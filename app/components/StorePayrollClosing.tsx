"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, LockKeyhole, RefreshCw, WalletCards } from "lucide-react";
import { canClosePayrollPeriod, payrollPeriodClosingDate } from "../lib/finance";
import { PAYROLL_UPDATED_EVENT } from "../lib/payroll";
import { salaryAdvanceSettlementSplit } from "../lib/salary-advances";
import { DatePickerControl } from "./DatePickerControl";
import styles from "./StorePayrollClosing.module.css";

type Store = { id: string; name: string; status?: string };

type PayrollItem = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  position: string;
  employmentStatus?: "ACTIVE" | "INACTIVE";
  completedShiftCount?: number;
  kpiCompletedShiftCount?: number;
  kpiEligible?: boolean;
  durationMinutes: number;
  hours: number;
  kpiDurationSeconds?: number;
  kpiHours?: number;
  hourlyRate: number;
  baseSalary: number;
  tiktokAllowance: number;
  supportAllowance: number;
  manualAllowance: number;
  manualBonus: number;
  kpiBonus: number;
  totalPay: number;
  salaryAdvancePending: number;
  salaryAdvancePaid: number;
  salaryAdvanceReserved: number;
  availablePay: number;
};

type PayrollSummary = {
  period: string;
  storeId: string;
  storeName: string;
  revenue: number;
  expense: number;
  profit: number;
  netProfit?: number;
  totalHours: number;
  totalDurationMinutes: number;
  kpiEligibleHours?: number;
  totalKpiHours?: number;
  profitPerHour: number;
  profitPerKpiHour?: number;
  kpiRate: number;
  kpiPool?: number;
  totalBaseSalary: number;
  totalTikTokAllowance: number;
  totalSupportAllowance: number;
  totalManualAllowance: number;
  totalManualBonus: number;
  totalKpiBonus: number;
  totalPerformanceBonus?: number;
  managerSalary: number;
  managerBonus: number;
  managerTotal: number;
  costBreakdown: {
    employeeBaseSalary: number;
    tiktokAllowance: number;
    supportAllowance: number;
    manualAllowance: number;
    manualBonus: number;
    managerSalary: number;
    employeeKpiBonus: number;
    managerBonus: number;
  };
  payrollPolicy?: {
    managerMonthlySalaryVnd: number;
    managerKpiRatePercent: number | null;
    version: number;
  };
  totalPay: number;
  totalSalaryAdvancePending: number;
  totalSalaryAdvancePaid: number;
  totalSalaryAdvanceReserved: number;
  totalAvailablePay: number;
  items: PayrollItem[];
  status: "PREVIEW" | "LOCKED";
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
  salaryConfirmedAt?: string;
  rewardsConfirmedAt?: string;
  paymentConfirmedAt?: string;
  closedAt?: string;
};

type EmployeePayrollClosing = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeStatusAtLock: "ACTIVE" | "INACTIVE";
  status: "BASE_LOCKED" | "LOCKED";
  kpiDeferred: boolean;
  lockedAt: string;
  lockedBy: string;
  item: PayrollItem;
};

type FinancialPeriodStatus = "DRAFT" | "CALCULATED" | "RECONCILING" | "CONFIRMED" | "PAID" | "LOCKED";

type FinancialPeriod = {
  id: string;
  storeId: string;
  period: string;
  status: FinancialPeriodStatus;
  revision: number;
  calculatedAt?: string | null;
  confirmedAt?: string | null;
  paidAt?: string | null;
  lockedAt?: string | null;
};

type PayrollResponse = {
  period?: string;
  message?: string;
  locked?: boolean;
  summary?: PayrollSummary;
  employeeClosings?: EmployeePayrollClosing[];
  individualLockedCount?: number;
  closing?: PayrollClosing | null;
  financialPeriod?: FinancialPeriod | null;
  previousSummary?: PayrollSummary | null;
  history?: PayrollClosing[];
};

type PayrollAction = "FINALIZE_SINGLE_EMPLOYEE" | "FINALIZE_EMPLOYEE" | "FINALIZE_MANAGER" | "CONFIRM_SALARY" | "CONFIRM_REWARDS" | "CONFIRM_PAYMENT" | "CLOSE_PERIOD";

type PayrollWorkflowAction = {
  action: Exclude<PayrollAction, "FINALIZE_SINGLE_EMPLOYEE">;
  label: string;
  completed: boolean;
  available: boolean;
  reason: string;
};

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = (value: number | undefined) => `${moneyFormatter.format(Number(value ?? 0))} đồng`;
const percent = (value: number | undefined) => `${(Number(value ?? 0) * 100).toFixed(0)}%`;
const dateTime24 = (value: string | undefined) => value
  ? new Intl.DateTimeFormat("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(value))
  : "—";

function currentPeriod() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "2026";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

function statusLabel(status: PayrollClosing["status"] | undefined) {
  if (status === "MANAGER_FINALIZED") return "Đã chốt quản lý";
  if (status === "SALARY_CONFIRMED") return "Đã xác nhận chi lương";
  if (status === "REWARDS_CONFIRMED") return "Đã xác nhận thưởng, phụ cấp";
  if (status === "PAYMENT_CONFIRMED") return "Đã xác nhận chi";
  if (status === "LOCKED") return "Đã kết sổ";
  return "Chưa chốt";
}

const financialPeriodRank: Record<FinancialPeriodStatus, number> = {
  DRAFT: 0,
  CALCULATED: 1,
  RECONCILING: 2,
  CONFIRMED: 3,
  PAID: 4,
  LOCKED: 5,
};

function financialPeriodStatusLabel(status: FinancialPeriodStatus | undefined) {
  if (status === "DRAFT") return "Đang nhập liệu";
  if (status === "CALCULATED") return "Đã tính bảng lương";
  if (status === "RECONCILING") return "Đang đối soát";
  if (status === "CONFIRMED") return "Đã xác nhận số liệu";
  if (status === "PAID") return "Đã xác nhận chi";
  if (status === "LOCKED") return "Đã khóa kỳ";
  return "Chưa tạo kỳ";
}

function payrollActionReason(action: PayrollAction, employee?: PayrollItem) {
  if (action === "FINALIZE_SINGLE_EMPLOYEE") {
    return `Chốt bảng lương cá nhân ${employee?.employeeCode ?? "chưa xác định"} để phục vụ đối soát kỳ.`;
  }
  if (action === "FINALIZE_EMPLOYEE") return "Tính bảng lương kỳ từ dữ liệu chấm công, phụ cấp, thưởng và ứng lương đã đối soát.";
  if (action === "FINALIZE_MANAGER") return "Bắt đầu đối soát toàn bộ bảng lương nhân viên và quản lý của kỳ.";
  if (action === "CONFIRM_SALARY") return "Xác nhận đã đối soát phần lương cơ bản của kỳ.";
  if (action === "CONFIRM_REWARDS") return "Xác nhận số liệu lương, thưởng, phụ cấp, KPI và ứng lương toàn kỳ.";
  if (action === "CONFIRM_PAYMENT") return "Xác nhận các khoản lương và thưởng của kỳ đã được chi trả.";
  return "Khóa kỳ sau khi hoàn tất đối soát, xác nhận số liệu và chi trả.";
}

function delta(current: number | undefined, previous: number | undefined) {
  const value = Number(current ?? 0) - Number(previous ?? 0);
  return `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
}

function localDateLabel(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function assertPayrollMoney(label: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Bảng lương không hợp lệ: ${label} không phải số tiền VND an toàn.`);
  }
  return value;
}

function sumPayrollMoney(label: string, values: number[]) {
  const total = values.reduce((sum, value) => sum + assertPayrollMoney(label, value), 0);
  return assertPayrollMoney(label, total);
}

function assertPayrollEqual(label: string, actual: number, expected: number) {
  if (assertPayrollMoney(label, actual) !== assertPayrollMoney(label, expected)) {
    throw new Error(`Bảng lương không đồng nhất với Finance Engine ở ${label}. Vui lòng tải lại hoặc liên hệ quản trị hệ thống.`);
  }
}

function assertPayrollSummaryInvariants(summary: PayrollSummary) {
  if (!Array.isArray(summary.items) || !summary.costBreakdown) {
    throw new Error("Bảng lương không có dữ liệu đối soát Finance Engine bắt buộc.");
  }
  const rowBaseSalary = sumPayrollMoney("lương nhân viên", summary.items.map((item) => item.baseSalary));
  const rowTikTok = sumPayrollMoney("phụ cấp TikTok", summary.items.map((item) => item.tiktokAllowance));
  const rowSupport = sumPayrollMoney("phụ cấp hỗ trợ", summary.items.map((item) => item.supportAllowance));
  const rowManualAllowance = sumPayrollMoney("phụ cấp khác", summary.items.map((item) => item.manualAllowance));
  const rowManualBonus = sumPayrollMoney("thưởng khác", summary.items.map((item) => item.manualBonus));
  const rowEmployeeKpi = sumPayrollMoney("KPI nhân viên", summary.items.map((item) => item.kpiBonus));
  const rowTotalPay = sumPayrollMoney("tổng nhận nhân viên", summary.items.map((item) => item.totalPay));

  for (const item of summary.items) {
    assertPayrollEqual(
      `tổng nhận của ${item.employeeCode}`,
      item.totalPay,
      sumPayrollMoney(`tổng nhận của ${item.employeeCode}`, [
        item.baseSalary,
        item.tiktokAllowance,
        item.supportAllowance,
        item.manualAllowance,
        item.manualBonus,
        item.kpiBonus,
      ]),
    );
  }

  assertPayrollEqual("tổng lương nhân viên", summary.totalBaseSalary, rowBaseSalary);
  assertPayrollEqual("lương nhân viên/Finance Engine", summary.totalBaseSalary, summary.costBreakdown.employeeBaseSalary);
  assertPayrollEqual("tổng phụ cấp TikTok", summary.totalTikTokAllowance, rowTikTok);
  assertPayrollEqual("phụ cấp TikTok/Finance Engine", summary.totalTikTokAllowance, summary.costBreakdown.tiktokAllowance);
  assertPayrollEqual("tổng phụ cấp hỗ trợ", summary.totalSupportAllowance, rowSupport);
  assertPayrollEqual("phụ cấp hỗ trợ/Finance Engine", summary.totalSupportAllowance, summary.costBreakdown.supportAllowance);
  assertPayrollEqual("tổng phụ cấp khác", summary.totalManualAllowance, rowManualAllowance);
  assertPayrollEqual("phụ cấp khác/Finance Engine", summary.totalManualAllowance, summary.costBreakdown.manualAllowance);
  assertPayrollEqual("tổng thưởng khác", summary.totalManualBonus, rowManualBonus);
  assertPayrollEqual("thưởng khác/Finance Engine", summary.totalManualBonus, summary.costBreakdown.manualBonus);
  assertPayrollEqual("tổng KPI nhân viên", summary.totalKpiBonus, rowEmployeeKpi);
  assertPayrollEqual("KPI nhân viên/Finance Engine", summary.totalKpiBonus, summary.costBreakdown.employeeKpiBonus);
  assertPayrollEqual("tổng nhận nhân viên", summary.totalPay, rowTotalPay);
  assertPayrollEqual("lương quản lý/Finance Engine", summary.managerSalary, summary.costBreakdown.managerSalary);
  assertPayrollEqual("KPI quản lý/Finance Engine", summary.managerBonus, summary.costBreakdown.managerBonus);
  assertPayrollEqual("tổng nhận quản lý", summary.managerTotal, sumPayrollMoney("tổng nhận quản lý", [summary.managerSalary, summary.managerBonus]));

  const policySalary = summary.payrollPolicy?.managerMonthlySalaryVnd;
  if (policySalary === undefined) {
    throw new Error("Bảng lương không có snapshot chính sách lương quản lý của kỳ.");
  }
  assertPayrollEqual("lương quản lý/chính sách kỳ", summary.managerSalary, policySalary);
}

export default function StorePayrollClosing({ store, initialPeriod }: { store: Store; initialPeriod?: string }) {
  const [period, setPeriod] = useState(initialPeriod ?? currentPeriod());
  const [data, setData] = useState<PayrollResponse>({});
  const [loadedScope, setLoadedScope] = useState<{ storeId: string; period: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const loadRequest = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const readOnly = store.status === "INACTIVE";

  const load = useCallback(async () => {
    const requestedScope = { storeId: store.id, period };
    const requestId = ++loadRequest.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError("");
    setData({});
    setLoadedScope(null);
    try {
      const response = await fetch(`/api/payroll?storeId=${encodeURIComponent(requestedScope.storeId)}&period=${encodeURIComponent(requestedScope.period)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json() as PayrollResponse;
      if (!response.ok) throw new Error(payload.message || "Không thể tải dữ liệu lương thưởng.");
      if (
        payload.period !== requestedScope.period
        || !payload.summary
        || payload.summary.period !== requestedScope.period
        || payload.summary.storeId !== requestedScope.storeId
        || (payload.closing && (payload.closing.period !== requestedScope.period || payload.closing.storeId !== requestedScope.storeId))
        || (payload.financialPeriod && (payload.financialPeriod.period !== requestedScope.period || payload.financialPeriod.storeId !== requestedScope.storeId))
      ) {
        throw new Error("Dữ liệu lương thưởng phản hồi không đúng cửa hàng hoặc kỳ đã chọn.");
      }
      assertPayrollSummaryInvariants(payload.summary);
      if (requestId !== loadRequest.current || controller.signal.aborted) return;
      setData(payload);
      setLoadedScope(requestedScope);
    } catch (cause) {
      if (requestId !== loadRequest.current || controller.signal.aborted) return;
      setData({});
      setLoadedScope(null);
      setError(cause instanceof Error ? cause.message : "Không thể tải dữ liệu lương thưởng.");
    } finally {
      if (loadController.current === controller) loadController.current = null;
      if (requestId === loadRequest.current && !controller.signal.aborted) setLoading(false);
    }
  }, [period, store.id]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);
  useEffect(() => { setMessage(""); }, [period, store.id]);
  useEffect(() => {
    const handlePayrollUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ storeId?: string; period?: string; source?: string }>).detail;
      if (detail?.source === "management" && detail.storeId === store.id && detail.period === period) {
        void load();
      }
    };
    window.addEventListener(PAYROLL_UPDATED_EVENT, handlePayrollUpdate);
    return () => window.removeEventListener(PAYROLL_UPDATED_EVENT, handlePayrollUpdate);
  }, [load, period, store.id]);

  const runAction = async (action: PayrollAction, employee?: PayrollItem) => {
    const actionScope = loadedScope;
    if (loading || !actionScope || actionScope.period !== period || actionScope.storeId !== store.id) {
      setError("Dữ liệu kỳ lương đang tải hoặc chưa khớp kỳ đã chọn. Vui lòng tải lại trước khi thao tác.");
      return;
    }
    if (action === "CONFIRM_PAYMENT" && !window.confirm(
      "Xác nhận đã chi sẽ ghi nhận việc chi trả lương, thưởng và phụ cấp của kỳ vào dòng tiền. Bạn có chắc chắn số tiền đã được chi?",
    )) return;
    if (action === "CLOSE_PERIOD" && !window.confirm(
      "Khóa kỳ sẽ giữ bất biến toàn bộ số liệu, cấu hình và bảng lương đã xác nhận. Mọi điều chỉnh sau đó phải tạo bút toán điều chỉnh. Bạn có chắc chắn?",
    )) return;
    if (action === "FINALIZE_SINGLE_EMPLOYEE" && employee && !window.confirm(
      `Chốt bảng lương cá nhân cho ${employee.employeeName}? Bản chốt này được giữ để đối soát kỳ ${actionScope.period}.`,
    )) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: actionScope.storeId,
          period: actionScope.period,
          action,
          employeeId: employee?.employeeId,
          expectedRevision: data.financialPeriod?.revision ?? 0,
          reason: payrollActionReason(action, employee),
        }),
      });
      const payload = await response.json() as PayrollResponse;
      if (!response.ok) throw new Error(payload.message || "Không thể thực hiện thao tác.");
      setMessage(payload.message || "Đã cập nhật kỳ lương thưởng.");
      await load();
      window.dispatchEvent(new CustomEvent(PAYROLL_UPDATED_EVENT, {
        detail: { storeId: actionScope.storeId, period: actionScope.period, source: "closing" },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể thực hiện thao tác.");
    } finally {
      setSaving(false);
    }
  };

  const summary = data.summary;
  const closing = data.closing;
  const previous = data.previousSummary;
  const dataIsCurrent = Boolean(
    loadedScope
    && loadedScope.period === period
    && loadedScope.storeId === store.id
    && summary !== undefined
    && summary.period === period
    && summary.storeId === store.id,
  );
  const grandTotal = closing?.grandTotal ?? ((summary?.totalAvailablePay ?? summary?.totalPay ?? 0) + (summary?.managerTotal ?? 0));
  // Before the manager closing exists, show the same net settlement split the
  // API will persist. Pending advances are included here because they already
  // reserve payroll and the workflow cannot continue until they are paid or
  // corrected. Once no draft remains, this is exactly the API's PAID split.
  const previewSettlement = salaryAdvanceSettlementSplit({
    employeeBaseSalary: summary?.totalBaseSalary ?? 0,
    employeeTotalPay: summary?.totalPay ?? 0,
    managerSalary: summary?.managerSalary ?? 0,
    managerBonus: summary?.managerBonus ?? 0,
    advanceAmount: summary?.totalSalaryAdvanceReserved ?? 0,
  });
  const employeeKpiHours = summary?.kpiEligibleHours ?? summary?.totalHours ?? 0;
  const totalKpiHours = summary?.totalKpiHours ?? employeeKpiHours;
  const profitPerKpiHour = summary?.profitPerKpiHour ?? summary?.profitPerHour ?? 0;
  const managerKpiRatePercent = summary?.payrollPolicy?.managerKpiRatePercent ?? 0;
  const employeeClosingById = useMemo(
    () => new Map((data.employeeClosings ?? []).map((item) => [item.employeeId, item])),
    [data.employeeClosings],
  );
  const allEmployeesIndividuallyLocked = summary?.items.every((item) => employeeClosingById.has(item.employeeId)) ?? false;
  const inactiveEmployeesWaiting = summary?.items.filter((item) => item.employmentStatus === "INACTIVE" && !employeeClosingById.has(item.employeeId)) ?? [];
  const closingWindowOpen = canClosePayrollPeriod(period);
  const closingWindowDate = payrollPeriodClosingDate(period);
  const pendingAdvanceAmount = summary?.totalSalaryAdvancePending ?? 0;
  const legacyClosingRank = closing ? {
    MANAGER_FINALIZED: 1,
    SALARY_CONFIRMED: 2,
    REWARDS_CONFIRMED: 3,
    PAYMENT_CONFIRMED: 4,
    LOCKED: 5,
  }[closing.status] : 0;
  const canonicalStatus = data.financialPeriod?.status;
  const canonicalRank = canonicalStatus ? financialPeriodRank[canonicalStatus] : null;
  const workflowRank = canonicalRank ?? (
    legacyClosingRank >= 3
      ? legacyClosingRank
      : legacyClosingRank >= 1
        ? 2
        : summary?.status === "LOCKED"
          ? 1
          : 0
  );
  const periodIsLocked = canonicalStatus ? canonicalStatus === "LOCKED" : Boolean(data.locked || closing?.status === "LOCKED");
  const individualCheckpointOpen = canonicalRank === null || canonicalRank < financialPeriodRank.CONFIRMED;
  const canLockIndividual = closingWindowOpen && individualCheckpointOpen;
  const workflowActions = useMemo<PayrollWorkflowAction[]>(() => {
    const waitingEmployees = Math.max(0, (summary?.items.length ?? 0) - employeeClosingById.size);
    const openingReason = `Mở từ ngày cuối tháng ${localDateLabel(closingWindowDate)} hoặc các ngày sau đó.`;
    const firstCompleted = workflowRank >= financialPeriodRank.CALCULATED;
    const firstAvailable = Boolean(summary && workflowRank === financialPeriodRank.DRAFT && closingWindowOpen && allEmployeesIndividuallyLocked && pendingAdvanceAmount === 0);
    const firstReason = firstCompleted
      ? "Đã tính bảng lương từ dữ liệu nguồn của kỳ."
      : !closingWindowOpen
        ? openingReason
        : pendingAdvanceAmount > 0
          ? `Còn ${money(pendingAdvanceAmount)} ứng lương đang chờ xác nhận chi.`
          : !allEmployeesIndividuallyLocked
            ? `Cần chốt bảng lương cá nhân cho ${waitingEmployees} nhân viên còn lại trước.`
            : "Đủ điều kiện tính bảng lương kỳ.";
    const reconciliationStarted = workflowRank >= financialPeriodRank.RECONCILING;
    const salaryChecklistCompleted = workflowRank >= financialPeriodRank.CONFIRMED || legacyClosingRank >= 2;
    const periodConfirmed = workflowRank >= financialPeriodRank.CONFIRMED;
    const periodPaid = workflowRank >= financialPeriodRank.PAID;
    const periodLocked = workflowRank >= financialPeriodRank.LOCKED;
    return [
      { action: "FINALIZE_EMPLOYEE", label: "Tính bảng lương kỳ", completed: firstCompleted, available: firstAvailable, reason: firstReason },
      { action: "FINALIZE_MANAGER", label: "Bắt đầu đối soát", completed: reconciliationStarted, available: workflowRank === financialPeriodRank.CALCULATED, reason: reconciliationStarted ? "Kỳ đã chuyển sang đối soát." : firstCompleted ? "Đủ điều kiện bắt đầu đối soát." : "Tính bảng lương kỳ trước." },
      { action: "CONFIRM_SALARY", label: "Xác nhận đối soát lương", completed: salaryChecklistCompleted, available: workflowRank === financialPeriodRank.RECONCILING && legacyClosingRank === 1, reason: salaryChecklistCompleted ? "Đã đối soát phần lương cơ bản." : workflowRank === financialPeriodRank.RECONCILING ? "Đủ điều kiện xác nhận đối soát lương." : "Bắt đầu đối soát trước." },
      { action: "CONFIRM_REWARDS", label: "Xác nhận số liệu toàn kỳ", completed: periodConfirmed, available: workflowRank === financialPeriodRank.RECONCILING && salaryChecklistCompleted, reason: periodConfirmed ? "Số liệu và cấu hình áp dụng cho kỳ đã được xác nhận." : salaryChecklistCompleted ? "Đủ điều kiện xác nhận toàn bộ số liệu kỳ." : "Xác nhận đối soát lương trước." },
      { action: "CONFIRM_PAYMENT", label: "Xác nhận đã chi", completed: periodPaid, available: workflowRank === financialPeriodRank.CONFIRMED, reason: periodPaid ? "Đã xác nhận chi trả lương, thưởng và phụ cấp." : periodConfirmed ? "Đủ điều kiện xác nhận đã chi." : "Xác nhận số liệu toàn kỳ trước." },
      { action: "CLOSE_PERIOD", label: "Khóa kỳ", completed: periodLocked, available: workflowRank === financialPeriodRank.PAID, reason: periodLocked ? "Kỳ đã khóa và dùng snapshot bất biến." : periodPaid ? "Đủ điều kiện khóa kỳ." : "Xác nhận đã chi trước khi khóa kỳ." },
    ];
  }, [allEmployeesIndividuallyLocked, closingWindowDate, closingWindowOpen, employeeClosingById.size, legacyClosingRank, pendingAdvanceAmount, summary, workflowRank]);

  const exportReport = () => {
    if (!summary || !dataIsCurrent) return;
    const rows: Array<Array<string | number>> = [
      ["BÁO CÁO LƯƠNG THƯỞNG", store.name, period],
      ["Mã NV", "Nhân viên", "Lương cứng/giờ", "Giờ làm thực tế", "Giờ tính KPI", "Lương thực nhận", "Phụ cấp TikTok", "Phụ cấp hỗ trợ", "Phụ cấp khác", "Thưởng khác", "Thưởng KPI", "Tổng nhận", "Đã ứng", "Còn phải trả"],
      ...summary.items.map((item) => [item.employeeCode, item.employeeName, item.hourlyRate, item.hours.toFixed(2), Number(item.kpiHours ?? item.hours).toFixed(2), item.baseSalary, item.tiktokAllowance, item.supportAllowance, item.manualAllowance, item.manualBonus, item.kpiBonus, item.totalPay, item.salaryAdvanceReserved ?? 0, item.availablePay ?? item.totalPay]),
      ["", "TỔNG NHÂN VIÊN", "", summary.totalHours.toFixed(2), employeeKpiHours.toFixed(2), summary.totalBaseSalary, summary.totalTikTokAllowance, summary.totalSupportAllowance, summary.totalManualAllowance, summary.totalManualBonus, summary.totalKpiBonus, summary.totalPay, summary.totalSalaryAdvanceReserved ?? 0, summary.totalAvailablePay ?? summary.totalPay],
      ["", `LƯƠNG QUẢN LÝ (CHÍNH SÁCH KỲ, PHIÊN ${summary.payrollPolicy?.version ?? "—"})`, "", summary.managerSalary],
      ["", `THƯỞNG KPI QUẢN LÝ (${managerKpiRatePercent.toFixed(2)}% LỢI NHUẬN HOẠT ĐỘNG DƯƠNG)`, "", summary.managerBonus],
      ["", "TỔNG CHI LƯƠNG", "", grandTotal],
      ["", "TRẠNG THÁI", "", canonicalStatus ? financialPeriodStatusLabel(canonicalStatus) : statusLabel(closing?.status)],
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `luong-thuong-${store.name.toLocaleLowerCase("vi-VN").replaceAll(" ", "-")}-${period}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <div className="reference-module payroll-page">
    <div className="ref-toolbar">
      <div><h2>TỔNG KẾT LƯƠNG THƯỞNG</h2><p>Chốt lương nhân viên, quản lý và khóa kỳ của {store.name}</p></div>
      <div className="ref-toolbar-actions">
        <DatePickerControl className="payroll-period-picker" ariaLabel="Kỳ lương" hint="Kỳ lương" type="month" value={period} onChange={setPeriod} disabled={saving}/>
        <button onClick={() => void load()} disabled={loading || saving}><RefreshCw size={16}/> Làm mới</button>
        <button onClick={exportReport} disabled={!dataIsCurrent}><Download size={16}/> Xuất báo cáo</button>
      </div>
    </div>

    {error && <div className="form-message">{error}</div>}
    {message && <div className="success-banner">{message}</div>}
    {loading && <div className="report-profit-note"><RefreshCw size={17}/> Đang tải dữ liệu kỳ lương…</div>}

    {summary && <>
      <div className="ref-metrics four">
        <article className="ref-metric"><i><WalletCards size={25}/></i><div><span>Còn trả nhân viên</span><strong>{money(summary.totalAvailablePay ?? summary.totalPay)}</strong><small>Đã ứng {money(summary.totalSalaryAdvanceReserved ?? 0)} · {employeeClosingById.size}/{summary.items.length} nhân viên đã chốt</small></div></article>
        <article className="ref-metric"><i><WalletCards size={25}/></i><div><span>Lương quản lý</span><strong>{money(summary.managerSalary)}</strong><small>Theo chính sách kỳ · phiên {summary.payrollPolicy?.version ?? "—"}</small></div></article>
        <article className="ref-metric orange"><i><WalletCards size={25}/></i><div><span>Thưởng KPI quản lý</span><strong>{money(summary.managerBonus)}</strong><small>{managerKpiRatePercent.toFixed(2)}% lợi nhuận hoạt động dương</small></div></article>
        <article className="ref-metric blue"><i><WalletCards size={25}/></i><div><span>Tổng chi lương</span><strong>{money(grandTotal)}</strong><small>{canonicalStatus ? financialPeriodStatusLabel(canonicalStatus) : statusLabel(closing?.status)}</small></div></article>
      </div>
      <div className="report-profit-note"><WalletCards size={18}/><span><b>Tổng giờ xét KPI nhân viên:</b> {totalKpiHours.toFixed(2)} giờ làm thực tế. KPI quản lý áp dụng độc lập theo tỷ lệ {managerKpiRatePercent.toFixed(2)}% trên lợi nhuận hoạt động dương. Lợi nhuận trên giờ: {money(profitPerKpiHour)}/giờ.</span></div>

      <section className="manager-panel">
        <div className="panel-title"><div><h2>QUY TRÌNH CHỐT KỲ</h2><p>Thực hiện lần lượt để tính, đối soát, xác nhận, chi trả và khóa kỳ an toàn.</p></div><span className="status-pill">{canonicalStatus ? financialPeriodStatusLabel(canonicalStatus) : statusLabel(closing?.status)}</span></div>
        <div className="comparison-grid">
          <p><span>1. Tính bảng lương kỳ</span><b>{workflowRank >= financialPeriodRank.CALCULATED ? "Đã tính" : "Chờ tính"}</b><em>{money(summary.totalAvailablePay ?? summary.totalPay)}</em></p>
          <p><span>2. Đối soát toàn kỳ</span><b>{workflowRank >= financialPeriodRank.RECONCILING ? "Đã bắt đầu" : "Chờ đối soát"}</b><em>{money(summary.managerTotal)}</em></p>
          <p><span>3. Đối soát phần lương</span><b>{workflowRank >= financialPeriodRank.CONFIRMED || legacyClosingRank >= 2 ? "Đã xác nhận" : "Chờ xác nhận"}</b><em>{money(closing?.salaryTotal ?? previewSettlement.salaryTotal)}</em></p>
          <p><span>4. Xác nhận số liệu toàn kỳ</span><b>{workflowRank >= financialPeriodRank.CONFIRMED ? "Đã xác nhận" : "Chờ xác nhận"}</b><em>{money(closing?.rewardAllowanceTotal ?? previewSettlement.rewardAllowanceTotal)}</em></p>
          <p><span>5. Xác nhận đã chi</span><b>{workflowRank >= financialPeriodRank.PAID ? "Đã chi" : "Chờ chi"}</b><em>{money(grandTotal)}</em></p>
          <p><span>6. Khóa kỳ</span><b>{periodIsLocked ? "Đã khóa" : "Chưa khóa"}</b><em>{period}</em></p>
        </div>
        {readOnly && <div className="form-message">Cửa hàng đang ngưng hoạt động. Bạn chỉ có thể xem và xuất lịch sử kỳ lương.</div>}
        {inactiveEmployeesWaiting.length > 0 && <div className="employee-closing-warning"><LockKeyhole size={17}/><div><b>Cần chốt lương cho nhân viên ngưng làm việc</b><span>{inactiveEmployeesWaiting.map((item) => `${item.employeeCode} · ${item.employeeName}`).join(", ")}</span></div></div>}
        <div className="payroll-workflow-actions" role="list" aria-label="Các bước chốt và khóa kỳ lương thưởng">
          {workflowActions.map((item, index) => {
            const reasonId = `payroll-workflow-reason-${item.action.toLocaleLowerCase("en-US")}`;
            const disabled = readOnly || saving || loading || !dataIsCurrent || item.completed || !item.available;
            return <div className={`payroll-workflow-action ${item.completed ? "completed" : item.available ? "ready" : "waiting"}`} role="listitem" key={item.action}>
              <button
                type="button"
                className="payroll-workflow-button"
                disabled={disabled}
                aria-describedby={reasonId}
                aria-current={item.available && !item.completed ? "step" : undefined}
                onClick={() => void runAction(item.action)}
              >
                {item.action === "CLOSE_PERIOD" || item.completed ? <LockKeyhole size={16}/> : <CheckCircle2 size={16}/>}<span>{index + 1}. {saving && item.available ? "ĐANG XỬ LÝ…" : item.label}</span>
              </button>
              <small id={reasonId}>{item.reason}</small>
            </div>;
          })}
        </div>
        {!closingWindowOpen && <div className="report-profit-note payroll-closing-window-note"><LockKeyhole size={18}/> Quy trình kỳ {period} sẽ mở vào ngày cuối tháng {localDateLabel(closingWindowDate)} và vẫn mở từ ngày 1 tháng sau.</div>}
        {periodIsLocked && <div className="report-profit-note"><CheckCircle2 size={18}/> Kỳ {period} đã được xác nhận, chi trả và khóa bằng snapshot bất biến.</div>}
      </section>

      <section className="manager-panel table-panel">
        <div className="panel-title"><div><h2>CHI TIẾT LƯƠNG THƯỞNG NHÂN VIÊN</h2><p>Lương thực nhận = lương cứng theo giờ × giờ làm thực tế. Chốt cá nhân tạo bản đối soát cho kỳ; nhân viên ngưng làm việc được ưu tiên chốt ngay khi không còn ca mở.</p></div><span>{employeeClosingById.size}/{summary.items.length} đã chốt</span></div>
        <div className={`data-table-wrap ${styles.desktopTableWrap}`} role="region" aria-label="Bảng chi tiết lương thưởng nhân viên, cuộn ngang để xem đầy đủ"><table className="data-table employee-closing-table"><caption className="sr-only">Chi tiết lương thưởng nhân viên kỳ {period}</caption><thead><tr><th>Mã NV</th><th>Nhân viên</th><th>Trạng thái làm việc</th><th>Lương cứng</th><th>Giờ làm thực tế</th><th>Giờ tính KPI</th><th>Lương thực nhận</th><th>Phụ cấp TikTok</th><th>Phụ cấp hỗ trợ</th><th>Phụ cấp khác</th><th>Thưởng khác</th><th>Thưởng KPI</th><th>Tổng nhận</th><th>Đã ứng</th><th>Còn trả</th><th>Chốt cá nhân</th></tr></thead><tbody>
          {summary.items.length === 0 ? <tr><td colSpan={16} className="empty-cell">Chưa có dữ liệu chấm công trong kỳ.</td></tr> : summary.items.map((item) => {
            const employeeClosing = employeeClosingById.get(item.employeeId);
            const isInactive = item.employmentStatus === "INACTIVE";
            const mayLockNow = individualCheckpointOpen && (canLockIndividual || isInactive);
            const itemKpiHours = Number(item.kpiHours ?? item.hours);
            return <tr key={item.employeeId} className={isInactive ? "inactive-employee-payroll" : ""}><td><b>{item.employeeCode}</b></td><td><b>{item.employeeName}</b><br/><small>{item.position}</small></td><td><div className="employee-kpi-status"><span className={`status-pill ${isInactive ? "inactive" : ""}`}>{isInactive ? "Ngưng làm việc" : "Đang làm việc"}</span>{isInactive ? <><small>{item.hours.toFixed(2)} giờ thực tế trong kỳ</small><span className={`status-pill ${itemKpiHours > 0 ? "" : "inactive"}`}>{itemKpiHours > 0 ? "Có phân bổ KPI" : "Không có giờ KPI"}</span></> : null}</div></td><td>{money(item.hourlyRate)}/giờ</td><td>{item.hours.toFixed(2)} giờ</td><td>{itemKpiHours.toFixed(2)} giờ</td><td><b>{money(item.baseSalary)}</b></td><td>{money(item.tiktokAllowance)}</td><td>{money(item.supportAllowance)}</td><td>{money(item.manualAllowance)}</td><td>{money(item.manualBonus)}</td><td className="money-green">{money(item.kpiBonus)}</td><td><b>{money(item.totalPay)}</b></td><td>{money(item.salaryAdvanceReserved ?? 0)}</td><td className="money-green"><b>{money(item.availablePay ?? item.totalPay)}</b></td><td>{employeeClosing ? <div className="employee-closing-state"><span className="status-pill"><LockKeyhole size={12}/> {employeeClosing.kpiDeferred && workflowRank < financialPeriodRank.CONFIRMED ? "Đã chốt lương" : "Đã xác nhận kỳ"}</span><small>{employeeClosing.kpiDeferred && workflowRank < financialPeriodRank.CONFIRMED ? "KPI chờ xác nhận kỳ · " : ""}{dateTime24(employeeClosing.lockedAt)}</small></div> : <button type="button" className="employee-lock-button" disabled={readOnly || saving || loading || !dataIsCurrent || !mayLockNow || pendingAdvanceAmount > 0} onClick={() => void runAction("FINALIZE_SINGLE_EMPLOYEE", item)}><LockKeyhole size={14}/> {pendingAdvanceAmount > 0 ? "Chờ xác nhận ứng" : !individualCheckpointOpen ? "Kỳ đã xác nhận" : isInactive ? "Chốt bắt buộc" : mayLockNow ? "Chốt lương" : "Chờ hết tháng"}</button>}</td></tr>;
          })}
        </tbody><tfoot><tr><td colSpan={4}>TỔNG CỘNG</td><td>{summary.totalHours.toFixed(2)} giờ</td><td>{employeeKpiHours.toFixed(2)} giờ</td><td>{money(summary.totalBaseSalary)}</td><td>{money(summary.totalTikTokAllowance)}</td><td>{money(summary.totalSupportAllowance)}</td><td>{money(summary.totalManualAllowance)}</td><td>{money(summary.totalManualBonus)}</td><td>{money(summary.totalKpiBonus)}</td><td>{money(summary.totalPay)}</td><td>{money(summary.totalSalaryAdvanceReserved ?? 0)}</td><td>{money(summary.totalAvailablePay ?? summary.totalPay)}</td><td>{employeeClosingById.size}/{summary.items.length}</td></tr></tfoot></table></div>

        <ol className={styles.mobilePayrollList} aria-label={`Chi tiết lương thưởng nhân viên kỳ ${period}`}>
          {summary.items.length === 0 ? <li className={styles.mobileListState}>Chưa có dữ liệu chấm công trong kỳ.</li> : summary.items.map((item) => {
            const employeeClosing = employeeClosingById.get(item.employeeId);
            const isInactive = item.employmentStatus === "INACTIVE";
            const mayLockNow = individualCheckpointOpen && (canLockIndividual || isInactive);
            const itemKpiHours = Number(item.kpiHours ?? item.hours);
            const actionLabel = pendingAdvanceAmount > 0
              ? "Chờ xác nhận ứng"
              : !individualCheckpointOpen
                ? "Kỳ đã xác nhận"
                : isInactive
                  ? "Chốt bắt buộc"
                  : mayLockNow
                    ? "Chốt lương"
                    : "Chờ hết tháng";

            return <li className={`${styles.mobilePayrollCard} ${isInactive ? styles.mobilePayrollCardInactive : ""}`} key={item.employeeId}>
              <header className={styles.mobilePayrollHeader}>
                <div><b>{item.employeeName}</b><span>{item.employeeCode} · {item.position}</span></div>
                <span className={`status-pill ${isInactive ? "inactive" : ""}`}>{isInactive ? "Ngưng làm việc" : "Đang làm việc"}</span>
              </header>

              <dl className={styles.mobilePayrollSummary}>
                <div><dt>Giờ thực tế</dt><dd>{item.hours.toFixed(2)} giờ</dd></div>
                <div><dt>Lương thực nhận</dt><dd>{money(item.baseSalary)}</dd></div>
                <div><dt>Tổng nhận</dt><dd>{money(item.totalPay)}</dd></div>
                <div className={styles.mobileAvailablePay}><dt>Còn trả</dt><dd>{money(item.availablePay ?? item.totalPay)}</dd></div>
              </dl>

              <details className={styles.mobilePayrollDetails}>
                <summary>Chi tiết lương, thưởng và phụ cấp</summary>
                <dl>
                  <div><dt>Lương cứng</dt><dd>{money(item.hourlyRate)}/giờ</dd></div>
                  <div><dt>Giờ tính KPI</dt><dd>{itemKpiHours.toFixed(2)} giờ</dd></div>
                  <div><dt>Phụ cấp TikTok</dt><dd>{money(item.tiktokAllowance)}</dd></div>
                  <div><dt>Phụ cấp hỗ trợ</dt><dd>{money(item.supportAllowance)}</dd></div>
                  <div><dt>Phụ cấp khác</dt><dd>{money(item.manualAllowance)}</dd></div>
                  <div><dt>Thưởng khác</dt><dd>{money(item.manualBonus)}</dd></div>
                  <div><dt>Thưởng KPI</dt><dd>{money(item.kpiBonus)}</dd></div>
                  <div><dt>Đã ứng</dt><dd>{money(item.salaryAdvanceReserved ?? 0)}</dd></div>
                </dl>
              </details>

              <footer className={styles.mobilePayrollAction}>
                {employeeClosing ? <div className={styles.mobileClosingState}>
                  <span className="status-pill"><LockKeyhole size={13}/> {employeeClosing.kpiDeferred && workflowRank < financialPeriodRank.CONFIRMED ? "Đã chốt lương" : "Đã xác nhận kỳ"}</span>
                  <small>{employeeClosing.kpiDeferred && workflowRank < financialPeriodRank.CONFIRMED ? "KPI chờ xác nhận kỳ · " : ""}{dateTime24(employeeClosing.lockedAt)}</small>
                </div> : <button
                  type="button"
                  disabled={readOnly || saving || loading || !dataIsCurrent || !mayLockNow || pendingAdvanceAmount > 0}
                  aria-label={`${actionLabel} cho ${item.employeeName}`}
                  onClick={() => void runAction("FINALIZE_SINGLE_EMPLOYEE", item)}
                >
                  <LockKeyhole size={16}/><span>{actionLabel}</span>
                </button>}
              </footer>
            </li>;
          })}
          {summary.items.length > 0 && <li className={styles.mobilePayrollTotals}>
            <b>Tổng cộng</b>
            <span>{summary.totalHours.toFixed(2)} giờ · Còn trả {money(summary.totalAvailablePay ?? summary.totalPay)}</span>
          </li>}
        </ol>
      </section>

      <div className="comparison-grid">
        <section className="manager-panel"><h2>SO SÁNH VỚI KỲ TRƯỚC</h2>
          {!previous ? <p>Chưa có kỳ lương trước đã khóa để so sánh.</p> : <>
            <p><span>Tổng lương nhân viên</span><b>{money(previous.totalPay)}</b><em>{delta(summary.totalPay, previous.totalPay)}</em></p>
            <p><span>Thưởng KPI nhân viên</span><b>{money(previous.totalKpiBonus)}</b><em>{delta(summary.totalKpiBonus, previous.totalKpiBonus)}</em></p>
            <p><span>Lợi nhuận cửa hàng</span><b>{money(previous.profit)}</b><em>{delta(summary.profit, previous.profit)}</em></p>
            <p><span>Tỷ lệ KPI</span><b>{percent(previous.kpiRate)}</b><em>{percent(summary.kpiRate)}</em></p>
          </>}
        </section>
        <section className="manager-panel"><h2>ĐỐI SOÁT KỲ HIỆN TẠI</h2>
          <p><span>Doanh thu</span><b>{money(summary.revenue)}</b><em>{period}</em></p>
          <p><span>Tổng chi phí</span><b>{money(summary.expense)}</b><em>{store.name}</em></p>
          <p><span>Lợi nhuận cơ sở sau toàn bộ chi phí và lương quản lý</span><b>{money(summary.profit)}</b><em>{money(profitPerKpiHour)}/giờ KPI</em></p>
          <p><span>Lợi nhuận sau cùng</span><b>{money(summary.netProfit ?? summary.profit)}</b><em>Đã trừ KPI nhân viên và thưởng quản lý</em></p>
          <p><span>Ngưỡng thưởng KPI</span><b>{percent(summary.kpiRate)}</b><em>Không cộng dồn</em></p>
        </section>
      </div>
    </>}

    <section className="manager-panel table-panel">
      <div className="panel-title"><h2>LỊCH SỬ KẾT SỔ LƯƠNG THƯỞNG</h2><span>{data.history?.length ?? 0} kỳ</span></div>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Kỳ</th><th>Cửa hàng</th><th>Chi lương</th><th>Thưởng & phụ cấp</th><th>Tổng chi</th><th>Trạng thái</th><th>Xác nhận lương</th><th>Xác nhận thưởng, phụ cấp</th><th>Đã chi lúc</th><th>Khóa lúc</th></tr></thead><tbody>
        {!data.history?.length ? <tr><td colSpan={10} className="empty-cell">Chưa có lịch sử kết sổ.</td></tr> : data.history.map((item) => <tr key={`${item.storeId}-${item.period}`}><td><b>{item.period}</b></td><td>{item.storeName}</td><td>{money(item.salaryTotal)}</td><td>{money(item.rewardAllowanceTotal)}</td><td className="money-green"><b>{money(item.grandTotal)}</b></td><td><span className="status-pill">{statusLabel(item.status)}</span></td><td>{dateTime24(item.salaryConfirmedAt)}</td><td>{dateTime24(item.rewardsConfirmedAt)}</td><td>{dateTime24(item.paymentConfirmedAt)}</td><td>{dateTime24(item.closedAt)}</td></tr>)}
      </tbody></table></div>
    </section>
  </div>;
}
