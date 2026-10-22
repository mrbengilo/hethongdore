"use client";

import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

type AccessibleModalOptions = {
  open: boolean;
  rootRef: RefObject<HTMLElement | null>;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  dismissDisabled?: boolean;
};

type BackgroundState = {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
};

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function makeBackgroundInert(modalRoot: HTMLElement) {
  const states: BackgroundState[] = [];
  let branch: HTMLElement = modalRoot;
  let parent = branch.parentElement;
  while (parent) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      states.push({
        element: sibling,
        inert: sibling.inert,
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }
    if (parent === document.body) break;
    branch = parent;
    parent = branch.parentElement;
  }
  return states;
}

function restoreBackground(states: BackgroundState[]) {
  for (const { element, inert, ariaHidden } of states) {
    element.inert = inert;
    if (ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", ariaHidden);
  }
}

/**
 * Keeps keyboard and assistive-technology focus inside an in-tree modal.
 * Background attributes are restored exactly, so independently managed
 * drawers and overlays are not accidentally made interactive.
 */
export function useAccessibleModal({
  open,
  rootRef,
  dialogRef,
  initialFocusRef,
  returnFocusRef,
  onDismiss,
  dismissDisabled = false,
}: AccessibleModalOptions) {
  const dismissRef = useRef(onDismiss);
  const dismissDisabledRef = useRef(dismissDisabled);

  useEffect(() => {
    dismissRef.current = onDismiss;
    dismissDisabledRef.current = dismissDisabled;
  }, [dismissDisabled, onDismiss]);

  useEffect(() => {
    if (!open) return;
    const modalRoot = rootRef.current;
    const dialog = dialogRef.current;
    if (!modalRoot || !dialog) return;

    const explicitReturnFocus = returnFocusRef?.current ?? null;
    const previouslyFocused = explicitReturnFocus
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const firstFocusable = focusableElements(dialog)[0];
    (initialFocusRef?.current ?? firstFocusable ?? dialog).focus({ preventScroll: true });

    const background = makeBackgroundInert(modalRoot);
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (dismissDisabledRef.current) return;
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      if (event.shiftKey && (activeIndex <= 0 || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex === -1 || active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      (focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      restoreBackground(background);
      document.body.style.overflow = previousBodyOverflow;
      const focusTarget = explicitReturnFocus ?? previouslyFocused;
      if (focusTarget?.isConnected) {
        window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
      }
    };
  }, [dialogRef, initialFocusRef, open, returnFocusRef, rootRef]);
}
