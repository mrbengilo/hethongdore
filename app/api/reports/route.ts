import { initDb, writeAudit } from "../../../db/runtime";
import {
  type LocalDateRange,
  allocateStoreProfitSharing,
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

const PROFIT_SHARING_MEMBERS = [
  { id: "pham-thi-diem-thuy", name: "Phạm Thị Diễm Thúy", percentage: 40 },
  { id: "truong-viet-vi", name: "Trương Việt Vi", percentage: 60 },
] as const;

type MemberProfitAllocation = {
  memberId: string;
  memberName: string;
  percentage: number;
  amount: number;
};

type StoreProfitAllocation = {
  storeId: string;
  storeName: string;
  revenue: number;
  expense: number;
  finalProfit: number;
  distributableProfit: number;
  settlementStatus: "LOCKED" | "PAYMENT_CONFIRMED" | "OPEN" | "PROVISIONAL";
  memberAllocations: MemberProfitAllocation[];
};

type ProfitSharingHistory = {
  version: number;
  period: string;
  revenue: number;
  expense: number;
  profit: number;
  accountingProfit: number;
  distributableProfit: number;
  memberAllocations: MemberProfitAllocation[];
  storeAllocations: StoreProfitAllocation[];
  totals: {
    revenue: number;
    expense: number;
    finalProfit: number;
    distributableProfit: number;
    memberAllocations: MemberProfitAllocation[];
  };
  /** Legacy aliases retained so records created by earlier versions remain readable. */
  firstShare: number;
  secondShare: number;
  status: "LOCKED";
  closedAt: string;
  closedBy: string;
  legacy?: boolean;
};

function validPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function safeStoredVnd(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function memberAllocations(distributableProfit: number) {
  const thuyAmount = multiplyRatioVnd(distributableProfit, 40, 100);
  const viAmount = distributableProfit - thuyAmount;
  return [
    { memberId: PROFIT_SHARING_MEMBERS[0].id, memberName: PROFIT_SHARING_MEMBERS[0].name, percentage: 40, amount: thuyAmount },
    { memberId: PROFIT_SHARING_MEMBERS[1].id, memberName: PROFIT_SHARING_MEMBERS[1].name, percentage: 60, amount: viAmount },
  ];
}

function normalizeMemberAllocations(raw: unknown, profit: number, firstShare: number, secondShare: number) {
  const rows = Array.isArray(raw) ? raw.flatMap((item) => item && typeof item === "object" && !Array.isArray(item)
    ? [item as Record<string, unknown>]
    : []) : [];
  const amountFor = (memberId: string, memberName: string, fallback: number) => {
    const match = rows.find((row) => row.memberId === memberId || row.memberName === memberName);
    return match ? safeStoredVnd(match.amount) : fallback;
  };
  const viAmount = amountFor(PROFIT_SHARING_MEMBERS[1].id, PROFIT_SHARING_MEMBERS[1].name, firstShare);
  const thuyAmount = amountFor(PROFIT_SHARING_MEMBERS[0].id, PROFIT_SHARING_MEMBERS[0].name, secondShare);
  if (viAmount + thuyAmount === 0 && profit > 0) return memberAllocations(profit);
  return [
    { memberId: PROFIT_SHARING_MEMBERS[0].id, memberName: PROFIT_SHARING_MEMBERS[0].name, percentage: 40, amount: thuyAmount },
    { memberId: PROFIT_SHARING_MEMBERS[1].id, memberName: PROFIT_SHARING_MEMBERS[1].name, percentage: 60, amount: viAmount },
  ];
}

function parseProfitSharing(value: string): ProfitSharingHistory | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const period = String(raw.period ?? "");
    if (!validPeriod(period)) return null;
    const profit = safeStoredVnd(raw.distributableProfit ?? raw.profit);
    const firstShare = safeStoredVnd(raw.firstShare);
    const secondShare = safeStoredVnd(raw.secondShare);
    const allocations = normalizeMemberAllocations(raw.memberAllocations, profit, firstShare, secondShare);
    const storeAllocations = Array.isArray(raw.storeAllocations) ? raw.storeAllocations.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const distributableProfit = safeStoredVnd(row.distributableProfit);
      return [{
        storeId: String(row.storeId ?? ""),
        storeName: String(row.storeName ?? row.storeId ?? "Cửa hàng"),
        revenue: safeStoredVnd(row.revenue),
        expense: safeStoredVnd(row.expense),
        finalProfit: Number(row.finalProfit ?? 0),
        distributableProfit,
        settlementStatus: row.settlementStatus === "LOCKED" ? "LOCKED" as const : "PROVISIONAL" as const,
        memberAllocations: normalizeMemberAllocations(row.memberAllocations, distributableProfit, 0, 0),
      }];
    }) : [];
    const revenue = safeStoredVnd(raw.revenue);
    const expense = safeStoredVnd(raw.expense);
    const rawTotals = raw.totals && typeof raw.totals === "object" && !Array.isArray(raw.totals)
      ? raw.totals as Record<string, unknown>
      : null;
    const storedAccountingProfit = raw.accountingProfit ?? rawTotals?.finalProfit;
    const accountingProfit = storedAccountingProfit === undefined ? revenue - expense : Number(storedAccountingProfit);
    return {
      version: Number(raw.version ?? 1),
      period,
      revenue,
      expense,
      profit,
      accountingProfit: Number.isSafeInteger(accountingProfit) ? accountingProfit : revenue - expense,
      distributableProfit: profit,
      memberAllocations: allocations,
      storeAllocations,
      totals: { revenue, expense, finalProfit: Number.isSafeInteger(accountingProfit) ? accountingProfit : revenue - expense, distributableProfit: profit, memberAllocations: allocations },
      firstShare: allocations.find((item) => item.memberId === PROFIT_SHARING_MEMBERS[1].id)?.amount ?? firstShare,
      secondShare: allocations.find((item) => item.memberId === PROFIT_SHARING_MEMBERS[0].id)?.amount ?? secondShare,
      status: "LOCKED",
      closedAt: String(raw.closedAt ?? ""),
      closedBy: String(raw.closedBy ?? ""),
      legacy: !Array.isArray(raw.storeAllocations),
    };
  } catch {
    return null;
  }
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

function profitSharingSnapshot(period: string, stores: Array<{ current: StoreDateRangeFinance }>) {
  const storeShares = allocateStoreProfitSharing(stores.map(({ current }) => current.profit));
  const storeAllocations: StoreProfitAllocation[] = stores.map(({ current }, index) => {
    const share = storeShares[index];
    const distributableProfit = share?.distributableProfit ?? 0;
    return {
      storeId: current.id,
      storeName: current.name,
      revenue: current.revenue,
      expense: current.expense,
      finalProfit: current.profit,
      distributableProfit,
      settlementStatus: current.settlementStatus,
      memberAllocations: [
        { memberId: PROFIT_SHARING_MEMBERS[0].id, memberName: PROFIT_SHARING_MEMBERS[0].name, percentage: 40, amount: share?.firstShareAmount ?? 0 },
        { memberId: PROFIT_SHARING_MEMBERS[1].id, memberName: PROFIT_SHARING_MEMBERS[1].name, percentage: 60, amount: share?.secondShareAmount ?? 0 },
      ],
    };
  });
  const revenue = sumVnd(storeAllocations.map((store) => store.revenue));
  const expense = sumVnd(storeAllocations.map((store) => store.expense));
  const finalProfit = revenue - expense;
  const distributableProfit = sumVnd(storeAllocations.map((store) => store.distributableProfit));
  const thuyAmount = sumVnd(storeAllocations.map((store) => store.memberAllocations[0]?.amount ?? 0));
  const viAmount = sumVnd(storeAllocations.map((store) => store.memberAllocations[1]?.amount ?? 0));
  const allocations: MemberProfitAllocation[] = [
    { memberId: PROFIT_SHARING_MEMBERS[0].id, memberName: PROFIT_SHARING_MEMBERS[0].name, percentage: 40, amount: thuyAmount },
    { memberId: PROFIT_SHARING_MEMBERS[1].id, memberName: PROFIT_SHARING_MEMBERS[1].name, percentage: 60, amount: viAmount },
  ];
  return {
    period,
    revenue,
    expense,
    finalProfit,
    distributableProfit,
    memberAllocations: allocations,
    storeAllocations,
    totals: { revenue, expense, finalProfit, distributableProfit, memberAllocations: allocations },
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
  const profitSharingHistory = historyRows.results.flatMap((row) => {
    const item = parseProfitSharing(row.dataJson);
    return item ? [item] : [];
  });
  const profitSharingPreview = profitSharingSnapshot(range.to.slice(0, 7), data.stores);
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
    profitSharingMembers: PROFIT_SHARING_MEMBERS,
    profitSharingPreview,
    profitSharingHistory,
    dividendHistory: profitSharingHistory,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền chốt chia lợi nhuận." }, 403);
  const body = await request.json().catch(() => ({})) as { action?: string; period?: string };
  const period = body.period ?? "";
  const validAction = body.action === "CLOSE_PROFIT_SHARING" || body.action === "CLOSE_DIVIDEND";
  if (!validAction || !validPeriod(period)) return json({ message: "Thao tác hoặc kỳ chia lợi nhuận không hợp lệ." }, 400);
  if (period >= localPeriod()) return json({ message: "Chỉ được chốt chia lợi nhuận sau khi kỳ tháng đã kết thúc." }, 409);
  const db = await initDb();
  const report = await reportData(db, period);
  if (report.stores.length === 0) return json({ message: "Không có cửa hàng hoạt động trong kỳ để chốt chia lợi nhuận." }, 409);
  const unlocked: string[] = [];
  for (const store of report.stores) {
    const closing = await db.prepare("SELECT id FROM business_records WHERE category = 'PAYROLL_CLOSING' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(store.current.id, period).first<{ id: string }>();
    if (!closing) unlocked.push(store.current.id);
  }
  if (unlocked.length) return json({ message: `Còn ${unlocked.length} cửa hàng chưa khóa kỳ lương. Hãy hoàn tất trước khi chia lợi nhuận.` }, 409);

  const id = `dividend:${period}`;
  const existing = await db.prepare("SELECT id FROM business_records WHERE id = ? AND category = 'DIVIDEND' AND status = 'LOCKED' LIMIT 1")
    .bind(id).first<{ id: string }>();
  if (existing) return json({ message: "Kỳ chia lợi nhuận này đã được chốt và khóa." }, 409);

  const snapshot = profitSharingSnapshot(period, report.stores);
  const firstShare = snapshot.memberAllocations.find((item) => item.memberId === PROFIT_SHARING_MEMBERS[1].id)?.amount ?? 0;
  const secondShare = snapshot.memberAllocations.find((item) => item.memberId === PROFIT_SHARING_MEMBERS[0].id)?.amount ?? 0;
  const closedAt = new Date().toISOString();
  const record: ProfitSharingHistory = {
    version: 2,
    period,
    revenue: snapshot.revenue,
    expense: snapshot.expense,
    profit: snapshot.distributableProfit,
    accountingProfit: snapshot.finalProfit,
    distributableProfit: snapshot.distributableProfit,
    memberAllocations: snapshot.memberAllocations,
    storeAllocations: snapshot.storeAllocations,
    totals: snapshot.totals,
    firstShare,
    secondShare,
    status: "LOCKED",
    closedAt,
    closedBy: user.id,
  };
  try {
    await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'DIVIDEND', NULL, ?, ?, ?, 'LOCKED', ?, ?)")
      .bind(id, user.id, `Chia lợi nhuận ${period}`, JSON.stringify(record), closedAt, closedAt).run();
  } catch (error) {
    const current = await db.prepare("SELECT id FROM business_records WHERE id = ? AND category = 'DIVIDEND' AND status = 'LOCKED' LIMIT 1")
      .bind(id).first<{ id: string }>();
    if (current) return json({ message: "Kỳ chia lợi nhuận này đã được chốt và khóa." }, 409);
    throw error;
  }
  await writeAudit(user.id, "PROFIT_SHARING_PERIOD_CLOSE", "DIVIDEND", id, JSON.stringify(record));
  return json({ record, message: "Đã xác nhận chia lợi nhuận, ghi lịch sử theo từng cửa hàng và khóa kỳ." }, 201);
}
