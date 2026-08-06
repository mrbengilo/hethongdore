"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeDollarSign, Banknote, CheckCircle2, Clock3, Download, Gift, Search, TrendingUp, WalletCards } from "lucide-react";

type ShiftRow = {
  id: string;
  shift_code: string;
  started_at: string;
  ended_at: string | null;
  tiktok_allowance: number;
  hourlyRate: number;
  status: string;
};

type Order = {
  id: string;
  code: string;
  amount: number;
  payment_method: "CASH" | "BANK_TRANSFER";
  status: string;
  created_at: string;
};

const money = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;
const today = () => new Date().toISOString().slice(0, 10);
const monthNow = () => new Date().toISOString().slice(0, 7);
const date = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
const time = (value: string) => new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));

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
  const hours = Math.max(0, (end.getTime() - new Date(shift.started_at).getTime()) / 3_600_000);
  const wage = Math.round(hours * shift.hourlyRate);
  return { ...shift, hours, wage, total: wage + shift.tiktok_allowance };
}

function EmployeeMetric({ icon: Icon, label, value, note, tone = "green" }: { icon: typeof Clock3; label: string; value: string; note?: string; tone?: string }) {
  return <article className={`employee-metric ${tone}`}><i><Icon size={24}/></i><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

export function ReferenceEmployeePayroll() {
  const { shifts, reload } = useShifts();
  const [month, setMonth] = useState(monthNow());
  const [through, setThrough] = useState(today());
  const rows = useMemo(() => shifts.filter((shift) => shift.started_at.slice(0, 7) === month && shift.started_at.slice(0, 10) <= through).map(shiftInfo), [month, shifts, through]);
  const wage = rows.reduce((sum, row) => sum + row.wage, 0);
  const allowance = rows.reduce((sum, row) => sum + row.tiktok_allowance, 0);
  const reward = Math.round(wage * .06);
  const income = wage + allowance + reward;
  return <div className="employee-reference payroll-reference"><div className="employee-filter"><label>Tháng<input type="month" value={month} onChange={(event) => setMonth(event.target.value)}/></label><label>Đến ngày<input type="date" value={through} onChange={(event) => setThrough(event.target.value)}/></label><button className="primary-button" onClick={reload}><TrendingUp size={17}/> Xem thống kê</button></div>
    <div className="employee-metrics four"><EmployeeMetric icon={WalletCards} label="TỔNG THU NHẬP" value={money(income)} note={`Đến ngày ${through}`}/><EmployeeMetric icon={BadgeDollarSign} label="TỔNG LƯƠNG" value={money(wage)} note={`Từ ${rows.length} ca làm`} tone="blue"/><EmployeeMetric icon={Gift} label="TỔNG THƯỞNG" value={money(reward + allowance)} note="Thưởng + phụ cấp" tone="orange"/><EmployeeMetric icon={CheckCircle2} label="TỶ LỆ HOÀN THÀNH CA" value={rows.length ? "100%" : "0%"} note={`${rows.length} / ${rows.length} ca`}/></div>
    <section className="employee-detail-strip"><h2>CHI TIẾT THỐNG KÊ</h2><div><span>Số ca làm<b>{rows.length} ca</b></span><span>Tổng số giờ làm<b>{rows.reduce((sum, row) => sum + row.hours, 0).toFixed(2)} giờ</b></span><span>Lương cứng theo giờ<b>{money(rows[0]?.hourlyRate ?? 20_000)}/giờ</b></span><span>Ngày công<b>{new Set(rows.map((row) => row.started_at.slice(0, 10))).size} ngày</b></span><span>Lương trung bình/ca<b>{money(rows.length ? wage / rows.length : 0)}</b></span></div></section>
    <div className="employee-payroll-grid"><section className="employee-panel table-panel"><div className="panel-title"><h2>CHI TIẾT LƯƠNG THEO CA</h2><button onClick={() => csv("bang-luong.csv", [["Ngày", "Ca", "Giờ vào", "Giờ kết ca", "Số giờ", "Lương", "Phụ cấp", "Thành tiền"], ...rows.map((row) => [date(row.started_at), row.shift_code, time(row.started_at), row.ended_at ? time(row.ended_at) : "Đang làm", row.hours.toFixed(2), row.wage, row.tiktok_allowance, row.total])])}><Download size={16}/> Xuất Excel</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Ngày làm</th><th>Ca làm</th><th>Thời gian vào</th><th>Thời gian kết ca</th><th>Số giờ</th><th>Lương cứng</th><th>Thành tiền</th></tr></thead><tbody>{rows.length === 0 ? <tr><td className="empty-cell" colSpan={8}>Chưa có ca làm trong thời gian đã chọn.</td></tr> : rows.map((row, index) => <tr key={row.id}><td>{index + 1}</td><td>{date(row.started_at)}</td><td><span className={`shift-pill s${index % 3 + 1}`}>{row.shift_code}</span></td><td>{time(row.started_at)}</td><td>{row.ended_at ? time(row.ended_at) : "Đang làm"}</td><td>{row.hours.toFixed(2)} giờ</td><td>{money(row.wage)}</td><td className="money-green">{money(row.total)}</td></tr>)}</tbody></table></div></section><aside className="employee-panel income-summary"><h2>TỔNG KẾT THU NHẬP</h2><p><span>Tổng lương ({rows.length} ca)</span><b>{money(wage)}</b></p><p><span>Phụ cấp TikTok</span><b>{money(allowance)}</b></p><p><span>Thưởng khác</span><b>{money(reward)}</b></p><p className="total"><span>TỔNG THU NHẬP</span><b>{money(income)}</b></p><div><BadgeDollarSign size={30}/><span>Đã tính đến ngày<br/><b>{through}</b></span></div></aside></div>
  </div>;
}

export function ReferenceEmployeeCashflow({ shift, orders }: { shift: { active: boolean; shiftCode: string | null; startedAt: string | null }; orders: Order[] }) {
  const completed = orders.filter((order) => order.status === "COMPLETED");
  const revenue = completed.reduce((sum, order) => sum + order.amount, 0);
  const cash = completed.filter((order) => order.payment_method === "CASH").reduce((sum, order) => sum + order.amount, 0);
  const bank = completed.filter((order) => order.payment_method === "BANK_TRANSFER").reduce((sum, order) => sum + order.amount, 0);
  const expense = Math.round(revenue * .14);
  const profit = revenue - expense;
  const margin = revenue ? profit / revenue * 100 : 0;
  return <div className="employee-reference cashflow-reference"><section className="employee-panel current-shift"><h2>CA LÀM HIỆN TẠI</h2><div className="shift-overview"><div><span>{shift.shiftCode ?? "CA 1"}</span><strong>07:00 - 12:00</strong><small>{shift.active ? "● Đang làm" : "Bạn chưa bắt đầu ca làm việc"}</small></div><div><i><TrendingUp/></i><span>DOANH THU</span><strong>{money(revenue)}</strong><small>Số đơn: {completed.length} · CK: {money(bank)} · TM: {money(cash)}</small></div><div className="orange"><i><Banknote/></i><span>CHI PHÍ</span><strong>{money(expense)}</strong><small>Tổng chi tạm tính trong ca</small></div><div className="blue"><i><WalletCards/></i><span>LỢI NHUẬN TẠM TÍNH</span><strong>{money(profit)}</strong><small>Tỷ lệ lợi nhuận {margin.toFixed(2)}%</small></div></div></section>
    <section className="employee-panel table-panel"><div className="panel-title"><h2>LỊCH SỬ DÒNG TIỀN TRONG CA</h2><button onClick={() => csv("dong-tien-ca.csv", [["Mã đơn", "Thời gian", "Hình thức", "Doanh thu"], ...completed.map((order) => [order.code, order.created_at, order.payment_method, order.amount])])}><Download size={16}/> Xuất Excel</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Mã đơn</th><th>Thời gian</th><th>Hình thức thanh toán</th><th>Doanh thu</th><th>Chi phí phân bổ</th><th>Lợi nhuận</th><th>Trạng thái</th></tr></thead><tbody>{completed.length === 0 ? <tr><td className="empty-cell" colSpan={8}>{shift.active ? "Chưa có đơn hàng trong ca hiện tại." : "Bạn chưa bắt đầu ca làm việc"}</td></tr> : completed.map((order, index) => { const allocated = Math.round(order.amount * .14); return <tr key={order.id}><td>{index + 1}</td><td className="money-green">{order.code}</td><td>{new Date(order.created_at).toLocaleString("vi-VN")}</td><td><span className={order.payment_method === "CASH" ? "status-pill" : "shift-pill s3"}>{order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</span></td><td>{money(order.amount)}</td><td className="money-orange">{money(allocated)}</td><td className="money-green">{money(order.amount - allocated)}</td><td><span className="status-pill">Đã ghi nhận</span></td></tr>; })}</tbody><tfoot><tr><td colSpan={4}>TỔNG CỘNG</td><td>{money(revenue)}</td><td>{money(expense)}</td><td>{money(profit)}</td><td/></tr></tfoot></table></div></section>
  </div>;
}

export function ReferenceEmployeeShiftHistory() {
  const { shifts, reload } = useShifts();
  const [from, setFrom] = useState(`${monthNow()}-01`);
  const [to, setTo] = useState(today());
  const [query, setQuery] = useState("");
  const rows = useMemo(() => shifts.filter((shift) => { const value = shift.started_at.slice(0, 10); return value >= from && value <= to && (!query || shift.shift_code.toLocaleLowerCase("vi-VN").includes(query.toLocaleLowerCase("vi-VN"))); }).map(shiftInfo), [from, query, shifts, to]);
  return <div className="employee-reference history-reference"><div className="employee-history-filter"><label>Từ ngày<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label><label>Đến ngày<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label><label>Ca làm<select value={query} onChange={(event) => setQuery(event.target.value)}><option value="">Tất cả</option><option>CA 1</option><option>CA 2</option><option>CA 3</option></select></label><button className="primary-button" onClick={reload}><Search size={17}/> Tìm kiếm</button></div>
    <section className="employee-panel table-panel"><div className="panel-title"><h2>LỊCH SỬ CA LÀM</h2><button onClick={() => csv("lich-su-ca-lam.csv", [["Ngày", "Mã ca", "Giờ vào", "Giờ kết ca", "Số giờ", "Lương giờ", "Lương dự tính"], ...rows.map((row) => [date(row.started_at), row.shift_code, time(row.started_at), row.ended_at ? time(row.ended_at) : "Đang làm", row.hours.toFixed(2), row.hourlyRate, row.total])])}><Download size={16}/> Xuất Excel</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Thời gian (Ngày làm việc)</th><th>Mã nhân viên</th><th>Tên nhân viên</th><th>Ca làm</th><th>Thời gian vào</th><th>Thời gian kết ca</th><th>Số giờ làm</th><th>Lương cứng</th><th>Lương dự tính</th></tr></thead><tbody>{rows.length === 0 ? <tr><td className="empty-cell" colSpan={10}>Chưa có lịch sử ca làm trong thời gian đã chọn.</td></tr> : rows.map((row, index) => <tr key={row.id}><td>{index + 1}</td><td>{date(row.started_at)}</td><td>NV001</td><td>Nguyễn Thị An</td><td><span className={`shift-pill s${index % 3 + 1}`}>{row.shift_code}</span></td><td>{time(row.started_at)}</td><td>{row.ended_at ? time(row.ended_at) : "Đang làm"}</td><td className="money-green">{row.hours.toFixed(2)} giờ</td><td>{money(row.hourlyRate)}/giờ</td><td className="money-green">{money(row.total)}</td></tr>)}</tbody></table></div><div className="history-footer"><span>Hiển thị 1 - {rows.length} của {rows.length} bản ghi</span><div><button>‹</button><button className="active">1</button><button>›</button></div></div></section>
  </div>;
}
