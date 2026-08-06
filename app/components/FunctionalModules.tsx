"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";

export type FunctionalStore = { id: string; name: string; address: string; revenue: number; expense: number; profit: number; status: string };
export type FunctionalUser = { id: string; name: string; storeId: string | null; employeeId: string | null };
type BusinessRecord = { id: string; category: string; store_id: string | null; title: string; data: Record<string, unknown>; status: string; created_at: string; updated_at: string };
type Employee = { id: string; store_id: string; code: string; name: string; position: string; phone: string; hourly_rate: number; status: string; username?: string };
type ShiftRow = { id: string; shift_code: string; started_at: string; ended_at: string | null; tiktok_allowance: number; employeeCode: string; employeeName: string; hourlyRate: number; status: string };

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value)) + " đ";
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
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [month, setMonth] = useState(monthNow());
  const [message, setMessage] = useState("");
  const { records, reload } = useRecords("MANAGER_PAYROLL");
  const store = stores.find((item) => item.id === storeId);
  const salary = 3000000;
  const bonus = Math.max(0, Math.round((store?.profit ?? 0) * .02));
  async function save() {
    const response = await fetch("/api/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "MANAGER_PAYROLL", storeId, title: `${store?.name ?? "Cửa hàng"} · ${month}`, data: { month, salary, bonus, total: salary + bonus, formula: "2% lợi nhuận" } }) });
    const result = await response.json(); setMessage(response.ok ? "✓ Đã chốt lương thưởng quản lý." : result.message); if (response.ok) reload();
  }
  return <div className="page-content"><div className="form-card"><div className="form-grid two"><label>Cửa hàng<select value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Tháng / Năm<input type="month" value={month} onChange={(e) => setMonth(e.target.value)}/></label><label>Lương cố định<input value={money(salary)} disabled/></label><label>Thưởng = 2% lợi nhuận<input value={money(bonus)} disabled/></label></div><div className="share-total"><span>Tổng nhận</span><b>{money(salary + bonus)}</b></div><button className="primary-button align-right" onClick={save}>Lưu bảng lương</button>{message && <div className={message.startsWith("✓") ? "success-banner" : "form-message"}>{message}</div>}</div><div className="table-card"><div className="table-head"><h2>Lịch sử lương thưởng quản lý</h2><button onClick={() => downloadCsv("luong-quan-ly.csv", [["Kỳ", "Cửa hàng", "Lương", "Thưởng", "Tổng"], ...records.map((r) => [String(r.data.month ?? ""), r.title, Number(r.data.salary ?? 0), Number(r.data.bonus ?? 0), Number(r.data.total ?? 0)])])}><Download size={16}/> Xuất Excel</button></div><table className="data-table"><thead><tr><th>Kỳ</th><th>Cửa hàng</th><th>Lương</th><th>Thưởng</th><th>Tổng nhận</th><th>Thao tác</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{String(record.data.month ?? "")}</td><td>{record.title}</td><td>{money(Number(record.data.salary ?? 0))}</td><td>{money(Number(record.data.bonus ?? 0))}</td><td className="money-green">{money(Number(record.data.total ?? 0))}</td><td><button className="danger-link" onClick={() => removeRecord(record.id, reload)}>Xóa</button></td></tr>)}</tbody></table></div></div>;
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
  return <><div className="stats-grid three"><div className="stat-card green"><div><span>TỔNG BẢN GHI</span><strong>{records.length}</strong><small>Dữ liệu đã lưu</small></div></div><div className="stat-card orange"><div><span>TỔNG GIÁ TRỊ</span><strong>{money(total)}</strong><small>Theo danh mục</small></div></div><div className="stat-card blue"><div><span>CẬP NH…40811 tokens truncated…a 1", "07:02", "12:05", "5,05 giờ", "20.000 đ", "101.000 đ"], ["04/08/2026", "NV001", "Ca 2", "12:01", "17:03", "5,03 giờ", "20.000 đ", "100.600 đ"], ["03/08/2026", "NV001", "Ca 3", "17:00", "23:03", "6,05 giờ", "20.000 đ", "121.000 đ"], ["02/08/2026", "NV001", "Ca 1", "07:00", "12:00", "5,00 giờ", "20.000 đ", "100.000 đ"]].map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j} className={j === 7 ? "money-green" : ""}>{x}</td>)}</tr>)}</tbody></table></div></>; }

// Kept as visual fallbacks while the functional modules above handle all active routes.
void [TasksView, ManagerPayroll, TransferView, DividendView, EmployeePayroll, EmployeeHistory];
