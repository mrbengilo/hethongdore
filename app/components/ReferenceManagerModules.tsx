"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeDollarSign, BarChart3, CheckCircle2, ShieldCheck, Store, UserRound, XCircle } from "lucide-react";
import { formatVndInput, parseVndInput } from "../lib/format";

export type ReferenceStore = { id: string; name: string; address: string; revenue: number; expense: number; profit: number; status: string };
type Employee = { id: string; code: string; name: string; position: string; phone: string; hourly_rate: number; store_id: string; store_name?: string; status: string };
type EmployeeTransfer = { id: string; employee_id: string; employee_code: string; employee_name: string; employee_position: string; source_store_id: string; source_store_name: string; target_store_id: string; target_store_name: string; start_date: string; end_date: string; shifts: string[]; support_hourly_rate: number; support_allowance: number; reason: string; status: "SCHEDULED" | "ACTIVE" | "COMPLETED" | "CANCELLED"; created_by_name?: string };

const money = (value: number) => `${new Intl.NumberFormat("en-US").format(Math.round(value))} đồng`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

export function ReferenceManagerTransfer({ stores }: { stores: ReferenceStore[] }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [transfers, setTransfers] = useState<EmployeeTransfer[]>([]);
  const [sourceStoreId, setSourceStoreId] = useState(stores.find((store) => store.status === "ACTIVE")?.id ?? stores[0]?.id ?? "");
  const [employeeId, setEmployeeId] = useState("");
  const [targetStore, setTargetStore] = useState(stores[1]?.id ?? stores[0]?.id ?? "");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [hourlyRate, setHourlyRate] = useState("0");
  const [allowance, setAllowance] = useState("0");
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
      const next = (result.employees ?? []).filter((item: Employee) => item.status === "ACTIVE");
      setEmployees(next);
      setEmployeeId((current) => next.some((item: Employee) => item.id === current) ? current : next[0]?.id ?? "");
    });
  }, [sourceStoreId]);
  useEffect(() => { reload(); }, [reload]);
  const employee = employees.find((item) => item.id === employeeId);
  const source = stores.find((item) => item.id === sourceStoreId);
  const target = stores.find((item) => item.id === targetStore);
  useEffect(() => {
    setHourlyRate(employee ? formatVndInput(employee.hourly_rate) : "0");
    setAllowance("0");
  }, [employee]);
  useEffect(() => {
    if (!targetStore || targetStore === sourceStoreId) setTargetStore(stores.find((item) => item.id !== sourceStoreId && item.status === "ACTIVE")?.id ?? "");
  }, [sourceStoreId, stores, targetStore]);
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
    <section className="manager-panel transfer-person"><h2>2. THÔNG TIN NHÂN VIÊN</h2><div className="transfer-profile"><i><UserRound size={30}/></i><div><small>{employee?.code ?? "—"}</small><strong>{employee?.name ?? "Chọn nhân viên"}</strong><span>{employee?.position ?? "—"}</span><em>Đang làm tại cửa hàng chính</em></div></div><p><Store size={15}/> Cửa hàng chính <b>{source?.name ?? employee?.store_name ?? "—"}</b></p><label>Lương hỗ trợ theo giờ (VNĐ)<input type="text" inputMode="numeric" value={hourlyRate} onChange={(event) => setHourlyRate(formatVndInput(event.target.value))}/></label><label>Phụ cấp hỗ trợ (VNĐ)<input type="text" inputMode="numeric" value={allowance} onChange={(event) => setAllowance(formatVndInput(event.target.value))}/></label></section>
    <section className="transfer-policy-card"><h2>3. QUYỀN TRUY CẬP HỆ THỐNG</h2><p><ShieldCheck/> <span><b>Được đăng nhập hệ thống của cửa hàng hỗ trợ</b><small>Quyền tại cửa hàng nhận được kích hoạt trong thời gian hỗ trợ.</small></span></p><p><XCircle/> <span><b>Thu hồi quyền sau khi kết thúc thời gian hỗ trợ</b><small>Tự động trả quyền đăng nhập về cửa hàng chính.</small></span></p></section>
    <section className="transfer-policy-card"><h2>4. CHÍNH SÁCH LƯƠNG & PHỤ CẤP</h2><p><BadgeDollarSign/> <span><b>Lương, thưởng và phụ cấp</b><small>Được tính cho cửa hàng nhận hỗ trợ.</small></span></p><p><BarChart3/> <span><b>Ghi nhận chi phí</b><small>Chi phí nhân sự được đưa vào báo cáo cửa hàng nhận.</small></span></p></section>
    </div>
    <div className="transfer-submit-row"><button className="primary-button transfer-submit" disabled={saving} onClick={save}><CheckCircle2 size={18}/>{saving ? "ĐANG XỬ LÝ..." : "ĐIỀU CHUYỂN"}</button></div>
    {message && <div className={message.startsWith("✓") ? "success-banner" : "form-message"}>{message}</div>}
    <section className="manager-panel table-panel"><div className="panel-title"><h2>LỊCH SỬ ĐIỀU CHUYỂN</h2><span>{transfers.length} bản ghi</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Thời gian hỗ trợ</th><th>Nhân viên</th><th>Cửa hàng điều đi</th><th>Cửa hàng hỗ trợ</th><th>Ca làm việc</th><th>Lương/giờ</th><th>Phụ cấp</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{transfers.length === 0 ? <tr><td colSpan={9} className="empty-cell">Chưa có lịch sử điều chuyển.</td></tr> : transfers.map((record) => <tr key={record.id}><td>{record.start_date} → {record.end_date}</td><td><b>{record.employee_code} · {record.employee_name}</b></td><td>{record.source_store_name}</td><td>{record.target_store_name}</td><td>{record.shifts.join(", ") || "—"}</td><td>{money(record.support_hourly_rate)}</td><td>{money(record.support_allowance)}</td><td><span className={`status-pill transfer-${record.status.toLowerCase()}`}>{statusLabel(record.status)}</span></td><td><div className="row-actions">{!["COMPLETED", "CANCELLED"].includes(record.status) && <><button onClick={() => updateStatus(record, "END")}>Kết thúc</button><button className="danger" onClick={() => updateStatus(record, "CANCEL")}>Hủy</button></>}</div></td></tr>)}</tbody></table></div></section>
  </div>;
}
