import { initDb } from "../../../db/runtime";
import {
  type LocalDateRange,
  evaluateFinancePerformance,
  financeComparisonPopulation,
  localDate,
  localDateRangeKeys,
  localMonthRange,
  localPeriod,
  previousComparableDateRange,
  summarizeAccrualTimeline,
  sumVnd,
  validateFinanceDateRange,
} from "../../lib/finance";
import {
  allocateProfitSharingMembers,
  closeProfitDistribution,
  listProfitDistributions,
  previewProfitDistribution,
  ProfitDistributionError,
  readProfitDistribution,
  type ProfitDistributionPreview,
  type ProfitDistributionRecord,
} from "../../lib/profit-distributions";
import { getSessionUser, json } from "../_lib/auth";
import {
  loadFinancialPolicyForPeriod,
  type FinancialPolicyVersion,
} from "../_lib/financial-policy";
import { parsePersistedFinancialPeriodSnapshot } from "../_lib/financial-period";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerHasGlobalStoreAccess,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";
import {
  storeDateRangeFinance,
  type StoreDateRangeFinance,
} from "../_lib/store-finance";

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
  status: "LOCKED";
  closedAt: string;
  closedBy: string;
  reason?: string;
  legacy?: boolean;
};

function validPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
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

type Granularity = "day" | "month";
type FixedCostRecognition = "ACCRUAL" | "FULL_ENDING_PERIOD";
type StoreOption = { id: string; name: string; status: string; createdAt: string };

function fixedCostRecognitionForRange(params: URLSearchParams, range: LocalDateRange): FixedCostRecognition {
  if (!params.has("from") && !params.has("to")) return "FULL_ENDING_PERIOD";

  // The main report opens on the current month-to-date. That whole-period
  // selection must agree with each store's monthly financial view: fixed
  // costs, manager salary and KPI are recognized in full. A genuinely partial
  // custom range (for example one day or one week) keeps daily accrual
  // semantics so revenue and expense always describe the same date window.
  const endingMonth = localMonthRange(range.to.slice(0, 7));
  const today = localDate();
  const finalAvailableDay = endingMonth.to > today ? today : endingMonth.to;
  return range.from <= endingMonth.from && range.to === finalAvailableDay
    ? "FULL_ENDING_PERIOD"
    : "ACCRUAL";
}

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
  fixedCostRecognition: FixedCostRecognition,
) {
  const ids = storeId ? [storeId] : storeOptions.map((store) => store.id);
  const rows = await Promise.all(ids.map(async (id) => {
    const [current, previous] = await Promise.all([
      storeDateRangeFinance(db, id, range, { fixedCostRecognition, payrollRecognition: "PREVIEW" }),
      storeDateRangeFinance(db, id, previousRange, { fixedCostRecognition, payrollRecognition: "PREVIEW" }),
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

type CanonicalProfitDistribution = ProfitDistributionPreview | ProfitDistributionRecord;

function uiMemberAllocations(distribution: CanonicalProfitDistribution): MemberProfitAllocation[] {
  return distribution.members.map((member) => ({
    memberId: member.memberId,
    memberName: member.name,
    percentage: member.rateBasisPoints / 100,
    amount: member.amount,
  }));
}

function uiStoreAllocations(distribution: CanonicalProfitDistribution): StoreProfitAllocation[] {
  const memberPolicies = distribution.members.map((member) => ({
    memberId: member.memberId,
    name: member.name,
    rateBasisPoints: member.rateBasisPoints,
    memberSnapshot: member.memberSnapshot,
    ordinal: member.ordinal,
  }));
  return distribution.stores.map((store) => {
    const snapshot = parsePersistedFinancialPeriodSnapshot(store.financialSnapshot);
    const allocations = allocateProfitSharingMembers(store.distributableProfit, memberPolicies);
    return {
      storeId: store.storeId,
      storeName: store.storeName,
      revenue: snapshot.finance.grossRevenue,
      expense: snapshot.finance.totalExpense,
      finalProfit: snapshot.finance.finalProfit,
      distributableProfit: snapshot.finance.distributableProfit,
      settlementStatus: "LOCKED",
      memberAllocations: allocations.map((member) => ({
        memberId: member.memberId,
        memberName: member.name,
        percentage: member.rateBasisPoints / 100,
        amount: member.amount,
      })),
    };
  });
}

function uiProfitSharingSummary(distribution: CanonicalProfitDistribution) {
  const memberAllocations = uiMemberAllocations(distribution);
  const storeAllocations = uiStoreAllocations(distribution);
  const revenue = sumVnd(storeAllocations.map((store) => store.revenue));
  const expense = sumVnd(storeAllocations.map((store) => store.expense));
  return {
    period: distribution.period,
    revenue,
    expense,
    finalProfit: distribution.totalFinalProfit,
    distributableProfit: distribution.totalDistributableProfit,
    memberAllocations,
    storeAllocations,
    totals: {
      revenue,
      expense,
      finalProfit: distribution.totalFinalProfit,
      distributableProfit: distribution.totalDistributableProfit,
      memberAllocations,
    },
  };
}

function uiProfitSharingHistory(record: ProfitDistributionRecord): ProfitSharingHistory {
  const summary = uiProfitSharingSummary(record);
  return {
    version: 3,
    period: record.period,
    revenue: summary.revenue,
    expense: summary.expense,
    profit: record.totalDistributableProfit,
    accountingProfit: record.totalFinalProfit,
    distributableProfit: record.totalDistributableProfit,
    memberAllocations: summary.memberAllocations,
    storeAllocations: summary.storeAllocations,
    totals: summary.totals,
    status: "LOCKED",
    closedAt: record.closedAt,
    closedBy: record.closedBy,
    reason: record.reason,
  };
}

function profitSharingMembers(distribution: CanonicalProfitDistribution | null) {
  return distribution?.members.map((member) => ({
    id: member.memberId,
    name: member.name,
    percentage: member.rateBasisPoints / 100,
  })) ?? [];
}

function configuredProfitSharingMembers(policyVersion: FinancialPolicyVersion | null) {
  return policyVersion?.policy.profitSharingMembers.map((member) => ({
    id: member.memberId,
    name: member.name,
    percentage: member.rateBasisPoints / 100,
  })) ?? [];
}

function distributionErrorMessage(error: ProfitDistributionError) {
  const messages: Record<ProfitDistributionError["code"], string> = {
    INVALID_INPUT: "Dữ liệu chia lợi nhuận không hợp lệ.",
    MISSING_PERIOD: "Chưa đủ kỳ tài chính của tất cả cửa hàng để chia lợi nhuận.",
    PERIOD_NOT_LOCKED: "Còn cửa hàng chưa khóa kỳ tài chính.",
    CORRUPT_SNAPSHOT: "Snapshot tài chính đã khóa không hợp lệ; cần đối soát trước khi chia.",
    POLICY_MISMATCH: "Các cửa hàng không dùng cùng phiên bản chính sách đã khóa.",
    POLICY_NOT_CONFIGURED: "Chính sách chia lợi nhuận chưa được cấu hình hợp lệ.",
    ALREADY_CLOSED: "Kỳ chia lợi nhuận này đã được chốt và khóa.",
    INTEGRITY_ERROR: "Dữ liệu chia lợi nhuận đã khóa không toàn vẹn.",
    ATOMIC_WRITE_FAILED: "Không thể ghi nhận chia lợi nhuận an toàn; không có dữ liệu dở dang được lưu.",
  };
  return messages[error.code];
}

function distributionErrorStatus(error: ProfitDistributionError) {
  if (error.code === "INVALID_INPUT") return 400;
  if (error.code === "INTEGRITY_ERROR" || error.code === "ATOMIC_WRITE_FAILED") return 500;
  return 409;
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
  const scope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = scope.storeId;
  const globalStoreAccess = managerHasGlobalStoreAccess(user);
  const db = await initDb();
  const storeOptionsResult = globalStoreAccess
    ? await db.prepare(`
      SELECT id, name, status, created_at AS createdAt
      FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at
    `).all<StoreOption>()
    : await db.prepare(`
      SELECT id, name, status, created_at AS createdAt
      FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at
    `).bind(storeId).all<StoreOption>();
  const storeOptions = storeOptionsResult.results;
  if (storeId && !storeOptions.some((store) => store.id === storeId)) {
    return json({ message: "Cửa hàng không tồn tại." }, 404);
  }
  const fixedCostRecognition = fixedCostRecognitionForRange(params, range);
  const usesFullEndingPeriodFixedCosts = fixedCostRecognition === "FULL_ENDING_PERIOD";
  const data = await reportRangeData(
    db,
    range,
    previousRange,
    granularity,
    storeId,
    storeOptions,
    fixedCostRecognition,
  );
  const distributionPeriod = range.to.slice(0, 7);
  let currentDistribution: ProfitDistributionRecord | null = null;
  let previewDistribution: ProfitDistributionPreview | null = null;
  let configuredFinancialPolicy: FinancialPolicyVersion | null = null;
  let profitSharingHistory: ProfitSharingHistory[] = [];
  let profitSharingReadiness: null | {
    ready: boolean;
    status: "READY" | "LOCKED" | "UNAVAILABLE";
    code: string;
    message: string;
  } = null;
  if (globalStoreAccess) {
    try {
      const [current, summaries, financialPolicy] = await Promise.all([
        readProfitDistribution(db, distributionPeriod),
        listProfitDistributions(db, { limit: 36 }),
        loadFinancialPolicyForPeriod(db, distributionPeriod),
      ]);
      currentDistribution = current;
      configuredFinancialPolicy = financialPolicy;
      const historyRecords = await Promise.all(summaries.map(async (summary) => {
        const record = summary.period === distributionPeriod && current
          ? current
          : await readProfitDistribution(db, summary.period);
        if (!record) {
          throw new ProfitDistributionError("INTEGRITY_ERROR", `Missing immutable distribution ${summary.period}`);
        }
        return record;
      }));
      if (current && !historyRecords.some((record) => record.period === current.period)) {
        historyRecords.unshift(current);
      }
      profitSharingHistory = historyRecords.map(uiProfitSharingHistory);
      if (currentDistribution) {
        profitSharingReadiness = {
          ready: false,
          status: "LOCKED",
          code: "ALREADY_CLOSED",
          message: "Kỳ chia lợi nhuận đã được khóa và chỉ đọc từ snapshot bất biến.",
        };
      } else {
        try {
          previewDistribution = await previewProfitDistribution(db, distributionPeriod);
          profitSharingReadiness = {
            ready: true,
            status: "READY",
            code: "READY",
            message: "Tất cả cửa hàng đã khóa kỳ; có thể xác nhận chia lợi nhuận.",
          };
        } catch (error) {
          if (!(error instanceof ProfitDistributionError)) throw error;
          profitSharingReadiness = {
            ready: false,
            status: "UNAVAILABLE",
            code: error.code,
            message: distributionErrorMessage(error),
          };
        }
      }
    } catch (error) {
      if (error instanceof ProfitDistributionError) {
        return json({ message: distributionErrorMessage(error), code: error.code }, distributionErrorStatus(error));
      }
      throw error;
    }
  }
  const memberSource = currentDistribution ?? previewDistribution;
  const configuredMembers = configuredProfitSharingMembers(configuredFinancialPolicy);
  const profitSharingPreview = previewDistribution ? uiProfitSharingSummary(previewDistribution) : null;
  const profitSharingMemberSource = globalStoreAccess
    ? currentDistribution
      ? {
          type: "LOCKED_DISTRIBUTION_SNAPSHOT" as const,
          policyVersionId: currentDistribution.policyVersionId,
          policyVersion: currentDistribution.configVersion,
          effectiveFromPeriod: null,
          immutable: true,
        }
      : previewDistribution
        ? {
            type: "LOCKED_PERIOD_PREVIEW" as const,
            policyVersionId: previewDistribution.policyVersionId,
            policyVersion: previewDistribution.configVersion,
            effectiveFromPeriod: null,
            immutable: true,
          }
        : configuredFinancialPolicy
          ? {
              type: "FINANCIAL_POLICY" as const,
              policyVersionId: configuredFinancialPolicy.id,
              policyVersion: configuredFinancialPolicy.version,
              effectiveFromPeriod: configuredFinancialPolicy.effectiveFromPeriod,
              immutable: false,
            }
          : {
              type: "UNCONFIGURED" as const,
              policyVersionId: null,
              policyVersion: null,
              effectiveFromPeriod: null,
              immutable: false,
            }
    : {
        type: "HIDDEN" as const,
        policyVersionId: null,
        policyVersion: null,
        effectiveFromPeriod: null,
        immutable: false,
      };
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
      monthlyAccrual: usesFullEndingPeriodFixedCosts
        ? "Chi phí cố định, lương quản lý và KPI của tháng kết thúc phạm vi được ghi nhận đủ một lần; kỳ mở dùng chính sách hiện hành, kỳ đã khóa giữ nguyên bản chốt."
        : "Chi phí cố định, lương quản lý và KPI được phân bổ theo ngày trong phạm vi tùy chọn; kỳ mở dùng chính sách hiện hành, kỳ đã khóa giữ nguyên bản chốt.",
      performanceRewards: "Thưởng KPI kỳ mở là số xem trước theo chính sách hiện hành; kỳ đã khóa chỉ dùng ảnh chụp bất biến.",
    },
    profitSharingMembers: globalStoreAccess ? profitSharingMembers(memberSource) : [],
    configuredProfitSharingMembers: globalStoreAccess ? configuredMembers : [],
    profitSharingMemberSource,
    profitSharingPolicy: globalStoreAccess && configuredFinancialPolicy
      ? {
          id: configuredFinancialPolicy.id,
          version: configuredFinancialPolicy.version,
          effectiveFromPeriod: configuredFinancialPolicy.effectiveFromPeriod,
        }
      : null,
    profitSharingPreview,
    profitSharingHistory,
    dividendHistory: profitSharingHistory,
    profitSharingReadiness,
    profitSharingMessage: profitSharingReadiness?.message ?? null,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền chốt chia lợi nhuận." }, 403);
  if (!managerHasGlobalStoreAccess(user)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const body = await request.json().catch(() => ({})) as { action?: string; period?: string; reason?: string };
  const period = body.period ?? "";
  const validAction = body.action === "CLOSE_PROFIT_SHARING" || body.action === "CLOSE_DIVIDEND";
  if (!validAction || !validPeriod(period)) return json({ message: "Thao tác hoặc kỳ chia lợi nhuận không hợp lệ." }, 400);
  if (period >= localPeriod()) return json({ message: "Chỉ được chốt chia lợi nhuận sau khi kỳ tháng đã kết thúc." }, 409);
  const db = await initDb();
  const reason = body.reason?.trim() || "Xác nhận chia lợi nhuận cuối kỳ trên báo cáo tài chính.";
  try {
    const canonicalRecord = await closeProfitDistribution(db, {
      period,
      actorId: user.id,
      reason,
    });
    const record = uiProfitSharingHistory(canonicalRecord);
    return json({
      record,
      profitSharingMembers: profitSharingMembers(canonicalRecord),
      message: "Đã xác nhận chia lợi nhuận từ snapshot tài chính đã khóa và khóa sổ phân chia.",
    }, 201);
  } catch (error) {
    if (error instanceof ProfitDistributionError) {
      return json({ message: distributionErrorMessage(error), code: error.code }, distributionErrorStatus(error));
    }
    throw error;
  }
}
