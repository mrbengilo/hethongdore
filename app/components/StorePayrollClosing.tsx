"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, LockKeyhole, RefreshCw, WalletCards } from "lucide-react";

type Store = { id: string; name: string; status?: string };

type PayrollItem = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  position: string;
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
  netProfit?: number;
  totalHours: number;
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

type PayrollResponse = {
  message?: string;
  locked?: boolean;
  summary?: PayrollSummary;
  closing?: PayrollClosing | null;
  previousSummary?: PayrollSummary | null;
  history?: PayrollClosing[];
};

type PayrollAction = "FINALIZE_EMPLOYEE" | "FINALIZE_MANAGER" | "CONFIRM_SALARY" | "CONFIRM_REWARDS" | "CONFIRM_PAYMENT" | "CLOSE_PERIOD";

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

export default function StorePayrollClosing({ store, initialPeriod }: { store: Store; initialPeriod?: string }) {
  const [period, setPeriod] = useState(initialPeriod ?? currentPeriod());
  const [data, setData] = useState<PayrollResponse>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const readOnly = store.status === "INACTIVE";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/payroll?storeId=${encodeURIComponent(store.id)}&period=${encodeURIComponent(period)}`, { cache: "no-store" });
      const payload = await response.json() as PayrollResponse;
      if (!response.ok) throw new Error(payload.message || "Không thể tải dữ liệu lương thưởng.");
      setData(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể tải dữ liệu lương thưởng.");
    } finally {
      setLoading(false);
    }
  }, [period, store.id]);

  useEffect(() => { void load(); }, [load]);

  const runAction = async (action: PayrollAction) => {
    if (action === "CLOSE_PERIOD" && !window.confirm("Kết sổ sẽ khóa kỳ lương này và không thể chỉnh sửa. Bạn có chắc chắn?")) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: store.id, period, action }),
      });
      const payload = await response.json() as PayrollResponse;
      if (!response.ok) throw new Error(payload.message || "Không thể thực hiện thao tác.");
      setMessage(payload.message || "Đã cập nhật kỳ lương thưởng.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể thực hiện thao tác.");
    } finally {
      setSaving(false);
    }
  };

  const summary = data.summary;
  const closing = data.closing;
  const previous = data.previousSummary;
  const grandTotal = closing?.grandTotal ?? ((summary?.totalPay ?? 0) + (summary?.managerTotal ?? 0));
  const nextAction = useMemo<{ action: PayrollAction; label: string } | null>(() => {
    if (!summary || summary.status !== "LOCKED") return { action: "FINALIZE_EMPLOYEE", label: "Chốt lương nhân viên" };
    if (!closing) return { action: "FINALIZE_MANAGER", label: "Chốt lương quản lý" };
    if (closing.status === "MANAGER_FINALIZED") return { action: "CONFIRM_SALARY", label: "Xác nhận chi lương" };
    if (closing.status === "SALARY_CONFIRMED") return { action: "CONFIRM_REWARDS", label: "Xác nhận thưởng và phụ cấp" };
    if (closing.status === "REWARDS_CONFIRMED") return { action: "CONFIRM_PAYMENT", label: "Xác nhận đã chi" };
    if (closing.status === "PAYMENT_CONFIRMED") return { action: "CLOSE_PERIOD", label: "Kết sổ và khóa kỳ" };
    return null;
  }, [closing, summary]);

  const exportReport = () => {
    if (!summary) return;
    const rows: Array<Array<string | number>> = [
      ["BÁO CÁO LƯƠNG THƯỞNG", store.name, period],
      ["Mã NV", "Nhân viên", "Lương cứng/giờ", "Giờ thực tế", "Lương thực nhận", "Phụ cấp TikTok", "Phụ cấp hỗ trợ", "Phụ cấp khác", "Thưởng khác", "Thưởng KPI", "Tổng nhận"],
      ...summary.items.map((item) => [item.employeeCode, item.employeeName, item.hourlyRate, item.hours.toFixed(2), item.baseSalary, item.tiktokAllowance, item.supportAllowance, item.manualAllowance, item.manualBonus, item.kpiBonus, item.totalPay]),
      ["", "TỔNG NHÂN VIÊN", "", summary.totalHours.toFixed(2), summary.totalBaseSalary, summary.totalTikTokAllowance, summary.totalSupportAllowance, summary.totalManualAllowance, summary.totalManualBonus, summary.totalKpiBonus, summary.totalPay],
      ["", "LƯƠNG QUẢN LÝ", "", summary.managerSalary],
      ["", "THƯỞNG QUẢN LÝ (2% lợi nhuận)", "", summary.managerBonus],
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
        <input aria-label="Kỳ lương" type="month" value={period} onChange={(event) => setPeriod(event.target.value)} disabled={saving}/>
        <button onClick={() => void load()} disabled={loading || saving}><RefreshCw size={16}/> Làm mới</button>
        <button onClick={exportReport} disabled={!summary}><Download size={16}/> Xuất báo cáo</button>
      </div>
    </div>

    {error && <div className="form-message">{error}</div>}
    {message && <div className="success-banner">{message}</div>}
    {loading && <div className="report-profit-note"><RefreshCw size={17}/> Đang tải dữ liệu kỳ lương…</div>}

    {summary && <>
      <div className="ref-metrics four">
        <article className="ref-metric"><i><WalletCards size={25}/></i><div><span>Tổng lương nhân viên</span><strong>{money(summary.totalPay)}</strong><small>{summary.items.length} nhân viên · {summary.totalHours.toFixed(2)} giờ</small></div></article>
        <article className="ref-metric"><i><WalletCards size={25}/></i><div><span>Lương quản lý</span><strong>{money(summary.managerSalary)}</strong><small>Cố định theo cửa hàng</small></div></article>
        <article className="ref-metric orange"><i><WalletCards size={25}/></i><div><span>Thưởng quản lý</span><strong>{money(summary.managerBonus)}</strong><small>2% lợi nhuận cửa hàng</small></div></article>
        <article className="ref-metric blue"><i><WalletCards size={25}/></i><div><span>Tổng chi lương</span><strong>{money(grandTotal)}</strong><small>{statusLabel(closing?.status)}</small></div></article>
      </div>

      <section className="manager-panel">
        <div className="panel-title"><div><h2>QUY TRÌNH KẾT SỔ</h2><p>Thực hiện lần lượt để đảm bảo số liệu được đối soát và khóa đúng kỳ.</p></div><span className="status-pill">{statusLabel(closing?.status)}</span></div>
        <div className="comparison-grid">
          <p><span>1. Lương và KPI nhân viên</span><b>{summary.status === "LOCKED" ? "Đã chốt" : "Chờ chốt"}</b><em>{money(summary.totalPay)}</em></p>
          <p><span>2. Lương và thưởng quản lý</span><b>{closing ? "Đã chốt" : "Chờ chốt"}</b><em>{money(summary.managerTotal)}</em></p>
          <p><span>3. Xác nhận chi lương</span><b>{["SALARY_CONFIRMED", "REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"].includes(closing?.status ?? "") ? "Đã xác nhận" : "Chờ xác nhận"}</b><em>{money(closing?.salaryTotal ?? ((summary.totalBaseSalary ?? 0) + summary.managerSalary))}</em></p>
          <p><span>4. Xác nhận thưởng, phụ cấp</span><b>{["REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"].includes(closing?.status ?? "") ? "Đã xác nhận" : "Chờ xác nhận"}</b><em>{money(closing?.rewardAllowanceTotal ?? (grandTotal - summary.totalBaseSalary - summary.managerSalary))}</em></p>
          <p><span>5. Ghi nhận đã chi</span><b>{closing?.status === "PAYMENT_CONFIRMED" || closing?.status === "LOCKED" ? "Đã chi" : "Chờ chi"}</b><em>{money(grandTotal)}</em></p>
          <p><span>6. Khóa kỳ</span><b>{closing?.status === "LOCKED" ? "Đã khóa" : "Chưa khóa"}</b><em>{period}</em></p>
        </div>
        {readOnly && <div className="form-message">Cửa hàng đang ngưng hoạt động. Bạn chỉ có thể xem và xuất lịch sử kỳ lương.</div>}
        {nextAction ? <button className="primary-button wide" disabled={readOnly || saving || loading} onClick={() => void runAction(nextAction.action)}>
          {nextAction.action === "CLOSE_PERIOD" ? <LockKeyhole size={17}/> : <CheckCircle2 size={17}/>} {saving ? "ĐANG XỬ LÝ…" : nextAction.label}
        </button> : <div className="report-profit-note"><CheckCircle2 size={18}/> Kỳ {period} đã được kết sổ và khóa an toàn.</div>}
      </section>

      <section className="manager-panel table-panel">
        <div className="panel-title"><div><h2>CHI TIẾT LƯƠNG THƯỞNG NHÂN VIÊN</h2><p>Lương thực nhận = lương cứng theo giờ × giờ làm thực tế; KPI áp dụng một ngưỡng, không cộng dồn.</p></div><span>{summary.items.length} nhân viên</span></div>
        <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Mã NV</th><th>Nhân viên</th><th>Lương cứng</th><th>Giờ thực tế</th><th>Lương thực nhận</th><th>Phụ cấp TikTok</th><th>Phụ cấp hỗ trợ</th><th>Phụ cấp khác</th><th>Thưởng khác</th><th>Thưởng KPI</th><th>Tổng nhận</th></tr></thead><tbody>
          {summary.items.length === 0 ? <tr><td colSpan={11} className="empty-cell">Chưa có dữ liệu chấm công trong kỳ.</td></tr> : summary.items.map((item) => <tr key={item.employeeId}><td><b>{item.employeeCode}</b></td><td><b>{item.employeeName}</b><br/><small>{item.position}</small></td><td>{money(item.hourlyRate)}/giờ</td><td>{item.hours.toFixed(2)} giờ</td><td><b>{money(item.baseSalary)}</b></td><td>{money(item.tiktokAllowance)}</td><td>{money(item.supportAllowance)}</td><td>{money(item.manualAllowance)}</td><td>{money(item.manualBonus)}</td><td className="money-green">{money(item.kpiBonus)}</td><td className="money-green"><b>{money(item.totalPay)}</b></td></tr>)}
        </tbody><tfoot><tr><td colSpan={3}>TỔNG CỘNG</td><td>{summary.totalHours.toFixed(2)} giờ</td><td>{money(summary.totalBaseSalary)}</td><td>{money(summary.totalTikTokAllowance)}</td><td>{money(summary.totalSupportAllowance)}</td><td>{money(summary.totalManualAllowance)}</td><td>{money(summary.totalManualBonus)}</td><td>{money(summary.totalKpiBonus)}</td><td>{money(summary.totalPay)}</td></tr></tfoot></table></div>
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
          <p><span>Lợi nhuận cơ sở sau toàn bộ chi phí và lương quản lý</span><b>{money(summary.profit)}</b><em>{money(summary.profitPerHour)}/giờ</em></p>
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
