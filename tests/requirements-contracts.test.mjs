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

  for (const column of ["province", "ward", "address_line", "age", "cccd_number", "cccd_image_key", "cccd_image_name"]) {
    assert.match(`${schema}\n${runtime}`, new RegExp(column, "u"));
  }
  for (const field of ["province", "ward", "addressLine", "age", "cccdNumber", "cccdImageKey", "cccdImageName"]) {
    assert.match(api, new RegExp(field, "u"));
    assert.match(ui, new RegExp(field, "u"));
  }
  assert.match(api, /INSERT INTO employees[\s\S]*province, ward, address_line, age,[\s\S]*cccd_number, cccd_image_key, cccd_image_name/u);
  assert.match(api, /UPDATE employees SET[\s\S]*province = \?, ward = \?,[\s\S]*address_line = \?, age = \?, cccd_number = \?, cccd_image_key = \?, cccd_image_name = \?/u);
  assert.match(uploadApi, /image\/jpeg.*image\/png.*image\/webp/su);
  assert.match(uploadApi, /5 \* 1024 \* 1024/u);
  assert.match(uploadApi, /UPLOADS/u);
  assert.match(hosting, /"r2"\s*:\s*"UPLOADS"/u);
});

test("inventory receipts use a persistent mobile-safe list and server-calculated totals", async () => {
  const [recordsApi, receiptCode, inventoryUi, styles] = await sources([
    "../app/api/records/route.ts",
    "../app/lib/inventory-receipt-code.ts",
    "../app/components/InventoryManagement.tsx",
    "../app/globals.css",
  ]);

  assert.match(recordsApi, /if \(category === "NHAP_HANG"\)/u);
  assert.match(recordsApi, /rawItems\.length === 0 \|\| rawItems\.length > 100/u);
  assert.match(recordsApi, /const goodsAmount = Math\.round\(weight \* unitPrice\)/u);
  assert.match(recordsApi, /goodsTotal, shippingTotal, total: sumVnd\(\[goodsTotal, shippingTotal\]\)/u);
  assert.match(recordsApi, /inventoryReceiptDateToken\(receiptDate\)/u);
  assert.match(recordsApi, /printf\('PN-%s-%05d'/u);
  assert.match(receiptCode, /return `PN-\$\{inventoryReceiptDateToken\(receiptDate\)\}-\$\{String\(sequence\)\.padStart\(5, "0"\)\}`/u);
  assert.match(recordsApi, /json_set\(\?, '\$\.receiptNo', request\.receipt_no, '\$\.savedAt', \?, '\$\.savedBy', \?\)/u);
  assert.match(recordsApi, /import \{ summarizeInventoryHistory \} from "\.\.\/\.\.\/lib\/inventory"/u);
  assert.match(recordsApi, /historySummary: summarizeInventoryHistory\(summaryRows\.map\(\(row\) => parseRow\(row\)\.data\)\)/u);
  assert.match(recordsApi, /const includeAllHistory = params\.get\("all"\) === "1"/u);

  assert.match(inventoryUi, /items\.map\(\(item/u);
  assert.match(inventoryUi, /Th[êe]m h[àa]ng h[oó]a/u);
  assert.match(inventoryUi, /setItems\(\[createDraftItem\(\)\]\)/u);
  assert.match(inventoryUi, /await reloadHistory\(\)/u);
  for (const label of ["Tổng mặt hàng đã nhập", "Tổng chi phí vận chuyển", "Tổng tiền nhập hàng", "Tổng cộng đã nhập"]) {
    assert.match(inventoryUi, new RegExp(label, "u"));
  }
  assert.match(inventoryUi, /formatMoney\(draftTotals\.shipping\)/u);
  assert.match(inventoryUi, /formatMoney\(draftTotals\.goods\)/u);
  assert.match(inventoryUi, /formatMoney\(draftTotals\.amount\)/u);
  assert.match(inventoryUi, /aria-label="Tổng hợp lịch sử nhập hàng đã lưu"/u);
  assert.match(inventoryUi, /formatMoney\(historySummary\.shipping\)/u);
  assert.match(inventoryUi, /formatMoney\(historySummary\.goods\)/u);
  assert.match(inventoryUi, /formatMoney\(historySummary\.amount\)/u);
  assert.match(inventoryUi, /all: "1"/u);
  assert.match(inventoryUi, /phiếu gần nhất · \$\{historySummary\.receiptCount\} phiếu đã ghi nhận/u);
  assert.match(inventoryUi, /value=\{formatMoneyInput\(item\.unitPrice\)\}/u);
  assert.match(inventoryUi, /value=\{formatMoneyInput\(item\.shipping\)\}/u);

  const draftTableIndex = inventoryUi.indexOf('className="data-table inventory-draft-table"');
  const addItemActionIndex = inventoryUi.indexOf('className="inventory-add-item-actions"');
  const noteIndex = inventoryUi.indexOf('placeholder="Ghi chú chung cho phiếu nhập"');
  assert.ok(draftTableIndex >= 0 && draftTableIndex < addItemActionIndex, "add-item action must follow the inventory list");
  assert.ok(addItemActionIndex < noteIndex, "add-item action must stay directly above the receipt note");
  assert.match(inventoryUi, /<button type="button" disabled=\{inactive \|\| saving \|\| items\.length >= 100\} onClick=\{addItem\}>/u);
  assert.match(inventoryUi, /className="inventory-draft-fieldset"/u);
  assert.match(inventoryUi, /className="data-table-wrap inventory-table-scroll" role="region" aria-label=/u);
  assert.doesNotMatch(inventoryUi, /<fieldset[^>]*style=\{\{ border: 0, margin: 0, padding: 0 \}\}/u);
  assert.match(styles, /\.inventory-draft-fieldset\{width:100%;min-width:0;max-width:100%/u);
  assert.match(styles, /\.inventory-table-scroll\{width:100%;min-width:0;max-width:100%;overflow-x:auto/u);
  assert.match(styles, /\.inventory-draft-table\{min-width:1180px\}/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*?\.inventory-management \.table-head>div\{display:block;width:100%\}/u);
});

test("fixed-cost saves are immutable independent batches and monthly totals include every batch once", async () => {
  const [recordsApi, fixedCostUi, financeAggregation, styles] = await sources([
    "../app/api/records/route.ts",
    "../app/components/FixedCostManagement.tsx",
    "../app/api/_lib/store-finance.ts",
    "../app/globals.css",
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
  assert.match(fixedCostUi, /method: "POST"/u);
  assert.doesNotMatch(fixedCostUi, /method: "PATCH"/u);
  assert.match(fixedCostUi, /data: \{ \.\.\.values, period: savedPeriod, clientRequestId,/u);
  assert.match(fixedCostUi, /setClientRequestId\(nextClientRequestId\(\)\)/u);
  assert.match(fixedCostUi, /result\.periodSummaries/u);
  assert.match(fixedCostUi, /nextCursor/u);
  assert.match(fixedCostUi, /Tải thêm lịch sử/u);
  assert.match(fixedCostUi, /action: "VOID_FIXED_COST"/u);
  assert.match(fixedCostUi, /phiếu đã hủy vẫn được giữ/u);

  assert.match(recordsApi, /rawItems\.length < fixedCostKeys\.length \|\| rawItems\.length > 100/u);
  assert.match(recordsApi, /seenKeys\.size !== fixedCostKeys\.length/u);
  assert.match(recordsApi, /total: sumVnd\(items\.map\(\(item\) => item\.amount\)\)/u);
  assert.match(recordsApi, /immutableHistoryCategories = new Set\(\["NHAP_HANG", "CHI_PHI_CO_DINH"\]\)/u);
  assert.match(recordsApi, /category === "CHI_PHI_CO_DINH" && storeId[\s\S]*LIMIT \?`/u);
  assert.match(recordsApi, /periodSummaries: fixedCostPeriodSummaries/u);
  assert.match(recordsApi, /fixedCostRecordId\(body\.storeId, fixedCostClientRequestId\)/u);
  assert.match(recordsApi, /ON CONFLICT\(id\) DO NOTHING/u);
  assert.match(recordsApi, /body\.action !== "VOID_FIXED_COST"/u);
  assert.match(recordsApi, /SET status = 'VOID'/u);
  assert.match(recordsApi, /"VOID_FIXED_COST", "CHI_PHI_CO_DINH"/u);
  assert.match(recordsApi, /entryNo: `CP-/u);
  assert.match(recordsApi, /savedAt: now,/u);
  assert.match(recordsApi, /savedBy: user\.id,/u);
  assert.match(recordsApi, /changeHistory: \[\{ action: "CREATE", at: now, by: user\.id, total: data\.total, items: data\.items \}\]/u);
  assert.doesNotMatch(recordsApi, /Kỳ chi phí này đã tồn tại/u);
  assert.match(financeAggregation, /const savedTotal = safeVnd\(data\.total\)/u);
  assert.match(financeAggregation, /status NOT IN \('DELETED', 'VOID'\)/u);
  assert.match(financeAggregation, /sumVnd\(fixedResult\.results\.map\(\(row\) => fixedCostTotal\(parseObject\(row\.dataJson\)\)\)\)/u);
  assert.match(styles, /\.fixed-cost-entry-row\{display:grid/u);
  assert.match(styles, /@media\(max-width:720px\)\{[^}]*\.fixed-cost-page\{width:100%;overflow-x:clip\}/u);
  assert.match(styles, /\.fixed-cost-void-row/u);
});

test("reports compare periods and profit sharing requires every store ledger to be locked", async () => {
  const [reportsApi, financeAggregation, reportUi, portal] = await sources([
    "../app/api/reports/route.ts",
    "../app/api/_lib/store-finance.ts",
    "../app/components/FinancialReports.tsx",
    "../app/components/Portal.tsx",
  ]);

  assert.match(reportsApi, /const range = localMonthRange\(period\)/u);
  assert.match(reportsApi, /const report = await reportRangeData\([\s\S]{0,240}"month",[\s\S]{0,240}"FULL_ENDING_PERIOD"/u);
  assert.match(reportsApi, /for \(const store of report\.stores\)/u);
  assert.match(reportsApi, /comparison:/u);
  assert.match(reportsApi, /category = 'PAYROLL_CLOSING'.*status = 'LOCKED'/su);
  assert.match(reportsApi, /category = 'DIVIDEND'.*status = 'LOCKED'/su);
  assert.match(reportsApi, /Phạm Thị Diễm Thúy.*percentage: 40/su);
  assert.match(reportsApi, /Trương Việt Vi.*percentage: 60/su);
  assert.match(reportsApi, /profitSharingSnapshot\(period, report\.stores\)/u);
  assert.match(reportsApi, /allocateStoreProfitSharing\(stores\.map/u);
  assert.match(reportsApi, /multiplyRatioVnd\(distributableProfit, 40, 100\)/u);
  assert.match(reportsApi, /const viAmount = distributableProfit - thuyAmount/u);
  assert.match(reportsApi, /thuyAmount = sumVnd\(storeAllocations/u);
  assert.match(reportsApi, /viAmount = sumVnd\(storeAllocations/u);
  assert.match(reportsApi, /storeAllocations/u);
  assert.match(reportsApi, /PROFIT_SHARING_PERIOD_CLOSE/u);
  assert.match(reportsApi, /body\.action === "CLOSE_PROFIT_SHARING" \|\| body\.action === "CLOSE_DIVIDEND"/u);
  assert.match(reportsApi, /dividendHistory: profitSharingHistory/u);
  assert.match(financeAggregation, /category = 'CHI_PHI_CO_DINH'/u);
  assert.match(financeAggregation, /category = 'NHAP_HANG'/u);
  assert.match(financeAggregation, /profitBeforePerformanceRewards/u);
  assert.match(reportUi, /CLOSE_PROFIT_SHARING/u);
  assert.match(reportUi, /THỐNG KÊ PHÂN CHIA THEO TỪNG CỬA HÀNG/u);
  assert.match(reportUi, /allStoresLocked/u);
  assert.match(reportUi, /CHỜ CỬA HÀNG KHÓA KỲ/u);
  assert.match(reportUi, /Phạm Thị Diễm Thúy \(40%\)/u);
  assert.match(reportUi, /Trương Việt Vi \(60%\)/u);
  assert.match(reportUi, /profitChange/u);
  assert.match(portal, /const managerMenu = \[[^\]]*"Chia lợi nhuận"/u);
  assert.match(portal, /view === "Chia lợi nhuận"[\s\S]*?<ManagerProfitSharingClosing\/>/u);
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
  assert.match(recordsApi, /isStorePeriodLocked\(db, storeId, date\.slice\(0, 7\)\)/u);
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

  for (const label of ["Theo ca", "Theo ngày", "Theo nhân viên", "Lương cứng", "Lương thực nhận"]) {
    assert.match(attendanceUi, new RegExp(label, "u"));
  }
  assert.match(attendanceUi, /hourlyMoney\(row\.rates\[0\]\)/u);
  assert.match(attendanceUi, /current\.salary \+= Math\.round\(seconds \/ 3_600 \* rate\)/u);
  assert.doesNotMatch(attendanceUi, /const fallback: ShiftSession/u);
  assert.match(closingUi, /money\(item\.hourlyRate\)\}\/giờ/u);
  assert.match(closingUi, /money\(item\.baseSalary\)/u);
  assert.match(closingUi, /Lương thực nhận = lương cứng theo giờ × giờ làm thực tế/u);
});

test("store payroll keeps manager-set rates and synchronizes every manual adjustment", async () => {
  const [payrollApi, payrollRules, payrollUi, closingUi, styles] = await sources([
    "../app/api/payroll/route.ts",
    "../app/lib/payroll.ts",
    "../app/components/ReferenceStoreModules.tsx",
    "../app/components/StorePayrollClosing.tsx",
    "../app/globals.css",
  ]);

  assert.match(payrollApi, /hourlyRate: requireVnd\(Number\(employee\.hourlyRate\), "Lương theo giờ"\)/u);
  assert.doesNotMatch(payrollApi, /hourlyRate: employeeDurationSeconds > 0 \? multiplyRatioVnd\(baseSalary/u);
  assert.match(payrollApi, /payrollAdjustmentTotals\(employeeAdjustments\.map/u);
  assert.match(payrollRules, /PAYROLL_UPDATED_EVENT = "dore:payroll-updated"/u);
  assert.match(payrollRules, /manualAllowance: sumVnd/u);
  assert.match(payrollRules, /manualBonus: sumVnd/u);
  assert.match(payrollUi, /Phụ cấp TikTok \$\{money\(summary\?\.totalTikTokAllowance/u);
  assert.match(payrollUi, /Phụ cấp khác \$\{money\(summary\?\.totalManualAllowance/u);
  assert.match(payrollUi, /<th>Thưởng khác<\/th>/u);
  assert.doesNotMatch(payrollUi, /Thưởng đã tạo/u);
  assert.match(payrollUi, /source: "management"/u);
  assert.match(closingUi, /source === "management"/u);
  assert.match(closingUi, /source: "closing"/u);
  assert.match(styles, /\.ref-metric small\{line-height:1\.45;white-space:pre-line\}/u);
});

test("store payroll binds requests and mutations to one verified period", async () => {
  const [closingUi] = await sources(["../app/components/StorePayrollClosing.tsx"]);

  assert.match(closingUi, /const loadRequest = useRef\(0\)/u);
  assert.match(closingUi, /const loadController = useRef<AbortController \| null>\(null\)/u);
  assert.match(closingUi, /loadController\.current\?\.abort\(\)/u);
  assert.match(closingUi, /signal: controller\.signal/u);
  assert.match(closingUi, /requestId !== loadRequest\.current \|\| controller\.signal\.aborted/u);
  assert.match(closingUi, /payload\.period !== requestedScope\.period/u);
  assert.match(closingUi, /payload\.summary\.period !== requestedScope\.period/u);
  assert.match(closingUi, /payload\.summary\.storeId !== requestedScope\.storeId/u);
  assert.match(closingUi, /setData\(\{\}\);[\s\S]*setLoadedScope\(null\)/u);
  assert.match(closingUi, /const actionScope = loadedScope/u);
  assert.match(closingUi, /actionScope\.period !== period \|\| actionScope\.storeId !== store\.id/u);
  assert.match(closingUi, /body: JSON\.stringify\(\{ storeId: actionScope\.storeId, period: actionScope\.period/u);
  assert.match(closingUi, /disabled=\{!dataIsCurrent\}/u);
});

test("payroll management ignores out-of-order months and gates every action on the loaded scope", async () => {
  const [payrollUi] = await sources(["../app/components/ReferenceStoreModules.tsx"]);

  assert.match(payrollUi, /const loadRequest = useRef\(0\)/u);
  assert.match(payrollUi, /const loadController = useRef<AbortController \| null>\(null\)/u);
  assert.match(payrollUi, /loadController\.current\?\.abort\(\)/u);
  assert.match(payrollUi, /signal: controller\.signal/u);
  assert.match(payrollUi, /requestId !== loadRequest\.current \|\| controller\.signal\.aborted/u);
  assert.match(payrollUi, /result\.period !== requestedScope\.period/u);
  assert.match(payrollUi, /result\.summary\.period !== requestedScope\.period/u);
  assert.match(payrollUi, /result\.summary\.storeId !== requestedScope\.storeId/u);
  assert.match(payrollUi, /setLoadedSummary\(null\);[\s\S]*setLoadedLocked\(false\);[\s\S]*setLoadedScope\(null\)/u);
  assert.match(payrollUi, /const summary = dataIsCurrent \? loadedSummary : null/u);
  assert.match(payrollUi, /const actionScope = loadedScope/u);
  assert.match(payrollUi, /body: JSON\.stringify\(\{ storeId: actionScope\.storeId, period: actionScope\.period \}\)/u);
  assert.match(payrollUi, /luong-thuong-\$\{actionScope\.storeId\}-\$\{actionScope\.period\}\.csv/u);
  assert.match(payrollUi, /<button disabled=\{!dataIsCurrent\} onClick=\{exportPayroll\}>/u);
  assert.match(payrollUi, /disabled=\{locked \|\| loading \|\| finalizing \|\| !dataIsCurrent\}/u);
  assert.match(payrollUi, /storeId: actionScope\.storeId,[\s\S]*period: actionScope\.period/u);
});

test("payroll adjustment dialog is resilient, accessible, and period-scoped", async () => {
  const [employeesApi, payrollUi] = await sources([
    "../app/api/employees/route.ts",
    "../app/components/ReferenceStoreModules.tsx",
  ]);

  assert.match(payrollUi, /useEmployees\(store\.id, month\)/u);
  assert.match(payrollUi, /query\.set\("payrollPeriod", payrollPeriod\)/u);
  assert.match(payrollUi, /savingAdjustmentRef\.current/u);
  assert.match(payrollUi, /deletingAdjustmentRef\.current/u);
  assert.match(payrollUi, /if \(!response\.ok\) \{[\s\S]*reportError\(result\.message/u);
  assert.match(payrollUi, /deleteRecord\(id, setMessage\)/u);
  assert.match(payrollUi, /role="dialog" aria-modal="true" aria-labelledby="payroll-adjustment-dialog-title"/u);
  assert.match(payrollUi, /aria-label="Đóng hộp thoại tạo phụ cấp hoặc thưởng"/u);
  assert.match(payrollUi, /useAccessibleModal\(\{[\s\S]*initialFocusRef: payrollEmployeeSelectRef,[\s\S]*returnFocusRef: payrollTriggerRef,/u);
  assert.match(payrollUi, /<select ref=\{payrollEmployeeSelectRef\} disabled=\{savingAdjustment\}/u);
  assert.match(payrollUi, /disabled=\{savingAdjustment \|\| !employeeId\}/u);
  assert.match(payrollUi, /savingAdjustment \? "Đang lưu…"/u);
  assert.match(payrollUi, /const employeeStatusSuffix/u);
  assert.match(payrollUi, /status === "SUSPENDED"/u);
  assert.match(payrollUi, /status === "TERMINATED" \|\| status === "INACTIVE"/u);
  assert.match(payrollUi, /Tổng giờ xét KPI <b>\{totalKpiHours\.toFixed\(2\)\} giờ<\/b>/u);
  assert.match(payrollUi, /Lợi nhuận cơ sở trước KPI/u);
  assert.match(payrollUi, /Lợi nhuận sau cùng/u);
  assert.doesNotMatch(payrollUi, /Lợi nhuận cửa hàng <b>[\s\S]*Tổng giờ <b>\{\(summary\?\.totalHours/u);

  assert.match(employeesApi, /const payrollPeriod = params\.get\("payrollPeriod"\)/u);
  assert.match(employeesApi, /periodBoundsUtc\(payrollPeriod\)/u);
  assert.match(employeesApi, /e\.status IN \('TERMINATED', 'INACTIVE'\)[\s\S]*FROM shift_sessions s[\s\S]*s\.store_id = \?[\s\S]*s\.work_date >= \?[\s\S]*s\.work_date < \?/u);
  assert.match(employeesApi, /FROM employee_payroll_closings c[\s\S]*c\.store_id = \? AND c\.period = \?/u);
  assert.match(employeesApi, /r\.category = 'LUONG_THUONG'[\s\S]*r\.store_id = \?[\s\S]*substr\(json_extract\(r\.data_json, '\$\.date'\), 1, 7\) = \?/u);
  assert.match(employeesApi, /t\.start_date < \? AND t\.end_date >= \?/u);
});

test("employee payroll itemizes every allowance below the allowance total", async () => {
  const [payrollApi, employeePayroll, styles] = await sources([
    "../app/api/payroll/route.ts",
    "../app/components/ReferenceEmployeeModules.tsx",
    "../app/globals.css",
  ]);

  assert.match(employeePayroll, /Phụ cấp clip TikTok/u);
  assert.match(employeePayroll, /Phụ cấp hỗ trợ · \{row\.storeName\}/u);
  assert.match(employeePayroll, /manualAllowanceDetails\.map\(\(adjustment\)/u);
  assert.match(payrollApi, /adjustmentSourceRows[\s\S]*category = 'LUONG_THUONG'[\s\S]*json_extract\(r\.data_json, '\$\.employeeId'\)/u);
  assert.doesNotMatch(payrollApi, /WHERE t\.target_store_id = \? AND t\.status != 'CANCELLED'/u);
  assert.match(employeePayroll, /adjustment\.label/u);
  assert.match(employeePayroll, /money\(adjustment\.amount\)/u);
  assert.match(employeePayroll, /supportAllowanceByStore/u);
  assert.match(employeePayroll, /aria-label="Chi tiết các khoản phụ cấp"/u);
  assert.match(payrollApi, /label: item\.note/u);
  assert.match(payrollApi, /adjustments: adjustmentDetails/u);
  assert.match(styles, /\.allowance-breakdown/u);
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
  assert.match(payrollApi, /managerHoursPerStore: MANAGER_FIXED_WORK_HOURS_PER_STORE/u);
  assert.match(payrollApi, /currentPolicy\.employeeKpiTiers\.map/u);
  assert.match(payrollApi, /loadPayrollPolicy/u);
  assert.match(payrollApi, /settleStoreProfit\(profit, totalKpiBonus, managerBonus\)/u);
  assert.match(portal, /view === "Lương thưởng quản lý"[\s\S]*return <ManagerPayroll\/>/u);
  assert.match(portal, /Chỉ ghi nhận số liệu thật từ các cửa hàng đã xác nhận chi và khóa kỳ/u);
  assert.match(finance, /profitBeforePerformanceRewards - performanceRewards/u);
  assert.match(aggregation, /const managerSalary = lockedSnapshot[\s\S]*payrollPolicy\.managerMonthlySalaryVnd/u);
  assert.match(aggregation, /lockedSnapshot[\s\S]*provisionalKpi\?\.managerBonus/u);
  assert.match(aggregation, /distributeStoreKpiByPolicy\([\s\S]*profitBeforePerformanceRewards[\s\S]*completedShiftCount[\s\S]*durationSeconds/u);
  assert.match(aggregation, /if \(!row\.transferId\) \{[\s\S]*secondsByEmployee\.set/u);
  assert.match(aggregation, /employeeFinancialStatusForPeriod\([\s\S]*row\.employeeStatusAtPeriodEnd,[\s\S]*row\.hasLifecycleHistory,[\s\S]*row\.inactivePeriod,[\s\S]*period[\s\S]*\)/u);
  assert.match(aggregation, /employee_status_at_lock AS lockedEmploymentStatus[\s\S]*employee_payroll_closings employee_lock[\s\S]*employee_lock\.status IN \('BASE_LOCKED', 'LOCKED'\)/u);
  assert.match(aggregation, /const baseExpense = sumVnd\(\[[\s\S]*managerSalary[\s\S]*\]\);[\s\S]*const profitBeforePerformanceRewards = revenue - baseExpense/u);
  assert.match(aggregation, /const expense = sumVnd\(\[baseExpense, employeeKpiBonus, managerBonus\]\)/u);
  assert.match(aggregation, /profit: revenue - expense/u);
  assert.match(aggregation, /options\.payrollRecognition === "PREVIEW"[\s\S]*allocateMonthlyExpense\(finance\.expenseBreakdown\.managerSalary, "managerSalary"/u);
  assert.match(aggregation, /finance\.settlementStatus === "PAYMENT_CONFIRMED" \|\| finance\.settlementStatus === "LOCKED"[\s\S]*addMonthlyExpenseAtClose\(finance\.expenseBreakdown\.managerSalary, "managerSalary", monthRange\.to, eligibleDates, days\)/u);
});

test("overview and reports reconcile fixed costs while cashflow labels actual payments distinctly", async () => {
  const [storesApi, reportsApi, cashflowApi] = await sources([
    "../app/api/stores/route.ts",
    "../app/api/reports/route.ts",
    "../app/api/cashflow/route.ts",
  ]);

  assert.match(storesApi, /storeDateRangeFinance\(db, id, currentRange, \{ payrollRecognition: "PREVIEW", payrollPolicy \}\)/u);
  assert.match(storesApi, /to: fullCurrentRange\.to > today \? today : fullCurrentRange\.to/u);
  assert.match(storesApi, /previousComparableDateRange\(currentRange, "month"\)/u);
  assert.match(reportsApi, /fixedCostRecognitionForRange\(params, range\)[\s\S]*const usesFullEndingPeriodFixedCosts = fixedCostRecognition === "FULL_ENDING_PERIOD"/u);
  assert.match(reportsApi, /range\.from <= endingMonth\.from && range\.to === finalAvailableDay/u);
  assert.match(reportsApi, /storeDateRangeFinance\(db, id, range, \{ fixedCostRecognition, payrollRecognition: "PREVIEW", payrollPolicy \}\)/u);
  assert.match(reportsApi, /storeDateRangeFinance\(db, id, previousRange, \{ fixedCostRecognition, payrollRecognition: "PREVIEW", payrollPolicy \}\)/u);
  assert.match(reportsApi, /monthlyAccrual:[\s\S]*Chi phí cố định, lương quản lý và KPI của tháng kết thúc phạm vi được ghi nhận đủ một lần[\s\S]*kỳ mở dùng chính sách hiện hành[\s\S]*kỳ đã khóa giữ nguyên bản chốt/u);
  assert.match(reportsApi, /performanceRewards:[\s\S]*kỳ mở là số xem trước theo chính sách hiện hành[\s\S]*kỳ đã khóa chỉ dùng ảnh chụp bất biến/u);
  assert.match(cashflowApi, /financeStatus: "ACTUAL_CASH"/u);
  assert.match(cashflowApi, /outflow: "Tiền đã chi thực tế"/u);
  assert.match(cashflowApi, /accountingReconciliation/u);
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
  assert.match(payrollApi, /const sourceIds = new Set\(\[\.\.\.lockedSourceByStore\.keys\(\), \.\.\.detailSourceNames\.keys\(\)\]\)/u);
  assert.match(payrollApi, /locked: overallState\.locked/u);
  assert.match(payrollApi, /paid: overallState\.paid/u);
  assert.match(payrollApi, /lockedSource \? Promise\.resolve\(null\) : buildPreview/u);
  assert.match(payrollUi, /Nh[âa]n vi[êe]n h[oỗ] tr[oợ]/u);
  assert.match(payrollUi, /Lương h[oỗ] tr[oợ]\/gi[oờ]/u);
  assert.match(payrollUi, /Giờ làm thực tế/u);
  assert.match(payrollUi, /Ph[ụu] c[ấa]p h[oỗ] tr[oợ]/u);
  assert.match(payrollUi, /Lương thực nhận/u);
  assert.doesNotMatch(payrollUi, /Thực nhận ca/u);
  assert.match(payrollUi, /mainShiftRows.*!row\.isSupport/u);
  assert.match(payrollUi, /supportShiftRows.*row\.isSupport/u);
  assert.match(payrollUi, /support \? <><th>Lương hỗ trợ\/giờ<\/th><th>Phụ cấp hỗ trợ<\/th><\/> : <th>Lương cứng<\/th>/u);
  assert.match(payrollUi, /CHỐT MỘT PHẦN/u);
  assert.match(payrollUi, /sourcePaymentLabel/u);
});

test("website and store cards use logo.jpg as the canonical favicon and brand asset", async () => {
  const [layout, login, portal] = await sources([
    "../app/layout.tsx",
    "../app/page.tsx",
    "../app/components/Portal.tsx",
  ]);

  assert.match(layout, /url: "\/logo\.jpg\?v=/u);
  assert.match(layout, /type: "image\/jpeg", sizes: "any"/u);
  assert.match(login, /src="\/logo\.jpg"/u);
  assert.match(portal, /src="\/logo\.jpg"/u);
  assert.doesNotMatch(`${layout}\n${login}\n${portal}`, /\/dore-logo\.jpg/u);
});

test("manager financial report opens on the current month-to-date accounting period", async () => {
  const source = await readFile(new URL("../app/components/ManagerFinanceViews.tsx", import.meta.url), "utf8");
  assert.match(source, /function initialDayRange\(\)[\s\S]*?const to = localIsoDate\(\);[\s\S]*?from: `\$\{to\.slice\(0, 7\)\}-01`, to/u);
  assert.doesNotMatch(source, /function initialDayRange\(\)[\s\S]{0,180}shiftDate\(to, -6\)/u);
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
