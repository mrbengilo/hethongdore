export type RoundingMode = "HALF_UP" | "DOWN" | "UP";

export const FINANCE_TIME_ZONE = "Asia/Ho_Chi_Minh";

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

export const MANAGER_MONTHLY_SALARY_VND = 3_000_000;

export function managerProfitBonus(profit: number) {
  return multiplyDecimalVnd(Math.max(0, requireVnd(profit, "Lợi nhuận", true)), "0.02");
}

/**
 * Freeze the final performance-reward layer without feeding either reward back
 * into its own calculation. `baseProfit` is revenue minus every operating cost,
 * employee salary/allowance/bonus and the fixed manager salary. Both KPI pools
 * are then deducted exactly once to obtain the store's final profit.
 */
export function settleStoreProfit(baseProfit: number, employeeKpiBonus: number) {
  const profitBeforePerformanceRewards = requireVnd(baseProfit, "Lợi nhuận cơ sở", true);
  const employeeBonus = requireVnd(employeeKpiBonus, "Thưởng KPI nhân viên");
  const managerBonus = managerProfitBonus(profitBeforePerformanceRewards);
  const performanceRewards = sumVnd([employeeBonus, managerBonus]);
  const finalProfit = requireVnd(profitBeforePerformanceRewards - performanceRewards, "Lợi nhuận sau cùng", true);
  return { profitBeforePerformanceRewards, employeeKpiBonus: employeeBonus, managerBonus, performanceRewards, finalProfit };
}
