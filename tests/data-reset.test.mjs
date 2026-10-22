import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const drizzleDirectory = new URL("../drizzle/", import.meta.url);

async function sql(name) {
  return readFile(new URL(name, drizzleDirectory), "utf8");
}

test("latest reset migration preserves store identity and manager access while clearing every operational row", async () => {
  const db = new DatabaseSync(":memory:");
  const migrationNames = (await readdir(drizzleDirectory))
    .filter((name) => /^000[0-7]_.*\.sql$/u.test(name))
    .sort();
  for (const name of migrationNames) db.exec(await sql(name));

  const managerHash = "manager-password-hash-must-survive";
  db.exec(`
    INSERT INTO stores (id, name, address, revenue, expense, status, created_at) VALUES
      ('store-1', 'Store 1', 'Address 1', 5000000, 2000000, 'ACTIVE', '2026-08-01T00:00:00Z'),
      ('store-2', 'Store 2', 'Address 2', 7000000, 3000000, 'INACTIVE', '2026-08-02T00:00:00Z');
    INSERT INTO employees (id, store_id, code, name, position, phone, hourly_rate, status)
      VALUES ('employee-1', 'store-1', 'NV001', 'Employee', 'Sales', '0900000000', 20000, 'ACTIVE');
    INSERT INTO users (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, locked_until, shift_active, current_shift, shift_started_at)
      VALUES ('manager-1', 'manager', '${managerHash}', 'MANAGER', 'Manager', 'employee-1', 'store-1', 2, 9999999999999, 1, 'SHIFT-M', '2026-08-08T01:00:00Z');
    INSERT INTO users (id, username, password_hash, role, name, failed_attempts, shift_active)
      VALUES ('manager-2', 'manager-2', 'second-manager-hash', 'MANAGER', 'Second manager', 0, 0);
    INSERT INTO users (id, username, password_hash, role, name, employee_id, store_id)
      VALUES ('employee-user-1', 'employee', 'employee-hash', 'EMPLOYEE', 'Employee', 'employee-1', 'store-1');
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES
      ('manager-session', 'manager-1', 'manager-token', 9999999999999, '2026-08-08T00:00:00Z'),
      ('manager-session-2', 'manager-2', 'manager-token-2', 9999999999999, '2026-08-08T00:00:00Z'),
      ('employee-session', 'employee-user-1', 'employee-token', 9999999999999, '2026-08-08T00:00:00Z'),
      ('orphan-session', 'missing-user', 'orphan-token', 9999999999999, '2026-08-08T00:00:00Z');
    INSERT INTO orders (id, code, store_id, employee_id, shift_code, amount, payment_method, created_at)
      VALUES ('order-1', 'ORD-1', 'store-1', 'employee-1', 'SHIFT-1', 100000, 'CASH', '2026-08-08T00:00:00Z');
    INSERT INTO audit_logs (id, user_id, action, entity_type, created_at)
      VALUES ('audit-1', 'manager-1', 'CREATE', 'STORE', '2026-08-08T00:00:00Z');
    INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('record-1', 'CHI_PHI_CO_DINH', 'store-1', 'manager-1', 'Cost', '{}', 'ACTIVE', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z');
    INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, started_at, status)
      VALUES ('shift-1', 'SHIFT-1', 'store-1', 'employee-1', '2026-08-08T00:00:00Z', 'ACTIVE');
    INSERT INTO employee_transfers (id, employee_id, source_store_id, target_store_id, start_date, end_date, support_hourly_rate, reason, created_by, created_at, updated_at)
      VALUES ('transfer-1', 'employee-1', 'store-1', 'store-2', '2026-08-08', '2026-08-09', 25000, 'Support', 'manager-1', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z');
    INSERT INTO employee_payroll_closings (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
      VALUES ('closing-1', 'store-1', 'employee-1', '2026-08', '{}', 'ACTIVE', 'LOCKED', '2026-08-08T00:00:00Z', 'manager-1');
    INSERT INTO system_state (key, value, updated_at)
      VALUES ('future_state', 'KEEP', '2026-08-08T00:00:00Z');
  `);

  const resetSql = await sql("0008_reset_operational_data_preserve_stores.sql");
  db.exec(resetSql);
  db.prepare("UPDATE system_state SET value = ? WHERE key = ?")
    .run("COMPLETE", "data_reset_2026_08_08_v2");
  db.exec(resetSql);

  for (const table of [
    "employee_payroll_closings",
    "orders",
    "shift_sessions",
    "employee_transfers",
    "business_records",
    "audit_logs",
    "employees",
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} should be empty`);
  }

  assert.deepEqual(
    db.prepare("SELECT id, name, address, revenue, expense, status, created_at AS createdAt FROM stores ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "store-1", name: "Store 1", address: "Address 1", revenue: 0, expense: 0, status: "ACTIVE", createdAt: "2026-08-01T00:00:00Z" },
      { id: "store-2", name: "Store 2", address: "Address 2", revenue: 0, expense: 0, status: "INACTIVE", createdAt: "2026-08-02T00:00:00Z" },
    ],
  );

  assert.deepEqual(db.prepare("SELECT id, username, password_hash AS passwordHash, role, name, employee_id AS employeeId, store_id AS storeId, failed_attempts AS failedAttempts, locked_until AS lockedUntil, shift_active AS shiftActive, current_shift AS currentShift, shift_started_at AS shiftStartedAt FROM users ORDER BY id").all().map((row) => ({ ...row })), [
    {
      id: "manager-1",
      username: "manager",
      passwordHash: managerHash,
      role: "MANAGER",
      name: "Manager",
      employeeId: null,
      storeId: null,
      failedAttempts: 0,
      lockedUntil: null,
      shiftActive: 0,
      currentShift: null,
      shiftStartedAt: null,
    },
    {
      id: "manager-2",
      username: "manager-2",
      passwordHash: "second-manager-hash",
      role: "MANAGER",
      name: "Second manager",
      employeeId: null,
      storeId: null,
      failedAttempts: 0,
      lockedUntil: null,
      shiftActive: 0,
      currentShift: null,
      shiftStartedAt: null,
    },
  ]);
  assert.deepEqual(db.prepare("SELECT id, user_id AS userId, token_hash AS tokenHash, expires_at AS expiresAt, created_at AS createdAt FROM sessions ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "manager-session", userId: "manager-1", tokenHash: "manager-token", expiresAt: 9999999999999, createdAt: "2026-08-08T00:00:00Z" },
    { id: "manager-session-2", userId: "manager-2", tokenHash: "manager-token-2", expiresAt: 9999999999999, createdAt: "2026-08-08T00:00:00Z" },
  ]);
  assert.deepEqual(db.prepare("SELECT key, value FROM system_state ORDER BY key").all().map((row) => ({ ...row })), [
    { key: "data_reset_2026_08_08", value: "R2_PENDING" },
    { key: "data_reset_2026_08_08_v2", value: "COMPLETE" },
    { key: "future_state", value: "KEEP" },
  ]);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("runtime permanently retires automatic reset while historical migration remains auditable", async () => {
  const [runtime, schema, journal, resetMigration] = await Promise.all([
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    sql("0008_reset_operational_data_preserve_stores.sql"),
  ]);

  assert.doesNotMatch(runtime, /DATA_RESET_KEY|ensureOneTimeDataReset|verifyLegacyResetMarkerWithoutMutation/u);
  assert.match(runtime, /Startup never reads[\s\S]*never deletes or zeroes existing operational data/u);
  assert.match(runtime, /LEGACY_RESET_COMPATIBILITY_KEY = "data_reset_2026_08_08_v2"/u);
  assert.match(runtime, /LEGACY_RESET_COMPLETE = "COMPLETE"/u);
  assert.match(runtime, /INSERT OR IGNORE INTO system_state \(key, value, updated_at\)/u);
  assert.ok(
    runtime.indexOf("INSERT OR IGNORE INTO system_state (key, value, updated_at)")
      < runtime.indexOf('PRAGMA table_info(users)'),
    "the rollback compatibility marker must be persisted before later additive compatibility work",
  );
  assert.ok(
    runtime.indexOf("INSERT OR IGNORE INTO system_state (key, value, updated_at)")
      < runtime.indexOf("managerPasswordHash(platform.kind)"),
    "configuration validation must not fail before the rollback guard is durable",
  );
  assert.doesNotMatch(runtime, /DELETE FROM users WHERE role != 'MANAGER'/u);
  assert.doesNotMatch(runtime, /UPDATE stores SET revenue = 0, expense = 0/u);
  assert.doesNotMatch(runtime, /DELETE FROM stores/u);
  assert.match(runtime, /WHERE NOT EXISTS \(SELECT 1 FROM users WHERE role = 'MANAGER'\)/u);
  assert.doesNotMatch(runtime, /storage\.list|storage\.delete|finishResetUploads/u);
  assert.doesNotMatch(runtime, /initialStores|defaultStoreShifts|EMPLOYEE_HASH|user-employee|nv001/u);
  assert.doesNotMatch(runtime, /UPDATE users SET password_hash/u);

  assert.match(resetMigration, /UPDATE `stores`[\s\S]*`revenue` = 0[\s\S]*`expense` = 0/u);
  assert.match(resetMigration, /INSERT OR IGNORE INTO `system_state`/u);
  assert.doesNotMatch(resetMigration, /DELETE FROM `stores`/u);
  assert.match(schema, /sqliteTable\("system_state"/u);
  assert.match(journal, /0008_reset_operational_data_preserve_stores/u);
});

test("new additive startup marker makes the prior release reset guard executable but inert", async () => {
  const runtime = await readFile(new URL("../db/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /INSERT OR IGNORE INTO system_state[\s\S]*LEGACY_RESET_COMPATIBILITY_KEY, LEGACY_RESET_COMPLETE/u);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE stores (id TEXT PRIMARY KEY, revenue INTEGER NOT NULL, expense INTEGER NOT NULL);
    CREATE TABLE employees (id TEXT PRIMARY KEY);
    CREATE TABLE orders (id TEXT PRIMARY KEY);
    INSERT INTO stores VALUES ('store-live', 900000, 120000);
    INSERT INTO employees VALUES ('employee-live');
    INSERT INTO orders VALUES ('order-live');
  `);

  // This is the non-destructive statement executed by the new runtime.
  db.prepare("INSERT OR IGNORE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)")
    .run("data_reset_2026_08_08_v2", "COMPLETE", "2026-08-10T00:00:00.000Z");

  // Execute the guard used by the prior release. Its destructive body must be
  // unreachable after the new runtime has initialized this database once.
  const priorReleaseState = db.prepare(
    "SELECT value FROM system_state WHERE key = ? LIMIT 1",
  ).get("data_reset_2026_08_08_v2");
  if (!priorReleaseState) {
    db.exec("DELETE FROM orders; DELETE FROM employees; UPDATE stores SET revenue = 0, expense = 0;");
  }

  assert.deepEqual({ ...priorReleaseState }, { value: "COMPLETE" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employees").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT revenue, expense FROM stores WHERE id = 'store-live'").get() },
    { revenue: 900000, expense: 120000 },
  );
});

test("runtime persists the rollback guard even when later bootstrap validation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dore-reset-guard-"));
  const databasePath = path.join(root, "dore.sqlite");
  const runtimeUrl = new URL("../db/runtime.ts", import.meta.url).href;
  try {
    const pending = new DatabaseSync(databasePath);
    pending.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO system_state VALUES ('data_reset_2026_08_08_v2', 'R2_PENDING', '2026-08-09T00:00:00.000Z');`);
    pending.close();
    const child = spawnSync(process.execPath, [
      "--require",
      "./tests/tsx-windows-userinfo.cjs",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const { initDb } = await import(${JSON.stringify(runtimeUrl)});
try {
  await initDb();
  process.exitCode = 91;
} catch (error) {
  if (!String(error).includes("DORE_MANAGER_PASSWORD_HASH")) process.exitCode = 92;
}`,
    ], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        DORE_DB_PLATFORM: "sqlite",
        DORE_DATABASE_PATH: databasePath,
        DORE_MANAGER_PASSWORD_HASH: "invalid-on-purpose",
      },
      timeout: 20_000,
    });
    assert.equal(child.status, 0, child.stderr);

    const db = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        { ...db.prepare("SELECT value FROM system_state WHERE key = ?").get("data_reset_2026_08_08_v2") },
        { value: "COMPLETE" },
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
