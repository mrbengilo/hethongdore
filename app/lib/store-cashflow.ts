import { attendanceDeltaMinutes, attendanceStatusAt } from "./scheduling";

export type StoreCashflowMode = "day" | "week" | "month";

export type CompletedShiftMoney = {
  cashRevenue: number;
  transferRevenue: number;
  expenseAmount: number;
};

export type RevenueBreakdownShift = CompletedShiftMoney & {
  workDate: string;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
};

export type AttendanceObservation = {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  startedAt: string;
  scheduledStartAt: string | null;
  attendanceStatus?: string | null;
  attendanceDeltaMinutes?: number | null;
  attendanceGraceMinutes?: number | null;
};

const localDatePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const localPeriodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function validLocalDate(value: string) {
  if (!localDatePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function addCalendarDays(value: string, amount: number) {
  if (!validLocalDate(value) || !Number.isSafeInteger(amount)) throw new Error("Ngày lọc dòng tiền không hợp lệ.");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day + amount));
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

function monthRange(period: string) {
  if (!localPeriodPattern.test(period)) throw new Error("Kỳ tháng dòng tiền không hợp lệ.");
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * Resolve a day, Monday-to-Sunday week, or calendar month entirely from
 * Vietnam-local date keys. UTC calendar arithmetic makes the result
 * independent from the Node server's configured operating-system timezone.
 */
export function completedShiftDateRange(mode: StoreCashflowMode, anchor: string) {
  if (mode === "month") return monthRange(anchor.slice(0, 7));
  if (!validLocalDate(anchor)) throw new Error("Ngày lọc dòng tiền không hợp lệ.");
  if (mode === "day") return { from: anchor, to: anchor };
  const [year, month, day] = anchor.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const mondayOffset = -((weekday + 6) % 7);
  const from = addCalendarDays(anchor, mondayOffset);
  return { from, to: addCalendarDays(from, 6) };
}

function safeStoredVnd(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Sum each persisted completed-shift row once; no store-level denormalized total is mixed in. */
export function summarizeCompletedShiftMoney(rows: CompletedShiftMoney[]) {
  let cash = 0n;
  let transfer = 0n;
  let expense = 0n;
  for (const row of rows) {
    cash += BigInt(safeStoredVnd(Number(row.cashRevenue)));
    transfer += BigInt(safeStoredVnd(Number(row.transferRevenue)));
    expense += BigInt(safeStoredVnd(Number(row.expenseAmount)));
  }
  const cashRevenue = Number(cash);
  const transferRevenue = Number(transfer);
  const expenseAmount = Number(expense);
  const revenue = Number(cash + transfer);
  const net = Number(cash + transfer - expense);
  if (![cashRevenue, transferRevenue, expenseAmount, revenue, net].every(Number.isSafeInteger)) {
    throw new Error("Tổng dòng tiền ca vượt giới hạn an toàn.");
  }
  return { cashRevenue, transferRevenue, revenue, expenseAmount, net };
}

function safeRevenue(row: CompletedShiftMoney) {
  const cash = safeStoredVnd(Number(row.cashRevenue));
  const transfer = safeStoredVnd(Number(row.transferRevenue));
  const total = BigInt(cash) + BigInt(transfer);
  const value = Number(total);
  if (!Number.isSafeInteger(value)) throw new Error("Tổng doanh thu vượt giới hạn an toàn.");
  return value;
}

type RevenueAccumulator = { revenue: bigint; completedShiftCount: number };

function addRevenue(map: Map<string, RevenueAccumulator>, key: string, revenue: number) {
  const current = map.get(key) ?? { revenue: 0n, completedShiftCount: 0 };
  current.revenue += BigInt(revenue);
  current.completedShiftCount += 1;
  map.set(key, current);
}

function checkedRevenue(value: bigint) {
  const revenue = Number(value);
  if (!Number.isSafeInteger(revenue)) throw new Error("Tổng doanh thu vượt giới hạn an toàn.");
  return revenue;
}

/** Build stable, non-overlapping views from persisted completed-shift rows. */
export function buildRevenueBreakdowns(selectedRows: RevenueBreakdownShift[], yearRows = selectedRows) {
  const daily = new Map<string, RevenueAccumulator>();
  const monthly = new Map<string, RevenueAccumulator>();
  const employee = new Map<string, RevenueAccumulator & { employeeCode: string | null; employeeName: string | null }>();
  const shift = new Map<string, RevenueAccumulator & {
    shiftName: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
  }>();

  for (const row of selectedRows) {
    const revenue = safeRevenue(row);
    addRevenue(daily, row.workDate, revenue);

    const employeeCurrent = employee.get(row.employeeId) ?? {
      revenue: 0n,
      completedShiftCount: 0,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
    };
    employeeCurrent.revenue += BigInt(revenue);
    employeeCurrent.completedShiftCount += 1;
    employee.set(row.employeeId, employeeCurrent);

    const shiftName = row.shiftName?.trim() || "Ca chưa đặt tên";
    const shiftKey = `${shiftName}\u0000${row.scheduledStart ?? ""}\u0000${row.scheduledEnd ?? ""}`;
    const shiftCurrent = shift.get(shiftKey) ?? {
      revenue: 0n,
      completedShiftCount: 0,
      shiftName,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
    };
    shiftCurrent.revenue += BigInt(revenue);
    shiftCurrent.completedShiftCount += 1;
    shift.set(shiftKey, shiftCurrent);
  }

  for (const row of yearRows) addRevenue(monthly, row.workDate.slice(0, 7), safeRevenue(row));

  return {
    daily: [...daily.entries()].map(([date, value]) => ({
      date,
      revenue: checkedRevenue(value.revenue),
      completedShiftCount: value.completedShiftCount,
    })).sort((left, right) => left.date.localeCompare(right.date)),
    monthly: [...monthly.entries()].map(([period, value]) => ({
      period,
      revenue: checkedRevenue(value.revenue),
      completedShiftCount: value.completedShiftCount,
    })).sort((left, right) => left.period.localeCompare(right.period)),
    employees: [...employee.entries()].map(([employeeId, value]) => ({
      employeeId,
      employeeCode: value.employeeCode,
      employeeName: value.employeeName,
      revenue: checkedRevenue(value.revenue),
      completedShiftCount: value.completedShiftCount,
    })).sort((left, right) => right.revenue - left.revenue || (left.employeeName ?? left.employeeId).localeCompare(right.employeeName ?? right.employeeId, "vi")),
    shifts: [...shift.values()].map((value) => ({
      shiftName: value.shiftName,
      scheduledStart: value.scheduledStart,
      scheduledEnd: value.scheduledEnd,
      revenue: checkedRevenue(value.revenue),
      completedShiftCount: value.completedShiftCount,
    })).sort((left, right) => (left.scheduledStart ?? "99:99").localeCompare(right.scheduledStart ?? "99:99") || left.shiftName.localeCompare(right.shiftName, "vi")),
  };
}

export function resolveAttendanceObservation(row: AttendanceObservation) {
  const persisted = row.attendanceStatus;
  const persistedDelta = row.attendanceDeltaMinutes == null ? null : Number(row.attendanceDeltaMinutes);
  const computedDelta = row.scheduledStartAt
    ? attendanceDeltaMinutes(row.startedAt, row.scheduledStartAt)
    : null;
  const computedStatus = row.scheduledStartAt
    ? attendanceStatusAt(row.startedAt, row.scheduledStartAt, row.attendanceGraceMinutes ?? undefined)
    : null;
  const deltaMinutes = persistedDelta != null && Number.isSafeInteger(persistedDelta)
    ? persistedDelta
    : computedDelta ?? 0;
  const status = persisted === "EARLY" || persisted === "ON_TIME" || persisted === "LATE"
    ? persisted
    : computedStatus ?? "UNKNOWN";
  return { status, deltaMinutes } as const;
}

/** Aggregate attendance once per started shift for the selected store/month. */
export function buildMonthlyAttendanceStats(rows: AttendanceObservation[]) {
  const employees = new Map<string, {
    employeeCode: string | null;
    employeeName: string | null;
    early: number;
    onTime: number;
    late: number;
    unknown: number;
    total: number;
    known: number;
    deltaTotal: number;
  }>();
  for (const row of rows) {
    const observation = resolveAttendanceObservation(row);
    const current = employees.get(row.employeeId) ?? {
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      early: 0,
      onTime: 0,
      late: 0,
      unknown: 0,
      total: 0,
      known: 0,
      deltaTotal: 0,
    };
    if (observation.status === "EARLY") current.early += 1;
    else if (observation.status === "LATE") current.late += 1;
    else if (observation.status === "ON_TIME") current.onTime += 1;
    else current.unknown += 1;
    current.total += 1;
    if (observation.status !== "UNKNOWN") {
      current.known += 1;
      current.deltaTotal += observation.deltaMinutes;
    }
    employees.set(row.employeeId, current);
  }
  return [...employees.entries()].map(([employeeId, value]) => ({
    employeeId,
    employeeCode: value.employeeCode,
    employeeName: value.employeeName,
    early: value.early,
    onTime: value.onTime,
    late: value.late,
    unknown: value.unknown,
    total: value.total,
    averageDeltaMinutes: value.known ? Math.round(value.deltaTotal / value.known * 10) / 10 : 0,
  })).sort((left, right) => right.late - left.late || (left.employeeName ?? left.employeeId).localeCompare(right.employeeName ?? right.employeeId, "vi"));
}
