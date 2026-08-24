import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../app/components/MonthEndExpensePanel.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/components/MonthEndExpensePanel.module.css", import.meta.url), "utf8");
const portal = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
const reports = await readFile(new URL("../app/components/FinancialReports.tsx", import.meta.url), "utf8");

test("store navigation exposes the month-end expense source module", () => {
  assert.match(portal, /"Dòng tiền", "Chi phí cuối kỳ", "Báo cáo"/u);
  assert.match(portal, /view === "Chi phí cuối kỳ"[\s\S]*<MonthEndExpensePanel/u);
  assert.match(portal, /monthEndExpenses: "Chi phí cuối kỳ"/u);
});

test("month-end expense UI keeps accounting expense separate from cashflow", () => {
  assert.match(panel, /fetch\("\/api\/month-end-expenses"/u);
  assert.doesNotMatch(panel, /\/api\/(?:cashflow|store-cashflow)/u);
  assert.match(panel, /method: creating \? "POST" : mode === "EDIT" \? "PATCH" : "DELETE"/u);
  assert.match(panel, /Idempotency-Key/u);
  assert.match(panel, /version: selected\?\.version/u);
  assert.match(panel, /reason: reason\.trim\(\)/u);
});

test("financial report and export expose month-end expense as a distinct line", () => {
  assert.match(reports, /monthEndExpenses: number/u);
  assert.match(reports, /key: "monthEndExpenses", label: "Chi phí cuối kỳ"/u);
  assert.match(reports, /EXPENSE_FIELDS\.map\(\(field\) => field\.label\)/u);
});

test("month-end expense panel becomes mobile cards without page-wide overflow", () => {
  assert.match(styles, /@media\(max-width:720px\)/u);
  assert.match(styles, /\.tableWrap\{overflow:visible\}/u);
  assert.match(styles, /\.table,.table tbody,.table tr,.table td\{display:block/u);
  assert.match(styles, /\.modal\{width:100%;max-height:92dvh/u);
  assert.match(styles, /\.headerActions\{display:grid;grid-template-columns:1fr 1fr\}/u);
});
