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
  for (const label of ["Tổng mặt hàng", "Chi phí vận chuyển", "Tiền nhập hàng", "Tổng cộng"]) {
    assert.match(inventoryUi, new RegExp(label, "u"));
  }
  assert.match(inventoryUi, /formatMoney\(draftTotals\.shipping\)/u);
  assert.match(inventoryUi, /formatMoney\(draftTotals\.goods\)/u);
  assert.match(inventoryUi, /formatMoney\(draftTotals\.amount\)/u);
  assert.match(inventoryUi, /value=\{formatMoneyInput\(item\.unitPrice\)\}/u);
  assert.match(inventoryUi, /value=\{formatMoneyInput\(item\.shipping\)\}/u);
});

test("fixed costs use an eight-line resettable draft and persist custom rows in audited history", async () => {
  const [recordsApi, fixedCostUi, financeAggregation] = await sources([
    "../app/api/records/route.ts",
    "../app/components/FixedCostManagement.tsx",
    "../app/api/_lib/store-finance.ts",
  ]);

  for (const label of ["Set up", "Mặt bằng", "Điện", "Nước", "Wifi", "Marketing", "Rác", "Khác"]) {
    assert.match(fixedCostUi, new RegExp(label, "u"));
  }
  assert.match(fixedCostUi, /createDefaultDraft/u);
  assert.match(fixedCostUi, /Thêm chi phí/u);
  assert.match(fixedCostUi, /form="fixed-cost-entry-form"/u);
  assert.match(fixedCostUi, /id="fixed-cost-entry-form"/u);
  assert.match(fixedCostUi, /fixed-cost-toolbar-save/u);
  assert.match(fixedCostUi, /items\.map\(\(item, index\)/u);
  assert.match(fixedCostUi, /setItems\(createDefaultDraft\(\)\)/u);
  assert.match(fixedCostUi, /value=\{formatMoneyInput\(item\.amount\)\}/u);
  assert.match(fixedCostUi, /hourCycle: "h23"/u);

  assert.match(recordsApi, /rawItems\.length < fixedCostKeys\.length \|\| rawItems\.length > 100/u);
  assert.match(recordsApi, /seenKeys\.size !== fixedCostKeys\.length/u);
  assert.match(recordsApi, /total: sumVnd\(items\.map\(\(item\) => item\.amount\)\)/u);
  assert.match(recordsApi, /changeHistory: \[\{ action: "CREATE", at: now, by: user\.id, total: data\.total, items: data\.items \}\]/u);
  assert.match(recordsApi, /action: "UPDATE", at: updatedAt, by: user\.id, total: data\.total, items: data\.items/u);
  assert.match(financeAggregation, /const savedTotal = safeVnd\(data\.total\)/u);
});

test("reports compare periods and dividend closing requires every store ledger to be locked", async () => {
  const [reportsApi, financeAggregation, reportUi] = await sources([
    "../app/api/reports/route.ts",
    "../app/api/_lib/store-finance.ts",
    "../app/components/FinancialReports.tsx",
  ]);

  assert.match(reportsApi, /const range = localMonthRange\(period\)/u);
  assert.match(reportsApi, /reportRangeData\(db, range, previousRange, "month"/u);
  assert.match(reportsApi, /for \(const store of report\.stores\)/u);
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

test("attendance and employee payroll distinguish hourly rate from earned salary", async () => {
  const [attendanceUi, closingUi] = await sources([
    "../app/components/ReferenceStoreModules.tsx",
    "../app/components/StorePayrollClosing.tsx",
  ]);

  for (const label of ["Theo ca", "Theo ngày", "Theo tháng · từng nhân viên", "Lương cứng", "Lương thực nhận"]) {
    assert.match(attendanceUi, new RegExp(label, "u"));
  }
  assert.match(attendanceUi, /hourlyMoney\(row\.rates\[0\]\)/u);
  assert.match(attendanceUi, /current\.salary \+= Math\.round\(seconds \/ 3_600 \* rate\)/u);
  assert.doesNotMatch(attendanceUi, /const fallback: ShiftSession/u);
  assert.match(closingUi, /money\(item\.hourlyRate\)\}\/giờ/u);
  assert.match(closingUi, /money\(item\.baseSalary\)/u);
  assert.match(closingUi, /Lương thực nhận = lương cứng theo giờ × giờ làm thực tế/u);
});

test("manager payroll uses only locked store ledgers and final profit includes every payroll cost", async () => {
  const [payrollApi, portal, finance, aggregation] = await sources([
    "../app/api/payroll/route.ts",
    "../app/components/Portal.tsx",
    "../app/lib/finance.ts",
    "../app/api/_lib/store-finance.ts",
  ]);

  assert.match(payrollApi, /category = 'PAYROLL_CLOSING' AND status = 'LOCKED'/u);
  assert.match(payrollApi, /params\.get\("scope"\) === "manager"/u);
  assert.match(payrollApi, /policy: \{ salaryPerStore: MANAGER_MONTHLY_SALARY_VND, bonusRate: 0\.02 \}/u);
  assert.match(payrollApi, /settleStoreProfit\(profit, totalKpiBonus\)/u);
  assert.match(portal, /view === "Lương thưởng quản lý"[\s\S]*return <ManagerPayroll\/>/u);
  assert.match(portal, /Chỉ ghi nhận số liệu thật từ các cửa hàng đã xác nhận chi và khóa kỳ/u);
  assert.match(finance, /profitBeforePerformanceRewards - performanceRewards/u);
  assert.match(aggregation, /managerSalary: MANAGER_MONTHLY_SALARY_VND/u);
  assert.match(aggregation, /lockedSnapshot[\s\S]*managerProfitBonus\(profitBeforePerformanceRewards\)/u);
  assert.match(aggregation, /employeeKpiBonusFromSeconds\(profitBeforePerformanceRewards, totalDurationSeconds, seconds\)/u);
  assert.match(aggregation, /const expense = sumVnd\(\[baseExpense, employeeKpiBonus, managerBonus\]\)/u);
  assert.match(aggregation, /profit: revenue - expense/u);
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
  assert.match(payrollUi, /Giờ làm thực tế/u);
  assert.match(payrollUi, /Ph[ụu] c[ấa]p h[oỗ] tr[oợ]/u);
  assert.match(payrollUi, /Lương thực nhận/u);
  assert.doesNotMatch(payrollUi, /Thực nhận ca/u);
  assert.match(payrollUi, /mainShiftRows.*!row\.isSupport/u);
  assert.match(payrollUi, /supportShiftRows.*row\.isSupport/u);
  assert.match(payrollUi, /support \? <><th>Lương hỗ trợ\/giờ<\/th><th>Phụ cấp hỗ trợ<\/th><\/> : <th>Lương cứng<\/th>/u);
});

test("website and store cards use logo.jpg as the canonical favicon and brand asset", async () => {
  const [layout, login, portal] = await sources([
    "../app/layout.tsx",
    "../app/page.tsx",
    "../app/components/Portal.tsx",
  ]);

  assert.match(layout, /url: "\/logo\.jpg\?v=/u);
  assert.match(login, /src="\/logo\.jpg"/u);
  assert.match(portal, /src="\/logo\.jpg"/u);
  assert.doesNotMatch(`${layout}\n${login}\n${portal}`, /\/dore-logo\.jpg/u);
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
