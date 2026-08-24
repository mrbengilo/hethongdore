"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Pencil, Plus, ReceiptText, RefreshCw, Trash2, WalletCards, X } from "lucide-react";
import { formatVndInput, parseVndInput } from "../lib/format";
import { useAccessibleModal } from "./useAccessibleModal";
import styles from "./MonthEndExpensePanel.module.css";

type ExpenseStore = { id: string; name: string; status?: string };

type MonthEndExpense = {
  id: string;
  storeId: string;
  period: string;
  title: string;
  category: string;
  amount: number;
  note: string | null;
  status: "ACTIVE" | "VOID";
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  voidedBy: string | null;
  voidedAt: string | null;
};

type ExpenseResponse = {
  storeId?: string;
  period?: string;
  locked?: boolean;
  expenses?: MonthEndExpense[];
  items?: MonthEndExpense[];
  total?: number;
  message?: string;
};

type DialogMode = "CREATE" | "EDIT" | "VOID" | null;

const CATEGORIES = [
  ["RESERVE", "Dự phòng"],
  ["SHRINKAGE", "Hao hụt"],
  ["LOSS", "Thất thoát"],
  ["INVENTORY_ADJUSTMENT", "Điều chỉnh tồn kho"],
  ["ADMINISTRATION", "Chi phí quản trị"],
  ["PERIOD_DEDUCTION", "Khấu trừ cuối kỳ"],
  ["SUPPLEMENTAL", "Chi phí bổ sung"],
  ["UNRECORDED", "Chi phí chưa được ghi nhận"],
  ["OTHER", "Khác"],
] as const;

const categoryLabels = new Map<string, string>(CATEGORIES);
const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

function money(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value || 0))} đồng`;
}

function dateTime(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VIETNAM_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function csvDownload(filename: string, rows: Array<Array<string | number>>) {
  const cell = (value: string | number) => {
    const raw = String(value);
    const protectedValue = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
    return `"${protectedValue.replaceAll('"', '""')}"`;
  };
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function MonthEndExpensePanel({ store, period, onChanged }: {
  store: ExpenseStore;
  period: string;
  onChanged?: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<MonthEndExpense[]>([]);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<DialogMode>(null);
  const [selected, setSelected] = useState<MonthEndExpense | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0][0]);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const requestIdRef = useRef("");
  const loadControllerRef = useRef<AbortController | null>(null);
  const scopeRef = useRef(`${store.id}:${period}`);
  const modalRootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const titleFocusRef = useRef<HTMLInputElement>(null);
  const reasonFocusRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement>(null);
  const inactive = store.status === "INACTIVE";

  const load = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const scope = `${store.id}:${period}`;
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ storeId: store.id, period });
      const response = await fetch(`/api/month-end-expenses?${params}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json().catch(() => ({})) as ExpenseResponse;
      if (!response.ok) throw new Error(result.message || "Không thể tải chi phí cuối kỳ.");
      if (scopeRef.current !== scope || controller.signal.aborted) return;
      setItems(result.expenses ?? result.items ?? []);
      setLocked(Boolean(result.locked));
    } catch (error) {
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      setSuccess(false);
      setMessage(error instanceof Error ? error.message : "Không thể tải chi phí cuối kỳ.");
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
      if (scopeRef.current === scope && !controller.signal.aborted) setLoading(false);
    }
  }, [period, store.id]);

  useEffect(() => {
    scopeRef.current = `${store.id}:${period}`;
    setMode(null);
    setSelected(null);
    void load();
    return () => loadControllerRef.current?.abort();
  }, [load, period, store.id]);

  const dismiss = useCallback(() => {
    if (busy) return;
    setMode(null);
    setSelected(null);
  }, [busy]);

  useAccessibleModal({
    open: mode !== null,
    rootRef: modalRootRef,
    dialogRef,
    initialFocusRef: mode === "VOID" ? reasonFocusRef : titleFocusRef,
    returnFocusRef,
    onDismiss: dismiss,
    dismissDisabled: busy,
  });

  const activeItems = useMemo(() => items.filter((item) => item.status === "ACTIVE"), [items]);
  const total = useMemo(() => activeItems.reduce((sum, item) => sum + Number(item.amount || 0), 0), [activeItems]);
  const readonly = inactive || locked;

  function rememberTrigger() {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function beginCreate() {
    if (readonly) return;
    rememberTrigger();
    setSelected(null);
    setTitle("");
    setCategory(CATEGORIES[0][0]);
    setAmount("");
    setNote("");
    setReason("");
    requestIdRef.current = crypto.randomUUID();
    setMode("CREATE");
  }

  function beginEdit(item: MonthEndExpense) {
    if (readonly || item.status !== "ACTIVE") return;
    rememberTrigger();
    setSelected(item);
    setTitle(item.title);
    setCategory(item.category);
    setAmount(formatVndInput(item.amount));
    setNote(item.note ?? "");
    setReason("");
    setMode("EDIT");
  }

  function beginVoid(item: MonthEndExpense) {
    if (readonly || item.status !== "ACTIVE") return;
    rememberTrigger();
    setSelected(item);
    setReason("");
    setMode("VOID");
  }

  async function mutate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode || busy || readonly) return;
    const parsedAmount = parseVndInput(amount);
    if (mode !== "VOID") {
      if (title.trim().length < 2 || title.trim().length > 120) return setMessage("Tên khoản chi phải từ 2 đến 120 ký tự.");
      if (!categoryLabels.has(category)) return setMessage("Loại chi phí cuối kỳ không hợp lệ.");
      if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) return setMessage("Số tiền phải là số nguyên VND dương.");
      if (note.trim().length < 2 || note.trim().length > 500) return setMessage("Ghi chú phải từ 2 đến 500 ký tự.");
    }
    if (mode !== "CREATE" && (reason.trim().length < 5 || reason.trim().length > 500)) {
      return setMessage("Vui lòng nhập lý do thay đổi từ 5 đến 500 ký tự.");
    }

    const mutationScope = scopeRef.current;
    setBusy(true);
    setSuccess(false);
    setMessage("");
    try {
      const creating = mode === "CREATE";
      const response = await fetch("/api/month-end-expenses", {
        method: creating ? "POST" : mode === "EDIT" ? "PATCH" : "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(creating ? { "Idempotency-Key": requestIdRef.current } : {}),
        },
        body: JSON.stringify(creating ? {
          storeId: store.id,
          period,
          title: title.trim(),
          category,
          amount: parsedAmount,
          note: note.trim(),
          clientRequestId: requestIdRef.current,
        } : mode === "EDIT" ? {
          id: selected?.id,
          storeId: store.id,
          version: selected?.version,
          title: title.trim(),
          category,
          amount: parsedAmount,
          note: note.trim(),
          reason: reason.trim(),
        } : {
          id: selected?.id,
          storeId: store.id,
          version: selected?.version,
          reason: reason.trim(),
        }),
      });
      const result = await response.json().catch(() => ({})) as ExpenseResponse;
      if (!response.ok) throw new Error(result.message || "Không thể cập nhật chi phí cuối kỳ.");
      if (scopeRef.current !== mutationScope) return;
      setMode(null);
      setSelected(null);
      setSuccess(true);
      setMessage(`✓ ${result.message || "Đã cập nhật chi phí cuối kỳ."}`);
      await load();
      if (scopeRef.current === mutationScope) await onChanged?.();
    } catch (error) {
      if (scopeRef.current !== mutationScope) return;
      setSuccess(false);
      setMessage(error instanceof Error ? error.message : "Không thể cập nhật chi phí cuối kỳ.");
    } finally {
      if (scopeRef.current === mutationScope) setBusy(false);
    }
  }

  function exportCsv() {
    csvDownload(`chi-phi-cuoi-ky-${store.id}-${period}.csv`, [
      ["Kỳ", "Tên khoản chi", "Loại", "Số tiền", "Ghi chú", "Trạng thái", "Tạo lúc", "Cập nhật lúc"],
      ...items.map((item) => [item.period, item.title, categoryLabels.get(item.category) ?? item.category, item.amount, item.note ?? "", item.status, dateTime(item.createdAt), dateTime(item.updatedAt)]),
      ["", "TỔNG ĐANG HIỆU LỰC", "", total, "", "", "", ""],
    ]);
  }

  return <section className={styles.panel} aria-labelledby="month-end-expense-title">
    <header className={styles.header}>
      <div>
        <h2 id="month-end-expense-title">CHI PHÍ CUỐI KỲ HÀNG THÁNG</h2>
        <p>Khoản điều chỉnh sau KPI, được trừ đúng một lần trước khi xác định lợi nhuận sau cùng.</p>
      </div>
      <div className={styles.headerActions}>
        <button type="button" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={16}/> Làm mới</button>
        <button type="button" onClick={exportCsv} disabled={!items.length}><Download size={16}/> Xuất CSV</button>
        <button type="button" className={styles.primaryButton} onClick={beginCreate} disabled={readonly || loading || busy}><Plus size={17}/> TẠO CHI PHÍ CUỐI KỲ</button>
      </div>
    </header>

    {readonly ? <p className={styles.lockedNotice}>{inactive ? "Cửa hàng đang ngưng hoạt động; lịch sử chỉ còn chế độ xem." : "Kỳ đã xác nhận, đã chi hoặc đã khóa; dữ liệu nguồn không thể thay đổi."}</p> : null}
    {message && mode === null ? <p className={success ? styles.success : styles.error} role={success ? "status" : "alert"}>{message}</p> : null}

    <div className={styles.metrics}>
      <article><WalletCards/><span>TỔNG CHI PHÍ CUỐI KỲ</span><strong>{money(total)}</strong></article>
      <article><ReceiptText/><span>SỐ KHOẢN ĐANG HIỆU LỰC</span><strong>{activeItems.length} khoản</strong></article>
      <article><ReceiptText/><span>KỲ ÁP DỤNG</span><strong>{period.split("-").reverse().join("/")}</strong></article>
    </div>

    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus lets users scroll the wide month-end expense table. */}
    <div className={styles.tableWrap} role="region" tabIndex={0} aria-label="Danh sách chi phí cuối kỳ, có thể cuộn ngang">
      <table className={styles.table}>
        <thead><tr><th>STT</th><th>Khoản chi</th><th>Loại</th><th>Số tiền</th><th>Ghi chú</th><th>Thời gian</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={8} className={styles.empty}>Đang tải chi phí cuối kỳ…</td></tr>
            : items.length ? items.map((item, index) => <tr key={item.id} className={item.status === "VOID" ? styles.voidRow : undefined}>
              <td data-label="STT">{index + 1}</td>
              <td data-label="Khoản chi"><b>{item.title}</b><small>Phiên bản {item.version}</small></td>
              <td data-label="Loại">{categoryLabels.get(item.category) ?? item.category}</td>
              <td data-label="Số tiền"><strong className={styles.amount}>{money(item.amount)}</strong></td>
              <td data-label="Ghi chú" className={styles.note}>{item.note || "—"}</td>
              <td data-label="Thời gian"><time dateTime={item.updatedAt}>{dateTime(item.updatedAt)}</time><small>Tạo: {dateTime(item.createdAt)}</small></td>
              <td data-label="Trạng thái"><span className={item.status === "ACTIVE" ? styles.active : styles.void}>{item.status === "ACTIVE" ? "Hiệu lực" : "Đã hủy"}</span></td>
              <td data-label="Thao tác"><div className={styles.actions}>
                {item.status === "ACTIVE" ? <>
                  <button type="button" disabled={readonly || busy} onClick={() => beginEdit(item)}><Pencil size={15}/><span>Sửa</span></button>
                  <button type="button" className={styles.voidButton} disabled={readonly || busy} onClick={() => beginVoid(item)}><Trash2 size={15}/><span>Hủy</span></button>
                </> : <span>Chỉ xem</span>}
              </div></td>
            </tr>) : <tr><td colSpan={8} className={styles.empty}>Chưa có chi phí cuối kỳ trong tháng này.</td></tr>}
        </tbody>
      </table>
    </div>

    {mode ? <div ref={modalRootRef} className={styles.backdrop}>
      <form ref={dialogRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="month-end-dialog-title" tabIndex={-1} aria-busy={busy} onSubmit={mutate}>
        <header><div><h2 id="month-end-dialog-title">{mode === "CREATE" ? "Tạo chi phí cuối kỳ" : mode === "EDIT" ? "Sửa chi phí cuối kỳ" : "Hủy chi phí cuối kỳ"}</h2><p>{store.name} · Kỳ {period}</p></div><button type="button" aria-label="Đóng" onClick={dismiss} disabled={busy}><X size={19}/></button></header>
        {mode === "VOID" ? <div className={styles.voidSummary}><span>Khoản sẽ hủy</span><b>{selected?.title}</b><strong>{money(selected?.amount ?? 0)}</strong></div> : <>
          <label>Tên khoản chi<input ref={titleFocusRef} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} required/></label>
          <div className={styles.formGrid}>
            <label>Loại chi phí<select value={category} onChange={(event) => setCategory(event.target.value)}>{CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Số tiền (đồng)<input inputMode="numeric" value={amount} onChange={(event) => setAmount(formatVndInput(event.target.value))} placeholder="3,000,000" required/></label>
          </div>
          <label>Ghi chú<textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} required/></label>
        </>}
        {mode !== "CREATE" ? <label>Lý do {mode === "VOID" ? "hủy" : "chỉnh sửa"}<textarea ref={reasonFocusRef} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} required/></label> : null}
        {message && mode !== null ? <p className={styles.error} role="alert">{message}</p> : null}
        <footer><button type="button" onClick={dismiss} disabled={busy}>Đóng</button><button type="submit" className={mode === "VOID" ? styles.dangerButton : styles.primaryButton} disabled={busy}>{busy ? "Đang lưu…" : mode === "VOID" ? "XÁC NHẬN HỦY" : "LƯU"}</button></footer>
      </form>
    </div> : null}
  </section>;
}
