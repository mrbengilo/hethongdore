"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRightLeft, CheckCircle2, RefreshCw } from "lucide-react";
import { ActionButton } from "./ActionFeedback";
import { notifyAction } from "../lib/action-feedback";
import styles from "./StoreShiftSwapPanel.module.css";

type Employee = { id: string; name: string; code: string };
type Assignment = {
  id: string; recordId: string; employeeId: string; shiftName: string;
  start: string; end: string; startAt: string; endAt: string; workDate: string;
  version: string; eligible: boolean; blockedReason?: string | null;
};
type ScheduleResponse = { actorId: string; employees: Employee[]; assignments: Assignment[]; serverTime: string };
type SwapRequest = {
  storeId: string; date: string; assignmentAId: string; assignmentBId: string;
  expectedVersionA: string; expectedVersionB: string; expectedActorId: string; idempotencyKey: string; reason: string;
};
type PendingSwap = {
  actorId: string; request: SwapRequest;
  before: [Assignment, Assignment]; employees: [Employee, Employee];
};
type SwapReceipt = { operationId: string; assignments: Assignment[]; employees: Employee[] };
type Props = {
  store: { id: string; name: string; status?: string };
  date: string;
  onCompleted: () => Promise<unknown> | void;
};

function storageKey(actorId: string, storeId: string, date: string) {
  return `dore:pending-shift-swap:${encodeURIComponent(actorId)}:${encodeURIComponent(storeId)}:${date}`;
}

function readPending(actorId: string, storeId: string, date: string): PendingSwap | null {
  const key = storageKey(actorId, storeId, date);
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingSwap;
    if (value.actorId !== actorId || value.request?.storeId !== storeId || value.request?.date !== date
      || value.request.expectedActorId !== actorId
      || typeof value.request.idempotencyKey !== "string" || typeof value.request.reason !== "string"
      || typeof value.request.assignmentAId !== "string" || typeof value.request.assignmentBId !== "string"
      || typeof value.request.expectedVersionA !== "string" || typeof value.request.expectedVersionB !== "string"
      || !Array.isArray(value.before) || value.before.length !== 2
      || value.before.some((entry) => !entry || typeof entry.shiftName !== "string" || typeof entry.start !== "string" || typeof entry.end !== "string")
      || !Array.isArray(value.employees) || value.employees.length !== 2
      || value.employees.some((employee) => !employee || typeof employee.id !== "string" || typeof employee.name !== "string")) return null;
    return value;
  } catch { return null; }
}

function shiftLabel(assignment: Assignment) {
  return `${assignment.shiftName} · ${assignment.start}–${assignment.end}${assignment.end <= assignment.start ? " · Qua đêm" : ""}`;
}

/** A keyed instance belongs to exactly one store and work date. */
export default function StoreShiftSwapPanel({ store, date, onCompleted }: Props) {
  const id = useId();
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [employeeAId, setEmployeeAId] = useState("");
  const [employeeBId, setEmployeeBId] = useState("");
  const [assignmentAId, setAssignmentAId] = useState("");
  const [assignmentBId, setAssignmentBId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<PendingSwap | null>(null);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<SwapReceipt | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const inactive = store.status === "INACTIVE";

  const reload = useCallback(async () => {
    const requestId = ++sequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLoadError("");
    setData(null);
    setEmployeeAId(""); setEmployeeBId(""); setAssignmentAId(""); setAssignmentBId("");
    try {
      const response = await fetch(`/api/shift-swaps?${new URLSearchParams({ storeId: store.id, date })}`, {
        cache: "no-store", signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Không có quyền hoặc không thể tải lịch đổi ca.");
      if (typeof payload.actorId !== "string" || !Array.isArray(payload.employees) || !Array.isArray(payload.assignments)) {
        throw new Error("Dữ liệu lịch không hợp lệ. Hãy tải lại trước khi đổi ca.");
      }
      if (!mounted.current || controller.signal.aborted || requestId !== sequence.current) return;
      setData(payload as ScheduleResponse);
      setPending(readPending(payload.actorId, store.id, date));
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || requestId !== sequence.current) return;
      setLoadError(failure instanceof Error ? failure.message : "Không thể tải lịch đổi ca.");
    } finally {
      if (mounted.current && !controller.signal.aborted && requestId === sequence.current) setLoading(false);
    }
  }, [store.id, date]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; loadController.current?.abort(); };
  }, [reload]);

  const assignmentsA = useMemo(() => data?.assignments.filter((entry) => entry.employeeId === employeeAId) ?? [], [data, employeeAId]);
  const assignmentsB = useMemo(() => data?.assignments.filter((entry) => entry.employeeId === employeeBId) ?? [], [data, employeeBId]);
  const selectedA = assignmentsA.find((entry) => entry.id === assignmentAId);
  const selectedB = assignmentsB.find((entry) => entry.id === assignmentBId);
  const employeeA = data?.employees.find((employee) => employee.id === employeeAId);
  const employeeB = data?.employees.find((employee) => employee.id === employeeBId);
  const sameShift = Boolean(selectedA && selectedB && selectedA.startAt === selectedB.startAt && selectedA.endAt === selectedB.endAt);
  const validChoice = Boolean(selectedA?.eligible && selectedB?.eligible && employeeA && employeeB
    && employeeAId !== employeeBId && assignmentAId !== assignmentBId && !sameShift);
  const disabled = loading || Boolean(loadError) || sending || Boolean(pending) || inactive;

  function chooseEmployee(side: "A" | "B", employeeId: string) {
    setError(""); setReceipt(null);
    const assignments = data?.assignments.filter((entry) => entry.employeeId === employeeId) ?? [];
    // Never guess a shift when an employee has several assignments, even if
    // only one of them is currently eligible.
    const single = assignments.length === 1 && assignments[0].eligible ? assignments[0].id : "";
    if (side === "A") { setEmployeeAId(employeeId); setAssignmentAId(single); }
    else { setEmployeeBId(employeeId); setAssignmentBId(single); }
  }

  async function sendSwap(saved: PendingSwap) {
    if (inFlight.current || !data || saved.actorId !== data.actorId) return;
    const recovering = Boolean(pending);
    inFlight.current = true;
    setSending(true); setError(""); setReceipt(null);
    const key = storageKey(saved.actorId, saved.request.storeId, saved.request.date);
    // Save the exact key and payload BEFORE sending. A lost response, tab
    // change or reload must replay this operation, never construct its inverse.
    try { sessionStorage.setItem(key, JSON.stringify(saved)); }
    catch {
      setError("Trình duyệt không lưu được mã yêu cầu. Chưa gửi đổi ca; hãy cho phép lưu dữ liệu phiên rồi thử lại.");
      setSending(false); inFlight.current = false; return;
    }
    setPending(saved);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch("/api/shift-swaps", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saved.request), signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!payload || (!response.ok && ![400, 401, 403, 404, 409, 422].includes(response.status))) {
        throw new Error("Chưa xác nhận được kết quả từ máy chủ.");
      }
      if (!response.ok) {
        // Permission loss after an unknown result cannot prove that the
        // original attempt did not commit. Keep its receipt request for this
        // actor, but clear visible data until access is verified again.
        if (recovering && [401, 403].includes(response.status)) {
          if (!mounted.current) return;
          setPending(null);
          setError("Chưa xác minh được yêu cầu trước vì phiên đăng nhập hoặc quyền đã thay đổi. Đăng nhập lại tài khoản có quyền rồi kiểm tra yêu cầu cũ.");
          await reload();
          return;
        }
        sessionStorage.removeItem(key);
        if (!mounted.current) return;
        setPending(null);
        setError(payload.message || "Không thể đổi ca. Hãy tải lại lịch và kiểm tra lựa chọn.");
        setAssignmentAId(""); setAssignmentBId("");
        if (response.status === 409 || response.status === 401 || response.status === 403) await reload();
        return;
      }
      if (payload.ok !== true || typeof payload.operationId !== "string" || !Array.isArray(payload.assignments)
        || payload.assignments.length !== 2) throw new Error("Máy chủ chưa trả đầy đủ kết quả đổi ca.");
      sessionStorage.removeItem(key);
      // Refresh the owning schedule even if the user switched back to its tab
      // while the POST was pending. Detached panel state must not be updated.
      const refreshSchedule = Promise.resolve().then(onCompleted);
      if (!mounted.current) { await refreshSchedule.catch(() => undefined); return; }
      setPending(null);
      setReceipt({ operationId: payload.operationId, assignments: payload.assignments, employees: saved.employees });
      setReason(""); setError("");
      notifyAction("Đã đổi ca thành công. Lịch phân ca đã được cập nhật.");
      await Promise.all([reload(), refreshSchedule.catch(() => {
        if (mounted.current) setError("Đổi ca đã thành công, nhưng chưa tải lại được bảng lịch. Hãy dùng Tải lại lịch để cập nhật.");
      })]);
    } catch {
      if (mounted.current) setError("Chưa xác định được kết quả đổi ca. Dùng nút Kiểm tra lại yêu cầu để gửi lại đúng mã cũ; hệ thống sẽ không đổi ca lần thứ hai.");
    } finally {
      window.clearTimeout(timeout);
      inFlight.current = false;
      if (mounted.current) { setSending(false); statusRef.current?.focus(); }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !validChoice || !selectedA || !selectedB || !employeeA || !employeeB || !data) return;
    const businessReason = reason.trim() || "Đổi ca theo phân công của quản lý";
    if (businessReason.length < 5 || businessReason.length > 500) {
      setError("Lý do cần từ 5 đến 500 ký tự, hoặc để trống để dùng lý do đổi ca của quản lý."); return;
    }
    await sendSwap({
      actorId: data.actorId, before: [selectedA, selectedB], employees: [employeeA, employeeB],
      request: { storeId: store.id, date, assignmentAId: selectedA.id, assignmentBId: selectedB.id,
        expectedVersionA: selectedA.version, expectedVersionB: selectedB.version,
        expectedActorId: data.actorId,
        idempotencyKey: crypto.randomUUID(), reason: businessReason },
    });
  }

  function employeeChoice(side: "A" | "B", value: string, otherId: string, assignments: Assignment[], selectedId: string) {
    const employee = data?.employees.find((entry) => entry.id === value);
    return <fieldset className={styles.person} disabled={disabled}>
      <legend>{side === "A" ? "Nhân viên cần đổi" : "Nhân viên đổi cùng"}</legend>
      <label htmlFor={`${id}-employee-${side}`}>Chọn nhân viên {side}</label>
      <select id={`${id}-employee-${side}`} value={value} onChange={(event) => chooseEmployee(side, event.target.value)} required>
        <option value="">Chọn nhân viên…</option>
        {data?.employees.filter((entry) => entry.id !== otherId).map((entry) => <option key={entry.id} value={entry.id}>{entry.code} · {entry.name}</option>)}
      </select>
      {employee && <p className={styles.employeeName}>{employee.code} · {employee.name}</p>}
      {!value ? <p className={styles.hint}>Chọn nhân viên để xem các ca đã phân trong ngày.</p>
        : assignments.length === 0 ? <p className={styles.hint} role="status">Nhân viên chưa có ca trong ngày này.</p>
          : <fieldset className={styles.assignmentList}>
            <legend>{assignments.length > 1 ? `Chọn chính xác một trong ${assignments.length} ca` : "Ca đã phân trong ngày"}</legend>
            {assignments.map((entry) => <label key={entry.id} className={`${styles.assignment} ${selectedId === entry.id ? styles.selected : ""}`}>
              <input type="radio" name={`${id}-assignment-${side}`} value={entry.id} checked={selectedId === entry.id} disabled={!entry.eligible}
                onChange={() => { if (side === "A") setAssignmentAId(entry.id); else setAssignmentBId(entry.id); setReceipt(null); setError(""); }}/>
              <span><b>{entry.shiftName}</b><span>{entry.start}–{entry.end}{entry.end <= entry.start ? " · Qua đêm" : ""}</span>
                {!entry.eligible && <small>{entry.blockedReason || "Ca này không còn đủ điều kiện đổi."}</small>}</span>
            </label>)}
          </fieldset>}
    </fieldset>;
  }

  return <section className={styles.panel} aria-label="Đổi ca giữa hai nhân viên" aria-busy={sending || loading}>
    <header className={styles.heading}><div><h3>Đổi ca</h3><p>Chọn hai nhân viên và đúng ca cần đổi tại {store.name}. Các ca khác được giữ nguyên.</p></div>
      <ActionButton type="button" className={styles.secondary} disabled={sending || loading || Boolean(pending)} onClick={() => reload()}><RefreshCw size={16} aria-hidden="true"/> Tải lại lịch</ActionButton>
    </header>
    <p className={styles.rule}>Chỉ đổi lịch dự kiến chưa bắt đầu, chưa chấm công và chưa khóa kỳ. Giờ hiển thị theo Việt Nam.</p>
    <div ref={statusRef} tabIndex={-1} className={styles.status}>
      {loading && <p role="status">Đang tải nhân viên và lịch phân ca…</p>}
      {loadError && <p className={styles.error} role="alert">{loadError}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {receipt && <div className={styles.success} role="status"><b><CheckCircle2 size={18} aria-hidden="true"/> Đổi ca thành công</b>
        {receipt.assignments.map((entry) => <p key={entry.id}>{receipt.employees.find((employee) => employee.id === entry.employeeId)?.name ?? "Nhân viên"}: {shiftLabel(entry)}</p>)}
        <small>Mã thao tác: {receipt.operationId}</small></div>}
    </div>
    {pending && <div className={styles.pending} role="status"><h4>{sending ? "Đang xác nhận đổi ca…" : "Có yêu cầu cần xác nhận kết quả"}</h4>
      <p>{pending.employees[0].name}: {shiftLabel(pending.before[0])} ↔ {pending.employees[1].name}: {shiftLabel(pending.before[1])}</p>
      <p>Giữ nguyên yêu cầu này để kiểm tra kết quả an toàn, kể cả khi lần gửi trước đã thành công.</p>
      <ActionButton type="button" className={styles.primary} disabled={sending || loading || Boolean(loadError)} busy={sending} onClick={() => sendSwap(pending)}>{sending ? "Đang xử lý…" : "Kiểm tra lại yêu cầu"}</ActionButton>
    </div>}
    {!loading && !loadError && !pending && data?.assignments.length === 0 && <p className={styles.empty} role="status">Ngày này chưa có phân công. Hãy tạo lịch trong tab Lịch phân ca trước khi đổi ca.</p>}
    {!pending && <form onSubmit={submit}>
      <div className={styles.people}>
        {employeeChoice("A", employeeAId, employeeBId, assignmentsA, assignmentAId)}
        {employeeChoice("B", employeeBId, employeeAId, assignmentsB, assignmentBId)}
      </div>
      {sameShift && <p className={styles.error} role="alert">Hai ca có cùng thời gian; đổi như vậy không làm thay đổi lịch. Hãy chọn hai ca khác nhau.</p>}
      {selectedA && selectedB && employeeA && employeeB && <div className={styles.preview} aria-label="Xem trước lịch sau đổi"><h4><ArrowRightLeft size={18} aria-hidden="true"/> Lịch sau khi đổi</h4>
        <div><p><b>{employeeA.name}</b><span>Từ {shiftLabel(selectedA)}</span><strong>Sang {shiftLabel(selectedB)}</strong></p>
          <p><b>{employeeB.name}</b><span>Từ {shiftLabel(selectedB)}</span><strong>Sang {shiftLabel(selectedA)}</strong></p></div>
        <small>Chỉ hai phân công đã chọn thay đổi người làm. Các phân công khác và lịch sử chấm công được giữ nguyên.</small></div>}
      <label className={styles.reason} htmlFor={`${id}-reason`}>Lý do hoặc ghi chú (không bắt buộc)
        <textarea id={`${id}-reason`} maxLength={500} value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} placeholder="Ví dụ: Hai nhân viên thống nhất đổi ca trong ngày"/>
      </label>
      <div className={styles.submitRow}><p>{validChoice ? "Kiểm tra lịch sau đổi rồi xác nhận." : "Chọn đủ hai nhân viên và hai ca hợp lệ để tiếp tục."}</p>
        <ActionButton type="submit" className={styles.primary} disabled={disabled || !validChoice} busy={sending}><ArrowRightLeft size={18} aria-hidden="true"/> Đổi ca</ActionButton></div>
    </form>}
  </section>;
}
