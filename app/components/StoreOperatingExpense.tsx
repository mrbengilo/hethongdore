"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Download, Plus, ReceiptText, RefreshCw, WalletCards, X } from "lucide-react";

type ExpenseStore = {
  id: string;
  name: string;
  status?: string;
};

type OperatingExpense = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  data: {
    date: string;
    amount: number;
    note: string;
  };
};

const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

function todayInVietnam() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: VIETNAM_TIME_ZONE }).format(new Date());
}

function money(value: number) {
  const safeValue = Number.isFinite(value) ? Math.round(value) : 0;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(safeValue)} đồng`;
}

function dateTime24(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VIETNAM_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function dateLabel(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : "—";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeExpense(value: unknown): OperatingExpense | null {
  const row = asObject(value);
  const data = asObject(row.data);
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    title: String(row.title ?? "Chi phí phát sinh").trim() || "Chi phí phát sinh",
    status: String(row.status ?? "ACTIVE"),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? ""),
    data: {
      date: String(data.date ?? ""),
      amount: Number(data.amount ?? 0),
      note: String(data.note ?? ""),
    },
  };
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const cell = (value: string | number) => {
    const raw = String(value);
    const protectedValue = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${protectedValue.replaceAll('"', '""')}"`;
  };
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function StoreOperatingExpense({ store, onSaved }: {
  store: ExpenseStore;
  onSaved?: () => void | Promise<void>;
}) {
  const [records, setRecords] = useState<OperatingExpense[]>([]);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayInVietnam);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const inactive = store.status === "INACTIVE";

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ category: "DONG_TIEN", storeId: store.id });
      const response = await fetch(`/api/records?${query.toString()}`, { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as { records?: unknown[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể tải lịch sử chi phí phát sinh.");
      setRecords((result.records ?? []).map(normalizeExpense).filter((record): record is OperatingExpense => record !== null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể tải lịch sử chi phí phát sinh.");
    } finally {
      setLoading(false);
    }
  }, [store.id]);

  useEffect(() => { void reload(); }, [reload]);

  const total = useMemo(() => records.reduce((sum, record) => {
    const value = record.data.amount;
    return Number.isFinite(value) ? sum + value : sum;
  }, 0), [records]);

  function begin() {
    setDate(todayInVietnam());
    setTitle("");
    setAmount("");
    setNote("");
    setError("");
    setMessage("");
    setOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    const parsedAmount = Number(amount);
    if (!/^\d+$/.test(amount) || !Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
      return setError("Số tiền phải là số nguyên VND dương.");
    }
    if (!date || !title.trim() || !note.trim()) return setError("Vui lòng nhập đủ ngày, loại chi phí và ghi chú.");
    if (inactive) return setError("Cửa hàng đang ngưng hoạt động, không thể tạo chi phí phát sinh.");

    setSaving(true);
    try {
      const response = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "DONG_TIEN",
          storeId: store.id,
          title: title.trim(),
          data: { date, period: date.slice(0, 7), amount: parsedAmount, note: note.trim() },
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể lưu chi phí phát sinh.");
      setOpen(false);
      setMessage("Đã lưu chi phí phát sinh và ghi nhận vào lịch sử.");
      await reload();
      await onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể lưu chi phí phát sinh.");
    } finally {
      setSaving(false);
    }
  }

  function exportHistory() {
    downloadCsv(`chi-phi-phat-sinh-${store.id}.csv`, [
      ["Ngày chi", "Loại / tên chi phí", "Số tiền", "Ghi chú", "Tạo lúc", "Cập nhật lúc"],
      ...records.map((record) => [record.data.date, record.title, record.data.amount, record.data.note, dateTime24(record.createdAt), dateTime24(record.updatedAt)]),
    ]);
  }

  return <section className="reference-module operating-expense-page">
    <div className="ref-toolbar">
      <div><h2>CHI PHÍ PHÁT SINH</h2><p>Ghi nhận từng khoản chi thực tế của {store.name}; mỗi lần lưu tạo một dòng lịch sử riêng.</p></div>
      <div className="ref-toolbar-actions">
        <button type="button" onClick={() => void reload()} disabled={loading}><RefreshCw size={16}/> Làm mới</button>
        <button type="button" onClick={exportHistory} disabled={!records.length}><Download size={16}/> Xuất CSV</button>
        <button type="button" className="primary-button" disabled={inactive} onClick={begin}><Plus size={17}/> Tạo chi phí phát sinh</button>
      </div>
    </div>

    {inactive && <div className="inactive-store-banner">Cửa hàng đang ngưng hoạt động. Lịch sử vẫn được giữ nguyên nhưng không thể tạo khoản chi mới.</div>}
    {error && !open && <div className="form-message">{error}</div>}
    {message && !open && <div className="success-banner">{message}</div>}

    <div className="comparison-grid">
      <article className="ref-metric orange"><i><WalletCards size={24}/></i><div><span>TỔNG CHI PHÍ PHÁT SINH</span><strong>{money(total)}</strong><small>{records.length} khoản đã ghi nhận</small></div></article>
      <article className="ref-metric"><i><ReceiptText size={24}/></i><div><span>LỊCH SỬ GẦN NHẤT</span><strong>{records[0] ? dateLabel(records[0].data.date) : "—"}</strong><small>{records[0] ? records[0].title : "Chưa có dữ liệu"}</small></div></article>
    </div>

    <section className="table-card">
      <div className="table-head"><div><h2>Lịch sử chi phí phát sinh</h2><p>Dữ liệu thực đã lưu, hiển thị ngày giờ theo định dạng 24 giờ.</p></div><b>{money(total)}</b></div>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Ngày chi</th><th>Loại / tên chi phí</th><th>Số tiền</th><th>Ghi chú</th><th>Tạo lúc</th><th>Cập nhật lúc</th><th>Trạng thái</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={8} className="empty-cell">Đang tải lịch sử chi phí phát sinh...</td></tr> : records.length === 0 ? <tr><td colSpan={8} className="empty-cell">Chưa có chi phí phát sinh. Chọn “Tạo chi phí phát sinh” để ghi nhận khoản đầu tiên.</td></tr> : records.map((record, index) => <tr key={record.id}><td>{index + 1}</td><td>{dateLabel(record.data.date)}</td><td><b>{record.title}</b></td><td className="money-orange"><b>{money(record.data.amount)}</b></td><td>{record.data.note || "—"}</td><td>{dateTime24(record.createdAt)}</td><td>{dateTime24(record.updatedAt)}</td><td><span className="status-pill">{record.status === "ACTIVE" ? "Đã lưu" : record.status}</span></td></tr>)}
      </tbody><tfoot><tr><td colSpan={3}>TỔNG CỘNG</td><td>{money(total)}</td><td colSpan={4}/></tr></tfoot></table></div>
    </section>

    {open && <div className="modal-backdrop"><form className="modal" onSubmit={save}>
      <div className="modal-title"><div><h2>Tạo chi phí phát sinh</h2><p>Khoản chi sẽ được ghi riêng vào lịch sử của {store.name}.</p></div><button type="button" disabled={saving} onClick={() => setOpen(false)} aria-label="Đóng"><X size={19}/></button></div>
      <div className="form-grid two">
        <label>Ngày chi *<input type="date" required value={date} onChange={(event) => setDate(event.target.value)}/></label>
        <label>Loại / tên chi phí *<input list="operating-expense-types" required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ví dụ: Sửa chữa thiết bị"/><datalist id="operating-expense-types"><option value="Marketing"/><option value="Sửa chữa"/><option value="Vật tư tiêu hao"/><option value="Phí dịch vụ"/><option value="Khác"/></datalist></label>
      </div>
      <label>Số tiền *<input type="number" inputMode="numeric" min="1" step="1" required value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Ví dụ: 15000"/><small>{money(Number(amount || 0))}</small></label>
      <label>Ghi chú *<textarea required maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Nội dung, lý do hoặc thông tin đối soát khoản chi"/></label>
      {error && <div className="form-message">{error}</div>}
      <div className="modal-actions"><button type="button" disabled={saving} onClick={() => setOpen(false)}>Hủy</button><button type="submit" className="primary-button" disabled={saving || inactive}>{saving ? "ĐANG LƯU..." : "LƯU"}</button></div>
    </form></div>}
  </section>;
}
