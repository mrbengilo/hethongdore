import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  status: text("status").notNull().default("ACTIVE"),
  inactiveAt: text("inactive_at"),
});

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
  createdAt: text("created_at").notNull(),
});

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
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
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
