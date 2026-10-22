export type AdminResetKind = "ORDERS" | "ATTENDANCE";
export type AdminResetRange = "DAY" | "MONTH";

export type AdminResetFilter = {
  storeId: string;
  kind: AdminResetKind;
  range: AdminResetRange;
  date: string | null;
  period: string | null;
  employeeId: string | null;
  shiftCode: string | null;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH_PATTERN = /^\d{4}-\d{2}$/u;

function cleanOptional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseAdminResetFilter(input: Record<string, unknown>): AdminResetFilter {
  const storeId = cleanOptional(input.storeId);
  if (!storeId) throw new Error("Thiếu cửa hàng cần thao tác.");

  const kind = input.kind === "ATTENDANCE" ? "ATTENDANCE" : input.kind === "ORDERS" ? "ORDERS" : null;
  if (!kind) throw new Error("Loại dữ liệu reset không hợp lệ.");
  const range = input.range === "MONTH" ? "MONTH" : input.range === "DAY" ? "DAY" : null;
  if (!range) throw new Error("Khoảng thời gian reset không hợp lệ.");

  const date = cleanOptional(input.date);
  const period = cleanOptional(input.period);
  if (range === "DAY" && (!date || !DAY_PATTERN.test(date))) throw new Error("Ngày reset không hợp lệ.");
  if (range === "MONTH" && (!period || !MONTH_PATTERN.test(period))) throw new Error("Tháng reset không hợp lệ.");

  return {
    storeId,
    kind,
    range,
    date: range === "DAY" ? date : null,
    period: range === "MONTH" ? period : null,
    employeeId: cleanOptional(input.employeeId),
    shiftCode: cleanOptional(input.shiftCode),
  };
}

export function resetFilterPeriod(filter: AdminResetFilter) {
  return filter.range === "MONTH" ? filter.period! : filter.date!.slice(0, 7);
}

export function resetFilterLabel(filter: AdminResetFilter) {
  const time = filter.range === "DAY" ? filter.date : filter.period;
  const parts = [filter.kind === "ORDERS" ? "Đơn hàng" : "Chấm công", time];
  if (filter.employeeId) parts.push("theo nhân viên");
  if (filter.shiftCode) parts.push("theo ca");
  return parts.filter(Boolean).join(" · ");
}

export function buildAdminResetWhere(filter: AdminResetFilter) {
  const alias = filter.kind === "ORDERS" ? "o" : "s";
  const clauses = [`${alias}.store_id = ?`];
  const bindings: unknown[] = [filter.storeId];
  const accountingDate = filter.kind === "ORDERS"
    ? "COALESCE(NULLIF(s.work_date, ''), date(datetime(o.created_at, '+7 hours')))"
    : "COALESCE(NULLIF(s.work_date, ''), date(datetime(s.started_at, '+7 hours')))";
  if (filter.range === "DAY") {
    clauses.push(`${accountingDate} = ?`);
    bindings.push(filter.date);
  } else {
    clauses.push(`substr(${accountingDate}, 1, 7) = ?`);
    bindings.push(filter.period);
  }
  if (filter.employeeId) {
    clauses.push(`${alias}.employee_id = ?`);
    bindings.push(filter.employeeId);
  }
  if (filter.shiftCode) {
    clauses.push(`${alias}.shift_code = ?`);
    bindings.push(filter.shiftCode);
  }
  return { sql: clauses.join(" AND "), bindings };
}
