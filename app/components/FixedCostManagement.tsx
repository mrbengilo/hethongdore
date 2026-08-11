"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Ban, Building2, Download, Plus, ReceiptText, Save, Trash2, TrendingDown, TrendingUp, WalletCards } from "lucide-react";
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
  clientRequestId: string;
  note: string;
  total: number;
  items: FixedCostItem[];
  entryNo: string;
  savedAt: string;
  savedBy: string;
  changeHistory: FixedCostHistoryEntry[];
};

type FixedCostRecord = {
  id: string;
  title: string;
  status: string;
  data: FixedCostData;
  created_at: string;
  updated_at: string;
};

type FixedCostPeriodSummary = {
  period: string;
  entryCount: number;
  total: number;
  items: FixedCostItem[];
};

type FixedCostHistoryResponse = {
  records?: Array<Record<string, unknown>>;
  periodSummaries?: FixedCostPeriodSummary[];
  nextCursor?: string | null;
  historyTotal?: number;
  message?: string;
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

function nextClientRequestId() {
  return crypto.randomUUID();
}

function createDefaultDraft() {
  return costFields.map(([key, name]) => ({
    id: nextDraftId(),
    key,
    name,
    amount: "0",
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

function normalizeItems(raw: Record<string, unknown>) {
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
  return {
    values,
    items: [...costFields.map(([key, name]) => ({ key, name, amount: values[key] })), ...customItems] satisfies FixedCostItem[],
  };
}

function normalizeRecord(row: Record<string, unknown>): FixedCostRecord {
  const raw = row.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  const normalized = normalizeItems(raw);
  return {
    id: String(row.id),
    title: String(row.title ?? "Chi phí cố định"),
    status: String(row.status ?? "ACTIVE"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    data: {
      ...normalized.values,
      period: String(raw.period ?? ""),
      clientRequestId: String(raw.clientRequestId ?? ""),
      note: String(raw.note ?? ""),
      total: sumVnd(normalized.items.map((item) => item.amount)),
      items: normalized.items,
      entryNo: String(raw.entryNo ?? `CP-${String(row.id ?? "").slice(0, 8).toUpperCase()}`),
      savedAt: String(raw.savedAt ?? row.created_at ?? row.updated_at ?? ""),
      savedBy: String(raw.savedBy ?? row.owner_id ?? ""),
      changeHistory: Array.isArray(raw.changeHistory) ? raw.changeHistory as FixedCostHistoryEntry[] : [],
    },
  };
}

function normalizeSummary(raw: FixedCostPeriodSummary): FixedCostPeriodSummary {
  return {
    period: String(raw.period ?? ""),
    entryCount: Math.max(0, Math.round(Number(raw.entryCount ?? 0))),
    total: safeVnd(raw.total),
    items: Array.isArray(raw.items) ? raw.items.map((item) => ({
      key: fixedCostKeys.has(item.key as FixedCostKey) ? item.key as FixedCostKey : null,
      name: String(item.name ?? ""),
      amount: safeVnd(item.amount),
    })).filter((item) => item.name) : [],
  };
}

export function FixedCostManagement({ store, onSaved }: { store: StoreRef; onSaved?: () => void | Promise<void> }) {
  const [records, setRecords] = useState<FixedCostRecord[]>([]);
  const [periodSummaries, setPeriodSummaries] = useState<FixedCostPeriodSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [period, setPeriod] = useState(currentPeriod());
  const [formPeriod, setFormPeriod] = useState(currentPeriod());
  const [items, setItems] = useState<DraftCostItem[]>(() => createDefaultDraft());
  const [clientRequestId, setClientRequestId] = useState(() => nextClientRequestId());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState("");
  const inactive = store.status === "INACTIVE";

  const historyUrl = useCallback((cursor?: string | null, limit = 25) => {
    const params = new URLSearchParams({ category: "CHI_PHI_CO_DINH", storeId: store.id, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return `/api/records?${params.toString()}`;
  }, [store.id]);

  const reload = useCallback(async () => {
    const response = await fetch(historyUrl());
    const result = await response.json().catch(() => ({})) as FixedCostHistoryResponse;
    if (!response.ok) throw new Error(result.message ?? "Không thể tải lịch sử chi phí cố định.");
    setRecords((result.records ?? []).map((row) => normalizeRecord(row)));
    setPeriodSummaries((result.periodSummaries ?? []).map(normalizeSummary));
    setNextCursor(result.nextCursor ?? null);
    setHistoryTotal(Math.max(0, Number(result.historyTotal ?? 0)));
  }, [historyUrl]);

  useEffect(() => { void reload().catch((error) => setMessage(error instanceof Error ? error.message : "Không thể tải lịch sử chi phí cố định.")); }, [reload]);

  const draftTotal = useMemo(() => {
    const amounts = items.map((item) => Number(item.amount || 0));
    return amounts.every((amount) => isVnd(amount) && amount >= 0) ? sumVnd(amounts) : 0;
  }, [items]);
  const selectedSummary = periodSummaries.find((summary) => summary.period === period);
  const previousSummary = periodSummaries.find((summary) => summary.period === periodBefore(period));
  const selectedItems = selectedSummary?.items ?? [];
  const currentTotal = selectedSummary?.total ?? 0;
  const previousTotal = previousSummary?.total ?? 0;
  const change = previousTotal ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;
  const largest = selectedItems.reduce<FixedCostItem | null>((result, item) => !result || item.amount > result.amount ? item : result, null);
  const maxCost = Math.max(1, ...selectedItems.map((item) => item.amount));

  function markDraftChanged() {
    setClientRequestId(nextClientRequestId());
    setMessage("");
    setSuccess("");
  }

  function resetDraft(targetPeriod = formPeriod) {
    setFormPeriod(targetPeriod);
    setItems(createDefaultDraft());
    setClientRequestId(nextClientRequestId());
    setNote("");
    setMessage("");
  }

  function updateItem(id: string, field: "name" | "amount", value: string) {
    setItems((current) => current.map((item) => item.id === id
      ? { ...item, [field]: field === "amount" ? moneyDigits(value) : value }
      : item));
    markDraftChanged();
  }

  function addItem() {
    if (items.length >= 100) return setMessage("Mỗi lần lưu được có tối đa 100 khoản chi phí.");
    setItems((current) => [...current, { id: nextDraftId(), key: null, name: "", amount: "0" }]);
    markDraftChanged();
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id || item.key !== null));
    markDraftChanged();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inactive) return setMessage("Cửa hàng đang ngưng hoạt động, không thể lưu chi phí.");
    const payloadItems = items.map((item) => ({ key: item.key, name: item.name.trim(), amount: Number(item.amount || 0) }));
    const invalidIndex = payloadItems.findIndex((item) => !item.name || !isVnd(item.amount) || item.amount < 0);
    if (invalidIndex >= 0) return setMessage(`Dòng ${invalidIndex + 1}: cần có tên khoản chi và số tiền nguyên VND không âm.`);

    const values = Object.fromEntries(costFields.map(([key]) => [key, payloadItems.find((item) => item.key === key)?.amount ?? 0])) as Record<FixedCostKey, number>;
    const total = sumVnd(payloadItems.map((item) => item.amount));
    const savedPeriod = formPeriod;
    setSaving(true);
    setMessage("");
    setSuccess("");
    try {
      const response = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "CHI_PHI_CO_DINH",
          storeId: store.id,
          title: `Chi phí cố định ${savedPeriod}`,
          data: { ...values, period: savedPeriod, clientRequestId, note: note.trim(), items: payloadItems, total },
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể lưu chi phí cố định.");
      setPeriod(savedPeriod);
      resetDraft(savedPeriod);
      setSuccess("Đã lưu một lần nhập độc lập. Danh sách nhập đã được đặt lại về 0 để không mang số liệu sang lần sau.");
      await reload();
      await onSaved?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể lưu chi phí cố định.");
    } finally {
      setSaving(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMessage("");
    try {
      const response = await fetch(historyUrl(nextCursor));
      const result = await response.json().catch(() => ({})) as FixedCostHistoryResponse;
      if (!response.ok) throw new Error(result.message ?? "Không thể tải thêm lịch sử chi phí.");
      const incoming = (result.records ?? []).map((row) => normalizeRecord(row));
      setRecords((current) => {
        const ids = new Set(current.map((record) => record.id));
        return [...current, ...incoming.filter((record) => !ids.has(record.id))];
      });
      setPeriodSummaries((result.periodSummaries ?? []).map(normalizeSummary));
      setNextCursor(result.nextCursor ?? null);
      setHistoryTotal(Math.max(0, Number(result.historyTotal ?? historyTotal)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể tải thêm lịch sử chi phí.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function voidRecord(record: FixedCostRecord) {
    if (inactive || record.status === "VOID" || voidingId) return;
    if (!window.confirm(`Hủy phiếu ${record.data.entryNo}? Phiếu vẫn nằm trong lịch sử nhưng sẽ không còn được tính vào tổng chi phí.`)) return;
    setVoidingId(record.id);
    setMessage("");
    setSuccess("");
    try {
      const response = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "VOID_FIXED_COST", id: record.id, reason: "Quản lý xác nhận hủy phiếu nhập sai" }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể hủy phiếu chi phí.");
      setSuccess(result.message ?? "Đã hủy phiếu chi phí.");
      await reload();
      await onSaved?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể hủy phiếu chi phí.");
    } finally {
      setVoidingId(null);
    }
  }

  async function exportCsv() {
    setExporting(true);
    setMessage("");
    try {
      const allRecords: FixedCostRecord[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = await fetch(historyUrl(cursor, 100));
        const result = await response.json().catch(() => ({})) as FixedCostHistoryResponse;
        if (!response.ok) throw new Error(result.message ?? "Không thể tải lịch sử để xuất CSV.");
        allRecords.push(...(result.records ?? []).map((row) => normalizeRecord(row)));
        const following = result.nextCursor ?? null;
        if (following && seenCursors.has(following)) throw new Error("Mốc phân trang lịch sử bị lặp.");
        if (following) seenCursors.add(following);
        cursor = following;
      } while (cursor);
      const rows = [["Mã lần lưu", "Kỳ", ...costFields.map(([, label]) => label), "Khoản thêm", "Tổng", "Ghi chú", "Lưu lúc", "Trạng thái"], ...allRecords.map((record) => [
        record.data.entryNo,
        record.data.period,
        ...costFields.map(([key]) => record.data[key]),
        record.data.items.filter((item) => item.key === null).map((item) => `${item.name}: ${item.amount}`).join("; "),
        record.data.total,
        record.data.note,
        dateTime24(record.data.savedAt),
        record.status === "VOID" ? "Đã hủy" : "Đang tính",
      ])];
      const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `chi-phi-co-dinh-${store.id}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể xuất lịch sử chi phí.");
    } finally {
      setExporting(false);
    }
  }

  return <div className="fixed-cost-page">
    <div className="fixed-cost-toolbar">
      <div><h2>Chi phí cố định</h2><p>Mỗi lần lưu là một lần nhập độc lập trong tháng của {store.name}</p></div>
      <div>
        <input aria-label="Kỳ xem chi phí" type="month" value={period} onChange={(event) => setPeriod(event.target.value)}/>
        <button type="button" disabled={exporting} onClick={() => void exportCsv()}><Download size={16}/> {exporting ? "Đang xuất..." : "Xuất CSV"}</button>
        <button type="button" className="primary-button" disabled={inactive || saving || items.length >= 100} onClick={addItem}><Plus size={17}/> Thêm chi phí</button>
        <button type="submit" form="fixed-cost-entry-form" className="primary-button fixed-cost-toolbar-save" disabled={inactive || saving}><Save size={17}/> {saving ? "ĐANG LƯU..." : "Lưu chi phí"}</button>
      </div>
    </div>
    {inactive && <div className="inactive-store-banner">Cửa hàng đang ngưng hoạt động. Bạn vẫn xem và xuất được lịch sử, nhưng không thể thêm hoặc hủy chi phí.</div>}

    <form id="fixed-cost-entry-form" className="fixed-cost-panel fixed-cost-draft" onSubmit={save}>
      <div className="panel-title">
        <div><h3>Danh sách chi phí cần nhập</h3><p>8 khoản mặc định luôn sẵn sàng. Sau khi lưu, danh sách trở về 0 và lịch sử cũ không thể ghi đè.</p></div>
        <label>Kỳ chi phí<input aria-label="Kỳ nhập chi phí" type="month" required disabled={inactive || saving} value={formPeriod} onChange={(event) => { setFormPeriod(event.target.value); markDraftChanged(); }}/></label>
      </div>
      <fieldset disabled={inactive || saving}>
        <div className="fixed-cost-entry-list" role="table" aria-label="Danh sách chi phí cố định cần nhập">
          <div className="fixed-cost-entry-header" role="row">
            <span role="columnheader">STT</span><span role="columnheader">Khoản chi phí</span><span role="columnheader">Số tiền</span><span role="columnheader">Thao tác</span>
          </div>
          {items.map((item, index) => <div className={`fixed-cost-entry-row ${item.key ? "is-default" : "is-custom"}`} role="row" key={item.id}>
            <span className="fixed-cost-entry-index" role="cell">{index + 1}</span>
            <div className="fixed-cost-entry-name" role="cell">{item.key
              ? <b>{item.name}</b>
              : <input aria-label={`Tên chi phí dòng ${index + 1}`} required value={item.name} onChange={(event) => updateItem(item.id, "name", event.target.value)} placeholder="Tên khoản chi phí"/>}</div>
            <label className="fixed-cost-entry-amount" role="cell"><span>Số tiền</span><input aria-label={`Số tiền dòng ${index + 1}`} inputMode="numeric" pattern="[0-9,]*" required value={formatMoneyInput(item.amount)} onChange={(event) => updateItem(item.id, "amount", event.target.value)} placeholder="0"/></label>
            <div className={`fixed-cost-entry-action ${item.key ? "is-default" : "is-custom"}`} role="cell">{item.key === null
              ? <button type="button" onClick={() => removeItem(item.id)} aria-label={`Xóa chi phí dòng ${index + 1}`}><Trash2 size={16}/></button>
              : <span className="fixed-cost-default-label">Mặc định</span>}</div>
          </div>)}
          <div className="fixed-cost-entry-total" role="row"><b role="cell">Tổng cộng · {items.length} khoản</b><strong role="cell">{formatVnd(draftTotal)}</strong></div>
        </div>
        <label className="fixed-cost-note">Ghi chú<textarea value={note} onChange={(event) => { setNote(event.target.value); markDraftChanged(); }} placeholder="Nội dung hoặc đối soát chi phí trong lần lưu này"/></label>
      </fieldset>
      {message && <div className="form-message fixed-cost-feedback" role="alert">{message}</div>}
      {success && <div className="success-banner fixed-cost-feedback" role="status">{success}</div>}
      <div className="fixed-cost-save-actions">
        <button className="primary-button" disabled={inactive || saving}><Save size={17}/> {saving ? "ĐANG LƯU..." : "Lưu chi phí"}</button>
      </div>
    </form>

    <div className="fixed-cost-metrics"><Metric icon={WalletCards} label="Tổng chi phí tháng" value={formatVnd(currentTotal)} note={`${formatPeriod(period)} · ${selectedSummary?.entryCount ?? 0} lần lưu đang tính`}/><Metric icon={previousTotal && change <= 0 ? TrendingDown : TrendingUp} label="So với tháng trước" value={`${change > 0 ? "+" : ""}${change.toFixed(2)}%`} note={`${formatVnd(previousTotal)} kỳ trước`} tone={change > 0 ? "orange" : "blue"}/><Metric icon={Building2} label="Khoản chi lớn nhất" value={formatVnd(largest?.amount ?? 0)} note={largest?.name ?? "Chưa có dữ liệu"}/><Metric icon={ReceiptText} label="Số kỳ đã nhập" value={`${periodSummaries.length} kỳ`} note={`${historyTotal} phiếu gồm cả phiếu đã hủy`} tone="purple"/></div>
    <div className="fixed-cost-grid">
      <section className="fixed-cost-panel"><div className="panel-title"><div><h3>Tổng hợp đang tính · {formatPeriod(period)}</h3><p>{selectedSummary?.entryCount ?? 0} lần lưu hợp lệ · Đơn vị VND</p></div></div><div className="fixed-cost-list">{selectedItems.map((item, index) => <div key={`${item.key ?? "custom"}-${index}`}><span>{item.name}</span><b>{formatVnd(item.amount)}</b></div>)}<div className="total"><span>Tổng cộng</span><b>{formatVnd(currentTotal)}</b></div></div></section>
      <section className="fixed-cost-panel"><div className="panel-title"><div><h3>Biểu đồ cơ cấu chi phí</h3><p>{formatPeriod(period)}</p></div><BarChart3 size={20}/></div><div className="fixed-cost-bars">{selectedSummary ? selectedItems.map((item, index) => <div key={`${item.key ?? "custom"}-bar-${index}`}><span>{item.name}</span><i><b style={{ width: `${Math.max(item.amount ? 5 : 0, item.amount / maxCost * 100)}%` }}/></i><strong>{formatVnd(item.amount)}</strong></div>) : <div className="empty-cell">Chưa có dữ liệu trong kỳ.</div>}</div></section>
    </div>
    <section className="fixed-cost-panel history">
      <div className="panel-title"><div><h3>Lịch sử nhập chi phí cố định</h3><p>Mỗi dòng là một phiếu bất biến; phiếu đã hủy vẫn được giữ để đối soát nhưng không tính vào tổng</p></div></div>
      <div className="data-table-wrap fixed-cost-history-scroll"><table className="data-table fixed-cost-history-table"><thead><tr><th>Mã lần lưu</th><th>Kỳ</th><th>Chi tiết khoản chi</th><th>Tổng</th><th>Ghi chú</th><th>Lưu lúc</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{records.length ? records.map((record) => <tr className={record.status === "VOID" ? "fixed-cost-void-row" : ""} key={record.id}><td><b>{record.data.entryNo}</b></td><td>{formatPeriod(record.data.period)}</td><td><div className="fixed-cost-history-items">{record.data.items.map((item, index) => <span key={`${record.id}-${item.key ?? "custom"}-${index}`}>{item.name}: <b>{formatVnd(item.amount)}</b></span>)}</div></td><td className="money-orange"><b>{formatVnd(record.data.total)}</b></td><td>{record.data.note || "—"}</td><td><b>{dateTime24(record.data.savedAt)}</b></td><td><span className={`fixed-cost-immutable-label ${record.status === "VOID" ? "void" : ""}`}>{record.status === "VOID" ? "Đã hủy · Không tính" : "Đã lưu · Không ghi đè"}</span></td><td>{record.status === "VOID" ? "—" : <button type="button" className="fixed-cost-void-button" disabled={inactive || Boolean(voidingId)} onClick={() => void voidRecord(record)}><Ban size={14}/>{voidingId === record.id ? "Đang hủy..." : "Hủy phiếu"}</button>}</td></tr>) : <tr><td colSpan={8} className="empty-cell">Chưa có lịch sử chi phí cố định.</td></tr>}</tbody></table></div>
      <div className="fixed-cost-history-pagination"><span>Đã hiển thị {records.length}/{historyTotal} phiếu</span>{nextCursor ? <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Đang tải..." : "Tải thêm lịch sử"}</button> : <b>Đã tải hết lịch sử</b>}</div>
    </section>
  </div>;
}
