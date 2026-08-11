import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
});

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
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
});

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
  appliedHourlyRate: integer("applied_hourly_rate"),
  appliedTikTokAllowance: integer("applied_tiktok_allowance"),
  startedAt: text("started_at").notNull(),
  attendanceStatus: text("attendance_status"),
  attendanceDeltaMinutes: integer("attendance_delta_minutes"),
  attendanceGraceMinutes: integer("attendance_grace_minutes").notNull().default(15),
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
  status: text("status").notNull().default("ACTIVE"),
}, (table) => [
  uniqueIndex("idx_shift_sessions_previous_session")
    .on(table.previousSessionId)
    .where(sql`${table.previousSessionId} IS NOT NULL`),
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
