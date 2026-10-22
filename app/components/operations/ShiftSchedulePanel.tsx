"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import ShiftSwapPanel from "./ShiftSwapPanel";
import { Notice, Panel } from "./shared";

export type ScheduleEmployee = { id: string; code: string; name: string };
export type Assignment = {
  id: string; store_id: string; employee_id: string; business_date: string;
  definition_id: string; shift_name: string; scheduled_start_at: string;
  scheduled_end_at: string; status: string; version: number;
};
type Definition = { id: string; name: string; start_time: string; end_time: string };
type ScheduleData = {
  stores: { id: string; name: string }[]; employees: ScheduleEmployee[];
  definitions: Definition[]; assignments: Assignment[]; date: string;
};
const timeFormat = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Ho_Chi_Minh" });
const localDay = (instant: string) => new Date(new Date(instant).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
export function assignmentLabel(row: Assignment) {
  const overnight = localDay(row.scheduled_end_at) !== localDay(row.scheduled_start_at);
  return `${row.shift_name} · ${timeFormat.format(new Date(row.scheduled_start_at))}–${timeFormat.format(new Date(row.scheduled_end_at))}${overnight ? " (+1 ngày)" : ""}`;
}

export default function ShiftSchedulePanel({ actorId, initialStoreId }: { actorId: string; initialStoreId?: string }) {
  const [storeId, setStoreId] = useState(initialStoreId ?? "");
  const [date, setDate] = useState(() => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10));
  const [tab, setTab] = useState<"schedule" | "swap">("schedule");
  const [data, setData] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestNumber = useRef(0);
  const contextKey = `${storeId}:${date}`;

  useEffect(() => {
    const current = ++requestNumber.current;
    const controller = new AbortController();
    setLoading(true); setMessage("");
    const params = new URLSearchParams({ date });
    if (storeId) params.set("storeId", storeId);
    fetch(`/api/shift-assignments?${params}`, { signal: controller.signal }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? (response.status === 403 ? "Bạn không có quyền xem lịch phân ca." : "Không thể tải lịch phân ca."));
      return result as ScheduleData;
    }).then((result) => {
      if (current !== requestNumber.current || controller.signal.aborted) return;
      setData(result);
      if (!storeId && result.stores.length) setStoreId(result.stores[0].id);
    }).catch((error: unknown) => {
      if (current !== requestNumber.current || controller.signal.aborted) return;
      setData(null); setMessage(error instanceof Error ? error.message : "Không thể kết nối để tải lịch.");
    }).finally(() => { if (current === requestNumber.current && !controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [storeId, date, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const applied = useCallback((rows: Assignment[]) => {
    // Show server-confirmed rows immediately, then reconcile the shared schedule.
    setData((previous) => previous ? { ...previous, assignments: previous.assignments.map((row) => rows.find((next) => next.id === row.id) ?? row) } : previous);
    reload();
  }, [reload]);
  const storeName = data?.stores.find((store) => store.id === storeId)?.name;
  const usable = data && !loading && data.date === date;

  function changeContext(nextStore: string, nextDate: string) {
    // Invalidate the old request before React runs the next effect.
    requestNumber.current += 1;
    setStoreId(nextStore); setDate(nextDate); setLoading(true); setMessage("");
  }

  return <div className="op-stack op-schedule">
    <Panel title="Lịch phân ca" action={<button className="op-secondary" onClick={reload} disabled={loading || pending}>Tải lại lịch</button>}>
      <div className="op-schedule-context">
        <label htmlFor="schedule-store">Cửa hàng<select id="schedule-store" value={storeId} onChange={(event) => changeContext(event.target.value, date)} disabled={pending || Boolean(initialStoreId)}><option value="">Chọn cửa hàng</option>{data?.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        <label htmlFor="schedule-date">Ngày phân ca<input id="schedule-date" type="date" value={date} onChange={(event) => { if (event.target.value) changeContext(storeId, event.target.value); }} disabled={pending} required /></label>
      </div>
      <p className="op-schedule-caption">{storeName ?? "Chọn cửa hàng được cấp quyền"} · Ngày nghiệp vụ theo giờ Việt Nam (Asia/Ho_Chi_Minh).</p>
      <div className="op-schedule-tabs" role="group" aria-label="Chế độ lịch phân ca"><button type="button" className={tab === "schedule" ? "active" : ""} aria-pressed={tab === "schedule"} onClick={() => setTab("schedule")} disabled={pending}>Lịch phân ca</button><button type="button" className={tab === "swap" ? "active" : ""} aria-pressed={tab === "swap"} onClick={() => setTab("swap")} disabled={pending}>Đổi ca</button></div>
      {loading && <p role="status">Đang tải lịch phân ca…</p>}
      {message && <div role="alert"><Notice kind="warning">{message}</Notice></div>}
      {usable && !data.stores.length && <Notice kind="warning">Bạn chưa được cấp cửa hàng để quản lý lịch phân ca.</Notice>}
      {data && storeId && tab === "schedule" && <div hidden={!usable}><ScheduleEditor key={contextKey} storeId={storeId} date={date} data={data} onChanged={reload} onPending={setPending} /></div>}
      {data && storeId && tab === "swap" && <div hidden={!usable}><ShiftSwapPanel actorId={actorId} key={contextKey} storeId={storeId} date={date} employees={data.employees} assignments={data.assignments} onChanged={applied} onPending={setPending} /></div>}
    </Panel>
  </div>;
}

function ScheduleEditor({ storeId, date, data, onChanged, onPending }: {
  storeId: string; date: string; data: ScheduleData; onChanged: () => void; onPending: (value: boolean) => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [shiftName, setShiftName] = useState("");
  const [startTime, setStartTime] = useState("07:00");
  const [endTime, setEndTime] = useState("12:00");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const locked = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const planned = data.assignments.filter((row) => row.status !== "CANCELLED");
  useEffect(() => { if (message) feedback.current?.focus(); }, [message, data]);

  async function write(path: string, method: string, body: unknown, successMessage: string) {
    if (locked.current) return;
    locked.current = true; setBusy(true); onPending(true); setMessage(""); setSuccess(false);
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Không thể lưu lịch phân ca.");
      setSuccess(true); setMessage(successMessage); onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Mất kết nối. Tải lại lịch để kiểm tra kết quả trước khi thử lại."); }
    finally { locked.current = false; setBusy(false); onPending(false); window.setTimeout(() => feedback.current?.focus(), 0); }
  }

  function createAssignment(event: FormEvent) {
    event.preventDefault();
    void write("/api/shift-assignments", "POST", { storeId, date, employeeId, definitionId }, "Đã thêm phân công.");
  }
  function createDefinition(event: FormEvent) {
    event.preventDefault();
    void write("/api/shift-definitions", "POST", { storeId, name: shiftName, startTime, endTime }, "Đã tạo định nghĩa ca.");
  }

  return <div className="op-stack">
    <Notice>Lịch dự kiến được lưu riêng với chấm công thực tế. Thay đổi lịch không sửa giờ vào/ra, đơn hàng hoặc dữ liệu lương đã phát sinh.</Notice>
    <div ref={feedback} tabIndex={-1} role="status" aria-live="polite" className="op-schedule-feedback">{message && <Notice kind={success ? "success" : "warning"}>{message}</Notice>}</div>
    <form onSubmit={createAssignment} className="op-form" aria-label="Thêm phân công"><h3>Thêm phân công cho ngày đã chọn</h3><fieldset className="op-schedule-fieldset" disabled={busy}><div className="op-form-grid three"><label htmlFor="schedule-employee">Nhân viên<select id="schedule-employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required><option value="">Chọn nhân viên</option>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.code} · {employee.name}</option>)}</select></label><label htmlFor="schedule-definition">Ca làm việc<select id="schedule-definition" value={definitionId} onChange={(event) => setDefinitionId(event.target.value)} required><option value="">Chọn ca</option>{data.definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.name} · {definition.start_time}–{definition.end_time}{definition.end_time < definition.start_time ? " (+1 ngày)" : ""}</option>)}</select></label><button className="op-primary op-schedule-align-end" type="submit" disabled={!employeeId || !definitionId}>{busy ? "Đang lưu…" : "Thêm phân công"}</button></div></fieldset></form>
    {!data.employees.length && <p>Chưa có nhân viên hợp lệ tại cửa hàng. Cần quản trị viên cập nhật hồ sơ nhân viên.</p>}
    {/* The overflow region needs a keyboard stop so users can scroll the full schedule. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    {!planned.length ? <p role="status">Ngày này chưa có phân công. Tạo ca làm việc và thêm phân công để sử dụng Đổi ca.</p> : <div className="op-table-wrap" tabIndex={0} role="region" aria-label="Bảng lịch phân ca"><table><thead><tr><th>Nhân viên</th><th>Ca dự kiến</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{planned.map((row) => { const employee = data.employees.find((item) => item.id === row.employee_id); return <tr key={row.id}><td>{employee ? `${employee.code} · ${employee.name}` : row.employee_id}</td><td>{assignmentLabel(row)}</td><td>{row.status === "PLANNED" ? "Dự kiến" : row.status === "STARTED" ? "Đã vào ca" : row.status}</td><td><button type="button" className="op-danger-link" disabled={busy || row.status !== "PLANNED"} onClick={() => void write("/api/shift-assignments", "DELETE", { storeId, assignmentId: row.id, expectedVersion: row.version }, "Đã hủy phân công.")} aria-label={`Hủy phân công ${employee?.name ?? row.employee_id} ${row.shift_name}`}>Hủy phân công</button></td></tr>; })}</tbody></table></div>}
    <details className="op-schedule-definitions"><summary>Quản lý định nghĩa ca ({data.definitions.length})</summary><p>Giờ kết thúc sớm hơn giờ bắt đầu là ca qua đêm, kết thúc vào ngày kế tiếp.</p><form className="op-form" onSubmit={createDefinition} aria-label="Tạo định nghĩa ca"><fieldset className="op-schedule-fieldset" disabled={busy}><div className="op-form-grid three"><label htmlFor="definition-name">Tên ca<input id="definition-name" value={shiftName} onChange={(event) => setShiftName(event.target.value)} maxLength={80} required /></label><label htmlFor="definition-start">Giờ bắt đầu<input id="definition-start" type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required /></label><label htmlFor="definition-end">Giờ kết thúc<input id="definition-end" type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} required /></label></div><button className="op-secondary" type="submit" disabled={!shiftName.trim() || startTime === endTime}>Tạo ca làm việc</button></fieldset></form></details>
  </div>;
}
