import { initDb, writeAudit } from "../../../db/runtime";
import { distributeEmployeeKpi, employeeKpiRate } from "../../lib/payroll";
import { getSessionUser, json } from "../_lib/auth";

type EmployeeRow = {
  id: string;
  code: string;
  name: string;
  position: string;
  hourlyRate: number;
};

type HoursRow = {
  employeeId: string;
  hours: number;
  baseSalary: number;
  tiktokAllowance: number;
};

type TransferAllowanceRow = {
  id: string;
  employeeId: string;
  supportAllowance: number;
};

type StoreRow = {
  id: string;
  name: string;
  revenue: number;
  expense: number;
};

type RecordRow = {
  id: string;
  data_json: string;
  status: string;
};

type PayrollAdjustment = {
  kind?: string;
  employeeId?: string;
  amount?: number;
  date?: string;
};

type PayrollItem = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  position: string;
  hours: number;
  hourlyRate: number;
  baseSalary: number;
  tiktokAllowance: number;
  supportAllowance: number;
  manualAllowance: number;
  manualBonus: number;
  kpiBonus: number;
  totalPay: number;
};

type PayrollSummary = {
  period: string;
  storeId: string;
  storeName: string;
  revenue: number;
  expense: number;
  profit: number;
  totalHours: number;
  profitPerHour: number;
  kpiRate: number;
  totalBaseSalary: number;
  totalTikTokAllowance: number;
  totalSupportAllowance: number;
  totalManualAllowance: number;
  totalManualBonus: number;
  totalKpiBonus: number;
  totalPay: number;
  items: PayrollItem[];
  status: "PREVIEW" | "LOCKED";
  finalizedAt?: string;
  finalizedBy?: string;
};

function currentPeriod() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

function validPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function periodBounds(period: string) {
  const [year, month] = period.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    localStart: `${period}-01`,
    localEnd: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
    start: new Date(`${period}-01T00:00:00+07:00`).toISOString(),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+07:00`).toISOString(),
  };
}

function snapshotId(storeId: string, period: string) {
  return `kpi-summary:${storeId}:${period}`;
}

function parseData<T>(value: string): T | null {
  try { return JSON.parse(value) as T; } catch { return null; }
}

async function lockedSummary(db: Awaited<ReturnType<typeof initDb>>, storeId: string, period: string) {
  const row = await db.prepare("SELECT id, data_json, status FROM business_records WHERE id = ? AND category = 'KPI_SUMMARY' AND status = 'LOCKED' LIMIT 1")
    .bind(snapshotId(storeId, period)).first<RecordRow>();
  return row ? parseData<PayrollSummary>(row.data_json) : null;
}

async function buildPreview(db: Awaited<ReturnType<typeof initDb>>, storeId: string, period: string): Promise<PayrollSummary | null> {
  const store = await db.prepare("SELECT id, name, revenue, expense FROM stores WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
    .bind(storeId).first<StoreRow>();
  if (!store) return null;

  const { start, end, localStart, localEnd } = periodBounds(period);
  const employeesResult = await db.prepare(`
    SELECT id, code, name, position, hourly_rate AS hourlyRate
    FROM employees e
    WHERE e.status != 'ARCHIVED' AND (
      e.store_id = ?
      OR EXISTS (
        SELECT 1 FROM shift_sessions s
        WHERE s.employee_id = e.id AND s.store_id = ? AND s.status = 'COMPLETED'
          AND s.ended_at IS NOT NULL AND s.started_at >= ? AND s.started_at < ?
      )
      OR EXISTS (
        SELECT 1 FROM employee_transfers t
        WHERE t.employee_id = e.id AND t.target_store_id = ? AND t.status != 'CANCELLED'
          AND t.start_date >= ? AND t.start_date < ?
      )
    )
    ORDER BY code
  `).bind(storeId, storeId, start, end, storeId, localStart, localEnd).all<EmployeeRow>();
  const hoursResult = await db.prepare(`
    SELECT s.employee_id AS employeeId,
      ROUND(SUM((julianday(s.ended_at) - julianday(s.started_at)) * 24), 6) AS hours,
      ROUND(SUM((julianday(s.ended_at) - julianday(s.started_at)) * 24 * COALESCE(s.applied_hourly_rate, e.hourly_rate)), 0) AS baseSalary,
      COALESCE(SUM(s.tiktok_allowance), 0) AS tiktokAllowance
    FROM shift_sessions s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.store_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
      AND s.started_at >= ? AND s.started_at < ?
    GROUP BY s.employee_id
  `).bind(storeId, start, end).all<HoursRow>();

  const transferAllowances = await db.prepare(`
    SELECT id, employee_id AS employeeId, support_allowance AS supportAllowance
    FROM employee_transfers
    WHERE target_store_id = ? AND status != 'CANCELLED'
      AND start_date >= ? AND start_date < ?
  `).bind(storeId, localStart, localEnd).all<TransferAllowanceRow>();

  const adjustmentRows = await db.prepare("SELECT id, data_json, status FROM business_records WHERE category = 'LUONG_THUONG' AND store_id = ? AND status != 'DELETED' ORDER BY created_at")
    .bind(storeId).all<RecordRow>();
  const adjustments = adjustmentRows.results
    .map((record) => parseData<PayrollAdjustment>(record.data_json))
    .filter((item): item is PayrollAdjustment => Boolean(item?.employeeId && item.date?.slice(0, 7) === period));

  const hoursByEmployee = new Map(hoursResult.results.map((row) => [row.employeeId, row]));
  const profit = Number(store.revenue) - Number(store.expense);
  const kpiDistribution = distributeEmployeeKpi(profit, employeesResult.results.map((employee) => ({
    employeeId: employee.id,
    hours: Math.max(0, Number(hoursByEmployee.get(employee.id)?.hours ?? 0)),
  })));
  const kpiByEmployee = new Map(kpiDistribution.map((item) => [item.employeeId, item.bonus]));

  const items = employeesResult.results.map((employee): PayrollItem => {
    const shift = hoursByEmployee.get(employee.id);
    const hours = Math.max(0, Number(shift?.hours ?? 0));
    const employeeAdjustments = adjustments.filter((item) => item.employeeId === employee.id);
    const manualAllowance = employeeAdjustments.filter((item) => item.kind === "ALLOWANCE").reduce((sum, item) => sum + Math.max(0, Number(item.amount ?? 0)), 0);
    const manualBonus = employeeAdjustments.filter((item) => item.kind === "BONUS").reduce((sum, item) => sum + Math.max(0, Number(item.amount ?? 0)), 0);
    const baseSalary = Math.max(0, Math.round(Number(shift?.baseSalary ?? hours * Number(employee.hourlyRate))));
    const tiktokAllowance = Math.max(0, Number(shift?.tiktokAllowance ?? 0));
    const supportAllowance = transferAllowances.results
      .filter((transfer) => transfer.employeeId === employee.id)
      .reduce((sum, transfer) => sum + Math.max(0, Number(transfer.supportAllowance ?? 0)), 0);
    const kpiBonus = kpiByEmployee.get(employee.id) ?? 0;
    return {
      employeeId: employee.id,
      employeeCode: employee.code,
      employeeName: employee.name,
      position: employee.position,
      hours,
      hourlyRate: hours > 0 ? Math.round(baseSalary / hours) : Number(employee.hourlyRate),
      baseSalary,
      tiktokAllowance,
      supportAllowance,
      manualAllowance,
      manualBonus,
      kpiBonus,
      totalPay: baseSalary + tiktokAllowance + supportAllowance + manualAllowance + manualBonus + kpiBonus,
    };
  });

  const totalHours = items.reduce((sum, item) => sum + item.hours, 0);
  return {
    period,
    storeId: store.id,
    storeName: store.name,
    revenue: Number(store.revenue),
    expense: Number(store.expense),
    profit,
    totalHours,
    profitPerHour: totalHours > 0 ? profit / totalHours : 0,
    kpiRate: employeeKpiRate(profit, totalHours),
    totalBaseSalary: items.reduce((sum, item) => sum + item.baseSalary, 0),
    totalTikTokAllowance: items.reduce((sum, item) => sum + item.tiktokAllowance, 0),
    totalSupportAllowance: items.reduce((sum, item) => sum + item.supportAllowance, 0),
    totalManualAllowance: items.reduce((sum, item) => sum + item.manualAllowance, 0),
    totalManualBonus: items.reduce((sum, item) => sum + item.manualBonus, 0),
    totalKpiBonus: items.reduce((sum, item) => sum + item.kpiBonus, 0),
    totalPay: items.reduce((sum, item) => sum + item.totalPay, 0),
    items,
    status: "PREVIEW",
  };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const params = new URL(request.url).searchParams;
  const period = params.get("period") ?? currentPeriod();
  if (!validPeriod(period)) return json({ message: "Kỳ lương không hợp lệ" }, 400);

  const db = await initDb();
  if (user.role === "EMPLOYEE") {
    // An employee can have income in both the home store and a support store.
    // Only their own item is returned; data of other employees remains private.
    const snapshots = await db.prepare("SELECT data_json FROM business_records WHERE category = 'KPI_SUMMARY' AND status = 'LOCKED' AND id LIKE ? ORDER BY created_at")
      .bind(`kpi-summary:%:${period}`).all<{ data_json: string }>();
    const ownItems = snapshots.results.flatMap((row) => {
      const summary = parseData<PayrollSummary>(row.data_json);
      const item = summary?.items.find((payrollItem) => payrollItem.employeeId === user.employeeId);
      return item && summary ? [{ ...item, storeId: summary.storeId, storeName: summary.storeName }] : [];
    });
    const item = ownItems.length ? ownItems.slice(1).reduce<PayrollItem>((total, current) => ({
      ...total,
      hours: total.hours + current.hours,
      baseSalary: total.baseSalary + current.baseSalary,
      tiktokAllowance: total.tiktokAllowance + current.tiktokAllowance,
      supportAllowance: total.supportAllowance + current.supportAllowance,
      manualAllowance: total.manualAllowance + current.manualAllowance,
      manualBonus: total.manualBonus + current.manualBonus,
      kpiBonus: total.kpiBonus + current.kpiBonus,
      totalPay: total.totalPay + current.totalPay,
      hourlyRate: total.hours + current.hours > 0 ? Math.round((total.baseSalary + current.baseSalary) / (total.hours + current.hours)) : current.hourlyRate,
    }), ownItems[0]) : null;
    return json({ period, locked: ownItems.length > 0, item, sources: ownItems.map((entry) => ({ storeId: entry.storeId, storeName: entry.storeName, totalPay: entry.totalPay })) });
  }

  const storeId = params.get("storeId");
  if (!storeId) return json({ message: "Vui lòng chọn cửa hàng" }, 400);
  const snapshot = await lockedSummary(db, storeId, period);

  const summary = snapshot ?? await buildPreview(db, storeId, period);
  if (!summary) return json({ message: "Không tìm thấy cửa hàng" }, 404);
  return json({ period, locked: summary.status === "LOCKED", summary });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền tổng kết lương thưởng" }, 403);
  const body = await request.json().catch(() => ({})) as { storeId?: string; period?: string };
  const storeId = body.storeId?.trim();
  const period = body.period?.trim() ?? "";
  if (!storeId || !validPeriod(period)) return json({ message: "Cửa hàng hoặc kỳ lương không hợp lệ" }, 400);

  const db = await initDb();
  if (await lockedSummary(db, storeId, period)) return json({ message: "Kỳ lương này đã được tổng kết và khóa" }, 409);
  const preview = await buildPreview(db, storeId, period);
  if (!preview) return json({ message: "Không tìm thấy cửa hàng" }, 404);
  const finalizedAt = new Date().toISOString();
  const summary: PayrollSummary = { ...preview, status: "LOCKED", finalizedAt, finalizedBy: user.id };
  const id = snapshotId(storeId, period);
  try {
    await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'KPI_SUMMARY', ?, ?, ?, ?, 'LOCKED', ?, ?)")
      .bind(id, storeId, user.id, `Tổng kết KPI ${period}`, JSON.stringify(summary), finalizedAt, finalizedAt).run();
  } catch {
    return json({ message: "Kỳ lương này đã được tổng kết và khóa" }, 409);
  }
  await writeAudit(user.id, "PAYROLL_FINALIZE", "KPI_SUMMARY", id, JSON.stringify({ storeId, period, profit: summary.profit, totalHours: summary.totalHours, kpiRate: summary.kpiRate, totalKpiBonus: summary.totalKpiBonus }));
  return json({ locked: true, summary, message: "Đã tổng kết và khóa kỳ lương thưởng" }, 201);
}
