import { initDb, writeAudit } from "../../../db/runtime";
import {
  durationMinutes, localPeriod, managerProfitBonus, MANAGER_MONTHLY_SALARY_VND,
  multiplyRatioVnd, periodBoundsUtc, requireVnd, settleStoreProfit, sumVnd, utcTimestamp,
} from "../../lib/finance";
import { employeeKpiBonusFromSeconds, employeeKpiRateFromSeconds, employeePayWithKpi } from "../../lib/payroll";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import { storePeriodFinance, type StoreExpenseBreakdown } from "../_lib/store-finance";

type EmployeeRow = {
  id: string;
  code: string;
  name: string;
  position: string;
  hourlyRate: number;
  status: "ACTIVE" | "INACTIVE";
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
  employmentStatus: "ACTIVE" | "INACTIVE";
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
  expenseBeforePerformanceRewards: number;
  profit: number;
  netProfit: number;
  costBreakdown: StoreExpenseBreakdown;
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

type EmployeeShiftDetailRow = {
  id: string;
  shiftCode: string;
  shiftName: string | null;
  workDate: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  hourlyRate: number;
  tiktokAllowance: number;
  transferId: string | null;
  supportAllowance: number | null;
  storeId: string;
  storeName: string;
  sourceStoreName: string | null;
};

type PayrollClosing = {
  period: string;
  storeId: string;
  storeName: string;
  employeeTotal: number;
  managerSalary: number;
  managerBonus: number;
  managerTotal: number;
  salaryTotal: number;
  rewardAllowanceTotal: number;
  grandTotal: number;
  status: "MANAGER_FINALIZED" | "SALARY_CONFIRMED" | "REWARDS_CONFIRMED" | "PAYMENT_CONFIRMED" | "LOCKED";
  managerFinalizedAt: string;
  managerFinalizedBy: string;
  salaryConfirmedAt?: string;
  salaryConfirmedBy?: string;
  rewardsConfirmedAt?: string;
  rewardsConfirmedBy?: string;
  paymentConfirmedAt?: string;
  paymentConfirmedBy?: string;
  closedAt?: string;
  closedBy?: string;
};

type EmployeePayrollClosing = {
  id: string;
  period: string;
  storeId: string;
  storeName: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeStatusAtLock: "ACTIVE" | "INACTIVE";
  item: PayrollItem;
  status: "BASE_LOCKED" | "LOCKED";
  kpiDeferred: boolean;
  lockedAt: string;
  lockedBy: string;
};

type PayrollAction = "FINALIZE_SINGLE_EMPLOYEE" | "FINALIZE_EMPLOYEE" | "FINALIZE_MANAGER" | "CONFIRM_SALARY" | "CONFIRM_REWARDS" | "CONFIRM_PAYMENT" | "CLOSE_PERIOD";

const payrollActions = new Set<PayrollAction>([
  "FINALIZE_SINGLE_EMPLOYEE",
  "FINALIZE_EMPLOYEE",
  "FINALIZE_MANAGER",
  "CONFIRM_SALARY",
  "CONFIRM_REWARDS",
  "CONFIRM_PAYMENT",
  "CLOSE_PERIOD",
]);

function validPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function snapshotId(storeId: string, period: string) {
  return `kpi-summary:${storeId}:${period}`;
}

function closingId(storeId: string, period: string) {
  return `payroll-closing:${storeId}:${period}`;
}

function employeeClosingId(storeId: string, period: string, employeeId: string) {
  return `employee-payroll-closing:${storeId}:${period}:${employeeId}`;
}

function previousPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function parseData<T>(value: string): T | null {
  try { return JSON.parse(value) as T; } catch { return null; }
}

function safePayrollVnd(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function isPayrollAction(value: unknown): value is PayrollAction {
  return typeof value === "string" && payrollActions.has(value as PayrollAction);
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
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

async function employeePayrollClosings(db: Awaited<ReturnType<typeof initDb>>, storeId: string, period: string) {
  const rows = await db.prepare(`SELECT id, snapshot_json AS snapshotJson, employee_status_at_lock AS employeeStatusAtLock,
      status, locked_at AS lockedAt, locked_by AS lockedBy
    FROM employee_payroll_closings
    WHERE store_id = ? AND period = ? AND status IN ('BASE_LOCKED', 'LOCKED')
    ORDER BY locked_at, employee_id`)
    .bind(storeId, period).all<{
      id: string;
      snapshotJson: string;
      employeeStatusAtLock: string;
      status: string;
      lockedAt: string;
      lockedBy: string;
    }>();
  return rows.results.flatMap((row) => {
    const snapshot = parseData<EmployeePayrollClosing>(row.snapshotJson);
    if (!snapshot) return [];
    return [{
      ...snapshot,
      id: row.id,
      employeeStatusAtLock: row.employeeStatusAtLock === "INACTIVE" ? "INACTIVE" as const : "ACTIVE" as const,
      status: row.status === "BASE_LOCKED" ? "BASE_LOCKED" as const : "LOCKED" as const,
      lockedAt: row.lockedAt,
      lockedBy: row.lockedBy,
    }];
  });
}

async function employeeStatusMap(db: Awaited<ReturnType<typeof initDb>>, employeeIds: string[]) {
  const entries = await Promise.all([...new Set(employeeIds)].map(async (employeeId) => {
    const employee = await db.prepare("SELECT status FROM employees WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
      .bind(employeeId).first<{ status: string }>();
    return [employeeId, employee?.status === "INACTIVE" ? "INACTIVE" : "ACTIVE"] as const;
  }));
  return new Map<string, "ACTIVE" | "INACTIVE">(entries);
}

async function managerPayrollPeriod(db: Awaited<ReturnType<typeof initDb>>, period: string) {
  const result = await db.prepare(`
    SELECT data_json AS dataJson
    FROM business_records
    WHERE category = 'PAYROLL_CLOSING' AND status = 'LOCKED'
      AND json_extract(data_json, '$.period') = ?
    ORDER BY json_extract(data_json, '$.storeName')
  `).bind(period).all<{ dataJson: string }>();
  const rows = (await Promise.all(result.results.map(async (record) => {
    const closing = parseData<PayrollClosing>(record.dataJson);
    if (!closing || closing.status !== "LOCKED") return null;
    const summary = await lockedSummary(db, closing.storeId, period);
    if (!summary) return null;
    const managerSalary = safePayrollVnd(closing.managerSalary || MANAGER_MONTHLY_SALARY_VND);
    const managerBonus = safePayrollVnd(closing.managerBonus);
    const managerTotal = sumVnd([managerSalary, managerBonus]);
    return {
      period,
      storeId: closing.storeId,
      storeName: closing.storeName,
      profitBeforePerformanceRewards: summary.profit,
      employeeKpiBonus: summary.totalKpiBonus,
      finalProfit: summary.netProfit,
      managerSalary,
      managerBonus,
      managerTotal,
      paymentConfirmedAt: closing.paymentConfirmedAt ?? null,
      closedAt: closing.closedAt ?? null,
      status: "LOCKED" as const,
    };
  }))).filter((row): row is NonNullable<typeof row> => Boolean(row));
  const totalSalary = sumVnd(rows.map((row) => row.managerSalary));
  const totalBonus = sumVnd(rows.map((row) => row.managerBonus));
  return {
    period,
    policy: { salaryPerStore: MANAGER_MONTHLY_SALARY_VND, bonusRate: 0.02 },
    rows,
    totals: { storeCount: rows.length, totalSalary, totalBonus, totalPay: sumVnd([totalSalary, totalBonus]) },
  };
}

async function buildPreview(db: Awaited<ReturnType<typeof initDb>>, storeId: string, period: string): Promise<PayrollSummary | null> {
  const store = await storePeriodFinance(db, storeId, period);
  if (!store) return null;

  const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
  const employeesResult = await db.prepare(`
    SELECT id, code, name, position, hourly_rate AS hourlyRate, status
    FROM employees e
    WHERE e.status != 'ARCHIVED' AND (
      (e.status = 'ACTIVE' AND e.store_id = ?)
      OR (e.status = 'INACTIVE' AND e.store_id = ?
        AND strftime('%Y-%m', e.inactive_at, '+7 hours') = ?)
      OR EXISTS (
        SELECT 1 FROM shift_sessions s
        WHERE s.employee_id = e.id AND s.store_id = ? AND s.status = 'COMPLETED'
          AND s.ended_at IS NOT NULL AND (
            (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
            OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
          )
      )
      OR EXISTS (
        SELECT 1 FROM employee_transfers t
        WHERE t.employee_id = e.id AND t.target_store_id = ? AND t.status != 'CANCELLED'
          AND t.start_date < ? AND t.end_date >= ?
      )
      OR EXISTS (
        SELECT 1 FROM business_records r
        WHERE r.category = 'LUONG_THUONG' AND r.store_id = ? AND r.status != 'DELETED'
          AND json_extract(r.data_json, '$.employeeId') = e.id
          AND substr(json_extract(r.data_json, '$.date'), 1, 7) = ?
      )
      OR EXISTS (
        SELECT 1 FROM employee_payroll_closings c
        WHERE c.store_id = ? AND c.employee_id = e.id AND c.period = ?
          AND c.status IN ('BASE_LOCKED', 'LOCKED')
      )
    )
    ORDER BY code
  `).bind(storeId, storeId, period, storeId, localStart, localEnd, startUtc, endUtc, storeId, localEnd, localStart, storeId, period, storeId, period).all<EmployeeRow>();
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
      AND (
        (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
        OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
      )
    GROUP BY s.employee_id, COALESCE(s.applied_hourly_rate, e.hourly_rate)
  `).bind(storeId, localStart, localEnd, startUtc, endUtc).all<HoursRow>();

  const transferAllowances = await db.prepare(`
    SELECT DISTINCT t.id, t.employee_id AS employeeId, t.support_allowance AS supportAllowance
    FROM employee_transfers t
    JOIN shift_sessions s ON s.transfer_id = t.id AND s.store_id = t.target_store_id
    WHERE t.target_store_id = ? AND t.status != 'CANCELLED'
      AND t.start_date < ? AND t.end_date >= ?
      AND s.status = 'COMPLETED' AND (
        (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
        OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
      )
      AND (CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
        ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END) > 0
  `).bind(storeId, localEnd, localStart, localStart, localEnd, startUtc, endUtc).all<TransferAllowanceRow>();

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
  const expenseBeforePerformanceRewards = requireVnd(
    Number(store.expense) - Number(store.expenseBreakdown.employeeKpiBonus) - Number(store.expenseBreakdown.managerBonus),
    "Chi phí trước thưởng hiệu quả",
  );
  const profit = store.profitBeforePerformanceRewards;
  const totalDurationSeconds = [...shiftsByEmployee.values()].reduce((sum, shift) => sum + shift.durationSeconds, 0);

  const calculatedItems = employeesResult.results.map((employee): PayrollItem => {
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
      employmentStatus: employee.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
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

  // An individually locked employee keeps the exact immutable snapshot even
  // when the rest of the store continues working later in the same month.
  const individuallyLocked = new Map((await employeePayrollClosings(db, storeId, period)).map((closing) => [closing.employeeId, closing]));
  const items = calculatedItems.map((item) => {
    const closing = individuallyLocked.get(item.employeeId);
    if (!closing) return item;
    if (!closing.kpiDeferred) return closing.item;
    const locked = closing.item;
    const kpiBonus = item.kpiBonus;
    return {
      ...locked,
      // KPI depends on the complete store month. It stays live until the
      // store period is finalized while every deterministic component below
      // remains frozen at the offboarding time.
      kpiBonus,
      totalPay: employeePayWithKpi(locked, kpiBonus),
    };
  });
  const payrollDurationSeconds = items.reduce((sum, item) => sum + item.durationSeconds, 0);
  const totalHours = payrollDurationSeconds / 3_600;
  const managerSalary = MANAGER_MONTHLY_SALARY_VND;
  const totalKpiBonus = sumVnd(items.map((item) => item.kpiBonus));
  const settlement = settleStoreProfit(profit, totalKpiBonus);
  const managerBonus = settlement.managerBonus;
  const netProfit = settlement.finalProfit;
  const expense = sumVnd([expenseBeforePerformanceRewards, totalKpiBonus, managerBonus]);
  const costBreakdown: StoreExpenseBreakdown = {
    ...store.expenseBreakdown,
    employeeKpiBonus: totalKpiBonus,
    managerBonus,
  };
  return {
    period,
    storeId: store.id,
    storeName: store.name,
    revenue,
    expense,
    expenseBeforePerformanceRewards,
    profit,
    netProfit,
    costBreakdown,
    totalHours,
    totalDurationSeconds: payrollDurationSeconds,
    totalDurationMinutes: durationMinutes(payrollDurationSeconds),
    profitPerHour: payrollDurationSeconds > 0 ? multiplyRatioVnd(profit, 3_600, payrollDurationSeconds) : 0,
    kpiRate: employeeKpiRateFromSeconds(profit, payrollDurationSeconds),
    totalBaseSalary: sumVnd(items.map((item) => item.baseSalary)),
    totalTikTokAllowance: sumVnd(items.map((item) => item.tiktokAllowance)),
    totalSupportAllowance: sumVnd(items.map((item) => item.supportAllowance)),
    totalManualAllowance: sumVnd(items.map((item) => item.manualAllowance)),
    totalManualBonus: sumVnd(items.map((item) => item.manualBonus)),
    totalKpiBonus,
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
    const sourceClosings = await Promise.all(ownItems.map(async (entry) => ({
      storeId: entry.storeId,
      storeName: entry.storeName,
      closing: await payrollClosing(db, entry.storeId, period),
    })));
    const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
    const detailRows = user.employeeId ? await db.prepare(`
      SELECT s.id,
        s.shift_code AS shiftCode,
        s.shift_name AS shiftName,
        s.work_date AS workDate,
        s.scheduled_start AS scheduledStart,
        s.scheduled_end AS scheduledEnd,
        s.started_at AS startedAt,
        s.ended_at AS endedAt,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END AS durationSeconds,
        COALESCE(s.applied_hourly_rate, e.hourly_rate) AS hourlyRate,
        COALESCE(s.tiktok_allowance, 0) AS tiktokAllowance,
        s.transfer_id AS transferId,
        t.support_allowance AS supportAllowance,
        s.store_id AS storeId,
        target.name AS storeName,
        source.name AS sourceStoreName
      FROM shift_sessions s
      JOIN employees e ON e.id = s.employee_id
      JOIN stores target ON target.id = s.store_id
      LEFT JOIN employee_transfers t ON t.id = s.transfer_id
      LEFT JOIN stores source ON source.id = t.source_store_id
      WHERE s.employee_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
          OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
        )
      ORDER BY s.started_at DESC
    `).bind(user.employeeId, localStart, localEnd, startUtc, endUtc).all<EmployeeShiftDetailRow>() : { results: [] as EmployeeShiftDetailRow[] };
    const transferSeconds = new Map<string, number>();
    for (const shift of detailRows.results) {
      if (shift.transferId) transferSeconds.set(shift.transferId, (transferSeconds.get(shift.transferId) ?? 0) + Math.max(0, Math.round(Number(shift.durationSeconds ?? 0))));
    }
    const transferAllocationState = new Map<string, { cumulativeSeconds: number; allocated: number }>();
    const shiftDetails = detailRows.results.map((shift) => {
      const seconds = Math.max(0, Math.round(Number(shift.durationSeconds ?? 0)));
      const hourlyRate = requireVnd(Math.max(0, Math.round(Number(shift.hourlyRate ?? 0))), "Lương theo giờ");
      const baseSalary = multiplyRatioVnd(hourlyRate, seconds, 3_600);
      let supportAllowance = 0;
      if (shift.transferId) {
        const totalSeconds = transferSeconds.get(shift.transferId) ?? 0;
        const allocation = transferAllocationState.get(shift.transferId) ?? { cumulativeSeconds: 0, allocated: 0 };
        allocation.cumulativeSeconds += seconds;
        const targetAllocated = totalSeconds > 0
          ? multiplyRatioVnd(safePayrollVnd(shift.supportAllowance), allocation.cumulativeSeconds, totalSeconds)
          : 0;
        supportAllowance = Math.max(0, targetAllocated - allocation.allocated);
        allocation.allocated = targetAllocated;
        transferAllocationState.set(shift.transferId, allocation);
      }
      const tiktokAllowance = safePayrollVnd(shift.tiktokAllowance);
      return {
        ...shift,
        durationSeconds: seconds,
        durationMinutes: durationMinutes(seconds),
        hours: seconds / 3_600,
        hourlyRate,
        baseSalary,
        supportAllowance,
        tiktokAllowance,
        isSupport: Boolean(shift.transferId),
        netPay: sumVnd([baseSalary, supportAllowance, tiktokAllowance]),
      };
    });
    const supportSourceIds = new Set(shiftDetails.filter((shift) => shift.isSupport).map((shift) => shift.storeId));
    return json({
      period,
      locked: ownItems.length > 0,
      item,
      sources: ownItems.map((entry) => ({
        storeId: entry.storeId,
        storeName: entry.storeName,
        hours: entry.hours,
        hourlyRate: entry.hourlyRate,
        baseSalary: entry.baseSalary,
        supportAllowance: entry.supportAllowance,
        manualAllowance: entry.manualAllowance,
        manualBonus: entry.manualBonus,
        kpiBonus: entry.kpiBonus,
        totalPay: entry.totalPay,
        isSupport: supportSourceIds.has(entry.storeId),
        sourceStoreName: shiftDetails.find((shift) => shift.storeId === entry.storeId && shift.isSupport)?.sourceStoreName ?? null,
        paymentStatus: sourceClosings.find((source) => source.storeId === entry.storeId)?.closing?.status ?? "PENDING",
        paidAt: sourceClosings.find((source) => source.storeId === entry.storeId)?.closing?.paymentConfirmedAt ?? null,
      })),
      shiftDetails,
      paid: sourceClosings.length > 0 && sourceClosings.every((source) => source.closing?.status === "PAYMENT_CONFIRMED" || source.closing?.status === "LOCKED"),
    });
  }

  if (params.get("scope") === "manager") {
    return json({ managerPayroll: await managerPayrollPeriod(db, period) });
  }

  const storeId = params.get("storeId");
  if (!storeId) return json({ message: "Vui lòng chọn cửa hàng" }, 400);
  const snapshot = await lockedSummary(db, storeId, period);

  const baseSummary = snapshot ?? await buildPreview(db, storeId, period);
  if (!baseSummary) return json({ message: "Không tìm thấy cửa hàng" }, 404);
  const statuses = await employeeStatusMap(db, baseSummary.items.map((item) => item.employeeId));
  const summary: PayrollSummary = {
    ...baseSummary,
    items: baseSummary.items.map((item) => ({
      ...item,
      employmentStatus: statuses.get(item.employeeId) ?? item.employmentStatus ?? "ACTIVE",
    })),
  };
  const individualClosings = await employeePayrollClosings(db, storeId, period);
  const closing = await payrollClosing(db, storeId, period);
  const previous = await lockedSummary(db, storeId, previousPeriod(period));
  const historyRows = await db.prepare("SELECT data_json FROM business_records WHERE category = 'PAYROLL_CLOSING' AND store_id = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 24")
    .bind(storeId).all<{ data_json: string }>();
  const history = historyRows.results.flatMap((row) => {
    const item = parseData<PayrollClosing>(row.data_json);
    return item ? [item] : [];
  });
  return json({
    period,
    locked: summary.status === "LOCKED",
    summary,
    employeeClosings: individualClosings,
    individualLockedCount: individualClosings.length,
    closing,
    previousSummary: previous,
    history,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền tổng kết lương thưởng" }, 403);
  const body = await request.json().catch(() => ({})) as {
    storeId?: string;
    period?: string;
    action?: string;
    employeeId?: string;
  };
  const storeId = body.storeId?.trim();
  const period = body.period?.trim() ?? "";
  if (!storeId || !validPeriod(period)) return json({ message: "Cửa hàng hoặc kỳ lương không hợp lệ" }, 400);
  if (!await isStoreActive(storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const requestedAction = body.action ?? "FINALIZE_EMPLOYEE";
  if (!isPayrollAction(requestedAction)) return json({ message: "Thao tác chốt kỳ lương không hợp lệ." }, 400);
  const action = requestedAction;
  if (action === "FINALIZE_SINGLE_EMPLOYEE") {
    const employeeId = body.employeeId?.trim() ?? "";
    if (!employeeId) return json({ message: "Vui lòng chọn nhân viên cần chốt lương." }, 400);
    if (period > localPeriod()) return json({ message: "Không thể chốt lương cho kỳ trong tương lai." }, 409);

    const summary = await lockedSummary(db, storeId, period) ?? await buildPreview(db, storeId, period);
    if (!summary) return json({ message: "Không tìm thấy cửa hàng." }, 404);
    const sourceItem = summary.items.find((item) => item.employeeId === employeeId);
    if (!sourceItem) return json({ message: "Nhân viên không có trong bảng lương của cửa hàng ở kỳ này." }, 404);
    const employee = await db.prepare("SELECT code, name, status FROM employees WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
      .bind(employeeId).first<{ code: string; name: string; status: string }>();
    if (!employee) return json({ message: "Không tìm thấy nhân viên." }, 404);
    if (period === localPeriod() && employee.status !== "INACTIVE") {
      return json({ message: "Kỳ hiện tại chỉ được chốt riêng sớm cho nhân viên đã ngưng làm việc. Nhân viên đang làm việc cần chờ hết tháng." }, 409);
    }
    const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
    const openShift = await db.prepare(`SELECT id FROM shift_sessions
      WHERE employee_id = ? AND store_id = ? AND status = 'ACTIVE' AND (
        (NULLIF(work_date, '') IS NOT NULL AND work_date >= ? AND work_date < ?)
        OR (NULLIF(work_date, '') IS NULL AND started_at >= ? AND started_at < ?)
      ) LIMIT 1`)
      .bind(employeeId, storeId, localStart, localEnd, startUtc, endUtc).first<{ id: string }>();
    if (openShift) return json({ message: "Nhân viên còn ca làm chưa kết thúc trong kỳ. Hãy kết ca trước khi chốt lương." }, 409);

    const current = (await employeePayrollClosings(db, storeId, period)).find((closing) => closing.employeeId === employeeId);
    if (current) return json({ employeeClosing: current, message: "Lương nhân viên đã được chốt và khóa sổ trước đó." });

    const lockedAt = utcTimestamp();
    const employmentStatus = employee.status === "INACTIVE" ? "INACTIVE" as const : "ACTIVE" as const;
    // Individual closing never owns the KPI amount. Store costs may still be
    // corrected after employees are reviewed, so KPI is materialized only in
    // the single immutable KPI_SUMMARY created by FINALIZE_EMPLOYEE.
    const kpiDeferred = true;
    const item: PayrollItem = {
      ...sourceItem,
      employmentStatus,
      kpiBonus: 0,
      totalPay: employeePayWithKpi(sourceItem, 0),
    };
    const employeeClosing: EmployeePayrollClosing = {
      id: employeeClosingId(storeId, period, employeeId),
      period,
      storeId,
      storeName: summary.storeName,
      employeeId,
      employeeCode: employee.code,
      employeeName: employee.name,
      employeeStatusAtLock: employmentStatus,
      item,
      status: "BASE_LOCKED",
      kpiDeferred,
      lockedAt,
      lockedBy: user.id,
    };
    const result = await db.prepare(`INSERT OR IGNORE INTO employee_payroll_closings
      (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(employeeClosing.id, storeId, employeeId, period, JSON.stringify(employeeClosing), employmentStatus, employeeClosing.status, lockedAt, user.id).run();
    const saved = (await employeePayrollClosings(db, storeId, period)).find((closing) => closing.employeeId === employeeId);
    if (!saved) return json({ message: "Không thể khóa sổ lương nhân viên." }, 409);
    if (affectedRows(result) > 0) {
      await writeAudit(user.id, "EMPLOYEE_PAYROLL_LOCK", "EMPLOYEE_PAYROLL_CLOSING", saved.id, JSON.stringify({
        storeId,
        period,
        employeeId,
        employeeStatusAtLock: employmentStatus,
        totalPay: saved.item.totalPay,
        kpiDeferred: saved.kpiDeferred,
      }));
    }
    return json({
      employeeClosing: saved,
      message: summary.status === "LOCKED"
        ? "Đã khóa các khoản lương xác định của nhân viên. KPI giữ theo bảng lương tổng đã khóa của cửa hàng."
        : "Đã khóa lương cơ bản và các khoản xác định của nhân viên. KPI sẽ được tính chính xác khi chốt kỳ cửa hàng.",
    }, affectedRows(result) > 0 ? 201 : 200);
  }
  if (action !== "FINALIZE_EMPLOYEE") {
    const employeeSummary = await lockedSummary(db, storeId, period);
    if (!employeeSummary) return json({ message: "Hãy chốt lương thưởng nhân viên trước." }, 409);
    const existing = await payrollClosing(db, storeId, period);
    const now = utcTimestamp();

    if (action === "FINALIZE_MANAGER") {
      if (existing) return json({ closing: existing, message: "Lương thưởng quản lý đã được chốt." });
      const closedEmployees = new Set((await employeePayrollClosings(db, storeId, period)).map((item) => item.employeeId));
      const missingEmployees = employeeSummary.items.filter((item) => !closedEmployees.has(item.employeeId));
      if (missingEmployees.length > 0) {
        return json({
          message: `Hãy chốt lương riêng cho từng nhân viên trước khi chốt lương quản lý. Còn ${missingEmployees.length} nhân viên chưa khóa sổ.`,
          missingEmployeeIds: missingEmployees.map((item) => item.employeeId),
        }, 409);
      }
      const managerSalary = employeeSummary.managerSalary ?? MANAGER_MONTHLY_SALARY_VND;
      const managerBonus = employeeSummary.managerBonus ?? managerProfitBonus(employeeSummary.profit);
      const managerTotal = sumVnd([managerSalary, managerBonus]);
      const salaryTotal = sumVnd([employeeSummary.totalBaseSalary, managerSalary]);
      const employeeRewards = employeeSummary.totalPay - employeeSummary.totalBaseSalary;
      const rewardAllowanceTotal = sumVnd([employeeRewards, managerBonus]);
      const closing: PayrollClosing = {
        period,
        storeId,
        storeName: employeeSummary.storeName,
        employeeTotal: employeeSummary.totalPay,
        managerSalary,
        managerBonus,
        managerTotal,
        salaryTotal,
        rewardAllowanceTotal,
        grandTotal: sumVnd([employeeSummary.totalPay, managerTotal]),
        status: "MANAGER_FINALIZED",
        managerFinalizedAt: now,
        managerFinalizedBy: user.id,
      };
      const id = closingId(storeId, period);
      try {
        await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'PAYROLL_CLOSING', ?, ?, ?, ?, 'MANAGER_FINALIZED', ?, ?)")
          .bind(id, storeId, user.id, `Kết sổ lương ${period}`, JSON.stringify(closing), now, now).run();
      } catch {
        const current = await payrollClosing(db, storeId, period);
        if (current) return json({ closing: current, message: "Lương thưởng quản lý đã được chốt." });
        return json({ message: "Không thể chốt lương thưởng quản lý." }, 409);
      }
      await writeAudit(user.id, "MANAGER_PAYROLL_FINALIZE", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, managerSalary, managerBonus }));
      return json({ closing, message: "Đã chốt lương thưởng quản lý." }, 201);
    }

    if (!existing) return json({ message: "Hãy chốt lương thưởng quản lý trước." }, 409);
    const id = closingId(storeId, period);
    if (action === "CONFIRM_SALARY") {
      if (["SALARY_CONFIRMED", "REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"].includes(existing.status)) return json({ closing: existing, message: "Khoản chi lương đã được xác nhận." });
      if (existing.status !== "MANAGER_FINALIZED") return json({ message: "Trạng thái kỳ lương không hợp lệ để xác nhận chi lương." }, 409);
      const closing: PayrollClosing = { ...existing, status: "SALARY_CONFIRMED", salaryConfirmedAt: now, salaryConfirmedBy: user.id };
      const result = await db.prepare("UPDATE business_records SET data_json = ?, status = 'SALARY_CONFIRMED', updated_at = ? WHERE id = ? AND status = 'MANAGER_FINALIZED'")
        .bind(JSON.stringify(closing), now, id).run();
      if (affectedRows(result) === 0) {
        const current = await payrollClosing(db, storeId, period);
        return current
          ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
          : json({ message: "Không thể xác nhận khoản chi lương." }, 409);
      }
      await writeAudit(user.id, "PAYROLL_SALARY_CONFIRM", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, amount: closing.salaryTotal }));
      return json({ closing, message: "Đã xác nhận khoản chi lương nhân viên và quản lý." });
    }
    if (action === "CONFIRM_REWARDS") {
      if (["REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"].includes(existing.status)) return json({ closing: existing, message: "Khoản thưởng và phụ cấp đã được xác nhận." });
      if (existing.status !== "SALARY_CONFIRMED") return json({ message: "Hãy xác nhận khoản chi lương trước." }, 409);
      const closing: PayrollClosing = { ...existing, status: "REWARDS_CONFIRMED", rewardsConfirmedAt: now, rewardsConfirmedBy: user.id };
      const result = await db.prepare("UPDATE business_records SET data_json = ?, status = 'REWARDS_CONFIRMED', updated_at = ? WHERE id = ? AND status = 'SALARY_CONFIRMED'")
        .bind(JSON.stringify(closing), now, id).run();
      if (affectedRows(result) === 0) {
        const current = await payrollClosing(db, storeId, period);
        return current
          ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
          : json({ message: "Không thể xác nhận khoản thưởng và phụ cấp." }, 409);
      }
      await writeAudit(user.id, "PAYROLL_REWARDS_CONFIRM", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, amount: closing.rewardAllowanceTotal }));
      return json({ closing, message: "Đã xác nhận khoản chi thưởng và phụ cấp." });
    }
    if (action === "CONFIRM_PAYMENT") {
      if (existing.status === "LOCKED") return json({ closing: existing, message: "Kỳ lương đã kết sổ và khóa." });
      if (existing.status === "PAYMENT_CONFIRMED") return json({ closing: existing, message: "Đã ghi nhận chi trả lương, thưởng và phụ cấp." });
      if (existing.status !== "REWARDS_CONFIRMED") return json({ message: "Hãy xác nhận riêng khoản chi lương và khoản thưởng, phụ cấp trước." }, 409);
      const closing: PayrollClosing = { ...existing, status: "PAYMENT_CONFIRMED", paymentConfirmedAt: now, paymentConfirmedBy: user.id };
      const result = await db.prepare("UPDATE business_records SET data_json = ?, status = 'PAYMENT_CONFIRMED', updated_at = ? WHERE id = ? AND status = 'REWARDS_CONFIRMED'")
        .bind(JSON.stringify(closing), now, id).run();
      if (affectedRows(result) === 0) {
        const current = await payrollClosing(db, storeId, period);
        return current
          ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
          : json({ message: "Không thể ghi nhận chi trả lương thưởng." }, 409);
      }
      await writeAudit(user.id, "PAYROLL_PAYMENT_CONFIRM", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, grandTotal: closing.grandTotal }));
      return json({ closing, message: "Đã chi và ghi nhận lịch sử chi lương, thưởng, phụ cấp." });
    }

    if (existing.status === "LOCKED") return json({ closing: existing, message: "Kỳ lương đã kết sổ và khóa." });
    if (action !== "CLOSE_PERIOD") return json({ message: "Thao tác chốt kỳ lương không hợp lệ." }, 400);
    if (existing.status !== "PAYMENT_CONFIRMED") return json({ message: "Hãy xác nhận chi trước khi kết sổ." }, 409);
    const closing: PayrollClosing = { ...existing, status: "LOCKED", closedAt: now, closedBy: user.id };
    const result = await db.prepare("UPDATE business_records SET data_json = ?, status = 'LOCKED', updated_at = ? WHERE id = ? AND status = 'PAYMENT_CONFIRMED'")
      .bind(JSON.stringify(closing), now, id).run();
    if (affectedRows(result) === 0) {
      const current = await payrollClosing(db, storeId, period);
      return current
        ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
        : json({ message: "Không thể kết sổ kỳ lương." }, 409);
    }
    await writeAudit(user.id, "PAYROLL_PERIOD_CLOSE", "PAYROLL_CLOSING", id, JSON.stringify({ storeId, period, grandTotal: closing.grandTotal }));
    return json({ closing, message: "Đã kết sổ và khóa kỳ lương thưởng." });
  }

  if (await lockedSummary(db, storeId, period)) return json({ message: "Kỳ lương này đã được tổng kết và khóa" }, 409);
  if (period >= localPeriod()) return json({ message: "Chỉ được tổng kết lương, thưởng và KPI sau khi tháng làm việc đã kết thúc." }, 409);
  const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
  const openShift = await db.prepare(`SELECT id FROM shift_sessions
    WHERE store_id = ? AND status = 'ACTIVE' AND (
      (NULLIF(work_date, '') IS NOT NULL AND work_date >= ? AND work_date < ?)
      OR (NULLIF(work_date, '') IS NULL AND started_at >= ? AND started_at < ?)
    ) LIMIT 1`)
    .bind(storeId, localStart, localEnd, startUtc, endUtc).first<{ id: string }>();
  if (openShift) return json({ message: "Cửa hàng còn ca làm trong kỳ chưa kết thúc. Hãy kết ca trước khi chốt lương." }, 409);
  const preview = await buildPreview(db, storeId, period);
  if (!preview) return json({ message: "Không tìm thấy cửa hàng" }, 404);
  const closedEmployees = new Set((await employeePayrollClosings(db, storeId, period)).map((item) => item.employeeId));
  const missingEmployees = preview.items.filter((item) => !closedEmployees.has(item.employeeId));
  if (missingEmployees.length > 0) {
    return json({
      message: `Hãy chốt lương riêng cho từng nhân viên trước khi khóa bảng lương cửa hàng. Còn ${missingEmployees.length} nhân viên chưa khóa sổ.`,
      missingEmployeeIds: missingEmployees.map((item) => item.employeeId),
    }, 409);
  }
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
