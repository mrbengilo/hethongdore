"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Notice } from "./shared";
import type { Assignment, ScheduleEmployee } from "./ShiftSchedulePanel";
import { assignmentLabel } from "./ShiftSchedulePanel";

type SwapRequest = {
  storeId: string; date: string; assignmentAId: string; assignmentBId: string;
  expectedVersionA: number; expectedVersionB: number; idempotencyKey: string; reason: string;
};

export default function ShiftSwapPanel({ actorId, storeId, date, employees, assignments, onChanged, onPending }: {
  actorId: string; storeId: string; date: string; employees: ScheduleEmployee[]; assignments: Assignment[];
  onChanged: (rows: Assignment[]) => void; onPending: (pending: boolean) => void;
}) {
  const [employeeA, setEmployeeA] = useState("");
  const [employeeB, setEmployeeB] = useState("");
  const [assignmentA, setAssignmentA] = useState("");
  const [assignmentB, setAssignmentB] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<SwapRequest | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const inFlight = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const storageKey = `dore-shift-swap:${actorId}:${storeId}:${date}`;

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const request = JSON.parse(saved) as SwapRequest;
        if (request.storeId === storeId && request.date === date && request.idempotencyKey) {
          setPending(request);
          setMessage("Có yêu cầu chưa xác định kết quả. Bấm Thử lại để nhận kết quả đã lưu; hệ thống không đổi ca lần thứ hai.");
        }
      }
    } catch { /* Storage is optional; the in-memory request still protects retries. */ }
  }, [storageKey, storeId, date]);

  useEffect(() => { onPending(Boolean(pending) || sending); }, [onPending, pending, sending]);
  useEffect(() => { if (message) feedback.current?.focus(); }, [message, assignments]);

  const rowsA = assignments.filter((row) => row.employee_id === employeeA && row.status === "PLANNED");
  const rowsB = assignments.filter((row) => row.employee_id === employeeB && row.status === "PLANNED");
  const selectedA = rowsA.find((row) => row.id === assignmentA);
  const selectedB = rowsB.find((row) => row.id === assignmentB);
  const name = (id: string) => { const employee = employees.find((item) => item.id === id); return employee ? `${employee.code} · ${employee.name}` : id; };

  function chooseEmployee(side: "A" | "B", id: string) {
    const rows = assignments.filter((row) => row.employee_id === id && row.status === "PLANNED");
    // Multiple shifts require a deliberate choice; array order is never a business decision.
    const selected = rows.length === 1 ? rows[0].id : "";
    if (side === "A") { setEmployeeA(id); setAssignmentA(selected); }
    else { setEmployeeB(id); setAssignmentB(selected); }
    setMessage(""); setSuccess(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!pending && (!selectedA || !selectedB || employeeA === employeeB)) return;
    const payload = pending ?? {
      storeId, date, assignmentAId: selectedA!.id, assignmentBId: selectedB!.id,
      expectedVersionA: selectedA!.version, expectedVersionB: selectedB!.version,
      idempotencyKey: crypto.randomUUID(), reason: reason.trim(),
    };
    inFlight.current = true; setSending(true); setSuccess(false); setMessage(""); setPending(payload);
    // Persist before sending: a timeout or a reload must replay the identical operation.
    try { sessionStorage.setItem(storageKey, JSON.stringify(payload)); } catch { /* Retry remains available in this view. */ }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch("/api/shift-swaps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      const result = await response.json();
      if (response.status >= 500) throw new Error("unknown-result");
      setPending(null);
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
      if (!response.ok) {
        setMessage(`${result.message ?? "Không thể đổi ca."}${response.status === 409 ? " Tải lại lịch rồi chọn lại hai ca." : ""}`);
        if (response.status === 409) { setAssignmentA(""); setAssignmentB(""); onChanged([]); }
        return;
      }
      const rows = result.assignments as Assignment[];
      setSuccess(true);
      setMessage(`Đổi ca thành công. ${rows.map((row) => `${name(row.employee_id)}: ${assignmentLabel(row)}`).join("; ")}. Mã thao tác: ${result.operationId}.`);
      setEmployeeA(""); setEmployeeB(""); setAssignmentA(""); setAssignmentB(""); setReason("");
      onChanged(rows);
    } catch {
      setMessage("Chưa xác định kết quả do mất kết nối hoặc hết thời gian chờ. Giữ nguyên yêu cầu và bấm Thử lại; không tạo thao tác mới.");
    } finally {
      window.clearTimeout(timer); inFlight.current = false; setSending(false);
      window.setTimeout(() => feedback.current?.focus(), 0);
    }
  }

  return <form className="op-form" onSubmit={submit} aria-label="Đổi ca">
    <Notice>Chỉ đổi đúng hai phân công trong cùng ngày và cửa hàng. Ca đã bắt đầu, có chấm công hoặc thuộc kỳ đã khóa sẽ bị chặn.</Notice>
    {!assignments.some((row) => row.status === "PLANNED") && <p role="status">Ngày này chưa có phân công dự kiến để đổi. Mở tab Lịch phân ca để thêm phân công.</p>}
    <fieldset className="op-schedule-fieldset" disabled={sending || Boolean(pending)}>
      <div className="op-swap-grid">
        <div className="op-swap-person">
          <h3>Nhân viên cần đổi</h3>
          <label htmlFor="swap-employee-a">Nhân viên A<select id="swap-employee-a" value={employeeA} onChange={(event) => chooseEmployee("A", event.target.value)} required><option value="">Chọn nhân viên</option>{employees.map((employee) => <option key={employee.id} value={employee.id} disabled={employee.id === employeeB}>{employee.code} · {employee.name}</option>)}</select></label>
          <label htmlFor="swap-assignment-a">Ca cần đổi của A<select id="swap-assignment-a" aria-describedby={selectedA ? "swap-selected-a" : undefined} value={assignmentA} onChange={(event) => setAssignmentA(event.target.value)} disabled={!rowsA.length} required><option value="">Chọn chính xác ca cần đổi</option>{rowsA.map((row) => <option key={row.id} value={row.id}>{assignmentLabel(row)}</option>)}</select></label>
          {selectedA && <p id="swap-selected-a" className="op-swap-selected">Ca đã chọn: {assignmentLabel(selectedA)}</p>}
          {employeeA && !rowsA.length && <p>Nhân viên A không có ca dự kiến trong ngày này.</p>}
          {rowsA.length > 1 && !assignmentA && <p>A có nhiều ca. Bạn cần chọn một ca.</p>}
        </div>
        <div className="op-swap-person">
          <h3>Nhân viên đổi</h3>
          <label htmlFor="swap-employee-b">Nhân viên B<select id="swap-employee-b" value={employeeB} onChange={(event) => chooseEmployee("B", event.target.value)} required><option value="">Chọn nhân viên</option>{employees.map((employee) => <option key={employee.id} value={employee.id} disabled={employee.id === employeeA}>{employee.code} · {employee.name}</option>)}</select></label>
          <label htmlFor="swap-assignment-b">Ca cần đổi của B<select id="swap-assignment-b" aria-describedby={selectedB ? "swap-selected-b" : undefined} value={assignmentB} onChange={(event) => setAssignmentB(event.target.value)} disabled={!rowsB.length} required><option value="">Chọn chính xác ca cần đổi</option>{rowsB.map((row) => <option key={row.id} value={row.id}>{assignmentLabel(row)}</option>)}</select></label>
          {selectedB && <p id="swap-selected-b" className="op-swap-selected">Ca đã chọn: {assignmentLabel(selectedB)}</p>}
          {employeeB && !rowsB.length && <p>Nhân viên B không có ca dự kiến trong ngày này.</p>}
          {rowsB.length > 1 && !assignmentB && <p>B có nhiều ca. Bạn cần chọn một ca.</p>}
        </div>
      </div>
      {selectedA && selectedB && <div className="op-swap-preview" aria-label="Kết quả dự kiến"><strong>Kết quả dự kiến</strong><p>{name(employeeA)}: {assignmentLabel(selectedA)} → {assignmentLabel(selectedB)}</p><p>{name(employeeB)}: {assignmentLabel(selectedB)} → {assignmentLabel(selectedA)}</p></div>}
      <label htmlFor="swap-reason">Lý do / ghi chú (không bắt buộc)<textarea id="swap-reason" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ví dụ: thay đổi thời gian làm việc theo đề nghị của hai nhân viên" /></label>
    </fieldset>
    <div ref={feedback} tabIndex={-1} role="status" aria-live="polite" className="op-schedule-feedback">{message && <Notice kind={success ? "success" : "warning"}>{message}</Notice>}</div>
    <div className="op-schedule-actions"><button className="op-primary" type="submit" disabled={sending || (!pending && (!selectedA || !selectedB || employeeA === employeeB))}>{sending ? "Đang đổi ca…" : pending ? "Thử lại yêu cầu đổi ca" : "Đổi ca"}</button>{!pending && (!selectedA || !selectedB) && <span>Chọn đủ hai nhân viên và hai ca để tiếp tục.</span>}</div>
  </form>;
}
