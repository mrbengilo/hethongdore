import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL("../drizzle/0030_payroll_snapshot_hardening.sql", import.meta.url);
const runtimeUrl = new URL("../db/runtime.ts", import.meta.url);
const schemaUrl = new URL("../db/schema.ts", import.meta.url);
const resetUrl = new URL("../app/api/admin/reset-data/route.ts", import.meta.url);
const resetItemsUrl = new URL("../app/api/admin/reset-data/items/route.ts", import.meta.url);
const employeesUrl = new URL("../app/api/admin/employees/route.ts", import.meta.url);

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function createLegacyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE employee_transfers (
      id text PRIMARY KEY NOT NULL,
      support_allowance integer NOT NULL
    );
    CREATE TABLE financial_periods (
      store_id text NOT NULL,
      period text NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE shift_sessions (
      id text PRIMARY KEY NOT NULL,
      transfer_id text,
      store_id text NOT NULL,
      work_date text,
      started_at text NOT NULL,
      status text NOT NULL
    );
    INSERT INTO employee_transfers (id, support_allowance)
    VALUES ('transfer-1', 42000);
    INSERT INTO financial_periods (store_id, period, status)
    VALUES ('store-locked', '2026-08', 'LOCKED');
    INSERT INTO shift_sessions (id, transfer_id, store_id, work_date, started_at, status) VALUES
      ('active-open', 'transfer-1', 'store-open', '2026-08-10', '2026-08-10T01:00:00.000Z', 'ACTIVE'),
      ('completed-open', 'transfer-1', 'store-open', '2026-08-09', '2026-08-09T01:00:00.000Z', 'COMPLETED'),
      ('completed-locked', 'transfer-1', 'store-locked', '2026-08-08', '2026-08-08T01:00:00.000Z', 'COMPLETED'),
      ('without-transfer', NULL, 'store-open', '2026-08-07', '2026-08-07T01:00:00.000Z', 'COMPLETED');
  `);
  return db;
}

test("0030 snapshots support allowance once for every non-locked legacy shift", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const db = createLegacyDatabase();
  try {
    for (const statement of migrationStatements(migration)) db.exec(statement);

    assert.deepEqual(
      db.prepare("SELECT id, applied_support_allowance AS amount FROM shift_sessions ORDER BY id")
        .all().map((row) => ({ ...row })),
      [
        { id: "active-open", amount: 42000 },
        { id: "completed-locked", amount: null },
        { id: "completed-open", amount: 42000 },
        { id: "without-transfer", amount: 0 },
      ],
    );

    db.exec("UPDATE employee_transfers SET support_allowance = 99000 WHERE id = 'transfer-1'");
    assert.equal(
      db.prepare("SELECT applied_support_allowance FROM shift_sessions WHERE id = 'completed-open'").get()
        .applied_support_allowance,
      42000,
    );
    assert.throws(
      () => db.exec("UPDATE shift_sessions SET applied_support_allowance = -1 WHERE id = 'active-open'"),
      /invalid applied support allowance/u,
    );
    assert.throws(
      () => db.exec(`INSERT INTO shift_sessions
        (id, transfer_id, store_id, work_date, started_at, status, applied_support_allowance)
        VALUES ('invalid', NULL, 'store-open', '2026-08-11', '2026-08-11T01:00:00.000Z', 'ACTIVE', -1)`),
      /invalid applied support allowance/u,
    );
  } finally {
    db.close();
  }
});

test("runtime and schema mirror the non-locked snapshot and validation contract", async () => {
  const [runtime, schema] = await Promise.all([
    readFile(runtimeUrl, "utf8"),
    readFile(schemaUrl, "utf8"),
  ]);

  assert.match(runtime, /UPDATE shift_sessions SET applied_support_allowance = COALESCE/u);
  assert.match(runtime, /WHERE applied_support_allowance IS NULL\s+AND NOT EXISTS/u);
  assert.doesNotMatch(runtime, /WHERE status = 'ACTIVE' AND applied_support_allowance IS NULL/u);
  assert.match(runtime, /invalid applied support allowance/u);
  assert.match(schema, /appliedSupportAllowance: integer\("applied_support_allowance"\)/u);
  assert.match(schema, /appliedSupportAllowance\} IS NULL OR \$\{table\.appliedSupportAllowance\} >= 0/u);
});

test("admin archives and item concurrency state preserve support allowance snapshots", async () => {
  const [reset, resetItems, employees] = await Promise.all([
    readFile(resetUrl, "utf8"),
    readFile(resetItemsUrl, "utf8"),
    readFile(employeesUrl, "utf8"),
  ]);

  assert.match(reset, /'shiftAppliedSupportAllowance', s\.applied_support_allowance/u);
  assert.match(reset, /'appliedSupportAllowance', s\.applied_support_allowance/u);
  assert.match(resetItems, /'appliedSupportAllowance', s\.applied_support_allowance/u);
  assert.match(resetItems, /s\.applied_support_allowance AS appliedSupportAllowance/u);
  assert.match(resetItems, /appliedSupportAllowance: row\.appliedSupportAllowance/u);
  assert.match(resetItems, /AND s\.applied_support_allowance IS \?/u);
  assert.match(employees, /'appliedSupportAllowance', s\.applied_support_allowance/u);
});
