"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays, CalendarRange, Check, ChevronLeft, ChevronRight, Clock3,
  Download, Edit3, Plus, Search, Trash2, UsersRound, X,
} from "lucide-react";
import {
  addDays, compareShiftDefinitions, formatShiftDuration, isOvernightShift, localDate,
  shiftDurationMinutes, shiftNumber, shiftsOverlap, shiftUtcRange, validClock, weekDates,
} from "../lib/scheduling";
import { requestIsCurrent } from "../lib/request-guard";
import { useAccessibleModal } from "./useAccessibleModal";
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
  sourceId?: string;
  record?: BusinessRecord;
  name: string;
  start: string;
  end: string;
  duration: number;
  overnight: boolean;
  persisted: boolean;
  templateKey?: string;
  sortOrder?: number;
  workDate?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  snapshot?: boolean;
};

type DailyShiftRecord = {
  id: string;
  storeId: string;
  workDate: string;
  name: string;
  start: string;
  end: string;
  version: number;
  createdAt: string;
  updatedAt: string;
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
  { id: "default-1", templateKey: "default-1", sortOrder: 1, name: "Ca 1", start: "07:00", end: "12:00", duration: 300, overnight: false, persisted: false },
  { id: "default-2", templateKey: "default-2", sortOrder: 2, name: "Ca 2", start: "12:00", end: "17:00", duration: 300, overnight: false, persisted: false },
  { id: "default-3", templateKey: "default-3", sortOrder: 3, name: "Ca 3", start: "17:00", end: "23:00", duration: 360, overnight: false, persisted: false },
];

function mergeDefaultShifts(persisted: ShiftDefinition[]) {
  const claimedTemplates = new Set(persisted.flatMap((shift) => shift.templateKey ? [shift.templateKey] : []));
  const claimedLegacyNames = new Set(persisted.map((shift) => shift.name.trim().toLocaleLowerCase("vi-VN")));
  return [
    ...persisted,
    ...defaultShifts.filter((shift) => !claimedTemplates.has(shift.templateKey ?? "")
      && !claimedLegacyNames.has(shift.name.toLocaleLowerCase("vi-VN"))),
  ].sort(compareShiftDefinitions);
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

function updatedAtLabel(value?: string) {
  if (!value) return "Chưa ghi nhận thời gian";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Chưa ghi nhận thời gian";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
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
  const matchingDefault = defaultShifts.find((shift) => shift.name.toLocaleLowerCase("vi-VN") === record.title.trim().toLocaleLowerCase("vi-VN"));
  const rawSortOrder = Number(record.data.sortOrder);
  return {
    id: record.id,
    record,
    name: record.title,
    start,
    end,
    duration,
    overnight: isOvernightShift(start, end),
    persisted: true,
    templateKey: safeString(record.data.templateKey, matchingDefault?.templateKey),
    sortOrder: Number.isInteger(rawSortOrder) && rawSortOrder > 0
      ? rawSortOrder
      : shiftNumber(record.title) ?? undefined,
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

function toDailyShift(row: DailyShiftRecord): ShiftDefinition | null {
  if (!validClock(row.start) || !validClock(row.end)) return null;
  const duration = shiftDurationMinutes(row.start, row.end);
  if (!duration) return null;
  return {
    id: row.id,
    name: row.name,
    start: row.start,
    end: row.end,
    duration,
    overnight: isOvernightShift(row.start, row.end),
    persisted: true,
    workDate: row.workDate,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sortOrder: shiftNumber(row.name) ?? undefined,
  };
}

function useRecords(category: "CA_LAM_VIEC" | "LICH_PHAN_CA", storeId: string) {
  const [records, setRecords] = useState<BusinessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const requestId = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ category, storeId });
      const response = await fetch(`/api/records?${query}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Không thể tải dữ liệu");
      if (!requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) return;
      setRecords(result.records ?? []);
      setError("");
    } catch (reason) {
      if (!requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) return;
      setError(reason instanceof Error ? reason.message : "Không thể tải dữ liệu");
    } finally {
      if (requestController.current === controller) requestController.current = null;
      if (requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) setLoading(false);
    }
  }, [category, storeId]);
  useEffect(() => {
    setRecords([]);
    void reload();
    return () => requestController.current?.abort();
  }, [reload]);
  return { records, loading, error, reload };
}

function useEmployees(storeId: string) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const requestId = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    try {
      const response = await fetch(`/api/employees?storeId=${encodeURIComponent(storeId)}&includeSupport=1`, { signal: controller.signal });
      const result = await response.json();
      if (!requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) return;
      setEmployees(response.ok ? result.employees ?? [] : []);
    } catch {
      if (!requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) return;
      setEmployees([]);
    } finally {
      if (requestController.current === controller) requestController.current = null;
      if (requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) setLoading(false);
    }
  }, [storeId]);
  useEffect(() => {
    setEmployees([]);
    void reload();
    return () => requestController.current?.abort();
  }, [reload]);
  return { employees, loading, reload };
}

function useDailyShifts(storeId: string, date: string) {
  const [records, setRecords] = useState<DailyShiftRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const requestId = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ storeId, date });
      const response = await fetch(`/api/daily-shifts?${query}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Không thể tải ca làm việc theo ngày");
      if (!requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) return;
      setRecords(Array.isArray(result.shifts) ? result.shifts : []);
      setError("");
    } catch (reason) {
      if (!requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) return;
      setError(reason instanceof Error ? reason.message : "Không thể tải ca làm việc theo ngày");
    } finally {
      if (requestController.current === controller) requestController.current = null;
      if (requestIsCurrent(requestId, requestSequence.current, controller.signal.aborted)) setLoading(false);
    }
  }, [date, storeId]);
  useEffect(() => {
    setRecords([]);
    void reload();
    return () => requestController.current?.abort();
  }, [reload]);
  return { records, loading, error, reload };
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

async function saveScheduleBatch(input: {
  storeId: string;
  clientRequestId: string;
  date: string;
  employeeIds: string[];
  note: string;
  entries: Array<{ shiftId: string; shiftName: string; start: string; end: string }>;
}) {
  const response = await fetch("/api/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "CREATE_SCHEDULE_BATCH",
      category: "LICH_PHAN_CA",
      storeId: input.storeId,
      data: {
        clientRequestId: input.clientRequestId,
        date: input.date,
        employeeIds: input.employeeIds,
        note: input.note,
        entries: input.entries,
      },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Không thể lưu toàn bộ lịch phân ca");
  return result;
}

async function removeRecord(id: string) {
  const response = await fetch(`/api/records?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Không thể xóa dữ liệu");
}

async function saveDailyShift(input: {
  id?: string;
  storeId: string;
  workDate: string;
  name: string;
  start: string;
  end: string;
  version?: number;
  clientRequestId?: string;
}) {
  const response = await fetch("/api/daily-shifts", {
    method: input.id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Không thể lưu ca làm việc");
  return result;
}

async function removeDailyShift(shift: ShiftDefinition) {
  const query = new URLSearchParams({ id: shift.id, version: String(shift.version ?? 0) });
  const response = await fetch(`/api/daily-shifts?${query}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Không thể xóa ca làm việc");
  return result;
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
    <span><b title={employee.name}>{employee.name}</b><small>{employee.code} · {employee.position}</small></span>
  </div>;
}

function scheduleMatchesShift(entry: ScheduleEntry, shift: ShiftDefinition) {
  return entry.shiftName === shift.name && entry.start === shift.start && entry.end === shift.end;
}

function ShiftCards({ shifts, schedules, date, onEdit, onRemove }: {
  shifts: ShiftDefinition[];
  schedules: ScheduleEntry[];
  date: string;
  onEdit?: (shift: ShiftDefinition) => void;
  onRemove?: (shift: ShiftDefinition) => void;
}) {
  return <div className={`${styles.shiftCards} ${shifts.length > 3 ? styles.compactShiftCards : ""}`}>
    {shifts.map((shift, index) => {
      const people = new Set(schedules.filter((entry) => entry.date === date && scheduleMatchesShift(entry, shift)).flatMap((entry) => entry.employeeIds)).size;
      return <article className={`${styles.shiftCard} ${styles[`tone${index % 3 + 1}`]}`} key={shift.id}>
        <i><Clock3 size={25}/></i>
        <div><span>{shift.name}</span><strong>{shift.start} - {shift.end}</strong><small>{formatShiftDuration(shift.duration)}{shift.overnight ? " · Qua đêm" : ""} · {people} nhân viên</small>{(shift.updatedAt || shift.record) && <small className={styles.updatedAt}>Cập nhật: {updatedAtLabel(shift.updatedAt ?? shift.record?.updated_at ?? shift.record?.created_at)}</small>}</div>
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
        const assigned = schedules.find((entry) => entry.date === date && entry.employeeIds.includes(employee.id) && scheduleMatchesShift(entry, shift));
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
    const nextNumber = Math.max(0, ...shifts.map((item) => shiftNumber(item.name) ?? 0)) + 1;
    setName(shift?.name ?? `Ca ${nextNumber}`);
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
        data: {
          start,
          end,
          durationMinutes: duration,
          overnight: isOvernightShift(start, end),
          templateKey: editing?.templateKey,
          sortOrder: editing?.templateKey ? editing.sortOrder : shiftNumber(name.trim()) ?? undefined,
        },
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
  const [date, setDate] = useState(localDate());
  const dailyShiftSource = useDailyShifts(store.id, date);
  const scheduleSource = useRecords("LICH_PHAN_CA", store.id);
  const employeeSource = useEmployees(store.id);
  const shifts = useMemo(() => dailyShiftSource.records
    .map(toDailyShift)
    .filter((item): item is ShiftDefinition => Boolean(item))
    .sort(compareShiftDefinitions), [dailyShiftSource.records]);
  const schedules = useMemo(() => scheduleSource.records.map(toSchedule).filter((item): item is ScheduleEntry => Boolean(item)), [scheduleSource.records]);
  const employees = employeeSource.employees;
  const [view, setView] = useState<"day" | "week" | "employee">("day");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const [shiftIds, setShiftIds] = useState<string[]>([]);
  const [batchRequestId, setBatchRequestId] = useState("");
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [editingShift, setEditingShift] = useState<ShiftDefinition | null>(null);
  const [shiftName, setShiftName] = useState("");
  const [shiftStart, setShiftStart] = useState("07:00");
  const [shiftEnd, setShiftEnd] = useState("12:00");
  const [shiftRequestId, setShiftRequestId] = useState("");
  const [shiftSaving, setShiftSaving] = useState(false);
  const shiftBackdropRef = useRef<HTMLDivElement | null>(null);
  const shiftDialogRef = useRef<HTMLFormElement | null>(null);
  const shiftInitialFocusRef = useRef<HTMLInputElement | null>(null);
  const shiftReturnFocusRef = useRef<HTMLElement | null>(null);
  const scheduleBackdropRef = useRef<HTMLDivElement | null>(null);
  const scheduleDialogRef = useRef<HTMLFormElement | null>(null);
  const scheduleInitialFocusRef = useRef<HTMLInputElement | null>(null);
  const scheduleReturnFocusRef = useRef<HTMLElement | null>(null);

  useAccessibleModal({
    open: shiftOpen,
    rootRef: shiftBackdropRef,
    dialogRef: shiftDialogRef,
    initialFocusRef: shiftInitialFocusRef,
    returnFocusRef: shiftReturnFocusRef,
    dismissDisabled: shiftSaving,
    onDismiss: () => setShiftOpen(false),
  });
  useAccessibleModal({
    open,
    rootRef: scheduleBackdropRef,
    dialogRef: scheduleDialogRef,
    initialFocusRef: scheduleInitialFocusRef,
    returnFocusRef: scheduleReturnFocusRef,
    dismissDisabled: saving,
    onDismiss: () => setOpen(false),
  });

  const scheduleSnapshotShift = useMemo<ShiftDefinition | null>(() => {
    if (!editing || editing.date !== date) return null;
    return {
      id: `schedule-snapshot:${editing.id}`,
      sourceId: editing.shiftId,
      name: editing.shiftName,
      start: editing.start,
      end: editing.end,
      duration: shiftDurationMinutes(editing.start, editing.end),
      overnight: editing.overnight,
      persisted: false,
      workDate: editing.date,
      snapshot: true,
    };
  }, [date, editing]);
  const selectableShifts = scheduleSnapshotShift ? [scheduleSnapshotShift, ...shifts] : shifts;
  const selectedShifts = selectableShifts.filter((shift) => shiftIds.includes(shift.id));
  const selectedShift = selectedShifts[0];
  const visibleEmployees = employees.filter((employee) => `${employee.code} ${employee.name} ${employee.position}`.toLocaleLowerCase("vi-VN").includes(search.toLocaleLowerCase("vi-VN")));

  function beginShift(shift?: ShiftDefinition) {
    if (inactive) return setMessage("Cửa hàng đã ngưng hoạt động. Bạn chỉ có thể xem dữ liệu lịch sử.");
    shiftReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingShift(shift ?? null);
    const nextNumber = Math.max(0, ...shifts.map((item) => shiftNumber(item.name) ?? 0)) + 1;
    setShiftName(shift?.name ?? `Ca ${nextNumber}`);
    setShiftStart(shift?.start ?? "07:00");
    setShiftEnd(shift?.end ?? "12:00");
    setShiftRequestId(shift ? "" : crypto.randomUUID());
    setMessage("");
    setShiftOpen(true);
  }

  async function saveShift(event: FormEvent) {
    event.preventDefault();
    if (inactive) return setMessage("Không thể lưu ca làm việc cho cửa hàng đã ngưng hoạt động.");
    const duration = shiftDurationMinutes(shiftStart, shiftEnd);
    if (!shiftName.trim() || !validClock(shiftStart) || !validClock(shiftEnd) || !duration) {
      return setMessage("Vui lòng nhập tên ca và khung giờ hợp lệ; giờ bắt đầu phải khác giờ kết thúc.");
    }
    if (shifts.some((shift) => shift.id !== editingShift?.id
      && shift.name.trim().toLocaleLowerCase("vi-VN") === shiftName.trim().toLocaleLowerCase("vi-VN")
      && shift.start === shiftStart && shift.end === shiftEnd)) {
      return setMessage("Ca cùng tên và khung giờ đã tồn tại trong ngày này.");
    }
    setShiftSaving(true);
    try {
      const requestId = shiftRequestId || crypto.randomUUID();
      if (!shiftRequestId && !editingShift) setShiftRequestId(requestId);
      await saveDailyShift({
        id: editingShift?.id,
        storeId: store.id,
        workDate: date,
        name: shiftName.trim(),
        start: shiftStart,
        end: shiftEnd,
        version: editingShift?.version,
        clientRequestId: editingShift ? undefined : requestId,
      });
      await dailyShiftSource.reload();
      setShiftOpen(false);
      setMessage("");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Không thể lưu ca làm việc");
    } finally {
      setShiftSaving(false);
    }
  }

  async function removeShift(shift: ShiftDefinition) {
    if (inactive) return setMessage("Không thể xóa ca làm việc của cửa hàng đã ngưng hoạt động.");
    if (!window.confirm(`Xóa ${shift.name} ngày ${shortDate(date)}? Lịch đã phân và ca đã phát sinh vẫn được giữ nguyên.`)) return;
    try {
      await removeDailyShift(shift);
      await dailyShiftSource.reload();
      setMessage("Đã xóa ca làm việc; lịch đã phân và lịch sử chấm công vẫn giữ nguyên.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Không thể xóa ca làm việc");
    }
  }

  function begin(entry?: ScheduleEntry) {
    if (inactive) return setMessage("Cửa hàng đã ngưng hoạt động. Bạn chỉ có thể xem dữ liệu lịch sử.");
    scheduleReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(entry ?? null);
    setDate(entry?.date ?? date);
    const initialShiftId = entry ? `schedule-snapshot:${entry.id}` : "";
    setShiftIds(initialShiftId ? [initialShiftId] : []);
    setBatchRequestId(entry ? safeString(entry.record.data.clientRequestId) : crypto.randomUUID());
    setSelectedEmployees(entry?.employeeIds ?? []);
    setNote(entry?.note ?? "");
    setSearch("");
    setMessage("");
    setOpen(true);
  }

  function toggleEmployee(id: string) {
    if (!editing) setBatchRequestId(crypto.randomUUID());
    setSelectedEmployees((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function toggleShift(id: string) {
    if (editing) return setShiftIds([id]);
    setBatchRequestId(crypto.randomUUID());
    setShiftIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function changeDraftDate(value: string) {
    if (!editing) setBatchRequestId(crypto.randomUUID());
    if (value !== date) setShiftIds([]);
    setDate(value);
  }

  function toggleAllEmployees() {
    if (!editing) setBatchRequestId(crypto.randomUUID());
    setSelectedEmployees(selectedEmployees.length === employees.length ? [] : employees.map((employee) => employee.id));
  }

  function changeDraftNote(value: string) {
    if (!editing) setBatchRequestId(crypto.randomUUID());
    setNote(value);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inactive) return setMessage("Không thể lưu lịch phân ca cho cửa hàng đã ngưng hoạt động.");
    if (selectedShifts.length === 0 || selectedEmployees.length === 0) return setMessage("Vui lòng chọn ít nhất một ca và một nhân viên.");
    for (let first = 0; first < selectedShifts.length; first += 1) {
      for (let second = first + 1; second < selectedShifts.length; second += 1) {
        const left = selectedShifts[first];
        const right = selectedShifts[second];
        if (shiftsOverlap(date, left.start, left.end, date, right.start, right.end)) {
          return setMessage(`${left.name} và ${right.name} bị trùng thời gian. Vui lòng chỉ chọn một trong hai ca.`);
        }
      }
    }
    const conflicts = employees.filter((employee) => selectedEmployees.includes(employee.id) && selectedShifts.some((shift) => schedules.some((entry) =>
      entry.id !== editing?.id && entry.employeeIds.includes(employee.id) && shiftsOverlap(date, shift.start, shift.end, entry.date, entry.start, entry.end),
    )));
    if (conflicts.length) return setMessage(`Trùng lịch làm việc: ${conflicts.map((employee) => employee.name).join(", ")}.`);
    setSaving(true);
    try {
      if (editing) {
        const shift = selectedShift;
        const utcRange = shift && shiftUtcRange(date, shift.start, shift.end);
        if (!shift || !utcRange) throw new Error("Ngày áp dụng hoặc thời gian ca không hợp lệ.");
        await saveRecord({
          id: editing.id,
          category: "LICH_PHAN_CA",
          storeId: store.id,
          title: `${shift.name} · ${date}`,
          data: {
            date,
            shiftId: shift.sourceId ?? shift.id,
            shiftName: shift.name,
            start: shift.start,
            end: shift.end,
            startAt: utcRange.startAt,
            endAt: utcRange.endAt,
            overnight: shift.overnight,
            employeeIds: selectedEmployees,
            note: note.trim(),
          },
        });
      } else {
        const requestGroup = batchRequestId || crypto.randomUUID();
        if (!batchRequestId) setBatchRequestId(requestGroup);
        await saveScheduleBatch({
          storeId: store.id,
          clientRequestId: requestGroup,
          date,
          employeeIds: selectedEmployees,
          note: note.trim(),
          entries: selectedShifts.map((shift) => ({
            shiftId: shift.sourceId ?? shift.id,
            shiftName: shift.name,
            start: shift.start,
            end: shift.end,
          })),
        });
      }
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
      <div><h2>Lịch phân ca</h2><p>Tạo ca riêng cho từng ngày, sau đó phân nhiều ca cho nhiều nhân viên</p></div>
      <div className={styles.toolbarActions}>
        <label className={styles.dateControl}><CalendarDays size={17}/><input type="date" value={date} onChange={(event) => setDate(event.target.value)}/></label>
        <button type="button" className={styles.secondaryButton} onClick={() => exportCsv("lich-phan-ca.csv", [["Ngày", "Ca", "Thời gian", "Nhân viên", "Ghi chú"], ...schedules.map((entry) => [entry.date, entry.shiftName, `${entry.start} - ${entry.end}`, entry.employeeNames.join("; "), entry.note])])}><Download size={17}/> Xuất Excel</button>
        <button type="button" className={styles.secondaryButton} disabled={inactive} onClick={() => beginShift()}><Plus size={18}/> Tạo ca làm việc</button>
        <button type="button" className={styles.primaryButton} disabled={inactive || shifts.length === 0} onClick={() => begin()}><CalendarRange size={18}/> Tạo lịch phân ca</button>
      </div>
    </header>
    {inactive && <div className={styles.inactiveBanner}><b>Cửa hàng đã ngưng hoạt động</b><span>Lịch sử vẫn được xem và xuất báo cáo; tạo, sửa hoặc xóa lịch phân ca đã bị khóa.</span></div>}
    {shifts.length
      ? <ShiftCards shifts={shifts} schedules={schedules} date={date} onEdit={inactive ? undefined : beginShift} onRemove={inactive ? undefined : removeShift}/>
      : !dailyShiftSource.loading && <div className={styles.dailyShiftEmpty}><Clock3 size={22}/><span><b>Chưa có ca làm việc ngày {shortDate(date)}</b><small>Hãy tạo ca với tên và khung giờ dành riêng cho ngày này trước khi phân lịch.</small></span><button type="button" className={styles.secondaryButton} disabled={inactive} onClick={() => beginShift()}><Plus size={17}/> Tạo ca làm việc</button></div>}
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
    <section className={styles.historyPanel}><div className={styles.historyTitle}><div><h3>Lịch đã tạo ngày {shortDate(date)}</h3><p>{inactive ? "Cửa hàng ngưng hoạt động: chỉ xem lịch sử." : "Chọn một lịch để sửa danh sách nhân viên hoặc ghi chú."}</p></div><button type="button" className={styles.secondaryButton} onClick={() => setDate(localDate())}>Hôm nay</button></div>{daySchedules.length ? <div className={styles.scheduleHistory}>{daySchedules.map((entry) => <article key={entry.id}><i><Clock3 size={19}/></i><span><b>{entry.shiftName}</b><small className={styles.historyShiftTime}>{entry.start} - {entry.end}{entry.overnight ? " · Qua đêm" : ""}</small><small>{entry.employeeNames.join(", ") || `${entry.employeeIds.length} nhân viên`}{entry.note ? ` · ${entry.note}` : ""}</small><small className={styles.updatedAt}>Cập nhật: {updatedAtLabel(entry.record.updated_at ?? entry.record.created_at)}</small></span><div><button type="button" disabled={inactive} aria-label="Sửa lịch" onClick={() => begin(entry)}><Edit3 size={16}/></button><button type="button" disabled={inactive} aria-label="Xóa lịch" onClick={() => remove(entry)}><Trash2 size={16}/></button></div></article>)}</div> : <p className={styles.empty}>Chưa tạo lịch phân ca cho ngày này.</p>}</section>
    {(dailyShiftSource.loading || scheduleSource.loading) && <p className={styles.loading}>Đang tải dữ liệu lịch và ca theo ngày...</p>}
    {(dailyShiftSource.error || scheduleSource.error || message) && !open && !shiftOpen && <p className={styles.error}>{message || dailyShiftSource.error || scheduleSource.error}</p>}
    {shiftOpen && <div className={styles.backdrop} ref={shiftBackdropRef}><form className={styles.modal} ref={shiftDialogRef} role="dialog" aria-modal="true" aria-labelledby="daily-shift-dialog-title" tabIndex={-1} onSubmit={saveShift}>
      <div className={styles.modalHeader}><div><h3 id="daily-shift-dialog-title">{editingShift ? "Sửa ca làm việc" : "Tạo ca làm việc"}</h3><p>Ca này chỉ áp dụng cho ngày {shortDate(date)}. Lịch của ngày khác không thay đổi.</p></div><button type="button" aria-label="Đóng biểu mẫu ca làm việc" disabled={shiftSaving} onClick={() => setShiftOpen(false)}><X size={20}/></button></div>
      <label>Ngày áp dụng<input type="date" value={date} disabled readOnly/></label>
      <label>Tên ca *<input ref={shiftInitialFocusRef} required maxLength={50} value={shiftName} onChange={(event) => setShiftName(event.target.value)} placeholder="Ví dụ: Ca sáng"/></label>
      <div className={styles.twoColumns}><label>Thời gian bắt đầu *<input required type="time" value={shiftStart} onChange={(event) => setShiftStart(event.target.value)}/></label><label>Thời gian kết thúc *<input required type="time" value={shiftEnd} onChange={(event) => setShiftEnd(event.target.value)}/></label></div>
      <div className={styles.durationPreview}><Clock3 size={20}/><span>Thời lượng ca<strong>{formatShiftDuration(shiftDurationMinutes(shiftStart, shiftEnd))}</strong></span>{isOvernightShift(shiftStart, shiftEnd) && <em>Qua đêm</em>}</div>
      {editingShift && <p className={styles.snapshotNotice}>Sửa ca không thay đổi tên hoặc thời gian trong các lịch đã phân, ca đang chạy và lịch sử trước đó.</p>}
      {message && <p className={styles.error}>{message}</p>}
      <div className={styles.modalActions}><button type="button" className={styles.secondaryButton} disabled={shiftSaving} onClick={() => setShiftOpen(false)}>Hủy</button><button className={styles.primaryButton} disabled={shiftSaving || inactive}>{shiftSaving ? "Đang lưu..." : editingShift ? "Cập nhật ca" : "Lưu ca làm việc"}</button></div>
    </form></div>}
    {open && <div className={styles.backdrop} ref={scheduleBackdropRef}><form className={`${styles.modal} ${styles.scheduleModal}`} ref={scheduleDialogRef} role="dialog" aria-modal="true" aria-labelledby="schedule-editor-dialog-title" tabIndex={-1} onSubmit={save}>
      <div className={styles.modalHeader}><div><h3 id="schedule-editor-dialog-title">{editing ? "Sửa lịch phân ca" : "Tạo lịch phân ca"}</h3><p>{editing ? "Cập nhật ca, nhân viên và ghi chú trên cùng một màn hình." : "Chọn một hoặc nhiều ca, nhân viên và ghi chú trên cùng một màn hình."}</p></div><button type="button" aria-label="Đóng biểu mẫu lịch phân ca" disabled={saving} onClick={() => setOpen(false)}><X size={20}/></button></div>
      <div className={styles.stepBody}>
        <label>Ngày áp dụng *<input ref={scheduleInitialFocusRef} type="date" required value={date} onChange={(event) => changeDraftDate(event.target.value)}/></label>
        <fieldset className={styles.shiftPicker}><legend>{editing ? "Chọn ca làm việc *" : `Chọn một hoặc nhiều ca * (${selectedShifts.length}/${shifts.length})`}</legend><div className={styles.scheduleShiftPicker}>{selectableShifts.length ? selectableShifts.map((shift, index) => <label className={shiftIds.includes(shift.id) ? styles.selectedShift : ""} key={shift.id}><input type={editing ? "radio" : "checkbox"} name={editing ? "shift" : undefined} checked={shiftIds.includes(shift.id)} onChange={() => toggleShift(shift.id)}/><i className={styles[`dot${index % 3 + 1}`]}/><span><b>{shift.name}{shift.snapshot ? " · Bản lưu của lịch" : ""}</b><small>{shift.start} - {shift.end}</small><small>{formatShiftDuration(shift.duration)}{shift.overnight ? " · Qua đêm" : ""}</small></span><Check size={17}/></label>) : <p className={styles.employeePickerMessage}>Ngày này chưa có ca làm việc. Hãy đóng biểu mẫu và tạo ca trước.</p>}</div></fieldset>
        <div className={styles.selectedSummary}><Clock3 size={19}/><span><b>{selectedShifts.length ? editing ? selectedShift?.name : `${selectedShifts.length} ca đã chọn` : "Chưa chọn ca"}</b><small>{dateLabel(date)}{selectedShifts.length ? ` · ${selectedShifts.map((shift) => `${shift.name} ${shift.start}-${shift.end}`).join("; ")}` : ""}</small></span></div>
        <label className={styles.employeeSearch}><Search size={17}/><input aria-label="Tìm nhân viên" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm mã, tên hoặc vị trí nhân viên..."/></label>
        <div className={styles.selectionTools}><b>Chọn nhân viên ({selectedEmployees.length}/{employees.length})</b><button type="button" onClick={toggleAllEmployees}>{selectedEmployees.length === employees.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}</button></div>
        <fieldset className={styles.employeePicker} aria-label="Danh sách nhân viên theo chiều dọc">{employeeSource.loading
          ? <p className={styles.employeePickerMessage}>Đang tải nhân viên...</p>
          : visibleEmployees.length
            ? visibleEmployees.map((employee) => <label key={employee.id}><input type="checkbox" checked={selectedEmployees.includes(employee.id)} onChange={() => toggleEmployee(employee.id)}/><EmployeeName employee={employee}/><Check size={17}/></label>)
            : <p className={styles.employeePickerMessage}>Không tìm thấy nhân viên phù hợp.</p>}</fieldset>
        <label>Ghi chú <textarea value={note} onChange={(event) => changeDraftNote(event.target.value)} placeholder="Nhập ghi chú cho lịch phân ca..." maxLength={300}/></label>
        {message && <p className={styles.error}>{message}</p>}
        <div className={styles.modalActions}><button type="button" className={styles.secondaryButton} disabled={saving} onClick={() => setOpen(false)}>Hủy</button><button className={styles.primaryButton} aria-label={editing ? "Cập nhật lịch phân ca" : "Lưu lịch phân ca"} disabled={saving || inactive || !selectedEmployees.length || !selectedShifts.length}>{saving ? "Đang lưu..." : editing ? "CẬP NHẬT" : "LƯU"}</button></div>
      </div>
    </form></div>}
  </section>;
}
