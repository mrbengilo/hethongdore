"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  BadgeDollarSign,
  Banknote,
  BarChart3,
  CheckCircle2,
  Download,
  Percent,
  ShieldCheck,
  Store,
  TrendingUp,
  UserRound,
  WalletCards,
  XCircle,
} from "lucide-react";
import { formatVndInput, parseVndInput } from "../lib/format";
import { ManagerProfitSharingClosing } from "./FinancialReports";

export type ReferenceStore = {
  id: string;
  name: string;
  address: string;
  revenue: number;
  expense: number;
  profit: number;
  status: string;
};

type Employee = {
  id: string;
  code: string;
  name: string;
  position: string;
  phone: string;
  hourly_rate: number;
  store_id: string;
  store_name?: string;
  status: string;
};

type EmployeeTransfer = {
  id: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  employee_position: string;
  source_store_id: string;
  source_store_name: string;
  target_store_id: string;
  target_store_name: string;
  start_date: string;
  end_date: string;
  shifts: string[];
  support_hourly_rate: number;
  support_allowance: number;
  reason: string;
  status: "SCHEDULED" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  created_by_name?: string;
};

const money = (value: number) => `${new Intl.NumberFormat("en-US").format(Math.round(value))} đồng`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

function csv(filename: string, rows: Array<Array<string | number>>) {
  const safe = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(safe).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Metric({ icon: Icon, label, value, note, tone = "green" }: {
  icon: typeof Banknote;
  label: string;
  value: string;
  note?: string;
  tone?: string;
}) {
  return <article className={`manager-metric ${tone}`}><i><Icon size={24}/></i><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

function TrendChart({ stores }: { stores: ReferenceStore[] }) {
  const values = stores.length ? stores : Array.from({ length: 5 }, (_, index) => ({ id: String(index), name: `Cửa hàng ${index + 1}`, revenue: 200 + index * 30, expense: 110 + index * 20, profit: 90 + index * 10, address: "", status: "" }));
  const max = Math.max(...values.flatMap((item) => [item.revenue, item.expense, item.profit]), 1);
  return <div className="manager-bars" aria-label="Biểu đồ doanh thu chi phí lợi nhuận">{values.map((item) => <div className="manager-bar-column" key={item.id}><div><i className="revenue" style={{ height: `${Math.max(16, item.revenue / max * 150)}px` }}/><i className="expense" style={{ height: `${Math.max(12, item.expense / max * 150)}px` }}/><i className="profit" style={{ height: `${Math.max(10, item.profit / max * 150)}px` }}/></div><span>{item.name.replace("DORE ", "")}</span></div>)}</div>;
}

export function ReferenceManagerCashflow({ stores, totals }: { stores: ReferenceStore[]; totals: { revenue: number; expense: number; profit: number } }) {
  const [storeId, setStoreId] = useState("ALL");
  const selected = stores.find((store) => store.id === storeId);
  const summary = selected ?? totals;
  const margin = summary.revenue ? summary.profit / summary.revenue * 100 : 0;
  const rows = selected ? [selected] : stores;
  return <div className="page-content manager-reference">
    <div className="manager-filter-strip"><label>Chọn cửa hàng<select value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="ALL">Tất cả cửa hàng</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label><label>Chọn thời gian<input type="date" defaultValue={today()}/></label><button onClick={() => csv("dong-tien-dore.csv", [["Cửa hàng", "Doanh thu", "Chi phí", "Lợi nhuận"], ...rows.map((store) => [store.name, store.revenue, store.expense, store.profit])])}><Download size={17}/> Xuất báo cáo</button></div>
    <div className="manager-metrics three"><Metric icon={TrendingUp} label="DOANH THU" value={money(summary.revenue)} note="↑ 12,45% so với kỳ trước"/><Metric icon={WalletCards} label="CHI PHÍ" value={money(summary.expense)} note="↑ 8,32% so với kỳ trước" tone="orange"/><Metric icon={BarChart3} label="LỢI NHUẬN" value={money(summary.profit)} note="↑ 16,78% so với kỳ trước" tone="blue"/></div>
    <div className="manager-chart-grid"><section className="manager-panel"><div className="panel-title"><div><h2>Biểu đồ dòng tiền</h2><p><b className="dot green"/> Doanh thu <b className="dot orange"/> Chi phí <b className="dot blue"/> Lợi nhuận</p></div><select aria-label="Kiểu thời gian"><option>Theo cửa hàng</option><option>Theo ngày</option></select></div><TrendChart stores={rows}/></section><section className="manager-panel"><h2>Tỷ lệ cơ cấu</h2><div className="manager-donut-layout"><div className="manager-donut cash" style={{ "--profit": `${Math.min(75, Math.max(15, margin))}%` } as CSSProperties}><span><small>Lợi nhuận</small><b>{margin.toFixed(2)}%</b></span></div><div className="manager-legend"><p><i className="green"/> Doanh thu <b>{money(summary.revenue)}</b></p><p><i className="orange"/> Chi phí <b>{money(summary.expense)}</b></p><p><i className="blue"/> Lợi nhuận <b>{money(summary.profit)}</b></p></div></div></section></div>
    <section className="manager-panel table-panel"><div className="panel-title"><h2>Chi tiết dòng tiền</h2><span>{rows.length} cửa hàng</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Cửa hàng</th><th>Doanh thu</th><th>Chi phí cố định</th><th>Marketing</th><th>Tổng chi phí</th><th>Lợi nhuận</th><th>Tỷ lệ</th></tr></thead><tbody>{rows.map((store) => <tr key={store.id}><td><b>{store.name}</b></td><td className="money-green">{money(store.revenue)}</td><td>{money(Math.round(store.expense * .42))}</td><td>{money(Math.round(store.expense * .08))}</td><td className="money-orange">{money(store.expense)}</td><td className="money-blue">{money(store.profit)}</td><td className="money-green">{store.revenue ? (store.profit / store.revenue * 100).toFixed(2) : "0"}%</td></tr>)}</tbody></table></div></section>
  </div>;
}

export function ReferenceManagerReports({ stores, totals }: { stores: ReferenceStore[]; totals: { revenue: number; expense: number; profit: number } }) {
  const [mode, setMode] = useState<"all" | "store">("all");
  const margin = totals.revenue ? totals.profit / totals.revenue * 100 : 0;
  return <div className="page-content manager-reference">
    <div className="report-switch"><button className={mode === "all" ? "active" : ""} onClick={() => setMode("all")}><BarChart3 size={17}/> Tổng tất cả cửa hàng</button><button className={mode === "store" ? "active" : ""} onClick={() => setMode("store")}><Store size={17}/> Theo từng cửa hàng</button><span/><button onClick={() => csv("bao-cao-dore.csv", [["Cửa hàng", "Doanh thu", "Chi phí", "Lợi nhuận"], ...stores.map((store) => [store.name, store.revenue, store.expense, store.profit])])}><Download size={17}/> File Excel</button></div>
    <div className="manager-metrics four"><Metric icon={Banknote} label="TỔNG DOANH THU" value={money(totals.revenue)} note="↑ 12,45% so với kỳ trước"/><Metric icon={WalletCards} label="TỔNG CHI PHÍ" value={money(totals.expense)} note="↑ 8,32% so với kỳ trước" tone="orange"/><Metric icon={BarChart3} label="TỔNG LỢI NHUẬN" value={money(totals.profit)} note="↑ 16,78% so với kỳ trước" tone="blue"/><Metric icon={Percent} label="TỶ LỆ LỢI NHUẬN" value={`${margin.toFixed(2)}%`} note="↑ 2,14% so với kỳ trước"/></div>
    <div className="manager-chart-grid"><section className="manager-panel"><h2>Biểu đồ tổng theo cửa hàng</h2><p className="chart-legend"><b className="dot green"/> Doanh thu <b className="dot orange"/> Chi phí <b className="dot blue"/> Lợi nhuận</p><TrendChart stores={mode === "store" ? stores.slice(0, 1) : stores}/></section><section className="manager-panel"><h2>Cơ cấu doanh thu theo cửa hàng</h2><div className="manager-donut-layout"><div className="manager-donut stores"><span><small>Tổng</small><b>{money(totals.revenue)}</b></span></div><div className="manager-legend compact">{stores.map((store, index) => <p key={store.id}><i className={["green", "orange", "blue", "teal", "gold"][index % 5]}/>{store.name}<b>{totals.revenue ? (store.revenue / totals.revenue * 100).toFixed(1) : "0"}%</b></p>)}</div></div></section></div>
    <section className="manager-panel table-panel"><h2>Chi tiết doanh thu – chi phí – lợi nhuận từng cửa hàng</h2><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Cửa hàng</th><th>Tổng doanh thu</th><th>Tổng chi phí</th><th>Lợi nhuận</th><th>Tỷ lệ lợi nhuận</th></tr></thead><tbody>{stores.map((store, index) => <tr key={store.id}><td>{index + 1}</td><td><b>{store.name}</b></td><td>{money(store.revenue)}</td><td>{money(store.expense)}</td><td className="money-green">{money(store.profit)}</td><td className="money-green">{store.revenue ? (store.profit / store.revenue * 100).toFixed(2) : "0"}%</td></tr>)}</tbody><tfoot><tr><td colSpan={2}>Tổng cộng</td><td>{money(totals.revenue)}</td><td>{money(totals.expense)}</td><td>{money(totals.profit)}</td><td>{margin.toFixed(2)}%</td></tr></tfoot></table></div></section>
    <div className="manager-insight"><TrendingUp size={24}/><b>Xu hướng:</b><span>Doanh thu và lợi nhuận tăng ổn định; DORE THỐT NỐT đang có hiệu suất vận hành tốt.</span><button>Xem chi tiết →</button></div>
  </div>;
}

export function ReferenceManagerPayroll({ stores }: { stores: ReferenceStore[] }) {
  return <div className="page-content manager-reference"><section className="manager-panel payroll-form"><h2>Lương thưởng quản lý được lấy từ kỳ đã khóa</h2><div className="notice-banner" role="note">Màn hình tham chiếu này không tạo hoặc sửa bảng lương. Số chính thức chỉ xuất hiện sau khi cửa hàng xác nhận chi và khóa kỳ trong danh mục <b>Lương thưởng quản lý</b>.</div><aside className="payroll-guide"><h3>Chính sách hiện hành</h3><p>Lương quản lý cố định <b>3.000.000 đ/cửa hàng/kỳ</b>.</p><p>Mỗi cửa hàng ghi nhận <b>140 giờ quản lý</b> trong tổng giờ tính KPI.</p><p>Quỹ KPI chọn một ngưỡng <b>3%, 5% hoặc 7%</b> theo lợi nhuận trên tổng giờ, rồi chia cho nhân viên đủ điều kiện và quản lý theo tỷ trọng giờ.</p><p>Ca hỗ trợ không được cộng vào tổng giờ KPI của cửa hàng nhận hỗ trợ.</p></aside></section><section className="manager-panel table-panel"><div className="panel-title"><h2>Cửa hàng áp dụng chính sách</h2><span>{stores.length} cửa hàng</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>STT</th><th>Cửa hàng</th><th>Lương cố định</th><th>Giờ quản lý</th><th>Nguồn số liệu</th></tr></thead><tbody>{stores.length === 0 ? <tr><td colSpan={5} className="empty-cell">Chưa có cửa hàng.</td></tr> : stores.map((store, index) => <tr key={store.id}><td>{index + 1}</td><td><b>{store.name}</b></td><td>{money(3_000_000)}</td><td>140 giờ</td><td><span className="status-pill">Kỳ đã khóa</span></td></tr>)}</tbody></table></div></section></div>;
}

export function ReferenceManagerTransfer({ stores }: { stores: ReferenceStore[] }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [transfers, setTransfers] = useState<EmployeeTransfer[]>([]);
  const [sourceStoreId, setSourceStoreId] = useState(stores.find((store) => store.status === "ACTIVE")?.id ?? stores[0]?.id ?? "");
  const [employeeId, setEmployeeId] = useState("");
  const [targetStore, setTargetStore] = useState(stores[1]?.id ?? stores[0]?.id ?? "");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [hourlyRate, setHourlyRate] = useState("20,000");
  const [allowance, setAllowance] = useState("500,000");
  const [reason, setReason] = useState("Hỗ trợ vận hành cửa hàng");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [shifts, setShifts] = useState(["Ca sáng", "Ca chiều"]);
  const reload = useCallback(async () => {
    const response = await fetch("/api/transfers");
    const result = await response.json();
    if (response.ok) setTransfers(result.transfers ?? []);
  }, []);
  useEffect(() => {
    if (!sourceStoreId) return;
    fetch(`/api/employees?storeId=${encodeURIComponent(sourceStoreId)}`).then((response) => response.json()).then((result) => {
      const next = (result.employees ?? []).filter((item: Employee) => item.status !== "INACTIVE");
      setEmployees(next);
      setEmployeeId((current) => next.some((item: Employee) => item.id === current) ? current : next[0]?.id ?? "");
    });
  }, [sourceStoreId]);
  useEffect(() => { reload(); }, [reload]);
  const employee = employees.find((item) => item.id === employeeId);
  const source = stores.find((item) => item.id === sourceStoreId);
  const target = stores.find((item) => item.id === targetStore);
  useEffect(() => {
    if (!employee) return;
    setHourlyRate(formatVndInput(employee.hourly_rate));
    if (!targetStore || targetStore === sourceStoreId) setTargetStore(stores.find((item) => item.id !== sourceStoreId && item.status === "ACTIVE")?.id ?? "");
  }, [employee, sourceStoreId, stores, targetStore]);
  function toggleShift(value: string) {
    setShifts((current) => {
      if (value === "Cả ngày") return current.includes(value) ? [] : [value];
      const withoutAllDay = current.filter((item) => item !== "Cả ngày");
      return withoutAllDay.includes(value) ? withoutAllDay.filter((item) => item !== value) : [...withoutAllDay, value];
    });
  }
  async function save() {
    const parsedHourlyRate = parseVndInput(hourlyRate);
    const parsedAllowance = parseVndInput(allowance);
    if (!employee || !target || end < start || shifts.length === 0 || parsedHourlyRate <= 0 || parsedAllowance < 0 || !reason.trim()) return setMessage("Vui lòng kiểm tra nhân viên, thời gian, ca, lương và lý do hỗ trợ.");
    setSaving(true);
    const response = await fetch("/api/transfers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId, targetStoreId: target.id, startDate: start, endDate: end, shifts, supportHourlyRate: parsedHourlyRate, supportAllowance: parsedAllowance, reason }) });
    const result = await response.json();
    setMessage(response.ok ? `✓ ${result.message}` : result.message ?? "Không thể tạo điều chuyển.");
    setSaving(false);
    if (response.ok) await reload();
  }
  async function updateStatus(record: EmployeeTransfer, action: "CANCEL" | "END") {
    const response = await fetch("/api/transfers", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: record.id, action }) });
    const result = await response.json();
    setMessage(response.ok ? "✓ Đã cập nhật lịch điều chuyển." : result.message ?? "Không thể cập nhật lịch điều chuyển.");
    if (response.ok) await reload();
  }
  const statusLabel = (status: EmployeeTransfer["status"]) => status === "ACTIVE" ? "Đang hỗ trợ" : status === "SCHEDULED" ? "Sắp hỗ trợ" : status === "COMPLETED" ? "Đã hoàn thành" : "Đã hủy";
  return <div className="page-content manager-reference"><div className="transfer-reference-grid transfer-new-layout">
    <section className="manager-panel transfer-form"><h2>1. THÔNG TIN ĐIỀU CHUYỂN</h2><div className="two-fields"><label>Cửa hàng điều đi<select value={sourceStoreId} onChange={(event) => setSourceStoreId(event.target.value)}>{stores.filter((item) => item.status === "ACTIVE").map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Chọn nhân viên<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Chọn nhân viên</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Cửa hàng nhận hỗ trợ<select value={targetStore} onChange={(event) => setTargetStore(event.target.value)}>{stores.filter((item) => item.id !== sourceStoreId && item.status === "ACTIVE").map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Ngày bắt đầu<input type="date" value={start} onChange={(event) => setStart(event.target.value)}/></label><label>Ngày kết thúc<input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)}/></label></div><b className="field-label">Ca làm việc áp dụng</b><div className="shift-checks">{["Ca sáng", "Ca chiều", "Ca tối", "Cả ngày"].map((item) => <label key={item}><input type="checkbox" checked={shifts.includes(item)} onChange={() => toggleShift(item)}/>{item}</label>)}</div><label>Lý do điều chuyển<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Nhập lý do điều chuyển"/></label></section>
    <section className="manager-panel transfer-person"><h2>2. THÔNG TIN NHÂN VIÊN</h2><div className="transfer-profile"><i><UserRound size={30}/></i><div><small>{employee?.code ?? "NV000"}</small><strong>{employee?.name ?? "Chọn nhân viên"}</strong><span>{employee?.position ?? "Nhân viên bán hàng"}</span><em>Đang làm tại cửa hàng chính</em></div></div><p><Store size={15}/> Cửa hàng chính <b>{source?.name ?? employee?.store_name ?? "DORE"}</b></p><label>Lương hỗ trợ theo giờ (VNĐ)<input type="text" inputMode="numeric" value={hourlyRate} onChange={(event) => setHourlyRate(formatVndInput(event.target.value))}/></label><label>Phụ cấp hỗ trợ (VNĐ)<input type="text" inputMode="numeric" value={allowance} onChange={(event) => setAllowance(formatVndInput(event.target.value))}/></label></section>
    <section className="transfer-policy-card"><h2>3. QUYỀN TRUY CẬP HỆ THỐNG</h2><p><ShieldCheck/> <span><b>Được đăng nhập hệ thống của cửa hàng hỗ trợ</b><small>Quyền tại cửa hàng nhận được kích hoạt trong thời gian hỗ trợ.</small></span></p><p><XCircle/> <span><b>Thu hồi quyền sau khi kết thúc thời gian hỗ trợ</b><small>Tự động trả quyền đăng nhập về cửa hàng chính.</small></span></p></section>
    <section className="transfer-policy-card"><h2>4. CHÍNH SÁCH LƯƠNG & PHỤ CẤP</h2><p><BadgeDollarSign/> <span><b>Lương, thưởng và phụ cấp</b><small>Được tính cho cửa hàng nhận hỗ trợ.</small></span></p><p><BarChart3/> <span><b>Ghi nhận chi phí</b><small>Chi phí nhân sự được đưa vào báo cáo cửa hàng nhận.</small></span></p></section>
    </div>
    <div className="transfer-submit-row"><button className="primary-button transfer-submit" disabled={saving} onClick={save}><CheckCircle2 size={18}/>{saving ? "ĐANG XỬ LÝ..." : "ĐIỀU CHUYỂN"}</button></div>
    {message && <div className={message.startsWith("✓") ? "success-banner" : "form-message"}>{message}</div>}
    <section className="manager-panel table-panel"><div className="panel-title"><h2>LỊCH SỬ ĐIỀU CHUYỂN</h2><span>{transfers.length} bản ghi</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Thời gian hỗ trợ</th><th>Nhân viên</th><th>Cửa hàng điều đi</th><th>Cửa hàng hỗ trợ</th><th>Ca làm việc</th><th>Lương/giờ</th><th>Phụ cấp</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{transfers.length === 0 ? <tr><td colSpan={9} className="empty-cell">Chưa có lịch sử điều chuyển.</td></tr> : transfers.map((record) => <tr key={record.id}><td>{record.start_date} → {record.end_date}</td><td><b>{record.employee_code} · {record.employee_name}</b></td><td>{record.source_store_name}</td><td>{record.target_store_name}</td><td>{record.shifts.join(", ") || "—"}</td><td>{money(record.support_hourly_rate)}</td><td>{money(record.support_allowance)}</td><td><span className={`status-pill transfer-${record.status.toLowerCase()}`}>{statusLabel(record.status)}</span></td><td><div className="row-actions">{!["COMPLETED", "CANCELLED"].includes(record.status) && <><button onClick={() => updateStatus(record, "END")}>Kết thúc</button><button className="danger" onClick={() => updateStatus(record, "CANCEL")}>Hủy</button></>}</div></td></tr>)}</tbody></table></div></section>
  </div>;
}

export function ReferenceManagerDividend({ totals }: { totals: { revenue: number; expense: number; profit: number } }) {
  void totals;
  return <ManagerProfitSharingClosing />;
}
