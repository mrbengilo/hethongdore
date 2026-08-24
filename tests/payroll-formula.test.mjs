import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function moduleFromTypescript(path, replacements = []) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

async function payrollModule() {
  const financeSource = await readFile(new URL("../app/lib/finance.ts", import.meta.url), "utf8");
  const financeOutput = ts.transpileModule(financeSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const financeUrl = `data:text/javascript;base64,${Buffer.from(financeOutput).toString("base64")}`;
  return moduleFromTypescript("../app/lib/payroll.ts", [['from "./finance"', `from "${financeUrl}"`]]);
}

async function kpiModule() {
  return moduleFromTypescript("../app/lib/kpi-engine.ts");
}

const canonicalConfig = {
  tiers: [
    { minProfitPerHour: 30_000, employeeRateBps: 700 },
    { minProfitPerHour: 15_000, employeeRateBps: 500 },
    { minProfitPerHour: 7_000, employeeRateBps: 300 },
  ],
  managerRateBps: 200,
};

test("canonical KPI uses actual employee seconds and independent manager policy", async () => {
  const { calculateKpi } = await kpiModule();
  const result = calculateKpi({
    operatingProfit: 3_000_000,
    employees: [
      { employeeId: "active", actualSeconds: 40 * 3_600 },
      { employeeId: "archived-after-period", actualSeconds: 60 * 3_600 },
    ],
    config: canonicalConfig,
  });

  assert.equal(result.totalEmployeeHours, 100);
  assert.equal(result.profitPerHour, 30_000);
  assert.equal(result.employeeRateBps, 700);
  assert.equal(result.employeeKpiPool, 210_000);
  assert.deepEqual(result.employeeAllocations.map(({ employeeId, employeeKpi }) => ({ employeeId, employeeKpi })), [
    { employeeId: "active", employeeKpi: 84_000 },
    { employeeId: "archived-after-period", employeeKpi: 126_000 },
  ]);
  assert.equal(result.employeeKpiTotal, 210_000);
  assert.equal(result.managerRateBps, 200);
  assert.equal(result.managerKpi, 60_000);
});

test("KPI does not invent manager hours and manager KPI remains policy-based without employee hours", async () => {
  const { calculateKpi } = await kpiModule();
  const result = calculateKpi({ operatingProfit: 980_000, employees: [], config: canonicalConfig });
  assert.equal(result.totalEmployeeSeconds, 0);
  assert.equal(result.totalEmployeeHours, 0);
  assert.equal(result.profitPerHour, 0);
  assert.equal(result.employeeKpiTotal, 0);
  assert.equal(result.managerKpi, 19_600);
});

test("non-positive operating profit pays no employee or manager KPI", async () => {
  const { calculateKpi } = await kpiModule();
  for (const operatingProfit of [0, -1_000_000]) {
    const result = calculateKpi({
      operatingProfit,
      employees: [{ employeeId: "employee", actualSeconds: 100 * 3_600 }],
      config: canonicalConfig,
    });
    assert.equal(result.employeeKpiTotal, 0);
    assert.equal(result.managerKpi, 0);
  }
});

test("manual allowance and bonus remain explicit in preview and closing pay", async () => {
  const { employeePayWithKpi, payrollAdjustmentTotals } = await payrollModule();
  const adjustments = payrollAdjustmentTotals([
    { kind: "ALLOWANCE", amount: 49_000 },
    { kind: "BONUS", amount: 39_000 },
  ]);

  assert.deepEqual(adjustments, { manualAllowance: 49_000, manualBonus: 39_000 });
  assert.equal(employeePayWithKpi({
    baseSalary: 556,
    tiktokAllowance: 25_000,
    supportAllowance: 0,
    ...adjustments,
  }, 0), 113_556);
});

test("mid-period offboarding freezes deterministic pay but adds finalized KPI exactly once", async () => {
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

test("production payroll is wired to the canonical KPI engine and support snapshots", async () => {
  const [payroll, route, component] = await Promise.all([
    readFile(new URL("../app/lib/payroll.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payroll/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StorePayrollClosing.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(payroll, /MANAGER_FIXED_WORK_HOURS|INACTIVE_EMPLOYEE_KPI|distributeStoreKpiByPolicy/u);
  assert.match(route, /import \{ calculateKpi \} from "\.\.\/\.\.\/lib\/kpi-engine"/u);
  assert.match(route, /COALESCE\(MAX\(s\.applied_support_allowance\), 0\) AS supportAllowance/u);
  assert.match(route, /COALESCE\(s\.applied_support_allowance, 0\) AS supportAllowance/u);
  assert.doesNotMatch(route, /MAX\(t\.support_allowance\)|t\.support_allowance AS supportAllowance/u);
  assert.doesNotMatch(route, /MANAGER_FIXED_WORK_HOURS|managerFixedHours/u);
  assert.doesNotMatch(component, /managerFixedHours|140 giờ|ca chính thực tế/u);
  assert.match(component, /assertPayrollSummaryInvariants\(payload\.summary\)/u);
});
