import { initDb } from "../../../db/runtime";
import { dateRangeBoundsUtc, periodBoundsUtc, shiftAccountingDate } from "../../lib/finance";
import { attendancePolicyPayload } from "../../lib/attendance-policy";
import {
  buildMonthlyAttendanceStats,
  buildRevenueBreakdowns,
  completedShiftDateRange,
  resolveAttendanceObservation,
  summarizeCompletedShiftMoney,
  type StoreCashflowMode,
} from "../../lib/store-cashflow";
import { getSessionUser, json } from "../_lib/auth";
import { MANAGER_STORE_SCOPE_MESSAGE, resolveManagerStoreScope } from "../_lib/manager-scope";
import { storeDateRangeFinance } from "../_lib/store-finance";
import { loadAttendancePolicy } from "../_lib/attendance-policy";

type StoreRow = {
  id: string;
  name: string;
  status: string;
};

type CompletedShiftRow = {
  id: string;
  shiftCode: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  workDate: string | null;
  startedAt: string;
  endedAt: string;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  cashRevenue: number;
  transferRevenue: number;
  expenseAmount: number;
  expenseNote: string | null;
  attendanceStatus: string | null;
  attendanceDeltaMinutes: number | null;
  attendanceGraceMinutes: number;
};

type AttendanceRow = {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  startedAt: string;
  scheduledStartAt: string | null;
  attendanceStatus: string | null;
  attendanceDeltaMinutes: number | null;
  attendanceGraceMinutes: number;
};

const modes = new Set<StoreCashflowMode>(["day", "week", "month"]);

function safeStoredVnd(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

async function completedShiftsInBounds(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  bounds: ReturnType<typeof dateRangeBoundsUtc>,
) {
  const result = await db.prepare(`
    SELECT
      s.id,
      s.shift_code AS shiftCode,
      s.shift_name AS shiftName,
      s.scheduled_start AS scheduledStart,
      s.scheduled_end AS scheduledEnd,
      s.scheduled_start_at AS scheduledStartAt,
      s.scheduled_end_at AS scheduledEndAt,
      s.work_date AS workDate,
      s.started_at AS startedAt,
      s.ended_at AS endedAt,
      s.employee_id AS employeeId,
      e.code AS employeeCode,
      e.name AS employeeName,
      COALESCE(s.cash_revenue, 0) AS cashRevenue,
      COALESCE(s.transfer_revenue, 0) AS transferRevenue,
      COALESCE(s.expense_amount, 0) AS expenseAmount,
      s.expense_note AS expenseNote,
      s.attendance_status AS attendanceStatus,
      s.attendance_delta_minutes AS attendanceDeltaMinutes,
      s.attendance_grace_minutes AS attendanceGraceMinutes
    FROM shift_sessions s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.store_id = ?
      AND s.status = 'COMPLETED'
      AND s.ended_at IS NOT NULL
      AND (
        (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
        OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
      )
    ORDER BY s.ended_at DESC, s.id DESC
  `).bind(
    storeId,
    bounds.localStart,
    bounds.localEnd,
    bounds.startUtc,
    bounds.endUtc,
  ).all<CompletedShiftRow>();

  return result.results.map((row) => {
    const cashRevenue = safeStoredVnd(row.cashRevenue);
    const transferRevenue = safeStoredVnd(row.transferRevenue);
    const expenseAmount = safeStoredVnd(row.expenseAmount);
    const attendance = resolveAttendanceObservation(row);
    return {
      id: row.id,
      shiftCode: row.shiftCode,
      shiftName: row.shiftName,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      scheduledStartAt: row.scheduledStartAt,
      scheduledEndAt: row.scheduledEndAt,
      workDate: shiftAccountingDate(row.workDate, row.startedAt),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      cashRevenue,
      transferRevenue,
      revenue: cashRevenue + transferRevenue,
      expenseAmount,
      expenseNote: row.expenseNote,
      attendanceStatus: attendance.status,
      attendanceDeltaMinutes: attendance.deltaMinutes,
      attendanceGraceMinutes: row.attendanceGraceMinutes,
    };
  });
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") {
    return json({ message: "Không có quyền xem dòng tiền cửa hàng." }, 403);
  }

  const params = new URL(request.url).searchParams;
  const scope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = scope.storeId ?? "";
  const requestedMode = params.get("mode") ?? "month";
  const anchor = params.get("anchor")?.trim() ?? "";
  if (!storeId) return json({ message: "Vui lòng chọn cửa hàng." }, 400);
  if (!modes.has(requestedMode as StoreCashflowMode)) {
    return json({ message: "Kiểu lọc dòng tiền không hợp lệ." }, 400);
  }

  const mode = requestedMode as StoreCashflowMode;
  let range: { from: string; to: string };
  try {
    range = completedShiftDateRange(mode, anchor);
  } catch (cause) {
    return json({ message: cause instanceof Error ? cause.message : "Khoảng dòng tiền không hợp lệ." }, 400);
  }

  const db = await initDb();
  const store = await db.prepare(`
    SELECT id, name, status FROM stores
    WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE')
    LIMIT 1
  `).bind(storeId).first<StoreRow>();
  if (!store) return json({ message: "Cửa hàng không tồn tại." }, 404);

  const currentPolicy = await loadAttendancePolicy(db);
  const bounds = dateRangeBoundsUtc(range);
  const attendancePeriod = (mode === "month" ? anchor : anchor.slice(0, 7)).slice(0, 7);
  const attendanceBounds = periodBoundsUtc(attendancePeriod);
  const reportYear = Number(attendancePeriod.slice(0, 4));
  const yearRange = { from: `${reportYear}-01-01`, to: `${reportYear}-12-31` };
  const yearBounds = dateRangeBoundsUtc(yearRange);
  const [shifts, yearShifts, attendanceResult, accounting] = await Promise.all([
    completedShiftsInBounds(db, storeId, bounds),
    completedShiftsInBounds(db, storeId, yearBounds),
    db.prepare(`SELECT
        s.employee_id AS employeeId,
        e.code AS employeeCode,
        e.name AS employeeName,
        s.started_at AS startedAt,
        s.scheduled_start_at AS scheduledStartAt,
        s.attendance_status AS attendanceStatus,
        s.attendance_delta_minutes AS attendanceDeltaMinutes,
        s.attendance_grace_minutes AS attendanceGraceMinutes
      FROM shift_sessions s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.store_id = ? AND s.status IN ('ACTIVE', 'COMPLETED')
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
          OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
        )
      ORDER BY s.started_at, s.id`)
      .bind(storeId, attendanceBounds.localStart, attendanceBounds.localEnd, attendanceBounds.startUtc, attendanceBounds.endUtc)
      .all<AttendanceRow>(),
    storeDateRangeFinance(db, storeId, range),
  ]);
  const revenueBreakdowns = buildRevenueBreakdowns(shifts, yearShifts);
  const attendanceEmployees = buildMonthlyAttendanceStats(attendanceResult.results);
  const attendanceTotals = attendanceEmployees.reduce((total, item) => ({
    early: total.early + item.early,
    onTime: total.onTime + item.onTime,
    late: total.late + item.late,
    unknown: total.unknown + item.unknown,
    total: total.total + item.total,
  }), { early: 0, onTime: 0, late: 0, unknown: 0, total: 0 });

  return json({
    store,
    filter: {
      mode,
      anchor,
      from: range.from,
      to: range.to,
      timeZone: "Asia/Ho_Chi_Minh",
    },
    totals: {
      ...summarizeCompletedShiftMoney(shifts),
      completedShiftCount: shifts.length,
    },
    accountingTotals: accounting ? {
      revenue: accounting.revenue,
      expense: accounting.expense,
      profit: accounting.profit,
      expenseBreakdown: accounting.expenseBreakdown,
    } : { revenue: 0, expense: 0, profit: 0, expenseBreakdown: {} },
    revenueBreakdowns,
    attendance: {
      period: attendancePeriod,
      timeZone: "Asia/Ho_Chi_Minh",
      rule: {
        early: "Điểm danh trước giờ bắt đầu ca.",
        onTime: `Điểm danh từ giờ bắt đầu ca đến đúng ${currentPolicy.lateGraceMinutes} phút sau.`,
        late: `Điểm danh sau ${currentPolicy.lateGraceMinutes} phút kể từ giờ bắt đầu ca.`,
      },
      policy: attendancePolicyPayload(currentPolicy),
      totals: attendanceTotals,
      employees: attendanceEmployees,
    },
    shifts,
    recognitionPolicy: {
      revenue: "Doanh thu tiền mặt và chuyển khoản được lấy từ từng ca đã kết thúc.",
      expense: "Chi phí trong ca được lấy từ expense_amount và chỉ cộng một lần cho mỗi ca hoàn tất.",
      accountingDate: "Ưu tiên ngày ca đã lưu; dữ liệu cũ được quy đổi theo giờ Việt Nam từ thời điểm bắt đầu ca.",
    },
  });
}
