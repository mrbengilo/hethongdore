import { initDb, writeAudit } from "../../../db/runtime";
import {
  durationMinutes, localPeriod, managerProfitBonus, MANAGER_MONTHLY_SALARY_VND,
  multiplyRatioVnd, periodBoundsUtc, requireVnd, sumVnd, utcTimestamp,
} from "../../lib/finance";
import { employeeKpiBonusFromSeconds, employeeKpiRateFromSeconds } from "../../lib/payroll";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";

type EmployeeRow = {
  id: string;
  code: string;
  name: string;
  position: string;
  hourlyRate: number;
};

type HoursRow = {
  employeeId: string;
  durationSeconds: number;
  appliedHourlyRate: number;
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
  durationSeconds: number;
  durationMinutes: number;
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
  totalDurationSeconds: number;
  totalDurationMinutes: number;
  profitPerHour: number;
  kpiRate: number;
  totalBaseSalary: number;
  totalTikTokAllowance: number;
  totalSupportAllowance: number;
  totalManualAllowance: number;
  totalManualBonus: number;
  totalKpiBonus: number;
  managerSalary: number;
  managerBonus: number;
  managerTotal: number;
  totalPay: number;
  items: PayrollItem[];
  status: "PREVIEW" | "LOCKED";
  finalizedAt?: string;
  finalizedBy?: string;
};

type PayrollClosing = {
  period: string;
  storeId: string;
  storeName: string;
  employeeTotal: number;
  managerSalary: number;
  managerBonus: number;
  managerTotal: number;
  grandTotal: number;
  status: "MANAGER_FINALIZED" | "PAYMENT_CONFIRMED" | "LOCKED";
  managerFinalizedAt: string;
  managerFinalizedBy: string;
  paymentConfirmedAt?: string;
  paymentConfirmedBy?: string;
  closedAt?: string;
  closedBy?: string;
};

function validPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function snapshotId(storeId: string, period: string) {
  return `kpi-summary:${storeId}:${period}`;
}

function closingId(storeId: string, period: string) {
  return `payroll-closing:${storeId}:${period}`;
}

function previousPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function parseData<T>(value: string): T | null {
  try { return JSON.parse(value) as T; } catch { return null; }
}

async function lockedSummary(db: Awaited<ReturnType<typeof initDb>>, storeId: string, period: string) {
  const row = await db.prepare("SELECT id, data_json, status FROM business_records WHERE id = ? AND category = 'KPI_SUMMARY' AND status = 'LOCKED' LIMIT 1")
    .bind(snapshotId(storeId, period)).first<RecordRow>();
  return row ? parseData<PayrollSummary>(row.data_json) : null;
}

async function payrollClosing(db: Awaited<ReturnType<typeof initDb>>, storeId: string, period: string) {
  const row = await db.prepare("SELECT id, data_json, status FROM business_records WHERE id = ? AND category = 'PAYROLL_CLOSING' AND status != 'DELETED' LIMIT 1")
    .bind(closingId(storeId, period)).first<RecordRow>();
  return row ? parseData<PayrollClosing>(row.data_json) : null;
}

async function buildPreview(db: Awaited<ReturnType<typeof initDb>>, storeId: string, period: string): Promise<PayrollSummary | null> {
  const store = await db.prepare("SELECT id, name, revenue, expense FROM stores WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
    .bind(storeId).first<StoreRow>();
  if (!store) return null;

  const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
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
          AND t.start_date < ? AND t.end_date >= ?
      )
    )
    ORDER BY code
  `).bind(storeId, storeId, startUtc, endUtc, storeId, localEnd, localStart).all<EmployeeRow>();
  const hoursResult = await db.prepare(`
    SELECT s.employee_id AS employeeId,
      SUM(CASE
        WHEN s.duration_seconds > 0 THEN s.duration_seconds
        ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0)
      END) AS durationSeconds,
      COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
      COALESCE(SUM(s.tiktok_allowance), 0) AS tiktokAllowance
    FROM shift_sessions s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.store_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
      AND s.started_at >= ? AND s.started_at < ?
    GROUP BY s.employee_id, COALESCE(s.applied_hourly_rate, e.hourly_rate)
  `).bind(storeId, startUtc, endUtc).all<HoursRow>();

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

  const shiftsByEmployee = new Map<string, { durationSeconds: number; baseSalary: number; tiktokAllowance: number }>();
  for (const row of hoursResult.results) {
    const current = shiftsByEmployee.get(row.employeeId) ?? { durationSeconds: 0, baseSalary: 0, tiktokAllowance: 0 };
    const seconds = Math.max(0, Math.round(Number(row.durationSeconds ?? 0)));
    const appliedHourlyRate = requireVnd(Number(row.appliedHourlyRate), "Lương theo giờ");
    const tiktokAllowance = requireVnd(Math.max(0, Math.round(Number(row.tiktokAllowance ?? 0))), "Phụ cấp TikTok");
    shiftsByEmployee.set(row.employeeId, {
      durationSeconds: current.durationSeconds + seconds,
      baseSalary: sumVnd([current.baseSalary, multiplyRatioVnd(appliedHourlyRate, seconds, 3_600)]),
      tiktokAllowance: sumVnd([current.tiktokAllowance, tiktokAllowance]),
    });
  }
  const revenue = requireVnd(Number(store.revenue), "Doanh thu");
  const expense = requireVnd(Number(store.expense), "Chi phí");
  const profit = revenue - expense;
  const totalDurationSeconds = [...shiftsByEmployee.values()].reduce((sum, shift) => sum + shift.durationSeconds, 0);

  const items = employeesResult.results.map((employee): PayrollItem => {
    const shift = shiftsByEmployee.get(employee.id);
    const employeeDurationSeconds = shift?.durationSeconds ?? 0;
    const minutes = durationMinutes(employeeDurationSeconds);
    const hours = employeeDurationSeconds / 3_600;
    const employeeAdjustments = adjustments.filter((item) => item.employeeId === employee.id);
    const manualAllowance = sumVnd(employeeAdjustments.filter((item) => item.kind === "ALLOWANCE").map((item) => requireVnd(Number(item.amount ?? 0), "Phụ cấp khác")));
    const manualBonus = sumVnd(employeeAdjustments.filter((item) => item.kind === "BONUS").map((item) => requireVnd(Number(item.amount ?? 0), "Thưởng khác")));
    const baseSalary = shift?.baseSalary ?? 0;
    const tiktokAllowance = Math.max(0, Number(shift?.tiktokAllowance ?? 0));
    const supportAllowance = transferAllowances.results
      .filter((transfer) => transfer.employeeId === employee.id)
      .reduce((sum, transfer) => sumVnd([sum, requireVnd(Number(transfer.supportAllowance ?? 0), "Phụ cấp hỗ trợ")]), 0);
    const kpiBonus = employeeKpiBonusFromSeconds(profit, totalDurationSeconds, employeeDurationSeconds);
    return {
      employeeId: employee.id,
      employeeCode: employee.code,
      employeeName: employee.name,
      position: employee.position,
      durationSeconds: employeeDurationSeconds,
      durationMinutes: minutes,
      hours,
      hourlyRate: employeeDurationSeconds > 0 ? multiplyRatioVnd(baseSalary, 3_600, employeeDurationSeconds) : requireVnd(Number(employee.hourlyRate), "Lương theo giờ"),
      baseSalary,
      tiktokAllowance,
      supportAllowance,
      manualAllowance,
      manualBonus,
      kpiBonus,
      totalPay: sumVnd([baseSalary, tiktokAllowance, supportAllowance, manualAllowance, manualBonus, kpiBonus]),
    };
  });

  const totalHours = totalDurationSeconds / 3_600;
  const managerSalary = MANAGER_MONTHLY_SALARY_VND;
  const managerBonus = managerProfitBonus(profit);
  return {
    period,
    storeId: store.id,
    storeName: store.name,
    revenue,
    expense,
    profit,
    totalHours,
    totalDurationSeconds,
    totalDurationMinutes: durationMinutes(totalDurationSeconds),
    profitPerHour: totalDurationSeconds > 0 ? multiplyRatioVnd(profit, 3_600, totalDurationSeconds) : 0,
    kpiRate: employeeKpiRateFromSeconds(profit, totalDurationSeconds),
    totalBaseSalary: sumVnd(items.map((item) => item.baseSalary)),
    totalTikTokAllowance: sumVnd(items.map((item) => item.tiktokAllowance)),
    totalSupportAllowance: sumVnd(items.map((item) => item.supportAllowance)),
    totalManualAllowance: sumVnd(items.map((item) => item.manualAllowance)),
    totalManualBonus: sumVnd(items.map((item) => item.manualBonus)),
    totalKpiBonus: sumVnd(items.map((item) => item.kpiBonus)),
    managerSalary,
    managerBonus,
    managerTotal: sumVnd([managerSalary, managerBonus]),
    totalPay: sumVnd(items.map((item) => item.totalPay)),
    items,
    status: "PREVIEW",
  };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const params = new URL(request.url).searchParams;
  const period = params.get("period") ?? localPeriod();
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
    const item = ownItems.length ? ownItems.slice(1).reduce<PayrollItem>((total, current) => {
      const durationSeconds = (total.durationSeconds ?? Math.round(total.hours * 3_600)) + (current.durationSeconds ?? Math.round(current.hours * 3_600));
      const baseSalary = sumVnd([total.baseSalary, current.baseSalary]);
      return {
        ...total,
        durationSeconds,
        durationMinutes: durationMinutes(durationSeconds),
        hours: durationSeconds / 3_600,
        baseSalary,
        tiktokAllowance: sumVnd([total.tiktokAllowance, current.tiktokAllowance]),
        supportAllowance: sumVnd([total.supportAllowance, current.supportAllowance]),
        manualAllowance: sumVnd([total.manualAllowance, current.manualAllowance]),
        manualBonus: sumVnd([total.manualBonus, current.manualBonus]),
        kpiBonus: sumVnd([total.kpiBonus, current.kpiBonus]),
        totalPay: sumVnd([total.totalPay, current.totalPay]),
        hourlyRate: durationSeconds > 0 ? multiplyRatioVnd(baseSalary, 3_600, durationSeconds) : current.hourlyRate,
      };
    }, ownItems[0]) : null;
    return json({ period, locked: ownItems.length > 0, item, sources: ownItems.map((entry) => ({ storeId: entry.storeId, storeName: entry.storeName, totalPay: entry.totalPay })) });
  }

  const storeId = params.get("storeId");
  if (!storeId) return json({ message: "Vui lòng chọn cửa hàng" }, 400);
  const snapshot = await lockedSummary(db, storeId, period);

  const summary = snapshot ?? await buildPreview(db, storeId, period);
  if (!summary) return json({ message: "Không tìm thấy cửa hàng" }, 404);
  const closing = await payrollClosing(db, storeId, period);
  const previous = await lockedSummary(db, storeId, previousPeriod(period));
  const historyRows = await db.prepare("SELECT data_json FROM business_records WHERE category = 'PAYROLL_CLOSING' AND store_id = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 24")
    .bind(storeId).all<{ data_json: string }>();
  const history = historyRows.results.flatMap((row) => {
    const item = parseData<PayrollClosing>(row.data_json);
    return item ? [item] : [];
  });
  return json({ period, locked: summary.status === "LOCKED", summary, closing, previousSummary: previous, history });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền tổng kết lương thưởng" }, 403);
  const body = await request.json().catch(() => ({})) as {
    storeId?: string;
    period?: string;
    action?: "FINALIZE_EMPLOYEE" | "FINALIZE_MANAGER" | "CONFIRM_PAYMENT" | "CLOSE_PERIOD";
  };
  const storeId = body.storeId?.trim();
  const period = body.period?.trim() ?? "";
  if (!storeId || !validPeriod(period)) return json({ message: "Cửa hàng hoặc kỳ lương không hợp lệ" }, 400);
  if (!await isStoreActive(storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);

  const db = await initDb();
  const action = body.action ?? "FINALIZE_EMPLOYEE";
  if (action !== "FINALIZE_EMPLOYEE") {
    const employeeSummary = await lockedSummary(db, storeId, period);
    if (!employeeSummary) return json({ message: "Hãy chốt lương thưởng nhân viên trước." }, 409);
    const existing = await payrollClosing(db, storeId, period);
    const now = utcTimestamp();

    if (action === "FINALIZE_MANAGER") {
      if (existing) return json({ closing: existing, message: "Lương thưởng quản lý đã được chốt." });
      const managerSalary = employeeSummary.managerSalary ?? MANAGER_MONTHLY_SALARY_VND;
      const managerBonus = employeeSummary.managerBonus ?? managerProfitBonus(employeeSummary.profit);
      const managerTotal = sumVnd([managerSalary, managerBonus]);
      const closing: PayrollClosing = {
        period,
        storeId,
        storeName: employeeSummary.storeName,
        employeeTotal: employeeSummary.totalPay,
        managerSalary,
        managerBonus,
        managerTotal,
        grandTotal: sumVnd([employeeSummary.totalPay, managerTotal]),
        status: "MANAGER_FINALIZED",
        managerFinalizedAt: now,
        managerFinalizedBy: user.id,
      };
      const id = closingId(storeId, period);
      await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'PAYROLL_CLOSING', ?, ?, ?, ?, 'MANAGER_FINALIZED', ?, ?)")
        .bind(id, storeId, user.id, `Kết sổ lương ${period}`, JSON.stringify(closing), now, now).run();
      await writeAudit(user.id, "MANAGER_PAYROLL_FINALIZE", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, managerSalary, managerBonus }));
      return json({ closing, message: "Đã chốt lương thưởng quản lý." }, 201);
    }

    if (!existing) return json({ message: "Hãy chốt lương thưởng quản lý trước." }, 409);
    const id = closingId(storeId, period);
    if (action === "CONFIRM_PAYMENT") {
      if (existing.status === "LOCKED") return json({ closing: existing, message: "Kỳ lương đã kết sổ và khóa." });
      const closing: PayrollClosing = { ...existing, status: "PAYMENT_CONFIRMED", paymentConfirmedAt: now, paymentConfirmedBy: user.id };
      await db.prepare("UPDATE business_records SET data_json = ?, status = 'PAYMENT_CONFIRMED', updated_at = ? WHERE id = ? AND status != 'LOCKED'")
        .bind(JSON.stringify(closing), now, id).run();
      await writeAudit(user.id, "PAYROLL_PAYMENT_CONFIRM", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, grandTotal: closing.grandTotal }));
      return json({ closing, message: "Đã xác nhận chi lương và thưởng." });
    }

    if (existing.status !== "PAYMENT_CONFIRMED") return json({ message: "Hãy xác nhận chi trước khi kết sổ." }, 409);
    const closing: PayrollClosing = { ...existing, status: "LOCKED", closedAt: now, closedBy: user.id };
    await db.prepare("UPDATE business_records SET data_json = ?, status = 'LOCKED', updated_at = ? WHERE id = ? AND status = 'PAYMENT_CONFIRMED'")
      .bind(JSON.stringify(closing), now, id).run();
    await writeAudit(user.id, "PAYROLL_PERIOD_CLOSE", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, grandTotal: closing.grandTotal }));
    return json({ closing, message: "Đã kết sổ và khóa kỳ lương thưởng." });
  }

  if (await lockedSummary(db, storeId, period)) return json({ message: "Kỳ lương này đã được tổng kết và khóa" }, 409);
  const preview = await buildPreview(db, storeId, period);
  if (!preview) return json({ message: "Không tìm thấy cửa hàng" }, 404);
  const finalizedAt = utcTimestamp();
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
