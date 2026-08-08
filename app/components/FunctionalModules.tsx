"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, Download, Eye, EyeOff, KeyRound, Languages, LockKeyhole, Pencil, Plus, Save, ShieldCheck, Trash2, UserRoundCog } from "lucide-react";

export type FunctionalStore = { id: string; name: string; address: string; revenue: number; expense: number; profit: number; status: string };
export type FunctionalUser = { id: string; name: string; storeId: string | null; employeeId: string | null };
type BusinessRecord = { id: string; category: string; store_id: string | null; title: string; data: Record<string, unknown>; status: string; created_at: string; updated_at: string };
type Employee = { id: string; store_id: string; code: string; name: string; position: string; phone: string; hourly_rate: number; status: string; username?: string };
type ShiftRow = { id: string; shift_code: string; started_at: string; ended_at: string | null; tiktok_allowance: number; employeeCode: string; employeeName: string; hourlyRate: number; status: string };

const money = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value)) + " đồng";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const monthNow = () => today().slice(0, 7);
const dateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));

function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const safe = (value: string | number | null | undefined) => {
    const raw = String(value ?? "");
    const protectedValue = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${protectedValue.replaceAll('"', '""')}"`;
  };
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

function useRecords(category: string, storeId?: string | null) {
  const [records, setRecords] = useState<BusinessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ category });
    if (storeId) query.set("storeId", storeId);
    const response = await fetch(`/api/records?${query}`);
    const result = await response.json();
    setRecords(result.records ?? []); setLoading(false);
  }, [category, storeId]);
  useEffect(() => { reload(); }, [reload]);
  return { records, loading, reload };
}

async function removeRecord(id: string, reload: () => Promise<void>) {
  if (!confirm("Xóa dữ liệu này?")) return;
  await fetch(`/api/records?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  await reload();
}

export function FunctionalTaskManager({ stores }: { stores: FunctionalStore[] }) {
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [shift, setShift] = useState("CA 1 · 07:00 - 12:00");
  const [date, setDate] = useState(today());
  const [items, setItems] = useState(["Mở cửa hàng, kiểm tra vệ sinh", "Sắp xếp và bổ sung hàng trên kệ", "Tư vấn và hỗ trợ khách hàng", "Báo cáo doanh thu cuối ca"]);
  const [message, setMessage] = useState("");
  const { records, reload } = useRecords("TASKS", storeId);
  useEffect(() => { if (!storeId && stores[0]) setStoreId(stores[0].id); }, [storeId, stores]);
  async function save() {
    const validItems = items.map((content) => content.trim()).filter(Boolean).map((content) => ({ content, completedBy: [] }));
    if (!storeId || validItems.length === 0) return setMessage("Vui lòng chọn cửa hàng và nhập ít nhất một công việc.");
    const response = await fetch("/api/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "TASKS", storeId, title: `Công việc ${shift} · ${date}`, data: { shift, date, items: validItems } }) });
    const result = await response.json();
    setMessage(response.ok ? `✓ Đã gửi ${validItems.length} công việc đến nhân viên.` : result.message);
    if (response.ok) await reload();
  }
  return <div className="page-content split-layout"><section className="form-card"><div className="form-grid three"><label>Cửa hàng<select value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Ca làm<select value={shift} onChange={(e) => setShift(e.target.value)}><option>CA 1 · 07:00 - 12:00</option><option>CA 2 · 12:00 - 17:00</option><option>CA 3 · 17:00 - 23:00</option></select></label><label>Ngày áp dụng<input type="date" value={date} onChange={(e) => setDate(e.target.value)}/></label></div><h2>Danh sách công việc</h2><div className="task-editor">{items.map((task, index) => <div key={index}><span>{index + 1}</span><input value={task} onChange={(e) => setItems(items.map((item, i) => i === index ? e.target.value : item))}/><button type="button" onClick={() => setItems(items.filter((_, i) => i !== index))}>×</button></div>)}</div><button className="ghost-button" onClick={() => setItems([...items, ""])}>＋ Thêm công việc</button><button className="primary-button send-button" onClick={save}>➤ Lưu và gửi</button>{message && <div className={message.startsWith("✓") ? "success-banner" : "form-message"}>{message}</div>}</section><aside className="help-card"><h2>Lịch sử đã gửi</h2>{records.length === 0 ? <p>Chưa có danh sách công việc.</p> : records.slice(0, 6).map((record) => <div className="record-summary" key={record.id}><b>{record.title}</b><span>{Array.isArray(record.data.items) ? record.data.items.length : 0} việc</span><button className="danger-link" onClick={() => removeRecord(record.id, reload)}>Xóa</button></div>)}</aside></div>;
}

export function FunctionalEmployeeTasks({ user }: { user: FunctionalUser }) {
  const { records, reload } = useRecords("TASKS", user.storeId);
  const current = records.filter((record) => String(record.data.date ?? "") === today());
  const items = current.flatMap((record) => (Array.isArray(record.data.items) ? record.data.items as Array<{ content?: string; completedBy?: string[] }> : []).map((item, index) => ({ record, item, index })));
  async function toggle(recordId: string, completedIndex: number) {
    await fetch("/api/records", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: recordId, completedIndex }) });
    await reload();
  }
  const done = items.filter(({ item }) => item.completedBy?.includes(user.id)).length;
  return <section className="table-card task-card"><div className="table-head"><h2>✓ Công việc cần làm</h2><span>{done}/{items.length} hoàn thành</span></div>{items.length === 0 ? <div className="empty-cell">Quản lý chưa giao việc cho hôm nay.</div> : items.map(({ record, item, index }, row) => <label className="task-row" key={`${record.id}-${index}`}><span>{row + 1}</span><b>{item.content}</b><small>{record.title}</small><input type="checkbox" checked={Boolean(item.completedBy?.includes(user.id))} onChange={() => toggle(record.id, index)}/></label>)}</section>;
}

export function FunctionalManagerPayroll({ stores }: { stores: FunctionalStore[] }) {
  return <div className="page-content"><section className="form-card"><h2>Lương thưởng quản lý được lấy từ kỳ đã khóa</h2><div className="notice-banner" role="note">Màn hình cũ này chỉ cung cấp hướng dẫn và không được tạo bảng lương thủ công. Hãy dùng danh mục <b>Lương thưởng quản lý</b> để xem số liệu đã xác nhận chi và khóa sổ.</div><div className="payroll-guide"><p>Lương cố định: <b>{money(3_000_000)}/cửa hàng/kỳ</b>.</p><p>Giờ quản lý cố định: <b>140 giờ/cửa hàng</b>.</p><p>Thưởng KPI dùng chung quỹ với nhân viên theo tỷ trọng giờ và một trong ba ngưỡng <b>3%, 5% hoặc 7%</b>; không nhập hoặc sửa thủ công.</p></div></section><section className="table-card"><div className="table-head"><h2>Cửa hàng áp dụng chính sách</h2><span>{stores.length} cửa hàng</span></div><table className="data-table"><thead><tr><th>Cửa hàng</th><th>Lương cố định</th><th>Giờ quản lý</th><th>Nguồn số liệu</th></tr></thead><tbody>{stores.length === 0 ? <tr><td colSpan={4} className="empty-cell">Chưa có cửa hàng.</td></tr> : stores.map((store) => <tr key={store.id}><td><b>{store.name}</b></td><td>{money(3_000_000)}</td><td>140 giờ</td><td>Kỳ lương đã xác nhận chi và khóa</td></tr>)}</tbody></table></section></div>;
}

export function FunctionalEmployees({ store }: { store: FunctionalStore }) {
  const empty = { id: "", code: "", name: "", position: "Nhân viên bán hàng", phone: "", hourlyRate: "20000", username: "", password: "" };
  const [employees, setEmployees] = useState<Employee[]>([]); const [form, setForm] = useState(empty); const [open, setOpen] = useState(false); const [message, setMessage] = useState("");
  const reload = useCallback(async () => { const result = await (await fetch(`/api/employees?storeId=${store.id}`)).json(); setEmployees(result.employees ?? []); }, [store.id]);
  useEffect(() => { reload(); }, [reload]);
  function edit(item?: Employee) { setForm(item ? { id: item.id, code: item.code, name: item.name, position: item.position, phone: item.phone, hourlyRate: String(item.hourly_rate), username: item.username ?? "", password: "" } : empty); setMessage(""); setOpen(true); }
  async function save(event: FormEvent) { event.preventDefault(); const response = await fetch("/api/employees", { method: form.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, storeId: store.id }) }); const result = await response.json(); if (!response.ok) return setMessage(result.message); setOpen(false); await reload(); }
  async function archive(id: string) { if (!confirm("Lưu trữ nhân viên và thu hồi phiên đăng nhập?")) return; await fetch(`/api/employees?id=${id}`, { method: "DELETE" }); reload(); }
  return <><div className="toolbar"><div className="stats-inline"><b>{employees.length}</b> nhân viên đang quản lý</div><button className="primary-button" onClick={() => edit()}><Plus size={17}/> Thêm nhân viên</button></div><div className="table-card"><div className="table-head"><h2>Danh sách nhân viên</h2></div><table className="data-table"><thead><tr><th>Mã NV</th><th>Họ tên</th><th>Chức vụ</th><th>SĐT</th><th>Lương/giờ</th><th>Tài khoản</th><th>Thao tác</th></tr></thead><tbody>{employees.map((employee) => <tr key={employee.id}><td><b>{employee.code}</b></td><td>{employee.name}</td><td>{employee.position}</td><td>{employee.phone}</td><td>{money(employee.hourly_rate)}</td><td>{employee.username ?? "—"}</td><td><div className="row-actions"><button onClick={() => edit(employee)}><Pencil size={15}/> Sửa</button><button className="danger" onClick={() => archive(employee.id)}><Trash2 size={15}/> Xóa</button></div></td></tr>)}</tbody></table></div>{open && <div className="modal-backdrop"><form className="modal" onSubmit={save}><div className="modal-title"><h2>{form.id ? "Cập nhật nhân viên" : "Thêm nhân viên"}</h2><button type="button" onClick={() => setOpen(false)}>×</button></div><div className="form-grid two"><label>Mã nhân viên<input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })}/></label><label>Họ tên<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label>Chức vụ<input required value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}/></label><label>Số điện thoại<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}/></label><label>Lương theo giờ<input type="number" min="1" required value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}/></label><label>Tên đăng nhập<input disabled={Boolean(form.id)} required={!form.id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}/></label><label>Mật khẩu {form.id && "(để trống nếu giữ nguyên)"}<input type="password" required={!form.id} minLength={6} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}/></label></div>{message && <div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>Hủy</button><button className="primary-button">Lưu nhân viên</button></div></form></div>}</>;
}

const categoryMap: Record<string, string> = { "Ca làm việc": "CA_LAM_VIEC", "Lịch phân ca": "LICH_PHAN_CA", "Nhập hàng": "NHAP_HANG", "Chấm công": "CHAM_CONG", "Lương thưởng": "LUONG_THUONG", "Dòng tiền": "DONG_TIEN", "Báo cáo": "BAO_CAO" };
export function FunctionalStoreRecords({ store, view }: { store: FunctionalStore; view: string }) {
  const category = categoryMap[view] ?? "BAO_CAO"; const { records, reload } = useRecords(category, store.id); const [open, setOpen] = useState(false); const [editing, setEditing] = useState<BusinessRecord | null>(null); const [title, setTitle] = useState(""); const [amount, setAmount] = useState(""); const [date, setDate] = useState(today()); const [note, setNote] = useState(""); const [message, setMessage] = useState("");
  function begin(record?: BusinessRecord) { setEditing(record ?? null); setTitle(record?.title ?? ""); setAmount(String(record?.data.amount ?? "")); setDate(String(record?.data.date ?? today())); setNote(String(record?.data.note ?? "")); setMessage(""); setOpen(true); }
  async function save(event: FormEvent) { event.preventDefault(); const payload = { id: editing?.id, category, storeId: store.id, title, data: { amount: Number(amount || 0), date, note } }; const response = await fetch("/api/records", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) return setMessage(result.message); setOpen(false); reload(); }
  const total = records.reduce((sum, record) => sum + Number(record.data.amount ?? 0), 0);
  return <><div className="stats-grid three"><div className="stat-card green"><div><span>TỔNG BẢN GHI</span><strong>{records.length}</strong><small>Dữ liệu đã lưu</small></div></div><div className="stat-card orange"><div><span>TỔNG GIÁ TRỊ</span><strong>{money(total)}</strong><small>Theo danh mục</small></div></div><div className="stat-card blue"><div><span>CẬP NHẬT</span><strong>{records[0] ? dateTime(records[0].updated_at) : "—"}</strong><small>Gần nhất</small></div></div></div><div className="table-card"><div className="table-head"><h2>Chi tiết {view.toLowerCase()}</h2><div><button onClick={() => downloadCsv(`${category.toLowerCase()}.csv`, [["Ngày", "Nội dung", "Số tiền", "Ghi chú"], ...records.map((r) => [String(r.data.date ?? ""), r.title, Number(r.data.amount ?? 0), String(r.data.note ?? "")])])}><Download size={16}/> Xuất Excel</button><button className="primary-button" onClick={() => begin()}><Plus size={16}/> Thêm mới</button></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Ngày</th><th>Nội dung</th><th>Số tiền/Giá trị</th><th>Ghi chú</th><th>Thao tác</th></tr></thead><tbody>{records.length === 0 ? <tr><td className="empty-cell" colSpan={5}>Chưa có dữ liệu. Bấm “Thêm mới” để bắt đầu.</td></tr> : records.map((record) => <tr key={record.id}><td>{String(record.data.date ?? "")}</td><td>{record.title}</td><td className="money-green">{money(Number(record.data.amount ?? 0))}</td><td>{String(record.data.note ?? "") || "—"}</td><td><div className="row-actions"><button onClick={() => begin(record)}>Sửa</button><button className="danger" onClick={() => removeRecord(record.id, reload)}>Xóa</button></div></td></tr>)}</tbody></table></div></div>{open && <div className="modal-backdrop"><form className="modal" onSubmit={save}><div className="modal-title"><h2>{editing ? "Cập nhật" : "Thêm mới"} {view.toLowerCase()}</h2><button type="button" onClick={() => setOpen(false)}>×</button></div><label>Nội dung<input required value={title} onChange={(e) => setTitle(e.target.value)}/></label><div className="form-grid two"><label>Ngày<input type="date" required value={date} onChange={(e) => setDate(e.target.value)}/></label><label>Số tiền / giá trị<input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}/></label></div><label>Ghi chú<textarea value={note} onChange={(e) => setNote(e.target.value)}/></label>{message && <div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>Hủy</button><button className="primary-button">Lưu dữ liệu</button></div></form></div>}</>;
}

export function FunctionalTransfer({ stores }: { stores: FunctionalStore[] }) {
  const { records, reload } = useRecords("TRANSFER"); const [employees, setEmployees] = useState<Employee[]>([]); const [employeeId, setEmployeeId] = useState(""); const [targetStore, setTargetStore] = useState(stores[1]?.id ?? stores[0]?.id ?? ""); const [start, setStart] = useState(today()); const [end, setEnd] = useState(today()); const [allowance, setAllowance] = useState("500000"); const [reason, setReason] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => { fetch("/api/employees").then((r) => r.json()).then((r) => { setEmployees(r.employees ?? []); if (!employeeId && r.employees?.[0]) setEmployeeId(r.employees[0].id); }); }, [employeeId]);
  async function save() { const employee = employees.find((e) => e.id === employeeId); const target = stores.find((s) => s.id === targetStore); if (!employee || !target || end < start) return setMessage("Vui lòng chọn nhân viên và thời gian hợp lệ."); const response = await fetch("/api/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "TRANSFER", storeId: targetStore, title: `${employee.name} → ${target.name}`, status: "PENDING", data: { employeeId, employeeName: employee.name, sourceStore: employee.store_id, targetStore, targetName: target.name, start, end, shifts: ["Ca sáng", "Ca chiều"], hourlyRate: employee.hourly_rate, allowance: Number(allowance), reason } }) }); const result = await response.json(); setMessage(response.ok ? "✓ Đã lưu điều chuyển, chờ duyệt." : result.message); if (response.ok) reload(); }
  async function setStatus(record: BusinessRecord, status: string) { await fetch("/api/records", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: record.id, title: record.title, data: record.data, status }) }); reload(); }
  return <div className="page-content"><div className="transfer-layout"><section className="form-card"><h2>1. Thông tin nhân viên</h2><label>Nhân viên<select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>{employees.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}</select></label><label>Phụ cấp hỗ trợ<input type="number" min="0" value={allowance} onChange={(e) => setAllowance(e.target.value)}/></label></section><section className="form-card"><h2>2. Thông tin điều chuyển</h2><div className="form-grid two"><label>Cửa hàng nhận<select value={targetStore} onChange={(e) => setTargetStore(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Người phê duyệt<input value="Quản trị viên DORE" disabled/></label><label>Ngày bắt đầu<input type="date" value={start} onChange={(e) => setStart(e.target.value)}/></label><label>Ngày kết thúc<input type="date" value={end} onChange={(e) => setEnd(e.target.value)}/></label></div><label>Lý do<textarea value={reason} onChange={(e) => setReason(e.target.value)}/></label><button className="primary-button" onClick={save}>Lưu điều chuyển</button>{message && <div className={message.startsWith("✓") ? "success-banner" : "form-message"}>{message}</div>}</section><aside className="policy-card"><h2>3. Quyền truy cập</h2><p>✓ Kích hoạt quyền tại cửa hàng nhận khi được duyệt.</p><p>× Thu hồi quyền sau ngày kết thúc.</p><p>⌂ Bảo toàn lịch sử tại cửa hàng chính.</p></aside></div><div className="table-card"><div className="table-head"><h2>Lịch sử điều chuyển</h2><button onClick={() => downloadCsv("dieu-chuyen.csv", [["Nhân viên", "Cửa hàng", "Từ ngày", "Đến ngày", "Trạng thái"], ...records.map((r) => [String(r.data.employeeName ?? ""), String(r.data.targetName ?? ""), String(r.data.start ?? ""), String(r.data.end ?? ""), r.status])])}>Xuất Excel</button></div><table className="data-table"><thead><tr><th>Nhân viên</th><th>Cửa hàng hỗ trợ</th><th>Thời gian</th><th>Phụ cấp</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{String(record.data.employeeName ?? "")}</td><td>{String(record.data.targetName ?? "")}</td><td>{String(record.data.start ?? "")} → {String(record.data.end ?? "")}</td><td>{money(Number(record.data.allowance ?? 0))}</td><td><span className="status-pill">{record.status}</span></td><td><div className="row-actions">{record.status === "PENDING" && <button onClick={() => setStatus(record, "APPROVED")}>Duyệt</button>}{!["CANCELLED", "COMPLETED"].includes(record.status) && <button onClick={() => setStatus(record, "COMPLETED")}>Kết thúc</button>}<button className="danger" onClick={() => setStatus(record, "CANCELLED")}>Hủy</button></div></td></tr>)}</tbody></table></div></div>;
}

export function FunctionalDividend({ totals }: { totals: { revenue: number; expense: number; profit: number } }) {
  const { records, reload } = useRecords("DIVIDEND"); const month = monthNow(); const existing = records.find((record) => String(record.data.month) === month); const profit = Math.max(0, totals.profit); const vi = Math.round(profit * .6); const thuy = profit - vi; const [message, setMessage] = useState("");
  async function lock() { const response = await fetch("/api/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "DIVIDEND", title: `Chia lợi nhuận ${month}`, status: "LOCKED", data: { month, revenue: totals.revenue, expense: totals.expense, profit, vi, thuy, margin: totals.revenue ? profit / totals.revenue * 100 : 0 } }) }); const result = await response.json(); setMessage(response.ok ? "✓ Đã xác nhận chia lợi nhuận và khóa kỳ." : result.message); if (response.ok) reload(); }
  return <div className="page-content"><div className="chart-grid dividend-grid"><section className="chart-card"><h2>Thông tin thành viên</h2><div className="shareholder"><span>PHẠM THỊ DIỄM THÚY <b>40%</b></span><strong>{money(thuy)}</strong></div><div className="shareholder"><span>TRƯƠNG VIỆT VI <b>60%</b></span><strong>{money(vi)}</strong></div><div className="share-total"><span>Tổng lợi nhuận được chia</span><b>{money(profit)}</b></div><button disabled={Boolean(existing)} className="primary-button wide" onClick={lock}>{existing ? "✓ Kỳ chia lợi nhuận đã khóa" : "Xác nhận chia lợi nhuận"}</button>{message && <div className="success-banner">{message}</div>}</section><section className="chart-card"><h2>Nguyên tắc tính</h2><p>Lợi nhuận sau cùng = Doanh thu − toàn bộ chi phí.</p><p>Số liệu được chụp tại thời điểm khóa kỳ và không tự thay đổi về sau.</p></section></div><div className="table-card"><div className="table-head"><h2>Lịch sử chia lợi nhuận</h2><button onClick={() => downloadCsv("chia-loi-nhuan.csv", [["Kỳ", "Doanh thu", "Chi phí", "Lợi nhuận", "Diễm Thúy", "Việt Vi"], ...records.map((r) => [String(r.data.month ?? ""), Number(r.data.revenue ?? 0), Number(r.data.expense ?? 0), Number(r.data.profit ?? 0), Number(r.data.thuy ?? 0), Number(r.data.vi ?? 0)])])}>Xuất Excel</button></div><table className="data-table"><thead><tr><th>Kỳ</th><th>Doanh thu</th><th>Chi phí</th><th>Lợi nhuận</th><th>Diễm Thúy</th><th>Việt Vi</th><th>Trạng thái</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{String(record.data.month ?? "")}</td><td>{money(Number(record.data.revenue ?? 0))}</td><td>{money(Number(record.data.expense ?? 0))}</td><td>{money(Number(record.data.profit ?? 0))}</td><td>{money(Number(record.data.thuy ?? 0))}</td><td>{money(Number(record.data.vi ?? 0))}</td><td><span className="status-pill">Đã khóa</span></td></tr>)}</tbody></table></div><div className="ai-analysis"><div className="analysis-illustration">↗</div><div><h2>📈 Kết luận phân tích kỳ {month}</h2><p>Lợi nhuận sau cùng đạt <b>{money(profit)}</b>, biên lợi nhuận <b>{totals.revenue ? (profit / totals.revenue * 100).toFixed(2) : "0"}%</b>. Thành viên Phạm Thị Diễm Thúy nhận {money(thuy)} và thành viên Trương Việt Vi nhận {money(vi)}.</p></div></div></div>;
}

export function FunctionalSettings({ name, email, storeId }: { name: string; email: string; storeId?: string | null }) {
  const { records, reload } = useRecords("PROFILE", storeId);
  const current = records[0];
  const [activeTab, setActiveTab] = useState<"profile" | "password">("profile");
  const [form, setForm] = useState({ name, email, phone: "0901 234 567", address: "Ninh Kiều, TP. Cần Thơ", intro: "Quản lý hệ thống chuỗi cửa hàng DORE." });
  const [message, setMessage] = useState("");
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [passwordVisible, setPasswordVisible] = useState({ current: false, next: false, confirm: false });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  useEffect(() => {
    if (current) setForm({ name: String(current.data.name ?? name), email: String(current.data.email ?? email), phone: String(current.data.phone ?? ""), address: String(current.data.address ?? ""), intro: String(current.data.intro ?? "") });
  }, [current, email, name]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/records", { method: current ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: current?.id, category: "PROFILE", storeId: storeId ?? null, title: `Hồ sơ ${form.name}`, data: form }) });
    const result = await response.json();
    setMessage(response.ok ? "✓ Đã lưu thông tin. Dữ liệu vẫn còn sau khi tải lại trang." : result.message);
    if (response.ok) void reload();
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordSuccess(false);
    if (passwordForm.newPassword.length < 8) return setPasswordMessage("Mật khẩu mới phải có ít nhất 8 ký tự.");
    if (passwordForm.newPassword !== passwordForm.confirmPassword) return setPasswordMessage("Xác nhận mật khẩu mới chưa khớp.");
    if (passwordForm.currentPassword === passwordForm.newPassword) return setPasswordMessage("Mật khẩu mới phải khác mật khẩu hiện tại.");
    setPasswordSaving(true);
    setPasswordMessage("");
    try {
      const response = await fetch("/api/auth/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(passwordForm),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      setPasswordSuccess(response.ok);
      setPasswordMessage(result.message ?? (response.ok ? "Đã đổi mật khẩu an toàn." : "Không thể đổi mật khẩu."));
      if (response.ok) setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
    } finally {
      setPasswordSaving(false);
    }
  }

  function togglePassword(field: keyof typeof passwordVisible) {
    setPasswordVisible((value) => ({ ...value, [field]: !value[field] }));
  }

  return <div className="page-content settings-layout">
    <aside className="settings-nav">
      <h2>Cài đặt</h2>
      <button type="button" className={activeTab === "profile" ? "active" : ""} onClick={() => setActiveTab("profile")}><UserRoundCog size={19}/><span>Thông tin cá nhân</span></button>
      <button type="button" className={activeTab === "password" ? "active" : ""} onClick={() => setActiveTab("password")}><KeyRound size={19}/><span>Đổi mật khẩu</span></button>
      <button type="button" disabled title="Tính năng đang được hoàn thiện"><BellRing size={19}/><span>Thông báo</span></button>
      <button type="button" disabled title="Hệ thống hiện dùng tiếng Việt"><Languages size={19}/><span>Ngôn ngữ</span></button>
    </aside>
    {activeTab === "profile" ? <section className="form-card settings-content">
      <div className="settings-section-heading"><i><UserRoundCog size={23}/></i><div><h2>Thông tin cá nhân</h2><p className="muted">Cập nhật thông tin tài khoản quản lý.</p></div></div>
      <form onSubmit={save}>
        <div className="profile-form"><div className="profile-photo" aria-hidden="true">{form.name.slice(0, 1)}</div><div className="form-grid two"><label>Họ và tên<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}/></label><label>Số điện thoại<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}/></label><label>Chức vụ<input value="Quản lý hệ thống" disabled/></label></div></div>
        <label>Địa chỉ<input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}/></label>
        <label>Giới thiệu<textarea value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })}/></label>
        <div className="settings-actions"><button type="submit" className="primary-button"><Save size={17}/> Lưu thay đổi</button></div>
      </form>
      {message && <div role="status" className={message.startsWith("✓") ? "success-banner" : "form-message"}>{message}</div>}
    </section> : <section className="form-card settings-content password-settings">
      <div className="settings-section-heading"><i><KeyRound size={23}/></i><div><h2>Đổi mật khẩu</h2><p className="muted">Cập nhật mật khẩu của tài khoản quản lý đang đăng nhập.</p></div></div>
      <div className="settings-security-note"><ShieldCheck size={21}/><span><b>Bảo vệ tài khoản</b><small>Sau khi đổi, các phiên đăng nhập khác sẽ tự động bị thu hồi; phiên hiện tại vẫn được giữ.</small></span></div>
      <form className="password-settings-form" onSubmit={changePassword}>
        <label>Mật khẩu hiện tại<div className="settings-password-input"><LockKeyhole size={18}/><input required type={passwordVisible.current ? "text" : "password"} autoComplete="current-password" value={passwordForm.currentPassword} onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })}/><button type="button" aria-label={passwordVisible.current ? "Ẩn mật khẩu hiện tại" : "Hiện mật khẩu hiện tại"} onClick={() => togglePassword("current")}>{passwordVisible.current ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>
        <label>Mật khẩu mới<div className="settings-password-input"><KeyRound size={18}/><input required minLength={8} maxLength={128} type={passwordVisible.next ? "text" : "password"} autoComplete="new-password" value={passwordForm.newPassword} onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} aria-describedby="new-password-hint"/><button type="button" aria-label={passwordVisible.next ? "Ẩn mật khẩu mới" : "Hiện mật khẩu mới"} onClick={() => togglePassword("next")}>{passwordVisible.next ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div><small id="new-password-hint">Ít nhất 8 ký tự và khác mật khẩu hiện tại.</small></label>
        <label>Xác nhận mật khẩu mới<div className="settings-password-input"><ShieldCheck size={18}/><input required minLength={8} maxLength={128} type={passwordVisible.confirm ? "text" : "password"} autoComplete="new-password" value={passwordForm.confirmPassword} onChange={(event) => setPasswordForm({ ...passwordForm, confirmPassword: event.target.value })}/><button type="button" aria-label={passwordVisible.confirm ? "Ẩn xác nhận mật khẩu" : "Hiện xác nhận mật khẩu"} onClick={() => togglePassword("confirm")}>{passwordVisible.confirm ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>
        <div className="settings-actions"><button type="submit" className="primary-button" disabled={passwordSaving}><KeyRound size={17}/> {passwordSaving ? "Đang đổi..." : "Đổi mật khẩu"}</button></div>
      </form>
      {passwordMessage && <div role={passwordSuccess ? "status" : "alert"} className={passwordSuccess ? "success-banner" : "form-message"}>{passwordMessage}</div>}
    </section>}
  </div>;
}

export function FunctionalEmployeeHistory({ payroll = false }: { payroll?: boolean }) {
  const [shifts, setShifts] = useState<ShiftRow[]>([]); const [from, setFrom] = useState(monthNow() + "-01"); const [to, setTo] = useState(today());
  const reload = useCallback(async () => { const result = await (await fetch("/api/shifts")).json(); setShifts(result.shifts ?? []); }, []); useEffect(() => { reload(); }, [reload]);
  const filtered = useMemo(() => shifts.filter((shift) => { const date = shift.started_at.slice(0, 10); return (!from || date >= from) && (!to || date <= to); }), [from, shifts, to]);
  const rows = filtered.map((shift) => { const end = shift.ended_at ? new Date(shift.ended_at) : new Date(); const hours = Math.max(0, (end.getTime() - new Date(shift.started_at).getTime()) / 3600000); const wage = Math.round(hours * shift.hourlyRate); return { ...shift, hours, wage, total: wage + shift.tiktok_allowance }; });
  const totalWage = rows.reduce((sum, row) => sum + row.wage, 0); const totalAllowance = rows.reduce((sum, row) => sum + row.tiktok_allowance, 0);
  return <>{payroll && <div className="stats-grid three"><div className="stat-card green"><div><span>TỔNG THU NHẬP</span><strong>{money(totalWage + totalAllowance)}</strong></div></div><div className="stat-card blue"><div><span>LƯƠNG THEO GIỜ</span><strong>{money(totalWage)}</strong></div></div><div className="stat-card orange"><div><span>PHỤ CẤP TIKTOK</span><strong>{money(totalAllowance)}</strong></div></div></div>}<div className="filter-card"><label>Từ ngày<input type="date" value={from} onChange={(e) => setFrom(e.target.value)}/></label><label>Đến ngày<input type="date" value={to} onChange={(e) => setTo(e.target.value)}/></label><button className="primary-button" onClick={reload}>Làm mới</button></div><div className="table-card"><div className="table-head"><h2>{payroll ? "Chi tiết bảng lương theo ca" : "Lịch sử ca làm"}</h2><button onClick={() => downloadCsv(payroll ? "bang-luong.csv" : "lich-su-ca.csv", [["Mã ca", "Bắt đầu", "Kết thúc", "Số giờ", "Lương", "Phụ cấp TikTok", "Tổng"], ...rows.map((r) => [r.shift_code, r.started_at, r.ended_at, r.hours.toFixed(2), r.wage, r.tiktok_allowance, r.total])])}><Download size={16}/> Xuất Excel</button></div><table className="data-table"><thead><tr><th>Mã ca</th><th>Giờ vào</th><th>Giờ kết ca</th><th>Số giờ</th><th>Lương giờ</th><th>Phụ cấp TikTok</th><th>Thành tiền</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={7} className="empty-cell">Chưa có ca đã ghi nhận trong khoảng thời gian.</td></tr> : rows.map((row) => <tr key={row.id}><td>{row.shift_code}</td><td>{dateTime(row.started_at)}</td><td>{row.ended_at ? dateTime(row.ended_at) : "Đang làm"}</td><td>{row.hours.toFixed(2)} giờ</td><td>{money(row.wage)}</td><td>{money(row.tiktok_allowance)}</td><td className="money-green">{money(row.total)}</td></tr>)}</tbody></table></div></>;
}
