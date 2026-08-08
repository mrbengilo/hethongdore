"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  BarChart3,
  CheckCircle2,
  Download,
  LockKeyhole,
  RefreshCw,
  TrendingUp,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

type ExpenseBreakdown = {
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

type FinancialSnapshot = {
  id?: string;
  name?: string;
  address?: string;
  status?: string;
  period?: string;
  revenue: number;
  expense: number;
  profit: number;
  profitBeforePerformanceRewards?: number;
  expenseBreakdown?: ExpenseBreakdown;
};

type Evaluation = {
  margin: number;
  revenueChange: number | null;
  expenseChange: number | null;
  profitChange: number | null;
  rating: string;
  direction: string;
};

type StoreFinancialRow = {
  current: FinancialSnapshot;
  previous: FinancialSnapshot | null;
  evaluation: Evaluation;
};

type Comparison = {
  revenueChange: number | null;
  expenseChange: number | null;
  profitChange: number | null;
};

type DividendHistoryItem = {
  period: string;
  revenue: number;
  expense: number;
  profit: number;
  firstShare: number;
  secondShare: number;
  status: string;
  closedAt: string;
  closedBy: string;
};

type FinancialReportResponse = {
  period: string;
  previousPeriod: string;
  stores: StoreFinancialRow[];
  totals: FinancialSnapshot;
  previousTotals: FinancialSnapshot;
  comparison: Comparison;
  dividendHistory: DividendHistoryItem[];
  message?: string;
};

type StoreRef = {
  id: string;
  name: string;
};

const EXPENSE_FIELDS: Array<{ key: keyof ExpenseBreakdown; label: string }> = [
  { key: "fixedCosts", label: "Chi phí cố định" },
  { key: "incidentalCosts", label: "Chi phí phát sinh" },
  { key: "inventoryGoods", label: "Chi phí hàng nhập" },
  { key: "inventoryShipping", label: "Phí vận chuyển nhập hàng" },
  { key: "employeeBaseSalary", label: "Lương cứng nhân viên" },
  { key: "tiktokAllowance", label: "Phụ cấp TikTok" },
  { key: "supportAllowance", label: "Phụ cấp hỗ trợ" },
  { key: "manualAllowance", label: "Phụ cấp phát sinh" },
  { key: "manualBonus", label: "Thưởng nhân viên phát sinh" },
  { key: "managerSalary", label: "Lương quản lý" },
  { key: "employeeKpiBonus", label: "Thưởng KPI nhân viên" },
  { key: "managerBonus", label: "Thưởng quản lý" },
];

const moneyFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

const dateTimeFormatter = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value: unknown) {
  const number = finiteNumber(value);
  return number === null ? "—" : `${moneyFormatter.format(Math.round(number))} đồng`;
}

function percent(value: unknown) {
  const number = finiteNumber(value);
  return number === null ? "—" : `${number.toFixed(2)}%`;
}

function currentPeriod() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "";
}

function periodLabel(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return "—";
  return `Tháng ${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

function dateTime(value: string | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dateTimeFormatter.format(parsed) : "—";
}

function changeFromValues(current: unknown, previous: unknown) {
  const currentNumber = finiteNumber(current);
  const previousNumber = finiteNumber(previous);
  if (currentNumber === null || previousNumber === null || previousNumber === 0) return null;
  return ((currentNumber - previousNumber) / Math.abs(previousNumber)) * 100;
}

function changeText(value: unknown) {
  const number = finiteNumber(value);
  if (number === null) return "Chưa có dữ liệu kỳ trước";
  if (Math.abs(number) < 0.005) return "→ 0.00% so với kỳ trước";
  return `${number > 0 ? "↑" : "↓"} ${Math.abs(number).toFixed(2)}% so với kỳ trước`;
}

function directionText(value: string | undefined) {
  const normalized = value?.trim().toLocaleUpperCase("vi-VN") ?? "";
  if (["UP", "INCREASE", "GROWTH", "POSITIVE", "TĂNG", "TANG"].includes(normalized)) return "↑ Tăng trưởng";
  if (["DOWN", "DECREASE", "DECLINE", "NEGATIVE", "GIẢM", "GIAM"].includes(normalized)) return "↓ Suy giảm";
  if (["STABLE", "FLAT", "NEUTRAL", "ỔN ĐỊNH", "ON DINH"].includes(normalized)) return "→ Ổn định";
  return value?.trim() || "Chưa đánh giá";
}

function completeTotals(data: FinancialReportResponse, side: "current" | "previous") {
  const provided = side === "current" ? data.totals : data.previousTotals;
  const snapshots = data.stores.flatMap((store) => {
    const snapshot = side === "current" ? store.current : store.previous;
    return snapshot ? [snapshot] : [];
  });
  const expenseBreakdown = Object.fromEntries(EXPENSE_FIELDS.map(({ key }) => [
    key,
    finiteNumber(provided.expenseBreakdown?.[key])
      ?? snapshots.reduce((sum, snapshot) => sum + (finiteNumber(snapshot.expenseBreakdown?.[key]) ?? 0), 0),
  ])) as ExpenseBreakdown;
  const profitBeforePerformanceRewards = finiteNumber(provided.profitBeforePerformanceRewards)
    ?? snapshots.reduce((sum, snapshot) => sum + (finiteNumber(snapshot.profitBeforePerformanceRewards) ?? 0), 0);
  return { ...provided, expenseBreakdown, profitBeforePerformanceRewards };
}

function overallEvaluation(data: FinancialReportResponse, totals: FinancialSnapshot): Evaluation {
  const margin = totals.revenue ? totals.profit / totals.revenue * 100 : 0;
  const { revenueChange, expenseChange, profitChange } = data.comparison;
  const score = (margin >= 15 ? 2 : margin >= 5 ? 1 : 0)
    + ((revenueChange ?? 0) > 0 ? 1 : 0)
    + ((profitChange ?? 0) > 0 ? 1 : 0)
    + ((expenseChange ?? 0) <= (revenueChange ?? 0) ? 1 : 0);
  const rating = score >= 4 ? "TỐT" : score >= 2 ? "CẦN THEO DÕI" : "CẦN CẢI THIỆN";
  const direction = (profitChange ?? 0) > 0 && (revenueChange ?? 0) > 0
    ? "TĂNG TRƯỞNG"
    : (profitChange ?? 0) < 0 ? "SUY GIẢM" : "ỔN ĐỊNH";
  return { margin, revenueChange, expenseChange, profitChange, rating, direction };
}

function safeCsvCell(value: unknown) {
  const raw = String(value ?? "");
  const protectedValue = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = `\uFEFF${rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function useFinancialReport(period: string, storeId?: string) {
  const [data, setData] = useState<FinancialReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!period) return;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ period });
    if (storeId) query.set("storeId", storeId);
    try {
      const response = await fetch(`/api/reports?${query.toString()}`, { cache: "no-store", signal });
      const payload = await response.json().catch(() => ({})) as Partial<FinancialReportResponse> & { message?: string };
      if (!response.ok) throw new Error(payload.message || "Không thể tải báo cáo tài chính.");
      setData(payload as FinancialReportResponse);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setData(null);
      setError(cause instanceof Error ? cause.message : "Không thể tải báo cáo tài chính.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [period, storeId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return { data, loading, error, reload: () => load() };
}

function Metric({ icon: Icon, label, value, note, tone = "green" }: {
  icon: LucideIcon;
  label: string;
  value: string;
  note?: string;
  tone?: string;
}) {
  return <article className={`manager-metric ${tone}`}><i><Icon size={24}/></i><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

function ReportToolbar({ title, description, period, setPeriod, onRefresh, onExport, loading, exportDisabled = false }: {
  title: string;
  description: string;
  period: string;
  setPeriod: (period: string) => void;
  onRefresh: () => void;
  onExport: () => void;
  loading: boolean;
  exportDisabled?: boolean;
}) {
  return <div className="ref-toolbar"><div><h2>{title}</h2><p>{description}</p></div><div className="ref-toolbar-actions">
    <input aria-label="Kỳ báo cáo" type="month" value={period} onChange={(event) => setPeriod(event.target.value)}/>
    <button onClick={onRefresh} disabled={loading}><RefreshCw size={16}/> {loading ? "Đang tải…" : "Làm mới"}</button>
    <button onClick={onExport} disabled={exportDisabled}><Download size={16}/> Xuất CSV</button>
  </div></div>;
}

function SummaryMetrics({ current, previous, evaluation }: {
  current: FinancialSnapshot;
  previous?: FinancialSnapshot | null;
  evaluation: Evaluation;
}) {
  return <div className="manager-metrics four">
    <Metric icon={TrendingUp} label="DOANH THU" value={money(current.revenue)} note={changeText(evaluation.revenueChange ?? changeFromValues(current.revenue, previous?.revenue))}/>
    <Metric icon={WalletCards} label="TỔNG CHI PHÍ" value={money(current.expense)} note={changeText(evaluation.expenseChange ?? changeFromValues(current.expense, previous?.expense))} tone="orange"/>
    <Metric icon={BadgeDollarSign} label="LỢI NHUẬN" value={money(current.profit)} note={changeText(evaluation.profitChange ?? changeFromValues(current.profit, previous?.profit))} tone="blue"/>
    <Metric icon={BarChart3} label="BIÊN LỢI NHUẬN" value={percent(evaluation.margin)} note={`${evaluation.rating || "Chưa đánh giá"} · ${directionText(evaluation.direction)}`} tone="purple"/>
  </div>;
}

function ExpenseBreakdownTable({ current, previous }: {
  current: FinancialSnapshot;
  previous?: FinancialSnapshot | null;
}) {
  return <section className="manager-panel table-panel"><div className="panel-title"><div><h2>CƠ CẤU CHI PHÍ ĐẦY ĐỦ</h2><p>Đối chiếu từng nhóm chi phí với kỳ trước</p></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Nhóm chi phí</th><th>Kỳ hiện tại</th><th>Kỳ trước</th><th>Chênh lệch</th><th>Biến động</th></tr></thead><tbody>
    {EXPENSE_FIELDS.map(({ key, label }) => {
      const currentValue = current.expenseBreakdown?.[key];
      const previousValue = previous?.expenseBreakdown?.[key];
      const currentNumber = finiteNumber(currentValue);
      const previousNumber = finiteNumber(previousValue);
      const difference = currentNumber !== null && previousNumber !== null ? currentNumber - previousNumber : null;
      return <tr key={key}><td><b>{label}</b></td><td>{money(currentValue)}</td><td>{money(previousValue)}</td><td className={difference !== null && difference > 0 ? "money-orange" : "money-green"}>{difference === null ? "—" : money(difference)}</td><td>{changeText(changeFromValues(currentValue, previousValue))}</td></tr>;
    })}
  </tbody><tfoot><tr><td>TỔNG CHI PHÍ</td><td>{money(current.expense)}</td><td>{money(previous?.expense)}</td><td>{previous ? money(current.expense - previous.expense) : "—"}</td><td>{changeText(changeFromValues(current.expense, previous?.expense))}</td></tr></tfoot></table></div></section>;
}

function EvaluationPanels({ period, previousPeriod, current, previous, evaluation }: {
  period: string;
  previousPeriod: string;
  current: FinancialSnapshot;
  previous?: FinancialSnapshot | null;
  evaluation: Evaluation;
}) {
  return <div className="comparison-grid"><section className="manager-panel"><h2>SO SÁNH KỲ TRƯỚC</h2>
    <p><span>Doanh thu · {periodLabel(previousPeriod)}</span><b>{money(previous?.revenue)}</b><em>{changeText(evaluation.revenueChange)}</em></p>
    <p><span>Chi phí · {periodLabel(previousPeriod)}</span><b>{money(previous?.expense)}</b><em>{changeText(evaluation.expenseChange)}</em></p>
    <p><span>Lợi nhuận · {periodLabel(previousPeriod)}</span><b>{money(previous?.profit)}</b><em>{changeText(evaluation.profitChange)}</em></p>
  </section><section className="manager-panel"><h2>ĐÁNH GIÁ HIỆU QUẢ · {periodLabel(period)}</h2>
    <p><span>Xếp loại</span><b>{evaluation.rating || "Chưa đánh giá"}</b><em>{percent(evaluation.margin)}</em></p>
    <p><span>Chiều hướng</span><b>{directionText(evaluation.direction)}</b><em>{changeText(evaluation.profitChange)}</em></p>
    <p><span>Lợi nhuận trước thưởng hiệu quả</span><b>{money(current.profitBeforePerformanceRewards)}</b><em>Lợi nhuận cuối: {money(current.profit)}</em></p>
  </section></div>;
}

function reportCsvRows(data: FinancialReportResponse, selectedStores = data.stores) {
  const header = [
    "Cửa hàng", "Kỳ", "Doanh thu", ...EXPENSE_FIELDS.map((field) => field.label),
    "Tổng chi phí", "Lợi nhuận trước thưởng hiệu quả", "Lợi nhuận", "Biên lợi nhuận", "Xếp loại", "Chiều hướng",
  ];
  const rows = selectedStores.flatMap((store) => {
    const current = [store.current.name ?? store.current.id ?? "", data.period, store.current.revenue, ...EXPENSE_FIELDS.map(({ key }) => store.current.expenseBreakdown?.[key]), store.current.expense, store.current.profitBeforePerformanceRewards, store.current.profit, store.evaluation.margin, store.evaluation.rating, store.evaluation.direction];
    const previousSnapshot = store.previous;
    const previous = previousSnapshot
      ? [[store.current.name ?? store.current.id ?? "", data.previousPeriod, previousSnapshot.revenue, ...EXPENSE_FIELDS.map(({ key }) => previousSnapshot.expenseBreakdown?.[key]), previousSnapshot.expense, previousSnapshot.profitBeforePerformanceRewards, previousSnapshot.profit, "", "", ""]]
      : [];
    return [current, ...previous];
  });
  return [header, ...rows];
}

export function ManagerFinancialReports({ initialPeriod }: { initialPeriod?: string } = {}) {
  const [period, setPeriod] = useState(initialPeriod ?? currentPeriod());
  const { data, loading, error, reload } = useFinancialReport(period);
  const totals = useMemo(() => data ? completeTotals(data, "current") : null, [data]);
  const previousTotals = useMemo(() => data ? completeTotals(data, "previous") : null, [data]);
  const evaluation = useMemo(() => data && totals ? overallEvaluation(data, totals) : null, [data, totals]);

  const exportReport = () => {
    if (!data) return;
    downloadCsv(`bao-cao-tai-chinh-${data.period}.csv`, reportCsvRows(data));
  };

  return <div className="page-content manager-reference">
    <ReportToolbar title="BÁO CÁO TÀI CHÍNH TOÀN HỆ THỐNG" description="Số liệu thực theo kỳ, so sánh kỳ trước và đánh giá hiệu quả từng cửa hàng" period={period} setPeriod={setPeriod} onRefresh={reload} onExport={exportReport} loading={loading} exportDisabled={!data}/>
    {error && <div className="form-message">{error}</div>}
    {loading && !data && <div className="report-profit-note"><RefreshCw size={17}/> Đang tổng hợp số liệu thực của kỳ…</div>}
    {data && totals && previousTotals && evaluation && <>
      <SummaryMetrics current={totals} previous={previousTotals} evaluation={evaluation}/>
      <EvaluationPanels period={data.period} previousPeriod={data.previousPeriod} current={totals} previous={previousTotals} evaluation={evaluation}/>
      <ExpenseBreakdownTable current={totals} previous={previousTotals}/>
      <section className="manager-panel table-panel"><div className="panel-title"><div><h2>HIỆU QUẢ THEO TỪNG CỬA HÀNG</h2><p>{periodLabel(data.period)} so với {periodLabel(data.previousPeriod)}</p></div><span>{data.stores.length} cửa hàng</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Cửa hàng</th><th>Doanh thu</th><th>Tổng chi phí</th><th>Lợi nhuận trước thưởng</th><th>Lợi nhuận cuối</th><th>Biên lợi nhuận</th><th>So kỳ trước</th><th>Đánh giá</th><th>Chiều hướng</th></tr></thead><tbody>
        {data.stores.length === 0 ? <tr><td colSpan={9} className="empty-cell">Không có dữ liệu cửa hàng trong kỳ đã chọn.</td></tr> : data.stores.map((store) => <tr key={store.current.id ?? store.current.name}><td><b>{store.current.name ?? store.current.id ?? "—"}</b></td><td>{money(store.current.revenue)}</td><td>{money(store.current.expense)}</td><td>{money(store.current.profitBeforePerformanceRewards)}</td><td className="money-green"><b>{money(store.current.profit)}</b></td><td>{percent(store.evaluation.margin)}</td><td>{changeText(store.evaluation.profitChange)}</td><td><span className="status-pill">{store.evaluation.rating || "Chưa đánh giá"}</span></td><td>{directionText(store.evaluation.direction)}</td></tr>)}
      </tbody></table></div></section>
    </>}
  </div>;
}

export function StoreFinancialReport({ store, initialPeriod }: { store: StoreRef; initialPeriod?: string }) {
  const [period, setPeriod] = useState(initialPeriod ?? currentPeriod());
  const { data, loading, error, reload } = useFinancialReport(period, store.id);
  const report = data?.stores.find((item) => item.current.id === store.id) ?? data?.stores[0];

  const exportReport = () => {
    if (!data || !report) return;
    downloadCsv(`bao-cao-tai-chinh-${store.id}-${data.period}.csv`, reportCsvRows(data, [report]));
  };

  return <div className="reference-module manager-reference">
    <ReportToolbar title={`BÁO CÁO TÀI CHÍNH · ${store.name}`} description="Doanh thu từ ca làm và toàn bộ chi phí thực tế của cửa hàng" period={period} setPeriod={setPeriod} onRefresh={reload} onExport={exportReport} loading={loading} exportDisabled={!report}/>
    {error && <div className="form-message">{error}</div>}
    {loading && !report && <div className="report-profit-note"><RefreshCw size={17}/> Đang tổng hợp số liệu cửa hàng…</div>}
    {!loading && data && !report && <div className="empty-cell">Không có dữ liệu của {store.name} trong kỳ {period}.</div>}
    {data && report && <>
      <SummaryMetrics current={report.current} previous={report.previous} evaluation={report.evaluation}/>
      <EvaluationPanels period={data.period} previousPeriod={data.previousPeriod} current={report.current} previous={report.previous} evaluation={report.evaluation}/>
      <ExpenseBreakdownTable current={report.current} previous={report.previous}/>
    </>}
  </div>;
}

export function ManagerDividendClosing({ initialPeriod }: { initialPeriod?: string } = {}) {
  const [period, setPeriod] = useState(initialPeriod ?? currentPeriod());
  const { data, loading, error, reload } = useFinancialReport(period);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const totals = useMemo(() => data ? completeTotals(data, "current") : null, [data]);
  const comparisonEvaluation = useMemo(() => data && totals ? overallEvaluation(data, totals) : null, [data, totals]);

  const currentHistory = useMemo(() => data?.dividendHistory.find((item) => item.period === period), [data?.dividendHistory, period]);
  const currentRevenue = currentHistory?.revenue ?? data?.totals.revenue;
  const currentExpense = currentHistory?.expense ?? data?.totals.expense;
  const distributableProfit = Math.max(0, finiteNumber(currentHistory?.profit ?? data?.totals.profit) ?? 0);
  const previewFirstShare = Math.round(distributableProfit * 0.6);
  const previewSecondShare = distributableProfit - previewFirstShare;
  const firstShare = currentHistory ? currentHistory.firstShare : previewFirstShare;
  const secondShare = currentHistory ? currentHistory.secondShare : previewSecondShare;

  const closeDividend = async () => {
    if (!data || currentHistory) return;
    if (!window.confirm(`Xác nhận chia ${money(distributableProfit)} cổ tức và khóa kỳ ${period}?`)) return;
    setSaving(true);
    setActionError("");
    setMessage("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "CLOSE_DIVIDEND", period }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message || "Không thể xác nhận chia cổ tức.");
      setMessage(payload.message || "Đã xác nhận chia cổ tức và khóa kỳ.");
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Không thể xác nhận chia cổ tức.");
    } finally {
      setSaving(false);
    }
  };

  const exportHistory = () => {
    if (!data) return;
    downloadCsv(`lich-su-chia-co-tuc-${period}.csv`, [
      ["Kỳ", "Doanh thu", "Tổng chi phí", "Lợi nhuận", "Cổ đông thứ nhất", "Cổ đông thứ hai", "Trạng thái", "Khóa lúc", "Người khóa"],
      ...data.dividendHistory.map((item) => [item.period, item.revenue, item.expense, item.profit, item.firstShare, item.secondShare, item.status, dateTime(item.closedAt), item.closedBy]),
    ]);
  };

  const previousProfit = Math.max(0, finiteNumber(data?.previousTotals.profit) ?? 0);
  const previousFirstShare = Math.round(previousProfit * 0.6);
  const previousSecondShare = previousProfit - previousFirstShare;

  return <div className="page-content manager-reference dividend-reference">
    <ReportToolbar title="CHỐT SỔ CHIA CỔ TỨC" description="Xác nhận, khóa kỳ và lưu lịch sử chia từ lợi nhuận thực tế" period={period} setPeriod={setPeriod} onRefresh={reload} onExport={exportHistory} loading={loading || saving} exportDisabled={!data}/>
    {(error || actionError) && <div className="form-message">{actionError || error}</div>}
    {message && <div className="success-banner">{message}</div>}
    {loading && !data && <div className="report-profit-note"><RefreshCw size={17}/> Đang tải số liệu cổ tức…</div>}
    {data && <>
      <div className="manager-metrics four">
        <Metric icon={TrendingUp} label="DOANH THU KỲ" value={money(currentRevenue)} note={changeText(data.comparison.revenueChange)}/>
        <Metric icon={WalletCards} label="TỔNG CHI PHÍ" value={money(currentExpense)} note={changeText(data.comparison.expenseChange)} tone="orange"/>
        <Metric icon={BadgeDollarSign} label="LỢI NHUẬN CHIA CỔ TỨC" value={money(distributableProfit)} note={changeText(data.comparison.profitChange)} tone="blue"/>
        <Metric icon={currentHistory ? CheckCircle2 : LockKeyhole} label="TRẠNG THÁI KỲ" value={currentHistory ? "Đã khóa" : "Chờ xác nhận"} note={currentHistory ? dateTime(currentHistory.closedAt) : periodLabel(period)} tone="purple"/>
      </div>
      <div className="comparison-grid"><section className="manager-panel"><h2>PHÂN CHIA KỲ HIỆN TẠI</h2>
        <p><span>Cổ đông thứ nhất (60%)</span><b>{money(firstShare)}</b><em>{currentHistory ? "Đã ghi lịch sử" : "Bản xem trước"}</em></p>
        <p><span>Cổ đông thứ hai (40%)</span><b>{money(secondShare)}</b><em>{currentHistory ? "Đã ghi lịch sử" : "Bản xem trước"}</em></p>
        <p><span>Tổng chia</span><b>{money(firstShare + secondShare)}</b><em>{periodLabel(period)}</em></p>
        <button className="primary-button wide" disabled={saving || loading || Boolean(currentHistory)} onClick={() => void closeDividend()}><LockKeyhole size={17}/> {saving ? "ĐANG KHÓA KỲ…" : currentHistory ? "KỲ CỔ TỨC ĐÃ KHÓA" : "XÁC NHẬN CHIA VÀ KHÓA KỲ"}</button>
      </section><section className="manager-panel"><h2>SO SÁNH KỲ TRƯỚC</h2>
        <p><span>Tổng cổ tức · {periodLabel(data.previousPeriod)}</span><b>{money(previousProfit)}</b><em>{changeText(data.comparison.profitChange)}</em></p>
        <p><span>Cổ đông thứ nhất</span><b>{money(previousFirstShare)}</b><em>Hiện tại: {money(firstShare)}</em></p>
        <p><span>Cổ đông thứ hai</span><b>{money(previousSecondShare)}</b><em>Hiện tại: {money(secondShare)}</em></p>
        <p><span>Đánh giá</span><b>{comparisonEvaluation?.rating || "Chưa đánh giá"}</b><em>{directionText(comparisonEvaluation?.direction)}</em></p>
      </section></div>
      <section className="manager-panel table-panel"><div className="panel-title"><div><h2>LỊCH SỬ CHIA CỔ TỨC</h2><p>Chỉ hiển thị các kỳ được ghi nhận từ hệ thống</p></div><span>{data.dividendHistory.length} kỳ</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Kỳ</th><th>Doanh thu</th><th>Tổng chi phí</th><th>Lợi nhuận</th><th>Cổ đông thứ nhất</th><th>Cổ đông thứ hai</th><th>Trạng thái</th><th>Ngày giờ khóa</th><th>Người khóa</th></tr></thead><tbody>
        {data.dividendHistory.length === 0 ? <tr><td colSpan={9} className="empty-cell">Chưa có lịch sử chia cổ tức.</td></tr> : data.dividendHistory.map((item) => <tr key={item.period}><td><b>{periodLabel(item.period)}</b></td><td>{money(item.revenue)}</td><td>{money(item.expense)}</td><td className="money-green"><b>{money(item.profit)}</b></td><td>{money(item.firstShare)}</td><td>{money(item.secondShare)}</td><td><span className="status-pill">{item.status}</span></td><td>{dateTime(item.closedAt)}</td><td>{item.closedBy || "—"}</td></tr>)}
      </tbody></table></div></section>
    </>}
  </div>;
}
