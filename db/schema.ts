import { sql } from "drizzle-orm";
import { AnySQLiteColumn, check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const stores = sqliteTable("stores", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  address: text("address").notNull(),
  revenue: integer("revenue").notNull().default(0),
  expense: integer("expense").notNull().default(0),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: text("created_at").notNull(),
});

export const employees = sqliteTable("employees", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  position: text("position").notNull(),
  phone: text("phone").notNull(),
  province: text("province").notNull().default(""),
  ward: text("ward").notNull().default(""),
  addressLine: text("address_line").notNull().default(""),
  age: integer("age"),
  cccdNumber: text("cccd_number"),
  cccdImageKey: text("cccd_image_key"),
  cccdImageName: text("cccd_image_name"),
  hourlyRate: integer("hourly_rate").notNull().default(20000),
  tiktokAllowance: integer("tiktok_allowance").notNull().default(25000),
  status: text("status").notNull().default("ACTIVE"),
  inactiveAt: text("inactive_at"),
  statusUpdatedAt: text("status_updated_at"),
  lifecycleVersion: integer("lifecycle_version").notNull().default(0),
  deletedAt: text("deleted_at"),
  deletedBy: text("deleted_by"),
}, (table) => [
  uniqueIndex("idx_employees_live_cccd_number")
    .on(table.cccdNumber)
    .where(sql`${table.cccdNumber} IS NOT NULL AND ${table.status} != 'ARCHIVED' AND ${table.deletedAt} IS NULL`),
]);

export const employeeStatusHistory = sqliteTable("employee_status_history", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id").notNull(),
  storeId: text("store_id").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  effectiveAt: text("effective_at").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_employee_status_history_employee_effective")
    .on(table.employeeId, table.effectiveAt, table.id),
  index("idx_employee_status_history_store_effective")
    .on(table.storeId, table.effectiveAt, table.id),
]);

export const cccdDeletionOutbox = sqliteTable("cccd_deletion_outbox", {
  key: text("key").primaryKey(),
  employeeId: text("employee_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  reason: text("reason").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_cccd_deletion_outbox_created").on(table.createdAt, table.key),
]);

export const cccdUploadRegistry = sqliteTable("cccd_upload_registry", {
  key: text("key").primaryKey(),
  actorUserId: text("actor_user_id").notNull(),
  actorStoreId: text("actor_store_id"),
  actorGlobalAccess: integer("actor_global_access").notNull().default(0),
  originalName: text("original_name"),
  contentType: text("content_type").notNull(),
  createdAt: text("created_at").notNull(),
  claimStatus: text("claim_status").notNull().default("PENDING"),
  claimedAt: text("claimed_at"),
  claimedEmployeeId: text("claimed_employee_id"),
  deletionStatus: text("deletion_status").notNull().default("NONE"),
  deleteRequestedAt: text("delete_requested_at"),
  deletedAt: text("deleted_at"),
  deletionAttempts: integer("deletion_attempts").notNull().default(0),
  lastDeletionError: text("last_deletion_error"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_cccd_upload_registry_pending")
    .on(table.claimStatus, table.deletionStatus, table.createdAt, table.key),
  index("idx_cccd_upload_registry_employee")
    .on(table.claimedEmployeeId, table.deletionStatus, table.key),
]);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  name: text("name").notNull(),
  employeeId: text("employee_id"),
  storeId: text("store_id"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: integer("locked_until"),
  shiftActive: integer("shift_active").notNull().default(0),
  currentShift: text("current_shift"),
  shiftStartedAt: text("shift_started_at"),
  isSuperAdmin: integer("is_super_admin").notNull().default(0),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  storeId: text("store_id").notNull(),
  employeeId: text("employee_id").notNull(),
  shiftCode: text("shift_code").notNull(),
  customerName: text("customer_name"),
  phone: text("phone"),
  age: integer("age"),
  amount: integer("amount").notNull(),
  paymentMethod: text("payment_method").notNull(),
  status: text("status").notNull().default("COMPLETED"),
  clientRequestId: text("client_request_id"),
  clientRequestFingerprint: text("client_request_fingerprint"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_orders_employee_client_request")
    .on(table.employeeId, table.clientRequestId)
    .where(sql`${table.clientRequestId} IS NOT NULL`),
  index("idx_orders_store_created").on(table.storeId, table.createdAt, table.id),
]);

// A single database-wide counter keeps newly issued human-facing order codes
// monotonic across every store. Existing order codes remain immutable; the
// runtime only seeds this counter from their count/highest numeric DH suffix.
export const orderCodeSequence = sqliteTable("order_code_sequence", {
  id: integer("id").primaryKey(),
  lastValue: integer("last_value").notNull().default(0),
});

// New order numbers advance independently per store. The legacy global table
// remains in place for rollback compatibility; historical order codes are
// never rewritten or copied into this table.
export const storeOrderCodeSequences = sqliteTable("store_order_code_sequences", {
  storeId: text("store_id").primaryKey(),
  codePrefix: text("code_prefix").notNull(),
  lastValue: integer("last_value").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_store_order_code_sequences_prefix").on(table.codePrefix),
]);

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  recipientUserId: text("recipient_user_id").notNull(),
  storeId: text("store_id").notNull(),
  type: text("type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  dataJson: text("data_json").notNull().default("{}"),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_notifications_recipient_type_entity")
    .on(table.recipientUserId, table.type, table.entityId),
  index("idx_notifications_recipient_unread")
    .on(table.recipientUserId, table.readAt, table.createdAt),
]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  storeId: text("store_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  detail: text("detail"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_audit_logs_entity_created").on(table.entityType, table.entityId, table.createdAt),
  index("idx_audit_logs_store_created").on(table.storeId, table.createdAt),
]);

/**
 * Immutable, effective-dated policy revisions used by financial periods.
 * The policy payload remains versioned as one document so new policy fields
 * can be introduced without rewriting historical period snapshots.
 */
export const financialPolicyVersions = sqliteTable("financial_policy_versions", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  effectiveFromPeriod: text("effective_from_period").notNull(),
  policyJson: text("policy_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  supersededAt: text("superseded_at"),
}, (table) => [
  check("financial_policy_versions_version_positive", sql`${table.version} > 0`),
  check(
    "financial_policy_versions_effective_period_format",
    sql`${table.effectiveFromPeriod} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(${table.effectiveFromPeriod}, 6, 2) AS integer) BETWEEN 1 AND 12`,
  ),
  check(
    "financial_policy_versions_policy_json_valid",
    sql`json_valid(${table.policyJson}) AND json_type(${table.policyJson}) = 'object'`,
  ),
  check(
    "financial_policy_versions_superseded_timestamp",
    sql`${table.supersededAt} IS NULL OR length(trim(${table.supersededAt})) > 0`,
  ),
  uniqueIndex("idx_financial_policy_versions_version").on(table.version),
  index("idx_financial_policy_versions_effective").on(table.effectiveFromPeriod, table.version),
]);

/** One canonical lifecycle and immutable financial snapshot per store/month. */
export const financialPeriods = sqliteTable("financial_periods", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull()
    .references(() => stores.id, { onDelete: "restrict", onUpdate: "restrict" }),
  period: text("period").notNull(),
  status: text("status").notNull().default("DRAFT"),
  policyVersionId: text("policy_version_id")
    .references(() => financialPolicyVersions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  configVersion: integer("config_version"),
  revision: integer("revision").notNull().default(0),
  grossRevenue: integer("gross_revenue").notNull().default(0),
  fixedExpense: integer("fixed_expense").notNull().default(0),
  variableExpense: integer("variable_expense").notNull().default(0),
  inventoryCost: integer("inventory_cost").notNull().default(0),
  inventoryShippingCost: integer("inventory_shipping_cost").notNull().default(0),
  employeeSalary: integer("employee_salary").notNull().default(0),
  managerSalary: integer("manager_salary").notNull().default(0),
  manualBonus: integer("manual_bonus").notNull().default(0),
  allowance: integer("allowance").notNull().default(0),
  totalHoursSeconds: integer("total_hours_seconds").notNull().default(0),
  employeeKpiTotal: integer("employee_kpi_total").notNull().default(0),
  managerKpi: integer("manager_kpi").notNull().default(0),
  operatingProfit: integer("operating_profit").notNull().default(0),
  profitAfterKpi: integer("profit_after_kpi").notNull().default(0),
  monthEndExpense: integer("month_end_expense").notNull().default(0),
  finalProfit: integer("final_profit").notNull().default(0),
  distributableProfit: integer("distributable_profit").notNull().default(0),
  salaryAdvance: integer("salary_advance").notNull().default(0),
  employeePayrollRowsJson: text("employee_payroll_rows_json").notNull().default("[]"),
  managerPayrollJson: text("manager_payroll_json").notNull().default("{}"),
  configSnapshotJson: text("config_snapshot_json").notNull().default("{}"),
  snapshotJson: text("snapshot_json").notNull().default("{}"),
  calculatedAt: text("calculated_at"),
  calculatedBy: text("calculated_by"),
  confirmedAt: text("confirmed_at"),
  confirmedBy: text("confirmed_by"),
  paidAt: text("paid_at"),
  paidBy: text("paid_by"),
  lockedAt: text("locked_at"),
  lockedBy: text("locked_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check(
    "financial_periods_period_format",
    sql`${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(${table.period}, 6, 2) AS integer) BETWEEN 1 AND 12`,
  ),
  check(
    "financial_periods_status",
    sql`${table.status} IN ('DRAFT', 'CALCULATED', 'RECONCILING', 'CONFIRMED', 'PAID', 'LOCKED')`,
  ),
  check("financial_periods_config_version", sql`${table.configVersion} IS NULL OR ${table.configVersion} > 0`),
  check("financial_periods_revision", sql`${table.revision} >= 0`),
  check("financial_periods_gross_revenue", sql`${table.grossRevenue} >= 0`),
  check("financial_periods_fixed_expense", sql`${table.fixedExpense} >= 0`),
  check("financial_periods_variable_expense", sql`${table.variableExpense} >= 0`),
  check("financial_periods_inventory_cost", sql`${table.inventoryCost} >= 0`),
  check("financial_periods_inventory_shipping_cost", sql`${table.inventoryShippingCost} >= 0`),
  check("financial_periods_employee_salary", sql`${table.employeeSalary} >= 0`),
  check("financial_periods_manager_salary", sql`${table.managerSalary} >= 0`),
  check("financial_periods_manual_bonus", sql`${table.manualBonus} >= 0`),
  check("financial_periods_allowance", sql`${table.allowance} >= 0`),
  check("financial_periods_total_hours_seconds", sql`${table.totalHoursSeconds} >= 0`),
  check("financial_periods_employee_kpi_total", sql`${table.employeeKpiTotal} >= 0`),
  check("financial_periods_manager_kpi", sql`${table.managerKpi} >= 0`),
  check("financial_periods_month_end_expense", sql`${table.monthEndExpense} >= 0`),
  check("financial_periods_distributable_profit", sql`${table.distributableProfit} >= 0`),
  check("financial_periods_salary_advance", sql`${table.salaryAdvance} >= 0`),
  check(
    "financial_periods_employee_payroll_json",
    sql`json_valid(${table.employeePayrollRowsJson}) AND json_type(${table.employeePayrollRowsJson}) = 'array'`,
  ),
  check(
    "financial_periods_manager_payroll_json",
    sql`json_valid(${table.managerPayrollJson}) AND json_type(${table.managerPayrollJson}) = 'object'`,
  ),
  check(
    "financial_periods_config_snapshot_json",
    sql`json_valid(${table.configSnapshotJson}) AND json_type(${table.configSnapshotJson}) = 'object'`,
  ),
  check(
    "financial_periods_snapshot_json",
    sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`,
  ),
  check(
    "financial_periods_policy_version_pair",
    sql`(${table.policyVersionId} IS NULL AND ${table.configVersion} IS NULL)
      OR (${table.policyVersionId} IS NOT NULL AND ${table.configVersion} IS NOT NULL)`,
  ),
  check(
    "financial_periods_calculated_pair",
    sql`(${table.calculatedAt} IS NULL AND ${table.calculatedBy} IS NULL)
      OR (${table.calculatedAt} IS NOT NULL AND ${table.calculatedBy} IS NOT NULL)`,
  ),
  check(
    "financial_periods_confirmed_pair",
    sql`(${table.confirmedAt} IS NULL AND ${table.confirmedBy} IS NULL)
      OR (${table.confirmedAt} IS NOT NULL AND ${table.confirmedBy} IS NOT NULL)`,
  ),
  check(
    "financial_periods_paid_pair",
    sql`(${table.paidAt} IS NULL AND ${table.paidBy} IS NULL)
      OR (${table.paidAt} IS NOT NULL AND ${table.paidBy} IS NOT NULL)`,
  ),
  check(
    "financial_periods_locked_pair",
    sql`(${table.lockedAt} IS NULL AND ${table.lockedBy} IS NULL)
      OR (${table.lockedAt} IS NOT NULL AND ${table.lockedBy} IS NOT NULL)`,
  ),
  check(
    "financial_periods_lifecycle_metadata",
    sql`(
      ${table.status} = 'DRAFT'
      AND ${table.calculatedAt} IS NULL
      AND ${table.confirmedAt} IS NULL
      AND ${table.paidAt} IS NULL
      AND ${table.lockedAt} IS NULL
    ) OR (
      ${table.status} IN ('CALCULATED', 'RECONCILING')
      AND ${table.calculatedAt} IS NOT NULL
      AND ${table.confirmedAt} IS NULL
      AND ${table.paidAt} IS NULL
      AND ${table.lockedAt} IS NULL
    ) OR (
      ${table.status} = 'CONFIRMED'
      AND ${table.calculatedAt} IS NOT NULL
      AND ${table.confirmedAt} IS NOT NULL
      AND ${table.paidAt} IS NULL
      AND ${table.lockedAt} IS NULL
      AND ${table.policyVersionId} IS NOT NULL
      AND json_extract(${table.snapshotJson}, '$.schemaVersion') IS 1
    ) OR (
      ${table.status} = 'PAID'
      AND ${table.calculatedAt} IS NOT NULL
      AND ${table.confirmedAt} IS NOT NULL
      AND ${table.paidAt} IS NOT NULL
      AND ${table.lockedAt} IS NULL
      AND ${table.policyVersionId} IS NOT NULL
      AND json_extract(${table.snapshotJson}, '$.schemaVersion') IS 1
    ) OR (
      ${table.status} = 'LOCKED'
      AND ${table.calculatedAt} IS NOT NULL
      AND ${table.confirmedAt} IS NOT NULL
      AND ${table.paidAt} IS NOT NULL
      AND ${table.lockedAt} IS NOT NULL
      AND ${table.policyVersionId} IS NOT NULL
      AND json_extract(${table.snapshotJson}, '$.schemaVersion') IS 1
    )`,
  ),
  check(
    "financial_periods_lifecycle_order",
    sql`(${table.confirmedAt} IS NULL OR ${table.confirmedAt} >= ${table.calculatedAt})
      AND (${table.paidAt} IS NULL OR ${table.paidAt} >= ${table.confirmedAt})
      AND (${table.lockedAt} IS NULL OR ${table.lockedAt} >= ${table.paidAt})`,
  ),
  check(
    "financial_periods_operating_profit_formula",
    sql`${table.operatingProfit} = ${table.grossRevenue}
      - ${table.fixedExpense}
      - ${table.variableExpense}
      - ${table.inventoryCost}
      - ${table.inventoryShippingCost}
      - ${table.employeeSalary}
      - ${table.managerSalary}
      - ${table.manualBonus}
      - ${table.allowance}`,
  ),
  check(
    "financial_periods_profit_after_kpi_formula",
    sql`${table.profitAfterKpi} = ${table.operatingProfit} - ${table.employeeKpiTotal} - ${table.managerKpi}`,
  ),
  check(
    "financial_periods_final_profit_formula",
    sql`${table.finalProfit} = ${table.profitAfterKpi} - ${table.monthEndExpense}`,
  ),
  check(
    "financial_periods_distributable_profit_formula",
    sql`${table.distributableProfit} = CASE
      WHEN ${table.finalProfit} > 0 THEN ${table.finalProfit}
      ELSE 0
    END`,
  ),
  uniqueIndex("idx_financial_periods_store_period").on(table.storeId, table.period),
  index("idx_financial_periods_status_period").on(table.status, table.period, table.storeId),
  index("idx_financial_periods_store_status").on(table.storeId, table.status, table.period),
]);

/** Immutable, period-wide profit-sharing close sourced only from LOCKED store periods. */
export const profitDistributions = sqliteTable("profit_distributions", {
  id: text("id").primaryKey(),
  period: text("period").notNull(),
  status: text("status").notNull().default("LOCKED"),
  policyVersionId: text("policy_version_id").notNull()
    .references(() => financialPolicyVersions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  configVersion: integer("config_version").notNull(),
  policySnapshotJson: text("policy_snapshot_json").notNull(),
  totalFinalProfit: integer("total_final_profit").notNull(),
  totalDistributableProfit: integer("total_distributable_profit").notNull(),
  storeCount: integer("store_count").notNull(),
  memberCount: integer("member_count").notNull(),
  closedBy: text("closed_by").notNull(),
  closedAt: text("closed_at").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check(
    "profit_distributions_period_format",
    sql`${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(${table.period}, 6, 2) AS integer) BETWEEN 1 AND 12`,
  ),
  check("profit_distributions_status", sql`${table.status} = 'LOCKED'`),
  check("profit_distributions_config_version", sql`${table.configVersion} > 0`),
  check(
    "profit_distributions_policy_snapshot_json",
    sql`json_valid(${table.policySnapshotJson}) AND json_type(${table.policySnapshotJson}) = 'object'`,
  ),
  check("profit_distributions_total_distributable", sql`${table.totalDistributableProfit} >= 0`),
  check("profit_distributions_store_count", sql`${table.storeCount} > 0`),
  check("profit_distributions_member_count", sql`${table.memberCount} > 0`),
  check("profit_distributions_closed_by", sql`length(trim(${table.closedBy})) > 0`),
  check("profit_distributions_reason", sql`length(trim(${table.reason})) > 0`),
  check(
    "profit_distributions_closed_at",
    sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${table.closedAt}) = ${table.closedAt}`,
  ),
  check(
    "profit_distributions_created_at",
    sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${table.createdAt}) = ${table.createdAt}`,
  ),
  uniqueIndex("idx_profit_distributions_period").on(table.period),
  index("idx_profit_distributions_closed_at").on(table.closedAt, table.id),
]);

/** Per-store provenance; negative stores retain their loss but distribute zero. */
export const profitDistributionStores = sqliteTable("profit_distribution_stores", {
  id: text("id").primaryKey(),
  distributionId: text("distribution_id").notNull()
    .references(() => profitDistributions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  storeId: text("store_id").notNull()
    .references(() => stores.id, { onDelete: "restrict", onUpdate: "restrict" }),
  storeNameSnapshot: text("store_name_snapshot").notNull(),
  financialPeriodId: text("financial_period_id").notNull()
    .references(() => financialPeriods.id, { onDelete: "restrict", onUpdate: "restrict" }),
  financialPeriodRevision: integer("financial_period_revision").notNull(),
  policyVersionId: text("policy_version_id").notNull()
    .references(() => financialPolicyVersions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  configVersion: integer("config_version").notNull(),
  finalProfit: integer("final_profit").notNull(),
  distributableProfit: integer("distributable_profit").notNull(),
  financialSnapshotJson: text("financial_snapshot_json").notNull(),
  ordinal: integer("ordinal").notNull(),
}, (table) => [
  check("profit_distribution_stores_name", sql`length(trim(${table.storeNameSnapshot})) > 0`),
  check("profit_distribution_stores_revision", sql`${table.financialPeriodRevision} >= 0`),
  check("profit_distribution_stores_config_version", sql`${table.configVersion} > 0`),
  check("profit_distribution_stores_distributable", sql`${table.distributableProfit} >= 0`),
  check(
    "profit_distribution_stores_formula",
    sql`${table.distributableProfit} = CASE WHEN ${table.finalProfit} > 0 THEN ${table.finalProfit} ELSE 0 END`,
  ),
  check(
    "profit_distribution_stores_snapshot_json",
    sql`json_valid(${table.financialSnapshotJson}) AND json_type(${table.financialSnapshotJson}) = 'object'`,
  ),
  check("profit_distribution_stores_ordinal", sql`${table.ordinal} >= 0`),
  uniqueIndex("idx_profit_distribution_stores_distribution_store").on(table.distributionId, table.storeId),
  uniqueIndex("idx_profit_distribution_stores_financial_period").on(table.financialPeriodId),
  uniqueIndex("idx_profit_distribution_stores_ordinal").on(table.distributionId, table.ordinal),
]);

/** Immutable member-policy snapshot and exact integer-VND allocation. */
export const profitDistributionMembers = sqliteTable("profit_distribution_members", {
  id: text("id").primaryKey(),
  distributionId: text("distribution_id").notNull()
    .references(() => profitDistributions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  memberId: text("member_id").notNull(),
  memberNameSnapshot: text("member_name_snapshot").notNull(),
  rateBasisPoints: integer("rate_basis_points").notNull(),
  amount: integer("amount").notNull(),
  memberSnapshotJson: text("member_snapshot_json").notNull(),
  ordinal: integer("ordinal").notNull(),
}, (table) => [
  check("profit_distribution_members_member_id", sql`length(trim(${table.memberId})) > 0`),
  check("profit_distribution_members_name", sql`length(trim(${table.memberNameSnapshot})) > 0`),
  check(
    "profit_distribution_members_rate",
    sql`${table.rateBasisPoints} >= 0 AND ${table.rateBasisPoints} <= 10000`,
  ),
  check("profit_distribution_members_amount", sql`${table.amount} >= 0`),
  check(
    "profit_distribution_members_snapshot_json",
    sql`json_valid(${table.memberSnapshotJson}) AND json_type(${table.memberSnapshotJson}) = 'object'`,
  ),
  check("profit_distribution_members_ordinal", sql`${table.ordinal} >= 0`),
  uniqueIndex("idx_profit_distribution_members_distribution_member").on(table.distributionId, table.memberId),
  uniqueIndex("idx_profit_distribution_members_ordinal").on(table.distributionId, table.ordinal),
]);

export const monthEndExpenses = sqliteTable("month_end_expenses", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull()
    .references(() => stores.id, { onDelete: "restrict", onUpdate: "restrict" }),
  period: text("period").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
  status: text("status").notNull().default("ACTIVE"),
  version: integer("version").notNull().default(1),
  clientRequestId: text("client_request_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull(),
  voidedBy: text("voided_by"),
  voidedAt: text("voided_at"),
}, (table) => [
  check(
    "month_end_expenses_period_format",
    sql`${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND CAST(substr(${table.period}, 6, 2) AS integer) BETWEEN 1 AND 12`,
  ),
  check("month_end_expenses_title", sql`length(trim(${table.title})) > 0`),
  check("month_end_expenses_category", sql`length(trim(${table.category})) > 0`),
  check("month_end_expenses_amount", sql`${table.amount} > 0`),
  check("month_end_expenses_version", sql`${table.version} > 0`),
  check("month_end_expenses_client_request", sql`length(trim(${table.clientRequestId})) > 0`),
  check("month_end_expenses_payload_hash", sql`length(trim(${table.payloadHash})) > 0`),
  check(
    "month_end_expenses_void_metadata",
    sql`(${table.status} = 'ACTIVE' AND ${table.voidedBy} IS NULL AND ${table.voidedAt} IS NULL)
      OR (${table.status} = 'VOID' AND ${table.voidedBy} IS NOT NULL AND ${table.voidedAt} IS NOT NULL)`,
  ),
  uniqueIndex("idx_month_end_expenses_actor_request")
    .on(table.storeId, table.createdBy, table.clientRequestId),
  index("idx_month_end_expenses_store_period_status")
    .on(table.storeId, table.period, table.status, table.createdAt),
]);

/**
 * Actual-money ledger. Accounting profit never sums this table; source links
 * exist solely to reconcile each cash movement with its originating record.
 */
export const cashflowEntries = sqliteTable("cashflow_entries", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull()
    .references(() => stores.id, { onDelete: "restrict", onUpdate: "restrict" }),
  direction: text("direction").notNull(),
  amount: integer("amount").notNull(),
  category: text("category").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  occurredAt: text("occurred_at").notNull(),
  createdBy: text("created_by").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  // Nullable only for rows created before the hardened ledger migration. All
  // new inserts are required to provide the pair by database triggers.
  clientRequestId: text("client_request_id"),
  payloadHash: text("payload_hash"),
  reversesEntryId: text("reverses_entry_id")
    .references((): AnySQLiteColumn => cashflowEntries.id, { onDelete: "restrict", onUpdate: "restrict" }),
}, (table) => [
  check("cashflow_entries_direction", sql`${table.direction} IN ('IN', 'OUT')`),
  check("cashflow_entries_amount", sql`${table.amount} > 0`),
  check("cashflow_entries_category", sql`length(trim(${table.category})) > 0`),
  check("cashflow_entries_source_type", sql`length(trim(${table.sourceType})) > 0`),
  check("cashflow_entries_source_id", sql`length(trim(${table.sourceId})) > 0`),
  check(
    "cashflow_entries_occurred_at",
    sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${table.occurredAt}) = ${table.occurredAt}`,
  ),
  check(
    "cashflow_entries_idempotency_metadata",
    sql`(${table.clientRequestId} IS NULL AND ${table.payloadHash} IS NULL)
      OR (
        length(trim(${table.clientRequestId})) BETWEEN 16 AND 200
        AND length(${table.payloadHash}) = 64
        AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*'
      )`,
  ),
  uniqueIndex("idx_cashflow_entries_source")
    .on(table.storeId, table.sourceType, table.sourceId),
  uniqueIndex("idx_cashflow_entries_actor_request")
    .on(table.storeId, table.createdBy, table.clientRequestId)
    .where(sql`${table.clientRequestId} IS NOT NULL`),
  uniqueIndex("idx_cashflow_entries_reversal")
    .on(table.reversesEntryId)
    .where(sql`${table.reversesEntryId} IS NOT NULL`),
  index("idx_cashflow_entries_store_occurred")
    .on(table.storeId, table.occurredAt, table.id),
  index("idx_cashflow_entries_source_lookup")
    .on(table.sourceType, table.sourceId),
]);

export const businessRecords = sqliteTable("business_records", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  storeId: text("store_id"),
  ownerId: text("owner_id"),
  title: text("title").notNull(),
  dataJson: text("data_json").notNull().default("{}"),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const inventoryReceiptCodeSequences = sqliteTable("inventory_receipt_code_sequences", {
  id: integer("id").primaryKey(),
  lastValue: integer("last_value").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const inventoryReceiptRequests = sqliteTable("inventory_receipt_requests", {
  recordId: text("record_id").primaryKey(),
  storeId: text("store_id").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  clientRequestId: text("client_request_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  receiptDate: text("receipt_date").notNull(),
  sequenceValue: integer("sequence_value").notNull(),
  receiptNo: text("receipt_no").notNull().unique(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_inventory_receipt_actor_request").on(table.storeId, table.actorUserId, table.clientRequestId),
  uniqueIndex("idx_inventory_receipt_sequence").on(table.sequenceValue),
]);

export const dailyShiftDefinitions = sqliteTable("daily_shift_definitions", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull(),
  workDate: text("work_date").notNull(),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  version: integer("version").notNull().default(1),
  clientRequestId: text("client_request_id"),
  payloadHash: text("payload_hash"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
}, (table) => [
  uniqueIndex("idx_daily_shift_store_request")
    .on(table.storeId, table.clientRequestId)
    .where(sql`${table.clientRequestId} IS NOT NULL`),
  uniqueIndex("idx_daily_shift_store_date_identity")
    .on(table.storeId, table.workDate, table.nameKey, table.startTime, table.endTime)
    .where(sql`${table.status} = 'ACTIVE'`),
  index("idx_daily_shift_store_date_status")
    .on(table.storeId, table.workDate, table.status, table.startTime, table.id),
]);

export const shiftSessions = sqliteTable("shift_sessions", {
  id: text("id").primaryKey(),
  shiftCode: text("shift_code").notNull().unique(),
  storeId: text("store_id").notNull(),
  employeeId: text("employee_id").notNull(),
  shiftName: text("shift_name"),
  scheduledStart: text("scheduled_start"),
  scheduledEnd: text("scheduled_end"),
  scheduledStartAt: text("scheduled_start_at"),
  scheduledEndAt: text("scheduled_end_at"),
  workDate: text("work_date"),
  previousSessionId: text("previous_session_id"),
  transferId: text("transfer_id"),
  sourceScheduleRecordId: text("source_schedule_record_id"),
  sourceScheduleUpdatedAt: text("source_schedule_updated_at"),
  appliedHourlyRate: integer("applied_hourly_rate"),
  appliedTikTokAllowance: integer("applied_tiktok_allowance"),
  appliedSupportAllowance: integer("applied_support_allowance"),
  startedAt: text("started_at").notNull(),
  attendanceStatus: text("attendance_status"),
  attendanceDeltaMinutes: integer("attendance_delta_minutes"),
  attendanceGraceMinutes: integer("attendance_grace_minutes").notNull().default(15),
  attendanceEarlyWindowMinutes: integer("attendance_early_window_minutes"),
  attendanceMaxShiftMinutes: integer("attendance_max_shift_minutes"),
  clockInLatitude: real("clock_in_latitude"),
  clockInLongitude: real("clock_in_longitude"),
  clockInAccuracyMeters: real("clock_in_accuracy_meters"),
  clockInLocationCapturedAt: text("clock_in_location_captured_at"),
  endedAt: text("ended_at"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  adminAdjustedDurationSeconds: integer("admin_adjusted_duration_seconds"),
  tiktok: integer("tiktok").notNull().default(0),
  tiktokAllowance: integer("tiktok_allowance").notNull().default(0),
  tasksCompleted: integer("tasks_completed").notNull().default(0),
  expenseAmount: integer("expense_amount").notNull().default(0),
  expenseNote: text("expense_note"),
  cashRevenue: integer("cash_revenue").notNull().default(0),
  transferRevenue: integer("transfer_revenue").notNull().default(0),
  closeReason: text("close_reason"),
  closeStatus: text("close_status").notNull().default("PENDING"),
  reconciliationStatus: text("reconciliation_status").notNull().default("CLEAR"),
  reconciliationReason: text("reconciliation_reason"),
  reconciledAt: text("reconciled_at"),
  reconciledBy: text("reconciled_by"),
  status: text("status").notNull().default("ACTIVE"),
}, (table) => [
  check("shift_sessions_status", sql`${table.status} IN ('ACTIVE', 'COMPLETED')`),
  check(
    "shift_sessions_business_date",
    sql`julianday(${table.startedAt}) IS NOT NULL
      AND (${table.workDate} IS NULL
        OR (${table.workDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND date(${table.workDate}) IS ${table.workDate}))`,
  ),
  check(
    "shift_sessions_snapshot_money_nonnegative",
    sql`(${table.appliedHourlyRate} IS NULL OR ${table.appliedHourlyRate} >= 0)
      AND (${table.appliedTikTokAllowance} IS NULL OR ${table.appliedTikTokAllowance} >= 0)
      AND (${table.appliedSupportAllowance} IS NULL OR ${table.appliedSupportAllowance} >= 0)`,
  ),
  check(
    "shift_sessions_money_nonnegative",
    sql`${table.tiktokAllowance} >= 0 AND ${table.expenseAmount} >= 0
      AND ${table.cashRevenue} >= 0 AND ${table.transferRevenue} >= 0`,
  ),
  check(
    "shift_sessions_duration_nonnegative",
    sql`${table.durationSeconds} >= 0
      AND (${table.adminAdjustedDurationSeconds} IS NULL OR ${table.adminAdjustedDurationSeconds} >= 0)`,
  ),
  check(
    "shift_sessions_booleans",
    sql`${table.tiktok} IN (0, 1) AND ${table.tasksCompleted} IN (0, 1)`,
  ),
  check(
    "shift_sessions_schedule_snapshot_pair",
    sql`(${table.scheduledStartAt} IS NULL AND ${table.scheduledEndAt} IS NULL)
      OR (${table.scheduledStartAt} IS NOT NULL AND ${table.scheduledEndAt} IS NOT NULL
        AND julianday(${table.scheduledStartAt}) IS NOT NULL
        AND julianday(${table.scheduledEndAt}) IS NOT NULL
        AND julianday(${table.scheduledEndAt}) > julianday(${table.scheduledStartAt}))`,
  ),
  check(
    "shift_sessions_schedule_provenance_pair",
    sql`(${table.sourceScheduleRecordId} IS NULL AND ${table.sourceScheduleUpdatedAt} IS NULL)
      OR (${table.sourceScheduleRecordId} IS NOT NULL
        AND length(trim(${table.sourceScheduleRecordId})) > 0
        AND ${table.sourceScheduleUpdatedAt} IS NOT NULL
        AND julianday(${table.sourceScheduleUpdatedAt}) IS NOT NULL)`,
  ),
  check(
    "shift_sessions_attendance_snapshot",
    sql`typeof(${table.attendanceGraceMinutes}) = 'integer'
      AND ${table.attendanceGraceMinutes} BETWEEN 0 AND 120
      AND (${table.attendanceEarlyWindowMinutes} IS NULL
        OR (typeof(${table.attendanceEarlyWindowMinutes}) = 'integer'
          AND ${table.attendanceEarlyWindowMinutes} BETWEEN 0 AND 1440))
      AND (${table.attendanceMaxShiftMinutes} IS NULL
        OR (typeof(${table.attendanceMaxShiftMinutes}) = 'integer'
          AND ${table.attendanceMaxShiftMinutes} BETWEEN 1 AND 10080))
      AND (${table.attendanceStatus} IS NULL OR ${table.attendanceStatus} IN ('EARLY', 'ON_TIME', 'LATE'))
      AND ((${table.attendanceStatus} IS NULL AND ${table.attendanceDeltaMinutes} IS NULL)
        OR (${table.attendanceStatus} IS NOT NULL
          AND typeof(${table.attendanceDeltaMinutes}) = 'integer'))`,
  ),
  check(
    "shift_sessions_clock_in_location",
    sql`(${table.clockInLatitude} IS NULL AND ${table.clockInLongitude} IS NULL
        AND ${table.clockInAccuracyMeters} IS NULL AND ${table.clockInLocationCapturedAt} IS NULL)
      OR (${table.clockInLatitude} BETWEEN -90 AND 90
        AND ${table.clockInLatitude} IS NOT NULL
        AND ${table.clockInLongitude} IS NOT NULL
        AND ${table.clockInAccuracyMeters} IS NOT NULL
        AND typeof(${table.clockInLatitude}) IN ('integer', 'real')
        AND typeof(${table.clockInLongitude}) IN ('integer', 'real')
        AND typeof(${table.clockInAccuracyMeters}) IN ('integer', 'real')
        AND ${table.clockInLongitude} BETWEEN -180 AND 180
        AND ${table.clockInAccuracyMeters} BETWEEN 0 AND 100000
        AND julianday(${table.clockInLocationCapturedAt}) IS NOT NULL)`,
  ),
  check(
    "shift_sessions_reconciliation",
    sql`(${table.reconciliationStatus} = 'CLEAR'
        AND ${table.reconciliationReason} IS NULL
        AND ${table.reconciledAt} IS NULL AND ${table.reconciledBy} IS NULL)
      OR (${table.reconciliationStatus} = 'REQUIRED'
        AND length(trim(${table.reconciliationReason})) > 0
        AND ${table.reconciledAt} IS NULL AND ${table.reconciledBy} IS NULL)
      OR (${table.reconciliationStatus} = 'CONFIRMED'
        AND length(trim(${table.reconciliationReason})) > 0
        AND julianday(${table.reconciledAt}) IS NOT NULL
        AND length(trim(${table.reconciledBy})) > 0)`,
  ),
  check(
    "shift_sessions_active_state",
    sql`${table.status} != 'ACTIVE'
      OR (${table.endedAt} IS NULL AND ${table.durationSeconds} = 0
        AND ${table.adminAdjustedDurationSeconds} IS NULL
        AND ${table.reconciliationStatus} = 'CLEAR')`,
  ),
  check(
    "shift_sessions_end_state",
    sql`${table.endedAt} IS NULL
      OR (${table.status} = 'COMPLETED'
        AND julianday(${table.startedAt}) IS NOT NULL
        AND julianday(${table.endedAt}) IS NOT NULL
        AND julianday(${table.endedAt}) >= julianday(${table.startedAt}))`,
  ),
  check(
    "shift_sessions_canonical_completion",
    sql`${table.status} != 'COMPLETED'
      OR ${table.endedAt} IS NOT NULL
      OR (
        ${table.sourceScheduleRecordId} IS NULL
        AND ${table.sourceScheduleUpdatedAt} IS NULL
        AND ${table.attendanceEarlyWindowMinutes} IS NULL
        AND ${table.attendanceMaxShiftMinutes} IS NULL
        AND ${table.reconciliationStatus} = 'CLEAR'
        AND ${table.durationSeconds} = 0
        AND ${table.adminAdjustedDurationSeconds} IS NULL
        AND ${table.tiktok} = 0 AND ${table.tiktokAllowance} = 0
        AND ${table.tasksCompleted} = 0 AND ${table.expenseAmount} = 0
        AND ${table.cashRevenue} = 0 AND ${table.transferRevenue} = 0
      )`,
  ),
  check(
    "shift_sessions_canonical_duration",
    sql`${table.status} != 'COMPLETED' OR ${table.endedAt} IS NULL
      OR ${table.adminAdjustedDurationSeconds} IS NOT NULL
      OR (
        ${table.sourceScheduleRecordId} IS NULL
        AND ${table.sourceScheduleUpdatedAt} IS NULL
        AND ${table.attendanceEarlyWindowMinutes} IS NULL
        AND ${table.attendanceMaxShiftMinutes} IS NULL
      )
      OR ABS(${table.durationSeconds} - CAST(ROUND(
        (julianday(${table.endedAt}) - julianday(${table.startedAt})) * 86400
      ) AS INTEGER)) <= 1`,
  ),
  check(
    "shift_sessions_max_duration_reconciled",
    sql`${table.attendanceMaxShiftMinutes} IS NULL
      OR COALESCE(${table.adminAdjustedDurationSeconds}, ${table.durationSeconds}) <= ${table.attendanceMaxShiftMinutes} * 60
      OR ${table.reconciliationStatus} IN ('REQUIRED', 'CONFIRMED')`,
  ),
  uniqueIndex("idx_shift_sessions_previous_session")
    .on(table.previousSessionId)
    .where(sql`${table.previousSessionId} IS NOT NULL`),
  index("idx_shift_sessions_employee_status_integrity")
    .on(table.employeeId, table.status, table.id),
  index("idx_shift_sessions_store_work_date_started")
    .on(table.storeId, table.workDate, table.startedAt, table.id),
]);

export const employeeTransfers = sqliteTable("employee_transfers", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id").notNull(),
  sourceStoreId: text("source_store_id").notNull(),
  targetStoreId: text("target_store_id").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  shiftsJson: text("shifts_json").notNull().default("[]"),
  supportHourlyRate: integer("support_hourly_rate").notNull(),
  supportAllowance: integer("support_allowance").notNull().default(0),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("SCHEDULED"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  endedAt: text("ended_at"),
});

export const adminResetArchives = sqliteTable("admin_reset_archives", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  kind: text("kind").notNull(),
  filterJson: text("filter_json").notNull(),
  summaryJson: text("summary_json").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_admin_reset_archives_store_created")
    .on(table.storeId, table.createdAt),
]);

export const employeePayrollClosings = sqliteTable("employee_payroll_closings", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull(),
  employeeId: text("employee_id").notNull(),
  period: text("period").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  employeeStatusAtLock: text("employee_status_at_lock").notNull(),
  status: text("status").notNull().default("LOCKED"),
  lockedAt: text("locked_at").notNull(),
  lockedBy: text("locked_by").notNull(),
}, (table) => [
  uniqueIndex("idx_employee_payroll_closing_period")
    .on(table.storeId, table.employeeId, table.period),
]);

export const salaryAdvances = sqliteTable("salary_advances", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull(),
  employeeId: text("employee_id").notNull(),
  period: text("period").notNull(),
  advanceDate: text("advance_date").notNull(),
  amount: integer("amount").notNull(),
  grossEntitlementSnapshot: integer("gross_entitlement_snapshot").notNull(),
  availableBeforeSnapshot: integer("available_before_snapshot").notNull(),
  remainingAfterSnapshot: integer("remaining_after_snapshot").notNull(),
  note: text("note").notNull(),
  status: text("status").notNull().default("DRAFT"),
  version: integer("version").notNull().default(1),
  clientRequestId: text("client_request_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  mutationToken: text("mutation_token").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull(),
  paidBy: text("paid_by"),
  paidAt: text("paid_at"),
}, (table) => [
  uniqueIndex("idx_salary_advances_actor_request")
    .on(table.storeId, table.createdBy, table.clientRequestId),
  index("idx_salary_advances_store_period_employee")
    .on(table.storeId, table.period, table.employeeId, table.status),
]);
