"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Building2,
  CalendarDays,
  CircleDollarSign,
  Download,
  RefreshCw,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

type FinancialSnapshot = {
  id?: string;
  name?: string;
  revenue: number;
  expense: number;
  profit: number;
};

type StoreReportRow = {
  current: FinancialSnapshot;
  previous: FinancialSnapshot | null;
  evaluation: {
    margin: number;
    revenueChange: number;
    expenseChange: number;
    profitChange: number;
    rating: string;
    direction: string;
  };
};

type ReportResponse = {
  period: string;
  previousPeriod: string;
  stores: StoreReportRow[];
  totals: FinancialSnapshot;
  previousTotals: FinancialSnapshot;
  comparison: {
    revenueChange: number;
    expenseChange: number;
    profitChange: number;
  };
};

type CashflowResponse = {
  period: string;
  granularity: "day" | "month";
  range: { startPeriod: string; endPeriod: string };
  stores: Array<{ id: string; name: string }>;
  totals: CashTotals;
  previousTotals: CashTotals;
  timeline: Array<{
    key: string;
    inflow: number;
    outflow: number;
    net: number;
    transactionCount: number;
    sources: string[];
  }>;
  byStore: Array<CashTotals & { storeId: string; storeName: string }>;
};

type CashTotals = { inflow: number; outflow: number; net: number };

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function currentPeriod() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function money(value: number) {
  return `${moneyFormatter.format(Math.round(value))} đồng`;
}

function periodLabel(period: string) {
  return /^\d{4}-\d{2}$/.test(period) ? `Tháng ${period.slice(5, 7)}/${period.slice(0, 4)}` : period;
}

function bucketLabel(key: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
  return periodLabel(key);
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return (current - previous) / Math.abs(previous) * 100;
}

function changeLabel(value: number) {
  const direction = value > 0.005 ? "Tăng" : value < -0.005 ? "Giảm" : "Không đổi";
  return `${direction} ${Math.abs(value).toFixed(2)}% so với kỳ trước`;
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

function FinanceMetric({ icon: Icon, label, value, change, tone = "green" }: {
  icon: LucideIcon;
  label: string;
  value: string;
  change: number;
  tone?: "green" | "orange" | "blue" | "teal";
}) {
  return <article className={`finance-metric finance-${tone}`}>
    <i aria-hidden="true"><Icon size={24}/></i>
    <div><span>{label}</span><strong>{value}</strong><small className={change < 0 ? "down" : "up"}>{changeLabel(change)}</small></div>
  </article>;
}

function FinanceLoading({ text }: { text: string }) {
  return <div className="finance-loading" role="status"><RefreshCw size={18}/><span>{text}</span></div>;
}

function useManagerReport(period: string) {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/reports?period=${encodeURIComponent(period)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ReportResponse & { message?: string };
        if (!response.ok) throw new Error(payload.message || "Không thể tải báo cáo.");
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
  }, [period, version]);
  return { data, error, loading, reload };
}

function ReportBarChart({ points }: { points: Array<{ label: string; revenue: number; expense: number; profit: number }> }) {
  const maximum = Math.max(1, ...points.flatMap((point) => [point.revenue, point.expense, Math.max(0, point.profit)]));
  return <section className="finance-panel finance-chart-panel">
    <div className="finance-panel-heading"><div><h2>Biểu đồ doanh thu – chi phí – lợi nhuận</h2><p>Dữ liệu tài chính thực tế của kỳ đang chọn</p></div><div className="finance-chart-legend"><span><i className="green"/>Doanh thu</span><span><i className="orange"/>Chi phí</span><span><i className="blue"/>Lợi nhuận</span></div></div>
    <div className="finance-bars-scroll"><div className="finance-bars" role="img" aria-label="Biểu đồ so sánh doanh thu, chi phí và lợi nhuận">
      {points.length === 0 ? <div className="finance-chart-empty">Chưa có dữ liệu biểu đồ trong kỳ.</div> : points.map((point) => <div className="finance-bar-group" key={point.label} aria-label={`${point.label}: doanh thu ${money(point.revenue)}, chi phí ${money(point.expense)}, lợi nhuận ${money(point.profit)}`}>
        <div className="finance-bar-stack" aria-hidden="true">
          <i className="revenue" style={{ height: `${Math.max(3, point.revenue / maximum * 100)}%` }}/>
          <i className="expense" style={{ height: `${Math.max(3, point.expense / maximum * 100)}%` }}/>
          <i className="profit" style={{ height: `${Math.max(3, Math.max(0, point.profit) / maximum * 100)}%` }}/>
        </div><span title={point.label}>{point.label}</span>
      </div>)}
    </div></div>
  </section>;
}

function RevenueShare({ rows, totalRevenue }: { rows: StoreReportRow[]; totalRevenue: number }) {
  const colors = ["#098b42", "#20aa70", "#ff7a18", "#2379e8", "#7555d9", "#d4a017"];
  const shares = rows.map((row) => totalRevenue > 0 ? row.current.revenue / totalRevenue * 100 : 0);
  const stops = shares.map((share, index) => {
    const start = shares.slice(0, index).reduce((sum, value) => sum + value, 0);
    return `${colors[index % colors.length]} ${start}% ${start + share}%`;
  });
  const background = stops.length && totalRevenue > 0 ? `conic-gradient(${stops.join(",")})` : "#edf2ee";
  return <section className="finance-panel finance-share-panel"><div className="finance-panel-heading"><div><h2>Cơ cấu doanh thu theo cửa hàng</h2><p>Tỷ trọng trên tổng doanh thu kỳ</p></div></div><div className="finance-share-body">
    <div className="finance-donut" style={{ background }} aria-label={`Tổng doanh thu ${money(totalRevenue)}`}><span><small>Tổng</small><b>{money(totalRevenue)}</b></span></div>
    <div className="finance-share-list">{rows.length === 0 ? <p>Chưa có dữ liệu cửa hàng.</p> : rows.map((row, index) => <p key={row.current.id ?? row.current.name}><i style={{ background: colors[index % colors.length] }}/><span>{row.current.name || row.current.id}</span><b>{totalRevenue ? `${(row.current.revenue / totalRevenue * 100).toFixed(1)}%` : "0%"}</b><small>{money(row.current.revenue)}</small></p>)}</div>
  </div></section>;
}

export function ManagerBusinessReport() {
  const [period, setPeriod] = useState(currentPeriod);
  const [storeId, setStoreId] = useState("ALL");
  const { data, error, loading, reload } = useManagerReport(period);
  const selected = data?.stores.find((row) => row.current.id === storeId) ?? null;
  const current = selected?.current ?? data?.totals ?? null;
  const previous = selected?.previous ?? (storeId === "ALL" ? data?.previousTotals : null);
  const comparison = selected?.evaluation ?? (data && current ? {
    margin: current.revenue ? current.profit / current.revenue * 100 : 0,
    ...data.comparison,
    rating: current.profit < 0
      ? "CẦN CẢI THIỆN"
      : data.comparison.profitChange > 0
        ? "TỐT"
        : data.comparison.profitChange < 0 ? "CẦN THEO DÕI" : "ỔN ĐỊNH",
    direction: current.profit < 0
      ? "CẦN CẢI THIỆN"
      : data.comparison.profitChange > 0 && data.comparison.revenueChange > 0
        ? "TĂNG TRƯỞNG"
        : data.comparison.profitChange < 0 ? "SUY GIẢM" : "ỔN ĐỊNH",
  } : null);
  const visibleRows = selected ? [selected] : data?.stores ?? [];
  const chartPoints = (() => {
    if (selected) {
      return [
        ...(selected.previous ? [{ label: periodLabel(data?.previousPeriod ?? ""), revenue: selected.previous.revenue, expense: selected.previous.expense, profit: selected.previous.profit }] : []),
        { label: periodLabel(data?.period ?? period), revenue: selected.current.revenue, expense: selected.current.expense, profit: selected.current.profit },
      ];
    }
    return (data?.stores ?? []).map((row) => ({ label: row.current.name || row.current.id || "Cửa hàng", revenue: row.current.revenue, expense: row.current.expense, profit: row.current.profit }));
  })();

  const exportReport = () => {
    if (!data) return;
    downloadCsv(`bao-cao-he-thong-${period}.csv`, [
      ["Cửa hàng", "Kỳ", "Doanh thu", "Tổng chi phí", "Lợi nhuận", "Biên lợi nhuận", "Tăng trưởng lợi nhuận", "Đánh giá"],
      ...visibleRows.map((row) => [row.current.name, data.period, row.current.revenue, row.current.expense, row.current.profit, row.evaluation.margin, row.evaluation.profitChange, row.evaluation.rating]),
    ]);
  };

  return <div className="page-content finance-view report-view">
    <div className="finance-toolbar"><div><h2>Báo cáo hoạt động</h2><p>Tổng hợp doanh thu, chi phí, lợi nhuận và mức tăng trưởng của toàn hệ thống.</p></div><div className="finance-toolbar-actions">
      <label><span>Phạm vi báo cáo</span><select aria-label="Chọn phạm vi báo cáo" value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="ALL">Tất cả cửa hàng</option>{data?.stores.map((row) => <option key={row.current.id} value={row.current.id}>{row.current.name}</option>)}</select></label>
      <label><span>Kỳ báo cáo</span><input aria-label="Chọn kỳ báo cáo" type="month" value={period} onChange={(event) => setPeriod(event.target.value)}/></label>
      <button onClick={reload} disabled={loading}><RefreshCw size={16}/>{loading ? "Đang tải…" : "Làm mới"}</button>
      <button className="finance-export" onClick={exportReport} disabled={!data}><Download size={16}/>Xuất báo cáo</button>
    </div></div>
    {error ? <div className="form-message" role="alert">{error}</div> : null}
    {loading && !data ? <FinanceLoading text="Đang tổng hợp số liệu báo cáo…"/> : null}
    {data && current && comparison ? <>
      <div className="finance-metrics">
        <FinanceMetric icon={ArrowUpRight} label="Tổng doanh thu" value={money(current.revenue)} change={comparison.revenueChange}/>
        <FinanceMetric icon={ArrowDownLeft} label="Tổng chi phí" value={money(current.expense)} change={comparison.expenseChange} tone="orange"/>
        <FinanceMetric icon={BarChart3} label="Tổng lợi nhuận" value={money(current.profit)} change={comparison.profitChange} tone="blue"/>
        <FinanceMetric icon={TrendingUp} label="Tỷ lệ lợi nhuận" value={`${comparison.margin.toFixed(2)}%`} change={comparison.profitChange} tone="teal"/>
      </div>
      <div className="finance-report-charts"><ReportBarChart points={chartPoints}/><RevenueShare rows={visibleRows} totalRevenue={current.revenue}/></div>
      <section className="finance-panel finance-growth-panel"><div><TrendingUp size={24}/><span><b>Đánh giá hiệu quả: {comparison.rating}</b><small>{comparison.direction} · Lợi nhuận {changeLabel(comparison.profitChange).toLocaleLowerCase("vi-VN")}</small></span></div><div><CalendarDays size={22}/><span><b>So sánh với {periodLabel(data.previousPeriod)}</b><small>Doanh thu: {money(previous?.revenue ?? 0)} · Lợi nhuận: {money(previous?.profit ?? 0)}</small></span></div></section>
      <section className="finance-panel finance-table-panel"><div className="finance-panel-heading"><div><h2>Chi tiết hiệu quả từng cửa hàng</h2><p>{periodLabel(data.period)} so với {periodLabel(data.previousPeriod)}</p></div><span>{visibleRows.length} cửa hàng</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Cửa hàng</th><th>Doanh thu</th><th>Tổng chi phí</th><th>Lợi nhuận</th><th>Tỷ lệ lợi nhuận</th><th>Tăng trưởng</th><th>Đánh giá</th></tr></thead><tbody>{visibleRows.length === 0 ? <tr><td colSpan={8} className="empty-cell">Chưa có dữ liệu cửa hàng trong kỳ đã chọn.</td></tr> : visibleRows.map((row, index) => <tr key={row.current.id ?? row.current.name}><td>{index + 1}</td><td><b>{row.current.name || row.current.id}</b></td><td>{money(row.current.revenue)}</td><td>{money(row.current.expense)}</td><td className={row.current.profit >= 0 ? "money-green" : "money-orange"}><b>{money(row.current.profit)}</b></td><td>{row.evaluation.margin.toFixed(2)}%</td><td>{changeLabel(row.evaluation.profitChange)}</td><td><span className="status-pill">{row.evaluation.rating}</span></td></tr>)}</tbody><tfoot><tr><td colSpan={2}>Tổng cộng</td><td>{money(current.revenue)}</td><td>{money(current.expense)}</td><td>{money(current.profit)}</td><td>{comparison.margin.toFixed(2)}%</td><td>{changeLabel(comparison.profitChange)}</td><td>{comparison.direction}</td></tr></tfoot></table></div></section>
    </> : null}
  </div>;
}

function useCashflow(period: string, granularity: "day" | "month", storeId: string) {
  const [data, setData] = useState<CashflowResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ period, granularity });
    if (storeId !== "ALL") query.set("storeId", storeId);
    setLoading(true);
    setError("");
    fetch(`/api/cashflow?${query.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as CashflowResponse & { message?: string };
        if (!response.ok) throw new Error(payload.message || "Không thể tải dòng tiền.");
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
  }, [granularity, period, storeId, version]);
  return { data, error, loading, reload };
}

function CashflowChart({ data }: { data: CashflowResponse }) {
  const maximum = Math.max(1, ...data.timeline.flatMap((row) => [row.inflow, row.outflow]));
  return <section className="finance-panel finance-cash-chart"><div className="finance-panel-heading"><div><h2>Biểu đồ dòng tiền</h2><p>Luồng tiền vào và tiền ra theo {data.granularity === "day" ? "ngày" : "tháng"}</p></div><div className="finance-chart-legend"><span><i className="green"/>Tiền vào</span><span><i className="orange"/>Tiền ra</span></div></div><div className="cash-bars-scroll"><div className={`cash-bars cash-${data.granularity}`} role="img" aria-label="Biểu đồ dòng tiền theo thời gian">
    {data.timeline.map((row) => <div className="cash-bar-group" key={row.key} aria-label={`${bucketLabel(row.key)}: tiền vào ${money(row.inflow)}, tiền ra ${money(row.outflow)}`}><div aria-hidden="true"><i className="inflow" style={{ height: `${Math.max(2, row.inflow / maximum * 100)}%` }}/><i className="outflow" style={{ height: `${Math.max(2, row.outflow / maximum * 100)}%` }}/></div><span>{data.granularity === "day" ? row.key.slice(8, 10) : `${row.key.slice(5, 7)}/${row.key.slice(2, 4)}`}</span></div>)}
  </div></div></section>;
}

export function ManagerCashflow() {
  const [period, setPeriod] = useState(currentPeriod);
  const [granularity, setGranularity] = useState<"day" | "month">("day");
  const [storeId, setStoreId] = useState("ALL");
  const { data, error, loading, reload } = useCashflow(period, granularity, storeId);
  const changes = data ? {
    inflow: percentChange(data.totals.inflow, data.previousTotals.inflow),
    outflow: percentChange(data.totals.outflow, data.previousTotals.outflow),
    net: percentChange(data.totals.net, data.previousTotals.net),
  } : null;
  const exportCashflow = () => {
    if (!data) return;
    downloadCsv(`dong-tien-${storeId.toLocaleLowerCase()}-${period}.csv`, [
      [data.granularity === "day" ? "Ngày" : "Tháng", "Tiền vào", "Tiền ra", "Dòng tiền thuần", "Số phát sinh", "Nguồn"],
      ...data.timeline.map((row) => [bucketLabel(row.key), row.inflow, row.outflow, row.net, row.transactionCount, row.sources.join("; ")]),
    ]);
  };

  return <div className="page-content finance-view cashflow-view">
    <div className="finance-toolbar"><div><h2>Dòng tiền</h2><p>Theo dõi luồng tiền vào, tiền ra thực tế của toàn hệ thống và từng cửa hàng.</p></div><div className="finance-toolbar-actions cashflow-actions">
      <label><span>Cửa hàng</span><select aria-label="Chọn cửa hàng xem dòng tiền" value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="ALL">Tất cả cửa hàng</option>{data?.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      <label><span>Kỳ theo dõi</span><input aria-label="Chọn kỳ dòng tiền" type="month" value={period} onChange={(event) => setPeriod(event.target.value)}/></label>
      <div className="finance-segment" role="group" aria-label="Nhóm dòng tiền"><button className={granularity === "day" ? "active" : ""} aria-pressed={granularity === "day"} onClick={() => setGranularity("day")}>Theo ngày</button><button className={granularity === "month" ? "active" : ""} aria-pressed={granularity === "month"} onClick={() => setGranularity("month")}>Theo tháng</button></div>
      <button onClick={reload} disabled={loading}><RefreshCw size={16}/>{loading ? "Đang tải…" : "Làm mới"}</button>
      <button className="finance-export" onClick={exportCashflow} disabled={!data}><Download size={16}/>Xuất dòng tiền</button>
    </div></div>
    {error ? <div className="form-message" role="alert">{error}</div> : null}
    {loading && !data ? <FinanceLoading text="Đang đối soát dòng tiền thực tế…"/> : null}
    {data && changes ? <>
      <div className="finance-metrics three">
        <FinanceMetric icon={ArrowUpRight} label="Tổng tiền vào" value={money(data.totals.inflow)} change={changes.inflow}/>
        <FinanceMetric icon={ArrowDownLeft} label="Tổng tiền ra" value={money(data.totals.outflow)} change={changes.outflow} tone="orange"/>
        <FinanceMetric icon={CircleDollarSign} label="Dòng tiền thuần" value={money(data.totals.net)} change={changes.net} tone="blue"/>
      </div>
      <div className="finance-cash-grid"><CashflowChart data={data}/><section className="finance-panel cash-summary"><div className="finance-panel-heading"><div><h2>Tổng hợp theo cửa hàng</h2><p>Thu, chi và dòng tiền thuần trong phạm vi đang xem</p></div><Building2 size={20}/></div>{data.byStore.length === 0 ? <p className="finance-empty-note">Chưa có dữ liệu cửa hàng.</p> : data.byStore.map((store) => <article key={store.storeId}><div><b>{store.storeName}</b><small>{money(store.inflow)} tiền vào</small></div><span className={store.net >= 0 ? "positive" : "negative"}>{money(store.net)}</span><progress aria-label={`Tỷ lệ tiền vào của ${store.storeName}`} max={Math.max(1, data.totals.inflow)} value={store.inflow}/></article>)}</section></div>
      <section className="finance-panel finance-table-panel"><div className="finance-panel-heading"><div><h2>Chi tiết dòng tiền theo {granularity === "day" ? "ngày" : "tháng"}</h2><p>{granularity === "day" ? periodLabel(period) : `6 tháng kết thúc tại ${periodLabel(period)}`}</p></div><span>{data.timeline.reduce((sum, row) => sum + row.transactionCount, 0)} phát sinh</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>{granularity === "day" ? "Ngày" : "Tháng"}</th><th>Tiền vào</th><th>Tiền ra</th><th>Dòng tiền thuần</th><th>Số phát sinh</th><th>Nguồn ghi nhận</th></tr></thead><tbody>{data.timeline.map((row) => <tr key={row.key}><td><b>{bucketLabel(row.key)}</b></td><td className="money-green">{money(row.inflow)}</td><td className="money-orange">{money(row.outflow)}</td><td className={row.net >= 0 ? "money-green" : "money-orange"}><b>{money(row.net)}</b></td><td>{row.transactionCount}</td><td>{row.sources.length ? row.sources.join(", ") : "Không phát sinh"}</td></tr>)}</tbody><tfoot><tr><td>Tổng cộng</td><td>{money(data.totals.inflow)}</td><td>{money(data.totals.outflow)}</td><td>{money(data.totals.net)}</td><td>{data.timeline.reduce((sum, row) => sum + row.transactionCount, 0)}</td><td/></tr></tfoot></table></div></section>
    </> : null}
  </div>;
}
