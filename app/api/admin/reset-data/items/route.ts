import { initDb } from "../../../../../db/runtime";
import { getSessionUser, json as responseJson, sha256 } from "../../../_lib/auth";
import { storePeriodUnlockedSql } from "../../../_lib/store-period-lock";
import { attendanceDeltaMinutes, attendanceStatusAt, localDate, shiftUtcRange } from "../../../../lib/scheduling";

type Database = Awaited<ReturnType<typeof initDb>>;
type Resource = "ORDERS" | "ATTENDANCE";
type Range = "ALL" | "DAY" | "MONTH";

type ListFilter = {
  storeId: string;
  resource: Resource;
  range: Range;
  date: string | null;
  period: string | null;
  employeeId: string | null;
  shiftCode: string | null;
  search: string | null;
  page: number;
  pageSize: number;
};

type StoreSnapshot = { id: string; name: string; revenue: number; expense: number };
type OrderItem = {
  id: string;
  code: string;
  storeId: string;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  shiftCode: string;
  shiftSessionId: string | null;
  shiftName: string | null;
  shiftStatus: string | null;
  workDate: string | null;
  customerName: string | null;
  phone: string | null;
  age: number | null;
  amount: number;
  paymentMethod: string;
  status: string;
  createdAt: string;
  clientRequestId?: string | null;
  clientRequestFingerprint?: string | null;
  notifications?: Array<Record<string, unknown>>;
  shiftSnapshot?: Record<string, unknown>;
  notificationsCanonicalJson?: string;
  shiftSnapshotCanonicalJson?: string;
  shiftCashRevenue: number | null;
  shiftTransferRevenue: number | null;
  storeRevenue: number;
  storeExpense: number;
  period: string;
  locked: number;
};
type AttendanceItem = {
  id: string;
  storeId: string;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  shiftCode: string;
  shiftName: string | null;
  workDate: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  recordedDurationSeconds: number;
  adminAdjustedDurationSeconds: number | null;
  status: string;
  attendanceStatus: string | null;
  attendanceDeltaMinutes: number | null;
  attendanceGraceMinutes: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  previousSessionId?: string | null;
  transferId?: string | null;
  appliedHourlyRate?: number | null;
  appliedTiktokAllowance?: number | null;
  appliedSupportAllowance?: number | null;
  tiktok?: number;
  tiktokAllowance?: number;
  tasksCompleted?: number;
  expenseNote?: string | null;
  closeReason?: string | null;
  closeStatus?: string;
  clockInLatitude?: number | null;
  clockInLongitude?: number | null;
  clockInAccuracyMeters?: number | null;
  clockInLocationCapturedAt?: string | null;
  cashRevenue: number;
  transferRevenue: number;
  expenseAmount: number;
  linkedOrderCount: number;
  storeRevenue: number;
  storeExpense: number;
  period: string;
  locked: number;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH_PATTERN = /^\d{4}-\d{2}$/u;
const MAX_PAGE_SIZE = 50;
const orderAccountingDate = "COALESCE(NULLIF(s.work_date, ''), date(datetime(o.created_at, '+7 hours')))";
const attendanceAccountingDate = "COALESCE(NULLIF(s.work_date, ''), date(datetime(s.started_at, '+7 hours')))";
const orderShiftSnapshotJsonSql = `json_object(
  'id', s.id, 'shiftCode', s.shift_code, 'storeId', s.store_id, 'employeeId', s.employee_id,
  'shiftName', s.shift_name, 'scheduledStart', s.scheduled_start, 'scheduledEnd', s.scheduled_end,
  'scheduledStartAt', s.scheduled_start_at, 'scheduledEndAt', s.scheduled_end_at,
  'workDate', s.work_date, 'previousSessionId', s.previous_session_id, 'transferId', s.transfer_id,
  'appliedHourlyRate', s.applied_hourly_rate, 'appliedTiktokAllowance', s.applied_tiktok_allowance,
  'appliedSupportAllowance', s.applied_support_allowance,
  'startedAt', s.started_at, 'attendanceStatus', s.attendance_status,
  'attendanceDeltaMinutes', s.attendance_delta_minutes,
  'attendanceGraceMinutes', s.attendance_grace_minutes,
  'clockInLatitude', s.clock_in_latitude, 'clockInLongitude', s.clock_in_longitude,
  'clockInAccuracyMeters', s.clock_in_accuracy_meters,
  'clockInLocationCapturedAt', s.clock_in_location_captured_at,
  'endedAt', s.ended_at, 'durationSeconds', s.duration_seconds,
  'adminAdjustedDurationSeconds', s.admin_adjusted_duration_seconds,
  'tiktok', s.tiktok, 'tiktokAllowance', s.tiktok_allowance,
  'tasksCompleted', s.tasks_completed, 'expenseAmount', s.expense_amount,
  'expenseNote', s.expense_note, 'cashRevenue', s.cash_revenue,
  'transferRevenue', s.transfer_revenue, 'closeReason', s.close_reason,
  'closeStatus', s.close_status, 'status', s.status
)`;
const orderNotificationsJsonSql = `(SELECT COALESCE(json_group_array(json(notification_json)), '[]')
  FROM (
    SELECT json_object(
      'id', n.id, 'recipientUserId', n.recipient_user_id, 'storeId', n.store_id,
      'type', n.type, 'entityType', n.entity_type, 'entityId', n.entity_id,
      'title', n.title, 'message', n.message, 'dataJson', n.data_json,
      'readAt', n.read_at, 'createdAt', n.created_at
    ) AS notification_json
    FROM notifications n
    WHERE n.store_id = o.store_id AND n.entity_type = 'ORDER' AND n.entity_id = o.id
    ORDER BY n.id
  ))`;

function json(data: unknown, status = 200) {
  return responseJson(data, status, {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie",
  });
}

function affectedRows(result: unknown) {
  const row = result as { meta?: { changes?: number }; changes?: number } | undefined;
  return Number(row?.meta?.changes ?? row?.changes ?? 0);
}

function optional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function parseFilter(url: URL): ListFilter {
  const storeId = optional(url.searchParams.get("storeId"));
  if (!storeId) throw new Error("Thiếu cửa hàng cần xem dữ liệu.");
  const resource = url.searchParams.get("resource") === "ATTENDANCE"
    ? "ATTENDANCE"
    : url.searchParams.get("resource") === "ORDERS" ? "ORDERS" : null;
  if (!resource) throw new Error("Loại dữ liệu không hợp lệ.");
  const rawRange = url.searchParams.get("range");
  const range = rawRange === "DAY" || rawRange === "MONTH" || rawRange === "ALL" ? rawRange : "ALL";
  const date = optional(url.searchParams.get("date"));
  const period = optional(url.searchParams.get("period"));
  if (range === "DAY" && (!date || !DAY_PATTERN.test(date))) throw new Error("Ngày lọc không hợp lệ.");
  if (range === "MONTH" && (!period || !MONTH_PATTERN.test(period))) throw new Error("Tháng lọc không hợp lệ.");
  return {
    storeId,
    resource,
    range,
    date: range === "DAY" ? date : null,
    period: range === "MONTH" ? period : null,
    employeeId: optional(url.searchParams.get("employeeId")),
    shiftCode: optional(url.searchParams.get("shiftCode")),
    search: optional(url.searchParams.get("search")),
    page: positiveInteger(url.searchParams.get("page"), 1),
    pageSize: positiveInteger(url.searchParams.get("pageSize"), 20, MAX_PAGE_SIZE),
  };
}

async function requireSuperAdmin(request: Request) {
  const user = await getSessionUser(request);
  return user?.role === "MANAGER" && Number(user.isSuperAdmin) === 1 ? user : null;
}

function periodLockSql(storeAlias: string, periodSql: string) {
  return `${storePeriodUnlockedSql(storeAlias, periodSql)} AND NOT EXISTS (
      SELECT 1 FROM employee_payroll_closings employee_lock
      WHERE employee_lock.store_id = ${storeAlias} AND employee_lock.period = ${periodSql}
    ) AND NOT EXISTS (
      SELECT 1 FROM business_records sharing_lock
      WHERE sharing_lock.category = 'DIVIDEND' AND sharing_lock.status = 'LOCKED'
        AND json_extract(sharing_lock.data_json, '$.period') = ${periodSql}
    )`;
}

async function assertPeriodUnlocked(db: Database, storeId: string, period: string) {
  const locks = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM employee_payroll_closings
        WHERE store_id = ? AND period = ?) AS employeeLocked,
      EXISTS(SELECT 1 FROM business_records
        WHERE store_id = ? AND category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING')
          AND COALESCE(status, '') != 'DELETED'
          AND json_extract(data_json, '$.period') = ?) AS storeLocked,
      EXISTS(SELECT 1 FROM business_records
        WHERE category = 'DIVIDEND' AND status = 'LOCKED'
          AND json_extract(data_json, '$.period') = ?) AS sharingLocked`)
    .bind(storeId, period, storeId, period, period)
    .first<{ employeeLocked: number; storeLocked: number; sharingLocked: number }>();
  if (locks?.employeeLocked) throw new Error("Kỳ lương của nhân viên đã khóa; không thể thay đổi dữ liệu chấm công hoặc đơn hàng.");
  if (locks?.storeLocked) throw new Error("Kỳ lương/KPI của cửa hàng đã chốt hoặc đang khóa; không thể thay đổi dữ liệu.");
  if (locks?.sharingLocked) throw new Error("Kỳ chia lợi nhuận đã khóa; không thể thay đổi dữ liệu.");
}

function filterWhere(filter: ListFilter) {
  const alias = filter.resource === "ORDERS" ? "o" : "s";
  const accountingDate = filter.resource === "ORDERS" ? orderAccountingDate : attendanceAccountingDate;
  const clauses = [`${alias}.store_id = ?`];
  const bindings: unknown[] = [filter.storeId];
  if (filter.range === "DAY") {
    clauses.push(`${accountingDate} = ?`);
    bindings.push(filter.date);
  } else if (filter.range === "MONTH") {
    clauses.push(`substr(${accountingDate}, 1, 7) = ?`);
    bindings.push(filter.period);
  }
  if (filter.employeeId) {
    clauses.push(`${alias}.employee_id = ?`);
    bindings.push(filter.employeeId);
  }
  if (filter.shiftCode) {
    clauses.push(`${alias}.shift_code = ?`);
    bindings.push(filter.shiftCode);
  }
  if (filter.search) {
    const needle = `%${filter.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    if (filter.resource === "ORDERS") {
      clauses.push(`(o.code LIKE ? ESCAPE '\\' OR COALESCE(o.customer_name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(o.phone, '') LIKE ? ESCAPE '\\' OR COALESCE(e.name, '') LIKE ? ESCAPE '\\')`);
      bindings.push(needle, needle, needle, needle);
    } else {
      clauses.push(`(s.shift_code LIKE ? ESCAPE '\\' OR COALESCE(s.shift_name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(e.name, '') LIKE ? ESCAPE '\\' OR COALESCE(e.code, '') LIKE ? ESCAPE '\\')`);
      bindings.push(needle, needle, needle, needle);
    }
  }
  return { sql: clauses.join(" AND "), bindings };
}

function versionState(row: OrderItem | AttendanceItem) {
  if ("amount" in row) {
    return {
      id: row.id, storeId: row.storeId, employeeId: row.employeeId, shiftCode: row.shiftCode,
      customerName: row.customerName, phone: row.phone, age: row.age, amount: row.amount,
      paymentMethod: row.paymentMethod, status: row.status, createdAt: row.createdAt,
      shiftSessionId: row.shiftSessionId, shiftStatus: row.shiftStatus,
      shiftCashRevenue: row.shiftCashRevenue, shiftTransferRevenue: row.shiftTransferRevenue,
      storeRevenue: row.storeRevenue, storeExpense: row.storeExpense, period: row.period, locked: row.locked,
    };
  }
  return {
    id: row.id, storeId: row.storeId, employeeId: row.employeeId, shiftCode: row.shiftCode,
    startedAt: row.startedAt, endedAt: row.endedAt, recordedDurationSeconds: row.recordedDurationSeconds,
    adminAdjustedDurationSeconds: row.adminAdjustedDurationSeconds, status: row.status,
    attendanceStatus: row.attendanceStatus, attendanceDeltaMinutes: row.attendanceDeltaMinutes,
    scheduledStart: row.scheduledStart, scheduledEnd: row.scheduledEnd,
    scheduledStartAt: row.scheduledStartAt ?? null, scheduledEndAt: row.scheduledEndAt ?? null,
    appliedHourlyRate: row.appliedHourlyRate ?? null,
    appliedTiktokAllowance: row.appliedTiktokAllowance ?? null,
    appliedSupportAllowance: row.appliedSupportAllowance ?? null,
    cashRevenue: row.cashRevenue, transferRevenue: row.transferRevenue, expenseAmount: row.expenseAmount,
    linkedOrderCount: row.linkedOrderCount, storeRevenue: row.storeRevenue, storeExpense: row.storeExpense,
    period: row.period, locked: row.locked,
  };
}

async function versioned<T extends OrderItem | AttendanceItem>(row: T) {
  return { ...row, versionToken: await sha256(JSON.stringify(versionState(row))) };
}

async function listOrders(db: Database, filter: ListFilter) {
  const where = filterWhere(filter);
  const periodSql = `substr(${orderAccountingDate}, 1, 7)`;
  const unlockedSql = periodLockSql("o.store_id", periodSql);
  const countStatement = db.prepare(`SELECT COUNT(*) AS count FROM orders o
      LEFT JOIN employees e ON e.id = o.employee_id
      LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code
        AND s.employee_id = o.employee_id AND s.store_id = o.store_id
      WHERE ${where.sql}`).bind(...where.bindings);
  const rowsStatement = db.prepare(`SELECT
      o.id, o.code, o.store_id AS storeId, o.employee_id AS employeeId,
      e.code AS employeeCode, e.name AS employeeName,
      o.shift_code AS shiftCode, s.id AS shiftSessionId, s.shift_name AS shiftName,
      s.status AS shiftStatus, s.work_date AS workDate,
      o.customer_name AS customerName, o.phone, o.age, o.amount,
      o.payment_method AS paymentMethod, o.status, o.created_at AS createdAt,
      s.cash_revenue AS shiftCashRevenue, s.transfer_revenue AS shiftTransferRevenue,
      st.revenue AS storeRevenue, st.expense AS storeExpense,
      ${periodSql} AS period,
      CASE WHEN s.id IS NULL OR NOT (${unlockedSql}) THEN 1 ELSE 0 END AS locked
    FROM orders o
    LEFT JOIN employees e ON e.id = o.employee_id
    LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code
      AND s.employee_id = o.employee_id AND s.store_id = o.store_id
    JOIN stores st ON st.id = o.store_id
    WHERE ${where.sql}
    ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`)
    .bind(...where.bindings, filter.pageSize, (filter.page - 1) * filter.pageSize);
  const [countResult, rowsResult] = await db.batch([countStatement, rowsStatement]);
  const count = countResult.results[0] as { count?: number } | undefined;
  const rows = rowsResult.results as OrderItem[];
  return { total: Number(count?.count ?? 0), rows: await Promise.all(rows.map(versioned)) };
}

async function listAttendance(db: Database, filter: ListFilter) {
  const where = filterWhere(filter);
  const periodSql = `substr(${attendanceAccountingDate}, 1, 7)`;
  const unlockedSql = periodLockSql("s.store_id", periodSql);
  const countStatement = db.prepare(`SELECT COUNT(*) AS count FROM shift_sessions s
      LEFT JOIN employees e ON e.id = s.employee_id WHERE ${where.sql}`)
    .bind(...where.bindings);
  const rowsStatement = db.prepare(`SELECT
      s.id, s.store_id AS storeId, s.employee_id AS employeeId,
      e.code AS employeeCode, e.name AS employeeName,
      s.shift_code AS shiftCode, s.shift_name AS shiftName, s.work_date AS workDate,
      s.started_at AS startedAt, s.ended_at AS endedAt,
      s.duration_seconds AS recordedDurationSeconds,
      s.admin_adjusted_duration_seconds AS adminAdjustedDurationSeconds,
      COALESCE(s.admin_adjusted_duration_seconds,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          WHEN s.ended_at IS NOT NULL THEN MAX(0, ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0))
          ELSE 0 END
      ) AS durationSeconds,
      s.status, s.attendance_status AS attendanceStatus,
      s.attendance_delta_minutes AS attendanceDeltaMinutes,
      s.attendance_grace_minutes AS attendanceGraceMinutes,
      s.scheduled_start AS scheduledStart, s.scheduled_end AS scheduledEnd,
      s.scheduled_start_at AS scheduledStartAt, s.scheduled_end_at AS scheduledEndAt,
      s.applied_hourly_rate AS appliedHourlyRate,
      s.applied_tiktok_allowance AS appliedTiktokAllowance,
      s.applied_support_allowance AS appliedSupportAllowance,
      s.cash_revenue AS cashRevenue, s.transfer_revenue AS transferRevenue,
      s.expense_amount AS expenseAmount,
      (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.store_id
        AND o.employee_id = s.employee_id AND o.shift_code = s.shift_code) AS linkedOrderCount,
      st.revenue AS storeRevenue, st.expense AS storeExpense,
      ${periodSql} AS period,
      CASE WHEN NOT (${unlockedSql}) THEN 1 ELSE 0 END AS locked
    FROM shift_sessions s
    LEFT JOIN employees e ON e.id = s.employee_id
    JOIN stores st ON st.id = s.store_id
    WHERE ${where.sql}
    ORDER BY ${attendanceAccountingDate} DESC, s.started_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .bind(...where.bindings, filter.pageSize, (filter.page - 1) * filter.pageSize);
  const [countResult, rowsResult] = await db.batch([countStatement, rowsStatement]);
  const count = countResult.results[0] as { count?: number } | undefined;
  const rows = rowsResult.results as AttendanceItem[];
  return { total: Number(count?.count ?? 0), rows: await Promise.all(rows.map(versioned)) };
}

async function loadOrder(db: Database, storeId: string, id: string) {
  const periodSql = `substr(${orderAccountingDate}, 1, 7)`;
  const unlockedSql = periodLockSql("o.store_id", periodSql);
  const row = await db.prepare(`SELECT
      o.id, o.code, o.store_id AS storeId, o.employee_id AS employeeId,
      e.code AS employeeCode, e.name AS employeeName,
      o.shift_code AS shiftCode, s.id AS shiftSessionId, s.shift_name AS shiftName,
      s.status AS shiftStatus, s.work_date AS workDate,
      o.customer_name AS customerName, o.phone, o.age, o.amount,
      o.payment_method AS paymentMethod, o.status, o.created_at AS createdAt,
      o.client_request_id AS clientRequestId,
      o.client_request_fingerprint AS clientRequestFingerprint,
      ${orderShiftSnapshotJsonSql} AS shiftSnapshotJson,
      ${orderNotificationsJsonSql} AS notificationsJson,
      s.cash_revenue AS shiftCashRevenue, s.transfer_revenue AS shiftTransferRevenue,
      st.revenue AS storeRevenue, st.expense AS storeExpense,
      ${periodSql} AS period,
      CASE WHEN s.id IS NULL OR NOT (${unlockedSql}) THEN 1 ELSE 0 END AS locked
    FROM orders o LEFT JOIN employees e ON e.id = o.employee_id
    LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code
      AND s.employee_id = o.employee_id AND s.store_id = o.store_id
    JOIN stores st ON st.id = o.store_id
    WHERE o.id = ? AND o.store_id = ? LIMIT 1`).bind(id, storeId)
    .first<OrderItem & { notificationsJson?: string; shiftSnapshotJson?: string }>();
  if (!row) return null;
  const { notificationsJson, shiftSnapshotJson, ...item } = row;
  let notifications: Array<Record<string, unknown>> = [];
  try { notifications = JSON.parse(notificationsJson ?? "[]") as Array<Record<string, unknown>>; } catch { notifications = []; }
  let shiftSnapshot: Record<string, unknown> = {};
  try { shiftSnapshot = JSON.parse(shiftSnapshotJson ?? "{}") as Record<string, unknown>; } catch { shiftSnapshot = {}; }
  return {
    ...item,
    notifications,
    shiftSnapshot,
    notificationsCanonicalJson: notificationsJson ?? "[]",
    shiftSnapshotCanonicalJson: shiftSnapshotJson ?? "{}",
  } as OrderItem;
}

async function loadAttendance(db: Database, storeId: string, id: string) {
  const periodSql = `substr(${attendanceAccountingDate}, 1, 7)`;
  const unlockedSql = periodLockSql("s.store_id", periodSql);
  return db.prepare(`SELECT
      s.id, s.store_id AS storeId, s.employee_id AS employeeId,
      e.code AS employeeCode, e.name AS employeeName,
      s.shift_code AS shiftCode, s.shift_name AS shiftName, s.work_date AS workDate,
      s.started_at AS startedAt, s.ended_at AS endedAt,
      s.duration_seconds AS recordedDurationSeconds,
      s.admin_adjusted_duration_seconds AS adminAdjustedDurationSeconds,
      COALESCE(s.admin_adjusted_duration_seconds,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          WHEN s.ended_at IS NOT NULL THEN MAX(0, ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0))
          ELSE 0 END
      ) AS durationSeconds,
      s.status, s.attendance_status AS attendanceStatus,
      s.attendance_delta_minutes AS attendanceDeltaMinutes,
      s.attendance_grace_minutes AS attendanceGraceMinutes,
      s.scheduled_start AS scheduledStart, s.scheduled_end AS scheduledEnd,
      s.scheduled_start_at AS scheduledStartAt, s.scheduled_end_at AS scheduledEndAt,
      s.previous_session_id AS previousSessionId, s.transfer_id AS transferId,
      s.applied_hourly_rate AS appliedHourlyRate,
      s.applied_tiktok_allowance AS appliedTiktokAllowance,
      s.applied_support_allowance AS appliedSupportAllowance,
      s.tiktok, s.tiktok_allowance AS tiktokAllowance, s.tasks_completed AS tasksCompleted,
      s.expense_note AS expenseNote, s.close_reason AS closeReason, s.close_status AS closeStatus,
      s.clock_in_latitude AS clockInLatitude, s.clock_in_longitude AS clockInLongitude,
      s.clock_in_accuracy_meters AS clockInAccuracyMeters,
      s.clock_in_location_captured_at AS clockInLocationCapturedAt,
      s.cash_revenue AS cashRevenue, s.transfer_revenue AS transferRevenue,
      s.expense_amount AS expenseAmount,
      (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.store_id
        AND o.employee_id = s.employee_id AND o.shift_code = s.shift_code) AS linkedOrderCount,
      st.revenue AS storeRevenue, st.expense AS storeExpense,
      ${periodSql} AS period,
      CASE WHEN NOT (${unlockedSql}) THEN 1 ELSE 0 END AS locked
    FROM shift_sessions s LEFT JOIN employees e ON e.id = s.employee_id
    JOIN stores st ON st.id = s.store_id
    WHERE s.id = ? AND s.store_id = ? LIMIT 1`).bind(id, storeId).first<AttendanceItem>();
}

function archiveInsert(
  db: Database,
  archiveId: string,
  userId: string,
  kind: string,
  storeId: string,
  filter: Record<string, unknown>,
  summary: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  createdAt: string,
  gateSql: string,
  gateBindings: unknown[],
) {
  return db.prepare(`INSERT INTO admin_reset_archives
      (id, store_id, actor_user_id, kind, filter_json, summary_json, snapshot_json, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gateSql}`)
    .bind(
      archiveId, storeId, userId, kind, JSON.stringify(filter), JSON.stringify(summary),
      JSON.stringify(snapshot), createdAt, ...gateBindings,
    );
}

function auditInsert(
  db: Database,
  archiveId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
  createdAt: string,
) {
  const before = Object.prototype.hasOwnProperty.call(detail, "before") ? detail.before : undefined;
  const after = Object.prototype.hasOwnProperty.call(detail, "after") ? detail.after : undefined;
  const reason = typeof detail.reason === "string" ? detail.reason : null;
  const beforeJson = before === undefined ? null : JSON.stringify(before);
  const afterJson = after === undefined ? null : JSON.stringify(after);
  const storeId = before && typeof before === "object" && "storeId" in before
    ? String((before as { storeId?: unknown }).storeId ?? "") || null
    : null;
  return db.prepare(`INSERT INTO audit_logs
      (id, user_id, action, entity_type, entity_id, detail, created_at,
       before_json, after_json, reason, store_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM admin_reset_archives WHERE id = ?)`)
    .bind(
      crypto.randomUUID(), userId, action, entityType, entityId, JSON.stringify(detail), createdAt,
      beforeJson, afterJson, reason, storeId, archiveId,
    );
}

function parseOrderEdit(body: Record<string, unknown>) {
  const amount = Number(body.amount);
  const age = body.age === "" || body.age == null ? null : Number(body.age);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Giá trị đơn hàng phải là số nguyên an toàn lớn hơn 0.");
  if (age != null && (!Number.isInteger(age) || age < 1 || age > 120)) throw new Error("Tuổi khách hàng không hợp lệ.");
  const paymentMethod = body.paymentMethod === "BANK_TRANSFER" ? "BANK_TRANSFER" : body.paymentMethod === "CASH" ? "CASH" : null;
  if (!paymentMethod) throw new Error("Hình thức thanh toán không hợp lệ.");
  return {
    customerName: optional(body.customerName),
    phone: optional(body.phone),
    age,
    amount,
    paymentMethod,
  };
}

type AttendanceEdit = {
  mode: "DURATION" | "TIMES";
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  status: "ACTIVE" | "COMPLETED";
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
  attendanceDeltaMinutes: number | null;
};

function normalizeIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Vui lòng nhập ${label}.`);
  const parsed = new Date(value.trim());
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} không hợp lệ.`);
  return parsed.toISOString();
}

function scheduledStartTimestamp(previous: AttendanceItem) {
  if (previous.scheduledStartAt && Number.isFinite(new Date(previous.scheduledStartAt).getTime())) {
    return previous.scheduledStartAt;
  }
  if (!previous.workDate || !previous.scheduledStart || !previous.scheduledEnd) return null;
  return shiftUtcRange(previous.workDate, previous.scheduledStart, previous.scheduledEnd)?.startAt ?? null;
}

function parseAttendanceEdit(body: Record<string, unknown>, previous: AttendanceItem): AttendanceEdit {
  // Keep the duration-only contract during the UI rollout, but active sessions
  // must use explicit timestamps so their state cannot become contradictory.
  if (body.startedAt === undefined) {
    if (previous.status === "ACTIVE" || !previous.endedAt) {
      throw new Error("Ca đang làm phải chỉnh bằng giờ vào và giờ kết ca cụ thể.");
    }
    if (body.durationHours === "" || body.durationHours == null) throw new Error("Vui lòng nhập số giờ làm thực tế.");
    const hours = Number(body.durationHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 72) throw new Error("Số giờ thực tế phải từ 0 đến 72 giờ.");
    return {
      mode: "DURATION",
      startedAt: previous.startedAt,
      endedAt: previous.endedAt,
      durationSeconds: Math.round(hours * 3_600),
      status: "COMPLETED",
      attendanceStatus: previous.attendanceStatus as AttendanceEdit["attendanceStatus"],
      attendanceDeltaMinutes: previous.attendanceDeltaMinutes,
    };
  }

  const startedAt = normalizeIsoTimestamp(body.startedAt, "giờ vào ca");
  const endedAt = body.endedAt === "" || body.endedAt == null
    ? null : normalizeIsoTimestamp(body.endedAt, "giờ kết ca");
  const accountingDate = previous.workDate || localDate(new Date(previous.startedAt));
  const scheduledStartAt = scheduledStartTimestamp(previous);
  const scheduledEndAt = previous.scheduledEndAt && Number.isFinite(new Date(previous.scheduledEndAt).getTime())
    ? previous.scheduledEndAt
    : previous.workDate && previous.scheduledStart && previous.scheduledEnd
      ? shiftUtcRange(previous.workDate, previous.scheduledStart, previous.scheduledEnd)?.endAt ?? null
      : null;
  if (scheduledStartAt && scheduledEndAt) {
    const scheduledStartDate = localDate(new Date(scheduledStartAt));
    const scheduledEndDate = localDate(new Date(scheduledEndAt));
    const correctedStartDate = localDate(new Date(startedAt));
    if (correctedStartDate < scheduledStartDate || correctedStartDate > scheduledEndDate
      || new Date(startedAt).getTime() > new Date(scheduledEndAt).getTime()) {
      throw new Error(`Giờ vào ca phải thuộc đúng ngày chấm công ${accountingDate} hoặc phần qua đêm của chính ca này.`);
    }
  } else if (localDate(new Date(startedAt)) !== accountingDate) {
    throw new Error(`Giờ vào ca phải thuộc đúng ngày chấm công ${accountingDate}; không thể chuyển bản ghi sang ngày hoặc kỳ lương khác.`);
  }
  if (previous.status === "ACTIVE" && endedAt) {
    throw new Error("Ca đang làm chỉ được sửa giờ vào; hãy kết ca bằng quy trình kết ca để đối soát đơn hàng và dòng tiền.");
  }
  if (!endedAt && previous.status !== "ACTIVE") {
    throw new Error("Không thể mở lại ca đã hoàn tất. Vui lòng nhập giờ kết ca.");
  }
  const startedTime = new Date(startedAt).getTime();
  const endedTime = endedAt ? new Date(endedAt).getTime() : null;
  if (endedTime !== null && endedTime < startedTime) throw new Error("Giờ kết ca không được trước giờ vào ca.");
  const durationSeconds = endedTime === null ? 0 : Math.round((endedTime - startedTime) / 1_000);
  if (durationSeconds > 72 * 3_600) throw new Error("Thời gian làm thực tế không được vượt quá 72 giờ.");
  const delta = scheduledStartAt ? attendanceDeltaMinutes(startedAt, scheduledStartAt) : null;
  return {
    mode: "TIMES",
    startedAt,
    endedAt,
    durationSeconds,
    status: previous.status === "ACTIVE" ? "ACTIVE" : "COMPLETED",
    attendanceStatus: scheduledStartAt
      ? attendanceStatusAt(startedAt, scheduledStartAt, previous.attendanceGraceMinutes)
      : null,
    attendanceDeltaMinutes: delta,
  };
}

async function mutateOrder(
  db: Database,
  userId: string,
  previous: OrderItem,
  next: ReturnType<typeof parseOrderEdit> | null,
  reason: string,
) {
  if (!previous.shiftSessionId || previous.shiftCashRevenue == null || previous.shiftTransferRevenue == null) {
    throw new Error("Đơn hàng chưa liên kết được với ca gốc; cần đối soát trước khi sửa hoặc xóa.");
  }
  if (previous.locked) throw new Error("Kỳ lương/KPI của đơn hàng đã khóa; không thể thay đổi dữ liệu.");
  const archiveId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const deleting = next == null;
  const nextStatus = deleting ? null : previous.status;
  const nextAmount = deleting ? 0 : next.amount;
  const nextCompletedContribution = nextStatus === "COMPLETED" ? nextAmount : 0;
  const previousShiftRevenue = Number(previous.shiftCashRevenue) + Number(previous.shiftTransferRevenue);
  const periodSql = `substr(${orderAccountingDate}, 1, 7)`;
  const unlockedSql = periodLockSql("o.store_id", periodSql);
  const gateSql = `EXISTS (
      SELECT 1 FROM orders o
      JOIN shift_sessions s ON s.id = ? AND s.shift_code = o.shift_code
        AND s.employee_id = o.employee_id AND s.store_id = o.store_id
      JOIN stores st ON st.id = o.store_id
      WHERE o.id = ? AND o.code = ? AND o.store_id = ? AND o.employee_id = ? AND o.shift_code = ?
        AND o.customer_name IS ? AND o.phone IS ? AND o.age IS ?
        AND o.amount = ? AND o.payment_method = ? AND o.status = ? AND o.created_at = ?
        AND o.client_request_id IS ? AND o.client_request_fingerprint IS ?
        AND s.status = ? AND s.cash_revenue = ? AND s.transfer_revenue = ?
        AND st.revenue = ? AND st.expense = ?
        AND ${orderNotificationsJsonSql} = ?
        AND ${orderShiftSnapshotJsonSql} = ?
        AND ${unlockedSql}
        AND (s.status != 'COMPLETED' OR st.revenue
          + COALESCE((SELECT SUM(CASE WHEN sibling.status = 'COMPLETED' THEN sibling.amount ELSE 0 END)
              FROM orders sibling WHERE sibling.store_id = o.store_id
                AND sibling.employee_id = o.employee_id AND sibling.shift_code = o.shift_code
                AND sibling.id != o.id), 0)
          + ? - s.cash_revenue - s.transfer_revenue >= 0)
    )`;
  const gateBindings = [
    previous.shiftSessionId, previous.id, previous.code, previous.storeId, previous.employeeId, previous.shiftCode,
    previous.customerName, previous.phone, previous.age, previous.amount, previous.paymentMethod,
    previous.status, previous.createdAt, previous.clientRequestId ?? null,
    previous.clientRequestFingerprint ?? null, previous.shiftStatus, previous.shiftCashRevenue,
    previous.shiftTransferRevenue, previous.storeRevenue, previous.storeExpense,
    previous.notificationsCanonicalJson ?? "[]", previous.shiftSnapshotCanonicalJson ?? "{}",
    nextCompletedContribution,
  ];
  const before = { ...previous };
  delete before.notificationsCanonicalJson;
  delete before.shiftSnapshotCanonicalJson;
  const action = deleting ? "SUPER_ADMIN_ORDER_DELETE" : "SUPER_ADMIN_ORDER_UPDATE";
  const archive = archiveInsert(
    db, archiveId, userId, deleting ? "ORDER_DELETE" : "ORDER_EDIT", previous.storeId,
    { resource: "ORDERS", id: previous.id, reason },
    { count: 1, amountBefore: previous.status === "COMPLETED" ? previous.amount : 0, amountAfter: nextCompletedContribution },
    { schemaVersion: 1, before, after: next }, createdAt, gateSql, gateBindings,
  );
  const existsArchive = "EXISTS (SELECT 1 FROM admin_reset_archives WHERE id = ?)";
  const mutation = deleting
    ? db.prepare(`DELETE FROM orders WHERE id = ? AND store_id = ? AND ${existsArchive}`)
      .bind(previous.id, previous.storeId, archiveId)
    : db.prepare(`UPDATE orders SET customer_name = ?, phone = ?, age = ?, amount = ?, payment_method = ?
        WHERE id = ? AND store_id = ? AND ${existsArchive}`)
      .bind(next.customerName, next.phone, next.age, next.amount, next.paymentMethod, previous.id, previous.storeId, archiveId);
  const results = await db.batch([
    archive,
    auditInsert(db, archiveId, userId, action, "ORDER", previous.id, {
      archiveId, reason, before, after: next,
    }, createdAt),
    ...(deleting ? [db.prepare(`DELETE FROM notifications WHERE store_id = ? AND entity_type = 'ORDER'
      AND entity_id = ? AND ${existsArchive}`).bind(previous.storeId, previous.id, archiveId)] : []),
    mutation,
    db.prepare(`UPDATE stores SET revenue = revenue + COALESCE((
        SELECT COALESCE(SUM(CASE WHEN current_order.status = 'COMPLETED' THEN current_order.amount ELSE 0 END), 0)
          - ?
        FROM shift_sessions target_shift
        LEFT JOIN orders current_order ON current_order.store_id = target_shift.store_id
          AND current_order.employee_id = target_shift.employee_id
          AND current_order.shift_code = target_shift.shift_code
        WHERE target_shift.id = ? AND target_shift.status = 'COMPLETED'
        GROUP BY target_shift.id
      ), 0)
      WHERE id = ? AND ${existsArchive}`)
      .bind(previousShiftRevenue, previous.shiftSessionId, previous.storeId, archiveId),
    db.prepare(`UPDATE shift_sessions SET
        cash_revenue = COALESCE((SELECT SUM(current_order.amount) FROM orders current_order
          WHERE current_order.store_id = shift_sessions.store_id
            AND current_order.employee_id = shift_sessions.employee_id
            AND current_order.shift_code = shift_sessions.shift_code
            AND current_order.status = 'COMPLETED' AND current_order.payment_method = 'CASH'), 0),
        transfer_revenue = COALESCE((SELECT SUM(current_order.amount) FROM orders current_order
          WHERE current_order.store_id = shift_sessions.store_id
            AND current_order.employee_id = shift_sessions.employee_id
            AND current_order.shift_code = shift_sessions.shift_code
            AND current_order.status = 'COMPLETED' AND current_order.payment_method = 'BANK_TRANSFER'), 0)
      WHERE id = ? AND status = 'COMPLETED' AND ${existsArchive}`)
      .bind(previous.shiftSessionId, archiveId),
  ]);
  if (affectedRows(results[0]) !== 1) {
    await assertPeriodUnlocked(db, previous.storeId, previous.period);
    throw new Error("Đơn hàng đã thay đổi bởi một yêu cầu khác. Vui lòng tải lại danh sách trước khi thao tác.");
  }
  return archiveId;
}

async function mutateAttendance(
  db: Database,
  userId: string,
  previous: AttendanceItem,
  edit: AttendanceEdit | null,
  reason: string,
) {
  if (previous.locked) throw new Error("Kỳ lương/KPI của chấm công đã khóa; không thể thay đổi dữ liệu.");
  const deleting = edit == null;
  if (deleting && previous.linkedOrderCount > 0) {
    throw new Error("Ca còn đơn hàng. Hãy xóa đơn hàng của ca trước rồi mới xóa chấm công.");
  }
  const archiveId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const periodSql = `substr(${attendanceAccountingDate}, 1, 7)`;
  const unlockedSql = periodLockSql("s.store_id", periodSql);
  const gateSql = `EXISTS (
      SELECT 1 FROM shift_sessions s JOIN stores st ON st.id = s.store_id
      WHERE s.id = ? AND s.store_id = ? AND s.employee_id = ? AND s.shift_code = ?
        AND s.shift_name IS ? AND s.scheduled_start IS ? AND s.scheduled_end IS ?
        AND s.scheduled_start_at IS ? AND s.scheduled_end_at IS ? AND s.work_date IS ?
        AND s.previous_session_id IS ? AND s.transfer_id IS ?
        AND s.applied_hourly_rate IS ? AND s.applied_tiktok_allowance IS ?
        AND s.applied_support_allowance IS ?
        AND s.started_at = ? AND s.attendance_status IS ? AND s.attendance_delta_minutes IS ?
        AND s.attendance_grace_minutes = ?
        AND s.clock_in_latitude IS ? AND s.clock_in_longitude IS ?
        AND s.clock_in_accuracy_meters IS ? AND s.clock_in_location_captured_at IS ?
        AND s.ended_at IS ? AND s.duration_seconds = ?
        AND s.admin_adjusted_duration_seconds IS ? AND s.status = ?
        AND s.tiktok = ? AND s.tiktok_allowance = ? AND s.tasks_completed = ?
        AND s.cash_revenue = ? AND s.transfer_revenue = ? AND s.expense_amount = ?
        AND s.expense_note IS ? AND s.close_reason IS ? AND s.close_status = ?
        AND st.revenue = ? AND st.expense = ? AND ${unlockedSql}
        ${edit?.mode === "DURATION" ? "AND s.status != 'ACTIVE' AND s.ended_at IS NOT NULL" : ""}
        ${edit?.status === "ACTIVE" ? `AND NOT EXISTS (
          SELECT 1 FROM shift_sessions other
          WHERE other.employee_id = s.employee_id AND other.status = 'ACTIVE' AND other.id != s.id
        ) AND NOT EXISTS (
          SELECT 1 FROM users u WHERE u.employee_id = s.employee_id
            AND u.shift_active = 1 AND COALESCE(u.current_shift, '') != s.shift_code
        )` : ""}
        ${deleting ? `AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.store_id = s.store_id
          AND o.employee_id = s.employee_id AND o.shift_code = s.shift_code)
        AND st.revenue >= s.cash_revenue + s.transfer_revenue
        AND st.expense >= s.expense_amount` : ""}
    )`;
  const gateBindings = [
    previous.id, previous.storeId, previous.employeeId, previous.shiftCode,
    previous.shiftName, previous.scheduledStart, previous.scheduledEnd,
    previous.scheduledStartAt ?? null, previous.scheduledEndAt ?? null, previous.workDate,
    previous.previousSessionId ?? null, previous.transferId ?? null,
    previous.appliedHourlyRate ?? null, previous.appliedTiktokAllowance ?? null,
    previous.appliedSupportAllowance ?? null,
    previous.startedAt, previous.attendanceStatus, previous.attendanceDeltaMinutes,
    previous.attendanceGraceMinutes,
    previous.clockInLatitude ?? null, previous.clockInLongitude ?? null,
    previous.clockInAccuracyMeters ?? null, previous.clockInLocationCapturedAt ?? null,
    previous.endedAt, previous.recordedDurationSeconds,
    previous.adminAdjustedDurationSeconds, previous.status,
    previous.tiktok ?? 0, previous.tiktokAllowance ?? 0, previous.tasksCompleted ?? 0,
    previous.cashRevenue, previous.transferRevenue, previous.expenseAmount,
    previous.expenseNote ?? null, previous.closeReason ?? null, previous.closeStatus ?? "PENDING",
    previous.storeRevenue, previous.storeExpense,
  ];
  const before = { ...previous };
  const after = deleting ? null : edit.mode === "DURATION"
    ? {
      ...previous,
      durationSeconds: edit.durationSeconds,
      adminAdjustedDurationSeconds: edit.durationSeconds,
    }
    : {
      ...previous,
      startedAt: edit.startedAt,
      endedAt: edit.endedAt,
      durationSeconds: edit.durationSeconds,
      recordedDurationSeconds: edit.durationSeconds,
      adminAdjustedDurationSeconds: null,
      status: edit.status,
      attendanceStatus: edit.attendanceStatus,
      attendanceDeltaMinutes: edit.attendanceDeltaMinutes,
    };
  const action = deleting ? "SUPER_ADMIN_ATTENDANCE_DELETE" : "SUPER_ADMIN_ATTENDANCE_UPDATE";
  const archive = archiveInsert(
    db, archiveId, userId, deleting ? "ATTENDANCE_DELETE" : "ATTENDANCE_EDIT", previous.storeId,
    { resource: "ATTENDANCE", id: previous.id, reason },
    { count: 1, hoursBefore: previous.durationSeconds / 3_600, hoursAfter: deleting ? 0 : edit.durationSeconds / 3_600 },
    { schemaVersion: 2, before, after }, createdAt, gateSql, gateBindings,
  );
  const existsArchive = "EXISTS (SELECT 1 FROM admin_reset_archives WHERE id = ?)";
  const attendanceMutation = deleting
    ? db.prepare(`DELETE FROM shift_sessions WHERE id = ? AND store_id = ? AND ${existsArchive}`)
      .bind(previous.id, previous.storeId, archiveId)
    : edit.mode === "DURATION"
      ? db.prepare(`UPDATE shift_sessions SET admin_adjusted_duration_seconds = ?
          WHERE id = ? AND store_id = ? AND ${existsArchive}`)
        .bind(edit.durationSeconds, previous.id, previous.storeId, archiveId)
      : db.prepare(`UPDATE shift_sessions SET started_at = ?, ended_at = ?, duration_seconds = ?,
          admin_adjusted_duration_seconds = NULL, status = ?, attendance_status = ?,
          attendance_delta_minutes = ?
        WHERE id = ? AND store_id = ? AND ${existsArchive}`)
        .bind(
          edit.startedAt, edit.endedAt, edit.durationSeconds, edit.status,
          edit.attendanceStatus, edit.attendanceDeltaMinutes,
          previous.id, previous.storeId, archiveId,
        );
  const userMutation = deleting || edit.status === "COMPLETED"
    ? db.prepare(`UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL
        WHERE employee_id = ? AND current_shift = ? AND ${existsArchive}`)
      .bind(previous.employeeId, previous.shiftCode, archiveId)
    : db.prepare(`UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ?
        WHERE employee_id = ? AND (shift_active = 0 OR current_shift = ?) AND ${existsArchive}`)
      .bind(previous.shiftCode, edit.startedAt, previous.employeeId, previous.shiftCode, archiveId);
  const results = await db.batch([
    archive,
    auditInsert(db, archiveId, userId, action, "SHIFT_SESSION", previous.id, { archiveId, reason, before, after }, createdAt),
    ...(deleting ? [
      db.prepare(`UPDATE stores SET revenue = revenue - ?, expense = expense - ?
        WHERE id = ? AND ${existsArchive}`)
        .bind(previous.cashRevenue + previous.transferRevenue, previous.expenseAmount, previous.storeId, archiveId),
    ] : []),
    userMutation,
    attendanceMutation,
  ]);
  if (affectedRows(results[0]) !== 1) {
    await assertPeriodUnlocked(db, previous.storeId, previous.period);
    const current = await loadAttendance(db, previous.storeId, previous.id);
    if (deleting && Number(current?.linkedOrderCount ?? 0) > 0) throw new Error("Ca còn đơn hàng. Hãy xóa đơn hàng trước.");
    throw new Error("Chấm công đã thay đổi bởi một yêu cầu khác. Vui lòng tải lại danh sách trước khi thao tác.");
  }
  return archiveId;
}

export async function GET(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được xem dữ liệu chi tiết." }, 403);
  try {
    const filter = parseFilter(new URL(request.url));
    const db = await initDb();
    const store = await db.prepare("SELECT id, name, revenue, expense FROM stores WHERE id = ? LIMIT 1")
      .bind(filter.storeId).first<StoreSnapshot>();
    if (!store) return json({ message: "Không tìm thấy cửa hàng." }, 404);
    const optionFilter = { ...filter, shiftCode: null, search: null };
    const optionWhere = filterWhere(optionFilter);
    const [result, employees, shifts] = await Promise.all([
      filter.resource === "ORDERS" ? listOrders(db, filter) : listAttendance(db, filter),
      db.prepare(`SELECT e.id, e.code, e.name, e.status FROM employees e
        WHERE e.store_id = ?
          OR EXISTS (SELECT 1 FROM orders o WHERE o.store_id = ? AND o.employee_id = e.id)
          OR EXISTS (SELECT 1 FROM shift_sessions s WHERE s.store_id = ? AND s.employee_id = e.id)
        ORDER BY e.status = 'ACTIVE' DESC, e.name, e.code`)
        .bind(filter.storeId, filter.storeId, filter.storeId)
        .all<{ id: string; code: string; name: string; status: string }>(),
      filter.resource === "ORDERS"
        ? db.prepare(`SELECT o.shift_code AS code, COALESCE(NULLIF(s.shift_name, ''), o.shift_code) AS name
            FROM orders o LEFT JOIN employees e ON e.id = o.employee_id
            LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code
              AND s.employee_id = o.employee_id AND s.store_id = o.store_id
            WHERE ${optionWhere.sql}
            GROUP BY o.shift_code, COALESCE(NULLIF(s.shift_name, ''), o.shift_code)
            ORDER BY MAX(o.created_at) DESC, name, code`).bind(...optionWhere.bindings)
          .all<{ code: string; name: string }>()
        : db.prepare(`SELECT s.shift_code AS code, COALESCE(NULLIF(s.shift_name, ''), s.shift_code) AS name
            FROM shift_sessions s LEFT JOIN employees e ON e.id = s.employee_id
            WHERE ${optionWhere.sql}
            GROUP BY s.shift_code, COALESCE(NULLIF(s.shift_name, ''), s.shift_code)
            ORDER BY MAX(s.started_at) DESC, name, code`).bind(...optionWhere.bindings)
          .all<{ code: string; name: string }>(),
    ]);
    return json({
      store,
      filter,
      employees: employees.results,
      shifts: shifts.results,
      rows: result.rows,
      pagination: {
        page: filter.page,
        pageSize: filter.pageSize,
        total: result.total,
        pages: Math.max(1, Math.ceil(result.total / filter.pageSize)),
      },
    });
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "Không thể tải dữ liệu chi tiết." }, 400);
  }
}

export async function PATCH(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được sửa dữ liệu." }, 403);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const storeId = optional(body.storeId);
  const id = optional(body.id);
  const versionToken = optional(body.versionToken);
  const reason = optional(body.reason);
  const resource = body.resource === "ATTENDANCE" ? "ATTENDANCE" : body.resource === "ORDERS" ? "ORDERS" : null;
  if (!storeId || !id || !versionToken || !resource) return json({ message: "Thiếu dữ liệu xác nhận bản ghi cần sửa." }, 400);
  if (!reason || reason.length < 3 || reason.length > 500) return json({ message: "Vui lòng nhập lý do thay đổi từ 3 đến 500 ký tự." }, 400);
  try {
    const db = await initDb();
    if (resource === "ORDERS") {
      const previous = await loadOrder(db, storeId, id);
      if (!previous) return json({ message: "Không tìm thấy đơn hàng trong cửa hàng này." }, 404);
      if (await sha256(JSON.stringify(versionState(previous))) !== versionToken) return json({ message: "Đơn hàng đã thay đổi. Vui lòng tải lại danh sách." }, 409);
      const archiveId = await mutateOrder(db, user.id, previous, parseOrderEdit(body), reason);
      return json({ message: "Đã cập nhật đơn hàng và đồng bộ doanh thu ca/cửa hàng.", archiveId });
    }
    const previous = await loadAttendance(db, storeId, id);
    if (!previous) return json({ message: "Không tìm thấy chấm công trong cửa hàng này." }, 404);
    if (await sha256(JSON.stringify(versionState(previous))) !== versionToken) return json({ message: "Chấm công đã thay đổi. Vui lòng tải lại danh sách." }, 409);
    const archiveId = await mutateAttendance(db, user.id, previous, parseAttendanceEdit(body, previous), reason);
    return json({ message: "Đã cập nhật giờ vào/kết ca, trạng thái đi làm và dữ liệu lương liên quan.", archiveId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể sửa dữ liệu.";
    return json({ message }, /khóa/u.test(message) ? 423 : /thay đổi|đang làm|liên kết/u.test(message) ? 409 : 400);
  }
}

export async function DELETE(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được xóa dữ liệu." }, 403);
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const storeId = optional(body.storeId) ?? optional(url.searchParams.get("storeId"));
  const id = optional(body.id) ?? optional(url.searchParams.get("id"));
  const versionToken = optional(body.versionToken) ?? optional(url.searchParams.get("versionToken"));
  const rawResource = body.resource ?? url.searchParams.get("resource");
  const resource = rawResource === "ATTENDANCE" ? "ATTENDANCE" : rawResource === "ORDERS" ? "ORDERS" : null;
  const reason = optional(body.reason);
  if (!storeId || !id || !versionToken || !resource) return json({ message: "Thiếu dữ liệu xác nhận bản ghi cần xóa." }, 400);
  if (!reason || reason.length < 3 || reason.length > 500) return json({ message: "Vui lòng nhập lý do xóa từ 3 đến 500 ký tự." }, 400);
  try {
    const db = await initDb();
    if (resource === "ORDERS") {
      const previous = await loadOrder(db, storeId, id);
      if (!previous) return json({ message: "Không tìm thấy đơn hàng trong cửa hàng này." }, 404);
      if (await sha256(JSON.stringify(versionState(previous))) !== versionToken) return json({ message: "Đơn hàng đã thay đổi. Vui lòng tải lại danh sách." }, 409);
      const archiveId = await mutateOrder(db, user.id, previous, null, reason);
      return json({ message: "Đã xóa đơn hàng, lưu bản đối soát và đồng bộ doanh thu.", archiveId });
    }
    const previous = await loadAttendance(db, storeId, id);
    if (!previous) return json({ message: "Không tìm thấy chấm công trong cửa hàng này." }, 404);
    if (await sha256(JSON.stringify(versionState(previous))) !== versionToken) return json({ message: "Chấm công đã thay đổi. Vui lòng tải lại danh sách." }, 409);
    const archiveId = await mutateAttendance(db, user.id, previous, null, reason);
    return json({ message: "Đã xóa chấm công, lưu bản đối soát và đồng bộ số liệu cửa hàng.", archiveId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể xóa dữ liệu.";
    return json({ message }, /khóa/u.test(message) ? 423 : /thay đổi|đang làm|còn đơn hàng|liên kết|đối soát/u.test(message) ? 409 : 400);
  }
}
