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
  `CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, position TEXT NOT NULL, phone TEXT NOT NULL, province TEXT NOT NULL DEFAULT '', ward TEXT NOT NULL DEFAULT '', address_line TEXT NOT NULL DEFAULT '', age INTEGER, cccd_number TEXT CHECK (cccd_number IS NULL OR (length(cccd_number) = 12 AND cccd_number NOT GLOB '*[^0-9]*')), cccd_image_key TEXT, cccd_image_name TEXT, hourly_rate INTEGER NOT NULL DEFAULT 20000, tiktok_allowance INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', inactive_at TEXT, status_updated_at TEXT, lifecycle_version INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT)`,
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
  `CREATE TABLE IF NOT EXISTS inventory_receipt_code_sequences (id INTEGER PRIMARY KEY CHECK (id = 1), last_value INTEGER NOT NULL CHECK (last_value >= 0), updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS inventory_receipt_requests (record_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, client_request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_date TEXT NOT NULL, sequence_value INTEGER NOT NULL CHECK (sequence_value > 0), receipt_no TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, UNIQUE (store_id, actor_user_id, client_request_id), UNIQUE (sequence_value))`,
  `CREATE TABLE IF NOT EXISTS daily_shift_definitions (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, work_date TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')), version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), client_request_id TEXT, payload_hash TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS shift_sessions (id TEXT PRIMARY KEY, shift_code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, shift_name TEXT, scheduled_start TEXT, scheduled_end TEXT, scheduled_start_at TEXT, scheduled_end_at TEXT, work_date TEXT, previous_session_id TEXT, transfer_id TEXT, source_schedule_record_id TEXT, source_schedule_updated_at TEXT, applied_hourly_rate INTEGER, applied_tiktok_allowance INTEGER, applied_support_allowance INTEGER, started_at TEXT NOT NULL, attendance_status TEXT, attendance_delta_minutes INTEGER, attendance_grace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (attendance_grace_minutes BETWEEN 0 AND 120), attendance_early_window_minutes INTEGER, attendance_max_shift_minutes INTEGER, clock_in_latitude REAL, clock_in_longitude REAL, clock_in_accuracy_meters REAL, clock_in_location_captured_at TEXT, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, admin_adjusted_duration_seconds INTEGER, tiktok INTEGER NOT NULL DEFAULT 0, tiktok_allowance INTEGER NOT NULL DEFAULT 0, tasks_completed INTEGER NOT NULL DEFAULT 0, expense_amount INTEGER NOT NULL DEFAULT 0, expense_note TEXT, cash_revenue INTEGER NOT NULL DEFAULT 0, transfer_revenue INTEGER NOT NULL DEFAULT 0, close_reason TEXT, close_status TEXT NOT NULL DEFAULT 'PENDING', reconciliation_status TEXT NOT NULL DEFAULT 'CLEAR', reconciliation_reason TEXT, reconciled_at TEXT, reconciled_by TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE')`,
  `CREATE TABLE IF NOT EXISTS employee_transfers (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, source_store_id TEXT NOT NULL, target_store_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, shifts_json TEXT NOT NULL DEFAULT '[]', support_hourly_rate INTEGER NOT NULL, support_allowance INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SCHEDULED', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS employee_payroll_closings (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, period TEXT NOT NULL, snapshot_json TEXT NOT NULL, employee_status_at_lock TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'LOCKED', locked_at TEXT NOT NULL, locked_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS salary_advances (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), advance_date TEXT NOT NULL CHECK (advance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), amount INTEGER NOT NULL CHECK (amount > 0), gross_entitlement_snapshot INTEGER NOT NULL CHECK (gross_entitlement_snapshot >= 0), available_before_snapshot INTEGER NOT NULL CHECK (available_before_snapshot >= 0), remaining_after_snapshot INTEGER NOT NULL CHECK (remaining_after_snapshot >= 0), note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PAID')), version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), client_request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, mutation_token TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, paid_by TEXT, paid_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS financial_policy_versions (
    id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    effective_from_period TEXT NOT NULL CHECK (
      effective_from_period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(effective_from_period, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    ),
    policy_json TEXT NOT NULL CHECK (json_valid(policy_json) AND json_type(policy_json) = 'object'),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    superseded_at TEXT CHECK (superseded_at IS NULL OR length(trim(superseded_at)) > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS financial_periods (
    id TEXT PRIMARY KEY NOT NULL,
    store_id TEXT NOT NULL,
    period TEXT NOT NULL CHECK (
      period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(period, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    ),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
      status IN ('DRAFT', 'CALCULATED', 'RECONCILING', 'CONFIRMED', 'PAID', 'LOCKED')
    ),
    policy_version_id TEXT,
    config_version INTEGER CHECK (config_version IS NULL OR config_version > 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    gross_revenue INTEGER NOT NULL DEFAULT 0 CHECK (gross_revenue >= 0),
    fixed_expense INTEGER NOT NULL DEFAULT 0 CHECK (fixed_expense >= 0),
    variable_expense INTEGER NOT NULL DEFAULT 0 CHECK (variable_expense >= 0),
    inventory_cost INTEGER NOT NULL DEFAULT 0 CHECK (inventory_cost >= 0),
    inventory_shipping_cost INTEGER NOT NULL DEFAULT 0 CHECK (inventory_shipping_cost >= 0),
    employee_salary INTEGER NOT NULL DEFAULT 0 CHECK (employee_salary >= 0),
    manager_salary INTEGER NOT NULL DEFAULT 0 CHECK (manager_salary >= 0),
    manual_bonus INTEGER NOT NULL DEFAULT 0 CHECK (manual_bonus >= 0),
    allowance INTEGER NOT NULL DEFAULT 0 CHECK (allowance >= 0),
    total_hours_seconds INTEGER NOT NULL DEFAULT 0 CHECK (total_hours_seconds >= 0),
    employee_kpi_total INTEGER NOT NULL DEFAULT 0 CHECK (employee_kpi_total >= 0),
    manager_kpi INTEGER NOT NULL DEFAULT 0 CHECK (manager_kpi >= 0),
    operating_profit INTEGER NOT NULL DEFAULT 0,
    profit_after_kpi INTEGER NOT NULL DEFAULT 0,
    month_end_expense INTEGER NOT NULL DEFAULT 0 CHECK (month_end_expense >= 0),
    final_profit INTEGER NOT NULL DEFAULT 0,
    distributable_profit INTEGER NOT NULL DEFAULT 0 CHECK (distributable_profit >= 0),
    salary_advance INTEGER NOT NULL DEFAULT 0 CHECK (salary_advance >= 0),
    employee_payroll_rows_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(employee_payroll_rows_json)),
    manager_payroll_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(manager_payroll_json)),
    config_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_snapshot_json)),
    snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(snapshot_json)),
    calculated_at TEXT,
    calculated_by TEXT,
    confirmed_at TEXT,
    confirmed_by TEXT,
    paid_at TEXT,
    paid_by TEXT,
    locked_at TEXT,
    locked_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (policy_version_id) REFERENCES financial_policy_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
      (policy_version_id IS NULL AND config_version IS NULL)
      OR (policy_version_id IS NOT NULL AND config_version IS NOT NULL)
    ),
    CHECK ((calculated_at IS NULL AND calculated_by IS NULL) OR (calculated_at IS NOT NULL AND calculated_by IS NOT NULL)),
    CHECK ((confirmed_at IS NULL AND confirmed_by IS NULL) OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
    CHECK ((paid_at IS NULL AND paid_by IS NULL) OR (paid_at IS NOT NULL AND paid_by IS NOT NULL)),
    CHECK ((locked_at IS NULL AND locked_by IS NULL) OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
    CHECK (
      (status = 'DRAFT' AND calculated_at IS NULL AND confirmed_at IS NULL AND paid_at IS NULL AND locked_at IS NULL)
      OR (status IN ('CALCULATED', 'RECONCILING') AND calculated_at IS NOT NULL AND confirmed_at IS NULL AND paid_at IS NULL AND locked_at IS NULL)
      OR (status = 'CONFIRMED' AND calculated_at IS NOT NULL AND confirmed_at IS NOT NULL AND paid_at IS NULL AND locked_at IS NULL AND policy_version_id IS NOT NULL AND json_extract(snapshot_json, '$.schemaVersion') IS 1)
      OR (status = 'PAID' AND calculated_at IS NOT NULL AND confirmed_at IS NOT NULL AND paid_at IS NOT NULL AND locked_at IS NULL AND policy_version_id IS NOT NULL AND json_extract(snapshot_json, '$.schemaVersion') IS 1)
      OR (status = 'LOCKED' AND calculated_at IS NOT NULL AND confirmed_at IS NOT NULL AND paid_at IS NOT NULL AND locked_at IS NOT NULL AND policy_version_id IS NOT NULL AND json_extract(snapshot_json, '$.schemaVersion') IS 1)
    ),
    CHECK (
      (confirmed_at IS NULL OR confirmed_at >= calculated_at)
      AND (paid_at IS NULL OR paid_at >= confirmed_at)
      AND (locked_at IS NULL OR locked_at >= paid_at)
    ),
    CHECK (json_type(employee_payroll_rows_json) = 'array'),
    CHECK (json_type(manager_payroll_json) = 'object'),
    CHECK (json_type(config_snapshot_json) = 'object'),
    CHECK (json_type(snapshot_json) = 'object'),
    CHECK (operating_profit = gross_revenue - fixed_expense - variable_expense - inventory_cost - inventory_shipping_cost - employee_salary - manager_salary - manual_bonus - allowance),
    CHECK (profit_after_kpi = operating_profit - employee_kpi_total - manager_kpi),
    CHECK (final_profit = profit_after_kpi - month_end_expense),
    CHECK (distributable_profit = CASE WHEN final_profit > 0 THEN final_profit ELSE 0 END)
  )`,
  `CREATE TABLE IF NOT EXISTS profit_distributions (
    id TEXT PRIMARY KEY NOT NULL,
    period TEXT NOT NULL UNIQUE CHECK (
      period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(period, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    ),
    status TEXT NOT NULL DEFAULT 'LOCKED' CHECK (status = 'LOCKED'),
    policy_version_id TEXT NOT NULL,
    config_version INTEGER NOT NULL CHECK (config_version > 0),
    policy_snapshot_json TEXT NOT NULL CHECK (json_valid(policy_snapshot_json) AND json_type(policy_snapshot_json) = 'object'),
    total_final_profit INTEGER NOT NULL,
    total_distributable_profit INTEGER NOT NULL CHECK (total_distributable_profit >= 0),
    store_count INTEGER NOT NULL CHECK (store_count > 0),
    member_count INTEGER NOT NULL CHECK (member_count > 0),
    closed_by TEXT NOT NULL CHECK (length(trim(closed_by)) > 0),
    closed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) = closed_at),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
    FOREIGN KEY (policy_version_id) REFERENCES financial_policy_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT
  )`,
  `CREATE TABLE IF NOT EXISTS profit_distribution_stores (
    id TEXT PRIMARY KEY NOT NULL,
    distribution_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    store_name_snapshot TEXT NOT NULL CHECK (length(trim(store_name_snapshot)) > 0),
    financial_period_id TEXT NOT NULL UNIQUE,
    financial_period_revision INTEGER NOT NULL CHECK (financial_period_revision >= 0),
    policy_version_id TEXT NOT NULL,
    config_version INTEGER NOT NULL CHECK (config_version > 0),
    final_profit INTEGER NOT NULL,
    distributable_profit INTEGER NOT NULL CHECK (distributable_profit >= 0),
    financial_snapshot_json TEXT NOT NULL CHECK (json_valid(financial_snapshot_json) AND json_type(financial_snapshot_json) = 'object'),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    FOREIGN KEY (distribution_id) REFERENCES profit_distributions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (financial_period_id) REFERENCES financial_periods(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (policy_version_id) REFERENCES financial_policy_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    UNIQUE (distribution_id, store_id),
    UNIQUE (distribution_id, ordinal),
    CHECK (distributable_profit = CASE WHEN final_profit > 0 THEN final_profit ELSE 0 END)
  )`,
  `CREATE TABLE IF NOT EXISTS profit_distribution_members (
    id TEXT PRIMARY KEY NOT NULL,
    distribution_id TEXT NOT NULL,
    member_id TEXT NOT NULL CHECK (length(trim(member_id)) > 0),
    member_name_snapshot TEXT NOT NULL CHECK (length(trim(member_name_snapshot)) > 0),
    rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points >= 0 AND rate_basis_points <= 10000),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    member_snapshot_json TEXT NOT NULL CHECK (json_valid(member_snapshot_json) AND json_type(member_snapshot_json) = 'object'),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    FOREIGN KEY (distribution_id) REFERENCES profit_distributions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    UNIQUE (distribution_id, member_id),
    UNIQUE (distribution_id, ordinal)
  )`,
  `CREATE TABLE IF NOT EXISTS month_end_expenses (
    id TEXT PRIMARY KEY NOT NULL,
    store_id TEXT NOT NULL,
    period TEXT NOT NULL CHECK (
      period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(period, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    ),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    category TEXT NOT NULL CHECK (length(trim(category)) > 0),
    amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOID')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    client_request_id TEXT NOT NULL CHECK (length(trim(client_request_id)) > 0),
    payload_hash TEXT NOT NULL CHECK (length(trim(payload_hash)) > 0),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL,
    voided_by TEXT,
    voided_at TEXT,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
      (status = 'ACTIVE' AND voided_by IS NULL AND voided_at IS NULL)
      OR (status = 'VOID' AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS cashflow_entries (
    id TEXT PRIMARY KEY NOT NULL,
    store_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL CHECK (length(trim(category)) > 0),
    source_type TEXT NOT NULL CHECK (length(trim(source_type)) > 0),
    source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
    occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at),
    created_by TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    client_request_id TEXT,
    payload_hash TEXT,
    reverses_entry_id TEXT,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (reverses_entry_id) REFERENCES cashflow_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
      (client_request_id IS NULL AND payload_hash IS NULL)
      OR (
        length(trim(client_request_id)) BETWEEN 16 AND 200
        AND length(payload_hash) = 64
        AND payload_hash NOT GLOB '*[^0-9a-f]*'
      )
    )
  )`,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_policy_versions_version ON financial_policy_versions(version)`,
  `CREATE INDEX IF NOT EXISTS idx_financial_policy_versions_effective ON financial_policy_versions(effective_from_period, version)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_periods_store_period ON financial_periods(store_id, period)`,
  `CREATE INDEX IF NOT EXISTS idx_financial_periods_status_period ON financial_periods(status, period, store_id)`,
  `CREATE INDEX IF NOT EXISTS idx_financial_periods_store_status ON financial_periods(store_id, status, period)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_distributions_period ON profit_distributions(period)`,
  `CREATE INDEX IF NOT EXISTS idx_profit_distributions_closed_at ON profit_distributions(closed_at, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_distribution_stores_distribution_store ON profit_distribution_stores(distribution_id, store_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_distribution_stores_financial_period ON profit_distribution_stores(financial_period_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_distribution_stores_ordinal ON profit_distribution_stores(distribution_id, ordinal)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_distribution_members_distribution_member ON profit_distribution_members(distribution_id, member_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_distribution_members_ordinal ON profit_distribution_members(distribution_id, ordinal)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_month_end_expenses_actor_request ON month_end_expenses(store_id, created_by, client_request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_month_end_expenses_store_period_status ON month_end_expenses(store_id, period, status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cashflow_entries_source ON cashflow_entries(store_id, source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cashflow_entries_store_occurred ON cashflow_entries(store_id, occurred_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_cashflow_entries_source_lookup ON cashflow_entries(source_type, source_id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_financial_periods_locked_update
    BEFORE UPDATE ON financial_periods
    WHEN OLD.status = 'LOCKED'
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_financial_periods_locked_delete
    BEFORE DELETE ON financial_periods
    WHEN OLD.status = 'LOCKED'
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_financial_policy_versions_immutable_update
    BEFORE UPDATE ON financial_policy_versions
    WHEN NOT (
      OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
      AND NEW.id IS OLD.id AND NEW.version IS OLD.version
      AND NEW.effective_from_period IS OLD.effective_from_period
      AND NEW.policy_json IS OLD.policy_json AND NEW.created_by IS OLD.created_by
      AND NEW.created_at IS OLD.created_at
    )
    BEGIN SELECT RAISE(ABORT, 'financial policy versions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_financial_policy_versions_immutable_delete
    BEFORE DELETE ON financial_policy_versions
    BEGIN SELECT RAISE(ABORT, 'financial policy versions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distributions_immutable_update
    BEFORE UPDATE ON profit_distributions
    BEGIN SELECT RAISE(ABORT, 'profit distributions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distributions_immutable_delete
    BEFORE DELETE ON profit_distributions
    BEGIN SELECT RAISE(ABORT, 'profit distributions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distribution_stores_bounded_insert
    BEFORE INSERT ON profit_distribution_stores
    WHEN (SELECT COUNT(*) FROM profit_distribution_stores WHERE distribution_id = NEW.distribution_id)
      >= (SELECT store_count FROM profit_distributions WHERE id = NEW.distribution_id)
    BEGIN SELECT RAISE(ABORT, 'profit distribution store rows are complete'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distribution_stores_immutable_update
    BEFORE UPDATE ON profit_distribution_stores
    BEGIN SELECT RAISE(ABORT, 'profit distribution store rows are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distribution_stores_immutable_delete
    BEFORE DELETE ON profit_distribution_stores
    BEGIN SELECT RAISE(ABORT, 'profit distribution store rows are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distribution_members_bounded_insert
    BEFORE INSERT ON profit_distribution_members
    WHEN (SELECT COUNT(*) FROM profit_distribution_members WHERE distribution_id = NEW.distribution_id)
      >= (SELECT member_count FROM profit_distributions WHERE id = NEW.distribution_id)
    BEGIN SELECT RAISE(ABORT, 'profit distribution member rows are complete'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distribution_members_immutable_update
    BEFORE UPDATE ON profit_distribution_members
    BEGIN SELECT RAISE(ABORT, 'profit distribution member rows are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_profit_distribution_members_immutable_delete
    BEFORE DELETE ON profit_distribution_members
    BEGIN SELECT RAISE(ABORT, 'profit distribution member rows are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_month_end_expenses_locked_insert
    BEFORE INSERT ON month_end_expenses
    WHEN EXISTS (SELECT 1 FROM financial_periods WHERE store_id = NEW.store_id AND period = NEW.period AND status = 'LOCKED')
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept month-end expenses'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_month_end_expenses_locked_update
    BEFORE UPDATE ON month_end_expenses
    WHEN EXISTS (SELECT 1 FROM financial_periods WHERE store_id = OLD.store_id AND period = OLD.period AND status = 'LOCKED')
      OR EXISTS (SELECT 1 FROM financial_periods WHERE store_id = NEW.store_id AND period = NEW.period AND status = 'LOCKED')
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept month-end expense changes'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_month_end_expenses_locked_delete
    BEFORE DELETE ON month_end_expenses
    WHEN EXISTS (SELECT 1 FROM financial_periods WHERE store_id = OLD.store_id AND period = OLD.period AND status = 'LOCKED')
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept month-end expense changes'); END`,
];

// Kept outside the initial schema batch so an older cashflow table receives
// its additive compatibility columns before indexes and triggers reference
// them. These statements intentionally do not feed accounting calculations.
const cashflowLedgerSchemaStatements = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cashflow_entries_actor_request
    ON cashflow_entries(store_id, created_by, client_request_id)
    WHERE client_request_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cashflow_entries_reversal
    ON cashflow_entries(reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL`,
  `CREATE TRIGGER IF NOT EXISTS trg_cashflow_entries_require_metadata
    BEFORE INSERT ON cashflow_entries
    WHEN NEW.client_request_id IS NULL
      OR length(trim(NEW.client_request_id)) NOT BETWEEN 16 AND 200
      OR NEW.payload_hash IS NULL
      OR length(NEW.payload_hash) != 64
      OR NEW.payload_hash GLOB '*[^0-9a-f]*'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.occurred_at) IS NOT NEW.occurred_at
    BEGIN SELECT RAISE(ABORT, 'cashflow entry requires idempotency metadata and canonical ISO occurredAt'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_cashflow_entries_idempotency_conflict
    BEFORE INSERT ON cashflow_entries
    WHEN EXISTS (
      SELECT 1 FROM cashflow_entries AS existing
      WHERE (
        (
          existing.store_id = NEW.store_id
          AND existing.source_type = NEW.source_type
          AND existing.source_id = NEW.source_id
        ) OR (
          existing.store_id = NEW.store_id
          AND existing.created_by = NEW.created_by
          AND existing.client_request_id = NEW.client_request_id
        )
      )
      AND (existing.payload_hash IS NULL OR existing.payload_hash != NEW.payload_hash)
    )
    BEGIN SELECT RAISE(ABORT, 'cashflow idempotency conflict'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_cashflow_entries_reversal_validate
    BEFORE INSERT ON cashflow_entries
    WHEN (NEW.reverses_entry_id IS NULL AND NEW.source_type = 'REVERSAL')
      OR (NEW.reverses_entry_id IS NOT NULL AND (
        NEW.source_type != 'REVERSAL'
        OR NEW.source_id != NEW.reverses_entry_id
        OR NOT EXISTS (
        SELECT 1 FROM cashflow_entries AS original
        WHERE original.id = NEW.reverses_entry_id
          AND original.reverses_entry_id IS NULL
          AND original.store_id = NEW.store_id
          AND original.category = NEW.category
          AND original.amount = NEW.amount
          AND original.direction != NEW.direction
          AND NEW.occurred_at >= original.occurred_at
          AND NEW.id != original.id
        )
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid cashflow reversal'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_cashflow_entries_locked_insert
    BEFORE INSERT ON cashflow_entries
    WHEN EXISTS (
      SELECT 1 FROM financial_periods AS locked_period
      WHERE locked_period.store_id = NEW.store_id
        AND locked_period.period = strftime('%Y-%m', NEW.occurred_at, '+7 hours')
        AND locked_period.status = 'LOCKED'
    )
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept cashflow entries'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_cashflow_entries_append_only_update
    BEFORE UPDATE ON cashflow_entries
    BEGIN SELECT RAISE(ABORT, 'cashflow ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_cashflow_entries_append_only_delete
    BEFORE DELETE ON cashflow_entries
    BEGIN SELECT RAISE(ABORT, 'cashflow ledger is append-only'); END`,
];

// Installed only after additive compatibility columns exist. A partial UNIQUE
// index would make deployment fail when a legacy database already contains an
// anomaly, so ACTIVE-session serialization is deliberately trigger-based:
// historical duplicates remain queryable and can be closed one by one, while
// no new INSERT/UPDATE can create or preserve another ACTIVE duplicate.
const shiftAttendanceIntegrityStatements = [
  `CREATE INDEX IF NOT EXISTS idx_shift_sessions_employee_status_integrity
    ON shift_sessions(employee_id, status, id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_one_active_insert
    BEFORE INSERT ON shift_sessions
    WHEN NEW.status = 'ACTIVE' AND EXISTS (
      SELECT 1 FROM shift_sessions existing
      WHERE existing.employee_id = NEW.employee_id AND existing.status = 'ACTIVE'
    )
    BEGIN SELECT RAISE(ABORT, 'employee already has an ACTIVE shift session'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_one_active_update
    BEFORE UPDATE ON shift_sessions
    WHEN NEW.status = 'ACTIVE' AND EXISTS (
      SELECT 1 FROM shift_sessions existing
      WHERE existing.employee_id = NEW.employee_id
        AND existing.status = 'ACTIVE' AND existing.id != OLD.id
    )
    BEGIN SELECT RAISE(ABORT, 'employee already has an ACTIVE shift session'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_validate_insert_v2
    BEFORE INSERT ON shift_sessions
    WHEN NEW.status NOT IN ('ACTIVE', 'COMPLETED')
      OR julianday(NEW.started_at) IS NULL
      OR (NEW.work_date IS NOT NULL AND (
        NEW.work_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        OR date(NEW.work_date) IS NOT NEW.work_date
      ))
      OR (NEW.scheduled_start_at IS NULL) != (NEW.scheduled_end_at IS NULL)
      OR (NEW.scheduled_start_at IS NOT NULL AND (
        julianday(NEW.scheduled_start_at) IS NULL
        OR julianday(NEW.scheduled_end_at) IS NULL
        OR julianday(NEW.scheduled_end_at) <= julianday(NEW.scheduled_start_at)
      ))
      OR (NEW.source_schedule_record_id IS NULL) != (NEW.source_schedule_updated_at IS NULL)
      OR (NEW.source_schedule_record_id IS NOT NULL AND (
        length(trim(NEW.source_schedule_record_id)) = 0
        OR julianday(NEW.source_schedule_updated_at) IS NULL
      ))
      OR typeof(NEW.attendance_grace_minutes) != 'integer'
      OR NEW.attendance_grace_minutes NOT BETWEEN 0 AND 120
      OR (NEW.attendance_early_window_minutes IS NOT NULL
        AND (typeof(NEW.attendance_early_window_minutes) != 'integer'
          OR NEW.attendance_early_window_minutes NOT BETWEEN 0 AND 1440))
      OR (NEW.attendance_max_shift_minutes IS NOT NULL
        AND (typeof(NEW.attendance_max_shift_minutes) != 'integer'
          OR NEW.attendance_max_shift_minutes NOT BETWEEN 1 AND 10080))
      OR NEW.attendance_status NOT IN ('EARLY', 'ON_TIME', 'LATE')
      OR (NEW.attendance_status IS NULL) != (NEW.attendance_delta_minutes IS NULL)
      OR (NEW.attendance_delta_minutes IS NOT NULL
        AND typeof(NEW.attendance_delta_minutes) != 'integer')
      OR (NEW.applied_hourly_rate IS NOT NULL
        AND (typeof(NEW.applied_hourly_rate) != 'integer' OR NEW.applied_hourly_rate < 0))
      OR (NEW.applied_tiktok_allowance IS NOT NULL
        AND (typeof(NEW.applied_tiktok_allowance) != 'integer' OR NEW.applied_tiktok_allowance < 0))
      OR typeof(NEW.duration_seconds) != 'integer' OR NEW.duration_seconds < 0
      OR (NEW.admin_adjusted_duration_seconds IS NOT NULL AND (
        typeof(NEW.admin_adjusted_duration_seconds) != 'integer'
        OR NEW.admin_adjusted_duration_seconds < 0
      ))
      OR NEW.tiktok NOT IN (0, 1) OR NEW.tasks_completed NOT IN (0, 1)
      OR typeof(NEW.tiktok_allowance) != 'integer' OR NEW.tiktok_allowance < 0
      OR typeof(NEW.expense_amount) != 'integer' OR NEW.expense_amount < 0
      OR typeof(NEW.cash_revenue) != 'integer' OR NEW.cash_revenue < 0
      OR typeof(NEW.transfer_revenue) != 'integer' OR NEW.transfer_revenue < 0
      OR NOT (
        (NEW.clock_in_latitude IS NULL AND NEW.clock_in_longitude IS NULL
          AND NEW.clock_in_accuracy_meters IS NULL AND NEW.clock_in_location_captured_at IS NULL)
        OR (NEW.clock_in_latitude IS NOT NULL AND NEW.clock_in_latitude BETWEEN -90 AND 90
          AND typeof(NEW.clock_in_latitude) IN ('integer', 'real')
          AND NEW.clock_in_longitude IS NOT NULL AND NEW.clock_in_longitude BETWEEN -180 AND 180
          AND typeof(NEW.clock_in_longitude) IN ('integer', 'real')
          AND NEW.clock_in_accuracy_meters IS NOT NULL AND NEW.clock_in_accuracy_meters BETWEEN 0 AND 100000
          AND typeof(NEW.clock_in_accuracy_meters) IN ('integer', 'real')
          AND julianday(NEW.clock_in_location_captured_at) IS NOT NULL)
      )
      OR NOT (
        (NEW.reconciliation_status = 'CLEAR' AND NEW.reconciliation_reason IS NULL
          AND NEW.reconciled_at IS NULL AND NEW.reconciled_by IS NULL)
        OR (NEW.reconciliation_status = 'REQUIRED'
          AND length(trim(COALESCE(NEW.reconciliation_reason, ''))) > 0
          AND NEW.reconciled_at IS NULL AND NEW.reconciled_by IS NULL)
        OR (NEW.reconciliation_status = 'CONFIRMED'
          AND length(trim(COALESCE(NEW.reconciliation_reason, ''))) > 0
          AND julianday(NEW.reconciled_at) IS NOT NULL
          AND length(trim(COALESCE(NEW.reconciled_by, ''))) > 0)
      )
      OR (NEW.status = 'ACTIVE' AND (
        NEW.ended_at IS NOT NULL OR NEW.duration_seconds != 0
        OR NEW.admin_adjusted_duration_seconds IS NOT NULL
        OR NEW.reconciliation_status != 'CLEAR'
      ))
      OR (NEW.ended_at IS NOT NULL AND (
        NEW.status != 'COMPLETED' OR julianday(NEW.ended_at) IS NULL
        OR julianday(NEW.ended_at) < julianday(NEW.started_at)
      ))
      OR (NEW.status = 'COMPLETED' AND NEW.ended_at IS NULL AND (
        NEW.source_schedule_record_id IS NOT NULL OR NEW.source_schedule_updated_at IS NOT NULL
        OR NEW.attendance_early_window_minutes IS NOT NULL OR NEW.attendance_max_shift_minutes IS NOT NULL
        OR NEW.reconciliation_status != 'CLEAR' OR NEW.duration_seconds != 0
        OR NEW.admin_adjusted_duration_seconds IS NOT NULL
        OR NEW.tiktok != 0 OR NEW.tiktok_allowance != 0 OR NEW.tasks_completed != 0
        OR NEW.expense_amount != 0 OR NEW.cash_revenue != 0 OR NEW.transfer_revenue != 0
      ))
      OR (NEW.status = 'COMPLETED' AND NEW.ended_at IS NOT NULL
        AND (NEW.source_schedule_record_id IS NOT NULL
          OR NEW.source_schedule_updated_at IS NOT NULL
          OR NEW.attendance_early_window_minutes IS NOT NULL
          OR NEW.attendance_max_shift_minutes IS NOT NULL)
        AND NEW.admin_adjusted_duration_seconds IS NULL
        AND ABS(NEW.duration_seconds - CAST(ROUND(
          (julianday(NEW.ended_at) - julianday(NEW.started_at)) * 86400
        ) AS INTEGER)) > 1)
      OR (NEW.attendance_max_shift_minutes IS NOT NULL
        AND COALESCE(NEW.admin_adjusted_duration_seconds, NEW.duration_seconds)
          > NEW.attendance_max_shift_minutes * 60
        AND NEW.reconciliation_status = 'CLEAR')
    BEGIN SELECT RAISE(ABORT, 'invalid shift session integrity'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_validate_update_v2
    BEFORE UPDATE ON shift_sessions
    WHEN NEW.status NOT IN ('ACTIVE', 'COMPLETED')
      OR julianday(NEW.started_at) IS NULL
      OR (NEW.work_date IS NOT NULL AND (
        NEW.work_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        OR date(NEW.work_date) IS NOT NEW.work_date
      ))
      OR (NEW.scheduled_start_at IS NULL) != (NEW.scheduled_end_at IS NULL)
      OR (NEW.scheduled_start_at IS NOT NULL AND (
        julianday(NEW.scheduled_start_at) IS NULL
        OR julianday(NEW.scheduled_end_at) IS NULL
        OR julianday(NEW.scheduled_end_at) <= julianday(NEW.scheduled_start_at)
      ))
      OR (NEW.source_schedule_record_id IS NULL) != (NEW.source_schedule_updated_at IS NULL)
      OR (NEW.source_schedule_record_id IS NOT NULL AND (
        length(trim(NEW.source_schedule_record_id)) = 0
        OR julianday(NEW.source_schedule_updated_at) IS NULL
      ))
      OR typeof(NEW.attendance_grace_minutes) != 'integer'
      OR NEW.attendance_grace_minutes NOT BETWEEN 0 AND 120
      OR (NEW.attendance_early_window_minutes IS NOT NULL
        AND (typeof(NEW.attendance_early_window_minutes) != 'integer'
          OR NEW.attendance_early_window_minutes NOT BETWEEN 0 AND 1440))
      OR (NEW.attendance_max_shift_minutes IS NOT NULL
        AND (typeof(NEW.attendance_max_shift_minutes) != 'integer'
          OR NEW.attendance_max_shift_minutes NOT BETWEEN 1 AND 10080))
      OR NEW.attendance_status NOT IN ('EARLY', 'ON_TIME', 'LATE')
      OR (NEW.attendance_status IS NULL) != (NEW.attendance_delta_minutes IS NULL)
      OR (NEW.attendance_delta_minutes IS NOT NULL
        AND typeof(NEW.attendance_delta_minutes) != 'integer')
      OR (NEW.applied_hourly_rate IS NOT NULL
        AND (typeof(NEW.applied_hourly_rate) != 'integer' OR NEW.applied_hourly_rate < 0))
      OR (NEW.applied_tiktok_allowance IS NOT NULL
        AND (typeof(NEW.applied_tiktok_allowance) != 'integer' OR NEW.applied_tiktok_allowance < 0))
      OR typeof(NEW.duration_seconds) != 'integer' OR NEW.duration_seconds < 0
      OR (NEW.admin_adjusted_duration_seconds IS NOT NULL AND (
        typeof(NEW.admin_adjusted_duration_seconds) != 'integer'
        OR NEW.admin_adjusted_duration_seconds < 0
      ))
      OR NEW.tiktok NOT IN (0, 1) OR NEW.tasks_completed NOT IN (0, 1)
      OR typeof(NEW.tiktok_allowance) != 'integer' OR NEW.tiktok_allowance < 0
      OR typeof(NEW.expense_amount) != 'integer' OR NEW.expense_amount < 0
      OR typeof(NEW.cash_revenue) != 'integer' OR NEW.cash_revenue < 0
      OR typeof(NEW.transfer_revenue) != 'integer' OR NEW.transfer_revenue < 0
      OR NOT (
        (NEW.clock_in_latitude IS NULL AND NEW.clock_in_longitude IS NULL
          AND NEW.clock_in_accuracy_meters IS NULL AND NEW.clock_in_location_captured_at IS NULL)
        OR (NEW.clock_in_latitude IS NOT NULL AND NEW.clock_in_latitude BETWEEN -90 AND 90
          AND typeof(NEW.clock_in_latitude) IN ('integer', 'real')
          AND NEW.clock_in_longitude IS NOT NULL AND NEW.clock_in_longitude BETWEEN -180 AND 180
          AND typeof(NEW.clock_in_longitude) IN ('integer', 'real')
          AND NEW.clock_in_accuracy_meters IS NOT NULL AND NEW.clock_in_accuracy_meters BETWEEN 0 AND 100000
          AND typeof(NEW.clock_in_accuracy_meters) IN ('integer', 'real')
          AND julianday(NEW.clock_in_location_captured_at) IS NOT NULL)
      )
      OR NOT (
        (NEW.reconciliation_status = 'CLEAR' AND NEW.reconciliation_reason IS NULL
          AND NEW.reconciled_at IS NULL AND NEW.reconciled_by IS NULL)
        OR (NEW.reconciliation_status = 'REQUIRED'
          AND length(trim(COALESCE(NEW.reconciliation_reason, ''))) > 0
          AND NEW.reconciled_at IS NULL AND NEW.reconciled_by IS NULL)
        OR (NEW.reconciliation_status = 'CONFIRMED'
          AND length(trim(COALESCE(NEW.reconciliation_reason, ''))) > 0
          AND julianday(NEW.reconciled_at) IS NOT NULL
          AND length(trim(COALESCE(NEW.reconciled_by, ''))) > 0)
      )
      OR (NEW.status = 'ACTIVE' AND (
        NEW.ended_at IS NOT NULL OR NEW.duration_seconds != 0
        OR NEW.admin_adjusted_duration_seconds IS NOT NULL
        OR NEW.reconciliation_status != 'CLEAR'
      ))
      OR (NEW.ended_at IS NOT NULL AND (
        NEW.status != 'COMPLETED' OR julianday(NEW.ended_at) IS NULL
        OR julianday(NEW.ended_at) < julianday(NEW.started_at)
      ))
      OR (NEW.status = 'COMPLETED' AND NEW.ended_at IS NULL AND (
        OLD.status != 'COMPLETED'
        OR NEW.source_schedule_record_id IS NOT NULL OR NEW.source_schedule_updated_at IS NOT NULL
        OR NEW.attendance_early_window_minutes IS NOT NULL OR NEW.attendance_max_shift_minutes IS NOT NULL
        OR NEW.reconciliation_status != 'CLEAR' OR NEW.duration_seconds != 0
        OR NEW.admin_adjusted_duration_seconds IS NOT NULL
        OR NEW.tiktok != 0 OR NEW.tiktok_allowance != 0 OR NEW.tasks_completed != 0
        OR NEW.expense_amount != 0 OR NEW.cash_revenue != 0 OR NEW.transfer_revenue != 0
      ))
      OR (NEW.status = 'COMPLETED' AND NEW.ended_at IS NOT NULL
        AND (OLD.status != 'COMPLETED'
          OR NEW.source_schedule_record_id IS NOT NULL
          OR NEW.source_schedule_updated_at IS NOT NULL
          OR NEW.attendance_early_window_minutes IS NOT NULL
          OR NEW.attendance_max_shift_minutes IS NOT NULL)
        AND NEW.admin_adjusted_duration_seconds IS NULL
        AND ABS(NEW.duration_seconds - CAST(ROUND(
          (julianday(NEW.ended_at) - julianday(NEW.started_at)) * 86400
        ) AS INTEGER)) > 1)
      OR (NEW.attendance_max_shift_minutes IS NOT NULL
        AND COALESCE(NEW.admin_adjusted_duration_seconds, NEW.duration_seconds)
          > NEW.attendance_max_shift_minutes * 60
        AND NEW.reconciliation_status = 'CLEAR')
    BEGIN SELECT RAISE(ABORT, 'invalid shift session integrity'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_locked_insert
    BEFORE INSERT ON shift_sessions
    WHEN EXISTS (
      SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = NEW.store_id
        AND locked_period.period = COALESCE(
          CASE WHEN NEW.work_date GLOB '????-??-??' THEN substr(NEW.work_date, 1, 7) END,
          strftime('%Y-%m', NEW.started_at, '+7 hours')
        )
        AND locked_period.status = 'LOCKED'
    )
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept shift sessions'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_locked_update
    BEFORE UPDATE ON shift_sessions
    WHEN EXISTS (
      SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = OLD.store_id
        AND locked_period.period = COALESCE(
          CASE WHEN OLD.work_date GLOB '????-??-??' THEN substr(OLD.work_date, 1, 7) END,
          strftime('%Y-%m', OLD.started_at, '+7 hours')
        )
        AND locked_period.status = 'LOCKED'
    ) OR EXISTS (
      SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = NEW.store_id
        AND locked_period.period = COALESCE(
          CASE WHEN NEW.work_date GLOB '????-??-??' THEN substr(NEW.work_date, 1, 7) END,
          strftime('%Y-%m', NEW.started_at, '+7 hours')
        )
        AND locked_period.status = 'LOCKED'
    )
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept shift session changes'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_locked_delete
    BEFORE DELETE ON shift_sessions
    WHEN EXISTS (
      SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = OLD.store_id
        AND locked_period.period = COALESCE(
          CASE WHEN OLD.work_date GLOB '????-??-??' THEN substr(OLD.work_date, 1, 7) END,
          strftime('%Y-%m', OLD.started_at, '+7 hours')
        )
        AND locked_period.status = 'LOCKED'
    )
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept shift session changes'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_daily_shift_definitions_validate_insert_v2
    BEFORE INSERT ON daily_shift_definitions
    WHEN NEW.status NOT IN ('ACTIVE', 'DELETED') OR NEW.version < 1
      OR NEW.work_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.work_date) IS NOT NEW.work_date
      OR NEW.start_time NOT GLOB '[0-2][0-9]:[0-5][0-9]'
      OR NEW.end_time NOT GLOB '[0-2][0-9]:[0-5][0-9]'
      OR substr(NEW.start_time, 1, 2) NOT BETWEEN '00' AND '23'
      OR substr(NEW.end_time, 1, 2) NOT BETWEEN '00' AND '23'
      OR substr(NEW.start_time, 4, 2) NOT BETWEEN '00' AND '59'
      OR substr(NEW.end_time, 4, 2) NOT BETWEEN '00' AND '59'
      OR NEW.start_time = NEW.end_time
      OR length(trim(NEW.name)) = 0 OR length(trim(NEW.name_key)) = 0
      OR (NEW.status = 'ACTIVE' AND NEW.deleted_at IS NOT NULL)
      OR (NEW.status = 'DELETED' AND NEW.deleted_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'invalid daily shift definition integrity'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_daily_shift_definitions_validate_update_v2
    BEFORE UPDATE ON daily_shift_definitions
    WHEN NEW.status NOT IN ('ACTIVE', 'DELETED') OR NEW.version < 1
      OR NEW.work_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      OR date(NEW.work_date) IS NOT NEW.work_date
      OR NEW.start_time NOT GLOB '[0-2][0-9]:[0-5][0-9]'
      OR NEW.end_time NOT GLOB '[0-2][0-9]:[0-5][0-9]'
      OR substr(NEW.start_time, 1, 2) NOT BETWEEN '00' AND '23'
      OR substr(NEW.end_time, 1, 2) NOT BETWEEN '00' AND '23'
      OR substr(NEW.start_time, 4, 2) NOT BETWEEN '00' AND '59'
      OR substr(NEW.end_time, 4, 2) NOT BETWEEN '00' AND '59'
      OR NEW.start_time = NEW.end_time
      OR length(trim(NEW.name)) = 0 OR length(trim(NEW.name_key)) = 0
      OR (NEW.status = 'ACTIVE' AND NEW.deleted_at IS NOT NULL)
      OR (NEW.status = 'DELETED' AND NEW.deleted_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'invalid daily shift definition integrity'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_daily_shift_definitions_locked_insert
    BEFORE INSERT ON daily_shift_definitions
    WHEN EXISTS (SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = NEW.store_id
        AND locked_period.period = substr(NEW.work_date, 1, 7)
        AND locked_period.status = 'LOCKED')
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept daily shifts'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_daily_shift_definitions_locked_update
    BEFORE UPDATE ON daily_shift_definitions
    WHEN EXISTS (SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = OLD.store_id
        AND locked_period.period = substr(OLD.work_date, 1, 7)
        AND locked_period.status = 'LOCKED')
      OR EXISTS (SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = NEW.store_id
        AND locked_period.period = substr(NEW.work_date, 1, 7)
        AND locked_period.status = 'LOCKED')
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept daily shift changes'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_daily_shift_definitions_locked_delete
    BEFORE DELETE ON daily_shift_definitions
    WHEN EXISTS (SELECT 1 FROM financial_periods locked_period
      WHERE locked_period.store_id = OLD.store_id
        AND locked_period.period = substr(OLD.work_date, 1, 7)
        AND locked_period.status = 'LOCKED')
    BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept daily shift changes'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_support_allowance_insert
    BEFORE INSERT ON shift_sessions
    WHEN NEW.applied_support_allowance IS NOT NULL AND (
      typeof(NEW.applied_support_allowance) != 'integer' OR NEW.applied_support_allowance < 0
    )
    BEGIN SELECT RAISE(ABORT, 'invalid applied support allowance'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_shift_sessions_support_allowance_update
    BEFORE UPDATE OF applied_support_allowance ON shift_sessions
    WHEN NEW.applied_support_allowance IS NOT NULL AND (
      typeof(NEW.applied_support_allowance) != 'integer' OR NEW.applied_support_allowance < 0
    )
    BEGIN SELECT RAISE(ABORT, 'invalid applied support allowance'); END`,
];

const finalizedPeriodStatusesSql = "('CONFIRMED', 'PAID', 'LOCKED')";

function finalizedSourceGuardStatements(input: Readonly<{
  table: string;
  triggerPrefix: string;
  oldPeriodSql: string;
  newPeriodSql: string;
  entity: string;
  oldPredicateSql?: string;
  newPredicateSql?: string;
}>) {
  const oldPredicate = input.oldPredicateSql ? `(${input.oldPredicateSql}) AND ` : "";
  const newPredicate = input.newPredicateSql ? `(${input.newPredicateSql}) AND ` : "";
  return [
    `CREATE TRIGGER IF NOT EXISTS ${input.triggerPrefix}_finalized_insert
      BEFORE INSERT ON ${input.table}
      WHEN ${newPredicate}EXISTS (
        SELECT 1 FROM financial_periods period
        WHERE period.store_id = NEW.store_id
          AND period.period = ${input.newPeriodSql}
          AND period.status IN ${finalizedPeriodStatusesSql}
      )
      BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept ${input.entity}'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${input.triggerPrefix}_finalized_update
      BEFORE UPDATE ON ${input.table}
      WHEN (${oldPredicate}EXISTS (
        SELECT 1 FROM financial_periods period
        WHERE period.store_id = OLD.store_id
          AND period.period = ${input.oldPeriodSql}
          AND period.status IN ${finalizedPeriodStatusesSql}
      )) OR (${newPredicate}EXISTS (
        SELECT 1 FROM financial_periods period
        WHERE period.store_id = NEW.store_id
          AND period.period = ${input.newPeriodSql}
          AND period.status IN ${finalizedPeriodStatusesSql}
      ))
      BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept ${input.entity} changes'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${input.triggerPrefix}_finalized_delete
      BEFORE DELETE ON ${input.table}
      WHEN ${oldPredicate}EXISTS (
        SELECT 1 FROM financial_periods period
        WHERE period.store_id = OLD.store_id
          AND period.period = ${input.oldPeriodSql}
          AND period.status IN ${finalizedPeriodStatusesSql}
      )
      BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept ${input.entity} changes'); END`,
  ];
}

const shiftSessionOldPeriodSql = `COALESCE(
  CASE WHEN OLD.work_date GLOB '????-??-??' THEN substr(OLD.work_date, 1, 7) END,
  strftime('%Y-%m', OLD.started_at, '+7 hours')
)`;
const shiftSessionNewPeriodSql = `COALESCE(
  CASE WHEN NEW.work_date GLOB '????-??-??' THEN substr(NEW.work_date, 1, 7) END,
  strftime('%Y-%m', NEW.started_at, '+7 hours')
)`;
const businessRecordCategoriesSql = "'CHI_PHI_CO_DINH', 'DONG_TIEN', 'NHAP_HANG', 'LUONG_THUONG'";
const businessRecordOldPeriodSql = `CASE
  WHEN OLD.category = 'CHI_PHI_CO_DINH' THEN json_extract(OLD.data_json, '$.period')
  ELSE COALESCE(json_extract(OLD.data_json, '$.period'), substr(json_extract(OLD.data_json, '$.date'), 1, 7))
END`;
const businessRecordNewPeriodSql = `CASE
  WHEN NEW.category = 'CHI_PHI_CO_DINH' THEN json_extract(NEW.data_json, '$.period')
  ELSE COALESCE(json_extract(NEW.data_json, '$.period'), substr(json_extract(NEW.data_json, '$.date'), 1, 7))
END`;

const financialPeriodLifecycleGuardStatements = [
  `CREATE TRIGGER IF NOT EXISTS trg_financial_periods_initial_state
    BEFORE INSERT ON financial_periods
    WHEN NEW.status != 'DRAFT' OR NEW.revision != 0
    BEGIN SELECT RAISE(ABORT, 'financial period must start as DRAFT revision 0'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_financial_periods_adjacent_transition
    BEFORE UPDATE OF status ON financial_periods
    WHEN OLD.status IS NOT NEW.status AND (
      NEW.revision != OLD.revision + 1
      OR NOT (
        (OLD.status = 'DRAFT' AND NEW.status = 'CALCULATED')
        OR (OLD.status = 'CALCULATED' AND NEW.status = 'RECONCILING')
        OR (OLD.status = 'RECONCILING' AND NEW.status = 'CONFIRMED')
        OR (OLD.status = 'CONFIRMED' AND NEW.status = 'PAID')
        OR (OLD.status = 'PAID' AND NEW.status = 'LOCKED')
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invalid financial period lifecycle transition'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_financial_periods_confirmed_snapshot_freeze
    BEFORE UPDATE ON financial_periods
    WHEN OLD.status IN ${finalizedPeriodStatusesSql} AND (
      NEW.id IS NOT OLD.id
      OR NEW.store_id IS NOT OLD.store_id
      OR NEW.period IS NOT OLD.period
      OR NEW.policy_version_id IS NOT OLD.policy_version_id
      OR NEW.config_version IS NOT OLD.config_version
      OR NEW.gross_revenue IS NOT OLD.gross_revenue
      OR NEW.fixed_expense IS NOT OLD.fixed_expense
      OR NEW.variable_expense IS NOT OLD.variable_expense
      OR NEW.inventory_cost IS NOT OLD.inventory_cost
      OR NEW.inventory_shipping_cost IS NOT OLD.inventory_shipping_cost
      OR NEW.employee_salary IS NOT OLD.employee_salary
      OR NEW.manager_salary IS NOT OLD.manager_salary
      OR NEW.manual_bonus IS NOT OLD.manual_bonus
      OR NEW.allowance IS NOT OLD.allowance
      OR NEW.total_hours_seconds IS NOT OLD.total_hours_seconds
      OR NEW.employee_kpi_total IS NOT OLD.employee_kpi_total
      OR NEW.manager_kpi IS NOT OLD.manager_kpi
      OR NEW.operating_profit IS NOT OLD.operating_profit
      OR NEW.profit_after_kpi IS NOT OLD.profit_after_kpi
      OR NEW.month_end_expense IS NOT OLD.month_end_expense
      OR NEW.final_profit IS NOT OLD.final_profit
      OR NEW.distributable_profit IS NOT OLD.distributable_profit
      OR NEW.salary_advance IS NOT OLD.salary_advance
      OR NEW.employee_payroll_rows_json IS NOT OLD.employee_payroll_rows_json
      OR NEW.manager_payroll_json IS NOT OLD.manager_payroll_json
      OR NEW.config_snapshot_json IS NOT OLD.config_snapshot_json
      OR NEW.calculated_at IS NOT OLD.calculated_at
      OR NEW.calculated_by IS NOT OLD.calculated_by
      OR NEW.confirmed_at IS NOT OLD.confirmed_at
      OR NEW.confirmed_by IS NOT OLD.confirmed_by
      OR NEW.created_at IS NOT OLD.created_at
      OR (NEW.status = OLD.status AND NEW.revision IS NOT OLD.revision)
      OR (OLD.status IN ('PAID', 'LOCKED') AND (
        NEW.paid_at IS NOT OLD.paid_at OR NEW.paid_by IS NOT OLD.paid_by
      ))
      OR json_remove(
        NEW.snapshot_json, '$.status', '$.paidAt', '$.paidBy', '$.lockedAt', '$.lockedBy'
      ) IS NOT json_remove(
        OLD.snapshot_json, '$.status', '$.paidAt', '$.paidBy', '$.lockedAt', '$.lockedBy'
      )
      OR json_extract(NEW.snapshot_json, '$.status') IS NOT NEW.status
      OR json_extract(NEW.snapshot_json, '$.paidAt') IS NOT NEW.paid_at
      OR json_extract(NEW.snapshot_json, '$.paidBy') IS NOT NEW.paid_by
      OR json_extract(NEW.snapshot_json, '$.lockedAt') IS NOT NEW.locked_at
      OR json_extract(NEW.snapshot_json, '$.lockedBy') IS NOT NEW.locked_by
    )
    BEGIN SELECT RAISE(ABORT, 'CONFIRMED financial snapshot is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_financial_periods_confirmed_delete
    BEFORE DELETE ON financial_periods
    WHEN OLD.status IN ${finalizedPeriodStatusesSql}
    BEGIN SELECT RAISE(ABORT, 'finalized financial period cannot be deleted'); END`,
  ...finalizedSourceGuardStatements({
    table: "month_end_expenses",
    triggerPrefix: "trg_month_end_expenses",
    oldPeriodSql: "OLD.period",
    newPeriodSql: "NEW.period",
    entity: "month-end expense",
  }),
  ...finalizedSourceGuardStatements({
    table: "shift_sessions",
    triggerPrefix: "trg_shift_sessions",
    oldPeriodSql: shiftSessionOldPeriodSql,
    newPeriodSql: shiftSessionNewPeriodSql,
    entity: "shift session",
  }),
  ...finalizedSourceGuardStatements({
    table: "daily_shift_definitions",
    triggerPrefix: "trg_daily_shift_definitions",
    oldPeriodSql: "substr(OLD.work_date, 1, 7)",
    newPeriodSql: "substr(NEW.work_date, 1, 7)",
    entity: "daily shift",
  }),
  ...finalizedSourceGuardStatements({
    table: "orders",
    triggerPrefix: "trg_orders",
    oldPeriodSql: "strftime('%Y-%m', OLD.created_at, '+7 hours')",
    newPeriodSql: "strftime('%Y-%m', NEW.created_at, '+7 hours')",
    entity: "order",
  }),
  ...finalizedSourceGuardStatements({
    table: "business_records",
    triggerPrefix: "trg_business_records",
    oldPeriodSql: businessRecordOldPeriodSql,
    newPeriodSql: businessRecordNewPeriodSql,
    entity: "financial business record",
    oldPredicateSql: `OLD.category IN (${businessRecordCategoriesSql})`,
    newPredicateSql: `NEW.category IN (${businessRecordCategoriesSql})`,
  }),
  ...finalizedSourceGuardStatements({
    table: "salary_advances",
    triggerPrefix: "trg_salary_advances",
    oldPeriodSql: "OLD.period",
    newPeriodSql: "NEW.period",
    entity: "salary advance",
  }),
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
  // Install the daily-shift LOCKED guards before any compatibility backfill.
  // The broader shift trigger set depends on additive columns created later,
  // but these guards only depend on the two baseline tables and therefore can
  // protect historical periods from the first possible source mutation.
  await db.batch(shiftAttendanceIntegrityStatements
    .filter((sql) => sql.includes("trg_daily_shift_definitions_locked_"))
    .map((sql) => db.prepare(sql)));
  // The original audit table predates structured before/after snapshots. Add
  // each column only when missing so both upgraded and already-migrated
  // databases retain every historical row and can safely restart.
  const auditColumns = await db.prepare("PRAGMA table_info(audit_logs)").all<{ name: string }>();
  const existingAuditColumns = new Set(auditColumns.results.map((column) => column.name));
  const missingAuditColumns = [
    ["before_json", "ALTER TABLE audit_logs ADD COLUMN before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json))"],
    ["after_json", "ALTER TABLE audit_logs ADD COLUMN after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json))"],
    ["reason", "ALTER TABLE audit_logs ADD COLUMN reason TEXT"],
    ["store_id", "ALTER TABLE audit_logs ADD COLUMN store_id TEXT"],
  ].filter(([column]) => !existingAuditColumns.has(column));
  if (missingAuditColumns.length) {
    await db.batch(missingAuditColumns.map(([, sql]) => db.prepare(sql)));
  }
  // These indexes must be created after compatibility columns exist; creating
  // them in the initial schema batch would fail on a legacy audit table.
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created ON audit_logs(entity_type, entity_id, created_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_audit_logs_store_created ON audit_logs(store_id, created_at)").run();
  const cashflowColumns = await db.prepare("PRAGMA table_info(cashflow_entries)").all<{ name: string }>();
  const existingCashflowColumns = new Set(cashflowColumns.results.map((column) => column.name));
  const missingCashflowColumns = [
    ["client_request_id", "ALTER TABLE cashflow_entries ADD COLUMN client_request_id TEXT"],
    ["payload_hash", "ALTER TABLE cashflow_entries ADD COLUMN payload_hash TEXT"],
    ["reverses_entry_id", "ALTER TABLE cashflow_entries ADD COLUMN reverses_entry_id TEXT REFERENCES cashflow_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT"],
  ].filter(([column]) => !existingCashflowColumns.has(column));
  if (missingCashflowColumns.length) {
    await db.batch(missingCashflowColumns.map(([, sql]) => db.prepare(sql)));
  }
  await db.batch(cashflowLedgerSchemaStatements.map((sql) => db.prepare(sql)));
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
        FROM snapshots
        WHERE NOT EXISTS (
          SELECT 1 FROM financial_periods locked_period
          WHERE locked_period.store_id = snapshots.storeId
            AND locked_period.period = substr(snapshots.workDate, 1, 7)
            AND locked_period.status IN ('CONFIRMED', 'PAID', 'LOCKED')
        )`).bind(backfilledAt, backfilledAt),
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
    ["source_schedule_record_id", "ALTER TABLE shift_sessions ADD COLUMN source_schedule_record_id TEXT"],
    ["source_schedule_updated_at", "ALTER TABLE shift_sessions ADD COLUMN source_schedule_updated_at TEXT"],
    ["applied_hourly_rate", "ALTER TABLE shift_sessions ADD COLUMN applied_hourly_rate INTEGER"],
    ["applied_tiktok_allowance", "ALTER TABLE shift_sessions ADD COLUMN applied_tiktok_allowance INTEGER"],
    ["applied_support_allowance", "ALTER TABLE shift_sessions ADD COLUMN applied_support_allowance INTEGER"],
    ["attendance_status", "ALTER TABLE shift_sessions ADD COLUMN attendance_status TEXT"],
    ["attendance_delta_minutes", "ALTER TABLE shift_sessions ADD COLUMN attendance_delta_minutes INTEGER"],
    ["attendance_grace_minutes", "ALTER TABLE shift_sessions ADD COLUMN attendance_grace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (attendance_grace_minutes BETWEEN 0 AND 120)"],
    ["attendance_early_window_minutes", "ALTER TABLE shift_sessions ADD COLUMN attendance_early_window_minutes INTEGER"],
    ["attendance_max_shift_minutes", "ALTER TABLE shift_sessions ADD COLUMN attendance_max_shift_minutes INTEGER"],
    ["clock_in_latitude", "ALTER TABLE shift_sessions ADD COLUMN clock_in_latitude REAL"],
    ["clock_in_longitude", "ALTER TABLE shift_sessions ADD COLUMN clock_in_longitude REAL"],
    ["clock_in_accuracy_meters", "ALTER TABLE shift_sessions ADD COLUMN clock_in_accuracy_meters REAL"],
    ["clock_in_location_captured_at", "ALTER TABLE shift_sessions ADD COLUMN clock_in_location_captured_at TEXT"],
    ["duration_seconds", "ALTER TABLE shift_sessions ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0"],
    ["admin_adjusted_duration_seconds", "ALTER TABLE shift_sessions ADD COLUMN admin_adjusted_duration_seconds INTEGER"],
    ["close_reason", "ALTER TABLE shift_sessions ADD COLUMN close_reason TEXT"],
    ["close_status", "ALTER TABLE shift_sessions ADD COLUMN close_status TEXT NOT NULL DEFAULT 'PENDING'"],
    ["reconciliation_status", "ALTER TABLE shift_sessions ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'CLEAR'"],
    ["reconciliation_reason", "ALTER TABLE shift_sessions ADD COLUMN reconciliation_reason TEXT"],
    ["reconciled_at", "ALTER TABLE shift_sessions ADD COLUMN reconciled_at TEXT"],
    ["reconciled_by", "ALTER TABLE shift_sessions ADD COLUMN reconciled_by TEXT"],
  ].filter(([column]) => !existingShiftColumns.has(column));
  if (missingShiftColumns.length) await db.batch(missingShiftColumns.map(([, sql]) => db.prepare(sql)));
  // Hydrate only open legacy TikTok sessions from their employee configuration.
  // Completed sessions remain untouched because a NULL value means the row
  // predates TikTok snapshot support and must not be rewritten as fact.
  await db.prepare(`UPDATE shift_sessions SET applied_tiktok_allowance = (
      SELECT employee.tiktok_allowance FROM employees employee
      WHERE employee.id = shift_sessions.employee_id
    )
    WHERE status = 'ACTIVE' AND applied_tiktok_allowance IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM financial_periods locked_period
        WHERE locked_period.store_id = shift_sessions.store_id
          AND locked_period.period = COALESCE(
            CASE WHEN shift_sessions.work_date GLOB '????-??-??'
              THEN substr(shift_sessions.work_date, 1, 7) END,
            strftime('%Y-%m', shift_sessions.started_at, '+7 hours')
          )
          AND locked_period.status IN ('CONFIRMED', 'PAID', 'LOCKED')
      )`).run();
  await db.prepare(`UPDATE shift_sessions SET applied_support_allowance = COALESCE((
      SELECT transfer.support_allowance FROM employee_transfers transfer
      WHERE transfer.id = shift_sessions.transfer_id
    ), 0)
    WHERE applied_support_allowance IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM financial_periods locked_period
        WHERE locked_period.store_id = shift_sessions.store_id
          AND locked_period.period = COALESCE(
            CASE WHEN shift_sessions.work_date GLOB '????-??-??'
              THEN substr(shift_sessions.work_date, 1, 7) END,
            strftime('%Y-%m', shift_sessions.started_at, '+7 hours')
          )
          AND locked_period.status IN ('CONFIRMED', 'PAID', 'LOCKED')
      )`).run();
  // Existing rows retain their recorded classification and their legacy
  // 15-minute snapshot. Only incomplete legacy rows are hydrated; changing the
  // global policy must never rewrite attendance history.
  await db.prepare(`UPDATE shift_sessions SET
      attendance_delta_minutes = ${attendanceDeltaMinutesSql},
      attendance_status = ${attendanceStatusSql}
    WHERE scheduled_start_at IS NOT NULL
      AND status = 'ACTIVE'
      AND julianday(started_at) IS NOT NULL
      AND julianday(scheduled_start_at) IS NOT NULL
      AND (attendance_status IS NULL OR attendance_delta_minutes IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM financial_periods locked_period
        WHERE locked_period.store_id = shift_sessions.store_id
          AND locked_period.period = COALESCE(
            CASE WHEN shift_sessions.work_date GLOB '????-??-??'
              THEN substr(shift_sessions.work_date, 1, 7) END,
            strftime('%Y-%m', shift_sessions.started_at, '+7 hours')
          )
          AND locked_period.status IN ('CONFIRMED', 'PAID', 'LOCKED')
      )`).run();
  await db.batch(shiftAttendanceIntegrityStatements.map((sql) => db.prepare(sql)));
  // Compatibility hydration above deliberately skips CONFIRMED/PAID/LOCKED.
  // Install the stronger source/lifecycle freeze only after legacy columns and
  // open-period compatibility rows are ready; this bootstrap never rewrites a
  // finalized financial fact.
  await db.batch(financialPeriodLifecycleGuardStatements.map((sql) => db.prepare(sql)));
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
    ["cccd_number", "ALTER TABLE employees ADD COLUMN cccd_number TEXT CHECK (cccd_number IS NULL OR (length(cccd_number) = 12 AND cccd_number NOT GLOB '*[^0-9]*'))"],
    ["cccd_image_key", "ALTER TABLE employees ADD COLUMN cccd_image_key TEXT"],
    ["cccd_image_name", "ALTER TABLE employees ADD COLUMN cccd_image_name TEXT"],
    ["tiktok_allowance", "ALTER TABLE employees ADD COLUMN tiktok_allowance INTEGER NOT NULL DEFAULT 0"],
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
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_live_cccd_number
    ON employees(cccd_number)
    WHERE cccd_number IS NOT NULL AND status != 'ARCHIVED' AND deleted_at IS NULL`).run();

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

export type StructuredAuditInput = {
  detail?: string | null;
  storeId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};

export type StructuredAuditInsertOptions = {
  id?: string;
  createdAt?: string;
};

function serializeAuditJson(value: unknown) {
  if (value === undefined) return null;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Structured audit snapshots must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new TypeError("Structured audit snapshots must be JSON-serializable");
  }
  // JSON.stringify is the serializer of record. Parse once before persistence
  // so invalid custom serialization can never enter the constrained columns.
  try {
    JSON.parse(serialized);
  } catch {
    throw new TypeError("Structured audit snapshots must contain valid JSON");
  }
  return serialized;
}

/** Build an audit write for inclusion in the caller's atomic db.batch. */
export function prepareStructuredAuditInsert(
  db: D1Database,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  input: StructuredAuditInput = {},
  options: StructuredAuditInsertOptions = {},
) {
  const beforeJson = serializeAuditJson(input.before);
  const afterJson = serializeAuditJson(input.after);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const parsedCreatedAt = new Date(createdAt);
  if (!Number.isFinite(parsedCreatedAt.getTime()) || parsedCreatedAt.toISOString() !== createdAt) {
    throw new TypeError("Structured audit createdAt must be a canonical UTC ISO timestamp");
  }
  return db.prepare(`INSERT INTO audit_logs
      (id, user_id, action, entity_type, entity_id, detail, created_at, before_json, after_json, reason, store_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      options.id ?? crypto.randomUUID(),
      userId,
      action,
      entityType,
      entityId,
      input.detail ?? null,
      createdAt,
      beforeJson,
      afterJson,
      input.reason ?? null,
      input.storeId ?? null,
    );
}

export async function writeStructuredAudit(
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  input: StructuredAuditInput = {},
) {
  const db = await initDb();
  await prepareStructuredAuditInsert(db, userId, action, entityType, entityId, input).run();
}

export async function writeAudit(userId: string | null, action: string, entityType: string, entityId: string | null, detail?: string) {
  await writeStructuredAudit(userId, action, entityType, entityId, { detail });
}
