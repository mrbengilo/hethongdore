"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BusinessRecord, comparisonLabel, dateTime24, money, Notice, Panel, Stat, StoreFinance } from "./shared";

type FinanceResponse = {
  month: string;
  previousMonth: string;
  stores?: StoreFinance[];
  totals?: Pick<StoreFinance, "revenue" | "expense" | "profit" | "distributableProfit" | "employeeKpiTotal" | "managerKpi">;
  store?: StoreFinance;
  previous: Partial<StoreFinance>;
  comparison: { revenue: number; expense: number; profit: number };
};

type DividendResponse = {
  month: string;
  current: { stores: StoreFinance[]; totals: { revenue: number; expense: number; profit: number; employeeKpiTotal: number; managerKpi: number; distributableProfit: number } };
  previous: { totals: { revenue: number; expense: number; profit: number; employeeKpiTotal: number; managerKpi: number; distributableProfit: number } };
  record: BusinessRecord | null;
  history: BusinessRecord[];
  message?: string;
};

function performance(finance: { revenue: number; profit: number }, growth: number) {
  const margin = finance.revenue > 0 ? finance.profit / finance.revenue : 0;
  if (finance.profit <= 0) return { label: "Cần cải thiện", detail: "Cửa hàng chưa tạo lợi nhuận dương trong kỳ." };
  if (margin >= 0.2 && growth >= 5) return { label: "Hiệu quả cao", detail: "Biên lợi nhuận tốt và lợi nhuận tăng rõ so với kỳ trước." };
  if (margin >= 0.1 && growth >= 0) return { label: "Hoạt động tốt", detail: "Lợi nhuận dương và chiều hướng không suy giảm." };
  return { label: "Theo dõi", detail: "Có lợi nhuận nhưng biên hoặc tốc độ tăng trưởng còn thấp." };
}

export function ReportsPanel({ storeId, month }: { storeId?: string; month: string }) {
  const [data, setData] = useState<FinanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ month });
    if (storeId) query.set("storeId", storeId);
    const response = await fetch(`/api/finance?${query}`);
    const result = await response.json();
    if (response.ok) setData(result);
    setLoading(false);
  }, [month, storeId]);
  useEffect(() => { void load(); }, [load]);

  if (loading || !data) return <Notice>Đang tổng hợp báo cáo từ số liệu thực...</Notice>;
  const current = storeId ? data.store! : data.totals!;
  const previous = data.previous;
  const margin = current.revenue > 0 ? current.profit / current.revenue * 100 : 0;
  const evaluation = performance(current, data.comparison.profit);
  const trend = data.comparison.profit > 0 ? "tăng" : data.comparison.profit < 0 ? "giảm" : "đi ngang";

  return <div className="op-stack">
    <div className="op-stats four">
      <Stat label="DOANH THU" value={money(current.revenue)} note={comparisonLabel(data.comparison.revenue)} />
      <Stat label="TỔNG CHI PHÍ" value={money(current.expense)} note={comparisonLabel(data.comparison.expense)} tone="orange" />
      <Stat label="LỢI NHUẬN CƠ SỞ" value={money(current.profit)} note={comparisonLabel(data.comparison.profit)} tone="blue" />
      <Stat label="BIÊN LỢI NHUẬN" value={`${margin.toFixed(2)}%`} note={evaluation.label} tone={current.profit > 0 ? "green" : "red"} />
    </div>
    <Panel title={`So sánh cùng kỳ · ${data.previousMonth} → ${month}`}>
      <div className="op-table-wrap"><table><thead><tr><th>Chỉ số</th><th>Kỳ trước</th><th>Kỳ hiện tại</th><th>Thay đổi</th></tr></thead><tbody>
        <tr><td>Doanh thu</td><td>{money(Number(previous.revenue ?? 0))}</td><td>{money(current.revenue)}</td><td>{comparisonLabel(data.comparison.revenue)}</td></tr>
        <tr><td>Chi phí</td><td>{money(Number(previous.expense ?? 0))}</td><td>{money(current.expense)}</td><td>{comparisonLabel(data.comparison.expense)}</td></tr>
        <tr><td>Lợi nhuận</td><td>{money(Number(previous.profit ?? 0))}</td><td>{money(current.profit)}</td><td>{comparisonLabel(data.comparison.profit)}</td></tr>
      </tbody></table></div>
    </Panel>
    <Panel title="Phân tích chiều hướng & đánh giá hiệu quả">
      <div className="op-analysis-grid"><article><span>Chiều hướng</span><strong>Lợi nhuận đang {trend}</strong><p>So với kỳ trước, lợi nhuận thay đổi {Math.abs(data.comparison.profit).toFixed(2)}%. Phân tích này được tính trực tiếp từ doanh thu đơn hàng và các khoản chi đã ghi nhận.</p></article><article><span>Đánh giá</span><strong>{evaluation.label}</strong><p>{evaluation.detail}</p></article><article><span>Khả năng tạo tiền</span><strong>{money(Number(current.distributableProfit ?? Math.max(0, current.profit)))}</strong><p>Lợi nhuận còn lại sau KPI nhân viên và KPI quản lý, dùng làm cơ sở chia cổ tức.</p></article></div>
    </Panel>
    {!storeId && data.stores && <Panel title="Hiệu quả theo cửa hàng"><div className="op-table-wrap"><table><thead><tr><th>Cửa hàng</th><th>Doanh thu</th><th>Chi phí</th><th>Lợi nhuận</th><th>Biên LN</th><th>Đánh giá</th></tr></thead><tbody>{data.stores.map((store) => { const storeMargin = store.revenue > 0 ? store.profit / store.revenue * 100 : 0; return <tr key={store.id}><td><b>{store.name}</b></td><td>{money(store.revenue)}</td><td>{money(store.expense)}</td><td>{money(store.profit)}</td><td>{storeMargin.toFixed(2)}%</td><td>{performance(store, 0).label}</td></tr>; })}</tbody></table></div></Panel>}
  </div>;
}

export function DividendPanel({ month }: { month: string }) {
  const [data, setData] = useState<DividendResponse | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/dividends?month=${encodeURIComponent(month)}`);
    const result = await response.json();
    if (response.ok) setData(result);
    else setMessage(result.message ?? "Không thể tải dữ liệu cổ tức");
  }, [month]);
  useEffect(() => { void load(); }, [load]);
  const totals = data?.current.totals;
  const distributable = Math.max(0, totals?.distributableProfit ?? 0);
  const shares = useMemo(() => [
    { name: "TRƯƠNG VIỆT VI", rate: 60, amount: Math.round(distributable * .6) },
    { name: "PHẠM THỊ DIỄM THÚY", rate: 40, amount: distributable - Math.round(distributable * .6) },
  ], [distributable]);

  async function closeDividend() {
    setBusy(true); setMessage("");
    const response = await fetch("/api/dividends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month }) });
    const result = await response.json();
    setBusy(false);
    if (!response.ok) return setMessage(result.message ?? "Không thể chia cổ tức");
    setMessage("Đã xác nhận chia cổ tức, ghi lịch sử và khóa kỳ cổ tức.");
    await load();
  }

  if (!data || !totals) return <Notice>{message || "Đang tổng hợp lợi nhuận có thể chia..."}</Notice>;
  const prior = data.previous.totals;
  const growth = prior.distributableProfit === 0 ? (distributable > 0 ? 100 : 0) : ((distributable - prior.distributableProfit) / Math.abs(prior.distributableProfit)) * 100;
  const locked = data.record?.status === "LOCKED";
  return <div className="op-stack">
    <div className="op-stats four"><Stat label="DOANH THU" value={money(totals.revenue)} /><Stat label="CHI PHÍ TRƯỚC KPI" value={money(totals.expense)} tone="orange" /><Stat label="KPI NV + QUẢN LÝ" value={money(totals.employeeKpiTotal + totals.managerKpi)} tone="blue" /><Stat label="LỢI NHUẬN CÓ THỂ CHIA" value={money(distributable)} /></div>
    <Panel title={`Chốt sổ chia cổ tức · ${month}`}>
      <Notice>Chỉ được chia cổ tức khi <b>tất cả cửa hàng đã chốt và khóa kỳ lương</b>. Lợi nhuận chia là phần còn lại sau khi trừ KPI nhân viên và KPI quản lý.</Notice>
      <div className="op-share-grid">{shares.map((share) => <article key={share.name}><span>{share.name}</span><b>{share.rate}%</b><strong>{money(share.amount)}</strong></article>)}</div>
      <div className="op-total-row"><span>Tổng cổ tức</span><strong>{money(distributable)}</strong><button className="op-lock" disabled={locked || busy} onClick={closeDividend}>{locked ? "ĐÃ CHIA & KHÓA KỲ" : "XÁC NHẬN CHIA & KHÓA KỲ"}</button></div>
      {message && <Notice kind={message.startsWith("Đã") ? "success" : "warning"}>{message}</Notice>}
    </Panel>
    <Panel title="So sánh & chiều hướng"><div className="op-analysis-grid"><article><span>Kỳ trước</span><strong>{money(prior.distributableProfit)}</strong><p>Lợi nhuận có thể chia của kỳ liền trước.</p></article><article><span>Thay đổi</span><strong>{growth >= 0 ? "+" : ""}{growth.toFixed(2)}%</strong><p>{growth > 0 ? "Khả năng tạo lợi nhuận chia cổ tức đang cải thiện." : growth < 0 ? "Lợi nhuận chia cổ tức đang giảm, cần xem lại doanh thu và cơ cấu chi phí." : "Không thay đổi so với kỳ trước."}</p></article><article><span>Trạng thái kỳ</span><strong>{locked ? "Đã khóa" : "Chờ xác nhận"}</strong><p>{data.record?.data.lockedAt ? `Khóa lúc ${dateTime24(String(data.record.data.lockedAt))}` : "Kỳ vẫn mở và chưa ghi nhận chia cổ tức."}</p></article></div></Panel>
    <Panel title="Lịch sử chia cổ tức"><div className="op-table-wrap"><table><thead><tr><th>Kỳ</th><th>Lợi nhuận có thể chia</th><th>Việt Vi 60%</th><th>Diễm Thúy 40%</th><th>Thời gian khóa</th><th>Trạng thái</th></tr></thead><tbody>{data.history.length === 0 ? <tr><td colSpan={6}>Chưa có lịch sử chia cổ tức.</td></tr> : data.history.map((record) => { const shareholders = Array.isArray(record.data.shareholders) ? record.data.shareholders as Array<Record<string, unknown>> : []; return <tr key={record.id}><td>{String(record.data.month ?? "")}</td><td>{money(Number((record.data.totals as Record<string, unknown> | undefined)?.distributableProfit ?? 0))}</td><td>{money(Number(shareholders[0]?.amount ?? 0))}</td><td>{money(Number(shareholders[1]?.amount ?? 0))}</td><td>{record.data.lockedAt ? dateTime24(String(record.data.lockedAt)) : "—"}</td><td><b>{record.status}</b></td></tr>; })}</tbody></table></div></Panel>
  </div>;
}
