import assert from "node:assert/strict";
import { test } from "node:test";

import {
  financialPolicyTikTokAllowanceVnd,
  financialPolicyFromPayrollSnapshot,
  isFinancialPeriod,
  loadFinancialPolicyForPeriod,
  normalizeFinancialPolicy,
  parseFinancialPolicy,
  parseFinancialPolicyVersionRow,
  serializeFinancialPolicy,
} from "../app/api/_lib/financial-policy.ts";
import { serializePayrollPolicy } from "../app/lib/payroll-policy.ts";

function policyPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    managerMonthlySalaryVnd: 4_250_000,
    managerKpiRateBasisPoints: 225,
    employeeKpiTiers: [
      { minimumProfitPerHour: 7_000, rateBasisPoints: 300 },
      { minimumProfitPerHour: 30_000, rateBasisPoints: 700 },
      { minimumProfitPerHour: 15_000, rateBasisPoints: 500 },
    ],
    allowances: {
      TIKTOK: { amountVnd: 30_000, eligibility: "SHIFT_SNAPSHOT" },
    },
    profitSharingMembers: [
      { memberId: "member-a", name: "Thành viên A", rateBasisPoints: 4_000 },
      { memberId: "member-b", name: "Thành viên B", rateBasisPoints: 6_000 },
    ],
    ...overrides,
  };
}

function payrollSnapshot(overrides = {}) {
  const stored = {
    schemaVersion: 1,
    managerMonthlySalaryVnd: 5_500_000,
    managerKpiRateBasisPoints: 250,
    employeeKpiTiers: [
      { minimumProfitPerHour: 30_000, rateBasisPoints: 800 },
      { minimumProfitPerHour: 15_000, rateBasisPoints: 550 },
      { minimumProfitPerHour: 7_000, rateBasisPoints: 325 },
    ],
    version: 9,
    updatedBy: "admin-policy",
    mutationToken: "policy-nine",
    ...overrides,
  };
  return {
    ...stored,
    rawValue: serializePayrollPolicy(stored),
    updatedAt: "2026-08-24T01:00:00.000Z",
  };
}

class FakeDb {
  constructor({ rows = [], payrollPolicy = payrollSnapshot() } = {}) {
    this.rows = structuredClone(rows);
    this.payrollPolicy = payrollPolicy;
    this.insertAttempts = 0;
  }

  prepare(sql) {
    const normalizedSql = sql.replace(/\s+/gu, " ").trim();
    return {
      bind: (...bindings) => ({
        first: async () => this.#first(normalizedSql, bindings),
        run: async () => this.#run(normalizedSql, bindings),
      }),
      first: async () => this.#first(normalizedSql, []),
    };
  }

  #first(sql, bindings) {
    if (sql.includes("FROM system_state")) {
      return { value: this.payrollPolicy.rawValue, updatedAt: this.payrollPolicy.updatedAt };
    }
    if (sql.includes("COALESCE(MAX(version)")) {
      return { nextVersion: Math.max(0, ...this.rows.map((row) => row.version)) + 1 };
    }
    if (sql.includes("FROM financial_policy_versions")) {
      const [period] = bindings;
      return this.rows
        .filter((row) => row.effectiveFromPeriod <= period)
        .sort((left, right) => right.effectiveFromPeriod.localeCompare(left.effectiveFromPeriod)
          || right.version - left.version)[0] ?? null;
    }
    throw new Error(`Unexpected SELECT: ${sql}`);
  }

  #run(sql, bindings) {
    if (!sql.startsWith("INSERT OR IGNORE INTO financial_policy_versions")) {
      throw new Error(`Unexpected mutation: ${sql}`);
    }
    this.insertAttempts += 1;
    const [id, version, effectiveFromPeriod, policyJson, createdBy, createdAt] = bindings;
    if (!this.rows.some((row) => row.id === id || row.version === version)) {
      this.rows.push({
        id,
        version,
        effectiveFromPeriod,
        policyJson,
        createdBy,
        createdAt,
        supersededAt: null,
      });
    }
    return { success: true };
  }
}

test("normalizes explicit policy fields without injecting business defaults", () => {
  const source = policyPayload();
  const normalized = normalizeFinancialPolicy(source);
  assert.ok(normalized);
  assert.equal(normalized.managerMonthlySalaryVnd, 4_250_000);
  assert.equal(normalized.managerKpiRateBasisPoints, 225);
  assert.deepEqual(normalized.employeeKpiTiers.map((tier) => tier.minimumProfitPerHour), [30_000, 15_000, 7_000]);
  assert.deepEqual(normalized.allowances, source.allowances);
  assert.deepEqual(normalized.profitSharingMembers, source.profitSharingMembers);
  assert.notEqual(normalized.allowances, source.allowances);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.allowances.TIKTOK), true);
  assert.equal(Object.isFrozen(normalized.profitSharingMembers[0]), true);
  assert.equal(financialPolicyTikTokAllowanceVnd(normalized), 30_000);
  assert.equal(financialPolicyTikTokAllowanceVnd({ allowances: {} }), null);

  assert.equal(normalizeFinancialPolicy({ ...source, allowances: undefined }), null);
  assert.equal(normalizeFinancialPolicy({ ...source, profitSharingMembers: undefined }), null);
  assert.equal(normalizeFinancialPolicy({ ...source, managerKpiRateBasisPoints: null }), null);
  assert.equal(normalizeFinancialPolicy({ ...source, managerKpiRateBasisPoints: 10_001 }), null);
  assert.equal(normalizeFinancialPolicy({ ...source, managerKpiRateBasisPoints: 9_500 }), null);
  assert.equal(normalizeFinancialPolicy({
    ...source,
    profitSharingMembers: [{ memberId: "owner", name: "Chủ sở hữu", rateBasisPoints: 9_999 }],
  }), null, "configured profit-sharing rates must total exactly 100%");
  assert.equal(normalizeFinancialPolicy({
    ...source,
    profitSharingMembers: [
      { memberId: "duplicate", name: "A", rateBasisPoints: 5_000 },
      { memberId: "duplicate", name: "B", rateBasisPoints: 5_000 },
    ],
  }), null, "member identifiers must be unique");
});

test("serializes and parses a policy without changing extension payloads", () => {
  const normalized = normalizeFinancialPolicy(policyPayload());
  assert.ok(normalized);
  const serialized = serializeFinancialPolicy(normalized);
  const parsed = parseFinancialPolicy(serialized);
  assert.deepEqual(parsed, normalized);
  assert.equal(parseFinancialPolicy("not-json"), null);
  assert.equal(parseFinancialPolicy(JSON.stringify({ schemaVersion: 1 })), null);
});

test("adapts legacy payroll policy with the canonical 2% manager KPI compatibility rate", () => {
  const legacy = payrollSnapshot({ managerKpiRateBasisPoints: null });
  const policy = financialPolicyFromPayrollSnapshot(legacy, {
    allowances: { TIKTOK: { amountVnd: 42_000 } },
    profitSharingMembers: [{ memberId: "owner", name: "Chủ sở hữu", rateBasisPoints: 10_000 }],
  });
  assert.equal(policy.managerMonthlySalaryVnd, 5_500_000);
  assert.equal(policy.managerKpiRateBasisPoints, 200);
  assert.equal(policy.allowances.TIKTOK.amountVnd, 42_000);
  assert.equal(policy.profitSharingMembers[0].rateBasisPoints, 10_000);
});

test("validates effective periods and immutable version rows", () => {
  assert.equal(isFinancialPeriod("2026-08"), true);
  for (const invalid of ["2026-00", "2026-13", "2026-8", "26-08", null]) {
    assert.equal(isFinancialPeriod(invalid), false);
  }

  const policy = normalizeFinancialPolicy(policyPayload());
  assert.ok(policy);
  const version = parseFinancialPolicyVersionRow({
    id: "policy-3",
    version: 3,
    effectiveFromPeriod: "2026-08",
    policyJson: serializeFinancialPolicy(policy),
    createdBy: "admin",
    createdAt: "2026-08-24T00:00:00.000Z",
    supersededAt: null,
  });
  assert.ok(version);
  assert.equal(Object.isFrozen(version), true);
  assert.equal(version.policy.managerMonthlySalaryVnd, 4_250_000);
  assert.equal(parseFinancialPolicyVersionRow({ ...version, version: 0 }), null);
  assert.equal(parseFinancialPolicyVersionRow({ ...version, policyJson: "{}" }), null);
});

test("loads the latest policy effective for a period without ignoring historical superseded rows", async () => {
  const makeRow = (id, version, effectiveFromPeriod, salary, supersededAt = null) => {
    const policy = normalizeFinancialPolicy(policyPayload({ managerMonthlySalaryVnd: salary }));
    return {
      id,
      version,
      effectiveFromPeriod,
      policyJson: serializeFinancialPolicy(policy),
      createdBy: "admin",
      createdAt: "2026-01-01T00:00:00.000Z",
      supersededAt,
    };
  };
  const db = new FakeDb({ rows: [
    makeRow("policy-june", 1, "2026-06", 4_000_000, "2026-08-01T00:00:00.000Z"),
    makeRow("policy-august", 2, "2026-08", 5_000_000),
    makeRow("policy-october", 3, "2026-10", 6_000_000),
  ] });

  const july = await loadFinancialPolicyForPeriod(db, "2026-07");
  const september = await loadFinancialPolicyForPeriod(db, "2026-09");
  assert.equal(july.id, "policy-june");
  assert.equal(july.policy.managerMonthlySalaryVnd, 4_000_000);
  assert.equal(september.id, "policy-august");
  assert.equal(db.insertAttempts, 0);
});

test("bootstraps one immutable legacy snapshot with INSERT OR IGNORE and reuses it idempotently", async () => {
  const db = new FakeDb({
    rows: [{
      id: "future-policy",
      version: 5,
      effectiveFromPeriod: "2026-10",
      policyJson: serializeFinancialPolicy(normalizeFinancialPolicy(policyPayload())),
      createdBy: "admin",
      createdAt: "2026-08-01T00:00:00.000Z",
      supersededAt: null,
    }],
    payrollPolicy: payrollSnapshot(),
  });

  const first = await loadFinancialPolicyForPeriod(db, "2026-08", {
    now: "2026-08-24T02:00:00.000Z",
  });
  const second = await loadFinancialPolicyForPeriod(db, "2026-08", {
    now: "2026-08-24T03:00:00.000Z",
  });

  assert.equal(first.id, "financial-policy-legacy-2026-08-v9");
  assert.equal(first.version, 6);
  assert.equal(first.createdBy, "admin-policy");
  assert.equal(first.policy.managerMonthlySalaryVnd, 5_500_000);
  assert.equal(first.policy.managerKpiRateBasisPoints, 250);
  assert.deepEqual(first.policy.allowances, {});
  assert.deepEqual(first.policy.profitSharingMembers, []);
  assert.strictEqual(second.id, first.id);
  assert.equal(db.rows.filter((row) => row.effectiveFromPeriod === "2026-08").length, 1);
  assert.equal(db.insertAttempts, 1);
});

test("rejects invalid periods and malformed stored versions", async () => {
  const db = new FakeDb({ rows: [{
    id: "broken-policy",
    version: 1,
    effectiveFromPeriod: "2026-08",
    policyJson: "{}",
    createdBy: "admin",
    createdAt: "now",
    supersededAt: null,
  }] });
  await assert.rejects(() => loadFinancialPolicyForPeriod(db, "2026-8"), TypeError);
  await assert.rejects(
    () => loadFinancialPolicyForPeriod(db, "2026-08"),
    /Financial policy version is invalid/u,
  );
});
