import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createProfitDistributionDatabase, seedPolicy, seedPeriod } from "./helpers/profit-distribution-fixtures.mjs";
import { readSetupRepayments, saveSetupRepayment } from "../app/lib/profit-setup-repayments.ts";
import { closeProfitDistribution, readProfitDistributionAvailability } from "../app/lib/profit-distributions.ts";
import { profitSetupRepaymentStatements } from "../db/profit-setup-repayments.ts";

const period = "2026-08";
const save = (db, amount, expectedVersion = 0, storeId = "store-a") => saveSetupRepayment(db, {
  period, storeId, amount, expectedVersion, actorId: "admin-a",
});
const close = (db, extra = {}) => closeProfitDistribution(db, { period, actorId: "admin-a", reason: "Test close", ...extra });

async function fixture(t, stores = ["store-a"]) {
  const db = await createProfitDistributionDatabase(stores);
  t.after(() => db.close?.());
  await seedPolicy(db);
  await seedPeriod(db, "store-a", 5_000_000);
  return db;
}

test("save, edit and reset to zero persist independently while other stores are pending", async (t) => {
  const db = await fixture(t, ["store-a", "store-b"]);
  const original = await db.prepare("SELECT snapshot_json FROM financial_periods").first("snapshot_json");
  const first = await save(db, 2_000_000);
  assert.equal(first.version, 1);
  assert.deepEqual((await readSetupRepayments(db, period)).map((row) => ({ ...row })), [first]);
  let available = await readProfitDistributionAvailability(db, period);
  assert.equal(available.pendingStores.length, 1);
  assert.equal(available.preview.totalDistributableProfit, 3_000_000);
  assert.deepEqual(available.preview.members.map((row) => row.amount), [1_200_000, 1_800_000]);
  await assert.rejects(close(db), (error) => error.code === "MISSING_PERIOD");
  await save(db, 1_000_000, 1);
  await seedPeriod(db, "store-b", 2_000_000);
  await save(db, 500_000, 0, "store-b");
  available = await readProfitDistributionAvailability(db, period);
  assert.deepEqual(available.preview.stores.map((row) => row.distributableProfit), [4_000_000, 1_500_000]);
  assert.deepEqual(available.preview.members.map((row) => row.amount), [2_200_000, 3_300_000]);
  await save(db, 0, 2);
  assert.deepEqual((await readSetupRepayments(db, period)).map(({ amount, version }) => ({ amount, version })), [
    { amount: 0, version: 3 }, { amount: 500_000, version: 1 },
  ]);
  assert.deepEqual(await readSetupRepayments(db, "2026-07"), [], "another month never inherits setup");
  assert.equal(await db.prepare("SELECT snapshot_json FROM financial_periods WHERE store_id='store-a'").first("snapshot_json"), original);
  const audits = await db.prepare("SELECT before_json, after_json FROM audit_logs WHERE action='PROFIT_SETUP_REPAYMENT_SAVE'").all();
  assert.equal(audits.results.length, 4);
  assert.equal(JSON.parse(audits.results[0].after_json).amount, 2_000_000);
  assert.equal(JSON.parse(audits.results[0].before_json), null);
});

test("invalid amounts, versions, missing and open store periods cannot save", async (t) => {
  const db = await fixture(t, ["store-a", "store-b"]);
  for (const amount of [-1, 1.5, "2000000", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(save(db, amount), (error) => error.status === 400);
  }
  for (const version of [-1, null, "0", 0.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(save(db, 1, version), (error) => error.status === 400);
  }
  await assert.rejects(save(db, 1, 0, "missing"), (error) => error.status === 409);
  await assert.rejects(save(db, 1, 0, "store-b"), (error) => error.status === 409);
  await seedPeriod(db, "store-b", 2_000_000, { status: "CONFIRMED" });
  await assert.rejects(save(db, 1, 0, "store-b"), (error) => error.status === 409);
  assert.deepEqual(await readSetupRepayments(db, period), []);
});

test("concurrent saves accept exactly one revision and an audit failure rolls back the amount", async (t) => {
  const db = await fixture(t);
  const results = await Promise.allSettled([save(db, 2_000_000), save(db, 3_000_000)]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(results.find((row) => row.status === "rejected").reason.status, 409);
  const before = await readSetupRepayments(db, period);
  assert.equal(before[0].version, 1);
  assert.equal(await db.prepare("SELECT COUNT(*) FROM audit_logs").first("COUNT(*)"), 1);
  await db.prepare(`CREATE TRIGGER test_fail_setup_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'PROFIT_SETUP_REPAYMENT_SAVE' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`).run();
  await assert.rejects(save(db, 1, 1), /test audit failure/);
  assert.deepEqual(await readSetupRepayments(db, period), before);
});

test("global close uses saved values, rejects stale clients and freezes further edits", async (t) => {
  const db = await fixture(t);
  await save(db, 2_000_000);
  await assert.rejects(close(db, { expectedSetupVersions: [{ storeId: "store-a", version: 0 }] }), (error) => error.code === "STALE_SETUP_REPAYMENT");
  await assert.rejects(close(db, { setupRepayments: [] }), (error) => error.code === "STALE_SETUP_REPAYMENT");
  await assert.rejects(close(db, { expectedSetupVersions: null }), (error) => error.code === "INVALID_INPUT");
  const closed = await close(db, { expectedSetupVersions: [{ storeId: "store-a", version: 1 }] });
  assert.equal(closed.totalDistributableProfit, 3_000_000);
  assert.equal(closed.totalSetupRepayment, 2_000_000);
  assert.deepEqual(closed.members.map((row) => row.amount), [1_200_000, 1_800_000]);
  await assert.rejects(save(db, 0, 1), (error) => error.status === 409);
  await assert.rejects(db.prepare("UPDATE profit_setup_repayments SET amount=0, version=2").run(), /closed/);
  await assert.rejects(db.prepare("DELETE FROM profit_setup_repayments").run(), /cannot be deleted/);
  assert.equal((await readSetupRepayments(db, period))[0].amount, 2_000_000);
});

test("a save between preview and close transaction cancels the entire stale close", async (t) => {
  for (const initialAmount of [null, 1_000_000]) {
    await t.test(initialAmount === null ? "first save" : "existing amount changed", async (t) => {
      const db = await fixture(t);
      if (initialAmount !== null) await save(db, initialAmount);
      const interleaved = {
        prepare: db.prepare.bind(db),
        batch: async (statements) => {
          await save(db, 2_000_000, initialAmount === null ? 0 : 1);
          return db.batch(statements);
        },
      };
      await assert.rejects(close(interleaved), (error) => error.code === "STALE_SETUP_REPAYMENT");
      for (const table of ["profit_distributions", "profit_distribution_stores", "profit_distribution_members"]) {
        assert.equal(await db.prepare(`SELECT COUNT(*) FROM ${table}`).first("COUNT(*)"), 0);
      }
      assert.equal(await db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action='PROFIT_DISTRIBUTION_CLOSE'").first("COUNT(*)"), 0);
      assert.equal((await readSetupRepayments(db, period))[0].amount, 2_000_000);
      assert.equal((await close(db)).totalDistributableProfit, 3_000_000);
    });
  }
});

test("a close before the save transaction rejects the pending save", async (t) => {
  const db = await fixture(t);
  const interleaved = {
    prepare: db.prepare.bind(db),
    batch: async (statements) => {
      await close(db);
      return db.batch(statements);
    },
  };
  await assert.rejects(save(interleaved, 2_000_000), (error) => error.status === 409);
  assert.deepEqual(await readSetupRepayments(db, period), []);
  assert.equal(await db.prepare("SELECT total_distributable_profit FROM profit_distributions").first("total_distributable_profit"), 5_000_000);
});

test("migration is additive, repeatable and matches runtime without changing historical snapshots", async (t) => {
  const db = await fixture(t);
  await close(db, { setupRepayments: [{ storeId: "store-a", amount: 2_000_000 }] });
  const before = await db.prepare("SELECT * FROM profit_distribution_stores").all();
  const source = await readFile(new URL("../drizzle/0035_saved_profit_setup_repayments.sql", import.meta.url), "utf8");
  assert.equal(source, profitSetupRepaymentStatements.join(";\n--> statement-breakpoint\n") + ";\n");
  for (const statement of profitSetupRepaymentStatements) await db.prepare(statement).run();
  assert.deepEqual((await db.prepare("SELECT * FROM profit_distribution_stores").all()).results, before.results);
  await assert.rejects(save(db, 3_000_000), (error) => error.status === 409);
});
