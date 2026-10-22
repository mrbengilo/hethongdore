import assert from "node:assert/strict";
import test from "node:test";
import { createD1, executeMigration, initializeLegacy, seedIdentities } from "./helpers/d1-fixture.mjs";
import { cancelAssignment, createAssignment, createDefinition, scheduleWindow, scopedStores, swapAssignments, validDate } from "../app/api/_lib/scheduling.ts";
import { startEmployeeShift, ensureActiveShiftRollover, endEmployeeShift } from "../app/api/_lib/shift-rollover.ts";

const actor = { id: "manager", role: "STORE_MANAGER" };
const date = "2099-06-15";

async function fixture(t) {
  const { mf, db } = await createD1();
  t.after(() => mf.dispose());
  await initializeLegacy(db);
  await executeMigration(db, "0001_shift_scheduling.sql");
  await seedIdentities(db);
  const definitions = [];
  for (const [name, startTime, endTime] of [["Morning", "08:00", "12:00"], ["Afternoon", "12:00", "16:00"], ["Evening", "17:00", "20:00"], ["Late", "20:00", "23:00"], ["Overlap", "10:00", "14:00"], ["Night", "22:00", "03:00"], ["Dawn", "02:00", "06:00"]]) {
    definitions.push(await createDefinition(db, actor, { storeId: "s1", name, startTime, endTime }));
  }
  const assign = (employeeId, index, day = date) => createAssignment(db, actor, { storeId: "s1", employeeId, date: day, definitionId: definitions[index].id });
  const a = await assign("a", 0), b = await assign("b", 1);
  const body = { storeId: "s1", date, assignmentAId: a.id, assignmentBId: b.id, expectedVersionA: a.version, expectedVersionB: b.version, idempotencyKey: crypto.randomUUID() };
  const rows = async () => (await db.prepare("SELECT * FROM shift_assignments ORDER BY id").all()).results;
  return { db, definitions, assign, a, b, body, rows };
}

test("Vietnam date validation, half-open adjacent intervals and overnight UTC conversion", () => {
  assert.equal(validDate("2028-02-29"), "2028-02-29");
  for (const value of ["2026-02-29", "2026-02-30", "2026-13-01", "15/06/2099", "", null]) assert.throws(() => validDate(value), /Ngày/);
  assert.deepEqual(scheduleWindow("2099-06-15", "22:00", "03:00"), { start: "2099-06-15T15:00:00.000Z", end: "2099-06-15T20:00:00.000Z" });
  assert.equal(scheduleWindow(date, "08:00", "12:00").end, scheduleWindow(date, "12:00", "16:00").start);
  assert.throws(() => scheduleWindow(date, "25:00", "12:00"));
  assert.throws(() => scheduleWindow(date, "12:00", "12:00"));
});

for (const multiple of [0, 1, 2]) test(`D1 swaps exact selected pair with ${multiple} employees having multiple shifts`, async (t) => {
  const f = await fixture(t);
  if (multiple >= 1) await f.assign("a", 2);
  if (multiple === 2) await f.assign("b", 3);
  const before = await f.rows();
  const result = await swapAssignments(f.db, actor, f.body);
  assert.equal(result.assignments.length, 2);
  const after = await f.rows();
  for (const row of before) {
    const next = after.find((item) => item.id === row.id);
    if ([f.a.id, f.b.id].includes(row.id)) {
      assert.equal(next.employee_id, row.employee_id === "a" ? "b" : "a");
      assert.equal(next.version, 2);
      assert.equal(next.scheduled_start_at, row.scheduled_start_at);
      assert.equal(next.scheduled_end_at, row.scheduled_end_at);
    } else assert.deepEqual(next, row);
  }
  for (const person of ["a", "b"]) assert.equal(after.filter((r) => r.employee_id === person).length, before.filter((r) => r.employee_id === person).length);
  const audit = await f.db.prepare("SELECT * FROM audit_logs WHERE id=?").bind(result.operationId).first();
  const detail = JSON.parse(audit.detail);
  assert.equal(audit.user_id, actor.id);
  assert.equal(detail.actor.role, actor.role);
  assert.equal(detail.before.length, 2);
  assert.equal(detail.after.length, 2);
  assert.ok(detail.reason);
  assert.equal((await f.db.prepare("SELECT state FROM shift_swaps WHERE id=?").bind(result.operationId).first()).state, "DONE");
});

test("D1 retry after lost response returns saved result without reversing, different payload conflicts", async (t) => {
  const f = await fixture(t);
  const result = await swapAssignments(f.db, actor, f.body);
  const after = await f.rows();
  const retry = await swapAssignments(f.db, actor, f.body);
  assert.equal(retry.operationId, result.operationId);
  assert.deepEqual(retry.assignments, result.assignments);
  assert.equal(retry.replayed, true);
  assert.deepEqual(await f.rows(), after);
  await assert.rejects(swapAssignments(f.db, actor, { ...f.body, reason: "changed" }), (e) => e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM shift_swaps").first()).n, 1);
});

for (const fault of ["ABORT", "IGNORE"]) test(`D1 injected second UPDATE ${fault} rolls back assignments, audit and idempotency`, async (t) => {
  const f = await fixture(t);
  const before = await f.rows();
  const auditCount = (await f.db.prepare("SELECT count(*) AS n FROM audit_logs").first()).n;
  await f.db.prepare(`CREATE TRIGGER injected_update_failure BEFORE UPDATE ON shift_assignments WHEN OLD.id='${f.b.id}' BEGIN SELECT RAISE(${fault}${fault === "ABORT" ? ",'injected second update failure'" : ""}); END`).run();
  await assert.rejects(swapAssignments(f.db, actor, f.body));
  assert.deepEqual(await f.rows(), before);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM shift_swaps").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM audit_logs").first()).n, auditCount);
});

test("D1 audit insertion failure rolls back whole swap", async (t) => {
  const f = await fixture(t);
  const before = await f.rows();
  await f.db.prepare("CREATE TRIGGER injected_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='SHIFT_SWAP' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END").run();
  await assert.rejects(swapAssignments(f.db, actor, f.body));
  assert.deepEqual(await f.rows(), before);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM shift_swaps").first()).n, 0);
});

test("D1 competing swaps have one winner, stale versions cannot mutate", async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([swapAssignments(f.db, actor, f.body), swapAssignments(f.db, actor, { ...f.body, idempotencyKey: crypto.randomUUID() })]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((r) => r.status === "rejected").reason.code, "SCHEDULE_CONFLICT");
  const after = await f.rows();
  await assert.rejects(swapAssignments(f.db, actor, { ...f.body, idempotencyKey: crypto.randomUUID() }), (e) => e.status === 409);
  assert.deepEqual(await f.rows(), after);
});

test("D1 same-key concurrent requests commit once and return identical operation", async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.all([swapAssignments(f.db, actor, f.body), swapAssignments(f.db, actor, f.body)]);
  assert.equal(outcomes[0].operationId, outcomes[1].operationId);
  assert.ok((await f.rows()).every((r) => r.version === 2));
});

test("D1 invalid pairs, nonexistent IDs, different day/store and missing selections reject", async (t) => {
  const f = await fixture(t);
  const samePerson = await f.assign("a", 2);
  const otherDate = await f.assign("b", 0, "2099-06-16");
  const before = await f.rows();
  for (const patch of [{ assignmentBId: f.a.id }, { assignmentBId: samePerson.id }, { assignmentAId: "missing" }, { assignmentBId: otherDate.id }, { date: "2099-06-16" }, { storeId: "s2" }, { assignmentAId: "" }, { expectedVersionB: undefined }]) {
    await assert.rejects(swapAssignments(f.db, actor, { ...f.body, ...patch }));
  }
  assert.deepEqual(await f.rows(), before);
});

test("D1 equal-time positions are rejected as meaningless", async (t) => {
  const f = await fixture(t);
  const sameSlot = await f.assign("c", 0);
  await assert.rejects(swapAssignments(f.db, actor, { ...f.body, assignmentBId: sameSlot.id }), (e) => e.code === "SCHEDULE_NOOP");
});

for (const person of ["a", "b"]) test(`D1 checks final overlap for person ${person} and permits adjacency`, async (t) => {
  const f = await fixture(t);
  // Their current other shift is adjacent; the incoming swapped position overlaps it.
  if (person === "a") await f.assign("a", 1);
  else await f.assign("b", 0);
  const before = await f.rows();
  await assert.rejects(swapAssignments(f.db, actor, f.body), (e) => e.code === "SCHEDULE_OVERLAP");
  assert.deepEqual(await f.rows(), before);
});

test("D1 overnight overlap checks neighboring business dates", async (t) => {
  const f = await fixture(t);
  const night = await f.assign("a", 5);
  const evening = await f.assign("b", 2);
  await f.assign("b", 6, "2099-06-16");
  await assert.rejects(swapAssignments(f.db, actor, { ...f.body, assignmentAId: night.id, assignmentBId: evening.id }), (e) => e.code === "SCHEDULE_OVERLAP");
});

for (const change of ["ARCHIVED", "INACTIVE", "TRANSFERRED"]) test(`D1 employee ${change} is rechecked at commit`, async (t) => {
  const f = await fixture(t);
  if (change === "TRANSFERRED") await f.db.prepare("UPDATE employees SET store_id='s2' WHERE id='a'").run();
  else await f.db.prepare("UPDATE employees SET status=? WHERE id='a'").bind(change).run();
  await assert.rejects(swapAssignments(f.db, actor, f.body), (e) => e.code === "SCHEDULE_ELIGIBILITY");
});

test("D1 active attendance and locked period prevent scheduling mutations", async (t) => {
  const f = await fixture(t);
  await f.db.prepare("INSERT INTO shift_sessions(id,shift_code,store_id,employee_id,started_at,status) VALUES('actual','actual','s1','a',?,'ACTIVE')").bind(new Date().toISOString()).run();
  await assert.rejects(swapAssignments(f.db, actor, f.body), (e) => e.code === "SCHEDULE_STARTED");
  await f.db.prepare("UPDATE shift_sessions SET ended_at=?,status='COMPLETED' WHERE id='actual'").bind(new Date().toISOString()).run();
  await f.db.prepare("INSERT INTO business_records(id,category,store_id,title,data_json,status,created_at,updated_at) VALUES('lock','PAYROLL_PERIOD','s1','Locked','{\"month\":\"2099-06\"}','LOCKED','now','now')").run();
  await assert.rejects(swapAssignments(f.db, actor, f.body), (e) => e.code === "SCHEDULE_LOCKED");
  await assert.rejects(cancelAssignment(f.db, actor, { storeId: "s1", assignmentId: f.a.id, expectedVersion: 1 }), (e) => e.code === "SCHEDULE_LOCKED");
});

test("D1 cancellation racing swap is serialized by version and status", async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([swapAssignments(f.db, actor, f.body), cancelAssignment(f.db, actor, { storeId: "s1", assignmentId: f.a.id, expectedVersion: 1 })]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const after = await f.rows();
  assert.equal(after.length, 2);
  assert.ok(after.every((r) => r.version <= 2));
  await assert.rejects(f.db.prepare("DELETE FROM shift_assignments WHERE id=?").bind(f.a.id).run());
});

test("D1 concurrent overlap creation cannot break final schedule", async (t) => {
  const f = await fixture(t);
  await Promise.allSettled([swapAssignments(f.db, actor, f.body), f.assign("a", 1)]);
  const overlaps = await f.db.prepare("SELECT a.id FROM shift_assignments a JOIN shift_assignments b ON a.id<b.id AND a.employee_id=b.employee_id AND a.status='PLANNED' AND b.status='PLANNED' AND a.scheduled_start_at<b.scheduled_end_at AND a.scheduled_end_at>b.scheduled_start_at").all();
  assert.equal(overlaps.results.length, 0);
});

test("D1 permission and grant revocation use database role, not forged actor role", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await scopedStores(f.db, { id: "htkd", role: "HTKD" })).map((s) => s.id), ["s1"]);
  for (const who of [{ id: "employee", role: "EMPLOYEE" }, { id: "employee", role: "MANAGER" }, { id: "unknown", role: "MANAGER" }, { id: "revoked", role: "STORE_MANAGER" }]) await assert.rejects(swapAssignments(f.db, who, f.body));
  await f.db.prepare("DELETE FROM user_store_scopes WHERE user_id='manager'").run();
  await assert.rejects(swapAssignments(f.db, actor, f.body));
});

test("D1 migrations preserve legacy facts and fresh/upgraded scheduling schemas match", async (t) => {
  const { mf, db } = await createD1(); t.after(() => mf.dispose());
  await initializeLegacy(db);
  await db.prepare("INSERT INTO shift_sessions(id,shift_code,store_id,employee_id,started_at,ended_at,status) VALUES('legacy','legacy','s1','old','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z','COMPLETED')").run();
  await db.prepare("INSERT INTO business_records(id,category,store_id,title,data_json,status,created_at,updated_at) VALUES('oldpay','PAYROLL_PERIOD','s1','Old','{\"month\":\"2026-01\",\"snapshot\":{\"salary\":123}}','LOCKED','old','old')").run();
  const before = await db.prepare("SELECT * FROM shift_sessions").all();
  const payroll = await db.prepare("SELECT * FROM business_records").all();
  await executeMigration(db, "0001_shift_scheduling.sql");
  await executeMigration(db, "0001_shift_scheduling.sql");
  assert.deepEqual((await db.prepare("SELECT * FROM shift_sessions").all()).results, before.results);
  assert.deepEqual((await db.prepare("SELECT * FROM business_records").all()).results, payroll.results);
  const fresh = await createD1(); t.after(() => fresh.mf.dispose());
  await executeMigration(fresh.db, "0000_dore_initial.sql");
  await executeMigration(fresh.db, "0001_shift_scheduling.sql");
  const query = "SELECT name,type,sql FROM sqlite_master WHERE name LIKE 'shift_%' OR name LIKE 'schedule_%' OR name='user_store_scopes' ORDER BY name";
  assert.deepEqual((await fresh.db.prepare(query).all()).results, (await db.prepare(query).all()).results);
});

for (const state of ["started", "ended"]) test(`D1 wall-clock ${state} schedule cannot be swapped`, async (t) => {
  const f = await fixture(t);
  // Arrange historical fixture before reinstalling the real write guard. This is
  // test-only setup, never an application escape hatch or a mocked predicate.
  await f.db.prepare("DROP TRIGGER schedule_assignment_update").run();
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const end = new Date(Date.now() + (state === "started" ? 3_600_000 : -1_800_000)).toISOString();
  await f.db.prepare("UPDATE shift_assignments SET scheduled_start_at=?,scheduled_end_at=? WHERE id=?").bind(start, end, f.a.id).run();
  await executeMigration(f.db, "0001_shift_scheduling.sql");
  await assert.rejects(swapAssignments(f.db, actor, f.body), (e) => e.code === "SCHEDULE_STARTED");
});

test("D1 swap leaves historical orders, actual attendance and payroll snapshots byte-equivalent", async (t) => {
  const f = await fixture(t);
  await f.db.prepare("INSERT INTO shift_sessions(id,shift_code,store_id,employee_id,started_at,ended_at,status,tiktok_allowance) VALUES('history','history','s1','a','2026-01-01T00:00:00Z','2026-01-01T02:00:00Z','COMPLETED',25000)").run();
  await f.db.prepare("INSERT INTO orders(id,code,store_id,employee_id,shift_code,amount,payment_method,created_at) VALUES('order','order','s1','a','history',123456,'CASH','2026-01-01T01:00:00Z')").run();
  await f.db.prepare("INSERT INTO business_records(id,category,store_id,title,data_json,status,created_at,updated_at) VALUES('snapshot','PAYROLL_PERIOD','s1','Payroll','{\"month\":\"2026-01\",\"snapshot\":{\"salary\":123456}}','LOCKED','old','old')").run();
  const snapshot = async () => Promise.all(["orders", "shift_sessions", "business_records"].map(async (table) => (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));
  const before = await snapshot();
  await swapAssignments(f.db, actor, f.body);
  assert.deepEqual(await snapshot(), before);
});

test("D1 real attendance domain starts swapped assignment and preserves actual overtime", async (t) => {
  const f = await fixture(t);
  await swapAssignments(f.db, actor, f.body);
  const user = { id: "employee", employeeId: "a", storeId: "s1", shiftActive: 0, currentShift: null, shiftStartedAt: null };
  const started = await startEmployeeShift(user, f.db, new Date("2099-06-15T05:05:00Z"));
  assert.equal(started.shiftName, "Afternoon");
  assert.equal(started.scheduledStartAt, f.b.scheduled_start_at);
  const active = { ...user, shiftActive: 1, currentShift: started.shiftCode, shiftStartedAt: started.startedAt };
  const overtime = await ensureActiveShiftRollover(active, f.db, new Date("2099-06-15T20:00:00Z"));
  assert.equal(overtime.shiftCode, started.shiftCode);
  assert.equal(overtime.rollovers.length, 0);
  await endEmployeeShift(active, f.db, false, new Date("2099-06-15T20:00:00Z"));
  const sessions = (await f.db.prepare("SELECT * FROM shift_sessions").all()).results;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].employee_id, "a");
  assert.equal(sessions[0].started_at, "2099-06-15T05:05:00.000Z");
  assert.equal(sessions[0].ended_at, "2099-06-15T20:00:00.000Z");
  const link = await f.db.prepare("SELECT * FROM shift_assignment_sessions").first();
  assert.equal(link.assignment_id, f.b.id);
  await assert.rejects(swapAssignments(f.db, actor, { ...f.body, expectedVersionA: 2, expectedVersionB: 2, idempotencyKey: crypto.randomUUID() }), (e) => e.code === "SCHEDULE_STARTED");
});

test("D1 real start racing swap cannot attach attendance to another employee", async (t) => {
  const f = await fixture(t);
  const user = { id: "employee", employeeId: "a", storeId: "s1", shiftActive: 0, currentShift: null, shiftStartedAt: null };
  const results = await Promise.allSettled([swapAssignments(f.db, actor, f.body), startEmployeeShift(user, f.db, new Date("2099-06-15T01:05:00Z"))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const mismatch = await f.db.prepare("SELECT a.id FROM shift_assignment_sessions l JOIN shift_assignments a ON a.id=l.assignment_id JOIN shift_sessions s ON s.id=l.session_id WHERE a.employee_id!=s.employee_id OR a.scheduled_start_at!=s.scheduled_start_at").all();
  assert.equal(mismatch.results.length, 0);
  if (results[0].status === "fulfilled") assert.equal((await f.db.prepare("SELECT count(*) AS n FROM shift_sessions").first()).n, 0);
});

test("D1 lock racing swap preserves serial order and LOCKED cannot be removed by generic writes", async (t) => {
  const f = await fixture(t);
  const lock = f.db.prepare("INSERT INTO business_records(id,category,store_id,title,data_json,status,created_at,updated_at) VALUES('race-lock','PAYROLL_PERIOD','s1','Payroll','{\"month\":\"2099-06\"}','LOCKED','now','now')");
  const results = await Promise.allSettled([swapAssignments(f.db, actor, f.body), lock.run()]);
  assert.equal(results[1].status, "fulfilled");
  if (results[0].status === "fulfilled") assert.ok((await f.rows()).every((row) => row.version === 2));
  else assert.equal(results[0].reason.code, "SCHEDULE_LOCKED");
  await assert.rejects(f.db.prepare("UPDATE business_records SET status='ACTIVE' WHERE id='race-lock'").run(), /SCHEDULE_LOCKED/);
  await assert.rejects(f.db.prepare("DELETE FROM business_records WHERE id='race-lock'").run(), /SCHEDULE_LOCKED/);
  await assert.rejects(swapAssignments(f.db, actor, { ...f.body, idempotencyKey: crypto.randomUUID(), expectedVersionA: 2, expectedVersionB: 2 }));
});

test("D1 overnight attendance rejects next-month LOCKED period and rolls back users/session/link", async (t) => {
  const f = await fixture(t);
  const night = await f.assign("a", 5, "2099-06-30");
  await f.db.prepare("INSERT INTO business_records(id,category,store_id,title,data_json,status,created_at,updated_at) VALUES('july-lock','PAYROLL_PERIOD','s1','July','{\"month\":\"2099-07\"}','LOCKED','now','now')").run();
  const user = { id: "employee", employeeId: "a", storeId: "s1", shiftActive: 0, currentShift: null, shiftStartedAt: null };
  await assert.rejects(startEmployeeShift(user, f.db, new Date(night.scheduled_start_at)), /SCHEDULE_LOCKED/);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM shift_sessions").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM shift_assignment_sessions").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT shift_active FROM users WHERE id='employee'").first()).shift_active, 0);
});

test("D1 duplicate assignment and invalid foreign key do not multiply or orphan rows", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.assign("a", 0));
  await assert.rejects(f.assign("missing-employee", 3));
  assert.equal((await f.rows()).length, 2);
  assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
});
