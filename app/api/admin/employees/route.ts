import { initDb } from "../../../../db/runtime";
import { durationSeconds } from "../../../lib/finance";
import { attendanceDeltaMinutes, attendanceStatusAt, shiftUtcRange } from "../../../lib/scheduling";
import {
  enqueuePurgedCccdDeletionStatement,
  processCccdDeletionOutbox,
} from "../../_lib/cccd-deletion";
import {
  employeeStatusLabel,
  isEmployeeStatus,
  normalizedEmployeeStatus,
  transitionEmployeeStatus,
} from "../../_lib/employee-lifecycle";
import { retireCccdUploadStatements } from "../../_lib/cccd-upload-registry";
import { getSessionUser, json as responseJson, sha256 } from "../../_lib/auth";
import { storePeriodUnlockedSql } from "../../_lib/store-period-lock";

type Database = Awaited<ReturnType<typeof initDb>>;

type EmployeeAdminRow = {
  id: string;
  storeId: string;
  code: string;
  name: string;
  position: string;
  phone: string;
  province: string;
  ward: string;
  addressLine: string;
  age: number | null;
  cccdImageKey: string | null;
  cccdImageName: string | null;
  hourlyRate: number;
  tiktokAllowance: number;
  status: string;
  inactiveAt: string | null;
  statusUpdatedAt: string | null;
  lifecycleVersion: number;
  username: string | null;
  hasLogin: number;
  activeShiftCount: number;
  orderCount: number;
  shiftCount: number;
  payrollClosingCount: number;
};

type ActiveShiftCloseRow = {
  id: string;
  shiftCode: string;
  storeId: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  workDate: string | null;
  startedAt: string;
  endedAt: string | null;
  attendanceStatus: string | null;
  attendanceDeltaMinutes: number | null;
  durationSeconds: number;
  cashRevenue: number;
  transferRevenue: number;
  expenseAmount: number;
  closeReason: string | null;
  closeStatus: string;
  orderCashRevenue: number;
  orderTransferRevenue: number;
  unknownTenderCount: number;
  storeRevenue: number;
  storeExpense: number;
  period: string;
  locked: number;
  shiftSnapshotCanonicalJson: string;
};

type ActiveShiftClosure = ActiveShiftCloseRow & {
  computedScheduledStartAt: string | null;
  computedScheduledEndAt: string | null;
  computedDurationSeconds: number;
  computedAttendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
  computedAttendanceDeltaMinutes: number | null;
  closeToken: string;
  auditId: string;
};

type StoreCloseSummary = {
  storeId: string;
  revenue: number;
  expense: number;
  revenueDelta: number;
};

const MAX_PAGE_SIZE = 100;
const PURGE_REASON_CATEGORY = "SUPER_ADMIN_EMPLOYEE_PURGE";
const activeShiftAccountingDate = "COALESCE(NULLIF(s.work_date, ''), date(datetime(s.started_at, '+7 hours')))";
const activeShiftPeriod = `substr(${activeShiftAccountingDate}, 1, 7)`;
const activeShiftSnapshotJsonSql = `json_object(
  'id', s.id, 'shiftCode', s.shift_code, 'storeId', s.store_id, 'employeeId', s.employee_id,
  'shiftName', s.shift_name, 'scheduledStart', s.scheduled_start, 'scheduledEnd', s.scheduled_end,
  'scheduledStartAt', s.scheduled_start_at, 'scheduledEndAt', s.scheduled_end_at,
  'workDate', s.work_date, 'previousSessionId', s.previous_session_id, 'transferId', s.transfer_id,
  'appliedHourlyRate', s.applied_hourly_rate, 'appliedTiktokAllowance', s.applied_tiktok_allowance,
  'startedAt', s.started_at, 'attendanceStatus', s.attendance_status,
  'attendanceDeltaMinutes', s.attendance_delta_minutes,
  'endedAt', s.ended_at, 'durationSeconds', s.duration_seconds,
  'adminAdjustedDurationSeconds', s.admin_adjusted_duration_seconds,
  'tiktok', s.tiktok, 'tiktokAllowance', s.tiktok_allowance,
  'tasksCompleted', s.tasks_completed, 'expenseAmount', s.expense_amount,
  'expenseNote', s.expense_note, 'cashRevenue', s.cash_revenue,
  'transferRevenue', s.transfer_revenue, 'closeReason', s.close_reason,
  'closeStatus', s.close_status, 'status', s.status
)`;

function activeShiftPeriodUnlockedSql() {
  return `${storePeriodUnlockedSql("s.store_id", activeShiftPeriod)} AND NOT EXISTS (
    SELECT 1 FROM business_records sharing_lock
    WHERE sharing_lock.category = 'DIVIDEND' AND sharing_lock.status = 'LOCKED'
      AND json_extract(sharing_lock.data_json, '$.period') = ${activeShiftPeriod}
  )`;
}

function json(data: unknown, status = 200) {
  return responseJson(data, status, {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie",
  });
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number }; changes?: number } | null)?.meta?.changes ?? 0);
}

function optional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function escapedLike(value: string) {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

async function requireSuperAdmin(request: Request) {
  const user = await getSessionUser(request);
  return user?.role === "MANAGER" && Number(user.isSuperAdmin) === 1 ? user : null;
}

function versionState(row: EmployeeAdminRow) {
  return {
    id: row.id,
    storeId: row.storeId,
    code: row.code,
    status: normalizedEmployeeStatus(row.status),
    lifecycleVersion: Number(row.lifecycleVersion ?? 0),
    username: row.username,
    statusUpdatedAt: row.statusUpdatedAt,
  };
}

async function withVersion(row: EmployeeAdminRow) {
  const status = normalizedEmployeeStatus(row.status);
  if (status === "ARCHIVED") throw new Error("EMPLOYEE_NOT_FOUND");
  return {
    ...row,
    status,
    statusLabel: employeeStatusLabel(status),
    hasLogin: Boolean(row.hasLogin),
    versionToken: await sha256(JSON.stringify(versionState(row))),
  };
}

async function loadEmployee(db: Database, storeId: string, employeeId: string) {
  return db.prepare(`SELECT
      e.id, e.store_id AS storeId, e.code, e.name, e.position, e.phone,
      e.province, e.ward, e.address_line AS addressLine, e.age,
      e.cccd_image_key AS cccdImageKey, e.cccd_image_name AS cccdImageName,
      e.hourly_rate AS hourlyRate, e.tiktok_allowance AS tiktokAllowance,
      e.status, e.inactive_at AS inactiveAt, e.status_updated_at AS statusUpdatedAt,
      COALESCE(e.lifecycle_version, 0) AS lifecycleVersion,
      (SELECT username FROM users WHERE employee_id = e.id ORDER BY id LIMIT 1) AS username,
      EXISTS(SELECT 1 FROM users WHERE employee_id = e.id) AS hasLogin,
      (SELECT COUNT(*) FROM shift_sessions s WHERE s.employee_id = e.id AND (s.status = 'ACTIVE' OR s.ended_at IS NULL)) AS activeShiftCount,
      (SELECT COUNT(*) FROM orders o WHERE o.employee_id = e.id) AS orderCount,
      (SELECT COUNT(*) FROM shift_sessions s WHERE s.employee_id = e.id) AS shiftCount,
      (SELECT COUNT(*) FROM employee_payroll_closings c WHERE c.employee_id = e.id) AS payrollClosingCount
    FROM employees e
    WHERE e.id = ? AND e.store_id = ? AND e.status != 'ARCHIVED' AND e.deleted_at IS NULL
    LIMIT 1`)
    .bind(employeeId, storeId)
    .first<EmployeeAdminRow>();
}

async function loadActiveShiftsForPurge(db: Database, employeeId: string) {
  return (await db.prepare(`SELECT
      s.id, s.shift_code AS shiftCode, s.store_id AS storeId, s.shift_name AS shiftName,
      s.scheduled_start AS scheduledStart, s.scheduled_end AS scheduledEnd,
      s.scheduled_start_at AS scheduledStartAt, s.scheduled_end_at AS scheduledEndAt,
      s.work_date AS workDate, s.started_at AS startedAt, s.ended_at AS endedAt,
      s.attendance_status AS attendanceStatus,
      s.attendance_delta_minutes AS attendanceDeltaMinutes,
      s.duration_seconds AS durationSeconds,
      s.cash_revenue AS cashRevenue, s.transfer_revenue AS transferRevenue,
      s.expense_amount AS expenseAmount, s.close_reason AS closeReason,
      s.close_status AS closeStatus,
      COALESCE((SELECT SUM(o.amount) FROM orders o
        WHERE o.store_id = s.store_id AND o.employee_id = s.employee_id
          AND o.shift_code = s.shift_code AND o.status = 'COMPLETED'
          AND o.payment_method = 'CASH'), 0) AS orderCashRevenue,
      COALESCE((SELECT SUM(o.amount) FROM orders o
        WHERE o.store_id = s.store_id AND o.employee_id = s.employee_id
          AND o.shift_code = s.shift_code AND o.status = 'COMPLETED'
          AND o.payment_method = 'BANK_TRANSFER'), 0) AS orderTransferRevenue,
      (SELECT COUNT(*) FROM orders o
        WHERE o.store_id = s.store_id AND o.employee_id = s.employee_id
          AND o.shift_code = s.shift_code AND o.status = 'COMPLETED'
          AND COALESCE(o.payment_method, '') NOT IN ('CASH', 'BANK_TRANSFER')) AS unknownTenderCount,
      st.revenue AS storeRevenue, st.expense AS storeExpense,
      ${activeShiftPeriod} AS period,
      CASE WHEN ${activeShiftPeriodUnlockedSql()} THEN 0 ELSE 1 END AS locked,
      ${activeShiftSnapshotJsonSql} AS shiftSnapshotCanonicalJson
    FROM shift_sessions s
    JOIN stores st ON st.id = s.store_id
    WHERE s.employee_id = ? AND s.status = 'ACTIVE' AND s.ended_at IS NULL
    ORDER BY s.started_at, s.id`)
    .bind(employeeId).all<ActiveShiftCloseRow>()).results;
}

function requireSafeMoney(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} không hợp lệ.`);
  return value;
}

function deriveActiveShiftClosures(rows: ActiveShiftCloseRow[], endedAt: string) {
  return rows.map<ActiveShiftClosure>((row) => {
    const legacyRange = !row.scheduledStartAt && row.workDate && row.scheduledStart && row.scheduledEnd
      ? shiftUtcRange(row.workDate, row.scheduledStart, row.scheduledEnd)
      : null;
    const computedScheduledStartAt = row.scheduledStartAt ?? legacyRange?.startAt ?? null;
    const computedScheduledEndAt = row.scheduledEndAt ?? legacyRange?.endAt ?? null;
    const computedAttendanceDeltaMinutes = computedScheduledStartAt
      ? attendanceDeltaMinutes(row.startedAt, computedScheduledStartAt)
      : null;
    const computedAttendanceStatus = computedScheduledStartAt
      ? attendanceStatusAt(row.startedAt, computedScheduledStartAt)
      : null;
    requireSafeMoney(Number(row.cashRevenue), "Doanh thu tiền mặt đã lưu");
    requireSafeMoney(Number(row.transferRevenue), "Doanh thu chuyển khoản đã lưu");
    requireSafeMoney(Number(row.orderCashRevenue), "Doanh thu tiền mặt từ đơn hàng");
    requireSafeMoney(Number(row.orderTransferRevenue), "Doanh thu chuyển khoản từ đơn hàng");
    requireSafeMoney(Number(row.expenseAmount), "Chi phí trong ca");
    return {
      ...row,
      computedScheduledStartAt,
      computedScheduledEndAt,
      computedDurationSeconds: durationSeconds(row.startedAt, endedAt),
      computedAttendanceStatus,
      computedAttendanceDeltaMinutes,
      closeToken: `EMPLOYEE_PURGE:${crypto.randomUUID()}`,
      auditId: crypto.randomUUID(),
    };
  });
}

function summarizeStoresForClose(rows: ActiveShiftClosure[]) {
  const summaries = new Map<string, StoreCloseSummary>();
  for (const row of rows) {
    const existing = summaries.get(row.storeId);
    if (existing && (existing.revenue !== Number(row.storeRevenue) || existing.expense !== Number(row.storeExpense))) {
      throw new Error("Số liệu cửa hàng đã thay đổi trong lúc đối soát ca.");
    }
    const summary = existing ?? {
      storeId: row.storeId,
      revenue: requireSafeMoney(Number(row.storeRevenue), "Doanh thu cửa hàng"),
      expense: requireSafeMoney(Number(row.storeExpense), "Chi phí cửa hàng"),
      revenueDelta: 0,
    };
    summary.revenueDelta += Number(row.orderCashRevenue) + Number(row.orderTransferRevenue)
      - Number(row.cashRevenue) - Number(row.transferRevenue);
    if (!Number.isSafeInteger(summary.revenueDelta)
      || !Number.isSafeInteger(summary.revenue + summary.revenueDelta)
      || summary.revenue + summary.revenueDelta < 0) {
      throw new Error("Đối soát doanh thu ca sẽ làm doanh thu cửa hàng âm hoặc vượt giới hạn.");
    }
    summaries.set(row.storeId, summary);
  }
  return [...summaries.values()];
}

function activeShiftArchiveGate(rows: ActiveShiftClosure[], stores: StoreCloseSummary[]) {
  const clauses = [
    `(SELECT COUNT(*) FROM shift_sessions active_shift
      WHERE active_shift.employee_id = e.id AND active_shift.status = 'ACTIVE'
        AND active_shift.ended_at IS NULL) = ?`,
  ];
  const bindings: unknown[] = [rows.length];
  for (const row of rows) {
    clauses.push(`EXISTS (
      SELECT 1 FROM shift_sessions s
      WHERE s.id = ? AND s.employee_id = e.id AND s.store_id = ?
        AND s.status = 'ACTIVE' AND s.ended_at IS NULL
        AND ${activeShiftSnapshotJsonSql} = ?
        AND COALESCE((SELECT SUM(cash_order.amount) FROM orders cash_order
          WHERE cash_order.store_id = s.store_id AND cash_order.employee_id = s.employee_id
            AND cash_order.shift_code = s.shift_code AND cash_order.status = 'COMPLETED'
            AND cash_order.payment_method = 'CASH'), 0) = ?
        AND COALESCE((SELECT SUM(transfer_order.amount) FROM orders transfer_order
          WHERE transfer_order.store_id = s.store_id AND transfer_order.employee_id = s.employee_id
            AND transfer_order.shift_code = s.shift_code AND transfer_order.status = 'COMPLETED'
            AND transfer_order.payment_method = 'BANK_TRANSFER'), 0) = ?
        AND NOT EXISTS (SELECT 1 FROM orders unknown_tender
          WHERE unknown_tender.store_id = s.store_id AND unknown_tender.employee_id = s.employee_id
            AND unknown_tender.shift_code = s.shift_code AND unknown_tender.status = 'COMPLETED'
            AND COALESCE(unknown_tender.payment_method, '') NOT IN ('CASH', 'BANK_TRANSFER'))
        AND ${activeShiftPeriodUnlockedSql()}
    )`);
    bindings.push(
      row.id, row.storeId, row.shiftSnapshotCanonicalJson,
      row.orderCashRevenue, row.orderTransferRevenue,
    );
  }
  for (const store of stores) {
    clauses.push(`EXISTS (SELECT 1 FROM stores purge_store
      WHERE purge_store.id = ? AND purge_store.revenue = ? AND purge_store.expense = ?
        AND purge_store.revenue + ? >= 0)`);
    bindings.push(store.storeId, store.revenue, store.expense, store.revenueDelta);
  }
  return { sql: clauses.join(" AND "), bindings };
}

export async function GET(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được xem danh sách này." }, 403);
  const url = new URL(request.url);
  const storeId = optional(url.searchParams.get("storeId"));
  if (!storeId) return json({ message: "Thiếu cửa hàng cần xem nhân viên." }, 400);
  const page = positiveInteger(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInteger(url.searchParams.get("pageSize"), 20, MAX_PAGE_SIZE);
  const search = optional(url.searchParams.get("search"));
  const db = await initDb();
  const store = await db.prepare("SELECT id, name, status FROM stores WHERE id = ? LIMIT 1")
    .bind(storeId).first<{ id: string; name: string; status: string }>();
  if (!store) return json({ message: "Không tìm thấy cửa hàng." }, 404);

  const clauses = ["e.store_id = ?", "e.status != 'ARCHIVED'", "e.deleted_at IS NULL"];
  const bindings: unknown[] = [storeId];
  if (search) {
    const needle = escapedLike(search);
    clauses.push(`(e.code LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\'
      OR e.phone LIKE ? ESCAPE '\\' OR COALESCE((SELECT username FROM users WHERE employee_id = e.id LIMIT 1), '') LIKE ? ESCAPE '\\')`);
    bindings.push(needle, needle, needle, needle);
  }
  const where = clauses.join(" AND ");
  const [countResult, rowsResult] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS count FROM employees e WHERE ${where}`).bind(...bindings),
    db.prepare(`SELECT
        e.id, e.store_id AS storeId, e.code, e.name, e.position, e.phone,
        e.province, e.ward, e.address_line AS addressLine, e.age,
        e.cccd_image_key AS cccdImageKey, e.cccd_image_name AS cccdImageName,
        e.hourly_rate AS hourlyRate, e.tiktok_allowance AS tiktokAllowance,
        e.status, e.inactive_at AS inactiveAt, e.status_updated_at AS statusUpdatedAt,
        COALESCE(e.lifecycle_version, 0) AS lifecycleVersion,
        (SELECT username FROM users WHERE employee_id = e.id ORDER BY id LIMIT 1) AS username,
        EXISTS(SELECT 1 FROM users WHERE employee_id = e.id) AS hasLogin,
        (SELECT COUNT(*) FROM shift_sessions s WHERE s.employee_id = e.id AND (s.status = 'ACTIVE' OR s.ended_at IS NULL)) AS activeShiftCount,
        (SELECT COUNT(*) FROM orders o WHERE o.employee_id = e.id) AS orderCount,
        (SELECT COUNT(*) FROM shift_sessions s WHERE s.employee_id = e.id) AS shiftCount,
        (SELECT COUNT(*) FROM employee_payroll_closings c WHERE c.employee_id = e.id) AS payrollClosingCount
      FROM employees e
      WHERE ${where}
      ORDER BY CASE e.status WHEN 'ACTIVE' THEN 0 WHEN 'SUSPENDED' THEN 1 ELSE 2 END, e.name, e.code
      LIMIT ? OFFSET ?`)
      .bind(...bindings, pageSize, (page - 1) * pageSize),
  ]);
  const total = Number((countResult.results[0] as { count?: number } | undefined)?.count ?? 0);
  const rows = await Promise.all((rowsResult.results as EmployeeAdminRow[]).map(withVersion));
  return json({
    store,
    rows,
    pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}

export async function PATCH(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được đổi trạng thái nhân viên." }, 403);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const storeId = optional(body.storeId);
  const id = optional(body.id);
  const versionToken = optional(body.versionToken);
  const reason = optional(body.reason);
  if (!storeId || !id || !versionToken || !isEmployeeStatus(body.status)) {
    return json({ message: "Thiếu dữ liệu xác nhận trạng thái nhân viên." }, 400);
  }
  if (!reason || reason.length < 3 || reason.length > 500) {
    return json({ message: "Vui lòng nhập lý do thay đổi từ 3 đến 500 ký tự." }, 400);
  }
  const db = await initDb();
  const existing = await loadEmployee(db, storeId, id);
  if (!existing) return json({ message: "Không tìm thấy nhân viên trong cửa hàng." }, 404);
  const currentStatus = normalizedEmployeeStatus(existing.status);
  if (currentStatus === body.status) {
    return json({
      message: `Nhân viên hiện đã ở trạng thái ${employeeStatusLabel(body.status)}.`,
      row: await withVersion(existing),
    });
  }
  if (await sha256(JSON.stringify(versionState(existing))) !== versionToken) {
    return json({ message: "Hồ sơ nhân viên đã thay đổi. Vui lòng tải lại danh sách." }, 409);
  }
  try {
    await transitionEmployeeStatus({
      db,
      actorUserId: user.id,
      employeeId: id,
      storeId,
      status: body.status,
      expectedVersion: Number(existing.lifecycleVersion ?? 0),
      reason,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "EMPLOYEE_SHIFT_PERIOD_LOCKED") {
      return json({ message: "Kỳ lương/KPI hoặc kỳ chia lợi nhuận của ca đang làm đã khóa. Không thể đổi trạng thái nhân viên." }, 423);
    }
    if (error instanceof Error && ["EMPLOYEE_SHIFT_UNKNOWN_TENDER", "EMPLOYEE_SHIFT_FINANCE_INVARIANT"].includes(error.message)) {
      return json({ message: "Không thể đổi trạng thái vì số liệu doanh thu ca đang làm chưa hợp lệ. Vui lòng đối soát đơn hàng." }, 409);
    }
    if (error instanceof Error && error.message === "EMPLOYEE_ACTIVE_SHIFT") {
      return json({ message: "Nhân viên đang có ca làm việc chưa kết. Hãy kết ca hoặc dùng thao tác xóa của quản trị cấp cao để hệ thống chốt ca an toàn." }, 409);
    }
    if (error instanceof Error && error.message === "EMPLOYEE_VERSION_CONFLICT") {
      return json({ message: "Hồ sơ nhân viên vừa được cập nhật. Vui lòng tải lại danh sách." }, 409);
    }
    throw error;
  }
  const updated = await loadEmployee(db, storeId, id);
  if (!updated) return json({ message: "Không thể tải lại hồ sơ vừa cập nhật." }, 500);
  return json({
    message: body.status === "ACTIVE"
      ? "Đã chuyển sang đang làm việc; nhân viên có thể đăng nhập lại."
      : `Đã chuyển sang ${employeeStatusLabel(body.status).toLocaleLowerCase("vi-VN")} và thu hồi toàn bộ phiên đăng nhập.`,
    row: await withVersion(updated),
  });
}

export async function DELETE(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được xóa nhân viên." }, 403);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const storeId = optional(body.storeId);
  const id = optional(body.id);
  const versionToken = optional(body.versionToken);
  const reason = optional(body.reason);
  const confirmation = optional(body.confirmation);
  if (!storeId || !id || !versionToken) return json({ message: "Thiếu dữ liệu xác nhận nhân viên cần xóa." }, 400);
  if (!reason || reason.length < 3 || reason.length > 500) {
    return json({ message: "Vui lòng nhập lý do xóa từ 3 đến 500 ký tự." }, 400);
  }
  const db = await initDb();
  const existing = await loadEmployee(db, storeId, id);
  if (!existing) return json({ message: "Nhân viên đã được xóa hoặc không tồn tại trong cửa hàng." }, 404);
  if (!confirmation || confirmation.toLocaleUpperCase("vi-VN") !== existing.code.toLocaleUpperCase("vi-VN")) {
    return json({ message: `Nhập đúng mã nhân viên ${existing.code} để xác nhận xóa.` }, 400);
  }
  if (await sha256(JSON.stringify(versionState(existing))) !== versionToken) {
    return json({ message: "Hồ sơ nhân viên đã thay đổi. Vui lòng tải lại danh sách." }, 409);
  }

  const now = new Date().toISOString();
  const activeRows = await loadActiveShiftsForPurge(db, id);
  if (activeRows.some((row) => Number(row.locked) === 1)) {
    return json({
      message: "Kỳ lương/KPI hoặc kỳ chia lợi nhuận của ca đang làm đã khóa. Không thể xóa nhân viên cho đến khi kỳ được mở lại.",
      lockedPeriods: [...new Set(activeRows.filter((row) => Number(row.locked) === 1).map((row) => row.period))],
    }, 423);
  }
  if (activeRows.some((row) => Number(row.unknownTenderCount) > 0)) {
    return json({ message: "Ca đang làm có đơn hàng với hình thức thanh toán không hợp lệ. Cần đối soát đơn trước khi xóa nhân viên." }, 409);
  }
  let activeClosures: ActiveShiftClosure[];
  let storeClosures: StoreCloseSummary[];
  try {
    activeClosures = deriveActiveShiftClosures(activeRows, now);
    storeClosures = summarizeStoresForClose(activeClosures);
  } catch (error) {
    return json({
      message: error instanceof Error ? error.message : "Không thể đối soát ca đang làm.",
    }, 409);
  }
  const archiveGate = activeShiftArchiveGate(activeClosures, storeClosures);
  const archiveId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const historyId = crypto.randomUUID();
  const tombstoneCode = `DEL-${existing.id.replaceAll("-", "").toUpperCase()}`;
  const nextVersion = Number(existing.lifecycleVersion ?? 0) + 1;
  const gate = `EXISTS (SELECT 1 FROM admin_reset_archives gate WHERE gate.id = '${archiveId.replaceAll("'", "''")}')`;
  const summaryJson = JSON.stringify({
    orderCount: existing.orderCount,
    shiftCount: existing.shiftCount,
    payrollClosingCount: existing.payrollClosingCount,
    activeShiftCount: existing.activeShiftCount,
  });
  const snapshotJson = JSON.stringify({
    schemaVersion: 3,
    employeeId: existing.id,
    storeId,
    lifecycleVersion: existing.lifecycleVersion,
    tombstone: {
      employeeId: existing.id,
      code: tombstoneCode,
      lifecycleVersion: nextVersion,
    },
    reasonCategory: PURGE_REASON_CATEGORY,
    piiRetainedInLiveProfile: false,
    historicalFinancialSnapshotsRetained: true,
    activeShiftClosures: activeClosures.map((row) => ({
      before: JSON.parse(row.shiftSnapshotCanonicalJson) as Record<string, unknown>,
      orderTruth: {
        cashRevenue: Number(row.orderCashRevenue),
        transferRevenue: Number(row.orderTransferRevenue),
      },
      storeBefore: { revenue: Number(row.storeRevenue), expense: Number(row.storeExpense) },
      after: {
        endedAt: now,
        durationSeconds: row.computedDurationSeconds,
        attendanceStatus: row.computedAttendanceStatus,
        attendanceDeltaMinutes: row.computedAttendanceDeltaMinutes,
        cashRevenue: Number(row.orderCashRevenue),
        transferRevenue: Number(row.orderTransferRevenue),
        closeReason: "SUPER_ADMIN_EMPLOYEE_PURGE",
        closeStatus: "CONFIRMED",
        status: "COMPLETED",
      },
    })),
  });

  const closeStatements = activeClosures.map((row) => db.prepare(`UPDATE shift_sessions SET
      scheduled_start_at = COALESCE(scheduled_start_at, ?),
      scheduled_end_at = COALESCE(scheduled_end_at, ?),
      ended_at = ?, duration_seconds = ?, admin_adjusted_duration_seconds = NULL,
      attendance_status = ?, attendance_delta_minutes = ?,
      cash_revenue = ?, transfer_revenue = ?,
      close_reason = 'SUPER_ADMIN_EMPLOYEE_PURGE', close_status = ?, status = 'COMPLETED'
    WHERE id = ? AND employee_id = ? AND store_id = ?
      AND status = 'ACTIVE' AND ended_at IS NULL AND ${gate}`)
    .bind(
      row.computedScheduledStartAt, row.computedScheduledEndAt,
      now, row.computedDurationSeconds,
      row.computedAttendanceStatus, row.computedAttendanceDeltaMinutes,
      row.orderCashRevenue, row.orderTransferRevenue,
      row.closeToken, row.id, id, row.storeId,
    ));
  const storeCloseStatements = storeClosures.map((store) => db.prepare(`UPDATE stores SET revenue = revenue + ?
    WHERE id = ? AND revenue = ? AND expense = ? AND revenue + ? >= 0 AND ${gate}`)
    .bind(store.revenueDelta, store.storeId, store.revenue, store.expense, store.revenueDelta));
  const closeAuditStatements = activeClosures.flatMap((row) => {
    const before = JSON.parse(row.shiftSnapshotCanonicalJson) as Record<string, unknown>;
    return [
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, action, entity_type, entity_id, detail, created_at)
        SELECT ?, ?, 'SUPER_ADMIN_EMPLOYEE_PURGE_SHIFT_CLOSE', 'SHIFT_SESSION', id, ?, ?
        FROM shift_sessions
        WHERE id = ? AND employee_id = ? AND status = 'COMPLETED'
          AND close_reason = 'SUPER_ADMIN_EMPLOYEE_PURGE' AND close_status = ? AND ${gate}`)
        .bind(row.auditId, user.id, JSON.stringify({
          archiveId,
          employeeId: id,
          reasonCategory: PURGE_REASON_CATEGORY,
          before,
          after: {
            endedAt: now,
            durationSeconds: row.computedDurationSeconds,
            attendanceStatus: row.computedAttendanceStatus,
            attendanceDeltaMinutes: row.computedAttendanceDeltaMinutes,
            cashRevenue: Number(row.orderCashRevenue),
            transferRevenue: Number(row.orderTransferRevenue),
            closeReason: "SUPER_ADMIN_EMPLOYEE_PURGE",
          },
        }), now, row.id, id, row.closeToken),
      db.prepare(`UPDATE shift_sessions SET close_status = 'CONFIRMED'
        WHERE id = ? AND employee_id = ? AND status = 'COMPLETED'
          AND close_reason = 'SUPER_ADMIN_EMPLOYEE_PURGE' AND close_status = ? AND ${gate}`)
        .bind(row.id, id, row.closeToken),
    ];
  });
  const freezeResultIndex = 1 + closeStatements.length + storeCloseStatements.length + closeAuditStatements.length;
  const employeeMutationIndex = freezeResultIndex + 1;

  const results = await db.batch([
    db.prepare(`INSERT INTO admin_reset_archives
        (id, store_id, actor_user_id, kind, filter_json, summary_json, snapshot_json, created_at)
      SELECT ?, e.store_id, ?, 'EMPLOYEE_PURGE', ?, ?, ?, ?
      FROM employees e
      WHERE e.id = ? AND e.store_id = ? AND e.status != 'ARCHIVED' AND e.deleted_at IS NULL
        AND COALESCE(e.lifecycle_version, 0) = ? AND ${archiveGate.sql}`)
      .bind(
        archiveId,
        user.id,
        JSON.stringify({ employeeId: existing.id }),
        summaryJson,
        snapshotJson,
        now,
        id,
        storeId,
        existing.lifecycleVersion,
        ...archiveGate.bindings,
      ),
    ...closeStatements,
    ...storeCloseStatements,
    ...closeAuditStatements,
    // Freeze legacy shifts before removing the live pay configuration. This
    // preserves every historical payroll calculation without retaining PII.
    db.prepare(`UPDATE shift_sessions SET
        applied_hourly_rate = COALESCE(applied_hourly_rate, ?),
        applied_tiktok_allowance = COALESCE(applied_tiktok_allowance, ?)
      WHERE employee_id = ? AND ${gate}`)
      .bind(existing.hourlyRate, existing.tiktokAllowance, id),
    db.prepare(`UPDATE employees SET
        code = ?, name = 'Nhân viên đã xóa', position = 'Đã xóa', phone = '',
        province = '', ward = '', address_line = '', age = NULL,
        cccd_image_key = NULL, cccd_image_name = NULL,
        hourly_rate = 0, tiktok_allowance = 0,
        status = 'ARCHIVED', inactive_at = COALESCE(inactive_at, ?),
        status_updated_at = ?, deleted_at = ?, deleted_by = ?,
        lifecycle_version = lifecycle_version + 1
      WHERE id = ? AND store_id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
        AND lifecycle_version = ? AND ${gate}
        AND NOT EXISTS (SELECT 1 FROM shift_sessions active_shift
          WHERE active_shift.employee_id = employees.id AND active_shift.status = 'ACTIVE'
            AND active_shift.ended_at IS NULL)`)
      .bind(tombstoneCode, now, now, now, user.id, id, storeId, existing.lifecycleVersion),
    // Attendance coordinates are not part of financial history. Remove them
    // from every historical session in the same atomic purge while keeping
    // all timestamps, durations, pay snapshots, revenue and expenses intact.
    db.prepare(`UPDATE shift_sessions SET
        clock_in_latitude = NULL,
        clock_in_longitude = NULL,
        clock_in_accuracy_meters = NULL,
        clock_in_location_captured_at = NULL
      WHERE employee_id = ? AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(id, id, now),
    ...(existing.cccdImageKey ? [enqueuePurgedCccdDeletionStatement(db, {
      key: existing.cccdImageKey,
      employeeId: id,
      storeId,
      requestedBy: user.id,
      reason: "SUPER_ADMIN_EMPLOYEE_PURGE",
      deletedAt: now,
    }), ...retireCccdUploadStatements(db, {
      key: existing.cccdImageKey,
      requestedAt: now,
    })] : []),
    db.prepare(`UPDATE business_records SET owner_id = NULL,
        title = replace(replace(replace(title, ?, 'Nhân viên đã xóa'), ?, ?), ?, '')
      WHERE owner_id IN (SELECT id FROM users WHERE employee_id = ?) AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(existing.name, existing.code, tombstoneCode, existing.phone, id, id, now),
    // Redact live JSON identity values wherever the stable employee id is
    // referenced (including employeeIds/employeeNames schedule arrays). Money
    // and every other operational field remain unchanged.
    db.prepare(`UPDATE business_records SET data_json =
        replace(replace(replace(data_json,
          json_quote(?), json_quote('Nhân viên đã xóa')),
          json_quote(?), json_quote(?)),
          json_quote(?), json_quote(''))
      WHERE json_valid(data_json) AND instr(data_json, json_quote(?)) > 0 AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(existing.name, existing.code, tombstoneCode, existing.phone, id, id, now),
    // Payroll and reset snapshots retain immutable money, totals and the
    // stable employee id, but no longer retain the deleted person's direct
    // identity. This is a targeted pseudonymisation, never a history delete.
    db.prepare(`UPDATE employee_payroll_closings SET snapshot_json =
        replace(replace(replace(snapshot_json,
          json_quote(?), json_quote('Nhân viên đã xóa')),
          json_quote(?), json_quote(?)),
          json_quote(?), json_quote(''))
      WHERE employee_id = ? AND json_valid(snapshot_json) AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(existing.name, existing.code, tombstoneCode, existing.phone, id, id, now),
    db.prepare(`UPDATE admin_reset_archives SET
        filter_json = CASE WHEN json_valid(filter_json) THEN
          replace(replace(replace(filter_json,
            json_quote(?), json_quote('Nhân viên đã xóa')),
            json_quote(?), json_quote(?)),
            json_quote(?), json_quote('')) ELSE filter_json END,
        summary_json = CASE WHEN json_valid(summary_json) THEN
          replace(replace(replace(summary_json,
            json_quote(?), json_quote('Nhân viên đã xóa')),
            json_quote(?), json_quote(?)),
            json_quote(?), json_quote('')) ELSE summary_json END,
        snapshot_json = CASE WHEN json_valid(snapshot_json) THEN
          replace(replace(replace(snapshot_json,
            json_quote(?), json_quote('Nhân viên đã xóa')),
            json_quote(?), json_quote(?)),
            json_quote(?), json_quote('')) ELSE snapshot_json END
      WHERE (instr(filter_json, json_quote(?)) > 0
          OR instr(summary_json, json_quote(?)) > 0
          OR instr(snapshot_json, json_quote(?)) > 0)
        AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(
        existing.name, existing.code, tombstoneCode, existing.phone,
        existing.name, existing.code, tombstoneCode, existing.phone,
        existing.name, existing.code, tombstoneCode, existing.phone,
        id, id, id, id, now,
      ),
    // Audit history remains append-only. Direct actor identity is detached or
    // redacted while stable entity ids preserve reconciliation traceability.
    db.prepare(`UPDATE audit_logs SET user_id = NULL,
        detail = CASE WHEN detail IS NULL THEN NULL ELSE '{"redacted":true,"reason":"EMPLOYEE_PURGED"}' END
      WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?) AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(id, id, now),
    db.prepare(`UPDATE audit_logs SET
        detail = CASE WHEN detail IS NULL THEN NULL ELSE '{"redacted":true,"reason":"EMPLOYEE_PURGED"}' END
      WHERE entity_type = 'EMPLOYEE' AND entity_id = ? AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(id, id, now),
    db.prepare(`UPDATE employee_transfers SET
        status = CASE WHEN status IN ('SCHEDULED', 'ACTIVE') THEN 'CANCELLED' ELSE status END,
        updated_at = ?,
        ended_at = CASE WHEN status IN ('SCHEDULED', 'ACTIVE') THEN COALESCE(ended_at, ?) ELSE ended_at END,
        reason = replace(replace(replace(reason, ?, 'Nhân viên đã xóa'), ?, ?), ?, ''),
        shifts_json = CASE WHEN json_valid(shifts_json) THEN
          replace(replace(replace(shifts_json,
            json_quote(?), json_quote('Nhân viên đã xóa')),
            json_quote(?), json_quote(?)),
            json_quote(?), json_quote('')) ELSE shifts_json END
      WHERE employee_id = ? AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(
        now, now, existing.name, existing.code, tombstoneCode, existing.phone,
        existing.name, existing.code, tombstoneCode, existing.phone,
        id, id, now,
      ),
    // Manager notifications are part of the order audit trail. Preserve each
    // notification's recipient, read state and order link, while removing any
    // employee identity copied into its display text or structured payload.
    db.prepare(`UPDATE notifications SET
        title = replace(replace(replace(title, ?, 'Nhân viên đã xóa'), ?, ?), ?, ''),
        message = replace(replace(replace(message, ?, 'Nhân viên đã xóa'), ?, ?), ?, ''),
        data_json = CASE WHEN json_valid(data_json) THEN
          replace(replace(replace(data_json,
            json_quote(?), json_quote('Nhân viên đã xóa')),
            json_quote(?), json_quote(?)),
            json_quote(?), json_quote('')) ELSE data_json END
      WHERE entity_type = 'ORDER'
        AND entity_id IN (SELECT order_row.id FROM orders order_row WHERE order_row.employee_id = ?)
        AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(
        existing.name, existing.code, tombstoneCode, existing.phone,
        existing.name, existing.code, tombstoneCode, existing.phone,
        existing.name, existing.code, tombstoneCode, existing.phone,
        id, id, now,
      ),
    db.prepare(`DELETE FROM sessions
      WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?) AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(id, id, now),
    db.prepare(`DELETE FROM notifications
      WHERE recipient_user_id IN (SELECT id FROM users WHERE employee_id = ?) AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(id, id, now),
    db.prepare(`DELETE FROM users WHERE employee_id = ? AND ${gate}
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ARCHIVED' AND deleted_at = ?)`)
      .bind(id, id, now),
    db.prepare(`INSERT INTO employee_status_history
        (id, employee_id, store_id, from_status, to_status, effective_at, actor_user_id, reason, created_at)
      SELECT ?, id, store_id, ?, 'ARCHIVED', ?, ?, ?, ? FROM employees
      WHERE id = ? AND store_id = ? AND status = 'ARCHIVED' AND deleted_at = ? AND lifecycle_version = ?`)
      .bind(historyId, normalizedEmployeeStatus(existing.status), now, user.id, PURGE_REASON_CATEGORY, now, id, storeId, now, nextVersion),
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, 'SUPER_ADMIN_EMPLOYEE_PURGE', 'EMPLOYEE', id, ?, ? FROM employees
      WHERE id = ? AND store_id = ? AND status = 'ARCHIVED' AND deleted_at = ? AND lifecycle_version = ?`)
      .bind(auditId, user.id, JSON.stringify({
        storeId,
        archiveId,
        employeeId: id,
        tombstoneCode,
        lifecycleVersion: nextVersion,
        reasonCategory: PURGE_REASON_CATEGORY,
      }), now, id, storeId, now, nextVersion),
  ]);

  if (affectedRows(results[0]) !== 1 || affectedRows(results[employeeMutationIndex]) !== 1
    || closeStatements.some((_, index) => affectedRows(results[1 + index]) !== 1)
    || storeCloseStatements.some((_, index) => affectedRows(results[1 + closeStatements.length + index]) !== 1)) {
    const currentActive = await loadActiveShiftsForPurge(db, id);
    const lockedPeriods = [...new Set(currentActive
      .filter((row) => Number(row.locked) === 1)
      .map((row) => row.period))];
    if (lockedPeriods.length > 0) {
      return json({
        message: "Kỳ lương/KPI hoặc kỳ chia lợi nhuận của ca đang làm vừa được khóa. Không thể xóa nhân viên.",
        lockedPeriods,
      }, 423);
    }
    return json({ message: "Hồ sơ nhân viên vừa thay đổi. Vui lòng tải lại danh sách." }, 409);
  }
  const durableCccdCleanup = existing.cccdImageKey
    ? await processCccdDeletionOutbox({ key: existing.cccdImageKey, limit: 1 })
      .catch(() => ({ deleted: 0, pending: 1 }))
    : { deleted: 0, pending: 0 };
  const uploadWarning = durableCccdCleanup.pending > 0
    ? "Hồ sơ đã được xóa và ảnh không còn truy cập được; kho ảnh sẽ được dọn tự động ở lần thử lại tiếp theo."
    : null;
  const activeShiftReviews: never[] = [];
  const attendanceWarning = activeShiftReviews.length > 0
    ? `Nhân viên còn ${activeShiftReviews.length} ca chưa kết. Ca và doanh thu được giữ nguyên; quản trị cấp cao cần rà soát giờ kết ca trong mục Chấm công.`
    : null;
  return json({
    message: "Đã xóa tài khoản và ẩn danh thông tin nhận dạng trong hồ sơ vận hành, bảng lương và bản chụp lịch sử. Số liệu tài chính cùng mã liên kết ổn định vẫn được giữ nguyên để đối soát.",
    archiveId,
    deletedId: id,
    warning: [attendanceWarning, uploadWarning].filter(Boolean).join(" ") || null,
    attendanceReview: activeShiftReviews,
    closedAttendance: activeClosures.map((row) => ({
      id: row.id,
      shiftCode: row.shiftCode,
      shiftName: row.shiftName,
      storeId: row.storeId,
      startedAt: row.startedAt,
      endedAt: now,
      durationSeconds: row.computedDurationSeconds,
      attendanceStatus: row.computedAttendanceStatus,
      attendanceDeltaMinutes: row.computedAttendanceDeltaMinutes,
      cashRevenue: Number(row.orderCashRevenue),
      transferRevenue: Number(row.orderTransferRevenue),
      expenseAmount: Number(row.expenseAmount),
    })),
  });
}
