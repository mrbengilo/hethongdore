"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banknote, Landmark, Pencil, ReceiptText, RefreshCw, Search, ShoppingBag, Trash2, X } from "lucide-react";
import { formatDateTime24, formatMonthVn, formatVndDisplay, formatVndInput, parseVndInput } from "../lib/format";
import styles from "./StoreOrdersManagement.module.css";
import { useAccessibleModal } from "./useAccessibleModal";

type StoreOrder = {
  id: string;
  code: string;
  store_id: string;
  employee_id: string;
  shift_code: string;
  customer_name: string | null;
  phone: string | null;
  age: number | null;
  amount: number;
  payment_method: "CASH" | "BANK_TRANSFER";
  status: "COMPLETED" | "VOID";
  created_at: string;
  employeeName: string | null;
  employeeCode: string | null;
  createdByName: string | null;
  createdByCode: string | null;
  shiftSessionId: string | null;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  workDate: string | null;
  shiftStartedAt: string | null;
  shiftEndedAt: string | null;
  shiftStatus: string | null;
  period: string | null;
  locked: number;
  lastAction: string | null;
  lastUpdatedAt: string | null;
  lastUpdatedBy: string | null;
};

type OrderForm = {
  customerName: string;
  phone: string;
  age: string;
  amount: string;
  paymentMethod: "CASH" | "BANK_TRANSFER";
};

const emptyForm: OrderForm = { customerName: "", phone: "", age: "", amount: "", paymentMethod: "CASH" };
const periodLabel = (value: string) => formatMonthVn(value).replace(/^Tháng\s+/, "");

function shiftLabel(order: StoreOrder) {
  const name = order.shiftName?.trim() || order.shift_code || "Ca chưa xác định";
  return order.scheduledStart && order.scheduledEnd
    ? `${name} · ${order.scheduledStart}–${order.scheduledEnd}`
    : name;
}

function groupKey(order: StoreOrder, groupBy: "none" | "employee" | "shift") {
  if (groupBy === "employee") return `employee:${order.employee_id}`;
  if (groupBy === "shift") return `shift:${order.shiftSessionId ?? order.shift_code}`;
  return "all";
}

function groupTitle(order: StoreOrder, groupBy: "none" | "employee" | "shift") {
  if (groupBy === "employee") return `${order.employeeName || "Nhân viên không còn hoạt động"} · ${order.employeeCode || order.employee_id}`;
  if (groupBy === "shift") return shiftLabel(order);
  return "Tất cả đơn hàng";
}

export function StoreOrdersManagement({ store, period, focusedOrderId, focusRequestKey, onChanged }: {
    store: { id: string; name: string; status?: string };
    period: string;
    focusedOrderId: string | null;
    focusRequestKey: number;
    onChanged?: () => void | Promise<void>;
}) {
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [search, setSearch] = useState("");
  const [employeeId, setEmployeeId] = useState("ALL");
  const [shiftId, setShiftId] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [groupBy, setGroupBy] = useState<"none" | "employee" | "shift">("shift");
  const [editing, setEditing] = useState<StoreOrder | null>(null);
  const [form, setForm] = useState<OrderForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [dialogMessage, setDialogMessage] = useState("");
  const focusedOnce = useRef(-1);
  const editBackdropRef = useRef<HTMLDivElement | null>(null);
  const editDialogRef = useRef<HTMLElement | null>(null);
  const editTriggerRef = useRef<HTMLElement | null>(null);

  useAccessibleModal({
    open: Boolean(editing),
    rootRef: editBackdropRef,
    dialogRef: editDialogRef,
    returnFocusRef: editTriggerRef,
    dismissDisabled: saving,
    onDismiss: () => setEditing(null),
  });

  const load = useCallback(() => setReloadVersion((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ storeId: store.id, period });
    if (focusedOrderId) query.set("orderId", focusedOrderId);
    setLoading(true);
    setError("");
    fetch(`/api/orders?${query.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { orders?: StoreOrder[]; message?: string };
        if (!response.ok) throw new Error(payload.message || "Không thể tải danh sách đơn hàng.");
        setOrders(Array.isArray(payload.orders) ? payload.orders : []);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Không thể tải danh sách đơn hàng.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [focusedOrderId, period, reloadVersion, store.id]);

  useEffect(() => {
    if (!focusedOrderId) return;
    focusedOnce.current = -1;
    setSearch("");
    setEmployeeId("ALL");
    setShiftId("ALL");
    setStatus("ALL");
  }, [focusedOrderId, focusRequestKey]);

  useEffect(() => {
    if (!focusedOrderId || focusedOnce.current === focusRequestKey || loading
      || search || employeeId !== "ALL" || shiftId !== "ALL" || status !== "ALL") return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`store-order-${focusedOrderId}`);
      if (!target) return;
      focusedOnce.current = focusRequestKey;
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [employeeId, focusRequestKey, focusedOrderId, loading, orders, search, shiftId, status]);

  const employees = useMemo(() => {
    const map = new Map<string, string>();
    for (const order of orders) map.set(order.employee_id, `${order.employeeName || "Nhân viên không còn hoạt động"} · ${order.employeeCode || order.employee_id}`);
    return [...map.entries()].sort((left, right) => left[1].localeCompare(right[1], "vi"));
  }, [orders]);

  const shifts = useMemo(() => {
    const map = new Map<string, string>();
    for (const order of orders) map.set(order.shiftSessionId ?? order.shift_code, shiftLabel(order));
    return [...map.entries()].sort((left, right) => left[1].localeCompare(right[1], "vi"));
  }, [orders]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("vi");
    return orders.filter((order) => {
      if (employeeId !== "ALL" && order.employee_id !== employeeId) return false;
      if (shiftId !== "ALL" && (order.shiftSessionId ?? order.shift_code) !== shiftId) return false;
      if (status !== "ALL" && order.status !== status) return false;
      if (!needle) return true;
      return [order.code, order.customer_name, order.phone, order.employeeName, order.employeeCode, order.shiftName, order.shift_code]
        .some((value) => String(value ?? "").toLocaleLowerCase("vi").includes(needle));
    });
  }, [employeeId, orders, search, shiftId, status]);

  const groups = useMemo(() => {
    const map = new Map<string, StoreOrder[]>();
    for (const order of filtered) {
      const key = groupKey(order, groupBy);
      const current = map.get(key) ?? [];
      current.push(order);
      map.set(key, current);
    }
    return [...map.values()];
  }, [filtered, groupBy]);

  // The API may append one explicitly focused notification order from another
  // period. Keep it visible for navigation without contaminating this period's
  // summary cards.
  const periodOrders = orders.filter((order) => order.period === period);
  const activeOrders = periodOrders.filter((order) => order.status === "COMPLETED");
  const cash = activeOrders.filter((order) => order.payment_method === "CASH").reduce((total, order) => total + Number(order.amount), 0);
  const transfer = activeOrders.filter((order) => order.payment_method === "BANK_TRANSFER").reduce((total, order) => total + Number(order.amount), 0);
  const readOnly = store.status === "INACTIVE";

  function openEdit(order: StoreOrder) {
    setEditing(order);
    setForm({
      customerName: order.customer_name ?? "",
      phone: order.phone ?? "",
      age: order.age == null ? "" : String(order.age),
      amount: formatVndInput(order.amount),
      paymentMethod: order.payment_method,
    });
    setDialogMessage("");
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    const amount = parseVndInput(form.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setDialogMessage("Giá trị đơn hàng phải lớn hơn 0.");
      return;
    }
    setSaving(true);
    setDialogMessage("");
    try {
      const response = await fetch("/api/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editing.id,
          storeId: store.id,
          customerName: form.customerName,
          phone: form.phone,
          age: form.age,
          amount,
          paymentMethod: form.paymentMethod,
        }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "Không thể cập nhật đơn hàng.");
      setEditing(null);
      load();
      await onChanged?.();
    } catch (cause) {
      setDialogMessage(cause instanceof Error ? cause.message : "Không thể cập nhật đơn hàng.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(order: StoreOrder) {
    if (order.locked || order.status !== "COMPLETED" || readOnly) return;
    if (!window.confirm(`Hủy đơn ${order.code}? Đơn vẫn được lưu trong lịch sử và doanh thu sẽ được đối soát lại.`)) return;
    try {
      const query = new URLSearchParams({ id: order.id, storeId: store.id });
      const response = await fetch(`/api/orders?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "Không thể hủy đơn hàng.");
      load();
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể hủy đơn hàng.");
    }
  }

  return <section className={styles.module} aria-busy={loading}>
    <div className={styles.metrics}>
      <article className={`${styles.metric} ${styles.metricOrders}`}><i className={styles.metricIcon}><ShoppingBag size={23}/></i><div className={styles.metricContent}><span>Đơn đã ghi nhận</span><strong>{activeOrders.length} đơn</strong><small>{periodOrders.length - activeOrders.length} đơn đã hủy vẫn lưu lịch sử</small></div></article>
      <article className={`${styles.metric} ${styles.metricCash}`}><i className={styles.metricIcon}><Banknote size={23}/></i><div className={styles.metricContent}><span>Tiền mặt</span><strong>{formatVndDisplay(cash)}</strong><small>Đơn hoàn tất trong kỳ {periodLabel(period)}</small></div></article>
      <article className={`${styles.metric} ${styles.metricTransfer}`}><i className={styles.metricIcon}><Landmark size={23}/></i><div className={styles.metricContent}><span>Chuyển khoản</span><strong>{formatVndDisplay(transfer)}</strong><small>Đơn hoàn tất trong kỳ {periodLabel(period)}</small></div></article>
      <article className={`${styles.metric} ${styles.metricRevenue}`}><i className={styles.metricIcon}><ReceiptText size={23}/></i><div className={styles.metricContent}><span>Tổng doanh thu đơn</span><strong>{formatVndDisplay(cash + transfer)}</strong><small>Tự đồng bộ với ca và cửa hàng</small></div></article>
    </div>

    <div className={`${styles.panel} ${styles.toolbar}`}>
      <label className={styles.searchField}>Tìm đơn hàng
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Mã đơn, khách hàng, SĐT…"/><Search size={17}/>
      </label>
      <label>Nhân viên<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="ALL">Tất cả nhân viên</option>{employees.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Ca làm việc<select value={shiftId} onChange={(event) => setShiftId(event.target.value)}><option value="ALL">Tất cả ca</option>{shifts.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Trạng thái<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">Tất cả trạng thái</option><option value="COMPLETED">Hoàn tất</option><option value="VOID">Đã hủy</option></select></label>
      <label>Nhóm danh sách<select value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}><option value="shift">Theo ca</option><option value="employee">Theo nhân viên</option><option value="none">Không nhóm</option></select></label>
      <button type="button" className={styles.refresh} onClick={load} disabled={loading}><RefreshCw size={16}/> {loading ? "Đang tải…" : "Làm mới"}</button>
    </div>

    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    <section className={styles.panel}>
      <header className={styles.panelHeader}><div><h2>Danh sách đơn hàng {store.name}</h2><p>Hiển thị đầy đủ người tạo, ca, thời điểm và lịch sử cập nhật của quản lý.</p></div><b>{filtered.length} đơn</b></header>
      {!groups.length ? <div className={styles.empty}>{loading ? "Đang tải đơn hàng…" : "Không có đơn phù hợp bộ lọc."}</div> : groups.map((group) => <section className={styles.group} key={groupKey(group[0], groupBy)}>
        <div className={styles.groupTitle}><div><h3>{groupTitle(group[0], groupBy)}</h3><small>{groupBy === "none" ? `Kỳ ${period}` : `${group.length} đơn trong nhóm`}</small></div><span>{formatVndDisplay(group.filter((order) => order.status === "COMPLETED").reduce((total, order) => total + Number(order.amount), 0))}</span></div>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>Đơn / trạng thái</th><th>Thời gian tạo</th><th>Khách hàng</th><th>Người tạo</th><th>Ca làm việc</th><th>Thanh toán</th><th>Giá trị</th><th>Cập nhật gần nhất</th><th>Thao tác</th></tr></thead>
          <tbody>{group.map((order) => {
            const mutable = !readOnly && !order.locked && order.status === "COMPLETED";
            return <tr key={order.id} id={`store-order-${order.id}`} tabIndex={focusedOrderId === order.id ? -1 : undefined} className={focusedOrderId === order.id ? styles.highlight : undefined}>
              <td data-label="Đơn / trạng thái"><b className={styles.orderCode}>{order.code}</b><span className={`${styles.pill} ${order.status === "VOID" ? styles.pillVoid : ""}`}>{order.status === "COMPLETED" ? "Hoàn tất" : "Đã hủy"}</span>{order.locked ? <small className={`${styles.pill} ${styles.pillLocked}`}>Kỳ đã khóa</small> : null}</td>
              <td data-label="Thời gian tạo"><b>{formatDateTime24(order.created_at, true)}</b><small>Kỳ {periodLabel(order.period || period)}</small></td>
              <td data-label="Khách hàng"><b>{order.customer_name || "Khách lẻ"}</b><small>{order.phone || "Không có SĐT"}{order.age ? ` · ${order.age} tuổi` : ""}</small></td>
              <td data-label="Người tạo"><b>{order.createdByName || order.employeeName || "Nhân viên không còn hoạt động"}</b><small>{order.createdByCode || order.employeeCode || order.employee_id}</small></td>
              <td data-label="Ca làm việc"><b>{order.shiftName || order.shift_code}</b><small>{order.scheduledStart && order.scheduledEnd ? `${order.scheduledStart}–${order.scheduledEnd}` : order.shift_code}</small></td>
              <td data-label="Thanh toán"><b>{order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</b><small>{order.shiftStatus === "COMPLETED" ? "Ca đã kết thúc" : "Ca đang hoạt động"}</small></td>
              <td data-label="Giá trị"><b>{formatVndDisplay(order.amount)}</b></td>
              <td data-label="Cập nhật gần nhất"><b>{order.lastUpdatedAt ? formatDateTime24(order.lastUpdatedAt, true) : "Chưa chỉnh sửa"}</b><small>{order.lastUpdatedBy || "—"}</small></td>
              <td data-label="Thao tác"><div className={styles.actions}><button type="button" aria-label={`Sửa đơn ${order.code}`} title={mutable ? "Sửa đơn" : "Đơn hoặc kỳ không thể thay đổi"} disabled={!mutable} onClick={(event) => { editTriggerRef.current = event.currentTarget; openEdit(order); }}><Pencil size={15}/></button><button type="button" aria-label={`Hủy đơn ${order.code}`} title={mutable ? "Hủy đơn" : "Đơn hoặc kỳ không thể thay đổi"} disabled={!mutable} onClick={() => void remove(order)}><Trash2 size={15}/></button></div></td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>)}
    </section>

    {editing ? <div ref={editBackdropRef} className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditing(null); }}>
      <section ref={editDialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="manager-order-edit-title" tabIndex={-1}>
        <header className={styles.dialogHeader}><div><h2 id="manager-order-edit-title">Sửa đơn {editing.code}</h2><p>{shiftLabel(editing)} · người tạo {editing.employeeName || editing.employeeCode}</p></div><button type="button" className={styles.close} aria-label="Đóng cửa sổ sửa đơn" disabled={saving} onClick={() => setEditing(null)}><X size={18}/></button></header>
        <form className={styles.editForm} onSubmit={saveEdit}>
          <label>Tên khách hàng<input value={form.customerName} maxLength={100} onChange={(event) => setForm((current) => ({ ...current, customerName: event.target.value }))}/></label>
          <label>Số điện thoại<input value={form.phone} inputMode="tel" maxLength={20} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}/></label>
          <label>Tuổi<input value={form.age} type="number" min="1" max="120" onChange={(event) => setForm((current) => ({ ...current, age: event.target.value }))}/></label>
          <label>Hình thức thanh toán<select value={form.paymentMethod} onChange={(event) => setForm((current) => ({ ...current, paymentMethod: event.target.value as OrderForm["paymentMethod"] }))}><option value="CASH">Tiền mặt</option><option value="BANK_TRANSFER">Chuyển khoản</option></select></label>
          <label className={styles.wide}>Giá trị đơn hàng<input required value={form.amount} inputMode="numeric" onChange={(event) => setForm((current) => ({ ...current, amount: formatVndInput(event.target.value) }))}/><small>Nhập 15000 sẽ hiển thị 15,000.</small></label>
          {dialogMessage ? <div className={styles.dialogMessage} role="alert">{dialogMessage}</div> : null}
          <div className={styles.dialogActions}><button type="button" disabled={saving} onClick={() => setEditing(null)}>Hủy bỏ</button><button type="submit" disabled={saving}>{saving ? "Đang lưu…" : "Lưu thay đổi"}</button></div>
        </form>
      </section>
    </div> : null}
  </section>;
}
