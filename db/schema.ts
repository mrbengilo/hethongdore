import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  hourlyRate: integer("hourly_rate").notNull().default(20000),
  status: text("status").notNull().default("ACTIVE"),
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
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  tiktok: integer("tiktok").notNull().default(0),
  tiktokAllowance: integer("tiktok_allowance").notNull().default(0),
  tasksCompleted: integer("tasks_completed").notNull().default(0),
  expenseAmount: integer("expense_amount").notNull().default(0),
  expenseNote: text("expense_note"),
  cashRevenue: integer("cash_revenue").notNull().default(0),
  transferRevenue: integer("transfer_revenue").notNull().default(0),
  status: text("status").notNull().default("ACTIVE"),
});
