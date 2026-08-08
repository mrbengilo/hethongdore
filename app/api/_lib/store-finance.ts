import { initDb } from "../../../db/runtime";
import {
  type LocalDateRange,
  MANAGER_MONTHLY_SALARY_VND,
  dateRangeBoundsUtc,
  localDate,
  localDateRangeKeys,
  localMonthRange,
  managerProfitBonus,
  multiplyRatioVnd,
  periodBoundsUtc,
  requireVnd,
  shiftAccountingDate,
  storeExistsInPeriod,
  sumVnd,
} from "../../lib/finance";
import { employeeKpiBonusFromSeconds } from "../../lib/payroll";

type Db = Awaited<ReturnType<typeof initDb>>;

type StoreRow = {
  id: string;
  name: string;
  address: string;
  status: string;
  createdAt: string;
};

type ShiftFinanceRow = {
  employeeId: string;
  durationSeconds: number;
  appliedHourlyRate: number;
  cashRevenue: number;
  transferRevenue: number;
  incidentalExpense: number;
  tiktokAllowance: number;
  transferId: string | null;
  supportAllowance: number | null;
};

type RecordRow = { dataJson: string };

export type StoreExpenseBreakdown = {
  fixedCosts: number;
  incidentalCosts: number;
  inventoryGoods: number;
  inventoryShipping: number;
  employeeBaseSalary: number;
  tiktokAllowance: number;
  supportAllowance: number;
  manualAllowance: number;
  manualBonus: number;
  managerSalary: number;
  employeeKpiBonus: number;
  managerBonus: number;
};

export type StorePeriodFinance = {
  id: string;
  name: string;
  address: string;
  status: string;
  period: string;
  revenue: number;
  expense: number;
  profit: number;
  profitBeforePerformanceRewards: number;
  expenseBreakdown: StoreExpenseBreakdown;
  calculationStatus: "PROVISIONAL" | "LOCKED";
  settlementStatus: "OPEN" | "PAYMENT_CONFIRMED" | "LOCKED";
};

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeVnd(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function inventoryTotals(data: Record<string, unknown>) {
  const rawItems = Array.isArray(data.items) ? data.items : [data];
  return rawItems.reduce((total, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return total;
    const row = item as Record<string, unknown>;
    const weight = Number(row.weight ?? 0);
    const unitPrice = safeVnd(row.unitPrice);
    const shipping = safeVnd(row.shipping);
    const calculatedGoods = Number.isFinite(weight) && weight >= 0
      ? Math.round(weight * unitPrice)
      : Math.max(0, safeVnd(row.amount) - shipping);
    const goods = safeVnd(row.goodsAmount ?? calculatedGoods);
    total.goods = sumVnd([total.goods, goods]);
    total.shipping = sumVnd([total.shipping, shipping]);
    return total;
  }, { goods: 0, shipping: 0 });
}

function fixedCostTotal(data: Record<string, unknown>) {
  const savedTotal = safeVnd(data.total);
  if (savedTotal > 0 || data.total === 0) return savedTotal;
  return sumVnd(["setup", "rent", "electricity", "water", "wifi", "marketing", "garbage", "other"].map((key) => safeVnd(data[key])));
}

export function previousPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export async function storePeriodFinance(db: Db, storeId: string, period: string): Promise<StorePeriodFinance | null> {
  const store = await db.prepare("SELECT id, name, address, status, created_at AS createdAt FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(storeId).first<StoreRow>();
  if (!store || !storeExistsInPeriod(store.createdAt, period)) return null;

  const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
  const [shiftResult, fixedResult, incidentalResult, inventoryResult, adjustmentResult, snapshotRow, closingRow] = await Promise.all([
    db.prepare(`
      SELECT
        s.employee_id AS employeeId,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END AS durationSeconds,
        COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
        COALESCE(s.cash_revenue, 0) AS cashRevenue,
        COALESCE(s.transfer_revenue, 0) AS transferRevenue,
        COALESCE(s.expense_amount, 0) AS incidentalExpense,
        COALESCE(s.tiktok_allowance, 0) AS tiktokAllowance,
        s.transfer_id AS transferId,
        t.support_allowance AS supportAllowance
      FROM shift_sessions s
      JOIN employees e ON e.id = s.employee_id
      LEFT JOIN employee_transfers t ON t.id = s.transfer_id
      WHERE s.store_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
          OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
        )
    `).bind(storeId, localStart, localEnd, startUtc, endUtc).all<ShiftFinanceRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'CHI_PHI_CO_DINH' AND store_id = ? AND status != 'DELETED' AND json_extract(data_json, '$.period') = ?")
      .bind(storeId, period).all<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'DONG_TIEN' AND store_id = ? AND status != 'DELETED' AND (json_extract(data_json, '$.period') = ? OR substr(json_extract(data_json, '$.date'), 1, 7) = ?)")
      .bind(storeId, period, period).all<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'NHAP_HANG' AND store_id = ? AND status != 'DELETED' AND (json_extract(data_json, '$.period') = ? OR substr(json_extract(data_json, '$.date'), 1, 7) = ?)")
      .bind(storeId, period, period).all<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'LUONG_THUONG' AND store_id = ? AND status != 'DELETED' AND substr(json_extract(data_json, '$.date'), 1, 7) = ?")
      .bind(storeId, period).all<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'KPI_SUMMARY' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(storeId, period).first<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson, status FROM business_records WHERE category = 'PAYROLL_CLOSING' AND store_id = ? AND status != 'DELETED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(storeId, period).first<RecordRow & { status: string }>(),
  ]);

  let revenue = 0;
  let incidentalCosts = 0;
  let employeeBaseSalary = 0;
  let tiktokAllowance = 0;
  let totalDurationSeconds = 0;
  const secondsByEmployee = new Map<string, number>();
  const supportByTransfer = new Map<string, number>();
  for (const row of shiftResult.results) {
    const seconds = Math.max(0, Math.round(Number(row.durationSeconds ?? 0)));
    const hourlyRate = requireVnd(Math.max(0, Math.round(Number(row.appliedHourlyRate ?? 0))), "Lương theo giờ");
    revenue = sumVnd([revenue, safeVnd(row.cashRevenue), safeVnd(row.transferRevenue)]);
    incidentalCosts = sumVnd([incidentalCosts, safeVnd(row.incidentalExpense)]);
    employeeBaseSalary = sumVnd([employeeBaseSalary, multiplyRatioVnd(hourlyRate, seconds, 3_600)]);
    tiktokAllowance = sumVnd([tiktokAllowance, safeVnd(row.tiktokAllowance)]);
    totalDurationSeconds += seconds;
    secondsByEmployee.set(row.employeeId, (secondsByEmployee.get(row.employeeId) ?? 0) + seconds);
    if (row.transferId && seconds > 0) supportByTransfer.set(row.transferId, safeVnd(row.supportAllowance));
  }
  incidentalCosts = sumVnd([
    incidentalCosts,
    ...incidentalResult.results.map((row) => safeVnd(parseObject(row.dataJson).amount)),
  ]);

  const fixedCosts = sumVnd(fixedResult.results.map((row) => fixedCostTotal(parseObject(row.dataJson))));
  const inventory = inventoryResult.results.reduce((total, row) => {
    const next = inventoryTotals(parseObject(row.dataJson));
    return { goods: sumVnd([total.goods, next.goods]), shipping: sumVnd([total.shipping, next.shipping]) };
  }, { goods: 0, shipping: 0 });

  let manualAllowance = 0;
  let manualBonus = 0;
  for (const row of adjustmentResult.results) {
    const data = parseObject(row.dataJson);
    if (data.kind === "ALLOWANCE") manualAllowance = sumVnd([manualAllowance, safeVnd(data.amount)]);
    if (data.kind === "BONUS") manualBonus = sumVnd([manualBonus, safeVnd(data.amount)]);
  }

  const supportAllowance = sumVnd([...supportByTransfer.values()]);
  const baseExpense = sumVnd([
    fixedCosts,
    incidentalCosts,
    inventory.goods,
    inventory.shipping,
    employeeBaseSalary,
    tiktokAllowance,
    supportAllowance,
    manualAllowance,
    manualBonus,
    MANAGER_MONTHLY_SALARY_VND,
  ]);
  const profitBeforePerformanceRewards = revenue - baseExpense;
  const lockedSnapshot = snapshotRow ? parseObject(snapshotRow.dataJson) : null;
  const employeeKpiBonus = lockedSnapshot
    ? safeVnd(lockedSnapshot.totalKpiBonus)
    : sumVnd([...secondsByEmployee.values()].map((seconds) => employeeKpiBonusFromSeconds(profitBeforePerformanceRewards, totalDurationSeconds, seconds)));
  const managerBonus = lockedSnapshot
    ? safeVnd(lockedSnapshot.managerBonus)
    : managerProfitBonus(profitBeforePerformanceRewards);
  const expenseBreakdown: StoreExpenseBreakdown = {
    fixedCosts,
    incidentalCosts,
    inventoryGoods: inventory.goods,
    inventoryShipping: inventory.shipping,
    employeeBaseSalary,
    tiktokAllowance,
    supportAllowance,
    manualAllowance,
    manualBonus,
    managerSalary: MANAGER_MONTHLY_SALARY_VND,
    employeeKpiBonus,
    managerBonus,
  };
  const expense = sumVnd([baseExpense, employeeKpiBonus, managerBonus]);

  return {
    ...store,
    period,
    revenue,
    expense,
    profit: revenue - expense,
    profitBeforePerformanceRewards,
    expenseBreakdown,
    calculationStatus: snapshotRow ? "LOCKED" : "PROVISIONAL",
    settlementStatus: closingRow?.status === "LOCKED"
      ? "LOCKED"
      : closingRow?.status === "PAYMENT_CONFIRMED" || Boolean(closingRow && parseObject(closingRow.dataJson).paymentConfirmedAt)
        ? "PAYMENT_CONFIRMED"
        : "OPEN",
  };
}

type RangeShiftRow = {
  employeeId: string;
  workDate: string | null;
  startedAt: string;
  durationSeconds: number;
  appliedHourlyRate: number;
  cashRevenue: number;
  transferRevenue: number;
  incidentalExpense: number;
  tiktokAllowance: number;
};

type RangeRecordRow = {
  category: string;
  dataJson: string;
};

type StoreStatusAuditRow = {
  detail: string | null;
  createdAt: string;
};

type StoreTransition = { at: string; to: "ACTIVE" | "INACTIVE" };

export type StoreRangeFinanceDay = {
  date: string;
  revenue: number;
  expense: number;
  profit: number;
  expenseBreakdown: StoreExpenseBreakdown;
};

export type StoreDateRangeFinance = Omit<StorePeriodFinance, "period"> & {
  range: LocalDateRange;
  activeDayCount: number;
  timeline: StoreRangeFinanceDay[];
  periodStatuses: Array<{
    period: string;
    calculationStatus: "PROVISIONAL" | "LOCKED";
    settlementStatus: "OPEN" | "PAYMENT_CONFIRMED" | "LOCKED";
  }>;
};

function emptyExpenseBreakdown(): StoreExpenseBreakdown {
  return {
    fixedCosts: 0,
    incidentalCosts: 0,
    inventoryGoods: 0,
    inventoryShipping: 0,
    employeeBaseSalary: 0,
    tiktokAllowance: 0,
    supportAllowance: 0,
    manualAllowance: 0,
    manualBonus: 0,
    managerSalary: 0,
    employeeKpiBonus: 0,
    managerBonus: 0,
  };
}

function periodsInRange(range: LocalDateRange) {
  return [...new Set(localDateRangeKeys(range).map((date) => date.slice(0, 7)))];
}

function parseStoreTransitions(rows: StoreStatusAuditRow[]): StoreTransition[] {
  return rows.flatMap((row) => {
    const detail = parseObject(row.detail ?? "");
    const to: StoreTransition["to"] | null = detail.to === "INACTIVE" ? "INACTIVE" : detail.to === "ACTIVE" ? "ACTIVE" : null;
    if (!to) return [];
    const at = localDate(new Date(row.createdAt));
    return at ? [{ at, to }] : [];
  }).sort((first, second) => first.at.localeCompare(second.at));
}

function storeIsActiveOnDate(createdDate: string, transitions: ReturnType<typeof parseStoreTransitions>, date: string) {
  if (!createdDate || date < createdDate) return false;
  let status: "ACTIVE" | "INACTIVE" = "ACTIVE";
  for (const transition of transitions) {
    if (transition.at >= date) break;
    status = transition.to;
  }
  return status === "ACTIVE" || transitions.some((transition) => transition.at === date && transition.to === "ACTIVE");
}

function allocateMonthlyExpense(
  amount: number,
  field: keyof StoreExpenseBreakdown,
  eligibleDates: string[],
  selectedDays: Map<string, StoreRangeFinanceDay>,
) {
  if (amount <= 0 || eligibleDates.length === 0) return;
  const base = Math.floor(amount / eligibleDates.length);
  const remainder = amount % eligibleDates.length;
  eligibleDates.forEach((date, index) => {
    const day = selectedDays.get(date);
    if (!day) return;
    day.expenseBreakdown[field] = sumVnd([day.expenseBreakdown[field], base + (index < remainder ? 1 : 0)]);
  });
}

function addDayExpense(day: StoreRangeFinanceDay, field: keyof StoreExpenseBreakdown, amount: number) {
  day.expenseBreakdown[field] = sumVnd([day.expenseBreakdown[field], amount]);
}

/**
 * Date-range accounting view. Direct activity is attributed to its persisted
 * Vietnam work/record date; monthly costs are accrued across the days on which
 * the store existed and was active. This keeps range totals equal to timeline
 * totals and prevents salary from appearing before a store existed.
 */
export async function storeDateRangeFinance(
  db: Db,
  storeId: string,
  range: LocalDateRange,
): Promise<StoreDateRangeFinance | null> {
  const store = await db.prepare("SELECT id, name, address, status, created_at AS createdAt FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(storeId).first<StoreRow>();
  const bounds = dateRangeBoundsUtc(range);
  if (!store) return null;
  const createdDate = localDate(new Date(store.createdAt));
  if (!createdDate || createdDate > range.to) return null;

  const periods = periodsInRange(range);
  const [shiftResult, recordResult, auditResult, monthlyFinances] = await Promise.all([
    db.prepare(`
      SELECT s.employee_id AS employeeId, s.work_date AS workDate, s.started_at AS startedAt,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END AS durationSeconds,
        COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
        COALESCE(s.cash_revenue, 0) AS cashRevenue,
        COALESCE(s.transfer_revenue, 0) AS transferRevenue,
        COALESCE(s.expense_amount, 0) AS incidentalExpense,
        COALESCE(s.tiktok_allowance, 0) AS tiktokAllowance
      FROM shift_sessions s
      JOIN employees e ON e.id = s.employee_id
      WHERE s.store_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
          OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
        )
      ORDER BY COALESCE(NULLIF(s.work_date, ''), s.started_at)
    `).bind(storeId, bounds.localStart, bounds.localEnd, bounds.startUtc, bounds.endUtc).all<RangeShiftRow>(),
    db.prepare(`
      SELECT category, data_json AS dataJson
      FROM business_records
      WHERE store_id = ? AND status != 'DELETED'
        AND category IN ('DONG_TIEN', 'NHAP_HANG', 'LUONG_THUONG')
        AND json_extract(data_json, '$.date') >= ? AND json_extract(data_json, '$.date') < ?
      ORDER BY json_extract(data_json, '$.date'), created_at
    `).bind(storeId, bounds.localStart, bounds.localEnd).all<RangeRecordRow>(),
    db.prepare(`
      SELECT detail, created_at AS createdAt FROM audit_logs
      WHERE entity_type = 'STORE' AND entity_id = ? AND action = 'STORE_STATUS_CHANGE'
      ORDER BY created_at
    `).bind(storeId).all<StoreStatusAuditRow>(),
    Promise.all(periods.map((period) => storePeriodFinance(db, storeId, period))),
  ]);

  const timeline = localDateRangeKeys(range).map<StoreRangeFinanceDay>((date) => ({
    date,
    revenue: 0,
    expense: 0,
    profit: 0,
    expenseBreakdown: emptyExpenseBreakdown(),
  }));
  const days = new Map(timeline.map((day) => [day.date, day]));

  for (const shift of shiftResult.results) {
    const date = shiftAccountingDate(shift.workDate, shift.startedAt);
    const day = days.get(date);
    if (!day) continue;
    const seconds = Math.max(0, Math.round(Number(shift.durationSeconds ?? 0)));
    const hourlyRate = requireVnd(Math.max(0, Math.round(Number(shift.appliedHourlyRate ?? 0))), "Lương theo giờ");
    day.revenue = sumVnd([day.revenue, safeVnd(shift.cashRevenue), safeVnd(shift.transferRevenue)]);
    addDayExpense(day, "incidentalCosts", safeVnd(shift.incidentalExpense));
    addDayExpense(day, "employeeBaseSalary", multiplyRatioVnd(hourlyRate, seconds, 3_600));
    addDayExpense(day, "tiktokAllowance", safeVnd(shift.tiktokAllowance));
  }

  for (const row of recordResult.results) {
    const data = parseObject(row.dataJson);
    const day = days.get(String(data.date ?? ""));
    if (!day) continue;
    if (row.category === "DONG_TIEN") addDayExpense(day, "incidentalCosts", safeVnd(data.amount));
    if (row.category === "NHAP_HANG") {
      const inventory = inventoryTotals(data);
      addDayExpense(day, "inventoryGoods", inventory.goods);
      addDayExpense(day, "inventoryShipping", inventory.shipping);
    }
    if (row.category === "LUONG_THUONG" && data.kind === "ALLOWANCE") addDayExpense(day, "manualAllowance", safeVnd(data.amount));
    if (row.category === "LUONG_THUONG" && data.kind === "BONUS") addDayExpense(day, "manualBonus", safeVnd(data.amount));
  }

  const transitions = parseStoreTransitions(auditResult.results);
  const activeDayCount = timeline.reduce(
    (count, day) => count + (storeIsActiveOnDate(createdDate, transitions, day.date) ? 1 : 0),
    0,
  );
  if (activeDayCount === 0) return null;
  const periodStatuses: StoreDateRangeFinance["periodStatuses"] = [];
  monthlyFinances.forEach((finance, index) => {
    if (!finance) return;
    const period = periods[index];
    periodStatuses.push({
      period,
      calculationStatus: finance.calculationStatus,
      settlementStatus: finance.settlementStatus,
    });
    const eligibleDates = localDateRangeKeys(localMonthRange(period))
      .filter((date) => storeIsActiveOnDate(createdDate, transitions, date));
    allocateMonthlyExpense(finance.expenseBreakdown.fixedCosts, "fixedCosts", eligibleDates, days);
    allocateMonthlyExpense(finance.expenseBreakdown.supportAllowance, "supportAllowance", eligibleDates, days);
    allocateMonthlyExpense(finance.expenseBreakdown.managerSalary, "managerSalary", eligibleDates, days);
    if (finance.calculationStatus === "LOCKED") {
      allocateMonthlyExpense(finance.expenseBreakdown.employeeKpiBonus, "employeeKpiBonus", eligibleDates, days);
      allocateMonthlyExpense(finance.expenseBreakdown.managerBonus, "managerBonus", eligibleDates, days);
    }
  });

  for (const day of timeline) {
    day.expense = sumVnd(Object.values(day.expenseBreakdown));
    day.profit = day.revenue - day.expense;
  }
  const expenseBreakdown = Object.fromEntries(Object.keys(emptyExpenseBreakdown()).map((field) => [
    field,
    sumVnd(timeline.map((day) => day.expenseBreakdown[field as keyof StoreExpenseBreakdown])),
  ])) as StoreExpenseBreakdown;
  const revenue = sumVnd(timeline.map((day) => day.revenue));
  const expense = sumVnd(timeline.map((day) => day.expense));
  const performanceRewards = sumVnd([expenseBreakdown.employeeKpiBonus, expenseBreakdown.managerBonus]);
  return {
    ...store,
    range,
    activeDayCount,
    revenue,
    expense,
    profit: revenue - expense,
    profitBeforePerformanceRewards: revenue - (expense - performanceRewards),
    expenseBreakdown,
    calculationStatus: periodStatuses.length > 0 && periodStatuses.every((item) => item.calculationStatus === "LOCKED") ? "LOCKED" : "PROVISIONAL",
    settlementStatus: periodStatuses.length > 0 && periodStatuses.every((item) => item.settlementStatus === "LOCKED")
      ? "LOCKED"
      : periodStatuses.some((item) => item.settlementStatus === "PAYMENT_CONFIRMED" || item.settlementStatus === "LOCKED")
        ? "PAYMENT_CONFIRMED"
        : "OPEN",
    periodStatuses,
    timeline,
  };
}
