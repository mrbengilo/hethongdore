import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("employee status changes use one audited endpoint and revoke existing login sessions", async () => {
  const [employeesApi, auth, login, shiftApi, ui] = await Promise.all([
    source("../app/api/employees/route.ts"),
    source("../app/api/_lib/auth.ts"),
    source("../app/api/auth/login/route.ts"),
    source("../app/api/shift/route.ts"),
    source("../app/components/EmployeeManagement.tsx"),
  ]);

  assert.match(employeesApi, /action === "SET_STATUS"/u);
  assert.match(employeesApi, /DELETE FROM sessions WHERE user_id IN/u);
  assert.match(employeesApi, /EMPLOYEE_STATUS_CHANGE/u);
  assert.match(employeesApi, /NOT EXISTS \(SELECT 1 FROM shift_sessions WHERE employee_id = \? AND status = 'ACTIVE'\)/u);
  assert.match(employeesApi, /affectedRows\(transition\) === 0/u);
  assert.match(employeesApi, /body\.status !== undefined && body\.status !== existing\.status/u);
  assert.match(employeesApi, /body\.password !== ""/u);
  assert.match(employeesApi, /SET status = 'INACTIVE', inactive_at = \?/u);
  assert.match(employeesApi, /SET status = 'ACTIVE', inactive_at = NULL/u);
  assert.match(employeesApi, /requiredOffboardingLock/u);
  assert.match(employeesApi, /trước khi chuyển lại sang đang làm việc/u);
  assert.match(auth, /row\.employeeStatus !== "ACTIVE" \|\| row\.homeStoreStatus !== "ACTIVE"/u);
  assert.match(auth, /DELETE FROM sessions WHERE token_hash = \?/u);
  assert.match(login, /user\.employee_status !== "ACTIVE"/u);
  assert.match(shiftApi, /EXISTS \(SELECT 1 FROM employees WHERE id = \? AND status = 'ACTIVE'\)/u);
  assert.match(ui, /action: "SET_STATUS"/u);
  assert.match(ui, /Ngưng làm việc/u);
  assert.doesNotMatch(ui, /<select value=\{form\.status\}/u);
});

test("individual payroll locks are immutable, idempotent and preserve offboarding snapshots", async () => {
  const [schema, runtime, migration, payroll, records, ui] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/runtime.ts"),
    source("../drizzle/0006_employee_payroll_closing.sql"),
    source("../app/api/payroll/route.ts"),
    source("../app/api/records/route.ts"),
    source("../app/components/StorePayrollClosing.tsx"),
  ]);

  for (const text of [schema, runtime, migration]) assert.match(text, /employee_payroll_closings/u);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_employee_payroll_closing_period`/u);
  assert.match(payroll, /"FINALIZE_SINGLE_EMPLOYEE"/u);
  assert.match(payroll, /INSERT OR IGNORE INTO employee_payroll_closings/u);
  assert.match(payroll, /period === localPeriod\(\) && employee\.status !== "INACTIVE"/u);
  assert.match(payroll, /const kpiDeferred = true/u);
  assert.doesNotMatch(payroll, /kpiDeferred = period === localPeriod\(\)/u);
  assert.match(payroll, /employeePayWithKpi\(locked, kpiBonus\)/u);
  assert.match(payroll, /employeePayWithKpi\(sourceItem, 0\)/u);
  assert.match(payroll, /\(e\.status = 'ACTIVE' AND e\.store_id = \?\)/u);
  assert.match(payroll, /e\.status = 'INACTIVE'.*strftime\('%Y-%m', e\.inactive_at, '\+7 hours'\) = \?/su);
  assert.match(payroll, /SELECT 1 FROM employee_payroll_closings c/u);
  assert.match(payroll, /Hãy chốt lương riêng cho từng nhân viên/u);
  assert.match(records, /isEmployeePayrollLocked/u);
  assert.match(records, /đã khóa sổ riêng/u);
  assert.doesNotMatch(`${payroll}\n${records}`, /DELETE FROM employee_payroll_closings|UPDATE employee_payroll_closings/u);
  assert.match(ui, /runAction\("FINALIZE_SINGLE_EMPLOYEE", item\)/u);
  assert.match(ui, /dateTime24\(employeeClosing\.lockedAt\)/u);
  assert.match(ui, /KPI chờ chốt kỳ/u);
  assert.match(ui, /Chốt bắt buộc/u);
});

test("previous-period individual closing defers KPI until the locked store summary", async () => {
  const payroll = await source("../app/api/payroll/route.ts");
  assert.match(payroll, /const kpiDeferred = true/u);
  assert.match(payroll, /kpiBonus: 0/u);
  assert.match(payroll, /employeePayWithKpi\(sourceItem, 0\)/u);
  assert.match(payroll, /employeePayWithKpi\(locked, kpiBonus\)/u);
  assert.match(payroll, /single immutable KPI_SUMMARY created by FINALIZE_EMPLOYEE/u);
});

test("inactive_at includes an offboarded zero-pay employee only in the offboarding period", async () => {
  const [schema, runtime, migration, employeesApi, payroll] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/runtime.ts"),
    source("../drizzle/0006_employee_payroll_closing.sql"),
    source("../app/api/employees/route.ts"),
    source("../app/api/payroll/route.ts"),
  ]);
  for (const text of [schema, runtime, migration]) assert.match(text, /inactive_at/u);
  assert.match(runtime, /status = 'INACTIVE' AND inactive_at IS NULL/u);
  assert.match(employeesApi, /inactive_at = \?/u);
  assert.match(employeesApi, /inactive_at = NULL/u);
  assert.match(payroll, /e\.status = 'INACTIVE'.*e\.inactive_at.*= \?/su);
});

test("transfer creation rejects inactive employees and closes the status-change race", async () => {
  const [employeesApi, transfersApi] = await Promise.all([
    source("../app/api/employees/route.ts"),
    source("../app/api/transfers/route.ts"),
  ]);
  assert.match(transfersApi, /WHERE id = \? AND status = 'ACTIVE'/u);
  assert.match(transfersApi, /INSERT INTO employee_transfers[\s\S]*WHERE EXISTS \(SELECT 1 FROM employees e[\s\S]*e\.status = 'ACTIVE'\)/u);
  assert.match(transfersApi, /NOT EXISTS \([\s\S]*t\.status IN \('SCHEDULED', 'ACTIVE'\)/u);
  assert.match(transfersApi, /affectedRows\(insert\) === 0/u);
  assert.match(transfersApi, /Nhân viên vừa chuyển sang ngưng làm việc/u);
  assert.match(employeesApi, /NOT EXISTS \(SELECT 1 FROM employee_transfers WHERE employee_id = \? AND status IN \('SCHEDULED', 'ACTIVE'\)\)/u);
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
  assert.match(payrollUi, /Khóa sổ riêng/u);
  assert.match(payrollUi, /employeeClosingById/u);
});
