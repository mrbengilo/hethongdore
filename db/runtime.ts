import { env } from "cloudflare:workers";

const MANAGER_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const DATA_RESET_KEY = "data_reset_2026_08_08_v2";
const RESET_UPLOADS_PENDING = "R2_PENDING";
const RESET_COMPLETE = "COMPLETE";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL, revenue INTEGER NOT NULL DEFAULT 0, expense INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, position TEXT NOT NULL, phone TEXT NOT NULL, province TEXT NOT NULL DEFAULT '', ward TEXT NOT NULL DEFAULT '', address_line TEXT NOT NULL DEFAULT '', age INTEGER, cccd_image_key TEXT, cccd_image_name TEXT, hourly_rate INTEGER NOT NULL DEFAULT 20000, status TEXT NOT NULL DEFAULT 'ACTIVE', inactive_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, employee_id TEXT, store_id TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, shift_active INTEGER NOT NULL DEFAULT 0, current_shift TEXT, shift_started_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, shift_code TEXT NOT NULL, customer_name TEXT, phone TEXT, age INTEGER, amount INTEGER NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, detail TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS business_records (id TEXT PRIMARY KEY, category TEXT NOT NULL, store_id TEXT, owner_id TEXT, title TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shift_sessions (id TEXT PRIMARY KEY, shift_code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, shift_name TEXT, scheduled_start TEXT, scheduled_end TEXT, scheduled_start_at TEXT, scheduled_end_at TEXT, work_date TEXT, previous_session_id TEXT, transfer_id TEXT, applied_hourly_rate INTEGER, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, tiktok INTEGER NOT NULL DEFAULT 0, tiktok_allowance INTEGER NOT NULL DEFAULT 0, tasks_completed INTEGER NOT NULL DEFAULT 0, expense_amount INTEGER NOT NULL DEFAULT 0, expense_note TEXT, cash_revenue INTEGER NOT NULL DEFAULT 0, transfer_revenue INTEGER NOT NULL DEFAULT 0, close_reason TEXT, close_status TEXT NOT NULL DEFAULT 'PENDING', status TEXT NOT NULL DEFAULT 'ACTIVE')`,
  `CREATE TABLE IF NOT EXISTS employee_transfers (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, source_store_id TEXT NOT NULL, target_store_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, shifts_json TEXT NOT NULL DEFAULT '[]', support_hourly_rate INTEGER NOT NULL, support_allowance INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SCHEDULED', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS employee_payroll_closings (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, period TEXT NOT NULL, snapshot_json TEXT NOT NULL, employee_status_at_lock TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'LOCKED', locked_at TEXT NOT NULL, locked_by TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_store_shift ON orders(store_id, employee_id, shift_code, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_store ON employees(store_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_records_category_store ON business_records(category, store_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shift_sessions_employee ON shift_sessions(employee_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_transfers_employee_dates ON employee_transfers(employee_id, start_date, end_date, status)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_transfers_target_dates ON employee_transfers(target_store_id, start_date, end_date, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_payroll_closing_period ON employee_payroll_closings(store_id, employee_id, period)`,
];

type ResetUploadsBucket = {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
};

async function ensureOneTimeDataReset(db: D1Database) {
  const state = await db.prepare("SELECT value FROM system_state WHERE key = ? LIMIT 1")
    .bind(DATA_RESET_KEY).first<{ value: string }>();
  if (state) return;

  const now = new Date().toISOString();
  // This second reset intentionally preserves store identities and manager
  // accounts/sessions. Only operational data, employees and employee access
  // are removed, while the two store financial counters return to zero.
  await db.batch([
    db.prepare("DELETE FROM employee_payroll_closings"),
    db.prepare("DELETE FROM orders"),
    db.prepare("DELETE FROM shift_sessions"),
    db.prepare("DELETE FROM employee_transfers"),
    db.prepare("DELETE FROM business_records"),
    db.prepare("DELETE FROM audit_logs"),
    db.prepare("DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM users AS manager_user WHERE manager_user.id = sessions.user_id AND manager_user.role = 'MANAGER')"),
    db.prepare("DELETE FROM users WHERE role != 'MANAGER'"),
    db.prepare("UPDATE users SET employee_id = NULL, store_id = NULL, failed_attempts = 0, locked_until = NULL, shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE role = 'MANAGER'"),
    db.prepare("DELETE FROM employees"),
    db.prepare("UPDATE stores SET revenue = 0, expense = 0"),
    db.prepare("INSERT OR IGNORE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)").bind(DATA_RESET_KEY, RESET_UPLOADS_PENDING, now),
  ]);
}

async function ensureManagerAccount(db: D1Database) {
  await db.prepare(`INSERT OR IGNORE INTO users
    (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, locked_until, shift_active, current_shift, shift_started_at)
    SELECT ?, ?, ?, 'MANAGER', ?, NULL, NULL, 0, NULL, 0, NULL, NULL
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'MANAGER')`)
    .bind("user-manager", "admin", MANAGER_HASH, "Quản trị viên").run();
}

async function finishResetUploads(db: D1Database) {
  const state = await db.prepare("SELECT value FROM system_state WHERE key = ? LIMIT 1")
    .bind(DATA_RESET_KEY).first<{ value: string }>();
  if (state?.value !== RESET_UPLOADS_PENDING) return;

  const storage = (env as unknown as { UPLOADS?: ResetUploadsBucket }).UPLOADS;
  if (!storage) return;
  try {
    let cursor: string | undefined;
    do {
      const page = await storage.list({ prefix: "cccd/", cursor, limit: 1000 });
      const keys = page.objects
        .map((object) => object.key)
        .filter((key) => key.startsWith("cccd/"));
      if (keys.length) await storage.delete(keys);
      if (!page.truncated) break;
      if (!page.cursor) throw new Error("R2 returned a truncated CCCD page without a continuation cursor");
      cursor = page.cursor;
    } while (cursor);
    await db.prepare("UPDATE system_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
      .bind(RESET_COMPLETE, new Date().toISOString(), DATA_RESET_KEY, RESET_UPLOADS_PENDING).run();
  } catch (error) {
    // Keep the marker pending so a later request retries a transient R2 error.
    console.error("Unable to finish the one-time CCCD upload reset", error);
  }
}

export async function initDb() {
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is unavailable");
  await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
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
    ["duration_seconds", "ALTER TABLE shift_sessions ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0"],
    ["close_reason", "ALTER TABLE shift_sessions ADD COLUMN close_reason TEXT"],
    ["close_status", "ALTER TABLE shift_sessions ADD COLUMN close_status TEXT NOT NULL DEFAULT 'PENDING'"],
  ].filter(([column]) => !existingShiftColumns.has(column));
  if (missingShiftColumns.length) await db.batch(missingShiftColumns.map(([, sql]) => db.prepare(sql)));
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_shift_sessions_store_work_date ON shift_sessions(store_id, work_date, status)").run();
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
    ["inactive_at", "ALTER TABLE employees ADD COLUMN inactive_at TEXT"],
  ].filter(([column]) => !existingEmployeeColumns.has(column));
  if (missingEmployeeColumns.length) await db.batch(missingEmployeeColumns.map(([, sql]) => db.prepare(sql)));
  // Legacy inactive rows did not carry an offboarding timestamp. Backfill
  // once so they can be closed in the current payroll period without being
  // pulled into every future period.
  await db.prepare("UPDATE employees SET inactive_at = ? WHERE status = 'INACTIVE' AND inactive_at IS NULL")
    .bind(new Date().toISOString()).run();

  await ensureOneTimeDataReset(db);
  await ensureManagerAccount(db);
  await finishResetUploads(db);
  await db.prepare("PRAGMA optimize").run();
  return db;
}

export async function writeAudit(userId: string | null, action: string, entityType: string, entityId: string | null, detail?: string) {
  const db = env.DB;
  if (!db) return;
  await db.prepare("INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, action, entityType, entityId, detail ?? null, new Date().toISOString()).run();
}
