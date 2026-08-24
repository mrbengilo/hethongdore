import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const migration27Url = new URL("../drizzle/0027_finance_engine_foundation.sql", import.meta.url);
const migration28Url = new URL("../drizzle/0028_cashflow_ledger_hardening.sql", import.meta.url);

function migrationStatements(source) {
  return source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean);
}

async function applyMigration(db, url) {
  const source = await readFile(url, "utf8");
  for (const statement of migrationStatements(source)) db.exec(statement);
}

function baseDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      revenue INTEGER NOT NULL DEFAULT 0,
      expense INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );
    INSERT INTO stores (id, name, address, created_at)
    VALUES ('store-1', 'Store one', 'Test', '2026-08-01T00:00:00.000Z'),
           ('store-2', 'Store two', 'Test', '2026-08-01T00:00:00.000Z');
  `);
  return db;
}

function insertCashflow(db, overrides = {}, conflict = "ABORT") {
  const row = {
    id: "cashflow-1",
    storeId: "store-1",
    direction: "OUT",
    amount: 500_000,
    category: "MARKETING",
    sourceType: "VARIABLE_EXPENSE",
    sourceId: "expense-1",
    occurredAt: "2026-08-20T10:00:00.000Z",
    createdBy: "actor-1",
    note: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    clientRequestId: "cashflow-request-0000001",
    payloadHash: "a".repeat(64),
    reversesEntryId: null,
    ...overrides,
  };
  return db.prepare(`INSERT OR ${conflict} INTO cashflow_entries
      (id, store_id, direction, amount, category, source_type, source_id,
       occurred_at, created_by, note, created_at, client_request_id, payload_hash, reverses_entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id, row.storeId, row.direction, row.amount, row.category,
      row.sourceType, row.sourceId, row.occurredAt, row.createdBy, row.note,
      row.createdAt, row.clientRequestId, row.payloadHash, row.reversesEntryId,
    );
}

function validLockedPeriod(db, storeId = "store-1", period = "2026-08") {
  db.prepare(`INSERT OR IGNORE INTO financial_policy_versions
      (id, version, effective_from_period, policy_json, created_by, created_at)
    VALUES ('policy-1', 1, '2026-01', '{}', 'actor-1', '2026-08-31T16:00:00.000Z')`).run();
  db.prepare(`INSERT INTO financial_periods
      (id, store_id, period, status, policy_version_id, config_version,
       snapshot_json, calculated_at, calculated_by, confirmed_at, confirmed_by,
       paid_at, paid_by, locked_at, locked_by, created_at, updated_at)
    VALUES (?, ?, ?, 'LOCKED', 'policy-1', 1, '{"schemaVersion":1}',
      ?, 'actor-1', ?, 'actor-1', ?, 'actor-1', ?, 'actor-1', ?, ?)`)
    .run(
      `locked-${storeId}-${period}`,
      storeId,
      period,
      "2026-08-31T16:00:00.000Z",
      "2026-08-31T16:01:00.000Z",
      "2026-08-31T16:02:00.000Z",
      "2026-08-31T16:03:00.000Z",
      "2026-08-31T16:00:00.000Z",
      "2026-08-31T16:03:00.000Z",
    );
}

test("0028 is journaled once and additively preserves legacy cashflow", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const migration28Positions = journal.entries
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => entry.tag === "0028_cashflow_ledger_hardening");
  const migration27Position = journal.entries.findIndex((entry) => entry.tag === "0027_finance_engine_foundation");
  const laterMigrationPositions = journal.entries
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => entry.idx > 28);

  assert.equal(migration28Positions.length, 1);
  assert.ok(migration27Position >= 0 && migration27Position < migration28Positions[0].position);
  assert.ok(laterMigrationPositions.length > 0);
  assert.ok(laterMigrationPositions.every(({ position }) => position > migration28Positions[0].position));

  const db = baseDatabase();
  await applyMigration(db, migration27Url);
  db.prepare(`INSERT INTO cashflow_entries
      (id, store_id, direction, amount, category, source_type, source_id,
       occurred_at, created_by, note, created_at)
    VALUES ('legacy-cash', 'store-1', 'OUT', 123000, 'LEGACY', 'LEGACY', 'legacy-1',
      'legacy timestamp', 'legacy-actor', NULL, '2026-08-01T00:00:00.000Z')`).run();
  await applyMigration(db, migration28Url);

  assert.deepEqual(
    { ...db.prepare("SELECT id, amount, client_request_id, payload_hash, reverses_entry_id FROM cashflow_entries WHERE id = 'legacy-cash'").get() },
    { id: "legacy-cash", amount: 123000, client_request_id: null, payload_hash: null, reverses_entry_id: null },
  );
  const columns = db.prepare("PRAGMA table_info(cashflow_entries)").all().map((row) => row.name);
  assert.deepEqual(columns.slice(-3), ["client_request_id", "payload_hash", "reverses_entry_id"]);
  db.close();
});

test("ledger requires canonical metadata, is append-only, and distinguishes replay from conflict", async () => {
  const db = baseDatabase();
  await applyMigration(db, migration27Url);
  await applyMigration(db, migration28Url);

  assert.throws(() => db.prepare(`INSERT INTO cashflow_entries
      (id, store_id, direction, amount, category, source_type, source_id, occurred_at, created_by, created_at)
    VALUES ('missing-meta', 'store-1', 'OUT', 1, 'TEST', 'TEST', 'missing-meta', ?, 'actor-1', ?)`)
    .run("2026-08-20T10:00:00.000Z", "2026-08-20T10:00:00.000Z"), /requires idempotency metadata/u);
  assert.throws(() => insertCashflow(db, { id: "bad-date", sourceId: "bad-date", occurredAt: "2026-08-20T10:00:00Z" }), /canonical ISO/u);

  assert.equal(insertCashflow(db).changes, 1);
  assert.equal(insertCashflow(db, { id: "cashflow-replay", clientRequestId: "cashflow-request-replay01" }, "IGNORE").changes, 0);
  assert.throws(
    () => insertCashflow(db, { id: "cashflow-conflict", amount: 600_000, payloadHash: "b".repeat(64), clientRequestId: "cashflow-request-change01" }),
    /cashflow idempotency conflict/u,
  );
  assert.throws(() => db.prepare("UPDATE cashflow_entries SET amount = amount + 1 WHERE id = 'cashflow-1'").run(), /append-only/u);
  assert.throws(() => db.prepare("DELETE FROM cashflow_entries WHERE id = 'cashflow-1'").run(), /append-only/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cashflow_entries").get().count, 1);
  db.close();
});

test("reversals are exact opposite append-only movements and only one reversal is allowed", async () => {
  const db = baseDatabase();
  await applyMigration(db, migration27Url);
  await applyMigration(db, migration28Url);
  insertCashflow(db);

  assert.throws(
    () => insertCashflow(db, {
      id: "bad-reversal",
      sourceType: "REVERSAL",
      sourceId: "cashflow-1",
      clientRequestId: "cashflow-bad-reversal-01",
      payloadHash: "b".repeat(64),
      reversesEntryId: "cashflow-1",
    }),
    /invalid cashflow reversal/u,
  );
  assert.equal(insertCashflow(db, {
    id: "reversal-1",
    direction: "IN",
    sourceType: "REVERSAL",
    sourceId: "cashflow-1",
    clientRequestId: "cashflow-good-reversal01",
    payloadHash: "c".repeat(64),
    reversesEntryId: "cashflow-1",
    occurredAt: "2026-08-20T11:00:00.000Z",
  }).changes, 1);
  assert.throws(() => insertCashflow(db, {
    id: "reversal-wrong-source",
    direction: "IN",
    sourceType: "REVERSAL",
    sourceId: "not-the-original-entry",
    clientRequestId: "cashflow-wrong-source-001",
    payloadHash: "e".repeat(64),
    reversesEntryId: "cashflow-1",
    occurredAt: "2026-08-20T11:30:00.000Z",
  }), /invalid cashflow reversal/u);
  assert.throws(() => insertCashflow(db, {
    id: "reversal-2",
    direction: "IN",
    sourceType: "REVERSAL",
    sourceId: "cashflow-1",
    clientRequestId: "cashflow-other-reversal1",
    payloadHash: "d".repeat(64),
    reversesEntryId: "cashflow-1",
    occurredAt: "2026-08-20T12:00:00.000Z",
  }), /cashflow idempotency conflict|UNIQUE constraint failed/u);
  db.close();
});

test("cashflow insert fails closed for the Vietnam-local canonical LOCKED period", async () => {
  const db = baseDatabase();
  await applyMigration(db, migration27Url);
  await applyMigration(db, migration28Url);
  validLockedPeriod(db);

  assert.throws(() => insertCashflow(db, {
    id: "august-boundary",
    sourceId: "august-boundary",
    clientRequestId: "cashflow-august-boundary1",
    occurredAt: "2026-08-31T16:59:59.000Z",
  }), /LOCKED financial period/u);
  assert.equal(insertCashflow(db, {
    id: "september-boundary",
    sourceId: "september-boundary",
    clientRequestId: "cashflow-september-bound1",
    occurredAt: "2026-08-31T17:00:00.000Z",
  }).changes, 1);
  db.close();
});

test("helpers support exact retry, gated batch writes, and atomic source/audit/ledger rollback", async () => {
  const [{ createSqliteDatabase }, ledger, runtime] = await Promise.all([
    import("../db/sqlite.ts"),
    import("../app/api/_lib/cashflow-ledger.ts"),
    import("../db/runtime.ts"),
  ]);
  const db = await createSqliteDatabase(":memory:");
  await db.exec(`
    CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL, revenue INTEGER NOT NULL DEFAULT 0, expense INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO stores VALUES ('store-1', 'Store one', 'Test', 0, 0, 'ACTIVE', '2026-08-01T00:00:00.000Z');
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, detail TEXT, created_at TEXT NOT NULL, before_json TEXT, after_json TEXT, reason TEXT, store_id TEXT);
    CREATE TABLE source_mutations (id TEXT PRIMARY KEY, mutation_token TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO source_mutations VALUES ('source-1', 'initial', '2026-08-20T10:00:00.000Z');
  `);
  for (const statement of migrationStatements(await readFile(migration27Url, "utf8"))) await db.exec(statement);
  for (const statement of migrationStatements(await readFile(migration28Url, "utf8"))) await db.exec(statement);

  const input = {
    storeId: "store-1",
    direction: "OUT",
    amount: 500_000,
    category: "MARKETING",
    sourceType: "VARIABLE_EXPENSE",
    sourceId: "source-1",
    occurredAt: "2026-08-20T10:00:00.000Z",
    createdBy: "actor-1",
    clientRequestId: "helper-request-000000001",
    createdAt: "2026-08-20T10:00:00.000Z",
  };
  assert.equal((await ledger.appendCashflowEntry(db, input)).created, true);
  assert.equal((await ledger.appendCashflowEntry(db, input)).created, false);
  await assert.rejects(ledger.appendCashflowEntry(db, { ...input, amount: 600_000 }), /different payload/u);

  const gated = await ledger.buildCashflowEntry({
    ...input,
    sourceId: "source-gated",
    clientRequestId: "helper-gated-request-0001",
  });
  await db.batch([
    ledger.prepareCashflowEntryInsertWhere(
      db,
      gated,
      "EXISTS (SELECT 1 FROM source_mutations WHERE id = ? AND mutation_token = ?)",
      ["source-1", "stale-token"],
    ),
  ]);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM cashflow_entries WHERE id = ?").bind(gated.id).first("count"), 0);
  await db.batch([
    db.prepare("UPDATE source_mutations SET mutation_token = ? WHERE id = ? AND mutation_token = ?")
      .bind("commit-token", "source-1", "initial"),
    ledger.prepareCashflowEntryInsertWhere(
      db,
      gated,
      "EXISTS (SELECT 1 FROM source_mutations WHERE id = ? AND mutation_token = ?)",
      ["source-1", "commit-token"],
    ),
  ]);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM cashflow_entries WHERE id = ?").bind(gated.id).first("count"), 1);

  const atomicAt = "2026-08-20T12:00:00.000Z";
  const rollbackEntry = await ledger.buildCashflowEntry({
    ...input,
    sourceId: "source-rollback",
    clientRequestId: "helper-rollback-request01",
    occurredAt: atomicAt,
    createdAt: atomicAt,
  });
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO source_mutations (id, mutation_token, created_at) VALUES (?, ?, ?)")
      .bind("source-rollback", "rollback-token", atomicAt),
    ledger.prepareCashflowEntryInsert(db, rollbackEntry),
    runtime.prepareStructuredAuditInsert(
      db,
      "actor-1",
      "CREATE",
      "VARIABLE_EXPENSE",
      "source-rollback",
      { storeId: "store-1", after: { amount: 500_000 } },
      { id: "audit-rollback", createdAt: atomicAt },
    ),
    db.prepare("INSERT INTO source_mutations (id, mutation_token, created_at) VALUES ('fail', NULL, NULL)"),
  ]), /constraint/u);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM source_mutations WHERE id = 'source-rollback'").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM cashflow_entries WHERE id = ?").bind(rollbackEntry.id).first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE id = 'audit-rollback'").first("count"), 0);
  db.close();
});

test("linked 500k cashflow does not double-count the originating 500k expense in profit", async () => {
  const [{ calculateFinance }, storeFinance, financeEngine] = await Promise.all([
    import("../app/lib/finance-engine.ts"),
    readFile(new URL("../app/api/_lib/store-finance.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/finance-engine.ts", import.meta.url), "utf8"),
  ]);
  const result = calculateFinance({
    grossRevenue: 1_000_000,
    fixedExpense: 0,
    variableExpense: 500_000,
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
  assert.equal(result.totalExpense, 500_000);
  assert.equal(result.finalProfit, 500_000);
  assert.doesNotMatch(storeFinance, /FROM\s+cashflow_entries|JOIN\s+cashflow_entries/iu);
  assert.doesNotMatch(financeEngine, /cashflow_entries/iu);
});
