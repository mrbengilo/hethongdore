"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, CheckCircle2, ChevronLeft, ChevronRight, Clock3,
  Download, Edit3, ExternalLink, Gift, MapPin, PackageOpen, Plus, Search, Trash2, UserRound,
  UsersRound, WalletCards, X,
} from "lucide-react";
import StorePayrollClosing from "./StorePayrollClosing";
import SalaryAdvancePanel from "./SalaryAdvancePanel";
import AttendanceStatsPanel from "./AttendanceStatsPanel";
import { formatDateTime24, formatDateVn, formatMonthVn, formatVndInput, parseVndInput } from "../lib/format";
import { PAYROLL_UPDATED_EVENT } from "../lib/payroll";
import {
  attendanceDeltaMinutes,
  attendanceStatusAt,
} from "../lib/scheduling";
import { DatePickerControl } from "./DatePickerControl";
import { useAccessibleModal } from "./useAccessibleModal";

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
  duration_seconds?: number; admin_adjusted_duration_seconds?: number | null; adminAdjustedDurationSeconds?: number | null; supportAllowance?: number | null; sourceStoreName?: string | null; targetStoreName?: string | null;
  scheduled_start_at?: string | null; attendance_status?: "EARLY" | "ON_TIME" | "LATE" | null;
  attendance_delta_minutes?: number | null;
  attendanceGraceMinutes?: number | null; attendance_grace_minutes?: number | null;
  clockInLatitude?: number | null; clockInLongitude?: number | null;
  clockInAccuracyMeters?: number | null; clockInLocationCapturedAt?: string | null;
  clock_in_latitude?: number | null; clock_in_longitude?: number | null;
  clock_in_accuracy_meters?: number | null; clock_in_location_captured_at?: string | null;
};
type AttendanceLocation = {
  latitude: number; longitude: number; accuracyMeters: number | null; capturedAt: string | null;
};
type PayrollItem = {
  employeeId: string; employeeCode: string; employeeName: string; position: string;
  hours: number; hourlyRate: number; baseSalary: number; tiktokAllowance: number;
  supportAllowance: number; manualAllowance: number; manualBonus: number; kpiBonus: number; totalPay: number;
  salaryAdvancePending: number; salaryAdvancePaid: number; salaryAdvanceReserved: number; availablePay: number;
};
type PayrollSummary = {
  period: string; storeId: string; storeName: string; revenue: number; expense: number;
  profit: number; netProfit?: number; totalHours: number; kpiEligibleHours?: number;
  managerFixedHours?: number; totalKpiHours?: number; profitPerHour: number; profitPerKpiHour?: number; kpiRate: number;
  totalBaseSalary: number; totalTikTokAllowance: number; totalSupportAllowance: number; totalManualAllowance: number;
  totalManualBonus: number; totalKpiBonus: number; totalPay: number;
  totalSalaryAdvancePending: number; totalSalaryAdvancePaid: number; totalSalaryAdvanceReserved: number; totalAvailablePay: number;
  items: PayrollItem[]; status: "PREVIEW" | "LOCKED"; finalizedAt?: string;
};
type PayrollScope = { storeId: string; period: string };
type PayrollResponse = { period?: string; locked?: boolean; summary?: PayrollSummary; message?: string };

const samePayrollScope = (left: PayrollScope, right: PayrollScope) => left.storeId === right.storeId && left.period === right.period;

const money = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value)) + " đồng";
const hourlyMoney = (value: number) => `${money(value)}/giờ`;
const employeeStatusSuffix = (status: string) => status === "SUSPENDED"
  ? " · Tạm ngưng"
  : status === "TERMINATED" || status === "INACTIVE" ? " · Đã nghỉ việc" : "";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const dateLabel = (value: string) => formatDateVn(value);
const timeLabel = (value: string | null) => value ? new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }).format(new Date(value)) : "—";
const locationTimeLabel = (value: string | null) => value && Number.isFinite(new Date(value).getTime())
  ? formatDateTime24(value)
  : "Chưa có thời điểm lấy";
const finiteField = (primary: unknown, fallback: unknown) => {
  const value = primary ?? fallback;
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const sessionLocation = (shift: ShiftSession): AttendanceLocation | null => {
  const latitude = finiteField(shift.clockInLatitude, shift.clock_in_latitude);
  const longitude = finiteField(shift.clockInLongitude, shift.clock_in_longitude);
  if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const rawAccuracy = finiteField(shift.clockInAccuracyMeters, shift.clock_in_accuracy_meters);
  return {
    latitude,
    longitude,
    accuracyMeters: rawAccuracy !== null && rawAccuracy >= 0 ? rawAccuracy : null,
    capturedAt: shift.clockInLocationCapturedAt ?? shift.clock_in_location_captured_at ?? null,
  };
};
const locationMapUrl = (location: AttendanceLocation) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`;
const locationExportLabel = (locations: AttendanceLocation[]) => locations.length === 0
  ? "Không có dữ liệu vị trí"
  : locations.map((location) => `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)} · ${location.accuracyMeters === null ? "chưa có độ chính xác" : `±${Math.round(location.accuracyMeters)} m`} · ${locationTimeLabel(location.capturedAt)}`).join("; ");
const sessionRate = (shift: { hourlyRate: number; appliedHourlyRate?: number | null }) => Number(shift.appliedHourlyRate ?? shift.hourlyRate ?? 0);
const sessionSeconds = (shift: ShiftSession) => {
  const adjusted = shift.adminAdjustedDurationSeconds ?? shift.admin_adjusted_duration_seconds;
  if (adjusted != null) return Math.max(0, Number(adjusted));
  if (Number(shift.duration_seconds) > 0) return Number(shift.duration_seconds);
  const start = new Date(shift.started_at).getTime();
  const end = shift.ended_at ? new Date(shift.ended_at).getTime() : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1_000)) : 0;
};
const sessionDate = (shift: ShiftSession) => shift.workDate
  ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(shift.started_at));
const sessionAttendance = (shift: ShiftSession) => {
  const persistedStatus = shift.attendance_status;
  const persistedDelta = Number(shift.attendance_delta_minutes);
  if (persistedStatus && shift.attendance_delta_minutes !== null && shift.attendance_delta_minutes !== undefined
    && Number.isFinite(persistedDelta)) return { status: persistedStatus, delta: persistedDelta };
  if (!shift.scheduled_start_at) return null;
  const graceMinutes = Number(shift.attendanceGraceMinutes ?? shift.attendance_grace_minutes);
  if (!Number.isSafeInteger(graceMinutes) || graceMinutes < 0) return null;
  const delta = attendanceDeltaMinutes(shift.started_at, shift.scheduled_start_at);
  const status = attendanceStatusAt(shift.started_at, shift.scheduled_start_at, graceMinutes);
  return delta === null || status === null ? null : { status, delta };
};
type ShiftDisplay = { id: string; title: string; start: string; end: string; tone: string; record?: BusinessRecord };
const defaultShifts: ShiftDisplay[] = [
  { id: "default-1", title: "Ca 1", start: "07:00", end: "12:00", tone: "s1" },
  { id: "default-2", title: "Ca 2", start: "12:00", end: "17:00", tone: "s2" },
  { id: "default-3", title: "Ca 3", start: "17:00", end: "23:00", tone: "s3" },
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

function useEmployees(storeId: string, payrollPeriod?: string) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const reload = useCallback(async () => {
    const query = new URLSearchParams({ storeId, includeSupport: "1" });
    if (payrollPeriod) query.set("payrollPeriod", payrollPeriod);
    const response = await fetch("/api/employees?" + query);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Không thể tải danh sách nhân viên.");
    setEmployees(data.employees ?? []);
  }, [payrollPeriod, storeId]);
  useEffect(() => { void reload(); }, [reload]);
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

async function deleteRecord(id: string, reportError: (message: string) => void = (message) => window.alert(message)) {
  if (!confirm("Bạn có chắc muốn xóa dữ liệu này?")) return false;
  try {
    const response = await fetch("/api/records?id=" + encodeURIComponent(id), { method: "DELETE" });
    const result = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) {
      reportError(result.message || "Không thể xóa dữ liệu.");
      return false;
    }
    return true;
  } catch {
    reportError("Không thể kết nối để xóa dữ liệu. Vui lòng thử lại.");
    return false;
  }
}

function Metric({ icon: Icon, label, value, note, tone = "green" }: {
  icon: typeof Clock3; label: string; value: string; note?: string; tone?: string;
}) {
  return <article className={"ref-metric " + tone}><i><Icon size={23}/></i><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

function Person({ name, position }: { name: string; position: string }) {
  return <div className="ref-person"><i>{name.slice(0, 1)}</i><span><b>{name}</b><small>{position}</small></span></div>;
}

function AttendanceLocationView({ locations, employeeName }: { locations: AttendanceLocation[]; employeeName: string }) {
  if (locations.length === 0) return <span className="attendance-location-empty">Không có dữ liệu vị trí</span>;
  const items = locations.map((location, index) => <div className="attendance-location-item" key={`${location.capturedAt ?? "legacy"}-${location.latitude}-${location.longitude}-${index}`}>
    <a
      href={locationMapUrl(location)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Mở vị trí điểm danh của ${employeeName} trên Google Maps`}
    >
      <MapPin size={14} aria-hidden="true"/> Mở bản đồ <ExternalLink size={12} aria-hidden="true"/>
    </a>
    <span>{location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}</span>
    <small>{location.accuracyMeters === null ? "Chưa có độ chính xác" : `Độ chính xác ±${Math.round(location.accuracyMeters)} m`}</small>
    <time dateTime={location.capturedAt ?? undefined}>Lấy lúc {locationTimeLabel(location.capturedAt)}</time>
  </div>);
  if (items.length === 1) return items[0];
  return <details className="attendance-location-group">
    <summary>{locations.length} vị trí điểm danh</summary>
    <div>{items}</div>
  </details>;
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
  const [name, setName] = useState(""); const [start, setStart] = useState("07:00"); const [end, setEnd] = useState("12:00"); const [message, setMessage] = useState("");
  const shifts: ShiftDisplay[] = records.length ? records.map((record, index) => ({ id: record.id, title: record.title, start: String(record.data.start ?? "07:00"), end: String(record.data.end ?? "12:00"), tone: "s" + ((index % 3) + 1), record })) : defaultShifts;
  function begin(record?: BusinessRecord) { setEditing(record ?? null); setName(record?.title ?? ""); setStart(String(record?.data.start ?? "07:00")); setEnd(String(record?.data.end ?? "12:00")); setMessage(""); setOpen(true); }
  async function save(event: FormEvent) { event.preventDefault(); try { await saveRecord({ id: editing?.id, category: "CA_LAM_VIEC", storeId: store.id, title: name, data: { start, end } }); setOpen(false); await reload(); } catch (error) { setMessage((error as Error).message); } }
  async function remove(record: BusinessRecord) { if (await deleteRecord(record.id)) await reload(); }
  const weekDates = Array.from({ length: 7 }, (_, index) => { const d = new Date(date + "T12:00:00"); d.setDate(d.getDate() - d.getDay() + 1 + index); return new Intl.DateTimeFormat("en-CA").format(d); });
  return <div className="reference-module">
    <div className="ref-toolbar"><div><h2>Ca làm việc</h2><p>Quản lý tên ca và thời gian làm việc</p></div><div className="ref-toolbar-actions"><input type="date" value={date} onChange={(e) => setDate(e.target.value)}/><button onClick={() => csv("ca-lam-viec.csv", [["Tên ca","Bắt đầu","Kết thúc"], ...shifts.map(s => [s.title,s.start,s.end])])}><Download size={16}/> Xuất Excel</button><button className="primary-button" onClick={() => begin()}><Plus size={17}/> Tạo ca làm việc</button></div></div>
    <div className="ref-shift-grid">{shifts.slice(0, 3).map((shift, index) => <article className={"ref-shift " + ["green","orange","purple"][index % 3]} key={shift.id}><span>{shift.title}</span><strong>{shift.start} - {shift.end}</strong><small><UsersRound size={15}/> {6 + index} nhân viên</small>{shift.record && <div className="shift-card-actions"><button onClick={() => begin(shift.record)}><Edit3 size={14}/></button><button onClick={() => remove(shift.record!)}><Trash2 size={14}/></button></div>}</article>)}<article className="ref-day-summary"><b>Tổng quan ngày {dateLabel(date)}</b><div><span><strong>{shifts.length}</strong> Tổng ca</span><span><strong>18</strong> Nhân viên</span><span><strong>{schedule.length || 32}</strong> Lượt ca</span></div></article></div>
    <section className="table-card"><div className="table-head"><div><h2>{mode === "day" ? "Lịch phân ca ngày " + dateLabel(date) : "Lịch làm việc trong tuần"}</h2><p>Chọn chế độ xem ngày hoặc tuần</p></div><div className="ref-tabs compact"><button className={mode === "day" ? "active" : ""} onClick={() => setMode("day")}>Lịch theo ngày</button><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Lịch theo tuần</button></div></div>
      {mode === "day" ? <DayScheduleGrid shifts={shifts}/> : <div className="data-table-wrap"><table className="data-table week-table"><thead><tr><th>Ca</th>{weekDates.map((item) => <th key={item}>{new Intl.DateTimeFormat("vi-VN",{weekday:"short",day:"2-digit",month:"2-digit"}).format(new Date(item+"T12:00:00"))}</th>)}</tr></thead><tbody>{shifts.map((shift,index)=><tr key={shift.id}><td><b className={"shift-text c"+((index%3)+1)}>{shift.title}<small>{shift.start} - {shift.end}</small></b></td>{weekDates.map((day,dayIndex)=><td key={day}><span className={"shift-pill "+shift.tone}>{Math.max(2, 4 + ((index + dayIndex) % 4))} nhân viên</span></td>)}</tr>)}</tbody></table></div>}
    </section>
    {open && <div className="modal-backdrop"><form className="modal shift-definition-modal" onSubmit={save}><div className="modal-title"><div><h2>{editing ? "Cập nhật ca làm việc" : "Thêm ca làm việc"}</h2><p>Chỉ cần nhập tên ca và thời gian áp dụng</p></div><button type="button" onClick={() => setOpen(false)}><X size={19}/></button></div><label>Tên ca *<input required placeholder="Ví dụ: Ca sáng" value={name} onChange={(e) => setName(e.target.value)}/></label><div className="form-grid two"><label>Thời gian bắt đầu *<input type="time" required value={start} onChange={(e) => setStart(e.target.value)}/></label><label>Thời gian kết thúc *<input type="time" required value={end} onChange={(e) => setEnd(e.target.value)}/></label></div>{message && <div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>Hủy</button><button className="primary-button">Lưu ca làm việc</button></div></form></div>}
  </div>;
}

function DayScheduleGrid({ shifts }: { shifts: Array<{ id: string; title: string; start: string; end: string; tone: string }> }) {
  return <div className="data-table-wrap"><table className="data-table schedule-table"><thead><tr><th>Nhân viên</th>{shifts.slice(0,3).map((shift)=><th key={shift.id}>{shift.title} ({shift.start} - {shift.end})</th>)}</tr></thead><tbody>{samplePeople.map((person,index)=><tr key={person[0]}><td><Person name={person[0]} position={person[1]}/></td>{shifts.slice(0,3).map((shift,shiftIndex)=><td key={shift.id}>{(index + shiftIndex) % 3 !== 1 ? <span className={"shift-pill "+shift.tone}>{shift.title} · {shift.start} - {shift.end}</span> : "—"}</td>)}</tr>)}</tbody></table></div>;
}

function ScheduleManagement({ store }: { store: ReferenceStore }) {
  const { records, reload } = useRecords("LICH_PHAN_CA", store.id); const shiftRecords = useRecords("CA_LAM_VIEC", store.id).records;
  const { employees } = useEmployees(store.id); const [date, setDate] = useState(today()); const [viewMode, setViewMode] = useState<"shift"|"employee">("shift");
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<BusinessRecord | null>(null);
  const [shiftId, setShiftId] = useState(""); const [selected, setSelected] = useState<string[]>([]); const [note, setNote] = useState(""); const [message, setMessage] = useState("");
  const shifts: ShiftDisplay[] = shiftRecords.length ? shiftRecords.map((r,index)=>({id:r.id,title:r.title,start:String(r.data.start??"07:00"),end:String(r.data.end??"12:00"),tone:"s"+((index%3)+1)})) : defaultShifts;
  useEffect(() => { if (!shiftId && shifts[0]) setShiftId(shifts[0].id); }, [shiftId, shifts]);
  const dayRecords = records.filter((record) => String(record.data.date ?? "") === date);
  function begin(record?: BusinessRecord) { setEditing(record ?? null); setShiftId(String(record?.data.shiftId ?? shifts[0]?.id ?? "")); setSelected(Array.isArray(record?.data.employeeIds) ? record?.data.employeeIds as string[] : []); setNote(String(record?.data.note ?? "")); setOpen(true); setMessage(""); }
  async function save(event: FormEvent) { event.preventDefault(); const shift = shifts.find((item) => item.id === shiftId); if (!shift || !selected.length) return setMessage("Vui lòng chọn ca và ít nhất một nhân viên."); const names = employees.filter(e=>selected.includes(e.id)).map(e=>e.name); try { await saveRecord({ id: editing?.id, category:"LICH_PHAN_CA", storeId:store.id, title:shift.title+" · "+date, data:{date,shiftId,shiftName:shift.title,start:shift.start,end:shift.end,employeeIds:selected,employeeNames:names,note} }); setOpen(false); await reload(); } catch(error){ setMessage((error as Error).message); } }
  async function remove(id:string){if(await deleteRecord(id)) await reload();}
  const employeeRows = employees.length ? employees.map(e=>[e.name,e.position,e.id]) : samplePeople.map((p,i)=>[p[0],p[1],"sample-"+i]);
  return <div className="reference-module schedule-page">
    <div className="ref-toolbar"><div><h2>Lịch phân ca</h2><p>Tạo và quản lý lịch phân công ca làm việc cho nhân viên</p></div><div className="ref-toolbar-actions"><button onClick={()=>setDate(new Date(new Date(date).getTime()-86400000).toISOString().slice(0,10))}><ChevronLeft size={17}/></button><input type="date" value={date} onChange={(e)=>setDate(e.target.value)}/><button onClick={()=>setDate(new Date(new Date(date).getTime()+86400000).toISOString().slice(0,10))}><ChevronRight size={17}/></button><button onClick={()=>csv("lich-phan-ca.csv",[["Ngày","Ca","Nhân viên"],...records.map(r=>[String(r.data.date??""),String(r.data.shiftName??""),String((r.data.employeeNames as string[]|undefined)?.join(", ")??"")])])}><Download size={16}/> Xuất Excel</button><button className="primary-button" onClick={()=>begin()}><Plus size={17}/> Tạo lịch phân ca</button></div></div>
    <div className="ref-shift-grid schedule-summary">{shifts.slice(0,3).map((shift,index)=><article className={"ref-shift "+["green","orange","purple"][index]} key={shift.id}><span>{shift.title}</span><strong>{shift.start} - {shift.end}</strong><small>{dayRecords.filter(r=>r.data.shiftId===shift.id).reduce((sum,r)=>sum+((r.data.employeeIds as string[]|undefined)?.length??0),0)} nhân viên đã xếp</small></article>)}<article className="ref-day-summary"><b>Tổng quan ngày {dateLabel(date)}</b><div><span><strong>{shifts.length}</strong> Tổng ca</span><span><strong>{employees.length}</strong> Nhân viên</span><span><strong>{dayRecords.length}</strong> Lịch đã tạo</span></div></article></div>
    <section className="table-card"><div className="table-head"><div><h2>Danh sách lịch phân ca</h2><p>{dayRecords.length ? "Dữ liệu đã lưu cho ngày đang chọn" : "Chưa có lịch đã lưu; đang hiển thị bố cục mẫu"}</p></div><div className="ref-tabs compact"><button className={viewMode==="shift"?"active":""} onClick={()=>setViewMode("shift")}>Theo ca</button><button className={viewMode==="employee"?"active":""} onClick={()=>setViewMode("employee")}>Theo nhân viên</button></div></div>
      {viewMode==="shift"?<DayScheduleGrid shifts={shifts}/>:<div className="data-table-wrap"><table className="data-table"><thead><tr><th>Nhân viên</th><th>Ca được phân</th><th>Thời gian</th><th>Ghi chú</th></tr></thead><tbody>{employeeRows.map((employee)=><tr key={employee[2]}><td><Person name={employee[0]} position={employee[1]}/></td><td>{dayRecords.filter(r=>(r.data.employeeIds as string[]|undefined)?.includes(employee[2])).map(r=>String(r.data.shiftName)).join(", ")||"Chưa phân ca"}</td><td>{dayRecords.filter(r=>(r.data.employeeIds as string[]|undefined)?.includes(employee[2])).map(r=>String(r.data.start)+" - "+String(r.data.end)).join(", ")||"—"}</td><td>—</td></tr>)}</tbody></table></div>}
    </section>
    {dayRecords.length>0&&<section className="table-card"><div className="table-head"><h2>Lịch đã tạo trong ngày</h2></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Ca</th><th>Thời gian</th><th>Nhân viên</th><th>Ghi chú</th><th>Thao tác</th></tr></thead><tbody>{dayRecords.map(record=><tr key={record.id}><td><b>{String(record.data.shiftName)}</b></td><td>{String(record.data.start)} - {String(record.data.end)}</td><td>{String((record.data.employeeNames as string[]|undefined)?.join(", ")??"")}</td><td>{String(record.data.note??"—")}</td><td><div className="row-actions"><button onClick={()=>begin(record)}><Edit3 size={15}/></button><button className="danger" onClick={()=>remove(record.id)}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table></div></section>}
    {open&&<div className="modal-backdrop"><form className="modal schedule-modal" onSubmit={save}><div className="modal-title"><div><h2>{editing?"Cập nhật lịch phân ca":"Tạo lịch phân ca"}</h2><p>{store.name}</p></div><button type="button" onClick={()=>setOpen(false)}><X size={19}/></button></div><label>Ngày áp dụng<input type="date" required value={date} onChange={(e)=>setDate(e.target.value)}/></label><label>Chọn ca<select value={shiftId} onChange={(e)=>setShiftId(e.target.value)}>{shifts.map(shift=><option key={shift.id} value={shift.id}>{shift.title} · {shift.start} - {shift.end}</option>)}</select></label><fieldset className="employee-check-list"><legend>Chọn nhân viên ({selected.length})</legend>{employees.map(employee=><label key={employee.id}><input type="checkbox" checked={selected.includes(employee.id)} onChange={()=>setSelected(selected.includes(employee.id)?selected.filter(id=>id!==employee.id):[...selected,employee.id])}/><Person name={employee.name} position={employee.position}/></label>)}</fieldset><label>Ghi chú<textarea value={note} onChange={(e)=>setNote(e.target.value)} placeholder="Nhập ghi chú..."/></label>{message&&<div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={()=>setOpen(false)}>Hủy</button><button className="primary-button">Lưu lịch ca</button></div></form></div>}
  </div>;
}

function GoodsManagement({ store }: { store: ReferenceStore }) {
  const { records, reload } = useRecords("NHAP_HANG", store.id); const [query,setQuery]=useState(""); const [open,setOpen]=useState(false); const [editing,setEditing]=useState<BusinessRecord|null>(null); const [message,setMessage]=useState(""); const [hiddenSamples,setHiddenSamples]=useState<string[]>([]);
  const empty={name:"",quantity:"1",unit:"Bao",weight:"",unitPrice:"",shipping:"0",date:today(),note:""}; const [form,setForm]=useState(empty);
  const samples: BusinessRecord[]=sampleGoods.map((g,index)=>({id:"sample-"+index,title:g[0],status:"SAVED",updated_at:"",data:{quantity:g[1],unit:g[2],weight:g[3],unitPrice:g[4],shipping:g[5],amount:g[3]*g[4]+g[5],date:"2025-05-"+String(15-index).padStart(2,"0"),note:""}}));
  const rows=(records.length?records:samples.filter(r=>!hiddenSamples.includes(r.id))).filter(r=>r.title.toLocaleLowerCase("vi").includes(query.toLocaleLowerCase("vi")));
  const totalWeight=rows.reduce((s,r)=>s+Number(r.data.weight??0),0); const total=rows.reduce((s,r)=>s+Number(r.data.amount??0),0);
  function begin(record?:BusinessRecord){setEditing(record?.id.startsWith("sample-")?null:record??null);setForm(record?{name:record.title,quantity:String(record.data.quantity??1),unit:String(record.data.unit??"Bao"),weight:String(record.data.weight??""),unitPrice:String(record.data.unitPrice??""),shipping:String(record.data.shipping??0),date:String(record.data.date??today()),note:String(record.data.note??"")}:{...empty});setMessage("");setOpen(true);}
  async function save(event:FormEvent){event.preventDefault();const amount=Number(form.weight)*Number(form.unitPrice)+Number(form.shipping||0);try{await saveRecord({id:editing?.id,category:"NHAP_HANG",storeId:store.id,title:form.name,data:{...form,quantity:Number(form.quantity),weight:Number(form.weight),unitPrice:Number(form.unitPrice),shipping:Number(form.shipping),amount}});setOpen(false);await reload();}catch(error){setMessage((error as Error).message);}}
  async function remove(record:BusinessRecord){if(!confirm(`Xóa mặt hàng ${record.title}?`))return; if(record.id.startsWith("sample-")){setHiddenSamples(current=>[...current,record.id]);return;} if(await deleteRecord(record.id))await reload();}
  return <div className="reference-module goods-page"><div className="ref-toolbar"><div><h2>Nhập hàng</h2><p>Quản lý danh sách mặt hàng nhập kho</p></div><div className="ref-toolbar-actions"><button onClick={()=>csv("nhap-hang.csv",[["Mặt hàng","Số lượng","Cân nặng","Đơn giá","Thành tiền"],...rows.map(r=>[r.title,Number(r.data.quantity),Number(r.data.weight),Number(r.data.unitPrice),Number(r.data.amount)])])}><Download size={16}/> Xuất Excel</button><button className="primary-button" onClick={()=>begin()}><Plus size={17}/> Thêm mặt hàng</button></div></div>
    <div className="ref-metrics four"><Metric icon={PackageOpen} label="Tổng mặt hàng" value={String(rows.length)} note="Danh sách hiện tại"/><Metric icon={PackageOpen} label="Tổng số lượng (bao)" value={String(rows.reduce((s,r)=>s+Number(r.data.quantity??0),0))} tone="blue"/><Metric icon={PackageOpen} label="Tổng cân nặng (kg)" value={new Intl.NumberFormat("vi-VN").format(totalWeight)} tone="purple"/><Metric icon={WalletCards} label="Tổng chi phí nhập" value={money(total)} tone="orange"/></div>
    <section className="table-card"><div className="table-head"><label className="ref-search"><Search size={16}/><input placeholder="Tìm kiếm mặt hàng..." value={query} onChange={(e)=>setQuery(e.target.value)}/></label><button>Tất cả danh mục</button></div><div className="data-table-wrap"><table className="data-table goods-table"><thead><tr><th>STT</th><th>Tên mặt hàng</th><th>Số lượng</th><th>Đơn vị</th><th>Cân nặng (kg)</th><th>Đơn giá (đ/kg)</th><th>Phí vận chuyển</th><th>Thành tiền</th><th>Hành động</th></tr></thead><tbody>{rows.map((record,index)=><tr key={record.id}><td>{index+1}</td><td><b>{record.title}</b></td><td>{String(record.data.quantity)}</td><td>{String(record.data.unit)}</td><td>{String(record.data.weight)}</td><td>{money(Number(record.data.unitPrice))}</td><td>{money(Number(record.data.shipping))}</td><td className="money-green"><b>{money(Number(record.data.amount))}</b></td><td><div className="row-actions"><button onClick={()=>begin(record)}><Edit3 size={15}/></button><button className="danger" onClick={()=>remove(record)}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table></div></section>
    <section className="table-card"><div className="table-head"><h2>Lịch sử nhập hàng</h2><div className="ref-tabs compact"><button className="active">Tất cả</button><button>Hôm nay</button><button>Tháng này</button></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Ngày nhập</th><th>Mặt hàng</th><th>Số lượng</th><th>Cân nặng</th><th>Thành tiền</th><th>Người nhập</th></tr></thead><tbody>{rows.slice(0,5).map(r=><tr key={r.id}><td>{String(r.data.date)}</td><td>{r.title}</td><td>{String(r.data.quantity)} {String(r.data.unit)}</td><td>{String(r.data.weight)} kg</td><td><b>{money(Number(r.data.amount))}</b></td><td>Quản lý cửa hàng</td></tr>)}</tbody></table></div></section>
    {open&&<div className="modal-backdrop"><form className="modal goods-modal" onSubmit={save}><div className="modal-title"><div><h2>{editing?"Cập nhật mặt hàng":"Thêm mặt hàng"}</h2><p>Thành tiền tự động theo cân nặng × đơn giá + vận chuyển</p></div><button type="button" onClick={()=>setOpen(false)}><X size={19}/></button></div><label>Tên mặt hàng *<input required value={form.name} onChange={(e)=>setForm({...form,name:e.target.value})}/></label><div className="form-grid two"><label>Số lượng (bao) *<input type="number" min="1" required value={form.quantity} onChange={(e)=>setForm({...form,quantity:e.target.value})}/></label><label>Đơn vị<select value={form.unit} onChange={(e)=>setForm({...form,unit:e.target.value})}><option>Bao</option><option>Kiện</option><option>Thùng</option></select></label><label>Cân nặng (kg) *<input type="number" min="0.01" step="0.01" required value={form.weight} onChange={(e)=>setForm({...form,weight:e.target.value})}/></label><label>Đơn giá nhập (đ/kg) *<input type="number" min="1" required value={form.unitPrice} onChange={(e)=>setForm({...form,unitPrice:e.target.value})}/></label><label>Phí vận chuyển<input type="number" min="0" value={form.shipping} onChange={(e)=>setForm({...form,shipping:e.target.value})}/></label><label>Ngày nhập<input type="date" value={form.date} onChange={(e)=>setForm({...form,date:e.target.value})}/></label></div><div className="goods-total">Thành tiền <b>{money(Number(form.weight||0)*Number(form.unitPrice||0)+Number(form.shipping||0))}</b></div><label>Ghi chú<textarea value={form.note} onChange={(e)=>setForm({...form,note:e.target.value})}/></label>{message&&<div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={()=>setOpen(false)}>Hủy</button><button className="primary-button">Lưu mặt hàng</button></div></form></div>}
  </div>;
}

function AttendanceManagement({ store }: { store: ReferenceStore }) {
  type Mode = "shift" | "day" | "month";
  type AttendanceRow = {
    key: string; employeeCode: string; employeeName: string; workDate: string;
    shiftNames: string[]; startedAt: string | null; endedAt: string | null;
    durationSeconds: number; salary: number; rates: number[]; sessionCount: number;
    active: boolean; supporting: boolean; sourceStoreNames: string[];
    attendanceStatuses: Array<"EARLY" | "ON_TIME" | "LATE">; attendanceDeltas: number[];
    locations: AttendanceLocation[];
  };
  const { shifts } = useShiftSessions(store.id);
  const [mode, setMode] = useState<Mode>("shift");
  const [query, setQuery] = useState("");
  const [date, setDate] = useState(today());
  const [month, setMonth] = useState(today().slice(0, 7));

  const monthSessions = useMemo(() => shifts.filter((shift) => {
    const matchesMonth = sessionDate(shift).slice(0, 7) === month;
    const searchable = `${shift.employeeCode} ${shift.employeeName} ${shift.shiftName ?? shift.shift_code}`.toLocaleLowerCase("vi");
    return matchesMonth && searchable.includes(query.toLocaleLowerCase("vi"));
  }), [month, query, shifts]);

  const aggregate = useCallback((sessions: ShiftSession[], keyOf: (shift: ShiftSession) => string): AttendanceRow[] => {
    const groups = new Map<string, AttendanceRow>();
    for (const shift of sessions) {
      const seconds = sessionSeconds(shift);
      const rate = sessionRate(shift);
      const key = keyOf(shift);
      const current = groups.get(key) ?? {
        key, employeeCode: shift.employeeCode, employeeName: shift.employeeName, workDate: sessionDate(shift),
        shiftNames: [], startedAt: null, endedAt: null, durationSeconds: 0, salary: 0, rates: [], sessionCount: 0,
        active: false, supporting: false, sourceStoreNames: [], attendanceStatuses: [], attendanceDeltas: [], locations: [],
      };
      const attendance = sessionAttendance(shift);
      const location = sessionLocation(shift);
      current.shiftNames = [...new Set([...current.shiftNames, shift.shiftName ?? shift.shift_code])];
      current.rates = [...new Set([...current.rates, rate])];
      current.sourceStoreNames = [...new Set([...current.sourceStoreNames, ...(shift.sourceStoreName ? [shift.sourceStoreName] : [])])];
      current.startedAt = !current.startedAt || new Date(shift.started_at) < new Date(current.startedAt) ? shift.started_at : current.startedAt;
      current.endedAt = !shift.ended_at ? current.endedAt : !current.endedAt || new Date(shift.ended_at) > new Date(current.endedAt) ? shift.ended_at : current.endedAt;
      current.durationSeconds += seconds;
      current.salary += Math.round(seconds / 3_600 * rate);
      current.sessionCount += 1;
      current.active ||= !shift.ended_at || shift.status === "ACTIVE";
      current.supporting ||= Boolean(shift.transfer_id);
      if (attendance) {
        current.attendanceStatuses.push(attendance.status);
        current.attendanceDeltas.push(attendance.delta);
      }
      if (location) current.locations.push(location);
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => b.workDate.localeCompare(a.workDate) || a.employeeCode.localeCompare(b.employeeCode, "vi"));
  }, []);

  const rows = useMemo(() => {
    if (mode === "shift") return aggregate(monthSessions.filter((shift) => sessionDate(shift) === date), (shift) => shift.id);
    if (mode === "day") return aggregate(monthSessions, (shift) => `${sessionDate(shift)}:${shift.employeeCode}`);
    return aggregate(monthSessions, (shift) => shift.employeeCode);
  }, [aggregate, date, mode, monthSessions]);
  const totalSeconds = rows.reduce((sum, row) => sum + row.durationSeconds, 0);
  const totalPay = rows.reduce((sum, row) => sum + row.salary, 0);
  const employeeCount = new Set(rows.map((row) => row.employeeCode)).size;
  const shiftSummary = useMemo(() => {
    const totals = new Map<string, number>();
    for (const shift of monthSessions) {
      const name = shift.shiftName ?? shift.shift_code;
      totals.set(name, (totals.get(name) ?? 0) + sessionSeconds(shift));
    }
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b, "vi"));
  }, [monthSessions]);
  const rowRate = (row: AttendanceRow) => row.rates.length === 1
    ? hourlyMoney(row.rates[0])
    : row.rates.map((rate) => money(rate)).join(" · ") + "/giờ";
  const attendanceLabel = (row: AttendanceRow) => {
    if (row.attendanceStatuses.length === 0) return "Chưa có mốc lịch";
    if (row.attendanceStatuses.length === 1) {
      const status = row.attendanceStatuses[0];
      const delta = row.attendanceDeltas[0] ?? 0;
      if (status === "EARLY") return `Sớm ${Math.abs(delta)} phút`;
      if (status === "LATE") return `Trễ ${Math.max(0, delta)} phút`;
      return delta > 0 ? `Đúng giờ (+${delta} phút)` : "Đúng giờ";
    }
    const early = row.attendanceStatuses.filter((status) => status === "EARLY").length;
    const onTime = row.attendanceStatuses.filter((status) => status === "ON_TIME").length;
    const late = row.attendanceStatuses.filter((status) => status === "LATE").length;
    return `Sớm ${early} · Đúng ${onTime} · Trễ ${late}`;
  };
  const attendanceTone = (row: AttendanceRow) => {
    if (row.attendanceStatuses.includes("LATE")) return "attendance-status attendance-late";
    if (row.attendanceStatuses.includes("EARLY")) return "attendance-status attendance-early";
    if (row.attendanceStatuses.includes("ON_TIME")) return "attendance-status attendance-on-time";
    return "attendance-status attendance-unknown";
  };

  return <div className="reference-module attendance-page">
    <div className="ref-toolbar"><div><h2>Chấm công</h2><p>Danh sách ca và thống kê lương theo giờ làm thực tế</p></div><div className="ref-toolbar-actions">
      {mode === "shift"
        ? <DatePickerControl ariaLabel="Ngày chấm công" hint="Ngày chấm công" value={date} onChange={(value) => { setDate(value); setMonth(value.slice(0, 7)); }}/>
        : <DatePickerControl ariaLabel="Tháng chấm công" hint="Tháng chấm công" type="month" value={month} onChange={setMonth}/>}
      <button type="button" onClick={() => csv("cham-cong.csv", [["Ngày", "Nhân viên", "Ca", "Điểm danh", "Vị trí điểm danh", "Số giờ", "Lương cứng/giờ", "Lương thực nhận"], ...rows.map((row) => [row.workDate, row.employeeName, row.shiftNames.join(", "), attendanceLabel(row), locationExportLabel(row.locations), (row.durationSeconds / 3_600).toFixed(2), rowRate(row), row.salary])])}><Download size={16}/> Xuất Excel</button>
    </div></div>
    <div className="ref-metrics four"><Metric icon={UsersRound} label="Nhân viên có chấm công" value={employeeCount + " người"}/><Metric icon={Clock3} label="Tổng giờ làm thực tế" value={(totalSeconds / 3_600).toFixed(2) + " giờ"} note={`Từ ${rows.reduce((sum, row) => sum + row.sessionCount, 0)} ca làm`} tone="blue"/><Metric icon={WalletCards} label="Lương cứng" value="Theo mức / giờ" note="Quản lý thiết lập cho từng nhân viên" tone="purple"/><Metric icon={WalletCards} label="Tổng lương thực nhận" value={money(totalPay)} note="Lương cứng/giờ × giờ thực tế" tone="teal"/></div>
    <section className="table-card attendance-records" aria-labelledby="attendance-records-title">
      <div className="table-head attendance-table-head"><div className="attendance-table-controls"><h3 className="sr-only" id="attendance-records-title">Danh sách chấm công</h3><div className="ref-tabs compact attendance-mode-tabs" role="group" aria-label="Cách tổng hợp chấm công"><button type="button" className={mode === "shift" ? "active" : ""} aria-pressed={mode === "shift"} onClick={() => setMode("shift")}>Theo ca</button><button type="button" className={mode === "day" ? "active" : ""} aria-pressed={mode === "day"} onClick={() => setMode("day")}>Theo ngày</button><button type="button" className={mode === "month" ? "active" : ""} aria-pressed={mode === "month"} onClick={() => setMode("month")}>Theo tháng · từng nhân viên</button></div><p className="attendance-guidance">Trạng thái đi sớm, đúng giờ hoặc đi trễ dùng ảnh chụp ngưỡng được lưu tại thời điểm nhân viên điểm danh. Chính sách hiện hành và chú giải đánh giá được hiển thị trong bảng thống kê bên dưới. Vị trí là ảnh chụp định vị tại thời điểm nhân viên xác nhận điểm danh.</p></div><label className="ref-search"><Search size={16} aria-hidden="true"/><input aria-label="Tìm nhân viên hoặc ca" placeholder="Tìm nhân viên hoặc ca..." value={query} onChange={(event) => setQuery(event.target.value)}/></label></div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus lets users scroll the wide attendance table. */}
      <div className="data-table-wrap attendance-desktop-table" role="region" tabIndex={0} aria-label="Bảng chấm công, cuộn ngang để xem đầy đủ"><table className="data-table attendance-table"><thead><tr><th>STT</th>{mode !== "month" ? <th>Ngày</th> : null}<th>Nhân viên</th><th>Ca làm việc</th>{mode === "shift" ? <><th>Giờ vào</th><th>Giờ kết ca</th></> : null}<th>Điểm danh</th><th>Vị trí điểm danh</th><th>Số giờ thực tế</th><th>Lương cứng</th><th>Lương thực nhận</th><th>Trạng thái</th></tr></thead><tbody>
        {rows.length === 0 ? <tr><td colSpan={mode === "shift" ? 12 : 10} className="empty-cell">Chưa có dữ liệu chấm công thực tế trong thời gian đã chọn.</td></tr> : rows.map((row, index) => <tr key={row.key}><td>{index + 1}</td>{mode !== "month" ? <td>{dateLabel(row.workDate)}</td> : null}<td><Person name={row.employeeName} position={row.supporting ? `${row.employeeCode} · Hỗ trợ từ ${row.sourceStoreNames.join(", ") || "cửa hàng khác"}` : row.employeeCode}/></td><td><b className={`shift-text c${(index % 3) + 1}`}>{row.shiftNames.join(", ") || "—"}</b>{mode !== "shift" ? <small className="support-note">{row.sessionCount} ca</small> : null}</td>{mode === "shift" ? <><td>{timeLabel(row.startedAt)}</td><td>{row.active ? "Đang làm" : timeLabel(row.endedAt)}</td></> : null}<td><span className={attendanceTone(row)}>{attendanceLabel(row)}</span></td><td className="attendance-location-cell"><AttendanceLocationView locations={row.locations} employeeName={row.employeeName}/></td><td>{(row.durationSeconds / 3_600).toFixed(2)} giờ</td><td>{rowRate(row)}</td><td className="money-green"><b>{money(row.salary)}</b></td><td><span className="status-pill">{row.active ? "Đang làm" : row.supporting ? "Ca hỗ trợ" : "Đã kết ca"}</span></td></tr>)}
      </tbody></table></div>
      {rows.length === 0 ? <p className="attendance-mobile-empty">Chưa có dữ liệu chấm công thực tế trong thời gian đã chọn.</p> : <ol className="attendance-mobile-list" aria-label="Danh sách chấm công">{rows.map((row, index) => <li className="attendance-mobile-card" key={row.key}><header><span className="attendance-mobile-index" aria-label={`Dòng ${index + 1}`}>{index + 1}</span><Person name={row.employeeName} position={row.supporting ? `${row.employeeCode} · Hỗ trợ từ ${row.sourceStoreNames.join(", ") || "cửa hàng khác"}` : row.employeeCode}/><span className="status-pill">{row.active ? "Đang làm" : row.supporting ? "Ca hỗ trợ" : "Đã kết ca"}</span></header><dl>{mode !== "month" ? <div><dt>Ngày</dt><dd>{dateLabel(row.workDate)}</dd></div> : null}<div><dt>Ca làm việc</dt><dd><b className={`shift-text c${(index % 3) + 1}`}>{row.shiftNames.join(", ") || "—"}</b>{mode !== "shift" ? <small className="support-note">{row.sessionCount} ca</small> : null}</dd></div>{mode === "shift" ? <><div><dt>Giờ vào</dt><dd>{timeLabel(row.startedAt)}</dd></div><div><dt>Giờ kết ca</dt><dd>{row.active ? "Đang làm" : timeLabel(row.endedAt)}</dd></div></> : null}<div><dt>Điểm danh</dt><dd><span className={attendanceTone(row)}>{attendanceLabel(row)}</span></dd></div><div className="attendance-mobile-location"><dt>Vị trí</dt><dd><AttendanceLocationView locations={row.locations} employeeName={row.employeeName}/></dd></div><div><dt>Giờ thực tế</dt><dd>{(row.durationSeconds / 3_600).toFixed(2)} giờ</dd></div><div><dt>Lương cứng</dt><dd>{rowRate(row)}</dd></div><div><dt>Thực nhận</dt><dd className="money-green"><b>{money(row.salary)}</b></dd></div></dl></li>)}</ol>}
    </section>
    <AttendanceStatsPanel storeId={store.id}/>
    <div className="ref-bottom-grid"><article className="chart-card"><h3>Cách tính lương</h3><p>• Lương cứng là mức lương quản lý đặt theo giờ cho từng nhân viên.</p><p>• Lương thực nhận = Lương cứng/giờ × số giờ làm thực tế.</p></article><article className="chart-card"><h3>Tổng hợp theo ca · {month}</h3><div className="shift-info">{shiftSummary.length ? shiftSummary.map(([name, seconds]) => <span key={name}><b>{name}</b>{(seconds / 3_600).toFixed(2)} giờ</span>) : <p>Chưa có ca đã ghi nhận.</p>}</div></article><article className="chart-card donut-small"><div className="ref-donut attendance"><b>{employeeCount}</b><small>nhân viên</small></div><div><b>Thống kê tháng</b><p>{monthSessions.length} ca làm thực tế</p><p>{money(monthSessions.reduce((sum, shift) => sum + Math.round(sessionSeconds(shift) / 3_600 * sessionRate(shift)), 0))} tiền lương</p></div></article></div>
  </div>;
}

function PayrollManagement({ store }: { store: ReferenceStore }) {
  const { records, reload } = useRecords("LUONG_THUONG", store.id);
  const [month, setMonth] = useState(today().slice(0, 7));
  const { employees } = useEmployees(store.id, month);
  const [loadedSummary, setLoadedSummary] = useState<PayrollSummary | null>(null);
  const [loadedLocked, setLoadedLocked] = useState(false);
  const [loadedScope, setLoadedScope] = useState<PayrollScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [finalizing, setFinalizing] = useState(false);
  const [kind, setKind] = useState<"ALLOWANCE" | "BONUS">("ALLOWANCE");
  const [open, setOpen] = useState(false);
  const [adjustmentScope, setAdjustmentScope] = useState<PayrollScope | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(today());
  const [message, setMessage] = useState("");
  const [savingAdjustment, setSavingAdjustment] = useState(false);
  const [deletingAdjustmentId, setDeletingAdjustmentId] = useState<string | null>(null);
  const savingAdjustmentRef = useRef(false);
  const deletingAdjustmentRef = useRef<string | null>(null);
  const payrollEmployeeSelectRef = useRef<HTMLSelectElement | null>(null);
  const payrollBackdropRef = useRef<HTMLDivElement | null>(null);
  const payrollDialogRef = useRef<HTMLFormElement | null>(null);
  const payrollTriggerRef = useRef<HTMLElement | null>(null);
  const loadRequest = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const selectedScopeRef = useRef<PayrollScope>({ storeId: store.id, period: month });

  const loadPayroll = useCallback(async () => {
    const requestedScope = { storeId: store.id, period: month };
    const requestId = ++loadRequest.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setMessage("");
    setLoadedSummary(null);
    setLoadedLocked(false);
    setLoadedScope(null);
    try {
      const query = new URLSearchParams(requestedScope);
      const response = await fetch("/api/payroll?" + query, { cache: "no-store", signal: controller.signal });
      const result = await response.json() as PayrollResponse;
      if (!response.ok) throw new Error(result.message || "Không thể tải kỳ lương");
      if (
        result.period !== requestedScope.period
        || !result.summary
        || result.summary.period !== requestedScope.period
        || result.summary.storeId !== requestedScope.storeId
      ) {
        throw new Error("Dữ liệu lương thưởng phản hồi không đúng cửa hàng hoặc kỳ đã chọn.");
      }
      if (requestId !== loadRequest.current || controller.signal.aborted) return;
      setLoadedSummary(result.summary);
      setLoadedLocked(Boolean(result.locked));
      setLoadedScope(requestedScope);
    } catch (cause) {
      if (requestId !== loadRequest.current || controller.signal.aborted) return;
      setLoadedSummary(null);
      setLoadedLocked(false);
      setLoadedScope(null);
      setMessage(cause instanceof Error ? cause.message : "Không thể tải kỳ lương");
    } finally {
      if (loadController.current === controller) loadController.current = null;
      if (requestId === loadRequest.current && !controller.signal.aborted) setLoading(false);
    }
  }, [month, store.id]);

  useEffect(() => {
    selectedScopeRef.current = { storeId: store.id, period: month };
  }, [month, store.id]);
  useEffect(() => {
    void loadPayroll();
    return () => loadController.current?.abort();
  }, [loadPayroll]);
  useEffect(() => {
    const handlePayrollUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ storeId?: string; period?: string; source?: string }>).detail;
      if (detail?.source === "closing" && detail.storeId === store.id && detail.period === month) {
        void loadPayroll();
      }
    };
    window.addEventListener(PAYROLL_UPDATED_EVENT, handlePayrollUpdate);
    return () => window.removeEventListener(PAYROLL_UPDATED_EVENT, handlePayrollUpdate);
  }, [loadPayroll, month, store.id]);
  useEffect(() => {
    if (!employees.some((employee) => employee.id === employeeId)) {
      setEmployeeId(employees[0]?.id ?? "");
    }
  }, [employeeId, employees]);
  const dataIsCurrent = Boolean(
    loadedScope
    && loadedScope.storeId === store.id
    && loadedScope.period === month
    && loadedSummary
    && loadedSummary.storeId === loadedScope.storeId
    && loadedSummary.period === loadedScope.period,
  );
  const summary = dataIsCurrent ? loadedSummary : null;
  const locked = dataIsCurrent ? loadedLocked : false;
  const adjustmentIsCurrent = Boolean(
    adjustmentScope
    && loadedScope
    && dataIsCurrent
    && samePayrollScope(adjustmentScope, loadedScope),
  );
  useAccessibleModal({
    open: Boolean(open && adjustmentScope && adjustmentIsCurrent),
    rootRef: payrollBackdropRef,
    dialogRef: payrollDialogRef,
    initialFocusRef: payrollEmployeeSelectRef,
    returnFocusRef: payrollTriggerRef,
    dismissDisabled: savingAdjustment,
    onDismiss: closeAdjustmentDialog,
  });
  const periodRecords = records.filter((record) => String(record.data.date ?? "").slice(0, 7) === month);

  function selectMonth(value: string) {
    selectedScopeRef.current = { storeId: store.id, period: value };
    setOpen(false);
    setAdjustmentScope(null);
    setMonth(value);
  }

  function begin(type: "ALLOWANCE" | "BONUS") {
    const actionScope = loadedScope;
    if (!actionScope || !dataIsCurrent) {
      setMessage("Dữ liệu kỳ lương đang tải hoặc chưa khớp kỳ đã chọn. Vui lòng tải lại trước khi thao tác.");
      return;
    }
    if (locked) return setMessage("Kỳ lương đã khóa, không thể thêm khoản mới.");
    payrollTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAdjustmentScope(actionScope);
    setKind(type);
    setAmount("");
    setNote("");
    setDate(actionScope.period === today().slice(0, 7) ? today() : `${actionScope.period}-01`);
    setMessage("");
    setOpen(true);
  }

  function closeAdjustmentDialog() {
    if (savingAdjustmentRef.current) return;
    setOpen(false);
    setAdjustmentScope(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingAdjustmentRef.current) return;
    const actionScope = adjustmentScope;
    if (!actionScope || !adjustmentIsCurrent || date.slice(0, 7) !== actionScope.period) {
      setMessage("Kỳ lương đã thay đổi. Vui lòng đóng hộp thoại và tạo lại khoản điều chỉnh trong kỳ đang chọn.");
      return;
    }
    const employee = employees.find((item) => item.id === employeeId);
    const parsedAmount = parseVndInput(amount);
    if (!employee || !Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) return setMessage("Vui lòng chọn nhân viên và nhập số tiền hợp lệ.");
    savingAdjustmentRef.current = true;
    setSavingAdjustment(true);
    setMessage("");
    try {
      await saveRecord({
        category: "LUONG_THUONG", storeId: actionScope.storeId,
        title: (kind === "ALLOWANCE" ? "Phụ cấp" : "Thưởng") + " · " + employee.name,
        data: { kind, employeeId, employeeName: employee.name, amount: parsedAmount, note, date, period: actionScope.period },
      });
      setOpen(false);
      setAdjustmentScope(null);
      if (samePayrollScope(selectedScopeRef.current, actionScope)) {
        await reload();
        if (samePayrollScope(selectedScopeRef.current, actionScope)) await loadPayroll();
      }
      window.dispatchEvent(new CustomEvent(PAYROLL_UPDATED_EVENT, {
        detail: { storeId: actionScope.storeId, period: actionScope.period, source: "management" },
      }));
    } catch (error) {
      // Keep the dialog and every entered field intact so the manager can
      // correct or retry the same adjustment.
      setMessage((error as Error).message);
    } finally {
      savingAdjustmentRef.current = false;
      setSavingAdjustment(false);
    }
  }

  async function remove(id: string) {
    const actionScope = loadedScope;
    if (!actionScope || !dataIsCurrent || locked || deletingAdjustmentRef.current) {
      if (locked) setMessage("Kỳ lương đã khóa, không thể xóa khoản đã tổng kết.");
      else if (!dataIsCurrent) setMessage("Dữ liệu kỳ lương đang tải hoặc chưa khớp kỳ đã chọn. Vui lòng tải lại trước khi thao tác.");
      return;
    }
    deletingAdjustmentRef.current = id;
    setDeletingAdjustmentId(id);
    setMessage("");
    try {
      if (await deleteRecord(id, setMessage)) {
        if (samePayrollScope(selectedScopeRef.current, actionScope)) {
          await reload();
          if (samePayrollScope(selectedScopeRef.current, actionScope)) await loadPayroll();
        }
        window.dispatchEvent(new CustomEvent(PAYROLL_UPDATED_EVENT, {
          detail: { storeId: actionScope.storeId, period: actionScope.period, source: "management" },
        }));
      }
    } finally {
      deletingAdjustmentRef.current = null;
      setDeletingAdjustmentId(null);
    }
  }

  async function finalize() {
    const actionScope = loadedScope;
    if (!actionScope || !dataIsCurrent || locked || loading || finalizing) {
      if (!dataIsCurrent) setMessage("Dữ liệu kỳ lương đang tải hoặc chưa khớp kỳ đã chọn. Vui lòng tải lại trước khi thao tác.");
      return;
    }
    if (!confirm(`Tổng kết và khóa lương thưởng tháng ${actionScope.period}? Dữ liệu KPI sẽ không tự thay đổi sau khi khóa.`)) return;
    setFinalizing(true);
    setMessage("");
    try {
      const response = await fetch("/api/payroll", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: actionScope.storeId, period: actionScope.period }),
      });
      const result = await response.json() as PayrollResponse;
      if (!response.ok) throw new Error(result.message || "Không thể tổng kết kỳ lương");
      if (!result.summary || result.summary.storeId !== actionScope.storeId || result.summary.period !== actionScope.period) {
        throw new Error("Dữ liệu tổng kết phản hồi không đúng cửa hàng hoặc kỳ đã chọn.");
      }
      window.dispatchEvent(new CustomEvent(PAYROLL_UPDATED_EVENT, {
        detail: { storeId: actionScope.storeId, period: actionScope.period, source: "management" },
      }));
      if (!samePayrollScope(selectedScopeRef.current, actionScope)) return;
      setLoadedSummary(result.summary);
      setLoadedLocked(true);
      setLoadedScope(actionScope);
      setMessage("✓ Đã tổng kết và khóa kỳ lương thưởng.");
    } catch (cause) {
      if (samePayrollScope(selectedScopeRef.current, actionScope)) {
        setMessage(cause instanceof Error ? cause.message : "Không thể tổng kết kỳ lương");
      }
    } finally {
      setFinalizing(false);
    }
  }

  function exportPayroll() {
    const actionScope = loadedScope;
    if (!actionScope || !dataIsCurrent || !summary) return;
    csv(`luong-thuong-${actionScope.storeId}-${actionScope.period}.csv`, [
      ["Nhân viên", "Lương cứng/giờ", "Giờ thực tế", "Lương thực nhận", "Phụ cấp", "Thưởng khác", "Thưởng KPI", "Tổng nhận", "Đã ứng", "Còn khả dụng"],
      ...summary.items.map((item) => [item.employeeName, item.hourlyRate, item.hours.toFixed(2), item.baseSalary, item.tiktokAllowance + item.supportAllowance + item.manualAllowance, item.manualBonus, item.kpiBonus, item.totalPay, item.salaryAdvanceReserved ?? 0, item.availablePay ?? item.totalPay]),
    ]);
  }

  const items = summary?.items ?? [];
  const totalAllowance = (summary?.totalTikTokAllowance ?? 0) + (summary?.totalSupportAllowance ?? 0) + (summary?.totalManualAllowance ?? 0);
  const totalBonus = (summary?.totalManualBonus ?? 0) + (summary?.totalKpiBonus ?? 0);
  const rateLabel = `${Math.round((summary?.kpiRate ?? 0) * 100)}%`;
  const managerFixedHours = summary?.managerFixedHours ?? 140;
  const employeeKpiHours = summary?.kpiEligibleHours ?? summary?.totalHours ?? 0;
  const totalKpiHours = summary?.totalKpiHours ?? (employeeKpiHours + managerFixedHours);
  const profitPerKpiHour = summary?.profitPerKpiHour ?? summary?.profitPerHour ?? 0;
  const allowanceNote = [
    `Phụ cấp TikTok ${money(summary?.totalTikTokAllowance ?? 0)}`,
    ...(summary?.totalSupportAllowance ? [`Phụ cấp hỗ trợ ${money(summary.totalSupportAllowance)}`] : []),
    `Phụ cấp khác ${money(summary?.totalManualAllowance ?? 0)}`,
  ].join("\n");

  return <div className="reference-module payroll-page">
    <div className="ref-toolbar"><div><h2>Lương thưởng nhân viên</h2><p>Tổng kết lương và thưởng KPI theo giờ làm thực tế của từng cửa hàng</p></div><div className="ref-toolbar-actions payroll-compact-actions">
      <DatePickerControl className="payroll-period-picker" ariaLabel="Tháng tổng kết" hint="Kỳ lương" type="month" value={month} onChange={selectMonth}/>
      <button disabled={!dataIsCurrent} onClick={exportPayroll}><Download size={16}/> Xuất Excel</button>
      <button disabled={locked || loading || finalizing || !dataIsCurrent} onClick={() => begin("ALLOWANCE")}><Plus size={16}/> Tạo phụ cấp</button>
      <button disabled={locked || loading || finalizing || !dataIsCurrent} onClick={() => begin("BONUS")}><Gift size={16}/> Tạo thưởng</button>
      <button className="primary-button" disabled={locked || loading || finalizing || !dataIsCurrent} onClick={finalize}><CheckCircle2 size={16}/>{locked ? "Đã khóa kỳ" : loading || finalizing ? "Đang tính..." : "Tổng kết tháng"}</button>
    </div></div>

    {message && <div className={message.startsWith("✓") ? "success-banner" : "form-message"}>{message}</div>}
    <div className="report-profit-note"><CheckCircle2 size={18}/><span>Lợi nhuận cơ sở trước KPI <b>{money(summary?.profit ?? store.profit)}</b> · Tổng giờ xét KPI <b>{totalKpiHours.toFixed(2)} giờ</b> ({employeeKpiHours.toFixed(2)} giờ nhân viên đủ điều kiện + {managerFixedHours} giờ quản lý) · Lợi nhuận cơ sở/giờ xét KPI <b>{money(profitPerKpiHour)}</b> · Ngưỡng KPI <b>{rateLabel}</b>{typeof summary?.netProfit === "number" ? <> · Lợi nhuận sau cùng <b>{money(summary.netProfit)}</b></> : null}</span></div>
    <div className="ref-metrics six">
      <Metric icon={Clock3} label="Tổng giờ làm" value={(summary?.totalHours ?? 0).toFixed(2) + " giờ"} tone="blue"/>
      <Metric icon={WalletCards} label="Tổng lương thực nhận" value={money(summary?.totalBaseSalary ?? 0)} note="Lương cứng/giờ × giờ thực tế"/>
      <Metric icon={Gift} label="Thưởng KPI" value={money(summary?.totalKpiBonus ?? 0)} note={`Một ngưỡng duy nhất: ${rateLabel}`} tone="orange"/>
      <Metric icon={WalletCards} label="Tổng phụ cấp" value={money(totalAllowance)} note={allowanceNote} tone="purple"/>
      <Metric icon={UsersRound} label="Tổng chi trả" value={money(summary?.totalPay ?? 0)} tone="teal"/>
      <Metric icon={UserRound} label="Tổng nhân viên" value={items.length + " nhân viên"}/>
    </div>

    {dataIsCurrent ? <SalaryAdvancePanel storeId={store.id} period={month} disabled={locked || loading || finalizing} onUpdated={loadPayroll}/> : null}

    <section className="table-card"><div className="table-head"><div><h2>Chi tiết lương thưởng · {formatMonthVn(month)}</h2><p>Lương thực nhận được tính từ lương cứng theo giờ và giờ làm thực tế.</p></div><span className={locked ? "status-pill" : "shift-pill s2"}>{locked ? "Đã tổng kết · Đã khóa" : "Bản xem trước"}</span></div><div className="data-table-wrap"><table className="data-table payroll-table"><thead><tr><th>Nhân viên</th><th>Lương cứng</th><th>Giờ thực tế</th><th>Lương thực nhận</th><th>Phụ cấp</th><th>Thưởng khác</th><th>Thưởng KPI</th><th>Tổng nhận</th><th>Đã ứng</th><th>Còn khả dụng</th></tr></thead><tbody>
      {items.length ? items.map((item) => <tr key={item.employeeId}><td><Person name={item.employeeName} position={`${item.employeeCode} · ${item.position}`}/></td><td>{hourlyMoney(item.hourlyRate)}</td><td>{item.hours.toFixed(2)} giờ</td><td><b>{money(item.baseSalary)}</b></td><td className="money-green">{money(item.tiktokAllowance + item.supportAllowance + item.manualAllowance)}</td><td>{money(item.manualBonus)}</td><td className="money-green"><b>{money(item.kpiBonus)}</b></td><td><b>{money(item.totalPay)}</b></td><td>{money(item.salaryAdvanceReserved ?? 0)}</td><td className="money-green"><b>{money(item.availablePay ?? item.totalPay)}</b></td></tr>) : <tr><td colSpan={10} className="empty-cell">{loading ? "Đang tổng hợp dữ liệu..." : "Chưa có nhân viên trong cửa hàng."}</td></tr>}
    </tbody></table></div></section>

    <section className="table-card"><div className="table-head"><h2>Lịch sử tạo phụ cấp và thưởng · {formatMonthVn(month)}</h2><span>{periodRecords.length} bản ghi</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Thời gian</th><th>Nhân viên</th><th>Loại</th><th>Số tiền</th><th>Nội dung chi</th><th>Người tạo</th><th>Thao tác</th></tr></thead><tbody>
      {periodRecords.length ? periodRecords.map((record) => <tr key={record.id}><td>{dateLabel(String(record.data.date))}</td><td><b>{String(record.data.employeeName)}</b></td><td><span className={record.data.kind === "BONUS" ? "bonus-pill" : "allowance-pill"}>{record.data.kind === "BONUS" ? "Thưởng" : "Phụ cấp"}</span></td><td className="money-green"><b>{money(Number(record.data.amount))}</b></td><td>{String(record.data.note || "—")}</td><td>Quản lý cửa hàng</td><td><button disabled={locked || loading || finalizing || !dataIsCurrent || deletingAdjustmentId !== null} className="danger-link" onClick={() => void remove(record.id)}>{deletingAdjustmentId === record.id ? "Đang xóa…" : "Xóa"}</button></td></tr>) : <tr><td colSpan={7} className="empty-cell">Chưa phát sinh phụ cấp hoặc thưởng trong kỳ.</td></tr>}
    </tbody></table></div></section>

    <div className="ref-chart-row"><article className="chart-card donut-small"><div className="ref-donut payroll"><b>{money(summary?.totalAvailablePay ?? summary?.totalPay ?? 0)}</b><small>Còn phải chi</small></div><div><b>Cơ cấu chi trả</b><p>Lương theo giờ thực tế</p><p>Đã trừ các khoản ứng lương</p></div></article><article className="chart-card"><h3>Thống kê giờ làm theo ngày</h3><MiniBars/></article><article className="chart-card quick-total"><h3>Tóm tắt nhanh</h3><p><span>Lương thực nhận</span><b>{money(summary?.totalBaseSalary ?? 0)}</b></p><p><span>Phụ cấp</span><b>{money(totalAllowance)}</b></p><p><span>Thưởng khác</span><b>{money(summary?.totalManualBonus ?? 0)}</b></p><p><span>Thưởng KPI</span><b>{money(summary?.totalKpiBonus ?? 0)}</b></p><p><span>Đã ứng / chờ chi</span><b>{money(summary?.totalSalaryAdvanceReserved ?? 0)}</b></p><p><span>Còn khả dụng</span><b>{money(summary?.totalAvailablePay ?? summary?.totalPay ?? 0)}</b></p><p><span>Tổng thưởng</span><b>{money(totalBonus)}</b></p></article></div>

    {open && adjustmentScope && adjustmentIsCurrent && <div ref={payrollBackdropRef} className="modal-backdrop"><form ref={payrollDialogRef} className="modal payroll-action-modal" role="dialog" aria-modal="true" aria-labelledby="payroll-adjustment-dialog-title" aria-busy={savingAdjustment} tabIndex={-1} onSubmit={save}><div className="modal-title"><div><h2 id="payroll-adjustment-dialog-title">{kind === "ALLOWANCE" ? "Tạo phụ cấp" : "Tạo thưởng"}</h2><p>Khoản chi được ghi nhận đúng nhân viên, cửa hàng và tháng lương</p></div><button type="button" aria-label="Đóng hộp thoại tạo phụ cấp hoặc thưởng" disabled={savingAdjustment} onClick={closeAdjustmentDialog}><X size={19}/></button></div><label>Nhân viên được nhận *<select ref={payrollEmployeeSelectRef} disabled={savingAdjustment} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.code} · {employee.name}{employeeStatusSuffix(employee.status)}</option>)}</select></label><label>Số tiền {kind === "ALLOWANCE" ? "phụ cấp" : "thưởng"} *<input inputMode="numeric" required disabled={savingAdjustment} value={amount} onChange={(event) => setAmount(formatVndInput(event.target.value))} placeholder="0"/><small>Nhập theo VND, ví dụ: 15000 sẽ hiển thị 15,000.</small></label><div className="app-date-picker-field"><span>Ngày ghi nhận</span><DatePickerControl ariaLabel="Ngày ghi nhận phụ cấp hoặc thưởng" min={`${adjustmentScope.period}-01`} max={`${adjustmentScope.period}-31`} disabled={savingAdjustment} value={date} onChange={setDate}/></div><label>Nội dung chi *<textarea required disabled={savingAdjustment} value={note} onChange={(event) => setNote(event.target.value)} placeholder={kind === "ALLOWANCE" ? "Ví dụ: Phụ cấp chuyên cần" : "Ví dụ: Thưởng hoàn thành công việc"}/></label>{message && <div className="form-message" role="alert">{message}</div>}<div className="modal-actions"><button type="button" disabled={savingAdjustment} onClick={closeAdjustmentDialog}>Hủy</button><button className="primary-button" disabled={savingAdjustment || !employeeId}>{savingAdjustment ? "Đang lưu…" : `Lưu ${kind === "ALLOWANCE" ? "phụ cấp" : "thưởng"}`}</button></div></form></div>}
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
  const completed=shifts.filter(s=>s.ended_at); const hours=completed.reduce((sum,s)=>sum+sessionSeconds(s)/3600,0); const shiftWages=completed.reduce((sum,s)=>sum+(sessionSeconds(s)/3600)*sessionRate(s),0); const wages=periodPayroll?.totalBaseSalary??shiftWages; const recordExtras=payroll.reduce((sum,r)=>sum+Number(r.data.amount??0),0); const extras=periodPayroll ? periodPayroll.totalTikTokAllowance+periodPayroll.totalSupportAllowance+periodPayroll.totalManualAllowance+periodPayroll.totalManualBonus+periodPayroll.totalKpiBonus : recordExtras;
  return <div className="reference-module report-page"><div className="ref-toolbar"><div><h2>Báo cáo thống kê</h2><p>Tổng hợp dữ liệu hoạt động của cửa hàng</p></div><div className="ref-toolbar-actions"><input type="date" value={from} onChange={(e)=>setFrom(e.target.value)}/><span>−</span><input type="date" value={to} onChange={(e)=>setTo(e.target.value)}/><button className="primary-button" onClick={()=>csv("bao-cao-cua-hang.csv",[["Chỉ số","Giá trị"],["Nhân viên",employees.length],["Tổng giờ",hours.toFixed(2)],["Lương",Math.round(wages)],["Thưởng/phụ cấp",extras],["Doanh thu",store.revenue]])}><Download size={16}/> Xuất báo cáo</button></div></div>
    <div className="ref-report-tabs">{["Tổng quan","Chấm công","Lương thưởng","Ca làm việc","Nhân viên","Chi tiết"].map(item=><button key={item} className={tab===item?"active":""} onClick={()=>setTab(item)}>{item}</button>)}</div>
    <div className="ref-metrics five"><Metric icon={UsersRound} label="Tổng nhân viên" value={employees.length+" người"} note="Theo dữ liệu hiện tại"/><Metric icon={Clock3} label="Tổng giờ làm" value={hours.toFixed(2)+" giờ"} note="Theo kỳ đã chọn"/><Metric icon={WalletCards} label="Tổng lương cứng" value={money(wages)}/><Metric icon={Gift} label="Tổng thưởng" value={money(extras)}/><Metric icon={WalletCards} label="Tổng lương nhận" value={money(wages+extras)}/></div>
    <div className="ref-report-charts"><article className="chart-card"><h2>Giờ làm việc theo ngày</h2><MiniBars/></article><article className="chart-card"><h2>Doanh thu theo ngày</h2><MiniLine/></article><article className="chart-card donut-small vertical"><h2>Cơ cấu lương nhận</h2><div className="ref-donut report"><b>{money(wages+extras)}</b><small>Tổng lương nhận</small></div></article></div>
    <div className="ref-report-bottom"><section className="table-card"><div className="table-head"><h2>{tab === "Tổng quan" ? "Thống kê theo nhân viên" : "Chi tiết " + tab.toLocaleLowerCase("vi")}</h2></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Nhân viên</th><th>Tổng giờ làm</th><th>Lương cứng</th><th>Thưởng</th><th>Phụ cấp</th><th>Lương nhận</th></tr></thead><tbody>{(employees.length?employees:samplePeople.slice(0,3).map((p,i)=>({id:"s"+i,name:p[0],position:p[1],hourly_rate:20000}))).map((employee,index)=>{const employeeHours=[75.5,68,66.5][index%3];const base=employeeHours*employee.hourly_rate;const extra=payroll.filter(r=>r.data.employeeId===employee.id).reduce((s,r)=>s+Number(r.data.amount),0);return <tr key={employee.id}><td><Person name={employee.name} position={employee.position}/></td><td>{employeeHours.toFixed(2)}</td><td>{money(base)}</td><td className="money-green">{money(extra)}</td><td>{money(100000)}</td><td className="money-green"><b>{money(base+extra+100000)}</b></td></tr>})}</tbody></table></div></section><aside className="chart-card"><h2>Thống kê ca làm việc</h2>{["Ca 1 · 62,50 giờ","Ca 2 · 71,00 giờ","Ca 3 · 76,50 giờ"].map((text,index)=><div className="progress-row" key={text}><span>{text}</span><i><b style={{width:[30,34,36][index]+"%"}}/></i><strong>{[29.8,33.8,36.4][index]}%</strong></div>)}</aside></div>
    <div className="report-profit-note"><CheckCircle2 size={18}/> Dữ liệu {tab.toLocaleLowerCase("vi")} của {store.name} trong kỳ {from} → {to} · Doanh thu <b>{money(store.revenue)}</b> · Lợi nhuận <b>{money(store.profit)}</b></div>
  </div>;
}
