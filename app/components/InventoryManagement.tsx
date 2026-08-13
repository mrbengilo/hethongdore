"use client";

import { FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banknote, ChevronDown, ChevronRight, Download, PackageOpen, Plus, ReceiptText, Save, Trash2, Truck } from "lucide-react";
import { formatDateVn } from "../lib/format";
import { DatePickerControl } from "./DatePickerControl";

type InventoryStore = {
  id: string;
  name: string;
  status?: string;
};

type DraftInventoryItem = {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  weight: string;
  unitPrice: string;
  shipping: string;
};

type InventoryItem = {
  name: string;
  quantity: number;
  unit: string;
  weight: number;
  unitPrice: number;
  shipping: number;
  amount: number;
};

type InventoryReceipt = {
  id: string;
  receiptNo: string;
  title: string;
  date: string;
  period: string;
  note: string;
  items: InventoryItem[];
  createdAt: string;
  updatedAt: string;
};

type InventoryHistorySummary = {
  receiptCount: number;
  itemLines: number;
  quantity: number;
  weight: number;
  goods: number;
  shipping: number;
  amount: number;
};

type DraftField = Exclude<keyof DraftInventoryItem, "id">;

const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";
const EMPTY_HISTORY_SUMMARY: InventoryHistorySummary = {
  receiptCount: 0,
  itemLines: 0,
  quantity: 0,
  weight: 0,
  goods: 0,
  shipping: 0,
  amount: 0,
};
let draftSequence = 0;

function createDraftItem(): DraftInventoryItem {
  draftSequence += 1;
  return {
    id: `inventory-draft-${draftSequence}`,
    name: "",
    quantity: "1",
    unit: "Bao",
    weight: "",
    unitPrice: "",
    shipping: "0",
  };
}

function todayInVietnam() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: VIETNAM_TIME_ZONE }).format(new Date());
}

function formatMoney(value: number) {
  const safeValue = Number.isFinite(value) ? Math.round(value) : 0;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(safeValue)} đồng`;
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(Number.isFinite(value) ? value : 0);
}

function moneyDigits(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

function formatMoneyInput(value: string) {
  const digits = moneyDigits(value);
  return digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "";
}

function formatTimestamp(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: VIETNAM_TIME_ZONE,
  }).format(new Date(value));
}

function localDateFromTimestamp(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: VIETNAM_TIME_ZONE }).format(new Date(value));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown) {
  const parsed = Number(typeof value === "string" ? value.replaceAll(",", "") : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function InventoryMetric({ icon: Icon, label, value, tone = "" }: { icon: typeof PackageOpen; label: string; value: string; tone?: string }) {
  return <article className={`ref-metric ${tone}`}><i><Icon size={23}/></i><div><span>{label}</span><strong>{value}</strong></div></article>;
}

function calculateLineGoods(weight: number, unitPrice: number) {
  const amount = Math.round(weight * unitPrice);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function calculateDraftAmount(item: DraftInventoryItem) {
  const goods = calculateLineGoods(finiteNumber(item.weight), finiteNumber(item.unitPrice));
  const shipping = Math.max(0, Math.round(finiteNumber(item.shipping)));
  const amount = goods + shipping;
  return Number.isSafeInteger(amount) ? amount : 0;
}

function normalizeItem(value: unknown, fallbackName = ""): InventoryItem {
  const raw = asObject(value);
  const weight = Math.max(0, finiteNumber(raw.weight));
  const unitPrice = Math.max(0, Math.round(finiteNumber(raw.unitPrice)));
  const shipping = Math.max(0, Math.round(finiteNumber(raw.shipping)));
  const calculatedAmount = calculateLineGoods(weight, unitPrice) + shipping;
  const parsedStoredAmount = Number(raw.amount);
  const hasStoredAmount = raw.amount != null && Number.isFinite(parsedStoredAmount);
  const storedAmount = Math.round(parsedStoredAmount);
  return {
    name: String(raw.name ?? fallbackName).trim(),
    quantity: Math.max(0, Math.round(finiteNumber(raw.quantity))),
    unit: String(raw.unit ?? "Bao").trim() || "Bao",
    weight,
    unitPrice,
    shipping,
    amount: hasStoredAmount && Number.isSafeInteger(storedAmount) && storedAmount >= 0 ? storedAmount : calculatedAmount,
  };
}

function normalizeReceipt(value: unknown): InventoryReceipt | null {
  const row = asObject(value);
  const id = String(row.id ?? "").trim();
  if (!id) return null;

  const data = asObject(row.data);
  let items = Array.isArray(data.items) ? data.items.flatMap((item) => {
    const rawItem = asObject(item);
    return Object.keys(rawItem).length > 0 ? [normalizeItem(rawItem)] : [];
  }) : [];

  // Keep previously saved, single-item NHAP_HANG records readable as one receipt.
  if (items.length === 0 && (data.weight != null || data.quantity != null || data.unitPrice != null)) {
    items = [normalizeItem(data, String(row.title ?? ""))];
  }

  const createdAt = String(row.created_at ?? row.updated_at ?? "");
  const updatedAt = String(row.updated_at ?? createdAt);
  const savedAt = String(data.savedAt ?? createdAt);
  const date = String(data.date ?? localDateFromTimestamp(createdAt));
  return {
    id,
    receiptNo: String(data.receiptNo ?? `PN-${id.slice(0, 8).toUpperCase()}`),
    title: String(row.title ?? "Phiếu nhập hàng"),
    date,
    period: String(data.period ?? date.slice(0, 7)),
    note: String(data.note ?? ""),
    items,
    createdAt: savedAt,
    updatedAt,
  };
}

function itemGoodsAmount(item: InventoryItem) {
  return Math.max(0, item.amount - item.shipping);
}

function receiptTotals(items: InventoryItem[]) {
  return items.reduce((totals, item) => ({
    itemLines: totals.itemLines + 1,
    quantity: totals.quantity + item.quantity,
    weight: totals.weight + item.weight,
    goods: totals.goods + itemGoodsAmount(item),
    shipping: totals.shipping + item.shipping,
    amount: totals.amount + item.amount,
  }), { itemLines: 0, quantity: 0, weight: 0, goods: 0, shipping: 0, amount: 0 });
}

function summarizeReceipts(receipts: InventoryReceipt[]): InventoryHistorySummary {
  return receipts.reduce<InventoryHistorySummary>((summary, receipt) => {
    const totals = receiptTotals(receipt.items);
    return {
      receiptCount: summary.receiptCount + 1,
      itemLines: summary.itemLines + totals.itemLines,
      quantity: summary.quantity + totals.quantity,
      weight: summary.weight + totals.weight,
      goods: summary.goods + totals.goods,
      shipping: summary.shipping + totals.shipping,
      amount: summary.amount + totals.amount,
    };
  }, EMPTY_HISTORY_SUMMARY);
}

function normalizeHistorySummary(value: unknown, fallback: InventoryHistorySummary): InventoryHistorySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const source = value as Record<string, unknown>;
  const number = (field: keyof InventoryHistorySummary) => Math.max(0, finiteNumber(source[field]));
  return {
    receiptCount: Math.round(number("receiptCount")),
    itemLines: Math.round(number("itemLines")),
    quantity: number("quantity"),
    weight: number("weight"),
    goods: Math.round(number("goods")),
    shipping: Math.round(number("shipping")),
    amount: Math.round(number("amount")),
  };
}

function exportInventoryCsv(store: InventoryStore, receipts: InventoryReceipt[]) {
  const cell = (value: string | number) => {
    const raw = String(value);
    const protectedValue = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${protectedValue.replaceAll('"', '""')}"`;
  };
  const rows: Array<Array<string | number>> = [[
    "Thời điểm lưu", "Ngày nhập", "Mã phiếu", "STT", "Tên hàng hóa", "Số lượng",
    "Đơn vị", "Cân nặng (kg)", "Đơn giá nhập/kg", "Giá hàng", "Phí vận chuyển",
    "Thành tiền dòng", "Tổng phiếu", "Ghi chú",
  ]];

  for (const receipt of receipts) {
    const totals = receiptTotals(receipt.items);
    receipt.items.forEach((item, index) => rows.push([
      formatTimestamp(receipt.createdAt), receipt.date, receipt.receiptNo,
      index + 1, item.name, item.quantity, item.unit, item.weight, item.unitPrice,
      itemGoodsAmount(item), item.shipping, item.amount, totals.amount, receipt.note,
    ]));
  }

  const content = "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `lich-su-nhap-hang-${store.id}-${todayInVietnam()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function StoreInventoryManagement({ store }: { store: InventoryStore }) {
  const pendingSave = useRef<{ fingerprint: string; clientRequestId: string } | null>(null);
  const [items, setItems] = useState<DraftInventoryItem[]>(() => [createDraftItem()]);
  const [date, setDate] = useState(todayInVietnam());
  const [note, setNote] = useState("");
  const [receipts, setReceipts] = useState<InventoryReceipt[]>([]);
  const [historySummary, setHistorySummary] = useState<InventoryHistorySummary>(EMPTY_HISTORY_SUMMARY);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [formError, setFormError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [success, setSuccess] = useState("");
  const inactive = store.status === "INACTIVE";

  const reloadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError("");
    setReceipts([]);
    setHistorySummary(EMPTY_HISTORY_SUMMARY);
    try {
      const query = new URLSearchParams({ category: "NHAP_HANG", storeId: store.id });
      const response = await fetch(`/api/records?${query.toString()}`);
      const result = await response.json().catch(() => ({})) as { records?: unknown[]; historySummary?: unknown; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể tải lịch sử nhập hàng.");
      const normalized = (result.records ?? [])
        .map(normalizeReceipt)
        .filter((record): record is InventoryReceipt => record !== null)
        .sort((first, second) => (Date.parse(second.createdAt) || 0) - (Date.parse(first.createdAt) || 0));
      setReceipts(normalized);
      setHistorySummary(normalizeHistorySummary(result.historySummary, summarizeReceipts(normalized)));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Không thể tải lịch sử nhập hàng.");
    } finally {
      setLoadingHistory(false);
    }
  }, [store.id]);

  useEffect(() => { void reloadHistory(); }, [reloadHistory]);

  async function exportAllHistory() {
    setExporting(true);
    setHistoryError("");
    try {
      const query = new URLSearchParams({ category: "NHAP_HANG", storeId: store.id, all: "1" });
      const response = await fetch(`/api/records?${query.toString()}`);
      const result = await response.json().catch(() => ({})) as { records?: unknown[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể tải đầy đủ lịch sử để xuất CSV.");
      const allReceipts = (result.records ?? [])
        .map(normalizeReceipt)
        .filter((record): record is InventoryReceipt => record !== null)
        .sort((first, second) => (Date.parse(second.createdAt) || 0) - (Date.parse(first.createdAt) || 0));
      exportInventoryCsv(store, allReceipts);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Không thể xuất lịch sử nhập hàng.");
    } finally {
      setExporting(false);
    }
  }

  const draftTotals = useMemo(() => items.reduce((totals, item) => {
    const weight = Math.max(0, finiteNumber(item.weight));
    const unitPrice = Math.max(0, finiteNumber(item.unitPrice));
    const shipping = Math.max(0, Math.round(finiteNumber(item.shipping)));
    const goods = calculateLineGoods(weight, unitPrice);
    return {
      quantity: totals.quantity + Math.max(0, Math.round(finiteNumber(item.quantity))),
      weight: totals.weight + weight,
      goods: totals.goods + goods,
      shipping: totals.shipping + shipping,
      amount: totals.amount + goods + shipping,
    };
  }, { quantity: 0, weight: 0, goods: 0, shipping: 0, amount: 0 }), [items]);

  function updateItem(id: string, field: DraftField, value: string) {
    const nextValue = field === "unitPrice" || field === "shipping" ? moneyDigits(value) : value;
    setItems((current) => current.map((item) => item.id === id ? { ...item, [field]: nextValue } : item));
    setFormError("");
    setSuccess("");
  }

  function addItem() {
    if (items.length >= 100) return setFormError("Mỗi phiếu nhập được có tối đa 100 mặt hàng.");
    setItems((current) => [...current, createDraftItem()]);
    setFormError("");
    setSuccess("");
  }

  function removeItem(id: string) {
    setItems((current) => current.length > 1 ? current.filter((item) => item.id !== id) : current);
  }

  function validateDraft() {
    if (!date) return "Vui lòng chọn ngày nhập hàng.";
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const quantity = Number(item.quantity);
      const weight = Number(item.weight);
      const unitPrice = Number(item.unitPrice);
      const shipping = Number(item.shipping || 0);
      if (!item.name.trim()) return `Dòng ${index + 1}: vui lòng nhập tên hàng hóa.`;
      if (!Number.isInteger(quantity) || quantity <= 0) return `Dòng ${index + 1}: số lượng phải là số nguyên dương.`;
      if (!item.unit.trim()) return `Dòng ${index + 1}: vui lòng chọn đơn vị.`;
      if (!Number.isFinite(weight) || weight <= 0) return `Dòng ${index + 1}: cân nặng phải lớn hơn 0.`;
      if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0) return `Dòng ${index + 1}: đơn giá phải là số nguyên dương.`;
      if (!Number.isSafeInteger(shipping) || shipping < 0) return `Dòng ${index + 1}: phí vận chuyển phải là số nguyên không âm.`;
      const goodsAmount = Math.round(weight * unitPrice);
      if (!Number.isSafeInteger(goodsAmount) || !Number.isSafeInteger(goodsAmount + shipping)) return `Dòng ${index + 1}: thành tiền vượt giới hạn cho phép.`;
    }
    return "";
  }

  async function saveReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setSuccess("");
    if (inactive) return setFormError("Cửa hàng đang ngưng hoạt động, không thể tạo phiếu nhập.");
    const validationMessage = validateDraft();
    if (validationMessage) return setFormError(validationMessage);

    const payloadItems: InventoryItem[] = items.map((item) => ({
      name: item.name.trim(),
      quantity: Number(item.quantity),
      unit: item.unit.trim() || "Bao",
      weight: Number(item.weight),
      unitPrice: Number(item.unitPrice),
      shipping: Number(item.shipping || 0),
      amount: calculateDraftAmount(item),
    }));
    const fingerprint = JSON.stringify({ date, note: note.trim(), items: payloadItems });
    if (pendingSave.current?.fingerprint !== fingerprint) {
      pendingSave.current = { fingerprint, clientRequestId: crypto.randomUUID() };
    }
    const clientRequestId = pendingSave.current.clientRequestId;

    setSaving(true);
    try {
      const response = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "NHAP_HANG",
          storeId: store.id,
          title: `Phiếu nhập ${date} · ${payloadItems.length} mặt hàng`,
          data: { date, period: date.slice(0, 7), clientRequestId, note: note.trim(), items: payloadItems },
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể lưu phiếu nhập hàng.");

      // Reset only after the server confirms that the complete receipt was saved.
      setItems([createDraftItem()]);
      setDate(todayInVietnam());
      setNote("");
      pendingSave.current = null;
      setSuccess(result.message ?? "Đã lưu phiếu nhập hàng và ghi nhận vào lịch sử.");
      await reloadHistory();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Không thể lưu phiếu nhập hàng.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="reference-module inventory-management">
    <div className="ref-toolbar">
      <div>
        <h2>Nhập hàng</h2>
        <p>Lập phiếu nhập nhiều mặt hàng cho {store.name}</p>
      </div>
    </div>

    {inactive && <div className="form-message">Cửa hàng đang ngưng hoạt động. Lịch sử vẫn xem và xuất được nhưng không thể tạo phiếu mới.</div>}

    <div className="ref-metrics four inventory-draft-metrics" aria-label="Tổng hợp lịch sử nhập hàng đã lưu">
      <InventoryMetric icon={PackageOpen} label="Tổng mặt hàng đã nhập" value={loadingHistory ? "Đang tải..." : `${historySummary.itemLines} mặt hàng`}/>
      <InventoryMetric icon={Truck} label="Tổng chi phí vận chuyển" value={loadingHistory ? "Đang tải..." : formatMoney(historySummary.shipping)} tone="blue"/>
      <InventoryMetric icon={Banknote} label="Tổng tiền nhập hàng" value={loadingHistory ? "Đang tải..." : formatMoney(historySummary.goods)} tone="purple"/>
      <InventoryMetric icon={ReceiptText} label="Tổng cộng đã nhập" value={loadingHistory ? "Đang tải..." : formatMoney(historySummary.amount)} tone="orange"/>
    </div>

    <form className="table-card inventory-receipt-form" onSubmit={saveReceipt}>
      <div className="table-head">
        <div>
          <h2>Phiếu nhập hàng mới</h2>
          <p>Danh sách nháp luôn được giữ lại cho đến khi lưu thành công.</p>
        </div>
        <div className="inventory-date-field">
          <span>Ngày nhập</span>
          <DatePickerControl ariaLabel="Ngày nhập hàng" required disabled={inactive || saving} value={date} onChange={setDate}/>
        </div>
      </div>

      <fieldset className="inventory-draft-fieldset" disabled={inactive || saving}>
        <p id="inventory-draft-scroll-hint" className="inventory-scroll-hint">Vuốt ngang bảng để xem và nhập đầy đủ các cột.</p>
        <div className="data-table-wrap inventory-table-scroll" role="region" aria-label="Danh sách hàng hóa trong phiếu nhập" aria-describedby="inventory-draft-scroll-hint">
          <table className="data-table inventory-draft-table">
            <thead><tr>
              <th>STT</th><th>Tên hàng hóa</th><th>Số lượng</th><th>Đơn vị</th>
              <th>Cân nặng (kg)</th><th>Đơn giá nhập/kg</th><th>Phí vận chuyển</th>
              <th>Thành tiền</th><th>Thao tác</th>
            </tr></thead>
            <tbody>{items.map((item, index) => <tr key={item.id}>
              <td>{index + 1}</td>
              <td><input aria-label={`Tên hàng hóa dòng ${index + 1}`} required value={item.name} onChange={(event) => updateItem(item.id, "name", event.target.value)} placeholder="Tên hàng hóa"/></td>
              <td><input aria-label={`Số lượng dòng ${index + 1}`} type="number" min="1" step="1" required value={item.quantity} onChange={(event) => updateItem(item.id, "quantity", event.target.value)}/></td>
              <td><select aria-label={`Đơn vị dòng ${index + 1}`} value={item.unit} onChange={(event) => updateItem(item.id, "unit", event.target.value)}><option>Bao</option><option>Kiện</option><option>Thùng</option><option>Cái</option></select></td>
              <td><input aria-label={`Cân nặng dòng ${index + 1}`} type="number" min="0.01" step="0.01" required value={item.weight} onChange={(event) => updateItem(item.id, "weight", event.target.value)}/></td>
              <td><input aria-label={`Đơn giá dòng ${index + 1}`} inputMode="numeric" pattern="[0-9,]*" required value={formatMoneyInput(item.unitPrice)} onChange={(event) => updateItem(item.id, "unitPrice", event.target.value)} placeholder="0"/></td>
              <td><input aria-label={`Phí vận chuyển dòng ${index + 1}`} inputMode="numeric" pattern="[0-9,]*" required value={formatMoneyInput(item.shipping)} onChange={(event) => updateItem(item.id, "shipping", event.target.value)} placeholder="0"/></td>
              <td><b>{formatMoney(calculateDraftAmount(item))}</b></td>
              <td><button type="button" disabled={items.length === 1} onClick={() => removeItem(item.id)} aria-label={`Xóa dòng ${index + 1}`}><Trash2 size={16}/></button></td>
            </tr>)}</tbody>
            <tfoot><tr>
              <td colSpan={2}><b>Tổng phiếu · {items.length} mặt hàng</b></td>
              <td>{formatNumber(draftTotals.quantity)}</td><td>—</td>
              <td>{formatNumber(draftTotals.weight)} kg</td>
              <td>{formatMoney(draftTotals.goods)}</td>
              <td>{formatMoney(draftTotals.shipping)}</td>
              <td><b>{formatMoney(draftTotals.amount)}</b></td><td/>
            </tr></tfoot>
          </table>
        </div>
        <div className="inventory-add-item-actions">
          <button type="button" disabled={inactive || saving || items.length >= 100} onClick={addItem}>
            <Plus size={17}/> Thêm hàng hóa
          </button>
        </div>
        <div className="inventory-note-field">
          <label>Ghi chú<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ghi chú chung cho phiếu nhập"/></label>
        </div>
      </fieldset>

      {formError && <div className="form-message inventory-form-feedback">{formError}</div>}
      {success && <div className="success-banner inventory-form-feedback">{success}</div>}
      <div className="inventory-save-actions">
        <button className="primary-button" disabled={inactive || saving}>
          <Save size={17}/> {saving ? "ĐANG LƯU..." : "LƯU PHIẾU"}
        </button>
      </div>
    </form>

    <section className="table-card inventory-history-card">
      <div className="table-head">
        <div>
          <h2>Lịch sử nhập hàng theo phiếu</h2>
          <p>{receipts.length < historySummary.receiptCount
            ? `${receipts.length} phiếu gần nhất · ${historySummary.receiptCount} phiếu đã ghi nhận`
            : `${historySummary.receiptCount} phiếu đã ghi nhận`}</p>
        </div>
        <button type="button" disabled={historySummary.receiptCount === 0 || exporting} onClick={() => void exportAllHistory()}>
          <Download size={16}/> {exporting ? "Đang chuẩn bị..." : "Xuất CSV"}
        </button>
      </div>
      {historyError && <div className="form-message" style={{ margin: 20 }}>{historyError}</div>}
      <p id="inventory-history-scroll-hint" className="inventory-scroll-hint">Vuốt ngang bảng để xem đầy đủ lịch sử phiếu.</p>
      <div className="data-table-wrap inventory-table-scroll" role="region" aria-label="Lịch sử nhập hàng theo phiếu" aria-describedby="inventory-history-scroll-hint">
        <table className="data-table inventory-history-table">
          <thead><tr>
            <th>Thời điểm lưu</th><th>Ngày nhập</th><th>Mã phiếu</th><th>Tổng hàng</th>
            <th>Khối lượng</th><th>Giá hàng</th><th>Vận chuyển</th><th>Tổng cộng</th>
            <th>Ghi chú</th><th>Chi tiết</th>
          </tr></thead>
          <tbody>
            {loadingHistory ? <tr><td colSpan={10} className="empty-cell">Đang tải lịch sử nhập hàng...</td></tr> : receipts.length === 0 ? <tr><td colSpan={10} className="empty-cell"><PackageOpen size={22}/> Chưa có phiếu nhập hàng.</td></tr> : receipts.map((receipt) => {
              const totals = receiptTotals(receipt.items);
              const expanded = expandedId === receipt.id;
              return <Fragment key={receipt.id}>
                <tr>
                  <td>{formatTimestamp(receipt.createdAt)}</td>
                  <td>{formatDateVn(receipt.date)}</td>
                  <td><b>{receipt.receiptNo}</b></td>
                  <td><b>{totals.itemLines} mặt hàng</b><small style={{ display: "block" }}>{formatNumber(totals.quantity)} đơn vị</small></td>
                  <td>{formatNumber(totals.weight)} kg</td>
                  <td>{formatMoney(totals.goods)}</td>
                  <td>{formatMoney(totals.shipping)}</td>
                  <td className="money-green"><b>{formatMoney(totals.amount)}</b></td>
                  <td>{receipt.note || "—"}</td>
                  <td><button type="button" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : receipt.id)}>{expanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>} {expanded ? "Thu gọn" : "Xem"}</button></td>
                </tr>
                {expanded && <tr>
                  <td colSpan={10} style={{ padding: 0, background: "#f8faf8" }}>
                    {/* A scrollable region must be keyboard-focusable so its off-screen columns remain reachable. */}
                    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
                    <div className="data-table-wrap inventory-table-scroll" role="region" tabIndex={0} aria-label={`Chi tiết phiếu nhập ${receipt.receiptNo}`}>
                      <table className="data-table inventory-history-detail-table">
                        <thead><tr><th>STT</th><th>Tên hàng hóa</th><th>Số lượng</th><th>Đơn vị</th><th>Cân nặng</th><th>Đơn giá nhập/kg</th><th>Giá hàng</th><th>Phí vận chuyển</th><th>Thành tiền</th></tr></thead>
                        <tbody>{receipt.items.map((item, index) => <tr key={`${receipt.id}-${index}`}>
                          <td>{index + 1}</td><td><b>{item.name || "—"}</b></td><td>{formatNumber(item.quantity)}</td><td>{item.unit}</td>
                          <td>{formatNumber(item.weight)} kg</td><td>{formatMoney(item.unitPrice)}</td><td>{formatMoney(itemGoodsAmount(item))}</td>
                          <td>{formatMoney(item.shipping)}</td><td className="money-green"><b>{formatMoney(item.amount)}</b></td>
                        </tr>)}</tbody>
                      </table>
                    </div>
                  </td>
                </tr>}
              </Fragment>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}
