import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("schedule employee chooser is a compact accessible vertical list", async () => {
  const [component, styles] = await Promise.all([
    source("../app/components/StoreSchedulingModules.tsx"),
    source("../app/components/StoreSchedulingModules.module.css"),
  ]);

  assert.match(component, /aria-label="Danh sách nhân viên theo chiều dọc"/u);
  assert.match(component, /aria-label="Tìm nhân viên"/u);
  assert.match(component, /Không tìm thấy nhân viên phù hợp/u);
  assert.match(styles, /\.employeePicker\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*gap:\s*5px;[^}]*max-height:\s*240px;[^}]*overflow-y:\s*auto;/su);
  assert.match(styles, /\.employeePicker label\s*\{[^}]*min-height:\s*46px;[^}]*padding:\s*6px 9px;/su);
});

test("fixed-cost primary buttons expose readable action labels", async () => {
  const [component, styles] = await Promise.all([
    source("../app/components/FixedCostManagement.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(component, /> Thêm chi phí<\/button>/u);
  assert.equal(component.match(/"Lưu chi phí"/gu)?.length, 2);
  assert.match(styles, /\.fixed-cost-toolbar \.primary-button,[\s\S]*?background:\s*linear-gradient\([^)]+\);[\s\S]*?color:\s*#fff;/u);
  assert.match(styles, /\.fixed-cost-save-actions \.primary-button/u);
});

test("fixed-cost rows and payroll actions stay compact, visible and accessible on mobile", async () => {
  const [fixedCost, payroll, payrollManagement, payrollApi, styles] = await Promise.all([
    source("../app/components/FixedCostManagement.tsx"),
    source("../app/components/StorePayrollClosing.tsx"),
    source("../app/components/ReferenceStoreModules.tsx"),
    source("../app/api/payroll/route.ts"),
    source("../app/globals.css"),
  ]);

  assert.match(fixedCost, /fixed-cost-entry-row \$\{item\.key \? "is-default" : "is-custom"\}/u);
  assert.match(fixedCost, /fixed-cost-entry-action \$\{item\.key \? "is-default" : "is-custom"\}/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*?\.fixed-cost-entry-row,\.fixed-cost-entry-row\.is-default\{grid-template-columns:24px minmax\(82px,1fr\) minmax\(96px,42%\)/u);
  assert.match(styles, /\.fixed-cost-entry-action\.is-default\{display:none\}/u);
  assert.match(styles, /\.fixed-cost-entry-name input,\.fixed-cost-entry-amount input\{min-height:44px/u);

  for (const label of [
    "Khóa bảng lương cửa hàng",
    "Chốt lương quản lý",
    "Xác nhận chi lương",
    "Xác nhận thưởng và phụ cấp",
    "Chốt sổ",
    "Khóa kỳ chi lương thưởng",
  ]) assert.match(payroll, new RegExp(label, "u"));
  assert.match(payroll, /className="payroll-workflow-actions" role="list" aria-label="Các bước chốt và khóa kỳ lương thưởng"/u);
  assert.match(payroll, /aria-describedby=\{reasonId\}/u);
  assert.match(payroll, /disabled=\{disabled\}/u);
  assert.match(payroll, /Mở từ ngày cuối tháng/u);
  assert.match(payrollApi, /if \(!canClosePayrollPeriod\(period\)\)/u);
  assert.match(payrollManagement, /ref-toolbar-actions payroll-compact-actions/u);
  assert.match(styles, /\.payroll-workflow-button\{[^}]*min-height:44px/u);
  assert.match(styles, /\.payroll-page \.ref-toolbar-actions>button,\.payroll-compact-actions>button\{[^}]*min-height:44px;[^}]*font-size:10px/u);
  assert.match(styles, /\.payroll-workflow-actions\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
});

test("employee save action and current-shift summary remain legible", async () => {
  const [management, employeeHome, styles] = await Promise.all([
    source("../app/components/EmployeeManagement.tsx"),
    source("../app/components/ReferenceEmployeeHome.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(management, /<Save size=\{17\}\/> \{saving \? "ĐANG LƯU\.\.\." : "LƯU NHÂN VIÊN"\}/u);
  assert.match(management, /className="primary-button employee-add-button"/u);
  assert.match(management, /const \[passwordVisible, setPasswordVisible\] = useState\(false\)/u);
  assert.match(management, /setPasswordVisible\(false\)[\s\S]*setOpen\(true\)/u);
  assert.match(management, /type=\{passwordVisible \? "text" : "password"\}/u);
  assert.match(management, /aria-label=\{passwordVisible \? "Ẩn mật khẩu nhân viên" : "Hiện mật khẩu nhân viên"\}/u);
  assert.match(management, /aria-pressed=\{passwordVisible\}/u);
  assert.match(management, /type="button"[\s\S]*onClick=\{\(\) => setPasswordVisible\(\(current\) => !current\)\}/u);
  assert.match(management, /required=\{!editing\}/u);
  assert.match(management, /autoComplete="new-password"/u);
  assert.match(management, /<Plus size=\{17\}\/> THÊM NHÂN VIÊN/u);
  assert.match(styles, /\.employee-drawer \.drawer-actions \.primary-button(?:,[^{]+)?\{[^}]*background:linear-gradient\([^}]*color:#fff;[^}]*white-space:nowrap;/u);
  assert.match(styles, /\.ref-toolbar-actions>\.employee-add-button\{[^}]*background:linear-gradient\([^}]*color:#fff;/u);
  assert.match(styles, /\.employee-password-field>button\{[^}]*width:44px;[^}]*height:44px;[^}]*touch-action:manipulation/u);
  assert.match(styles, /\.employee-password-field>button:focus-visible/u);
  assert.match(employeeHome, /className="employee-shift-summary" aria-label=/u);
  assert.match(employeeHome, /className="employee-shift-name"/u);
  assert.match(styles, /\.employee-home-reference \.shift-card \.employee-shift-summary\{[^}]*grid-template-columns:minmax\(112px,max-content\) minmax\(0,1fr\);/u);
  assert.match(styles, /\.employee-home-reference \.shift-card \.employee-shift-name\{[^}]*height:auto;[^}]*white-space:nowrap;/u);
  assert.match(styles, /@media\(max-width:420px\)\{\.employee-home-reference \.shift-card \.employee-shift-summary\{grid-template-columns:1fr;/u);
});

test("employee editor exposes a per-employee formatted TikTok allowance", async () => {
  const [management, styles] = await Promise.all([
    source("../app/components/EmployeeManagement.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(management, /tiktokAllowance: Number\(row\.tiktok_allowance \?\? row\.tiktokAllowance \?\? 25_000\)/u);
  assert.match(management, /tiktokAllowance: "25,000"/u);
  assert.match(management, /tiktokAllowance: formatVndInput\(employee\.tiktokAllowance\)/u);
  assert.match(management, /tiktokAllowance: parseVndInput\(form\.tiktokAllowance\)/u);
  assert.match(management, /Phụ cấp TikTok phải là số nguyên từ 0 đồng trở lên/u);
  assert.match(management, /<th>Phụ cấp TikTok<\/th>/u);
  assert.match(management, /className="employee-tiktok-allowance">\{formatMoney\(employee\.tiktokAllowance\)\}/u);
  assert.match(management, /id="employee-tiktok-allowance"[\s\S]*?inputMode="numeric"[\s\S]*?aria-describedby="employee-tiktok-allowance-help"/u);
  assert.match(management, /updateForm\("tiktokAllowance", formatVndInput\(event\.target\.value\)\)/u);
  assert.match(management, /áp dụng riêng cho mỗi ca có TikTok của nhân viên này/u);
  assert.match(styles, /\.employee-tiktok-field\{[^}]*grid-column:1\/-1;[^}]*min-width:0;/u);
  assert.match(styles, /\.employee-tiktok-field>input\{[^}]*width:100%;[^}]*min-width:0;/u);
  assert.match(styles, /\.employee-tiktok-allowance\{[^}]*white-space:nowrap/u);
});

test("employee home renders the employee-specific TikTok allowance with a legacy-safe fallback", async () => {
  const [portal, employeeHome] = await Promise.all([
    source("../app/components/Portal.tsx"),
    source("../app/components/ReferenceEmployeeHome.tsx"),
  ]);

  const normalizer = employeeHome.match(/export function normalizeEmployeeTiktokAllowance\(value: unknown\) \{([\s\S]*?)\n\}/u);
  assert.ok(normalizer, "TikTok allowance normalizer must remain executable and independently testable");
  const normalize = runInNewContext(`(value) => {${normalizer[1]}}`);
  assert.equal(normalize(0), 0, "an explicitly configured zero allowance must be preserved");
  assert.equal(normalize(49_000), 49_000, "an employee-specific allowance must be preserved");
  for (const legacyValue of [undefined, null, -1, 1.5, "49,000"]) assert.equal(normalize(legacyValue), 25_000);

  const resolverSource = employeeHome.match(/export function resolveEmployeeTiktokAllowanceSnapshot\([\s\S]*?\n\) \{([\s\S]*?)\n\}/u);
  assert.ok(resolverSource, "shift snapshot resolver must remain independently testable");
  const resolveSnapshot = runInNewContext(`(source, snapshot, current) => {${resolverSource[1]}}`, {
    normalizeEmployeeTiktokAllowance: normalize,
  });
  assert.equal(resolveSnapshot("sync", { tiktokAllowance: 49_000 }, 25_000), 49_000);
  assert.equal(resolveSnapshot("start", { tiktokAllowance: 0 }, 49_000), 0);
  assert.equal(resolveSnapshot("end", { tiktokAllowance: 0 }, 49_000), 49_000, "an earned zero at shift end must not overwrite the configured allowance");
  assert.equal(resolveSnapshot("end", { tiktokAllowance: 49_000, employeeTiktokAllowance: 0 }, 49_000), 0, "a dedicated configured snapshot must preserve an explicit zero");

  assert.match(portal, /employeeTiktokAllowance\?: number \| null/u);
  assert.match(employeeHome, /employeeTiktokAllowance\?: number \| null/u);
  assert.match(employeeHome, /const tiktokAllowanceAmount = normalizeEmployeeTiktokAllowance\(user\.employeeTiktokAllowance\)/u);
  assert.match(employeeHome, /Phụ cấp TikTok: \+\{money\(tiktokAllowanceAmount\)\}/u);
  assert.doesNotMatch(employeeHome, /money\((?:25_000|25000)\)/u);
  assert.match(portal, /const tiktokAllowanceChanged = nextEmployeeTiktokAllowance !== normalizeEmployeeTiktokAllowance\(user\.employeeTiktokAllowance\)/u);
  assert.match(portal, /resolveEmployeeTiktokAllowanceSnapshot\("sync", data, user\.employeeTiktokAllowance\)/u);
  assert.match(portal, /resolveEmployeeTiktokAllowanceSnapshot\(action, data, user\.employeeTiktokAllowance\)/u);
  assert.match(portal, /Ca này có làm clip TikTok \(\+\{money\(tiktokAllowanceAmount\)\}\)/u);
  assert.doesNotMatch(portal, /Ca này có làm clip TikTok \(\+25\.000 đ\)/u);
});

test("store month controls, expense breakdown and system back action stay touch-friendly", async () => {
  const [portal, reports, styles] = await Promise.all([
    source("../app/components/Portal.tsx"),
    source("../app/components/FinancialReports.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(portal, /function showMonthPicker\(input: HTMLInputElement\)[\s\S]*typeof input\.showPicker !== "function"\) return false;[\s\S]*return true;/u);
  assert.match(portal, /function MonthPickerControl[\s\S]*<Calendar size=\{18\}[\s\S]*className="month-picker-native"[\s\S]*aria-label=\{ariaLabel\}[\s\S]*type="month"/u);
  assert.match(portal, /showMonthPicker\(inputRef\.current \?\? event\.currentTarget\)\) event\.preventDefault\(\)/u);
  assert.match(portal, /<ArrowLeft size=\{17\}\/?> Quay về trang quản lý chính<\/button>/u);
  assert.doesNotMatch(portal, /<span className="date-control">▣ Kỳ/u);
  assert.match(portal, /className="table-card store-expense-breakdown"/u);
  assert.match(portal, /<StoreFinancialReport store=\{store\} initialPeriod=\{period\} onPeriodChange=\{onPeriodChange\}\/>/u);

  assert.match(reports, /function MonthPickerControl[\s\S]*<Calendar size=\{18\}[\s\S]*className="month-picker-native"/u);
  assert.match(reports, /const period = onPeriodChange \? \(initialPeriod \?\? localPeriod\) : localPeriod;[\s\S]*const setPeriod = onPeriodChange \?\? setLocalPeriod;/u);
  assert.match(reports, /className="manager-panel table-panel financial-expense-table"/u);
  assert.match(styles, /\.month-picker-control\{[^}]*min-height:46px;[^}]*cursor:pointer;[^}]*touch-action:manipulation/u);
  assert.match(styles, /\.date-control \.month-picker-native\{[^}]*position:absolute;[^}]*inset:0;[^}]*width:100%;[^}]*height:100%;[^}]*opacity:0;/u);
  assert.match(styles, /\.store-expense-breakdown \.comparison-grid>p\{[^}]*grid-template-columns:minmax\(148px,210px\) max-content max-content;[^}]*justify-content:start;[^}]*padding:15px 0;[^}]*font-size:13px;/u);
  assert.match(styles, /\.store-expense-breakdown \.comparison-grid b\{[^}]*font-size:13px;[^}]*white-space:nowrap;[^}]*font-variant-numeric:tabular-nums/u);
  assert.match(styles, /@media\(max-width:420px\)\{[\s\S]*\.store-expense-breakdown \.comparison-grid>p\{grid-template-columns:minmax\(0,max-content\) max-content;[^}]*gap:5px 8px;[^}]*max-width:100%/u);
  assert.match(styles, /\.store-expense-breakdown \.comparison-grid span\{grid-column:1\/-1;max-width:100%\}/u);
  assert.match(styles, /\.store-expense-breakdown \.comparison-grid b\{grid-column:1;text-align:left;white-space:normal;overflow-wrap:anywhere\}/u);
  assert.match(styles, /\.back-system\{[^}]*font-size:12px!important/u);
  assert.match(styles, /\.sidebar nav button\.active\{[^}]*font-weight:850;[^}]*box-shadow:/u);
  assert.match(styles, /\.light \.back-system\{[^}]*border-color:#77be8e;[^}]*background:linear-gradient/u);
  assert.match(styles, /\.financial-expense-table \.data-table\{[^}]*width:min\(100%,1080px\);[^}]*table-layout:fixed/u);
  assert.match(styles, /\.financial-expense-table \.data-table td:nth-child\(2\)\{[^}]*font-size:16px;[^}]*font-weight:900/u);
  assert.match(styles, /\.app-shell\.light \.main-area \.page-content :is\(\.stat-card,\.table-card,\.manager-panel,\.employee-panel,\.orders-panel\)\{[^}]*border-color:#abd7b8;[^}]*box-shadow:/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.app-shell\.light \.main-area \.page-content :is\(\.stat-card,\.table-card,\.manager-panel,\.employee-panel,\.orders-panel\)\{border-width:1px;/u);
});

test("manager password change verifies the current secret and revokes other sessions", async () => {
  const [settings, route] = await Promise.all([
    source("../app/components/FunctionalModules.tsx"),
    source("../app/api/auth/password/route.ts"),
  ]);

  for (const icon of ["UserRoundCog", "KeyRound", "BellRing", "Languages", "ShieldCheck"]) assert.match(settings, new RegExp(icon, "u"));
  assert.match(settings, /fetch\("\/api\/auth\/password"/u);
  assert.match(settings, /current-password/u);
  assert.match(settings, /new-password/u);
  assert.match(settings, /Xác nhận mật khẩu mới/u);
  assert.match(route, /user\.role !== "MANAGER"/u);
  assert.match(route, /verifyPassword\(currentPassword, account\.passwordHash\)/u);
  assert.match(route, /hashPassword\(newPassword\)/u);
  assert.match(route, /DELETE FROM sessions WHERE user_id = \? AND token_hash != \?/u);
  assert.match(route, /PASSWORD_CHANGED/u);
  assert.doesNotMatch(route, /writeAudit\([^\n]*(currentPassword|newPassword|confirmPassword)/u);
});

test("employee portal no longer prompts or auto-switches a shift after scheduled end", async () => {
  const portal = await source("../app/components/Portal.tsx");
  assert.doesNotMatch(portal, /Bạn làm ca tiếp theo phải không|rollover-warning-banner|confirmRollover|declineRollover/u);
  assert.doesNotMatch(portal, /action: "rollover"/u);
});
