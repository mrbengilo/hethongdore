"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Edit3, Eye, KeyRound, RefreshCw, Search, ShieldAlert, Trash2, X } from "lucide-react";
import { useAccessibleModal } from "./useAccessibleModal";
import styles from "./SuperAdminEmployeeDirectory.module.css";

type EmployeeStatus = "ACTIVE" | "SUSPENDED" | "TERMINATED";
type AccountStatus = "ENABLED" | "DISABLED" | "LOCKED" | "NO_ACCOUNT";
type EmployeeRow = {
  id: string; storeId: string; storeName: string; storeStatus: string; code: string; name: string;
  position: string; phone: string; province: string; ward: string; addressLine: string; age: number | null;
  cccdImageKey: string | null; hourlyRate: number; tiktokAllowance: number; status: EmployeeStatus;
  statusLabel: string; username: string | null; hasLogin: boolean; accountStatus: AccountStatus;
  activeShiftCount: number; orderCount: number; shiftCount: number; payrollClosingCount: number;
  versionToken: string;
};
type ListResponse = { rows: EmployeeRow[]; pagination: { page: number; pageSize: number; total: number; pages: number } };
type EditDraft = Pick<EmployeeRow, "name" | "position" | "phone" | "province" | "ward" | "addressLine"> & {
  age: string; hourlyRate: string; tiktokAllowance: string; username: string;
};
type Action = { kind: "EDIT" | "RESET_PASSWORD" | "DELETE"; row: EmployeeRow };

const money = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đồng`;
const numberText = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value));
const parseNumber = (value: string) => Number(value.replace(/[^0-9]/gu, ""));
const accountLabels: Record<AccountStatus, string> = {
  ENABLED: "Được phép đăng nhập", DISABLED: "Đã khóa theo trạng thái", LOCKED: "Tạm khóa bảo mật", NO_ACCOUNT: "Chưa có tài khoản",
};

function draftFor(row: EmployeeRow): EditDraft {
  return {
    name: row.name, position: row.position, phone: row.phone, province: row.province,
    ward: row.ward, addressLine: row.addressLine, age: row.age == null ? "" : String(row.age),
    hourlyRate: numberText(row.hourlyRate), tiktokAllowance: numberText(row.tiktokAllowance), username: row.username ?? "",
  };
}

export function SuperAdminEmployeeDirectory() {
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const modalRootRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const initialFocusRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    if (saving) return;
    setAction(null); setDraft(null); setReason(""); setConfirmation(""); setPassword(""); setPasswordConfirmation("");
  }, [saving]);
  useAccessibleModal({ open: Boolean(action), rootRef: modalRootRef, dialogRef, initialFocusRef, returnFocusRef: triggerRef, onDismiss: close, dismissDisabled: saving });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/admin/employees?${params}`, { cache: "no-store", signal });
      const data = await response.json().catch(() => ({})) as Partial<ListResponse> & { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể tải danh sách nhân viên.");
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setPagination(data.pagination ?? { page, pageSize: 20, total: 0, pages: 1 });
    } catch (requestError) {
      if (!signal?.aborted) setError(requestError instanceof Error ? requestError.message : "Không thể tải danh sách nhân viên.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [page, search]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [load]);

  function begin(kind: Action["kind"], row: EmployeeRow) {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAction({ kind, row }); setDraft(kind === "EDIT" ? draftFor(row) : null);
    setReason(""); setConfirmation(""); setPassword(""); setPasswordConfirmation(""); setError(""); setMessage("");
  }

  const validEdit = action?.kind === "EDIT" && draft && Object.values({
    name: draft.name, position: draft.position, phone: draft.phone, province: draft.province,
    ward: draft.ward, addressLine: draft.addressLine,
  }).every((value) => value.trim()) && Number(draft.age) >= 15 && Number(draft.age) <= 100
    && parseNumber(draft.hourlyRate) > 0 && Number.isSafeInteger(parseNumber(draft.hourlyRate))
    && Number.isSafeInteger(parseNumber(draft.tiktokAllowance)) && (!action.row.hasLogin || Boolean(draft.username.trim()));
  const validPassword = password.length >= 10 && password.length <= 128 && /[A-Za-z]/u.test(password) && /\d/u.test(password)
    && password === passwordConfirmation;
  const canSubmit = reason.trim().length >= 3 && (action?.kind === "EDIT" ? Boolean(validEdit)
    : action?.kind === "RESET_PASSWORD" ? validPassword
      : action?.kind === "DELETE" ? confirmation.trim().toLocaleUpperCase("vi-VN") === action.row.code.toLocaleUpperCase("vi-VN") : false);

  async function submit() {
    if (!action || !canSubmit) return;
    setSaving(true); setError(""); setMessage("");
    const body: Record<string, unknown> = {
      storeId: action.row.storeId, id: action.row.id, versionToken: action.row.versionToken, reason: reason.trim(),
    };
    if (action.kind === "EDIT" && draft) Object.assign(body, {
      action: "EDIT_PROFILE", ...draft, age: Number(draft.age), hourlyRate: parseNumber(draft.hourlyRate),
      tiktokAllowance: parseNumber(draft.tiktokAllowance), username: draft.username.trim(),
    });
    if (action.kind === "RESET_PASSWORD") Object.assign(body, { action: "RESET_PASSWORD", password, passwordConfirmation });
    if (action.kind === "DELETE") body.confirmation = confirmation.trim();
    try {
      const response = await fetch("/api/admin/employees", {
        method: action.kind === "DELETE" ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({})) as { message?: string; warning?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể cập nhật nhân viên.");
      setMessage([data.message, data.warning].filter(Boolean).join(" "));
      close();
      if (action.kind === "DELETE" && rows.length === 1 && page > 1) setPage((current) => current - 1);
      else await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Không thể cập nhật nhân viên.");
    } finally { setSaving(false); }
  }

  return <div className={styles.page}>
    <section className={styles.panel} aria-labelledby="employee-directory-title">
      <header className={styles.header}>
        <div><h2 id="employee-directory-title">Danh sách nhân viên toàn hệ thống</h2><p>Hồ sơ và tài khoản của tất cả cửa hàng. Mật khẩu hiện tại luôn được mã hóa và không thể xem; quản trị chỉ có thể đặt lại mật khẩu mới.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={17}/> Làm mới</button>
      </header>
      <div className={styles.toolbar}>
        <label><span>Tìm nhân viên</span><span className={styles.search}><Search size={17}/><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Tên, mã, SĐT hoặc tài khoản"/></span></label>
        <div><b>{pagination.total}</b><span> nhân viên</span></div>
      </div>
      {error && !action ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.message} role="status">{message}</p> : null}
      <div className={styles.tableWrap} aria-busy={loading}>
        {loading ? <p className={styles.empty}>Đang tải danh sách…</p> : rows.length === 0 ? <p className={styles.empty}>Không có nhân viên phù hợp.</p> : <table className={styles.table}>
          <thead><tr><th>Cửa hàng / nhân viên</th><th>Liên hệ / hồ sơ</th><th>Lương / phụ cấp</th><th>Tài khoản</th><th>Đối soát</th><th>Thao tác</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td data-label="Cửa hàng / nhân viên"><span className={styles.store}>{row.storeName}</span><b>{row.code} · {row.name}</b><small>{row.position}{row.age ? ` · ${row.age} tuổi` : ""}</small></td>
            <td data-label="Liên hệ / hồ sơ"><b>{row.phone || "Không có SĐT"}</b><small>{[row.addressLine, row.ward, row.province].filter(Boolean).join(", ") || "Chưa có địa chỉ"}</small>{row.cccdImageKey ? <a href={`/api/uploads?key=${encodeURIComponent(row.cccdImageKey)}`} target="_blank" rel="noopener noreferrer"><Eye size={14}/> Xem ảnh CCCD</a> : <small>Chưa có ảnh CCCD</small>}</td>
            <td data-label="Lương / phụ cấp"><b>{money(row.hourlyRate)}/giờ</b><small>Phụ cấp TikTok {money(row.tiktokAllowance)}</small></td>
            <td data-label="Tài khoản"><b>{row.username || "Chưa có tài khoản"}</b><span className={`${styles.account} ${styles[row.accountStatus.toLowerCase()]}`}>{accountLabels[row.accountStatus]}</span><small>Mật khẩu: đã mã hóa, không hiển thị</small></td>
            <td data-label="Đối soát"><b>{row.shiftCount} ca · {row.orderCount} đơn</b><small>{row.payrollClosingCount} kỳ lương · {row.activeShiftCount} ca đang mở</small><span className={`${styles.status} ${styles[row.status.toLowerCase()]}`}>{row.statusLabel}</span></td>
            <td data-label="Thao tác"><div className={styles.actions}><button type="button" onClick={() => begin("EDIT", row)}><Edit3 size={15}/> Sửa</button><button type="button" onClick={() => begin("RESET_PASSWORD", row)} disabled={!row.hasLogin}><KeyRound size={15}/> Đặt lại mật khẩu</button><button type="button" className={styles.delete} onClick={() => begin("DELETE", row)}><Trash2 size={15}/> Xóa</button></div></td>
          </tr>)}</tbody>
        </table>}
      </div>
      <footer className={styles.pagination}><span>Trang {pagination.page}/{pagination.pages}</span><div><button type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Trang trước</button><button type="button" disabled={loading || page >= pagination.pages} onClick={() => setPage((current) => current + 1)}>Trang sau</button></div></footer>
    </section>

    {action ? <div ref={modalRootRef} className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="employee-directory-dialog-title" tabIndex={-1} aria-busy={saving}>
        <button type="button" className={styles.close} onClick={close} disabled={saving} aria-label="Đóng"><X size={19}/></button>
        <h3 id="employee-directory-dialog-title">{action.kind === "EDIT" ? `Sửa hồ sơ ${action.row.name}` : action.kind === "RESET_PASSWORD" ? `Đặt lại mật khẩu ${action.row.name}` : `Xóa ${action.row.name}`}</h3>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {action.kind === "EDIT" && draft ? <div className={styles.formGrid}>
          <label>Họ và tên<input ref={initialFocusRef} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
          <label>Chức vụ<input value={draft.position} onChange={(event) => setDraft({ ...draft, position: event.target.value })}/></label>
          <label>Số điện thoại<input value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })}/></label>
          <label>Tuổi<input type="number" min="15" max="100" value={draft.age} onChange={(event) => setDraft({ ...draft, age: event.target.value })}/></label>
          <label>Tỉnh/thành phố<input value={draft.province} onChange={(event) => setDraft({ ...draft, province: event.target.value })}/></label>
          <label>Phường/xã<input value={draft.ward} onChange={(event) => setDraft({ ...draft, ward: event.target.value })}/></label>
          <label className={styles.full}>Địa chỉ<input value={draft.addressLine} onChange={(event) => setDraft({ ...draft, addressLine: event.target.value })}/></label>
          <label>Lương/giờ<input inputMode="numeric" value={draft.hourlyRate} onChange={(event) => setDraft({ ...draft, hourlyRate: numberText(parseNumber(event.target.value)) })}/></label>
          <label>Phụ cấp TikTok<input inputMode="numeric" value={draft.tiktokAllowance} onChange={(event) => setDraft({ ...draft, tiktokAllowance: numberText(parseNumber(event.target.value)) })}/></label>
          <label className={styles.full}>Tên đăng nhập<input value={draft.username} disabled={!action.row.hasLogin} onChange={(event) => setDraft({ ...draft, username: event.target.value })}/></label>
        </div> : null}
        {action.kind === "RESET_PASSWORD" ? <div className={styles.resetBox}><ShieldAlert size={20}/><p>Hệ thống không lưu mật khẩu dạng đọc được. Mật khẩu mới sẽ thay thế mật khẩu cũ và toàn bộ phiên đăng nhập hiện tại bị thu hồi.</p><label>Mật khẩu mới<input ref={initialFocusRef} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)}/><small>10–128 ký tự, có ít nhất một chữ và một số.</small></label><label>Nhập lại mật khẩu<input type="password" autoComplete="new-password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)}/></label></div> : null}
        {action.kind === "DELETE" ? <div className={styles.danger}><ShieldAlert size={20}/><p>Tài khoản và dữ liệu nhận dạng sẽ bị xóa; lịch sử tài chính được giữ dưới mã ẩn danh để không làm sai báo cáo.</p><label>Nhập mã <b>{action.row.code}</b> để xác nhận<input ref={initialFocusRef} autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}/></label></div> : null}
        <label className={styles.reason}>Lý do thao tác<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Nhập ít nhất 3 ký tự"/></label>
        <div className={styles.dialogActions}><button type="button" onClick={close} disabled={saving}>Hủy</button><button type="button" className={action.kind === "DELETE" ? styles.confirmDelete : styles.confirm} onClick={() => void submit()} disabled={saving || !canSubmit}>{saving ? "Đang lưu…" : action.kind === "DELETE" ? "Xóa khỏi hệ thống" : action.kind === "RESET_PASSWORD" ? "Đặt lại và đăng xuất" : "Lưu thay đổi"}</button></div>
      </section>
    </div> : null}
  </div>;
}
