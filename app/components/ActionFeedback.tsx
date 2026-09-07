"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type FormEvent, type MouseEvent } from "react";
import { notifyAction, runExclusiveAction, subscribeActionFeedback, type ActionNotice } from "../lib/action-feedback";

const FormPending = createContext<{ pending: boolean; submitterId: string | null }>({ pending: false, submitterId: null });
const reportFailure = (error: unknown) => {
  if (error instanceof Error && error.name === "AbortError") return;
  notifyAction(error instanceof Error ? error.message : "Không thể hoàn tất thao tác. Vui lòng thử lại.", "error");
};

export function ActionButton({ onClick, children, disabled, busy = false, type, ...props }: Omit<ComponentProps<"button">, "onClick"> & {
  busy?: boolean; onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
}) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const formPending = useContext(FormPending);
  const actionId = useId();
  const processing = busy || props["aria-busy"] === true || props["aria-busy"] === "true" || pending || (formPending.pending && (formPending.submitterId === actionId
    || (!formPending.submitterId && type === "submit")));
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (inFlight.current || processing) { event.preventDefault(); return; }
    void runExclusiveAction(inFlight, () => onClick?.(event), setPending, reportFailure);
  };
  return <button {...props} data-action-id={actionId} type={type} disabled={disabled || processing} aria-busy={processing || undefined} onClick={click}>
    {processing && <span className="action-spinner" aria-hidden="true"/>}{children}
    {processing && <span className="sr-only"> · Đang xử lý</span>}
  </button>;
}

export function ActionForm({ onSubmit, children, ...props }: Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit?: (event: FormEvent<HTMLFormElement>) => unknown;
}) {
  const [pending, setPending] = useState(false);
  const [submitterId, setSubmitterId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (inFlight.current) { event.preventDefault(); return; }
    setSubmitterId((event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-action-id") ?? null);
    void runExclusiveAction(inFlight, () => onSubmit?.(event), setPending, reportFailure);
  };
  return <FormPending.Provider value={{ pending, submitterId }}><form {...props} onSubmit={submit} aria-busy={pending || props["aria-busy"]}>{children}</form></FormPending.Provider>;
}

export default function ActionNotifications() {
  const [notice, setNotice] = useState<(ActionNotice & { sequence: number }) | null>(null);
  useEffect(() => subscribeActionFeedback((next) => setNotice((previous) => ({ ...next, sequence: (previous?.sequence ?? 0) + 1 }))), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === "error" ? 12_000 : 8_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return <div className="action-notifications" aria-live="polite" aria-atomic="true">
    {notice && <div className={`action-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <span>{notice.message}</span><button type="button" aria-label="Đóng thông báo" onClick={() => setNotice(null)}>×</button>
    </div>}
  </div>;
}
