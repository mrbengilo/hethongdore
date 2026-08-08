"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays, CalendarRange, Check, ChevronLeft, ChevronRight, Clock3,
  Download, Edit3, Plus, Search, Trash2, UsersRound, X,
} from "lucide-react";
import {
  addDays, formatShiftDuration, isOvernightShift, localDate,
  shiftDurationMinutes, shiftsOverlap, shiftUtcRange, validClock, weekDates,
} from "../lib/scheduling";
import styles from "./StoreSchedulingModules.module.css";

export type SchedulingStore = { id: string; name: string; status?: string };

type BusinessRecord = {
  id: string;
  title: string;
  data: Record<string, unknown>;
  status: string;
  created_at?: string;
  updated_at?: string;
};

type Employee = {
  id: string;
  code: string;
  name: string;
  position: string;
  status: string;
};

type ShiftDefinition = {
  id: string;
  record?: BusinessRecord;
  name: string;
  start: string;
  end: string;
  duration: number;
  overnight: boolean;
  persisted: boolean;
};

type ScheduleEntry = {
  id: string;
  record: BusinessRecord;
  date: string;
  shiftId: string;
  shiftName: string;
  start: string;
  end: string;
  overnight: boolean;
  employeeIds: string[];
  employeeNames: string[];
  note: string;
};

const defaultShifts: ShiftDefinition[] = [
  { id: "default-1", name: "Ca 1", start: "07:00", end: "12:00", duration: 300, overnight: false, persisted: false },
  { id: "default-2", name: "Ca 2", start: "12:00", end: "17:00", duration: 300, overnight: false, persisted: false },
  { id: "default-3", name: "Ca 3", start: "17:00", end: "23:00", duration: 360, overnight: false, persisted: false },
];

function mergeDefaultShifts(persisted: ShiftDefinition[]) {
  const normalized = (value: string) => value.trim().toLocaleLowerCase("vi-VN");
  const matched = new Set<string>();
  const defaults = defaultShifts.map((fallback) => {
    const existing = persisted.find((shift) => normalized(shift.name) === normalized(fallback.name));
    if (existing) matched.add(existing.id);
    return existing ?? fallback;
  });
  return [...defaults, ...persisted.filter((shift) => !matched.has(shift.id))];
}

const dayNames = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("vi-VN", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(`${value}T12:00:00+07:00`));
}

function shortDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function safeStrings(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function toShift(record: BusinessRecord): ShiftDefinition | null {
  const start = safeString(record.data.start);
  const end = safeString(record.data.end);
  if (!validClock(start) || !validClock(end)) return null;
  const duration = shiftDurationMinutes(start, end);
  if (!duration) return null;
  return {
    id: record.id,
    record,
    name: record.title,
    start,
    end,
    duration,
    overnight: isOvernightShift(start, end),
    persisted: true,
  };
}

function toSchedule(record: BusinessRecord): ScheduleEntry | null {
  const date = safeString(record.data.date);
  const start = safeString(record.data.start);
  const end = safeString(record.data.end);
  if (!date || !validClock(start) || !validClock(end)) return null;
  return {
    id: record.id,
    record,
    date,
    shiftId: safeString(record.data.shiftId),
    shiftName: safeString(record.data.shiftName, record.title.split(" · ")[0] || "Ca làm"),
    start,
    end,
    overnight: typeof record.data.overnight === "boolean"
      ? record.data.overnight
      : isOvernightShift(start, end),
    employeeIds: safeStrings(record.data.employeeIds),
    employeeNames: safeStrings(record.data.employeeNames),
    note: safeString(record.data.note),
  };
}

function useRecords(category: "CA_LAM_VIEC" | "LICH_PHAN_CA", storeId: string) {
  const [records, setRecords] = useState<BusinessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ category, storeId });
      const response = await fetch(`/api/records?${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Không thể tải dữ liệu");
      setRecords(result.records ?? []);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Không thể tải dữ liệu");
    } finally {
      setLoading(false);
    }
  }, [category, storeId]);
  useEffect(() => { void reload(); }, [reload]);
  return { records, loading, error, reload };
}

function useEmployees(storeId: string) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/employees?storeId=${encodeURIComponent(storeId)}&includeSupport=1`);
      const result = await response.json();
      setEmployees(response.ok ? result.employees ?? [] : []);
    } finally {
      setLoading(false);
    }
  }, [storeId]);
  useEffect(() => { void reload(); }, [reload]);
  return { employees, loading, reload };
}

async function saveRecord(input: {
  id?: string;
  category: "CA_LAM_VIEC" | "LICH_PHAN_CA";
  storeId: string;
  title: string;
  data: Record<string, unknown>;
}) {
  const response = await fetch("/api/records", {
    method: input.id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Không thể lưu dữ liệu");
  return result;
}

async function removeRecord(id: string) {
  const response = await fetch(`/api/records?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Không thể xóa dữ liệu");
}

function exportCsv(filename: string, rows: Array<Array<string | number>>) {
  const safe = (value: string | number) => {
    const source = String(value);
    const protectedValue = /^[=+\-@]/.test(source) ? `'${source}` : source;
    return `"${protectedValue.replaceAll('"', '""')}"`;
  };
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function EmployeeName({ employee }: { employee: Employee }) {
  return <div className={styles.employeeName}>
    <i>{employee.name.slice(0, 1).toLocaleUpperCase("vi-VN")}</i>
    <span><b>{employee.name}</b><small>{employee.code} · {employee.position}</small></span>
  </div>;
}

function ShiftCards({ shifts, schedules, date, onEdit, onRemove }: {
  shifts: ShiftDefinition[];
  schedules: ScheduleEntry[];
  date: string;
  onEdit?: (shift: ShiftDefinition) => void;
  onRemove?: (shift: ShiftDefinition) => void;
}) {
  return <div className={styles.shiftCards}>
    {shifts.map((shift, index) => {
      const people = new Set(schedules.filter((entry) => entry.date === date && (entry.shiftId === shift.id || entry.shiftName === shift.name)).flatMap((entry) => entry.employeeIds)).size;
      return <article className={`${styles.shiftCard} ${styles[`tone${index % 3 + 1}`]}`} key={shift.id}>
        <i><Clock3 size={25}/></i>
        <div><span>{shift.name}</span><strong>{shift.start} - {shift.end}</strong><small>{formatShiftDuration(shift.duration)}{shift.overnight ? " · Qua đêm" : ""} · {people} nhân viên</small></div>
        {onEdit && <div className={styles.cardActions}>
          <button type="button" aria-label={`Sửa ${shift.name}`} onClick={() => onEdit(shift)}><Edit3 size={15}/></button>
          <button type="button" aria-label={`Xóa ${shift.name}`} disabled={!shift.persisted} onClick={() => onRemove?.(shift)}><Trash2 size={15}/></button>
        </div>}
      </article>;
    })}
  </div>;
}

function DayGrid({ employees, shifts, schedules, date, onEdit }: {
  employees: Employee[];
  shifts: ShiftDefinition[];
  schedules: ScheduleEntry[];
  date: string;
  onEdit?: (entry: ScheduleEntry) => void;
}) {
  return <div className={styles.tableWrap}><table className={styles.scheduleTable}>
    <thead><tr><th>Nhân viên</th>{shifts.map((shift) => <th key={shift.id}><b>{shift.name}</b><small>{shift.start} - {shift.end}</small></th>)}</tr></thead>
    <tbody>{employees.length === 0 ? <tr><td colSpan={shifts.length + 1} className={styles.empty}>Chưa có nhân viên tại cửa hàng.</td></tr> : employees.map((employee) => <tr key={employee.id}>
      <td><EmployeeName employee={employee}/></td>
      {shifts.map((shift, index) => {
        const assigned = schedules.find((entry) => entry.date === date && entry.employeeIds.includes(employee.id) && (entry.shiftId === shift.id || entry.shiftName === shift.name));
        return <td key={shift.id}>{assigned
          ? <button type="button" disabled={!onEdit} className={`${styles.assignmentChip} ${styles[`chip${index % 3 + 1}`]}`} onClick={() => onEdit?.(assigned)}><Check size={14}/><span>{assigned.shiftName}<small>{assigned.start} - {assigned.end}</small></span></button>
          : <span className={styles.unassigned}>—</span>}</td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

function WeekGrid({ employees, schedules, anchor, onEdit }: {
  employees: Employee[];
  schedules: ScheduleEntry[];
  anchor: string;
  onEdit?: (entry: ScheduleEntry) => void;
}) {
  const dates = weekDates(anchor);
  return <div className={styles.tableWrap}><table className={`${styles.scheduleTable} ${styles.weekTable}`}>
    <thead><tr><th>Nhân viên</th>{dates.map((date, index) => <th key={date}><b>{dayNames[index]}</b><small>{shortDate(date).slice(0, 5)}</small></th>)}</tr></thead>
    <tbody>{employees.map((employee) => <tr key={employee.id}><td><EmployeeName employee={employee}/></td>{dates.map((date) => {
      const entries = schedules.filter((entry) => entry.date === date && entry.employeeIds.includes(employee.id));
      return <td key={date}>{entries.length ? entries.map((entry) => <button type="button" disabled={!onEdit} className={styles.weekChip} key={entry.id} onClick={() => onEdit?.(entry)}><b>{entry.shiftName}</b><small>{entry.start} - {entry.end}</small></button>) : <span className={styles.unassigned}>—</span>}</td>;
    })}</tr>)}</tbody>
  </table></div>;
}

export function StoreShiftManagement({ store }: { store: SchedulingStore }) {
  const inactive = store.status === "INACTIVE";
  const shiftsSource = useRecords("CA_LAM_VIEC", store.id);
  const scheduleSource = useRecords("LICH_PHAN_CA", store.id);
  const { employees } = useEmployees(store.id);
  const shifts = useMemo(() => {
    const persisted = shiftsSource.records.map(toShift).filter((item): item is ShiftDefinition => Boolean(item));
    return mergeDefaultShifts(persisted);
  }, [shiftsSource.records]);
  const schedules = useMemo(() => scheduleSource.records.map(toSchedule).filter((item): item is ScheduleEntry => Boolean(item)), [scheduleSource.records]);
  const [date, setDate] = useState(localDate());
  const [view, setView] = useState<"day" | "week">("day");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ShiftDefinition | null>(null);
  const [name, setName] = useState("");
  const [start, setStart] = useState("07:00");
  const [end, setEnd] = useState("12:00");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function begin(shift?: ShiftDefinition) {
    if (inactive) return setMessage("Cửa hàng đã ngưng hoạt động. Bạn chỉ có thể xem dữ liệu lịch sử.");
    setEditing(shift ?? null);
    setName(shift?.name ?? `Ca ${shifts.length + 1}`);
    setStart(shift?.start ?? "07:00");
    setEnd(shift?.end ?? "12:00");
    setMessage("");
    setOpen(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inactive) return setMessage("Không thể lưu ca làm việc cho cửa hàng đã ngưng hoạt động.");
    const duration = shiftDurationMinutes(start, end);
    if (!name.trim() || !validClock(start) || !validClock(end) || !duration) return setMessage("Vui lòng nhập tên ca và khung giờ hợp lệ; giờ bắt đầu phải khác giờ kết thúc.");
    if (shifts.some((shift) => shift.id !== editing?.id && shift.name.trim().toLocaleLowerCase("vi-VN") === name.trim().toLocaleLowerCase("vi-VN"))) return setMessage("Tên ca đã tồn tại trong cửa hàng.");
    setSaving(true);
    try {
      await saveRecord({
        id: editing?.persisted ? editing.id : undefined,
        category: "CA_LAM_VIEC",
        storeId: store.id,
        title: name.trim(),
        data: { start, end, durationMinutes: duration, overnight: isOvernightShift(start, end) },
      });
      await shiftsSource.reload();
      setOpen(false);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Không thể lưu ca làm việc");
    } finally {
      setSaving(false);
    }
  }

  async function remove(shift: ShiftDefinition) {
    if (inactive) return setMessage("Không thể xóa ca làm việc của cửa hàng đã ngưng hoạt động.");
    if (!shift.persisted) return;
    if (schedules.some((entry) => entry.shiftId === shift.id || entry.shiftName === shift.name)) return setMessage("Không thể xóa ca đã được sử dụng trong lịch phân ca.");
    if (!window.confirm(`Xóa ${shift.name}?`)) return;
    try { await removeRecord(shift.id); await shiftsSource.reload(); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Không thể xóa ca"); }
  }

  const assignedToday = new Set(schedules.filter((entry) => entry.date === date).flatMap((entry) => entry.employeeIds)).size;
  return <section className={styles.shell} aria-label="Quản lý ca làm việc">
    <header className={styles.toolbar}>
      <div><h2>Ca làm việc</h2><p>Quản lý khung giờ và theo dõi lịch làm của nhân viên</p></div>
      <div className={styles.toolbarActions}>
        <label className={styles.dateControl}><CalendarDays size={17}/><input type="date" value={date} onChange={(event) => setDate(event.target.value)}/></label>
        <button type="button" className={styles.secondaryButton} onClick={() => exportCsv("ca-lam-viec.csv", [["Tên ca", "Bắt đầu", "Kết thúc", "Thời lượng", "Qua đêm"], ...shifts.map((shift) => [shift.name, shift.start, shift.end, formatShiftDuration(shift.duration), shift.overnight ? "Có" : "Không"])])}><Download size={17}/> Xuất Excel</button>
        <button type="button" className={styles.primaryButton} disabled={inactive} onClick={() => begin()}><Plus size={18}/> Tạo ca làm việc</button>
      </div>
    </header>
    {inactive && <div className={styles.inactiveBanner}><b>Cửa hàng đã ngưng hoạt động</b><span>Ca làm việc và lịch sử vẫn được hiển thị, nhưng mọi thao tác tạo, sửa hoặc xóa đã bị khóa.</span></div>}
    <ShiftCards shifts={shifts} schedules={schedules} date={date} onEdit={inactive ? undefined : begin} onRemove={inactive ? undefined : remove}/>
    <div className={styles.summaryStrip}><span><Clock3 size={21}/><b>{shifts.length}</b> Tổng ca</span><span><UsersRound size={21}/><b>{employees.length}</b> Nhân viên</span><span><CalendarRange size={21}/><b>{assignedToday}</b> Đã xếp ngày này</span><span><b>{shifts.filter((shift) => shift.overnight).length}</b> Ca qua đêm</span></div>
    <section className={styles.panel}>
      <div className={styles.panelHeader}><div className={styles.tabs}><button type="button" className={view === "day" ? styles.activeTab : ""} onClick={() => setView("day")}>Lịch theo ngày</button><button type="button" className={view === "week" ? styles.activeTab : ""} onClick={() => setView("week")}>Lịch theo tuần</button></div><div className={styles.dateNav}><button type="button" onClick={() => setDate(addDays(date, view === "day" ? -1 : -7))}><ChevronLeft size={18}/></button><b>{view === "day" ? dateLabel(date) : `${shortDate(weekDates(date)[0])} - ${shortDate(weekDates(date)[6])}`}</b><button type="button" onClick={() => setDate(addDays(date, view === "day" ? 1 : 7))}><ChevronRight size={18}/></button></div></div>
      {view === "day" ? <DayGrid employees={employees} shifts={shifts} schedules={schedules} date={date}/> : <WeekGrid employees={employees} schedules={schedules} anchor={date}/>} 
      {(shiftsSource.loading || scheduleSource.loading) && <p className={styles.loading}>Đang tải dữ liệu...</p>}
      {(shiftsSource.error || scheduleSource.error || message) && <p className={styles.error}>{message || shiftsSource.error || scheduleSource.error}</p>}
    </section>
    {open && <div className={styles.backdrop}><form className={styles.modal} onSubmit={save}>
      <div className={styles.modalHeader}><div><h3>{editing ? "Sửa ca làm việc" : "Tạo ca làm việc"}</h3><p>Ca kết thúc sớm hơn giờ bắt đầu sẽ được ghi nhận là ca qua đêm.</p></div><button type="button" onClick={() => setOpen(false)}><X size={20}/></button></div>
      <label>Tên ca *<input required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ví dụ: Ca 1"/></label>
      <div className={styles.twoColumns}><label>Thời gian bắt đầu *<input required type="time" value={start} onChange={(event) => setStart(event.target.value)}/></label><label>Thời gian kết thúc *<input required type="time" value={end} onChange={(event) => setEnd(event.target.value)}/></label></div>
      <div className={styles.durationPreview}><Clock3 size={20}/><span>Thời lượng ca<strong>{formatShiftDuration(shiftDurationMinutes(start, end))}</strong></span>{isOvernightShift(start, end) && <em>Qua đêm</em>}</div>
      {message && <p className={styles.error}>{message}</p>}
      <div className={styles.modalActions}><button type="button" className={styles.secondaryButton} onClick={() => setOpen(false)}>Hủy</button><button className={styles.primaryButton} disabled={saving || inactive}>{saving ? "Đang lưu..." : "Lưu ca làm việc"}</button></div>
    </form></div>}
  </section>;
}

export function StoreScheduleManagement({ store }: { store: SchedulingStore }) {
  const inactive = store.status === "INACTIVE";
  const shiftSource = useRecords("CA_LAM_VIEC", store.id);
  const scheduleSource = useRecords("LICH_PHAN_CA", store.id);
  const employeeSource = useEmployees(store.id);
  const shifts = useMemo(() => {
    const persisted = shiftSource.records.map(toShift).filter((item): item is ShiftDefinition => Boolean(item));
    return mergeDefaultShifts(persisted);
  }, [shiftSource.records]);
  const schedules = useMemo(() => scheduleSource.records.map(toSchedule).filter((item): item is ScheduleEntry => Boolean(item)), [scheduleSource.records]);
  const employees = employeeSource.employees;
  const [date, setDate] = useState(localDate());
  const [view, setView] = useState<"day" | "week" | "employee">("day");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const [shiftId, setShiftId] = useState("");
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedShift = shifts.find((shift) => shift.id === shiftId) ?? shifts[0];
  const visibleEmployees = employees.filter((employee) => `${employee.code} ${employee.name} ${employee.position}`.toLocaleLowerCase("vi-VN").includes(search.toLocaleLowerCase("vi-VN")));

  function begin(entry?: ScheduleEntry) {
    if (inactive) return setMessage("Cửa hàng đã ngưng hoạt động. Bạn chỉ có thể xem dữ liệu lịch sử.");
    setEditing(entry ?? null);
    setDate(entry?.date ?? date);
    setShiftId(entry?.shiftId || shifts.find((shift) => shift.name === entry?.shiftName)?.id || shifts[0]?.id || "");
    setSelectedEmployees(entry?.employeeIds ?? []);
    setNote(entry?.note ?? "");
    setSearch("");
    setMessage("");
    setStep(1);
    setOpen(true);
  }

  function continueToEmployees() {
    if (inactive) return setMessage("Không thể tạo lịch cho cửa hàng đã ngưng hoạt động.");
    if (!selectedShift) return setMessage("Vui lòng tạo và chọn một ca làm việc trước.");
    setMessage("");
    setStep(2);
  }

  function toggleEmployee(id: string) {
    setSelectedEmployees((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inactive) return setMessage("Không thể lưu lịch phân ca cho cửa hàng đã ngưng hoạt động.");
    if (!selectedShift || selectedEmployees.length === 0) return setMessage("Vui lòng chọn ít nhất một nhân viên.");
    const utcRange = shiftUtcRange(date, selectedShift.start, selectedShift.end);
    if (!utcRange) return setMessage("Ngày áp dụng hoặc thời gian ca không hợp lệ.");
    const conflicts = employees.filter((employee) => selectedEmployees.includes(employee.id) && schedules.some((entry) =>
      entry.id !== editing?.id && entry.employeeIds.includes(employee.id) && shiftsOverlap(date, selectedShift.start, selectedShift.end, entry.date, entry.start, entry.end),
    ));
    if (conflicts.length) return setMessage(`Trùng lịch làm việc: ${conflicts.map((employee) => employee.name).join(", ")}.`);
    setSaving(true);
    try {
      const names = employees.filter((employee) => selectedEmployees.includes(employee.id)).map((employee) => employee.name);
      await saveRecord({
        id: editing?.id,
        category: "LICH_PHAN_CA",
        storeId: store.id,
        title: `${selectedShift.name} · ${date}`,
        data: {
          date,
          shiftId: selectedShift.id,
          shiftName: selectedShift.name,
          start: selectedShift.start,
          end: selectedShift.end,
          startAt: utcRange.startAt,
          endAt: utcRange.endAt,
          overnight: selectedShift.overnight,
          employeeIds: selectedEmployees,
          employeeNames: names,
          note: note.trim(),
        },
      });
      await scheduleSource.reload();
      setOpen(false);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Không thể lưu lịch phân ca");
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: ScheduleEntry) {
    if (inactive) return setMessage("Không thể xóa lịch phân ca của cửa hàng đã ngưng hoạt động.");
    if (!window.confirm(`Xóa lịch ${entry.shiftName} ngày ${shortDate(entry.date)}?`)) return;
    try { await removeRecord(entry.id); await scheduleSource.reload(); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Không thể xóa lịch"); }
  }

  const week = weekDates(date);
  const daySchedules = schedules.filter((entry) => entry.date === date);
  return <section className={styles.shell} aria-label="Quản lý lịch phân ca">
    <header className={styles.toolbar}>
      <div><h2>Lịch phân ca</h2><p>Tạo và quản lý lịch phân công ca làm việc cho nhân viên</p></div>
      <div className={styles.toolbarActions}><label className={styles.dateControl}><CalendarDays size={17}/><input type="date" value={date} onChange={(event) => setDate(event.target.value)}/></label><button type="button" className={styles.secondaryButton} onClick={() => exportCsv("lich-phan-ca.csv", [["Ngày", "Ca", "Thời gian", "Nhân viên", "Ghi chú"], ...schedules.map((entry) => [entry.date, entry.shiftName, `${entry.start} - ${entry.end}`, entry.employeeNames.join("; "), entry.note])])}><Download size={17}/> Xuất Excel</button><button type="button" className={styles.primaryButton} disabled={inactive} onClick={() => begin()}><Plus size={18}/> Tạo lịch phân ca</button></div>
    </header>
    {inactive && <div className={styles.inactiveBanner}><b>Cửa hàng đã ngưng hoạt động</b><span>Lịch sử vẫn được xem và xuất báo cáo; tạo, sửa hoặc xóa lịch phân ca đã bị khóa.</span></div>}
    <ShiftCards shifts={shifts} schedules={schedules} date={date}/>
    <div className={styles.summaryStrip}><span><CalendarRange size={21}/><b>{daySchedules.length}</b> Lịch trong ngày</span><span><UsersRound size={21}/><b>{new Set(daySchedules.flatMap((entry) => entry.employeeIds)).size}</b> Nhân viên đã xếp</span><span><Clock3 size={21}/><b>{shifts.length}</b> Ca hoạt động</span><span><b>{employees.length - new Set(daySchedules.flatMap((entry) => entry.employeeIds)).size}</b> Chưa phân ca</span></div>
    <section className={styles.panel}>
      <div className={styles.panelHeader}><div className={styles.tabs}><button type="button" className={view === "day" ? styles.activeTab : ""} onClick={() => setView("day")}>Theo ngày</button><button type="button" className={view === "week" ? styles.activeTab : ""} onClick={() => setView("week")}>Theo tuần</button><button type="button" className={view === "employee" ? styles.activeTab : ""} onClick={() => setView("employee")}>Theo nhân viên</button></div><div className={styles.dateNav}><button type="button" onClick={() => setDate(addDays(date, view === "day" ? -1 : -7))}><ChevronLeft size={18}/></button><b>{view === "day" ? dateLabel(date) : `${shortDate(week[0])} - ${shortDate(week[6])}`}</b><button type="button" onClick={() => setDate(addDays(date, view === "day" ? 1 : 7))}><ChevronRight size={18}/></button></div></div>
      {view === "day" && <DayGrid employees={employees} shifts={shifts} schedules={schedules} date={date} onEdit={inactive ? undefined : begin}/>} 
      {view === "week" && <WeekGrid employees={employees} schedules={schedules} anchor={date} onEdit={inactive ? undefined : begin}/>} 
      {view === "employee" && <div className={styles.employeeScheduleList}>{employees.map((employee) => {
        const entries = schedules.filter((entry) => week.includes(entry.date) && entry.employeeIds.includes(employee.id)).sort((a, b) => a.date.localeCompare(b.date));
        return <article key={employee.id}><EmployeeName employee={employee}/><div>{entries.length ? entries.map((entry) => <button type="button" disabled={inactive} key={entry.id} onClick={() => begin(entry)}><b>{shortDate(entry.date)} · {entry.shiftName}</b><small>{entry.start} - {entry.end}{entry.overnight ? " · Qua đêm" : ""}</small></button>) : <span>Chưa có lịch trong tuần</span>}</div></article>;
      })}</div>}
    </section>
    <section className={styles.historyPanel}><div className={styles.historyTitle}><div><h3>Lịch đã tạo ngày {shortDate(date)}</h3><p>{inactive ? "Cửa hàng ngưng hoạt động: chỉ xem lịch sử." : "Chọn một lịch để sửa danh sách nhân viên hoặc ghi chú."}</p></div><button type="button" className={styles.secondaryButton} onClick={() => setDate(localDate())}>Hôm nay</button></div>{daySchedules.length ? <div className={styles.scheduleHistory}>{daySchedules.map((entry) => <article key={entry.id}><i><Clock3 size={19}/></i><span><b>{entry.shiftName} · {entry.start} - {entry.end}</b><small>{entry.employeeNames.join(", ") || `${entry.employeeIds.length} nhân viên`}{entry.note ? ` · ${entry.note}` : ""}</small></span><div><button type="button" disabled={inactive} aria-label="Sửa lịch" onClick={() => begin(entry)}><Edit3 size={16}/></button><button type="button" disabled={inactive} aria-label="Xóa lịch" onClick={() => remove(entry)}><Trash2 size={16}/></button></div></article>)}</div> : <p className={styles.empty}>Chưa tạo lịch phân ca cho ngày này.</p>}</section>
    {(shiftSource.error || scheduleSource.error || message) && !open && <p className={styles.error}>{message || shiftSource.error || scheduleSource.error}</p>}
    {open && <div className={styles.backdrop}><form className={`${styles.modal} ${styles.scheduleModal}`} onSubmit={save}>
      <div className={styles.modalHeader}><div><h3>{editing ? "Sửa lịch phân ca" : "Tạo lịch phân ca"}</h3><p>Chọn ca trước, sau đó chọn các nhân viên áp dụng.</p></div><button type="button" onClick={() => setOpen(false)}><X size={20}/></button></div>
      <div className={styles.steps}><span className={step === 1 ? styles.currentStep : styles.completedStep}><b>1</b> Chọn ca</span><i/><span className={step === 2 ? styles.currentStep : ""}><b>2</b> Chọn nhân viên</span></div>
      {step === 1 ? <div className={styles.stepBody}>
        <label>Ngày áp dụng *<input type="date" required value={date} onChange={(event) => setDate(event.target.value)}/></label>
        <fieldset className={styles.shiftPicker}><legend>Chọn ca làm việc *</legend>{shifts.map((shift, index) => <label className={shiftId === shift.id ? styles.selectedShift : ""} key={shift.id}><input type="radio" name="shift" checked={shiftId === shift.id} onChange={() => setShiftId(shift.id)}/><i className={styles[`dot${index % 3 + 1}`]}/><span><b>{shift.name}</b><small>{shift.start} - {shift.end} · {formatShiftDuration(shift.duration)}{shift.overnight ? " · Qua đêm" : ""}</small></span><Check size={17}/></label>)}</fieldset>
        <label>Ghi chú <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Nhập ghi chú cho lịch phân ca..." maxLength={300}/></label>
        {message && <p className={styles.error}>{message}</p>}
        <div className={styles.modalActions}><button type="button" className={styles.secondaryButton} onClick={() => setOpen(false)}>Hủy</button><button type="button" className={styles.primaryButton} onClick={continueToEmployees}>Tiếp tục chọn nhân viên <ChevronRight size={17}/></button></div>
      </div> : <div className={styles.stepBody}>
        <div className={styles.selectedSummary}><Clock3 size={19}/><span><b>{selectedShift?.name}</b><small>{dateLabel(date)} · {selectedShift?.start} - {selectedShift?.end}</small></span></div>
        <label className={styles.employeeSearch}><Search size={17}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm mã, tên hoặc vị trí nhân viên..."/></label>
        <div className={styles.selectionTools}><b>Chọn nhân viên ({selectedEmployees.length}/{employees.length})</b><button type="button" onClick={() => setSelectedEmployees(selectedEmployees.length === employees.length ? [] : employees.map((employee) => employee.id))}>{selectedEmployees.length === employees.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}</button></div>
        <fieldset className={styles.employeePicker}>{employeeSource.loading ? <p>Đang tải nhân viên...</p> : visibleEmployees.map((employee) => <label key={employee.id}><input type="checkbox" checked={selectedEmployees.includes(employee.id)} onChange={() => toggleEmployee(employee.id)}/><EmployeeName employee={employee}/><Check size={17}/></label>)}</fieldset>
        {message && <p className={styles.error}>{message}</p>}
        <div className={styles.modalActions}><button type="button" className={styles.secondaryButton} onClick={() => setStep(1)}><ChevronLeft size={17}/> Quay lại</button><button className={styles.primaryButton} disabled={saving || inactive || !selectedEmployees.length}>{saving ? "Đang lưu..." : editing ? "Cập nhật lịch" : "Lưu lịch ca"}</button></div>
      </div>}
    </form></div>}
  </section>;
}
