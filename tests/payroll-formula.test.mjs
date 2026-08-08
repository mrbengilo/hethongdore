import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function payrollModule() {
  const financeSource = await readFile(new URL("../app/lib/finance.ts", import.meta.url), "utf8");
  const financeOutput = ts.transpileModule(financeSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const financeUrl = `data:text/javascript;base64,${Buffer.from(financeOutput).toString("base64")}`;
  const source = (await readFile(new URL("../app/lib/payroll.ts", import.meta.url), "utf8"))
    .replace('from "./finance"', `from "${financeUrl}"`);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("employee KPI uses the highest reached tier without stacking", async () => {
  const { employeeKpiRate } = await payrollModule();
  assert.equal(employeeKpiRate(6_999, 1), 0);
  assert.equal(employeeKpiRate(7_000, 1), 0.03);
  assert.equal(employeeKpiRate(14_999, 1), 0.03);
  assert.equal(employeeKpiRate(15_000, 1), 0.05);
  assert.equal(employeeKpiRate(29_999, 1), 0.05);
  assert.equal(employeeKpiRate(30_000, 1), 0.07);
  assert.equal(employeeKpiRate(100_000, 1), 0.07);
});

test("employee KPI is proportional to actual hours", async () => {
  const { employeeKpiBonus, distributeEmployeeKpi } = await payrollModule();
  assert.equal(employeeKpiBonus(1_000_000, 100, 40), 12_000);
  assert.deepEqual(distributeEmployeeKpi(1_000_000, [
    { employeeId: "a", hours: 40 },
    { employeeId: "b", hours: 60 },
  ]), [
    { employeeId: "a", hours: 40, bonus: 12_000 },
    { employeeId: "b", hours: 60, bonus: 18_000 },
  ]);
});

test("inactive employee below 15 completed shifts is excluded from KPI and its denominator", async () => {
  const { distributeEmployeeKpiByPolicy } = await payrollModule();
  const result = distributeEmployeeKpiByPolicy(1_000_000, [
    { employeeId: "active", employmentStatus: "ACTIVE", completedShiftCount: 8, durationSeconds: 40 * 3_600 },
    { employeeId: "left-early", employmentStatus: "INACTIVE", completedShiftCount: 14, durationSeconds: 10 * 3_600 },
  ]);

  assert.deepEqual(result.map(({ employeeId, eligible, bonus }) => ({ employeeId, eligible, bonus })), [
    { employeeId: "active", eligible: true, bonus: 50_000 },
    { employeeId: "left-early", eligible: false, bonus: 0 },
  ]);
});

test("inactive employee with at least 15 completed shifts remains in KPI allocation", async () => {
  const { distributeEmployeeKpiByPolicy } = await payrollModule();
  const result = distributeEmployeeKpiByPolicy(1_000_000, [
    { employeeId: "active", employmentStatus: "ACTIVE", completedShiftCount: 8, durationSeconds: 40 * 3_600 },
    { employeeId: "left-qualified", employmentStatus: "INACTIVE", completedShiftCount: 15, durationSeconds: 10 * 3_600 },
  ]);

  assert.deepEqual(result.map(({ employeeId, eligible, bonus }) => ({ employeeId, eligible, bonus })), [
    { employeeId: "active", eligible: true, bonus: 40_000 },
    { employeeId: "left-qualified", eligible: true, bonus: 10_000 },
  ]);
});

test("active employees always participate by actual worked time", async () => {
  const { distributeEmployeeKpiByPolicy } = await payrollModule();
  const result = distributeEmployeeKpiByPolicy(1_000_000, [
    { employeeId: "active", employmentStatus: "ACTIVE", completedShiftCount: 1, durationSeconds: 30 * 3_600 },
    { employeeId: "left-early", employmentStatus: "INACTIVE", completedShiftCount: 14, durationSeconds: 10 * 3_600 },
    { employeeId: "left-qualified", employmentStatus: "INACTIVE", completedShiftCount: 20, durationSeconds: 20 * 3_600 },
  ]);

  assert.deepEqual(result.map(({ employeeId, eligible, bonus }) => ({ employeeId, eligible, bonus })), [
    { employeeId: "active", eligible: true, bonus: 30_000 },
    { employeeId: "left-early", eligible: false, bonus: 0 },
    { employeeId: "left-qualified", eligible: true, bonus: 20_000 },
  ]);
});

test("store KPI includes 140 manager hours and shares one tier pool exactly", async () => {
  const {
    MANAGER_FIXED_WORK_HOURS_PER_STORE,
    distributeStoreKpiByPolicy,
  } = await payrollModule();
  const result = distributeStoreKpiByPolicy(7_200_000, [
    { employeeId: "active", employmentStatus: "ACTIVE", completedShiftCount: 8, durationSeconds: 60 * 3_600 },
    { employeeId: "left-early", employmentStatus: "INACTIVE", completedShiftCount: 14, durationSeconds: 20 * 3_600 },
    { employeeId: "left-qualified", employmentStatus: "INACTIVE", completedShiftCount: 15, durationSeconds: 40 * 3_600 },
  ]);

  assert.equal(MANAGER_FIXED_WORK_HOURS_PER_STORE, 140);
  assert.equal(result.eligibleEmployeeHours, 100);
  assert.equal(result.totalHours, 240);
  assert.equal(result.profitPerHour, 30_000);
  assert.equal(result.kpiRate, 0.07);
  assert.equal(result.kpiPool, 504_000);
  assert.deepEqual(result.employees.map(({ employeeId, eligible, bonus }) => ({ employeeId, eligible, bonus })), [
    { employeeId: "active", eligible: true, bonus: 126_000 },
    { employeeId: "left-early", eligible: false, bonus: 0 },
    { employeeId: "left-qualified", eligible: true, bonus: 84_000 },
  ]);
  assert.equal(result.employeeBonusTotal, 210_000);
  assert.deepEqual(result.manager, { durationSeconds: 140 * 3_600, hours: 140, bonus: 294_000 });
  assert.equal(result.employeeBonusTotal + result.managerBonus, result.kpiPool);
});

test("manager-only store reaches the 3 percent threshold and VND allocation never leaks rounding", async () => {
  const { distributeStoreKpiByPolicy } = await payrollModule();
  const below = distributeStoreKpiByPolicy(979_999, []);
  assert.equal(below.kpiRate, 0);
  assert.equal(below.managerBonus, 0);

  const threshold = distributeStoreKpiByPolicy(980_000, []);
  assert.equal(threshold.profitPerHour, 7_000);
  assert.equal(threshold.kpiRate, 0.03);
  assert.equal(threshold.kpiPool, 29_400);
  assert.equal(threshold.managerBonus, 29_400);

  const rounding = distributeStoreKpiByPolicy(10_000_001, [
    { employeeId: "one-second", employmentStatus: "ACTIVE", completedShiftCount: 1, durationSeconds: 1 },
    { employeeId: "two-seconds", employmentStatus: "ACTIVE", completedShiftCount: 1, durationSeconds: 2 },
  ]);
  assert.equal(rounding.employeeBonusTotal + rounding.managerBonus, rounding.kpiPool);
});

test("multi-store employee payroll is locked and paid only when every source is complete", async () => {
  const { employeePayrollOverallState } = await payrollModule();

  assert.deepEqual(employeePayrollOverallState([
    { locked: true, paymentStatus: "LOCKED" },
    { locked: false, paymentStatus: "PROVISIONAL" },
  ]), { locked: false, paid: false });
  assert.deepEqual(employeePayrollOverallState([
    { locked: true, paymentStatus: "PAYMENT_CONFIRMED" },
    { locked: true, paymentStatus: "PENDING" },
  ]), { locked: true, paid: false });
  assert.deepEqual(employeePayrollOverallState([
    { locked: true, paymentStatus: "PAYMENT_CONFIRMED" },
    { locked: true, paymentStatus: "LOCKED" },
  ]), { locked: true, paid: true });
  assert.deepEqual(employeePayrollOverallState([]), { locked: false, paid: false });
});

test("employee KPI handles invalid or non-positive values", async () => {
  const { employeeKpiBonus, employeeKpiRate } = await payrollModule();
  assert.equal(employeeKpiRate(0, 100), 0);
  assert.equal(employeeKpiRate(100_000, 0), 0);
  assert.equal(employeeKpiBonus(-1, 100, 10), 0);
  assert.equal(employeeKpiBonus(1_000_000, 100, 0), 0);
  assert.equal(employeeKpiBonus(Number.NaN, 100, 10), 0);
});

test("mid-month offboarding freezes deterministic pay but defers KPI until period close", async () => {
  const { employeePayWithKpi } = await payrollModule();
  const lockedComponents = {
    baseSalary: 2_000_000,
    tiktokAllowance: 100_000,
    supportAllowance: 200_000,
    manualAllowance: 50_000,
    manualBonus: 75_000,
  };
  assert.equal(employeePayWithKpi(lockedComponents, 0), 2_425_000);
  assert.equal(employeePayWithKpi(lockedComponents, 350_000), 2_775_000);
});
