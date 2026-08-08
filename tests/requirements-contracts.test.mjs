import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function sources(paths) {
  return Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")));
}

test("employee profiles persist the required address, age and CCCD fields", async () => {
  const [schema, runtime, api, uploadApi, ui, hosting] = await sources([
    "../db/schema.ts",
    "../db/runtime.ts",
    "../app/api/employees/route.ts",
    "../app/api/uploads/route.ts",
    "../app/components/EmployeeManagement.tsx",
    "../.openai/hosting.json",
  ]);

  for (const column of ["province", "ward", "address_line", "age", "cccd_image_key", "cccd_image_name"]) {
    assert.match(`${schema}\n${runtime}`, new RegExp(column, "u"));
  }
  for (const field of ["province", "ward", "addressLine", "age", "cccdImageKey", "cccdImageName"]) {
    assert.match(api, new RegExp(field, "u"));
    assert.match(ui, new RegExp(field, "u"));
  }
  assert.match(api, /INSERT INTO employees .*province, ward, address_line, age, cccd_image_key, cccd_image_name/u);
  assert.match(api, /UPDATE employees SET .*province = \?, ward = \?, address_line = \?, age = \?, cccd_image_key = \?, cccd_image_name = \?/u);
  assert.match(uploadApi, /image\/jpeg.*image\/png.*image\/webp/su);
  assert.match(uploadApi, /5 \* 1024 \* 1024/u);
  assert.match(uploadApi, /UPLOADS/u);
  assert.match(hosting, /"r2"\s*:\s*"UPLOADS"/u);
});

test("inventory receipts use a persistent multi-line list and server-calculated totals", async () => {
  const [recordsApi, inventoryUi] = await sources([
    "../app/api/records/route.ts",
    "../app/components/InventoryManagement.tsx",
  ]);

  assert.match(recordsApi, /if \(category === "NHAP_HANG"\)/u);
  assert.match(recordsApi, /rawItems\.length === 0 \|\| rawItems\.length > 100/u);
  assert.match(recordsApi, /const goodsAmount = Math\.round\(weight \* unitPrice\)/u);
  assert.match(recordsApi, /goodsTotal, shippingTotal, total: sumVnd\(\[goodsTotal, shippingTotal\]\)/u);
  assert.match(recordsApi, /receiptNo: `PN-/u);
  assert.match(recordsApi, /savedAt: now, savedBy: user\.id/u);

  assert.match(inventoryUi, /items\.map\(\(item/u);
  assert.match(inventoryUi, /Th[êe]m h[àa]ng h[oó]a/u);
  assert.match(inventoryUi, /setItems\(\[createDraftItem\(\)\]\)/u);
  assert.match(inventoryUi, /await reloadHistory\(\)/u);
});

test("reports compare periods and dividend closing requires every store ledger to be locked", async () => {
  const [reportsApi, financeAggregation, reportUi] = await sources([
    "../app/api/reports/route.ts",
    "../app/api/_lib/store-finance.ts",
    "../app/components/FinancialReports.tsx",
  ]);

  assert.match(reportsApi, /const priorPeriod = previousPeriod\(period\)/u);
  assert.match(reportsApi, /storePeriodFinance\(db, id, period\)/u);
  assert.match(reportsApi, /comparison:/u);
  assert.match(reportsApi, /category = 'PAYROLL_CLOSING'.*status = 'LOCKED'/su);
  assert.match(reportsApi, /category = 'DIVIDEND'.*status = 'LOCKED'/su);
  assert.match(reportsApi, /multiplyRatioVnd\(profit, 60, 100\)/u);
  assert.match(reportsApi, /DIVIDEND_PERIOD_CLOSE/u);
  assert.match(financeAggregation, /category = 'CHI_PHI_CO_DINH'/u);
  assert.match(financeAggregation, /category = 'NHAP_HANG'/u);
  assert.match(financeAggregation, /profitBeforePerformanceRewards/u);
  assert.match(reportUi, /CLOSE_DIVIDEND/u);
  assert.match(reportUi, /profitChange/u);
});

test("operating expenses are validated, persisted and included in store finance", async () => {
  const [recordsApi, financeAggregation, expenseUi, portal] = await sources([
    "../app/api/records/route.ts",
    "../app/api/_lib/store-finance.ts",
    "../app/components/StoreOperatingExpense.tsx",
    "../app/components/Portal.tsx",
  ]);

  assert.match(recordsApi, /if \(category === "DONG_TIEN"\)/u);
  assert.match(recordsApi, /!validDate\(date\) \|\| !isVnd\(amount\) \|\| amount <= 0 \|\| !note/u);
  assert.match(recordsApi, /isPayrollPeriodLocked\(db, storeId, date\.slice\(0, 7\)\)/u);
  assert.match(recordsApi, /date, period: date\.slice\(0, 7\), amount, note/u);

  assert.match(financeAggregation, /category = 'DONG_TIEN'.*store_id = \?.*status != 'DELETED'/u);
  assert.match(financeAggregation, /incidentalCosts = sumVnd\(\[\s*incidentalCosts,\s*\.\.\.incidentalResult\.results\.map/su);
  assert.match(financeAggregation, /incidentalCosts,/u);

  assert.match(expenseUi, /export function StoreOperatingExpense/u);
  assert.match(expenseUi, /category: "DONG_TIEN"/u);
  assert.match(expenseUi, /Tạo chi phí phát sinh/u);
  assert.match(expenseUi, /await onSaved\?\.\(\)/u);
  assert.match(expenseUi, /hourCycle: "h23"/u);
  assert.match(portal, /import \{ StoreOperatingExpense \} from "\.\/StoreOperatingExpense"/u);
  assert.match(portal, /view === "Dòng tiền".*<StoreOperatingExpense store=\{store\}/su);
});

test("payroll and dividend ledgers can only advance through audited locking actions", async () => {
  const [payrollApi, recordsApi] = await sources([
    "../app/api/payroll/route.ts",
    "../app/api/records/route.ts",
  ]);

  for (const action of [
    "FINALIZE_EMPLOYEE",
    "FINALIZE_MANAGER",
    "CONFIRM_SALARY",
    "CONFIRM_REWARDS",
    "CONFIRM_PAYMENT",
    "CLOSE_PERIOD",
  ]) assert.match(payrollApi, new RegExp(action, "u"));

  for (const state of [
    "MANAGER_FINALIZED",
    "SALARY_CONFIRMED",
    "REWARDS_CONFIRMED",
    "PAYMENT_CONFIRMED",
    "LOCKED",
  ]) assert.match(payrollApi, new RegExp(state, "u"));

  for (const audit of [
    "PAYROLL_FINALIZE",
    "MANAGER_PAYROLL_FINALIZE",
    "PAYROLL_SALARY_CONFIRM",
    "PAYROLL_REWARDS_CONFIRM",
    "PAYROLL_PAYMENT_CONFIRM",
    "PAYROLL_PERIOD_CLOSE",
  ]) assert.match(payrollApi, new RegExp(audit, "u"));

  assert.match(recordsApi, /protectedCategories = new Set\(\["KPI_SUMMARY", "PAYROLL_CLOSING", "DIVIDEND"\]\)/u);
  assert.match(recordsApi, /protectedCategories\.has\(body\.category\)/u);
  assert.match(recordsApi, /String\(existing\.status\) === "LOCKED" \|\| protectedCategories\.has/u);
  assert.match(recordsApi, /existing\.category === "KPI_SUMMARY".*existing\.category === "PAYROLL_CLOSING".*existing\.category === "DIVIDEND"/u);
});

test("employee payroll exposes main/support shift identity and actual-pay components", async () => {
  const [payrollApi, payrollUi] = await sources([
    "../app/api/payroll/route.ts",
    "../app/components/ReferenceEmployeeModules.tsx",
  ]);

  for (const field of ["shiftDetails", "isSupport", "storeName", "sourceStoreName", "hours", "hourlyRate", "baseSalary", "supportAllowance", "netPay"]) {
    assert.match(payrollApi, new RegExp(field, "u"));
  }
  assert.match(payrollApi, /multiplyRatioVnd\(safePayrollVnd\(shift\.supportAllowance\)/u);
  assert.match(payrollUi, /Nh[âa]n vi[êe]n h[oỗ] tr[oợ]/u);
  assert.match(payrollUi, /Lương h[oỗ] tr[oợ]\/gi[oờ]/u);
  assert.match(payrollUi, /Gi[oờ] th[ựu]c t[ếe]/u);
  assert.match(payrollUi, /Ph[ụu] c[ấa]p h[oỗ] tr[oợ]/u);
  assert.match(payrollUi, /Th[ựu]c nh[ậa]n ca/u);
});

test("migration upgrades existing employee and shift tables without recreating them", async () => {
  const migration = await readFile(new URL("../drizzle/0005_employee_profile_shift_rollover.sql", import.meta.url), "utf8");
  for (const column of [
    "province",
    "ward",
    "address_line",
    "age",
    "cccd_image_key",
    "cccd_image_name",
    "scheduled_start_at",
    "scheduled_end_at",
    "previous_session_id",
    "close_reason",
    "close_status",
  ]) assert.match(migration, new RegExp("ADD `" + column + "`", "u"));
  assert.match(migration, /CREATE INDEX `idx_shift_sessions_employee_active` ON `shift_sessions` \(`employee_id`,`status`,`scheduled_end_at`\)/u);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_shift_sessions_previous_session` ON `shift_sessions` \(`previous_session_id`\) WHERE `previous_session_id` IS NOT NULL/u);
  assert.doesNotMatch(migration, /CREATE TABLE/u);
});
