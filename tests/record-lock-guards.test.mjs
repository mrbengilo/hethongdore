import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

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
    CREATE TABLE business_records (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      store_id TEXT,
      title TEXT NOT NULL,
      data_json TEXT NOT NULL,
      status TEXT
    );
    CREATE TABLE employee_payroll_closings (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT
    );
    CREATE TABLE shift_sessions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      shift_name TEXT,
      scheduled_start TEXT,
      scheduled_end TEXT,
      status TEXT NOT NULL
    );
  `);
  return db;
}

async function fixedCostModule() {
  const source = await readFile(new URL("../app/lib/fixed-cost.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

async function periodLockModule() {
  const source = await readFile(new URL("../app/api/_lib/store-period-lock.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function addRecord(db, { id, category, storeId = "store-1", period, date, employeeId, clientRequestId, total, status = "ACTIVE" }) {
  const data = { ...(period ? { period } : {}), ...(date ? { date } : {}), ...(employeeId ? { employeeId } : {}), ...(clientRequestId ? { clientRequestId } : {}), ...(total !== undefined ? { total } : {}) };
  db.prepare("INSERT INTO business_records (id, category, store_id, title, data_json, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, category, storeId, id, JSON.stringify(data), status);
}

test("records route conditionally guards every payroll-sensitive create, update and delete", async () => {
  const [source, lockSource] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(new URL("../app/api/_lib/store-period-lock.ts", import.meta.url), "utf8"),
  ]);

  assert.match(source, /payrollSensitiveCategories = new Set\(\["LUONG_THUONG", "CHI_PHI_CO_DINH", "DONG_TIEN", "NHAP_HANG"\]\)/u);
  assert.match(source, /INSERT INTO business_records[\s\S]*?SELECT \?, \?, \?, \?, \?, \?, \?, \?, \?[\s\S]*?WHERE \$\{incomingPeriodLockGuardSql\}/u);
  assert.match(source, /UPDATE business_records[\s\S]*?AND \$\{existingPeriodLockGuardSql\}[\s\S]*?AND \$\{incomingPeriodLockGuardSql\}/u);
  assert.match(source, /SET status = 'DELETED'[\s\S]*?AND \$\{existingPeriodLockGuardSql\}/u);
  assert.match(lockSource, /category IN \('KPI_SUMMARY', 'PAYROLL_CLOSING'\)/u);
  assert.match(lockSource, /COALESCE\(store_period_lock\.status, ''\) != 'DELETED'/u);
  assert.match(lockSource, /COALESCE\(employee_period_lock\.status, ''\) != 'DELETED'/u);
  assert.match(source, /body\.action === "CREATE_SCHEDULE_BATCH"/u);
  assert.doesNotMatch(source, /scheduleClientRequestId/u);
  assert.equal(source.match(/affectedRows\(result\) === 0/g)?.length, 7);
  assert.match(source, /periodLockMessage\(\)[\s\S]*?423/u);
});

test("shift definition mutation guard blocks referenced schedules and active attendance atomically", async () => {
  const source = await readFile(routeUrl, "utf8");
  const guard = templateConstant(source, "shiftDefinitionMutableGuardSql");
  const db = database();
  db.prepare("INSERT INTO business_records (id, category, store_id, title, data_json, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run("shift-1", "CA_LAM_VIEC", "store-1", "Ca 1", JSON.stringify({ start: "08:00", end: "12:00" }), "ACTIVE");
  const update = db.prepare(`UPDATE business_records SET title = ?
    WHERE id = ? AND status != 'DELETED' AND ${guard}`);

  assert.equal(update.run("Ca 1 mới", "shift-1").changes, 1);
  db.prepare("UPDATE business_records SET title = 'Ca 1' WHERE id = 'shift-1'").run();
  db.prepare("INSERT INTO business_records (id, category, store_id, title, data_json, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run("schedule-1", "LICH_PHAN_CA", "store-1", "Lịch", JSON.stringify({ shiftId: "shift-1" }), "ACTIVE");
  assert.equal(update.run("Không được sửa", "shift-1").changes, 0);
  assert.equal(db.prepare("SELECT title FROM business_records WHERE id = 'shift-1'").get().title, "Ca 1");

  db.prepare("UPDATE business_records SET status = 'DELETED' WHERE id = 'schedule-1'").run();
  db.prepare("INSERT INTO shift_sessions (id, store_id, shift_name, scheduled_start, scheduled_end, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run("active-1", "store-1", "Ca 1", "08:00", "12:00", "ACTIVE");
  assert.equal(update.run("Vẫn không được sửa", "shift-1").changes, 0);
  assert.equal(db.prepare("SELECT title FROM business_records WHERE id = 'shift-1'").get().title, "Ca 1");
});

test("period guards block both the existing and incoming period atomically", async () => {
  const { incomingStorePeriodUnlockedSql, storePeriodUnlockedSql } = await periodLockModule();
  const existingPeriod = `CASE
    WHEN business_records.category = 'CHI_PHI_CO_DINH' THEN json_extract(business_records.data_json, '$.period')
    ELSE COALESCE(json_extract(business_records.data_json, '$.period'), substr(json_extract(business_records.data_json, '$.date'), 1, 7))
  END`;
  const existingGuard = storePeriodUnlockedSql("business_records.store_id", existingPeriod);
  const incomingGuard = incomingStorePeriodUnlockedSql;
  const db = database();

  addRecord(db, { id: "cost", category: "CHI_PHI_CO_DINH", period: "2026-07" });
  const patch = db.prepare(`UPDATE business_records SET title = ?
    WHERE id = ? AND ${existingGuard} AND ${incomingGuard}`);

  assert.equal(patch.run("open", "cost", "store-1", "2026-08").changes, 1);
  addRecord(db, { id: "old-lock", category: "KPI_SUMMARY", period: "2026-07", status: "CLOSING" });
  assert.equal(patch.run("blocked-old", "cost", "store-1", "2026-08").changes, 0);

  db.prepare("DELETE FROM business_records WHERE id = ?").run("old-lock");
  addRecord(db, { id: "new-lock", category: "KPI_SUMMARY", period: "2026-08", status: "LOCKED" });
  assert.equal(patch.run("blocked-new", "cost", "store-1", "2026-08").changes, 0);
  assert.equal(db.prepare("SELECT title FROM business_records WHERE id = ?").get("cost").title, "open");

  db.prepare("DELETE FROM business_records WHERE id = ?").run("new-lock");
  assert.equal(patch.run("moved", "cost", "store-1", "2026-08").changes, 1);

  addRecord(db, { id: "delete-lock", category: "KPI_SUMMARY", period: "2026-07", status: "LOCKED" });
  const remove = db.prepare(`UPDATE business_records SET status = 'DELETED'
    WHERE id = ? AND ${existingGuard}`);
  assert.equal(remove.run("cost").changes, 0);
  assert.equal(db.prepare("SELECT status FROM business_records WHERE id = ?").get("cost").status, "ACTIVE");
});

test("every non-deleted KPI, payroll and employee-closing lifecycle state locks the whole store period", async () => {
  const { incomingStorePeriodUnlockedSql } = await periodLockModule();
  const db = database();
  const unlocked = db.prepare(`SELECT CASE WHEN ${incomingStorePeriodUnlockedSql} THEN 1 ELSE 0 END AS unlocked`);

  for (const category of ["KPI_SUMMARY", "PAYROLL_CLOSING"]) {
    for (const status of [null, "ACTIVE", "CLOSING", "MANAGER_FINALIZED", "SALARY_CONFIRMED", "REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED"]) {
      db.prepare("DELETE FROM business_records").run();
      addRecord(db, { id: `lock-${category}-${status ?? "null"}`, category, period: "2026-08", status });
      assert.equal(unlocked.get("store-1", "2026-08").unlocked, 0, `${category}/${status ?? "NULL"} must lock`);
      assert.equal(unlocked.get("store-2", "2026-08").unlocked, 1, "another store remains open");
      assert.equal(unlocked.get("store-1", "2026-09").unlocked, 1, "another period remains open");
    }
    db.prepare("DELETE FROM business_records").run();
    addRecord(db, { id: `deleted-${category}`, category, period: "2026-08", status: "DELETED" });
    assert.equal(unlocked.get("store-1", "2026-08").unlocked, 1, `${category}/DELETED must not lock`);
  }

  for (const status of [null, "CLOSING", "BASE_LOCKED", "LOCKED", "LEGACY_FINALIZED"]) {
    db.prepare("DELETE FROM employee_payroll_closings").run();
    db.prepare("INSERT INTO employee_payroll_closings (id, store_id, employee_id, period, status) VALUES (?, ?, ?, ?, ?)")
      .run(`employee-lock-${status ?? "null"}`, "store-1", "unrelated-employee", "2026-08", status);
    assert.equal(unlocked.get("store-1", "2026-08").unlocked, 0, `employee ${status ?? "NULL"} must lock store-wide`);
  }
  db.prepare("DELETE FROM employee_payroll_closings").run();
  db.prepare("INSERT INTO employee_payroll_closings (id, store_id, employee_id, period, status) VALUES (?, ?, ?, ?, 'DELETED')")
    .run("employee-deleted", "store-1", "unrelated-employee", "2026-08");
  assert.equal(unlocked.get("store-1", "2026-08").unlocked, 1, "deleted employee closing does not lock");
});

test("allowance guards are store-wide across previous and next periods", async () => {
  const { incomingStorePeriodUnlockedSql, storePeriodUnlockedSql } = await periodLockModule();
  const existingPeriodGuard = storePeriodUnlockedSql(
    "business_records.store_id",
    "COALESCE(json_extract(business_records.data_json, '$.period'), substr(json_extract(business_records.data_json, '$.date'), 1, 7))",
  );
  const incomingPeriodGuard = incomingStorePeriodUnlockedSql;
  const db = database();

  addRecord(db, {
    id: "allowance",
    category: "LUONG_THUONG",
    date: "2026-07-20",
    employeeId: "employee-old",
  });
  const patch = db.prepare(`UPDATE business_records SET title = ?
    WHERE id = ?
      AND ${existingPeriodGuard}
      AND ${incomingPeriodGuard}`);
  const values = ["updated", "allowance", "store-1", "2026-08"];
  assert.equal(patch.run(...values).changes, 1);

  db.prepare("INSERT INTO employee_payroll_closings (id, store_id, employee_id, period, status) VALUES (?, ?, ?, ?, ?)")
    .run("old-employee-lock", "store-1", "employee-old", "2026-07", "BASE_LOCKED");
  assert.equal(patch.run(...values).changes, 0);

  db.prepare("DELETE FROM employee_payroll_closings").run();
  db.prepare("INSERT INTO employee_payroll_closings (id, store_id, employee_id, period, status) VALUES (?, ?, ?, ?, ?)")
    .run("new-employee-lock", "store-1", "employee-new", "2026-08", "CLOSING");
  assert.equal(patch.run(...values).changes, 0);
  assert.equal(db.prepare("SELECT title FROM business_records WHERE id = ?").get("allowance").title, "updated");
});

test("fixed-cost client request ids produce one deterministic record across retries", async () => {
  const { fixedCostRecordId, normalizeFixedCostClientRequestId } = await fixedCostModule();
  const requestId = "6e2427c8-dc56-4c2a-8a77-563cb0b0fd11";
  assert.equal(normalizeFixedCostClientRequestId(requestId), requestId);
  assert.equal(normalizeFixedCostClientRequestId("bad"), null);
  const firstId = await fixedCostRecordId("store-1", requestId);
  assert.equal(firstId, await fixedCostRecordId("store-1", requestId));
  assert.notEqual(firstId, await fixedCostRecordId("store-2", requestId));

  const db = database();
  const insert = db.prepare(`INSERT INTO business_records (id, category, store_id, title, data_json, status)
    VALUES (?, 'CHI_PHI_CO_DINH', ?, 'cost', ?, 'ACTIVE') ON CONFLICT(id) DO NOTHING`);
  const data = JSON.stringify({ period: "2026-08", clientRequestId: requestId, total: 100_000 });
  assert.equal(insert.run(firstId, "store-1", data).changes, 1);
  assert.equal(insert.run(firstId, "store-1", data).changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM business_records").get().count, 1);
});

test("voiding a fixed-cost batch preserves history, reduces totals, and respects period locks", async () => {
  const source = await readFile(routeUrl, "utf8");
  const storeFinance = await readFile(new URL("../app/api/_lib/store-finance.ts", import.meta.url), "utf8");
  const cashflow = await readFile(new URL("../app/api/cashflow/route.ts", import.meta.url), "utf8");
  const { storePeriodUnlockedSql } = await periodLockModule();
  const existingGuard = storePeriodUnlockedSql("business_records.store_id", "json_extract(business_records.data_json, '$.period')");
  const db = database();
  addRecord(db, { id: "cost-a", category: "CHI_PHI_CO_DINH", period: "2026-08", total: 100_000 });
  addRecord(db, { id: "cost-b", category: "CHI_PHI_CO_DINH", period: "2026-08", total: 40_000 });

  const activeTotal = () => Number(db.prepare(`SELECT COALESCE(SUM(json_extract(data_json, '$.total')), 0) AS total
    FROM business_records WHERE category = 'CHI_PHI_CO_DINH' AND status NOT IN ('DELETED', 'VOID')`).get().total);
  assert.equal(activeTotal(), 140_000);
  const voidBatch = db.prepare(`UPDATE business_records SET status = 'VOID'
    WHERE id = ? AND category = 'CHI_PHI_CO_DINH' AND status = 'ACTIVE' AND ${existingGuard}`);
  assert.equal(voidBatch.run("cost-a").changes, 1);
  assert.equal(activeTotal(), 40_000);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM business_records WHERE category = 'CHI_PHI_CO_DINH'").get().count, 2);
  assert.equal(db.prepare("SELECT status FROM business_records WHERE id = 'cost-a'").get().status, "VOID");

  addRecord(db, { id: "cost-c", category: "CHI_PHI_CO_DINH", period: "2026-09", total: 20_000 });
  addRecord(db, { id: "period-lock", category: "KPI_SUMMARY", period: "2026-09", status: "CLOSING" });
  assert.equal(voidBatch.run("cost-c").changes, 0);
  assert.equal(db.prepare("SELECT status FROM business_records WHERE id = 'cost-c'").get().status, "ACTIVE");

  assert.match(source, /writeAudit\(user\.id, "VOID_FIXED_COST", "CHI_PHI_CO_DINH"/u);
  assert.match(storeFinance, /status NOT IN \('DELETED', 'VOID'\)/u);
  assert.match(cashflow, /r\.category = 'CHI_PHI_CO_DINH' AND r\.status = 'VOID'/u);
});
