"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, RefreshCw, Save, Search, ShieldAlert, Trash2, X } from "lucide-react";
import styles from "./SuperAdminEmployees.module.css";

type Store = { id: string; name: string };
type EmployeeStatus = "ACTIVE" | "SUSPENDED" | "TERMINATED";
type EmployeeRow = {
  id: string;
  code: string;
  name: string;
  position: string;
  phone: string;
  province: string;
  ward: string;
  addressLine: string;
  age: number | null;
  cccdImageKey: string | null;
  cccdImageName: string | null;
  hourlyRate: number;
  tiktokAllowance: number;
  status: EmployeeStatus;
  statusLabel: string;
  statusUpdatedAt: string | null;
  username: string | null;
  hasLogin: boolean;
  activeShiftCount: number;
  orderCount: number;
  shiftCount: number;
  payrollClosingCount: number;
  versionToken: string;
};
type ListResponse = {
  rows: EmployeeRow[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
};
type PendingAction =
  | { kind: "STATUS"; row: EmployeeRow; status: EmployeeStatus }
  | { kind: "DELETE"; row: EmployeeRow };

const STATUS_OPTIONS: Array<{ value: EmployeeStatus; label: string }> = [
  { value: "ACTIVE", label: "Đang làm việc" },
  { value: "SUSPENDED", label: "Tạm ngưng" },
  { value: "TERMINATED", label: "Đã nghỉ việc" },
];

const money = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đồng`;
const fullDateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat("vi-VN", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23",
    }).format(new Date(value))
  : "Chưa cập nhật";
const imageUrl = (key: string) => `/api/uploads?key=${encodeURIComponent(key)}`;

export function SuperAdminEmployees({ store, onChanged }: { store: Store; onChanged?: () => void | Promise<void> }) {
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [draftStatuses, setDraftStatuses] = useState<Record<string, EmployeeStatus>>({});
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ storeId: store.id, page: String(page), pageSize: "20" });
    if (search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/admin/employees?${params.toString()}`, { cache: "no-store", signal });
      const data = await response.json().catch(() => ({})) as Partial<ListResponse> & { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể tải danh sách nhân viên.");
      const nextRows = Array.isArray(data.rows) ? data.rows : [];
      setRows(nextRows);
      setDraftStatuses(Object.fromEntries(nextRows.map((row) => [row.id, row.status])));
      setPagination(data.pagination ?? { page, pageSize: 20, total: 0, pages: 1 });
    } catch (requestError) {
      if (signal?.aborted) return;
      setRows([]);
      setError(requestError instanceof Error ? requestError.message : "Không thể tải danh sách nhân viên.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page, search, store.id]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  useEffect(() => {
    if (!pending) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => dialogTitleRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        setPending(null);
        setReason("");
        setConfirmation("");
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      if (event.shiftKey && activeIndex <= 0) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (activeIndex === -1 || active === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (triggerRef.current?.isConnected) window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
  }, [pending, saving]);

  function beginStatus(row: EmployeeRow) {
    const status = draftStatuses[row.id] ?? row.status;
    if (status === row.status) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReason("");
    setConfirmation("");
    setPending({ kind: "STATUS", row, status });
  }

  function beginDelete(row: EmployeeRow) {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReason("");
    setConfirmation("");
    setPending({ kind: "DELETE", row });
  }

  function closeDialog() {
    if (saving) return;
    setPending(null);
    setReason("");
    setConfirmation("");
  }

  async function submit() {
    if (!pending || reason.trim().length < 3) return;
    if (pending.kind === "DELETE" && confirmation.trim().toLocaleUpperCase("vi-VN") !== pending.row.code.toLocaleUpperCase("vi-VN")) return;
    setSaving(true);
    setError("");
    setMessage("");
    setWarning("");
    try {
      const response = await fetch("/api/admin/employees", {
        method: pending.kind === "DELETE" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: store.id,
          id: pending.row.id,
          versionToken: pending.row.versionToken,
          reason: reason.trim(),
          ...(pending.kind === "STATUS" ? { status: pending.status } : { confirmation: confirmation.trim() }),
        }),
      });
      const data = await response.json().catch(() => ({})) as { message?: string; warning?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể cập nhật nhân viên.");
      setMessage(data.message ?? "Đã cập nhật nhân viên.");
      setWarning(data.warning ?? "");
      setPending(null);
      setReason("");
      setConfirmation("");
      if (pending.kind === "DELETE" && rows.length === 1 && page > 1) setPage((current) => current - 1);
      else await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Không thể cập nhật nhân viên.");
    } finally {
      setSaving(false);
    }
  }

  const statusLabel = pending?.kind === "STATUS"
    ? STATUS_OPTIONS.find((option) => option.value === pending.status)?.label
    : null;
  const canSubmit = Boolean(pending)
    && reason.trim().length >= 3
    && (pending?.kind !== "DELETE" || confirmation.trim().toLocaleUpperCase("vi-VN") === pending.row.code.toLocaleUpperCase("vi-VN"));

  return <section className={styles.panel} aria-labelledby="super-admin-employees-title">
    <header className={styles.header}>
      <div><h2 id="super-admin-employees-title">Danh sách nhân viên · {store.name}</h2><p>Quản trị cấp cao có thể đổi trạng thái tài khoản hoặc xóa hồ sơ. Các báo cáo cũ vẫn giữ mã đối soát ẩn danh để số liệu không thay đổi.</p></div>
      <button type="button" className={styles.refresh} onClick={() => void load()} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""}/> Làm mới</button>
    </header>
    <div className={styles.toolbar}>
      <label><span>Tìm nhân viên</span><span className={styles.search}><Search size={17}/><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Tên, mã, SĐT hoặc tài khoản"/></span></label>
      <div className={styles.total}><b>{pagination.total}</b><span>nhân viên</span></div>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {message ? <div className={styles.message} role="status">{message}</div> : null}
    {warning ? <div className={styles.warning} role="status"><ShieldAlert size={17}/>{warning}</div> : null}
    <div className={styles.tableWrap} aria-busy={loading}>
      {loading ? <div className={styles.empty}>Đang tải danh sách nhân viên…</div> : rows.length === 0 ? <div className={styles.empty}>Không có nhân viên phù hợp.</div> : <table className={styles.table}>
        <thead><tr><th>Nhân viên</th><th>Liên hệ / địa chỉ</th><th>Lương / phụ cấp</th><th>Tài khoản / hồ sơ</th><th>Lịch sử liên quan</th><th>Trạng thái và thao tác</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td data-label="Nhân viên"><b>{row.code} · {row.name}</b><small>{row.position}{row.age == null ? "" : ` · ${row.age} tuổi`}</small></td>
          <td data-label="Liên hệ / địa chỉ"><b>{row.phone || "Không có SĐT"}</b><small>{[row.addressLine, row.ward, row.province].filter(Boolean).join(", ") || "Chưa có địa chỉ"}</small></td>
          <td data-label="Lương / phụ cấp"><b>{money(row.hourlyRate)}/giờ</b><small>Phụ cấp TikTok {money(row.tiktokAllowance)}</small></td>
          <td data-label="Tài khoản / hồ sơ"><b>{row.username || "Không có tài khoản"}</b><small>{row.cccdImageKey ? <a href={imageUrl(row.cccdImageKey)} target="_blank" rel="noopener noreferrer"><Eye size={14}/> Xem CCCD</a> : "Không có ảnh CCCD"}</small></td>
          <td data-label="Lịch sử liên quan"><b>{row.shiftCount} ca · {row.orderCount} đơn</b><small>{row.payrollClosingCount} kỳ lương · {row.activeShiftCount} ca đang mở</small></td>
          <td data-label="Trạng thái và thao tác">
            <span className={`${styles.status} ${styles[row.status.toLowerCase()]}`}>{row.statusLabel}</span>
            <small>Cập nhật {fullDateTime(row.statusUpdatedAt)}</small>
            <div className={styles.actions}>
              <select aria-label={`Trạng thái của ${row.name}`} value={draftStatuses[row.id] ?? row.status} onChange={(event) => setDraftStatuses((current) => ({ ...current, [row.id]: event.target.value as EmployeeStatus }))}>{STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
              <button type="button" disabled={(draftStatuses[row.id] ?? row.status) === row.status || saving} onClick={() => beginStatus(row)}><Save size={15}/> Lưu trạng thái</button>
              <button type="button" className={styles.delete} disabled={saving} onClick={() => beginDelete(row)}><Trash2 size={15}/> Xóa khỏi hệ thống</button>
            </div>
          </td>
        </tr>)}</tbody>
      </table>}
    </div>
    <footer className={styles.pagination}><span>Trang {pagination.page}/{pagination.pages}</span><div><button type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Trang trước</button><button type="button" disabled={loading || page >= pagination.pages} onClick={() => setPage((current) => current + 1)}>Trang sau</button></div></footer>

    {pending ? <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="employee-action-title" aria-busy={saving}>
        <button type="button" className={styles.close} aria-label="Đóng" onClick={closeDialog} disabled={saving}><X size={19}/></button>
        <h3 id="employee-action-title" ref={dialogTitleRef} tabIndex={-1}>{pending.kind === "DELETE" ? `Xóa ${pending.row.name}` : `Chuyển sang ${statusLabel}`}</h3>
        {pending.kind === "DELETE" ? <div className={styles.dangerNote}><ShieldAlert size={20}/><p>Tài khoản, phiên đăng nhập, hồ sơ nhận dạng và ảnh CCCD sẽ bị xóa. Nhân viên không còn xuất hiện trong danh sách. Lịch sử tài chính chỉ giữ mã ẩn danh để không làm sai báo cáo.</p></div> : <p>Trạng thái mới có hiệu lực ngay. Tạm ngưng và Đã nghỉ việc sẽ bị đăng xuất và không thể đăng nhập.</p>}
        <label>Lý do thao tác<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Nhập ít nhất 3 ký tự"/></label>
        {pending.kind === "DELETE" ? <label>Nhập mã <b>{pending.row.code}</b> để xác nhận<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off"/></label> : null}
        <div className={styles.dialogActions}><button type="button" onClick={closeDialog} disabled={saving}>Hủy bỏ</button><button type="button" className={pending.kind === "DELETE" ? styles.confirmDelete : styles.confirm} onClick={() => void submit()} disabled={saving || !canSubmit}>{saving ? "Đang lưu…" : pending.kind === "DELETE" ? "Xóa khỏi hệ thống" : "Xác nhận trạng thái"}</button></div>
      </section>
    </div> : null}
  </section>;
}
