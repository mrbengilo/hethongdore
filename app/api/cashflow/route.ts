import { initDb } from "../../../db/runtime";
import {
  type LocalDateRange,
  dateRangeBoundsUtc,
  localDate as vietnamDate,
  localDateRangeKeys,
  localMonthRange,
  localPeriod,
  previousComparableDateRange,
  sumVnd,
  validateFinanceDateRange,
} from "../../lib/finance";
import { getSessionUser, json } from "../_lib/auth";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerHasGlobalStoreAccess,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";
import { storeDateRangeFinance } from "../_lib/store-finance";

type Granularity = "day" | "month";

type StoreRow = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
};

type ShiftRow = {
  id: string;
  storeId: string;
  storeName: string;
  shiftName: string | null;
  workDate: string | null;
  startedAt: string;
  endedAt: string;
  cashRevenue: number;
  transferRevenue: number;
  expenseAmount: number;
  expenseNote: string | null;
  hasAggregateRevenueLedger: number;
  hasCashRevenueLedger: number;
  hasTransferRevenueLedger: number;
  hasExpenseLedger: number;
};

type RecordRow = {
  id: string;
  category: string;
  storeId: string;
  storeName: string;
  title: string;
  dataJson: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  hasLedger: number;
};

type SalaryAdvanceRow = {
  id: string;
  storeId: string;
  storeName: string;
  employeeCode: string;
  employeeName: string;
  amount: number;
  period: string;
  note: string;
  paidAt: string;
  hasLedger: number;
};

type LedgerCashRow = {
  id: string;
  storeId: string;
  storeName: string;
  direction: "IN" | "OUT";
  amount: number;
  category: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
  createdBy: string;
  note: string | null;
  createdAt: string;
  reversesEntryId: string | null;
};

type CashEntry = {
  id: string;
  date: string;
  storeId: string;
  storeName: string;
  inflow: number;
  outflow: number;
  source: string;
  note: string;
  direction: "IN" | "OUT";
  amount: number;
  category: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
  origin: "LEDGER" | "LEGACY_VIRTUAL";
  isReversal: boolean;
  reversesEntryId: string | null;
};

type CashflowDiagnostics = {
  ledgerEntryCount: number;
  legacyEntryCount: number;
  suppressedLegacyCount: number;
  skippedUnpaidLegacyCount: number;
  reversalCount: number;
};

const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function addMonths(period: string, amount: number) {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeVnd(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function recognizedLocalDate(value: string | null | undefined) {
  if (!value) return "";
  if (datePattern.test(value)) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? vietnamDate(parsed) : "";
}

function sourceLabel(sourceType: string, category: string) {
  const labels: Record<string, string> = {
    ORDER: "Doanh thu đơn hàng",
    ORDER_REVENUE: "Doanh thu đơn hàng",
    SHIFT_REVENUE: "Doanh thu ca làm",
    SHIFT_REVENUE_CASH: "Doanh thu tiền mặt ca làm",
    SHIFT_REVENUE_BANK: "Doanh thu chuyển khoản ca làm",
    SHIFT_EXPENSE: "Chi phí trong ca",
    VARIABLE_EXPENSE: "Chi phí phát sinh",
    INVENTORY_RECEIPT: "Nhập hàng",
    FIXED_EXPENSE: "Chi phí cố định",
    PAYROLL_PAYMENT: "Chi lương, thưởng và phụ cấp",
    SALARY_ADVANCE: "Ứng lương nhân viên",
    MONTH_END_EXPENSE: "Chi phí cuối kỳ",
    REVERSAL: "Đảo dòng tiền",
  };
  return labels[sourceType] ?? labels[category] ?? category;
}

function normalizedSourceType(category: string) {
  if (category === "DONG_TIEN") return "VARIABLE_EXPENSE";
  if (category === "NHAP_HANG") return "INVENTORY_RECEIPT";
  if (category === "CHI_PHI_CO_DINH") return "FIXED_EXPENSE";
  if (category === "PAYROLL_CLOSING") return "PAYROLL_PAYMENT";
  return category;
}

function explicitPaidTimestamp(data: Record<string, unknown>) {
  for (const value of [data.paidAt, data.paymentDate, data.paymentConfirmedAt]) {
    if (typeof value !== "string") continue;
    const date = recognizedLocalDate(value);
    if (date) return { date, occurredAt: value };
  }
  return { date: "", occurredAt: "" };
}

function inventoryTotal(data: Record<string, unknown>) {
  const storedTotal = safeVnd(data.total);
  if (storedTotal > 0 || data.total === 0) return storedTotal;
  const rawItems = Array.isArray(data.items) ? data.items : [];
  return sumVnd(rawItems.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const storedAmount = safeVnd(row.amount);
    if (storedAmount > 0 || row.amount === 0) return [storedAmount];
    const weight = Number(row.weight ?? 0);
    const goods = Number.isFinite(weight) && weight >= 0 ? Math.round(weight * safeVnd(row.unitPrice)) : 0;
    return [sumVnd([safeVnd(goods), safeVnd(row.shipping)])];
  }));
}

function fixedCostTotal(data: Record<string, unknown>) {
  const storedTotal = safeVnd(data.total);
  if (storedTotal > 0 || data.total === 0) return storedTotal;
  if (Array.isArray(data.items)) {
    return sumVnd(data.items.flatMap((item) => item && typeof item === "object" && !Array.isArray(item)
      ? [safeVnd((item as Record<string, unknown>).amount)]
      : []));
  }
  return sumVnd(["setup", "rent", "electricity", "water", "wifi", "marketing", "garbage", "other"].map((key) => safeVnd(data[key])));
}

function validEntryDate(value: string, range: LocalDateRange) {
  return datePattern.test(value) && value >= range.from && value <= range.to;
}

function bucketKeys(range: LocalDateRange, granularity: Granularity) {
  const dates = localDateRangeKeys(range);
  return granularity === "day" ? dates : [...new Set(dates.map((date) => date.slice(0, 7)))];
}

async function collectEntries(
  db: Awaited<ReturnType<typeof initDb>>,
  range: LocalDateRange,
  storeId: string | null,
) {
  const bounds = dateRangeBoundsUtc(range);
  const recordStoreSql = storeId ? " AND r.store_id = ?" : "";
  const ledgerStatement = db.prepare(`
    SELECT entry.id, entry.store_id AS storeId, store.name AS storeName,
      entry.direction, entry.amount, entry.category,
      entry.source_type AS sourceType, entry.source_id AS sourceId,
      entry.occurred_at AS occurredAt, entry.created_by AS createdBy,
      entry.note, entry.created_at AS createdAt,
      entry.reverses_entry_id AS reversesEntryId
    FROM cashflow_entries entry
    JOIN stores store ON store.id = entry.store_id
    WHERE store.status IN ('ACTIVE', 'INACTIVE')
      AND (
        (length(entry.occurred_at) = 10 AND entry.occurred_at >= ? AND entry.occurred_at < ?)
        OR (entry.occurred_at >= ? AND entry.occurred_at < ?)
      )${storeId ? " AND entry.store_id = ?" : ""}
    ORDER BY entry.occurred_at, entry.id
  `);
  const shiftStatement = db.prepare(`
    SELECT s.id, s.store_id AS storeId, st.name AS storeName, s.shift_name AS shiftName,
      s.work_date AS workDate, s.started_at AS startedAt, s.ended_at AS endedAt,
      COALESCE(s.cash_revenue, 0) AS cashRevenue,
      COALESCE(s.transfer_revenue, 0) AS transferRevenue,
      COALESCE(s.expense_amount, 0) AS expenseAmount,
      s.expense_note AS expenseNote,
      EXISTS (
        SELECT 1 FROM cashflow_entries entry
        WHERE entry.store_id = s.store_id
          AND entry.source_type = 'SHIFT_REVENUE' AND entry.source_id = s.id
      ) AS hasAggregateRevenueLedger,
      EXISTS (
        SELECT 1 FROM cashflow_entries entry
        WHERE entry.store_id = s.store_id
          AND entry.source_type = 'SHIFT_REVENUE_CASH' AND entry.source_id = s.id
      ) AS hasCashRevenueLedger,
      EXISTS (
        SELECT 1 FROM cashflow_entries entry
        WHERE entry.store_id = s.store_id
          AND entry.source_type = 'SHIFT_REVENUE_BANK' AND entry.source_id = s.id
      ) AS hasTransferRevenueLedger,
      EXISTS (
        SELECT 1 FROM cashflow_entries entry
        WHERE entry.store_id = s.store_id
          AND entry.source_type = 'SHIFT_EXPENSE' AND entry.source_id = s.id
      ) AS hasExpenseLedger
    FROM shift_sessions s
    JOIN stores st ON st.id = s.store_id
    WHERE s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
      AND st.status IN ('ACTIVE', 'INACTIVE')
      AND s.ended_at >= ? AND s.ended_at < ?${storeId ? " AND s.store_id = ?" : ""}
    ORDER BY s.ended_at
  `);
  const recordStatement = db.prepare(`
    SELECT r.id, r.category, r.store_id AS storeId, s.name AS storeName, r.title,
      r.data_json AS dataJson, r.status, r.created_at AS createdAt, r.updated_at AS updatedAt,
      EXISTS (
        SELECT 1 FROM cashflow_entries entry
        WHERE entry.store_id = r.store_id AND entry.source_id = r.id
          AND entry.source_type = CASE r.category
            WHEN 'DONG_TIEN' THEN 'VARIABLE_EXPENSE'
            WHEN 'NHAP_HANG' THEN 'INVENTORY_RECEIPT'
            WHEN 'CHI_PHI_CO_DINH' THEN 'FIXED_EXPENSE'
            WHEN 'PAYROLL_CLOSING' THEN 'PAYROLL_PAYMENT'
            ELSE r.category
          END
      ) AS hasLedger
    FROM business_records r
    JOIN stores s ON s.id = r.store_id
    WHERE r.category IN ('DONG_TIEN', 'NHAP_HANG', 'CHI_PHI_CO_DINH', 'PAYROLL_CLOSING')
      AND s.status IN ('ACTIVE', 'INACTIVE')
      AND r.status != 'DELETED'
      AND NOT (r.category = 'CHI_PHI_CO_DINH' AND r.status = 'VOID')${recordStoreSql}
      AND (
        (r.category = 'DONG_TIEN'
          AND json_extract(r.data_json, '$.date') >= ? AND json_extract(r.data_json, '$.date') < ?)
        OR (r.category IN ('NHAP_HANG', 'CHI_PHI_CO_DINH'))
        OR (r.category = 'PAYROLL_CLOSING'
          AND json_extract(r.data_json, '$.paymentConfirmedAt') >= ?
          AND json_extract(r.data_json, '$.paymentConfirmedAt') < ?)
      )
    ORDER BY r.updated_at
  `);
  const salaryAdvanceStatement = db.prepare(`
    SELECT advance.id, advance.store_id AS storeId, store.name AS storeName,
      COALESCE(employee.code, 'ĐÃ XÓA') AS employeeCode,
      COALESCE(employee.name, 'Nhân viên đã xóa') AS employeeName,
      advance.amount, advance.period, advance.note, advance.paid_at AS paidAt,
      EXISTS (
        SELECT 1 FROM cashflow_entries entry
        WHERE entry.store_id = advance.store_id
          AND entry.source_type = 'SALARY_ADVANCE' AND entry.source_id = advance.id
      ) AS hasLedger
    FROM salary_advances advance
    JOIN stores store ON store.id = advance.store_id
    LEFT JOIN employees employee ON employee.id = advance.employee_id
    WHERE advance.status = 'PAID' AND advance.paid_at IS NOT NULL
      AND store.status IN ('ACTIVE', 'INACTIVE')
      AND advance.paid_at >= ? AND advance.paid_at < ?
      ${storeId ? "AND advance.store_id = ?" : ""}
    ORDER BY advance.paid_at
  `);

  const ledgerBinds: unknown[] = [bounds.localStart, bounds.localEnd, bounds.startUtc, bounds.endUtc];
  if (storeId) ledgerBinds.push(storeId);
  const shiftBinds: unknown[] = [bounds.startUtc, bounds.endUtc];
  if (storeId) shiftBinds.push(storeId);
  const recordBinds: unknown[] = [];
  if (storeId) recordBinds.push(storeId);
  recordBinds.push(bounds.localStart, bounds.localEnd, bounds.startUtc, bounds.endUtc);
  const salaryAdvanceBinds: unknown[] = [bounds.startUtc, bounds.endUtc];
  if (storeId) salaryAdvanceBinds.push(storeId);
  const [ledgerResult, shiftResult, recordResult, salaryAdvanceResult] = await Promise.all([
    ledgerStatement.bind(...ledgerBinds).all<LedgerCashRow>(),
    shiftStatement.bind(...shiftBinds).all<ShiftRow>(),
    recordStatement.bind(...recordBinds).all<RecordRow>(),
    salaryAdvanceStatement.bind(...salaryAdvanceBinds).all<SalaryAdvanceRow>(),
  ]);

  const entries: CashEntry[] = [];
  const diagnostics: CashflowDiagnostics = {
    ledgerEntryCount: 0,
    legacyEntryCount: 0,
    suppressedLegacyCount: 0,
    skippedUnpaidLegacyCount: 0,
    reversalCount: 0,
  };
  const pushEntry = (entry: CashEntry) => {
    entries.push(entry);
    if (entry.origin === "LEDGER") diagnostics.ledgerEntryCount += 1;
    else diagnostics.legacyEntryCount += 1;
    if (entry.isReversal) diagnostics.reversalCount += 1;
  };
  const pushLegacy = (input: {
    id: string;
    date: string;
    occurredAt: string;
    storeId: string;
    storeName: string;
    direction: "IN" | "OUT";
    amount: number;
    category: string;
    sourceType: string;
    sourceId: string;
    source: string;
    note: string;
  }) => pushEntry({
    ...input,
    inflow: input.direction === "IN" ? input.amount : 0,
    outflow: input.direction === "OUT" ? input.amount : 0,
    origin: "LEGACY_VIRTUAL",
    isReversal: false,
    reversesEntryId: null,
  });

  for (const row of ledgerResult.results) {
    const date = recognizedLocalDate(row.occurredAt);
    const amount = safeVnd(row.amount);
    if (amount <= 0 || !validEntryDate(date, range)) continue;
    const reversal = row.reversesEntryId !== null;
    pushEntry({
      id: row.id,
      date,
      storeId: row.storeId,
      storeName: row.storeName,
      inflow: row.direction === "IN" ? amount : 0,
      outflow: row.direction === "OUT" ? amount : 0,
      source: reversal ? "Đảo dòng tiền" : sourceLabel(row.sourceType, row.category),
      note: row.note ?? "",
      direction: row.direction,
      amount,
      category: row.category,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      occurredAt: row.occurredAt,
      origin: "LEDGER",
      isReversal: reversal,
      reversesEntryId: row.reversesEntryId,
    });
  }

  for (const row of shiftResult.results) {
    const date = recognizedLocalDate(row.endedAt);
    if (!validEntryDate(date, range)) continue;
    const cashRevenue = safeVnd(row.cashRevenue);
    if (cashRevenue > 0 && (row.hasAggregateRevenueLedger || row.hasCashRevenueLedger)) {
      diagnostics.suppressedLegacyCount += 1;
    } else if (cashRevenue > 0) pushLegacy({
      id: `legacy:SHIFT_REVENUE_CASH:${row.id}`,
      date,
      occurredAt: row.endedAt,
      storeId: row.storeId,
      storeName: row.storeName,
      direction: "IN",
      amount: cashRevenue,
      category: "SHIFT_REVENUE",
      sourceType: "SHIFT_REVENUE_CASH",
      sourceId: row.id,
      source: "Doanh thu tiền mặt ca làm",
      note: row.shiftName || "Ca làm đã hoàn tất",
    });
    const transferRevenue = safeVnd(row.transferRevenue);
    if (transferRevenue > 0 && (row.hasAggregateRevenueLedger || row.hasTransferRevenueLedger)) {
      diagnostics.suppressedLegacyCount += 1;
    } else if (transferRevenue > 0) pushLegacy({
      id: `legacy:SHIFT_REVENUE_BANK:${row.id}`,
      date,
      occurredAt: row.endedAt,
      storeId: row.storeId,
      storeName: row.storeName,
      direction: "IN",
      amount: transferRevenue,
      category: "SHIFT_REVENUE",
      sourceType: "SHIFT_REVENUE_BANK",
      sourceId: row.id,
      source: "Doanh thu chuyển khoản ca làm",
      note: row.shiftName || "Ca làm đã hoàn tất",
    });
    const expense = safeVnd(row.expenseAmount);
    if (expense > 0 && row.hasExpenseLedger) diagnostics.suppressedLegacyCount += 1;
    else if (expense > 0) pushLegacy({
      id: `legacy:SHIFT_EXPENSE:${row.id}`,
      date,
      occurredAt: row.endedAt,
      storeId: row.storeId,
      storeName: row.storeName,
      direction: "OUT",
      amount: expense,
      category: "SHIFT_EXPENSE",
      sourceType: "SHIFT_EXPENSE",
      sourceId: row.id,
      source: "Chi phí trong ca",
      note: row.expenseNote || row.shiftName || "Chi phí ca làm",
    });
  }

  for (const row of recordResult.results) {
    const data = parseObject(row.dataJson);
    let date = String(data.date ?? "");
    let occurredAt = date;
    let amount = 0;
    let source = row.title;
    let note = String(data.note ?? row.title);
    if (row.category === "DONG_TIEN") {
      amount = safeVnd(data.amount);
      source = "Chi phí phát sinh";
    } else if (row.category === "NHAP_HANG") {
      amount = inventoryTotal(data);
      source = "Nhập hàng";
      note = String(data.receiptNo ?? data.note ?? row.title);
      ({ date, occurredAt } = explicitPaidTimestamp(data));
    } else if (row.category === "CHI_PHI_CO_DINH") {
      amount = fixedCostTotal(data);
      source = "Chi phí cố định";
      ({ date, occurredAt } = explicitPaidTimestamp(data));
    } else if (row.category === "PAYROLL_CLOSING") {
      amount = safeVnd(data.grandTotal);
      source = "Chi lương, thưởng và phụ cấp";
      date = recognizedLocalDate(String(data.paymentConfirmedAt ?? ""));
      occurredAt = String(data.paymentConfirmedAt ?? "");
      note = `Kỳ lương ${String(data.period ?? "")}`;
    }
    const sourceType = normalizedSourceType(row.category);
    if (amount > 0 && row.hasLedger) {
      diagnostics.suppressedLegacyCount += 1;
      continue;
    }
    if (amount > 0 && (row.category === "CHI_PHI_CO_DINH" || row.category === "NHAP_HANG") && !date) {
      diagnostics.skippedUnpaidLegacyCount += 1;
      continue;
    }
    if (amount <= 0 || !validEntryDate(date, range)) continue;
    pushLegacy({
      id: `legacy:${sourceType}:${row.id}`,
      date,
      occurredAt,
      storeId: row.storeId,
      storeName: row.storeName,
      direction: "OUT",
      amount,
      category: sourceType,
      sourceType,
      sourceId: row.id,
      source,
      note,
    });
  }
  for (const row of salaryAdvanceResult.results) {
    const date = recognizedLocalDate(row.paidAt);
    const amount = safeVnd(row.amount);
    if (amount <= 0 || !validEntryDate(date, range)) continue;
    if (row.hasLedger) {
      diagnostics.suppressedLegacyCount += 1;
      continue;
    }
    pushLegacy({
      id: `legacy:SALARY_ADVANCE:${row.id}`,
      date,
      occurredAt: row.paidAt,
      storeId: row.storeId,
      storeName: row.storeName,
      direction: "OUT",
      amount,
      category: "SALARY_ADVANCE",
      sourceType: "SALARY_ADVANCE",
      sourceId: row.id,
      source: "Ứng lương nhân viên",
      note: `${row.employeeName} (${row.employeeCode}) · Kỳ ${row.period} · ${row.note}`,
    });
  }
  return { entries, diagnostics };
}

function summarize(entries: CashEntry[]) {
  const inflow = sumVnd(entries.map((entry) => entry.inflow));
  const outflow = sumVnd(entries.map((entry) => entry.outflow));
  return { inflow, outflow, net: inflow - outflow };
}

function aggregateTimeline(entries: CashEntry[], keys: string[], granularity: Granularity) {
  const rows = new Map(keys.map((key) => [key, {
    key,
    inflow: 0,
    outflow: 0,
    net: 0,
    transactionCount: 0,
    sources: new Set<string>(),
    notes: new Set<string>(),
  }]));
  for (const entry of entries) {
    const key = granularity === "day" ? entry.date : entry.date.slice(0, 7);
    const row = rows.get(key);
    if (!row) continue;
    row.inflow = sumVnd([row.inflow, entry.inflow]);
    row.outflow = sumVnd([row.outflow, entry.outflow]);
    row.net = row.inflow - row.outflow;
    row.transactionCount += 1;
    row.sources.add(entry.source);
    if (entry.note) row.notes.add(entry.note);
  }
  return [...rows.values()].map((row) => ({ ...row, sources: [...row.sources], notes: [...row.notes] }));
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
  return (current - previous) / Math.abs(previous) * 100;
}

function requestedRange(params: URLSearchParams, period: string, granularity: Granularity) {
  const from = params.get("from");
  const to = params.get("to");
  const explicitRange = Boolean(from || to);
  let range: LocalDateRange;
  if (!from && !to) {
    range = granularity === "day"
      ? localMonthRange(period)
      : { from: `${addMonths(period, -5)}-01`, to: localMonthRange(period).to };
    const today = vietnamDate();
    if (range.from > today) throw new Error("Không thể xem dòng tiền cho kỳ trong tương lai.");
    if (range.to > today) range = { ...range, to: today };
  } else {
    if (!from || !to) throw new Error("Vui lòng chọn đầy đủ ngày bắt đầu và ngày kết thúc.");
    range = { from, to };
  }
  validateFinanceDateRange(range, granularity, explicitRange ? vietnamDate() : range.to);
  return range;
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền xem dòng tiền." }, 403);
  const params = new URL(request.url).searchParams;
  const period = params.get("period") ?? localPeriod();
  const requestedGranularity = params.get("granularity") ?? "day";
  if (requestedGranularity !== "day" && requestedGranularity !== "month") {
    return json({ message: "Mức tổng hợp dòng tiền không hợp lệ." }, 400);
  }
  const granularity: Granularity = requestedGranularity;
  const scope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = scope.storeId;
  if (!periodPattern.test(period)) return json({ message: "Kỳ dòng tiền không hợp lệ." }, 400);
  let range: LocalDateRange;
  try {
    range = requestedRange(params, period, granularity);
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "Khoảng dòng tiền không hợp lệ." }, 400);
  }
  const previousRange = previousComparableDateRange(range, granularity);

  const db = await initDb();
  const storesPromise = managerHasGlobalStoreAccess(user)
    ? db.prepare(`SELECT id, name, status, created_at AS createdAt
      FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at`).all<StoreRow>()
    : db.prepare(`SELECT id, name, status, created_at AS createdAt
      FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at`).bind(storeId).all<StoreRow>();
  const [storesResult, currentCashflow, previousCashflow] = await Promise.all([
    storesPromise,
    collectEntries(db, range, storeId),
    collectEntries(db, previousRange, storeId),
  ]);
  if (storeId && !storesResult.results.some((store) => store.id === storeId)) {
    return json({ message: "Cửa hàng không tồn tại." }, 404);
  }
  const selectedStores = storesResult.results.filter((store) => !storeId || store.id === storeId);
  const accountingStores = (await Promise.all(selectedStores.map((store) => (
    storeDateRangeFinance(db, store.id, range)
  )))).filter((store): store is NonNullable<typeof store> => Boolean(store));
  const currentEntries = currentCashflow.entries;
  const previousEntries = previousCashflow.entries;
  currentEntries.sort((first, second) => first.date.localeCompare(second.date));
  const keys = bucketKeys(range, granularity);
  const byStore = storesResult.results
    .filter((store) => !storeId || store.id === storeId)
    .map((store) => ({
      storeId: store.id,
      storeName: store.name,
      ...summarize(currentEntries.filter((entry) => entry.storeId === store.id)),
      transactionCount: currentEntries.filter((entry) => entry.storeId === store.id).length,
      sources: [...new Set(currentEntries.filter((entry) => entry.storeId === store.id).map((entry) => entry.source))],
    }));
  const timeline = aggregateTimeline(currentEntries, keys, granularity);
  const totalInflow = sumVnd(byStore.map((store) => store.inflow));
  const totalOutflow = sumVnd(byStore.map((store) => store.outflow));
  const currentTotals = { inflow: totalInflow, outflow: totalOutflow, net: totalInflow - totalOutflow };
  const accountingTotals = {
    revenue: sumVnd(accountingStores.map((store) => store.revenue)),
    expense: sumVnd(accountingStores.map((store) => store.expense)),
    profit: sumVnd(accountingStores.map((store) => store.revenue)) - sumVnd(accountingStores.map((store) => store.expense)),
  };
  const priorTotals = summarize(previousEntries);
  const reconciliationWarnings = [
    ...(currentCashflow.diagnostics.legacyEntryCount > 0 ? [{
      code: "LEGACY_VIRTUAL_ENTRIES",
      severity: "INFO",
      message: `${currentCashflow.diagnostics.legacyEntryCount} dòng tiền đang được đọc tương thích từ dữ liệu cũ chưa có liên kết sổ cái.`,
    }] : []),
    ...(currentCashflow.diagnostics.skippedUnpaidLegacyCount > 0 ? [{
      code: "UNPAID_LEGACY_EXCLUDED",
      severity: "WARNING",
      message: `${currentCashflow.diagnostics.skippedUnpaidLegacyCount} khoản cố định/nhập hàng thiếu ngày thực chi nên không được đưa vào dòng tiền.`,
    }] : []),
    ...(currentCashflow.diagnostics.suppressedLegacyCount > 0 ? [{
      code: "NORMALIZED_SOURCE_WON",
      severity: "INFO",
      message: `${currentCashflow.diagnostics.suppressedLegacyCount} bản ghi tương thích đã được bỏ qua vì nguồn đã có trong sổ cái.`,
    }] : []),
    ...(currentCashflow.diagnostics.reversalCount > 0 ? [{
      code: "CASHFLOW_REVERSALS_PRESENT",
      severity: "INFO",
      message: `${currentCashflow.diagnostics.reversalCount} giao dịch đảo đã được đối chiếu bằng liên kết sổ cái trực tiếp.`,
    }] : []),
    ...(accountingTotals.expense !== currentTotals.outflow ? [{
      code: "ACCOUNTING_CASH_TIMING_DIFFERENCE",
      severity: "INFO",
      message: "Chi phí kế toán và tiền đã chi khác nhau do thời điểm ghi nhận hoặc trạng thái thanh toán.",
    }] : []),
  ];
  return json({
    period: range.to.slice(0, 7),
    granularity,
    scope: storeId ? "STORE" : "ALL",
    storeId,
    range: { ...range, startPeriod: range.from.slice(0, 7), endPeriod: range.to.slice(0, 7) },
    previousRange,
    request: { scope: storeId ? "STORE" : "ALL", storeId, from: range.from, to: range.to, granularity },
    stores: storesResult.results,
    totals: currentTotals,
    actualCashTotals: {
      revenueInflow: currentTotals.inflow,
      cashOutflow: currentTotals.outflow,
      netCashFlow: currentTotals.net,
    },
    accountingTotals,
    reconciliation: {
      accountingExpense: accountingTotals.expense,
      cashOutflow: currentTotals.outflow,
      timingDifference: accountingTotals.expense - currentTotals.outflow,
      warnings: reconciliationWarnings,
      diagnostics: currentCashflow.diagnostics,
    },
    metricLabels: {
      inflow: "Dòng tiền vào từ doanh thu",
      outflow: "Tiền đã chi thực tế",
      net: "Dòng tiền thuần",
      accountingExpense: "Chi phí kế toán",
    },
    previousTotals: priorTotals,
    comparison: {
      inflowChange: percentChange(currentTotals.inflow, priorTotals.inflow),
      outflowChange: percentChange(currentTotals.outflow, priorTotals.outflow),
      netChange: percentChange(currentTotals.net, priorTotals.net),
    },
    timeline,
    byStore,
    entries: currentEntries,
    cashflowReadModel: {
      mode: "LEDGER_FIRST_WITH_LEGACY_COMPATIBILITY",
      sourceOfTruth: "cashflow_entries",
      legacyFallback: "Chỉ dùng bản ghi cũ khi chưa tồn tại cashflow_entries có cùng storeId/sourceType/sourceId.",
      diagnostics: currentCashflow.diagnostics,
    },
    financeStatus: "ACTUAL_CASH",
    recognitionPolicy: {
      timeZone: "Asia/Ho_Chi_Minh",
      endDateInclusive: true,
      revenue: "Ưu tiên dòng tiền thực nhận trong sổ cái; dữ liệu ca cũ chỉ được dùng khi nguồn chưa có liên kết sổ cái.",
      expenses: "Ưu tiên khoản thực chi trong sổ cái. Chi phí cố định/nhập hàng cũ thiếu paidAt, paymentDate hoặc paymentConfirmedAt sẽ không bị tự gán ngày và không được coi là đã chi.",
      payroll: "Khoản ứng lương là dòng tiền ra tại lúc xác nhận chi; phần lương, thưởng và phụ cấp còn lại là dòng tiền ra sau khi xác nhận thanh toán kỳ lương.",
      accountingReconciliation: "Tiền đã chi thực tế có thể khác chi phí kế toán do ngày thanh toán và ngày ghi nhận chi phí khác nhau.",
    },
  });
}
