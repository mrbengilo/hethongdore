"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  CircleDollarSign,
  FileSpreadsheet,
  FileText,
  Minus,
  RefreshCw,
  Store,
  TrendingDown,
  TrendingUp,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

type Granularity = "day" | "month";
type RangeValue = { from: string; to: string };
type FinanceStatusValue = "PROVISIONAL" | "LOCKED" | "ACTUAL_CASH";
type RecognitionPolicy = string | Record<string, string | boolean>;

type FinancialSnapshot = {
  id?: string;
  name?: string;
  revenue: number;
  expense: number;
  profit: number;
};

type FinanceEvaluation = {
  margin: number | null;
  revenueChange: number;
  expenseChange: number;
  profitChange: number;
  rating: string;
  direction: string;
};

type StoreReportRow = {
  current: FinancialSnapshot;
  previous: FinancialSnapshot | null;
  evaluation: FinanceEvaluation;
};

type ReportTimelineRow = {
  key: string;
  revenue: number;
  expense: number;
  profit: number;
};

type ReportResponse = {
  period: string;
  previousPeriod: string;
  range?: { from?: string; to?: string; startPeriod?: string; endPeriod?: string };
  previousRange?: { from: string; to: string };
  granularity?: Granularity;
  financeStatus?: FinanceStatusValue;
  recognitionPolicy?: RecognitionPolicy;
  scope?: "ALL" | "STORE";
  storeId?: string | null;
  request?: { scope: "ALL" | "STORE"; storeId: string | null; from: string; to: string; granularity: Granularity };
  storeOptions?: Array<{ id: string; name: string }>;
  timeline?: ReportTimelineRow[];
  stores: StoreReportRow[];
  totals: FinancialSnapshot;
  previousTotals: FinancialSnapshot;
  comparison: Partial<FinanceEvaluation> & Pick<FinanceEvaluation, "revenueChange" | "expenseChange" | "profitChange">;
};

type CashTotals = { inflow: number; outflow: number; net: number };

type CashTimelineRow = {
  key: string;
  inflow: number;
  outflow: number;
  net: number;
  transactionCount: number;
  sources: string[];
  notes: string[];
};

type CashflowResponse = {
  period: string;
  granularity: Granularity;
  range: { from?: string; to?: string; startPeriod?: string; endPeriod?: string };
  previousRange?: { from: string; to: string };
  financeStatus?: FinanceStatusValue;
  recognitionPolicy?: RecognitionPolicy;
  scope?: "ALL" | "STORE";
  storeId?: string | null;
  request?: { scope: "ALL" | "STORE"; storeId: string | null; from: string; to: string; granularity: Granularity };
  stores: Array<{ id: string; name: string }>;
  totals: CashTotals;
  previousTotals: CashTotals;
  timeline: CashTimelineRow[];
  byStore: Array<CashTotals & { storeId: string; storeName: string }>;
};

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compactFormatter = new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 });
const storeColors = ["#07883b", "#10a56a", "#ff7a18", "#1888ee", "#6557d9", "#d4a017"];

function localIsoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function shiftMonth(value: string, months: number) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 0));
  return `${value}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function initialDayRange(): RangeValue {
  const to = localIsoDate();
  return { from: shiftDate(to, -6), to };
}

function initialMonthRange(): RangeValue {
  const to = localIsoDate().slice(0, 7);
  return { from: shiftMonth(to, -5), to };
}

function useFinanceRange() {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [dayRange, setDayRange] = useState<RangeValue>(initialDayRange);
  const [monthRange, setMonthRange] = useState<RangeValue>(initialMonthRange);
  const range = granularity === "day" ? dayRange : monthRange;
  const setRange = granularity === "day" ? setDayRange : setMonthRange;

  const maximum = granularity === "day" ? localIsoDate() : localIsoDate().slice(0, 7);
  const updateFrom = (from: string) => {
    const safeFrom = from > maximum ? maximum : from;
    setRange((current) => ({ from: safeFrom, to: safeFrom > current.to ? safeFrom : current.to }));
  };
  const updateTo = (to: string) => {
    const safeTo = to > maximum ? maximum : to;
    setRange((current) => ({ from: safeTo < current.from ? safeTo : current.from, to: safeTo }));
  };
  const queryRange = granularity === "day"
    ? range
    : { from: `${range.from}-01`, to: range.to === localIsoDate().slice(0, 7) ? localIsoDate() : lastDayOfMonth(range.to) };

  return { granularity, setGranularity, range, updateFrom, updateTo, queryRange };
}

function money(value: number) {
  return `${moneyFormatter.format(Math.round(value))} đ`;
}

function compactMoney(value: number) {
  return value === 0 ? "0" : compactFormatter.format(value).replace(" ", "");
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
  return (current - previous) / Math.abs(previous) * 100;
}

function changeLabel(value: number) {
  const direction = value > 0.005 ? "Tăng" : value < -0.005 ? "Giảm" : "Không đổi";
  return `${direction} ${Math.abs(value).toFixed(2)}%`;
}

function marginLabel(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : "Không xác định";
}

function periodLabel(period: string) {
  return /^\d{4}-\d{2}$/.test(period) ? `Tháng ${period.slice(5, 7)}/${period.slice(0, 4)}` : period;
}

function bucketLabel(key: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
  return periodLabel(key);
}

function shortBucketLabel(key: string, granularity: Granularity) {
  return granularity === "day" && /^\d{4}-\d{2}-\d{2}$/.test(key)
    ? `${key.slice(8, 10)}/${key.slice(5, 7)}`
    : /^\d{4}-\d{2}$/.test(key) ? `${key.slice(5, 7)}/${key.slice(2, 4)}` : key;
}

function rangeLabel(range: { from?: string; to?: string; startPeriod?: string; endPeriod?: string } | undefined) {
  if (!range) return "kỳ trước";
  const from = range.from ?? range.startPeriod ?? "";
  const to = range.to ?? range.endPeriod ?? "";
  if (!from || !to) return "kỳ trước";
  return from === to ? bucketLabel(from) : `${bucketLabel(from)} – ${bucketLabel(to)}`;
}

function escapeXml(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function downloadExcel(filename: string, rows: unknown[][]) {
  const sheetRows = rows.map((row) => `<Row>${row.map((value) => {
    const type = typeof value === "number" && Number.isFinite(value) ? "Number" : "String";
    return `<Cell><Data ss:Type="${type}">${escapeXml(value)}</Data></Cell>`;
  }).join("")}</Row>`).join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="DORE"><Table>${sheetRows}</Table></Worksheet></Workbook>`;
  const url = URL.createObjectURL(new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function sparklinePoints(values: number[], width = 188, height = 44) {
  if (!values.length) return "";
  const minimum = Math.min(...values, 0);
  const maximum = Math.max(...values, 1);
  const span = Math.max(1, maximum - minimum);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
    const y = height - 4 - (value - minimum) / span * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function MetricSparkline({ values }: { values: number[] }) {
  return <svg className="finance-sparkline" viewBox="0 0 188 44" preserveAspectRatio="none" aria-hidden="true">
    <polyline points={sparklinePoints(values)} fill="none" vectorEffect="non-scaling-stroke"/>
  </svg>;
}

function FinanceMetric({ icon: Icon, label, value, change, changeText, tone = "green", sparkline }: {
  icon: LucideIcon;
  label: string;
  value: string;
  change: number | null;
  changeText?: string;
  tone?: "green" | "orange" | "blue" | "teal";
  sparkline?: number[];
}) {
  const neutralChange = change === null || Math.abs(change) <= 0.005;
  const directionClass = neutralChange ? "neutral" : change < 0 ? "down" : "up";
  const ChangeIcon = neutralChange ? Minus : change < 0 ? TrendingDown : TrendingUp;
  return <article className={`finance-metric finance-${tone}${sparkline ? " has-sparkline" : ""}`}>
    <div className="finance-metric-main">
      <span className="finance-metric-icon" aria-hidden="true"><Icon size={25}/></span>
      <div><span>{label}</span><strong>{value}</strong><small className={directionClass}><ChangeIcon size={12}/>{changeText ?? (change === null ? "Không xác định" : changeLabel(change))} <em>so với kỳ trước</em></small></div>
    </div>
    {sparkline ? <MetricSparkline values={sparkline}/> : null}
  </article>;
}

function FinanceLoading({ text }: { text: string }) {
  return <div className="finance-loading" role="status"><RefreshCw size={18}/><span>{text}</span></div>;
}

function FinanceStatus({ status, policy }: { status?: FinanceStatusValue; policy?: RecognitionPolicy }) {
  const locked = status === "LOCKED";
  const actualCash = status === "ACTUAL_CASH";
  const policyItems = typeof policy === "string"
    ? [policy]
    : policy ? Object.entries(policy).flatMap(([key, value]) => key !== "timeZone" && typeof value === "string" ? [value] : []) : [];
  const fallback = actualCash
    ? "Chỉ hiển thị các khoản thu, chi đã thực sự được ghi nhận."
    : locked ? "Số liệu đã được xác nhận và khóa kỳ." : "Số liệu còn có thể thay đổi khi cửa hàng hoàn tất chốt kỳ.";
  return <aside className={`finance-status ${actualCash ? "actual" : locked ? "locked" : "provisional"}`} aria-label="Trạng thái số liệu tài chính">
    <span>{actualCash ? "Dòng tiền đã ghi nhận" : locked ? "Đã chốt kỳ" : "Tạm tính – kỳ chưa khóa"}</span>
    <p>{policyItems[0] || fallback}</p>
    {policyItems.length > 1 ? <details><summary>Nguyên tắc ghi nhận</summary><ul>{policyItems.map((item) => <li key={item}>{item}</li>)}</ul></details> : null}
  </aside>;
}

function RangeControls({ granularity, range, onFromChange, onToChange }: {
  granularity: Granularity;
  range: RangeValue;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}) {
  const type = granularity === "day" ? "date" : "month";
  const maximum = granularity === "day" ? localIsoDate() : localIsoDate().slice(0, 7);
  return <div className="finance-range" role="group" aria-label={granularity === "day" ? "Khoảng ngày báo cáo" : "Khoảng tháng báo cáo"}>
    <CalendarDays size={17} aria-hidden="true"/>
    <label><span>Từ</span><input type={type} value={range.from} max={range.to < maximum ? range.to : maximum} aria-label={granularity === "day" ? "Từ ngày" : "Từ tháng"} onChange={(event) => onFromChange(event.target.value)}/></label>
    <i aria-hidden="true">–</i>
    <label><span>Đến</span><input type={type} value={range.to} min={range.from} max={maximum} aria-label={granularity === "day" ? "Đến ngày" : "Đến tháng"} onChange={(event) => onToChange(event.target.value)}/></label>
  </div>;
}

function GranularityToggle({ value, onChange }: { value: Granularity; onChange: (value: Granularity) => void }) {
  return <div className="finance-segment" role="group" aria-label="Kiểu thống kê">
    <button type="button" className={value === "day" ? "active" : ""} aria-pressed={value === "day"} onClick={() => onChange("day")}><span aria-hidden="true"/>Theo ngày</button>
    <button type="button" className={value === "month" ? "active" : ""} aria-pressed={value === "month"} onClick={() => onChange("month")}><span aria-hidden="true"/>Theo tháng</button>
  </div>;
}

function ExportButtons({ onExcel, onPrint, disabled = false, compact = false }: {
  onExcel: () => void;
  onPrint: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return <div className={`finance-export-box${compact ? " compact" : ""}`}><span>{compact ? "Xuất dữ liệu" : "Xuất báo cáo"}</span><div>
    <button type="button" className="excel" onClick={onExcel} disabled={disabled}><FileSpreadsheet size={16}/>{compact ? "Excel" : "File Excel"}</button>
    <button type="button" className="pdf" title="Mở hộp thoại in hoặc lưu thành PDF" onClick={onPrint} disabled={disabled}><FileText size={16}/>{compact ? "PDF" : "File PDF"}</button>
  </div></div>;
}

function useManagerReport(granularity: Granularity, from: string, to: string, storeId: string) {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ period: to.slice(0, 7), from, to, granularity });
    if (storeId !== "ALL") query.set("storeId", storeId);
    setLoading(true);
    setError("");
    setData(null);
    fetch(`/api/reports?${query.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ReportResponse & { message?: string };
        if (!response.ok) throw new Error(payload.message || "Không thể tải báo cáo.");
        const requestedStore = storeId === "ALL" ? null : storeId;
        if (payload.request && (payload.request.from !== from || payload.request.to !== to || payload.request.granularity !== granularity || payload.request.storeId !== requestedStore)) {
          throw new Error("Phạm vi báo cáo phản hồi không khớp yêu cầu.");
        }
        setData(payload);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "Không thể tải báo cáo.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [from, granularity, storeId, to, version]);
  return { data, error, loading, reload };
}

function ReportBarChart({ points, granularity }: { points: ReportTimelineRow[]; granularity: Granularity }) {
  const positiveMaximum = Math.max(1, ...points.flatMap((point) => [point.revenue, point.expense, Math.max(0, point.profit)]));
  const negativeMinimum = Math.min(0, ...points.map((point) => point.profit));
  const chartSpan = positiveMaximum + Math.abs(negativeMinimum);
  const baseline = Math.abs(negativeMinimum) / chartSpan * 100;
  const labelStep = Math.max(1, Math.ceil(points.length / 12));
  const chartWidth = Math.max(600, points.length * 42);
  return <section className="finance-panel finance-chart-panel">
    <div className="finance-panel-heading"><div><h2>Biểu đồ doanh thu – chi phí – lợi nhuận</h2><p>Biểu đồ tổng theo {points.length} {granularity === "day" ? "ngày" : "tháng"}</p></div><ChartLegend/></div>
    <div className="finance-bars-scroll"><div className={`finance-bars${points.length > 20 ? " dense" : ""}`} style={{ minWidth: `${chartWidth}px` }} role="img" aria-label="Biểu đồ cột nhóm so sánh doanh thu, chi phí và lợi nhuận">
      {points.length === 0 ? <div className="finance-chart-empty">Chưa có dữ liệu biểu đồ trong kỳ.</div> : points.map((point, index) => <div className="finance-bar-group" key={point.key} aria-label={`${bucketLabel(point.key)}: doanh thu ${money(point.revenue)}, chi phí ${money(point.expense)}, lợi nhuận ${money(point.profit)}`}>
        <div className="finance-bar-stack" style={{ "--finance-baseline": `${baseline}%` } as CSSProperties} aria-hidden="true">
          <i className="revenue" style={{ height: `${point.revenue / chartSpan * 100}%` }}/>
          <i className="expense" style={{ height: `${point.expense / chartSpan * 100}%` }}/>
          <i className={point.profit < 0 ? "profit negative" : "profit"} style={{ height: `${Math.abs(point.profit) / chartSpan * 100}%` }}/>
        </div>{index % labelStep === 0 || index === points.length - 1 ? <span title={bucketLabel(point.key)}>{shortBucketLabel(point.key, granularity)}</span> : null}
      </div>)}
    </div></div>
  </section>;
}

function ChartLegend({ netLabel = "Lợi nhuận" }: { netLabel?: string }) {
  return <div className="finance-chart-legend" aria-label="Chú giải biểu đồ"><span><i className="green"/>Doanh thu</span><span><i className="orange"/>Chi phí</span><span><i className="blue"/>{netLabel}</span></div>;
}

function RevenueShare({ rows, totalRevenue }: { rows: StoreReportRow[]; totalRevenue: number }) {
  const shares = rows.map((row) => totalRevenue > 0 ? row.current.revenue / totalRevenue * 100 : 0);
  const stops = shares.reduce<{ cursor: number; values: string[] }>((result, share, index) => ({
    cursor: result.cursor + share,
    values: [...result.values, `${storeColors[index % storeColors.length]} ${result.cursor}% ${result.cursor + share}%`],
  }), { cursor: 0, values: [] }).values;
  const background = stops.length && totalRevenue > 0 ? `conic-gradient(${stops.join(",")})` : "#edf2ee";
  return <section className="finance-panel finance-share-panel"><div className="finance-panel-heading"><div><h2>Cơ cấu doanh thu theo cửa hàng</h2><p>Tỷ trọng trên tổng doanh thu kỳ</p></div></div><div className="finance-share-body">
    <div className="finance-donut" style={{ background }} role="img" aria-label={`Tổng doanh thu ${money(totalRevenue)}`}><span><small>Tổng</small><b>{money(totalRevenue)}</b></span></div>
    <div className="finance-share-list">{rows.length === 0 ? <p>Chưa có dữ liệu cửa hàng.</p> : rows.map((row, index) => <p key={row.current.id ?? row.current.name}><i style={{ background: storeColors[index % storeColors.length] }}/><span>{row.current.name || row.current.id}</span><b>{totalRevenue ? `${(row.current.revenue / totalRevenue * 100).toFixed(1)}%` : "0%"}</b><small>{money(row.current.revenue)}</small></p>)}</div>
  </div></section>;
}

export function ManagerBusinessReport() {
  const financeRange = useFinanceRange();
  const [scope, setScope] = useState<"ALL" | "STORE">("ALL");
  const [storeId, setStoreId] = useState("");
  const [storeOptions, setStoreOptions] = useState<Array<{ id: string; name: string }>>([]);
  const requestedStoreId = scope === "STORE" && storeId ? storeId : "ALL";
  const { data, error, loading, reload } = useManagerReport(financeRange.granularity, financeRange.queryRange.from, financeRange.queryRange.to, requestedStoreId);

  useEffect(() => {
    if (!data) return;
    const options = data.storeOptions ?? data.stores.flatMap((row) => row.current.id ? [{ id: row.current.id, name: row.current.name ?? row.current.id }] : []);
    if (options.length) setStoreOptions(options);
    if (scope === "STORE" && !storeId && options[0]?.id) setStoreId(options[0].id);
    if (scope === "STORE" && storeId && !data.stores.some((row) => row.current.id === storeId)) {
      setScope("ALL");
      setStoreId("");
    }
  }, [data, scope, storeId]);
  const selected = data?.stores.find((row) => row.current.id === storeId) ?? null;
  const activeStore = scope === "STORE" ? selected : null;
  const current = scope === "STORE" ? activeStore?.current ?? null : data?.totals ?? null;
  const previous = scope === "STORE" ? activeStore?.previous ?? null : data?.previousTotals ?? null;
  const comparison = activeStore?.evaluation ?? (data && current ? {
    margin: current.revenue ? current.profit / current.revenue * 100 : null,
    rating: current.profit < 0
      ? "CẦN CẢI THIỆN"
      : data.comparison.profitChange > 0
        ? "TỐT"
        : data.comparison.profitChange < 0 ? "CẦN THEO DÕI" : "ỔN ĐỊNH",
    direction: current.profit < 0
      ? "SUY GIẢM"
      : data.comparison.profitChange > 0 && data.comparison.revenueChange > 0
        ? "TĂNG TRƯỞNG"
        : data.comparison.profitChange < 0 ? "SUY GIẢM" : "ỔN ĐỊNH",
    ...data.comparison,
  } : null);
  const visibleRows = activeStore ? [activeStore] : data?.stores ?? [];
  const timeline: ReportTimelineRow[] = data?.timeline ?? [];
  const previousMargin = previous?.revenue ? previous.profit / previous.revenue * 100 : null;
  const marginDelta = comparison?.margin !== null && comparison?.margin !== undefined && previousMargin !== null
    ? comparison.margin - previousMargin
    : null;

  const chooseScope = (nextScope: "ALL" | "STORE") => {
    setScope(nextScope);
    if (nextScope === "STORE" && !storeId && storeOptions[0]?.id) setStoreId(storeOptions[0].id);
  };

  const exportReport = () => {
    if (!data) return;
    downloadExcel(`bao-cao-${financeRange.queryRange.from}-${financeRange.queryRange.to}.xls`, [
      ["Cửa hàng", "Từ ngày", "Đến ngày", "Doanh thu", "Tổng chi phí", "Lợi nhuận", "Tỷ lệ lợi nhuận (%)", "Tăng trưởng lợi nhuận (%)", "Đánh giá"],
      ...visibleRows.map((row) => [row.current.name, financeRange.queryRange.from, financeRange.queryRange.to, row.current.revenue, row.current.expense, row.current.profit, row.evaluation.margin ?? "", row.evaluation.profitChange, row.evaluation.rating]),
    ]);
  };

  return <div className="page-content finance-view report-view">
    <header className="finance-page-header">
      <div className="finance-page-title"><h1>Báo cáo</h1><p>Theo dõi và phân tích kết quả hoạt động của hệ thống.</p></div>
      <div className="finance-header-controls">
        <GranularityToggle value={financeRange.granularity} onChange={financeRange.setGranularity}/>
        <RangeControls granularity={financeRange.granularity} range={financeRange.range} onFromChange={financeRange.updateFrom} onToChange={financeRange.updateTo}/>
        <button type="button" className="finance-refresh" onClick={reload} disabled={loading} aria-label="Làm mới báo cáo"><RefreshCw size={17}/></button>
        <ExportButtons onExcel={exportReport} onPrint={() => window.print()} disabled={loading || !data}/>
      </div>
    </header>
    <div className="finance-scope-row">
      <div className="finance-scope-tabs" role="tablist" aria-label="Phạm vi báo cáo"><button type="button" role="tab" aria-selected={scope === "ALL"} className={scope === "ALL" ? "active" : ""} onClick={() => chooseScope("ALL")}><BarChart3 size={19}/>Tổng tất cả cửa hàng</button>
      <button type="button" role="tab" aria-selected={scope === "STORE"} className={scope === "STORE" ? "active" : ""} onClick={() => chooseScope("STORE")}><Store size={19}/>Theo từng cửa hàng</button></div>
      {scope === "STORE" ? <label className="finance-store-picker"><span>Chọn cửa hàng</span><select aria-label="Chọn cửa hàng xem báo cáo" value={storeId} onChange={(event) => setStoreId(event.target.value)}>{storeOptions.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label> : null}
    </div>
    {error ? <div className="form-message" role="alert">{error}</div> : null}
    {loading && !data ? <FinanceLoading text="Đang tổng hợp số liệu báo cáo…"/> : null}
    {data ? <FinanceStatus status={data.financeStatus} policy={data.recognitionPolicy}/> : null}
    {data && current && comparison ? <>
      <div className="finance-metrics">
        <FinanceMetric icon={WalletCards} label="Tổng doanh thu" value={money(current.revenue)} change={comparison.revenueChange}/>
        <FinanceMetric icon={ArrowDownLeft} label="Tổng chi phí" value={money(current.expense)} change={comparison.expenseChange} tone="orange"/>
        <FinanceMetric icon={BarChart3} label="Tổng lợi nhuận" value={money(current.profit)} change={comparison.profitChange} tone="blue"/>
        <FinanceMetric icon={CircleDollarSign} label="Tỷ lệ lợi nhuận" value={marginLabel(comparison.margin)} change={marginDelta} changeText={marginDelta === null ? "Không xác định" : `${marginDelta >= 0 ? "+" : ""}${marginDelta.toFixed(2)} điểm %`} tone="teal"/>
      </div>
      <div className="finance-report-charts"><ReportBarChart points={timeline} granularity={financeRange.granularity}/><RevenueShare rows={visibleRows} totalRevenue={current.revenue}/></div>
      <section className="finance-panel finance-table-panel report-detail-table"><div className="finance-panel-heading"><div><h2>Chi tiết doanh thu – chi phí – lợi nhuận từng cửa hàng</h2><p>{rangeLabel(data.range)} so với {data.previousRange ? rangeLabel(data.previousRange) : periodLabel(data.previousPeriod)}</p></div><span>{visibleRows.length} cửa hàng</span></div><div className="data-table-wrap"><table className="data-table"><caption className="sr-only">Chi tiết hiệu quả từng cửa hàng</caption><thead><tr><th>STT</th><th>Cửa hàng</th><th>Tổng doanh thu</th><th>Tổng chi phí</th><th>Lợi nhuận</th><th>Tỷ lệ lợi nhuận</th><th>Tăng trưởng</th><th>Đánh giá</th></tr></thead><tbody>{visibleRows.length === 0 ? <tr><td colSpan={8} className="empty-cell">Chưa có dữ liệu cửa hàng trong kỳ đã chọn.</td></tr> : visibleRows.map((row, index) => <tr key={row.current.id ?? row.current.name}><td>{index + 1}</td><td><b>{row.current.name || row.current.id}</b></td><td>{money(row.current.revenue)}</td><td>{money(row.current.expense)}</td><td className={row.current.profit >= 0 ? "money-green" : "money-orange"}><b>{money(row.current.profit)}</b></td><td className="money-green"><b>{marginLabel(row.evaluation.margin)}</b></td><td>{changeLabel(row.evaluation.profitChange)}</td><td><span className="status-pill">{row.evaluation.rating}</span></td></tr>)}</tbody><tfoot><tr><td colSpan={2}>Tổng cộng</td><td>{money(current.revenue)}</td><td>{money(current.expense)}</td><td>{money(current.profit)}</td><td>{marginLabel(comparison.margin)}</td><td>{changeLabel(comparison.profitChange)}</td><td>{comparison.direction}</td></tr></tfoot></table></div></section>
      <section className="finance-insight">
        {comparison.direction === "TĂNG TRƯỞNG"
          ? <TrendingUp size={22}/>
          : comparison.direction === "SUY GIẢM" || comparison.rating === "CẦN CẢI THIỆN"
            ? <TrendingDown size={22}/>
            : <Minus size={22}/>}
        <p><b>Xu hướng:</b> {comparison.direction === "TĂNG TRƯỞNG" ? "Doanh thu và lợi nhuận đang tăng so với kỳ trước." : comparison.direction === "SUY GIẢM" ? "Lợi nhuận đang giảm, cần rà soát các nhóm chi phí lớn." : comparison.rating === "CẦN CẢI THIỆN" ? "Kết quả chưa đạt kỳ vọng, cần ưu tiên cải thiện lợi nhuận." : "Hoạt động đang duy trì ổn định so với kỳ trước."}</p><span>Đánh giá: <b>{comparison.rating}</b></span>
      </section>
    </> : null}
  </div>;
}

function useCashflow(granularity: Granularity, from: string, to: string, storeId: string) {
  const [data, setData] = useState<CashflowResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ period: to.slice(0, 7), granularity, from, to });
    if (storeId !== "ALL") query.set("storeId", storeId);
    setLoading(true);
    setError("");
    setData(null);
    fetch(`/api/cashflow?${query.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as CashflowResponse & { message?: string };
        if (!response.ok) throw new Error(payload.message || "Không thể tải dòng tiền.");
        const requestedStore = storeId === "ALL" ? null : storeId;
        if (payload.request && (payload.request.from !== from || payload.request.to !== to || payload.request.granularity !== granularity || payload.request.storeId !== requestedStore)) {
          throw new Error("Phạm vi dòng tiền phản hồi không khớp yêu cầu.");
        }
        setData(payload);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "Không thể tải dòng tiền.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [from, granularity, storeId, to, version]);
  return { data, error, loading, reload };
}

function linePoints(values: number[], minimum: number, maximum: number) {
  const width = 720;
  const height = 220;
  const span = Math.max(1, maximum - minimum);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
    const y = height - (value - minimum) / span * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function CashflowLineChart({ data }: { data: CashflowResponse }) {
  const values = data.timeline.flatMap((row) => [row.inflow, row.outflow, row.net]);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(1, ...values);
  const labelStep = Math.max(1, Math.ceil(data.timeline.length / 7));
  return <section className="finance-panel finance-cash-chart"><div className="finance-panel-heading"><div><h2>Biểu đồ dòng tiền</h2><p>Đối chiếu doanh thu, chi phí và dòng tiền thuần theo {data.granularity === "day" ? "ngày" : "tháng"}</p></div><ChartLegend netLabel="Dòng tiền thuần"/></div>
    <div className="finance-line-chart" role="img" aria-label="Biểu đồ đường doanh thu, chi phí và dòng tiền thuần theo thời gian">
      {data.timeline.length === 0 ? <p className="finance-chart-empty">Chưa có dữ liệu dòng tiền.</p> : <>
        <div className="finance-y-labels" aria-hidden="true"><span>{compactMoney(maximum)}</span><span>{compactMoney((maximum + minimum) / 2)}</span><span>{compactMoney(minimum)}</span></div>
        <svg viewBox="0 -10 720 240" preserveAspectRatio="none" aria-hidden="true">
          <g className="finance-grid-lines"><line x1="0" x2="720" y1="0" y2="0"/><line x1="0" x2="720" y1="55" y2="55"/><line x1="0" x2="720" y1="110" y2="110"/><line x1="0" x2="720" y1="165" y2="165"/><line x1="0" x2="720" y1="220" y2="220"/></g>
          <polyline className="line-revenue" points={linePoints(data.timeline.map((row) => row.inflow), minimum, maximum)} vectorEffect="non-scaling-stroke"/>
          <polyline className="line-expense" points={linePoints(data.timeline.map((row) => row.outflow), minimum, maximum)} vectorEffect="non-scaling-stroke"/>
          <polyline className="line-profit" points={linePoints(data.timeline.map((row) => row.net), minimum, maximum)} vectorEffect="non-scaling-stroke"/>
        </svg>
        <div className="finance-x-labels" aria-hidden="true">{data.timeline.map((row, index) => index % labelStep === 0 || index === data.timeline.length - 1 ? <span key={row.key} style={{ left: `${data.timeline.length === 1 ? 50 : index / (data.timeline.length - 1) * 100}%` }}>{shortBucketLabel(row.key, data.granularity)}</span> : null)}</div>
      </>}
    </div>
  </section>;
}

function CashflowStructure({ totals }: { totals: CashTotals }) {
  const revenue = Math.max(0, totals.inflow);
  const expenseShare = revenue > 0 ? Math.min(100, Math.max(0, totals.outflow) / revenue * 100) : 0;
  const profitShare = revenue > 0 ? Math.min(100 - expenseShare, Math.max(0, totals.net) / revenue * 100) : 0;
  const remainder = Math.max(0, 100 - expenseShare - profitShare);
  const colors = ["#07883b", "#ff7a18", "#1888ee"];
  const background = revenue > 0
    ? `conic-gradient(${colors[1]} 0 ${expenseShare}%, ${colors[2]} ${expenseShare}% ${expenseShare + profitShare}%, #e8eeea ${expenseShare + profitShare}% 100%)`
    : "#edf2ee";
  const rows = [
    { label: "Doanh thu", value: totals.inflow, color: colors[0], percent: revenue > 0 ? "100%" : "Không xác định" },
    { label: "Chi phí", value: totals.outflow, color: colors[1], percent: revenue > 0 ? `${(totals.outflow / revenue * 100).toFixed(1)}%` : "Không xác định" },
    { label: "Dòng tiền thuần", value: totals.net, color: colors[2], percent: revenue > 0 ? `${(totals.net / revenue * 100).toFixed(1)}%` : "Không xác định" },
  ];
  return <section className="finance-panel finance-structure"><div className="finance-panel-heading"><div><h2>Tỷ lệ cơ cấu</h2><p>Cơ cấu chi phí và dòng tiền thuần trên doanh thu</p></div></div><div className="finance-structure-body">
    <div><div className="finance-donut" style={{ background }} role="img" aria-label={revenue > 0 ? `Chi phí chiếm ${expenseShare.toFixed(1)}%, dòng tiền thuần dương chiếm ${profitShare.toFixed(1)}% trên doanh thu` : "Chưa có doanh thu để xác định cơ cấu"}><span><small>Doanh thu</small><b>{money(totals.inflow)}</b></span></div>{totals.net < 0 ? <strong className="finance-loss-badge">Âm {money(Math.abs(totals.net))}</strong> : remainder > 0.05 ? <small className="finance-remainder">Chưa phân bổ {remainder.toFixed(1)}%</small> : null}</div>
    <div className="finance-structure-list">{rows.map((row) => <p key={row.label}><i style={{ background: row.color }}/><span>{row.label}<b>{money(row.value)}</b></span><em>{row.percent}</em></p>)}</div>
  </div></section>;
}

export function ManagerCashflow() {
  const financeRange = useFinanceRange();
  const [storeId, setStoreId] = useState("ALL");
  const [storeOptions, setStoreOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [page, setPage] = useState(0);
  const { data, error, loading, reload } = useCashflow(financeRange.granularity, financeRange.queryRange.from, financeRange.queryRange.to, storeId);

  useEffect(() => {
    if (!data) return;
    if (data.stores.length) setStoreOptions(data.stores);
    if (storeId !== "ALL" && !data.stores.some((store) => store.id === storeId)) setStoreId("ALL");
  }, [data, storeId]);
  const changes = data ? {
    inflow: percentChange(data.totals.inflow, data.previousTotals.inflow),
    outflow: percentChange(data.totals.outflow, data.previousTotals.outflow),
    net: percentChange(data.totals.net, data.previousTotals.net),
  } : null;
  const pageCount = Math.max(1, Math.ceil((data?.timeline.length ?? 0) / rowsPerPage));
  const safePage = Math.min(page, pageCount - 1);
  const visibleTimeline = data?.timeline.slice(safePage * rowsPerPage, (safePage + 1) * rowsPerPage) ?? [];

  const exportCashflow = () => {
    if (!data) return;
    downloadExcel(`dong-tien-${storeId.toLocaleLowerCase()}-${financeRange.queryRange.from}-${financeRange.queryRange.to}.xls`, [
      [data.granularity === "day" ? "Ngày" : "Tháng", "Doanh thu", "Chi phí", "Dòng tiền thuần", "Số phát sinh", "Nguồn ghi nhận", "Ghi chú"],
      ...data.timeline.map((row) => [bucketLabel(row.key), row.inflow, row.outflow, row.net, row.transactionCount, row.sources.join("; "), row.notes.join("; ")]),
    ]);
  };

  const setGranularity = (value: Granularity) => {
    financeRange.setGranularity(value);
    setPage(0);
  };

  return <div className="page-content finance-view cashflow-view">
    <header className="finance-page-header">
      <div className="finance-page-title"><h1>Dòng tiền</h1><p>Theo dõi doanh thu, chi phí và dòng tiền thuần thực tế của từng cửa hàng.</p></div>
      <div className="finance-header-controls cashflow-controls">
        <label className="finance-store-select"><span>Chọn cửa hàng</span><select aria-label="Chọn cửa hàng xem dòng tiền" value={storeId} onChange={(event) => { setStoreId(event.target.value); setPage(0); }}><option value="ALL">Tất cả cửa hàng</option>{storeOptions.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        <GranularityToggle value={financeRange.granularity} onChange={setGranularity}/>
        <RangeControls granularity={financeRange.granularity} range={financeRange.range} onFromChange={(value) => { financeRange.updateFrom(value); setPage(0); }} onToChange={(value) => { financeRange.updateTo(value); setPage(0); }}/>
        <button type="button" className="finance-refresh" onClick={reload} disabled={loading} aria-label="Làm mới dòng tiền"><RefreshCw size={17}/></button>
        <ExportButtons compact onExcel={exportCashflow} onPrint={() => window.print()} disabled={loading || !data}/>
      </div>
    </header>
    {error ? <div className="form-message" role="alert">{error}</div> : null}
    {loading && !data ? <FinanceLoading text="Đang đối soát dòng tiền thực tế…"/> : null}
    {data ? <FinanceStatus status={data.financeStatus} policy={data.recognitionPolicy}/> : null}
    {data && changes ? <>
      <div className="finance-metrics three cash-metrics">
        <FinanceMetric icon={ArrowUpRight} label="Doanh thu" value={money(data.totals.inflow)} change={changes.inflow} sparkline={data.timeline.map((row) => row.inflow)}/>
        <FinanceMetric icon={ArrowDownLeft} label="Chi phí" value={money(data.totals.outflow)} change={changes.outflow} tone="orange" sparkline={data.timeline.map((row) => row.outflow)}/>
        <FinanceMetric icon={BarChart3} label="Dòng tiền thuần" value={money(data.totals.net)} change={changes.net} tone="blue" sparkline={data.timeline.map((row) => row.net)}/>
      </div>
      <div className="finance-cash-grid"><CashflowLineChart data={data}/><CashflowStructure totals={data.totals}/></div>
      <section className="finance-panel finance-table-panel cash-detail-table"><div className="finance-panel-heading"><div><h2>Chi tiết dòng tiền theo {financeRange.granularity === "day" ? "ngày" : "tháng"}</h2><p>{rangeLabel(data.range)}</p></div><span>{data.timeline.reduce((sum, row) => sum + row.transactionCount, 0)} phát sinh</span></div><div className="data-table-wrap"><table className="data-table"><caption className="sr-only">Chi tiết dòng tiền theo kỳ</caption><thead><tr><th>{financeRange.granularity === "day" ? "Ngày" : "Tháng"}</th><th>Doanh thu</th><th>Chi phí</th><th>Dòng tiền thuần</th><th>Số phát sinh</th><th>Nguồn ghi nhận</th><th>Ghi chú</th></tr></thead><tbody>{visibleTimeline.length === 0 ? <tr><td colSpan={7} className="empty-cell">Không có phát sinh trong kỳ đang xem.</td></tr> : visibleTimeline.map((row) => <tr className="cash-row-screen" key={row.key}><td><b>{bucketLabel(row.key)}</b></td><td className="money-green">{money(row.inflow)}</td><td className="money-orange">{money(row.outflow)}</td><td className={row.net >= 0 ? "money-green" : "money-orange"}><b>{money(row.net)}</b></td><td>{row.transactionCount}</td><td>{row.sources.length ? row.sources.join(", ") : "–"}</td><td>{row.notes.length ? row.notes.join(", ") : "–"}</td></tr>)}{data.timeline.map((row) => <tr className="cash-row-print" key={`print-${row.key}`}><td><b>{bucketLabel(row.key)}</b></td><td className="money-green">{money(row.inflow)}</td><td className="money-orange">{money(row.outflow)}</td><td className={row.net >= 0 ? "money-green" : "money-orange"}><b>{money(row.net)}</b></td><td>{row.transactionCount}</td><td>{row.sources.length ? row.sources.join(", ") : "–"}</td><td>{row.notes.length ? row.notes.join(", ") : "–"}</td></tr>)}</tbody></table></div>
        <div className="finance-pagination"><label>Hiển thị <select aria-label="Số dòng trên mỗi trang" value={rowsPerPage} onChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select> trên mỗi trang</label><span>{data.timeline.length ? `${safePage * rowsPerPage + 1} – ${Math.min((safePage + 1) * rowsPerPage, data.timeline.length)} của ${data.timeline.length}` : "0 dòng"}</span><div><button type="button" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0} aria-label="Trang trước"><ArrowLeft size={16}/></button><b aria-label={`Trang ${safePage + 1} trên ${pageCount}`}>{safePage + 1}</b><button type="button" onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))} disabled={safePage >= pageCount - 1} aria-label="Trang sau"><ArrowRight size={16}/></button></div></div>
      </section>
    </> : null}
  </div>;
}
