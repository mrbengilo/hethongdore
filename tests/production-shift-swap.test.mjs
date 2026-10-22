import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Always a private, throwaway native SQLite database. No network or production
// credentials are used by this suite; route handlers run against real SQL.
const directory = await mkdtemp(join(tmpdir(), "dore-production-swap-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "fixture.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const [{ initDb }, { sha256 }, swap, route, { createSqliteDatabase }] = await Promise.all([
  import("../db/runtime.ts"), import("../app/api/_lib/auth.ts"),
  import("../app/lib/shift-swap.ts"), import("../app/api/shift-swaps/route.ts"),
  import("../db/sqlite.ts"),
]);
const db = await initDb();
const DATE = "2099-08-20";
const STAMP = "2099-01-01T00:00:00.000Z";
let serial = 0;
after(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function request(token, method = "GET", body, query = "") {
  return new Request(`http://localhost/api/shift-swaps${query}`, {
    method, headers: { "content-type": "application/json", ...(token ? { cookie: `dore_session=${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function account(f, name, role = "MANAGER", storeId = f.storeId, employeeId = null) {
  const id = `${f.prefix}-${name}`;
  await db.prepare(`INSERT INTO users (id,username,password_hash,role,name,employee_id,store_id,is_super_admin)
    VALUES (?,?,'unused',?,?,?,?,0)`).bind(id, id, role, name, employeeId, storeId).run();
  const token = `test-${id}`;
  await db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)")
    .bind(`session-${id}`, id, await sha256(token), Date.now() + 3_600_000, new Date().toISOString()).run();
  return { token, actor: { id, role, homeStoreId: storeId, isSuperAdmin: 0 } };
}

async function fixture() {
  const prefix = `swap-fixture-${++serial}`;
  const f = { prefix, storeId: `${prefix}-store`, date: DATE };
  await db.prepare("INSERT INTO stores (id,name,address,revenue,expense,status,created_at) VALUES (?,?, '',0,0,'ACTIVE',?)")
    .bind(f.storeId, f.storeId, STAMP).run();
  f.employees = {};
  for (const name of ["a", "b", "c", "d"]) {
    const id = `${prefix}-${name}`;
    await db.prepare(`INSERT INTO employees (id,store_id,code,name,position,phone,hourly_rate,tiktok_allowance,status)
      VALUES (?,?,?,?,'Sales','0900000000',20000,0,'ACTIVE')`).bind(id, f.storeId, id, `Employee ${name}`).run();
    f.employees[name] = id;
  }
  Object.assign(f, await account(f, "manager"));
  f.first = await schedule(f, "first", [f.employees.a], "08:00", "12:00");
  f.second = await schedule(f, "second", [f.employees.b], "13:00", "17:00");
  return f;
}

async function schedule(f, suffix, employeeIds, start, end, date = f.date, storeId = f.storeId) {
  const id = `${f.prefix}-schedule-${suffix}`;
  const shiftId = `${id}-definition`;
  const startAt = new Date(`${date}T${start}:00+07:00`).toISOString();
  const endTime = new Date(`${date}T${end}:00+07:00`);
  if (end <= start) endTime.setUTCDate(endTime.getUTCDate() + 1);
  const data = { date, shiftId, shiftDefinitionVersion: 1, shiftName: `Shift ${suffix}`, start, end,
    startAt, endAt: endTime.toISOString(), employeeIds, employeeNames: employeeIds.map((id) => id.split("-").at(-1)), note: "Keep this note" };
  await db.prepare(`INSERT INTO daily_shift_definitions
    (id,store_id,work_date,name,name_key,start_time,end_time,status,version,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'ACTIVE',1,?,?,?)`)
    .bind(shiftId, storeId, date, data.shiftName, data.shiftName.toLowerCase(), start, end, f.actor.id, STAMP, STAMP).run();
  await db.prepare(`INSERT INTO business_records (id,category,store_id,owner_id,title,data_json,status,created_at,updated_at)
    VALUES (?,'LICH_PHAN_CA',?,?,?,?,'ACTIVE',?,?)`)
    .bind(id, storeId, f.actor.id, data.shiftName, JSON.stringify(data), STAMP, STAMP).run();
  return id;
}

async function row(id) {
  const value = await db.prepare("SELECT * FROM business_records WHERE id=?").bind(id).first();
  return { ...value, data: JSON.parse(value.data_json) };
}

async function input(f, first = f.first, second = f.second, a = f.employees.a, b = f.employees.b) {
  const listing = await swap.listShiftSwapAssignments(db, f.actor, f.storeId, f.date);
  const left = listing.assignments.find((item) => item.recordId === first && item.employeeId === a);
  const right = listing.assignments.find((item) => item.recordId === second && item.employeeId === b);
  assert.ok(left, "first assignment must come from actual persisted schedule");
  assert.ok(right, "second assignment must come from actual persisted schedule");
  return { storeId: f.storeId, date: f.date, assignmentAId: left.id, assignmentBId: right.id,
    expectedVersionA: left.version, expectedVersionB: right.version, idempotencyKey: crypto.randomUUID(), reason: "Đổi ca theo lịch đã thống nhất" };
}

async function snapshot(f) {
  const records = await db.prepare("SELECT * FROM business_records WHERE store_id=? ORDER BY id").bind(f.storeId).all();
  const audit = await db.prepare("SELECT * FROM audit_logs WHERE store_id=? ORDER BY id").bind(f.storeId).all();
  const operations = await db.prepare("SELECT * FROM shift_swap_operations WHERE store_id=? ORDER BY id").bind(f.storeId).all();
  return JSON.stringify({ records: records.results, audit: audit.results, operations: operations.results });
}

async function rejectSwap(f, payload, status = 409) {
  const before = await snapshot(f);
  await assert.rejects(swap.commitShiftSwap(db, f.actor, payload), (error) => {
    assert.equal(error.status, status, `${error.code}: ${error.message}`);
    return true;
  });
  assert.equal(await snapshot(f), before, "rejected swap must leave records and audit unchanged");
}

test("native SQLite swaps exactly two slots, preserves unrelated assignments and immutable history", async () => {
  const f = await fixture();
  const extra = await schedule(f, "third", [f.employees.a, f.employees.c], "18:00", "21:00");
  const extraBefore = await row(extra);
  await db.prepare(`INSERT INTO shift_sessions (id,shift_code,store_id,employee_id,started_at,ended_at,status,duration_seconds)
    VALUES (?,?,?,?,?,?,'COMPLETED',14400)`).bind(`${f.prefix}-history`, `${f.prefix}-history`, f.storeId, f.employees.a,
      "2020-01-01T01:00:00.000Z", "2020-01-01T05:00:00.000Z").run();
  await db.prepare(`INSERT INTO orders (id,code,store_id,employee_id,shift_code,amount,payment_method,status,created_at)
    VALUES (?,?,?,?,?,10000,'CASH','COMPLETED',?)`).bind(`${f.prefix}-order`, `${f.prefix}-order`, f.storeId,
      f.employees.a, `${f.prefix}-history`, "2020-01-01T02:00:00.000Z").run();
  await db.prepare(`INSERT INTO employee_payroll_closings
    (id,store_id,employee_id,period,snapshot_json,employee_status_at_lock,status,locked_at,locked_by)
    VALUES (?,?,?,'2020-01','{"salary":123456,"history":"keep"}','ACTIVE','LOCKED',?,?)`)
    .bind(`${f.prefix}-payroll`, f.storeId, f.employees.a, STAMP, f.actor.id).run();
  const history = async () => JSON.stringify(await Promise.all(["shift_sessions", "orders", "employee_payroll_closings"]
    .map(async (table) => (await db.prepare(`SELECT * FROM ${table} WHERE store_id=? ORDER BY id`).bind(f.storeId).all()).results)));
  const beforeHistory = await history();
  const first = await row(f.first);
  const second = await row(f.second);
  const payload = await input(f);
  const result = await swap.commitShiftSwap(db, f.actor, payload);
  assert.ok(result.operationId);
  assert.equal(result.idempotent, false);
  assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.b]);
  assert.deepEqual((await row(f.second)).data.employeeIds, [f.employees.a]);
  for (const [id, original] of [[f.first, first], [f.second, second]]) {
    const changed = await row(id);
    for (const key of ["date", "start", "end", "startAt", "endAt", "shiftId", "shiftName", "note"]) {
      assert.deepEqual(changed.data[key], original.data[key], `${key} belongs to the shift slot`);
    }
    assert.equal(changed.created_at, original.created_at);
  }
  assert.deepEqual(await row(extra), extraBefore);
  assert.equal(await history(), beforeHistory);
  const listing = await swap.listShiftSwapAssignments(db, f.actor, f.storeId, f.date);
  assert.equal(listing.assignments.find((item) => item.id === payload.assignmentAId).employeeId, f.employees.b);
  assert.equal(listing.assignments.find((item) => item.id === payload.assignmentBId).employeeId, f.employees.a);
  const audit = await db.prepare("SELECT * FROM audit_logs WHERE store_id=?").bind(f.storeId).all();
  assert.equal(audit.results.length, 1);
  assert.equal(audit.results[0].user_id, f.actor.id);
  assert.equal(audit.results[0].reason, payload.reason);
  assert.ok(audit.results[0].before_json && audit.results[0].after_json);
});

test("multi-person rows retain every unselected occupant and stable slot identity", async () => {
  const f = await fixture();
  const multiA = await schedule(f, "multi-a", [f.employees.a, f.employees.c], "18:00", "19:00");
  const multiB = await schedule(f, "multi-b", [f.employees.b, f.employees.d], "20:00", "21:00");
  const payload = await input(f, multiA, multiB);
  await swap.commitShiftSwap(db, f.actor, payload);
  assert.deepEqual((await row(multiA)).data.employeeIds, [f.employees.b, f.employees.c]);
  assert.deepEqual((await row(multiB)).data.employeeIds, [f.employees.a, f.employees.d]);
  assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.a]);
  assert.deepEqual((await row(f.second)).data.employeeIds, [f.employees.b]);
});

test("lost response replay returns original outcome without swapping back; changed payload conflicts", async () => {
  const f = await fixture();
  const payload = await input(f);
  const original = await swap.commitShiftSwap(db, f.actor, payload);
  const after = await snapshot(f);
  const replay = await swap.commitShiftSwap(db, f.actor, payload);
  assert.equal(replay.operationId, original.operationId);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.assignments, original.assignments);
  assert.equal(await snapshot(f), after);
  await rejectSwap(f, { ...payload, reason: "Khác nội dung yêu cầu ban đầu" });
});

test("two concurrent swaps using the same version commit once", async () => {
  const f = await fixture();
  const payload = await input(f);
  const peer = await createSqliteDatabase(process.env.DORE_DATABASE_PATH);
  try {
    const results = await Promise.allSettled([
      swap.commitShiftSwap(db, f.actor, payload),
      swap.commitShiftSwap(peer, f.actor, { ...payload, idempotencyKey: crypto.randomUUID() }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
    assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.b]);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM audit_logs WHERE store_id=?").bind(f.storeId).first()).n, 1);
  } finally { peer.close(); }
});

test("concurrent same-key requests share one committed operation", async () => {
  const f = await fixture();
  const payload = await input(f);
  const results = await Promise.all([swap.commitShiftSwap(db, f.actor, payload), swap.commitShiftSwap(db, f.actor, payload)]);
  assert.equal(results[0].operationId, results[1].operationId);
  assert.equal(results.filter((r) => r.idempotent === false).length, 1);
  assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.b]);
});

for (const failure of ["ABORT", "IGNORE"]) {
  test(`second schedule UPDATE ${failure} rolls back first change, operation and audit`, async () => {
    const f = await fixture();
    const payload = await input(f);
    const before = await snapshot(f);
    const name = `reject_second_${serial}`;
    await db.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON business_records WHEN OLD.id='${f.second}'
      BEGIN SELECT RAISE(${failure}${failure === "ABORT" ? ", 'injected second update failure'" : ""}); END;`);
    try {
      await assert.rejects(swap.commitShiftSwap(db, f.actor, payload));
      assert.equal(await snapshot(f), before);
    } finally { await db.exec(`DROP TRIGGER ${name}`); }
    // The failed operation must not poison the idempotency key.
    const retry = await swap.commitShiftSwap(db, f.actor, payload);
    assert.equal(retry.idempotent, false);
    assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.b]);
  });
}

test("audit insertion failure rolls the entire swap back and allows safe retry", async () => {
  const f = await fixture();
  const payload = await input(f);
  const before = await snapshot(f);
  const name = `reject_audit_${serial}`;
  await db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs WHEN NEW.store_id='${f.storeId}'
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
  try {
    await assert.rejects(swap.commitShiftSwap(db, f.actor, payload));
    assert.equal(await snapshot(f), before);
  } finally { await db.exec(`DROP TRIGGER ${name}`); }
  assert.equal((await swap.commitShiftSwap(db, f.actor, payload)).idempotent, false);
});

test("stale record edits, deleted schedules, and forged versions cannot overwrite state", async () => {
  for (const mutation of ["edit", "delete", "version"]) {
    const f = await fixture();
    const payload = await input(f);
    if (mutation === "edit") await db.prepare("UPDATE business_records SET title='Changed by someone else',updated_at=? WHERE id=?")
      .bind("2099-01-02T00:00:00.000Z", f.first).run();
    if (mutation === "delete") await db.prepare("UPDATE business_records SET status='DELETED' WHERE id=?").bind(f.first).run();
    if (mutation === "version") payload.expectedVersionA = "forged-revision";
    await rejectSwap(f, payload);
  }
});

test("overlap is checked for each employee; adjacent shifts remain valid", async () => {
  for (const person of ["a", "b"]) {
    const f = await fixture();
    // This is disjoint from the person's current shift, but overlaps the target.
    await schedule(f, `overlap-${person}`, [f.employees[person]], person === "a" ? "14:00" : "09:00", person === "a" ? "15:00" : "10:00");
    await rejectSwap(f, await input(f));
  }
  const f = await fixture();
  await schedule(f, "adjacent", [f.employees.a], "17:00", "18:00");
  assert.equal((await swap.commitShiftSwap(db, f.actor, await input(f))).idempotent, false);
});

test("overnight overlap includes the next day and cannot bypass its locked period", async () => {
  const f = await fixture();
  const night = await schedule(f, "night", [f.employees.b], "22:00", "06:00", "2099-08-31");
  const early = await schedule(f, "day", [f.employees.a], "08:00", "12:00", "2099-08-31");
  f.date = "2099-08-31";
  await schedule(f, "next-day", [f.employees.a], "05:00", "07:00", "2099-09-01");
  await rejectSwap(f, await input(f, early, night));
  await db.prepare("UPDATE business_records SET status='DELETED' WHERE id=?").bind(`${f.prefix}-schedule-next-day`).run();
  await db.prepare(`INSERT INTO business_records (id,category,store_id,owner_id,title,data_json,status,created_at,updated_at)
    VALUES (?,'PAYROLL_CLOSING',?,?,'Locked','{"period":"2099-09"}','LOCKED',?,?)`)
    .bind(`${f.prefix}-lock`, f.storeId, f.actor.id, STAMP, STAMP).run();
  await rejectSwap(f, await input(f, early, night));
});

test("same person, same slot, same interval, and cross-date/cross-store inputs are rejected", async () => {
  const f = await fixture();
  const payload = await input(f);
  await assert.rejects(swap.commitShiftSwap(db, f.actor, { ...payload, assignmentBId: payload.assignmentAId, expectedVersionB: payload.expectedVersionA }));
  const own = await schedule(f, "own", [f.employees.a], "18:00", "20:00");
  await assert.rejects(swap.commitShiftSwap(db, f.actor, await input(f, f.first, own, f.employees.a, f.employees.a)));
  const same = await schedule(f, "same", [f.employees.b], "08:00", "12:00");
  await assert.rejects(swap.commitShiftSwap(db, f.actor, await input(f, f.first, same)));
  await rejectSwap(f, { ...payload, date: "2099-08-21" });
  const other = await fixture();
  const foreign = await input(other);
  await assert.rejects(swap.commitShiftSwap(db, f.actor, { ...payload, assignmentBId: foreign.assignmentBId, expectedVersionB: foreign.expectedVersionB }));
});

test("revoked manager scope, inactive employees and inactive stores fail at commit", async () => {
  for (const change of ["scope", "employee", "store"]) {
    const f = await fixture();
    const payload = await input(f);
    if (change === "scope") await db.prepare("UPDATE users SET store_id='different-store' WHERE id=?").bind(f.actor.id).run();
    if (change === "employee") await db.prepare("UPDATE employees SET status='INACTIVE' WHERE id=?").bind(f.employees.a).run();
    if (change === "store") await db.prepare("UPDATE stores SET status='INACTIVE' WHERE id=?").bind(f.storeId).run();
    const before = await snapshot(f);
    await assert.rejects(swap.commitShiftSwap(db, f.actor, payload));
    assert.equal(await snapshot(f), before);
  }
});

test("an actual session referencing a selected schedule prevents swapping history", async () => {
  const f = await fixture();
  const payload = await input(f);
  await db.prepare(`INSERT INTO shift_sessions
    (id,shift_code,store_id,employee_id,started_at,status,work_date,source_schedule_record_id,source_schedule_updated_at)
    VALUES (?,?,?,?,?,'ACTIVE',?,?,?)`).bind(`${f.prefix}-actual`, `${f.prefix}-actual`, f.storeId,
      f.employees.a, new Date().toISOString(), f.date, f.first, STAMP).run();
  await rejectSwap(f, payload);
});

test("API authenticates actors, rejects employee/unsupported roles and scopes all listing data", async () => {
  const f = await fixture();
  const other = await fixture();
  const payload = await input(f);
  assert.equal((await route.GET(request(null, "GET", undefined, `?storeId=${f.storeId}&date=${f.date}`))).status, 401);
  assert.equal((await route.POST(request(null, "POST", payload))).status, 401);
  const employee = await account(f, "employee-login", "EMPLOYEE", f.storeId, f.employees.a);
  const unknown = await account(f, "unsupported", "UNSUPPORTED");
  assert.equal((await route.POST(request(employee.token, "POST", payload))).status, 403);
  assert.equal((await route.GET(request(employee.token, "GET", undefined, `?storeId=${f.storeId}&date=${f.date}`))).status, 403);
  assert.ok([401, 403].includes((await route.POST(request(unknown.token, "POST", payload))).status));
  assert.ok([401, 403].includes((await route.GET(request(unknown.token, "GET", undefined, `?storeId=${f.storeId}&date=${f.date}`))).status));
  const outside = await route.GET(request(f.token, "GET", undefined, `?storeId=${other.storeId}&date=${f.date}`));
  assert.equal(outside.status, 403);
  const denied = await outside.text();
  assert.ok(!denied.includes(other.employees.a));
  const allowed = await route.GET(request(f.token, "GET", undefined, `?storeId=${f.storeId}&date=${f.date}`));
  assert.equal(allowed.status, 200);
  const listing = await allowed.json();
  assert.ok(listing.employees.every((person) => Object.values(f.employees).includes(person.id)));
  assert.ok(listing.assignments.every((item) => [f.first, f.second].includes(item.recordId)));
  // Actor/role in the body never overrides the authenticated session.
  assert.equal((await route.POST(request(employee.token, "POST", { ...payload, actorId: f.actor.id, role: "MANAGER" }))).status, 403);
  const committed = await route.POST(request(f.token, "POST", { ...payload, actorId: "attacker" }));
  assert.ok([200, 201].includes(committed.status), await committed.text());
  const audit = await db.prepare("SELECT user_id FROM audit_logs WHERE store_id=?").bind(f.storeId).all();
  assert.deepEqual(audit.results.map((entry) => entry.user_id), [f.actor.id]);
});

test("HTKD grants allow only assigned schedule stores and never open legacy administrative APIs", async () => {
  const f = await fixture();
  const other = await fixture();
  const htkd = await account(f, "htkd", "HTKD", null);
  await db.prepare("INSERT INTO schedule_store_grants (user_id,store_id) VALUES (?,?)").bind(htkd.actor.id, f.storeId).run();
  const allowed = await route.GET(request(htkd.token, "GET", undefined, `?storeId=${f.storeId}&date=${f.date}`));
  assert.equal(allowed.status, 200);
  const denied = await route.GET(request(htkd.token, "GET", undefined, `?storeId=${other.storeId}&date=${f.date}`));
  assert.equal(denied.status, 403);
  assert.ok(!(await denied.text()).includes(other.employees.a));
  const payload = await input(f);
  assert.ok([200, 201].includes((await route.POST(request(htkd.token, "POST", payload))).status));
  for (const path of ["payroll", "stores", "shifts", "orders", "records", "employees", "cashflow", "reports", "store-cashflow", "transfers"]) {
    const legacy = await import(`../app/api/${path}/route.ts`);
    for (const method of ["GET", "POST", "PATCH", "DELETE"].filter((method) => typeof legacy[method] === "function")) {
      const response = await legacy[method](new Request(`http://localhost/api/${path}?storeId=${f.storeId}&category=LICH_PHAN_CA`, {
        method, headers: { cookie: `dore_session=${htkd.token}`, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ storeId: f.storeId, category: "LICH_PHAN_CA", id: f.first }) }),
      }));
      assert.ok([401, 403].includes(response.status), `${method} ${path} exposed status ${response.status} to HTKD`);
    }
  }
  await db.prepare("DELETE FROM schedule_store_grants WHERE user_id=?").bind(htkd.actor.id).run();
  assert.equal((await route.GET(request(htkd.token, "GET", undefined, `?storeId=${f.storeId}&date=${f.date}`))).status, 403);
  // A replay still checks authorization rather than returning a cached result
  // to someone whose store grant was revoked.
  assert.equal((await route.POST(request(htkd.token, "POST", payload))).status, 403);
});

test("HTKD login redirects to scheduling; unsupported roles cannot obtain a fresh session", async () => {
  const { hashPassword } = await import("../app/api/_lib/auth.ts");
  const login = await import("../app/api/auth/login/route.ts");
  const f = await fixture();
  const htkd = await account(f, "htkd-login", "HTKD", null);
  const invalid = await account(f, "invalid-login", "UNSUPPORTED", null);
  const password = "Test-only-not-production-24!";
  const encoded = await hashPassword(password);
  await db.prepare("UPDATE users SET password_hash=? WHERE id IN (?,?)").bind(encoded, htkd.actor.id, invalid.actor.id).run();
  const response = await login.POST(new Request("http://localhost/api/auth/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ username: htkd.actor.id, password }) }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.redirect, "/scheduling");
  assert.match(response.headers.get("set-cookie"), /dore_session=/);
  const before = (await db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id=?").bind(invalid.actor.id).first()).n;
  const rejected = await login.POST(new Request("http://localhost/api/auth/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ username: invalid.actor.id, password }) }));
  assert.equal(rejected.status, 403);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id=?").bind(invalid.actor.id).first()).n, before);
});

test("legacy LOCKED and canonical finalized periods both block swap without altering their snapshots", async () => {
  for (const status of ["LEGACY", "CONFIRMED", "PAID", "LOCKED"]) {
    const f = await fixture();
    const payload = await input(f);
    if (status === "LEGACY") {
      await db.prepare(`INSERT INTO business_records (id,category,store_id,owner_id,title,data_json,status,created_at,updated_at)
        VALUES (?,'PAYROLL_CLOSING',?,?,'Locked','{"period":"2099-08","historicalAmount":234567}','LOCKED',?,?)`)
        .bind(`${f.prefix}-lock`, f.storeId, f.actor.id, STAMP, STAMP).run();
    } else {
      await finalizePeriod(f, status);
    }
    await rejectSwap(f, payload);
  }
});

async function finalizePeriod(f, status = "LOCKED") {
  const policyId = `${f.prefix}-policy`;
  const id = `${f.prefix}-period`;
  await db.prepare(`INSERT INTO financial_policy_versions (id,version,effective_from_period,policy_json,created_by,created_at)
    VALUES (?,?,'2099-08','{}',?,?)`).bind(policyId, 100000 + serial, f.actor.id, STAMP).run();
  await db.prepare(`INSERT INTO financial_periods (id,store_id,period,status,policy_version_id,config_version,created_at,updated_at)
    VALUES (?,?,'2099-08','DRAFT',?,1,?,?)`).bind(id, f.storeId, policyId, STAMP, STAMP).run();
  await db.prepare(`UPDATE financial_periods SET status='CALCULATED',revision=1,calculated_at=?,calculated_by=?,snapshot_json='{"schemaVersion":1}' WHERE id=?`)
    .bind(STAMP, f.actor.id, id).run();
  await db.prepare("UPDATE financial_periods SET status='RECONCILING',revision=2 WHERE id=?").bind(id).run();
  await db.prepare(`UPDATE financial_periods SET status='CONFIRMED',revision=3,confirmed_at=?,confirmed_by=?,
    snapshot_json=json_set(snapshot_json,'$.status','CONFIRMED') WHERE id=?`).bind(STAMP, f.actor.id, id).run();
  if (status === "CONFIRMED") return;
  await db.prepare(`UPDATE financial_periods SET status='PAID',revision=4,paid_at=?,paid_by=?,
    snapshot_json=json_set(snapshot_json,'$.status','PAID','$.paidAt',?,'$.paidBy',?) WHERE id=?`)
    .bind(STAMP, f.actor.id, STAMP, f.actor.id, id).run();
  if (status === "PAID") return;
  await db.prepare(`UPDATE financial_periods SET status='LOCKED',revision=5,locked_at=?,locked_by=?,
    snapshot_json=json_set(snapshot_json,'$.status','LOCKED','$.lockedAt',?,'$.lockedBy',?) WHERE id=?`)
    .bind(STAMP, f.actor.id, STAMP, f.actor.id, id).run();
}

test("employee transfer authorization is revalidated for the destination shift", async () => {
  const f = await fixture();
  const outside = await fixture();
  // A historical schedule remains visible after an employee moves, but does
  // not authorize swapping that employee into a different shift.
  await db.prepare("UPDATE employees SET store_id=? WHERE id=?").bind(outside.storeId, f.employees.a).run();
  await rejectSwap(f, await input(f));
  await db.prepare(`INSERT INTO employee_transfers
    (id,employee_id,source_store_id,target_store_id,start_date,end_date,shifts_json,support_hourly_rate,support_allowance,reason,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'["Shift first"]',20000,0,'Support testing','SCHEDULED',?,?,?)`)
    .bind(`${f.prefix}-transfer`, f.employees.a, outside.storeId, f.storeId, f.date, f.date, f.actor.id, STAMP, STAMP).run();
  await rejectSwap(f, await input(f));
  await db.prepare("UPDATE employee_transfers SET shifts_json='[\"Cả ngày\"]' WHERE id=?").bind(`${f.prefix}-transfer`).run();
  assert.equal((await swap.commitShiftSwap(db, f.actor, await input(f))).idempotent, false);
});

// The hook schedules a real competing SQL commit after all application reads,
// immediately before the operation's INSERT obtains the SQLite write lock.
// It does not fake query results or transaction success.
function interceptSwapInsert(connection, before, afterCommit) {
  function wrap(statement) {
    return {
      bind(...values) { return wrap(statement.bind(...values)); },
      async run() {
        if (before) await before();
        const result = await statement.run();
        if (afterCommit) await afterCommit();
        return result;
      },
    };
  }
  return {
    prepare(sql) {
      const statement = connection.prepare(sql);
      return /^\s*INSERT\s+INTO\s+shift_swap_operations/iu.test(sql) ? wrap(statement) : statement;
    },
    batch: (statements) => connection.batch(statements),
    exec: (sql) => connection.exec(sql),
  };
}

test("a transport error after the SQL commit recovers the durable result", async () => {
  const f = await fixture();
  const payload = await input(f);
  const interrupted = interceptSwapInsert(db, null, () => { throw new Error("connection lost after commit"); });
  const recovered = await swap.commitShiftSwap(interrupted, f.actor, payload);
  assert.equal(recovered.idempotent, true);
  assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.b]);
  const replay = await swap.commitShiftSwap(db, f.actor, payload);
  assert.equal(replay.operationId, recovered.operationId);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM shift_swap_operations WHERE store_id=?").bind(f.storeId).first()).n, 1);
});

for (const competitor of ["edit", "delete", "overlap", "attendance", "lock", "scope", "employee"]) {
  test(`a competing ${competitor} committed between validation and write wins safely`, async () => {
    const f = await fixture();
    const payload = await input(f);
    const peer = await createSqliteDatabase(process.env.DORE_DATABASE_PATH);
    let afterWriter;
    const raced = interceptSwapInsert(db, async () => {
      if (competitor === "edit") await peer.prepare("UPDATE business_records SET title='Competing edit',updated_at=? WHERE id=?")
        .bind("2099-01-03T00:00:00.000Z", f.first).run();
      if (competitor === "delete") await peer.prepare("UPDATE business_records SET status='DELETED' WHERE id=?").bind(f.first).run();
      if (competitor === "overlap") await schedule(f, "racing-overlap", [f.employees.a], "14:00", "15:00");
      if (competitor === "attendance") await peer.prepare(`INSERT INTO shift_sessions
        (id,shift_code,store_id,employee_id,started_at,status,work_date,source_schedule_record_id,source_schedule_updated_at)
        VALUES (?,?,?,?,?,'ACTIVE',?,?,?)`).bind(`${f.prefix}-racing-actual`, `${f.prefix}-racing-actual`, f.storeId,
          f.employees.a, new Date().toISOString(), f.date, f.first, STAMP).run();
      if (competitor === "lock") await finalizePeriod(f, "LOCKED");
      if (competitor === "scope") await peer.prepare("UPDATE users SET store_id='unrelated-store' WHERE id=?").bind(f.actor.id).run();
      if (competitor === "employee") await peer.prepare("UPDATE employees SET status='INACTIVE' WHERE id=?").bind(f.employees.b).run();
      afterWriter = await snapshot(f);
    });
    try {
      await assert.rejects(swap.commitShiftSwap(raced, f.actor, payload), (error) => {
        assert.ok([403, 409].includes(error.status), `${competitor}: ${error.code}/${error.status}`);
        return true;
      });
      assert.ok(afterWriter, "competing write must really execute after application validation");
      assert.equal(await snapshot(f), afterWriter);
    } finally { peer.close(); }
  });
}

test("if swap wins first, a following overlapping schedule INSERT is rejected by the database", async () => {
  const f = await fixture();
  await swap.commitShiftSwap(db, f.actor, await input(f));
  const before = await snapshot(f);
  await assert.rejects(schedule(f, "too-late-overlap", [f.employees.a], "14:00", "15:00"), /SCHEDULE_OVERLAP/u);
  assert.equal(await snapshot(f), before);
});

test("overlap checks include a schedule in another store", async () => {
  const f = await fixture();
  const other = await fixture();
  await schedule(f, "other-store", [f.employees.a], "14:00", "15:00", f.date, other.storeId);
  await rejectSwap(f, await input(f));
});

test("audit IGNORE cannot commit changed assignments without audit", async () => {
  const f = await fixture();
  const payload = await input(f);
  const before = await snapshot(f);
  const name = `ignore_audit_${serial}`;
  await db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs WHEN NEW.store_id='${f.storeId}'
    BEGIN SELECT RAISE(IGNORE); END;`);
  try {
    await assert.rejects(swap.commitShiftSwap(db, f.actor, payload));
    assert.equal(await snapshot(f), before);
  } finally { await db.exec(`DROP TRIGGER ${name}`); }
});

test("additive upgrade preserves all legacy rows and supports swaps without rewriting legacy slots", async () => {
  const f = await fixture();
  const payload = await input(f);
  const { shiftSwapStatements } = await import("../db/shift-swap.ts");
  const upgradePath = join(directory, "legacy-upgrade.sqlite");
  await db.prepare("VACUUM INTO ?").bind(upgradePath).run();
  const upgraded = await createSqliteDatabase(upgradePath);
  try {
    // Reconstruct the pre-feature database by removing only this additive
    // migration's objects from a populated full production-schema fixture.
    // Existing production tables, constraints, financial triggers and rows stay.
    const additions = shiftSwapStatements.map((sql) => {
      const match = sql.match(/^CREATE (TABLE|TRIGGER|INDEX) IF NOT EXISTS (\w+)/u);
      assert.ok(match, "migration must declare an explicit additive object");
      return { type: match[1], name: match[2] };
    });
    for (const type of ["TRIGGER", "INDEX", "TABLE"]) {
      for (const object of additions.filter((item) => item.type === type)) {
        await upgraded.exec(`DROP ${type} IF EXISTS ${object.name}`);
      }
    }
    const legacyTables = (await upgraded.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
    const allLegacyRows = async () => JSON.stringify(await Promise.all(legacyTables.map(async ({ name }) => ({
      table: name,
      rows: (await upgraded.prepare(`SELECT * FROM "${name}"`).all()).results.map((item) => JSON.stringify(item)).sort(),
    }))));
    const before = await allLegacyRows();
    for (let application = 0; application < 2; application++) {
      await upgraded.batch(shiftSwapStatements.map((sql) => upgraded.prepare(sql)));
      assert.equal(await allLegacyRows(), before, "upgrade and repeated initialization must not rewrite existing rows");
    }
    const schema = async (connection) => (await connection.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()).results;
    assert.deepEqual(await schema(upgraded), await schema(db), "fresh and upgraded schemas must converge");
    const result = await swap.commitShiftSwap(upgraded, f.actor, payload);
    assert.equal(result.idempotent, false);
    const changed = await upgraded.prepare("SELECT data_json FROM business_records WHERE id=?").bind(f.first).first();
    assert.deepEqual(JSON.parse(changed.data_json).employeeIds, [f.employees.b]);
    assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.a], "upgrade rehearsal must remain isolated");
  } finally { upgraded.close(); }
});

test("past dates and shifts that have started cannot be swapped even with fresh versions", async () => {
  const f = await fixture();
  f.date = "2020-01-01";
  f.first = await schedule(f, "past-first", [f.employees.a], "08:00", "12:00");
  f.second = await schedule(f, "past-second", [f.employees.b], "13:00", "17:00");
  await rejectSwap(f, await input(f));
  const current = await fixture();
  const payload = await input(current);
  // Application time is just after the first shift's boundary; the second is
  // still future. One started side must invalidate the complete operation.
  const before = await snapshot(current);
  await assert.rejects(swap.commitShiftSwap(db, current.actor, payload, new Date(`${current.date}T08:00:00+07:00`)), (error) => error.status === 409);
  assert.equal(await snapshot(current), before);
});

test("legacy schedule edit and delete clients cannot overwrite a swap with missing or stale revisions", async () => {
  const f = await fixture();
  const records = await import("../app/api/records/route.ts");
  const old = await row(f.first);
  await swap.commitShiftSwap(db, f.actor, await input(f));
  const before = await snapshot(f);
  for (const expectedUpdatedAt of [undefined, old.updated_at]) {
    const edit = await records.PATCH(request(f.token, "PATCH", {
      id: f.first, data: old.data, title: old.title, expectedUpdatedAt, reason: "An obsolete editing window",
    }));
    assert.equal(edit.status, 409, await edit.text());
    const query = new URLSearchParams({ id: f.first, reason: "An obsolete deletion window" });
    if (expectedUpdatedAt) query.set("expectedUpdatedAt", expectedUpdatedAt);
    const deletion = await records.DELETE(request(f.token, "DELETE", undefined, `?${query}`));
    assert.equal(deletion.status, 409, await deletion.text());
    assert.equal(await snapshot(f), before);
  }
});

test("ordinary schedule edits preserve stable identities across occupant insertion and reordering", async () => {
  const f = await fixture();
  const records = await import("../app/api/records/route.ts");
  const payload = await input(f);
  await swap.commitShiftSwap(db, f.actor, payload);
  let current = await row(f.first);
  const bSlot = current.data.assignmentIds[0];
  for (const employeeIds of [[f.employees.b, f.employees.c], [f.employees.c, f.employees.b]]) {
    const response = await records.PATCH(request(f.token, "PATCH", {
      id: f.first, data: { ...current.data, employeeIds }, title: current.title,
      expectedUpdatedAt: current.updated_at, reason: "Adjust additional team coverage",
    }));
    assert.equal(response.status, 200, await response.text());
    current = await row(f.first);
    assert.equal(current.data.assignmentIds[current.data.employeeIds.indexOf(f.employees.b)], bSlot);
    assert.equal(new Set(current.data.assignmentIds).size, 2);
  }
  const listing = await swap.listShiftSwapAssignments(db, f.actor, f.storeId, f.date);
  assert.equal(listing.assignments.find((assignment) => assignment.id === bSlot).employeeId, f.employees.b);
  await rejectSwap(f, { ...payload, idempotencyKey: crypto.randomUUID() });
});

test("actual attendance preview rejects obsolete confirmation and starts swapped assignment", async (context) => {
  const f = await fixture();
  const attendance = await import("../app/api/shift/route.ts");
  const a = await account(f, "attendance-a", "EMPLOYEE", f.storeId, f.employees.a);
  const b = await account(f, "attendance-b", "EMPLOYEE", f.storeId, f.employees.b);
  const now = new Date(`${DATE}T07:55:00+07:00`).getTime();
  await db.prepare("UPDATE sessions SET expires_at=? WHERE user_id IN (?,?)")
    .bind(now + 3600_000, a.actor.id, b.actor.id).run();
  context.mock.timers.enable({ apis: ["Date"], now });
  const preview = await attendance.GET(request(a.token, "GET", undefined, "?preview=start"));
  assert.equal(preview.status, 200);
  const oldCandidate = (await preview.json()).startCandidates[0];
  assert.equal(oldCandidate.scheduledStart, "08:00");
  await swap.commitShiftSwap(db, f.actor, await input(f));
  const location = { latitude: 10.8, longitude: 106.7, accuracyMeters: 10, capturedAt: new Date().toISOString() };
  const obsolete = await attendance.POST(request(a.token, "POST", {
    action: "start", expectedStart: oldCandidate, clockInLocation: location,
  }));
  assert.equal(obsolete.status, 409);
  const newPreview = await attendance.GET(request(b.token, "GET", undefined, "?preview=start"));
  assert.equal(newPreview.status, 200);
  const candidate = (await newPreview.json()).startCandidates[0];
  assert.equal(candidate.scheduledStart, "08:00");
  const started = await attendance.POST(request(b.token, "POST", {
    action: "start", expectedStart: candidate, clockInLocation: location,
  }));
  assert.equal(started.status, 200, await started.text());
  const session = await db.prepare("SELECT * FROM shift_sessions WHERE employee_id=?").bind(f.employees.b).first();
  assert.equal(session.source_schedule_record_id, f.first);
  assert.equal(session.source_schedule_updated_at, (await row(f.first)).updated_at);
  assert.equal(session.scheduled_start, "08:00");
  assert.equal(session.applied_hourly_rate, 20000);
  assert.equal(await db.prepare("SELECT 1 FROM shift_sessions WHERE employee_id=?").bind(f.employees.a).first(), null);
  await rejectSwap(f, await input(f, f.first, f.second, f.employees.b, f.employees.a));
});

test("cross-session actor assertion rejects even another authorized manager", async () => {
  const f = await fixture();
  const other = await account(f, "other-manager");
  const payload = { ...await input(f), expectedActorId: f.actor.id };
  const before = await snapshot(f);
  const response = await route.POST(request(other.token, "POST", payload));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "ACTOR_CHANGED");
  assert.equal(await snapshot(f), before);
});

test("swap winning after attendance validation invalidates pending clock-in transaction", async (context) => {
  const f = await fixture();
  const attendance = await import("../app/api/shift/route.ts");
  const a = await account(f, "racing-attendance-a", "EMPLOYEE", f.storeId, f.employees.a);
  const now = new Date(`${DATE}T07:55:00+07:00`).getTime();
  await db.prepare("UPDATE sessions SET expires_at=? WHERE user_id=?").bind(now + 3600_000, a.actor.id).run();
  context.mock.timers.enable({ apis: ["Date"], now });
  const preview = await attendance.GET(request(a.token, "GET", undefined, "?preview=start"));
  assert.equal(preview.status, 200);
  const candidate = (await preview.json()).startCandidates[0];
  const payload = await input(f);
  const batch = db.batch.bind(db);
  let intercepted = false;
  db.batch = async (statements) => {
    if (!intercepted) {
      intercepted = true;
      await swap.commitShiftSwap(db, f.actor, payload);
    }
    return batch(statements);
  };
  try {
    const result = await attendance.POST(request(a.token, "POST", {
      action: "start", expectedStart: candidate,
      clockInLocation: { latitude: 10.8, longitude: 106.7, accuracyMeters: 10, capturedAt: new Date().toISOString() },
    }));
    assert.equal(result.status, 409, await result.text());
    assert.ok(intercepted, "real attendance transaction must have raced with swap");
    assert.equal(await db.prepare("SELECT 1 FROM shift_sessions WHERE employee_id=?").bind(f.employees.a).first(), null);
    assert.equal((await db.prepare("SELECT shift_active FROM users WHERE id=?").bind(a.actor.id).first()).shift_active, 0);
    assert.deepEqual((await row(f.first)).data.employeeIds, [f.employees.b]);
    assert.equal((await db.prepare("SELECT count(*) n FROM audit_logs WHERE store_id=? AND action='SHIFT_START'").bind(f.storeId).first()).n, 0);
  } finally { db.batch = batch; }
});

test("midnight exclusive endpoint does not touch a locked following month", async () => {
  const f = await fixture();
  f.date = "2099-08-31";
  f.first = await schedule(f, "month-last-morning", [f.employees.a], "08:00", "12:00");
  f.second = await schedule(f, "month-last-night", [f.employees.b], "20:00", "00:00");
  await db.prepare(`INSERT INTO business_records (id,category,store_id,owner_id,title,data_json,status,created_at,updated_at)
    VALUES (?,'PAYROLL_CLOSING',?,?,'Locked','{"period":"2099-09"}','LOCKED',?,?)`)
    .bind(`${f.prefix}-next-period`, f.storeId, f.actor.id, STAMP, STAMP).run();
  const listing = await swap.listShiftSwapAssignments(db, f.actor, f.storeId, f.date);
  assert.ok(listing.assignments.every((assignment) => assignment.eligible));
  await swap.commitShiftSwap(db, f.actor, await input(f));
  assert.deepEqual((await row(f.second)).data.employeeIds, [f.employees.a]);
});

test("same-millisecond ordinary schedule edit advances the client revision", async (context) => {
  const f = await fixture();
  const records = await import("../app/api/records/route.ts");
  const before = await row(f.first);
  const now = Date.parse(STAMP);
  await db.prepare("UPDATE sessions SET expires_at=? WHERE user_id=?").bind(now + 3600_000, f.actor.id).run();
  context.mock.timers.enable({ apis: ["Date"], now });
  const payload = { id: f.first, data: { ...before.data, note: "New note" }, title: before.title,
    expectedUpdatedAt: before.updated_at, reason: "Update note without changing assignment" };
  assert.equal((await records.PATCH(request(f.token, "PATCH", payload))).status, 200);
  assert.notEqual((await row(f.first)).updated_at, before.updated_at);
  assert.equal((await records.PATCH(request(f.token, "PATCH", payload))).status, 409);
});

test("completed operation and swap audit remain immutable without blocking ordinary audit entries", async () => {
  const f = await fixture();
  const result = await swap.commitShiftSwap(db, f.actor, await input(f));
  const before = await snapshot(f);
  for (const sql of [
    "UPDATE shift_swap_operations SET reason='changed' WHERE id=?",
    "DELETE FROM shift_swap_operations WHERE id=?",
    "UPDATE audit_logs SET reason='changed' WHERE entity_id=? AND action='SWAP_SCHEDULE'",
    "DELETE FROM audit_logs WHERE entity_id=? AND action='SWAP_SCHEDULE'",
  ]) {
    await assert.rejects(db.prepare(sql).bind(result.operationId).run(), /SWAP_(AUDIT_)?IMMUTABLE/u);
    assert.equal(await snapshot(f), before);
  }
  await db.prepare("INSERT INTO audit_logs (id,user_id,action,entity_type,entity_id,detail,created_at) VALUES (?,?,'OTHER','TEST',?,'example',?)")
    .bind(`${f.prefix}-other-audit`, f.actor.id, f.storeId, STAMP).run();
  await db.prepare("DELETE FROM audit_logs WHERE id=?").bind(`${f.prefix}-other-audit`).run();
});

test("existing sessions immediately follow role changes and scheduling grants; logout revokes HTKD token", async () => {
  const f = await fixture();
  const other = await fixture();
  const me = await import("../app/api/auth/me/route.ts");
  const logout = await import("../app/api/auth/logout/route.ts");
  const stores = await import("../app/api/stores/route.ts");
  const payload = await input(f);
  await db.prepare("UPDATE users SET role='HTKD',is_super_admin=1 WHERE id=?").bind(f.actor.id).run();
  const identity = await me.GET(request(f.token));
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).user.role, "HTKD");
  assert.equal((await stores.GET(request(f.token))).status, 401);
  let visible = await route.GET(request(f.token, "GET", undefined, "?stores=1"));
  assert.deepEqual((await visible.json()).stores, [], "old manager homeStoreId and super-admin bit cannot authorize HTKD");
  assert.equal((await route.POST(request(f.token, "POST", payload))).status, 403);
  await db.prepare("INSERT INTO schedule_store_grants (user_id,store_id) VALUES (?,?)").bind(f.actor.id, f.storeId).run();
  visible = await route.GET(request(f.token, "GET", undefined, "?stores=1"));
  assert.deepEqual((await visible.json()).stores.map((store) => store.id), [f.storeId]);
  assert.equal((await route.GET(request(f.token, "GET", undefined, `?storeId=${other.storeId}&date=${f.date}`))).status, 403);
  await db.prepare("UPDATE users SET role='EMPLOYEE',employee_id=?,is_super_admin=0 WHERE id=?").bind(f.employees.a, f.actor.id).run();
  assert.equal((await route.POST(request(f.token, "POST", payload))).status, 403);
  await db.prepare("UPDATE users SET role='HTKD',employee_id=NULL WHERE id=?").bind(f.actor.id).run();
  assert.equal((await logout.POST(request(f.token, "POST", {}))).status, 200);
  assert.equal((await me.GET(request(f.token))).status, 401);
  assert.equal((await route.POST(request(f.token, "POST", payload))).status, 401);
});
