import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FINANCIAL_PERIOD_STATES,
  assertFinancialPeriodTransition,
  canTransitionFinancialPeriod,
  isFinancialPeriodImmutable,
  parsePersistedFinancialPeriodSnapshot,
  preferPersistedFinancialSnapshot,
  serializePersistedFinancialPeriodSnapshot,
  usesPersistedFinancialSnapshot,
} from "../app/api/_lib/financial-period.ts";
import { calculateFinance } from "../app/lib/finance-engine.ts";

const legalTransitions = new Set([
  "DRAFT->CALCULATED",
  "CALCULATED->RECONCILING",
  "RECONCILING->CONFIRMED",
  "CONFIRMED->PAID",
  "PAID->LOCKED",
]);

function finance(overrides = {}) {
  return calculateFinance({
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
    ...overrides,
  });
}

function confirmedSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    storeId: "store-a",
    period: "2026-08",
    status: "CONFIRMED",
    configVersion: 3,
    finance: finance(),
    confirmedAt: "2026-09-02T01:00:00.000Z",
    confirmedBy: "manager-a",
    paidAt: null,
    paidBy: null,
    lockedAt: null,
    lockedBy: null,
    ...overrides,
  };
}

test("allows only the adjacent forward lifecycle transitions", () => {
  for (const from of FINANCIAL_PERIOD_STATES) {
    for (const to of FINANCIAL_PERIOD_STATES) {
      const transition = `${from}->${to}`;
      const expected = legalTransitions.has(transition);
      assert.equal(canTransitionFinancialPeriod(from, to), expected, transition);
      if (expected) {
        assert.doesNotThrow(() => assertFinancialPeriodTransition(from, to));
      } else {
        assert.throws(
          () => assertFinancialPeriodTransition(from, to),
          new RegExp(`Illegal financial period transition: ${from} -> ${to}`, "u"),
        );
      }
    }
  }
});

test("LOCKED is the only directly immutable state", () => {
  for (const status of FINANCIAL_PERIOD_STATES) {
    assert.equal(isFinancialPeriodImmutable(status), status === "LOCKED");
  }
});

test("persisted snapshots are preferred only from CONFIRMED onward", () => {
  for (const status of FINANCIAL_PERIOD_STATES) {
    const expected = ["CONFIRMED", "PAID", "LOCKED"].includes(status);
    assert.equal(usesPersistedFinancialSnapshot(status), expected);
    assert.equal(
      preferPersistedFinancialSnapshot(status, "live", "persisted"),
      expected ? "persisted" : "live",
    );
    assert.equal(preferPersistedFinancialSnapshot(status, "live", null), "live");
  }
});

test("CONFIRMED snapshot round-trips with canonical Finance Engine metrics", () => {
  const parsed = parsePersistedFinancialPeriodSnapshot(confirmedSnapshot());
  const roundTrip = parsePersistedFinancialPeriodSnapshot(
    serializePersistedFinancialPeriodSnapshot(parsed),
  );

  assert.deepEqual(roundTrip, parsed);
  assert.equal(parsed.finance.operatingProfit, 30_000_000);
  assert.equal(parsed.finance.profitAfterKpi, 27_900_000);
  assert.equal(parsed.finance.finalProfit, 25_000_000);
  assert.equal(parsed.finance.distributableProfit, 25_000_000);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.finance), true);
});

test("PAID requires confirmation and payment metadata but no lock metadata", () => {
  const paid = parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "PAID",
    paidAt: "2026-09-03T01:00:00.000Z",
    paidBy: "manager-b",
  }));
  assert.equal(paid.status, "PAID");
  assert.equal(paid.paidBy, "manager-b");

  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "PAID",
  })), /paidAt and paidBy are required/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "PAID",
    paidAt: "2026-09-03T01:00:00.000Z",
    paidBy: null,
  })), /recorded together/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "PAID",
    paidAt: "2026-09-03T01:00:00.000Z",
    paidBy: "manager-b",
    lockedAt: "2026-09-04T01:00:00.000Z",
    lockedBy: "super-admin",
  })), /cannot contain lock metadata/u);
});

test("LOCKED requires chronologically ordered confirmation, payment, and lock metadata", () => {
  const locked = parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "LOCKED",
    paidAt: "2026-09-03T01:00:00.000Z",
    paidBy: "manager-b",
    lockedAt: "2026-09-04T01:00:00.000Z",
    lockedBy: "super-admin",
  }));
  assert.equal(locked.status, "LOCKED");
  assert.equal(locked.lockedBy, "super-admin");

  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "LOCKED",
    paidAt: "2026-09-03T01:00:00.000Z",
    paidBy: "manager-b",
  })), /lockedAt and lockedBy are required/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "LOCKED",
    paidAt: "2026-09-01T01:00:00.000Z",
    paidBy: "manager-b",
    lockedAt: "2026-09-04T01:00:00.000Z",
    lockedBy: "super-admin",
  })), /paidAt cannot be earlier/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "LOCKED",
    paidAt: "2026-09-05T01:00:00.000Z",
    paidBy: "manager-b",
    lockedAt: "2026-09-04T01:00:00.000Z",
    lockedBy: "super-admin",
  })), /lockedAt cannot be earlier/u);
});

test("snapshot parser rejects non-canonical or malformed Finance Engine metrics", () => {
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    finance: { ...finance(), finalProfit: 25_000_001 },
  })), /finance.finalProfit does not match/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    finance: { ...finance(), employeeSalary: 15_000_000.5 },
  })), /finance.employeeSalary/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    finance: { ...finance(), fixedExpense: -1 },
  })), /finance.fixedExpense/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    configVersion: 1.5,
  })), /configVersion/u);
});

test("snapshot parser rejects missing confirmation metadata and premature metadata", () => {
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    confirmedAt: null,
    confirmedBy: null,
  })), /confirmedAt and confirmedBy are required/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    paidAt: "2026-09-03T01:00:00.000Z",
    paidBy: "manager-b",
  })), /cannot contain payment or lock metadata/u);
  assert.throws(() => parsePersistedFinancialPeriodSnapshot(confirmedSnapshot({
    status: "RECONCILING",
  })), /snapshot status/u);
});
