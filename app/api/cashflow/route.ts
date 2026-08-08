import { initDb } from "../../../db/runtime";
import {
  type LocalDateRange,
  dateRangeBoundsUtc,
  localDate as vietnamDate,
  localDateRangeKeys,
  localMonthRange,
  localPeriod,
  previousComparableDateRange,
  shiftAccountingDate,
  summarizeCashTimeline,
  sumVnd,
  validateFinanceDateRange,
} from "../../lib/finance";
import { getSessionUser, json } from "../_lib/auth";

type Granularity = "day" | "month";

type StoreRow = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
};

type ShiftRow = {
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
};

type RecordRow = {
  category: string;
  storeId: string;
  storeName: string;
  title: string;
  dataJson: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type CashEntry = {
  date: string;
  storeId: string;
  storeName: string;
  inflow: number;
  outflow: number;
  source: string;
  note: string;
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
  const shiftStatement = db.prepare(`
    SELECT s.store_id AS storeId, st.name AS storeName, s.shift_name AS shiftName,
      s.work_date AS workDate, s.started_at AS startedAt, s.ended_at AS endedAt,
      COALESCE(s.cash_revenue, 0) AS cashRevenue,
      COALESCE(s.transfer_revenue, 0) AS transferRevenue,
      COALESCE(s.expense_amount, 0) AS expenseAmount,
      s.expense_note AS expenseNote
    FROM shift_sessions s
    JOIN stores st ON st.id = s.store_id
    WHERE s.status = 'COMPLETED' AND s.ended_at IS NOT NULL
      AND st.status IN ('ACTIVE', 'INACTIVE')
      AND (
        (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
        OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
      )${storeId ? " AND s.store_id = ?" : ""}
    ORDER BY s.ended_at
  `);
  const recordStatement = db.prepare(`
    SELECT r.category, r.store_id AS storeId, s.name AS storeName, r.title,
      r.data_json AS dataJson, r.status, r.created_at AS createdAt, r.updated_at AS updatedAt
    FROM business_records r
    JOIN stores s ON s.id = r.store_id
    WHERE r.category IN ('DONG_TIEN', 'NHAP_HANG', 'CHI_PHI_CO_DINH', 'PAYROLL_CLOSING')
      AND s.status IN ('ACTIVE', 'INACTIVE')
      AND r.status != 'DELETED'${recordStoreSql}
      AND (
        (r.category IN ('DONG_TIEN', 'NHAP_HANG')
          AND json_extract(r.data_json, '$.date') >= ? AND json_extract(r.data_json, '$.date') < ?)
        OR (r.category = 'CHI_PHI_CO_DINH')
        OR (r.category = 'PAYROLL_CLOSING'
          AND json_extract(r.data_json, '$.paymentConfirmedAt') >= ?
          AND json_extract(r.data_json, '$.paymentConfirmedAt') < ?)
      )
    ORDER BY r.updated_at
  `);

  const shiftBinds: unknown[] = [bounds.localStart, bounds.localEnd, bounds.startUtc, bounds.endUtc];
  if (storeId) shiftBinds.push(storeId);
  const recordBinds: unknown[] = [];
  if (storeId) recordBinds.push(storeId);
  recordBinds.push(bounds.localStart, bounds.localEnd, bounds.startUtc, bounds.endUtc);
  const [shiftResult, recordResult] = await Promise.all([
    shiftStatement.bind(...shiftBinds).all<ShiftRow>(),
    recordStatement.bind(...recordBinds).all<RecordRow>(),
  ]);

  const entries: CashEntry[] = [];
  for (const row of shiftResult.results) {
    const date = shiftAccountingDate(row.workDate, row.startedAt);
    if (!validEntryDate(date, range)) continue;
    const revenue = sumVnd([safeVnd(row.cashRevenue), safeVnd(row.transferRevenue)]);
    if (revenue > 0) entries.push({
      date,
      storeId: row.storeId,
      storeName: row.storeName,
      inflow: revenue,
      outflow: 0,
      source: "Doanh thu ca làm",
      note: row.shiftName || "Ca làm đã hoàn tất",
    });
    const expense = safeVnd(row.expenseAmount);
    if (expense > 0) entries.push({
      date,
      storeId: row.storeId,
      storeName: row.storeName,
      inflow: 0,
      outflow: expense,
      source: "Chi phí trong ca",
      note: row.expenseNote || row.shiftName || "Chi phí ca làm",
    });
  }

  for (const row of recordResult.results) {
    const data = parseObject(row.dataJson);
    let date = String(data.date ?? "");
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
    } else if (row.category === "CHI_PHI_CO_DINH") {
      amount = fixedCostTotal(data);
      source = "Chi phí cố định (ngày ghi nhận)";
      const period = String(data.period ?? "");
      const explicitDate = [data.paymentDate, data.paidAt, data.date]
        .map((value) => recognizedLocalDate(typeof value === "string" ? value : ""))
        .find(Boolean) ?? "";
      const updatedDate = recognizedLocalDate(row.updatedAt);
      date = explicitDate || (updatedDate.startsWith(period) ? updatedDate : `${period}-01`);
      note = `${String(data.note ?? row.title)} · Ngày ghi nhận: ${date}`;
    } else if (row.category === "PAYROLL_CLOSING") {
      amount = safeVnd(data.grandTotal);
      source = "Chi lương, thưởng và phụ cấp";
      date = recognizedLocalDate(String(data.paymentConfirmedAt ?? ""));
      note = `Kỳ lương ${String(data.period ?? "")}`;
    }
    if (amount <= 0 || !validEntryDate(date, range)) continue;
    entries.push({ date, storeId: row.storeId, storeName: row.storeName, inflow: 0, outflow: amount, source, note });
  }
  return entries;
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
  const storeId = params.get("storeId") || null;
  if (!periodPattern.test(period)) return json({ message: "Kỳ dòng tiền không hợp lệ." }, 400);
  let range: LocalDateRange;
  try {
    range = requestedRange(params, period, granularity);
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "Khoảng dòng tiền không hợp lệ." }, 400);
  }
  const previousRange = previousComparableDateRange(range, granularity);

  const db = await initDb();
  const storesPromise = db.prepare(`SELECT id, name, status, created_at AS createdAt
    FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at`).all<StoreRow>();
  const [storesResult, currentEntries, previousEntries] = await Promise.all([
    storesPromise,
    collectEntries(db, range, storeId),
    collectEntries(db, previousRange, storeId),
  ]);
  if (storeId && !storesResult.results.some((store) => store.id === storeId)) {
    return json({ message: "Cửa hàng không tồn tại." }, 404);
  }
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
  const currentTotals = summarizeCashTimeline(timeline);
  const priorTotals = summarize(previousEntries);
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
    previousTotals: priorTotals,
    comparison: {
      inflowChange: percentChange(currentTotals.inflow, priorTotals.inflow),
      outflowChange: percentChange(currentTotals.outflow, priorTotals.outflow),
      netChange: percentChange(currentTotals.net, priorTotals.net),
    },
    timeline,
    byStore,
    entries: currentEntries,
    financeStatus: "ACTUAL_CASH",
    recognitionPolicy: {
      timeZone: "Asia/Ho_Chi_Minh",
      endDateInclusive: true,
      revenue: "Doanh thu được ghi nhận theo ngày kế toán của ca đã kết thúc.",
      expenses: "Chi phí có ngày được ghi đúng ngày nghiệp vụ; chi phí cố định ưu tiên paymentDate/paidAt và nếu thiếu dùng ngày cập nhật hoặc đầu kỳ với nhãn ngày ghi nhận.",
      payroll: "Lương, thưởng và phụ cấp chỉ là dòng tiền ra sau khi đã xác nhận thanh toán.",
    },
  });
}
