import { initDb } from "../../../db/runtime";

type Db = Awaited<ReturnType<typeof initDb>>;
type RawRecord = Record<string, unknown>;

type FinanceEmployee = {
  id: string;
  code: string;
  name: string;
  hourlyRate: number;
  hours: number;
  salary: number;
  manualBonus: number;
  allowance: number;
  kpi: number;
  totalPay: number;
};

export type StoreFinance = {
  storeId: string;
  month: string;
  revenue: number;
  expense: number;
  profit: number;
  profitPerHour: number;
  kpiRate: number;
  employeeKpiTotal: number;
  managerKpi: number;
  distributableProfit: number;
  totalHours: number;
  expenseBreakdown: {
    fixed: number;
    variable: number;
    inventory: number;
    shipping: number;
    employeeSalary: number;
    managerSalary: number;
    employeeBonus: number;
    employeeAllowance: number;
  };
  employees: FinanceEmployee[];
  manager: { salary: number; kpi: number; totalPay: number };
};

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function currentVietnamMonth() {
  return new Date(Date.now() + VN_OFFSET_MS).toISOString().slice(0, 7);
}

export function normalizeMonth(value?: string | null) {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  return currentVietnamMonth();
}

export function previousMonth(month: string) {
  const [year, rawMonth] = normalizeMonth(month).split("-").map(Number);
  const date = new Date(Date.UTC(year, rawMonth - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthBounds(month: string) {
  const [year, rawMonth] = normalizeMonth(month).split("-").map(Number);
  const startMs = Date.UTC(year, rawMonth - 1, 1) - VN_OFFSET_MS;
  const endMs = Date.UTC(year, rawMonth, 1) - VN_OFFSET_MS;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

function localMonth(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 7);
}

function parseData(row: RawRecord) {
  try { return JSON.parse(String(row.data_json ?? "{}")) as Record<string, unknown>; }
  catch { return {}; }
}

function numeric(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function dataPeriod(row: RawRecord, data: Record<string, unknown>) {
  const explicit = String(data.period ?? data.month ?? "");
  return /^\d{4}-\d{2}$/.test(explicit) ? explicit : localMonth(row.created_at);
}

function sumItems(items: unknown, key: string) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + numeric((item as Record<string, unknown>)[key]), 0);
}

export async function calculateStoreFinance(storeId: string, monthInput?: string | null, suppliedDb?: Db): Promise<StoreFinance> {
  const month = normalizeMonth(monthInput);
  const { start, end } = monthBounds(month);
  const db = suppliedDb ?? await initDb();

  const [revenueRow, employeeResult, shiftResult, recordResult] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE store_id = ? AND status = 'COMPLETED' AND created_at >= ? AND created_at < ?").bind(storeId, start, end).first<{ total: number }>(),
    db.prepare("SELECT id, code, name, hourly_rate FROM employees WHERE store_id = ? AND status != 'ARCHIVED' ORDER BY code").bind(storeId).all(),
    db.prepare("SELECT s.employee_id, s.started_at, s.ended_at, s.tiktok_allowance, e.code, e.name, e.hourly_rate FROM shift_sessions s JOIN employees e ON e.id = s.employee_id WHERE s.store_id = ? AND s.started_at >= ? AND s.started_at < ? AND s.status != 'VOID' ORDER BY s.started_at").bind(storeId, start, end).all(),
    db.prepare("SELECT * FROM business_records WHERE store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC LIMIT 1000").bind(storeId).all(),
  ]);

  const employeeMap = new Map<string, FinanceEmployee>();
  for (const raw of employeeResult.results as RawRecord[]) {
    const id = String(raw.id);
    employeeMap.set(id, {
      id,
      code: String(raw.code ?? ""),
      name: String(raw.name ?? ""),
      hourlyRate: numeric(raw.hourly_rate),
      hours: 0,
      salary: 0,
      manualBonus: 0,
      allowance: 0,
      kpi: 0,
      totalPay: 0,
    });
  }

  const now = Date.now();
  for (const raw of shiftResult.results as RawRecord[]) {
    const employeeId = String(raw.employee_id ?? "");
    const employee = employeeMap.get(employeeId) ?? {
      id: employeeId,
      code: String(raw.code ?? ""),
      name: String(raw.name ?? ""),
      hourlyRate: numeric(raw.hourly_rate),
      hours: 0,
      salary: 0,
      manualBonus: 0,
      allowance: 0,
      kpi: 0,
      totalPay: 0,
    };
    const startedAt = new Date(String(raw.started_at)).getTime();
    const endedAt = raw.ended_at ? new Date(String(raw.ended_at)).getTime() : Math.min(now, new Date(end).getTime());
    const hours = Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt > startedAt
      ? Math.min(24, (endedAt - startedAt) / 3_600_000)
      : 0;
    employee.hours += hours;
    employee.allowance += numeric(raw.tiktok_allowance);
    employeeMap.set(employeeId, employee);
  }

  const records = (recordResult.results as RawRecord[])
    .map((row) => ({ row, data: parseData(row) }))
    .filter(({ row, data }) => dataPeriod(row, data) === month);

  const latestFixed = records.find(({ row }) => String(row.category) === "CHI_PHI_CO_DINH");
  const fixed = latestFixed
    ? numeric(latestFixed.data.total) || sumItems(latestFixed.data.items, "amount") || numeric(latestFixed.data.amount)
    : 0;

  let variable = 0;
  let inventory = 0;
  let shipping = 0;
  let manualBonusTotal = 0;
  let manualAllowanceTotal = 0;

  for (const { row, data } of records) {
    const category = String(row.category ?? "");
    if (category === "CHI_PHI_PHAT_SINH") variable += numeric(data.amount);
    if (category === "DONG_TIEN" && ["EXPENSE", "CHI"].includes(String(data.direction ?? data.type ?? "").toUpperCase())) variable += numeric(data.amount);
    if (category === "NHAP_HANG") {
      const items = Array.isArray(data.items) ? data.items : [];
      const itemGoods = (items as Array<Record<string, unknown>>).reduce((sum, item) => sum + numeric(item.weight) * numeric(item.unitPrice), 0);
      const itemShipping = (items as Array<Record<string, unknown>>).reduce((sum, item) => sum + numeric(item.shipping), 0);
      const receiptShipping = numeric(data.shippingCost) || itemShipping;
      const receiptGoods = numeric(data.goodsCost) || itemGoods || Math.max(0, numeric(data.total) - receiptShipping);
      inventory += receiptGoods;
      shipping += receiptShipping;
    }
    if (category === "EMPLOYEE_BONUS") {
      const employeeId = String(data.employeeId ?? "");
      const amount = numeric(data.amount);
      manualBonusTotal += amount;
      const employee = employeeMap.get(employeeId);
      if (employee) employee.manualBonus += amount;
    }
    if (category === "EMPLOYEE_ALLOWANCE") {
      const employeeId = String(data.employeeId ?? "");
      const amount = numeric(data.amount);
      manualAllowanceTotal += amount;
      const employee = employeeMap.get(employeeId);
      if (employee) employee.allowance += amount;
    }
  }

  let totalHours = 0;
  let employeeSalary = 0;
  let tiktokAllowance = 0;
  for (const employee of employeeMap.values()) {
    employee.hours = Math.round(employee.hours * 100) / 100;
    employee.salary = Math.round(employee.hours * employee.hourlyRate);
    totalHours += employee.hours;
    employeeSalary += employee.salary;
    tiktokAllowance += Math.max(0, employee.allowance - records
      .filter(({ row, data }) => String(row.category) === "EMPLOYEE_ALLOWANCE" && String(data.employeeId ?? "") === employee.id)
      .reduce((sum, { data }) => sum + numeric(data.amount), 0));
  }

  totalHours = Math.round(totalHours * 100) / 100;
  const managerSalary = 3_000_000;
  const employeeAllowance = manualAllowanceTotal + tiktokAllowance;
  const expense = Math.round(fixed + variable + inventory + shipping + employeeSalary + managerSalary + manualBonusTotal + employeeAllowance);
  const revenue = Math.round(numeric(revenueRow?.total));
  const profit = revenue - expense;
  const profitPerHour = profit > 0 && totalHours > 0 ? profit / totalHours : 0;
  const kpiRate = profitPerHour >= 30_000 ? 0.07 : profitPerHour >= 15_000 ? 0.05 : profitPerHour >= 7_000 ? 0.03 : 0;

  let employeeKpiTotal = 0;
  for (const employee of employeeMap.values()) {
    employee.kpi = profit > 0 && totalHours > 0 && kpiRate > 0
      ? Math.round((employee.hours / totalHours) * profit * kpiRate)
      : 0;
    employee.totalPay = employee.salary + employee.manualBonus + employee.allowance + employee.kpi;
    employeeKpiTotal += employee.kpi;
  }

  const managerKpi = profit > 0 ? Math.round(profit * 0.02) : 0;
  const distributableProfit = Math.max(0, profit - employeeKpiTotal - managerKpi);

  return {
    storeId,
    month,
    revenue,
    expense,
    profit,
    profitPerHour: Math.round(profitPerHour),
    kpiRate,
    employeeKpiTotal,
    managerKpi,
    distributableProfit,
    totalHours,
    expenseBreakdown: {
      fixed: Math.round(fixed),
      variable: Math.round(variable),
      inventory: Math.round(inventory),
      shipping: Math.round(shipping),
      employeeSalary: Math.round(employeeSalary),
      managerSalary,
      employeeBonus: Math.round(manualBonusTotal),
      employeeAllowance: Math.round(employeeAllowance),
    },
    employees: Array.from(employeeMap.values()),
    manager: { salary: managerSalary, kpi: managerKpi, totalPay: managerSalary + managerKpi },
  };
}
