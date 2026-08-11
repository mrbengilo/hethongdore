"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Banknote, CheckCircle2, Eye, Pencil, Plus, X } from "lucide-react";
import { formatDateTime24, formatDateVn, formatVndInput, parseVndInput } from "../lib/format";
import { DatePickerControl } from "./DatePickerControl";
import { useAccessibleModal } from "./useAccessibleModal";
import styles from "./SalaryAdvancePanel.module.css";

type SalaryAdvance = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  advanceDate: string;
  amount: number;
  grossEntitlementSnapshot: number;
  availableBeforeSnapshot: number;
  remainingAfterSnapshot: number;
  note: string;
  status: "DRAFT" | "PAID";
  version: number;
  createdByName: string;
  createdAt: string;
  updatedByName: string;
  updatedAt: string;
  paidByName: string | null;
  paidAt: string | null;
};

type EmployeeBalance = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  grossEntitlement: number;
  pendingAmount: number;
  paidAmount: number;
  reservedAmount: number;
  availableAmount: number;
  coverageGap: number;
  overpaymentDebt: number;
};

type AdvanceData = {
  storeId: string;
  period: string;
  serverNow: string;
  locked: boolean;
  advances: SalaryAdvance[];
  employees: EmployeeBalance[];
  totals: {
    pendingAmount: number;
    paidAmount: number;
    reservedAmount: number;
    availableAmount: number;
    coverageGap: number;
    overpaymentDebt: number;
  };
};

type ApiResult = Partial<AdvanceData> & {
  advance?: SalaryAdvance;
  message?: string;
};

type DialogMode = "CREATE" | "EDIT" | "VIEW";

const money = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đồng`;

function periodDefaultDate(period: string) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  return today.slice(0, 7) === period ? today : `${period}-01`;
}

export default function SalaryAdvancePanel({
  storeId,
  period,
  disabled = false,
  onUpdated,
}: {
  storeId: string;
  period: string;
  disabled?: boolean;
  onUpdated?: () => void | Promise<void>;
}) {
  const [data, setData] = useState<AdvanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [mode, setMode] = useState<DialogMode | null>(null);
  const [selected, setSelected] = useState<SalaryAdvance | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [advanceDate, setAdvanceDate] = useState(periodDefaultDate(period));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const requestIdRef = useRef("");
  const requestSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const scopeKey = `${storeId}\u0000${period}`;
  const scopeKeyRef = useRef(scopeKey);
  const modalRootRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLFormElement | null>(null);
  const initialFocusRef = useRef<HTMLSelectElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    try {
      const query = new URLSearchParams({ storeId, period });
      const response = await fetch(`/api/salary-advances?${query}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json() as ApiResult;
      if (!response.ok) throw new Error(result.message || "Không thể tải danh sách ứng lương.");
      if (requestId !== requestSequence.current || controller.signal.aborted) return;
      if (result.storeId !== storeId || result.period !== period || !result.advances || !result.employees || !result.totals) {
        throw new Error("Dữ liệu ứng lương phản hồi không đúng cửa hàng hoặc kỳ đã chọn.");
      }
      const freshData = result as AdvanceData;
      setData(freshData);
      setEmployeeId((current) => result.employees?.some((employee) => employee.employeeId === current)
        ? current
        : result.employees?.[0]?.employeeId ?? "");
      return freshData;
    } catch (error) {
      if (requestId !== requestSequence.current || controller.signal.aborted) return;
      setData(null);
      setSuccess(false);
      setMessage(error instanceof Error ? error.message : "Không thể tải danh sách ứng lương.");
      return null;
    } finally {
      if (loadController.current === controller) loadController.current = null;
      if (requestId === requestSequence.current && !controller.signal.aborted) setLoading(false);
    }
  }, [period, storeId]);

  useEffect(() => {
    scopeKeyRef.current = scopeKey;
  }, [scopeKey]);

  useEffect(() => {
    mutationController.current?.abort();
    mutationController.current = null;
    setBusy(false);
    setMode(null);
    setSelected(null);
    setMessage("");
    void load();
    return () => {
      loadController.current?.abort();
      mutationController.current?.abort();
    };
  }, [load]);

  const dismiss = useCallback(() => {
    if (busy) return;
    setMode(null);
    setSelected(null);
  }, [busy]);

  useAccessibleModal({
    open: mode !== null,
    rootRef: modalRootRef,
    dialogRef: modalRef,
    initialFocusRef,
    returnFocusRef,
    dismissDisabled: busy,
    onDismiss: dismiss,
  });

  const locked = Boolean(disabled || data?.locked);
  const selectedBalance = data?.employees.find((employee) => employee.employeeId === employeeId) ?? null;
  const currentCapacity = (selectedBalance?.availableAmount ?? 0)
    + (mode === "EDIT" && selected?.employeeId === employeeId ? selected.amount : 0);
  const maximumAmount = mode === "EDIT" && selected
    ? Math.min(currentCapacity, selected.availableBeforeSnapshot)
    : currentCapacity;
  const dialogCreatedAt = mode === "CREATE" ? data?.serverNow : selected?.createdAt;

  function rememberTrigger() {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  async function beginCreate() {
    if (locked || loading) return;
    rememberTrigger();
    const openingScope = scopeKey;
    const freshData = await load();
    if (!freshData || scopeKeyRef.current !== openingScope) return;
    setMode("CREATE");
    setSelected(null);
    setEmployeeId(freshData.employees[0]?.employeeId ?? "");
    setAdvanceDate(periodDefaultDate(period));
    setAmount("");
    setNote("");
    setMessage("");
    setSuccess(false);
    requestIdRef.current = crypto.randomUUID();
  }

  function beginEdit(advance: SalaryAdvance) {
    if (locked || advance.status !== "DRAFT") return;
    rememberTrigger();
    setMode("EDIT");
    setSelected(advance);
    setEmployeeId(advance.employeeId);
    setAdvanceDate(advance.advanceDate);
    setAmount(formatVndInput(advance.amount));
    setNote(advance.note);
    setMessage("");
    setSuccess(false);
  }

  function beginView(advance: SalaryAdvance) {
    rememberTrigger();
    setMode("VIEW");
    setSelected(advance);
    setEmployeeId(advance.employeeId);
    setAdvanceDate(advance.advanceDate);
    setAmount(formatVndInput(advance.amount));
    setNote(advance.note);
    setMessage("");
    setSuccess(false);
  }

  async function refreshAfterMutation(result: ApiResult, mutationScope: string) {
    if (scopeKeyRef.current !== mutationScope) return;
    setMode(null);
    setSelected(null);
    setSuccess(true);
    setMessage(`✓ ${result.message || "Đã cập nhật ứng lương."}`);
    await load();
    if (scopeKeyRef.current !== mutationScope) return;
    await onUpdated?.();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || locked || mode === "VIEW") return;
    const parsedAmount = parseVndInput(amount);
    if (!employeeId || !Number.isSafeInteger(parsedAmount) || parsedAmount <= 0 || parsedAmount >= maximumAmount) {
      setSuccess(false);
      setMessage(`Số tiền ứng phải lớn hơn 0 đồng và nhỏ hơn ${money(maximumAmount)}.`);
      return;
    }
    if (note.trim().length < 2) {
      setSuccess(false);
      setMessage("Vui lòng nhập nội dung ứng lương.");
      return;
    }
    const mutationScope = scopeKey;
    const mutationStoreId = storeId;
    const mutationPeriod = period;
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const creating = mode === "CREATE";
      const response = await fetch("/api/salary-advances", {
        method: creating ? "POST" : "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(creating ? { "Idempotency-Key": requestIdRef.current } : {}),
        },
        body: JSON.stringify(creating ? {
          storeId: mutationStoreId, period: mutationPeriod, employeeId, advanceDate, amount: parsedAmount, note: note.trim(),
          clientRequestId: requestIdRef.current,
        } : {
          id: selected?.id, storeId: mutationStoreId, version: selected?.version,
          advanceDate, amount: parsedAmount, note: note.trim(),
        }),
        signal: controller.signal,
      });
      const result = await response.json() as ApiResult;
      if (!response.ok) throw new Error(result.message || "Không thể lưu khoản ứng lương.");
      await refreshAfterMutation(result, mutationScope);
    } catch (error) {
      if (controller.signal.aborted || scopeKeyRef.current !== mutationScope) return;
      setSuccess(false);
      setMessage(error instanceof Error ? error.message : "Không thể lưu khoản ứng lương.");
    } finally {
      if (mutationController.current === controller) mutationController.current = null;
      if (scopeKeyRef.current === mutationScope) setBusy(false);
    }
  }

  async function confirmPayment(advance: SalaryAdvance) {
    if (busy || locked || advance.status !== "DRAFT") return;
    if (!window.confirm(`Xác nhận đã chi ${money(advance.amount)} ứng lương cho ${advance.employeeName}?`)) return;
    const mutationScope = scopeKey;
    const mutationStoreId = storeId;
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/salary-advances", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CONFIRM_PAYMENT",
          id: advance.id,
          storeId: mutationStoreId,
          version: advance.version,
        }),
        signal: controller.signal,
      });
      const result = await response.json() as ApiResult;
      if (!response.ok) throw new Error(result.message || "Không thể xác nhận chi khoản ứng lương.");
      await refreshAfterMutation(result, mutationScope);
    } catch (error) {
      if (controller.signal.aborted || scopeKeyRef.current !== mutationScope) return;
      setSuccess(false);
      setMessage(error instanceof Error ? error.message : "Không thể xác nhận chi khoản ứng lương.");
    } finally {
      if (mutationController.current === controller) mutationController.current = null;
      if (scopeKeyRef.current === mutationScope) setBusy(false);
    }
  }

  return <section className={styles.panel} aria-labelledby="salary-advance-title">
    <header className={styles.header}>
      <div>
        <h2 id="salary-advance-title">Lịch sử ứng lương của nhân viên</h2>
        <p>Khả dụng = lương thực tế + phụ cấp + thưởng − các khoản đã ứng.</p>
      </div>
      <button type="button" className={styles.primaryButton} disabled={locked || loading || busy} onClick={() => void beginCreate()}>
        <Plus size={17} aria-hidden="true"/> TẠO ỨNG LƯƠNG
      </button>
    </header>

    {message && mode === null ? <p className={success ? styles.success : styles.error} role={success ? "status" : "alert"}>{message}</p> : null}
    {locked ? <p className={styles.lockedNotice}>Kỳ lương đã bắt đầu chốt hoặc đã khóa. Danh sách chỉ còn chế độ xem.</p> : null}
    {(data?.totals.coverageGap ?? 0) > 0 ? <p className={styles.error} role="alert">
      Lương hiện tại đang thiếu {money(data?.totals.coverageGap ?? 0)} để bù các khoản ứng.
      {(data?.totals.overpaymentDebt ?? 0) > 0 ? ` Trong đó ${money(data?.totals.overpaymentDebt ?? 0)} đã chi vượt lương hiện tại.` : ""}
      {" "}Hệ thống đã chặn chốt và xác nhận chi lương cho đến khi đối soát xong.
    </p> : null}

    <div className={styles.metrics} aria-label="Tổng hợp ứng lương">
      <article><Banknote aria-hidden="true"/><span>Đang chờ chi</span><strong>{money(data?.totals.pendingAmount ?? 0)}</strong></article>
      <article><CheckCircle2 aria-hidden="true"/><span>Đã xác nhận chi</span><strong>{money(data?.totals.paidAmount ?? 0)}</strong></article>
      <article><Banknote aria-hidden="true"/><span>Còn khả dụng</span><strong>{money(data?.totals.availableAmount ?? 0)}</strong></article>
    </div>

    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus lets users scroll the wide salary-advance table. */}
    <div className={styles.tableWrap} role="region" tabIndex={0} aria-label="Danh sách ứng lương, có thể cuộn ngang">
      <table className={styles.table}>
        <thead><tr><th>STT</th><th>Thời gian tạo</th><th>Nhân viên</th><th>Số tiền ứng</th><th>Lương khả dụng tại lúc tạo</th><th>Lương còn lại sau ứng</th><th>Người tạo</th><th>Ghi chú</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={10} className={styles.empty}>Đang tải danh sách ứng lương…</td></tr>
            : data?.advances.length ? data.advances.map((advance, index) => <tr key={advance.id}>
              <td data-label="STT">{index + 1}</td>
              <td data-label="Thời gian tạo"><time dateTime={advance.createdAt}>{formatDateTime24(advance.createdAt, true)}</time><small>Ngày ứng: {formatDateVn(advance.advanceDate)}</small></td>
              <td data-label="Nhân viên"><b>{advance.employeeName}</b><small>{advance.employeeCode}</small></td>
              <td data-label="Số tiền ứng"><strong>{money(advance.amount)}</strong></td>
              <td data-label="Lương khả dụng tại lúc tạo">{money(advance.availableBeforeSnapshot)}</td>
              <td data-label="Lương còn lại sau ứng"><strong className={styles.remainingAmount}>{money(advance.remainingAfterSnapshot)}</strong></td>
              <td data-label="Người tạo">{advance.createdByName}</td>
              <td data-label="Ghi chú" className={styles.noteCell}>{advance.note}</td>
              <td data-label="Trạng thái"><span className={advance.status === "PAID" ? styles.paid : styles.pending}>{advance.status === "PAID" ? "Đã chi" : "Mới tạo"}</span></td>
              <td data-label="Thao tác"><div className={styles.actions}>
                {advance.status === "DRAFT" ?
                  <button type="button" disabled={locked || busy} aria-label={`Sửa khoản ứng của ${advance.employeeName}`} onClick={() => beginEdit(advance)}><Pencil size={16}/><span>Sửa</span></button>
                  : null}
                <button type="button" aria-label={`Xem chi tiết khoản ứng của ${advance.employeeName}`} onClick={() => beginView(advance)}><Eye size={16}/><span>Xem chi tiết</span></button>
                {advance.status === "DRAFT" ?
                  <button type="button" className={styles.confirmButton} disabled={locked || busy} onClick={() => void confirmPayment(advance)}><CheckCircle2 size={16}/><span>XÁC NHẬN CHI</span></button>
                  : null}
              </div></td>
            </tr>) : <tr><td colSpan={10} className={styles.empty}>Chưa có khoản ứng lương trong kỳ.</td></tr>}
        </tbody>
      </table>
    </div>

    {mode ? <div ref={modalRootRef} className={styles.backdrop}>
      <form ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="salary-advance-dialog-title" aria-busy={busy} tabIndex={-1} onSubmit={save}>
        <header><div><h2 id="salary-advance-dialog-title">{mode === "CREATE" ? "Tạo khoản ứng lương" : mode === "EDIT" ? "Sửa khoản ứng lương" : "Chi tiết khoản ứng lương"}</h2><p>Kỳ lương {period}</p></div><button type="button" aria-label="Đóng hộp thoại ứng lương" disabled={busy} onClick={dismiss}><X size={19}/></button></header>
        <label>Nhân viên
          <select ref={mode === "CREATE" ? initialFocusRef : undefined} value={employeeId} disabled={busy || mode !== "CREATE"} onChange={(event) => setEmployeeId(event.target.value)} required>
            {(data?.employees ?? []).map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.employeeCode} · {employee.employeeName}</option>)}
          </select>
        </label>
        <label>Thời gian hiện tại
          <input value={formatDateTime24(dialogCreatedAt, true)} readOnly aria-readonly="true" />
        </label>
        {selectedBalance ? <div className={styles.balanceBox} aria-live="polite"><span>Tổng lương, phụ cấp, thưởng</span><b>{money(selectedBalance.grossEntitlement)}</b><span>Đã ứng / đang chờ</span><b>{money(selectedBalance.reservedAmount)}</b><span>Được phép ứng thêm</span><strong>{money(maximumAmount)}</strong></div> : null}
        <div className={styles.formGrid}>
          <label>Số tiền ứng
            <input inputMode="numeric" required readOnly={mode === "VIEW"} disabled={busy} value={amount} aria-describedby="salary-advance-amount-hint" onChange={(event) => setAmount(formatVndInput(event.target.value))}/>
            <small id="salary-advance-amount-hint" className={styles.amountHint}>Phải lớn hơn 0 đồng và nhỏ hơn {money(maximumAmount)}; không chấp nhận số tiền bằng mức tối đa.</small>
          </label>
          <div><span className={styles.fieldLabel}>Ngày ứng</span><DatePickerControl ariaLabel="Ngày ứng lương" min={`${period}-01`} max={`${period}-31`} disabled={busy || mode === "VIEW"} required value={advanceDate} onChange={setAdvanceDate}/></div>
        </div>
        <label>Nội dung
          <textarea required maxLength={500} readOnly={mode === "VIEW"} disabled={busy} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ví dụ: Ứng lương chi phí cá nhân"/>
        </label>
        {selected ? <dl className={styles.auditDetails}>
          <div><dt>Trạng thái</dt><dd>{selected.status === "PAID" ? "Đã chi" : "Mới tạo"}</dd></div>
          <div><dt>Lương ghi nhận</dt><dd>{money(selected.grossEntitlementSnapshot)}</dd></div>
          <div><dt>Khả dụng lúc tạo</dt><dd>{money(selected.availableBeforeSnapshot)}</dd></div>
          <div><dt>Còn lại sau ứng</dt><dd>{money(selected.remainingAfterSnapshot)}</dd></div>
          <div><dt>Người tạo</dt><dd>{selected.createdByName} · {formatDateTime24(selected.createdAt, true)}</dd></div>
          <div><dt>Cập nhật gần nhất</dt><dd>{selected.updatedByName} · {formatDateTime24(selected.updatedAt, true)}</dd></div>
          {selected.paidAt ? <div><dt>Xác nhận chi</dt><dd>{selected.paidByName} · {formatDateTime24(selected.paidAt, true)}</dd></div> : null}
        </dl> : null}
        {message && !success ? <p className={styles.error} role="alert">{message}</p> : null}
        <footer><button type="button" disabled={busy} onClick={dismiss}>{mode === "VIEW" ? "Đóng" : "Hủy"}</button>{mode !== "VIEW" ? <button type="submit" className={styles.primaryButton} disabled={busy || maximumAmount <= 1}>{busy ? "Đang lưu…" : mode === "CREATE" ? "Lưu khoản ứng" : "Lưu thay đổi"}</button> : null}</footer>
      </form>
    </div> : null}
  </section>;
}
