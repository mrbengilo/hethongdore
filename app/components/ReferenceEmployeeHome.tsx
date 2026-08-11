"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, MapPin, ReceiptText } from "lucide-react";
import { captureClockInLocation, type ClockInLocation } from "../lib/attendance-location";
import { attendanceStatusAt, shiftUtcRange, type AttendanceStatus } from "../lib/scheduling";
import { serverAnchoredClockInCapturedAt } from "../lib/server-time";
import { useAccessibleModal } from "./useAccessibleModal";

type EmployeeUser = {
  id: string; name: string; storeId: string | null;
  employeeId?: string | null;
  employeeCode?: string | null; employeePosition?: string | null; employeePhone?: string | null;
  employeeTiktokAllowance?: number | null;
  storeName?: string | null; homeStoreName?: string | null; isSupporting?: boolean;
};
type EmployeeOrder = {
  id: string; amount: number; payment_method: "CASH" | "BANK_TRANSFER"; status: string;
};
type ShiftState = {
  active: boolean; shiftCode: string | null; startedAt: string | null;
  shiftName?: string | null; scheduledStart?: string | null; scheduledEnd?: string | null;
  scheduledEndAt?: string | null;
  attendanceStatus?: "EARLY" | "ON_TIME" | "LATE" | null;
  attendanceDeltaMinutes?: number | null;
};
type ShiftClosePayload = {
  tasksCompleted: boolean; expenseAmount: number; expenseNote: string;
  cashRevenue: number; transferRevenue: number;
  earlyEndConfirmed?: boolean;
};
export type ShiftActionResult = {
  ok: boolean;
  message?: string;
  startedAt?: string | null;
  attendanceStatus?: AttendanceStatus | null;
  attendanceDeltaMinutes?: number | null;
  requiresEarlyEndConfirmation?: boolean;
  scheduledEndAt?: string | null;
  serverNow?: string | null;
};
export type EmployeeClosingDraft = {
  expenseAmount: string;
  expenseNote: string;
  cashRevenue: string;
  transferRevenue: string;
};
type ShiftStartExpectation = {
  expectedStart: StartShiftPreview;
  clockInLocation: ClockInLocation;
};
type ShiftActionPayload = ShiftClosePayload | ShiftStartExpectation;
type TaskRecord = {
  id: string; title: string;
  data: { date?: string; items?: Array<{ content?: string; completedBy?: string[] }> };
};
type OwnSchedule = {
  id: string;
  date?: string;
  shiftName?: string;
  start?: string;
  end?: string;
  storeName?: string;
  note?: string;
};
type StartShiftPreview = {
  candidateId: string;
  selectionKind: "CURRENT" | "UPCOMING";
  shiftName: string;
  scheduledStart: string;
  scheduledEnd: string;
  workDate: string;
  attendanceStatus?: "EARLY" | "ON_TIME" | "LATE";
  attendanceDeltaMinutes?: number;
  earlyMinutes?: number;
};
type StartShiftConfirmation = {
  clockInLocation: ClockInLocation;
  mode: "EARLY_CONFIRM" | "CURRENT_CONFIRM" | "CURRENT_OR_NEXT";
  candidates: StartShiftPreview[];
};

const money = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value)) + " đồng";
export function normalizeEmployeeTiktokAllowance(value: unknown) {
  const amount = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 25_000;
}
export function resolveEmployeeTiktokAllowanceSnapshot(
  source: "sync" | "start" | "end",
  snapshot: Record<string, unknown>,
  current: unknown,
) {
  const value = source === "end"
    ? snapshot.employeeTiktokAllowance ?? current
    : snapshot.tiktokAllowance ?? snapshot.employeeTiktokAllowance ?? current;
  return normalizeEmployeeTiktokAllowance(value);
}
const formatMoneyInput = (value: string) => value
  .replace(/\D/g, "")
  .replace(/^0+(?=\d)/, "")
  .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const parseMoneyInput = (value: string) => Number(value.replaceAll(",", "") || 0);
export function serverTimeIsBeforeShiftEnd(serverNow: string, scheduledEndAt: string) {
  const serverTime = new Date(serverNow).getTime();
  const scheduledEndTime = new Date(scheduledEndAt).getTime();
  return Number.isFinite(serverTime) && Number.isFinite(scheduledEndTime) && serverTime < scheduledEndTime;
}
const time = (value: string | null) => value
  ? new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }).format(new Date(value))
  : "--:--";
const formatWorkDate = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(value);

function resolveShiftWorkDate(shiftCode: string | null, startedAt: string | null, currentWorkDate: string) {
  const encodedWorkDate = shiftCode?.match(/^CA-(\d{4}-\d{2}-\d{2})(?:-|$)/u)?.[1];
  const started = startedAt ? new Date(startedAt) : null;
  return encodedWorkDate ?? (started && Number.isFinite(started.getTime()) ? formatWorkDate(started) : currentWorkDate);
}

function legacyShiftName(shiftCode: string | null) {
  const match = shiftCode?.trim().match(/^CA[\s_-]*([1-3])$/i);
  return match ? `CA ${match[1]}` : shiftCode || "CHƯA XẾP CA";
}

function startShiftSentenceLabel(shiftName: string) {
  const name = shiftName.trim();
  return /^ca(?:\s|$)/iu.test(name) ? name.replace(/^ca/iu, "ca") : `ca ${name}`;
}

function startCandidateAttendanceStatus(candidate: StartShiftPreview, actualStartedAt: string) {
  const scheduled = shiftUtcRange(candidate.workDate, candidate.scheduledStart, candidate.scheduledEnd)?.startAt;
  return scheduled ? attendanceStatusAt(actualStartedAt, scheduled) : null;
}

function attendanceStatusLabel(status: AttendanceStatus | undefined) {
  if (status === "EARLY") return "Đi sớm";
  if (status === "LATE") return "Đi trễ";
  return "Đúng giờ";
}

const DEFAULT_SHIFT_TASKS = [
  ["Mở cửa hàng, kiểm tra vệ sinh", "Mở cửa đúng giờ, bật đèn, kiểm tra khu vực trưng bày"],
  ["Sắp xếp, trưng bày sản phẩm", "Sắp xếp quần áo, phụ kiện gọn gàng, đẹp mắt"],
  ["Tư vấn & hỗ trợ khách hàng", "Tư vấn sản phẩm, hỗ trợ khách thử đồ"],
  ["Báo cáo doanh thu đầu ca", "Báo cáo doanh thu đầu ca cho quản lý"],
  ["Kiểm tra & báo cáo tồn kho", "Kiểm tra hàng hóa, báo cáo sản phẩm sắp hết"],
  ["Vệ sinh & dọn dẹp cuối ca", "Dọn dẹp khu vực làm việc, sản phẩm gọn gàng"],
] as const;

export function employeeTaskFallbackStorageKey(
  employeeId: string,
  storeId: string | null,
  workDate: string,
  shiftKey: string,
) {
  const scope = [employeeId, storeId ?? "unassigned-store", workDate, shiftKey]
    .map((value) => encodeURIComponent(value))
    .join(":");
  return `dore-shift-tasks:v2:${scope}`;
}

export function ReferenceEmployeeHome({ user, shift, orders, onShift, tiktok, setTiktok, closingDraft, onClosingDraftChange }: {
  user: EmployeeUser;
  shift: ShiftState;
  orders: EmployeeOrder[];
  onShift: (action: "start" | "end", payload?: ShiftActionPayload) => void | ShiftActionResult | Promise<void | ShiftActionResult>;
  tiktok: boolean;
  setTiktok: (value: boolean) => void;
  closingDraft: EmployeeClosingDraft;
  onClosingDraftChange: (draft: EmployeeClosingDraft) => void;
}) {
  const activeOrders = orders.filter((order) => order.status === "COMPLETED");
  const tiktokAllowanceAmount = normalizeEmployeeTiktokAllowance(user.employeeTiktokAllowance);
  const orderCash = activeOrders.filter((order) => order.payment_method === "CASH").reduce((sum, order) => sum + order.amount, 0);
  const orderTransfer = activeOrders.filter((order) => order.payment_method === "BANK_TRANSFER").reduce((sum, order) => sum + order.amount, 0);
  const [taskProgress, setTaskProgress] = useState({ done: 0, total: 0 });
  const { expenseAmount, expenseNote, cashRevenue, transferRevenue } = closingDraft;
  const [closingMessage, setClosingMessage] = useState("");
  const [schedules, setSchedules] = useState<OwnSchedule[]>([]);
  const [now, setNow] = useState<Date | null>(null);
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [lastEndedAt, setLastEndedAt] = useState<string | null>(null);
  const [endingShift, setEndingShift] = useState(false);
  const [startConfirmation, setStartConfirmation] = useState<StartShiftConfirmation | null>(null);
  const [previewingStart, setPreviewingStart] = useState(false);
  const [startProgress, setStartProgress] = useState<"location" | "shift" | null>(null);
  const [startingShift, setStartingShift] = useState(false);
  const [startMessage, setStartMessage] = useState("");
  const [attendanceFeedback, setAttendanceFeedback] = useState<{
    status: "EARLY" | "ON_TIME" | "LATE";
    minutes: number;
  } | null>(() => shift.attendanceStatus ? {
    status: shift.attendanceStatus,
    minutes: Math.abs(Number(shift.attendanceDeltaMinutes ?? 0)),
  } : null);
  const [pendingEarlyEnd, setPendingEarlyEnd] = useState<ShiftClosePayload | null>(null);
  const startButtonRef = useRef<HTMLButtonElement | null>(null);
  const declineStartRef = useRef<HTMLButtonElement | null>(null);
  const employeeHomeRef = useRef<HTMLDivElement | null>(null);
  const startBackdropRef = useRef<HTMLDivElement | null>(null);
  const startDialogRef = useRef<HTMLElement | null>(null);
  const endButtonRef = useRef<HTMLButtonElement | null>(null);
  const declineEarlyEndRef = useRef<HTMLButtonElement | null>(null);
  const earlyEndBackdropRef = useRef<HTMLDivElement | null>(null);
  const earlyEndDialogRef = useRef<HTMLElement | null>(null);
  const previousActive = useRef(shift.active);
  const previousShiftCode = useRef(shift.shiftCode);
  const allTasksDone = taskProgress.total > 0 && taskProgress.done === taskProgress.total;
  const revenueEntered = cashRevenue !== "" && transferRevenue !== "";
  const expenseEntered = expenseAmount !== "";
  const enteredCash = parseMoneyInput(cashRevenue);
  const enteredTransfer = parseMoneyInput(transferRevenue);
  const enteredExpense = parseMoneyInput(expenseAmount);
  const amountsValid = [enteredCash, enteredTransfer, enteredExpense].every((value) => Number.isSafeInteger(value) && value >= 0);
  const expenseValid = enteredExpense === 0 || expenseNote.trim().length > 0;
  const tendersMatch = revenueEntered && enteredCash === orderCash && enteredTransfer === orderTransfer;
  const orderRequirementMet = enteredCash + enteredTransfer === 0 || activeOrders.length > 0;
  const canEnd = shift.active && allTasksDone && expenseEntered && revenueEntered && amountsValid && expenseValid && tendersMatch && orderRequirementMet;
  const revenueTotal = enteredCash + enteredTransfer;
  const todayValue = now
    ? formatWorkDate(now)
    : "";
  const taskWorkDate = resolveShiftWorkDate(shift.shiftCode, shift.startedAt, todayValue);
  const todaySchedule = schedules.find((item) => item.date === todayValue);
  const shiftName = shift.shiftName?.trim() || todaySchedule?.shiftName?.trim() || legacyShiftName(shift.shiftCode);
  const scheduledTime = shift.scheduledStart && shift.scheduledEnd
    ? `${shift.scheduledStart} - ${shift.scheduledEnd}`
    : todaySchedule?.start && todaySchedule?.end ? `${todaySchedule.start} - ${todaySchedule.end}` : "Theo lịch phân ca";
  const currentStartCandidate = startConfirmation?.candidates.find((candidate) => candidate.selectionKind === "CURRENT") ?? null;
  const upcomingStartCandidate = startConfirmation?.candidates.find((candidate) => candidate.selectionKind === "UPCOMING") ?? null;
  const singleStartCandidate = startConfirmation?.candidates[0] ?? null;

  useAccessibleModal({
    open: Boolean(pendingEarlyEnd),
    rootRef: earlyEndBackdropRef,
    dialogRef: earlyEndDialogRef,
    initialFocusRef: declineEarlyEndRef,
    returnFocusRef: endButtonRef,
    dismissDisabled: endingShift,
    onDismiss: declineEarlyEnd,
  });

  useEffect(() => {
    const tick = () => setNow(new Date(Date.now() + serverClockOffsetMs));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [serverClockOffsetMs]);

  useEffect(() => {
    let cancelled = false;
    const syncServerClock = async () => {
      try {
        const response = await fetch("/api/shift", { cache: "no-store" });
        const receivedAt = Date.now();
        const data = response.ok ? await response.json() : null;
        const serverAt = typeof data?.serverNow === "string" ? new Date(data.serverNow).getTime() : Number.NaN;
        if (!cancelled && Number.isFinite(serverAt)) {
          // The API stamps serverNow immediately before its response. Using
          // receive time avoids treating server-side validation latency as a
          // clock difference; the remaining error is only network transit.
          setServerClockOffsetMs(serverAt - receivedAt);
        }
      } catch { /* Keep the last known offset during a transient network failure. */ }
    };
    void syncServerClock();
    const timer = window.setInterval(() => void syncServerClock(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!todayValue) return;
    const from = todayValue;
    const toDate = new Date(`${todayValue}T12:00:00+07:00`);
    toDate.setUTCDate(toDate.getUTCDate() + 7);
    const to = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(toDate);
    fetch(`/api/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((response) => response.ok ? response.json() : { schedules: [] })
      .then((data) => setSchedules(data.schedules ?? []))
      .catch(() => setSchedules([]));
  }, [todayValue]);

  useEffect(() => {
    if (previousActive.current && !shift.active) {
      setLastEndedAt(new Date().toISOString());
      setClosingMessage("✓ Đã kết ca và ghi nhận vào lịch sử ca làm.");
      setPendingEarlyEnd(null);
    } else if (!previousActive.current && shift.active) {
      setLastEndedAt(null);
      setClosingMessage("");
    }
    previousActive.current = shift.active;
  }, [shift.active]);

  useEffect(() => {
    if (shift.active && previousShiftCode.current && shift.shiftCode && previousShiftCode.current !== shift.shiftCode) {
      setTiktok(false);
      setPendingEarlyEnd(null);
      setLastEndedAt(null);
      setClosingMessage("✓ Đã đồng bộ ca đang hoạt động.");
    }
    previousShiftCode.current = shift.shiftCode;
  }, [setTiktok, shift.active, shift.shiftCode]);

  useEffect(() => {
    if (shift.active) {
      setStartConfirmation(null);
      if (shift.attendanceStatus) {
        setAttendanceFeedback({
          status: shift.attendanceStatus,
          minutes: Math.abs(Number(shift.attendanceDeltaMinutes ?? 0)),
        });
      }
    } else {
      setAttendanceFeedback(null);
    }
  }, [shift.active, shift.attendanceDeltaMinutes, shift.attendanceStatus]);

  useEffect(() => {
    if (!startConfirmation) return;
    const frame = window.requestAnimationFrame(() => declineStartRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [startConfirmation]);

  useEffect(() => {
    if (!startConfirmation) return;
    const root = employeeHomeRef.current;
    const contentTargets = root
      ? (Array.from(root.children).filter((node) => node !== startBackdropRef.current) as HTMLElement[])
      : [];
    const inertTargets = [
      document.querySelector<HTMLElement>(".sidebar"),
      document.querySelector<HTMLElement>(".mobile-header"),
      document.querySelector<HTMLElement>(".employee-header"),
      ...contentTargets,
    ].filter((target): target is HTMLElement => target !== null);
    const inertState = inertTargets.map((target) => ({ target, hadInert: target.hasAttribute("inert") }));
    inertState.forEach(({ target }) => target.setAttribute("inert", ""));
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (startingShift) return;
        setStartConfirmation(null);
        window.requestAnimationFrame(() => startButtonRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = startDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", keepFocusInside);
      inertState.forEach(({ target, hadInert }) => { if (!hadInert) target.removeAttribute("inert"); });
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [startConfirmation, startingShift]);

  async function requestStartConfirmation() {
    if (shift.active || previewingStart || startingShift) return;
    setPreviewingStart(true);
    setStartProgress("location");
    setStartMessage("");
    setStartConfirmation(null);
    try {
      let clockInLocation: ClockInLocation;
      try {
        clockInLocation = await captureClockInLocation();
      } catch (error) {
        setStartMessage(error instanceof Error
          ? error.message
          : "Không thể lấy vị trí hiện tại. Vui lòng kiểm tra quyền Vị trí và thử lại.");
        return;
      }
      const locationCapturedAtMonotonic = performance.now();

      setStartProgress("shift");
      const response = await fetch("/api/shift?preview=start", { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as {
        message?: string;
        serverNow?: string;
        startMode?: StartShiftConfirmation["mode"];
        startCandidates?: Array<Partial<StartShiftPreview>>;
        startPreview?: Partial<StartShiftPreview>;
      };
      if (!response.ok) {
        setStartMessage(data.message ?? "Chưa thể xác định ca làm việc hiện tại.");
        return;
      }
      const rawCandidates = Array.isArray(data.startCandidates) && data.startCandidates.length
        ? data.startCandidates : data.startPreview ? [data.startPreview] : [];
      const candidates = rawCandidates.flatMap((preview): StartShiftPreview[] => {
        if (typeof preview.candidateId !== "string"
          || (preview.selectionKind !== "CURRENT" && preview.selectionKind !== "UPCOMING")
          || typeof preview.shiftName !== "string"
          || typeof preview.scheduledStart !== "string"
          || typeof preview.scheduledEnd !== "string"
          || typeof preview.workDate !== "string") return [];
        return [{
          candidateId: preview.candidateId,
          selectionKind: preview.selectionKind,
          shiftName: preview.shiftName,
          scheduledStart: preview.scheduledStart,
          scheduledEnd: preview.scheduledEnd,
          workDate: preview.workDate,
          attendanceStatus: preview.attendanceStatus === "EARLY" || preview.attendanceStatus === "ON_TIME" || preview.attendanceStatus === "LATE"
            ? preview.attendanceStatus : undefined,
          attendanceDeltaMinutes: Number.isInteger(preview.attendanceDeltaMinutes) ? preview.attendanceDeltaMinutes : undefined,
          earlyMinutes: Number.isInteger(preview.earlyMinutes) && Number(preview.earlyMinutes) > 0 ? Number(preview.earlyMinutes) : 0,
        }];
      });
      if (candidates.length === 0) {
        setStartMessage("Chưa thể xác định ca làm việc hiện tại. Vui lòng thử lại.");
        return;
      }
      const serverCapturedAt = typeof data.serverNow === "string"
        ? serverAnchoredClockInCapturedAt(data.serverNow, performance.now() - locationCapturedAtMonotonic)
        : null;
      if (!serverCapturedAt) {
        setStartMessage("Không thể đồng bộ thời gian máy chủ để ghi nhận vị trí. Vui lòng kiểm tra kết nối và thử lại.");
        return;
      }
      clockInLocation = { ...clockInLocation, capturedAt: serverCapturedAt };
      setStartConfirmation({
        clockInLocation,
        mode: data.startMode === "CURRENT_OR_NEXT" || data.startMode === "EARLY_CONFIRM" || data.startMode === "CURRENT_CONFIRM"
          ? data.startMode
          : candidates.length > 1 ? "CURRENT_OR_NEXT"
            : candidates[0].selectionKind === "UPCOMING" ? "EARLY_CONFIRM" : "CURRENT_CONFIRM",
        candidates,
      });
    } catch {
      setStartMessage("Không thể kiểm tra ca làm việc. Vui lòng kiểm tra kết nối và thử lại.");
    } finally {
      setPreviewingStart(false);
      setStartProgress(null);
    }
  }

  function declineStartShift() {
    if (startingShift) return;
    setStartConfirmation(null);
    window.requestAnimationFrame(() => startButtonRef.current?.focus());
  }

  async function confirmStartShift(selected: StartShiftPreview) {
    if (!startConfirmation || startingShift) return;
    setStartingShift(true);
    const { clockInLocation } = startConfirmation;
    try {
      const result = await onShift("start", { expectedStart: selected, clockInLocation });
      if (result && !result.ok) {
        setStartMessage(result.message ?? "Chưa thể điểm danh vào ca làm việc.");
        setStartConfirmation(null);
        window.requestAnimationFrame(() => startButtonRef.current?.focus());
        return;
      }
      const status = result?.attendanceStatus
        ?? selected.attendanceStatus
        ?? startCandidateAttendanceStatus(selected, result?.startedAt ?? clockInLocation.capturedAt)
        ?? (selected.selectionKind === "UPCOMING" ? "EARLY" : "ON_TIME");
      const minutes = Math.abs(Number(result?.attendanceDeltaMinutes ?? selected.attendanceDeltaMinutes ?? 0));
      setAttendanceFeedback({ status, minutes });
      setStartMessage(status === "EARLY"
        ? `✓ Bạn đi làm sớm${minutes ? ` ${minutes} phút` : ""}.`
        : status === "LATE" ? `Bạn đã đi trễ${minutes ? ` ${minutes} phút` : ""}.`
          : "✓ Bạn đã điểm danh đúng giờ.");
      setStartConfirmation(null);
    } catch {
      setStartMessage("Không thể kết nối để điểm danh. Vui lòng thử lại.");
      setStartConfirmation(null);
      window.requestAnimationFrame(() => startButtonRef.current?.focus());
    } finally {
      setStartingShift(false);
    }
  }

  async function latestShiftTiming() {
    try {
      const response = await fetch("/api/shift", { cache: "no-store" });
      const data = response.ok ? await response.json() : null;
      if (data?.active && data.shiftCode === shift.shiftCode
        && typeof data.scheduledEndAt === "string" && typeof data.serverNow === "string") {
        const endAt = String(data.scheduledEndAt);
        const serverNow = String(data.serverNow);
        if (!Number.isNaN(new Date(endAt).getTime()) && !Number.isNaN(new Date(serverNow).getTime())) {
          return { scheduledEndAt: endAt, serverNow };
        }
      }
    } catch { /* A fresh server time is mandatory for an early-close decision. */ }
    return null;
  }

  async function submitShiftEnd(payload: ShiftClosePayload, earlyEndConfirmed: boolean) {
    setEndingShift(true);
    try {
      setClosingMessage("");
      const result = await onShift("end", { ...payload, earlyEndConfirmed });
      if (result && !result.ok) {
        if (result.requiresEarlyEndConfirmation) {
          setPendingEarlyEnd(payload);
          return;
        }
        setClosingMessage(result.message ?? "Chưa thể kết ca. Vui lòng thử lại.");
        return;
      }
      setPendingEarlyEnd(null);
    } catch {
      setClosingMessage("Không thể kết nối để kết ca. Dữ liệu đã nhập vẫn được giữ nguyên, vui lòng thử lại.");
    } finally {
      setEndingShift(false);
    }
  }

  function declineEarlyEnd() {
    if (endingShift) return;
    setPendingEarlyEnd(null);
    window.requestAnimationFrame(() => endButtonRef.current?.focus());
  }

  async function finishShift() {
    if (!canEnd) {
      setClosingMessage("Hãy hoàn thành toàn bộ công việc, nhập chi phí (nhập 0 nếu không có), tiền mặt, chuyển khoản và nội dung chi nếu có chi phí.");
      return;
    }
    if (revenueTotal > 0 && activeOrders.length === 0) {
      setClosingMessage("Doanh thu lớn hơn 0. Vui lòng nhập ít nhất một đơn hàng trước khi kết ca.");
      return;
    }
    setEndingShift(true);
    const timing = await latestShiftTiming();
    setEndingShift(false);
    if (!timing) {
      setClosingMessage("Chưa thể đồng bộ giờ máy chủ và giờ kết thúc ca. Vui lòng thử lại để bảo đảm dữ liệu chấm công chính xác.");
      return;
    }
    const payload: ShiftClosePayload = {
      tasksCompleted: true,
      expenseAmount: enteredExpense,
      expenseNote: expenseNote.trim(),
      cashRevenue: enteredCash,
      transferRevenue: enteredTransfer,
    };
    const earlyEnd = serverTimeIsBeforeShiftEnd(timing.serverNow, timing.scheduledEndAt);
    if (earlyEnd) {
      setPendingEarlyEnd(payload);
      return;
    }
    await submitShiftEnd(payload, false);
  }

  return <div ref={employeeHomeRef} className="employee-home-reference">
    <div className="employee-hero-grid">
      <section className="attendance-card">
        <span>ĐIỂM DANH</span>
        <small>{now ? now.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }) : "Đang đồng bộ thời gian..."}</small>
        <strong suppressHydrationWarning>{now ? now.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }) : "--:--:--"}</strong>
        <button ref={startButtonRef} className="primary-button" disabled={shift.active || previewingStart || startingShift} aria-haspopup="dialog" aria-expanded={Boolean(startConfirmation)} aria-busy={previewingStart || startingShift} aria-describedby="attendance-location-help" onClick={() => void requestStartConfirmation()}><CheckCircle2 size={20}/> {shift.active ? "ĐÃ ĐIỂM DANH" : startProgress === "location" ? "ĐANG LẤY VỊ TRÍ..." : startProgress === "shift" ? "ĐANG KIỂM TRA CA..." : "ĐIỂM DANH"}</button>
        {!shift.active && <small id="attendance-location-help" className="attendance-location-help">Khi điện thoại hỏi quyền Vị trí, hãy chọn Cho phép để điểm danh.</small>}
        <small>{shift.active ? "Đang làm · " + shiftName : "Chưa điểm danh vào ca làm"}</small>
        {shift.active && attendanceFeedback && <span className={`attendance-status ${attendanceFeedback.status === "EARLY" ? "attendance-early" : attendanceFeedback.status === "LATE" ? "attendance-late" : "attendance-on-time"}`}>
          {attendanceFeedback.status === "EARLY" ? `Đi sớm${attendanceFeedback.minutes ? ` ${attendanceFeedback.minutes} phút` : ""}`
            : attendanceFeedback.status === "LATE" ? `Đi trễ${attendanceFeedback.minutes ? ` ${attendanceFeedback.minutes} phút` : ""}` : "Đúng giờ"}
        </span>}
        {startMessage && <small className="attendance-start-error" role="alert">{startMessage}</small>}
      </section>
      <section className="info-card">
        <span>THÔNG TIN NHÂN VIÊN</span>
        <p>Mã nhân viên <b>{user.employeeCode ?? "NV"}</b></p>
        <p>Họ và tên <b>{user.name}</b></p>
        <p>Chức vụ <b>{user.employeePosition ?? "Nhân viên"}</b></p>
        <p>Số điện thoại <b>{user.employeePhone ?? "Chưa cập nhật"}</b></p>
        {user.isSupporting && <p>Cửa hàng hỗ trợ <b>{user.storeName ?? "DORE"}</b></p>}
      </section>
      <section className="shift-card">
        <span>CA LÀM VIỆC HÔM NAY</span>
        <div className="employee-shift-summary" aria-label={`Ca hôm nay: ${shiftName}, ${scheduledTime}`}>
          <b className="employee-shift-name">{shiftName.toLocaleUpperCase("vi-VN")}</b>
          <strong className="employee-shift-schedule">{scheduledTime}</strong>
        </div>
        <p className="employee-shift-times">Giờ vào <b>{time(shift.startedAt)}</b><span>Giờ kết ca <b>{time(lastEndedAt)}</b></span></p>
        <small className={shift.active ? "active-text" : "warning-text"}>{shift.active ? "● Đang trong ca" : "Chưa điểm danh"}</small>
      </section>
    </div>

    <section className="employee-panel table-panel"><div className="panel-title"><div><h2>LỊCH PHÂN CA CỦA TÔI</h2><p>Lịch do quản lý đã lưu cho 7 ngày tới</p></div><span>{schedules.length} lịch</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Ngày</th><th>Cửa hàng</th><th>Ca</th><th>Thời gian 24 giờ</th><th>Ghi chú</th></tr></thead><tbody>{schedules.length ? schedules.map((item) => <tr key={item.id}><td><b>{item.date?.split("-").reverse().join("/")}</b></td><td>{item.storeName ?? user.storeName ?? "DORE"}</td><td><span className="shift-pill s1">{item.shiftName ?? "Ca làm"}</span></td><td><b>{item.start ?? "--:--"} - {item.end ?? "--:--"}</b></td><td>{item.note || "—"}</td></tr>) : <tr><td colSpan={5} className="empty-cell">Chưa có lịch phân ca trong 7 ngày tới.</td></tr>}</tbody></table></div></section>

    <EmployeeTaskChecklist user={user} workDate={taskWorkDate} shiftKey={shift.shiftCode} onProgress={setTaskProgress}/>

    <section className="employee-closing-reference">
      <div className="closing-title"><ReceiptText size={24}/><h2>THÔNG TIN KẾT CA</h2></div>
      <div className="closing-grid">
        <div className="closing-expense">
          <h3>Chi phí trong ca <em>(bắt buộc nhập)</em></h3>
          <label>Số tiền<input type="text" inputMode="numeric" pattern="[0-9,]*" required placeholder="Nhập 0 nếu không có chi phí" value={expenseAmount} onChange={(event) => onClosingDraftChange({ ...closingDraft, expenseAmount: formatMoneyInput(event.target.value) })}/></label>
          <label>Nội dung chi<textarea placeholder="Nhập nội dung chi..." value={expenseNote} onChange={(event) => onClosingDraftChange({ ...closingDraft, expenseNote: event.target.value })}/></label>
          <div className="wage-note">Số giờ làm dự kiến: <b>5 giờ</b><br/>Lương dự kiến: <b>{money(100000)}</b> ({money(20000)}/giờ)</div>
        </div>
        <div className="closing-revenue">
          <h3>Doanh thu ca <em>(bắt buộc)</em></h3>
          <div className="revenue-inputs">
            <label>Tiền mặt<input type="text" inputMode="numeric" pattern="[0-9,]*" required placeholder="Nhập số tiền" value={cashRevenue} onChange={(event) => onClosingDraftChange({ ...closingDraft, cashRevenue: formatMoneyInput(event.target.value) })}/><small>Theo đơn: {money(orderCash)}</small></label>
            <label>Chuyển khoản<input type="text" inputMode="numeric" pattern="[0-9,]*" required placeholder="Nhập số tiền" value={transferRevenue} onChange={(event) => onClosingDraftChange({ ...closingDraft, transferRevenue: formatMoneyInput(event.target.value) })}/><small>Theo đơn: {money(orderTransfer)}</small></label>
            <div><span>Tổng tiền</span><b>{money(revenueTotal)}</b><small>{activeOrders.length} đơn trong ca</small></div>
          </div>
          {revenueEntered && !tendersMatch && <div className="reconciliation-message"><b>Doanh thu chưa khớp với đơn hàng trong ca</b><span>Tiền mặt: cần {money(orderCash)}, đã nhập {money(enteredCash)}, chênh lệch {money(enteredCash - orderCash)}.</span><span>Chuyển khoản: cần {money(orderTransfer)}, đã nhập {money(enteredTransfer)}, chênh lệch {money(enteredTransfer - orderTransfer)}.</span></div>}
          <button ref={endButtonRef} className="end-shift-button" disabled={!canEnd || endingShift} aria-haspopup="dialog" aria-expanded={Boolean(pendingEarlyEnd)} onClick={() => void finishShift()}><CheckCircle2 size={19}/> {endingShift ? "ĐANG KẾT CA..." : "KẾT CA"}</button>
          {closingMessage && <p className={closingMessage.startsWith("✓") ? "success-banner" : "closing-error"}>{closingMessage}</p>}
          <small className="closing-hint">{!shift.active ? "Bạn chưa bắt đầu ca làm việc" : !allTasksDone ? "Vui lòng hoàn thành tất cả công việc trước khi kết ca" : !expenseEntered ? "Vui lòng nhập chi phí trong ca, nhập 0 nếu không có" : !revenueEntered ? "Vui lòng nhập doanh thu tiền mặt và chuyển khoản" : !amountsValid ? "Tiền phải là số nguyên VND không âm" : !expenseValid ? "Vui lòng nhập nội dung chi phí phát sinh" : !orderRequirementMet ? "Doanh thu lớn hơn 0 cần có ít nhất một đơn hàng" : !tendersMatch ? "Tiền mặt hoặc chuyển khoản chưa khớp với đơn hàng" : "Đã đủ điều kiện kết ca"}</small>
        </div>
        <label className="tiktok-box">
          <b>♪ CLIP TIKTOK</b>
          <span>Nếu ca này có làm clip TikTok, vui lòng tick vào ô bên dưới.</span>
          <span><input type="checkbox" checked={tiktok} onChange={(event) => setTiktok(event.target.checked)}/> Ca này có làm clip TikTok</span>
          <small>Phụ cấp TikTok: +{money(tiktokAllowanceAmount)}</small>
        </label>
      </div>
    </section>
    {startConfirmation && <div ref={startBackdropRef} className="modal-backdrop shift-start-backdrop">
      <button type="button" className="shift-start-dismiss" aria-label="Đóng xác nhận điểm danh" disabled={startingShift} onClick={declineStartShift}/>
      <section ref={startDialogRef} className="modal shift-start-confirmation" role="dialog" aria-modal="true" aria-labelledby="shift-start-confirm-title" aria-describedby="shift-start-confirm-description" tabIndex={-1}>
        <div className="modal-title"><div>
          <h2 id="shift-start-confirm-title">{startConfirmation.mode === "CURRENT_OR_NEXT" && currentStartCandidate && upcomingStartCandidate
            ? `Bạn điểm danh làm ${currentStartCandidate.shiftName} hay ${upcomingStartCandidate.shiftName}?`
            : startConfirmation.mode === "EARLY_CONFIRM" && singleStartCandidate
              ? `Bạn vào làm sớm hơn thời gian bắt đầu ${singleStartCandidate.shiftName} đúng không?`
              : singleStartCandidate ? `Bạn vào làm ${startShiftSentenceLabel(singleStartCandidate.shiftName)} phải không?` : "Xác nhận điểm danh"}</h2>
          <p id="shift-start-confirm-description">{startConfirmation.mode === "CURRENT_OR_NEXT" && currentStartCandidate && upcomingStartCandidate
            ? `Chọn ${currentStartCandidate.shiftName} để ghi nhận ${attendanceStatusLabel(currentStartCandidate.attendanceStatus).toLocaleLowerCase("vi-VN")} hoặc ${upcomingStartCandidate.shiftName} để ghi nhận đi sớm. Thời gian vào làm luôn là thời điểm thực tế.`
            : startConfirmation.mode === "EARLY_CONFIRM" && singleStartCandidate
              ? `Bạn đi làm sớm ${singleStartCandidate.earlyMinutes ?? Math.abs(singleStartCandidate.attendanceDeltaMinutes ?? 0)} phút. Chọn CÓ để lưu thời gian thực tế và gắn trạng thái Đi sớm.`
              : "Ca làm được máy chủ xác định theo lịch phân ca và giờ hiện tại."}</p>
        </div></div>
        {startConfirmation.mode === "CURRENT_OR_NEXT" ? <div className="shift-start-choice-preview">
          {currentStartCandidate && <div className="info-box shift-start-preview"><b>{currentStartCandidate.shiftName}</b><span>{currentStartCandidate.scheduledStart} - {currentStartCandidate.scheduledEnd} · {attendanceStatusLabel(currentStartCandidate.attendanceStatus)}</span></div>}
          {upcomingStartCandidate && <div className="info-box shift-start-preview"><b>{upcomingStartCandidate.shiftName}</b><span>{upcomingStartCandidate.scheduledStart} - {upcomingStartCandidate.scheduledEnd} · Đi sớm</span></div>}
        </div> : singleStartCandidate && <div className="info-box shift-start-preview"><b>{singleStartCandidate.shiftName}</b><span>{singleStartCandidate.scheduledStart} - {singleStartCandidate.scheduledEnd}</span></div>}
        <div className="shift-start-location" role="status">
          <MapPin size={22} aria-hidden="true"/>
          <span><b>Đã lấy vị trí hiện tại</b><small>Độ chính xác khoảng {Math.max(1, Math.round(startConfirmation.clockInLocation.accuracyMeters))} m · Chỉ lưu khi bạn xác nhận ca làm.</small></span>
        </div>
        <div className="modal-actions">
          {startConfirmation.mode === "CURRENT_OR_NEXT" && currentStartCandidate && upcomingStartCandidate ? <>
            <button ref={declineStartRef} type="button" disabled={startingShift} onClick={() => void confirmStartShift(currentStartCandidate)}>{startingShift ? "ĐANG GHI NHẬN..." : `Ca hiện tại · ${currentStartCandidate.shiftName}`}</button>
            <button type="button" className="primary-button" disabled={startingShift} onClick={() => void confirmStartShift(upcomingStartCandidate)}>{startingShift ? "ĐANG GHI NHẬN..." : `Ca sau · ${upcomingStartCandidate.shiftName}`}</button>
          </> : <>
            <button ref={declineStartRef} type="button" disabled={startingShift} onClick={declineStartShift}>KHÔNG</button>
            <button type="button" className="primary-button" disabled={startingShift || !singleStartCandidate} onClick={() => singleStartCandidate && void confirmStartShift(singleStartCandidate)}>{startingShift ? "ĐANG ĐIỂM DANH..." : "CÓ"}</button>
          </>}
        </div>
      </section>
    </div>}
    {pendingEarlyEnd && <div ref={earlyEndBackdropRef} className="modal-backdrop shift-start-backdrop">
      <button type="button" tabIndex={-1} className="shift-start-dismiss" aria-label="Đóng xác nhận kết ca sớm" disabled={endingShift} onClick={declineEarlyEnd}/>
      <section ref={earlyEndDialogRef} className="modal shift-start-confirmation" role="dialog" aria-modal="true" aria-labelledby="shift-early-end-confirm-title" aria-describedby="shift-early-end-confirm-description" tabIndex={-1}>
        <div className="modal-title"><div>
          <h2 id="shift-early-end-confirm-title">Chưa hết giờ kết ca, bạn có muốn kết ca không?</h2>
          <p id="shift-early-end-confirm-description">Nếu chọn KHÔNG, toàn bộ chi phí và doanh thu đã nhập vẫn được giữ nguyên.</p>
        </div></div>
        <div className="modal-actions">
          <button ref={declineEarlyEndRef} type="button" disabled={endingShift} onClick={declineEarlyEnd}>KHÔNG</button>
          <button type="button" className="primary-button" disabled={endingShift} onClick={() => void submitShiftEnd(pendingEarlyEnd, true)}>{endingShift ? "ĐANG KẾT CA..." : "CÓ"}</button>
        </div>
      </section>
    </div>}
  </div>;
}

function EmployeeTaskChecklist({ user, workDate, shiftKey, onProgress }: {
  user: EmployeeUser;
  workDate: string;
  shiftKey: string | null;
  onProgress: (progress: { done: number; total: number }) => void;
}) {
  const [records, setRecords] = useState<TaskRecord[]>([]);
  const [fallbackDone, setFallbackDone] = useState<boolean[]>(DEFAULT_SHIFT_TASKS.map(() => false));
  const fallbackStorageKey = shiftKey
    ? employeeTaskFallbackStorageKey(user.employeeId ?? user.id, user.storeId, workDate, shiftKey)
    : null;
  const reload = useCallback(async () => {
    const query = new URLSearchParams({ category: "TASKS" });
    if (user.storeId) query.set("storeId", user.storeId);
    const result = await (await fetch("/api/records?" + query)).json();
    setRecords((result.records ?? []).filter((record: TaskRecord) => String(record.data.date ?? "") === workDate));
  }, [user.storeId, workDate]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!fallbackStorageKey) {
      setFallbackDone(DEFAULT_SHIFT_TASKS.map(() => false));
      return;
    }
    try {
      const saved = JSON.parse(window.localStorage.getItem(fallbackStorageKey) ?? "[]") as boolean[];
      setFallbackDone(DEFAULT_SHIFT_TASKS.map((_, index) => Boolean(saved[index])));
    } catch {
      setFallbackDone(DEFAULT_SHIFT_TASKS.map(() => false));
    }
  }, [fallbackStorageKey]);
  const items = records.flatMap((record) => (record.data.items ?? []).map((item, index) => ({ record, item, index })));
  const done = items.length ? items.filter(({ item }) => item.completedBy?.includes(user.id)).length : fallbackDone.filter(Boolean).length;
  const total = items.length || DEFAULT_SHIFT_TASKS.length;
  useEffect(() => { onProgress({ done, total }); }, [done, total, onProgress]);
  async function toggle(recordId: string, index: number) {
    await fetch("/api/records", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: recordId, completedIndex: index }) });
    await reload();
  }
  function toggleFallback(index: number) {
    const next = fallbackDone.map((value, itemIndex) => itemIndex === index ? !value : value);
    setFallbackDone(next);
    if (fallbackStorageKey) window.localStorage.setItem(fallbackStorageKey, JSON.stringify(next));
  }
  return <section className="employee-task-reference">
    <div className="table-head"><h2>✓ CÔNG VIỆC CẦN LÀM</h2><span>{done}/{total} hoàn thành</span></div>
    <div className="employee-task-table">
      <div className="employee-task-head"><b>STT</b><b>Công việc</b><b>Mô tả</b><b>Trạng thái</b></div>
      {items.length ? items.map(({ record, item, index }, row) => <label className="employee-task-item" key={record.id + "-" + index}><span>{row + 1}</span><b>{item.content}</b><small>{record.title}</small><input type="checkbox" checked={Boolean(item.completedBy?.includes(user.id))} onChange={() => toggle(record.id, index)}/></label>) : DEFAULT_SHIFT_TASKS.map((task, index) => <label className="employee-task-item" key={task[0]}><span>{index + 1}</span><b>{task[0]}</b><small>{task[1]}</small><input type="checkbox" checked={fallbackDone[index]} onChange={() => toggleFallback(index)}/></label>)}
    </div>
    <p className="task-completion-note">ⓘ Vui lòng tick hoàn thành tất cả công việc trước khi kết ca.</p>
  </section>;
}
