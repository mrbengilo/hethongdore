"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  BarChart3, CheckCircle2, ChevronLeft, ChevronRight, Clock3,
  Download, Edit3, Gift, PackageOpen, Plus, Search, Trash2, UserRound,
  UsersRound, WalletCards, X,
} from "lucide-react";
import StorePayrollClosing from "./StorePayrollClosing";

export type ReferenceStore = {
  id: string; name: string; address: string; revenue: number; expense: number;
  profit: number; status: string;
};
type BusinessRecord = {
  id: string; title: string; data: Record<string, unknown>; status: string;
  created_at?: string; updated_at: string;
};
type Employee = {
  id: string; store_id: string; code: string; name: string; position: string;
  phone: string; hourly_rate: number; status: string; username?: string;
};
type ShiftSession = {
  id: string; shift_code: string; started_at: string; ended_at: string | null;
  employeeCode: string; employeeName: string; hourlyRate: number; status: string;
  shiftName?: string | null; workDate?: string | null; appliedHourlyRate?: number | null; transfer_id?: string | null;
  tiktok_allowance?: number; cash_revenue?: number; transfer_revenue?: number;
  expense_amount?: number; expense_note?: string;
  duration_seconds?: number; supportAllowance?: number | null; sourceStoreName?: string | null; targetStoreName?: string | null;
};
type PayrollItem = {
  employeeId: string; employeeCode: string; employeeName: string; position: string;
  hours: number; hourlyRate: number; baseSalary: number; tiktokAllowance: number;
  supportAllowance: number; manualAllowance: number; manualBonus: number; kpiBonus: number; totalPay: number;
};
type PayrollSummary = {
  period: string; storeId: string; storeName: string; revenue: number; expense: number;
  profit: number; totalHours: number; profitPerHour: number; kpiRate: number;
  totalBaseSalary: number; totalTikTokAllowance: number; totalSupportAllowance: number; totalManualAllowance: number;
  totalManualBonus: number; totalKpiBonus: number; totalPay: number;
  items: PayrollItem[]; status: "PREVIEW" | "LOCKED"; finalizedAt?: string;
};

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value)) + " đ";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const dateLabel = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value + "T12:00:00+07:00"));
const timeLabel = (value: string | null) => value ? new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value)) : "—";
const sessionRate = (shift: { hourlyRate: number; appliedHourlyRate?: number | null }) => Number(shift.appliedHourlyRate ?? shift.hourlyRate ?? 0);
const defaultShifts = [
  { id: "default-1", title: "Ca 1", start: "07:00", end: "15:00", tone: "s1" },
  { id: "default-2", title: "Ca 2", start: "15:00", end: "22:00", tone: "s2" },
  { id: "default-3", title: "Ca 3", start: "22:00", end: "07:00", tone: "s3" },
];
const samplePeople = [
  ["Nguyễn Thị An", "Bán hàng"], ["Trần Văn Bình", "Bán hàng"],
  ["Lê Thị Cúc", "Thu ngân"], ["Phạm Hoàng Dũng", "Kho"],
  ["Võ Thị Mai", "Bán hàng"], ["Đặng Minh Khang", "Bán hàng"],
];
const sampleGoods = [
  ["Chân váy", 15, "Bao", 120, 120000, 15000],
  ["Đồ nam", 20, "Bao", 210.5, 150000, 20000],
  ["Áo dài", 10, "Bao", 80, 200000, 15000],
  ["Đồ bộ", 18, "Bao", 150.3, 130000, 18000],
  ["Phụ kiện", 25, "Bao", 45, 60000, 10000],
] as const;

function csv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const safe = (value: string | number | null | undefined) => {
    const raw = String(value ?? ""); const protectedValue = /^[=+\-@]/.test(raw) ? "'" + raw : raw;
    return '"' + protectedValue.replaceAll('"', '""') + '"';
  };
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

function useRecords(category: string, storeId: string) {
  const [records, setRecords] = useState<BusinessRecord[]>([]);
  const reload = useCallback(async () => {
    const q = new URLSearchParams({ category, storeId });
    const data = await (await fetch("/api/records?" + q)).json();
    setRecords(data.records ?? []);
  }, [category, storeId]);
  useEffect(() => { reload(); }, [reload]);
  return { records, reload };
}

function useEmployees(storeId: string) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const reload = useCallback(async () => {
    const data = await (await fetch("/api/employees?storeId=" + encodeURIComponent(storeId))).json();
    setEmployees(data.employees ?? []);
  }, [storeId]);
  useEffect(() => { reload(); }, [reload]);
  return { employees, reload };
}

function useShiftSessions(storeId: string) {
  const [shifts, setShifts] = useState<ShiftSession[]>([]);
  const reload = useCallback(async () => {
    const data = await (await fetch("/api/shifts?storeId=" + encodeURIComponent(storeId))).json();
    setShifts(data.shifts ?? []);
  }, [storeId]);
  useEffect(() => { reload(); }, [reload]);
  return { shifts, reload };
}

async function saveRecord(input: {
  id?: string; category: string; storeId: string; title: string; data: Record<string, unknown>;
}) {
  const response = await fetch("/api/records", {
    method: input.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Không thể lưu dữ liệu");
}

async function deleteRecord(id: string) {
  if (!confirm("Bạn có chắc muốn xóa dữ liệu này?")) return false;
  await fetch("/api/records?id=" + encodeURIComponent(id), { method: "DELETE" });
  return true;
}

function Metric({ icon: Icon, label, value, note, tone = "green" }: {
  icon: typeof Clock3; label: string; value: string; note?: string; tone?: string;
}) {
  return <article className={"ref-metric " + tone}><i><Icon size={23}/></i><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

function Person({ name, position }: { name: string; position: string }) {
  return <div className="ref-person"><i>{name.slice(0, 1)}</i><span><b>{name}</b><small>{position}</small></span></div>;
}

function MiniBars({ values = [13, 11, 15, 8, 17, 12, 18, 14, 10, 16, 13, 19, 15] }: { values?: number[] }) {
  return <div className="ref-bars" aria-label="Biểu đồ cột">{values.map((v, i) => <span key={i} style={{ height: Math.max(12, v * 4) + "px" }}/>)}</div>;
}

function MiniLine({ tone = "green" }: { tone?: string }) {
  const points = [[5,105],[55,78],[100,95],[145,55],[190,82],[240,42],[285,71],[330,48],[380,30],[425,74],[495,38]];
  return <div className={"ref-line " + tone}><svg viewBox="0 0 500 145" role="img" aria-label="Biểu đồ xu hướng"><polyline points={points.map((p) => p.join(",")).join(" ")}/>{points.map(([x,y],i)=><circle key={i} cx={x} cy={y} r="4"/>)}</svg></div>;
}

export function ReferenceEmployees({ store }: { store: ReferenceStore }) {
  const { employees, reload } = useEmployees(store.id);
  const [query, setQuery] = useState(""); const [tab, setTab] = useState("ALL");
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<Employee | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const empty = { code: "", name: "", position: "Nhân viên bán hàng", phone: "", hourlyRate: "20000", username: "", password: "", status: "ACTIVE" };
  const [form, setForm] = useState(empty);
  const filtered = employees.filter((employee) => {
    const matches = (employee.code + " " + employee.name + " " + employee.phone).toLocaleLowerCase("vi").includes(query.toLocaleLowerCase("vi"));
    return matches && (tab === "ALL" || employee.status === tab);
  });
  function begin(employee?: Employee) {
    setEditing(employee ?? null);
    setForm(employee ? { code: employee.code, name: employee.name, position: employee.position, phone: employee.phone, hourlyRate: String(employee.hourly_rate), username: employee.username ?? "", password: "", status: employee.status === "INACTIVE" ? "INACTIVE" : "ACTIVE" } : { ...empty, code: "NV" + String(employees.length + 1).padStart(3, "0") });
    setMessage(""); setOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/employees", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editing?.id, storeId: store.id, ...form, hourlyRate: Number(form.hourlyRate) }),
      });
      const result = await response.json() as { message?: string; storeId?: string };
      if (!response.ok) return setMessage(result.message ?? "Không thể lưu nhân viên.");
      if (!editing && result.storeId !== store.id) return setMessage("Tài khoản chưa được gắn đúng cửa hàng. Vui lòng thử lại.");
      setOpen(false); await reload();
    } catch {
      setMessage("Không thể kết nối hệ thống. Vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  }
  return <div className="reference-module">
    <div className="ref-toolbar"><div><h2>Quản lý nhân viên</h2><p>Thêm, sửa thông tin và cập nhật trạng thái làm việc</p></div><div className="ref-toolbar-actions"><label className="ref-search"><Search size={16}/><input placeholder="Tìm kiếm nhân viên..." value={query} onChange={(e) => setQuery(e.target.value)}/></label><button className="primary-button" onClick={() => begin()}><Plus size={17}/> Thêm nhân viên</button></div></div>
    <div className="ref-metrics four"><Metric icon={UsersRound} label="Tổng nhân viên" value={String(employees.length)} note="Tất cả nhân viên"/><Metric icon={UserRound} label="Đang làm việc" value={String(employees.filter(e => e.status === "ACTIVE").length)} note="Được phép đăng nhập"/><Metric icon={Clock3} label="Nghỉ làm" value={String(employees.filter(e => e.status === "INACTIVE").length)} note="Đã thu hồi phiên đăng nhập" tone="orange"/><Metric icon={UserRound} label="Lương theo giờ" value="Quản lý thiết lập" note="Áp dụng theo ca thực tế" tone="red"/></div>
    <div className={"employee-ref-layout " + (open ? "with-drawer" : "")}><section className="table-card">
      <div className="ref-tabs"><button className={tab === "ALL" ? "active" : ""} onClick={() => setTab("ALL")}>Tất cả ({employees.length})</button><button className={tab === "ACTIVE" ? "active" : ""} onClick={() => setTab("ACTIVE")}>Đang làm việc ({employees.filter(e => e.status === "ACTIVE").length})</button><button className={tab === "INACTIVE" ? "active" : ""} onClick={() => setTab("INACTIVE")}>Nghỉ làm ({employees.filter(e => e.status === "INACTIVE").length})</button></div>
      <div className="data-table-wrap"><table className="data-table ref-employee-table"><thead><tr><th>Mã nhân viên</th><th>Họ và tên</th><th>SĐT</th><th>Chức vụ</th><th>Tên đăng nhập</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{filtered.length ? filtered.map((employee) => <tr key={employee.id}><td><b>{employee.code}</b></td><td><Person name={employee.name} position={employee.position}/></td><td>{employee.phone}</td><td>{employee.position}</td><td>{employee.username ?? "—"}</td><td><span className={`status-pill ${employee.status === "INACTIVE" ? "inactive" : ""}`}>● {employee.status === "INACTIVE" ? "Nghỉ làm" : "Đang làm việc"}</span></td><td><div className="row-actions"><button onClick={() => begin(employee)} title="Sửa nhân viên"><Edit3 size={15}/></button></div></td></tr>) : <tr><td colSpan={7} className="empty-cell">Không có nhân viên phù hợp.</td></tr>}</tbody></table></div>
    </section>{open && <aside className="employee-drawer"><form onSubmit={save}><div className="drawer-title"><div><h2>{editing ? "Cập nhật nhân viên" : "Thêm nhân viên"}</h2><span>Thông tin nhân viên</span></div><button type="button" onClick={() => setOpen(false)}><X size={19}/></button></div>
      <label>Mã nhân viên *<input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })}/></label>
      <label>Tên nhân viên *<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label>
      <label>Số điện thoại *<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}/></label>
      <label>Chức vụ<select value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}><option>Nhân viên bán hàng</option><option>Thu ngân</option><option>Kho</option></select></label>
      <label>Lương theo giờ *<input type="number" min="1" required value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}/></label>
      {editing && <label>Trạng thái làm việc<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="ACTIVE">Đang làm việc</option><option value="INACTIVE">Nghỉ làm</option></select></label>}
      <h3>Tài khoản đăng nhập</h3><label>Tên đăng nhập *<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}/></label>
      <label>{editing ? "Mật khẩu mới (để trống nếu giữ nguyên)" : "Mật khẩu *"}<input type="password" required={!editing} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}/></label>
      {message && <div className="form-message">{message}</div>}<div className="drawer-actions"><button type="button" onClick={() => setOpen(false)} disabled={saving}>Hủy bỏ</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Đang lưu..." : "Lưu nhân viên"}</button></div>
    </form></aside>}</div>
  </div>;
}

export function ReferenceStoreModule({ store, view }: { store: ReferenceStore; view: string }) {
  if (view === "Ca làm việc") return <ShiftManagement store={store}/>;
  if (view === "Lịch phân ca") return <ScheduleManagement store={store}/>;
  if (view === "Nhập hàng") return <GoodsManagement store={store}/>;
  if (view === "Chấm công") return <AttendanceManagement store={store}/>;
  if (view === "Lương thưởng") return <><PayrollManagement store={store}/><StorePayrollClosing store={store}/></>;
  if (view === "Dòng tiền") return <CashflowManagement store={store}/>;
  return <ReportManagement store={store}/>;
}

function ShiftManagement({ store }: { store: ReferenceStore }) {
  const { records, reload } = useRecords("CA_LAM_VIEC", store.id);
  const schedule = useRecords("LICH_PHAN_CA", store.id).records;
  const [mode, setMode] = useState<"day" | "week">("day"); const [date, setDate] = useState(today());
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<BusinessRecord | null>(null);
  const [name, setName] = useState(""); const [start, setStart] = useState("07:00"); const [end, setEnd] = useState("15:00"); const [message, setMessage] = useState("");
  const shifts = records.length ? records.map((record, index) => ({ id: record.id, title: record.title, start: String(record.data.start ?? "07:00"), end: String(record.data.end ?? "15:00"), tone: "s" + ((index % 3) + 1), record })) : defaultShifts;
  function begin(record?: BusinessRecord) { setEditing(record ?? null); setName(record?.title ?? ""); setStart(String(record?.data.start ?? "07:00")); setEnd(String(record?.data.end ?? "15:00")); setMessage(""); setOpen(true); }
  async function save(event: FormEvent) { event.preventDefault(); try { await saveRecord({ id: editing?.id, category: "CA_LAM_VIEC", storeId: store.id, title: name, data: { start, end } }); setOpen(false); await reload(); } catch (error) { setMessage((error as Error).message); } }
  async function remove(record: BusinessRecord) { if (await deleteRecord(record.id)) await reload(); }
  const weekDates = Array.from({ length: 7 }, (_, index) => { const d = new Date(date + "T12:00:00"); d.setDate(d.getDate() - d…10550 tokens truncated…</th><th>Số tiền</th><th>Nội dung chi</th><th>Người tạo</th><th>Thao tác</th></tr></thead><tbody>
      {periodRecords.length ? periodRecords.map((record) => <tr key={record.id}><td>{String(record.data.date)}</td><td><b>{String(record.data.employeeName)}</b></td><td><span className={record.data.kind === "BONUS" ? "bonus-pill" : "allowance-pill"}>{record.data.kind === "BONUS" ? "Thưởng" : "Phụ cấp"}</span></td><td className="money-green"><b>{money(Number(record.data.amount))}</b></td><td>{String(record.data.note || "—")}</td><td>Quản lý cửa hàng</td><td><button disabled={locked} className="danger-link" onClick={() => remove(record.id)}>Xóa</button></td></tr>) : <tr><td colSpan={7} className="empty-cell">Chưa phát sinh phụ cấp hoặc thưởng trong kỳ.</td></tr>}
    </tbody></table></div></section>

    <div className="ref-chart-row"><article className="chart-card donut-small"><div className="ref-donut payroll"><b>{money(summary?.totalPay ?? 0)}</b><small>Tổng chi trả</small></div><div><b>Cơ cấu chi trả</b><p>Lương theo giờ thực tế</p><p>Thưởng KPI không cộng dồn</p></div></article><article className="chart-card"><h3>Thống kê giờ làm theo ngày</h3><MiniBars/></article><article className="chart-card quick-total"><h3>Tóm tắt nhanh</h3><p><span>Lương cứng</span><b>{money(summary?.totalBaseSalary ?? 0)}</b></p><p><span>Phụ cấp</span><b>{money(totalAllowance)}</b></p><p><span>Thưởng khác</span><b>{money(summary?.totalManualBonus ?? 0)}</b></p><p><span>Thưởng KPI</span><b>{money(summary?.totalKpiBonus ?? 0)}</b></p><p><span>Tổng thưởng</span><b>{money(totalBonus)}</b></p></article></div>

    {open && <div className="modal-backdrop"><form className="modal payroll-action-modal" onSubmit={save}><div className="modal-title"><div><h2>{kind === "ALLOWANCE" ? "Tạo phụ cấp" : "Tạo thưởng"}</h2><p>Khoản chi được ghi nhận đúng nhân viên, cửa hàng và tháng lương</p></div><button type="button" onClick={() => setOpen(false)}><X size={19}/></button></div><label>Nhân viên được nhận *<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.code} · {employee.name}</option>)}</select></label><label>Số tiền {kind === "ALLOWANCE" ? "phụ cấp" : "thưởng"} *<input type="number" min="1" required value={amount} onChange={(event) => setAmount(event.target.value)}/></label><label>Ngày ghi nhận<input type="date" min={`${month}-01`} max={`${month}-31`} value={date} onChange={(event) => setDate(event.target.value)}/></label><label>Nội dung chi *<textarea required value={note} onChange={(event) => setNote(event.target.value)} placeholder={kind === "ALLOWANCE" ? "Ví dụ: Phụ cấp chuyên cần" : "Ví dụ: Thưởng hoàn thành công việc"}/></label>{message && <div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>Hủy</button><button className="primary-button">Lưu {kind === "ALLOWANCE" ? "phụ cấp" : "thưởng"}</button></div></form></div>}
  </div>;
}

function CashflowManagement({ store }: { store: ReferenceStore }) {
  const {records,reload}=useRecords("DONG_TIEN",store.id); const [open,setOpen]=useState(false); const [editing,setEditing]=useState<BusinessRecord|null>(null); const [type,setType]=useState("Marketing"); const [amount,setAmount]=useState(""); const [date,setDate]=useState(today()); const [note,setNote]=useState(""); const [message,setMessage]=useState("");
  const extra=records.reduce((s,r)=>s+Number(r.data.amount??0),0);const expense=store.expense+extra;const profit=store.revenue-expense; const margin=store.revenue?profit/store.revenue*100:0;
  function begin(record?:BusinessRecord){setEditing(record??null);setType(record?.title??"Marketing");setAmount(String(record?.data.amount??""));setDate(String(record?.data.date??today()));setNote(String(record?.data.note??""));setMessage("");setOpen(true);}
  async function save(event:FormEvent){event.preventDefault();try{await saveRecord({id:editing?.id,category:"DONG_TIEN",storeId:store.id,title:type,data:{amount:Number(amount),date,note}});setOpen(false);await reload();}catch(error){setMessage((error as Error).message);}}
  async function remove(id:string){if(await deleteRecord(id))await reload();}
  return <div className="reference-module cashflow-page"><div className="ref-toolbar"><div><h2>Dòng tiền</h2><p>Theo dõi doanh thu, chi phí và lợi nhuận cửa hàng</p></div><div className="ref-toolbar-actions"><input type="date" defaultValue={today()}/><button onClick={()=>csv("dong-tien-cua-hang.csv",[["Ngày","Loại chi phí","Số tiền","Ghi chú"],...records.map(r=>[String(r.data.date),r.title,Number(r.data.amount),String(r.data.note)])])}><Download size={16}/> Xuất Excel</button><button className="primary-button" onClick={()=>begin()}><Plus size={17}/> Thêm chi phí</button></div></div>
    <div className="ref-metrics four"><Metric icon={BarChart3} label="DOANH THU" value={money(store.revenue)} note="↑ 12,5% so với kỳ trước" tone="blue"/><Metric icon={WalletCards} label="TỔNG CHI PHÍ" value={money(expense)} note="↑ 8,3% so với kỳ trước" tone="orange"/><Metric icon={BarChart3} label="LỢI NHUẬN" value={money(profit)} note="↑ 18,9% so với kỳ trước"/><Metric icon={BarChart3} label="BIÊN LỢI NHUẬN" value={margin.toFixed(2)+"%"} tone="purple"/></div>
    <div className="ref-chart-row two"><article className="chart-card"><div className="panel-title"><h2>Doanh thu theo ngày</h2><select><option>Theo ngày</option><option>Theo tháng</option></select></div><MiniBars values={[12,9,8,16,16,13,18,17,13,19,21,12,15]}/></article><article className="chart-card"><div className="panel-title"><h2>Doanh thu & Lợi nhuận theo ngày</h2><select><option>Theo ngày</option><option>Theo tháng</option></select></div><MiniLine tone="blue"/></article></div>
    <div className="ref-cash-grid"><article className="table-card"><div className="table-head"><h2>Doanh thu</h2><button className="link-button">Xem chi tiết</button></div><table className="data-table"><tbody>{[18500000,16200000,21800000,13400000,11600000].map((value,index)=><tr key={index}><td>{15-index}/05/2025</td><td className="money-green">{money(value)}</td><td>Nhân viên bán hàng</td></tr>)}</tbody></table></article><article className="chart-card expense-list"><h2>Chi phí</h2><p><span>Chi phí cố định<small>Setup, điện, nước, wifi, rác, mặt bằng</small></span><b>{money(store.expense)}</b></p><p><span>Chi phí marketing<small>Quảng cáo và truyền thông</small></span><b>{money(records.filter(r=>r.title==="Marketing").reduce((s,r)=>s+Number(r.data.amount),0))}</b></p><p><span>Chi phí phát sinh đã nhập</span><b>{money(extra)}</b></p><p className="expense-total"><span>Tổng chi phí</span><b>{money(expense)}</b></p></article><article className="chart-card donut-small vertical"><div className="ref-donut cash"><b>{money(profit)}</b><small>Lợi nhuận</small></div><p>Lợi nhuận = Doanh thu − Tổng chi phí</p></article></div>
    <section className="table-card"><div className="table-head"><h2>Chi phí cố định gần đây</h2><span>{records.length} khoản phát sinh</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Ngày</th><th>Loại chi phí</th><th>Số tiền</th><th>Ghi chú</th><th>Người tạo</th><th>Thao tác</th></tr></thead><tbody>{records.length?records.map(record=><tr key={record.id}><td>{String(record.data.date)}</td><td><b>{record.title}</b></td><td className="money-orange">{money(Number(record.data.amount))}</td><td>{String(record.data.note||"—")}</td><td>Quản lý cửa hàng</td><td><div className="row-actions"><button onClick={()=>begin(record)}><Edit3 size={15}/></button><button className="danger" onClick={()=>remove(record.id)}><Trash2 size={15}/></button></div></td></tr>):<tr><td colSpan={6} className="empty-cell">Chưa nhập chi phí phát sinh.</td></tr>}</tbody></table></div></section>
    {open&&<div className="modal-backdrop"><form className="modal" onSubmit={save}><div className="modal-title"><div><h2>{editing?"Cập nhật chi phí":"Thêm chi phí"}</h2><p>Dữ liệu được ghi riêng cho {store.name}</p></div><button type="button" onClick={()=>setOpen(false)}><X size={19}/></button></div><label>Loại chi phí<select value={type} onChange={(e)=>setType(e.target.value)}><option>Marketing</option><option>Setup</option><option>Mặt bằng</option><option>Điện</option><option>Nước</option><option>Wifi</option><option>Rác</option><option>Khác</option></select></label><div className="form-grid two"><label>Số tiền *<input type="number" min="1" required value={amount} onChange={(e)=>setAmount(e.target.value)}/></label><label>Ngày chi<input type="date" value={date} onChange={(e)=>setDate(e.target.value)}/></label></div><label>Nội dung chi *<textarea required value={note} onChange={(e)=>setNote(e.target.value)}/></label>{message&&<div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={()=>setOpen(false)}>Hủy</button><button className="primary-button">Lưu chi phí</button></div></form></div>}
  </div>;
}

function ReportManagement({ store }: { store: ReferenceStore }) {
  const {employees}=useEmployees(store.id); const {shifts}=useShiftSessions(store.id); const payroll=useRecords("LUONG_THUONG",store.id).records; const [tab,setTab]=useState("Tổng quan"); const [from,setFrom]=useState(today().slice(0,8)+"01"); const [to,setTo]=useState(today()); const [periodPayroll,setPeriodPayroll]=useState<PayrollSummary|null>(null);
  useEffect(()=>{const period=from.slice(0,7);fetch(`/api/payroll?storeId=${encodeURIComponent(store.id)}&period=${encodeURIComponent(period)}`).then(r=>r.json()).then(data=>setPeriodPayroll(data.summary??null));},[from,store.id]);
  const completed=shifts.filter(s=>s.ended_at); const hours=completed.reduce((sum,s)=>sum+(new Date(s.ended_at!).getTime()-new Date(s.started_at).getTime())/3600000,0); const shiftWages=completed.reduce((sum,s)=>sum+((new Date(s.ended_at!).getTime()-new Date(s.started_at).getTime())/3600000)*sessionRate(s),0); const wages=periodPayroll?.totalBaseSalary??shiftWages; const recordExtras=payroll.reduce((sum,r)=>sum+Number(r.data.amount??0),0); const extras=periodPayroll ? periodPayroll.totalTikTokAllowance+periodPayroll.totalSupportAllowance+periodPayroll.totalManualAllowance+periodPayroll.totalManualBonus+periodPayroll.totalKpiBonus : recordExtras;
  return <div className="reference-module report-page"><div className="ref-toolbar"><div><h2>Báo cáo thống kê</h2><p>Tổng hợp dữ liệu hoạt động của cửa hàng</p></div><div className="ref-toolbar-actions"><input type="date" value={from} onChange={(e)=>setFrom(e.target.value)}/><span>−</span><input type="date" value={to} onChange={(e)=>setTo(e.target.value)}/><button className="primary-button" onClick={()=>csv("bao-cao-cua-hang.csv",[["Chỉ số","Giá trị"],["Nhân viên",employees.length],["Tổng giờ",hours.toFixed(2)],["Lương",Math.round(wages)],["Thưởng/phụ cấp",extras],["Doanh thu",store.revenue]])}><Download size={16}/> Xuất báo cáo</button></div></div>
    <div className="ref-report-tabs">{["Tổng quan","Chấm công","Lương thưởng","Ca làm việc","Nhân viên","Chi tiết"].map(item=><button key={item} className={tab===item?"active":""} onClick={()=>setTab(item)}>{item}</button>)}</div>
    <div className="ref-metrics five"><Metric icon={UsersRound} label="Tổng nhân viên" value={(employees.length||3)+" người"} note="100% đang làm việc"/><Metric icon={Clock3} label="Tổng giờ làm" value={(hours||210).toFixed(2)+" giờ"} note="Theo kỳ đã chọn"/><Metric icon={WalletCards} label="Tổng lương cứng" value={money(wages||4200000)}/><Metric icon={Gift} label="Tổng thưởng" value={money(extras||900000)}/><Metric icon={WalletCards} label="Tổng lương nhận" value={money((wages||4200000)+(extras||900000))}/></div>
    <div className="ref-report-charts"><article className="chart-card"><h2>Giờ làm việc theo ngày</h2><MiniBars/></article><article className="chart-card"><h2>Doanh thu theo ngày</h2><MiniLine/></article><article className="chart-card donut-small vertical"><h2>Cơ cấu lương nhận</h2><div className="ref-donut report"><b>{money((wages||4200000)+(extras||900000))}</b><small>Tổng lương nhận</small></div></article></div>
    <div className="ref-report-bottom"><section className="table-card"><div className="table-head"><h2>{tab === "Tổng quan" ? "Thống kê theo nhân viên" : "Chi tiết " + tab.toLocaleLowerCase("vi")}</h2></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Nhân viên</th><th>Tổng giờ làm</th><th>Lương cứng</th><th>Thưởng</th><th>Phụ cấp</th><th>Lương nhận</th></tr></thead><tbody>{(employees.length?employees:samplePeople.slice(0,3).map((p,i)=>({id:"s"+i,name:p[0],position:p[1],hourly_rate:20000}))).map((employee,index)=>{const employeeHours=[75.5,68,66.5][index%3];const base=employeeHours*employee.hourly_rate;const extra=payroll.filter(r=>r.data.employeeId===employee.id).reduce((s,r)=>s+Number(r.data.amount),0);return <tr key={employee.id}><td><Person name={employee.name} position={employee.position}/></td><td>{employeeHours.toFixed(2)}</td><td>{money(base)}</td><td className="money-green">{money(extra)}</td><td>{money(100000)}</td><td className="money-green"><b>{money(base+extra+100000)}</b></td></tr>})}</tbody></table></div></section><aside className="chart-card"><h2>Thống kê ca làm việc</h2>{["Ca 1 · 62,50 giờ","Ca 2 · 71,00 giờ","Ca 3 · 76,50 giờ"].map((text,index)=><div className="progress-row" key={text}><span>{text}</span><i><b style={{width:[30,34,36][index]+"%"}}/></i><strong>{[29.8,33.8,36.4][index]}%</strong></div>)}</aside></div>
    <div className="report-profit-note"><CheckCircle2 size={18}/> Dữ liệu {tab.toLocaleLowerCase("vi")} của {store.name} trong kỳ {from} → {to} · Doanh thu <b>{money(store.revenue)}</b> · Lợi nhuận <b>{money(store.profit)}</b></div>
  </div>;
}
