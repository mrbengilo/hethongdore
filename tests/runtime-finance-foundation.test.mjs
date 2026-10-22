import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const managerPasswordHash = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

function names(result) {
  return result.results.map((column) => column.name);
}

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

test("supported migration-then-runtime path upgrades audit storage without dual-authority collisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dore-finance-runtime-"));
  const databasePath = join(directory, "dore.sqlite");
  const previousPlatform = process.env.DORE_DB_PLATFORM;
  const previousPath = process.env.DORE_DATABASE_PATH;
  const previousHash = process.env.DORE_MANAGER_PASSWORD_HASH;
  let db;

  try {
    const { createSqliteDatabase } = await import("../db/sqlite.ts");
    const legacy = await createSqliteDatabase(databasePath);
    await legacy.exec(`
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail, created_at)
      VALUES ('legacy-audit', 'actor-old', 'CREATE', 'ORDER', 'order-old', 'preserve me', '2026-08-23T00:00:00.000Z');
    `);
    const migration = await readFile(new URL("../drizzle/0027_finance_engine_foundation.sql", import.meta.url), "utf8");
    for (const statement of migrationStatements(migration)) await legacy.exec(statement);
    assert.deepEqual(names(await legacy.prepare("PRAGMA table_info(audit_logs)").all()), [
      "id", "user_id", "action", "entity_type", "entity_id", "detail", "created_at",
    ]);
    legacy.close();

    process.env.DORE_DB_PLATFORM = "sqlite";
    process.env.DORE_DATABASE_PATH = databasePath;
    process.env.DORE_MANAGER_PASSWORD_HASH = managerPasswordHash;

    const runtime = await import("../db/runtime.ts");
    db = await runtime.initDb();
    assert.equal(await runtime.initDb(), db, "runtime bootstrap remains idempotent in-process");

    for (const table of [
      "financial_policy_versions",
      "financial_periods",
      "month_end_expenses",
      "cashflow_entries",
    ]) {
      assert.equal(
        await db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
          .bind(table).first("count"),
        1,
      );
    }

    assert.deepEqual(names(await db.prepare("PRAGMA table_info(financial_policy_versions)").all()), [
      "id",
      "version",
      "effective_from_period",
      "policy_json",
      "created_by",
      "created_at",
      "superseded_at",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA table_info(financial_periods)").all()), [
      "id",
      "store_id",
      "period",
      "status",
      "policy_version_id",
      "config_version",
      "revision",
      "gross_revenue",
      "fixed_expense",
      "variable_expense",
      "inventory_cost",
      "inventory_shipping_cost",
      "employee_salary",
      "manager_salary",
      "manual_bonus",
      "allowance",
      "total_hours_seconds",
      "employee_kpi_total",
      "manager_kpi",
      "operating_profit",
      "profit_after_kpi",
      "month_end_expense",
      "final_profit",
      "distributable_profit",
      "salary_advance",
      "employee_payroll_rows_json",
      "manager_payroll_json",
      "config_snapshot_json",
      "snapshot_json",
      "calculated_at",
      "calculated_by",
      "confirmed_at",
      "confirmed_by",
      "paid_at",
      "paid_by",
      "locked_at",
      "locked_by",
      "created_at",
      "updated_at",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA table_info(month_end_expenses)").all()), [
      "id",
      "store_id",
      "period",
      "title",
      "category",
      "amount",
      "note",
      "status",
      "version",
      "client_request_id",
      "payload_hash",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at",
      "voided_by",
      "voided_at",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA table_info(cashflow_entries)").all()), [
      "id",
      "store_id",
      "direction",
      "amount",
      "category",
      "source_type",
      "source_id",
      "occurred_at",
      "created_by",
      "note",
      "created_at",
      "client_request_id",
      "payload_hash",
      "reverses_entry_id",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA table_info(audit_logs)").all()), [
      "id",
      "user_id",
      "action",
      "entity_type",
      "entity_id",
      "detail",
      "created_at",
      "before_json",
      "after_json",
      "reason",
      "store_id",
    ]);
    assert.deepEqual(
      { ...await db.prepare("SELECT id, detail, before_json, after_json, reason, store_id FROM audit_logs WHERE id = 'legacy-audit'").first() },
      {
        id: "legacy-audit",
        detail: "preserve me",
        before_json: null,
        after_json: null,
        reason: null,
        store_id: null,
      },
    );

    const indexRows = await db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_financial_policy_versions_version',
        'idx_financial_policy_versions_effective',
        'idx_financial_periods_store_period',
        'idx_financial_periods_status_period',
        'idx_financial_periods_store_status',
        'idx_month_end_expenses_actor_request',
        'idx_month_end_expenses_store_period_status',
        'idx_cashflow_entries_source',
        'idx_cashflow_entries_store_occurred',
        'idx_cashflow_entries_source_lookup',
        'idx_cashflow_entries_actor_request',
        'idx_cashflow_entries_reversal',
        'idx_audit_logs_entity_created',
        'idx_audit_logs_store_created'
      ) ORDER BY name`).all();
    assert.equal(indexRows.results.length, 14);
    assert.deepEqual(names(await db.prepare("PRAGMA index_info(idx_financial_policy_versions_effective)").all()), [
      "effective_from_period", "version",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA index_info(idx_financial_periods_status_period)").all()), [
      "status", "period", "store_id",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA index_info(idx_month_end_expenses_store_period_status)").all()), [
      "store_id", "period", "status", "created_at",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA index_info(idx_cashflow_entries_source)").all()), [
      "store_id", "source_type", "source_id",
    ]);
    assert.deepEqual(names(await db.prepare("PRAGMA index_info(idx_cashflow_entries_store_occurred)").all()), [
      "store_id", "occurred_at", "id",
    ]);

    const triggerRows = await db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'trg_financial_periods_locked_update',
        'trg_financial_periods_locked_delete',
        'trg_financial_policy_versions_immutable_update',
        'trg_financial_policy_versions_immutable_delete',
        'trg_month_end_expenses_locked_insert',
        'trg_month_end_expenses_locked_update',
        'trg_month_end_expenses_locked_delete',
        'trg_cashflow_entries_require_metadata',
        'trg_cashflow_entries_idempotency_conflict',
        'trg_cashflow_entries_reversal_validate',
        'trg_cashflow_entries_locked_insert',
        'trg_cashflow_entries_append_only_update',
        'trg_cashflow_entries_append_only_delete'
      ) ORDER BY name`).all();
    assert.equal(triggerRows.results.length, 13);

    await runtime.writeStructuredAudit("actor-1", "UPDATE", "MONTH_END_EXPENSE", "expense-1", {
      detail: "reconciled",
      storeId: "store-1",
      before: { amount: 400_000, status: "ACTIVE" },
      after: { amount: 500_000, status: "ACTIVE" },
      reason: "Đối soát hóa đơn",
    });
    const structured = await db.prepare(`SELECT user_id, action, entity_type, entity_id, detail,
        before_json, after_json, reason, store_id
      FROM audit_logs WHERE entity_id = 'expense-1'`).first();
    assert.deepEqual(
      { ...structured, before_json: JSON.parse(structured.before_json), after_json: JSON.parse(structured.after_json) },
      {
        user_id: "actor-1",
        action: "UPDATE",
        entity_type: "MONTH_END_EXPENSE",
        entity_id: "expense-1",
        detail: "reconciled",
        before_json: { amount: 400_000, status: "ACTIVE" },
        after_json: { amount: 500_000, status: "ACTIVE" },
        reason: "Đối soát hóa đơn",
        store_id: "store-1",
      },
    );

    await runtime.writeAudit("actor-2", "CREATE", "ORDER", "order-2", "legacy call shape");
    assert.deepEqual(
      { ...await db.prepare(`SELECT detail, before_json, after_json, reason, store_id
        FROM audit_logs WHERE entity_id = 'order-2'`).first() },
      {
        detail: "legacy call shape",
        before_json: null,
        after_json: null,
        reason: null,
        store_id: null,
      },
    );

    const ledger = await import("../app/api/_lib/cashflow-ledger.ts");
    const atomicAt = "2026-08-23T03:04:05.000Z";
    await db.prepare(`INSERT OR IGNORE INTO stores
      (id, name, address, revenue, expense, status, created_at)
      VALUES ('store-atomic', 'Atomic store', 'Test', 0, 0, 'ACTIVE', ?)`)
      .bind(atomicAt).run();
    const ledgerEntry = await ledger.buildCashflowEntry({
      storeId: "store-atomic",
      direction: "OUT",
      amount: 500_000,
      category: "MARKETING",
      sourceType: "VARIABLE_EXPENSE",
      sourceId: "expense-atomic",
      occurredAt: atomicAt,
      createdBy: "actor-atomic",
      clientRequestId: "atomic-source-audit-ledger-0001",
      createdAt: atomicAt,
    });
    await db.batch([
      db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
        VALUES (?, 'CHI_PHI_PHAT_SINH', ?, ?, 'Marketing', '{}', 'ACTIVE', ?, ?)`)
        .bind("expense-atomic", "store-atomic", "actor-atomic", atomicAt, atomicAt),
      ledger.prepareCashflowEntryInsert(db, ledgerEntry),
      runtime.prepareStructuredAuditInsert(
        db,
        "actor-atomic",
        "CREATE",
        "CHI_PHI_PHAT_SINH",
        "expense-atomic",
        { storeId: "store-atomic", after: { amount: 500_000 } },
        { id: "audit-atomic", createdAt: atomicAt },
      ),
    ]);
    assert.deepEqual(
      { ...await db.prepare(`SELECT r.created_at AS sourceAt, c.created_at AS cashflowAt, a.created_at AS auditAt
        FROM business_records r
        JOIN cashflow_entries c ON c.source_id = r.id
        JOIN audit_logs a ON a.entity_id = r.id
        WHERE r.id = 'expense-atomic'`).first() },
      { sourceAt: atomicAt, cashflowAt: atomicAt, auditAt: atomicAt },
    );

    const circular = {};
    circular.self = circular;
    await assert.rejects(
      runtime.writeStructuredAudit("actor-3", "UPDATE", "ORDER", "order-3", { before: circular }),
      /JSON-serializable/u,
    );
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'order-3'").first("count"), 0);

    await assert.rejects(
      db.prepare(`INSERT INTO financial_periods
        (id, store_id, period, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("invalid-status", "store-1", "2026-08", "FINAL", "now", "now").run(),
      /financial period must start as DRAFT revision 0/u,
    );
    await assert.rejects(
      db.prepare(`INSERT INTO financial_periods
        (id, store_id, period, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("invalid-numeric-period", "store-1", "ABCD-08", "DRAFT", "now", "now").run(),
      /constraint/u,
    );
  } finally {
    if (db && typeof db.close === "function") db.close();
    if (previousPlatform === undefined) delete process.env.DORE_DB_PLATFORM;
    else process.env.DORE_DB_PLATFORM = previousPlatform;
    if (previousPath === undefined) delete process.env.DORE_DATABASE_PATH;
    else process.env.DORE_DATABASE_PATH = previousPath;
    if (previousHash === undefined) delete process.env.DORE_MANAGER_PASSWORD_HASH;
    else process.env.DORE_MANAGER_PASSWORD_HASH = previousHash;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime creates audit indexes only after additive audit compatibility", async () => {
  const [runtime, migration] = await Promise.all([
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0027_finance_engine_foundation.sql", import.meta.url), "utf8"),
  ]);
  const pragmaIndex = runtime.indexOf('PRAGMA table_info(audit_logs)');
  const auditIndex = runtime.indexOf('CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created');

  assert.ok(pragmaIndex >= 0);
  assert.ok(auditIndex > pragmaIndex);
  assert.match(runtime, /missingAuditColumns[\s\S]*ALTER TABLE audit_logs ADD COLUMN before_json[\s\S]*ALTER TABLE audit_logs ADD COLUMN store_id/u);
  assert.match(runtime, /writeAudit[\s\S]*writeStructuredAudit/u);
  assert.doesNotMatch(migration, /ALTER TABLE `audit_logs`/u);
});
