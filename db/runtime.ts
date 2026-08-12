import { getDatabasePlatform } from "./platform";
import { ensureSqliteStoreBaseline, managerPasswordHash } from "./bootstrap";
import {
  nextAvailableStoreOrderCodePrefix,
  prefixFromStoreOrderCode,
  storeOrderCodePrefix,
} from "../app/lib/order-code";
import {
  ATTENDANCE_POLICY_STATE_KEY,
  defaultAttendancePolicy,
  DEFAULT_ATTENDANCE_GRACE_MINUTES,
} from "../app/lib/attendance-policy";
import { defaultPayrollPolicy, PAYROLL_POLICY_STATE_KEY } from "../app/lib/payroll-policy";

const LEGACY_RESET_COMPATIBILITY_KEY = "data_reset_2026_08_08_v2";
const LEGACY_RESET_COMPLETE = "COMPLETE";
const LEGACY_RESET_UPLOADS_PENDING = "R2_PENDING";
const DAILY_SHIFT_BACKFILL_KEY = "daily_shift_backfill_v1";
const systemStateSchema = "CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)";
const attendanceDeltaMillisecondsSql = "CAST(ROUND((julianday(started_at) - julianday(scheduled_start_at)) * 86400000) AS INTEGER)";
const attendanceDeltaMinutesSql = `CASE
  WHEN ${attendanceDeltaMillisecondsSql} < 0
    THEN -CAST((ABS(${attendanceDeltaMillisecondsSql}) + 59999) / 60000 AS INTEGER)
  ELSE CAST((${attendanceDeltaMillisecondsSql} + 59999) / 60000 AS INTEGER)
END`;
const attendanceStatusSql = `CASE
  WHEN ${attendanceDeltaMillisecondsSql} < 0 THEN 'EARLY'
  WHEN ${attendanceDeltaMillisecondsSql} <= COALESCE(attendance_grace_minutes, ${DEFAULT_ATTENDANCE_GRACE_MINUTES}) * 60000 THEN 'ON_TIME'
  ELSE 'LATE'
END`;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL, revenue INTEGER NOT NULL DEFAULT 0, expense INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, position TEXT NOT NULL, phone TEXT NOT NULL, province TEXT NOT NULL DEFAULT '', ward TEXT NOT NULL DEFAULT '', address_line TEXT NOT NULL DEFAULT '', age INTEGER, cccd_image_key TEXT, cccd_image_name TEXT, hourly_rate INTEGER NOT NULL DEFAULT 20000, tiktok_allowance INTEGER NOT NULL DEFAULT 25000, status TEXT NOT NULL DEFAULT 'ACTIVE', inactive_at TEXT, status_updated_at TEXT, lifecycle_version INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS employee_status_history (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, store_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, effective_at TEXT NOT NULL, actor_user_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cccd_deletion_outbox (key TEXT PRIMARY KEY, employee_id TEXT NOT NULL, requested_by TEXT NOT NULL, reason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cccd_upload_registry (key TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, actor_store_id TEXT, actor_global_access INTEGER NOT NULL DEFAULT 0, original_name TEXT, content_type TEXT NOT NULL, created_at TEXT NOT NULL, claim_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (claim_status IN ('PENDING', 'CLAIMED')), claimed_at TEXT, claimed_employee_id TEXT, deletion_status TEXT NOT NULL DEFAULT 'NONE' CHECK (deletion_status IN ('NONE', 'PENDING', 'DELETED')), delete_requested_at TEXT, deleted_at TEXT, deletion_attempts INTEGER NOT NULL DEFAULT 0, last_deletion_error TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, employee_id TEXT, store_id TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, shift_active INTEGER NOT NULL DEFAULT 0, current_shift TEXT, shift_started_at TEXT, is_super_admin INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  systemStateSchema,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, shift_code TEXT NOT NULL, customer_name TEXT, phone TEXT, age INTEGER, amount INTEGER NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETED', client_request_id TEXT, client_request_fingerprint TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS order_code_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), last_value INTEGER NOT NULL CHECK (last_value >= 0))`,
  `CREATE TABLE IF NOT EXISTS store_order_code_sequences (store_id TEXT PRIMARY KEY, code_prefix TEXT NOT NULL, last_value INTEGER NOT NULL CHECK (last_value >= 0), updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, recipient_user_id TEXT NOT NULL, store_id TEXT NOT NULL, type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', read_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, detail TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_reset_archives (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, kind TEXT NOT NULL, filter_json TEXT NOT NULL, summary_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS business_records (id TEXT PRIMARY KEY, category TEXT NOT NULL, store_id TEXT, owner_id TEXT, title TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS daily_shift_definitions (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, work_date TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')), version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), client_request_id TEXT, payload_hash TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS shift_sessions (id TEXT PRIMARY KEY, shift_code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, shift_name TEXT, scheduled_start TEXT, scheduled_end TEXT, scheduled_start_at TEXT, scheduled_end_at TEXT, work_date TEXT, previous_session_id TEXT, transfer_id TEXT, applied_hourly_rate INTEGER, applied_tiktok_allowance INTEGER, started_at TEXT NOT NULL, attendance_status TEXT, attendance_delta_minutes INTEGER, attendance_grace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (attendance_grace_minutes BETWEEN 0 AND 120), clock_in_latitude REAL, clock_in_longitude REAL, clock_in_accuracy_meters REAL, clock_in_location_captured_at TEXT, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, admin_adjusted_duration_seconds INTEGER, tiktok INTEGER NOT NULL DEFAULT 0, tiktok_allowance INTEGER NOT NULL DEFAULT 0, tasks_completed INTEGER NOT NULL DEFAULT 0, expense_amount INTEGER NOT NULL DEFAULT 0, expense_note TEXT, cash_revenue INTEGER NOT NULL DEFAULT 0, transfer_revenue INTEGER NOT NULL DEFAULT 0, close_reason TEXT, close_status TEXT NOT NULL DEFAULT 'PENDING', status TEXT NOT NULL DEFAULT 'ACTIVE')`,
  `CREATE TABLE IF NOT EXISTS employee_transfers (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, source_store_id TEXT NOT NULL, target_store_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, shifts_json TEXT NOT NULL DEFAULT '[]', support_hourly_rate INTEGER NOT NULL, support_allowance INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SCHEDULED', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS employee_payroll_closings (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, period TEXT NOT NULL, snapshot_json TEXT NOT NULL, employee_status_at_lock TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'LOCKED', locked_at TEXT NOT NULL, locked_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS salary_advances (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), advance_date TEXT NOT NULL CHECK (advance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), amount INTEGER NOT NULL CHECK (amount > 0), gross_entitlement_snapshot INTEGER NOT NULL CHECK (gross_entitlement_snapshot >= 0), available_before_snapshot INTEGER NOT NULL CHECK (available_before_snapshot >= 0), remaining_after_snapshot INTEGER NOT NULL CHECK (remaining_after_snapshot >= 0), note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PAID')), version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), client_request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, mutation_token TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, paid_by TEXT, paid_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_store_shift ON orders(store_id, employee_id, shift_code, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_recipient_type_entity ON notifications(recipient_user_id, type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications(recipient_user_id, read_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_store ON employees(store_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_status_history_employee_effective ON employee_status_history(employee_id, effective_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_status_history_store_effective ON employee_status_history(store_id, effective_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_cccd_deletion_outbox_created ON cccd_deletion_outbox(created_at, key)`,
  `CREATE INDEX IF NOT EXISTS idx_cccd_upload_registry_pending ON cccd_upload_registry(claim_status, deletion_status, created_at, key)`,
  `CREATE INDEX IF NOT EXISTS idx_cccd_upload_registry_employee ON cccd_upload_registry(claimed_employee_id, deletion_status, key)`,
  `CREATE INDEX IF NOT EXISTS idx_records_category_store ON business_records(category, store_id, status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_shift_store_request ON daily_shift_definitions(store_id, client_request_id) WHERE client_request_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_shift_store_date_identity ON daily_shift_definitions(store_id, work_date, name_key, start_time, end_time) WHERE status = 'ACTIVE'`,
  `CREATE INDEX IF NOT EXISTS idx_daily_shift_store_date_status ON daily_shift_definitions(store_id, work_date, status, start_time, id)`,
  `CREATE INDEX IF NOT EXISTS idx_shift_sessions_employee ON shift_sessions(employee_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_reset_archives_store_created ON admin_reset_archives(store_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_transfers_employee_dates ON employee_transfers(employee_id, start_date, end_date, status)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_transfers_target_dates ON employee_transfers(target_store_id, start_date, end_date, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_payroll_closing_period ON employee_payroll_closings(store_id, employee_id, period)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_advances_actor_request ON salary_advances(store_id, created_by, client_request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_salary_advances_store_period_employee ON salary_advances(store_id, period, employee_id, status)`,
];

async function ensureManagerAccount(db: D1Database, passwordHash: string) {
  await db.prepare(`INSERT OR IGNORE INTO users
    (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, locked_until, shift_active, current_shift, shift_started_at)
    SELECT ?, ?, ?, 'MANAGER', ?, NULL, NULL, 0, NULL, 0, NULL, NULL
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'MANAGER')`)
    .bind("user-manager", "admin", passwordHash, "Quản trị viên").run();
}

type StorePrefixStoreRow = { id: string; name: string };
type StorePrefixSequenceRow = { storeId: string; codePrefix: string; lastValue: number };
type StorePrefixOrderRow = { storeId: string; code: string };

async function ensureStoreOrderCodePrefixes(db: D1Database) {
  const [storesResult, sequencesResult, ordersResult] = await Promise.all([
    db.prepare("SELECT id, name FROM stores ORDER BY created_at, id").all<StorePrefixStoreRow>(),
    db.prepare("SELECT store_id AS storeId, code_prefix AS codePrefix, last_value AS lastValue FROM store_order_code_sequences ORDER BY store_id").all<StorePrefixSequenceRow>(),
    db.prepare("SELECT store_id AS storeId, code FROM orders WHERE instr(code, '-') > 1").all<StorePrefixOrderRow>(),
  ]);
  const sequences = new Map(sequencesResult.results.map((row) => [row.storeId, row]));
  const occupied = new Set<string>();
  const preservedStores = new Set<string>();
  for (const row of sequencesResult.results) {
    if (occupied.has(row.codePrefix)) continue;
    occupied.add(row.codePrefix);
    preservedStores.add(row.storeId);
  }

  const historicalOwners = new Map<string, Set<string>>();
  const historicalStats = new Map<string, Map<string, { count: number; max: number }>>();
  for (const order of ordersResult.results) {
    const prefix = prefixFromStoreOrderCode(order.code);
    if (!prefix) continue;
    const suffix = Number(order.code.slice(prefix.length + 1));
    const owners = historicalOwners.get(prefix) ?? new Set<string>();
    owners.add(order.storeId);
    historicalOwners.set(prefix, owners);
    const byPrefix = historicalStats.get(order.storeId) ?? new Map<string, { count: number; max: number }>();
    const stat = byPrefix.get(prefix) ?? { count: 0, max: 0 };
    stat.count += 1;
    if (Number.isSafeInteger(suffix)) stat.max = Math.max(stat.max, suffix);
    byPrefix.set(prefix, stat);
    historicalStats.set(order.storeId, byPrefix);
  }

  const now = new Date().toISOString();
  for (const store of storesResult.results) {
    const existing = sequences.get(store.id);
    if (existing && preservedStores.has(store.id)) continue;
    const ownHistory = [...(historicalStats.get(store.id)?.entries() ?? [])]
      .sort((left, right) => right[1].count - left[1].count || right[1].max - left[1].max || left[0].localeCompare(right[0]));
    const basePrefix = existing?.codePrefix ?? ownHistory[0]?.[0] ?? storeOrderCodePrefix(store.name);
    const unavailable = new Set(occupied);
    for (const [prefix, owners] of historicalOwners) {
      if (owners.size !== 1 || !owners.has(store.id)) unavailable.add(prefix);
    }
    const codePrefix = nextAvailableStoreOrderCodePrefix(basePrefix, unavailable);
    const lastValue = existing?.lastValue ?? historicalStats.get(store.id)?.get(codePrefix)?.max ?? 0;
    if (existing) {
      // A pre-index duplicate keeps its counter but receives a deterministic
      // collision suffix. No historical order code is ever rewritten.
      await db.prepare("UPDATE store_order_code_sequences SET code_prefix = ?, updated_at = ? WHERE store_id = ?")
        .bind(codePrefix, now, store.id).run();
    } else {
      await db.prepare(`INSERT OR IGNORE INTO store_order_code_sequences
        (store_id, code_prefix, last_value, updated_at) VALUES (?, ?, ?, ?)`)
        .bind(store.id, codePrefix, lastValue, now).run();
    }
    occupied.add(codePrefix);
  }
  const knownStoreIds = new Set(storesResult.results.map((store) => store.id));
  for (const existing of sequencesResult.results) {
    if (knownStoreIds.has(existing.storeId) || preservedStores.has(existing.storeId)) continue;
    const codePrefix = nextAvailableStoreOrderCodePrefix(existing.codePrefix, occupied);
    await db.prepare("UPDATE store_order_code_sequences SET code_prefix = ?, updated_at = ? WHERE store_id = ?")
      .bind(codePrefix, now, existing.storeId).run();
    occupied.add(codePrefix);
  }
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_store_order_code_sequences_prefix ON store_order_code_sequences(code_prefix)").run();
}

async function initializeDb() {
  const platform = await getDatabasePlatform();
  const db = platform.database;
  // Commit this guard independently before broader schema compatibility work.
  // A later missing-column/index error must never leave a legacy rollback free
  // to interpret this database as awaiting its retired destructive reset.
  await db.prepare(systemStateSchema).run();
  // Releases that predate the additive bootstrap interpreted an absent marker
  // as authorization to erase operational data. Publish the retired reset's
  // completion marker before any later compatibility work can fail, so an
  // emergency code rollback cannot reactivate that destructive startup path.
  // INSERT OR IGNORE also preserves an existing marker without rewriting it.
  await db.prepare(`INSERT OR IGNORE INTO system_state (key, value, updated_at)
    VALUES (?, ?, ?)`)
    .bind(LEGACY_RESET_COMPATIBILITY_KEY, LEGACY_RESET_COMPLETE, new Date().toISOString()).run();
  // A previously interrupted legacy reset may already have the marker in its
  // upload-deletion phase. Retire that phase as well, otherwise the old binary
  // would erase current CCCD uploads after a rollback even though SQL reset was
  // skipped. This changes only compatibility metadata, never business rows.
  await db.prepare(`UPDATE system_state SET value = ?, updated_at = ?
    WHERE key = ? AND value = ?`)
    .bind(LEGACY_RESET_COMPLETE, new Date().toISOString(), LEGACY_RESET_COMPATIBILITY_KEY, LEGACY_RESET_UPLOADS_PENDING).run();
  await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
  const defaultPolicy = defaultAttendancePolicy(new Date().toISOString());
  await db.prepare(`INSERT OR IGNORE INTO system_state (key, value, updated_at)
    VALUES (?, ?, ?)`)
    .bind(ATTENDANCE_POLICY_STATE_KEY, defaultPolicy.rawValue, defaultPolicy.updatedAt).run();
  const payrollPolicy = defaultPayrollPolicy(new Date().toISOString());
  await db.prepare(`INSERT OR IGNORE INTO system_state (key, value, updated_at)
    VALUES (?, ?, ?)`)
    .bind(PAYROLL_POLICY_STATE_KEY, payrollPolicy.rawValue, payrollPolicy.updatedAt).run();
  const dailyShiftBackfill = await db.prepare("SELECT value FROM system_state WHERE key = ? LIMIT 1")
    .bind(DAILY_SHIFT_BACKFILL_KEY).first<{ value: string }>();
  if (!dailyShiftBackfill) {
    const backfilledAt = new Date().toISOString();
    await db.batch([
      db.prepare(`WITH parsed AS (
          SELECT store_id AS storeId, owner_id AS ownerId, created_at AS createdAt,
            CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.date') END AS workDate,
            CASE WHEN json_valid(data_json) THEN trim(json_extract(data_json, '$.shiftName')) END AS shiftName,
            CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.start') END AS startTime,
            CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.end') END AS endTime
          FROM business_records
          WHERE category = 'LICH_PHAN_CA' AND status != 'DELETED' AND store_id IS NOT NULL
        ), snapshots AS (
          SELECT storeId, workDate, shiftName, lower(shiftName) AS nameKey, startTime, endTime,
            COALESCE(MIN(ownerId), 'daily-shift-migration') AS createdBy,
            COALESCE(MIN(createdAt), ?) AS createdAt
          FROM parsed
          WHERE workDate GLOB '????-??-??' AND shiftName IS NOT NULL AND shiftName != ''
            AND startTime GLOB '??:??' AND endTime GLOB '??:??'
          GROUP BY storeId, workDate, shiftName, startTime, endTime
        )
        INSERT OR IGNORE INTO daily_shift_definitions
          (id, store_id, work_date, name, name_key, start_time, end_time, status, version,
            client_request_id, payload_hash, created_by, created_at, updated_at, deleted_at)
        SELECT 'daily-shift-migrated-' || lower(hex(randomblob(16))), storeId, workDate,
          shiftName, nameKey, startTime, endTime, 'ACTIVE', 1, NULL, NULL,
          createdBy, createdAt, ?, NULL
        FROM snapshots`).bind(backfilledAt, backfilledAt),
      db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES (?, 'COMPLETE', ?)")
        .bind(DAILY_SHIFT_BACKFILL_KEY, backfilledAt),
    ]);
  }
  const passwordHash = managerPasswordHash(platform.kind);
  const userColumns = await db.prepare("PRAGMA table_info(users)").all<{ name: string }>();
  if (!userColumns.results.some((column) => column.name === "is_super_admin")) {
    await db.prepare("ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0").run();
  }
  const orderColumns = await db.prepare("PRAGMA table_info(orders)").all<{ name: string }>();
  const existingOrderColumns = new Set(orderColumns.results.map((column) => column.name));
  const missingOrderColumns = [
    ["client_request_id", "ALTER TABLE orders ADD COLUMN client_request_id TEXT"],
    ["client_request_fingerprint", "ALTER TABLE orders ADD COLUMN client_request_fingerprint TEXT"],
  ].filter(([column]) => !existingOrderColumns.has(column));
  if (missingOrderColumns.length) await db.batch(missingOrderColumns.map(([, sql]) => db.prepare(sql)));
  const salaryAdvanceColumns = await db.prepare("PRAGMA table_info(salary_advances)").all<{ name: string }>();
  const existingSalaryAdvanceColumns = new Set(salaryAdvanceColumns.results.map((column) => column.name));
  const missingSalaryAdvanceColumns = [
    ["gross_entitlement_snapshot", "ALTER TABLE salary_advances ADD COLUMN gross_entitlement_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (gross_entitlement_snapshot >= 0)"],
    ["available_before_snapshot", "ALTER TABLE salary_advances ADD COLUMN available_before_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (available_before_snapshot >= 0)"],
    ["remaining_after_snapshot", "ALTER TABLE salary_advances ADD COLUMN remaining_after_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (remaining_after_snapshot >= 0)"],
  ].filter(([column]) => !existingSalaryAdvanceColumns.has(column));
  if (missingSalaryAdvanceColumns.length) {
    await db.batch(missingSalaryAdvanceColumns.map(([, sql]) => db.prepare(sql)));
  }
  // Create this partial index only after legacy databases have received both
  // additive columns. Existing orders keep NULL keys and remain untouched.
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_employee_client_request ON orders(employee_id, client_request_id) WHERE client_request_id IS NOT NULL").run();
  // Preserve every legacy code exactly as stored. The initial sequence starts
  // after both the number of existing rows and the greatest strictly numeric
  // DH suffix, so a database containing old random codes never starts again at
  // DH00001 and a valid historical DH number is never reused. Re-running this
  // bootstrap can only move the counter forward.
  await db.prepare(`INSERT INTO order_code_sequence (id, last_value)
    SELECT 1, MAX(
      (SELECT COUNT(*) FROM orders),
      COALESCE((SELECT MAX(CAST(substr(code, 3) AS INTEGER))
        FROM orders
        WHERE code GLOB 'DH[0-9]*'
          AND length(substr(code, 3)) = 5
          AND substr(code, 3) NOT GLOB '*[^0-9]*'), 0)
    )
    ON CONFLICT(id) DO UPDATE SET last_value = MAX(order_code_sequence.last_value, excluded.last_value)`).run();

  const shiftColumns = await db.prepare("PRAGMA table_info(shift_sessions)").all<{ name: string }>();
  const existingShiftColumns = new Set(shiftColumns.results.map((column) => column.name));
  const missingShiftColumns = [
    ["tasks_completed", "ALTER TABLE shift_sessions ADD COLUMN tasks_completed INTEGER NOT NULL DEFAULT 0"],
    ["expense_amount", "ALTER TABLE shift_sessions ADD COLUMN expense_amount INTEGER NOT NULL DEFAULT 0"],
    ["expense_note", "ALTER TABLE shift_sessions ADD COLUMN expense_note TEXT"],
    ["cash_revenue", "ALTER TABLE shift_sessions ADD COLUMN cash_revenue INTEGER NOT NULL DEFAULT 0"],
    ["transfer_revenue", "ALTER TABLE shift_sessions ADD COLUMN transfer_revenue INTEGER NOT NULL DEFAULT 0"],
    ["shift_name", "ALTER TABLE shift_sessions ADD COLUMN shift_name TEXT"],
    ["scheduled_start", "ALTER TABLE shift_sessions ADD COLUMN scheduled_start TEXT"],
    ["scheduled_end", "ALTER TABLE shift_sessions ADD COLUMN scheduled_end TEXT"],
    ["scheduled_start_at", "ALTER TABLE shift_sessions ADD COLUMN scheduled_start_at TEXT"],
    ["scheduled_end_at", "ALTER TABLE shift_sessions ADD COLUMN scheduled_end_at TEXT"],
    ["work_date", "ALTER TABLE shift_sessions ADD COLUMN work_date TEXT"],
    ["previous_session_id", "ALTER TABLE shift_sessions ADD COLUMN previous_session_id TEXT"],
    ["transfer_id", "ALTER TABLE shift_sessions ADD COLUMN transfer_id TEXT"],
    ["applied_hourly_rate", "ALTER TABLE shift_sessions ADD COLUMN applied_hourly_rate INTEGER"],
    ["applied_tiktok_allowance", "ALTER TABLE shift_sessions ADD COLUMN applied_tiktok_allowance INTEGER"],
    ["attendance_status", "ALTER TABLE shift_sessions ADD COLUMN attendance_status TEXT"],
    ["attendance_delta_minutes", "ALTER TABLE shift_sessions ADD COLUMN attendance_delta_minutes INTEGER"],
    ["attendance_grace_minutes", "ALTER TABLE shift_sessions ADD COLUMN attendance_grace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (attendance_grace_minutes BETWEEN 0 AND 120)"],
    ["clock_in_latitude", "ALTER TABLE shift_sessions ADD COLUMN clock_in_latitude REAL"],
    ["clock_in_longitude", "ALTER TABLE shift_sessions ADD COLUMN clock_in_longitude REAL"],
    ["clock_in_accuracy_meters", "ALTER TABLE shift_sessions ADD COLUMN clock_in_accuracy_meters REAL"],
    ["clock_in_location_captured_at", "ALTER TABLE shift_sessions ADD COLUMN clock_in_location_captured_at TEXT"],
    ["duration_seconds", "ALTER TABLE shift_sessions ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0"],
    ["admin_adjusted_duration_seconds", "ALTER TABLE shift_sessions ADD COLUMN admin_adjusted_duration_seconds INTEGER"],
    ["close_reason", "ALTER TABLE shift_sessions ADD COLUMN close_reason TEXT"],
    ["close_status", "ALTER TABLE shift_sessions ADD COLUMN close_status TEXT NOT NULL DEFAULT 'PENDING'"],
  ].filter(([column]) => !existingShiftColumns.has(column));
  if (missingShiftColumns.length) await db.batch(missingShiftColumns.map(([, sql]) => db.prepare(sql)));
  // Legacy sessions already active at deployment used the former global
  // 25,000 VND rate, so initialize their effective value additively. Later
  // manager edits intentionally update ACTIVE sessions through the employee
  // API; completed sessions keep their recorded allowance untouched.
  await db.prepare("UPDATE shift_sessions SET applied_tiktok_allowance = 25000 WHERE status = 'ACTIVE' AND applied_tiktok_allowance IS NULL").run();
  // Existing rows retain their recorded classification and their legacy
  // 15-minute snapshot. Only incomplete legacy rows are hydrated; changing the
  // global policy must never rewrite attendance history.
  await db.prepare(`UPDATE shift_sessions SET
      attendance_delta_minutes = ${attendanceDeltaMinutesSql},
      attendance_status = ${attendanceStatusSql}
    WHERE scheduled_start_at IS NOT NULL
      AND julianday(started_at) IS NOT NULL
      AND julianday(scheduled_start_at) IS NOT NULL
      AND (attendance_status IS NULL OR attendance_delta_minutes IS NULL)`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_shift_sessions_store_work_date ON shift_sessions(store_id, work_date, status)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_shift_sessions_store_work_date_started ON shift_sessions(store_id, work_date, started_at, id)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_orders_store_created ON orders(store_id, created_at, id)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_shift_sessions_store_attendance ON shift_sessions(store_id, work_date, attendance_status)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_shift_sessions_employee_active ON shift_sessions(employee_id, status, scheduled_end_at)").run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_sessions_previous_session ON shift_sessions(previous_session_id) WHERE previous_session_id IS NOT NULL").run();

  const employeeColumns = await db.prepare("PRAGMA table_info(employees)").all<{ name: string }>();
  const existingEmployeeColumns = new Set(employeeColumns.results.map((column) => column.name));
  const missingEmployeeColumns = [
    ["province", "ALTER TABLE employees ADD COLUMN province TEXT NOT NULL DEFAULT ''"],
    ["ward", "ALTER TABLE employees ADD COLUMN ward TEXT NOT NULL DEFAULT ''"],
    ["address_line", "ALTER TABLE employees ADD COLUMN address_line TEXT NOT NULL DEFAULT ''"],
    ["age", "ALTER TABLE employees ADD COLUMN age INTEGER"],
    ["cccd_image_key", "ALTER TABLE employees ADD COLUMN cccd_image_key TEXT"],
    ["cccd_image_name", "ALTER TABLE employees ADD COLUMN cccd_image_name TEXT"],
    ["tiktok_allowance", "ALTER TABLE employees ADD COLUMN tiktok_allowance INTEGER NOT NULL DEFAULT 25000"],
    ["inactive_at", "ALTER TABLE employees ADD COLUMN inactive_at TEXT"],
    ["status_updated_at", "ALTER TABLE employees ADD COLUMN status_updated_at TEXT"],
    ["lifecycle_version", "ALTER TABLE employees ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0"],
    ["deleted_at", "ALTER TABLE employees ADD COLUMN deleted_at TEXT"],
    ["deleted_by", "ALTER TABLE employees ADD COLUMN deleted_by TEXT"],
  ].filter(([column]) => !existingEmployeeColumns.has(column));
  if (missingEmployeeColumns.length) await db.batch(missingEmployeeColumns.map(([, sql]) => db.prepare(sql)));
  // Lifecycle startup is deliberately additive. Legacy INACTIVE rows remain
  // byte-for-byte compatible with the previous release so a rollback never
  // observes a status value rewritten by a newer binary.
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_employees_store_lifecycle ON employees(store_id, status, deleted_at, code)").run();

  // Historical automatic resets are permanently retired. Startup never reads
  // a reset marker and never deletes or zeroes existing operational data.
  if (platform.kind === "sqlite") await ensureSqliteStoreBaseline(db);
  await ensureStoreOrderCodePrefixes(db);
  await ensureManagerAccount(db, passwordHash);
  await db.prepare("PRAGMA optimize").run();
  return db;
}

let initializationPromise: Promise<D1Database> | undefined;

export function initDb() {
  initializationPromise ??= initializeDb().catch((error) => {
    initializationPromise = undefined;
    throw error;
  });
  return initializationPromise;
}

export async function writeAudit(userId: string | null, action: string, entityType: string, entityId: string | null, detail?: string) {
  const db = await initDb();
  await db.prepare("INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, action, entityType, entityId, detail ?? null, new Date().toISOString()).run();
}
