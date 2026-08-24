import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("employee lifecycle changes use one audited transition and revoke login sessions", async () => {
  const [employeesApi, lifecycle, auth, login, shiftApi, ui] = await Promise.all([
    source("../app/api/employees/route.ts"),
    source("../app/api/_lib/employee-lifecycle.ts"),
    source("../app/api/_lib/auth.ts"),
    source("../app/api/auth/login/route.ts"),
    source("../app/api/shift/route.ts"),
    source("../app/components/EmployeeManagement.tsx"),
  ]);

  assert.match(employeesApi, /action === "SET_STATUS"/u);
  assert.match(employeesApi, /transitionEmployeeStatus/u);
  assert.match(lifecycle, /DELETE FROM sessions/u);
  assert.match(lifecycle, /EMPLOYEE_STATUS_CHANGE/u);
  assert.match(lifecycle, /lifecycle_version = lifecycle_version \+ 1/u);
  assert.match(lifecycle, /"ACTIVE", "SUSPENDED", "TERMINATED"/u);
  assert.match(employeesApi, /body\.password !== ""/u);
  assert.doesNotMatch(employeesApi, /requiredOffboardingLock/u);
  assert.doesNotMatch(employeesApi, /NOT EXISTS \(SELECT 1 FROM shift_sessions WHERE employee_id/u);
  assert.doesNotMatch(employeesApi, /NOT EXISTS \(SELECT 1 FROM employee_transfers WHERE employee_id/u);
  assert.match(auth, /row\.employeeStatus !== "ACTIVE" \|\| row\.homeStoreStatus !== "ACTIVE"/u);
  assert.match(auth, /DELETE FROM sessions WHERE token_hash = \?/u);
  assert.match(login, /user\.employee_status !== "ACTIVE"/u);
  assert.match(shiftApi, /EXISTS \(SELECT 1 FROM employees WHERE id = \? AND store_id = \? AND status = 'ACTIVE'\)/u);
  assert.match(ui, /action: "SET_STATUS"/u);
  assert.match(ui, /value="SUSPENDED"/u);
  assert.match(ui, /value="TERMINATED"/u);
  assert.match(ui, /row\.status === "TERMINATED" \|\| row\.status === "INACTIVE" \? "TERMINATED"/u);
  assert.match(ui, /expectedVersion: editing\?\.lifecycleVersion/u);
  assert.match(ui, /if \(status === "TERMINATED"\) return "Đã nghỉ việc"/u);
  assert.doesNotMatch(employeesApi, /tiktok_allowance = CASE[^\n]+status = \?/u);
  assert.match(employeesApi, /status = \?[\s\S]*COALESCE\(lifecycle_version, 0\) = \?[\s\S]*deleted_at IS NULL/u);
  assert.match(employeesApi, /e\.status != 'ARCHIVED' AND e\.deleted_at IS NULL/u);
});

test("individual payroll locks are immutable, idempotent and preserve offboarding snapshots", async () => {
  const [schema, runtime, migration, payroll, records, periodLock, ui] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/runtime.ts"),
    source("../drizzle/0006_employee_payroll_closing.sql"),
    source("../app/api/payroll/route.ts"),
    source("../app/api/records/route.ts"),
    source("../app/api/_lib/store-period-lock.ts"),
    source("../app/components/StorePayrollClosing.tsx"),
  ]);

  for (const text of [schema, runtime, migration]) assert.match(text, /employee_payroll_closings/u);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_employee_payroll_closing_period`/u);
  assert.match(payroll, /"FINALIZE_SINGLE_EMPLOYEE"/u);
  assert.match(payroll, /INSERT OR IGNORE INTO employee_payroll_closings/u);
  assert.match(payroll, /const employmentStatus = employeeFinancialStatusForPeriod\([\s\S]*employee\.statusAtPeriodEnd,[\s\S]*employee\.hasLifecycleHistory,[\s\S]*employee\.inactivePeriod,[\s\S]*period/u);
  assert.match(payroll, /!canClosePayrollPeriod\(period\) && employmentStatus !== "INACTIVE"/u);
  assert.doesNotMatch(payroll, /FROM employees e WHERE e\.id = \? AND e\.status (?:=|!=|IN)/u);
  assert.match(payroll, /const kpiDeferred = true/u);
  assert.doesNotMatch(payroll, /kpiDeferred = period === localPeriod\(\)/u);
  assert.match(payroll, /employeePayWithKpi\(item, allocation\.employeeKpi\)/u);
  assert.match(payroll, /employeePayWithKpi\(sourceItem, 0\)/u);
  assert.match(payroll, /\(e\.statusAtPeriodEnd IN \('ACTIVE', 'SUSPENDED'\) AND e\.store_id = \?\)/u);
  assert.match(payroll, /lifecycle_exit\.effective_at >= \? AND lifecycle_exit\.effective_at < \?[\s\S]*lifecycle_exit\.to_status IN \('TERMINATED', 'INACTIVE', 'ARCHIVED'\)/u);
  assert.match(payroll, /e\.hasLifecycleHistory = 0 AND e\.status IN \('TERMINATED', 'INACTIVE'\)[\s\S]*e\.inactivePeriod = \?/u);
  assert.match(payroll, /SELECT 1 FROM employee_payroll_closings c/u);
  assert.match(payroll, /Hãy chốt lương riêng cho từng nhân viên/u);
  assert.match(records, /isStorePeriodLocked/u);
  assert.match(payroll, /UPDATE employee_payroll_closings[\s\S]*status = 'BASE_LOCKED'[\s\S]*status = 'CLOSING' AND locked_by = \?/u);
  assert.match(payroll, /DELETE FROM employee_payroll_closings[\s\S]*status = 'CLOSING' AND locked_by = \?/u);
  assert.match(periodLock, /canonical_period_lock\.period =/u);
  assert.match(periodLock, /canonical_period_lock\.status IN \('CONFIRMED', 'PAID', 'LOCKED'\)/u);
  assert.match(periodLock, /legacy_period_lock\.category = 'PAYROLL_CLOSING'/u);
  assert.match(periodLock, /legacy_period_lock\.status = 'LOCKED'/u);
  assert.match(ui, /runAction\("FINALIZE_SINGLE_EMPLOYEE", item\)/u);
  assert.match(ui, /dateTime24\(employeeClosing\.lockedAt\)/u);
  assert.match(ui, /KPI chờ xác nhận kỳ/u);
  assert.match(ui, /Chốt bắt buộc/u);
});

test("payroll closing gates serialize operational writes, active shifts and concurrent finalizers", async () => {
  const [payroll, records, periodLock] = await Promise.all([
    source("../app/api/payroll/route.ts"),
    source("../app/api/records/route.ts"),
    source("../app/api/_lib/store-period-lock.ts"),
  ]);

  const singleStart = payroll.indexOf('if (action === "FINALIZE_SINGLE_EMPLOYEE")');
  const storeStart = payroll.indexOf("const gateData = JSON.stringify", singleStart);
  const singleBranch = payroll.slice(singleStart, storeStart);
  const storeBranch = payroll.slice(storeStart);
  assert.ok(singleStart >= 0 && storeStart > singleStart);

  const singleGate = singleBranch.indexOf("INSERT OR IGNORE INTO employee_payroll_closings");
  const singlePreview = singleBranch.indexOf("const summary = await lockedSummary");
  assert.ok(singleGate >= 0 && singlePreview > singleGate, "employee CLOSING gate must be acquired before its snapshot is built");
  assert.match(singleBranch, /SELECT \?, \?, \?, \?, \?, \?, 'CLOSING', \?, \?[\s\S]*NOT EXISTS \([\s\S]*shift_sessions[\s\S]*\(status = 'ACTIVE' OR ended_at IS NULL\)/u);
  assert.match(singleBranch, /NOT EXISTS \([\s\S]*category = 'KPI_SUMMARY'[\s\S]*status = 'CLOSING'[\s\S]*'\$\.period'/u);
  assert.match(singleBranch, /UPDATE employee_payroll_closings[\s\S]*status = 'BASE_LOCKED'[\s\S]*WHERE id = \? AND status = 'CLOSING' AND locked_by = \?/u);
  assert.match(singleBranch, /DELETE FROM employee_payroll_closings[\s\S]*id = \? AND status = 'CLOSING' AND locked_by = \?/u);

  const storeGate = storeBranch.indexOf("INSERT OR IGNORE INTO business_records");
  const storePreview = storeBranch.indexOf("const preview = await buildPreview");
  assert.ok(storeGate >= 0 && storePreview > storeGate, "store CLOSING gate must be acquired before its snapshot is built");
  assert.match(storeBranch, /SELECT \?, 'KPI_SUMMARY',[\s\S]*'CLOSING'[\s\S]*NOT EXISTS \([\s\S]*shift_sessions[\s\S]*status = 'ACTIVE'/u);
  assert.match(storeBranch, /NOT EXISTS \([\s\S]*employee_payroll_closings[\s\S]*status = 'CLOSING'/u);
  assert.match(storeBranch, /gateData = JSON\.stringify\(\{ gateToken, period, storeId, status: "CLOSING"/u);
  assert.match(storeBranch, /prepareFinancialPeriodTransitionPlan\(db, \{[\s\S]*toStatus: "CALCULATED"/u);
  assert.match(storeBranch, /UPDATE business_records[\s\S]*status = 'CALCULATED'[\s\S]*status = 'CLOSING'[\s\S]*'\$\.gateToken'/u);
  assert.match(storeBranch, /assertFinancialPeriodPlanApplied\(finalizeResults, transition, 2\)/u);
  assert.match(storeBranch, /DELETE FROM business_records[\s\S]*status = 'CLOSING'[\s\S]*'\$\.gateToken'/u);

  assert.match(payroll, /PAYROLL_GATE_STALE_MS = 10 \* 60 \* 1_000/u);
  assert.match(payroll, /status = 'CLOSING' AND locked_at < \?/u);
  assert.match(payroll, /status = 'CLOSING' AND updated_at < \?/u);
  assert.match(periodLock, /canonical_period_lock\.status IN \('CONFIRMED', 'PAID', 'LOCKED'\)/u);
  assert.match(periodLock, /legacy_period_lock\.category = 'PAYROLL_CLOSING'/u);
  assert.match(periodLock, /legacy_period_lock\.status = 'LOCKED'/u);
  assert.match(records, /affectedRows\(result\) === 0/u);
});

test("previous-period individual closing defers KPI until the locked store summary", async () => {
  const payroll = await source("../app/api/payroll/route.ts");
  assert.match(payroll, /const kpiDeferred = true/u);
  assert.match(payroll, /kpiBonus: 0/u);
  assert.match(payroll, /employeePayWithKpi\(sourceItem, 0\)/u);
  assert.match(payroll, /employeePayWithKpi\(item, allocation\.employeeKpi\)/u);
  assert.match(payroll, /single immutable KPI_SUMMARY created by FINALIZE_EMPLOYEE/u);
});

test("legacy inactive rows remain byte-compatible and attributable to their offboarding period", async () => {
  const [schema, runtime, migration, lifecycle, payroll] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/runtime.ts"),
    source("../drizzle/0016_employee_lifecycle.sql"),
    source("../app/api/_lib/employee-lifecycle.ts"),
    source("../app/api/payroll/route.ts"),
  ]);
  for (const text of [schema, runtime]) assert.match(text, /inactive_at/u);
  assert.match(migration, /status_updated_at/u);
  assert.doesNotMatch(runtime, /UPDATE employees SET[\s\S]*status = 'TERMINATED'/u);
  assert.doesNotMatch(migration, /UPDATE `employees` SET[\s\S]*`status` = 'TERMINATED'/u);
  assert.match(runtime, /Legacy INACTIVE rows remain/u);
  assert.match(lifecycle, /CASE WHEN \? = 'TERMINATED' THEN \?/u);
  assert.match(lifecycle, /employeeStatusAtInstantSql/u);
  assert.match(lifecycle, /lifecycle_last\.effective_at < \?/u);
  assert.match(lifecycle, /lifecycle_first\.from_status/u);
  assert.match(payroll, /e\.hasLifecycleHistory = 0 AND e\.status IN \('TERMINATED', 'INACTIVE'\)[\s\S]*e\.inactivePeriod = \?/u);
});

test("offboarding KPI keeps historical actual work and individual KPI deferred", async () => {
  const [payroll, kpiEngine] = await Promise.all([
    source("../app/api/payroll/route.ts"),
    source("../app/lib/kpi-engine.ts"),
  ]);

  assert.match(payroll, /AS completedShiftCount/u);
  assert.match(payroll, /const kpiDistribution = calculateKpi\(\{/u);
  assert.match(payroll, /actualSeconds: item\.durationSeconds/u);
  assert.match(payroll, /kpiCompletedShiftCount/u);
  assert.match(payroll, /kpiEligibleDurationSeconds/u);
  assert.match(payroll, /const kpiDeferred = true/u);
  assert.match(kpiEngine, /operatingProfit <= 0 \|\| totalEmployeeSeconds <= 0/u);
  assert.doesNotMatch(payroll, /CASE WHEN s\.transfer_id IS NULL[\s\S]{0,320}AS kpiDurationSeconds/u);
  assert.match(payroll, /LEFT JOIN employees e ON e\.id = s\.employee_id/u);
  assert.match(payroll, /row\.appliedHourlyRate === null \|\| row\.appliedHourlyRate === undefined[\s\S]*Thiếu snapshot mức lương/u);
  assert.match(payroll, /employeeFinancialStatusForPeriod/u);
  assert.match(payroll, /employeeStatusAtInstantSql/u);
  assert.doesNotMatch(payroll, /employeeStatusMap/u);
  assert.match(payroll, /const canonicalSnapshot = payrollSummaryFromFinancialPeriod\(financialPeriodRow\)/u);
  assert.match(payroll, /const summary = snapshotIsAuthoritative && \(canonicalSnapshot \|\| legacySnapshot\)[\s\S]*canonicalSnapshot \?\? legacySnapshot[\s\S]*await buildPreview/u);
});

test("transfer creation requires active employees while lifecycle changes never mutate transfer history", async () => {
  const [employeesApi, transfersApi] = await Promise.all([
    source("../app/api/employees/route.ts"),
    source("../app/api/transfers/route.ts"),
  ]);
  assert.match(transfersApi, /WHERE id = \? AND status = 'ACTIVE'/u);
  assert.match(transfersApi, /INSERT INTO employee_transfers[\s\S]*WHERE EXISTS \(SELECT 1 FROM employees e[\s\S]*e\.status = 'ACTIVE'\)/u);
  assert.match(transfersApi, /NOT EXISTS \([\s\S]*t\.status IN \('SCHEDULED', 'ACTIVE'\)/u);
  assert.match(transfersApi, /affectedRows\(insert\) === 0/u);
  assert.match(transfersApi, /Nhân viên vừa chuyển sang ngưng làm việc/u);
  assert.doesNotMatch(employeesApi, /UPDATE employee_transfers/u);
  assert.doesNotMatch(employeesApi, /NOT EXISTS \(SELECT 1 FROM employee_transfers WHERE employee_id/u);
});

test("employee form and payroll controls remain visible", async () => {
  const [employeeUi, payrollUi, css] = await Promise.all([
    source("../app/components/EmployeeManagement.tsx"),
    source("../app/components/StorePayrollClosing.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(employeeUi, /type="submit" className="primary-button"/u);
  assert.match(css, /employee-drawer \.drawer-actions \.primary-button\{display:inline-flex!important/u);
  assert.match(css, /@media\(min-width:1001px\).*employee-drawer\{position:fixed.*bottom:16px/su);
  assert.match(payrollUi, /Chốt cá nhân/u);
  assert.match(payrollUi, /onClick=\{\(\) => void runAction\("FINALIZE_SINGLE_EMPLOYEE", item\)\}/u);
  assert.match(payrollUi, /aria-label=\{`\$\{actionLabel\} cho \$\{item\.employeeName\}`\}/u);
  assert.match(payrollUi, /employeeClosingById/u);
  assert.match(payrollUi, /giờ thực tế trong kỳ/u);
  assert.match(payrollUi, /Có phân bổ KPI/u);
  assert.match(payrollUi, /Không có giờ KPI/u);
  assert.doesNotMatch(payrollUi, /ca chính thực tế|Đủ điều kiện KPI|Không đủ điều kiện KPI/u);
  assert.match(css, /employee-kpi-status/u);
});
