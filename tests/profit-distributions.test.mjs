import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [{ createSqliteDatabase }, financeEngine, distributions] = await Promise.all([
  import("../db/sqlite.ts"),
  import("../app/lib/finance-engine.ts"),
  import("../app/lib/profit-distributions.ts"),
]);

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function database(storeIds = ["store-a", "store-b", "store-c", "store-d"]) {
  const db = await createSqliteDatabase(":memory:");
  await db.prepare(`CREATE TABLE stores (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT,
    store_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  )`).run();
  const [foundation, distributionMigration] = await Promise.all([
    readFile(new URL("../drizzle/0027_finance_engine_foundation.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0032_profit_distributions.sql", import.meta.url), "utf8"),
  ]);
  // Policy/period tables and indexes are the first seven statements. The
  // remaining foundation tables have their own focused migration tests.
  for (const statement of migrationStatements(foundation).slice(0, 7)) await db.prepare(statement).run();
  for (const statement of migrationStatements(distributionMigration)) await db.prepare(statement).run();
  const createdAt = "2026-08-01T00:00:00.000Z";
  for (const id of storeIds) {
    await db.prepare("INSERT INTO stores (id, name, status, created_at) VALUES (?, ?, 'ACTIVE', ?)")
      .bind(id, `DORE ${id.toUpperCase()}`, createdAt)
      .run();
  }
  return db;
}

const policy = {
  schemaVersion: 1,
  managerMonthlySalaryVnd: 3_000_000,
  managerKpiRateBasisPoints: 200,
  employeeKpiTiers: [],
  allowances: {},
  profitSharingMembers: [
    { memberId: "member-a", name: "Thành viên A", rateBasisPoints: 4_000 },
    { memberId: "member-b", name: "Thành viên B", rateBasisPoints: 6_000 },
  ],
};

async function seedPolicy(db, overrides = {}) {
  const selected = { ...policy, ...overrides };
  await db.prepare(`INSERT INTO financial_policy_versions
      (id, version, effective_from_period, policy_json, created_by, created_at)
    VALUES ('policy-v3', 3, '2026-08', ?, 'admin-a', '2026-08-01T00:00:00.000Z')`)
    .bind(JSON.stringify(selected))
    .run();
}

function financeForFinalProfit(finalProfit) {
  return financeEngine.calculateFinance({
    grossRevenue: Math.max(0, finalProfit),
    fixedExpense: Math.max(0, -finalProfit),
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
  });
}

async function seedPeriod(db, storeId, finalProfit, options = {}) {
  const status = options.status ?? "LOCKED";
  const finance = financeForFinalProfit(finalProfit);
  const snapshot = options.snapshot ?? {
    schemaVersion: 1,
    storeId,
    period: "2026-08",
    status,
    policyVersionId: "policy-v3",
    configVersion: 3,
    finance,
    totalHoursSeconds: 0,
    salaryAdvance: 0,
    employeePayrollRows: [],
    managerPayroll: {},
    configSnapshot: { policyVersionId: "policy-v3", configVersion: 3 },
    confirmedAt: "2026-09-01T00:00:00.000Z",
    confirmedBy: "manager-a",
    paidAt: status === "CONFIRMED" ? null : "2026-09-02T00:00:00.000Z",
    paidBy: status === "CONFIRMED" ? null : "manager-a",
    lockedAt: status === "LOCKED" ? "2026-09-03T00:00:00.000Z" : null,
    lockedBy: status === "LOCKED" ? "admin-a" : null,
  };
  const lifecycle = {
    calculatedAt: "2026-08-31T17:00:00.000Z",
    calculatedBy: "SYSTEM",
    confirmedAt: "2026-09-01T00:00:00.000Z",
    confirmedBy: "manager-a",
    paidAt: status === "CONFIRMED" ? null : "2026-09-02T00:00:00.000Z",
    paidBy: status === "CONFIRMED" ? null : "manager-a",
    lockedAt: status === "LOCKED" ? "2026-09-03T00:00:00.000Z" : null,
    lockedBy: status === "LOCKED" ? "admin-a" : null,
  };
  await db.prepare(`INSERT INTO financial_periods
      (id, store_id, period, status, policy_version_id, config_version, revision,
       gross_revenue, fixed_expense, variable_expense, inventory_cost,
       inventory_shipping_cost, employee_salary, manager_salary, manual_bonus,
       allowance, total_hours_seconds, employee_kpi_total, manager_kpi,
       operating_profit, profit_after_kpi, month_end_expense, final_profit,
       distributable_profit, salary_advance, employee_payroll_rows_json,
       manager_payroll_json, config_snapshot_json, snapshot_json,
       calculated_at, calculated_by, confirmed_at, confirmed_by, paid_at, paid_by,
       locked_at, locked_by, created_at, updated_at)
    VALUES (?, ?, '2026-08', ?, 'policy-v3', 3, 6,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, '[]', '{}', '{}', ?,
      ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-09-03T00:00:00.000Z')`)
    .bind(
      `period-${storeId}`,
      storeId,
      status,
      finance.grossRevenue,
      finance.fixedExpense,
      finance.variableExpense,
      finance.inventoryCost,
      finance.inventoryShippingCost,
      finance.employeeSalary,
      finance.managerSalary,
      finance.manualEmployeeBonus,
      finance.employeeAllowance,
      finance.employeeKpiTotal,
      finance.managerKpi,
      finance.operatingProfit,
      finance.profitAfterKpi,
      finance.monthEndExpense,
      finance.finalProfit,
      finance.distributableProfit,
      JSON.stringify(snapshot),
      lifecycle.calculatedAt,
      lifecycle.calculatedBy,
      lifecycle.confirmedAt,
      lifecycle.confirmedBy,
      lifecycle.paidAt,
      lifecycle.paidBy,
      lifecycle.lockedAt,
      lifecycle.lockedBy,
    )
    .run();
}

test("profit distribution migration is additive, journaled and immutable", async () => {
  const [migration, journalSource] = await Promise.all([
    readFile(new URL("../drizzle/0032_profit_distributions.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
  const journal = JSON.parse(journalSource);
  assert.equal(journal.entries.filter((entry) => entry.tag === "0032_profit_distributions").length, 1);
  for (const table of ["profit_distributions", "profit_distribution_stores", "profit_distribution_members"]) {
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`", "u"));
  }
  assert.doesNotMatch(migration, /^\s*(?:DROP\b|TRUNCATE\b|RENAME\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b)/imu);
});

test("preview and atomic close use per-store locked distributable profit without loss netting", async () => {
  const db = await database();
  try {
    await seedPolicy(db);
    for (const [storeId, profit] of [["store-a", 12_000_000], ["store-b", -2_000_000], ["store-c", 6_000_000], ["store-d", 4_000_000]]) {
      await seedPeriod(db, storeId, profit);
    }
    const preview = await distributions.previewProfitDistribution(db, "2026-08");
    assert.equal(preview.totalFinalProfit, 20_000_000);
    assert.equal(preview.totalDistributableProfit, 22_000_000);
    assert.deepEqual(preview.stores.map((store) => store.distributableProfit), [12_000_000, 0, 6_000_000, 4_000_000]);
    assert.deepEqual(preview.members.map((member) => member.amount), [8_800_000, 13_200_000]);

    const closed = await distributions.closeProfitDistribution(db, {
      period: "2026-08",
      actorId: "admin-a",
      reason: "Khóa chia lợi nhuận sau đối soát",
      now: "2026-09-05T00:00:00.000Z",
      id: "distribution-2026-08",
      auditId: "audit-distribution-2026-08",
    });
    assert.equal(closed.totalDistributableProfit, 22_000_000);
    assert.equal(closed.policyVersionId, "policy-v3");
    assert.equal(closed.stores[0].financialPeriodRevision, 6);
    assert.deepEqual(closed.members.map(({ memberId, rateBasisPoints, amount }) => ({ memberId, rateBasisPoints, amount })), [
      { memberId: "member-a", rateBasisPoints: 4_000, amount: 8_800_000 },
      { memberId: "member-b", rateBasisPoints: 6_000, amount: 13_200_000 },
    ]);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'PROFIT_DISTRIBUTION_CLOSE'").first("count"), 1);
    assert.deepEqual((await distributions.listProfitDistributions(db)).map((entry) => entry.period), ["2026-08"]);
    await assert.rejects(
      distributions.closeProfitDistribution(db, { period: "2026-08", actorId: "admin-a", reason: "duplicate" }),
      (error) => error instanceof distributions.ProfitDistributionError && error.code === "ALREADY_CLOSED",
    );

    await assert.rejects(db.prepare("UPDATE profit_distributions SET reason = 'changed' WHERE id = ?").bind(closed.id).run(), /immutable/i);
    await assert.rejects(db.prepare("DELETE FROM profit_distribution_members WHERE distribution_id = ?").bind(closed.id).run(), /immutable/i);
    await assert.rejects(db.prepare(`INSERT INTO profit_distribution_members
      (id, distribution_id, member_id, member_name_snapshot, rate_basis_points, amount, member_snapshot_json, ordinal)
      VALUES ('extra', ?, 'extra', 'Extra', 0, 0, '{}', 2)`).bind(closed.id).run(), /complete/i);
  } finally {
    db.close?.();
  }
});

test("close fails closed for missing, non-LOCKED or corrupt periods and rolls back audit conflicts", async (t) => {
  await t.test("missing store period", async () => {
    const db = await database(["store-a", "store-b"]);
    try {
      await seedPolicy(db);
      await seedPeriod(db, "store-a", 1_000_000);
      await assert.rejects(
        distributions.previewProfitDistribution(db, "2026-08"),
        (error) => error instanceof distributions.ProfitDistributionError && error.code === "MISSING_PERIOD",
      );
    } finally { db.close?.(); }
  });

  await t.test("non-LOCKED store period", async () => {
    const db = await database(["store-a"]);
    try {
      await seedPolicy(db);
      await seedPeriod(db, "store-a", 1_000_000, { status: "PAID" });
      await assert.rejects(
        distributions.previewProfitDistribution(db, "2026-08"),
        (error) => error instanceof distributions.ProfitDistributionError && error.code === "PERIOD_NOT_LOCKED",
      );
    } finally { db.close?.(); }
  });

  await t.test("corrupt locked snapshot", async () => {
    const db = await database(["store-a"]);
    try {
      await seedPolicy(db);
      await seedPeriod(db, "store-a", 1_000_000, {
        snapshot: {
          schemaVersion: 1,
          storeId: "store-a",
          period: "2026-08",
          status: "LOCKED",
          policyVersionId: "policy-v3",
        },
      });
      await assert.rejects(
        distributions.previewProfitDistribution(db, "2026-08"),
        (error) => error instanceof distributions.ProfitDistributionError && error.code === "CORRUPT_SNAPSHOT",
      );
    } finally { db.close?.(); }
  });

  await t.test("audit conflict rolls back every distribution row", async () => {
    const db = await database(["store-a"]);
    try {
      await seedPolicy(db);
      await seedPeriod(db, "store-a", 1_000_000);
      await db.prepare(`INSERT INTO audit_logs
          (id, action, entity_type, created_at)
        VALUES ('duplicate-audit', 'EXISTING', 'TEST', '2026-09-05T00:00:00.000Z')`).run();
      await assert.rejects(
        distributions.closeProfitDistribution(db, {
          period: "2026-08",
          actorId: "admin-a",
          reason: "Atomic failure test",
          now: "2026-09-05T00:00:00.000Z",
          id: "distribution-rollback",
          auditId: "duplicate-audit",
        }),
        (error) => error instanceof distributions.ProfitDistributionError && error.code === "ATOMIC_WRITE_FAILED",
      );
      assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM profit_distributions").first("count"), 0);
      assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM profit_distribution_stores").first("count"), 0);
      assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM profit_distribution_members").first("count"), 0);
    } finally { db.close?.(); }
  });
});
