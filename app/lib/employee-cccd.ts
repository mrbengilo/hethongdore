export const EMPLOYEE_CCCD_NUMBER_PATTERN = /^\d{12}$/;

export function normalizeEmployeeCccdNumber(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return EMPLOYEE_CCCD_NUMBER_PATTERN.test(normalized) ? normalized : null;
}

export function maskEmployeeCccdNumber(value: string | null | undefined) {
  if (!value || !EMPLOYEE_CCCD_NUMBER_PATTERN.test(value)) return null;
  return `${value.slice(0, 3)}******${value.slice(-3)}`;
}
