import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  addressProvince: text("address_province"),
  addressWard: text("address_ward"),
  addressDetail: text("address_detail"),
  cccdImage: text("cccd_image"),
  age: integer("age"),
  hourlyRate: integer("hourly_rate").notNull().default(20000),
  status: text("status").notNull().default("ACTIVE"),
}, (table) => [index("idx_employees_store").on(table.storeId, table.status)]);

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
}, (table) => [index("idx_sessions_token").on(table.tokenHash, table.expiresAt)]);

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
}, (table) => [index("idx_orders_store_shift").on(table.storeId, table.employeeId, table.shiftCode, table.createdAt)]);

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
}, (table) => [index("idx_records_category_store").on(table.category, table.storeId, table.status, table.createdAt)]);

export const shiftSessions = sqliteTable("shift_sessions", {
  id: text("id").primaryKey(),
  shiftCode: text("shift_code").notNull().unique(),
  shiftName: text("shift_name"),
  storeId: text("store_id").notNull(),
  employeeId: text("employee_id").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  scheduledStartAt: text("scheduled_start_at"),
  scheduledEndAt: text("scheduled_end_at"),
  rolloverFrom: text("rollover_from"),
  workSessionId: text("work_session_id"),
  autoRolled: integer("auto_rolled").notNull().default(0),
  tiktok: integer("tiktok").notNull().default(0),
  tiktokAllowance: integer("tiktok_allowance").notNull().default(0),
  status: text("status").notNull().default("ACTIVE"),
}, (table) => [
  index("idx_shift_sessions_employee").on(table.employeeId, table.startedAt),
  index("idx_shift_sessions_store").on(table.storeId, table.startedAt),
  index("idx_shift_sessions_work_session").on(table.workSessionId, table.startedAt),
]);

export const userStoreScopes = sqliteTable("user_store_scopes", {
  userId: text("user_id").notNull().references(() => users.id),
  storeId: text("store_id").notNull().references(() => stores.id),
}, (table) => [primaryKey({ columns: [table.userId, table.storeId] })]);

export const shiftDefinitions = sqliteTable("shift_definitions", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull().references(() => stores.id),
  name: text("name").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
}, (table) => [check("shift_definition_time", sql`${table.startTime} != ${table.endTime}`)]);

// Assignment identity follows the fixed shift slot. A swap changes its employee,
// retaining the slot snapshot and lineage; actual attendance remains separate.
export const shiftAssignments = sqliteTable("shift_assignments", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull().references(() => stores.id),
  employeeId: text("employee_id").notNull().references(() => employees.id),
  businessDate: text("business_date").notNull(),
  definitionId: text("definition_id").notNull().references(() => shiftDefinitions.id),
  shiftName: text("shift_name").notNull(),
  scheduledStartAt: text("scheduled_start_at").notNull(),
  scheduledEndAt: text("scheduled_end_at").notNull(),
  status: text("status", { enum: ["PLANNED", "CANCELLED"] }).notNull().default("PLANNED"),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id),
  updatedBy: text("updated_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("shift_assignment_status", sql`${table.status} IN ('PLANNED','CANCELLED')`),
  check("shift_assignment_version", sql`${table.version} > 0`),
  check("shift_assignment_interval", sql`${table.scheduledEndAt} > ${table.scheduledStartAt}`),
  index("idx_assignment_overlap").on(table.employeeId, table.status, table.scheduledStartAt, table.scheduledEndAt),
  index("idx_assignment_day").on(table.storeId, table.businessDate, table.status),
  uniqueIndex("idx_assignment_unique").on(table.employeeId, table.businessDate, table.definitionId).where(sql`${table.status}='PLANNED'`),
]);

export const shiftAssignmentSessions = sqliteTable("shift_assignment_sessions", {
  assignmentId: text("assignment_id").primaryKey().references(() => shiftAssignments.id),
  sessionId: text("session_id").notNull().unique().references(() => shiftSessions.id),
});

export const shiftSwaps = sqliteTable("shift_swaps", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull().references(() => users.id),
  storeId: text("store_id").notNull().references(() => stores.id),
  businessDate: text("business_date").notNull(),
  assignmentAId: text("assignment_a_id").notNull().references(() => shiftAssignments.id),
  assignmentBId: text("assignment_b_id").notNull().references(() => shiftAssignments.id),
  versionA: integer("version_a").notNull(),
  versionB: integer("version_b").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: text("payload").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
  resultJson: text("result_json").notNull().default("[]"),
  state: text("state", { enum: ["APPLYING", "DONE"] }).notNull().default("APPLYING"),
}, (table) => [
  check("shift_swap_state", sql`${table.state} IN ('APPLYING','DONE')`),
  unique("shift_swap_actor_key").on(table.actorId, table.idempotencyKey),
]);
