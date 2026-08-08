"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeDollarSign, Banknote, CheckCircle2, Clock3, Download, Gift, Search, TrendingUp, WalletCards } from "lucide-react";

type ShiftRow = {
  id: string;
  shift_code: string;
  shiftName?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  workDate?: string | null;
  employeeCode?: string | null;
  employeeName?: string | null;
  appliedHourlyRate?: number | null;
  started_at: string;
  ended_at: string | null;
  tiktok_allowance: number;
  hourlyRate: number;
  status: string;
  duration_seconds?: number;
  expense_amount?: number;
  cash_revenue?: number;
  transfer_revenue?: number;
  transfer_id?: string | null;
  supportAllowance?: number | null;
  sourceStoreName?: string | null;
  targetStoreName?: string | null;
};

type Order = {
  id: string;
  code: string;
  amount: number;
  payment_method: "CASH" | "BANK_TRANSFER";
  status: string;
  created_at: string;
};

type EmployeePayrollItem = {
  employeeId: string;
  hours: number;
  baseSalary: number;
  tiktokAllowance: number;
  supportAllowance: number;
  manualAllowance: number;
  manualBonus: number;
  kpiBonus: number;
  totalPay: number;
};

type EmployeePayrollSource = EmployeePayrollItem & {
  storeId: string;
  storeName: string;
  isSupport: boolean;
  hourlyRate: number;
  paymentStatus: string;
  paidAt?: string | null;
};

type EmployeePayrollShiftDetail = {
  id: string;
  shiftCode: string;
  shiftName?: string | null;
  workDate?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  hours: number;
  hourlyRate: number;
  baseSalary: number;
  supportAllowance: number;
  tiktokAllowance: number;
  netPay: number;
  isSupport: boolean;
  storeId: string;
  storeName: string;
  sourceStoreName?: string | null;
};

const money = (value: number) => `${new Intl.NumberFormat("en-US").format(Math.round(value))} đồng`;
const localDay = (value: Date | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(typeof value === "string" ? new Date(value) : value);
const today = () => localDay(new Date());
const monthNow = () => today().slice(0, 7);
const time = (value: string) => new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }).format(new Date(value));
const workDay = (shift: ShiftRow) => shift.workDate || localDay(shift.started_at);
const displayDay = (value: string) => value.split("-").reverse().join("/");

function displayShiftName(shift: ShiftRow) {
  const storedName = shift.shiftName?.trim();
  if (storedName) return storedName;
  const legacy = shift.shift_code.trim().match(/^CA[\s_-]*([1-3])$/i);
  if (legacy) return `Ca ${legacy[1]}`;

  // Older sessions only stored an opaque CA-YYYY-MM-DD-* code. Infer their
  // display label from the captured/signed-in time so historical rows remain
  // useful after the shift identity migration.
  const sourceTime = shift.scheduledStart ?? time(shift.started_at);
  const hour = Number.parseInt(sourceTime.slice(0, 2), 10);
  if (Number.isFinite(hour)) {
    if (hour >= 7 && hour < 15) return "Ca 1";
    if (hour >= 15 && hour < 22) return "Ca 2";
    return "Ca 3";
  }

  return "Ca làm";
}

function shiftTone(shift: ShiftRow) {
  const match = displayShiftName(shift).match(/(?:^|\s)([1-3])$/);
  return match?.[1] ?? "1";
}

function csv(filename: string, rows: Array<Array<string | number | null>>) {
  const safe = (value: string | number | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function useShifts() {
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const reload = useCallback(async () => { const result = await (await fetch("/api/shifts")).json(); setShifts(result.shifts ?? []); }, []);
  useEffect(() => { reload(); }, [reload]);
  return { shifts, reload };
}

function shiftInfo(shift: ShiftRow) {
  const end = shift.ended_at ? new Date(shift.ended_at) : new Date();
  const hours = shift.duration_seconds && shift.duration_seconds > 0 ? shift.duration_seconds / 3_600 : Math.max(0, (end.getTime() - new Date(shift.started_at).getTime()) / 3_600_000);
  const hourlyRate = Number(shift.appliedHourlyRate ?? shift.hourlyRate ?? 0);
  const wage = Math.round(hours * hourlyRate);
  // Phụ cấp hỗ trợ được phân bổ chính xác bởi API payroll theo toàn bộ ca
  // của cùng đợt hỗ trợ, tránh cộng lặp toàn bộ phụ cấp vào từng ca.
  const supportAllowance = 0;
  return { ...shift, hourlyRate, hours, wage, supportAllowance, total: wage + shift.tiktok_allowance + supportAllowance };
}

function EmployeeMetric({ icon: Icon, label, value, note, tone = "green" }: { icon: typeof Clock3; label: string; value: string; note?: string; tone?: string }) {
  return <article className={`employee-metric ${tone}`}><i><Icon size={24}/></i><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

function EmployeeShiftPayrollTable({ rows, support }: { rows: EmployeePayrollShiftDetail[]; support: boolean }) {
  return <section className={`employee-shift-payroll-group ${support ? "support" : "main"}`}>
    <div className="employee-shift-payroll-heading"><div><span>{support ? "CA HỖ TRỢ" : "CA TẠI CỬA HÀNG CHÍNH"}</span><h3>{support ? "Lương hỗ trợ theo ca" : "Lương cứng theo ca"}</h3></div><b>{rows.length} ca</b></div>
    <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Ngày</th><th>Ca / cửa hàng</th><th>Vai trò</th><th>Giờ làm thực tế</th>{support ? <><th>Lương hỗ trợ/giờ</th><th>Phụ cấp hỗ trợ</th></> : <th>Lương cứng</th>}<th>Phụ cấp TikTok</th><th>Lương thực nhận</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{displayDay(row.workDate || localDay(row.startedAt))}<small>{time(row.startedAt)} - {time(row.endedAt)}</small></td><td><b>{row.shiftName ?? row.shiftCode}</b><small>{row.storeName}</small></td><td>{support ? <><span className="status-pill">Nhân viên hỗ trợ</span><small className="support-note">Từ {row.sourceStoreName ?? "cửa hàng chính"}</small></> : <span>Nhân viên chính</span>}</td><td>{row.hours.toFixed(2)} giờ</td>{support ? <><td><b>{money(row.hourlyRate)}/giờ</b></td><td>{money(row.supportAllowance)}</td></> : <td><b>{money(row.hourlyRate)}/giờ</b></td>}<td>{money(row.tiktokAllowance)}</td><td className="money-green"><b>{money(row.netPay)}</b></td></tr>)}</tbody></table></div>
  </section>;
}

export function ReferenceEmployeePayroll() {
  const { shifts, reload } = useShifts();
  const [month, setMonth] = useState(monthNow());
  const [through, setThrough] = useState(today());
  const [payrollItem, setPayrollItem] = useState<EmployeePayrollItem | null>(null);
  const [sources, setSources] = useState<EmployeePayrollSource[]>([]);
  const [payrollShifts, setPayrollShifts] = useState<EmployeePayrollShiftDetail[]>([]);
  const [payrollLocked, setPayrollLocked] = useState(false);
  const [payrollPaid, setPayrollPaid] = useState(false);
  const loadPayroll = useCallback(async () => {
    const response = await fetch(`/api/payroll?period=${encodeURIComponent(month)}`);
    const data = await response.json();
    setPayrollItem(response.ok ? data.item ?? null : null);
    setSources(response.ok ? data.sources ?? [] : []);
    setPayrollShifts(response.ok ? data.shiftDetails ?? [] : []);
    setPayrollLocked(Boolean(response.ok && data.locked));
    setPayrollPaid(Boolean(response.ok && data.paid));
  }, [month]);
  useEffect(() => { loadPayroll(); }, [loadPayroll]);
  const rows = useMemo(() => shifts.filter((shift) => workDay(shift).slice(0, 7) === month && workDay(shift) <= through).map(shiftInfo), [month, shifts, through]);
  const detailRows = useMemo(() => payrollShifts.filter((shift) => (shift.workDate || localDay(shift.startedAt)) <= through), [payrollShifts, through]);
  const mainShiftRows = useMemo(() => detailRows.filter((row) => !row.isSupport), [detailRows]);
  const supportShiftRows = useMemo(() => detailRows.filter((row) => row.isSupport), [detailRows]);
  const shiftWage = detailRows.length ? detailRows.reduce((sum, row) => sum + row.baseSalary, 0) : rows.reduce((sum, row) => sum + row.wage, 0);
  const shiftAllowance = detailRows.length ? detailRows.reduce((sum, row) => sum + row.tiktokAllowance + row.supportAllowance, 0) : rows.reduce((sum, row) => sum + row.tiktok_allowance, 0);
  const wage = payrollLocked && payrollItem ? payrollItem.baseSalary : shiftWage;
  const allowance = payrollLocked && payrollItem ? payrollItem.tiktokAllowance + payrollItem.supportAllowance + payrollItem.manualAllowance : shiftAllowance;
  const reward = payrollLocked && payrollItem ? payrollItem.manualBonus + payrollItem.kpiBonus : 0;
  const income = payrollLocked && payrollItem ? payrollItem.totalPay : wage + allowance;
  const rowCount = detailRows.length || rows.length;
  const totalHours = detailRows.length ? detailRows.reduce((sum, row) => sum + row.hours, 0) : rows.reduce((sum, row) => sum + row.hours, 0);
  async function reloadAll() { await Promise.all([reload(), loadPayroll()]); }
  return <div className="employee-reference payroll-reference"><div className="employee-filter"><label>Tháng<input type="month" value={month} onChange={(event) => setMonth(event.target.value)}/></label><label>Đến ngày<input type="date" value={through} onChange={(event) => setThrough(event.target.value)}/></label><button className="primary-button" onClick={reloadAll}><TrendingUp size={17}/> Xem thống kê</button></div>
    <div className="employee-metrics four"><EmployeeMetric icon={WalletCards} label="TỔNG THU NHẬP" value={money(income)} note={payrollPaid ? "Đã chi và ghi nhận lịch sử" : payrollLocked ? "Đã chốt, chờ xác nhận chi" : `Tạm tính đến ${through}`}/><EmployeeMetric icon={BadgeDollarSign} label="TỔNG LƯƠNG" value={money(wage)} note={`Từ ${rowCount} ca làm`} tone="blue"/><EmployeeMetric icon={Gift} label="THƯỞNG & PHỤ CẤP" value={money(reward + allowance)} note={payrollLocked ? "KPI + thưởng + phụ cấp" : "Chờ quản lý tổng kết KPI"} tone="orange"/><EmployeeMetric icon={CheckCircle2} label="TRẠNG THÁI CHI" value={payrollPaid ? "ĐÃ CHI" : payrollLocked ? "CHỜ CHI" : "TẠM TÍNH"} note={`${rowCount} ca đã ghi nhận`}/></div>
    <section className="employee-detail-strip"><h2>CHI TIẾT THỐNG KÊ</h2><div><span>Số ca làm<b>{rowCount} ca</b></span><span>Tổng số giờ làm<b>{totalHours.toFixed(2)} giờ</b></span><span>Ca hỗ trợ<b>{detailRows.filter((row) => row.isSupport).length} ca</b></span><span>Cửa hàng tính lương<b>{Math.max(1, sources.length)} nơi</b></span><span>Lương trung bình/ca<b>{money(rowCount ? wage / rowCount : 0)}</b></span></div></section>
    {sources.length > 0 && <section className="employee-panel table-panel"><div className="panel-title"><h2>NGUỒN CHI TRẢ THEO CỬA HÀNG</h2><span>{sources.length} cửa hàng</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Cửa hàng</th><th>Vai trò</th><th>Giờ làm thực tế</th><th>Lương từ giờ làm</th><th>Phụ cấp hỗ trợ</th><th>Thưởng/KPI</th><th>Lương thực nhận</th><th>Trạng thái</th></tr></thead><tbody>{sources.map((source) => <tr key={source.storeId}><td><b>{source.storeName}</b></td><td>{source.isSupport ? <span className="status-pill">Nhân viên hỗ trợ</span> : "Nhân viên chính"}</td><td>{source.hours.toFixed(2)} giờ</td><td>{money(source.baseSalary)}</td><td>{source.isSupport ? money(source.supportAllowance) : "—"}</td><td>{money(source.manualBonus + source.kpiBonus + source.manualAllowance)}</td><td className="money-green"><b>{money(source.totalPay)}</b></td><td><span className="status-pill">{source.paymentStatus === "LOCKED" || source.paymentStatus === "PAYMENT_CONFIRMED" ? "Đã chi" : "Chờ chi"}</span></td></tr>)}</tbody></table></div></section>}
    <div className="employee-payroll-grid"><section className="employee-panel table-panel"><div className="panel-title"><div><h2>CHI TIẾT LƯƠNG THEO CA</h2><p>Tách rõ ca tại cửa hàng chính và ca hỗ trợ để không nhầm mức lương theo giờ.</p></div><button onClick={() => csv("bang-luong.csv", [["Ngày", "Ca", "Cửa hàng", "Vai trò", "Giờ vào", "Giờ kết", "Giờ làm thực tế", "Lương cứng/giờ", "Lương hỗ trợ/giờ", "Phụ cấp hỗ trợ", "Phụ cấp TikTok", "Lương thực nhận"], ...detailRows.map((row) => [displayDay(row.workDate || localDay(row.startedAt)), row.shiftName ?? row.shiftCode, row.storeName, row.isSupport ? "Nhân viên hỗ trợ" : "Nhân viên chính", time(row.startedAt), time(row.endedAt), row.hours.toFixed(2), row.isSupport ? "" : row.hourlyRate, row.isSupport ? row.hourlyRate : "", row.isSupport ? row.supportAllowance : "", row.tiktokAllowance, row.netPay])])}><Download size={16}/> Xuất Excel</button></div>{detailRows.length === 0 ? <div className="empty-cell">Chưa có ca làm trong thời gian đã chọn.</div> : <div className="employee-shift-payroll-groups">{mainShiftRows.length > 0 ? <EmployeeShiftPayrollTable rows={mainShiftRows} support={false}/> : null}{supportShiftRows.length > 0 ? <EmployeeShiftPayrollTable rows={supportShiftRows} support/> : null}</div>}</section><aside className="employee-panel income-summary"><h2>TỔNG KẾT THU NHẬP</h2><p><span>Tổng lương ({rowCount} ca)</span><b>{money(wage)}</b></p><p><span>Tổng phụ cấp</span><b>{money(allowance)}</b></p><p><span>Thưởng khác</span><b>{money(payrollItem?.manualBonus ?? 0)}</b></p><p><span>Thưởng KPI</span><b>{money(payrollItem?.kpiBonus ?? 0)}</b></p><p className="total"><span>TỔNG THỰC NHẬN</span><b>{money(income)}</b></p><div><BadgeDollarSign size={30}/><span>{payrollPaid ? "Đã chi lương, thưởng và phụ cấp" : payrollLocked ? "Đã chốt, đang chờ chi" : "KPI chỉ hiển thị sau tổng kết"}<br/><b>{month}</b></span></div></aside></div>
  </div>;
}

export function ReferenceEmployeeCashflow({ shift, orders }: { shift: { active: boolean; shiftCode: string | null; startedAt: string | null; scheduledStart?: string | null; scheduledEnd?: string | null }; orders: Order[] }) {
  const { shifts } = useShifts();
  const completed = orders.filter((order) => order.status === "COMPLETED");
  const revenue = completed.reduce((sum, order) => sum + order.amount, 0);
  const cash = completed.filter((order) => order.payment_method === "CASH").reduce((sum, order) => sum + order.amount, 0);
  const bank = completed.filter((order) => order.payment_method === "BANK_TRANSFER").reduce((sum, order) => sum + order.amount, 0);
  const currentSession = shifts.find((item) => item.shift_code === shift.shiftCode);
  const scheduledTime = shift.scheduledStart && shift.scheduledEnd
    ? `${shift.scheduledStart} - ${shift.scheduledEnd}`
    : currentSession?.scheduledStart && currentSession?.scheduledEnd
      ? `${currentSession.scheduledStart} - ${currentSession.scheduledEnd}`
      : "Chưa có khung giờ";
  const expense = Number(currentSession?.expense_amount ?? 0);
  const profit = revenue - expense;
  const margin = revenue ? profit / revenue * 100 : 0;
  return <div className="employee-reference cashflow-reference"><section className="employee-panel current-shift"><h2>CA LÀM HIỆN TẠI</h2><div className="shift-overview"><div><span>{currentSession?.shiftName ?? shift.shiftCode ?? "Chưa vào ca"}</span><strong>{scheduledTime}</strong><small>{shift.active ? "● Đang làm" : "Bạn chưa bắt đầu ca làm việc"}</small></div><div><i><TrendingUp/></i><span>DOANH THU</span><strong>{money(revenue)}</strong><small>Số đơn: {completed.length} · CK: {money(bank)} · TM: {money(cash)}</small></div><div className="orange"><i><Banknote/></i><span>CHI PHÍ TRONG CA</span><strong>{money(expense)}</strong><small>Chỉ phát sinh khi nhân viên nhập, mặc định 0 đồng</small></div><div className="blue"><i><WalletCards/></i><span>LỢI NHUẬN TẠM TÍNH</span><strong>{money(profit)}</strong><small>Tỷ lệ lợi nhuận {margin.toFixed(2)}%</small></div></div></section>
    <section className="employee-panel table-panel"><div className="panel-title"><h2>DÒNG TIỀN CA HIỆN TẠI</h2><button onClick={() => csv("dong-tien-ca.csv", [["Mã đơn", "Thời gian", "Hình thức", "Doanh thu"], ...completed.map((order) => [order.code, order.created_at, order.payment_method, order.amount])])}><Download size={16}/> Xuất Excel</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Mã đơn</th><th>Thời gian</th><th>Hình thức thanh toán</th><th>Doanh thu</th><th>Chi phí trong ca</th><th>Trạng thái</th></tr></thead><tbody>{completed.length === 0 ? <tr><td className="empty-cell" colSpan={7}>{shift.active ? "Chưa có đơn hàng trong ca hiện tại. Chi phí trong ca mặc định là 0 đồng." : "Bạn chưa bắt đầu ca làm việc"}</td></tr> : completed.map((order, index) => <tr key={order.id}><td>{index + 1}</td><td className="money-green">{order.code}</td><td>{new Date(order.created_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" })}</td><td><span className={order.payment_method === "CASH" ? "status-pill" : "shift-pill s3"}>{order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</span></td><td>{money(order.amount)}</td><td className="money-orange">{index === 0 ? money(expense) : "—"}</td><td><span className="status-pill">Đã ghi nhận</span></td></tr>)}</tbody><tfoot><tr><td colSpan={4}>TỔNG CỘNG</td><td>{money(revenue)}</td><td>{money(expense)}</td><td/></tr></tfoot></table></div></section>
  </div>;
}

export function ReferenceEmployeeRevenue() {
  const { shifts, reload } = useShifts();
  const [mode, setMode] = useState<"shift" | "day">("shift");
  const rows = shifts.filter((item) => item.status === "COMPLETED").map(shiftInfo);
  const total = rows.reduce((sum, item) => sum + Number(item.cash_revenue ?? 0) + Number(item.transfer_revenue ?? 0), 0);
  const cash = rows.reduce((sum, item) => sum + Number(item.cash_revenue ?? 0), 0);
  const bank = rows.reduce((sum, item) => sum + Number(item.transfer_revenue ?? 0), 0);
  const byDay = Object.values(rows.reduce<Record<string, { day: string; cash: number; bank: number; count: number }>>((result, item) => {
    const day = workDay(item); const current = result[day] ?? { day, cash: 0, bank: 0, count: 0 };
    current.cash += Number(item.cash_revenue ?? 0); current.bank += Number(item.transfer_revenue ?? 0); current.count += 1; result[day] = current; return result;
  }, {}));
  return <div className="employee-reference revenue-reference"><div className="employee-metrics four"><EmployeeMetric icon={TrendingUp} label="TỔNG DOANH THU" value={money(total)} note={`${rows.length} ca đã kết`}/><EmployeeMetric icon={Banknote} label="TIỀN MẶT" value={money(cash)} tone="orange"/><EmployeeMetric icon={WalletCards} label="CHUYỂN KHOẢN" value={money(bank)} tone="blue"/><EmployeeMetric icon={Clock3} label="SỐ NGÀY GHI NHẬN" value={String(byDay.length)}/></div><section className="employee-panel table-panel"><div className="panel-title"><div className="ref-tabs compact"><button className={mode === "shift" ? "active" : ""} onClick={() => setMode("shift")}>Theo ca</button><button className={mode === "day" ? "active" : ""} onClick={() => setMode("day")}>Theo ngày</button></div><button onClick={reload}><Search size={16}/> Làm mới</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr>{mode === "shift" ? <><th>Ngày</th><th>Ca làm</th><th>Cửa hàng</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng doanh thu</th></> : <><th>Ngày</th><th>Số ca</th><th>Tiền mặt</th><th>Chuyển khoản</th><th>Tổng doanh thu</th></>}</tr></thead><tbody>{mode === "shift" ? rows.map((item) => <tr key={item.id}><td>{displayDay(workDay(item))}</td><td><span className={`shift-pill s${shiftTone(item)}`}>{displayShiftName(item)}</span></td><td>{item.transfer_id ? <><b>{item.targetStoreName ?? "Cửa hàng hỗ trợ"}</b><small className="support-note">CA HỖ TRỢ · từ {item.sourceStoreName ?? "cửa hàng chính"}</small></> : "Cửa hàng chính"}</td><td>{money(Number(item.cash_revenue ?? 0))}</td><td>{money(Number(item.transfer_revenue ?? 0))}</td><td className="money-green"><b>{money(Number(item.cash_revenue ?? 0) + Number(item.transfer_revenue ?? 0))}</b></td></tr>) : byDay.map((item) => <tr key={item.day}><td>{displayDay(item.day)}</td><td>{item.count}</td><td>{money(item.cash)}</td><td>{money(item.bank)}</td><td className="money-green"><b>{money(item.cash + item.bank)}</b></td></tr>)}</tbody></table></div></section></div>;
}

export function ReferenceEmployeeShiftHistory() {
  const { shifts, reload } = useShifts();
  const [from, setFrom] = useState(`${monthNow()}-01`);
  const [to, setTo] = useState(today());
  const [query, setQuery] = useState("");
  const rows = useMemo(() => shifts.filter((shift) => {
    const value = workDay(shift);
    const selectedShift = displayShiftName(shift).toLocaleLowerCase("vi-VN");
    return value >= from && value <= to && (!query || selectedShift === query.toLocaleLowerCase("vi-VN"));
  }).map(shiftInfo), [from, query, shifts, to]);
  return <div className="employee-reference history-reference"><div className="employee-history-filter"><label>Từ ngày<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label><label>Đến ngày<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label><label>Ca làm<select value={query} onChange={(event) => setQuery(event.target.value)}><option value="">Tất cả</option><option value="Ca 1">Ca 1</option><option value="Ca 2">Ca 2</option><option value="Ca 3">Ca 3</option></select></label><button className="primary-button" onClick={reload}><Search size={17}/> Tìm kiếm</button></div>
    <section className="employee-panel table-panel"><div className="panel-title"><h2>LỊCH SỬ CA LÀM</h2><button onClick={() => csv("lich-su-ca-lam.csv", [["Ngày", "Ca làm", "Mã nhân viên", "Tên nhân viên", "Giờ vào", "Giờ kết ca", "Số giờ", "Lương giờ", "Phụ cấp hỗ trợ", "Lương dự tính"], ...rows.map((row) => [displayDay(workDay(row)), displayShiftName(row), row.employeeCode ?? "", row.employeeName ?? "", time(row.started_at), row.ended_at ? time(row.ended_at) : "Đang làm", row.hours.toFixed(2), row.hourlyRate, row.supportAllowance, row.total])])}><Download size={16}/> Xuất Excel</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Ngày làm việc</th><th>Mã nhân viên</th><th>Tên nhân viên</th><th>Ca làm</th><th>Giờ vào</th><th>Giờ kết ca</th><th>Số giờ</th><th>Lương/giờ</th><th>Phụ cấp hỗ trợ</th><th>Lương dự tính</th></tr></thead><tbody>{rows.length === 0 ? <tr><td className="empty-cell" colSpan={11}>Chưa có lịch sử ca làm trong thời gian đã chọn.</td></tr> : rows.map((row, index) => <tr key={row.id}><td>{index + 1}</td><td>{displayDay(workDay(row))}</td><td>{row.employeeCode ?? "—"}</td><td>{row.employeeName ?? "—"}</td><td><span className={`shift-pill s${shiftTone(row)}`}>{displayShiftName(row)}</span>{row.transfer_id && <small className="support-note">CA HỖ TRỢ · {row.targetStoreName ?? "Cửa hàng hỗ trợ"}</small>}</td><td>{time(row.started_at)}</td><td>{row.ended_at ? time(row.ended_at) : "Đang làm"}</td><td className="money-green">{row.hours.toFixed(2)} giờ</td><td>{money(row.hourlyRate)}/giờ</td><td>{row.transfer_id ? money(row.supportAllowance) : "—"}</td><td className="money-green">{money(row.total)}</td></tr>)}</tbody></table></div><div className="history-footer"><span>Hiển thị 1 - {rows.length} của {rows.length} bản ghi</span><div><button>‹</button><button className="active">1</button><button>›</button></div></div></section>
  </div>;
}
