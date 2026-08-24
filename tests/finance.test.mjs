import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function financeModule() {
  const source = await readFile(new URL("../app/lib/finance.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("VND values are safe integers and use explicit rounding", async () => {
  const { formatVnd, isVnd, multiplyDecimalVnd, multiplyRatioVnd, requireVnd } = await financeModule();
  assert.equal(isVnd(25_000), true);
  assert.equal(isVnd(25_000.5), false);
  assert.throws(() => requireVnd(-1), /không âm/);
  assert.equal(multiplyDecimalVnd(101, "0.03"), 3);
  assert.equal(multiplyDecimalVnd(150, "0.01"), 2);
  assert.equal(multiplyDecimalVnd(150, "0.01", "DOWN"), 1);
  assert.equal(multiplyRatioVnd(20_000, 18_180, 3_600), 101_000);
  assert.equal(formatVnd(15_000), "15,000 đồng");
  assert.equal(formatVnd(12_890), "12,890 đồng");
});

test("profit sharing never nets store losses and preserves exact legacy 40/60 totals", async () => {
  const { allocateStoreProfitSharing } = await financeModule();
  const rows = allocateStoreProfitSharing([12_000_000, -2_000_000, 6_000_000, 4_000_000]);
  assert.equal(rows.reduce((sum, row) => sum + row.distributableProfit, 0), 22_000_000);
  assert.equal(rows.reduce((sum, row) => sum + row.firstShareAmount, 0), 8_800_000);
  assert.equal(rows.reduce((sum, row) => sum + row.secondShareAmount, 0), 13_200_000);
  assert.equal(rows[1].distributableProfit, 0);
  assert.deepEqual(allocateStoreProfitSharing([12_000_000, -20_000_000]).map((row) => row.distributableProfit), [12_000_000, 0]);

  const rounding = allocateStoreProfitSharing([1, 1]);
  assert.equal(rounding.reduce((sum, row) => sum + row.distributableProfit, 0), 2);
  assert.equal(rounding.reduce((sum, row) => sum + row.firstShareAmount, 0), 1);
  assert.equal(rounding.reduce((sum, row) => sum + row.secondShareAmount, 0), 1);
  for (const row of rounding) assert.equal(row.firstShareAmount + row.secondShareAmount, row.distributableProfit);
});

test("final store profit deducts employee KPI and manager KPI exactly once", async () => {
  const { settleStoreProfit } = await financeModule();
  assert.deepEqual(settleStoreProfit(100_000_000, 4_000_000, 3_000_000), {
    profitBeforePerformanceRewards: 100_000_000,
    employeeKpiBonus: 4_000_000,
    managerBonus: 3_000_000,
    performanceRewards: 7_000_000,
    finalProfit: 93_000_000,
  });
  assert.deepEqual(settleStoreProfit(-5_000_000, 0, 0), {
    profitBeforePerformanceRewards: -5_000_000,
    employeeKpiBonus: 0,
    managerBonus: 0,
    performanceRewards: 0,
    finalProfit: -5_000_000,
  });
});

test("tender reconciliation reports entered minus expected per payment method", async () => {
  const { tenderDifferences } = await financeModule();
  assert.deepEqual(tenderDifferences(
    { cash: 1_000_000, bankTransfer: 500_000 },
    { cash: 950_000, bankTransfer: 550_000 },
  ), { cash: -50_000, bankTransfer: 50_000 });
});

test("Vietnam payroll periods have exact UTC boundaries", async () => {
  const { localDate, localPeriod, periodBoundsUtc } = await financeModule();
  assert.deepEqual(periodBoundsUtc("2026-08"), {
    localStart: "2026-08-01",
    localEnd: "2026-09-01",
    startUtc: "2026-07-31T17:00:00.000Z",
    endUtc: "2026-08-31T17:00:00.000Z",
  });
  const instant = new Date("2026-07-31T18:30:00.000Z");
  assert.equal(localDate(instant), "2026-08-01");
  assert.equal(localPeriod(instant), "2026-08");
});

test("payroll closing opens on the final Vietnam calendar day across month boundaries", async () => {
  const { canClosePayrollPeriod, payrollPeriodClosingDate } = await financeModule();

  assert.equal(payrollPeriodClosingDate("2025-02"), "2025-02-28");
  assert.equal(payrollPeriodClosingDate("2024-02"), "2024-02-29", "leap February must include day 29");
  assert.equal(payrollPeriodClosingDate("2026-12"), "2026-12-31", "December must not roll into the next year");

  assert.equal(canClosePayrollPeriod("2025-02", new Date("2025-02-27T16:59:59.999Z")), false);
  assert.equal(canClosePayrollPeriod("2025-02", new Date("2025-02-27T17:00:00.000Z")), true, "00:00 on the last Vietnam day opens closing");
  assert.equal(canClosePayrollPeriod("2024-02", new Date("2024-02-28T17:00:00.000Z")), true, "leap-day boundary opens closing");
  assert.equal(canClosePayrollPeriod("2026-12", new Date("2026-12-30T17:00:00.000Z")), true, "year-end boundary opens closing");
  assert.equal(canClosePayrollPeriod("2026-12", new Date("2026-12-31T17:00:00.000Z")), true, "day one of the next year remains open");
  assert.equal(canClosePayrollPeriod("2027-01", new Date("2026-12-31T17:00:00.000Z")), false, "a future payroll month remains blocked");
  assert.throws(() => payrollPeriodClosingDate("2026-13"), /không hợp lệ/u);
});

test("Vietnam report ranges include the end date and compare the exact preceding span", async () => {
  const {
    dateRangeBoundsUtc,
    localDateRangeKeys,
    previousComparableDateRange,
    previousEqualDateRange,
  } = await financeModule();

  const leapRange = { from: "2024-02-28", to: "2024-03-01" };
  assert.deepEqual(localDateRangeKeys(leapRange), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.deepEqual(dateRangeBoundsUtc(leapRange), {
    localStart: "2024-02-28",
    localEnd: "2024-03-02",
    startUtc: "2024-02-27T17:00:00.000Z",
    endUtc: "2024-03-01T17:00:00.000Z",
  });
  assert.deepEqual(previousEqualDateRange(leapRange), { from: "2024-02-25", to: "2024-02-27" });
  assert.deepEqual(previousEqualDateRange({ from: "2026-01-01", to: "2026-01-02" }), {
    from: "2025-12-30",
    to: "2025-12-31",
  });
  assert.deepEqual(previousComparableDateRange(
    { from: "2026-03-01", to: "2026-08-31" },
    "month",
  ), { from: "2025-09-01", to: "2026-02-28" });
});

test("finance ranges reject excessive and future windows", async () => {
  const { validateFinanceDateRange } = await financeModule();
  assert.deepEqual(validateFinanceDateRange(
    { from: "2026-01-01", to: "2026-12-31" },
    "day",
    "2026-12-31",
  ), { days: 365, months: 12 });
  assert.throws(() => validateFinanceDateRange(
    { from: "2025-12-30", to: "2026-12-31" },
    "day",
    "2026-12-31",
  ), /366 ngày/u);
  assert.throws(() => validateFinanceDateRange(
    { from: "2021-12-01", to: "2026-12-31" },
    "month",
    "2026-12-31",
  ), /60 tháng/u);
  assert.throws(() => validateFinanceDateRange(
    { from: "2026-08-01", to: "2026-08-09" },
    "day",
    "2026-08-08",
  ), /ngày hiện tại/u);
});

test("timeline summaries remain exact for empty data, losses and VND totals", async () => {
  const { evaluateFinancePerformance, summarizeAccrualTimeline, summarizeCashTimeline } = await financeModule();
  assert.deepEqual(summarizeAccrualTimeline([]), { revenue: 0, expense: 0, profit: 0 });
  assert.deepEqual(summarizeAccrualTimeline([
    { revenue: 100_000, expense: 40_000 },
    { revenue: 50_000, expense: 75_000 },
  ]), { revenue: 150_000, expense: 115_000, profit: 35_000 });
  assert.deepEqual(summarizeCashTimeline([
    { inflow: 100_000, outflow: 40_000 },
    { inflow: 50_000, outflow: 75_000 },
  ]), { inflow: 150_000, outflow: 115_000, net: 35_000 });
  assert.deepEqual(evaluateFinancePerformance(
    { revenue: 0, expense: 10_000, profit: -10_000 },
    { revenue: 0, expense: 0, profit: 0 },
  ), {
    margin: null,
    revenueChange: 0,
    expenseChange: 100,
    profitChange: -100,
    rating: "CẦN CẢI THIỆN",
    direction: "SUY GIẢM",
  });
});

test("comparison populations retain stores that closed between ranges", async () => {
  const { financeComparisonPopulation } = await financeModule();
  const closedStorePrevious = { id: "closed", revenue: 80_000, expense: 30_000, profit: 50_000 };
  const continuingCurrent = { id: "open", revenue: 100_000, expense: 40_000, profit: 60_000 };
  const continuingPrevious = { id: "open", revenue: 90_000, expense: 35_000, profit: 55_000 };
  assert.deepEqual(financeComparisonPopulation([
    { current: null, previous: closedStorePrevious },
    { current: continuingCurrent, previous: continuingPrevious },
  ]), {
    current: [continuingCurrent],
    previous: [closedStorePrevious, continuingPrevious],
  });
});

test("fixed and inventory cashflow requires an explicit payment timestamp", async () => {
  const source = await readFile(new URL("../app/api/cashflow/route.ts", import.meta.url), "utf8");
  assert.match(source, /r\.category IN \('NHAP_HANG', 'CHI_PHI_CO_DINH'\)/u);
  assert.match(source, /\[data\.paidAt, data\.paymentDate, data\.paymentConfirmedAt\]/u);
  assert.match(source, /skippedUnpaidLegacyCount \+= 1/u);
  assert.match(source, /validEntryDate\(date, range\)/u);
  assert.doesNotMatch(source, /\[data\.paidAt, data\.paymentDate, data\.date\]/u);
  assert.doesNotMatch(source, /r\.category = 'CHI_PHI_CO_DINH'[\s\S]{0,160}json_extract\(r\.data_json, '\$\.period'\) >= \?/u);
});

test("report settlement status and canonical profit distributions stay truthful", async () => {
  const [reports, storeFinance] = await Promise.all([
    readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_lib/store-finance.ts", import.meta.url), "utf8"),
  ]);
  assert.match(reports, /to: month\.to > today \? today : month\.to/u);
  assert.match(reports, /readProfitDistribution\(db, distributionPeriod\)/u);
  assert.match(reports, /listProfitDistributions\(db, \{ limit: 36 \}\)/u);
  assert.match(reports, /previewProfitDistribution\(db, distributionPeriod\)/u);
  assert.match(reports, /parsePersistedFinancialPeriodSnapshot\(store\.financialSnapshot\)/u);
  assert.match(reports, /closeProfitDistribution\(db, \{/u);
  assert.doesNotMatch(reports, /profitSharingSnapshot|category = 'DIVIDEND'|business_records/u);
  assert.match(storeFinance, /category = 'PAYROLL_CLOSING'.*status != 'DELETED'/u);
  assert.match(storeFinance, /closingRow\?\.status === "LOCKED"/u);
  assert.match(storeFinance, /function periodStatusPayload/u);
  assert.match(storeFinance, /calculationStatus: persistedStatus\?\.calculationStatus \?\? "PROVISIONAL"/u);
  assert.match(storeFinance, /settlementStatus: persistedStatus\?\.settlementStatus \?\? legacySettlementStatus/u);
  assert.match(storeFinance, /if \(activeDayCount === 0\) return null/u);
});

test("shift duration keeps actual seconds and derives exact minutes", async () => {
  const { durationMinutes, durationSeconds } = await financeModule();
  const seconds = durationSeconds("2026-08-01T00:00:00.000Z", "2026-08-01T05:03:00.000Z");
  assert.equal(seconds, 18_180);
  assert.equal(durationMinutes(seconds), 303);
  assert.equal(durationMinutes(90), 1.5);
  assert.throws(() => durationSeconds("invalid", "2026-08-01T00:00:00.000Z"), /không hợp lệ/);
});

test("D1 persists integer seconds while minutes and hours stay derived", async () => {
  const [schema, runtime, migration, shiftApi] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_finance_duration.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [schema, runtime, migration, shiftApi]) assert.match(source, /duration_seconds/u);
  assert.doesNotMatch(migration, /duration_minutes/u);
  assert.match(shiftApi, /durationMinutes\(workedSeconds\)/u);
});
