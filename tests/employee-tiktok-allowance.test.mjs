import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");
const {
  earnedTikTokAllowance,
  employeeTikTokAllowanceForCreate,
  employeeTikTokAllowanceForPatch,
} = await import("../app/lib/employee-tiktok.ts");

test("legacy TikTok allowance migration remains replayable without rewriting historical shifts", async () => {
  const migration = await source("../drizzle/0009_employee_tiktok_allowance.sql");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hourly_rate INTEGER NOT NULL DEFAULT 20000
    );
    CREATE TABLE shift_sessions (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      status TEXT NOT NULL,
      tiktok_allowance INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO employees (id, name, hourly_rate) VALUES ('employee-1', 'Nhân viên cũ', 23000);
    INSERT INTO shift_sessions (id, employee_id, status, tiktok_allowance) VALUES
      ('active-1', 'employee-1', 'ACTIVE', 0),
      ('completed-1', 'employee-1', 'COMPLETED', 39000);
  `);

  for (const statement of migration.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
    db.exec(statement);
  }

  const employee = db.prepare("SELECT name, hourly_rate AS hourlyRate, tiktok_allowance AS tiktokAllowance FROM employees WHERE id = 'employee-1'").get();
  assert.equal(employee.name, "Nhân viên cũ");
  assert.equal(employee.hourlyRate, 23000);
  assert.equal(employee.tiktokAllowance, 25000);
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'active-1'").get().applied_tiktok_allowance, 25000);
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'completed-1'").get().applied_tiktok_allowance, null);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM shift_sessions WHERE id = 'completed-1'").get().tiktok_allowance, 39000);

  db.exec("UPDATE employees SET tiktok_allowance = 0 WHERE id = 'employee-1'");
  assert.equal(db.prepare("SELECT tiktok_allowance FROM employees WHERE id = 'employee-1'").get().tiktok_allowance, 0);
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'active-1'").get().applied_tiktok_allowance, 25000);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM shift_sessions WHERE id = 'completed-1'").get().tiktok_allowance, 39000);

  db.exec("INSERT INTO employees (id, name, hourly_rate) VALUES ('employee-2', 'Nhân viên mới', 20000)");
  assert.equal(db.prepare("SELECT tiktok_allowance FROM employees WHERE id = 'employee-2'").get().tiktok_allowance, 25000);
  db.close();
});

test("employee API requires explicit per-employee VND and preserves omitted PATCH values", async () => {
  const [schema, runtime, employeesApi, allowancePolicy] = await Promise.all([
    source("../db/schema.ts"),
    source("../db/runtime.ts"),
    source("../app/api/employees/route.ts"),
    source("../app/lib/employee-tiktok.ts"),
  ]);

  assert.match(schema, /tiktokAllowance: integer\("tiktok_allowance"\)\.notNull\(\)\.default\(0\)/u);
  assert.match(runtime, /ADD COLUMN tiktok_allowance INTEGER NOT NULL DEFAULT 0/u);
  assert.match(runtime, /SET applied_tiktok_allowance = \([\s\S]*employee\.tiktok_allowance[\s\S]*status = 'ACTIVE' AND applied_tiktok_allowance IS NULL/u);
  assert.match(employeesApi, /tiktokAllowance\?: number \| string/u);
  assert.match(employeesApi, /employeeTikTokAllowanceForCreate\(body\.tiktokAllowance\)/u);
  assert.doesNotMatch(employeesApi, /financialPolicyTikTokAllowanceVnd/u);
  assert.match(employeesApi, /employeeTikTokAllowanceForPatch\(body\.tiktokAllowance, existing\.tiktokAllowance\)/u);
  assert.doesNotMatch(employeesApi, /body\.tiktokAllowance \|\|/u);
  assert.match(employeesApi, /tiktok_allowance = CASE WHEN \? = 1 THEN \? ELSE tiktok_allowance END/u);
  assert.doesNotMatch(employeesApi, /UPDATE shift_sessions\s+SET applied_tiktok_allowance/u);
  assert.match(employeesApi, /activeShiftSnapshotsPreserved: true/u);
  assert.match(allowancePolicy, /employeeTikTokAllowanceForCreate\(input: AllowanceInput\) \{\s*return parsedAllowance\(input\);/u);
  assert.doesNotMatch(allowancePolicy, /DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE/u);
  assert.match(allowancePolicy, /if \(input === undefined\) return validAllowance\(current\) \? current : null/u);
});

test("per-employee manager updates preserve active and historical shift snapshots", () => {
  assert.equal(employeeTikTokAllowanceForCreate(undefined), null);
  assert.equal(employeeTikTokAllowanceForCreate(null), null);
  assert.equal(employeeTikTokAllowanceForCreate(0), 0);
  assert.equal(employeeTikTokAllowanceForCreate(49_000), 49_000);
  assert.equal(employeeTikTokAllowanceForPatch(undefined, 49_000), 49_000);
  assert.equal(employeeTikTokAllowanceForPatch(0, 49_000), 0);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE employees (id TEXT PRIMARY KEY, tiktok_allowance INTEGER NOT NULL DEFAULT 25000);
    CREATE TABLE shift_sessions (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      applied_tiktok_allowance INTEGER,
      tiktok INTEGER NOT NULL DEFAULT 0,
      tiktok_allowance INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE employee_payroll_closings (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO employees (id, tiktok_allowance) VALUES ('employee-49', 25000);
    INSERT INTO shift_sessions
      (id, employee_id, applied_tiktok_allowance, tiktok, tiktok_allowance, ended_at, status)
    VALUES
      ('completed-39', 'employee-49', 39000, 1, 39000, '2026-08-01T12:00:00.000Z', 'COMPLETED'),
      ('active-25', 'employee-49', 25000, 0, 0, NULL, 'ACTIVE');
  `);

  const lockedSnapshot = JSON.stringify({ employeeId: "employee-49", tiktokAllowance: 39_000, totalPay: 139_000 });
  db.prepare("INSERT INTO employee_payroll_closings (id, employee_id, snapshot_json, status) VALUES (?, ?, ?, 'LOCKED')")
    .run("locked-1", "employee-49", lockedSnapshot);

  const applyManagerPatch = (employeeId, input, staleCurrent) => {
    const next = employeeTikTokAllowanceForPatch(input, staleCurrent);
    assert.notEqual(next, null);
    const provided = input !== undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE employees SET tiktok_allowance = CASE WHEN ? = 1 THEN ? ELSE tiktok_allowance END WHERE id = ?")
        .run(provided ? 1 : 0, next, employeeId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  // Explicit 49k updates employee policy, while an already-started shift keeps 25k.
  applyManagerPatch("employee-49", 49_000, 25_000);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM employees WHERE id = 'employee-49'").get().tiktok_allowance, 49_000);
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'active-25'").get().applied_tiktok_allowance, 25_000);

  // A stale legacy client omitted the field after the explicit update committed.
  // Its CASE update must preserve 49k and must not touch active snapshots.
  applyManagerPatch("employee-49", undefined, 25_000);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM employees WHERE id = 'employee-49'").get().tiktok_allowance, 49_000);
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'active-25'").get().applied_tiktok_allowance, 25_000);

  // END derives the earned amount from the row at write time, not a stale SELECT.
  db.prepare(`UPDATE shift_sessions SET
      tiktok = 1,
      tiktok_allowance = CASE WHEN ? = 1
        THEN COALESCE(applied_tiktok_allowance,
          (SELECT tiktok_allowance FROM employees WHERE id = ?), ?)
        ELSE 0 END,
      ended_at = ?, status = 'COMPLETED'
    WHERE id = ? AND status = 'ACTIVE'`)
    .run(1, "employee-49", 0, "2026-08-09T12:00:00.000Z", "active-25");
  assert.equal(db.prepare("SELECT tiktok_allowance FROM shift_sessions WHERE id = 'active-25'").get().tiktok_allowance, 25_000);

  // A later shift snapshots 49k, but earns zero when TikTok is not selected.
  db.prepare(`INSERT INTO shift_sessions (id, employee_id, applied_tiktok_allowance, status)
    SELECT ?, ?, (SELECT tiktok_allowance FROM employees WHERE id = ?), 'ACTIVE'`)
    .run("next-49", "employee-49", "employee-49");
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'next-49'").get().applied_tiktok_allowance, 49_000);
  const nextSnapshot = db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'next-49'").get().applied_tiktok_allowance;
  assert.equal(earnedTikTokAllowance(false, nextSnapshot), 0);
  db.prepare("UPDATE shift_sessions SET tiktok = 0, tiktok_allowance = 0, ended_at = ?, status = 'COMPLETED' WHERE id = ? AND status = 'ACTIVE'")
    .run("2026-08-09T17:00:00.000Z", "next-49");

  // Historical completed rows and the byte-for-byte locked JSON never change.
  assert.equal(db.prepare("SELECT tiktok_allowance FROM shift_sessions WHERE id = 'completed-39'").get().tiktok_allowance, 39_000);
  assert.equal(db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE id = 'locked-1'").get().snapshot_json, lockedSnapshot);

  // Explicit zero remains valid but only applies to shifts that start afterwards.
  db.prepare("INSERT INTO shift_sessions (id, employee_id, applied_tiktok_allowance, status) VALUES (?, ?, ?, 'ACTIVE')")
    .run("active-zero", "employee-49", 49_000);
  applyManagerPatch("employee-49", 0, 49_000);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM employees WHERE id = 'employee-49'").get().tiktok_allowance, 0);
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'active-zero'").get().applied_tiktok_allowance, 49_000);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM shift_sessions WHERE id = 'completed-39'").get().tiktok_allowance, 39_000);
  assert.equal(db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE id = 'locked-1'").get().snapshot_json, lockedSnapshot);

  // Inverse order: END commits first at 25k, then PATCH affects only the
  // employee configuration and future sessions, never that history.
  db.exec(`
    INSERT INTO employees (id, tiktok_allowance) VALUES ('employee-end-first', 25000);
    INSERT INTO shift_sessions (id, employee_id, applied_tiktok_allowance, status)
      VALUES ('end-first', 'employee-end-first', 25000, 'ACTIVE');
  `);
  db.prepare(`UPDATE shift_sessions SET
      tiktok = 1,
      tiktok_allowance = CASE WHEN ? = 1
        THEN COALESCE(applied_tiktok_allowance,
          (SELECT tiktok_allowance FROM employees WHERE id = ?), ?)
        ELSE 0 END,
      ended_at = ?, status = 'COMPLETED'
    WHERE id = ? AND status = 'ACTIVE'`)
    .run(1, "employee-end-first", 25_000, "2026-08-09T10:00:00.000Z", "end-first");
  applyManagerPatch("employee-end-first", 49_000, 25_000);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM shift_sessions WHERE id = 'end-first'").get().tiktok_allowance, 25_000);
  assert.equal(db.prepare("SELECT tiktok_allowance FROM employees WHERE id = 'employee-end-first'").get().tiktok_allowance, 49_000);
  db.prepare(`INSERT INTO shift_sessions (id, employee_id, applied_tiktok_allowance, status)
    SELECT ?, ?, (SELECT tiktok_allowance FROM employees WHERE id = ?), 'ACTIVE'`)
    .run("future-49", "employee-end-first", "employee-end-first");
  assert.equal(db.prepare("SELECT applied_tiktok_allowance FROM shift_sessions WHERE id = 'future-49'").get().applied_tiktok_allowance, 49_000);
  db.close();
});

test("shift writes serialize with allowance PATCH while payroll reads only completed history", async () => {
  const [auth, shift, payroll] = await Promise.all([
    source("../app/api/_lib/auth.ts"),
    source("../app/api/shift/route.ts"),
    source("../app/api/payroll/route.ts"),
  ]);

  assert.match(auth, /e\.tiktok_allowance AS employeeTiktokAllowance/u);
  assert.match(auth, /employeeTiktokAllowance = runningShift\.appliedTikTokAllowance/u);
  assert.match(shift, /applied_tiktok_allowance, applied_support_allowance, started_at/u);
  assert.match(shift, /\(SELECT tiktok_allowance FROM employees WHERE id = \?\)/u);
  assert.match(shift, /const appliedTikTokAllowance = employeeTikTokAllowanceSnapshot\(activeSession\.appliedTikTokAllowance\)/u);
  assert.match(shift, /tiktok_allowance = \?/u);
  assert.match(shift, /SELECT applied_tiktok_allowance AS appliedTikTokAllowance FROM shift_sessions WHERE id = \? AND status = 'ACTIVE'/u);
  assert.match(shift, /employeeTiktokAllowance: appliedTikTokAllowance,\s*expenseAmount/u);
  assert.doesNotMatch(shift, /body\.tiktok \? 25000 : 0/u);
  assert.doesNotMatch(shift, /rolloverTikTok \? 25000 : 0/u);
  assert.match(payroll, /COALESCE\(SUM\(s\.tiktok_allowance\), 0\) AS tiktokAllowance/u);
  assert.match(payroll, /const canonicalSnapshot = payrollSummaryFromFinancialPeriod\(financialPeriodRow\)/u);
  assert.match(payroll, /const summary = snapshotIsAuthoritative && \(canonicalSnapshot \|\| legacySnapshot\)[\s\S]*await buildPreview/u);
  assert.doesNotMatch(payroll, /UPDATE shift_sessions SET tiktok_allowance/u);
});
