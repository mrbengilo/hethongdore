import { formatVnd } from "./finance";

export const APP_TIME_ZONE = "Asia/Ho_Chi_Minh";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MONTH_PATTERN = /^\d{4}-\d{2}$/;

export function formatDateVn(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const date = typeof value === "string" && LOCAL_DATE_PATTERN.test(value)
    ? new Date(`${value}T12:00:00+07:00`)
    : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function formatMonthVn(value: string | null | undefined) {
  if (!value || !LOCAL_MONTH_PATTERN.test(value)) return "—";
  const [year, month] = value.split("-");
  return `Tháng ${month}/${year}`;
}

export function formatVndDisplay(value: number | null | undefined) {
  const amount = Math.round(Number(value ?? 0));
  return formatVnd(Number.isSafeInteger(amount) ? amount : 0);
}

export function formatNumber(value: number | null | undefined, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(Number(value ?? 0));
}

export function formatVndInput(value: string | number | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (!digits) return "";
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount) : "";
}

export function parseVndInput(value: string | number | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return 0;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? amount : Number.NaN;
}

export function formatTime24(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatDateTime24(value: Date | string | number | null | undefined, includeSeconds = false) {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  }).format(date);
}
