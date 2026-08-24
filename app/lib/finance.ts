export type RoundingMode = "HALF_UP" | "DOWN" | "UP";

export const FINANCE_TIME_ZONE = "Asia/Ho_Chi_Minh";

export type LocalDateRange = { from: string; to: string };

const localDatePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isLocalDateValue(value: string) {
  if (!localDatePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function addLocalDays(value: string, amount: number) {
  if (!isLocalDateValue(value) || !Number.isSafeInteger(amount)) throw new Error("Ngày hoặc số ngày không hợp lệ.");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day + amount));
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

export function localDateRangeDays(range: LocalDateRange) {
  if (!isLocalDateValue(range.from) || !isLocalDateValue(range.to) || range.from > range.to) {
    throw new Error("Khoảng ngày không hợp lệ.");
  }
  const start = Date.parse(`${range.from}T00:00:00.000Z`);
  const end = Date.parse(`${range.to}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

export function localDateRangeKeys(range: LocalDateRange) {
  const count = localDateRangeDays(range);
  return Array.from({ length: count }, (_, index) => addLocalDays(range.from, index));
}

export function previousEqualDateRange(range: LocalDateRange): LocalDateRange {
  const days = localDateRangeDays(range);
  const to = addLocalDays(range.from, -1);
  return { from: addLocalDays(to, 1 - days), to };
}

function isFullCalendarMonthRange(range: LocalDateRange) {
  if (!isLocalDateValue(range.from) || !isLocalDateValue(range.to) || !range.from.endsWith("-01")) return false;
  return addLocalDays(range.to, 1).endsWith("-01");
}

function addLocalMonths(value: string, amount: number) {
  if (!isLocalDateValue(value) || !Number.isSafeInteger(amount)) throw new Error("Ngày hoặc số tháng không hợp lệ.");
  const [year, month, day] = value.split("-").map(Number);
  const targetStart = new Date(Date.UTC(year, month - 1 + amount, 1));
  const targetDays = new Date(Date.UTC(targetStart.getUTCFullYear(), targetStart.getUTCMonth() + 1, 0)).getUTCDate();
  return `${targetStart.getUTCFullYear()}-${String(targetStart.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, targetDays)).padStart(2, "0")}`;
}

/** Full-month views compare the same number of calendar months; custom day spans compare the exact preceding N days. */
export function previousComparableDateRange(range: LocalDateRange, granularity: "day" | "month") {
  localDateRangeDays(range);
  if (granularity !== "month" || !isFullCalendarMonthRange(range)) return previousEqualDateRange(range);
  const monthCount = (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12
    + Number(range.to.slice(5, 7)) - Number(range.from.slice(5, 7)) + 1;
  const to = addLocalDays(range.from, -1);
  const from = addLocalMonths(range.from, -monthCount);
  return { from, to };
}

export function validateFinanceDateRange(
  range: LocalDateRange,
  granularity: "day" | "month",
  today = localDate(),
) {
  const days = localDateRangeDays(range);
  const months = (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12
    + Number(range.to.slice(5, 7)) - Number(range.from.slice(5, 7)) + 1;
  if (granularity === "day" && days > 366) throw new Error("Phạm vi theo ngày tối đa là 366 ngày.");
  if (granularity === "month" && months > 60) throw new Error("Phạm vi theo tháng tối đa là 60 tháng.");
  if (range.to > today) throw new Error("Phạm vi không được vượt quá ngày hiện tại tại Việt Nam.");
  return { days, months };
}

type FinanceSnapshot = { revenue: number; expense: number; profit: number };

function financePercentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
  return (current - previous) / Math.abs(previous) * 100;
}

export function evaluateFinancePerformance(
  current: FinanceSnapshot,
  previous: FinanceSnapshot | null,
  change = financePercentChange,
) {
  const margin = current.revenue === 0 ? null : current.profit / current.revenue * 100;
  const revenueChange = change(current.revenue, previous?.revenue ?? 0);
  const expenseChange = change(current.expense, previous?.expense ?? 0);
  const profitChange = change(current.profit, previous?.profit ?? 0);
  const score = ((margin ?? 0) >= 15 ? 2 : (margin ?? 0) >= 5 ? 1 : 0)
    + (revenueChange > 0 ? 1 : 0)
    + (profitChange > 0 ? 1 : 0)
    + (expenseChange <= revenueChange ? 1 : 0);
  return {
    margin,
    revenueChange,
    expenseChange,
    profitChange,
    rating: current.profit < 0 ? "CẦN CẢI THIỆN" : score >= 4 ? "TỐT" : score >= 2 ? "CẦN THEO DÕI" : "CẦN CẢI THIỆN",
    direction: current.profit < 0 || profitChange < 0 ? "SUY GIẢM" : profitChange > 0 && revenueChange > 0 ? "TĂNG TRƯỞNG" : "ỔN ĐỊNH",
  };
}

export function summarizeAccrualTimeline(rows: Array<{ revenue: number; expense: number }>) {
  const revenue = sumVnd(rows.map((row) => row.revenue));
  const expense = sumVnd(rows.map((row) => row.expense));
  return { revenue, expense, profit: revenue - expense };
}

export function summarizeCashTimeline(rows: Array<{ inflow: number; outflow: number }>) {
  const inflow = sumVnd(rows.map((row) => row.inflow));
  const outflow = sumVnd(rows.map((row) => row.outflow));
  return { inflow, outflow, net: inflow - outflow };
}

/** Keep both comparison populations independent when a store opens or closes between ranges. */
export function financeComparisonPopulation<T>(
  rows: Array<{ current: T | null; previous: T | null }>,
) {
  return {
    current: rows.flatMap((row) => row.current ? [row.current] : []),
    previous: rows.flatMap((row) => row.previous ? [row.previous] : []),
  };
}

export function dateRangeBoundsUtc(range: LocalDateRange) {
  localDateRangeDays(range);
  const localEnd = addLocalDays(range.to, 1);
  return {
    localStart: range.from,
    localEnd,
    startUtc: new Date(`${range.from}T00:00:00+07:00`).toISOString(),
    endUtc: new Date(`${localEnd}T00:00:00+07:00`).toISOString(),
  };
}

export function localMonthRange(period: string): LocalDateRange {
  const bounds = periodBoundsUtc(period);
  return { from: bounds.localStart, to: addLocalDays(bounds.localEnd, -1) };
}

export function isVnd(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function requireVnd(value: unknown, field = "Số tiền", allowNegative = false) {
  if (!isVnd(value) || (!allowNegative && value < 0)) {
    throw new Error(`${field} phải là số nguyên VND${allowNegative ? "" : " không âm"}.`);
  }
  return value;
}

export function sumVnd(values: number[]) {
  const total = values.reduce((sum, value) => sum + BigInt(requireVnd(value)), 0n);
  const result = Number(total);
  if (!Number.isSafeInteger(result)) throw new Error("Tổng tiền vượt giới hạn an toàn.");
  return result;
}

function roundQuotient(numerator: bigint, denominator: bigint, mode: RoundingMode) {
  if (denominator <= 0n) throw new Error("Mẫu số phải lớn hơn 0.");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (mode === "UP" && remainder > 0n) quotient += 1n;
  if (mode === "HALF_UP" && remainder * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

function decimalFraction(rate: string) {
  const normalized = rate.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Tỷ lệ decimal không hợp lệ.");
  const [whole, fraction = ""] = normalized.split(".");
  const scale = 10n ** BigInt(fraction.length);
  return { numerator: BigInt(whole + fraction), denominator: scale };
}

export function multiplyRatioVnd(amount: number, numerator: number | bigint, denominator: number | bigint, rounding: RoundingMode = "HALF_UP") {
  const source = BigInt(requireVnd(amount, "Số tiền", true));
  const top = typeof numerator === "bigint" ? numerator : BigInt(requireVnd(numerator, "Tử số", true));
  const bottom = typeof denominator === "bigint" ? denominator : BigInt(requireVnd(denominator, "Mẫu số"));
  const result = Number(roundQuotient(source * top, bottom, rounding));
  if (!Number.isSafeInteger(result)) throw new Error("Kết quả tiền vượt giới hạn an toàn.");
  return result;
}

export type StoreProfitShareAllocation = {
  finalProfit: number;
  distributableProfit: number;
  firstShareAmount: number;
  secondShareAmount: number;
};

/**
 * Keep each store's distributable result independent. A loss at one store is
 * never allowed to consume a different store's positive final profit.
 *
 * The 40/60 fields remain as a legacy read-model compatibility shape. New
 * distribution writes resolve their member policy from the locked financial
 * period and use the normalized profit-distribution ledger instead.
 */
export function allocateStoreProfitSharing(finalProfits: number[]): StoreProfitShareAllocation[] {
  const normalized = finalProfits.map((value) => requireVnd(value, "Lợi nhuận sau cùng", true));
  let cumulativeDistributable = 0;
  let allocatedFirstShare = 0;

  return normalized.map((finalProfit) => {
    const distributableProfit = Math.max(0, finalProfit);
    cumulativeDistributable += distributableProfit;
    const targetFirstShare = multiplyRatioVnd(cumulativeDistributable, 40, 100);
    const firstShareAmount = targetFirstShare - allocatedFirstShare;
    allocatedFirstShare = targetFirstShare;
    return {
      finalProfit,
      distributableProfit,
      firstShareAmount,
      secondShareAmount: distributableProfit - firstShareAmount,
    };
  });
}

export function multiplyDecimalVnd(amount: number, decimalRate: string, rounding: RoundingMode = "HALF_UP") {
  const rate = decimalFraction(decimalRate);
  return multiplyRatioVnd(amount, rate.numerator, rate.denominator, rounding);
}

export function multiplyDecimalRatioVnd(amount: number, decimalRate: string, shareNumerator: number, shareDenominator: number, rounding: RoundingMode = "HALF_UP") {
  const rate = decimalFraction(decimalRate);
  const numerator = rate.numerator * BigInt(requireVnd(shareNumerator, "Tử số tỷ trọng"));
  const denominator = rate.denominator * BigInt(requireVnd(shareDenominator, "Mẫu số tỷ trọng"));
  return multiplyRatioVnd(amount, numerator, denominator, rounding);
}

export function utcTimestamp(now = new Date()) {
  return now.toISOString();
}

export function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FINANCE_TIME_ZONE }).format(now);
}

export function localPeriod(now = new Date()) {
  return localDate(now).slice(0, 7);
}

/**
 * The payroll ledger can start closing at 00:00 Vietnam time on the final
 * calendar day of its month. Keeping this calendar rule here makes the API and
 * the manager UI agree across leap years and year boundaries.
 */
export function payrollPeriodClosingDate(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("Kỳ lương không hợp lệ.");
  const [year, month] = period.split("-").map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(day).padStart(2, "0")}`;
}

export function canClosePayrollPeriod(period: string, now = new Date()) {
  return localDate(now) >= payrollPeriodClosingDate(period);
}

/**
 * Assign a shift to exactly one accounting day. New sessions use the persisted
 * schedule occurrence (`work_date`); legacy rows fall back to their local
 * start date so an overnight completion cannot move between payroll periods.
 */
export function shiftAccountingDate(workDate: string | null | undefined, startedAt: string) {
  const normalized = workDate?.trim() ?? "";
  if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(normalized)) return normalized;
  const started = new Date(startedAt);
  return Number.isFinite(started.getTime()) ? localDate(started) : "";
}

export function periodBoundsUtc(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("Kỳ tháng không hợp lệ.");
  const [year, month] = period.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const localStart = `${period}-01`;
  const localEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  return {
    localStart,
    localEnd,
    startUtc: new Date(`${localStart}T00:00:00+07:00`).toISOString(),
    endUtc: new Date(`${localEnd}T00:00:00+07:00`).toISOString(),
  };
}

/** A store participates in a month only if it existed before that local month ended. */
export function storeExistsInPeriod(createdAt: string, period: string) {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const periodEnd = new Date(periodBoundsUtc(period).endUtc).getTime();
  return created < periodEnd;
}

export function durationSeconds(startedAt: string, endedAt: string) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Khoảng thời gian không hợp lệ.");
  return Math.round((end - start) / 1_000);
}

export function durationMinutes(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Thời lượng giây không hợp lệ.");
  return seconds / 60;
}

export function formatVnd(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(requireVnd(value, "Số tiền", true)) + " đồng";
}

export type TenderTotals = { cash: number; bankTransfer: number };

export function tenderDifferences(expected: TenderTotals, entered: TenderTotals) {
  return {
    cash: requireVnd(entered.cash, "Tiền mặt") - requireVnd(expected.cash, "Tiền mặt theo đơn"),
    bankTransfer: requireVnd(entered.bankTransfer, "Chuyển khoản") - requireVnd(expected.bankTransfer, "Chuyển khoản theo đơn"),
  };
}

/**
 * Freeze the final performance-reward layer without feeding either reward back
 * into its own calculation. `baseProfit` is revenue minus every operating cost,
 * employee salary/allowance/bonus and the fixed manager salary. The employee
 * and manager allocations come from the same hour-weighted KPI pool and are
 * then deducted exactly once to obtain the store's final profit.
 */
export function settleStoreProfit(baseProfit: number, employeeKpiBonus: number, managerKpiBonus: number) {
  const profitBeforePerformanceRewards = requireVnd(baseProfit, "Lợi nhuận cơ sở", true);
  const employeeBonus = requireVnd(employeeKpiBonus, "Thưởng KPI nhân viên");
  const managerBonus = requireVnd(managerKpiBonus, "Thưởng KPI quản lý");
  const performanceRewards = sumVnd([employeeBonus, managerBonus]);
  const finalProfit = requireVnd(profitBeforePerformanceRewards - performanceRewards, "Lợi nhuận sau cùng", true);
  return { profitBeforePerformanceRewards, employeeKpiBonus: employeeBonus, managerBonus, performanceRewards, finalProfit };
}
