"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { BusinessRecord, createRecord, dateTime24, money, Notice, Panel, StoreFinance } from "./shared";

type PayrollResponse = { summary: StoreFinance; period: BusinessRecord | null; history: BusinessRecord[] };

export default function PayrollPanel({ store, month, onChanged }: { store: StoreFinance; month: string; onChanged: () => Promise<void> | void }) {
  const [summary, setSummary] = useState<StoreFinance>(store);
  const [period, setPeriod] = useState<BusinessRecord | null>(null);
  const [history, setHistory] = useState<BusinessRecord[]>([]);
  const [employeeId, setEmployeeId] = useState(store.employees[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/payroll?storeId=${encodeURIComponent(store.id)}&month=${encodeURIComponent(month)}`);
    const result = await response.json() as PayrollResponse & { message?: string };
    if (!response.ok) return setMessage(result.message ?? "Không thể tải bảng lương");
    setSummary(result.summary); setPeriod(result.period); setHistory(result.history ?? []);
    if (!employeeId && result.summary.employees[0]) setEmployeeId(result.summary.employees[0].id);
  }, [store.id, month, employeeId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSummary(store); }, [store]);

  const data = period?.data ?? {};
  const locked = period?.status === "LOCKED";
  const salaryConfirmed = Boolean(data.salaryConfirmedAt);
  const bonusConfirmed = Boolean(data.bonusAllowanceConfirmedAt);
  const paid = Boolean(data.paidAt);

  async function addAdjustment(event: FormEvent, category: "EMPLOYEE_BONUS" | "EMPLOYEE_ALLOWANCE") {
    event.preventDefault();
    const employee = summary.employees.find((item) => item.id === employeeId);
    const value = Number(amount || 0);
    if (!employee || value <= 0) return setMessage("Vui lòng chọn nhân viên và nhập số tiền lớn hơn 0.");
    if (locked) return setMessage("Kỳ đã khóa sổ, không thể thêm thưởng/phụ cấp.");
    try {
      await createRecord(category, store.id, `${category === "EMPLOYEE_BONUS" ? "Thưởng" : "Phụ cấp"} · ${employee.name}`, {
        period: month, employeeId: employee.id, employeeCode: employee.code, employeeName: employee.name,
        amount: value, note: note.trim(), createdAt: new Date().toISOString(),
      });
      setAmount(""); setNote(""); setMessage(`Đã lưu ${category === "EMPLOYEE_BONUS" ? "thưởng" : "phụ cấp"} cho ${employee.name}.`);
      await load(); await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Không thể lưu"); }
  }

  async function action(actionName: "CONFIRM_SALARY" | "CONFIRM_BONUS_ALLOWANCE" | "MARK_PAID" | "LOCK") {
    setBusy(true); setMessage("");
    const response = await fetch("/api/payroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeId: store.id, month, action: actionName }) });
    const result = await response.json();
    setBusy(false);
    if (!response.ok) return setMessage(result.message ?? "Không thể thực hiện thao tác");
    const messages: Record<string, string> = {
      CONFIRM_SALARY: "Đã xác nhận chi lương.",
      CONFIRM_BONUS_ALLOWANCE: "Đã xác nhận chi thưởng và phụ cấp.",
      MARK_PAID: "Đã ghi nhận đã chi toàn bộ lương, thưởng và phụ cấp.",
      LOCK: "Đã chốt sổ và khóa kỳ thanh toán.",
    };
    setMessage(messages[actionName]);
    await load(); await onChanged();
  }

  return <div className="op-stack">
    <div className="op-stats four">
      <div className="op-mini"><span>Tổng giờ nhân viên</span><b>{summary.totalHours.toFixed(2)} giờ</b></div>
      <div className="op-mini"><span>Lương nhân viên</span><b>{money(summary.expenseBreakdown.employeeSalary)}</b></div>
      <div className="op-mini"><span>Thưởng + phụ cấp phát sinh</span><b>{money(summary.expenseBreakdown.employeeBonus + summary.expenseBreakdown.employeeAllowance)}</b></div>
      <div className="op-mini"><span>Lợi nhuận cơ sở tính KPI</span><b>{money(summary.profit)}</b></div>
    </div>

    <Panel title={`Bảng lương & KPI · ${month}`}>
      <Notice>KPI chỉ được tính <b>sau khi</b> doanh thu trừ đủ: chi phí cố định, chi phí phát sinh, nhập hàng, vận chuyển, lương nhân viên, lương quản lý, thưởng và phụ cấp phát sinh. Ngưỡng KPI nhân viên giữ đúng công thức đã thiết lập: 3% / 5% / 7%; quản lý nhận 2% lợi nhuận dương.</Notice>
      <div className="op-table-wrap"><table><thead><tr><th>Nhân viên</th><th>Giờ làm</th><th>Lương</th><th>Thưởng phát sinh</th><th>Phụ cấp</th><th>KPI ({Math.round(summary.kpiRate * 100)}%)</th><th>Tổng nhận</th></tr></thead><tbody>{summary.employees.length === 0 ? <tr><td colSpan={7}>Chưa có dữ liệu ca làm trong kỳ.</td></tr> : summary.employees.map((employee) => <tr key={employee.id}><td><b>{employee.code}</b> · {employee.name}</td><td>{employee.hours.toFixed(2)}</td><td>{money(employee.salary)}</td><td>{money(employee.manualBonus)}</td><td>{money(employee.allowance)}</td><td>{money(employee.kpi)}</td><td><b>{money(employee.totalPay)}</b></td></tr>)}</tbody><tfoot><tr><td>Quản lý cửa hàng</td><td>—</td><td>{money(summary.manager.salary)}</td><td>—</td><td>—</td><td>{money(summary.manager.kpi)} (2%)</td><td><b>{money(summary.manager.totalPay)}</b></td></tr></tfoot></table></div>
    </Panel>

    <Panel title="Thưởng / phụ cấp phát sinh cho nhân viên">
      <form className="op-form-inline" onSubmit={(event) => event.preventDefault()}>
        <label>Nhân viên<select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>{summary.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.code} · {employee.name}</option>)}</select></label>
        <label>Số tiền<input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></label>
        <label>Ghi chú<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Lý do thưởng/phụ cấp" /></label>
        <div className="op-inline-actions"><button className="op-primary" disabled={locked} onClick={(event) => void addAdjustment(event, "EMPLOYEE_BONUS")}>LƯU THƯỞNG</button><button className="op-secondary" disabled={locked} onClick={(event) => void addAdjustment(event, "EMPLOYEE_ALLOWANCE")}>LƯU PHỤ CẤP</button></div>
      </form>
    </Panel>

    <Panel title="Xác nhận chi và khóa kỳ">
      <div className="op-close-grid">
        <div className={salaryConfirmed ? "done" : ""}><span>1</span><b>Xác nhận chi lương</b><small>{data.salaryConfirmedAt ? dateTime24(String(data.salaryConfirmedAt)) : "Chưa xác nhận"}</small><button className="op-secondary" disabled={salaryConfirmed || locked || busy} onClick={() => action("CONFIRM_SALARY")}>{salaryConfirmed ? "ĐÃ XÁC NHẬN" : "XÁC NHẬN CHI LƯƠNG"}</button></div>
        <div className={bonusConfirmed ? "done" : ""}><span>2</span><b>Xác nhận thưởng & phụ cấp</b><small>{data.bonusAllowanceConfirmedAt ? dateTime24(String(data.bonusAllowanceConfirmedAt)) : "Chưa xác nhận"}</small><button className="op-secondary" disabled={bonusConfirmed || locked || busy} onClick={() => action("CONFIRM_BONUS_ALLOWANCE")}>{bonusConfirmed ? "ĐÃ XÁC NHẬN" : "XÁC NHẬN THƯỞNG/PHỤ CẤP"}</button></div>
        <div className={paid ? "done" : ""}><span>3</span><b>Ghi nhận đã chi</b><small>{data.paidAt ? dateTime24(String(data.paidAt)) : "Chưa chi"}</small><button className="op-primary" disabled={!salaryConfirmed || !bonusConfirmed || paid || locked || busy} onClick={() => action("MARK_PAID")}>{paid ? "ĐÃ CHI" : "XÁC NHẬN ĐÃ CHI"}</button></div>
        <div className={locked ? "done locked" : ""}><span>4</span><b>Chốt sổ / khóa kỳ</b><small>{data.lockedAt ? dateTime24(String(data.lockedAt)) : "Kỳ còn mở"}</small><button className="op-lock" disabled={!paid || locked || busy} onClick={() => action("LOCK")}>{locked ? "ĐÃ KHÓA KỲ" : "CHỐT SỔ & KHÓA KỲ"}</button></div>
      </div>
      {message && <Notice kind={message.startsWith("Đã") ? "success" : "warning"}>{message}</Notice>}
    </Panel>

    <Panel title="Lịch sử kỳ chi">
      <div className="op-table-wrap"><table><thead><tr><th>Kỳ</th><th>Xác nhận lương</th><th>Xác nhận thưởng/phụ cấp</th><th>Đã chi</th><th>Khóa kỳ</th><th>Trạng thái</th></tr></thead><tbody>{history.length === 0 ? <tr><td colSpan={6}>Chưa có lịch sử chốt kỳ.</td></tr> : history.map((record) => <tr key={record.id}><td>{String(record.data.month ?? "")}</td><td>{record.data.salaryConfirmedAt ? dateTime24(String(record.data.salaryConfirmedAt)) : "—"}</td><td>{record.data.bonusAllowanceConfirmedAt ? dateTime24(String(record.data.bonusAllowanceConfirmedAt)) : "—"}</td><td>{record.data.paidAt ? dateTime24(String(record.data.paidAt)) : "—"}</td><td>{record.data.lockedAt ? dateTime24(String(record.data.lockedAt)) : "—"}</td><td><b>{record.status}</b></td></tr>)}</tbody></table></div>
    </Panel>
  </div>;
}
