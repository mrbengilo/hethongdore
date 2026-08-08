import { initDb, writeAudit } from "../../../db/runtime";
import {
  type LocalDateRange,
  evaluateFinancePerformance,
  financeComparisonPopulation,
  localDate,
  localDateRangeKeys,
  localMonthRange,
  localPeriod,
  multiplyRatioVnd,
  previousComparableDateRange,
  summarizeAccrualTimeline,
  sumVnd,
  validateFinanceDateRange,
} from "../../lib/finance";
import { getSessionUser, json } from "../_lib/auth";
import {
  storeDateRangeFinance,
  type StoreDateRangeFinance,
} from "../_lib/store-finance";

type DividendHistory = {
  period: string;
  revenue: number;
  expense: number;
  profit: number;
  firstShare: number;
  secondShare: number;
  status: "LOCKED";
  closedAt: string;
  closedBy: string;
};

function validPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function parseDividend(value: string) {
  try { return JSON.parse(value) as DividendHistory; } catch { return null; }
}

function totals(stores: FinanceSnapshot[]) {
  const revenue = sumVnd(stores.map((store) => store.revenue));
  const expense = sumVnd(stores.map((store) => store.expense));
  return { revenue, expense, profit: revenue - expense };
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
  return (current - previous) / Math.abs(previous) * 100;
}

type FinanceSnapshot = { revenue: number; expense: number; profit: number };

function effectiveness(current: FinanceSnapshot, previous: FinanceSnapshot | null) {
  return evaluateFinancePerformance(current, previous, percentChange);
}

async function reportData(db: Awaited<ReturnType<typeof initDb>>, period: string, onlyStoreId?: string | null) {
  const range = localMonthRange(period);
  const previousRange = previousComparableDateRange(range, "month");
  const optionsResult = await db.prepare(`
    SELECT id, name, status, created_at AS createdAt
    FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at
  `).all<StoreOption>();
  const storeOptions = onlyStoreId
    ? optionsResult.results.filter((store) => store.id === onlyStoreId)
    : optionsResult.results;
  const report = await reportRangeData(db, range, previousRange, "month", onlyStoreId ?? null, storeOptions);
  return {
    ...report,
    period,
    previousPeriod: previousRange.to.slice(0, 7),
    range,
    previousRange,
  };
}

type Granularity = "day" | "month";
type StoreOption = { id: string; name: string; status: string; createdAt: string };

function reportRange(params: URLSearchParams, period: string, granularity: Granularity) {
  const from = params.get("from");
  const to = params.get("to");
  if (!from && !to) {
    const month = localMonthRange(period);
    const today = localDate();
    if (month.from > today) throw new Error("Không thể xem báo cáo cho kỳ trong tương lai.");
    return { ...month, to: month.to > today ? today : month.to };
  }
  if (!from || !to) throw new Error("Vui lòng chọn đầy đủ ngày bắt đầu và ngày kết thúc.");
  const range = { from, to };
  validateFinanceDateRange(range, granularity);
  return range;
}

function reportBucketKeys(range: LocalDateRange, granularity: Granularity) {
  const dates = localDateRangeKeys(range);
  return granularity === "day" ? dates : [...new Set(dates.map((date) => date.slice(0, 7)))];
}

function aggregateReportTimeline(stores: StoreDateRangeFinance[], range: LocalDateRange, granularity: Granularity) {
  const rows = new Map(reportBucketKeys(range, granularity).map((key) => [key, {
    key,
    revenue: 0,
    expense: 0,
    profit: 0,
  }]));
  for (const store of stores) {
    for (const day of store.timeline) {
      const key = granularity === "day" ? day.date : day.date.slice(0, 7);
      const row = rows.get(key);
      if (!row) continue;
      row.revenue = sumVnd([row.revenue, day.revenue]);
      row.expense = sumVnd([row.expense, day.expense]);
      row.profit = row.revenue - row.expense;
    }
  }
  return [...rows.values()];
}

async function reportRangeData(
  db: Awaited<ReturnType<typeof initDb>>,
  range: LocalDateRange,
  previousRange: LocalDateRange,
  granularity: Granularity,
  storeId: string | null,
  storeOptions: StoreOption[],
) {
  const ids = storeId ? [storeId] : storeOptions.map((store) => store.id);
  const rows = await Promise.all(ids.map(async (id) => {
    const [current, previous] = await Promise.all([
      storeDateRangeFinance(db, id, range),
      storeDateRangeFinance(db, id, previousRange),
    ]);
    return { current, previous };
  }));
  const population = financeComparisonPopulation(rows);
  const stores = rows.flatMap((row) => row.current
    ? [{ current: row.current, previous: row.previous, evaluation: effectiveness(row.current, row.previous) }]
    : []);
  const currentStores = population.current;
  const previousStores = population.previous;
  const timeline = aggregateReportTimeline(currentStores, range, granularity);
  const currentTotals = summarizeAccrualTimeline(timeline);
  const priorTotals = totals(previousStores);
  const evaluation = effectiveness(currentTotals, priorTotals);
  return {
    stores,
    byStore: stores.map((row) => ({
      storeId: row.current.id,
      storeName: row.current.name,
      revenue: row.current.revenue,
      expense: row.current.expense,
      profit: row.current.profit,
      calculationStatus: row.current.calculationStatus,
      settlementStatus: row.current.settlementStatus,
    })),
    totals: currentTotals,
    previousTotals: priorTotals,
    comparison: evaluation,
    evaluation,
    timeline,
    financeStatus: currentStores.length > 0 && currentStores.every((store) => store.settlementStatus === "LOCKED")
      ? "LOCKED" as const
      : "PROVISIONAL" as const,
    calculationStatus: currentStores.length > 0 && currentStores.every((store) => store.calculationStatus === "LOCKED")
      ? "LOCKED" as const
      : "PROVISIONAL" as const,
  };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền xem báo cáo." }, 403);
  const params = new URL(request.url).searchParams;
  const period = params.get("period") ?? localPeriod();
  if (!validPeriod(period)) return json({ message: "Kỳ báo cáo không hợp lệ." }, 400);
  const requestedGranularity = params.get("granularity") ?? "day";
  if (requestedGranularity !== "day" && requestedGranularity !== "month") {
    return json({ message: "Mức tổng hợp báo cáo không hợp lệ." }, 400);
  }
  const granularity: Granularity = requestedGranularity;
  let range: LocalDateRange;
  try {
    range = reportRange(params, period, granularity);
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "Khoảng báo cáo không hợp lệ." }, 400);
  }
  if (range.to > localDate()) return json({ message: "Không thể xem báo cáo cho ngày trong tương lai." }, 400);
  const previousRange = previousComparableDateRange(range, granularity);
  const storeId = params.get("storeId") || null;
  const db = await initDb();
  const storeOptionsResult = await db.prepare(`
    SELECT id, name, status, created_at AS createdAt
    FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at
  `).all<StoreOption>();
  const storeOptions = storeOptionsResult.results;
  if (storeId && !storeOptions.some((store) => store.id === storeId)) {
    return json({ message: "Cửa hàng không tồn tại." }, 404);
  }
  const data = await reportRangeData(db, range, previousRange, granularity, storeId, storeOptions);
  const historyRows = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'DIVIDEND' AND status = 'LOCKED' ORDER BY created_at DESC LIMIT 36")
    .all<{ dataJson: string }>();
  const dividendHistory = historyRows.results.flatMap((row) => {
    const item = parseDividend(row.dataJson);
    return item ? [item] : [];
  });
  return json({
    ...data,
    period: range.to.slice(0, 7),
    previousPeriod: previousRange.to.slice(0, 7),
    granularity,
    range: { ...range, startPeriod: range.from.slice(0, 7), endPeriod: range.to.slice(0, 7) },
    previousRange,
    scope: storeId ? "STORE" : "ALL",
    storeId,
    storeOptions,
    request: { scope: storeId ? "STORE" : "ALL", storeId, from: range.from, to: range.to, granularity },
    recognitionPolicy: {
      timeZone: "Asia/Ho_Chi_Minh",
      endDateInclusive: true,
      directActivity: "Ca làm và chi phí có ngày được ghi nhận đúng ngày nghiệp vụ.",
      monthlyAccrual: "Chi phí cố định và lương quản lý được phân bổ theo ngày cửa hàng hoạt động; tổng các ngày khớp tổng kỳ.",
      performanceRewards: "KPI nhân viên và quản lý chỉ được ghi nhận từ ảnh chụp kỳ đã khóa; kỳ chưa khóa có trạng thái PROVISIONAL.",
    },
    dividendHistory,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền chốt chia cổ tức." }, 403);
  const body = await request.json().catch(() => ({})) as { action?: string; period?: string };
  const period = body.period ?? "";
  if (body.action !== "CLOSE_DIVIDEND" || !validPeriod(period)) return json({ message: "Thao tác hoặc kỳ chia cổ tức không hợp lệ." }, 400);
  if (period >= localPeriod()) return json({ message: "Chỉ được chốt chia cổ tức sau khi kỳ tháng đã kết thúc." }, 409);
  const db = await initDb();
  const report = await reportData(db, period);
  if (report.stores.length === 0) return json({ message: "Không có cửa hàng hoạt động trong kỳ để chốt chia cổ tức." }, 409);
  const unlocked: string[] = [];
  for (const store of report.stores) {
    const closing = await db.prepare("SELECT id FROM business_records WHERE category = 'PAYROLL_CLOSING' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(store.current.id, period).first<{ id: string }>();
    if (!closing) unlocked.push(store.current.id);
  }
  if (unlocked.length) return json({ message: `Còn ${unlocked.length} cửa hàng chưa khóa kỳ lương. Hãy hoàn tất trước khi chia cổ tức.` }, 409);

  const id = `dividend:${period}`;
  const existing = await db.prepare("SELECT id FROM business_records WHERE id = ? AND category = 'DIVIDEND' AND status = 'LOCKED' LIMIT 1")
    .bind(id).first<{ id: string }>();
  if (existing) return json({ message: "Kỳ chia cổ tức này đã được chốt và khóa." }, 409);

  const profit = Math.max(0, report.totals.profit);
  const firstShare = multiplyRatioVnd(profit, 60, 100);
  const secondShare = profit - firstShare;
  const closedAt = new Date().toISOString();
  const record: DividendHistory = {
    period,
    revenue: report.totals.revenue,
    expense: report.totals.expense,
    profit,
    firstShare,
    secondShare,
    status: "LOCKED",
    closedAt,
    closedBy: user.id,
  };
  try {
    await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'DIVIDEND', NULL, ?, ?, ?, 'LOCKED', ?, ?)")
      .bind(id, user.id, `Chia cổ tức ${period}`, JSON.stringify(record), closedAt, closedAt).run();
  } catch (error) {
    const current = await db.prepare("SELECT id FROM business_records WHERE id = ? AND category = 'DIVIDEND' AND status = 'LOCKED' LIMIT 1")
      .bind(id).first<{ id: string }>();
    if (current) return json({ message: "Kỳ chia cổ tức này đã được chốt và khóa." }, 409);
    throw error;
  }
  await writeAudit(user.id, "DIVIDEND_PERIOD_CLOSE", "DIVIDEND", id, JSON.stringify(record));
  return json({ record, message: "Đã xác nhận chia cổ tức, ghi lịch sử và khóa kỳ." }, 201);
}
