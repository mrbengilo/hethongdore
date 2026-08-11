"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Edit3, RefreshCw, Search, Trash2, X } from "lucide-react";
import { formatDateTime24, formatDateVn } from "../lib/format";
import { DatePickerControl } from "./DatePickerControl";
import styles from "./SuperAdminDataRecords.module.css";

type Store = { id: string; name: string };
type Employee = { id: string; code: string; name: string; status: string };
type Resource = "ORDERS" | "ATTENDANCE";
type Range = "ALL" | "DAY" | "MONTH";
type BaseRow = {
  id: string; employeeId: string; employeeCode: string | null; employeeName: string | null;
  shiftCode: string; shiftName: string | null; versionToken: string; locked: number; period: string;
};
type OrderRow = BaseRow & {
  code: string; workDate: string | null; customerName: string | null; phone: string | null;
  age: number | null; amount: number; paymentMethod: string; status: string; createdAt: string;
  shiftSessionId: string | null;
};
type AttendanceRow = BaseRow & {
  workDate: string | null; startedAt: string; endedAt: string | null; durationSeconds: number;
  adminAdjustedDurationSeconds: number | null; status: string; attendanceStatus: string | null;
  attendanceDeltaMinutes: number | null; cashRevenue: number; transferRevenue: number;
  expenseAmount: number; linkedOrderCount: number; scheduledStart: string | null; scheduledEnd: string | null;
  scheduledStartAt?: string | null; scheduledEndAt?: string | null;
};
type Row = OrderRow | AttendanceRow;
type ListResponse = {
  rows: Row[];
  employees: Employee[];
  shifts: Array<{ code: string; name: string }>;
  pagination: { page: number; pageSize: number; total: number; pages: number };
};

const localDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const currentPeriod = () => localDay().slice(0, 7);
const money = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đồng`;
const dateTime = (value?: string | null) => formatDateTime24(value);
const toLocalDateTimeInput = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
};
const localDateTimeInputToIso = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}:00+07:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const paymentLabel = (value: string) => value === "BANK_TRANSFER" ? "Chuyển khoản" : "Tiền mặt";
const employeeStatusSuffix = (status: string) => status === "SUSPENDED"
  ? " · Tạm ngưng" : status === "TERMINATED" || status === "INACTIVE" ? " · Đã nghỉ việc" : "";
const attendanceLabel = (row: AttendanceRow) => {
  if (row.attendanceStatus === "EARLY") return `Đi sớm ${Math.abs(Number(row.attendanceDeltaMinutes ?? 0))} phút`;
  if (row.attendanceStatus === "LATE") return `Đi trễ ${Math.abs(Number(row.attendanceDeltaMinutes ?? 0))} phút`;
  if (row.attendanceStatus === "ON_TIME") return "Đúng giờ";
  return row.status === "ACTIVE" ? "Đang làm" : "Đã kết ca";
};

export function SuperAdminDataRecords({ store, onChanged }: { store: Store; onChanged?: () => void | Promise<void> }) {
  const [resource, setResource] = useState<Resource>("ORDERS");
  const [range, setRange] = useState<Range>("ALL");
  const [date, setDate] = useState(localDay);
  const [period, setPeriod] = useState(currentPeriod);
  const [employeeId, setEmployeeId] = useState("");
  const [shiftCode, setShiftCode] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Array<{ code: string; name: string }>>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const [orderForm, setOrderForm] = useState({ customerName: "", phone: "", age: "", amount: "", paymentMethod: "CASH" });
  const [attendanceTimes, setAttendanceTimes] = useState({ startedAt: "", endedAt: "" });
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const savingRef = useRef(false);
  const dialogOpen = Boolean(editing || deleting);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ storeId: store.id, resource, range, page: String(page), pageSize: "20" });
    if (range === "DAY") params.set("date", date);
    if (range === "MONTH") params.set("period", period);
    if (employeeId) params.set("employeeId", employeeId);
    if (shiftCode) params.set("shiftCode", shiftCode);
    if (search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/admin/reset-data/items?${params.toString()}`, { cache: "no-store", signal });
      const data = await response.json().catch(() => ({})) as Partial<ListResponse> & { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể tải danh sách dữ liệu.");
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setEmployees(Array.isArray(data.employees) ? data.employees : []);
      setShifts(Array.isArray(data.shifts) ? data.shifts : []);
      setPagination(data.pagination ?? { page, pageSize: 20, total: 0, pages: 1 });
    } catch (requestError) {
      if (signal?.aborted) return;
      setRows([]);
      setError(requestError instanceof Error ? requestError.message : "Không thể tải danh sách dữ liệu.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [date, employeeId, page, period, range, resource, search, shiftCode, store.id]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  useEffect(() => { savingRef.current = saving; }, [saving]);

  useEffect(() => {
    if (!dialogOpen) return;
    const previousOverflow = document.body.style.overflow;
    const panelContent = panelContentRef.current;
    document.body.style.overflow = "hidden";
    panelContent?.setAttribute("inert", "");
    panelContent?.setAttribute("aria-hidden", "true");
    window.requestAnimationFrame(() => dialogTitleRef.current?.focus());
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) { setEditing(null); setDeleting(null); setReason(""); return; }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const focusable = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")) : [];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      document.body.style.overflow = previousOverflow;
      panelContent?.removeAttribute("inert");
      panelContent?.removeAttribute("aria-hidden");
      const trigger = triggerRef.current;
      if (trigger?.isConnected) window.requestAnimationFrame(() => trigger.focus());
    };
  }, [dialogOpen]);

  function changeFilter(action: () => void) {
    action();
    setPage(1);
    setMessage("");
  }

  function changeResource(next: Resource) {
    setRows([]);
    setPagination({ page: 1, pageSize: 20, total: 0, pages: 1 });
    setLoading(true);
    changeFilter(() => {
      setResource(next);
      setShiftCode("");
    });
  }

  function openEdit(row: Row) {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReason("");
    setEditing(row);
    setDeleting(null);
    if (resource === "ORDERS") {
      const order = row as OrderRow;
      setOrderForm({
        customerName: order.customerName ?? "", phone: order.phone ?? "", age: order.age == null ? "" : String(order.age),
        amount: String(order.amount), paymentMethod: order.paymentMethod,
      });
    } else {
      const attendance = row as AttendanceRow;
      setAttendanceTimes({
        startedAt: toLocalDateTimeInput(attendance.startedAt),
        endedAt: toLocalDateTimeInput(attendance.endedAt),
      });
    }
  }

  function openDelete(row: Row) {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReason("");
    setEditing(null);
    setDeleting(row);
  }

  function closeDialog() {
    if (savingRef.current) return;
    setEditing(null);
    setDeleting(null);
    setReason("");
  }

  async function saveEdit() {
    if (!editing || reason.trim().length < 3) return;
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        storeId: store.id, resource, id: editing.id, versionToken: editing.versionToken, reason: reason.trim(),
      };
      if (resource === "ORDERS") Object.assign(body, orderForm);
      else {
        body.startedAt = localDateTimeInputToIso(attendanceTimes.startedAt);
        body.endedAt = localDateTimeInputToIso(attendanceTimes.endedAt);
      }
      const response = await fetch("/api/admin/reset-data/items", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể cập nhật dữ liệu.");
      setMessage(data.message ?? "Đã cập nhật dữ liệu.");
      setEditing(null);
      setReason("");
      await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Không thể cập nhật dữ liệu.");
    } finally {
      setSaving(false);
    }
  }

  async function removeRow() {
    if (!deleting || reason.trim().length < 3) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/reset-data/items", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: store.id, resource, id: deleting.id, versionToken: deleting.versionToken, reason: reason.trim() }),
      });
      const data = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể xóa dữ liệu.");
      setMessage(data.message ?? "Đã xóa dữ liệu.");
      setDeleting(null);
      setReason("");
      if (rows.length === 1 && page > 1) setPage((current) => current - 1);
      else await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Không thể xóa dữ liệu.");
    } finally {
      setSaving(false);
    }
  }

  const dialogRow = editing ?? deleting;
  const isAttendance = resource === "ATTENDANCE";
  const attendanceStartIso = localDateTimeInputToIso(attendanceTimes.startedAt);
  const attendanceEndIso = localDateTimeInputToIso(attendanceTimes.endedAt);
  const attendanceStartMs = attendanceStartIso ? new Date(attendanceStartIso).getTime() : Number.NaN;
  const attendanceEndMs = attendanceEndIso ? new Date(attendanceEndIso).getTime() : Number.NaN;
  const editingActiveAttendance = Boolean(editing && resource === "ATTENDANCE" && (editing as AttendanceRow).status === "ACTIVE");
  const attendanceTimesValid = Number.isFinite(attendanceStartMs) && (
    editingActiveAttendance
      ? attendanceTimes.endedAt === ""
      : Number.isFinite(attendanceEndMs) && attendanceEndMs >= attendanceStartMs && attendanceEndMs - attendanceStartMs <= 72 * 3_600_000
  );
  return <section className={styles.panel} aria-labelledby="super-admin-records-title">
    <div ref={panelContentRef} className={styles.panelContent}>
    <header className={styles.header}>
      <div><h2 id="super-admin-records-title">Danh sách dữ liệu chi tiết · {store.name}</h2><p>Mỗi bản ghi hiển thị riêng. Mọi sửa/xóa đều bị chặn khi kỳ đã khóa và được lưu bản đối soát cùng lịch sử thao tác.</p></div>
      <button type="button" className={styles.refresh} disabled={loading} onClick={() => void load()}><RefreshCw size={17} className={loading ? "spin" : ""}/> Làm mới</button>
    </header>
    <div className={styles.tabs} role="tablist" aria-label="Loại dữ liệu chi tiết">
      <button type="button" role="tab" aria-selected={resource === "ORDERS"} className={resource === "ORDERS" ? styles.activeTab : ""} onClick={() => changeResource("ORDERS")}>Tất cả đơn hàng</button>
      <button type="button" role="tab" aria-selected={resource === "ATTENDANCE"} className={resource === "ATTENDANCE" ? styles.activeTab : ""} onClick={() => changeResource("ATTENDANCE")}>Chấm công theo ca</button>
    </div>
    <div className={styles.filters}>
      <label>Thời gian<select value={range} onChange={(event) => changeFilter(() => { setRange(event.target.value as Range); setShiftCode(""); })}><option value="ALL">Toàn bộ lịch sử</option><option value="DAY">Theo ngày</option><option value="MONTH">Theo tháng</option></select></label>
      {range === "DAY" ? <div className={styles.pickerField}><span>Ngày</span><DatePickerControl ariaLabel="Chọn ngày chấm công hoặc đơn hàng" value={date} onChange={(value) => changeFilter(() => { setDate(value); setShiftCode(""); })}/></div> : null}
      {range === "MONTH" ? <div className={styles.pickerField}><span>Tháng</span><DatePickerControl ariaLabel="Chọn tháng chấm công hoặc đơn hàng" type="month" value={period} onChange={(value) => changeFilter(() => { setPeriod(value); setShiftCode(""); })}/></div> : null}
      <label>Nhân viên<select value={employeeId} onChange={(event) => changeFilter(() => { setEmployeeId(event.target.value); setShiftCode(""); })}><option value="">Tất cả nhân viên</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.code} · {employee.name}{employeeStatusSuffix(employee.status)}</option>)}</select></label>
      <label>Ca làm việc<select value={shiftCode} onChange={(event) => changeFilter(() => setShiftCode(event.target.value))}><option value="">Tất cả ca</option>{shifts.map((shift) => <option value={shift.code} key={shift.code}>{shift.name} · {shift.code}</option>)}</select></label>
      <label className={styles.search}><span>Tìm kiếm</span><span><Search size={16}/><input type="search" value={search} onChange={(event) => changeFilter(() => setSearch(event.target.value))} placeholder={isAttendance ? "Tên, mã nhân viên hoặc mã ca" : "Mã đơn, khách hàng, SĐT"}/></span></label>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {message ? <div className={styles.message} role="status">{message}</div> : null}
    <div className={styles.tableWrap} aria-busy={loading}>
      {loading ? <div className={styles.empty}>Đang tải dữ liệu…</div> : rows.length === 0 ? <div className={styles.empty}>Không có dữ liệu phù hợp.</div> : resource === "ORDERS" ? <table className={styles.table}>
        <thead><tr><th>Đơn hàng</th><th>Khách hàng</th><th>Nhân viên / ca</th><th>Giá trị</th><th>Thanh toán</th><th>Tạo lúc</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>{(rows as OrderRow[]).map((row) => <tr key={row.id}>
          <td data-label="Đơn hàng"><b>{row.code}</b><small>{formatDateVn(row.workDate ?? `${row.period}-01`)}</small></td>
          <td data-label="Khách hàng"><b>{row.customerName || "Khách lẻ"}</b><small>{row.phone || "Không có SĐT"}{row.age ? ` · ${row.age} tuổi` : ""}</small></td>
          <td data-label="Nhân viên / ca"><b>{row.employeeName ?? row.employeeId}</b><small>{row.employeeCode ?? "—"} · {row.shiftName ?? row.shiftCode}</small></td>
          <td data-label="Giá trị"><b>{money(row.amount)}</b></td><td data-label="Thanh toán">{paymentLabel(row.paymentMethod)}</td>
          <td data-label="Tạo lúc">{dateTime(row.createdAt)}</td><td data-label="Trạng thái"><span className={styles.status}>{row.status === "COMPLETED" ? "Hoàn tất" : row.status}</span>{row.locked ? <small>Kỳ đã khóa</small> : null}</td>
          <td data-label="Thao tác"><div className={styles.rowActions}><button type="button" aria-label={`Sửa đơn ${row.code}`} disabled={Boolean(row.locked) || !row.shiftSessionId} onClick={() => openEdit(row)}><Edit3 size={16}/> Sửa</button><button type="button" className={styles.delete} aria-label={`Xóa đơn ${row.code}`} disabled={Boolean(row.locked) || !row.shiftSessionId} onClick={() => openDelete(row)}><Trash2 size={16}/> Xóa</button></div></td>
        </tr>)}</tbody>
      </table> : <table className={styles.table}>
        <thead><tr><th>Ngày</th><th>Nhân viên</th><th>Ca</th><th>Giờ vào / kết</th><th>Giờ thực tế</th><th>Doanh thu / chi phí</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>{(rows as AttendanceRow[]).map((row) => {
          const blockedDelete = Boolean(row.locked) || row.status === "ACTIVE" || !row.endedAt || row.linkedOrderCount > 0;
          return <tr key={row.id}>
            <td data-label="Ngày"><b>{formatDateVn(row.workDate ?? `${row.period}-01`)}</b></td><td data-label="Nhân viên"><b>{row.employeeName ?? row.employeeId}</b><small>{row.employeeCode ?? "—"}</small></td>
            <td data-label="Ca"><b>{row.shiftName ?? row.shiftCode}</b><small>{row.scheduledStart && row.scheduledEnd ? `${row.scheduledStart} – ${row.scheduledEnd}` : row.shiftCode}</small></td><td data-label="Giờ vào / kết"><b>{dateTime(row.startedAt)}</b><small>{dateTime(row.endedAt)}</small></td>
            <td data-label="Giờ thực tế"><b>{(row.durationSeconds / 3_600).toFixed(2)} giờ</b>{row.adminAdjustedDurationSeconds != null ? <small>Đã điều chỉnh bởi quản trị cấp cao</small> : null}</td>
            <td data-label="Doanh thu / chi phí"><b>{money(row.cashRevenue + row.transferRevenue)}</b><small>Chi phí {money(row.expenseAmount)}</small></td>
            <td data-label="Trạng thái"><span className={`${styles.status} ${row.attendanceStatus === "EARLY" ? styles.early : row.attendanceStatus === "LATE" ? styles.late : row.attendanceStatus === "ON_TIME" ? styles.onTime : styles.unknown}`}>{attendanceLabel(row)}</span>{row.locked ? <small>Kỳ đã khóa</small> : row.linkedOrderCount > 0 ? <small>{row.linkedOrderCount} đơn hàng liên kết</small> : null}</td>
            <td data-label="Thao tác"><div className={styles.rowActions}><button type="button" aria-label={`Sửa giờ làm ${row.employeeName ?? row.employeeId}`} disabled={Boolean(row.locked) || (row.status !== "ACTIVE" && !row.endedAt)} onClick={() => openEdit(row)}><Edit3 size={16}/> Sửa giờ</button><button type="button" className={styles.delete} aria-label={`Xóa chấm công ${row.employeeName ?? row.employeeId}`} disabled={blockedDelete} title={row.linkedOrderCount > 0 ? "Hãy xóa đơn hàng của ca trước" : undefined} onClick={() => openDelete(row)}><Trash2 size={16}/> Xóa</button></div></td>
          </tr>;
        })}</tbody>
      </table>}
    </div>
    <footer className={styles.pagination}><span>{pagination.total} bản ghi · Trang {pagination.page}/{pagination.pages}</span><div><button type="button" aria-label="Trang trước" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={18}/></button><button type="button" aria-label="Trang sau" disabled={loading || page >= pagination.pages} onClick={() => setPage((current) => Math.min(pagination.pages, current + 1))}><ChevronRight size={18}/></button></div></footer>
    </div>
    {dialogRow ? <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="record-dialog-title">
        <header><h3 id="record-dialog-title" ref={dialogTitleRef} tabIndex={-1}>{deleting ? "Xác nhận xóa dữ liệu" : resource === "ORDERS" ? "Sửa đơn hàng" : "Sửa giờ vào và giờ kết ca"}</h3><button type="button" aria-label="Đóng" disabled={saving} onClick={closeDialog}><X size={20}/></button></header>
        <p>{resource === "ORDERS" ? `Đơn ${(dialogRow as OrderRow).code}` : `${dialogRow.employeeName ?? dialogRow.employeeId} · ${dialogRow.shiftName ?? dialogRow.shiftCode}`}</p>
        {editing && resource === "ORDERS" ? <div className={styles.formGrid}><label>Tên khách hàng<input value={orderForm.customerName} onChange={(event) => setOrderForm((current) => ({ ...current, customerName: event.target.value }))}/></label><label>Số điện thoại<input inputMode="tel" value={orderForm.phone} onChange={(event) => setOrderForm((current) => ({ ...current, phone: event.target.value }))}/></label><label>Tuổi<input type="number" min="1" max="120" value={orderForm.age} onChange={(event) => setOrderForm((current) => ({ ...current, age: event.target.value }))}/></label><label>Giá trị đơn<input type="number" min="1" step="1" required value={orderForm.amount} onChange={(event) => setOrderForm((current) => ({ ...current, amount: event.target.value }))}/></label><label>Thanh toán<select value={orderForm.paymentMethod} onChange={(event) => setOrderForm((current) => ({ ...current, paymentMethod: event.target.value }))}><option value="CASH">Tiền mặt</option><option value="BANK_TRANSFER">Chuyển khoản</option></select></label></div> : null}
        {editing && resource === "ATTENDANCE" ? <div className={styles.formGrid}>
          <label>Giờ vào ca<input type="datetime-local" step="60" required value={attendanceTimes.startedAt} onChange={(event) => setAttendanceTimes((current) => ({ ...current, startedAt: event.target.value }))}/></label>
          <label>Giờ kết ca<input type="datetime-local" step="60" required={!editingActiveAttendance} disabled={editingActiveAttendance} value={attendanceTimes.endedAt} onChange={(event) => setAttendanceTimes((current) => ({ ...current, endedAt: event.target.value }))}/>{editingActiveAttendance ? <small>Ca đang làm chỉ được sửa giờ vào. Hãy kết ca bằng quy trình đối soát của nhân viên.</small> : null}</label>
          <small className={styles.formHelp}>Hệ thống tính lại số giờ thực tế và trạng thái đi sớm/đúng giờ/đi trễ. Vị trí điểm danh, đơn hàng và số liệu tài chính của ca không bị thay đổi.</small>
        </div> : null}
        {deleting ? <div className={styles.dangerNote}><b>Dữ liệu sẽ bị loại khỏi vận hành.</b> Bản đối soát và lịch sử người thực hiện vẫn được lưu. Chấm công có đơn hàng liên kết phải xóa đơn trước.</div> : null}
        <label className={styles.fullLabel}>Lý do {deleting ? "xóa" : "thay đổi"}<textarea rows={3} minLength={3} maxLength={500} required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Nhập lý do để lưu vào lịch sử kiểm tra"/></label>
        <div className={styles.dialogActions}><button type="button" disabled={saving} onClick={closeDialog}>Hủy</button><button type="button" className={deleting ? styles.confirmDelete : styles.confirmSave} disabled={saving || reason.trim().length < 3 || Boolean(editing && resource === "ATTENDANCE" && !attendanceTimesValid)} onClick={() => void (deleting ? removeRow() : saveEdit())}>{saving ? "Đang lưu…" : deleting ? "Xóa dữ liệu" : "Lưu thay đổi"}</button></div>
      </section>
    </div> : null}
  </section>;
}
