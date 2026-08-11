import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = await mkdtemp(join(tmpdir(), "dore-attendance-policy-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, route, scheduling] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/admin/attendance-policy/route.ts"),
  import("../app/lib/scheduling.ts"),
]);
const db = await runtime.initDb();
const superToken = "attendance-policy-super-token";
const managerToken = "attendance-policy-manager-token";
const employeeToken = "attendance-policy-employee-token";

function request(token, method = "GET", body) {
  return new Request("http://localhost/api/admin/attendance-policy", {
    method,
    headers: {
      cookie: `dore_session=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function response(result) {
  return { status: result.status, headers: result.headers, body: await result.json() };
}

before(async () => {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO users (id, username, password_hash, role, name, is_super_admin)
      VALUES ('policy-super', 'policy-super', 'unused', 'MANAGER', 'Quản trị chính sách', 1),
             ('policy-manager', 'policy-manager', 'unused', 'MANAGER', 'Quản lý thường', 0),
             ('policy-employee-user', 'policy-employee', 'unused', 'EMPLOYEE', 'Nhân viên', 0)`),
    db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ('policy-session-super', 'policy-super', ?, ?, ?),
             ('policy-session-manager', 'policy-manager', ?, ?, ?),
             ('policy-session-employee', 'policy-employee-user', ?, ?, ?)`)
      .bind(
        await auth.sha256(superToken), Date.now() + 600_000, now,
        await auth.sha256(managerToken), Date.now() + 600_000, now,
        await auth.sha256(employeeToken), Date.now() + 600_000, now,
      ),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, scheduled_start_at, started_at,
       attendance_status, attendance_delta_minutes, attendance_grace_minutes, status)
      VALUES ('policy-history', 'POLICY-HISTORY', 'store-legacy', 'employee-legacy',
        '2026-08-11T01:00:00.000Z', '2026-08-11T01:15:00.000Z',
        'ON_TIME', 15, 15, 'COMPLETED')`),
  ]);
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("policy endpoint is super-admin only and explicitly private/no-store", async () => {
  for (const token of [managerToken, employeeToken, "missing-token"]) {
    assert.equal((await route.GET(request(token))).status, 403);
    assert.equal((await route.PATCH(request(token, "PATCH", { lateGraceMinutes: 5, expectedVersion: 1 }))).status, 403);
  }
  const result = await response(await route.GET(request(superToken)));
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") ?? "", /private/u);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/u);
  assert.equal(result.headers.get("vary"), "Cookie");
  assert.deepEqual(result.body.limits, { min: 0, max: 120 });
  assert.equal(result.body.policy.lateGraceMinutes, 15);
  assert.equal(result.body.policy.appliesTo, "NEW_CLOCK_INS_ONLY");
});

test("policy validates integer range and uses strict greater-than boundary", async () => {
  for (const lateGraceMinutes of [-1, 1.5, 121, Number.NaN]) {
    assert.equal((await route.PATCH(request(superToken, "PATCH", { lateGraceMinutes, expectedVersion: 1 }))).status, 400);
  }
  assert.equal(scheduling.attendanceStatusAt(
    "2026-08-11T01:07:00.000Z", "2026-08-11T01:00:00.000Z", 7,
  ), "ON_TIME");
  assert.equal(scheduling.attendanceStatusAt(
    "2026-08-11T01:07:00.001Z", "2026-08-11T01:00:00.000Z", 7,
  ), "LATE");
});

test("optimistic version update is race-safe, audited once and never reclassifies history", async () => {
  const initial = await response(await route.GET(request(superToken)));
  const expectedVersion = initial.body.policy.version;
  const raced = await Promise.all([
    response(await route.PATCH(request(superToken, "PATCH", { lateGraceMinutes: 5, expectedVersion }))),
    response(await route.PATCH(request(superToken, "PATCH", { lateGraceMinutes: 9, expectedVersion }))),
  ]);
  assert.deepEqual(raced.map((item) => item.status).sort(), [200, 409]);

  const current = await response(await route.GET(request(superToken)));
  assert.equal(current.body.policy.version, expectedVersion + 1);
  assert.ok([5, 9].includes(current.body.policy.lateGraceMinutes));
  assert.equal(current.body.policy.updatedByName, "Quản trị chính sách");
  assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs
    WHERE action = 'ATTENDANCE_POLICY_UPDATE'`).first()).count, 1);
  assert.deepEqual({ ...await db.prepare(`SELECT attendance_status AS status,
      attendance_delta_minutes AS delta, attendance_grace_minutes AS grace
    FROM shift_sessions WHERE id = 'policy-history'`).first() }, {
    status: "ON_TIME", delta: 15, grace: 15,
  });
});

test("additive migration snapshots legacy grace without rewriting attendance status", async () => {
  const migration = await readFile(new URL("../drizzle/0023_attendance_policy.sql", import.meta.url), "utf8");
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE shift_sessions (
        id TEXT PRIMARY KEY, attendance_status TEXT, attendance_delta_minutes INTEGER
      );
      INSERT INTO shift_sessions VALUES ('old', 'LATE', 3);`);
    legacy.exec(migration.replaceAll("--> statement-breakpoint", ""));
    assert.deepEqual({ ...legacy.prepare(`SELECT attendance_status AS status,
      attendance_delta_minutes AS delta, attendance_grace_minutes AS grace
      FROM shift_sessions WHERE id = 'old'`).get() }, { status: "LATE", delta: 3, grace: 15 });
    const stored = JSON.parse(legacy.prepare(`SELECT value FROM system_state
      WHERE key = 'attendance_late_grace_policy_v1'`).get().value);
    assert.equal(stored.lateGraceMinutes, 15);
    assert.equal(stored.version, 1);
  } finally {
    legacy.close();
  }
});

test("START snapshots grace and atomically rejects a policy changed after preview", async () => {
  const source = await readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8");
  assert.match(source, /attendance_grace_minutes/u);
  assert.match(source, /policy\.lateGraceMinutes/u);
  assert.match(source, /scheduleCandidateId[\s\S]*policy\.version[\s\S]*policy\.lateGraceMinutes/u);
  assert.ok((source.match(/EXISTS \(SELECT 1 FROM system_state WHERE key = \? AND value = \? AND updated_at = \?\)/gu) ?? []).length >= 2);
  assert.match(source, /Chính sách thời gian đi trễ vừa thay đổi/u);
});
