import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateKpi } from "../app/lib/kpi-engine.ts";

const configuredPolicy = Object.freeze({
  tiers: Object.freeze([
    Object.freeze({ minProfitPerHour: 15_000, employeeRateBps: 500 }),
    Object.freeze({ minProfitPerHour: 7_000, employeeRateBps: 300 }),
    Object.freeze({ minProfitPerHour: 30_000, employeeRateBps: 700 }),
  ]),
  managerRateBps: 200,
});

function oneEmployeeAtProfitPerHour(profitPerHour) {
  return calculateKpi({
    operatingProfit: profitPerHour,
    employees: [{ employeeId: "employee-1", actualSeconds: 3_600 }],
    config: configuredPolicy,
  });
}

test("selects the highest configured employee tier reached by profit per employee hour", () => {
  assert.equal(oneEmployeeAtProfitPerHour(6_999).employeeRateBps, 0);
  assert.equal(oneEmployeeAtProfitPerHour(7_000).employeeRateBps, 300);
  assert.equal(oneEmployeeAtProfitPerHour(14_999).employeeRateBps, 300);
  assert.equal(oneEmployeeAtProfitPerHour(15_000).employeeRateBps, 500);
  assert.equal(oneEmployeeAtProfitPerHour(29_999).employeeRateBps, 500);
  assert.equal(oneEmployeeAtProfitPerHour(30_000).employeeRateBps, 700);
  assert.equal(oneEmployeeAtProfitPerHour(90_000).selectedTier.minProfitPerHour, 30_000);
});

test("returns zero employee and manager KPI for zero or negative operating profit", () => {
  for (const operatingProfit of [-1_000_000, 0]) {
    const result = calculateKpi({
      operatingProfit,
      employees: [
        { employeeId: "positive-hours", actualSeconds: 3_600 },
        { employeeId: "zero-hours", actualSeconds: 0 },
      ],
      config: configuredPolicy,
    });

    assert.equal(result.totalEmployeeSeconds, 3_600);
    assert.equal(result.profitPerHour, 0);
    assert.equal(result.selectedTier, null);
    assert.equal(result.employeeKpiPool, 0);
    assert.equal(result.employeeKpiTotal, 0);
    assert.equal(result.managerKpi, 0);
    assert.deepEqual(result.employeeAllocations.map((employee) => employee.employeeKpi), [0, 0]);
  }
});

test("zero employee hours cannot create an employee pool while manager KPI remains independent", () => {
  const result = calculateKpi({
    operatingProfit: 1_000_000,
    employees: [{ employeeId: "zero-hours", actualSeconds: 0 }],
    config: configuredPolicy,
  });

  assert.equal(result.totalEmployeeHours, 0);
  assert.equal(result.profitPerHour, 0);
  assert.equal(result.employeeRateBps, 0);
  assert.equal(result.employeeKpiPool, 0);
  assert.equal(result.employeeKpiTotal, 0);
  assert.equal(result.managerKpi, 20_000);
});

test("employee and manager KPI use independent configured percentages", () => {
  const result = calculateKpi({
    operatingProfit: 1_000_000,
    employees: [
      { employeeId: "employee-a", actualSeconds: 40 * 3_600 },
      { employeeId: "employee-b", actualSeconds: 60 * 3_600 },
    ],
    config: configuredPolicy,
  });

  assert.equal(result.profitPerHour, 10_000);
  assert.equal(result.employeeRateBps, 300);
  assert.equal(result.employeeKpiPool, 30_000);
  assert.equal(result.employeeKpiTotal, 30_000);
  assert.deepEqual(result.employeeAllocations.map(({ employeeId, employeeKpi }) => ({ employeeId, employeeKpi })), [
    { employeeId: "employee-a", employeeKpi: 12_000 },
    { employeeId: "employee-b", employeeKpi: 18_000 },
  ]);
  assert.equal(result.managerRateBps, 200);
  assert.equal(result.managerKpi, 20_000);
});

test("largest-remainder allocation is deterministic and preserves every VND in the employee pool", () => {
  const employees = Object.freeze([
    Object.freeze({ employeeId: "employee-b", actualSeconds: 1 }),
    Object.freeze({ employeeId: "employee-a", actualSeconds: 1 }),
    Object.freeze({ employeeId: "employee-c", actualSeconds: 1 }),
  ]);
  const result = calculateKpi({
    operatingProfit: 100_001,
    employees,
    config: configuredPolicy,
  });

  assert.equal(result.employeeRateBps, 700);
  assert.equal(result.employeeKpiPool, 7_000);
  assert.equal(result.employeeKpiTotal, result.employeeKpiPool);
  assert.deepEqual(result.employeeAllocations.map(({ employeeId, employeeKpi }) => ({ employeeId, employeeKpi })), [
    { employeeId: "employee-b", employeeKpi: 2_333 },
    { employeeId: "employee-a", employeeKpi: 2_334 },
    { employeeId: "employee-c", employeeKpi: 2_333 },
  ]);
  assert.deepEqual(employees, [
    { employeeId: "employee-b", actualSeconds: 1 },
    { employeeId: "employee-a", actualSeconds: 1 },
    { employeeId: "employee-c", actualSeconds: 1 },
  ]);
});

test("rejects ambiguous or malformed configuration instead of silently choosing a business rule", () => {
  assert.throws(() => calculateKpi({
    operatingProfit: 1_000_000,
    employees: [],
    config: {
      managerRateBps: 200,
      tiers: [
        { minProfitPerHour: 7_000, employeeRateBps: 300 },
        { minProfitPerHour: 7_000, employeeRateBps: 500 },
      ],
    },
  }), /duplicated/u);

  assert.throws(() => calculateKpi({
    operatingProfit: 1_000_000,
    employees: [{ employeeId: "employee", actualSeconds: 0.5 }],
    config: configuredPolicy,
  }), /actualSeconds/u);

  assert.throws(() => calculateKpi({
    operatingProfit: 1_000_000,
    employees: [{ employeeId: "employee", actualSeconds: -1 }],
    config: configuredPolicy,
  }), /actualSeconds/u);

  assert.throws(() => calculateKpi({
    operatingProfit: 1_000_000,
    employees: [{ employeeId: "employee", actualSeconds: 3_600 }],
    config: {
      managerRateBps: 4_000,
      tiers: [{ minProfitPerHour: 7_000, employeeRateBps: 7_000 }],
    },
  }), /combined manager and employee KPI rates/u);
});
