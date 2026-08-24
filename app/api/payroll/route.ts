import { initDb } from "../../../db/runtime";
import {
  canClosePayrollPeriod, durationMinutes, localPeriod,
  multiplyRatioVnd, periodBoundsUtc, requireVnd, sumVnd, utcTimestamp,
} from "../../lib/finance";
import {
  employeePayWithKpi,
  employeePayrollOverallState,
  payrollAdjustmentTotals,
} from "../../lib/payroll";
import { calculateFinance } from "../../lib/finance-engine";
import { calculateKpi } from "../../lib/kpi-engine";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";
import {
  employeeFinancialStatusForPeriod,
  employeeStatusAtInstantSql,
} from "../_lib/employee-lifecycle";
import { storePeriodFinance, type StoreExpenseBreakdown } from "../_lib/store-finance";
import { salaryAdvanceCoverage, salaryAdvanceSettlementSplit, salaryAdvanceTotals } from "../../lib/salary-advances";
import { payrollPolicyPayload, type PayrollPolicySnapshot } from "../../lib/payroll-policy";
import { loadFinancialPolicyForPeriod, type FinancialPolicyVersion } from "../_lib/financial-policy";
import {
  buildCashflowEntry,
  prepareCashflowEntryInsertWhere,
} from "../_lib/cashflow-ledger";
import {
  assertFinancialPeriodPlanApplied,
  prepareFinancialPeriodDraftPlan,
  prepareFinancialPeriodTransitionPlan,
  readFinancialPeriodLifecycleRow,
  type FinancialPeriodCalculationInput,
  type FinancialPeriodLifecycleRow,
} from "../_lib/financial-period-lifecycle";

type EmployeeRow = {
  id: string;
  code: string;
  name: string;
  position: string;
  hourlyRate: number;
  status: "ACTIVE" | "SUSPENDED" | "TERMINATED" | "INACTIVE" | "ARCHIVED";
  statusAtPeriodEnd: string;
  hasLifecycleHistory: number;
  inactivePeriod: string | null;
};

type HoursRow = {
  employeeId: string;
  durationSeconds: number;
  kpiDurationSeconds: number;
  appliedHourlyRate: number | null;
  tiktokAllowance: number;
  completedShiftCount: number;
  kpiCompletedShiftCount: number;
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
  id: string;
  kind: "ALLOWANCE" | "BONUS";
  employeeId: string;
  amount: number;
  date: string;
  note: string;
};

type PayrollAdjustmentDetail = {
  id: string;
  kind: "ALLOWANCE" | "BONUS";
  label: string;
  amount: number;
  date: string;
  storeId: string;
  storeName: string;
};

type PayrollItem = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  position: string;
  employmentStatus: "ACTIVE" | "INACTIVE";
  completedShiftCount: number;
  kpiCompletedShiftCount: number;
  kpiEligible: boolean;
  durationSeconds: number;
  durationMinutes: number;
  hours: number;
  kpiDurationSeconds: number;
  kpiHours: number;
  hourlyRate: number;
  baseSalary: number;
  tiktokAllowance: number;
  supportAllowance: number;
  manualAllowance: number;
  manualBonus: number;
  adjustments: PayrollAdjustmentDetail[];
  kpiBonus: number;
  totalPay: number;
  salaryAdvancePending: number;
  salaryAdvancePaid: number;
  salaryAdvanceReserved: number;
  salaryAdvanceCoverageGap: number;
  salaryAdvanceOverpaymentDebt: number;
  availablePay: number;
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
  kpiEligibleHours: number;
  kpiEligibleDurationSeconds: number;
  totalKpiHours: number;
  totalKpiDurationSeconds: number;
  profitPerHour: number;
  profitPerKpiHour: number;
  kpiRate: number;
  kpiPool: number;
  totalBaseSalary: number;
  totalTikTokAllowance: number;
  totalSupportAllowance: number;
  totalManualAllowance: number;
  totalManualBonus: number;
  totalKpiBonus: number;
  totalPerformanceBonus: number;
  managerSalary: number;
  managerBonus: number;
  managerTotal: number;
  payrollPolicy?: ReturnType<typeof payrollPolicyPayload>;
  financialPolicyVersionId?: string;
  financialPolicyConfigVersion?: number;
  financialPolicySnapshot?: FinancialPolicyVersion["policy"];
  totalPay: number;
  totalSalaryAdvancePending: number;
  totalSalaryAdvancePaid: number;
  totalSalaryAdvanceReserved: number;
  totalSalaryAdvanceCoverageGap: number;
  totalSalaryAdvanceOverpaymentDebt: number;
  totalAvailablePay: number;
  items: PayrollItem[];
  status: "PREVIEW" | "LOCKED";
  finalizedAt?: string;
  finalizedBy?: string;
};

type PublicFinancialPeriod = {
  id: string;
  storeId: string;
  period: string;
  status: FinancialPeriodLifecycleRow["status"];
  revision: number;
  calculatedAt: string | null;
  confirmedAt: string | null;
  paidAt: string | null;
  lockedAt: string | null;
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
  hourlyRate: number | null;
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
  employeeGrossTotal?: number;
  salaryAdvancePaidTotal?: number;
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

// A closing snapshot is built after this short-lived database gate is
// acquired. Ten minutes is far beyond a normal preview calculation, while
// still allowing a request interrupted by a worker restart to recover.
const PAYROLL_GATE_STALE_MS = 10 * 60 * 1_000;

function payrollGateToken(scope: string) {
  return `payroll-gate:${scope}:${crypto.randomUUID()}`;
}

function stalePayrollGateCutoff() {
  return new Date(Date.now() - PAYROLL_GATE_STALE_MS).toISOString();
}

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

// Read-only compatibility for locked rows written before manager salary was
// embedded in a policy/snapshot. New calculations must never use this value.
const LEGACY_LOCKED_MANAGER_SALARY_VND = 3_000_000;

function lockedManagerSalary(closing: PayrollClosing, summary: PayrollSummary) {
  const snapshotted = closing.managerSalary ?? summary.payrollPolicy?.managerMonthlySalaryVnd;
  if (Number.isSafeInteger(snapshotted) && Number(snapshotted) >= 0) return Number(snapshotted);
  return LEGACY_LOCKED_MANAGER_SALARY_VND;
}

function managerSalaryForNewClosing(summary: PayrollSummary) {
  const policySalary = summary.payrollPolicy?.managerMonthlySalaryVnd;
  if (!Number.isSafeInteger(policySalary) || Number(policySalary) < 0) {
    throw new Error("Thiếu snapshot chính sách lương quản lý của kỳ.");
  }
  const managerSalary = requireVnd(summary.managerSalary, "Lương quản lý");
  if (managerSalary !== Number(policySalary)) {
    throw new Error("Lương quản lý không khớp snapshot chính sách của kỳ.");
  }
  return managerSalary;
}

function assertPayrollComponent(label: string, actual: number, expected: number, storeId: string, period: string) {
  if (!Number.isSafeInteger(actual) || !Number.isSafeInteger(expected) || actual !== expected) {
    throw new Error(`Bất nhất bảng lương ${storeId}/${period}: ${label} (${actual} != ${expected}).`);
  }
}

function assertPayrollSummaryInvariants(summary: PayrollSummary) {
  const rowBaseSalary = sumVnd(summary.items.map((item) => item.baseSalary));
  const rowTikTok = sumVnd(summary.items.map((item) => item.tiktokAllowance));
  const rowSupport = sumVnd(summary.items.map((item) => item.supportAllowance));
  const rowManualAllowance = sumVnd(summary.items.map((item) => item.manualAllowance));
  const rowManualBonus = sumVnd(summary.items.map((item) => item.manualBonus));
  const rowEmployeeKpi = sumVnd(summary.items.map((item) => item.kpiBonus));
  const rowTotalPay = sumVnd(summary.items.map((item) => item.totalPay));

  assertPayrollComponent("lương cơ bản theo dòng/tổng", rowBaseSalary, summary.totalBaseSalary, summary.storeId, summary.period);
  assertPayrollComponent("lương cơ bản payroll/finance", summary.totalBaseSalary, summary.costBreakdown.employeeBaseSalary, summary.storeId, summary.period);
  assertPayrollComponent("phụ cấp TikTok theo dòng/tổng", rowTikTok, summary.totalTikTokAllowance, summary.storeId, summary.period);
  assertPayrollComponent("phụ cấp TikTok payroll/finance", summary.totalTikTokAllowance, summary.costBreakdown.tiktokAllowance, summary.storeId, summary.period);
  assertPayrollComponent("phụ cấp hỗ trợ theo dòng/tổng", rowSupport, summary.totalSupportAllowance, summary.storeId, summary.period);
  assertPayrollComponent("phụ cấp hỗ trợ payroll/finance", summary.totalSupportAllowance, summary.costBreakdown.supportAllowance, summary.storeId, summary.period);
  assertPayrollComponent("phụ cấp khác theo dòng/tổng", rowManualAllowance, summary.totalManualAllowance, summary.storeId, summary.period);
  assertPayrollComponent("phụ cấp khác payroll/finance", summary.totalManualAllowance, summary.costBreakdown.manualAllowance, summary.storeId, summary.period);
  assertPayrollComponent("thưởng khác theo dòng/tổng", rowManualBonus, summary.totalManualBonus, summary.storeId, summary.period);
  assertPayrollComponent("thưởng khác payroll/finance", summary.totalManualBonus, summary.costBreakdown.manualBonus, summary.storeId, summary.period);
  assertPayrollComponent("KPI nhân viên theo dòng/tổng", rowEmployeeKpi, summary.totalKpiBonus, summary.storeId, summary.period);
  assertPayrollComponent("KPI nhân viên payroll/finance", summary.totalKpiBonus, summary.costBreakdown.employeeKpiBonus, summary.storeId, summary.period);
  assertPayrollComponent("lương quản lý payroll/finance", summary.managerSalary, summary.costBreakdown.managerSalary, summary.storeId, summary.period);
  assertPayrollComponent("KPI quản lý payroll/finance", summary.managerBonus, summary.costBreakdown.managerBonus, summary.storeId, summary.period);
  assertPayrollComponent("tổng quản lý", summary.managerTotal, sumVnd([summary.managerSalary, summary.managerBonus]), summary.storeId, summary.period);
  assertPayrollComponent("tổng nhân viên", summary.totalPay, rowTotalPay, summary.storeId, summary.period);
  assertPayrollComponent("tổng KPI", summary.totalPerformanceBonus, sumVnd([summary.totalKpiBonus, summary.managerBonus]), summary.storeId, summary.period);

  const policySalary = summary.payrollPolicy?.managerMonthlySalaryVnd;
  if (!Number.isSafeInteger(policySalary)) {
    throw new Error(`Bất nhất bảng lương ${summary.storeId}/${summary.period}: thiếu snapshot lương quản lý.`);
  }
  assertPayrollComponent("lương quản lý payroll/chính sách", summary.managerSalary, Number(policySalary), summary.storeId, summary.period);
}

/**
 * Keep the existing payroll API payload stable while sourcing every mutable
 * preview field from the immutable financial-policy version effective for the
 * requested period.
 */
function payrollPolicySnapshotFromVersion(version: FinancialPolicyVersion): PayrollPolicySnapshot {
  return {
    schemaVersion: 1,
    managerMonthlySalaryVnd: version.policy.managerMonthlySalaryVnd,
    managerKpiRateBasisPoints: version.policy.managerKpiRateBasisPoints,
    employeeKpiTiers: version.policy.employeeKpiTiers.map((tier) => ({ ...tier })),
    version: version.version,
    updatedBy: version.createdBy,
    mutationToken: version.id,
    rawValue: version.policyJson,
    updatedAt: version.createdAt,
  };
}

function financialPeriodId(storeId: string, period: string) {
  return `financial-period:${storeId}:${period}`;
}

function publicFinancialPeriod(
  storeId: string,
  period: string,
  row: FinancialPeriodLifecycleRow | null,
): PublicFinancialPeriod {
  return row ? {
    id: row.id,
    storeId: row.storeId,
    period: row.period,
    status: row.status,
    revision: row.revision,
    calculatedAt: row.calculatedAt,
    confirmedAt: row.confirmedAt,
    paidAt: row.paidAt,
    lockedAt: row.lockedAt,
  } : {
    id: financialPeriodId(storeId, period),
    storeId,
    period,
    status: "DRAFT",
    revision: 0,
    calculatedAt: null,
    confirmedAt: null,
    paidAt: null,
    lockedAt: null,
  };
}

function financialPeriodCalculation(summary: PayrollSummary): FinancialPeriodCalculationInput {
  if (!summary.financialPolicyVersionId
    || !Number.isSafeInteger(summary.financialPolicyConfigVersion)
    || !summary.financialPolicySnapshot
    || !summary.payrollPolicy) {
    throw new Error("Thiếu snapshot chính sách tài chính của kỳ.");
  }
  const cost = summary.costBreakdown;
  return {
    policyVersionId: summary.financialPolicyVersionId,
    configVersion: Number(summary.financialPolicyConfigVersion),
    finance: {
      grossRevenue: summary.revenue,
      fixedExpense: cost.fixedCosts,
      variableExpense: cost.incidentalCosts,
      inventoryCost: cost.inventoryGoods,
      inventoryShippingCost: cost.inventoryShipping,
      employeeSalary: cost.employeeBaseSalary,
      managerSalary: cost.managerSalary,
      manualEmployeeBonus: cost.manualBonus,
      employeeAllowance: sumVnd([
        cost.tiktokAllowance,
        cost.supportAllowance,
        cost.manualAllowance,
      ]),
      employeeKpiTotal: cost.employeeKpiBonus,
      managerKpi: cost.managerBonus,
      monthEndExpense: cost.monthEndExpenses,
    },
    totalHoursSeconds: summary.totalDurationSeconds,
    salaryAdvance: summary.totalSalaryAdvanceReserved,
    employeePayrollRows: summary.items,
    managerPayroll: {
      storeId: summary.storeId,
      storeName: summary.storeName,
      managerSalary: summary.managerSalary,
      managerBonus: summary.managerBonus,
      managerTotal: summary.managerTotal,
    },
    configSnapshot: {
      financialPolicy: summary.financialPolicySnapshot,
      payrollPolicy: summary.payrollPolicy,
      payrollSummary: summary,
      payrollMetrics: {
        totalDurationSeconds: summary.totalDurationSeconds,
        kpiEligibleDurationSeconds: summary.kpiEligibleDurationSeconds,
        totalKpiDurationSeconds: summary.totalKpiDurationSeconds,
        profitPerHour: summary.profitPerHour,
        profitPerKpiHour: summary.profitPerKpiHour,
        kpiRate: summary.kpiRate,
        kpiPool: summary.kpiPool,
      },
    },
  };
}

function payrollSummaryFromFinancialPeriod(row: FinancialPeriodLifecycleRow | null) {
  const persisted = row?.snapshot?.configSnapshot.payrollSummary;
  if (!persisted) return null;
  const summary = parseData<PayrollSummary>(JSON.stringify(persisted));
  if (!summary) return null;
  assertPayrollSummaryInvariants(summary);
  return summary;
}

async function ensureFinancialPeriodDraft(
  db: Awaited<ReturnType<typeof initDb>>,
  input: Readonly<{
    storeId: string;
    period: string;
    actorId: string;
    now: string;
    reason: string;
  }>,
) {
  const current = await readFinancialPeriodLifecycleRow(db, input.storeId, input.period);
  if (current) return current;
  const plan = prepareFinancialPeriodDraftPlan(db, {
    id: financialPeriodId(input.storeId, input.period),
    storeId: input.storeId,
    period: input.period,
    actorId: input.actorId,
    now: input.now,
    reason: input.reason,
  });
  const results = await db.batch([...plan.statements]);
  try {
    assertFinancialPeriodPlanApplied(results, plan);
  } catch {
    const concurrent = await readFinancialPeriodLifecycleRow(db, input.storeId, input.period);
    if (concurrent) return concurrent;
    throw new Error("Không thể khởi tạo kỳ tài chính.");
  }
  const created = await readFinancialPeriodLifecycleRow(db, input.storeId, input.period);
  if (!created) throw new Error("Không thể đọc kỳ tài chính vừa khởi tạo.");
  return created;
}

function requestedRevisionMatches(
  requestedRevision: number | undefined,
  row: FinancialPeriodLifecycleRow | null,
) {
  if (requestedRevision === undefined) return true;
  return Number.isSafeInteger(requestedRevision)
    && requestedRevision >= 0
    && requestedRevision === (row?.revision ?? 0);
}

const financialPeriodStatusRank: Record<FinancialPeriodLifecycleRow["status"], number> = {
  DRAFT: 0,
  CALCULATED: 1,
  RECONCILING: 2,
  CONFIRMED: 3,
  PAID: 4,
  LOCKED: 5,
};

function financialPeriodReached(
  row: FinancialPeriodLifecycleRow,
  status: FinancialPeriodLifecycleRow["status"],
) {
  return financialPeriodStatusRank[row.status] >= financialPeriodStatusRank[status];
}

async function payrollAdjustments(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  period: string,
) {
  const rows = await db.prepare("SELECT id, data_json FROM business_records WHERE category = 'LUONG_THUONG' AND store_id = ? AND status != 'DELETED' ORDER BY created_at")
    .bind(storeId).all<{ id: string; data_json: string }>();
  return rows.results.flatMap((record): PayrollAdjustment[] => {
    const data = parseData<Partial<Omit<PayrollAdjustment, "id">>>(record.data_json);
    const kind = data?.kind === "ALLOWANCE" ? "ALLOWANCE" as const : data?.kind === "BONUS" ? "BONUS" as const : null;
    const employeeId = String(data?.employeeId ?? "").trim();
    const amount = safePayrollVnd(data?.amount);
    const date = String(data?.date ?? "");
    const note = String(data?.note ?? "").trim();
    if (!kind || !employeeId || amount <= 0 || date.slice(0, 7) !== period) return [];
    return [{ id: record.id, kind, employeeId, amount, date, note: note || (kind === "ALLOWANCE" ? "Phụ cấp khác" : "Thưởng khác") }];
  });
}

function adjustmentDetails(
  adjustments: PayrollAdjustment[],
  employeeId: string,
  storeId: string,
  storeName: string,
) {
  return adjustments.filter((item) => item.employeeId === employeeId).map((item): PayrollAdjustmentDetail => ({
    id: item.id,
    kind: item.kind,
    label: item.note,
    amount: item.amount,
    date: item.date,
    storeId,
    storeName,
  }));
}

function mergePayrollItems(items: PayrollItem[]) {
  if (items.length === 0) return null;
  return items.slice(1).reduce<PayrollItem>((total, current) => {
    const durationSeconds = (total.durationSeconds ?? Math.round(total.hours * 3_600))
      + (current.durationSeconds ?? Math.round(current.hours * 3_600));
    const baseSalary = sumVnd([total.baseSalary, current.baseSalary]);
    const adjustments = new Map<string, PayrollAdjustmentDetail>();
    for (const adjustment of [...(total.adjustments ?? []), ...(current.adjustments ?? [])]) {
      adjustments.set(`${adjustment.storeId}:${adjustment.id}`, adjustment);
    }
    return {
      ...total,
      employmentStatus: total.employmentStatus === "INACTIVE" || current.employmentStatus === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      completedShiftCount: (total.completedShiftCount ?? 0) + (current.completedShiftCount ?? 0),
      kpiEligible: Boolean(total.kpiEligible || current.kpiEligible),
      durationSeconds,
      durationMinutes: durationMinutes(durationSeconds),
      hours: durationSeconds / 3_600,
      baseSalary,
      tiktokAllowance: sumVnd([total.tiktokAllowance, current.tiktokAllowance]),
      supportAllowance: sumVnd([total.supportAllowance, current.supportAllowance]),
      manualAllowance: sumVnd([total.manualAllowance, current.manualAllowance]),
      manualBonus: sumVnd([total.manualBonus, current.manualBonus]),
      adjustments: [...adjustments.values()],
      kpiBonus: sumVnd([total.kpiBonus, current.kpiBonus]),
      totalPay: sumVnd([total.totalPay, current.totalPay]),
      salaryAdvancePending: sumVnd([total.salaryAdvancePending ?? 0, current.salaryAdvancePending ?? 0]),
      salaryAdvancePaid: sumVnd([total.salaryAdvancePaid ?? 0, current.salaryAdvancePaid ?? 0]),
      salaryAdvanceReserved: sumVnd([total.salaryAdvanceReserved ?? 0, current.salaryAdvanceReserved ?? 0]),
      salaryAdvanceCoverageGap: sumVnd([total.salaryAdvanceCoverageGap ?? 0, current.salaryAdvanceCoverageGap ?? 0]),
      salaryAdvanceOverpaymentDebt: sumVnd([total.salaryAdvanceOverpaymentDebt ?? 0, current.salaryAdvanceOverpaymentDebt ?? 0]),
      availablePay: sumVnd([total.availablePay ?? total.totalPay, current.availablePay ?? current.totalPay]),
      // Every source belongs to the same employee. Keep the manager-set base
      // rate instead of reverse-calculating a rate from rounded salary.
      hourlyRate: total.hourlyRate,
    };
  }, { ...items[0], adjustments: [...(items[0].adjustments ?? [])] });
}

function isPayrollAction(value: unknown): value is PayrollAction {
  return typeof value === "string" && payrollActions.has(value as PayrollAction);
}

function salaryAdvanceCoverageConflict(summary: PayrollSummary, employeeId?: string) {
  const coverage = salaryAdvanceCoverage(employeeId
    ? summary.items.filter((item) => item.employeeId === employeeId)
    : summary.items);
  if (coverage.covered) return null;
  const employees = coverage.employees.filter((item) => item.coverageGap > 0);
  return json({
    code: "SALARY_ADVANCE_UNDERFUNDED",
    message: "Không thể chốt hoặc xác nhận chi lương vì lương hiện tại không còn đủ bù các khoản ứng đã tạo/đã chi. Hãy điều chỉnh dữ liệu lương và đối soát khoản ứng trước.",
    salaryAdvanceCoverage: {
      covered: false,
      totalCoverageGap: coverage.totalCoverageGap,
      totalOverpaymentDebt: coverage.totalOverpaymentDebt,
      employees,
    },
  }, 409);
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

async function managerPayrollPeriod(db: Awaited<ReturnType<typeof initDb>>, period: string, storeId: string | null = null) {
  const policyVersion = await loadFinancialPolicyForPeriod(db, period);
  const effectivePolicy = policyVersion.policy;
  const storeClause = storeId ? " AND store_id = ?" : "";
  const statement = db.prepare(`
    SELECT data_json AS dataJson
    FROM business_records
    WHERE category = 'PAYROLL_CLOSING' AND status = 'LOCKED'
      AND json_extract(data_json, '$.period') = ?
      ${storeClause}
    ORDER BY json_extract(data_json, '$.storeName')
  `);
  const result = storeId
    ? await statement.bind(period, storeId).all<{ dataJson: string }>()
    : await statement.bind(period).all<{ dataJson: string }>();
  const rows = (await Promise.all(result.results.map(async (record) => {
    const closing = parseData<PayrollClosing>(record.dataJson);
    if (!closing || closing.status !== "LOCKED") return null;
    const summary = await lockedSummary(db, closing.storeId, period);
    if (!summary) return null;
    const managerSalary = lockedManagerSalary(closing, summary);
    const managerBonus = safePayrollVnd(closing.managerBonus);
    const managerTotal = sumVnd([managerSalary, managerBonus]);
    return {
      period,
      storeId: closing.storeId,
      storeName: closing.storeName,
      profitBeforePerformanceRewards: summary.profit,
      employeeKpiBonus: summary.totalKpiBonus,
      finalProfit: summary.netProfit,
      // Retained as a response field for old manager-report clients only. KPI
      // no longer invents fixed manager hours or shares an employee-hour pool.
      managerHours: 0,
      employeeEligibleHours: summary.kpiEligibleHours ?? 0,
      totalKpiHours: summary.totalKpiHours ?? summary.kpiEligibleHours ?? 0,
      profitPerKpiHour: summary.profitPerKpiHour ?? summary.profitPerHour ?? 0,
      kpiRate: summary.kpiRate ?? 0,
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
    policy: {
      salaryPerStore: effectivePolicy.managerMonthlySalaryVnd,
      managerHoursPerStore: 0,
      managerKpiRate: effectivePolicy.managerKpiRateBasisPoints / 10_000,
      tiers: effectivePolicy.employeeKpiTiers.map((tier) => ({
        minimumProfitPerHour: tier.minimumProfitPerHour,
        rate: tier.rateBasisPoints / 10_000,
      })),
      version: policyVersion.version,
    },
    rows,
    totals: { storeCount: rows.length, totalSalary, totalBonus, totalPay: sumVnd([totalSalary, totalBonus]) },
  };
}

async function buildPreview(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  period: string,
): Promise<PayrollSummary | null> {
  const policyVersion = await loadFinancialPolicyForPeriod(db, period);
  const financePolicy = policyVersion.policy;
  const payrollPolicy = payrollPolicySnapshotFromVersion(policyVersion);
  // Use the same immutable policy value for finance and payroll calculations.
  // A concurrent superadmin save can affect the next preview, but never split
  // one preview across two policy versions.
  const store = await storePeriodFinance(db, storeId, period, financePolicy);
  if (!store) return null;

  const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
  const statusAtPeriodEndSql = employeeStatusAtInstantSql("e");
  const employeesResult = await db.prepare(`
    WITH employee_period_state AS (
      SELECT e.*, strftime('%Y-%m', e.inactive_at, '+7 hours') AS inactivePeriod,
        ${statusAtPeriodEndSql} AS statusAtPeriodEnd,
        EXISTS(SELECT 1 FROM employee_status_history lifecycle_any
          WHERE lifecycle_any.employee_id = e.id) AS hasLifecycleHistory
      FROM employees e
    )
    SELECT id, code, name, position, hourly_rate AS hourlyRate, status,
      statusAtPeriodEnd, hasLifecycleHistory, inactivePeriod
    FROM employee_period_state e
    WHERE (
      (e.statusAtPeriodEnd IN ('ACTIVE', 'SUSPENDED') AND e.store_id = ?)
      OR (e.store_id = ? AND (
        EXISTS (
          SELECT 1 FROM employee_status_history lifecycle_exit
          WHERE lifecycle_exit.employee_id = e.id
            AND lifecycle_exit.effective_at >= ? AND lifecycle_exit.effective_at < ?
            AND lifecycle_exit.to_status IN ('TERMINATED', 'INACTIVE', 'ARCHIVED')
        )
        OR (e.hasLifecycleHistory = 0 AND e.status IN ('TERMINATED', 'INACTIVE')
          AND e.inactivePeriod = ?)
      ))
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
  `).bind(
    endUtc,
    storeId,
    storeId, startUtc, endUtc, period,
    storeId, localStart, localEnd, startUtc, endUtc,
    storeId, localEnd, localStart,
    storeId, period,
    storeId, period,
  ).all<EmployeeRow>();
  const hoursResult = await db.prepare(`
    SELECT s.employee_id AS employeeId,
      SUM(COALESCE(s.admin_adjusted_duration_seconds,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END
      )) AS durationSeconds,
      SUM(COALESCE(s.admin_adjusted_duration_seconds,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END
      )) AS kpiDurationSeconds,
      COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
      COALESCE(SUM(s.tiktok_allowance), 0) AS tiktokAllowance,
      SUM(CASE WHEN COALESCE(s.admin_adjusted_duration_seconds,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END) > 0
        THEN 1 ELSE 0 END) AS completedShiftCount,
      SUM(CASE WHEN COALESCE(s.admin_adjusted_duration_seconds,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END) > 0
        THEN 1 ELSE 0 END) AS kpiCompletedShiftCount
    FROM shift_sessions s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.store_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
      AND COALESCE(s.reconciliation_status, 'CLEAR') IN ('CLEAR', 'CONFIRMED')
      AND (
        (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
        OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
      )
    GROUP BY s.employee_id, COALESCE(s.applied_hourly_rate, e.hourly_rate)
  `).bind(storeId, localStart, localEnd, startUtc, endUtc).all<HoursRow>();

  const transferAllowances = await db.prepare(`
    SELECT t.id, t.employee_id AS employeeId,
      COALESCE(MAX(s.applied_support_allowance), 0) AS supportAllowance
    FROM employee_transfers t
    JOIN shift_sessions s ON s.transfer_id = t.id AND s.store_id = t.target_store_id
    WHERE t.target_store_id = ?
      AND t.start_date < ? AND t.end_date >= ?
      AND s.status = 'COMPLETED'
      AND COALESCE(s.reconciliation_status, 'CLEAR') IN ('CLEAR', 'CONFIRMED')
      AND (
        (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
        OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
      )
      AND COALESCE(s.admin_adjusted_duration_seconds,
        CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
          ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END) > 0
    GROUP BY t.id, t.employee_id
  `).bind(storeId, localEnd, localStart, localStart, localEnd, startUtc, endUtc).all<TransferAllowanceRow>();

  const [adjustments, advanceRows] = await Promise.all([
    payrollAdjustments(db, storeId, period),
    salaryAdvanceTotals(db, storeId, period),
  ]);
  const advancesByEmployee = new Map(advanceRows.map((row) => [row.employeeId, row]));

  const shiftsByEmployee = new Map<string, {
    durationSeconds: number;
    kpiDurationSeconds: number;
    baseSalary: number;
    tiktokAllowance: number;
    completedShiftCount: number;
    kpiCompletedShiftCount: number;
  }>();
  for (const row of hoursResult.results) {
    const current = shiftsByEmployee.get(row.employeeId) ?? {
      durationSeconds: 0,
      kpiDurationSeconds: 0,
      baseSalary: 0,
      tiktokAllowance: 0,
      completedShiftCount: 0,
      kpiCompletedShiftCount: 0,
    };
    const seconds = Math.max(0, Math.round(Number(row.durationSeconds ?? 0)));
    const kpiSeconds = Math.max(0, Math.round(Number(row.kpiDurationSeconds ?? 0)));
    if (row.appliedHourlyRate === null || row.appliedHourlyRate === undefined) {
      throw new Error(`Thiếu snapshot mức lương cho nhân viên ${row.employeeId}.`);
    }
    const appliedHourlyRate = requireVnd(Number(row.appliedHourlyRate), "Lương theo giờ");
    const tiktokAllowance = requireVnd(Math.max(0, Math.round(Number(row.tiktokAllowance ?? 0))), "Phụ cấp TikTok");
    shiftsByEmployee.set(row.employeeId, {
      durationSeconds: current.durationSeconds + seconds,
      kpiDurationSeconds: current.kpiDurationSeconds + kpiSeconds,
      baseSalary: sumVnd([current.baseSalary, multiplyRatioVnd(appliedHourlyRate, seconds, 3_600)]),
      tiktokAllowance: sumVnd([current.tiktokAllowance, tiktokAllowance]),
      completedShiftCount: current.completedShiftCount + Math.max(0, Math.round(Number(row.completedShiftCount ?? 0))),
      kpiCompletedShiftCount: current.kpiCompletedShiftCount + Math.max(0, Math.round(Number(row.kpiCompletedShiftCount ?? 0))),
    });
  }
  const revenue = requireVnd(Number(store.revenue), "Doanh thu");
  const profit = store.operatingProfit;
  const calculatedItems = employeesResult.results.map((employee): PayrollItem => {
    const shift = shiftsByEmployee.get(employee.id);
    const employeeDurationSeconds = shift?.durationSeconds ?? 0;
    const minutes = durationMinutes(employeeDurationSeconds);
    const hours = employeeDurationSeconds / 3_600;
    const employeeAdjustments = adjustments.filter((item) => item.employeeId === employee.id);
    const { manualAllowance, manualBonus } = payrollAdjustmentTotals(employeeAdjustments.map((item) => ({
      kind: item.kind,
      amount: requireVnd(Number(item.amount ?? 0), item.kind === "ALLOWANCE" ? "Phụ cấp khác" : "Thưởng khác"),
    })));
    const baseSalary = shift?.baseSalary ?? 0;
    const tiktokAllowance = Math.max(0, Number(shift?.tiktokAllowance ?? 0));
    const supportAllowance = transferAllowances.results
      .filter((transfer) => transfer.employeeId === employee.id)
      .reduce((sum, transfer) => sumVnd([sum, requireVnd(Number(transfer.supportAllowance ?? 0), "Phụ cấp hỗ trợ")]), 0);
    const advances = advancesByEmployee.get(employee.id);
    const salaryAdvancePending = safePayrollVnd(advances?.pendingAmount);
    const salaryAdvancePaid = safePayrollVnd(advances?.paidAmount);
    const salaryAdvanceReserved = sumVnd([salaryAdvancePending, salaryAdvancePaid]);
    const totalPay = sumVnd([baseSalary, tiktokAllowance, supportAllowance, manualAllowance, manualBonus]);
    return {
      employeeId: employee.id,
      employeeCode: employee.code,
      employeeName: employee.name,
      position: employee.position,
      employmentStatus: employeeFinancialStatusForPeriod(
        employee.statusAtPeriodEnd,
        employee.hasLifecycleHistory,
        employee.inactivePeriod,
        period,
      ),
      completedShiftCount: shift?.completedShiftCount ?? 0,
      kpiCompletedShiftCount: shift?.kpiCompletedShiftCount ?? 0,
      kpiEligible: false,
      durationSeconds: employeeDurationSeconds,
      durationMinutes: minutes,
      hours,
      kpiDurationSeconds: shift?.kpiDurationSeconds ?? 0,
      kpiHours: (shift?.kpiDurationSeconds ?? 0) / 3_600,
      // This column is the base hourly rate owned by employee management.
      // Do not infer it from baseSalary: VND rounding on a short shift would
      // turn a configured 25,000 rate into an incorrect 25,020 display.
      hourlyRate: requireVnd(Number(employee.hourlyRate), "Lương theo giờ"),
      baseSalary,
      tiktokAllowance,
      supportAllowance,
      manualAllowance,
      manualBonus,
      adjustments: adjustmentDetails(adjustments, employee.id, storeId, store.name),
      kpiBonus: 0,
      totalPay,
      salaryAdvancePending,
      salaryAdvancePaid,
      salaryAdvanceReserved,
      salaryAdvanceCoverageGap: Math.max(0, salaryAdvanceReserved - totalPay),
      salaryAdvanceOverpaymentDebt: Math.max(0, salaryAdvancePaid - totalPay),
      availablePay: Math.max(0, totalPay - salaryAdvanceReserved),
    };
  });

  // An individually locked employee keeps the exact immutable snapshot even
  // when the rest of the store continues working later in the same month.
  const individuallyLocked = new Map((await employeePayrollClosings(db, storeId, period)).map((closing) => [closing.employeeId, closing]));
  const itemBases = calculatedItems.map((item) => {
    const closing = individuallyLocked.get(item.employeeId);
    if (!closing) return { item, kpiLocked: false };
    const locked: PayrollItem = {
      ...closing.item,
      employmentStatus: closing.employeeStatusAtLock,
      completedShiftCount: item.completedShiftCount,
      kpiCompletedShiftCount: Number.isSafeInteger(closing.item.kpiCompletedShiftCount)
        ? closing.item.kpiCompletedShiftCount
        : item.kpiCompletedShiftCount,
      kpiDurationSeconds: Number.isSafeInteger(closing.item.kpiDurationSeconds)
        ? closing.item.kpiDurationSeconds
        : item.kpiDurationSeconds,
      kpiHours: Number.isFinite(closing.item.kpiHours)
        ? closing.item.kpiHours
        : item.kpiHours,
      kpiEligible: false,
      adjustments: Array.isArray(closing.item.adjustments) ? closing.item.adjustments : item.adjustments,
      salaryAdvancePending: safePayrollVnd(closing.item.salaryAdvancePending ?? item.salaryAdvancePending),
      salaryAdvancePaid: safePayrollVnd(closing.item.salaryAdvancePaid ?? item.salaryAdvancePaid),
      salaryAdvanceReserved: safePayrollVnd(closing.item.salaryAdvanceReserved ?? item.salaryAdvanceReserved),
      availablePay: safePayrollVnd(closing.item.availablePay ?? item.availablePay),
    };
    if (!closing.kpiDeferred) return { item: locked, kpiLocked: true };
    return {
      item: {
        ...locked,
        // KPI depends on the complete store month. It stays live until the
        // store period is finalized while every deterministic component below
        // remains frozen at the offboarding time.
        kpiBonus: 0,
        totalPay: employeePayWithKpi(locked, 0),
        availablePay: Math.max(0, employeePayWithKpi(locked, 0) - safePayrollVnd(locked.salaryAdvanceReserved)),
      },
      kpiLocked: false,
    };
  });
  const kpiDistribution = calculateKpi({
    operatingProfit: profit,
    employees: itemBases.map(({ item }) => ({
      employeeId: item.employeeId,
      // KPI is based on all actual hours recorded at this store. Support work,
      // archive status and a later employee transfer must not erase history.
      actualSeconds: item.durationSeconds,
    })),
    config: {
      managerRateBps: financePolicy.managerKpiRateBasisPoints,
      tiers: financePolicy.employeeKpiTiers.map((tier) => ({
        minProfitPerHour: tier.minimumProfitPerHour,
        employeeRateBps: tier.rateBasisPoints,
      })),
    },
  });
  const kpiAllocations = kpiDistribution.employeeAllocations;
  const kpiAllocationByEmployee = new Map(kpiAllocations.map((allocation) => [allocation.employeeId, allocation]));
  const itemsBeforeCoverage = itemBases.map(({ item, kpiLocked }) => {
    const allocation = kpiAllocationByEmployee.get(item.employeeId);
    if (!allocation) return {
      ...item,
      availablePay: Math.max(0, item.totalPay - safePayrollVnd(item.salaryAdvanceReserved)),
    };
    if (kpiLocked) return {
      ...item,
      kpiEligible: allocation.actualSeconds > 0,
      availablePay: Math.max(0, item.totalPay - safePayrollVnd(item.salaryAdvanceReserved)),
    };
    const totalPay = employeePayWithKpi(item, allocation.employeeKpi);
    return {
      ...item,
      kpiEligible: allocation.actualSeconds > 0,
      kpiBonus: allocation.employeeKpi,
      totalPay,
      availablePay: Math.max(0, totalPay - safePayrollVnd(item.salaryAdvanceReserved)),
    };
  });
  const coverage = salaryAdvanceCoverage(itemsBeforeCoverage);
  const coverageByEmployee = new Map(coverage.employees.map((item) => [item.employeeId, item]));
  const items = itemsBeforeCoverage.map((item) => {
    const employeeCoverage = coverageByEmployee.get(item.employeeId);
    return {
      ...item,
      availablePay: employeeCoverage?.availableAmount ?? 0,
      salaryAdvanceCoverageGap: employeeCoverage?.coverageGap ?? 0,
      salaryAdvanceOverpaymentDebt: employeeCoverage?.overpaymentDebt ?? 0,
    };
  });
  const payrollDurationSeconds = items.reduce((sum, item) => sum + item.durationSeconds, 0);
  const kpiEligibleDurationSeconds = kpiDistribution.totalEmployeeSeconds;
  const totalHours = payrollDurationSeconds / 3_600;
  const managerSalary = financePolicy.managerMonthlySalaryVnd;
  const totalKpiBonus = sumVnd(items.map((item) => item.kpiBonus));
  const managerBonus = kpiDistribution.managerKpi;
  const costBreakdown: StoreExpenseBreakdown = {
    ...store.expenseBreakdown,
    employeeKpiBonus: totalKpiBonus,
    managerBonus,
  };
  const finance = calculateFinance({
    grossRevenue: revenue,
    fixedExpense: costBreakdown.fixedCosts,
    variableExpense: costBreakdown.incidentalCosts,
    inventoryCost: costBreakdown.inventoryGoods,
    inventoryShippingCost: costBreakdown.inventoryShipping,
    employeeSalary: costBreakdown.employeeBaseSalary,
    managerSalary: costBreakdown.managerSalary,
    manualEmployeeBonus: costBreakdown.manualBonus,
    employeeAllowance: sumVnd([
      costBreakdown.tiktokAllowance,
      costBreakdown.supportAllowance,
      costBreakdown.manualAllowance,
    ]),
    employeeKpiTotal: totalKpiBonus,
    managerKpi: managerBonus,
    monthEndExpense: costBreakdown.monthEndExpenses,
  });
  if (finance.operatingProfit !== profit) {
    throw new Error(`Bảng lương ${storeId}/${period} không khớp Finance Engine.`);
  }
  const expenseBeforePerformanceRewards = finance.operatingExpense;
  const netProfit = finance.finalProfit;
  const expense = finance.totalExpense;
  const summary: PayrollSummary = {
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
    kpiEligibleHours: kpiEligibleDurationSeconds / 3_600,
    kpiEligibleDurationSeconds,
    totalKpiHours: kpiDistribution.totalEmployeeHours,
    totalKpiDurationSeconds: kpiDistribution.totalEmployeeSeconds,
    profitPerHour: kpiDistribution.profitPerHour,
    profitPerKpiHour: kpiDistribution.profitPerHour,
    kpiRate: kpiDistribution.employeeRateBps / 10_000,
    kpiPool: sumVnd([kpiDistribution.employeeKpiPool, kpiDistribution.managerKpi]),
    totalBaseSalary: sumVnd(items.map((item) => item.baseSalary)),
    totalTikTokAllowance: sumVnd(items.map((item) => item.tiktokAllowance)),
    totalSupportAllowance: sumVnd(items.map((item) => item.supportAllowance)),
    totalManualAllowance: sumVnd(items.map((item) => item.manualAllowance)),
    totalManualBonus: sumVnd(items.map((item) => item.manualBonus)),
    totalKpiBonus,
    totalPerformanceBonus: sumVnd([totalKpiBonus, managerBonus]),
    managerSalary,
    managerBonus,
    managerTotal: sumVnd([managerSalary, managerBonus]),
    payrollPolicy: payrollPolicyPayload(payrollPolicy),
    financialPolicyVersionId: policyVersion.id,
    financialPolicyConfigVersion: policyVersion.version,
    financialPolicySnapshot: policyVersion.policy,
    totalPay: sumVnd(items.map((item) => item.totalPay)),
    totalSalaryAdvancePending: sumVnd(items.map((item) => item.salaryAdvancePending)),
    totalSalaryAdvancePaid: sumVnd(items.map((item) => item.salaryAdvancePaid)),
    totalSalaryAdvanceReserved: sumVnd(items.map((item) => item.salaryAdvanceReserved)),
    totalSalaryAdvanceCoverageGap: coverage.totalCoverageGap,
    totalSalaryAdvanceOverpaymentDebt: coverage.totalOverpaymentDebt,
    totalAvailablePay: sumVnd(items.map((item) => item.availablePay)),
    items,
    status: "PREVIEW",
  };
  assertPayrollSummaryInvariants(summary);
  return summary;
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
    const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
    const [snapshots, detailRows, adjustmentSourceRows] = await Promise.all([
      db.prepare("SELECT data_json FROM business_records WHERE category = 'KPI_SUMMARY' AND status = 'LOCKED' AND id LIKE ? ORDER BY created_at")
        .bind(`kpi-summary:%:${period}`).all<{ data_json: string }>(),
      user.employeeId ? db.prepare(`
      SELECT s.id,
        s.shift_code AS shiftCode,
        s.shift_name AS shiftName,
        s.work_date AS workDate,
        s.scheduled_start AS scheduledStart,
        s.scheduled_end AS scheduledEnd,
        s.started_at AS startedAt,
        s.ended_at AS endedAt,
        COALESCE(s.admin_adjusted_duration_seconds,
          CASE WHEN s.duration_seconds > 0 THEN s.duration_seconds
            ELSE ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400, 0) END) AS durationSeconds,
        COALESCE(s.applied_hourly_rate, e.hourly_rate) AS hourlyRate,
        COALESCE(s.tiktok_allowance, 0) AS tiktokAllowance,
        s.transfer_id AS transferId,
        COALESCE(s.applied_support_allowance, 0) AS supportAllowance,
        s.store_id AS storeId,
        target.name AS storeName,
        source.name AS sourceStoreName
      FROM shift_sessions s
      LEFT JOIN employees e ON e.id = s.employee_id
      JOIN stores target ON target.id = s.store_id
      LEFT JOIN employee_transfers t ON t.id = s.transfer_id
      LEFT JOIN stores source ON source.id = t.source_store_id
      WHERE s.employee_id = ? AND s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
        AND COALESCE(s.reconciliation_status, 'CLEAR') IN ('CLEAR', 'CONFIRMED')
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
          OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
        )
      ORDER BY s.started_at DESC
    `).bind(user.employeeId, localStart, localEnd, startUtc, endUtc).all<EmployeeShiftDetailRow>() : Promise.resolve({ results: [] as EmployeeShiftDetailRow[] }),
      user.employeeId ? db.prepare(`
        SELECT DISTINCT r.store_id AS storeId, s.name AS storeName
        FROM business_records r
        JOIN stores s ON s.id = r.store_id
        WHERE r.category = 'LUONG_THUONG' AND r.status != 'DELETED'
          AND json_extract(r.data_json, '$.employeeId') = ?
          AND COALESCE(json_extract(r.data_json, '$.period'), substr(json_extract(r.data_json, '$.date'), 1, 7)) = ?
      `).bind(user.employeeId, period).all<{ storeId: string; storeName: string }>()
        : Promise.resolve({ results: [] as Array<{ storeId: string; storeName: string }> }),
    ]);
    const lockedSources = snapshots.results.flatMap((row) => {
      const summary = parseData<PayrollSummary>(row.data_json);
      const item = summary?.items.find((payrollItem) => payrollItem.employeeId === user.employeeId);
      return item && summary ? [{ item, storeId: summary.storeId, storeName: summary.storeName }] : [];
    });
    const transferSeconds = new Map<string, number>();
    for (const shift of detailRows.results) {
      if (shift.transferId) transferSeconds.set(shift.transferId, (transferSeconds.get(shift.transferId) ?? 0) + Math.max(0, Math.round(Number(shift.durationSeconds ?? 0))));
    }
    const transferAllocationState = new Map<string, { cumulativeSeconds: number; allocated: number }>();
    const shiftDetails = detailRows.results.map((shift) => {
      const seconds = Math.max(0, Math.round(Number(shift.durationSeconds ?? 0)));
      if (shift.hourlyRate === null || shift.hourlyRate === undefined) {
        throw new Error(`Thiếu snapshot mức lương cho ca ${shift.id}.`);
      }
      const hourlyRate = requireVnd(Number(shift.hourlyRate), "Lương theo giờ");
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
    const lockedSourceByStore = new Map(lockedSources.map((source) => [source.storeId, source]));
    const detailSourceNames = new Map<string, string>([
      ...detailRows.results.map((shift): [string, string] => [shift.storeId, shift.storeName]),
      ...adjustmentSourceRows.results.map((source): [string, string] => [source.storeId, source.storeName]),
    ]);
    const sourceIds = new Set([...lockedSourceByStore.keys(), ...detailSourceNames.keys()]);
    const resolvedSources = (await Promise.all([...sourceIds].map(async (storeId) => {
      const lockedSource = lockedSourceByStore.get(storeId);
      const needsLegacyAdjustments = Boolean(lockedSource && !Array.isArray(lockedSource.item.adjustments));
      const [preview, closing, legacyAdjustments] = await Promise.all([
        lockedSource ? Promise.resolve(null) : buildPreview(db, storeId, period),
        payrollClosing(db, storeId, period),
        needsLegacyAdjustments ? payrollAdjustments(db, storeId, period) : Promise.resolve([] as PayrollAdjustment[]),
      ]);
      const previewItem = preview?.items.find((payrollItem) => payrollItem.employeeId === user.employeeId);
      const sourceItem = lockedSource?.item ?? previewItem;
      if (!sourceItem) return null;
      const storeName = lockedSource?.storeName ?? preview?.storeName ?? detailSourceNames.get(storeId) ?? "Cửa hàng";
      const item: PayrollItem = {
        ...sourceItem,
        adjustments: Array.isArray(sourceItem.adjustments)
          ? sourceItem.adjustments
          : adjustmentDetails(legacyAdjustments, sourceItem.employeeId, storeId, storeName),
      };
      return {
        storeId,
        storeName,
        item,
        locked: Boolean(lockedSource),
        closing,
      };
    }))).filter((source): source is NonNullable<typeof source> => Boolean(source))
      .sort((left, right) => left.storeName.localeCompare(right.storeName, "vi"));
    const item = mergePayrollItems(resolvedSources.map((source) => source.item));
    const sourceStates = resolvedSources.map((source) => ({
      locked: source.locked,
      paymentStatus: source.locked ? source.closing?.status ?? "PENDING" : "PROVISIONAL",
    }));
    const overallState = employeePayrollOverallState(sourceStates);
    return json({
      period,
      locked: overallState.locked,
      item,
      sources: resolvedSources.map((source) => ({
        ...source.item,
        storeId: source.storeId,
        storeName: source.storeName,
        locked: source.locked,
        isSupport: supportSourceIds.has(source.storeId),
        sourceStoreName: shiftDetails.find((shift) => shift.storeId === source.storeId && shift.isSupport)?.sourceStoreName ?? null,
        paymentStatus: source.locked ? source.closing?.status ?? "PENDING" : "PROVISIONAL",
        paidAt: source.closing?.paymentConfirmedAt ?? null,
      })),
      shiftDetails,
      paid: overallState.paid,
    });
  }

  if (params.get("scope") === "manager") {
    const scope = resolveManagerStoreScope(user, params.get("storeId"));
    if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
    return json({ managerPayroll: await managerPayrollPeriod(db, period, scope.storeId) });
  }

  const scope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = scope.storeId;
  if (!storeId) return json({ message: "Vui lòng chọn cửa hàng" }, 400);
  const financialPeriodRow = await readFinancialPeriodLifecycleRow(db, storeId, period);
  const legacySnapshot = await lockedSummary(db, storeId, period);
  const canonicalSnapshot = payrollSummaryFromFinancialPeriod(financialPeriodRow);
  const snapshotIsAuthoritative = financialPeriodRow
    ? ["CONFIRMED", "PAID", "LOCKED"].includes(financialPeriodRow.status)
    : Boolean(legacySnapshot);
  const summary = snapshotIsAuthoritative && (canonicalSnapshot || legacySnapshot)
    ? canonicalSnapshot ?? legacySnapshot
    : await buildPreview(db, storeId, period);
  if (!summary) return json({ message: "Không tìm thấy cửa hàng" }, 404);
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
    locked: financialPeriodRow
      ? financialPeriodRow.status === "LOCKED"
      : legacySnapshot?.status === "LOCKED",
    financialPeriod: publicFinancialPeriod(storeId, period, financialPeriodRow),
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
    expectedRevision?: number;
    reason?: string;
  };
  const storeId = body.storeId?.trim();
  const period = body.period?.trim() ?? "";
  if (!storeId || !validPeriod(period)) return json({ message: "Cửa hàng hoặc kỳ lương không hợp lệ" }, 400);
  if (!managerCanAccessStore(user, storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const requestedAction = body.action ?? "FINALIZE_EMPLOYEE";
  if (!isPayrollAction(requestedAction)) return json({ message: "Thao tác chốt kỳ lương không hợp lệ." }, 400);
  const action = requestedAction;
  const reason = body.reason?.trim() || `Thực hiện ${action} cho kỳ ${period}`;
  const financialPeriodAtRequest = await readFinancialPeriodLifecycleRow(db, storeId, period);
  if (action !== "FINALIZE_SINGLE_EMPLOYEE"
    && !requestedRevisionMatches(body.expectedRevision, financialPeriodAtRequest)) {
    return json({
      message: "Kỳ tài chính vừa được cập nhật bởi một yêu cầu khác. Vui lòng tải lại dữ liệu.",
      financialPeriod: publicFinancialPeriod(storeId, period, financialPeriodAtRequest),
    }, 409);
  }
  if (action === "FINALIZE_SINGLE_EMPLOYEE") {
    if (financialPeriodAtRequest
      && ["CONFIRMED", "PAID", "LOCKED"].includes(financialPeriodAtRequest.status)) {
      return json({ message: "Kỳ tài chính đã xác nhận nên không thể thay đổi đối soát từng nhân viên." }, 409);
    }
    const employeeId = body.employeeId?.trim() ?? "";
    if (!employeeId) return json({ message: "Vui lòng chọn nhân viên cần chốt lương." }, 400);
    if (period > localPeriod()) return json({ message: "Không thể chốt lương cho kỳ trong tương lai." }, 409);

    const current = (await employeePayrollClosings(db, storeId, period)).find((closing) => closing.employeeId === employeeId);
    if (current) return json({ employeeClosing: current, message: "Lương nhân viên đã được chốt và khóa sổ trước đó." });
    const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
    const statusAtPeriodEndSql = employeeStatusAtInstantSql("e");
    const employee = await db.prepare(`SELECT e.code, e.name,
        strftime('%Y-%m', e.inactive_at, '+7 hours') AS inactivePeriod,
        ${statusAtPeriodEndSql} AS statusAtPeriodEnd,
        EXISTS(SELECT 1 FROM employee_status_history lifecycle_any
          WHERE lifecycle_any.employee_id = e.id) AS hasLifecycleHistory
      FROM employees e WHERE e.id = ? LIMIT 1`)
      .bind(endUtc, employeeId).first<{
        code: string;
        name: string;
        inactivePeriod: string | null;
        statusAtPeriodEnd: string;
        hasLifecycleHistory: number;
      }>();
    if (!employee) return json({ message: "Không tìm thấy nhân viên." }, 404);
    const employmentStatus = employeeFinancialStatusForPeriod(
      employee.statusAtPeriodEnd,
      employee.hasLifecycleHistory,
      employee.inactivePeriod,
      period,
    );
    if (!canClosePayrollPeriod(period) && employmentStatus !== "INACTIVE") {
      return json({ message: "Nhân viên đang làm việc chỉ được chốt lương từ ngày cuối cùng của tháng. Nhân viên đã ngưng làm việc trong kỳ vẫn được ưu tiên chốt sớm." }, 409);
    }
    const id = employeeClosingId(storeId, period, employeeId);
    const gateStartedAt = utcTimestamp();
    const gateToken = payrollGateToken(`employee:${storeId}:${period}:${employeeId}`);
    const gateSnapshot = JSON.stringify({
      gateToken,
      period,
      storeId,
      employeeId,
      status: "CLOSING",
      startedAt: gateStartedAt,
    });

    await db.prepare(`DELETE FROM employee_payroll_closings
      WHERE id = ? AND status = 'CLOSING' AND locked_at < ?`)
      .bind(id, stalePayrollGateCutoff()).run();

    // The INSERT ... SELECT is the transaction boundary. A financial write
    // either commits before this statement (and is included in the preview)
    // or observes CLOSING and is rejected by the records route.
    const gateResult = await db.prepare(`INSERT OR IGNORE INTO employee_payroll_closings
      (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
      SELECT ?, ?, ?, ?, ?, ?, 'CLOSING', ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM shift_sessions
        WHERE store_id = ? AND employee_id = ? AND (status = 'ACTIVE' OR ended_at IS NULL) AND (
          (NULLIF(work_date, '') IS NOT NULL AND work_date >= ? AND work_date < ?)
          OR (NULLIF(work_date, '') IS NULL AND started_at >= ? AND started_at < ?)
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM business_records
        WHERE category = 'KPI_SUMMARY' AND store_id = ? AND status = 'CLOSING'
          AND json_extract(data_json, '$.period') = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM salary_advances
        WHERE store_id = ? AND employee_id = ? AND period = ? AND status = 'DRAFT'
      )`)
      .bind(
        id, storeId, employeeId, period, gateSnapshot, employmentStatus, gateStartedAt, gateToken,
        storeId, employeeId, localStart, localEnd, startUtc, endUtc,
        storeId, period,
        storeId, employeeId, period,
      ).run();

    if (affectedRows(gateResult) === 0) {
      const saved = (await employeePayrollClosings(db, storeId, period)).find((closing) => closing.employeeId === employeeId);
      if (saved) return json({ employeeClosing: saved, message: "Lương nhân viên đã được chốt và khóa sổ trước đó." });
      const openShift = await db.prepare(`SELECT id FROM shift_sessions
        WHERE store_id = ? AND employee_id = ? AND (status = 'ACTIVE' OR ended_at IS NULL) AND (
          (NULLIF(work_date, '') IS NOT NULL AND work_date >= ? AND work_date < ?)
          OR (NULLIF(work_date, '') IS NULL AND started_at >= ? AND started_at < ?)
        ) LIMIT 1`)
        .bind(storeId, employeeId, localStart, localEnd, startUtc, endUtc).first<{ id: string }>();
      if (openShift) return json({ message: "Nhân viên còn ca làm chưa kết thúc trong kỳ. Hãy kết ca trước khi chốt lương." }, 409);
      const pendingAdvance = await db.prepare("SELECT id FROM salary_advances WHERE store_id = ? AND employee_id = ? AND period = ? AND status = 'DRAFT' LIMIT 1")
        .bind(storeId, employeeId, period).first<{ id: string }>();
      if (pendingAdvance) return json({ message: "Hãy xác nhận chi hoặc chỉnh sửa khoản ứng lương đang chờ của nhân viên trước khi chốt lương." }, 409);
      return json({ message: "Lương nhân viên đang được chốt bởi một yêu cầu khác. Vui lòng thử lại sau." }, 409);
    }

    const releaseGate = async () => {
      await db.prepare(`DELETE FROM employee_payroll_closings
        WHERE id = ? AND status = 'CLOSING' AND locked_by = ?`)
        .bind(id, gateToken).run();
    };

    try {
      const summary = await lockedSummary(db, storeId, period) ?? await buildPreview(db, storeId, period);
      if (!summary) {
        await releaseGate();
        return json({ message: "Không tìm thấy cửa hàng." }, 404);
      }
      const sourceItem = summary.items.find((item) => item.employeeId === employeeId);
      if (!sourceItem) {
        await releaseGate();
        return json({ message: "Nhân viên không có trong bảng lương của cửa hàng ở kỳ này." }, 404);
      }
      const coverageConflict = salaryAdvanceCoverageConflict(summary, employeeId);
      if (coverageConflict) {
        await releaseGate();
        return coverageConflict;
      }

      const lockedAt = utcTimestamp();
      // Individual closing never owns the KPI amount. Store costs may still be
      // corrected after employees are reviewed, so KPI is materialized only in
      // the single immutable KPI_SUMMARY created by FINALIZE_EMPLOYEE.
      const kpiDeferred = true;
      const item: PayrollItem = {
        ...sourceItem,
        employmentStatus,
        kpiBonus: 0,
        totalPay: employeePayWithKpi(sourceItem, 0),
        availablePay: Math.max(
          0,
          employeePayWithKpi(sourceItem, 0) - safePayrollVnd(sourceItem.salaryAdvanceReserved),
        ),
      };
      const employeeClosing: EmployeePayrollClosing = {
        id,
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
      const auditDetail = JSON.stringify({
        storeId,
        period,
        employeeId,
        employeeStatusAtLock: employmentStatus,
        totalPay: employeeClosing.item.totalPay,
        kpiDeferred: employeeClosing.kpiDeferred,
      });
      const finalizeResults = await db.batch([
        db.prepare(`UPDATE employee_payroll_closings
          SET snapshot_json = ?, employee_status_at_lock = ?, status = 'BASE_LOCKED', locked_at = ?, locked_by = ?
          WHERE id = ? AND status = 'CLOSING' AND locked_by = ?`)
          .bind(JSON.stringify(employeeClosing), employmentStatus, lockedAt, user.id, id, gateToken),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
          SELECT ?, ?, ?, 'EMPLOYEE_PAYROLL_LOCK', 'EMPLOYEE_PAYROLL_CLOSING', closing.id, ?, ?, ?, ?, ?
          FROM employee_payroll_closings closing
          WHERE closing.id = ? AND closing.status = 'BASE_LOCKED'
            AND closing.locked_at = ? AND closing.locked_by = ?`)
          .bind(
            crypto.randomUUID(),
            user.id,
            storeId,
            auditDetail,
            JSON.stringify({ status: "CLOSING" }),
            JSON.stringify({ status: "BASE_LOCKED", employeeStatusAtLock: employmentStatus, totalPay: employeeClosing.item.totalPay }),
            "Khóa các thành phần lương xác định của nhân viên",
            lockedAt,
            id,
            lockedAt,
            user.id,
          ),
      ]);
      if (affectedRows(finalizeResults[0]) === 0) {
        await releaseGate();
        return json({ message: "Không thể khóa sổ lương nhân viên vì trạng thái vừa được cập nhật bởi yêu cầu khác." }, 409);
      }
      return json({
        employeeClosing,
        message: summary.status === "LOCKED"
          ? "Đã khóa các khoản lương xác định của nhân viên. KPI giữ theo bảng lương tổng đã khóa của cửa hàng."
          : "Đã khóa lương cơ bản và các khoản xác định của nhân viên. KPI sẽ được tính chính xác khi chốt kỳ cửa hàng.",
      }, 201);
    } catch (error) {
      await releaseGate();
      throw error;
    }
  }
  if (action !== "FINALIZE_EMPLOYEE") {
    const financialPeriod = await readFinancialPeriodLifecycleRow(db, storeId, period);
    if (!financialPeriod) return json({ message: "Hãy tính bảng lương kỳ trước." }, 409);
    const employeeSummary = await buildPreview(db, storeId, period);
    if (!employeeSummary) return json({ message: "Không tìm thấy cửa hàng." }, 404);
    const coverageConflict = salaryAdvanceCoverageConflict(employeeSummary);
    if (coverageConflict) return coverageConflict;
    const existing = await payrollClosing(db, storeId, period);
    const now = utcTimestamp();

    if (action === "FINALIZE_MANAGER") {
      if (financialPeriodReached(financialPeriod, "RECONCILING")) {
        return json({
          closing: existing,
          financialPeriod: publicFinancialPeriod(storeId, period, financialPeriod),
          message: "Kỳ tài chính đã chuyển sang đối soát.",
        });
      }
      if (financialPeriod.status !== "CALCULATED") {
        return json({ message: "Kỳ tài chính chưa ở trạng thái sẵn sàng đối soát." }, 409);
      }
      if (existing) return json({ message: "Dữ liệu đối soát cũ không khớp trạng thái kỳ tài chính." }, 409);
      const closedEmployees = new Set((await employeePayrollClosings(db, storeId, period)).map((item) => item.employeeId));
      const missingEmployees = employeeSummary.items.filter((item) => !closedEmployees.has(item.employeeId));
      if (missingEmployees.length > 0) {
        return json({
          message: `Hãy chốt lương riêng cho từng nhân viên trước khi chốt lương quản lý. Còn ${missingEmployees.length} nhân viên chưa khóa sổ.`,
          missingEmployeeIds: missingEmployees.map((item) => item.employeeId),
        }, 409);
      }
      let managerSalary: number;
      let managerBonus: number;
      try {
        managerSalary = managerSalaryForNewClosing(employeeSummary);
        managerBonus = requireVnd(employeeSummary.managerBonus, "KPI quản lý");
      } catch (error) {
        return json({ message: error instanceof Error ? error.message : "Thiếu snapshot chính sách lương quản lý của kỳ." }, 409);
      }
      const managerTotal = sumVnd([managerSalary, managerBonus]);
      const salaryAdvancePaidTotal = safePayrollVnd(employeeSummary.totalSalaryAdvancePaid);
      const settlement = salaryAdvanceSettlementSplit({
        employeeBaseSalary: employeeSummary.totalBaseSalary,
        employeeTotalPay: employeeSummary.totalPay,
        managerSalary,
        managerBonus,
        advanceAmount: salaryAdvancePaidTotal,
      });
      const employeeTotal = safePayrollVnd(settlement.employeeRemaining);
      const closing: PayrollClosing = {
        period,
        storeId,
        storeName: employeeSummary.storeName,
        employeeTotal,
        employeeGrossTotal: employeeSummary.totalPay,
        salaryAdvancePaidTotal,
        managerSalary,
        managerBonus,
        managerTotal,
        salaryTotal: settlement.salaryTotal,
        rewardAllowanceTotal: settlement.rewardAllowanceTotal,
        grandTotal: settlement.grandTotal,
        status: "MANAGER_FINALIZED",
        managerFinalizedAt: now,
        managerFinalizedBy: user.id,
      };
      const id = closingId(storeId, period);
      const transition = prepareFinancialPeriodTransitionPlan(db, {
        current: financialPeriod,
        toStatus: "RECONCILING",
        actorId: user.id,
        now,
        reason,
        calculation: financialPeriodCalculation(employeeSummary),
      });
      try {
        const results = await db.batch([
          db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'PAYROLL_CLOSING', ?, ?, ?, ?, 'MANAGER_FINALIZED', ?, ?)")
            .bind(id, storeId, user.id, `Kết sổ lương ${period}`, JSON.stringify(closing), now, now),
          db.prepare(`INSERT INTO audit_logs
              (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
            VALUES (?, ?, ?, 'MANAGER_PAYROLL_FINALIZE', 'PAYROLL_CLOSING', ?, ?, ?, ?, ?, ?)`)
            .bind(
              crypto.randomUUID(),
              user.id,
              storeId,
              id,
              JSON.stringify({ storeId, period, managerSalary, managerBonus }),
              JSON.stringify({ status: null }),
              JSON.stringify({ status: closing.status, managerSalary, managerBonus, managerTotal }),
              reason,
              now,
            ),
          ...transition.statements,
        ]);
        if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1) {
          throw new Error("Không thể tạo dữ liệu đối soát quản lý.");
        }
        assertFinancialPeriodPlanApplied(results, transition, 2);
      } catch {
        const currentPeriod = await readFinancialPeriodLifecycleRow(db, storeId, period);
        const current = await payrollClosing(db, storeId, period);
        if (currentPeriod && financialPeriodReached(currentPeriod, "RECONCILING")) {
          return json({
            closing: current,
            financialPeriod: publicFinancialPeriod(storeId, period, currentPeriod),
            message: "Kỳ tài chính đã chuyển sang đối soát.",
          });
        }
        return json({ message: "Không thể bắt đầu đối soát kỳ tài chính." }, 409);
      }
      return json({
        closing,
        financialPeriod: publicFinancialPeriod(storeId, period, transition.next),
        message: "Đã bắt đầu đối soát kỳ tài chính.",
      }, 201);
    }

    if (!existing) return json({ message: "Hãy chốt lương thưởng quản lý trước." }, 409);
    const id = closingId(storeId, period);
    if (action === "CONFIRM_SALARY") {
      if (financialPeriod.status !== "RECONCILING") {
        return json({ message: "Chỉ được xác nhận đối soát lương khi kỳ đang đối soát." }, 409);
      }
      if (["SALARY_CONFIRMED", "REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"].includes(existing.status)) return json({
        closing: existing,
        financialPeriod: publicFinancialPeriod(storeId, period, financialPeriod),
        message: "Khoản chi lương đã được xác nhận.",
      });
      if (existing.status !== "MANAGER_FINALIZED") return json({ message: "Trạng thái kỳ lương không hợp lệ để xác nhận chi lương." }, 409);
      const closing: PayrollClosing = { ...existing, status: "SALARY_CONFIRMED", salaryConfirmedAt: now, salaryConfirmedBy: user.id };
      const results = await db.batch([
        db.prepare("UPDATE business_records SET data_json = ?, status = 'SALARY_CONFIRMED', updated_at = ? WHERE id = ? AND status = 'MANAGER_FINALIZED'")
          .bind(JSON.stringify(closing), now, id),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
          SELECT ?, ?, ?, 'PAYROLL_SALARY_CONFIRM', 'PAYROLL_CLOSING', row.id, ?, ?, ?, ?, ?
          FROM business_records row
          WHERE row.id = ? AND row.status = 'SALARY_CONFIRMED'
            AND json_extract(row.data_json, '$.salaryConfirmedAt') = ?
            AND json_extract(row.data_json, '$.salaryConfirmedBy') = ?`)
          .bind(
            crypto.randomUUID(),
            user.id,
            storeId,
            JSON.stringify({ storeId, period, amount: closing.salaryTotal }),
            JSON.stringify({ status: existing.status }),
            JSON.stringify({ status: closing.status, salaryConfirmedAt: now, salaryConfirmedBy: user.id, amount: closing.salaryTotal }),
            reason,
            now,
            id,
            now,
            user.id,
          ),
      ]);
      if (affectedRows(results[0]) === 0) {
        const current = await payrollClosing(db, storeId, period);
        return current
          ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
          : json({ message: "Không thể xác nhận khoản chi lương." }, 409);
      }
      return json({
        closing,
        financialPeriod: publicFinancialPeriod(storeId, period, financialPeriod),
        message: "Đã xác nhận đối soát khoản lương nhân viên và quản lý.",
      });
    }
    if (action === "CONFIRM_REWARDS") {
      if (financialPeriodReached(financialPeriod, "CONFIRMED")) return json({
        closing: existing,
        financialPeriod: publicFinancialPeriod(storeId, period, financialPeriod),
        message: "Số liệu toàn kỳ đã được xác nhận.",
      });
      if (financialPeriod.status !== "RECONCILING") {
        return json({ message: "Kỳ tài chính chưa ở trạng thái đối soát." }, 409);
      }
      if (existing.status !== "SALARY_CONFIRMED") return json({ message: "Hãy xác nhận khoản chi lương trước." }, 409);
      const closing: PayrollClosing = { ...existing, status: "REWARDS_CONFIRMED", rewardsConfirmedAt: now, rewardsConfirmedBy: user.id };
      const finalSummary: PayrollSummary = {
        ...employeeSummary,
        status: "LOCKED",
        finalizedAt: now,
        finalizedBy: user.id,
      };
      assertPayrollSummaryInvariants(finalSummary);
      const transition = prepareFinancialPeriodTransitionPlan(db, {
        current: financialPeriod,
        toStatus: "CONFIRMED",
        actorId: user.id,
        now,
        reason,
        calculation: financialPeriodCalculation(finalSummary),
      });
      const results = await db.batch([
        db.prepare(`UPDATE business_records
          SET owner_id = ?, title = ?, data_json = ?, status = 'LOCKED', updated_at = ?
          WHERE id = ? AND category = 'KPI_SUMMARY' AND status = 'CALCULATED'`)
          .bind(user.id, `Snapshot bảng lương ${period}`, JSON.stringify(finalSummary), now, snapshotId(storeId, period)),
        db.prepare("UPDATE business_records SET data_json = ?, status = 'REWARDS_CONFIRMED', updated_at = ? WHERE id = ? AND status = 'SALARY_CONFIRMED'")
          .bind(JSON.stringify(closing), now, id),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
          SELECT ?, ?, ?, 'PAYROLL_REWARDS_CONFIRM', 'PAYROLL_CLOSING', row.id, ?, ?, ?, ?, ?
          FROM business_records row
          WHERE row.id = ? AND row.status = 'REWARDS_CONFIRMED'
            AND json_extract(row.data_json, '$.rewardsConfirmedAt') = ?
            AND json_extract(row.data_json, '$.rewardsConfirmedBy') = ?`)
          .bind(
            crypto.randomUUID(),
            user.id,
            storeId,
            JSON.stringify({ storeId, period, amount: closing.rewardAllowanceTotal }),
            JSON.stringify({ status: existing.status }),
            JSON.stringify({ status: closing.status, rewardsConfirmedAt: now, rewardsConfirmedBy: user.id, amount: closing.rewardAllowanceTotal }),
            reason,
            now,
            id,
            now,
            user.id,
          ),
        ...transition.statements,
      ]);
      if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1 || affectedRows(results[2]) !== 1) {
        const current = await payrollClosing(db, storeId, period);
        return current
          ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
          : json({ message: "Không thể xác nhận khoản thưởng và phụ cấp." }, 409);
      }
      assertFinancialPeriodPlanApplied(results, transition, 3);
      return json({
        closing,
        financialPeriod: publicFinancialPeriod(storeId, period, transition.next),
        summary: finalSummary,
        message: "Đã xác nhận toàn bộ số liệu kỳ và tạo snapshot bất biến.",
      });
    }
    if (action === "CONFIRM_PAYMENT") {
      if (financialPeriodReached(financialPeriod, "PAID")) return json({
        closing: existing,
        financialPeriod: publicFinancialPeriod(storeId, period, financialPeriod),
        message: "Đã ghi nhận chi trả lương, thưởng và phụ cấp.",
      });
      if (financialPeriod.status !== "CONFIRMED") {
        return json({ message: "Số liệu toàn kỳ phải được xác nhận trước khi ghi nhận chi trả." }, 409);
      }
      if (existing.status !== "REWARDS_CONFIRMED") return json({ message: "Hãy xác nhận riêng khoản chi lương và khoản thưởng, phụ cấp trước." }, 409);
      const closing: PayrollClosing = { ...existing, status: "PAYMENT_CONFIRMED", paymentConfirmedAt: now, paymentConfirmedBy: user.id };
      const paidEntry = closing.grandTotal > 0 ? await buildCashflowEntry({
        storeId,
        direction: "OUT",
        amount: closing.grandTotal,
        category: "PAYROLL",
        sourceType: "PAYROLL_PAYMENT",
        sourceId: id,
        occurredAt: now,
        createdBy: user.id,
        clientRequestId: `payroll-payment:${id}`,
        note: `Chi lương, thưởng và phụ cấp kỳ ${period}; đã trừ các khoản ứng lương đã chi`,
        createdAt: now,
      }) : null;
      const paymentGuard = `EXISTS (
        SELECT 1 FROM business_records paid
        WHERE paid.id = ? AND paid.status = 'PAYMENT_CONFIRMED'
          AND json_extract(paid.data_json, '$.paymentConfirmedAt') = ?
          AND json_extract(paid.data_json, '$.paymentConfirmedBy') = ?
      )`;
      const transition = prepareFinancialPeriodTransitionPlan(db, {
        current: financialPeriod,
        toStatus: "PAID",
        actorId: user.id,
        now,
        reason,
      });
      const results = await db.batch([
        db.prepare("UPDATE business_records SET data_json = ?, status = 'PAYMENT_CONFIRMED', updated_at = ? WHERE id = ? AND status = 'REWARDS_CONFIRMED'")
          .bind(JSON.stringify(closing), now, id),
        ...(paidEntry ? [prepareCashflowEntryInsertWhere(
          db,
          paidEntry,
          paymentGuard,
          [id, now, user.id],
        )] : []),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
          SELECT ?, ?, ?, 'PAYROLL_PAYMENT_CONFIRM', 'PAYROLL_CLOSING', paid.id, ?, ?, ?, ?, ?
          FROM business_records paid
          WHERE paid.id = ? AND paid.status = 'PAYMENT_CONFIRMED'
            AND json_extract(paid.data_json, '$.paymentConfirmedAt') = ?
            AND json_extract(paid.data_json, '$.paymentConfirmedBy') = ?`)
          .bind(
            crypto.randomUUID(),
            user.id,
            storeId,
            JSON.stringify({ storeId, period, grandTotal: closing.grandTotal, expenseTreatment: "PAYROLL_EXPENSE_SOURCE_NO_DOUBLE_COUNT" }),
            JSON.stringify({ status: existing.status, paymentConfirmedAt: existing.paymentConfirmedAt ?? null }),
            JSON.stringify({ status: closing.status, paymentConfirmedAt: now, paymentConfirmedBy: user.id, grandTotal: closing.grandTotal }),
            reason,
            now,
            id,
            now,
            user.id,
          ),
        ...transition.statements,
      ]);
      if (affectedRows(results[0]) === 0) {
        const current = await payrollClosing(db, storeId, period);
        return current
          ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
          : json({ message: "Không thể ghi nhận chi trả lương thưởng." }, 409);
      }
      const transitionOffset = paidEntry ? 3 : 2;
      assertFinancialPeriodPlanApplied(results, transition, transitionOffset);
      return json({
        closing,
        financialPeriod: publicFinancialPeriod(storeId, period, transition.next),
        message: "Đã chi và ghi nhận lịch sử chi lương, thưởng, phụ cấp.",
      });
    }

    if (action !== "CLOSE_PERIOD") return json({ message: "Thao tác chốt kỳ lương không hợp lệ." }, 400);
    if (financialPeriod.status === "LOCKED") return json({
      closing: existing,
      financialPeriod: publicFinancialPeriod(storeId, period, financialPeriod),
      message: "Kỳ tài chính đã khóa.",
    });
    if (financialPeriod.status !== "PAID") return json({ message: "Hãy xác nhận chi trước khi khóa kỳ." }, 409);
    if (existing.status !== "PAYMENT_CONFIRMED") return json({ message: "Hãy xác nhận chi trước khi kết sổ." }, 409);
    const closing: PayrollClosing = { ...existing, status: "LOCKED", closedAt: now, closedBy: user.id };
    const transition = prepareFinancialPeriodTransitionPlan(db, {
      current: financialPeriod,
      toStatus: "LOCKED",
      actorId: user.id,
      now,
      reason,
    });
    const results = await db.batch([
      db.prepare("UPDATE business_records SET data_json = ?, status = 'LOCKED', updated_at = ? WHERE id = ? AND status = 'PAYMENT_CONFIRMED'")
        .bind(JSON.stringify(closing), now, id),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
        SELECT ?, ?, ?, 'PAYROLL_PERIOD_CLOSE', 'PAYROLL_CLOSING', row.id, ?, ?, ?, ?, ?
        FROM business_records row
        WHERE row.id = ? AND row.status = 'LOCKED'
          AND json_extract(row.data_json, '$.closedAt') = ?
          AND json_extract(row.data_json, '$.closedBy') = ?`)
        .bind(
          crypto.randomUUID(),
          user.id,
          storeId,
          JSON.stringify({ storeId, period, grandTotal: closing.grandTotal }),
          JSON.stringify({ status: existing.status }),
          JSON.stringify({ status: closing.status, closedAt: now, closedBy: user.id, grandTotal: closing.grandTotal }),
          reason,
          now,
          id,
          now,
          user.id,
        ),
      ...transition.statements,
    ]);
    if (affectedRows(results[0]) === 0) {
      const current = await payrollClosing(db, storeId, period);
      return current
        ? json({ closing: current, message: "Trạng thái kỳ lương đã được cập nhật bởi một yêu cầu khác." })
        : json({ message: "Không thể kết sổ kỳ lương." }, 409);
    }
    assertFinancialPeriodPlanApplied(results, transition, 2);
    return json({
      closing,
      financialPeriod: publicFinancialPeriod(storeId, period, transition.next),
      message: "Đã khóa kỳ tài chính. Mọi số liệu được giữ theo snapshot đã xác nhận.",
    });
  }

  if (financialPeriodAtRequest && financialPeriodReached(financialPeriodAtRequest, "CALCULATED")) {
    const currentSummary = payrollSummaryFromFinancialPeriod(financialPeriodAtRequest)
      ?? await lockedSummary(db, storeId, period)
      ?? await buildPreview(db, storeId, period);
    return json({
      locked: financialPeriodAtRequest.status === "LOCKED",
      summary: currentSummary,
      financialPeriod: publicFinancialPeriod(storeId, period, financialPeriodAtRequest),
      message: "Bảng lương kỳ đã được tính.",
    });
  }
  if (!financialPeriodAtRequest && await lockedSummary(db, storeId, period)) {
    return json({ message: "Kỳ lương cũ này đã được tổng kết và khóa." }, 409);
  }
  if (financialPeriodAtRequest?.status === "DRAFT") {
    await db.prepare("DELETE FROM business_records WHERE id = ? AND category = 'KPI_SUMMARY' AND status = 'CALCULATED'")
      .bind(snapshotId(storeId, period)).run();
  }
  if (!canClosePayrollPeriod(period)) return json({ message: "Chỉ được tổng kết lương, thưởng và KPI từ ngày cuối cùng của tháng hoặc sau đó." }, 409);
  const { startUtc, endUtc, localStart, localEnd } = periodBoundsUtc(period);
  const id = snapshotId(storeId, period);
  await db.prepare(`DELETE FROM business_records
    WHERE id = ? AND category = 'KPI_SUMMARY' AND status = 'CLOSING' AND updated_at < ?`)
    .bind(id, stalePayrollGateCutoff()).run();

  const gateStartedAt = utcTimestamp();
  const gateToken = payrollGateToken(`store:${storeId}:${period}`);
  const gateData = JSON.stringify({ gateToken, period, storeId, status: "CLOSING", startedAt: gateStartedAt });
  const gateResult = await db.prepare(`INSERT OR IGNORE INTO business_records
    (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
    SELECT ?, 'KPI_SUMMARY', ?, ?, ?, ?, 'CLOSING', ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM shift_sessions
      WHERE store_id = ? AND status = 'ACTIVE' AND (
        (NULLIF(work_date, '') IS NOT NULL AND work_date >= ? AND work_date < ?)
        OR (NULLIF(work_date, '') IS NULL AND started_at >= ? AND started_at < ?)
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM employee_payroll_closings
      WHERE store_id = ? AND period = ? AND status = 'CLOSING'
    )
    AND NOT EXISTS (
      SELECT 1 FROM salary_advances
      WHERE store_id = ? AND period = ? AND status = 'DRAFT'
    )`)
    .bind(
      id, storeId, user.id, `Đang tổng kết KPI ${period}`, gateData, gateStartedAt, gateStartedAt,
      storeId, localStart, localEnd, startUtc, endUtc,
      storeId, period,
      storeId, period,
    ).run();

  if (affectedRows(gateResult) === 0) {
    if (await lockedSummary(db, storeId, period)) return json({ message: "Kỳ lương này đã được tổng kết và khóa" }, 409);
    const openShift = await db.prepare(`SELECT id FROM shift_sessions
      WHERE store_id = ? AND status = 'ACTIVE' AND (
        (NULLIF(work_date, '') IS NOT NULL AND work_date >= ? AND work_date < ?)
        OR (NULLIF(work_date, '') IS NULL AND started_at >= ? AND started_at < ?)
      ) LIMIT 1`)
      .bind(storeId, localStart, localEnd, startUtc, endUtc).first<{ id: string }>();
    if (openShift) return json({ message: "Cửa hàng còn ca làm trong kỳ chưa kết thúc. Hãy kết ca trước khi chốt lương." }, 409);
    const pendingAdvance = await db.prepare("SELECT id FROM salary_advances WHERE store_id = ? AND period = ? AND status = 'DRAFT' LIMIT 1")
      .bind(storeId, period).first<{ id: string }>();
    if (pendingAdvance) return json({ message: "Hãy xác nhận chi hoặc chỉnh sửa các khoản ứng lương đang chờ trước khi tổng kết tháng." }, 409);
    return json({ message: "Kỳ lương đang được chốt bởi một yêu cầu khác. Vui lòng thử lại sau." }, 409);
  }

  const releaseGate = async () => {
    await db.prepare(`DELETE FROM business_records
      WHERE id = ? AND category = 'KPI_SUMMARY' AND status = 'CLOSING'
        AND json_extract(data_json, '$.gateToken') = ?`)
      .bind(id, gateToken).run();
  };

  try {
    const preview = await buildPreview(db, storeId, period);
    if (!preview) {
      await releaseGate();
      return json({ message: "Không tìm thấy cửa hàng" }, 404);
    }
    const coverageConflict = salaryAdvanceCoverageConflict(preview);
    if (coverageConflict) {
      await releaseGate();
      return coverageConflict;
    }
    const closedEmployees = new Set((await employeePayrollClosings(db, storeId, period)).map((item) => item.employeeId));
    const missingEmployees = preview.items.filter((item) => !closedEmployees.has(item.employeeId));
    if (missingEmployees.length > 0) {
      await releaseGate();
      return json({
        message: `Hãy chốt lương riêng cho từng nhân viên trước khi khóa bảng lương cửa hàng. Còn ${missingEmployees.length} nhân viên chưa khóa sổ.`,
        missingEmployeeIds: missingEmployees.map((item) => item.employeeId),
      }, 409);
    }
    const finalizedAt = utcTimestamp();
    const summary: PayrollSummary = { ...preview, status: "PREVIEW" };
    assertPayrollSummaryInvariants(summary);
    const periodRow = await ensureFinancialPeriodDraft(db, {
      storeId,
      period,
      actorId: user.id,
      now: finalizedAt,
      reason: `Khởi tạo kỳ tài chính để tính bảng lương ${period}`,
    });
    if (periodRow.status !== "DRAFT") {
      await releaseGate();
      return json({
        financialPeriod: publicFinancialPeriod(storeId, period, periodRow),
        message: "Bảng lương kỳ đã được tính bởi một yêu cầu khác.",
      });
    }
    const transition = prepareFinancialPeriodTransitionPlan(db, {
      current: periodRow,
      toStatus: "CALCULATED",
      actorId: user.id,
      now: finalizedAt,
      reason,
      calculation: financialPeriodCalculation(summary),
    });
    const finalizeResults = await db.batch([
      db.prepare(`UPDATE business_records
        SET owner_id = ?, title = ?, data_json = ?, status = 'CALCULATED', updated_at = ?
        WHERE id = ? AND category = 'KPI_SUMMARY' AND status = 'CLOSING'
          AND json_extract(data_json, '$.gateToken') = ?`)
        .bind(user.id, `Bảng lương đã tính ${period}`, JSON.stringify(summary), finalizedAt, id, gateToken),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
        SELECT ?, ?, ?, 'PAYROLL_FINALIZE', 'KPI_SUMMARY', row.id, ?, ?, ?, ?, ?
        FROM business_records row
        WHERE row.id = ? AND row.category = 'KPI_SUMMARY' AND row.status = 'CALCULATED'
          AND row.updated_at = ? AND row.owner_id = ?`)
        .bind(
          crypto.randomUUID(),
          user.id,
          storeId,
          JSON.stringify({ storeId, period, profit: summary.profit, totalHours: summary.totalHours, kpiRate: summary.kpiRate, totalKpiBonus: summary.totalKpiBonus }),
          JSON.stringify({ status: "CLOSING" }),
          JSON.stringify({ status: "CALCULATED", calculatedAt: finalizedAt, calculatedBy: user.id, finalProfit: summary.netProfit }),
          reason,
          finalizedAt,
          id,
          finalizedAt,
          user.id,
        ),
      ...transition.statements,
    ]);
    if (affectedRows(finalizeResults[0]) === 0) {
      await releaseGate();
      return json({ message: "Không thể lưu bảng lương đã tính vì trạng thái vừa được cập nhật bởi yêu cầu khác." }, 409);
    }
    assertFinancialPeriodPlanApplied(finalizeResults, transition, 2);
    return json({
      locked: false,
      summary,
      financialPeriod: publicFinancialPeriod(storeId, period, transition.next),
      message: "Đã tính bảng lương kỳ. Quản lý có thể bắt đầu đối soát.",
    }, 201);
  } catch (error) {
    await releaseGate();
    throw error;
  }
}
