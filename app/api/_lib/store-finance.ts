import { initDb } from "../../../db/runtime";
import {
  type LocalDateRange,
  dateRangeBoundsUtc,
  localDate,
  localDateRangeKeys,
  localMonthRange,
  multiplyRatioVnd,
  periodBoundsUtc,
  requireVnd,
  shiftAccountingDate,
  storeExistsInPeriod,
  sumVnd,
} from "../../lib/finance";
import { calculateFinance, FINANCE_COMPONENTS } from "../../lib/finance-engine";
import { calculateKpi } from "../../lib/kpi-engine";
import type { PayrollPolicySnapshot } from "../../lib/payroll-policy";
import { loadFinancialPolicyForPeriod } from "./financial-policy";
import { parsePersistedFinancialPeriodSnapshot } from "./financial-period";

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
  appliedHourlyRate: number | null;
  incidentalExpense: number;
  tiktokAllowance: number;
  transferId: string | null;
  supportAllowance: number | null;
};

type OrderFinanceRow = {
  amount: number;
};

type FinancialPeriodRow = {
  status: "DRAFT" | "CALCULATED" | "RECONCILING" | "CONFIRMED" | "PAID" | "LOCKED";
  grossRevenue: number;
  fixedExpense: number;
  variableExpense: number;
  inventoryCost: number;
  inventoryShippingCost: number;
  employeeSalary: number;
  managerSalary: number;
  manualBonus: number;
  allowance: number;
  employeeKpiTotal: number;
  managerKpi: number;
  operatingProfit: number;
  profitAfterKpi: number;
  monthEndExpense: number;
  finalProfit: number;
  distributableProfit: number;
  configVersion: number | null;
  policyVersionId: string | null;
  snapshotJson: string;
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
  monthEndExpenses: number;
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
  operatingProfit: number;
  profitAfterKpi: number;
  finalProfit: number;
  distributableProfit: number;
  monthEndExpense: number;
  expenseBreakdown: StoreExpenseBreakdown;
  calculationStatus: "PROVISIONAL" | "CALCULATED" | "RECONCILING" | "CONFIRMED" | "PAID" | "LOCKED";
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

function requireAppliedHourlyRate(value: unknown, employeeId: string) {
  if (value === null || value === undefined) {
    throw new Error(`Thiếu snapshot mức lương cho nhân viên ${employeeId}.`);
  }
  return requireVnd(Number(value), `Mức lương đã áp dụng của nhân viên ${employeeId}`);
}

type FinancePolicyInput = Readonly<{
  managerMonthlySalaryVnd: number;
  managerKpiRateBasisPoints: number;
  employeeKpiTiers: readonly PayrollPolicySnapshot["employeeKpiTiers"][number][];
}>;

function payrollKpiConfig(policy: FinancePolicyInput) {
  return {
    managerRateBps: policy.managerKpiRateBasisPoints,
    tiers: policy.employeeKpiTiers.map((tier) => ({
      minProfitPerHour: tier.minimumProfitPerHour,
      employeeRateBps: tier.rateBasisPoints,
    })),
  };
}

function immutableFinancialPeriod(status: FinancialPeriodRow["status"]) {
  return status === "CONFIRMED" || status === "PAID" || status === "LOCKED";
}

function periodStatusPayload(status: FinancialPeriodRow["status"]) {
  return status === "LOCKED"
    ? { calculationStatus: "LOCKED" as const, settlementStatus: "LOCKED" as const }
    : status === "PAID"
      ? { calculationStatus: "PAID" as const, settlementStatus: "PAYMENT_CONFIRMED" as const }
      : status === "CONFIRMED"
        ? { calculationStatus: "CONFIRMED" as const, settlementStatus: "OPEN" as const }
        : status === "RECONCILING"
          ? { calculationStatus: "RECONCILING" as const, settlementStatus: "OPEN" as const }
          : status === "CALCULATED"
            ? { calculationStatus: "CALCULATED" as const, settlementStatus: "OPEN" as const }
            : { calculationStatus: "PROVISIONAL" as const, settlementStatus: "OPEN" as const };
}

function financialPeriodResult(store: StoreRow, period: string, row: FinancialPeriodRow): StorePeriodFinance {
  const persistedSnapshot = parsePersistedFinancialPeriodSnapshot(row.snapshotJson);
  if (persistedSnapshot.storeId !== store.id
    || persistedSnapshot.period !== period
    || persistedSnapshot.status !== row.status
    || persistedSnapshot.configVersion !== Number(row.configVersion)
    || !row.policyVersionId) {
    throw new Error(`Snapshot kỳ tài chính ${store.id}/${period} không khớp danh tính hoặc cấu hình đã chốt.`);
  }
  const rowFinance = calculateFinance({
    grossRevenue: requireVnd(Number(row.grossRevenue), "Doanh thu snapshot"),
    fixedExpense: requireVnd(Number(row.fixedExpense), "Chi phí cố định snapshot"),
    variableExpense: requireVnd(Number(row.variableExpense), "Chi phí phát sinh snapshot"),
    inventoryCost: requireVnd(Number(row.inventoryCost), "Chi phí nhập hàng snapshot"),
    inventoryShippingCost: requireVnd(Number(row.inventoryShippingCost), "Chi phí vận chuyển snapshot"),
    employeeSalary: requireVnd(Number(row.employeeSalary), "Lương nhân viên snapshot"),
    managerSalary: requireVnd(Number(row.managerSalary), "Lương quản lý snapshot"),
    manualEmployeeBonus: requireVnd(Number(row.manualBonus), "Thưởng nhân viên snapshot"),
    employeeAllowance: requireVnd(Number(row.allowance), "Phụ cấp snapshot"),
    employeeKpiTotal: requireVnd(Number(row.employeeKpiTotal), "KPI nhân viên snapshot"),
    managerKpi: requireVnd(Number(row.managerKpi), "KPI quản lý snapshot"),
    monthEndExpense: requireVnd(Number(row.monthEndExpense), "Chi phí cuối kỳ snapshot"),
  });
  if (rowFinance.operatingProfit !== Number(row.operatingProfit)
    || rowFinance.profitAfterKpi !== Number(row.profitAfterKpi)
    || rowFinance.finalProfit !== Number(row.finalProfit)
    || rowFinance.distributableProfit !== Number(row.distributableProfit)
    || FINANCE_COMPONENTS.some((component) => rowFinance[component] !== persistedSnapshot.finance[component])
    || rowFinance.operatingProfit !== persistedSnapshot.finance.operatingProfit
    || rowFinance.profitAfterKpi !== persistedSnapshot.finance.profitAfterKpi
    || rowFinance.finalProfit !== persistedSnapshot.finance.finalProfit
    || rowFinance.distributableProfit !== persistedSnapshot.finance.distributableProfit) {
    throw new Error(`Kỳ tài chính ${store.id}/${period} không khớp Finance Engine.`);
  }
  const finance = persistedSnapshot.finance;
  const snapshot = parseObject(row.snapshotJson);
  const savedBreakdown = snapshot.expenseBreakdown && typeof snapshot.expenseBreakdown === "object"
    && !Array.isArray(snapshot.expenseBreakdown)
    ? snapshot.expenseBreakdown as Record<string, unknown>
    : {};
  const breakdownVnd = (field: string, fallback: number) => Object.hasOwn(savedBreakdown, field)
    ? requireVnd(Number(savedBreakdown[field]), `expenseBreakdown.${field}`)
    : requireVnd(Number(fallback), `expenseBreakdown.${field}`);
  const tiktokAllowance = breakdownVnd("tiktokAllowance", 0);
  const supportAllowance = breakdownVnd("supportAllowance", 0);
  const manualAllowance = Object.hasOwn(savedBreakdown, "manualAllowance")
    ? breakdownVnd("manualAllowance", 0)
    : requireVnd(rowFinance.employeeAllowance - tiktokAllowance - supportAllowance, "expenseBreakdown.manualAllowance");
  if (sumVnd([tiktokAllowance, supportAllowance, manualAllowance]) !== rowFinance.employeeAllowance) {
    throw new Error(`Tính toàn vẹn cơ cấu chi phí kỳ ${store.id}/${period} không khớp Finance Engine (phụ cấp).`);
  }
  const expenseBreakdown: StoreExpenseBreakdown = {
    fixedCosts: breakdownVnd("fixedCosts", row.fixedExpense),
    incidentalCosts: breakdownVnd("incidentalCosts", row.variableExpense),
    inventoryGoods: breakdownVnd("inventoryGoods", row.inventoryCost),
    inventoryShipping: breakdownVnd("inventoryShipping", row.inventoryShippingCost),
    employeeBaseSalary: breakdownVnd("employeeBaseSalary", row.employeeSalary),
    tiktokAllowance,
    supportAllowance,
    manualAllowance,
    manualBonus: breakdownVnd("manualBonus", row.manualBonus),
    managerSalary: breakdownVnd("managerSalary", row.managerSalary),
    employeeKpiBonus: breakdownVnd("employeeKpiBonus", row.employeeKpiTotal),
    managerBonus: breakdownVnd("managerBonus", row.managerKpi),
    monthEndExpenses: breakdownVnd("monthEndExpenses", row.monthEndExpense),
  };
  const directComponentChecks = [
    ["fixedCosts", "fixedExpense"],
    ["incidentalCosts", "variableExpense"],
    ["inventoryGoods", "inventoryCost"],
    ["inventoryShipping", "inventoryShippingCost"],
    ["employeeBaseSalary", "employeeSalary"],
    ["manualBonus", "manualEmployeeBonus"],
    ["managerSalary", "managerSalary"],
    ["employeeKpiBonus", "employeeKpiTotal"],
    ["managerBonus", "managerKpi"],
    ["monthEndExpenses", "monthEndExpense"],
  ] as const satisfies readonly (readonly [keyof StoreExpenseBreakdown, keyof typeof finance])[];
  const mismatchedBucket = directComponentChecks.find(
    ([bucket, component]) => expenseBreakdown[bucket] !== finance[component],
  );
  if (mismatchedBucket) {
    throw new Error(
      `Tính toàn vẹn cơ cấu chi phí kỳ ${store.id}/${period} không khớp Finance Engine (${mismatchedBucket[0]}).`,
    );
  }

  const displayedTotal = sumVnd(Object.values(expenseBreakdown));
  const savedTotalFields = ["totalExpense", "total"] as const;
  const mismatchedSavedTotal = savedTotalFields.find((field) => (
    Object.hasOwn(savedBreakdown, field)
      && breakdownVnd(field, finance.totalExpense) !== finance.totalExpense
  ));
  if (displayedTotal !== finance.totalExpense || mismatchedSavedTotal) {
    throw new Error(`Tính toàn vẹn cơ cấu chi phí kỳ ${store.id}/${period} không khớp Finance Engine (tổng chi phí).`);
  }
  const status = periodStatusPayload(row.status);
  return {
    ...store,
    period,
    revenue: finance.grossRevenue,
    expense: finance.totalExpense,
    profit: finance.finalProfit,
    profitBeforePerformanceRewards: finance.operatingProfit,
    operatingProfit: finance.operatingProfit,
    profitAfterKpi: finance.profitAfterKpi,
    finalProfit: finance.finalProfit,
    distributableProfit: finance.distributableProfit,
    monthEndExpense: finance.monthEndExpense,
    expenseBreakdown,
    ...status,
  };
}

function inventoryTotals(data: Record<string, unknown>) {
  const storedGoodsTotal = safeVnd(data.goodsTotal);
  const storedShippingTotal = safeVnd(data.shippingTotal);
  if (data.goodsTotal === 0 || storedGoodsTotal > 0 || data.shippingTotal === 0 || storedShippingTotal > 0) {
    const storedTotal = safeVnd(data.total);
    if (storedTotal > 0 || data.total === 0) {
      // Canonical receipt payloads persist both component totals. Trust those
      // server-calculated integers so the financial report cannot reinterpret
      // historical item shapes differently from the inventory ledger.
      return { goods: storedGoodsTotal, shipping: storedShippingTotal };
    }
  }

  const rawItems = Array.isArray(data.items) ? data.items : [data];
  return rawItems.reduce((total, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return total;
    const row = item as Record<string, unknown>;
    const shipping = safeVnd(row.shipping);
    const storedAmount = safeVnd(row.amount);
    const hasStoredAmount = storedAmount > 0 || row.amount === 0;
    const storedGoods = safeVnd(row.goodsAmount);
    const hasStoredGoods = storedGoods > 0 || row.goodsAmount === 0;
    const weight = Number(row.weight);
    const unitPrice = safeVnd(row.unitPrice);
    const calculatedGoods = Number.isFinite(weight) && weight >= 0
      ? safeVnd(Math.round(weight * unitPrice))
      : 0;
    const goods = hasStoredGoods
      ? storedGoods
      : hasStoredAmount
        ? Math.max(0, storedAmount - shipping)
        : calculatedGoods;
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

export async function storePeriodFinance(
  db: Db,
  storeId: string,
  period: string,
  requestedFinancePolicy?: FinancePolicyInput,
): Promise<StorePeriodFinance | null> {
  // The compatibility argument remains available for isolated legacy tests.
  // Production callers resolve the immutable policy version effective for the
  // requested period, so a later policy edit cannot restate an earlier month.
  const payrollPolicy: FinancePolicyInput = requestedFinancePolicy
    ?? (await loadFinancialPolicyForPeriod(db, period)).policy;
  const store = await db.prepare("SELECT id, name, address, status, created_at AS createdAt FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(storeId).first<StoreRow>();
  if (!store || !storeExistsInPeriod(store.createdAt, period)) return null;

  const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
  const persistedPeriod = await db.prepare(`SELECT
      status,
      gross_revenue AS grossRevenue,
      fixed_expense AS fixedExpense,
      variable_expense AS variableExpense,
      inventory_cost AS inventoryCost,
      inventory_shipping_cost AS inventoryShippingCost,
      employee_salary AS employeeSalary,
      manager_salary AS managerSalary,
      manual_bonus AS manualBonus,
      allowance,
      employee_kpi_total AS employeeKpiTotal,
      manager_kpi AS managerKpi,
      operating_profit AS operatingProfit,
      profit_after_kpi AS profitAfterKpi,
      month_end_expense AS monthEndExpense,
      final_profit AS finalProfit,
      distributable_profit AS distributableProfit,
      config_version AS configVersion,
      policy_version_id AS policyVersionId,
      snapshot_json AS snapshotJson
    FROM financial_periods WHERE store_id = ? AND period = ? LIMIT 1`)
    .bind(storeId, period).first<FinancialPeriodRow>();
  if (persistedPeriod && immutableFinancialPeriod(persistedPeriod.status)) {
    return financialPeriodResult(store, period, persistedPeriod);
  }
  const [shiftResult, orderResult, fixedResult, incidentalResult, inventoryResult, adjustmentResult, monthEndResult, snapshotRow, closingRow] = await Promise.all([
    db.prepare(`
      SELECT
        s.employee_id AS employeeId,
        COALESCE(s.admin_adjusted_duration_seconds,
          CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
            ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END) AS durationSeconds,
        COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
        COALESCE(s.expense_amount, 0) AS incidentalExpense,
        COALESCE(s.tiktok_allowance, 0) AS tiktokAllowance,
        s.transfer_id AS transferId,
        COALESCE(s.applied_support_allowance, 0) AS supportAllowance
      FROM shift_sessions s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.store_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
        AND COALESCE(s.reconciliation_status, 'CLEAR') IN ('CLEAR', 'CONFIRMED')
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
          OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
        )
    `).bind(storeId, localStart, localEnd, startUtc, endUtc).all<ShiftFinanceRow>(),
    db.prepare(`SELECT amount
      FROM orders
      WHERE store_id = ? AND status = 'COMPLETED'
        AND created_at >= ? AND created_at < ?`)
      .bind(storeId, startUtc, endUtc).all<OrderFinanceRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'CHI_PHI_CO_DINH' AND store_id = ? AND status NOT IN ('DELETED', 'VOID') AND json_extract(data_json, '$.period') = ?")
      .bind(storeId, period).all<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'DONG_TIEN' AND store_id = ? AND status != 'DELETED' AND (json_extract(data_json, '$.period') = ? OR substr(json_extract(data_json, '$.date'), 1, 7) = ?)")
      .bind(storeId, period, period).all<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'NHAP_HANG' AND store_id = ? AND status != 'DELETED' AND (json_extract(data_json, '$.period') = ? OR substr(json_extract(data_json, '$.date'), 1, 7) = ?)")
      .bind(storeId, period, period).all<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'LUONG_THUONG' AND store_id = ? AND status != 'DELETED' AND substr(json_extract(data_json, '$.date'), 1, 7) = ?")
      .bind(storeId, period).all<RecordRow>(),
    db.prepare("SELECT amount FROM month_end_expenses WHERE store_id = ? AND period = ? AND status = 'ACTIVE'")
      .bind(storeId, period).all<{ amount: number }>(),
    db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'KPI_SUMMARY' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(storeId, period).first<RecordRow>(),
    db.prepare("SELECT data_json AS dataJson, status FROM business_records WHERE category = 'PAYROLL_CLOSING' AND store_id = ? AND status != 'DELETED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(storeId, period).first<RecordRow & { status: string }>(),
  ]);

  const revenue = sumVnd(orderResult.results.map((row) => safeVnd(row.amount)));
  let incidentalCosts = 0;
  let employeeBaseSalary = 0;
  let tiktokAllowance = 0;
  const secondsByEmployee = new Map<string, number>();
  const salarySecondsByEmployeeRate = new Map<string, { hourlyRate: number; seconds: number }>();
  const supportByTransfer = new Map<string, number>();
  for (const row of shiftResult.results) {
    const seconds = Math.max(0, Math.round(Number(row.durationSeconds ?? 0)));
    const hourlyRate = requireAppliedHourlyRate(row.appliedHourlyRate, row.employeeId);
    incidentalCosts = sumVnd([incidentalCosts, safeVnd(row.incidentalExpense)]);
    const salaryGroupKey = JSON.stringify([row.employeeId, hourlyRate]);
    const salaryGroup = salarySecondsByEmployeeRate.get(salaryGroupKey);
    salarySecondsByEmployeeRate.set(salaryGroupKey, {
      hourlyRate,
      seconds: (salaryGroup?.seconds ?? 0) + seconds,
    });
    tiktokAllowance = sumVnd([tiktokAllowance, safeVnd(row.tiktokAllowance)]);
    // KPI uses the actual hours recorded at this store. Employment status at
    // query time must not erase work that was actually completed in the period.
    secondsByEmployee.set(row.employeeId, (secondsByEmployee.get(row.employeeId) ?? 0) + seconds);
    if (row.transferId && seconds > 0) supportByTransfer.set(row.transferId, safeVnd(row.supportAllowance));
  }
  // Payroll groups actual seconds by employee and snapshotted hourly rate, then
  // rounds the resulting VND amount once. Finance must use the same boundary so
  // many short shifts cannot introduce a 1-2 VND reconciliation mismatch.
  employeeBaseSalary = sumVnd([...salarySecondsByEmployeeRate.values()].map(({ hourlyRate, seconds }) =>
    multiplyRatioVnd(hourlyRate, seconds, 3_600)));
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
  const monthEndExpense = sumVnd(monthEndResult.results.map((row) => safeVnd(row.amount)));
  const lockedSnapshot = snapshotRow ? parseObject(snapshotRow.dataJson) : null;
  // A locked KPI snapshot owns the manager salary used for that period. A
  // later global policy update must never restate historical accounting.
  const managerSalary = lockedSnapshot
    ? safeVnd(lockedSnapshot.managerSalary)
    : payrollPolicy.managerMonthlySalaryVnd;
  const employeeAllowance = sumVnd([tiktokAllowance, supportAllowance, manualAllowance]);
  const operatingStage = calculateFinance({
    grossRevenue: revenue,
    fixedExpense: fixedCosts,
    variableExpense: incidentalCosts,
    inventoryCost: inventory.goods,
    inventoryShippingCost: inventory.shipping,
    employeeSalary: employeeBaseSalary,
    managerSalary,
    manualEmployeeBonus: manualBonus,
    employeeAllowance,
    employeeKpiTotal: 0,
    managerKpi: 0,
    monthEndExpense,
  });
  const provisionalKpi = lockedSnapshot ? null : calculateKpi({
    operatingProfit: operatingStage.operatingProfit,
    employees: [...secondsByEmployee].map(([employeeId, actualSeconds]) => ({ employeeId, actualSeconds })),
    config: payrollKpiConfig(payrollPolicy),
  });
  const employeeKpiBonus = lockedSnapshot
    ? safeVnd(lockedSnapshot.totalKpiBonus)
    : provisionalKpi?.employeeKpiTotal ?? 0;
  const managerBonus = lockedSnapshot
    ? safeVnd(lockedSnapshot.managerBonus)
    : provisionalKpi?.managerKpi ?? 0;
  const finance = calculateFinance({
    grossRevenue: operatingStage.grossRevenue,
    fixedExpense: operatingStage.fixedExpense,
    variableExpense: operatingStage.variableExpense,
    inventoryCost: operatingStage.inventoryCost,
    inventoryShippingCost: operatingStage.inventoryShippingCost,
    employeeSalary: operatingStage.employeeSalary,
    managerSalary: operatingStage.managerSalary,
    manualEmployeeBonus: operatingStage.manualEmployeeBonus,
    employeeAllowance: operatingStage.employeeAllowance,
    employeeKpiTotal: employeeKpiBonus,
    managerKpi: managerBonus,
    monthEndExpense: operatingStage.monthEndExpense,
  });
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
    managerSalary,
    employeeKpiBonus,
    managerBonus,
    monthEndExpenses: monthEndExpense,
  };
  const persistedStatus = persistedPeriod ? periodStatusPayload(persistedPeriod.status) : null;
  const legacySettlementStatus = closingRow?.status === "LOCKED"
    ? "LOCKED" as const
    : closingRow?.status === "PAYMENT_CONFIRMED" || Boolean(closingRow && parseObject(closingRow.dataJson).paymentConfirmedAt)
      ? "PAYMENT_CONFIRMED" as const
      : "OPEN" as const;

  return {
    ...store,
    period,
    revenue,
    expense: finance.totalExpense,
    profit: finance.finalProfit,
    profitBeforePerformanceRewards: finance.operatingProfit,
    operatingProfit: finance.operatingProfit,
    profitAfterKpi: finance.profitAfterKpi,
    finalProfit: finance.finalProfit,
    distributableProfit: finance.distributableProfit,
    monthEndExpense: finance.monthEndExpense,
    expenseBreakdown,
    // A legacy KPI summary can preserve historical KPI components, but it is
    // not a financial-period lock and must never make live revenue/expenses
    // eligible for settlement or profit sharing. Lifecycle ownership belongs
    // exclusively to financial_periods.
    calculationStatus: persistedStatus?.calculationStatus ?? "PROVISIONAL",
    settlementStatus: persistedStatus?.settlementStatus ?? legacySettlementStatus,
  };
}

type RangeShiftRow = {
  employeeId: string;
  workDate: string | null;
  startedAt: string;
  durationSeconds: number;
  appliedHourlyRate: number | null;
  incidentalExpense: number;
  tiktokAllowance: number;
};

type RangeOrderRow = {
  workDate: string | null;
  createdAt: string;
  amount: number;
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
    calculationStatus: StorePeriodFinance["calculationStatus"];
    settlementStatus: "OPEN" | "PAYMENT_CONFIRMED" | "LOCKED";
  }>;
};

type StoreDateRangeFinanceOptions = {
  fixedCostRecognition?: "ACCRUAL" | "FULL_ENDING_PERIOD";
  payrollRecognition?: "SETTLED" | "PREVIEW";
  payrollPolicy?: FinancePolicyInput;
};

const FULL_PERIOD_PREVIEW_FIELDS = [
  "fixedCosts",
  "managerSalary",
  "employeeKpiBonus",
  "managerBonus",
  "monthEndExpenses",
] as const satisfies readonly (keyof StoreExpenseBreakdown)[];

function financeFromBreakdown(revenue: number, breakdown: StoreExpenseBreakdown) {
  return calculateFinance({
    grossRevenue: safeVnd(revenue),
    fixedExpense: safeVnd(breakdown.fixedCosts),
    variableExpense: safeVnd(breakdown.incidentalCosts),
    inventoryCost: safeVnd(breakdown.inventoryGoods),
    inventoryShippingCost: safeVnd(breakdown.inventoryShipping),
    employeeSalary: safeVnd(breakdown.employeeBaseSalary),
    managerSalary: safeVnd(breakdown.managerSalary),
    manualEmployeeBonus: safeVnd(breakdown.manualBonus),
    employeeAllowance: sumVnd([
      safeVnd(breakdown.tiktokAllowance),
      safeVnd(breakdown.supportAllowance),
      safeVnd(breakdown.manualAllowance),
    ]),
    employeeKpiTotal: safeVnd(breakdown.employeeKpiBonus),
    managerKpi: safeVnd(breakdown.managerBonus),
    monthEndExpense: safeVnd(breakdown.monthEndExpenses),
  });
}

function recognizeFullPeriodExpenseFields(
  rangeFinance: StoreDateRangeFinance,
  periodFinance: StorePeriodFinance,
  fields: readonly (keyof StoreExpenseBreakdown)[],
): StoreDateRangeFinance {
  const targetPeriod = periodFinance.period;
  const targetPeriodDays = rangeFinance.timeline.filter((day) => day.date.slice(0, 7) === targetPeriod);
  if (targetPeriodDays.length === 0) return rangeFinance;

  const nextAmounts = new Map<keyof StoreExpenseBreakdown, number>();
  for (const field of fields) {
    const amountOutsideTargetPeriod = sumVnd(rangeFinance.timeline
      .filter((day) => day.date.slice(0, 7) !== targetPeriod)
      .map((day) => requireVnd(day.expenseBreakdown[field], `Chi phí ${field} ngoài kỳ đối soát`)));
    nextAmounts.set(field, sumVnd([
      amountOutsideTargetPeriod,
      requireVnd(periodFinance.expenseBreakdown[field], `Chi phí ${field} theo tháng`),
    ]));
  }
  if (fields.every((field) => nextAmounts.get(field) === rangeFinance.expenseBreakdown[field])) {
    return rangeFinance;
  }

  const targetIndexes = rangeFinance.timeline.flatMap((day, index) => (
    day.date.slice(0, 7) === targetPeriod ? [index] : []
  ));
  const allocations = new Map<keyof StoreExpenseBreakdown, Map<number, number>>();
  for (const field of fields) {
    const periodAmount = requireVnd(periodFinance.expenseBreakdown[field], `Chi phí ${field} theo tháng`);
    const existingIndexes = targetIndexes.filter((index) => rangeFinance.timeline[index].expenseBreakdown[field] > 0);
    const allocationIndexes = existingIndexes.length > 0
      ? existingIndexes
      : periodAmount > 0
        ? targetIndexes.slice(-1)
        : [];
    const count = allocationIndexes.length;
    const base = count > 0 ? Math.floor(periodAmount / count) : 0;
    const remainder = count > 0 ? periodAmount % count : 0;
    allocations.set(field, new Map(allocationIndexes.map((index, allocationIndex) => [
      index,
      base + (allocationIndex < remainder ? 1 : 0),
    ])));
  }

  const timeline = rangeFinance.timeline.map((day, index) => {
    if (day.date.slice(0, 7) !== targetPeriod) return day;
    const expenseBreakdown = { ...day.expenseBreakdown };
    for (const field of fields) expenseBreakdown[field] = allocations.get(field)?.get(index) ?? 0;
    const finance = financeFromBreakdown(day.revenue, expenseBreakdown);
    return { ...day, expenseBreakdown, expense: finance.totalExpense, profit: finance.finalProfit };
  });
  const expenseBreakdown = { ...rangeFinance.expenseBreakdown };
  for (const field of fields) expenseBreakdown[field] = nextAmounts.get(field) ?? expenseBreakdown[field];
  const finance = financeFromBreakdown(rangeFinance.revenue, expenseBreakdown);
  return {
    ...rangeFinance,
    expenseBreakdown,
    expense: finance.totalExpense,
    profit: finance.finalProfit,
    profitBeforePerformanceRewards: finance.operatingProfit,
    operatingProfit: finance.operatingProfit,
    profitAfterKpi: finance.profitAfterKpi,
    finalProfit: finance.finalProfit,
    distributableProfit: finance.distributableProfit,
    monthEndExpense: finance.monthEndExpense,
    timeline,
  };
}

/**
 * Replace the accrued fixed-cost portion for one month with that month's full
 * configured amount. Any fixed-cost accrual from another month in the same
 * date range is preserved, which is required when a comparable range crosses
 * a month boundary. This is a replacement, not an addition: store totals,
 * profit and the daily timeline are rebuilt from the reconciled breakdown.
 */
export function recognizeFullPeriodFixedCosts(
  rangeFinance: StoreDateRangeFinance,
  periodFinance: StorePeriodFinance,
): StoreDateRangeFinance {
  return recognizeFullPeriodExpenseFields(rangeFinance, periodFinance, ["fixedCosts"]);
}

export function recognizeFullPeriodFinancialPreview(
  rangeFinance: StoreDateRangeFinance,
  periodFinance: StorePeriodFinance,
) {
  return recognizeFullPeriodExpenseFields(rangeFinance, periodFinance, FULL_PERIOD_PREVIEW_FIELDS);
}

/** Backward-compatible name for the store overview call site. */
export function recognizeFullPeriodFixedCostsForOverview(
  rangeFinance: StoreDateRangeFinance,
  periodFinance: StorePeriodFinance,
) {
  return recognizeFullPeriodFixedCosts(rangeFinance, periodFinance);
}

export function recognizeFullPeriodFinancialPreviewForOverview(
  rangeFinance: StoreDateRangeFinance,
  periodFinance: StorePeriodFinance,
) {
  return recognizeFullPeriodFinancialPreview(rangeFinance, periodFinance);
}

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
    monthEndExpenses: 0,
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
 * Recognize a monthly amount once, on the payroll period's closing date. The
 * store must have had at least one active day in the period, while the selected
 * date-range map decides whether that closing date belongs to the requested
 * slice. A partial daily report therefore cannot accrue a fraction of the fixed
 * manager salary before month close.
 */
function addMonthlyExpenseAtClose(
  amount: number,
  field: keyof StoreExpenseBreakdown,
  closeDate: string,
  eligibleDates: string[],
  selectedDays: Map<string, StoreRangeFinanceDay>,
) {
  if (amount <= 0 || eligibleDates.length === 0) return;
  const day = selectedDays.get(closeDate);
  if (day) addDayExpense(day, field, amount);
}

/**
 * Date-range accounting view. Direct activity is attributed to its persisted
 * Vietnam work/record date. Recurring operating costs are accrued across the
 * days on which the store existed and was active, while the fixed manager
 * salary is recognized once at that store-period's close. This keeps range
 * totals equal to timeline totals without inventing a daily manager salary.
 */
export async function storeDateRangeFinance(
  db: Db,
  storeId: string,
  range: LocalDateRange,
  options: StoreDateRangeFinanceOptions = {},
): Promise<StoreDateRangeFinance | null> {
  const store = await db.prepare("SELECT id, name, address, status, created_at AS createdAt FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(storeId).first<StoreRow>();
  const bounds = dateRangeBoundsUtc(range);
  if (!store) return null;
  const createdDate = localDate(new Date(store.createdAt));
  if (!createdDate || createdDate > range.to) return null;

  const periods = periodsInRange(range);
  const [shiftResult, orderResult, recordResult, auditResult, monthlyFinances] = await Promise.all([
    db.prepare(`
      SELECT s.employee_id AS employeeId, s.work_date AS workDate, s.started_at AS startedAt,
        COALESCE(s.admin_adjusted_duration_seconds,
          CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
            ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END) AS durationSeconds,
        COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
        COALESCE(s.expense_amount, 0) AS incidentalExpense,
        COALESCE(s.tiktok_allowance, 0) AS tiktokAllowance
      FROM shift_sessions s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.store_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
        AND COALESCE(s.reconciliation_status, 'CLEAR') IN ('CLEAR', 'CONFIRMED')
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
          OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
        )
      ORDER BY COALESCE(NULLIF(s.work_date, ''), s.started_at)
    `).bind(storeId, bounds.localStart, bounds.localEnd, bounds.startUtc, bounds.endUtc).all<RangeShiftRow>(),
    db.prepare(`
      SELECT NULL AS workDate, created_at AS createdAt, amount
      FROM orders
      WHERE store_id = ? AND status = 'COMPLETED'
        AND created_at >= ? AND created_at < ?
      ORDER BY created_at, id
    `).bind(storeId, bounds.startUtc, bounds.endUtc).all<RangeOrderRow>(),
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
    Promise.all(periods.map((period) => storePeriodFinance(db, storeId, period, options.payrollPolicy))),
  ]);

  const timeline = localDateRangeKeys(range).map<StoreRangeFinanceDay>((date) => ({
    date,
    revenue: 0,
    expense: 0,
    profit: 0,
    expenseBreakdown: emptyExpenseBreakdown(),
  }));
  const days = new Map(timeline.map((day) => [day.date, day]));

  for (const order of orderResult.results) {
    const date = shiftAccountingDate(order.workDate, order.createdAt);
    const day = days.get(date);
    if (day) day.revenue = sumVnd([day.revenue, safeVnd(order.amount)]);
  }

  for (const shift of shiftResult.results) {
    const date = shiftAccountingDate(shift.workDate, shift.startedAt);
    const day = days.get(date);
    if (!day) continue;
    const seconds = Math.max(0, Math.round(Number(shift.durationSeconds ?? 0)));
    const hourlyRate = requireAppliedHourlyRate(shift.appliedHourlyRate, shift.employeeId);
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
    const monthRange = localMonthRange(period);
    const eligibleDates = localDateRangeKeys(monthRange)
      .filter((date) => storeIsActiveOnDate(createdDate, transitions, date));
    allocateMonthlyExpense(finance.expenseBreakdown.fixedCosts, "fixedCosts", eligibleDates, days);
    allocateMonthlyExpense(finance.expenseBreakdown.supportAllowance, "supportAllowance", eligibleDates, days);
    if (options.payrollRecognition === "PREVIEW") {
      // Financial reports and store overviews mirror the current payroll
      // preview for open periods. Locked periods still carry their immutable
      // snapshot values from storePeriodFinance.
      allocateMonthlyExpense(finance.expenseBreakdown.managerSalary, "managerSalary", eligibleDates, days);
      allocateMonthlyExpense(finance.expenseBreakdown.employeeKpiBonus, "employeeKpiBonus", eligibleDates, days);
      allocateMonthlyExpense(finance.expenseBreakdown.managerBonus, "managerBonus", eligibleDates, days);
      allocateMonthlyExpense(finance.expenseBreakdown.monthEndExpenses, "monthEndExpenses", eligibleDates, days);
    } else {
      // Cash-flow views retain settlement semantics: the manager salary is an
      // actual outflow only after payment confirmation, and KPI is recognized
      // only once its immutable calculation snapshot exists.
      if (finance.settlementStatus === "PAYMENT_CONFIRMED" || finance.settlementStatus === "LOCKED") {
        addMonthlyExpenseAtClose(finance.expenseBreakdown.managerSalary, "managerSalary", monthRange.to, eligibleDates, days);
      }
      if (finance.calculationStatus === "LOCKED") {
        allocateMonthlyExpense(finance.expenseBreakdown.employeeKpiBonus, "employeeKpiBonus", eligibleDates, days);
        allocateMonthlyExpense(finance.expenseBreakdown.managerBonus, "managerBonus", eligibleDates, days);
        addMonthlyExpenseAtClose(finance.expenseBreakdown.monthEndExpenses, "monthEndExpenses", monthRange.to, eligibleDates, days);
      }
    }
  });

  for (const day of timeline) {
    const finance = financeFromBreakdown(day.revenue, day.expenseBreakdown);
    day.expense = finance.totalExpense;
    day.profit = finance.finalProfit;
  }
  const expenseBreakdown = Object.fromEntries(Object.keys(emptyExpenseBreakdown()).map((field) => [
    field,
    sumVnd(timeline.map((day) => day.expenseBreakdown[field as keyof StoreExpenseBreakdown])),
  ])) as StoreExpenseBreakdown;
  const revenue = sumVnd(timeline.map((day) => day.revenue));
  const finance = financeFromBreakdown(revenue, expenseBreakdown);
  const rangeFinance: StoreDateRangeFinance = {
    ...store,
    range,
    activeDayCount,
    revenue,
    expense: finance.totalExpense,
    profit: finance.finalProfit,
    profitBeforePerformanceRewards: finance.operatingProfit,
    operatingProfit: finance.operatingProfit,
    profitAfterKpi: finance.profitAfterKpi,
    finalProfit: finance.finalProfit,
    distributableProfit: finance.distributableProfit,
    monthEndExpense: finance.monthEndExpense,
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
  if (options.fixedCostRecognition !== "FULL_ENDING_PERIOD") return rangeFinance;
  const endingPeriodIndex = periods.indexOf(range.to.slice(0, 7));
  const endingPeriodFinance = endingPeriodIndex >= 0 ? monthlyFinances[endingPeriodIndex] : null;
  return endingPeriodFinance
    ? options.payrollRecognition === "PREVIEW"
      ? recognizeFullPeriodFinancialPreview(rangeFinance, endingPeriodFinance)
      : recognizeFullPeriodFixedCosts(rangeFinance, endingPeriodFinance)
    : rangeFinance;
}
