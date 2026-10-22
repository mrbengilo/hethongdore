import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const foundationUrl = new URL("../drizzle/0027_finance_engine_foundation.sql", import.meta.url);
const guardsUrl = new URL("../drizzle/0031_financial_period_lifecycle_guards.sql", import.meta.url);
const journalUrl = new URL("../drizzle/meta/_journal.json", import.meta.url);
const runtimeUrl = new URL("../db/runtime.ts", import.meta.url);

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function expectGuard(callback, pattern = /financial period|finalized/i) {
  assert.throws(callback, pattern);
}

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE stores (id text PRIMARY KEY NOT NULL);
    CREATE TABLE audit_logs (
      id text PRIMARY KEY NOT NULL,
      user_id text,
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id text,
      detail text,
      created_at text NOT NULL
    );
    INSERT INTO stores (id) VALUES ('store-closed'), ('store-open'), ('store-other');
  `);
  return db;
}

function installSourceTables(db) {
  db.exec(`
    CREATE TABLE shift_sessions (
      id text PRIMARY KEY NOT NULL,
      store_id text NOT NULL,
      work_date text,
      started_at text NOT NULL,
      note text
    );
    CREATE TABLE daily_shift_definitions (
      id text PRIMARY KEY NOT NULL,
      store_id text NOT NULL,
      work_date text NOT NULL,
      name text NOT NULL
    );
    CREATE TABLE orders (
      id text PRIMARY KEY NOT NULL,
      store_id text NOT NULL,
      created_at text NOT NULL,
      amount integer NOT NULL
    );
    CREATE TABLE business_records (
      id text PRIMARY KEY NOT NULL,
      category text NOT NULL,
      store_id text,
      title text NOT NULL,
      data_json text NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE'
    );
    CREATE TABLE salary_advances (
      id text PRIMARY KEY NOT NULL,
      store_id text NOT NULL,
      period text NOT NULL,
      note text NOT NULL
    );
  `);
}

function insertDraft(db, id, storeId, period) {
  db.prepare(`INSERT INTO financial_periods
      (id, store_id, period, status, revision, created_at, updated_at)
    VALUES (?, ?, ?, 'DRAFT', 0, ?, ?)`)
    .run(id, storeId, period, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
}

function calculate(db, id) {
  db.prepare(`UPDATE financial_periods SET
      status = 'CALCULATED', revision = revision + 1,
      policy_version_id = 'policy-1', config_version = 1,
      calculated_at = '2026-09-01T00:00:00.000Z', calculated_by = 'manager-1',
      updated_at = '2026-09-01T00:00:00.000Z'
    WHERE id = ?`).run(id);
}

function reconcile(db, id) {
  db.prepare(`UPDATE financial_periods SET
      status = 'RECONCILING', revision = revision + 1,
      updated_at = '2026-09-01T01:00:00.000Z'
    WHERE id = ?`).run(id);
}

function snapshot(status, settlement = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    status,
    marker: "immutable-calculation",
    paidAt: null,
    paidBy: null,
    lockedAt: null,
    lockedBy: null,
    ...settlement,
  });
}

function confirm(db, id) {
  db.prepare(`UPDATE financial_periods SET
      status = 'CONFIRMED', revision = revision + 1,
      confirmed_at = '2026-09-01T02:00:00.000Z', confirmed_by = 'manager-1',
      snapshot_json = ?, updated_at = '2026-09-01T02:00:00.000Z'
    WHERE id = ?`).run(snapshot("CONFIRMED"), id);
}

function insertSources(db, suffix, storeId, period) {
  const date = `${period}-15`;
  const utc = period === "2026-08"
    ? "2026-07-31T17:00:00.000Z"
    : `${period}-15T00:00:00.000Z`;
  db.prepare(`INSERT INTO month_end_expenses
      (id, store_id, period, title, category, amount, note, status, version,
       client_request_id, payload_hash, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'Hao hụt', 'SHRINKAGE', 1000, 'note', 'ACTIVE', 1,
      ?, ?, 'manager-1', ?, ?)`)
    .run(`month-${suffix}`, storeId, period, `request-${suffix}`, `hash-${suffix}`, utc, utc);
  db.prepare("INSERT INTO shift_sessions (id, store_id, work_date, started_at, note) VALUES (?, ?, ?, ?, 'note')")
    .run(`shift-${suffix}`, storeId, date, utc);
  db.prepare("INSERT INTO daily_shift_definitions (id, store_id, work_date, name) VALUES (?, ?, ?, 'Ca 1')")
    .run(`daily-${suffix}`, storeId, date);
  db.prepare("INSERT INTO orders (id, store_id, created_at, amount) VALUES (?, ?, ?, 1000)")
    .run(`order-${suffix}`, storeId, utc);
  db.prepare(`INSERT INTO business_records
      (id, category, store_id, title, data_json, status)
    VALUES (?, 'DONG_TIEN', ?, 'Chi phí', ?, 'ACTIVE')`)
    .run(`record-${suffix}`, storeId, JSON.stringify({ period, date, amount: 1000 }));
  db.prepare("INSERT INTO salary_advances (id, store_id, period, note) VALUES (?, ?, ?, 'note')")
    .run(`advance-${suffix}`, storeId, period);
}

test("0031 is additive, journaled, and mirrors the finalized lifecycle guards in runtime", async () => {
  const [migration, journalSource, runtime] = await Promise.all([
    readFile(guardsUrl, "utf8"),
    readFile(journalUrl, "utf8"),
    readFile(runtimeUrl, "utf8"),
  ]);
  const entries = JSON.parse(journalSource).entries.filter(
    (entry) => entry.tag === "0031_financial_period_lifecycle_guards",
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].idx, 31);
  assert.equal(entries[0].version, "6");
  assert.equal(entries[0].breakpoints, true);
  assert.doesNotMatch(
    migration,
    /^\s*(?:DROP\b|TRUNCATE\b|ALTER\s+TABLE\b|RENAME\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b|INSERT\s+INTO\b)/imu,
  );
  assert.doesNotMatch(migration, /cashflow_entries/u);
  assert.match(migration, /BEFORE INSERT ON `financial_periods`[\s\S]*NEW\.`status` != 'DRAFT'/u);
  assert.match(migration, /OLD\.`status` = 'CONFIRMED' AND NEW\.`status` = 'PAID'/u);
  assert.match(migration, /OLD\.`status` = 'PAID' AND NEW\.`status` = 'LOCKED'/u);
  assert.match(migration, /json_remove\([\s\S]*'\$\.paidAt'[\s\S]*'\$\.lockedBy'/u);
  assert.doesNotMatch(migration, /'KPI_SUMMARY'|'PAYROLL_CLOSING'/u);

  for (const prefix of [
    "month_end_expenses",
    "shift_sessions",
    "daily_shift_definitions",
    "orders",
    "business_records",
    "salary_advances",
  ]) {
    for (const operation of ["insert", "update", "delete"]) {
      const name = `trg_${prefix}_finalized_${operation}`;
      assert.match(migration, new RegExp(name, "u"));
    }
    assert.match(runtime, new RegExp(`triggerPrefix: "trg_${prefix}"`, "u"));
  }
  assert.match(runtime, /\$\{input\.triggerPrefix\}_finalized_insert/u);
  assert.match(runtime, /\$\{input\.triggerPrefix\}_finalized_update/u);
  assert.match(runtime, /\$\{input\.triggerPrefix\}_finalized_delete/u);
  assert.match(runtime, /financialPeriodLifecycleGuardStatements/u);
  assert.match(runtime, /db\.batch\(financialPeriodLifecycleGuardStatements\.map/u);
  assert.match(runtime, /trg_cashflow_entries_locked_insert[\s\S]*locked_period\.status = 'LOCKED'/u);
  assert.match(runtime, /trg_cashflow_entries_append_only_update/u);
  assert.match(runtime, /trg_cashflow_entries_append_only_delete/u);
  assert.equal(
    [...runtime.matchAll(/AND locked_period\.status IN \('CONFIRMED', 'PAID', 'LOCKED'\)/gu)].length,
    4,
    "all four compatibility backfills skip finalized periods",
  );
});

test("0031 enforces canonical adjacent transitions and freezes the confirmed snapshot payload", async () => {
  const [foundation, guards] = await Promise.all([
    readFile(foundationUrl, "utf8"),
    readFile(guardsUrl, "utf8"),
  ]);
  const db = createDatabase();
  try {
    for (const statement of migrationStatements(foundation)) db.exec(statement);
    installSourceTables(db);
    for (const statement of migrationStatements(guards)) db.exec(statement);
    db.prepare(`INSERT INTO financial_policy_versions
        (id, version, effective_from_period, policy_json, created_by, created_at)
      VALUES ('policy-1', 1, '2026-01', '{}', 'SYSTEM', '2026-01-01T00:00:00.000Z')`).run();

    expectGuard(
      () => db.prepare(`INSERT INTO financial_periods
          (id, store_id, period, status, revision, created_at, updated_at)
        VALUES ('invalid-initial', 'store-other', '2026-10', 'CALCULATED', 0, 'now', 'now')`).run(),
      /must start as DRAFT revision 0/u,
    );

    insertDraft(db, "period-illegal", "store-other", "2026-10");
    expectGuard(
      () => db.prepare(`UPDATE financial_periods SET
          status = 'RECONCILING', revision = revision + 1,
          calculated_at = '2026-11-01T00:00:00.000Z', calculated_by = 'manager-1'
        WHERE id = 'period-illegal'`).run(),
      /invalid financial period lifecycle transition/u,
    );
    expectGuard(
      () => db.prepare(`UPDATE financial_periods SET
          status = 'CALCULATED', revision = revision + 2,
          calculated_at = '2026-11-01T00:00:00.000Z', calculated_by = 'manager-1'
        WHERE id = 'period-illegal'`).run(),
      /invalid financial period lifecycle transition/u,
    );

    insertDraft(db, "period-closed", "store-closed", "2026-08");
    calculate(db, "period-closed");
    reconcile(db, "period-closed");
    confirm(db, "period-closed");
    assert.equal(
      db.prepare("SELECT status, revision FROM financial_periods WHERE id = 'period-closed'").get().status,
      "CONFIRMED",
    );

    expectGuard(
      () => db.prepare(`UPDATE financial_periods SET
          gross_revenue = 1, operating_profit = 1, profit_after_kpi = 1,
          final_profit = 1, distributable_profit = 1
        WHERE id = 'period-closed'`).run(),
      /CONFIRMED financial snapshot is immutable/u,
    );
    expectGuard(
      () => db.prepare("UPDATE financial_periods SET snapshot_json = ? WHERE id = 'period-closed'")
        .run(snapshot("CONFIRMED", { marker: "changed" })),
      /CONFIRMED financial snapshot is immutable/u,
    );
    expectGuard(
      () => db.prepare("UPDATE financial_periods SET revision = revision + 1 WHERE id = 'period-closed'").run(),
      /CONFIRMED financial snapshot is immutable/u,
    );
    expectGuard(
      () => db.prepare("DELETE FROM financial_periods WHERE id = 'period-closed'").run(),
      /finalized financial period cannot be deleted/u,
    );
    assert.doesNotThrow(() => db.prepare(
      "UPDATE financial_periods SET updated_at = '2026-09-01T02:30:00.000Z' WHERE id = 'period-closed'",
    ).run());

    const paidAt = "2026-09-02T00:00:00.000Z";
    db.prepare(`UPDATE financial_periods SET
        status = 'PAID', revision = revision + 1, paid_at = ?, paid_by = 'manager-2',
        snapshot_json = ?, updated_at = ?
      WHERE id = 'period-closed'`)
      .run(paidAt, snapshot("PAID", { paidAt, paidBy: "manager-2" }), paidAt);
    expectGuard(
      () => db.prepare(`UPDATE financial_periods SET paid_by = 'other',
          snapshot_json = ? WHERE id = 'period-closed'`)
        .run(snapshot("PAID", { paidAt, paidBy: "other" })),
      /CONFIRMED financial snapshot is immutable/u,
    );
    const lockedAt = "2026-09-03T00:00:00.000Z";
    db.prepare(`UPDATE financial_periods SET
        status = 'LOCKED', revision = revision + 1, locked_at = ?, locked_by = 'super-admin',
        snapshot_json = ?, updated_at = ?
      WHERE id = 'period-closed'`)
      .run(
        lockedAt,
        snapshot("LOCKED", { paidAt, paidBy: "manager-2", lockedAt, lockedBy: "super-admin" }),
        lockedAt,
      );
    assert.equal(
      db.prepare("SELECT status, revision FROM financial_periods WHERE id = 'period-closed'").get().status,
      "LOCKED",
    );
  } finally {
    db.close();
  }
});

test("0031 freezes every financial source at CONFIRMED and checks OLD plus NEW attribution", async () => {
  const [foundation, guards] = await Promise.all([
    readFile(foundationUrl, "utf8"),
    readFile(guardsUrl, "utf8"),
  ]);
  const db = createDatabase();
  try {
    for (const statement of migrationStatements(foundation)) db.exec(statement);
    installSourceTables(db);
    for (const statement of migrationStatements(guards)) db.exec(statement);
    db.prepare(`INSERT INTO financial_policy_versions
        (id, version, effective_from_period, policy_json, created_by, created_at)
      VALUES ('policy-1', 1, '2026-01', '{}', 'SYSTEM', '2026-01-01T00:00:00.000Z')`).run();

    insertDraft(db, "period-closed", "store-closed", "2026-08");
    insertDraft(db, "period-open", "store-open", "2026-09");
    calculate(db, "period-open");
    reconcile(db, "period-open");
    insertSources(db, "closed", "store-closed", "2026-08");
    calculate(db, "period-closed");
    reconcile(db, "period-closed");
    confirm(db, "period-closed");

    const closedMutations = [
      ["month-end", () => db.prepare("UPDATE month_end_expenses SET note = 'changed' WHERE id = 'month-closed'").run(),
        () => db.prepare("DELETE FROM month_end_expenses WHERE id = 'month-closed'").run()],
      ["shift", () => db.prepare("UPDATE shift_sessions SET note = 'changed' WHERE id = 'shift-closed'").run(),
        () => db.prepare("DELETE FROM shift_sessions WHERE id = 'shift-closed'").run()],
      ["daily shift", () => db.prepare("UPDATE daily_shift_definitions SET name = 'changed' WHERE id = 'daily-closed'").run(),
        () => db.prepare("DELETE FROM daily_shift_definitions WHERE id = 'daily-closed'").run()],
      ["order", () => db.prepare("UPDATE orders SET amount = 2000 WHERE id = 'order-closed'").run(),
        () => db.prepare("DELETE FROM orders WHERE id = 'order-closed'").run()],
      ["business record", () => db.prepare("UPDATE business_records SET title = 'changed' WHERE id = 'record-closed'").run(),
        () => db.prepare("DELETE FROM business_records WHERE id = 'record-closed'").run()],
      ["salary advance", () => db.prepare("UPDATE salary_advances SET note = 'changed' WHERE id = 'advance-closed'").run(),
        () => db.prepare("DELETE FROM salary_advances WHERE id = 'advance-closed'").run()],
    ];
    for (const [label, update, remove] of closedMutations) {
      expectGuard(update, /finalized financial period/u);
      expectGuard(remove, /finalized financial period/u);
      assert.ok(label);
    }

    expectGuard(
      () => db.prepare(`INSERT INTO orders (id, store_id, created_at, amount)
        VALUES ('order-new-closed', 'store-closed', '2026-08-15T00:00:00.000Z', 1)`).run(),
      /finalized financial period/u,
    );
    expectGuard(
      () => db.prepare(`INSERT INTO shift_sessions (id, store_id, work_date, started_at, note)
        VALUES ('shift-new-closed', 'store-closed', '2026-08-20', '2026-08-20T00:00:00.000Z', 'x')`).run(),
      /finalized financial period/u,
    );

    insertSources(db, "open", "store-open", "2026-09");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'order-open'").get().count, 1);
    expectGuard(
      () => db.prepare("UPDATE shift_sessions SET store_id = 'store-open', work_date = '2026-09-15' WHERE id = 'shift-closed'").run(),
      /finalized financial period/u,
    );
    expectGuard(
      () => db.prepare("UPDATE shift_sessions SET store_id = 'store-closed', work_date = '2026-08-15' WHERE id = 'shift-open'").run(),
      /finalized financial period/u,
    );
    expectGuard(
      () => db.prepare("UPDATE orders SET store_id = 'store-closed', created_at = '2026-08-15T00:00:00.000Z' WHERE id = 'order-open'").run(),
      /finalized financial period/u,
    );

    assert.doesNotThrow(() => db.prepare(`INSERT INTO business_records
        (id, category, store_id, title, data_json, status)
      VALUES ('payroll-projection', 'PAYROLL_CLOSING', 'store-closed', 'projection',
        '{"period":"2026-08"}', 'MANAGER_FINALIZED')`).run());
    assert.doesNotThrow(() => db.prepare(`INSERT INTO business_records
        (id, category, store_id, title, data_json, status)
      VALUES ('kpi-projection', 'KPI_SUMMARY', 'store-closed', 'projection',
        '{"period":"2026-08"}', 'LOCKED')`).run());
  } finally {
    db.close();
  }
});
