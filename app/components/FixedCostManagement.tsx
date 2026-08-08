"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Building2, Download, Edit3, Plus, ReceiptText, Save, Trash2, TrendingDown, TrendingUp, WalletCards } from "lucide-react";
import { formatVnd, isVnd, localPeriod, sumVnd } from "../lib/finance";

type StoreRef = { id: string; name: string; status: string };

const costFields = [
  ["setup", "Set up"],
  ["rent", "Mặt bằng"],
  ["electricity", "Điện"],
  ["water", "Nước"],
  ["wifi", "Wifi"],
  ["marketing", "Marketing"],
  ["garbage", "Rác"],
  ["other", "Khác"],
] as const;

type FixedCostKey = (typeof costFields)[number][0];
type FixedCostItem = { key: FixedCostKey | null; name: string; amount: number };
type FixedCostHistoryEntry = { action?: string; at?: string; by?: string; total?: number };

type FixedCostData = Record<FixedCostKey, number> & {
  period: string;
  note: string;
  total: number;
  items: FixedCostItem[];
  changeHistory: FixedCostHistoryEntry[];
};

type FixedCostRecord = {
  id: string;
  title: string;
  data: FixedCostData;
  created_at: string;
  updated_at: string;
};

type DraftCostItem = {
  id: string;
  key: FixedCostKey | null;
  name: string;
  amount: string;
};

const fixedCostKeys = new Set<FixedCostKey>(costFields.map(([key]) => key));
let draftSequence = 0;

function nextDraftId() {
  draftSequence += 1;
  return `fixed-cost-draft-${draftSequence}`;
}

function createDefaultDraft(values?: Partial<Record<FixedCostKey, number>>) {
  return costFields.map(([key, name]) => ({
    id: nextDraftId(),
    key,
    name,
    amount: String(values?.[key] ?? 0),
  } satisfies DraftCostItem));
}

function moneyDigits(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

function formatMoneyInput(value: string) {
  const digits = moneyDigits(value);
  return digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "";
}

function safeVnd(value: unknown) {
  const amount = Number(value);
  return isVnd(amount) && amount >= 0 ? amount : 0;
}

const currentPeriod = () => localPeriod();
const formatPeriod = (value: string) => value ? `Tháng ${value.slice(5, 7)}/${value.slice(0, 4)}` : "—";
const periodBefore = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};
const dateTime24 = (value: string) => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date(value)) : "—";

function Metric({ icon: Icon, label, value, note, tone = "green" }: { icon: typeof WalletCards; label: string; value: string; note: string; tone?: string }) {
  return <article className={`fixed-cost-metric ${tone}`}><i><Icon size={23}/></i><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>;
}

function normalizeRecord(row: Record<string, unknown>): FixedCostRecord {
  const raw = row.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const itemAmounts = new Map<FixedCostKey, number>();
  const customItems: FixedCostItem[] = [];

  for (const value of rawItems) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const rawKey = String(item.key ?? "");
    const key = fixedCostKeys.has(rawKey as FixedCostKey) ? rawKey as FixedCostKey : null;
    const amount = safeVnd(item.amount);
    if (key) itemAmounts.set(key, amount);
    else {
      const name = String(item.name ?? "").trim();
      if (name) customItems.push({ key: null, name, amount });
    }
  }

  const values = Object.fromEntries(costFields.map(([key]) => [key, safeVnd(raw[key] ?? itemAmounts.get(key))])) as Record<FixedCostKey, number>;
  const items: FixedCostItem[] = [
    ...costFields.map(([key, name]) => ({ key, name, amount: values[key] })),
    ...customItems,
  ];
  const total = sumVnd(items.map((item) => item.amount));

  return {
    id: String(row.id),
    title: String(row.title ?? "Chi phí cố định"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    data: {
      ...values,
      period: String(raw.period ?? ""),
      note: String(raw.note ?? ""),
      total,
      items,
      changeHistory: Array.isArray(raw.changeHistory) ? raw.changeHistory as FixedCostHistoryEntry[] : [],
    },
  };
}

export function FixedCostManagement({ store, onSaved }: { store: StoreRef; onSaved?: () => void | Promise<void> }) {
  const [records, setRecords] = useState<FixedCostRecord[]>([]);
  const [period, setPeriod] = useState(currentPeriod());
  const [formPeriod, setFormPeriod] = useState(currentPeriod());
  const [items, setItems] = useState<DraftCostItem[]>(() => createDefaultDraft());
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState("");
  const inactive = store.status === "INACTIVE";

  const reload = useCallback(async () => {
    const response = await fetch(`/api/records?category=CHI_PHI_CO_DINH&storeId=${encodeURIComponent(store.id)}`);
    const result = await response.json();
    setRecords((result.records ?? []).map((row: Record<string, unknown>) => normalizeRecord(row)));
  }, [store.id]);

  useEffect(() => { void reload(); }, [reload]);

  const draftTotal = useMemo(() => {
    const amounts = items.map((item) => Number(item.amount || 0));
    return amounts.every((amount) => isVnd(amount) && amount >= 0) ? sumVnd(amounts) : 0;
  }, [items]);
  const selected = records.find((record) => record.data.period === period);
  const previous = records.find((record) => record.data.period === periodBefore(period));
  const currentTotal = selected?.data.total ?? 0;
  const previousTotal = previous?.data.total ?? 0;
  const change = previousTotal ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;
  const selectedItems = selected?.data.items ?? [];
  const largest = selectedItems.reduce<FixedCostItem | null>((result, item) => !result || item.amount > result.amount ? item : result, null);
  const maxCost = Math.max(1, ...selectedItems.map((item) => item.amount));

  function resetDraft(targetPeriod = formPeriod) {
    setEditingId(null);
    setFormPeriod(targetPeriod);
    setItems(createDefaultDraft());
    setNote("");
    setMessage("");
  }

  function begin(record: FixedCostRecord) {
    setEditingId(record.id);
    setFormPeriod(record.data.period);
    setItems(record.data.items.map((item) => ({ ...item, id: nextDraftId(), amount: String(item.amount) })));
    setNote(record.data.note);
    setMessage("");
    setSuccess("");
  }

  function updateItem(id: string, field: "name" | "amount", value: string) {
    setItems((current) => current.map((item) => item.id === id
      ? { ...item, [field]: field === "amount" ? moneyDigits(value) : value }
      : item));
    setMessage("");
    setSuccess("");
  }

  function addItem() {
    if (items.length >= 100) return setMessage("Mỗi kỳ được có tối đa 100 khoản chi phí.");
    setItems((current) => [...current, { id: nextDraftId(), key: null, name: "", amount: "0" }]);
    setMessage("");
    setSuccess("");
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id || item.key !== null));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inactive) return setMessage("Cửa hàng đang ngưng hoạt động, không thể lưu chi phí.");
    const payloadItems = items.map((item) => ({ key: item.key, name: item.name.trim(), amount: Number(item.amount || 0) }));
    const invalidIndex = payloadItems.findIndex((item) => !item.name || !isVnd(item.amount) || item.amount < 0);
    if (invalidIndex >= 0) return setMessage(`Dòng ${invalidIndex + 1}: cần có tên khoản chi và số tiền nguyên VND không âm.`);

    const values = Object.fromEntries(costFields.map(([key]) => [key, payloadItems.find((item) => item.key === key)?.amount ?? 0])) as Record<FixedCostKey, number>;
    const total = sumVnd(payloadItems.map((item) => item.amount));
    const existing = records.find((record) => record.data.period === formPeriod);
    const id = editingId ?? existing?.id;
    setSaving(true);
    setMessage("");
    setSuccess("");
    try {
      const response = await fetch("/api/records", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          category: "CHI_PHI_CO_DINH",
          storeId: store.id,
          title: `Chi phí cố định ${formPeriod}`,
          data: { ...values, period: formPeriod, note: note.trim(), items: payloadItems, total },
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể lưu chi phí cố định.");
      setPeriod(formPeriod);
      resetDraft(formPeriod);
      setSuccess("Đã lưu danh sách chi phí và ghi nhận đầy đủ thời gian cập nhật.");
      await reload();
      await onSaved?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể lưu chi phí cố định.");
    } finally {
      setSaving(false);
    }
  }

  function exportCsv() {
    const rows = [["Kỳ", ...costFields.map(([, label]) => label), "Khoản thêm", "Tổng", "Ghi chú", "Tạo lúc", "Cập nhật lúc"], ...records.map((record) => [
      record.data.period,
      ...costFields.map(([key]) => record.data[key]),
      record.data.items.filter((item) => item.key === null).map((item) => `${item.name}: ${item.amount}`).join("; "),
      record.data.total,
      record.data.note,
      dateTime24(record.created_at),
      dateTime24(record.updated_at),
    ])];
    const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `chi-phi-co-dinh-${store.id}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return <div className="fixed-cost-page">
    <div className="fixed-cost-toolbar">
      <div><h2>Chi phí cố định</h2><p>Nhập danh sách chi phí vận hành định kỳ của {store.name}</p></div>
      <div>
        <input aria-label="Kỳ xem chi phí" type="month" value={period} onChange={(event) => setPeriod(event.target.value)}/>
        <button type="button" onClick={exportCsv}><Download size={16}/> Xuất CSV</button>
        <button type="button" className="primary-button" disabled={inactive || saving || items.length >= 100} onClick={addItem}><Plus size={17}/> Thêm chi phí</button>
        <button type="submit" form="fixed-cost-entry-form" className="primary-button fixed-cost-toolbar-save" disabled={inactive || saving}><Save size={17}/> {saving ? "ĐANG LƯU..." : "Lưu chi phí"}</button>
      </div>
    </div>
    {inactive && <div className="inactive-store-banner">Cửa hàng đang ngưng hoạt động. Bạn vẫn xem và xuất được lịch sử, nhưng không thể thêm hoặc sửa chi phí.</div>}

    <form id="fixed-cost-entry-form" className="fixed-cost-panel fixed-cost-draft" onSubmit={save}>
      <div className="panel-title">
        <div><h3>{editingId ? "Cập nhật danh sách chi phí" : "Danh sách chi phí cần nhập"}</h3><p>8 khoản mặc định luôn sẵn sàng; có thể thêm khoản khác bằng nút “Thêm chi phí”.</p></div>
        <label>Kỳ chi phí<input aria-label="Kỳ nhập chi phí" type="month" required disabled={inactive || saving} value={formPeriod} onChange={(event) => setFormPeriod(event.target.value)}/></label>
      </div>
      <fieldset disabled={inactive || saving}>
        <div className="data-table-wrap">
          <table className="data-table fixed-cost-draft-table">
            <thead><tr><th>STT</th><th>Khoản chi phí</th><th>Số tiền</th><th>Thao tác</th></tr></thead>
            <tbody>{items.map((item, index) => <tr key={item.id}>
              <td>{index + 1}</td>
              <td>{item.key
                ? <b>{item.name}</b>
                : <input aria-label={`Tên chi phí dòng ${index + 1}`} required value={item.name} onChange={(event) => updateItem(item.id, "name", event.target.value)} placeholder="Tên khoản chi phí"/>}</td>
              <td><input aria-label={`Số tiền dòng ${index + 1}`} inputMode="numeric" pattern="[0-9,]*" required value={formatMoneyInput(item.amount)} onChange={(event) => updateItem(item.id, "amount", event.target.value)} placeholder="0"/></td>
              <td>{item.key === null
                ? <button type="button" onClick={() => removeItem(item.id)} aria-label={`Xóa chi phí dòng ${index + 1}`}><Trash2 size={16}/></button>
                : <span className="fixed-cost-default-label">Mặc định</span>}</td>
            </tr>)}</tbody>
            <tfoot><tr><td colSpan={2}><b>Tổng cộng · {items.length} khoản</b></td><td><b>{formatVnd(draftTotal)}</b></td><td/></tr></tfoot>
          </table>
        </div>
        <label className="fixed-cost-note">Ghi chú<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Nội dung hoặc đối soát chi phí trong kỳ"/></label>
      </fieldset>
      {message && <div className="form-message fixed-cost-feedback">{message}</div>}
      {success && <div className="success-banner fixed-cost-feedback">{success}</div>}
      <div className="fixed-cost-save-actions">
        {editingId && <button type="button" disabled={saving} onClick={() => resetDraft()}>Hủy chỉnh sửa</button>}
        <button className="primary-button" disabled={inactive || saving}><Save size={17}/> {saving ? "ĐANG LƯU..." : "Lưu chi phí"}</button>
      </div>
    </form>

    <div className="fixed-cost-metrics"><Metric icon={WalletCards} label="Tổng chi phí tháng" value={formatVnd(currentTotal)} note={formatPeriod(period)}/><Metric icon={previousTotal && change <= 0 ? TrendingDown : TrendingUp} label="So với tháng trước" value={`${change > 0 ? "+" : ""}${change.toFixed(2)}%`} note={`${formatVnd(previousTotal)} kỳ trước`} tone={change > 0 ? "orange" : "blue"}/><Metric icon={Building2} label="Khoản chi lớn nhất" value={formatVnd(largest?.amount ?? 0)} note={largest?.name ?? "Chưa có dữ liệu"}/><Metric icon={ReceiptText} label="Số kỳ đã nhập" value={`${records.length} kỳ`} note="Lịch sử được lưu độc lập" tone="purple"/></div>
    <div className="fixed-cost-grid">
      <section className="fixed-cost-panel"><div className="panel-title"><div><h3>Danh sách đã lưu · {formatPeriod(period)}</h3><p>Đơn vị: VND</p></div>{selected && <button disabled={inactive} onClick={() => begin(selected)}><Edit3 size={15}/> Sửa</button>}</div><div className="fixed-cost-list">{selectedItems.map((item, index) => <div key={`${item.key ?? "custom"}-${index}`}><span>{item.name}</span><b>{formatVnd(item.amount)}</b></div>)}<div className="total"><span>Tổng cộng</span><b>{formatVnd(currentTotal)}</b></div></div></section>
      <section className="fixed-cost-panel"><div className="panel-title"><div><h3>Biểu đồ cơ cấu chi phí</h3><p>{formatPeriod(period)}</p></div><BarChart3 size={20}/></div><div className="fixed-cost-bars">{selectedItems.length ? selectedItems.map((item, index) => <div key={`${item.key ?? "custom"}-bar-${index}`}><span>{item.name}</span><i><b style={{ width: `${Math.max(item.amount ? 5 : 0, item.amount / maxCost * 100)}%` }}/></i><strong>{formatVnd(item.amount)}</strong></div>) : <div className="empty-cell">Chưa có dữ liệu trong kỳ.</div>}</div></section>
    </div>
    <section className="fixed-cost-panel history"><div className="panel-title"><div><h3>Lịch sử nhập chi phí cố định</h3><p>Mỗi lần lưu đều ghi nhận đầy đủ ngày giờ cập nhật theo định dạng 24 giờ</p></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Kỳ</th><th>Số khoản</th>{costFields.map(([, label]) => <th key={label}>{label}</th>)}<th>Tổng</th><th>Tạo lúc</th><th>Cập nhật lúc</th><th>Số lần lưu</th><th>Thao tác</th></tr></thead><tbody>{records.length ? records.map((record) => <tr key={record.id}><td><b>{formatPeriod(record.data.period)}</b></td><td>{record.data.items.length}</td>{costFields.map(([key]) => <td key={key}>{formatVnd(record.data[key])}</td>)}<td className="money-orange"><b>{formatVnd(record.data.total)}</b></td><td>{dateTime24(record.created_at)}</td><td><b>{dateTime24(record.updated_at)}</b></td><td>{record.data.changeHistory.length || 1}</td><td><button disabled={inactive} onClick={() => begin(record)}><Edit3 size={15}/></button></td></tr>) : <tr><td colSpan={costFields.length + 7} className="empty-cell">Chưa có lịch sử chi phí cố định.</td></tr>}</tbody></table></div>{selected?.data.changeHistory.length ? <div className="report-profit-note"><ReceiptText size={17}/><span>Lịch sử cập nhật kỳ này: {selected.data.changeHistory.map((entry) => dateTime24(entry.at ?? "")).join(" · ")}</span></div> : null}</section>
  </div>;
}
