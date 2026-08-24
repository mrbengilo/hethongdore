"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  Calendar,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  Clock3,
  RefreshCw,
  WalletCards,
} from "lucide-react";
import { formatDateTime24, formatTime24, formatVndDisplay } from "../lib/format";
import { DEFAULT_ATTENDANCE_GRACE_MINUTES } from "../lib/attendance-policy";
import type { StoreCashflowMode } from "../lib/store-cashflow";
import { DatePickerControl } from "./DatePickerControl";
import styles from "./StoreCashflow.module.css";

type CashflowStore = {
  id: string;
  name: string;
  status?: string;
};

type CompletedShift = {
  id: string;
  shiftCode: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  workDate: string;
  startedAt: string;
  endedAt: string;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  cashRevenue: number;
  transferRevenue: number;
  revenue: number;
  expenseAmount: number;
  expenseNote: string | null;
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | "UNKNOWN";
  attendanceDeltaMinutes: number;
};

type RevenueBreakdownItem = {
  revenue: number;
  completedShiftCount: number;
};

type AttendanceEmployee = {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  early: number;
  onTime: number;
  late: number;
  unknown: number;
  total: number;
  averageDeltaMinutes: number;
};

type StoreCashflowResponse = {
  store: { id: string; name: string; status: string };
  filter: {
    mode: StoreCashflowMode;
    anchor: string;
    from: string;
    to: string;
    timeZone: string;
  };
  totals: {
    cashRevenue: number;
    transferRevenue: number;
    revenue: number;
    expenseAmount: number;
    net: number;
    completedShiftCount: number;
  };
  accountingTotals: {
    revenue: number;
    expense: number;
    profit: number;
    expenseBreakdown: Record<string, number>;
  };
  revenueBreakdowns: {
    daily: Array<RevenueBreakdownItem & { date: string }>;
    monthly: Array<RevenueBreakdownItem & { period: string }>;
    employees: Array<RevenueBreakdownItem & { employeeId: string; employeeCode: string | null; employeeName: string | null }>;
    shifts: Array<RevenueBreakdownItem & { shiftName: string; scheduledStart: string | null; scheduledEnd: string | null }>;
  };
  attendance: {
    period: string;
    timeZone: string;
    rule: { early: string; onTime: string; late: string };
    policy: {
      lateGraceMinutes: number;
      version: number;
      updatedAt: string;
      appliesTo: "NEW_CLOCK_INS_ONLY";
    };
    totals: { early: number; onTime: number; late: number; unknown: number; total: number };
    employees: AttendanceEmployee[];
  };
  shifts: CompletedShift[];
  recognitionPolicy: {
    revenue: string;
    expense: string;
    accountingDate: string;
  };
};

type FilterState = {
  mode: StoreCashflowMode;
  day: string;
  month: string;
};

const timeZone = "Asia/Ho_Chi_Minh";
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const localPeriodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function todayInVietnam() {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

function dayForPeriod(period: string) {
  const today = todayInVietnam();
  return today.startsWith(`${period}-`) ? today : `${period}-01`;
}

function storageKey(storeId: string) {
  return `dore-store-cashflow-filter:${storeId}`;
}

function defaultFilter(period: string): FilterState {
  return { mode: "month", day: `${period}-01`, month: period };
}

function restoredFilter(storeId: string, period: string): FilterState {
  const fallback = defaultFilter(period);
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(storeId)) ?? "null") as Partial<FilterState> | null;
    if (!parsed || !["day", "week", "month"].includes(String(parsed.mode))) return fallback;
    if (!localDatePattern.test(String(parsed.day)) || !localPeriodPattern.test(String(parsed.month))) return fallback;
    return { mode: parsed.mode as StoreCashflowMode, day: String(parsed.day), month: String(parsed.month) };
  } catch {
    return fallback;
  }
}

function localDateLabel(value: string, options: Intl.DateTimeFormatOptions = {}) {
  if (!localDatePattern.test(value)) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...options,
  }).format(new Date(`${value}T12:00:00+07:00`));
}

function rangeLabel(data: StoreCashflowResponse) {
  if (data.filter.mode === "day") return `Ngày ${localDateLabel(data.filter.from)}`;
  if (data.filter.mode === "week") {
    return `Tuần ${localDateLabel(data.filter.from)} – ${localDateLabel(data.filter.to)}`;
  }
  const [year, month] = data.filter.from.split("-");
  return `Tháng ${Number(month)}/${year}`;
}

function scheduledTime(shift: CompletedShift) {
  if (shift.scheduledStart && shift.scheduledEnd) return `${shift.scheduledStart} – ${shift.scheduledEnd}`;
  if (shift.scheduledStartAt && shift.scheduledEndAt) {
    return `${formatTime24(shift.scheduledStartAt)} – ${formatTime24(shift.scheduledEndAt)}`;
  }
  return "Khung giờ chưa lưu";
}

function attendanceLabel(status: CompletedShift["attendanceStatus"], delta: number) {
  if (status === "EARLY") return `Sớm ${Math.abs(delta)} phút`;
  if (status === "LATE") return `Trễ ${Math.abs(delta)} phút`;
  if (status === "ON_TIME") return delta > 0 ? `Đúng giờ · +${delta} phút` : "Đúng giờ";
  return "Chưa đủ dữ liệu giờ ca";
}

function averageDeltaLabel(value: number) {
  if (!Number.isFinite(value) || value === 0) return "Đúng mốc bắt đầu";
  return value < 0 ? `Trước giờ TB ${Math.abs(value)} phút` : `Sau giờ TB +${value} phút`;
}

function RevenueProgressPanel({ title, note, items }: {
  title: string;
  note: string;
  items: Array<{ key: string; label: string; detail: string; revenue: number }>;
}) {
  const maximum = Math.max(0, ...items.map((item) => item.revenue));
  return <section className={styles.panel}>
    <header className={styles.panelHeader}><div><h3>{title}</h3><p>{note}</p></div><span>{items.length} mục</span></header>
    {items.length ? <div className={styles.progressList}>{items.map((item) => <div className={styles.progressRow} key={item.key}>
      <label>{item.label}<small>{item.detail}</small></label>
      <div className={styles.track} aria-hidden="true"><i style={{ width: `${maximum ? Math.max(3, item.revenue / maximum * 100) : 0}%` }}/></div>
      <strong>{formatVndDisplay(item.revenue)}</strong>
    </div>)}</div> : <div className={styles.empty}>Chưa có ca hoàn tất trong phạm vi này.</div>}
  </section>;
}

function CashflowMetric({ icon: Icon, label, value, note, tone = "green" }: {
  icon: typeof WalletCards;
  label: string;
  value: string;
  note: string;
  tone?: "green" | "orange" | "blue" | "teal";
}) {
  return <article className={`store-cashflow-metric ${tone}`}>
    <i><Icon size={22}/></i>
    <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
  </article>;
}

export function StoreShiftCashflow({ store, period, onPeriodChange, refreshVersion = 0 }: {
  store: CashflowStore;
  period: string;
  onPeriodChange: (period: string) => void;
  refreshVersion?: number;
}) {
  const [filter, setFilter] = useState<FilterState>(() => defaultFilter(period));
  const [filterReady, setFilterReady] = useState(false);
  const [data, setData] = useState<StoreCashflowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const lastPeriod = useRef(period);
  const requestSequence = useRef(0);
  const anchor = filter.mode === "month" ? filter.month : filter.day;

  useEffect(() => {
    const restored = restoredFilter(store.id, lastPeriod.current);
    setFilter(restored);
    if (restored.month !== lastPeriod.current) {
      lastPeriod.current = restored.month;
      onPeriodChange(restored.month);
    }
    setFilterReady(true);
  }, [onPeriodChange, store.id]);

  useEffect(() => {
    if (!filterReady) return;
    window.localStorage.setItem(storageKey(store.id), JSON.stringify(filter));
  }, [filter, filterReady, store.id]);

  useEffect(() => {
    if (!filterReady || period === lastPeriod.current) return;
    lastPeriod.current = period;
    setFilter((current) => {
      if (current.month === period && current.day.slice(0, 7) === period) return current;
      return { ...current, month: period, day: dayForPeriod(period) };
    });
  }, [filterReady, period]);

  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);

  useEffect(() => {
    if (!filterReady) return;
    const requestedScope = { storeId: store.id, mode: filter.mode, anchor };
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    const query = new URLSearchParams(requestedScope);
    setLoading(true);
    setError("");
    setData(null);
    fetch(`/api/store-cashflow?${query.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as StoreCashflowResponse & { message?: string };
        if (!response.ok) throw new Error(payload.message || "Không thể tải dòng tiền theo ca.");
        if (
          payload.store.id !== requestedScope.storeId
          || payload.filter.mode !== requestedScope.mode
          || payload.filter.anchor !== requestedScope.anchor
        ) {
          throw new Error("Dữ liệu dòng tiền phản hồi không đúng bộ lọc đã chọn.");
        }
        if (requestId !== requestSequence.current || controller.signal.aborted) return;
        setData(payload);
      })
      .catch((cause: unknown) => {
        if (requestId !== requestSequence.current || controller.signal.aborted) return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "Không thể tải dòng tiền theo ca.");
      })
      .finally(() => {
        if (requestId === requestSequence.current && !controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [anchor, filter.mode, filterReady, refreshVersion, reloadVersion, store.id]);

  const modes = useMemo(() => [
    { value: "day" as const, label: "Theo ngày", icon: CalendarDays },
    { value: "week" as const, label: "Theo tuần", icon: CalendarRange },
    { value: "month" as const, label: "Theo tháng", icon: Calendar },
  ], []);

  function chooseMode(mode: StoreCashflowMode) {
    setData(null);
    setError("");
    setFilter((current) => ({ ...current, mode }));
  }

  function updateDay(value: string) {
    if (!localDatePattern.test(value)) return;
    setData(null);
    setError("");
    setFilter((current) => ({ ...current, day: value, month: value.slice(0, 7) }));
    onPeriodChange(value.slice(0, 7));
  }

  function updateMonth(value: string) {
    if (!localPeriodPattern.test(value)) return;
    setData(null);
    setError("");
    setFilter((current) => ({ ...current, month: value, day: dayForPeriod(value) }));
    onPeriodChange(value);
  }

  const totals = data?.totals ?? {
    cashRevenue: 0,
    transferRevenue: 0,
    revenue: 0,
    expenseAmount: 0,
    net: 0,
    completedShiftCount: 0,
  };

  return <section className="store-cashflow" aria-busy={loading}>
    <header className="store-cashflow-header">
      <div><span className="store-cashflow-eyebrow">DỮ LIỆU CA ĐÃ HOÀN TẤT</span><h2>Dòng tiền theo ca</h2><p>Doanh thu kết ca và chi phí trong ca lấy trực tiếp từ dữ liệu vận hành của {store.name}.</p></div>
      <div className="store-cashflow-actions">
        <div className="store-cashflow-modes" role="group" aria-label="Chọn cách xem dòng tiền">
          {modes.map(({ value, label, icon: Icon }) => <button key={value} type="button" aria-pressed={filter.mode === value} className={filter.mode === value ? "active" : ""} onClick={() => chooseMode(value)}><Icon size={17}/>{label}</button>)}
        </div>
        <DatePickerControl
          className="store-cashflow-period-control"
          ariaLabel={filter.mode === "month" ? "Tháng dòng tiền" : filter.mode === "week" ? "Ngày thuộc tuần dòng tiền" : "Ngày dòng tiền"}
          hint={filter.mode === "day" ? "Chọn ngày" : filter.mode === "week" ? "Chọn một ngày trong tuần" : "Chọn tháng"}
          type={filter.mode === "month" ? "month" : "date"}
          value={anchor}
          onChange={(value) => filter.mode === "month" ? updateMonth(value) : updateDay(value)}
        />
        <button type="button" className="store-cashflow-refresh" onClick={reload} disabled={loading}><RefreshCw size={17}/>{loading ? "Đang tải…" : "Làm mới"}</button>
      </div>
    </header>

    {error ? <div className="form-message" role="alert">{error}</div> : null}
    <div className="store-cashflow-metrics">
      <CashflowMetric icon={WalletCards} label="Doanh thu kết ca" value={formatVndDisplay(totals.revenue)} note={`Tiền mặt ${formatVndDisplay(totals.cashRevenue)} · Chuyển khoản ${formatVndDisplay(totals.transferRevenue)}`}/>
      <CashflowMetric icon={ArrowDownLeft} label="Chi phí trong ca" value={formatVndDisplay(totals.expenseAmount)} note="Cộng một lần cho mỗi ca hoàn tất" tone="orange"/>
      <CashflowMetric icon={WalletCards} label="Dòng tiền thuần theo ca" value={formatVndDisplay(totals.net)} note="Doanh thu kết ca trừ chi phí trong ca" tone="blue"/>
      <CashflowMetric icon={Clock3} label="Ca đã hoàn tất" value={`${totals.completedShiftCount} ca`} note={data ? rangeLabel(data) : "Đang đồng bộ phạm vi"} tone="teal"/>
    </div>

    <div className="store-cashflow-policy"><CheckCircle2 size={18}/><p><b>Nguyên tắc ghi nhận:</b> mỗi bản ghi ca chỉ xuất hiện một lần trong bảng và chi phí trong ca chỉ được cộng từ <code>expense_amount</code> của chính ca đó. {data ? <>Tổng chi phí kế toán cùng phạm vi là <b>{formatVndDisplay(data.accountingTotals.expense)}</b>; trong đó <b>{formatVndDisplay(totals.expenseAmount)}</b> chi phí ca đã được đưa vào nhóm chi phí phát sinh và không cộng lại lần hai.</> : null}</p></div>

    <div className={styles.analysisGrid}>
      <RevenueProgressPanel title="Doanh thu theo ngày" note={data ? rangeLabel(data) : "Phạm vi đang tải"} items={(data?.revenueBreakdowns.daily ?? []).map((item) => ({ key: item.date, label: localDateLabel(item.date, { weekday: "short" }), detail: `${item.completedShiftCount} ca hoàn tất`, revenue: item.revenue }))}/>
      <RevenueProgressPanel title="Doanh thu theo tháng" note={`So sánh các tháng trong năm ${data?.attendance.period.slice(0, 4) ?? period.slice(0, 4)}`} items={(data?.revenueBreakdowns.monthly ?? []).map((item) => { const [year, month] = item.period.split("-"); return { key: item.period, label: `Tháng ${Number(month)}/${year}`, detail: `${item.completedShiftCount} ca hoàn tất`, revenue: item.revenue }; })}/>
      <RevenueProgressPanel title="Doanh thu theo nhân viên" note={data ? rangeLabel(data) : "Phạm vi đang tải"} items={(data?.revenueBreakdowns.employees ?? []).map((item) => ({ key: item.employeeId, label: item.employeeName || "Nhân viên không còn hoạt động", detail: `${item.employeeCode || item.employeeId} · ${item.completedShiftCount} ca`, revenue: item.revenue }))}/>
      <RevenueProgressPanel title="Doanh thu theo ca" note="Cộng độc lập theo tên và khung giờ ca" items={(data?.revenueBreakdowns.shifts ?? []).map((item) => ({ key: `${item.shiftName}-${item.scheduledStart}-${item.scheduledEnd}`, label: item.shiftName, detail: `${item.scheduledStart && item.scheduledEnd ? `${item.scheduledStart}–${item.scheduledEnd}` : "Chưa lưu khung giờ"} · ${item.completedShiftCount} lượt`, revenue: item.revenue }))}/>
    </div>

    <section className={`${styles.panel} ${styles.attendance}`}>
      <header className={styles.panelHeader}><div><h3>Điểm danh đúng giờ, sớm và trễ theo nhân viên</h3><p>Thống kê tháng {data?.attendance.period ?? period}: sớm trước giờ ca; đúng giờ đến đúng {data?.attendance.policy.lateGraceMinutes ?? DEFAULT_ATTENDANCE_GRACE_MINUTES} phút sau giờ bắt đầu; trễ khi vượt mốc này. Ngưỡng hiện tại áp dụng cho lượt điểm danh mới, lịch sử giữ theo ngưỡng đã lưu của từng ca.</p></div><span>{data?.attendance.totals.total ?? 0} lượt</span></header>
      <div className={styles.attendanceMetrics}>
        <article className={`${styles.attendanceMetric} ${styles.attendanceMetricEarly}`}><span>Điểm danh sớm</span><strong>{data?.attendance.totals.early ?? 0}</strong></article>
        <article className={`${styles.attendanceMetric} ${styles.attendanceMetricOnTime}`}><span>Điểm danh đúng giờ</span><strong>{data?.attendance.totals.onTime ?? 0}</strong></article>
        <article className={`${styles.attendanceMetric} ${styles.attendanceMetricLate}`}><span>Điểm danh trễ</span><strong>{data?.attendance.totals.late ?? 0}</strong></article>
        <article className={styles.attendanceMetric}><span>Dữ liệu cũ chưa đủ giờ ca</span><strong>{data?.attendance.totals.unknown ?? 0}</strong></article>
      </div>
      <div className={styles.attendanceTableWrap}><table className={styles.attendanceTable}>
        <caption className="sr-only">Thống kê trạng thái điểm danh theo nhân viên trong tháng</caption>
        <thead><tr><th>Nhân viên</th><th>Tổng lượt</th><th>Sớm</th><th>Đúng giờ</th><th>Trễ</th><th>Chưa đủ dữ liệu</th><th>Chênh lệch trung bình</th></tr></thead>
        <tbody>{data?.attendance.employees.length ? data.attendance.employees.map((employee) => <tr key={employee.employeeId}>
          <td data-label="Nhân viên"><b>{employee.employeeName || "Nhân viên không còn hoạt động"}</b><small>{employee.employeeCode || employee.employeeId}</small></td>
          <td data-label="Tổng lượt"><span className={styles.count}>{employee.total}</span></td>
          <td data-label="Sớm"><span className={`${styles.count} ${styles.early}`}>{employee.early}</span></td>
          <td data-label="Đúng giờ"><span className={`${styles.count} ${styles.onTime}`}>{employee.onTime}</span></td>
          <td data-label="Trễ"><span className={`${styles.count} ${styles.late}`}>{employee.late}</span></td>
          <td data-label="Chưa đủ dữ liệu">{employee.unknown}</td>
          <td data-label="Chênh lệch TB"><b>{averageDeltaLabel(employee.averageDeltaMinutes)}</b></td>
        </tr>) : <tr><td colSpan={7} className={styles.empty}>Chưa có lượt điểm danh trong tháng này.</td></tr>}</tbody>
      </table></div>
    </section>

    <section className="store-cashflow-shifts">
      <div className="store-cashflow-panel-heading"><div><h3>Chi tiết ca hoàn tất</h3><p>{data ? rangeLabel(data) : "Đang tải phạm vi đã chọn"} · Giờ hiển thị theo Việt Nam</p></div><span>{totals.completedShiftCount} ca</span></div>
      <div className="store-cashflow-table-wrap">
        <table className="store-cashflow-table">
          <caption className="sr-only">Danh sách ca hoàn tất và dòng tiền tương ứng</caption>
          <thead><tr><th>Ngày / ca làm</th><th>Doanh thu kết ca</th><th>Chi phí trong ca</th><th>Nhân viên kết ca</th><th>Giờ kết ca</th></tr></thead>
          <tbody>
            {loading && !data ? <tr className="store-cashflow-empty"><td colSpan={5}>Đang tải dữ liệu ca hoàn tất…</td></tr> : data?.shifts.length ? data.shifts.map((shift) => <tr key={shift.id}>
              <td data-label="Ngày / ca làm"><b>{shift.shiftName || shift.shiftCode}</b><small>{scheduledTime(shift)}</small><em>{localDateLabel(shift.workDate, { weekday: "short" })}</em></td>
              <td data-label="Doanh thu kết ca" className="store-cashflow-revenue"><b>{formatVndDisplay(shift.revenue)}</b><small>TM {formatVndDisplay(shift.cashRevenue)} · CK {formatVndDisplay(shift.transferRevenue)}</small></td>
              <td data-label="Chi phí trong ca" className="store-cashflow-expense"><b>{formatVndDisplay(shift.expenseAmount)}</b><small>{shift.expenseNote || "Không có ghi chú chi phí"}</small></td>
              <td data-label="Nhân viên kết ca"><b>{shift.employeeName || "Nhân viên không còn hoạt động"}</b><small>{shift.employeeCode || shift.employeeId}</small><em className={`${styles.shiftAttendance} ${shift.attendanceStatus === "LATE" ? styles.shiftAttendanceLate : shift.attendanceStatus === "ON_TIME" ? styles.shiftAttendanceOnTime : shift.attendanceStatus === "EARLY" ? styles.shiftAttendanceEarly : styles.shiftAttendanceUnknown}`}>{attendanceLabel(shift.attendanceStatus, shift.attendanceDeltaMinutes)}</em></td>
              <td data-label="Giờ kết ca"><b>{formatDateTime24(shift.endedAt, true)}</b><small>Đã hoàn tất</small></td>
            </tr>) : <tr className="store-cashflow-empty"><td colSpan={5}>Chưa có ca hoàn tất trong phạm vi đã chọn.</td></tr>}
          </tbody>
          {data?.shifts.length ? <tfoot><tr><td>Tổng cộng · {totals.completedShiftCount} ca</td><td>{formatVndDisplay(totals.revenue)}</td><td>{formatVndDisplay(totals.expenseAmount)}</td><td colSpan={2}>Dòng tiền thuần: {formatVndDisplay(totals.net)}</td></tr></tfoot> : null}
        </table>
      </div>
    </section>
  </section>;
}
