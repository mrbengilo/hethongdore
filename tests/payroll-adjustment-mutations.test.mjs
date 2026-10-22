import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const routeUrl = new URL("../app/api/records/route.ts", import.meta.url);

function templateConstant(source, name) {
  const prefix = `const ${name} = \``;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `${name} must exist`);
  const contentStart = start + prefix.length;
  const end = source.indexOf("`;", contentStart);
  assert.notEqual(end, -1, `${name} must be a template literal`);
  return source.slice(contentStart, end);
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE financial_periods (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE business_records (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      store_id TEXT,
      owner_id TEXT,
      title TEXT NOT NULL,
      data_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      store_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      detail TEXT,
      before_json TEXT,
      after_json TEXT,
      reason TEXT NOT NULL CHECK(length(trim(reason)) >= 5),
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

test("payroll adjustment lifecycle allows reconciliation states and blocks immutable states", async () => {
  const source = await readFile(routeUrl, "utf8");
  const guard = templateConstant(source, "payrollAdjustmentIncomingGuardSql")
    .replace("${incomingPeriodLockGuardSql}", "1 = 1");
  const db = database();
  const mutable = db.prepare(`SELECT CASE WHEN ${guard} THEN 1 ELSE 0 END AS mutable`);

  for (const status of ["DRAFT", "CALCULATED", "RECONCILING"]) {
    db.prepare("DELETE FROM financial_periods").run();
    db.prepare("INSERT INTO financial_periods (id, store_id, period, status) VALUES (?, ?, ?, ?)")
      .run(`period-${status}`, "store-1", "2026-08", status);
    assert.equal(mutable.get("store-1", "2026-08").mutable, 1, `${status} remains mutable`);
  }

  for (const status of ["CONFIRMED", "PAID", "LOCKED"]) {
    db.prepare("DELETE FROM financial_periods").run();
    db.prepare("INSERT INTO financial_periods (id, store_id, period, status) VALUES (?, ?, ?, ?)")
      .run(`period-${status}`, "store-1", "2026-08", status);
    assert.equal(mutable.get("store-1", "2026-08").mutable, 0, `${status} is immutable`);
    assert.equal(mutable.get("store-2", "2026-08").mutable, 1, "another store stays mutable");
    assert.equal(mutable.get("store-1", "2026-09").mutable, 1, "another month stays mutable");
  }
});

test("payroll adjustment edit guard is a versioned updated-at CAS", async () => {
  const source = await readFile(routeUrl, "utf8");
  const guard = templateConstant(source, "payrollAdjustmentExistingGuardSql")
    .replace("${existingPeriodLockGuardSql}", "1 = 1");
  const db = database();
  db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
    VALUES (?, 'LUONG_THUONG', ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
    .run("adjustment-1", "store-1", "manager-1", "Phụ cấp", JSON.stringify({ date: "2026-08-10", period: "2026-08", version: 1 }), "t0", "t0");
  const update = db.prepare(`UPDATE business_records SET updated_at = ?,
      data_json = json_set(data_json, '$.version', 2)
    WHERE id = ? AND updated_at = ?
      AND CAST(COALESCE(json_extract(data_json, '$.version'), 1) AS INTEGER) = ?
      AND ${guard}`);

  assert.equal(update.run("t1", "adjustment-1", "stale", 1).changes, 0, "stale timestamp loses");
  assert.equal(update.run("t1", "adjustment-1", "t0", 2).changes, 0, "stale version loses");
  assert.equal(update.run("t1", "adjustment-1", "t0", 1).changes, 1, "matching CAS wins");
  assert.equal(update.run("t2", "adjustment-1", "t0", 1).changes, 0, "only one concurrent writer wins");

  db.prepare("INSERT INTO financial_periods (id, store_id, period, status) VALUES (?, ?, ?, 'CONFIRMED')")
    .run("period-locked", "store-1", "2026-08");
  assert.equal(update.run("t2", "adjustment-1", "t1", 2).changes, 0, "confirmed period blocks CAS inside the mutation");
});

test("payroll adjustment route couples every mutation to structured audit and archived work evidence", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /payroll-adjustment-\$\{await sha256\([\s\S]*clientRequestId/u);
  assert.match(source, /createPayloadHash: payloadHash/u);
  assert.match(source, /lastMutationRequestId[\s\S]*lastMutationPayloadHash/u);
  assert.match(source, /CAST\(COALESCE\(json_extract\(data_json, '\$\.version'\), 1\) AS INTEGER\) = \?/u);
  assert.match(source, /updated_at = \?[\s\S]*payrollAdjustmentExistingGuardSql/u);
  assert.match(source, /db\.batch\(\[[\s\S]*'CREATE', 'LUONG_THUONG'[\s\S]*before_json, after_json, reason, created_at/u);
  assert.match(source, /db\.batch\(\[[\s\S]*'UPDATE', 'LUONG_THUONG'[\s\S]*before_json, after_json, reason, created_at/u);
  assert.match(source, /db\.batch\(\[[\s\S]*'DELETE', 'LUONG_THUONG'[\s\S]*before_json, after_json, reason, created_at/u);
  assert.match(source, /historical_work\.employee_id = e\.id[\s\S]*historical_work\.store_id = \?[\s\S]*historical_work\.ended_at IS NOT NULL/u);
  assert.match(source, /isPayrollAdjustmentPeriodBlocked[\s\S]*'CONFIRMED', 'PAID', 'LOCKED'/u);
});

test("an audit constraint failure rolls the paired adjustment mutation back", () => {
  const db = database();
  db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
    VALUES (?, 'LUONG_THUONG', ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
    .run("adjustment-rollback", "store-1", "manager-1", "Thưởng", JSON.stringify({ period: "2026-08", version: 1 }), "t0", "t0");

  assert.throws(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE business_records SET title = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
        .run("Không được lưu", "t1", "adjustment-rollback", "t0");
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("audit-1", "manager-1", "store-1", "UPDATE", "LUONG_THUONG", "adjustment-rollback", "test", "{}", "{}", "", "t1");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  assert.equal(db.prepare("SELECT title FROM business_records WHERE id = ?").get("adjustment-rollback").title, "Thưởng");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count, 0);
});
