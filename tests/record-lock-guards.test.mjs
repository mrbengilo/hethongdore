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
    CREATE TABLE business_records (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      store_id TEXT,
      title TEXT NOT NULL,
      data_json TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE employee_payroll_closings (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  return db;
}

function addRecord(db, { id, category, storeId = "store-1", period, date, employeeId, status = "ACTIVE" }) {
  const data = { ...(period ? { period } : {}), ...(date ? { date } : {}), ...(employeeId ? { employeeId } : {}) };
  db.prepare("INSERT INTO business_records (id, category, store_id, title, data_json, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, category, storeId, id, JSON.stringify(data), status);
}

test("records route conditionally guards every payroll-sensitive create, update and delete", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /payrollSensitiveCategories = new Set\(\["LUONG_THUONG", "CHI_PHI_CO_DINH", "DONG_TIEN", "NHAP_HANG"\]\)/u);
  assert.match(source, /INSERT INTO business_records[\s\S]*?SELECT \?, \?, \?, \?, \?, \?, \?, \?, \?[\s\S]*?WHERE \$\{incomingPeriodLockGuardSql\}\$\{employeeGuard\}/u);
  assert.match(source, /UPDATE business_records[\s\S]*?AND \$\{existingPeriodLockGuardSql\}[\s\S]*?AND \$\{incomingPeriodLockGuardSql\}\$\{employeeGuards\}/u);
  assert.match(source, /SET status = 'DELETED'[\s\S]*?AND \$\{existingPeriodLockGuardSql\}\$\{employeeGuard\}/u);
  assert.match(source, /period_lock\.status IN \('CLOSING', 'LOCKED'\)/u);
  assert.match(source, /employee_lock\.status IN \('CLOSING', 'BASE_LOCKED', 'LOCKED'\)/u);
  assert.equal(source.match(/affectedRows\(result\) === 0/g)?.length, 3);
  assert.match(source, /periodLockMessage\(\)[\s\S]*?423/u);
});

test("period guards block both the existing and incoming period atomically", async () => {
  const source = await readFile(routeUrl, "utf8");
  const existingGuard = templateConstant(source, "existingPeriodLockGuardSql");
  const incomingGuard = templateConstant(source, "incomingPeriodLockGuardSql");
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

test("allowance guards cover both the previous and next employee closing", async () => {
  const source = await readFile(routeUrl, "utf8");
  const existingPeriodGuard = templateConstant(source, "existingPeriodLockGuardSql");
  const incomingPeriodGuard = templateConstant(source, "incomingPeriodLockGuardSql");
  const existingEmployeeGuard = templateConstant(source, "existingEmployeeLockGuardSql");
  const incomingEmployeeGuard = templateConstant(source, "incomingEmployeeLockGuardSql");
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
      AND ${incomingPeriodGuard}
      AND ${existingEmployeeGuard}
      AND ${incomingEmployeeGuard}`);
  const values = ["updated", "allowance", "store-1", "2026-08", "store-1", "employee-new", "2026-08"];
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
