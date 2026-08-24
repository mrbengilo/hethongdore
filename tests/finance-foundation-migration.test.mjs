import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL("../drizzle/0027_finance_engine_foundation.sql", import.meta.url);
const journalUrl = new URL("../drizzle/meta/_journal.json", import.meta.url);

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((column) => column.name);
}

function indexColumns(db, indexName) {
  return db.prepare(`PRAGMA index_info(${JSON.stringify(indexName)})`).all().map((column) => column.name);
}

function expectDbError(callback) {
  assert.throws(callback, /constraint|foreign key|immutable|locked|unique/i);
}

function createLegacyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE stores (id text PRIMARY KEY NOT NULL);
    INSERT INTO stores (id) VALUES ('store-1'), ('store-2'), ('store-3');
    CREATE TABLE audit_logs (
      id text PRIMARY KEY NOT NULL,
      user_id text,
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id text,
      detail text,
      created_at text NOT NULL
    );
    INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail, created_at)
    VALUES ('audit-existing', 'user-1', 'CREATE', 'ORDER', 'order-1', '{}', '2026-08-24T00:00:00.000Z');
  `);
  return db;
}

test("finance foundation migration is additive, journaled once, and leaves audit compatibility to runtime", async () => {
  const [migration, journalSource] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(journalUrl, "utf8"),
  ]);
  const journal = JSON.parse(journalSource);
  const entries = journal.entries.filter((entry) => entry.tag === "0027_finance_engine_foundation");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].idx, 27);
  assert.equal(entries[0].version, "6");
  assert.equal(entries[0].breakpoints, true);

  for (const table of [
    "financial_policy_versions",
    "financial_periods",
    "month_end_expenses",
    "cashflow_entries",
  ]) {
    assert.match(migration, new RegExp("CREATE TABLE IF NOT EXISTS `" + table + "`", "u"));
  }
  assert.doesNotMatch(migration, /^\s*(?:DROP\b|TRUNCATE\b|RENAME\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b)/imu);
  assert.doesNotMatch(migration, /ALTER TABLE `audit_logs`/u);
  assert.match(migration, /Audit-log compatibility columns are intentionally owned by db\/runtime\.ts/u);
  for (const statement of migrationStatements(migration).filter((statement) => /^CREATE (?:UNIQUE )?INDEX/iu.test(statement))) {
    assert.match(statement, /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/iu);
  }
  for (const statement of migrationStatements(migration).filter((statement) => /^CREATE TRIGGER/iu.test(statement))) {
    assert.match(statement, /^CREATE TRIGGER IF NOT EXISTS/iu);
  }
});

test("finance foundation migration enforces canonical formulas, lifecycle, immutability, and source identity", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const statements = migrationStatements(migration);
  const db = createLegacyDatabase();

  try {
    for (const statement of statements) db.exec(statement);

    assert.deepEqual(tableColumns(db, "financial_policy_versions"), [
      "id", "version", "effective_from_period", "policy_json", "created_by", "created_at", "superseded_at",
    ]);
    assert.deepEqual(tableColumns(db, "financial_periods"), [
      "id", "store_id", "period", "status", "policy_version_id", "config_version", "revision",
      "gross_revenue", "fixed_expense", "variable_expense", "inventory_cost", "inventory_shipping_cost",
      "employee_salary", "manager_salary", "manual_bonus", "allowance", "total_hours_seconds",
      "employee_kpi_total", "manager_kpi", "operating_profit", "profit_after_kpi", "month_end_expense",
      "final_profit", "distributable_profit", "salary_advance", "employee_payroll_rows_json",
      "manager_payroll_json", "config_snapshot_json", "snapshot_json", "calculated_at", "calculated_by",
      "confirmed_at", "confirmed_by", "paid_at", "paid_by", "locked_at", "locked_by", "created_at", "updated_at",
    ]);
    assert.deepEqual(tableColumns(db, "month_end_expenses"), [
      "id", "store_id", "period", "title", "category", "amount", "note", "status", "version",
      "client_request_id", "payload_hash", "created_by", "created_at", "updated_by", "updated_at",
      "voided_by", "voided_at",
    ]);
    assert.deepEqual(tableColumns(db, "cashflow_entries"), [
      "id", "store_id", "direction", "amount", "category", "source_type", "source_id",
      "occurred_at", "created_by", "note", "created_at",
    ]);
    assert.deepEqual(tableColumns(db, "audit_logs"), [
      "id", "user_id", "action", "entity_type", "entity_id", "detail", "created_at",
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count, 1);

    assert.deepEqual(indexColumns(db, "idx_financial_policy_versions_version"), ["version"]);
    assert.deepEqual(indexColumns(db, "idx_financial_policy_versions_effective"), ["effective_from_period", "version"]);
    assert.deepEqual(indexColumns(db, "idx_financial_periods_store_period"), ["store_id", "period"]);
    assert.deepEqual(indexColumns(db, "idx_financial_periods_status_period"), ["status", "period", "store_id"]);
    assert.deepEqual(indexColumns(db, "idx_month_end_expenses_actor_request"), ["store_id", "created_by", "client_request_id"]);
    assert.deepEqual(indexColumns(db, "idx_month_end_expenses_store_period_status"), ["store_id", "period", "status", "created_at"]);
    assert.deepEqual(indexColumns(db, "idx_cashflow_entries_source"), ["store_id", "source_type", "source_id"]);
    assert.deepEqual(indexColumns(db, "idx_cashflow_entries_store_occurred"), ["store_id", "occurred_at", "id"]);

    const insertPolicy = db.prepare(`
      INSERT INTO financial_policy_versions
        (id, version, effective_from_period, policy_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertPolicy.run("policy-1", 1, "2026-08", "{}", "SYSTEM", "2026-08-24T00:00:00.000Z");
    insertPolicy.run("policy-2", 2, "2026-09", "{}", "SYSTEM", "2026-08-24T00:00:00.000Z");
    expectDbError(() => insertPolicy.run("policy-invalid-period", 3, "ABCD-08", "{}", "SYSTEM", "now"));
    expectDbError(() => insertPolicy.run("policy-invalid-month", 3, "2026-13", "{}", "SYSTEM", "now"));
    expectDbError(() => insertPolicy.run("policy-invalid-json", 3, "2026-10", "[]", "SYSTEM", "now"));
    expectDbError(() => insertPolicy.run("policy-duplicate", 1, "2026-10", "{}", "SYSTEM", "now"));

    expectDbError(() => db.prepare("UPDATE financial_policy_versions SET policy_json = ? WHERE id = ?").run('{"changed":true}', "policy-1"));
    db.prepare("UPDATE financial_policy_versions SET superseded_at = ? WHERE id = ?")
      .run("2026-08-25T00:00:00.000Z", "policy-1");
    expectDbError(() => db.prepare("UPDATE financial_policy_versions SET superseded_at = ? WHERE id = ?")
      .run("2026-08-26T00:00:00.000Z", "policy-1"));
    expectDbError(() => db.prepare("DELETE FROM financial_policy_versions WHERE id = ?").run("policy-1"));

    db.prepare(`
      INSERT INTO financial_periods
        (id, store_id, period, status, fixed_expense, operating_profit, profit_after_kpi, final_profit,
         distributable_profit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("period-1", "store-1", "2026-08", "DRAFT", 1_000_000, -1_000_000, -1_000_000, -1_000_000, 0, "now", "now");

    expectDbError(() => db.prepare(`
      INSERT INTO financial_periods (id, store_id, period, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("period-invalid-format", "store-2", "ABCD-08", "DRAFT", "now", "now"));
    expectDbError(() => db.prepare(`
      INSERT INTO financial_periods (id, store_id, period, status, calculated_at, calculated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("period-draft-stray-metadata", "store-2", "2026-08", "DRAFT", "now", "SYSTEM", "now", "now"));
    expectDbError(() => db.prepare(`
      INSERT INTO financial_periods (id, store_id, period, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("period-calculated-missing-metadata", "store-2", "2026-08", "CALCULATED", "now", "now"));
    expectDbError(() => db.prepare(`
      INSERT INTO financial_periods
        (id, store_id, period, status, policy_version_id, config_version, calculated_at, calculated_by,
         confirmed_at, confirmed_by, snapshot_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("period-confirmed-bad-snapshot", "store-2", "2026-08", "CONFIRMED", "policy-2", 1,
      "2026-08-24T01:00:00.000Z", "SYSTEM", "2026-08-24T02:00:00.000Z", "SYSTEM", "{}", "now", "now"));
    expectDbError(() => db.prepare(`
      INSERT INTO financial_periods
        (id, store_id, period, status, gross_revenue, operating_profit, profit_after_kpi, final_profit,
         distributable_profit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("period-bad-formula", "store-3", "2026-08", "DRAFT", 1_000, 999, 999, 999, 999, "now", "now"));
    expectDbError(() => db.prepare(`
      INSERT INTO financial_periods (id, store_id, period, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("period-orphan-store", "missing-store", "2026-08", "DRAFT", "now", "now"));

    db.prepare(`
      INSERT INTO financial_periods
        (id, store_id, period, status, policy_version_id, config_version, snapshot_json,
         calculated_at, calculated_by, confirmed_at, confirmed_by, paid_at, paid_by, locked_at, locked_by,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("period-locked", "store-2", "2026-09", "LOCKED", "policy-2", 1, '{"schemaVersion":1}',
      "2026-09-30T20:00:00.000Z", "SYSTEM", "2026-09-30T21:00:00.000Z", "SYSTEM",
      "2026-09-30T22:00:00.000Z", "SYSTEM", "2026-09-30T23:00:00.000Z", "SYSTEM", "now", "now");
    expectDbError(() => db.prepare("UPDATE financial_periods SET updated_at = ? WHERE id = ?").run("later", "period-locked"));
    expectDbError(() => db.prepare("DELETE FROM financial_periods WHERE id = ?").run("period-locked"));

    const insertMonthEnd = db.prepare(`
      INSERT INTO month_end_expenses
        (id, store_id, period, title, category, amount, status, client_request_id, payload_hash,
         created_by, created_at, updated_at, voided_by, voided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMonthEnd.run("month-end-1", "store-1", "2026-08", "Hao hụt", "SHRINKAGE", 500_000,
      "ACTIVE", "request-1", "hash-1", "SYSTEM", "now", "now", null, null);
    expectDbError(() => insertMonthEnd.run("month-end-active-with-void", "store-1", "2026-08", "A", "OTHER", 1,
      "ACTIVE", "request-2", "hash-2", "SYSTEM", "now", "now", "SYSTEM", "now"));
    expectDbError(() => insertMonthEnd.run("month-end-void-missing-actor", "store-1", "2026-08", "A", "OTHER", 1,
      "VOID", "request-3", "hash-3", "SYSTEM", "now", "now", null, "now"));
    expectDbError(() => insertMonthEnd.run("month-end-locked", "store-2", "2026-09", "A", "OTHER", 1,
      "ACTIVE", "request-4", "hash-4", "SYSTEM", "now", "now", null, null));
    expectDbError(() => insertMonthEnd.run("month-end-orphan", "missing-store", "2026-08", "A", "OTHER", 1,
      "ACTIVE", "request-5", "hash-5", "SYSTEM", "now", "now", null, null));
    db.prepare("UPDATE month_end_expenses SET status = 'VOID', voided_by = 'SYSTEM', voided_at = 'now' WHERE id = 'month-end-1'").run();

    const insertCashflow = db.prepare(`
      INSERT INTO cashflow_entries
        (id, store_id, direction, amount, category, source_type, source_id, occurred_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCashflow.run("cashflow-1", "store-1", "OUT", 500_000, "MONTH_END_EXPENSE",
      "MONTH_END_EXPENSE", "month-end-1", "now", "SYSTEM", "now");
    expectDbError(() => insertCashflow.run("cashflow-opposite-direction", "store-1", "IN", 500_000,
      "MONTH_END_EXPENSE", "MONTH_END_EXPENSE", "month-end-1", "now", "SYSTEM", "now"));
    expectDbError(() => insertCashflow.run("cashflow-orphan", "missing-store", "OUT", 1,
      "OTHER", "OTHER", "source", "now", "SYSTEM", "now"));

    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    for (const statement of statements) db.exec(statement);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_policy_versions").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_periods").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM month_end_expenses").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cashflow_entries").get().count, 1);
  } finally {
    db.close();
  }
});
