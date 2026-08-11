"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, LockKeyhole, RefreshCw, WalletCards } from "lucide-react";
import { canClosePayrollPeriod, payrollPeriodClosingDate } from "../lib/finance";
import { PAYROLL_UPDATED_EVENT } from "../lib/payroll";
import { DatePickerControl } from "./DatePickerControl";

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
  managerFixedHours?: number;
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
  totalPay: number;
  items: PayrollItem[];
  status: "PREVIEW" | "LOCKED";
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

type PayrollResponse = {
  period?: string;
  message?: string;
  locked?: boolean;
  summary?: PayrollSummary;
  employeeClosings?: EmployeePayrollClosing[];
  individualLockedCount?: number;
  closing?: PayrollClosing | null;
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

function delta(current: number | undefined, previous: number | undefined) {
  const value = Number(current ?? 0) - Number(previous ?? 0);
  return `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
}

function localDateLabel(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
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
      ) {
        throw new Error("Dữ liệu lương thưởng phản hồi không đúng cửa hàng hoặc kỳ đã chọn.");
      }
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
    if (action === "CLOSE_PERIOD" && !window.confirm("Kết sổ sẽ khóa kỳ lương này và không thể chỉnh sửa. Bạn có chắc chắn?")) return;
    if (action === "FINALIZE_SINGLE_EMPLOYEE" && employee && !window.confirm(
      `Chốt lương và khóa sổ riêng cho ${employee.employeeName}? Sau khi khóa sẽ không thể sửa thưởng, phụ cấp của nhân viên này trong kỳ ${actionScope.period}.`,
    )) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: actionScope.storeId, period: actionScope.period, action, employeeId: employee?.employeeId }),
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
  const grandTotal = closing?.grandTotal ?? ((summary?.totalPay ?? 0) + (summary?.managerTotal ?? 0));
  const managerFixedHours = summary?.managerFixedHours ?? 140;
  const employeeKpiHours = summary?.kpiEligibleHours ?? summary?.totalHours ?? 0;
  const totalKpiHours = summary?.totalKpiHours ?? (employeeKpiHours + managerFixedHours);
  const profitPerKpiHour = summary?.profitPerKpiHour ?? summary?.profitPerHour ?? 0;
  const employeeClosingById = useMemo(
    () => new Map((data.employeeClosings ?? []).map((item) => [item.employeeId, item])),
    [data.employeeClosings],
  );
  const allEmployeesIndividuallyLocked = summary?.items.every((item) => employeeClosingById.has(item.employeeId)) ?? false;
  const inactiveEmployeesWaiting = summary?.items.filter((item) => item.employmentStatus === "INACTIVE" && !employeeClosingById.has(item.employeeId)) ?? [];
  const closingWindowOpen = canClosePayrollPeriod(period);
  const closingWindowDate = payrollPeriodClosingDate(period);
  const canLockIndividual = closingWindowOpen;
  const closingRank = closing ? {
    MANAGER_FINALIZED: 1,
    SALARY_CONFIRMED: 2,
    REWARDS_CONFIRMED: 3,
    PAYMENT_CONFIRMED: 4,
    LOCKED: 5,
  }[closing.status] : 0;
  const workflowActions = useMemo<PayrollWorkflowAction[]>(() => {
    const waitingEmployees = Math.max(0, (summary?.items.length ?? 0) - employeeClosingById.size);
    const openingReason = `Mở từ ngày cuối tháng ${localDateLabel(closingWindowDate)} hoặc các ngày sau đó.`;
    const firstCompleted = summary?.status === "LOCKED";
    const firstAvailable = Boolean(summary && !firstCompleted && closingWindowOpen && allEmployeesIndividuallyLocked);
    const firstReason = firstCompleted
      ? "Đã khóa bảng lương nhân viên."
      : !closingWindowOpen
        ? openingReason
        : !allEmployeesIndividuallyLocked
          ? `Cần chốt riêng ${waitingEmployees} nhân viên còn lại trước.`
          : "Đủ điều kiện khóa bảng lương cửa hàng.";
    const managerCompleted = Boolean(closing);
    const managerAvailable = Boolean(firstCompleted && !managerCompleted);
    return [
      { action: "FINALIZE_EMPLOYEE", label: "Khóa bảng lương cửa hàng", completed: firstCompleted, available: firstAvailable, reason: firstReason },
      { action: "FINALIZE_MANAGER", label: "Chốt lương quản lý", completed: managerCompleted, available: managerAvailable, reason: managerCompleted ? "Đã chốt lương quản lý." : firstCompleted ? "Đủ điều kiện chốt lương quản lý." : "Hoàn tất khóa bảng lương cửa hàng trước." },
      { action: "CONFIRM_SALARY", label: "Xác nhận chi lương", completed: closingRank >= 2, available: closingRank === 1, reason: closingRank >= 2 ? "Đã xác nhận chi lương." : closingRank === 1 ? "Đủ điều kiện xác nhận chi lương." : "Hoàn tất chốt lương quản lý trước." },
      { action: "CONFIRM_REWARDS", label: "Xác nhận thưởng và phụ cấp", completed: closingRank >= 3, available: closingRank === 2, reason: closingRank >= 3 ? "Đã xác nhận thưởng và phụ cấp." : closingRank === 2 ? "Đủ điều kiện xác nhận thưởng và phụ cấp." : "Xác nhận chi lương trước." },
      { action: "CONFIRM_PAYMENT", label: "Chốt sổ", completed: closingRank >= 4, available: closingRank === 3, reason: closingRank >= 4 ? "Đã xác nhận chi trả và chốt sổ." : closingRank === 3 ? "Đủ điều kiện xác nhận đã chi và chốt sổ." : "Xác nhận lương, thưởng và phụ cấp trước." },
      { action: "CLOSE_PERIOD", label: "Khóa kỳ chi lương thưởng", completed: closingRank >= 5, available: closingRank === 4, reason: closingRank >= 5 ? "Kỳ lương thưởng đã khóa." : closingRank === 4 ? "Đủ điều kiện khóa kỳ chi lương thưởng." : "Chốt sổ trước khi khóa kỳ." },
    ];
  }, [allEmployeesIndividuallyLocked, closing, closingRank, closingWindowDate, closingWindowOpen, employeeClosingById.size, summary]);

  const exportReport = () => {
    if (!summary || !dataIsCurrent) return;
    const rows: Array<Array<string | number>> = [
      ["BÁO CÁO LƯƠNG THƯỞNG", store.name, period],
      ["Mã NV", "Nhân viên", "Lương cứng/giờ", "Giờ làm thực tế", "Giờ tính KPI", "Lương thực nhận", "Phụ cấp TikTok", "Phụ cấp hỗ trợ", "Phụ cấp khác", "Thưởng khác", "Thưởng KPI", "Tổng nhận"],
      ...summary.items.map((item) => [item.employeeCode, item.employeeName, item.hourlyRate, item.hours.toFixed(2), Number(item.kpiHours ?? item.hours).toFixed(2), item.baseSalary, item.tiktokAllowance, item.supportAllowance, item.manualAllowance, item.manualBonus, item.kpiBonus, item.totalPay]),
      ["", "TỔNG NHÂN VIÊN", "", summary.totalHours.toFixed(2), employeeKpiHours.toFixed(2), summary.totalBaseSalary, summary.totalTikTokAllowance, summary.totalSupportAllowance, summary.totalManualAllowance, summary.totalManualBonus, summary.totalKpiBonus, summary.totalPay],
      ["", `LƯƠNG QUẢN LÝ (${managerFixedHours} giờ cố định)`, "", summary.managerSalary],
      ["", `THƯỞNG KPI QUẢN LÝ (${managerFixedHours}/${totalKpiHours.toFixed(2)} giờ × ${percent(summary.kpiRate)} quỹ KPI)`, "", summary.managerBonus],
      ["", "TỔNG CHI LƯƠNG", "", grandTotal],
      ["", "TRẠNG THÁI", "", statusLabel(closing?.status)],
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
        <article className="ref-metric"><i><WalletCards size={25}/></i><div><span>Tổng lương nhân viên</span><strong>{money(summary.totalPay)}</strong><small>{employeeClosingById.size}/{summary.items.length} nhân viên đã khóa sổ · {summary.totalHours.toFixed(2)} giờ</small></div></article>
        <article className="ref-metric"><i><WalletCards size={25}/></i><div><span>Lương quản lý</span><strong>{money(summary.managerSalary)}</strong><small>{managerFixedHours} giờ cố định/cửa hàng</small></div></article>
        <article className="ref-metric orange"><i><WalletCards size={25}/></i><div><span>Thưởng KPI quản lý</span><strong>{money(summary.managerBonus)}</strong><small>{managerFixedHours}/{totalKpiHours.toFixed(2)} giờ × {percent(summary.kpiRate)} lợi nhuận</small></div></article>
        <article className="ref-metric blue"><i><WalletCards size={25}/></i><div><span>Tổng chi lương</span><strong>{money(grandTotal)}</strong><small>{statusLabel(closing?.status)}</small></div></article>
      </div>
      <div className="report-profit-note"><WalletCards size={18}/><span><b>Tổng giờ xét KPI:</b> {employeeKpiHours.toFixed(2)} giờ nhân viên chính đủ điều kiện + {managerFixedHours} giờ quản lý = {totalKpiHours.toFixed(2)} giờ. Ca hỗ trợ không tham gia mẫu số. Lợi nhuận trên giờ: {money(profitPerKpiHour)}/giờ.</span></div>

      <section className="manager-panel">
        <div className="panel-title"><div><h2>QUY TRÌNH KẾT SỔ</h2><p>Thực hiện lần lượt để đảm bảo số liệu được đối soát và khóa đúng kỳ.</p></div><span className="status-pill">{statusLabel(closing?.status)}</span></div>
        <div className="comparison-grid">
          <p><span>1. Chốt riêng từng nhân viên</span><b>{allEmployeesIndividuallyLocked ? "Đã chốt đủ" : `${employeeClosingById.size}/${summary.items.length} đã khóa`}</b><em>{money(summary.totalPay)}</em></p>
          <p><span>2. Lương và thưởng quản lý</span><b>{closing ? "Đã chốt" : "Chờ chốt"}</b><em>{money(summary.managerTotal)}</em></p>
          <p><span>3. Xác nhận chi lương</span><b>{["SALARY_CONFIRMED", "REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"].includes(closing?.status ?? "") ? "Đã xác nhận" : "Chờ xác nhận"}</b><em>{money(closing?.salaryTotal ?? ((summary.totalBaseSalary ?? 0) + summary.managerSalary))}</em></p>
          <p><span>4. Xác nhận thưởng, phụ cấp</span><b>{["REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"].includes(closing?.status ?? "") ? "Đã xác nhận" : "Chờ xác nhận"}</b><em>{money(closing?.rewardAllowanceTotal ?? (grandTotal - summary.totalBaseSalary - summary.managerSalary))}</em></p>
          <p><span>5. Ghi nhận đã chi</span><b>{closing?.status === "PAYMENT_CONFIRMED" || closing?.status === "LOCKED" ? "Đã chi" : "Chờ chi"}</b><em>{money(grandTotal)}</em></p>
          <p><span>6. Khóa kỳ</span><b>{closing?.status === "LOCKED" ? "Đã khóa" : "Chưa khóa"}</b><em>{period}</em></p>
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
        {closing?.status === "LOCKED" && <div className="report-profit-note"><CheckCircle2 size={18}/> Kỳ {period} đã được chốt sổ và khóa an toàn.</div>}
      </section>

      <section className="manager-panel table-panel">
        <div className="panel-title"><div><h2>CHI TIẾT LƯƠNG THƯỞNG NHÂN VIÊN</h2><p>Lương thực nhận = lương cứng theo giờ × giờ làm thực tế. Chốt riêng tạo bản ghi khóa bất biến; nhân viên ngưng làm việc được ưu tiên chốt ngay khi không còn ca mở.</p></div><span>{employeeClosingById.size}/{summary.items.length} đã khóa</span></div>
        <div className="data-table-wrap"><table className="data-table employee-closing-table"><thead><tr><th>Mã NV</th><th>Nhân viên</th><th>Trạng thái làm việc</th><th>Lương cứng</th><th>Giờ làm thực tế</th><th>Giờ tính KPI</th><th>Lương thực nhận</th><th>Phụ cấp TikTok</th><th>Phụ cấp hỗ trợ</th><th>Phụ cấp khác</th><th>Thưởng khác</th><th>Thưởng KPI</th><th>Tổng nhận</th><th>Khóa sổ riêng</th></tr></thead><tbody>
          {summary.items.length === 0 ? <tr><td colSpan={14} className="empty-cell">Chưa có dữ liệu chấm công trong kỳ.</td></tr> : summary.items.map((item) => {
            const employeeClosing = employeeClosingById.get(item.employeeId);
            const isInactive = item.employmentStatus === "INACTIVE";
            const mayLockNow = canLockIndividual || isInactive;
            const hasKpiPolicySnapshot = typeof item.completedShiftCount === "number" && typeof item.kpiEligible === "boolean";
            const completedShiftCount = Math.max(0, Math.round(item.kpiCompletedShiftCount ?? item.completedShiftCount ?? 0));
            const kpiEligible = item.kpiEligible === true;
            return <tr key={item.employeeId} className={isInactive ? "inactive-employee-payroll" : ""}><td><b>{item.employeeCode}</b></td><td><b>{item.employeeName}</b><br/><small>{item.position}</small></td><td><div className="employee-kpi-status"><span className={`status-pill ${isInactive ? "inactive" : ""}`}>{isInactive ? "Ngưng làm việc" : "Đang làm việc"}</span>{isInactive ? hasKpiPolicySnapshot ? <><small>{completedShiftCount} ca chính thực tế</small><span className={`status-pill ${kpiEligible ? "" : "inactive"}`}>{kpiEligible ? "Đủ điều kiện KPI" : "Không đủ điều kiện KPI"}</span></> : <><small>Dữ liệu kỳ đã khóa trước cập nhật</small><span className="status-pill">Điều kiện KPI chưa lưu</span></> : null}</div></td><td>{money(item.hourlyRate)}/giờ</td><td>{item.hours.toFixed(2)} giờ</td><td>{Number(item.kpiHours ?? item.hours).toFixed(2)} giờ</td><td><b>{money(item.baseSalary)}</b></td><td>{money(item.tiktokAllowance)}</td><td>{money(item.supportAllowance)}</td><td>{money(item.manualAllowance)}</td><td>{money(item.manualBonus)}</td><td className="money-green">{money(item.kpiBonus)}</td><td className="money-green"><b>{money(item.totalPay)}</b></td><td>{employeeClosing ? <div className="employee-closing-state"><span className="status-pill"><LockKeyhole size={12}/> {employeeClosing.kpiDeferred && summary.status !== "LOCKED" ? "Đã khóa lương" : "Đã khóa sổ"}</span><small>{employeeClosing.kpiDeferred && summary.status !== "LOCKED" ? "KPI chờ chốt kỳ · " : ""}{dateTime24(employeeClosing.lockedAt)}</small></div> : <button type="button" className="employee-lock-button" disabled={readOnly || saving || loading || !dataIsCurrent || !mayLockNow} onClick={() => void runAction("FINALIZE_SINGLE_EMPLOYEE", item)}><LockKeyhole size={14}/> {isInactive ? "Chốt bắt buộc" : mayLockNow ? "Chốt lương" : "Chờ hết tháng"}</button>}</td></tr>;
          })}
        </tbody><tfoot><tr><td colSpan={4}>TỔNG CỘNG</td><td>{summary.totalHours.toFixed(2)} giờ</td><td>{employeeKpiHours.toFixed(2)} giờ</td><td>{money(summary.totalBaseSalary)}</td><td>{money(summary.totalTikTokAllowance)}</td><td>{money(summary.totalSupportAllowance)}</td><td>{money(summary.totalManualAllowance)}</td><td>{money(summary.totalManualBonus)}</td><td>{money(summary.totalKpiBonus)}</td><td>{money(summary.totalPay)}</td><td>{employeeClosingById.size}/{summary.items.length}</td></tr></tfoot></table></div>
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
