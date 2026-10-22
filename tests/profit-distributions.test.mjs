import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { policy, seedPolicy, seedPeriod, createProfitDistributionDatabase as database } from "./helpers/profit-distribution-fixtures.mjs";

const distributions = await import("../app/lib/profit-distributions.ts");

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}


test("partial preview calculates setup only for locked stores and keeps an open store pending", async () => {
  const db = await database(["store-a", "store-b"]);
  try {
    await seedPolicy(db);
    await seedPeriod(db, "store-a", 5_000_000);
    await seedPeriod(db, "store-b", 8_000_000, { status: "CONFIRMED" });
    const setupRepayments = [{ storeId: "store-a", amount: 2_000_000 }];
    const result = await distributions.readProfitDistributionAvailability(db, "2026-08", setupRepayments);
    assert.equal(result.expectedStoreCount, 2);
    assert.deepEqual(result.pendingStores, [{ storeId: "store-b", storeName: "DORE STORE-B", status: "CONFIRMED" }]);
    assert.equal(result.preview.totalFinalProfit, 5_000_000);
    assert.equal(result.preview.totalDistributableProfit, 3_000_000);
    assert.deepEqual(result.preview.members.map((member) => member.amount), [1_200_000, 1_800_000]);
    await assert.rejects(distributions.closeProfitDistribution(db, {
      period: "2026-08", actorId: "admin-a", reason: "Partial must not close", setupRepayments,
    }), (error) => error.code === "PERIOD_NOT_LOCKED");
    await assert.rejects(distributions.readProfitDistributionAvailability(db, "2026-08", [
      { storeId: "store-b", amount: 2_000_000 },
    ]), (error) => error.code === "INVALID_INPUT");
  } finally { db.close?.(); }
});

test("setup repayment deducts after final payroll profit and freezes the requested 40/60 example", async () => {
  const db = await database(["store-a"]);
  try {
    await seedPolicy(db);
    await seedPeriod(db, "store-a", 5_000_000);
    const original = await db.prepare("SELECT snapshot_json FROM financial_periods").first("snapshot_json");
    const setupRepayments = [{ storeId: "store-a", amount: 2_000_000 }];
    const preview = await distributions.previewProfitDistribution(db, "2026-08", setupRepayments);
    assert.equal(preview.totalFinalProfit, 5_000_000);
    assert.equal(preview.totalSetupRepayment, 2_000_000);
    assert.equal(preview.totalDistributableProfit, 3_000_000);
    assert.deepEqual(preview.members.map((member) => member.amount), [1_200_000, 1_800_000]);
    const closed = await distributions.closeProfitDistribution(db, {
      period: "2026-08", actorId: "admin-a", reason: "Hoàn trả setup cửa hàng A", setupRepayments,
    });
    assert.equal(closed.allocationMethod, "PER_STORE");
    assert.equal(closed.stores[0].setupRepayment, 2_000_000);
    assert.equal(closed.stores[0].profitAfterSetup, 3_000_000);
    assert.deepEqual(closed.members, preview.members);
    assert.deepEqual(await distributions.readProfitDistribution(db, "2026-08"), closed);
    assert.equal(await db.prepare("SELECT snapshot_json FROM financial_periods").first("snapshot_json"), original);
    const audit = JSON.parse(await db.prepare("SELECT after_json FROM audit_logs WHERE action = 'PROFIT_DISTRIBUTION_CLOSE'").first("after_json"));
    assert.equal(audit.stores[0].setupRepayment, 2_000_000);
    assert.equal(audit.totalSetupRepayment, 2_000_000);
    await assert.rejects(db.prepare("UPDATE profit_distribution_stores SET setup_repayment = 0").run(), /immutable/i);
    await assert.rejects(distributions.closeProfitDistribution(db, {
      period: "2026-08", actorId: "admin-a", reason: "Thử sửa kỳ đã khóa", setupRepayments: [],
    }), (error) => error.code === "ALREADY_CLOSED");
  } finally { db.close?.(); }
});

test("each store rounds its own shares before member totals are added; losses never offset other stores", async () => {
  const db = await database();
  try {
    await seedPolicy(db);
    for (const [id, profit] of [["store-a", 5_000_001], ["store-b", 1], ["store-c", -50], ["store-d", 10]]) {
      await seedPeriod(db, id, profit);
    }
    const setupRepayments = [{ storeId: "store-a", amount: 2_000_000 }, { storeId: "store-d", amount: 20 }];
    const closed = await distributions.closeProfitDistribution(db, {
      period: "2026-08", actorId: "admin-a", reason: "Chia riêng từng cửa hàng", setupRepayments,
    });
    assert.deepEqual(closed.stores.map((store) => store.distributableProfit), [3_000_001, 1, 0, 0]);
    assert.equal(closed.stores[3].profitAfterSetup, -10);
    assert.equal(closed.totalDistributableProfit, 3_000_002);
    assert.deepEqual(closed.members.map((member) => member.amount), [1_200_000, 1_800_002]);
    assert.notDeepEqual(closed.members.map((member) => member.amount), [1_200_001, 1_800_001], "do not allocate from the aggregate before rounding");
    for (const member of closed.members) {
      const fromStores = closed.stores.reduce((sum, store) => sum + distributions.allocateProfitSharingMembers(store.distributableProfit, closed.members)
        .find((allocation) => allocation.memberId === member.memberId).amount, 0);
      assert.equal(member.amount, fromStores);
    }
  } finally { db.close?.(); }
});

test("invalid setup inputs fail before any distribution or audit is written", async () => {
  const db = await database(["store-a"]);
  try {
    await seedPolicy(db);
    await seedPeriod(db, "store-a", 5_000_000);
    for (const setupRepayments of [
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2000000", null].map((amount) => [{ storeId: "store-a", amount }]),
      [{ storeId: "missing", amount: 0 }],
      [{ storeId: "store-a", amount: 0 }, { storeId: "store-a", amount: 10 }],
      [null], {}, null,
    ]) {
      await assert.rejects(distributions.closeProfitDistribution(db, {
        period: "2026-08", actorId: "admin-a", reason: "Invalid setup", setupRepayments,
      }), (error) => error.code === "INVALID_INPUT");
    }
    assert.equal(await db.prepare("SELECT COUNT(*) FROM profit_distributions").first("COUNT(*)"), 0);
    assert.equal(await db.prepare("SELECT COUNT(*) FROM audit_logs").first("COUNT(*)"), 0);
  } finally { db.close?.(); }
});

test("additive upgrade preserves legacy aggregate rounding and immutable source rows", async () => {
  const db = await database(["store-a", "store-b"], false);
  try {
    await seedPolicy(db);
    await seedPeriod(db, "store-a", 1);
    await seedPeriod(db, "store-b", 1);
    await db.prepare(`INSERT INTO profit_distributions
      (id, period, policy_version_id, config_version, policy_snapshot_json, total_final_profit,
       total_distributable_profit, store_count, member_count, closed_by, closed_at, reason, created_at)
      VALUES ('legacy', '2026-08', 'policy-v3', 3, ?, 2, 2, 2, 2, 'admin-a',
        '2026-09-01T00:00:00.000Z', 'Original aggregate distribution', '2026-09-01T00:00:00.000Z')`)
      .bind(JSON.stringify(policy)).run();
    for (const [ordinal, storeId] of ["store-a", "store-b"].entries()) {
      await db.prepare(`INSERT INTO profit_distribution_stores
        (id, distribution_id, store_id, store_name_snapshot, financial_period_id, financial_period_revision,
         policy_version_id, config_version, final_profit, distributable_profit, financial_snapshot_json, ordinal)
        SELECT ?, 'legacy', store_id, ?, id, revision, policy_version_id, config_version,
          final_profit, distributable_profit, snapshot_json, ? FROM financial_periods WHERE store_id = ?`)
        .bind(`legacy-store-${ordinal}`, storeId, ordinal, storeId).run();
    }
    for (const [ordinal, member] of policy.profitSharingMembers.entries()) {
      await db.prepare(`INSERT INTO profit_distribution_members
        (id, distribution_id, member_id, member_name_snapshot, rate_basis_points, amount, member_snapshot_json, ordinal)
        VALUES (?, 'legacy', ?, ?, ?, 1, ?, ?)`)
        .bind(`legacy-member-${ordinal}`, member.memberId, member.name, member.rateBasisPoints, JSON.stringify(member), ordinal).run();
    }
    const priorMembers = await db.prepare("SELECT * FROM profit_distribution_members ORDER BY ordinal").all();
    const migration = await readFile(new URL("../drizzle/0033_profit_setup_repayment.sql", import.meta.url), "utf8");
    for (const statement of migrationStatements(migration)) await db.prepare(statement).run();
    const record = await distributions.readProfitDistribution(db, "2026-08");
    assert.equal(record.allocationMethod, "AGGREGATE");
    assert.equal(record.totalSetupRepayment, 0);
    assert.deepEqual(record.members.map((member) => member.amount), [1, 1]);
    assert.deepEqual((await db.prepare("SELECT * FROM profit_distribution_members ORDER BY ordinal").all()).results, priorMembers.results);
    await assert.rejects(db.prepare("UPDATE profit_distribution_stores SET setup_repayment = 1").run(), /immutable/i);
  } finally { db.close?.(); }
});

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
