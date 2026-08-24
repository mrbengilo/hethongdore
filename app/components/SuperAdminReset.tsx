"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { formatDateTime24, formatDateVn } from "../lib/format";
import { DatePickerControl } from "./DatePickerControl";
import { SuperAdminDataRecords } from "./SuperAdminDataRecords";
import { SuperAdminEmployees } from "./SuperAdminEmployees";
import { SuperAdminOrderHistory } from "./SuperAdminOrderHistory";
import styles from "./SuperAdminReset.module.css";

type Store = { id: string; name: string };
type Employee = { id: string; code: string; name: string; status: string };
type PreviewRow = {
  id: string;
  shiftCode: string;
  shiftName?: string | null;
  employeeId: string;
  status: string;
  amount?: number;
  paymentMethod?: string;
  createdAt?: string;
  workDate?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  attendanceStatus?: string | null;
  attendanceDeltaMinutes?: number | null;
  cashRevenue?: number;
  transferRevenue?: number;
  expenseAmount?: number;
};
type Preview = {
  store: Store;
  label: string;
  employees: Employee[];
  shifts: Array<{ code: string; name: string }>;
  summary: { count: number; amount?: number; hours?: number; revenue?: number; expense?: number };
  previewToken: string;
  rows: PreviewRow[];
  truncated: boolean;
};

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const currentPeriod = () => today().slice(0, 7);
const money = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đồng`;
const dateTime = (value?: string | null) => formatDateTime24(value);
const employeeStatusSuffix = (status: string) => status === "SUSPENDED"
  ? " · Tạm ngưng" : status === "TERMINATED" || status === "INACTIVE" ? " · Đã nghỉ việc" : "";
const attendanceLabel = (row: PreviewRow) => {
  const minutes = Math.abs(Number(row.attendanceDeltaMinutes ?? 0));
  if (row.attendanceStatus === "EARLY") return `Đi sớm ${minutes} phút`;
  if (row.attendanceStatus === "LATE") return `Đi trễ ${minutes} phút`;
  if (row.attendanceStatus === "ON_TIME") return "Đúng giờ";
  return row.status === "ACTIVE" ? "Đang làm" : "Đã kết ca";
};

export function SuperAdminReset({ store, onReset }: { store: Store; onReset?: () => void | Promise<void> }) {
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"ORDERS" | "ATTENDANCE">("ORDERS");
  const [range, setRange] = useState<"DAY" | "MONTH">("DAY");
  const [date, setDate] = useState(today);
  const [period, setPeriod] = useState(currentPeriod);
  const [employeeId, setEmployeeId] = useState("");
  const [shiftCode, setShiftCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shiftOptions, setShiftOptions] = useState<Array<{ code: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (confirming) confirmationRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ storeId: store.id, kind, range, mode: "options" });
    if (range === "DAY") params.set("date", date); else params.set("period", period);
    void fetch(`/api/admin/reset-data?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message ?? "Không thể tải bộ lọc dữ liệu.");
        const nextEmployees = Array.isArray(data.employees) ? data.employees as Employee[] : [];
        const nextShifts = Array.isArray(data.shifts) ? data.shifts as Array<{ code: string; name: string }> : [];
        setEmployees(nextEmployees);
        setShiftOptions(nextShifts);
        setEmployeeId((current) => current && !nextEmployees.some((employee) => employee.id === current) ? "" : current);
        setShiftCode((current) => current && !nextShifts.some((shift) => shift.code === current) ? "" : current);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setError(requestError instanceof Error ? requestError.message : "Không thể tải bộ lọc dữ liệu.");
      });
    return () => controller.abort();
  }, [date, kind, period, range, store.id]);

  function queryParams() {
    const params = new URLSearchParams({ storeId: store.id, kind, range });
    if (range === "DAY") params.set("date", date); else params.set("period", period);
    if (employeeId) params.set("employeeId", employeeId);
    if (shiftCode) params.set("shiftCode", shiftCode);
    return params;
  }

  async function loadPreview() {
    setLoading(true);
    setError("");
    setMessage("");
    setConfirming(false);
    try {
      const response = await fetch(`/api/admin/reset-data?${queryParams().toString()}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? "Không thể xem trước dữ liệu.");
      setPreview(data);
      setEmployees(data.employees ?? []);
      setShiftOptions(Array.isArray(data.shifts) ? data.shifts : []);
    } catch (requestError) {
      setPreview(null);
      setError(requestError instanceof Error ? requestError.message : "Không thể xem trước dữ liệu.");
    } finally {
      setLoading(false);
    }
  }

  async function resetData() {
    if (!preview) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const payload: Record<string, string> = {
        storeId: store.id,
        kind,
        range,
        previewToken: preview.previewToken,
        confirmation,
      };
      if (range === "DAY") payload.date = date; else payload.period = period;
      if (employeeId) payload.employeeId = employeeId;
      if (shiftCode) payload.shiftCode = shiftCode;
      const response = await fetch("/api/admin/reset-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? "Không thể reset dữ liệu.");
      setMessage(data.message ?? "Đã reset dữ liệu.");
      setConfirmation("");
      setConfirming(false);
      setPreview(null);
      await onReset?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Không thể reset dữ liệu.");
    } finally {
      setLoading(false);
    }
  }

  function changeFilter(action: () => void) {
    action();
    setPreview(null);
    setConfirming(false);
    setConfirmation("");
    setMessage("");
    setError("");
  }

  return <div className={styles.page}>
    <div className={styles.warning} role="note"><ShieldAlert size={24}/><div><b>Chỉ dành cho quản trị cấp cao</b><br/>Reset sẽ loại dữ liệu khỏi vận hành của riêng {store.name}. Hệ thống luôn xem trước, chặn kỳ đã khóa và lưu bản chụp/audit trước khi thực hiện.</div></div>
    <SuperAdminDataRecords store={store} onChanged={onReset}/>
    <SuperAdminOrderHistory store={store}/>
    <SuperAdminEmployees store={store} onChanged={onReset}/>
    <section className={styles.panel}>
      <header className={styles.panelHeader}><h2>Reset Dữ Liệu · {store.name}</h2><p>Chọn loại dữ liệu, thời gian, nhân viên hoặc mã ca. Không chọn nhân viên/ca nghĩa là áp dụng cho toàn bộ phạm vi thời gian.</p></header>
      <div className={styles.filters}>
        <label>Loại dữ liệu<select value={kind} onChange={(event) => changeFilter(() => setKind(event.target.value as "ORDERS" | "ATTENDANCE"))}><option value="ORDERS">Đơn hàng</option><option value="ATTENDANCE">Chấm công</option></select></label>
        <label>Khoảng thời gian<select value={range} onChange={(event) => changeFilter(() => setRange(event.target.value as "DAY" | "MONTH"))}><option value="DAY">Theo ngày</option><option value="MONTH">Theo tháng</option></select></label>
        {range === "DAY" ? <div className={styles.pickerField}><span>Ngày</span><DatePickerControl ariaLabel="Chọn ngày cần xem trước và reset" value={date} onChange={(value) => changeFilter(() => setDate(value))}/></div> : <div className={styles.pickerField}><span>Tháng</span><DatePickerControl ariaLabel="Chọn tháng cần xem trước và reset" type="month" value={period} onChange={(value) => changeFilter(() => setPeriod(value))}/></div>}
        <label>Nhân viên<select value={employeeId} onChange={(event) => changeFilter(() => setEmployeeId(event.target.value))}><option value="">Tất cả nhân viên</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.code} · {employee.name}{employeeStatusSuffix(employee.status)}</option>)}</select></label>
        <label>Ca làm việc<select value={shiftCode} onChange={(event) => changeFilter(() => setShiftCode(event.target.value))}><option value="">Tất cả ca</option>{shiftOptions.map((shift) => <option value={shift.code} key={shift.code}>{shift.name} · {shift.code}</option>)}</select></label>
      </div>
      <div className={styles.actions}><button type="button" className={styles.previewButton} disabled={loading} onClick={() => void loadPreview()}>{loading ? <RefreshCw size={17} className="spin"/> : <RefreshCw size={17}/>} Xem trước dữ liệu</button></div>
      {error ? <div className={`${styles.feedback} ${styles.error}`} role="alert">{error}</div> : null}
      {message ? <div className={styles.feedback} role="status">{message}</div> : null}
      {preview ? <>
        <div className={styles.summary}>
          <div><span>Số bản ghi phù hợp</span><strong>{preview.summary.count}</strong></div>
          {kind === "ORDERS" ? <div><span>Doanh thu sẽ điều chỉnh</span><strong>{money(preview.summary.amount ?? 0)}</strong></div> : <><div><span>Tổng giờ chấm công</span><strong>{(preview.summary.hours ?? 0).toFixed(2)} giờ</strong></div><div><span>Doanh thu/chi phí ca</span><strong>{money(preview.summary.revenue ?? 0)} / {money(preview.summary.expense ?? 0)}</strong></div></>}
        </div>
        {preview.rows.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Ca</th><th>Nhân viên</th><th>{kind === "ORDERS" ? "Giá trị" : "Giờ vào"}</th><th>{kind === "ORDERS" ? "Thời gian tạo" : "Giờ kết ca"}</th><th>Trạng thái</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.id}>
          <td><b>{row.shiftName ? `${row.shiftName} · ` : ""}{row.shiftCode}</b>{kind === "ATTENDANCE" && row.scheduledStart && row.scheduledEnd ? <small>{row.scheduledStart} – {row.scheduledEnd}</small> : row.workDate ? <small>{formatDateVn(row.workDate)}</small> : null}</td>
          <td>{employees.find((employee) => employee.id === row.employeeId)?.name ?? row.employeeId}</td>
          <td>{kind === "ORDERS" ? money(row.amount ?? 0) : dateTime(row.startedAt)}</td>
          <td>{kind === "ORDERS" ? dateTime(row.createdAt) : dateTime(row.endedAt)}</td>
          <td>{kind === "ATTENDANCE" ? <span className={`attendance-status ${row.attendanceStatus === "EARLY" ? "attendance-early" : row.attendanceStatus === "LATE" ? "attendance-late" : row.attendanceStatus === "ON_TIME" ? "attendance-on-time" : "attendance-unknown"}`}>{attendanceLabel(row)}</span> : row.status}</td>
        </tr>)}</tbody></table>{preview.truncated ? <p>Đang hiển thị 100 bản ghi đầu; toàn bộ số liệu phù hợp vẫn được tính trong tổng.</p> : null}</div> : <div className={styles.empty}>Không có dữ liệu phù hợp.</div>}
        {preview.summary.count > 0 ? confirming ? <div className={styles.confirmation}><p><AlertTriangle size={17}/> Nhập chính xác <strong>{store.name}</strong> để xác nhận reset {preview.label}.</p><div className={styles.confirmActions}><label>Tên cửa hàng<input ref={confirmationRef} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off"/></label><button type="button" className={styles.resetButton} disabled={loading || confirmation !== store.name} onClick={() => void resetData()}><Trash2 size={17}/> Reset dữ liệu</button></div></div> : <div className={styles.actions}><button type="button" className={styles.resetButton} onClick={() => setConfirming(true)}><Trash2 size={17}/> Reset dữ liệu đã xem trước</button></div> : null}
      </> : null}
    </section>
  </div>;
}
