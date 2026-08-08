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

test("a rollover successor is attributed to work_date across a month boundary", async () => {
  const { shiftAccountingDate } = await financeModule();
  const continuousBoundary = "2026-07-31T16:00:00.000Z"; // 23:00 on 31/07 in Vietnam.

  assert.equal(shiftAccountingDate("2026-08-01", continuousBoundary), "2026-08-01");
  assert.equal(shiftAccountingDate("2026-07-31", continuousBoundary), "2026-07-31");
  assert.equal(shiftAccountingDate(null, continuousBoundary), "2026-07-31");
  assert.notEqual(
    shiftAccountingDate("2026-08-01", continuousBoundary).slice(0, 7),
    shiftAccountingDate("2026-07-31", continuousBoundary).slice(0, 7),
    "the predecessor and successor must not be counted in the same month",
  );
});

test("a store enters reports only after its Vietnam-local creation boundary", async () => {
  const { storeExistsInPeriod } = await financeModule();

  assert.equal(storeExistsInPeriod("2026-08-31T16:59:59.999Z", "2026-08"), true);
  assert.equal(storeExistsInPeriod("2026-08-31T17:00:00.000Z", "2026-08"), false);
  assert.equal(storeExistsInPeriod("2026-08-31T18:00:00.000Z", "2026-08"), false);
  assert.equal(storeExistsInPeriod("2026-08-31T18:00:00.000Z", "2026-09"), true);
  assert.equal(storeExistsInPeriod("invalid", "2026-09"), false);
});

test("finance, payroll and cash-flow queries prioritize work_date with one legacy fallback", async () => {
  const [storeFinance, payroll, cashflow, records] = await Promise.all([
    readFile(new URL("../app/api/_lib/store-finance.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payroll/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cashflow/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/records/route.ts", import.meta.url), "utf8"),
  ]);
  const aliasedPredicate = /\(NULLIF\(s\.work_date, ''\) IS NOT NULL AND s\.work_date >= \? AND s\.work_date < \?\)[\s\S]*?OR \(NULLIF\(s\.work_date, ''\) IS NULL AND s\.started_at >= \? AND s\.started_at < \?\)/u;
  const unaliasedPredicate = /\(NULLIF\(work_date, ''\) IS NOT NULL AND work_date >= \? AND work_date < \?\)[\s\S]*?OR \(NULLIF\(work_date, ''\) IS NULL AND started_at >= \? AND started_at < \?\)/u;

  assert.match(storeFinance, aliasedPredicate);
  assert.match(cashflow, aliasedPredicate);
  assert.match(payroll, aliasedPredicate);
  assert.match(payroll, unaliasedPredicate);
  assert.match(cashflow, /shiftAccountingDate\(row\.workDate, row\.startedAt\)/u);
  assert.doesNotMatch(cashflow, /localDate\(row\.endedAt\)/u);
  assert.match(records, /COALESCE\(NULLIF\(s\.work_date, ''\), date\(s\.started_at, '\+7 hours'\)\)/u);
});

test("reports and payroll reject periods before the store existed", async () => {
  const [storeFinance, reports, payroll] = await Promise.all([
    readFile(new URL("../app/api/_lib/store-finance.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payroll/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(storeFinance, /created_at AS createdAt/u);
  assert.match(storeFinance, /!store \|\| !storeExistsInPeriod\(store\.createdAt, period\)/u);
  assert.match(reports, /const population = financeComparisonPopulation\(rows\)/u);
  assert.match(reports, /row\.current[\s\S]*evaluation: effectiveness\(row\.current, row\.previous\)/u);
  assert.match(payroll, /const store = await storePeriodFinance\(db, storeId, period\);[\s\S]*?if \(!store\) return null;/u);
});
