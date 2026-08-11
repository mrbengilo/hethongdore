"use client";

import { useRef } from "react";
import { CalendarDays } from "lucide-react";
import { formatDateVn, formatMonthVn } from "../lib/format";

type DatePickerControlProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  type?: "date" | "month";
  hint?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  min?: string;
  max?: string;
};

function showNativePicker(input: HTMLInputElement) {
  if (typeof input.showPicker !== "function") return false;
  try {
    input.showPicker();
    return true;
  } catch {
    return false;
  }
}

export function DatePickerControl({
  ariaLabel,
  value,
  onChange,
  type = "date",
  hint,
  className = "",
  disabled = false,
  required = false,
  min,
  max,
}: DatePickerControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const displayValue = type === "month" ? formatMonthVn(value) : formatDateVn(value);

  return <label className={`app-date-picker ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
    <CalendarDays size={19} strokeWidth={2} aria-hidden="true"/>
    <span>{hint ? <small>{hint}</small> : null}<b>{displayValue}</b></span>
    <input
      ref={inputRef}
      className="app-date-picker-native"
      aria-label={ariaLabel}
      type={type}
      value={value}
      disabled={disabled}
      required={required}
      min={min}
      max={max}
      onChange={(event) => onChange(event.target.value)}
      onClick={(event) => showNativePicker(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (showNativePicker(inputRef.current ?? event.currentTarget)) event.preventDefault();
      }}
    />
  </label>;
}
