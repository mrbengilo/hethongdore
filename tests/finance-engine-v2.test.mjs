import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KPI_EXPENSE_COMPONENTS,
  OPERATING_EXPENSE_COMPONENTS,
  calculateFinance,
} from "../app/lib/finance-engine.ts";

function emptyInput(overrides = {}) {
  return {
    grossRevenue: 0,
    fixedExpense: 0,
    variableExpense: 0,
    inventoryCost: 0,
    inventoryShippingCost: 0,
    employeeSalary: 0,
    managerSalary: 0,
    manualEmployeeBonus: 0,
    employeeAllowance: 0,
    employeeKpiTotal: 0,
    managerKpi: 0,
    monthEndExpense: 0,
    ...overrides,
  };
}

test("calculates the canonical 100m revenue to 25m final-profit example", () => {
  const result = calculateFinance(emptyInput({
    grossRevenue: 100_000_000,
    fixedExpense: 10_000_000,
    variableExpense: 5_000_000,
    inventoryCost: 30_000_000,
    inventoryShippingCost: 2_000_000,
    employeeSalary: 15_000_000,
    managerSalary: 5_000_000,
    manualEmployeeBonus: 2_000_000,
    employeeAllowance: 1_000_000,
    employeeKpiTotal: 1_500_000,
    managerKpi: 600_000,
    monthEndExpense: 2_900_000,
  }));

  assert.equal(result.operatingExpense, 70_000_000);
  assert.equal(result.operatingProfit, 30_000_000);
  assert.equal(result.kpiExpense, 2_100_000);
  assert.equal(result.profitAfterKpi, 27_900_000);
  assert.equal(result.monthEndExpense, 2_900_000);
  assert.equal(result.totalExpense, 75_000_000);
  assert.equal(result.finalProfit, 25_000_000);
  assert.equal(result.distributableProfit, 25_000_000);
  assert.equal(result.finalProfit, result.grossRevenue - result.totalExpense);
});

test("keeps a negative final profit while preventing loss distribution", () => {
  const result = calculateFinance(emptyInput({
    grossRevenue: 5_000_000,
    fixedExpense: 3_000_000,
    monthEndExpense: 3_000_000,
  }));

  assert.equal(result.operatingProfit, 2_000_000);
  assert.equal(result.profitAfterKpi, 2_000_000);
  assert.equal(result.finalProfit, -1_000_000);
  assert.equal(result.totalExpense, 6_000_000);
  assert.equal(result.distributableProfit, 0);
});

test("rejects malformed, negative, fractional, non-finite, and unsafe components", () => {
  for (const invalidValue of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1000", null]) {
    assert.throws(
      () => calculateFinance(emptyInput({ fixedExpense: invalidValue })),
      { name: "TypeError", message: /fixedExpense/u },
    );
  }

  const missing = emptyInput();
  delete missing.managerSalary;
  assert.throws(
    () => calculateFinance(missing),
    { name: "TypeError", message: /managerSalary/u },
  );
  assert.throws(() => calculateFinance(null), { name: "TypeError" });
  assert.throws(() => calculateFinance([]), { name: "TypeError" });
});

test("rejects an aggregate that would leave the safe integer range", () => {
  assert.throws(
    () => calculateFinance(emptyInput({
      fixedExpense: Number.MAX_SAFE_INTEGER,
      variableExpense: 1,
    })),
    { name: "RangeError", message: /operatingExpense/u },
  );
});

test("each operating component is counted once before KPI and month-end expense", () => {
  for (const component of OPERATING_EXPENSE_COMPONENTS) {
    const input = emptyInput({ grossRevenue: 1_000, [component]: 123 });
    const snapshot = structuredClone(input);
    const result = calculateFinance(input);

    assert.deepEqual(input, snapshot, `${component} input was mutated`);
    assert.equal(result[component], 123);
    assert.equal(result.operatingExpense, 123);
    assert.equal(result.operatingProfit, 877);
    assert.equal(result.profitAfterKpi, 877);
    assert.equal(result.finalProfit, 877);
    assert.equal(result.totalExpense, 123);
  }
});

test("KPI and month-end components affect only their intended profit stages", () => {
  for (const component of KPI_EXPENSE_COMPONENTS) {
    const result = calculateFinance(emptyInput({ grossRevenue: 1_000, [component]: 123 }));
    assert.equal(result.operatingProfit, 1_000);
    assert.equal(result.kpiExpense, 123);
    assert.equal(result.profitAfterKpi, 877);
    assert.equal(result.finalProfit, 877);
    assert.equal(result.totalExpense, 123);
  }

  const monthEnd = calculateFinance(emptyInput({ grossRevenue: 1_000, monthEndExpense: 123 }));
  assert.equal(monthEnd.operatingProfit, 1_000);
  assert.equal(monthEnd.profitAfterKpi, 1_000);
  assert.equal(monthEnd.finalProfit, 877);
  assert.equal(monthEnd.totalExpense, 123);
});

test("the result is immutable and total expense always reconciles to final profit", () => {
  const result = calculateFinance(emptyInput({
    grossRevenue: 10_000,
    fixedExpense: 1_000,
    employeeSalary: 2_000,
    employeeKpiTotal: 300,
    monthEndExpense: 200,
  }));

  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.totalExpense, result.operatingExpense + result.kpiExpense + result.monthEndExpense);
  assert.equal(result.finalProfit, result.grossRevenue - result.totalExpense);
});
