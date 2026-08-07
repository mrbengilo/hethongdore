"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { BarChart3, Building2, Download, Edit3, Plus, ReceiptText, TrendingDown, TrendingUp, WalletCards, X } from "lucide-react";
import { formatVnd, isVnd, localPeriod, sumVnd } from "../lib/finance";

type StoreRef = { id: string; name: string; status: string };

type FixedCostData = {
  period: string;
  setup: number;
  rent: number;
  electricity: number;
  water: number;
  wifi: number;
  marketing: number;
  other: number;
  note?: string;
  total: number;
};

type FixedCostRecord = {
  id: string;
  title: string;
  data: FixedCostData;
  created_at: string;
  updated_at: string;
};

const costFields = [
  ["setup", "Set up"],
  ["rent", "Mặt bằng"],
  ["electricity", "Điện"],
  ["water", "Nước"],
  ["wifi", "Wifi"],
  ["marketing", "Marketing"],
  ["other", "Khác"],
] as const;

const emptyCosts = Object.fromEntries(costFields.map(([key]) => [key, "0"])) as Record<(typeof costFields)[number][0], string>;
const currentPeriod = () => localPeriod();
const formatPeriod = (value: string) => value ? `Tháng ${value.slice(5, 7)}/${value.slice(0, 4)}` : "—";
const periodBefore = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

function Metric({ icon: Icon, label, value, note, tone = "green" }: { icon: typeof WalletCards; label: string; value: string; note: string; tone?: string }) {
  return <article className={`fixed-cost-metric ${tone}`}><i><Icon size={23}/></i><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>;
}

function normalizeRecord(row: Record<string, unknown>): FixedCostRecord {
  const raw = (row.data ?? {}) as Partial<FixedCostData>;
  const data = Object.fromEntries(costFields.map(([key]) => [key, Number(raw[key] ?? 0)])) as Omit<FixedCostData, "period" | "note" | "total">;
  const total = costFields.reduce((sum, [key]) => sum + Number(data[key] ?? 0), 0);
  return {
    id: String(row.id),
    title: String(row.title ?? "Chi phí cố định"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    data: { ...data, period: String(raw.period ?? ""), note: String(raw.note ?? ""), total },
  };
}

export function FixedCostManagement({ store }: { store: StoreRef }) {
  const [records, setRecords] = useState<FixedCostRecord[]>([]);
  const [period, setPeriod] = useState(currentPeriod());
  const [formPeriod, setFormPeriod] = useState(currentPeriod());
  const [costs, setCosts] = useState(emptyCosts);
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const inactive = store.status === "INACTIVE";

  const reload = useCallback(async () => {
    const response = await fetch(`/api/records?category=CHI_PHI_CO_DINH&storeId=${encodeURIComponent(store.id)}`);
    const result = await response.json();
    setRecords((result.records ?? []).map((row: Record<string, unknown>) => normalizeRecord(row)));
  }, [store.id]);

  useEffect(() => { reload(); }, [reload]);

  const selected = records.find((record) => record.data.period === period);
  const previous = records.find((record) => record.data.period === periodBefore(period));
  const currentTotal = selected?.data.total ?? 0;
  const previousTotal = previous?.data.total ?? 0;
  const change = previousTotal ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;
  const largest = selected ? [...costFields].sort((a, b) => selected.data[b[0]] - selected.data[a[0]])[0] : null;
  const maxCost = Math.max(1, ...costFields.map(([key]) => selected?.data[key] ?? 0));

  function begin(record?: FixedCostRecord) {
    const target = record ?? records.find((item) => item.data.period === period);
    setEditingId(target?.id ?? null);
    setFormPeriod(target?.data.period ?? period);
    setCosts(Object.fromEntries(costFields.map(([key]) => [key, String(target?.data[key] ?? 0)])) as typeof costs);
    setNote(target?.data.note ?? "");
    setMessage("");
    setOpen(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const values = Object.fromEntries(costFields.map(([key]) => [key, Number(costs[key] || 0)])) as Record<(typeof costFields)[number][0], number>;
    if (!Object.values(values).every((value) => isVnd(value) && value >= 0)) return setMessage("Mỗi khoản chi phải là số nguyên VND không âm.");
    const total = sumVnd(Object.values(values));
    const existing = records.find((record) => record.data.period === formPeriod);
    const id = editingId ?? existing?.id;
    const response = await fetch("/api/records", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, category: "CHI_PHI_CO_DINH", storeId: store.id, title: `Chi phí cố định ${formPeriod}`, data: { ...values, period: formPeriod, note: note.trim(), total } }),
    });
    const result = await response.json();
    if (!response.ok) return setMessage(result.message ?? "Không thể lưu chi phí cố định.");
    setOpen(false);
    setPeriod(formPeriod);
    await reload();
  }

  function exportCsv() {
    const rows = [["Kỳ", ...costFields.map(([, label]) => label), "Tổng", "Ghi chú"], ...records.map((record) => [record.data.period, ...costFields.map(([key]) => record.data[key]), record.data.total, record.data.note ?? ""])];
    const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `chi-phi-co-dinh-${store.id}.csv`; link.click(); URL.revokeObjectURL(url);
  }

  return <div className="fixed-cost-page">
    <div className="fixed-cost-toolbar"><div><h2>Chi phí cố định</h2><p>Quản lý các khoản chi vận hành định kỳ của {store.name}</p></div><div><input aria-label="Kỳ chi phí" type="month" value={period} onChange={(event) => setPeriod(event.target.value)}/><button onClick={exportCsv}><Download size={16}/> Xuất Excel</button><button className="primary-button" disabled={inactive} onClick={() => begin()}><Plus size={17}/> Nhập chi phí</button></div></div>
    {inactive && <div className="inactive-store-banner">Cửa hàng đang ngưng hoạt động. Bạn vẫn xem và xuất được lịch sử, nhưng không thể thêm hoặc sửa chi phí.</div>}
    <div className="fixed-cost-metrics"><Metric icon={WalletCards} label="Tổng chi phí tháng" value={formatVnd(currentTotal)} note={formatPeriod(period)}/><Metric icon={previousTotal && change <= 0 ? TrendingDown : TrendingUp} label="So với tháng trước" value={`${change > 0 ? "+" : ""}${change.toFixed(2)}%`} note={`${formatVnd(previousTotal)} kỳ trước`} tone={change > 0 ? "orange" : "blue"}/><Metric icon={Building2} label="Khoản chi lớn nhất" value={largest ? formatVnd(selected?.data[largest[0]] ?? 0) : "0 đ"} note={largest?.[1] ?? "Chưa có dữ liệu"}/><Metric icon={ReceiptText} label="Số kỳ đã nhập" value={`${records.length} kỳ`} note="Lịch sử được lưu độc lập" tone="purple"/></div>
    <div className="fixed-cost-grid"><section className="fixed-cost-panel"><div className="panel-title"><div><h3>Danh sách chi phí · {formatPeriod(period)}</h3><p>Đơn vị: VND</p></div>{selected && <button disabled={inactive} onClick={() => begin(selected)}><Edit3 size={15}/> Sửa</button>}</div><div className="fixed-cost-list">{costFields.map(([key, label]) => <div key={key}><span>{label}</span><b>{formatVnd(selected?.data[key] ?? 0)}</b></div>)}<div className="total"><span>Tổng cộng</span><b>{formatVnd(currentTotal)}</b></div></div></section>
      <section className="fixed-cost-panel"><div className="panel-title"><div><h3>Biểu đồ cơ cấu chi phí</h3><p>{formatPeriod(period)}</p></div><BarChart3 size={20}/></div><div className="fixed-cost-bars">{costFields.map(([key, label]) => { const value = selected?.data[key] ?? 0; return <div key={key}><span>{label}</span><i><b style={{ width: `${Math.max(value ? 5 : 0, value / maxCost * 100)}%` }}/></i><strong>{formatVnd(value)}</strong></div>; })}</div></section></div>
    <section className="fixed-cost-panel history"><div className="panel-title"><div><h3>Lịch sử nhập chi phí cố định</h3><p>Theo dõi và so sánh các kỳ đã lưu</p></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Kỳ</th><th>Set up</th><th>Mặt bằng</th><th>Điện</th><th>Nước</th><th>Wifi</th><th>Marketing</th><th>Khác</th><th>Tổng</th><th>Thao tác</th></tr></thead><tbody>{records.length ? records.map((record) => <tr key={record.id}><td><b>{formatPeriod(record.data.period)}</b></td>{costFields.map(([key]) => <td key={key}>{formatVnd(record.data[key])}</td>)}<td className="money-orange"><b>{formatVnd(record.data.total)}</b></td><td><button disabled={inactive} onClick={() => begin(record)}><Edit3 size={15}/></button></td></tr>) : <tr><td colSpan={10} className="empty-cell">Chưa có lịch sử chi phí cố định.</td></tr>}</tbody></table></div></section>
    {open && <div className="modal-backdrop"><form className="modal fixed-cost-modal" onSubmit={save}><div className="modal-title"><div><h2>Nhập chi phí cố định</h2><p>Mọi số tiền được lưu bằng số nguyên VND.</p></div><button type="button" onClick={() => setOpen(false)}><X size={19}/></button></div><label>Kỳ chi phí<input type="month" required value={formPeriod} onChange={(event) => setFormPeriod(event.target.value)}/></label><div className="fixed-cost-form-grid">{costFields.map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="1" required value={costs[key]} onChange={(event) => setCosts({ ...costs, [key]: event.target.value })}/></label>)}</div><label>Ghi chú<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Nội dung hoặc đối soát chi phí trong kỳ"/></label><div className="fixed-cost-form-total"><span>Tổng chi phí</span><b>{formatVnd(sumVnd(costFields.map(([key]) => Number(costs[key] || 0)).filter((value) => isVnd(value))))}</b></div>{message && <div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>Hủy</button><button className="primary-button">Lưu chi phí</button></div></form></div>}
  </div>;
}
