import { initDb, writeAudit } from "../../../db/runtime";
import {
  canClosePayrollPeriod, durationMinutes, localPeriod, MANAGER_MONTHLY_SALARY_VND,
  multiplyRatioVnd, periodBoundsUtc, requireVnd, settleStoreProfit, sumVnd, utcTimestamp,
} from "../../lib/finance";
import {
  MANAGER_FIXED_WORK_HOURS_PER_STORE,
  distributeStoreKpiByPolicy,
  employeePayWithKpi,
  employeePayrollOverallState,
  payrollAdjustmentTotals,
} from "../../lib/payroll";
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
  appliedHourlyRate: number;
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
  managerFixedHours: number;
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
    return [{ id: record.id, kind, employeeId, amount, date, note: note || (kind === "ALLOWANCE" ? "Phá»¥ cáº¥p khÃ¡c" : "ThÆ°á»Ÿng khÃ¡c") }];
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
    message: "KhÃ´ng thá»ƒ chá»‘t hoáº·c xÃ¡c nháº­n chi lÆ°Æ¡ng vÃ¬ lÆ°Æ¡ng hiá»‡n táº¡i khÃ´ng cÃ²n Ä‘á»§ bÃ¹ cÃ¡c khoáº£n á»©ng Ä‘Ã£ táº¡o/Ä‘Ã£ chi. HÃ£y Ä‘iá»u chá»‰nh dá»¯ liá»‡u lÆ°Æ¡ng vÃ  Ä‘á»‘i soÃ¡t khoáº£n á»©ng trÆ°á»›c.",
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
    const closi×núöÚ$z{-®éÜj×·”FVfW'&VC¢V×Æ÷–VT6Æ÷6–æræ·”FVfW'&VBÀ¢Ò’“°¢&WGW&â§6öâ‡°¢V×Æ÷–VT6Æ÷6–ærÀ¢ÖW76vS¢7VÖÖ'’ç7FGW2ÓÓÒ$Äô4´TB ¢ò,I:2¶Œ;6<:2¶†şª6âÌkjærŒ:2I¸¶æ‚>ºvæŒ:&âfœ:¦ââµ’vºòF†Vò.ª6ærÌkjærN¹VærI:2¶Œ;6>ºv>ºÖŒ:ærâ ¢¢,I:2¶Œ;6Ìkjær<j.ª6âl:<:2¶†şª6âŒ:2I¸¶æ‚>ºvæŒ:&âfœ:¦ââµ’>«ÒIkº62L:Öæ‚6Œ:Öæ‚Œ:2¶†’6¹B¾»2>ºÖŒ:ærâ"À¢ÒÂ#“°¢Ò6F6‚†W'&÷"’°¢v—B&VÆV6TvFR‚“°¢F‡&÷rW'&÷#°¢Ğ¢Ğ¢–b†7F–öâÓÒ$d”äÄ•¤UôTÕÄõ”TR"’°¢6öç7BV×Æ÷–VU7VÖÖ'’Òv—BÆö6¶VE7VÖÖ'’†F"Â7F÷&T–BÂW&–öB“°¢–b‚V×Æ÷–VU7VÖÖ'’’&WGW&â§6öâ‡²ÖW76vS¢$Œ:7’6¹BÌkjærFŒk¹öæræŒ:&âfœ:¦âG,k¹¶2â"ÒÂC’“°¢6öç7B6÷fW&vT6öæfÆ–7BÒ6Æ'”Gfæ6T6÷fW&vT6öæfÆ–7B†V×Æ÷–VU7VÖÖ'’“°¢–b†6÷fW&vT6öæfÆ–7B’&WGW&â6÷fW&vT6öæfÆ–7C°¢6öç7BW†—7F–ærÒv—B—&öÆÄ6Æ÷6–ær†F"Â7F÷&T–BÂW&–öB“°¢6öç7Bæ÷rÒWF5F–ÖW7F×‚“° ¢–b†7F–öâÓÓÒ$d”äÄ•¤UôÔätU""’°¢–b†W†—7F–ær’&WGW&â§6öâ‡²6Æ÷6–æs¢W†—7F–ærÂÖW76vS¢$ÌkjærFŒk¹öær^ª6âÌ;ÒI:2Ikº626¹Bâ"Ò“°¢6öç7B6Æ÷6VDV×Æ÷–VW2ÒæWr6WB‚†v—BV×Æ÷–VU—&öÆÄ6Æ÷6–æw2†F"Â7F÷&T–BÂW&–öB’’æÖ‚†—FVÒ’Óâ—FVÒæV×Æ÷–VT–B’“°¢6öç7BÖ—76–ætV×Æ÷–VW2ÒV×Æ÷–VU7VÖÖ'’æ—FV×2æf–ÇFW"‚†—FVÒ’Óâ6Æ÷6VDV×Æ÷–VW2æ†2†—FVÒæV×Æ÷–VT–B’“°¢–b†Ö—76–ætV×Æ÷–VW2æÆVæwF‚â’°¢&WGW&â§6öâ‡°¢ÖW76vS¢Œ:7’6¹BÌkjær&œ:¦ær6†òNº¶æræŒ:&âfœ:¦âG,k¹¶2¶†’6¹BÌkjær^ª6âÌ;Òâ<;&âG¶Ö—76–ætV×Æ÷–VW2æÆVæwF‡ÒæŒ:&âfœ:¦â6Œk¶Œ;6>¹RæÀ¢Ö—76–ætV×Æ÷–VT–G3¢Ö—76–ætV×Æ÷–VW2æÖ‚†—FVÒ’Óâ—FVÒæV×Æ÷–VT–B’À¢ÒÂC’“°¢Ğ¢6öç7BÖævW%6Æ'’ÒV×Æ÷–VU7VÖÖ'’æÖævW%6Æ'’óòÔätU%ôÔôåD„Å•õ4Ä%•õdäC°¢6öç7BÖævW$&öçW2ÒV×Æ÷–VU7VÖÖ'’æÖævW$&öçW2óò°¢6öç7BÖævW%F÷FÂÒ7VÕfæB…¶ÖævW%6Æ'’ÂÖævW$&öçW5Ò“°¢6öç7B6Æ'”Gfæ6U–EF÷FÂÒ6fU—&öÆÅfæB†V×Æ÷–VU7VÖÖ'’çF÷FÅ6Æ'”Gfæ6U–B“°¢6öç7B6WGFÆVÖVçBÒ6Æ'”Gfæ6U6WGFÆVÖVçE7Æ—B‡°¢V×Æ÷–VT&6U6Æ'“¢V×Æ÷–VU7VÖÖ'’çF÷FÄ&6U6Æ'’À¢V×Æ÷–VUF÷FÅ“¢V×Æ÷–VU7VÖÖ'’çF÷FÅ’À¢ÖævW%6Æ'’À¢ÖævW$&öçW2À¢Gfæ6TÖ÷VçC¢6Æ'”Gfæ6U–EF÷FÂÀ¢Ò“°¢6öç7BV×Æ÷–VUF÷FÂÒ6fU—&öÆÅfæB‡6WGFÆVÖVçBæV×Æ÷–VU&VÖ–æ–ær“°¢6öç7B6Æ÷6–æs¢—&öÆÄ6Æ÷6–ærÒ°¢W&–öBÀ¢7F÷&T–BÀ¢7F÷&TæÖS¢V×Æ÷–VU7VÖÖ'’ç7F÷&TæÖRÀ¢V×Æ÷–VUF÷FÂÀ¢V×Æ÷–VTw&÷75F÷FÃ¢V×Æ÷–VU7VÖÖ'’çF÷FÅ’À¢6Æ'”Gfæ6U–EF÷FÂÀ¢ÖævW%6Æ'’À¢ÖævW$&öçW2À¢ÖævW%F÷FÂÀ¢6Æ'•F÷FÃ¢6WGFÆVÖVçBç6Æ'•F÷FÂÀ¢&Wv&DÆÆ÷væ6UF÷FÃ¢6WGFÆVÖVçBç&Wv&DÆÆ÷væ6UF÷FÂÀ¢w&æEF÷FÃ¢6WGFÆVÖVçBæw&æEF÷FÂÀ¢7FGW3¢$ÔätU%ôd”äÄ•¤TB"À¢ÖævW$f–æÆ—¦VDC¢æ÷rÀ¢ÖævW$f–æÆ—¦VD'“¢W6W"æ–BÀ¢Ó°¢6öç7B–BÒ6Æ÷6–æt–B‡7F÷&T–BÂW&–öB“°¢G'’°¢v—BF"ç&W&R‚$”å4U%B”åDò'W6–æW75÷&V6÷&G2†–BÂ6FVv÷'’Â7F÷&Uö–BÂ÷væW%ö–BÂF—FÆRÂFFö§6öâÂ7FGW2Â7&VFVEöBÂWFFVEöB’dÅTU2ƒòÂu•$ôÄÅô4Äõ4”ärrÂòÂòÂòÂòÂtÔätU%ôd”äÄ•¤TBrÂòÂò’"¢æ&–æB†–BÂ7F÷&T–BÂW6W"æ–BÂ¾«÷B>¹RÌkjærG·W&–öGÖÂ¥4ôâç7G&–æv–g’†6Æ÷6–ær’Âæ÷rÂæ÷r’ç'Vâ‚“°¢Ò6F6‚°¢6öç7B7W'&VçBÒv—B—&öÆÄ6Æ÷6–ær†F"Â7F÷&T–BÂW&–öB“°¢–b†7W'&VçB’&WGW&â§6öâ‡²6Æ÷6–æs¢7W'&VçBÂÖW76vS¢$ÌkjærFŒk¹öær^ª6âÌ;ÒI:2Ikº626¹Bâ"Ò“°¢&WGW&â§6öâ‡²ÖW76vS¢$¶Œ;FærF¸26¹BÌkjærFŒk¹öær^ª6âÌ;Òâ"ÒÂC’“°¢Ğ¢v—Bw&—FTVF—B‡W6W"æ–BÂ$ÔätU%õ•$ôÄÅôd”äÄ•¤R"Â%•$ôÄÅô4Äõ4”är"Â–BÂ¥4ôâç7G&–æv–g’‡²7F÷&T–BÂW&–öBÂÖævW%6Æ'’ÂÖævW$&öçW2Ò’“°¢&WGW&â§6öâ‡²6Æ÷6–ærÂÖW76vS¢,I:26¹BÌkjærFŒk¹öær^ª6âÌ;Òâ"ÒÂ#“°¢Ğ ¢–b‚W†—7F–ær’&WGW&â§6öâ‡²ÖW76vS¢$Œ:7’6¹BÌkjærFŒk¹öær^ª6âÌ;ÒG,k¹¶2â"ÒÂC’“°¢6öç7B–BÒ6Æ÷6–æt–B‡7F÷&T–BÂW&–öB“°¢–b†7F–öâÓÓÒ$4ôäd•$Õõ4Ä%’"’°¢–b…²%4Ä%•ô4ôäd•$ÔTB"Â%$Ut$E5ô4ôäd•$ÔTB"Â%”ÔTåEô4ôäd•$ÔTB"Â$Äô4´TB%Òæ–æ6ÇVFW2†W†—7F–ærç7FGW2’’&WGW&â§6öâ‡²6Æ÷6–æs¢W†—7F–ærÂÖW76vS¢$¶†şª6â6†’ÌkjærI:2Ikº62Œ:2æªÖââ"Ò“°¢–b†W†—7F–ærç7FGW2ÓÒ$ÔätU%ôd”äÄ•¤TB"’&WGW&â§6öâ‡²ÖW76vS¢%G.ªærFŒ:’¾»2Ìkjær¶Œ;Færº7Î¸rI¸2Œ:2æªÖâ6†’Ìkjærâ"ÒÂC’“°¢6öç7B6Æ÷6–æs¢—&öÆÄ6Æ÷6–ærÒ²ââæW†—7F–ærÂ7FGW3¢%4Ä%•ô4ôäd•$ÔTB"Â6Æ'”6öæf—&ÖVDC¢æ÷rÂ6Æ'”6öæf—&ÖVD'“¢W6W"æ–BÓ°¢6öç7B&W7VÇBÒv—BF"ç&W&R‚%UDDR'W6–æW75÷&V6÷&G24UBFFö§6öâÒòÂ7FGW2Òu4Ä%•ô4ôäd•$ÔTBrÂWFFVEöBÒòt„U$R–BÒòäB7FGW2ÒtÔätU%ôd”äÄ•¤TBr"¢æ&–æB„¥4ôâç7G&–æv–g’†6Æ÷6–ær’Âæ÷rÂ–B’ç'Vâ‚“°¢–b†ffV7FVE&÷w2‡&W7VÇB’ÓÓÒ’°¢6öç7B7W'&VçBÒv—B—&öÆÄ6Æ÷6–ær†F"Â7F÷&T–BÂW&–öB“°¢&WGW&â7W'&Vç@¢ò§6öâ‡²6Æ÷6–æs¢7W'&VçBÂÖW76vS¢%G.ªærFŒ:’¾»2ÌkjærI:2Ikº62>ª×æª×B.¹ö’Ş¹—Bœ:§R>ªwR¶Œ:2â"Ò¢¢§6öâ‡²ÖW76vS¢$¶Œ;FærF¸2Œ:2æªÖâ¶†şª6â6†’Ìkjærâ"ÒÂC’“°¢Ğ¢v—Bw&—FTVF—B‡W6W"æ–BÂ%•$ôÄÅõ4Ä%•ô4ôäd•$Ò"Â%•$ôÄÅô4Äõ4”är"Â–BÂ¥4ôâç7G&–æv–g’‡²7F÷&T–BÂW&–öBÂÖ÷VçC¢6Æ÷6–ærç6Æ'•F÷FÂÒ’“°¢&WGW&â§6öâ‡²6Æ÷6–ærÂÖW76vS¢,I:2Œ:2æªÖâ¶†şª6â6†’ÌkjæræŒ:&âfœ:¦âl:^ª6âÌ;Òâ"Ò“°¢Ğ¢–b†7F–öâÓÓÒ$4ôäd•$Õõ$Ut$E2"’°¢–b…²%$Ut$E5ô4ôäd•$ÔTB"Â%”ÔTåEô4ôäd•$ÔTB"Â$Äô4´TB%Òæ–æ6ÇVFW2†W†—7F–ærç7FGW2’’&WGW&â§6öâ‡²6Æ÷6–æs¢W†—7F–ærÂÖW76vS¢$¶†şª6âFŒk¹öærl:ºR>ªWI:2Ikº62Œ:2æªÖââ"Ò“°¢–b†W†—7F–ærç7FGW2ÓÒ%4Ä%•ô4ôäd•$ÔTB"’&WGW&â§6öâ‡²ÖW76vS¢$Œ:7’Œ:2æªÖâ¶†şª6â6†’ÌkjærG,k¹¶2â"ÒÂC’“°¢6öç7B6Æ÷6–æs¢—&öÆÄ6Æ÷6–ærÒ²ââæW†—7F–ærÂ7FGW3¢%$Ut$E5ô4ôäd•$ÔTB"Â&Wv&G46öæf—&ÖVDC¢æ÷rÂ&Wv&G46öæf—&ÖVD'“¢W6W"æ–BÓ°¢6öç7B&W7VÇBÒv—BF"ç&W&R‚%UDDR'W6–æW75÷&V6÷&G24UBFFö§6öâÒòÂ7FGW2Òu$Ut$E5ô4ôäd•$ÔTBrÂWFFVEöBÒòt„U$R–BÒòäB7FGW2Òu4Ä%•ô4ôäd•$ÔTBr"¢æ&–æB„¥4ôâç7G&–æv–g’†6Æ÷6–ær’Âæ÷rÂ–B’ç'Vâ‚“°¢–b†ffV7FVE&÷w2‡&W7VÇB’ÓÓÒ’°¢6öç7B7W'&VçBÒv—B—&öÆÄ6Æ÷6–ær†F"Â7F÷&T–BÂW&–öB“°¢&WGW&â7W'&Vç@¢ò§6öâ‡²6Æ÷6–æs¢7W'&VçBÂÖW76vS¢%G.ªærFŒ:’¾»2ÌkjærI:2Ikº62>ª×æª×B.¹ö’Ş¹—Bœ:§R>ªwR¶Œ:2â"Ò¢¢§6öâ‡²ÖW76vS¢$¶Œ;FærF¸2Œ:2æªÖâ¶†şª6âFŒk¹öærl:ºR>ªWâ"ÒÂC’“°¢Ğ¢v—Bw&—FTVF—B‡W6W"æ–BÂ%•$ôÄÅõ$Ut$E5ô4ôäd•$Ò"Â%•$ôÄÅô4Äõ4”är"Â–BÂ¥4ôâç7G&–æv–g’‡²7F÷&T–BÂW&–öBÂÖ÷VçC¢6Æ÷6–ærç&Wv&DÆÆ÷væ6UF÷FÂÒ’“°¢&WGW&â§6öâ‡²6Æ÷6–ærÂÖW76vS¢,I:2Œ:2æªÖâ¶†şª6â6†’FŒk¹öærl:ºR>ªWâ"Ò“°¢Ğ¢–b†7F–öâÓÓÒ$4ôäd•$Õõ”ÔTåB"’°¢–b†W†—7F–ærç7FGW2ÓÓÒ$Äô4´TB"’&WGW&â§6öâ‡²6Æ÷6–æs¢W†—7F–ærÂÖW76vS¢$¾»2ÌkjærI:2¾«÷B>¹Rl:¶Œ;6â"Ò“°¢–b†W†—7F–ærç7FGW2ÓÓÒ%”ÔTåEô4ôäd•$ÔTB"’&WGW&â§6öâ‡²6Æ÷6–æs¢W†—7F–ærÂÖW76vS¢,I:2v†’æªÖâ6†’G.ª2ÌkjærÂFŒk¹öærl:ºR>ªWâ"Ò“°¢–b†W†—7F–ærç7FGW2ÓÒ%$Ut$E5ô4ôäd•$ÔTB"’&WGW&â§6öâ‡²ÖW76vS¢$Œ:7’Œ:2æªÖâ&œ:¦ær¶†şª6â6†’Ìkjærl:¶†şª6âFŒk¹öærÂºR>ªWG,k¹¶2â"ÒÂC’“°¢6öç7B6Æ÷6–æs¢—&öÆÄ6Æ÷6–ærÒ²ââæW†—7F–ærÂ7FGW3¢%”ÔTåEô4ôäd•$ÔTB"Â–ÖVçD6öæf—&ÖVDC¢æ÷rÂ–ÖVçD6öæf—&ÖVD'“¢W6W"æ–BÓ°¢6öç7B&W7VÇBÒv—BF"ç&W&R‚%UDDR'W6–æW75÷&V6÷&G24UBFFö§6öâÒòÂ7FGW2Òu”ÔTåEô4ôäd•$ÔTBrÂWFFVEöBÒòt„U$R–BÒòäB7FGW2Òu$Ut$E5ô4ôäd•$ÔTBr"¢æ&–æB„¥4ôâç7G&–æv–g’†6Æ÷6–ær’Âæ÷rÂ–B’ç'Vâ‚“°¢–b†ffV7FVE&÷w2‡&W7VÇB’ÓÓÒ’°¢6öç7B7W'&VçBÒv—B—&öÆÄ6Æ÷6–ær†F"Â7F÷&T–BÂW&–öB“°¢&WGW&â7W'&Vç@¢ò§6öâ‡²6Æ÷6–æs¢7W'&VçBÂÖW76vS¢%G.ªærFŒ:’¾»2ÌkjærI:2Ikº62>ª×æª×B.¹ö’Ş¹—Bœ:§R>ªwR¶Œ:2â"Ò¢¢§6öâ‡²ÖW76vS¢$¶Œ;FærF¸2v†’æªÖâ6†’G.ª2ÌkjærFŒk¹öærâ"ÒÂC’“°¢Ğ¢v—Bw&—FTVF—B‡W6W"æ–BÂ%•$ôÄÅõ”ÔTåEô4ôäd•$Ò"Â%•$ôÄÅô4Äõ4”är"Â–BÂ¥4ôâç7G&–æv–g’‡²7F÷&T–BÂW&–öBÂw&æEF÷FÃ¢6Æ÷6–æræw&æEF÷FÂÒ’“°¢&WGW&â§6öâ‡²6Æ÷6–ærÂÖW76vS¢,I:26†’l:v†’æªÖâÎ¸¶6‚>ºÒ6†’ÌkjærÂFŒk¹öærÂºR>ªWâ"Ò“°¢Ğ ¢–b†W†—7F–ærç7FGW2ÓÓÒ$Äô4´TB"’&WGW&â§6öâ‡²6Æ÷6–æs¢W†—7F–ærÂÖW76vS¢$¾»2ÌkjærI:2¾«÷B>¹Rl:¶Œ;6â"Ò“°¢–b†7F–öâÓÒ$4Äõ4UõU$”ôB"’&WGW&â§6öâ‡²ÖW76vS¢%F†òL:26¹B¾»2Ìkjær¶Œ;Færº7Î¸râ"ÒÂC“°¢–b†W†—7F–ærç7FGW2ÓÒ%”ÔTåEô4ôäd•$ÔTB"’&WGW&â§6öâ‡²ÖW76vS¢$Œ:7’Œ:2æªÖâ6†’G,k¹¶2¶†’¾«÷B>¹Râ"ÒÂC’“°¢6öç7B6Æ÷6–æs¢—&öÆÄ6Æ÷6–ærÒ²ââæW†—7F–ærÂ7FGW3¢$Äô4´TB"Â6Æ÷6VDC¢æ÷rÂ6Æ÷6VD'“¢W6W"æ–BÓ°¢6öç7B&W7VÇBÒv—BF"ç&W&R‚%UDDR'W6–æW75÷&V6÷&G24UBFFö§6öâÒòÂ7FGW2ÒtÄô4´TBrÂWFFVEöBÒòt„U$R–BÒòäB7FGW2Òu”ÔTåEô4ôäd•$ÔTBr"¢æ&–æB„¥4ôâç7G&–æv–g’†6Æ÷6–ær’Âæ÷rÂ–B’ç'Vâ‚“°¢–b†ffV7FVE&÷w2‡&W7VÇB’ÓÓÒ’°¢6öç7B7W'&VçBÒv—B—&öÆÄ6Æ÷6–ær†F"Â7F÷&T–BÂW&–öB“°¢&WGW&â7W'&Vç@¢ò§6öâ‡²6Æ÷6–æs¢7W'&VçBÂÖW76vS¢%G.ªærFŒ:’¾»2ÌkjærI:2Ikº62>ª×æª×B.¹ö’Ş¹—Bœ:§R>ªwR¶Œ:2â"Ò¢¢§6öâ‡²ÖW76vS¢$¶Œ;FærF¸2¾«÷B>¹R¾»2Ìkjærâ"ÒÂC’“°¢Ğ¢v—Bw&—FTVF—B‡W6W"æ–BÂ%•$ôÄÅõU$”ôEô4Äõ4R"Â%•$ôÄÅô4Äõ4”är"Â–BÂ¥4ôâç7G&–æv–g’‡²7F÷&T–BÂW&–öBÂw&æEF÷FÃ¢6Æ÷6–æræw&æEF÷FÂÒ’“°¢&WGW&â§6öâ‡²6Æ÷6–ærÂÖW76vS¢,I:2¾«÷B>¹Rl:¶Œ;6¾»2ÌkjærFŒk¹öærâ"Ò“°¢Ğ ¢–b†v—BÆö6¶VE7VÖÖ'’†F"Â7F÷&T–BÂW&–öB’’&WGW&â§6öâ‡²ÖW76vS¢$¾»2Ìkjærì:’I:2Ikº62N¹Vær¾«÷Bl:¶Œ;6"ÒÂC’“°¢–b‚6ä6Æ÷6U—&öÆÅW&–öB‡W&–öB’’&WGW&â§6öâ‡²ÖW76vS¢$6¸’Ikº62N¹Vær¾«÷BÌkjærÂFŒk¹öærl:µ’Nº²æ|:’7^¹’<;–ær>ºvFŒ:ær†ş«v26RI;2â"ÒÂC’“°¢6öç7B²7F'EWF2ÂVæEWF2ÂÆö6Å7F'BÂÆö6ÄVæBÒÒW&–öD&÷VæG5WF2‡W&–öB“°¢6öç7B–BÒ6æ6†÷D–B‡7F÷&T–BÂW&–öB“°¢v—BF"ç&W&R†DTÄUDRe$ôÒ'W6–æW75÷&V6÷&G0¢t„U$R–BÒòäB6FVv÷'’Òtµ•õ5TÔÔ%’räB7FGW2Òt4Äõ4”ärräBWFFVEöBÂö¢æ&–æB†–BÂ7FÆU—&öÆÄvFT7WFöfb‚’’ç'Vâ‚“° ¢6öç7BvFU7F'FVDBÒWF5F–ÖW7F×‚“°¢6öç7BvFUFö¶VâÒ—&öÆÄvFUFö¶Vâ†7F÷&S¢G·7F÷&T–GÓ¢G·W&–öGÖ“°¢6öç7BvFTFFÒ¥4ôâç7G&–æv–g’‡²vFUFö¶VâÂW&–öBÂ7F÷&T–BÂ7FGW3¢$4Äõ4”är"Â7F'FVDC¢vFU7F'FVDBÒ“°¢6öç7BvFU&W7VÇBÒv—BF"ç&W&R†”å4U%Bõ"”täõ$R”åDò'W6–æW75÷&V6÷&G0¢†–BÂ6FVv÷'’Â7F÷&Uö–BÂ÷væW%ö–BÂF—FÆRÂFFö§6öâÂ7FGW2Â7&VFVEöBÂWFFVEöB¢4TÄT5BòÂtµ•õ5TÔÔ%’rÂòÂòÂòÂòÂt4Äõ4”ärrÂòÂğ¢t„U$RäõBU„•5E2€¢4TÄT5Be$ôÒ6†–gE÷6W76–öç0¢t„U$R7F÷&Uö–BÒòäB7FGW2Òt5D•dRräB€¢„åTÄÄ”b‡v÷&µöFFRÂrr’•2äõBåTÄÂäBv÷&µöFFRãÒòäBv÷&µöFFRÂò¢õ"„åTÄÄ”b‡v÷&µöFFRÂrr’•2åTÄÂäB7F'FVEöBãÒòäB7F'FVEöBÂò¢¢¢äBäõBU„•5E2€¢4TÄT5Be$ôÒV×Æ÷–VU÷—&öÆÅö6Æ÷6–æw0¢t„U$R7F÷&Uö–BÒòäBW&–öBÒòäB7FGW2Òt4Äõ4”ärp¢¢äBäõBU„•5E2€¢4TÄT5Be$ôÒ6Æ'•öGfæ6W0¢t„U$R7F÷&Uö–BÒòäBW&–öBÒòäB7FGW2ÒtE$eBp¢–¢æ&–æB€¢–BÂ7F÷&T–BÂW6W"æ–BÂIærN¹Vær¾«÷Bµ’G·W&–öGÖÂvFTFFÂvFU7F'FVDBÂvFU7F'FVDBÀ¢7F÷&T–BÂÆö6Å7F'BÂÆö6ÄVæBÂ7F'EWF2ÂVæEWF2À¢7F÷&T–BÂW&–öBÀ¢7F÷&T–BÂW&–öBÀ¢’ç'Vâ‚“° ¢–b†ffV7FVE&÷w2†vFU&W7VÇB’ÓÓÒ’°¢–b†v—BÆö6¶VE7VÖÖ'’†F"Â7F÷&T–BÂW&–öB’’&WGW&â§6öâ‡²ÖW76vS¢$¾»2Ìkjærì:’I:2Ikº62N¹Vær¾«÷Bl:¶Œ;6"ÒÂC’“°¢6öç7B÷Vå6†–gBÒv—BF"ç&W&R†4TÄT5B–Be$ôÒ6†–gE÷6W76–öç0¢t„U$R7F÷&Uö–BÒòäB7FGW2Òt5D•dRräB€¢„åTÄÄ”b‡v÷&µöFFRÂrr’•2äõBåTÄÂäBv÷&µöFFRãÒòäBv÷&µöFFRÂò¢õ"„åTÄÄ”b‡v÷&µöFFRÂrr’•2åTÄÂäB7F'FVEöBãÒòäB7F'FVEöBÂò¢’Ä”Ô•B¢æ&–æB‡7F÷&T–BÂÆö6Å7F'BÂÆö6ÄVæBÂ7F'EWF2ÂVæEWF2’æf—'7CÇ²–C¢7G&–ærÓâ‚“°¢–b†÷Vå6†–gB’&WGW&â§6öâ‡²ÖW76vS¢$>ºÖŒ:ær<;&â6Ì:ÒG&öær¾»26Œk¾«÷BFŒ;¦2âŒ:7’¾«÷B6G,k¹¶2¶†’6¹BÌkjærâ"ÒÂC’“°¢6öç7BVæF–ætGfæ6RÒv—BF"ç&W&R‚%4TÄT5B–Be$ôÒ6Æ'•öGfæ6W2t„U$R7F÷&Uö–BÒòäBW&–öBÒòäB7FGW2ÒtE$eBrÄ”Ô•B"¢æ&–æB‡7F÷&T–BÂW&–öB’æf—'7CÇ²–C¢7G&–ærÓâ‚“°¢–b‡VæF–ætGfæ6R’&WGW&â§6öâ‡²ÖW76vS¢$Œ:7’Œ:2æªÖâ6†’†ş«v26¸–æ‚>ºÖ<:2¶†şª6âº–ærÌkjærIær6¹ÒG,k¹¶2¶†’N¹Vær¾«÷BFŒ:ærâ"ÒÂC’“°¢&WGW&â§6öâ‡²ÖW76vS¢$¾»2ÌkjærIærIkº626¹B.¹ö’Ş¹—Bœ:§R>ªwR¶Œ:2âgV’Ì;&ærFºÒÎª’6Râ"ÒÂC’“°¢Ğ ¢6öç7B&VÆV6TvFRÒ7–æ2‚’Óâ°¢v—BF"ç&W&R†DTÄUDRe$ôÒ'W6–æW75÷&V6÷&G0¢t„U$R–BÒòäB6FVv÷'’Òtµ•õ5TÔÔ%’räB7FGW2Òt4Äõ4”ärp¢äB§6öåöW‡G&7B†FFö§6öâÂrBævFUFö¶Vâr’Òö¢æ&–æB†–BÂvFUFö¶Vâ’ç'Vâ‚“°¢Ó° ¢G'’°¢6öç7B&Wf–WrÒv—B'V–ÆE&Wf–Wr†F"Â7F÷&T–BÂW&–öB“°¢–b‚&Wf–Wr’°¢v—B&VÆV6TvFR‚“°¢&WGW&â§6öâ‡²ÖW76vS¢$¶Œ;FærL:ÆÒFªW’>ºÖŒ:ær"ÒÂCB“°¢Ğ¢6öç7B6÷fW&vT6öæfÆ–7BÒ6Æ'”Gfæ6T6÷fW&vT6öæfÆ–7B‡&Wf–Wr“°¢–b†6÷fW&vT6öæfÆ–7B’°¢v—B&VÆV6TvFR‚“°¢&WGW&â6÷fW&vT6öæfÆ–7C°¢Ğ¢6öç7B6Æ÷6VDV×Æ÷–VW2ÒæWr6WB‚†v—BV×Æ÷–VU—&öÆÄ6Æ÷6–æw2†F"Â7F÷&T–BÂW&–öB’’æÖ‚†—FVÒ’Óâ—FVÒæV×Æ÷–VT–B’“°¢6öç7BÖ—76–ætV×Æ÷–VW2Ò&Wf–Wræ—FV×2æf–ÇFW"‚†—FVÒ’Óâ6Æ÷6VDV×Æ÷–VW2æ†2†—FVÒæV×Æ÷–VT–B’“°¢–b†Ö—76–ætV×Æ÷–VW2æÆVæwF‚â’°¢v—B&VÆV6TvFR‚“°¢&WGW&â§6öâ‡°¢ÖW76vS¢Œ:7’6¹BÌkjær&œ:¦ær6†òNº¶æræŒ:&âfœ:¦âG,k¹¶2¶†’¶Œ;6.ª6ærÌkjær>ºÖŒ:ærâ<;&âG¶Ö—76–ætV×Æ÷–VW2æÆVæwF‡ÒæŒ:&âfœ:¦â6Œk¶Œ;6>¹RæÀ¢Ö—76–ætV×Æ÷–VT–G3¢Ö—76–ætV×Æ÷–VW2æÖ‚†—FVÒ’Óâ—FVÒæV×Æ÷–VT–B’À¢ÒÂC’“°¢Ğ¢6öç7Bf–æÆ—¦VDBÒWF5F–ÖW7F×‚“°¢6öç7B7VÖÖ'“¢—&öÆÅ7VÖÖ'’Ò²ââç&Wf–WrÂ7FGW3¢$Äô4´TB"Âf–æÆ—¦VDBÂf–æÆ—¦VD'“¢W6W"æ–BÓ°¢6öç7Bf–æÆ—¦U&W7VÇBÒv—BF"ç&W&R†UDDR'W6–æW75÷&V6÷&G0¢4UB÷væW%ö–BÒòÂF—FÆRÒòÂFFö§6öâÒòÂ7FGW2ÒtÄô4´TBrÂWFFVEöBÒğ¢t„U$R–BÒòäB6FVv÷'’Òtµ•õ5TÔÔ%’räB7FGW2Òt4Äõ4”ärp¢äB§6öåöW‡G&7B†FFö§6öâÂrBævFUFö¶Vâr’Òö¢æ&–æB‡W6W"æ–BÂN¹Vær¾«÷Bµ’G·W&–öGÖÂ¥4ôâç7G&–æv–g’‡7VÖÖ'’’Âf–æÆ—¦VDBÂ–BÂvFUFö¶Vâ’ç'Vâ‚“°¢–b†ffV7FVE&÷w2†f–æÆ—¦U&W7VÇB’ÓÓÒ’°¢v—B&VÆV6TvFR‚“°¢&WGW&â§6öâ‡²ÖW76vS¢$¶Œ;FærF¸2¶Œ;6¾»2Ìkjærl:ÂG.ªærFŒ:’nº¶Ikº62>ª×æª×B.¹ö’œ:§R>ªwR¶Œ:2â"ÒÂC’“°¢Ğ¢v—Bw&—FTVF—B‡W6W"æ–BÂ%•$ôÄÅôd”äÄ•¤R"Â$µ•õ5TÔÔ%’"Â–BÂ¥4ôâç7G&–æv–g’‡²7F÷&T–BÂW&–öBÂ&öf—C¢7VÖÖ'’ç&öf—BÂF÷FÄ†÷W'3¢7VÖÖ'’çF÷FÄ†÷W'2Â·•&FS¢7VÖÖ'’æ·•&FRÂF÷FÄ·”&öçW3¢7VÖÖ'’çF÷FÄ·”&öçW2Ò’“°¢&WGW&â§6öâ‡²Æö6¶VC¢G'VRÂ7VÖÖ'’ÂÖW76vS¢,I:2N¹Vær¾«÷Bl:¶Œ;6¾»2ÌkjærFŒk¹öær"ÒÂ#“°¢Ò6F6‚†W'&÷"’°¢v—B&VÆV6TvFR‚“°¢F‡&÷rW'&÷#°¢Ğ§Ğ 