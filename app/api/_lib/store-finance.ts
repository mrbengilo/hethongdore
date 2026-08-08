import { initDb } from "../../../db/runtime";
import {
  MANAGER_MONTHLY_SALARY_VND,
  multiplyRatioVnd,
  periodBoundsUtc,
  requireVnd,
  sumVnd,
} from "../../lib/finance";

type Db = Awaited<ReturnType<typeof initDb>>;

type StoreRow = {
  id: string;
  name: string;
  address: string;
  status: string;
};

type ShiftFinanceRow = {
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
  const store = await db.prepare("SELECT id, name, address, status FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(storeId).first<StoreRow>();
  if (!store) return null;

  const { startUtc, endUtc } = periodBoundsUtc(period);
  const [shiftResult, fixedResult, incidentalResult, inventoryResult, adjustmentResult, snapshotRow] = await Promise.all([
    db.prepare(`
      SELECT
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
        AND s.started_at >= ? AND s.started_at < ?
    `).bind(storeId, startUtc, endUtc).all<ShiftFinanceRow>(),
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
  ]);

  let revenue = 0;
  let incidentalCosts = 0;
  let employeeBaseSalary = 0;
  let tiktokAllowance = 0;
  const supportByTransfer = new Map<string, number>();
  for (const row of shiftResult.results) {
    const seconds = Math.max(0, Math.round(Number(row.durationSeconds ?? 0)));
    const hourlyRate = requireVnd(Math.max(0, Math.round(Number(row.appliedHourlyRate ?? 0))), "Lương theo giờ");
    revenue = sumVnd([revenue, safeVnd(row.cashRevenue), safeVnd(row.transferRevenue)]);
    incidentalCosts = sumVnd([incidentalCosts, safeVnd(row.incidentalExpense)]);
    employeeBaseSalary = sumVnd([employeeBaseSalary, multiplyRatioVnd(hourlyRate, seconds, 3_600)]);
    tiktokAllowance = sumVnd([tiktokAllowance, safeVnd(row.tiktokAllowance)]);
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

  const lockedSnapshot = snapshotRow ? parseObject(snapshotRow.dataJson) : {};
  const employeeKpiBonus = safeVnd(lockedSnapshot.totalKpiBonus);
  const managerBonus = safeVnd(lockedSnapshot.managerBonus);
  const supportAllowance = sumVnd([...supportByTransfer.values()]);

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
  const expense = sumVnd([baseExpense, employeeKpiBonus, managerBonus]);

  return {
    ...store,
    period,
    revenue,
    expense,
    profit: revenue - expense,
    profitBeforePerformanceRewards: revenue - baseExpense,
    expenseBreakdown,
  };
}
