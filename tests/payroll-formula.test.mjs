import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function payrollModule() {
  const source = await readFile(new URL("../app/lib/payroll.ts", import.meta.url), "utf8");
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

test("employee KPI handles invalid or non-positive values", async () => {
  const { employeeKpiBonus, employeeKpiRate } = await payrollModule();
  assert.equal(employeeKpiRate(0, 100), 0);
  assert.equal(employeeKpiRate(100_000, 0), 0);
  assert.equal(employeeKpiBonus(-1, 100, 10), 0);
  assert.equal(employeeKpiBonus(1_000_000, 100, 0), 0);
  assert.equal(employeeKpiBonus(Number.NaN, 100, 10), 0);
});
