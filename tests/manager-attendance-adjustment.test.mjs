import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-attendance-adjustment-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, attendanceRoute, financialPeriodLifecycle] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/attendance-adjustments/route.ts"),
  import("../app/api/_lib/financial-period-lifecycle.ts"),
]);

const db = await initDb();
const tokens = {
  managerA: "attendance-manager-a-token",
  managerB: "attendance-manager-b-token",
  globalManager: "attendance-global-manager-token",
  superAdmin: "attendance-super-admin-token",
  employee: "attendance-employee-token",
};

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `dore_session=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

async function read(storeId, id, token = tokens.managerA) {
  return json(await attendanceRoute.GET(request(
    `/api/attendance-adjustments?${new URLSearchParams({ storeId, id })}`,
    token,
  )));
}

async function edit(input, token = tokens.managerA) {
  return json(await attendanceRoute.PATCH(request(
    "/api/attendance-adjustments",
    token,
    "PATCH",
    input,
  )));
}

function lockedPeriodCalculation() {
  return {
    policyVersionId: "attendance-policy-locked",
    configVersion: 991,
    finance: {
      grossRevenue: 0,
      fixedExpense: 0,
      variableExpense: 0,
      inventoryCost: 0,
      inventoryShippingCost: 0,
      employeeSalary: 0,
      managerSalary: 0,
      manualEmployeeBonus: 0,
      employeeAllowance: 0,
      employeeKpiTotal: 0,
      managerKpi: 0,
      monthEndExpense: 0,
    },
    totalHoursSeconds: 0,
    salaryAdvance: 0,
    employeePayrollRows: [],
    managerPayroll: {},
    configSnapshot: { policyVersionId: "attendance-policy-locked", configVersion: 991 },
  };
}

async function applyFinancialPeriodPlan(plan) {
  const results = await db.batch([...plan.statements]);
  financialPeriodLifecycle.assertFinancialPeriodPlanApplied(results, plan);
  return financialPeriodLifecycle.readFinancialPeriodLifecycleRow(db, plan.storeId, plan.period);
}

async function createLockedFinancialPeriod() {
  let row = await applyFinancialPeriodPlan(financialPeriodLifecycle.prepareFinancialPeriodDraftPlan(db, {
    id: "attendance-period-locked",
    storeId: "attendance-store-locked",
    period: "2026-09",
    actorId: "attendance-super-admin",
    now: "2026-10-01T00:00:00.000Z",
    reason: "Khởi tạo kỳ để kiểm tra khóa chấm công",
    auditId: "attendance-period-draft-audit",
  }));
  const calculation = lockedPeriodCalculation();
  const transitions = [
    ["CALCULATED", "2026-10-01T00:01:00.000Z", calculation],
    ["RECONCILING", "2026-10-01T00:02:00.000Z"],
    ["CONFIRMED", "2026-10-01T00:03:00.000Z", calculation],
    ["PAID", "2026-10-01T00:04:00.000Z"],
    ["LOCKED", "2026-10-01T00:05:00.000Z"],
  ];
  for (const [toStatus, now, nextCalculation] of transitions) {
    try {
      row = await applyFinancialPeriodPlan(financialPeriodLifecycle.prepareFinancialPeriodTransitionPlan(db, {
        current: row,
        toStatus,
        actorId: "attendance-super-admin",
        now,
        reason: `Chuyển kỳ sang ${toStatus} để kiểm tra khóa chấm công`,
        auditId: `attendance-period-${toStatus.toLowerCase()}-audit`,
        ...(nextCalculation ? { calculation: nextCalculation } : {}),
      }));
    } catch (error) {
      error.message = `${toStatus}: ${error.message}`;
      throw error;
    }
  }
  assert.equal(row.status, "LOCKED");
}

before(async () => {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES ('attendance-store-a', 'ATTENDANCE STORE A', 'A', 0, 0, 'ACTIVE', ?),
             ('attendance-store-b', 'ATTENDANCE STORE B', 'B', 0, 0, 'ACTIVE', ?),
             ('attendance-store-locked', 'ATTENDANCE STORE LOCKED', 'LOCKED', 0, 0, 'ACTIVE', ?)`)
      .bind(now, now, now),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
      VALUES ('attendance-employee-a', 'attendance-store-a', 'AT-A', 'Nhân viên A', 'Bán hàng', '0901000001', 20000, 0, 'ACTIVE'),
             ('attendance-employee-b', 'attendance-store-b', 'AT-B', 'Nhân viên B', 'Bán hàng', '0901000002', 20000, 0, 'ACTIVE'),
             ('attendance-employee-archived', 'attendance-store-a', 'AT-OLD', 'Nhân viên lịch sử', 'Bán hàng', '0901000003', 20000, 0, 'TERMINATED'),
             ('attendance-employee-locked', 'attendance-store-locked', 'AT-LOCK', 'Nhân viên kỳ khóa', 'Bán hàng', '0901000004', 20000, 0, 'ACTIVE')`),
    db.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, employee_id, store_id, shift_active, current_shift, shift_started_at, is_super_admin)
      VALUES ('attendance-manager-a', 'attendance-manager-a', 'unused', 'MANAGER', 'Manager A', NULL, 'attendance-store-a', 0, NULL, NULL, 0),
             ('attendance-manager-b', 'attendance-manager-b', 'unused', 'MANAGER', 'Manager B', NULL, 'attendance-store-b', 0, NULL, NULL, 0),
             ('attendance-global-manager', 'attendance-global-manager', 'unused', 'MANAGER', 'Global Manager', NULL, NULL, 0, NULL, NULL, 0),
             ('attendance-super-admin', 'attendance-super-admin', 'unused', 'MANAGER', 'Super Admin', NULL, 'attendance-store-a', 0, NULL, NULL, 1),
             ('attendance-user-a', 'attendance-user-a', 'unused', 'EMPLOYEE', 'Nhân viên A', 'attendance-employee-a', 'attendance-store-a', 1, 'SHIFT-ACTIVE', '2026-08-18T06:05:00.000Z', 0)`),
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, work_date,
         scheduled_start, scheduled_end, scheduled_start_at, scheduled_end_at,
         started_at, ended_at, duration_seconds, status, attendance_status,
         attendance_delta_minutes, attendance_grace_minutes, close_status)
      VALUES
        ('attendance-completed-main', 'SHIFT-COMPLETED-MAIN', 'attendance-store-a', 'attendance-employee-a', 'Ca 1', '2026-08-18',
         '08:00', '12:00', '2026-08-18T01:00:00.000Z', '2026-08-18T05:00:00.000Z',
         '2026-08-18T01:05:00.000Z', '2026-08-18T05:00:00.000Z', 14100, 'COMPLETED', 'ON_TIME', 5, 15, 'CONFIRMED'),
        ('attendance-completed-reason', 'SHIFT-COMPLETED-REASON', 'attendance-store-a', 'attendance-employee-a', 'Ca 1', '2026-08-19',
         '08:00', '12:00', '2026-08-19T01:00:00.000Z', '2026-08-19T05:00:00.000Z',
         '2026-08-19T01:00:00.000Z', '2026-08-19T05:00:00.000Z', 14400, 'COMPLETED', 'ON_TIME', 0, 15, 'CONFIRMED'),
        ('attendance-completed-stale', 'SHIFT-COMPLETED-STALE', 'attendance-store-a', 'attendance-employee-a', 'Ca 1', '2026-08-20',
         '08:00', '12:00', '2026-08-20T01:00:00.000Z', '2026-08-20T05:00:00.000Z',
         '2026-08-20T01:00:00.000Z', '2026-08-20T05:00:00.000Z', 14400, 'COMPLETED', 'ON_TIME', 0, 15, 'CONFIRMED'),
        ('attendance-active', 'SHIFT-ACTIVE', 'attendance-store-a', 'attendance-employee-a', 'Ca 2', '2026-08-18',
         '13:00', '17:00', '2026-08-18T06:00:00.000Z', '2026-08-18T10:00:00.000Z',
         '2026-08-18T06:05:00.000Z', NULL, 0, 'ACTIVE', 'ON_TIME', 5, 15, 'OPEN'),
        ('attendance-completed-reopen', 'SHIFT-COMPLETED-REOPEN', 'attendance-store-a', 'attendance-employee-a', 'Ca 2', '2026-08-21',
         '13:00', '17:00', '2026-08-21T06:00:00.000Z', '2026-08-21T10:00:00.000Z',
         '2026-08-21T06:00:00.000Z', '2026-08-21T10:00:00.000Z', 14400, 'COMPLETED', 'ON_TIME', 0, 15, 'CONFIRMED'),
        ('attendance-overnight', 'SHIFT-OVERNIGHT', 'attendance-store-a', 'attendance-employee-a', 'Ca đêm', '2026-08-22',
         '23:00', '09:00', '2026-08-22T16:00:00.000Z', '2026-08-23T02:00:00.000Z',
         '2026-08-22T16:05:00.000Z', '2026-08-23T01:00:00.000Z', 32100, 'COMPLETED', 'ON_TIME', 5, 15, 'CONFIRMED'),
        ('attendance-archived', 'SHIFT-ARCHIVED', 'attendance-store-a', 'attendance-employee-archived', 'Ca cũ', '2026-08-17',
         '08:00', '12:00', '2026-08-17T01:00:00.000Z', '2026-08-17T05:00:00.000Z',
         '2026-08-17T01:00:00.000Z', '2026-08-17T05:00:00.000Z', 14400, 'COMPLETED', 'ON_TIME', 0, 15, 'CONFIRMED'),
        ('attendance-store-b-session', 'SHIFT-STORE-B', 'attendance-store-b', 'attendance-employee-b', 'Ca B', '2026-08-18',
         '08:00', '12:00', '2026-08-18T01:00:00.000Z', '2026-08-18T05:00:00.000Z',
         '2026-08-18T01:00:00.000Z', '2026-08-18T05:00:00.000Z', 14400, 'COMPLETED', 'ON_TIME', 0, 15, 'CONFIRMED'),
        ('attendance-audit-fail', 'SHIFT-AUDIT-FAIL', 'attendance-store-a', 'attendance-employee-a', 'Ca audit', '2026-08-24',
         '08:00', '12:00', '2026-08-24T01:00:00.000Z', '2026-08-24T05:00:00.000Z',
         '2026-08-24T01:00:00.000Z', '2026-08-24T05:00:00.000Z', 14400, 'COMPLETED', 'ON_TIME', 0, 15, 'CONFIRMED'),
        ('attendance-locked', 'SHIFT-LOCKED', 'attendance-store-locked', 'attendance-employee-locked', 'Ca khóa', '2026-09-05',
         '08:00', '12:00', '2026-09-05T01:00:00.000Z', '2026-09-05T05:00:00.000Z',
         '2026-09-05T01:00:00.000Z', '2026-09-05T05:00:00.000Z', 14400, 'COMPLETED', 'ON_TIME', 0, 15, 'CONFIRMED')`),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('attendance-session-manager-a', 'attendance-manager-a', ?, ?, ?),
           ('attendance-session-manager-b', 'attendance-manager-b', ?, ?, ?),
           ('attendance-session-global-manager', 'attendance-global-manager', ?, ?, ?),
           ('attendance-session-super', 'attendance-super-admin', ?, ?, ?),
           ('attendance-session-employee', 'attendance-user-a', ?, ?, ?)`)
    .bind(
      await sha256(tokens.managerA), Date.now() + 600_000, now,
      await sha256(tokens.managerB), Date.now() + 600_000, now,
      await sha256(tokens.globalManager), Date.now() + 600_000, now,
      await sha256(tokens.superAdmin), Date.now() + 600_000, now,
      await sha256(tokens.employee), Date.now() + 600_000, now,
    ).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("manager adjustment is store scoped while a super-admin can select any store", async () => {
  assert.equal((await read("attendance-store-a", "attendance-completed-main")).status, 200);
  assert.equal((await read("attendance-store-b", "attendance-store-b-session")).status, 403);
  assert.equal((await read("attendance-store-a", "attendance-completed-main", tokens.managerB)).status, 403);
  assert.equal((await read("attendance-store-a", "attendance-completed-main", tokens.globalManager)).status, 403);
  assert.equal((await read("attendance-store-a", "attendance-completed-main", tokens.employee)).status, 403);
  const superResult = await read("attendance-store-b", "attendance-store-b-session", tokens.superAdmin);
  assert.equal(superResult.status, 200);
  assert.equal(superResult.body.attendance.storeId, "attendance-store-b");
});

test("manager correction requires a reason and writes structured before/after audit atomically", async () => {
  const loaded = await read("attendance-store-a", "attendance-completed-main");
  const missingReason = await edit({
    id: "attendance-completed-main",
    storeId: "attendance-store-a",
    versionToken: loaded.body.versionToken,
    startedAt: "2026-08-18T01:20:00.000Z",
    endedAt: "2026-08-18T05:10:00.000Z",
  });
  assert.equal(missingReason.status, 400);

  const updated = await edit({
    id: "attendance-completed-main",
    storeId: "attendance-store-a",
    versionToken: loaded.body.versionToken,
    reason: "Đối soát lại ảnh điểm danh",
    startedAt: "2026-08-18T01:20:00.000Z",
    endedAt: "2026-08-18T05:10:00.000Z",
  });
  assert.equal(updated.status, 200);
  const persisted = await db.prepare(`SELECT started_at AS startedAt, ended_at AS endedAt,
      duration_seconds AS durationSeconds, admin_adjusted_duration_seconds AS adjusted,
      attendance_status AS attendanceStatus, attendance_delta_minutes AS delta
    FROM shift_sessions WHERE id = 'attendance-completed-main'`).first();
  assert.deepEqual({ ...persisted }, {
    startedAt: "2026-08-18T01:20:00.000Z",
    endedAt: "2026-08-18T05:10:00.000Z",
    durationSeconds: 13800,
    adjusted: null,
    attendanceStatus: "LATE",
    delta: 20,
  });
  const audit = await db.prepare(`SELECT user_id AS userId, action, entity_type AS entityType,
      entity_id AS entityId, before_json AS beforeJson, after_json AS afterJson,
      reason, store_id AS storeId, created_at AS createdAt
    FROM audit_logs WHERE action = 'MANAGER_ATTENDANCE_UPDATE' AND entity_id = 'attendance-completed-main'`).first();
  assert.equal(audit.userId, "attendance-manager-a");
  assert.equal(audit.entityType, "SHIFT_SESSION");
  assert.equal(audit.entityId, "attendance-completed-main");
  assert.equal(audit.reason, "Đối soát lại ảnh điểm danh");
  assert.equal(audit.storeId, "attendance-store-a");
  assert.ok(Number.isFinite(new Date(audit.createdAt).getTime()));
  assert.equal(JSON.parse(audit.beforeJson).startedAt, "2026-08-18T01:05:00.000Z");
  assert.equal(JSON.parse(audit.afterJson).startedAt, "2026-08-18T01:20:00.000Z");
});

test("optimistic version conflicts do not add an audit row", async () => {
  const loaded = await read("attendance-store-a", "attendance-completed-stale");
  await db.prepare("UPDATE shift_sessions SET started_at = '2026-08-20T01:01:00.000Z', duration_seconds = 14340 WHERE id = 'attendance-completed-stale'").run();
  const result = await edit({
    id: "attendance-completed-stale",
    storeId: "attendance-store-a",
    versionToken: loaded.body.versionToken,
    reason: "Yêu cầu dùng phiên bản cũ",
    startedAt: "2026-08-20T01:02:00.000Z",
    endedAt: "2026-08-20T05:00:00.000Z",
  });
  assert.equal(result.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'attendance-completed-stale'").first("count"), 0);
});

test("ACTIVE may adjust only the start timestamp and COMPLETED cannot be reopened", async () => {
  const active = await read("attendance-store-a", "attendance-active");
  const fakeEnd = await edit({
    id: "attendance-active",
    storeId: "attendance-store-a",
    versionToken: active.body.versionToken,
    reason: "Không được tự kết ca",
    startedAt: "2026-08-18T06:10:00.000Z",
    endedAt: "2026-08-18T09:00:00.000Z",
  });
  assert.equal(fakeEnd.status, 409);
  const corrected = await edit({
    id: "attendance-active",
    storeId: "attendance-store-a",
    versionToken: active.body.versionToken,
    reason: "Đối soát lại thời điểm bắt đầu",
    startedAt: "2026-08-18T06:10:00.000Z",
  });
  assert.equal(corrected.status, 200);
  assert.equal(await db.prepare("SELECT ended_at FROM shift_sessions WHERE id = 'attendance-active'").first("ended_at"), null);
  assert.equal(await db.prepare("SELECT shift_started_at FROM users WHERE id = 'attendance-user-a'").first("shift_started_at"), "2026-08-18T06:10:00.000Z");

  const completed = await read("attendance-store-a", "attendance-completed-reopen");
  const reopened = await edit({
    id: "attendance-completed-reopen",
    storeId: "attendance-store-a",
    versionToken: completed.body.versionToken,
    reason: "Không được mở lại ca hoàn tất",
    startedAt: "2026-08-21T06:05:00.000Z",
    endedAt: null,
  });
  assert.equal(reopened.status, 409);
  assert.equal(await db.prepare("SELECT ended_at FROM shift_sessions WHERE id = 'attendance-completed-reopen'").first("ended_at"), "2026-08-21T10:00:00.000Z");
});

test("valid cross-midnight timestamps remain in the original scheduled occurrence", async () => {
  const loaded = await read("attendance-store-a", "attendance-overnight");
  const updated = await edit({
    id: "attendance-overnight",
    storeId: "attendance-store-a",
    versionToken: loaded.body.versionToken,
    reason: "Đối soát ca qua đêm",
    startedAt: "2026-08-22T18:00:00.000Z",
    endedAt: "2026-08-23T01:30:00.000Z",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.attendance.workDate, "2026-08-22");
  assert.equal(updated.body.attendance.durationSeconds, 27000);

  const unrelated = await edit({
    id: "attendance-overnight",
    storeId: "attendance-store-a",
    versionToken: updated.body.versionToken,
    reason: "Thử chuyển sang ngày không liên quan",
    startedAt: "2026-08-24T01:00:00.000Z",
    endedAt: "2026-08-24T02:00:00.000Z",
  });
  assert.equal(unrelated.status, 400);
});

test("archived employee identity remains visible in historical attendance", async () => {
  const result = await read("attendance-store-a", "attendance-archived");
  assert.equal(result.status, 200);
  assert.equal(result.body.attendance.employeeCode, "AT-OLD");
  assert.equal(result.body.attendance.employeeName, "Nhân viên lịch sử");
});

test("canonical LOCKED period is rechecked at mutation and blocks audit plus source update", async () => {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO financial_policy_versions
      (id, version, effective_from_period, policy_json, created_by, created_at)
    VALUES ('attendance-policy-locked', 991, '2026-09', '{}', 'attendance-super-admin', ?)`)
    .bind(now).run();
  await createLockedFinancialPeriod();
  const loaded = await read("attendance-store-locked", "attendance-locked", tokens.superAdmin);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.attendance.locked, 1);
  const result = await edit({
    id: "attendance-locked",
    storeId: "attendance-store-locked",
    versionToken: loaded.body.versionToken,
    reason: "Không được sửa kỳ đã khóa",
    startedAt: "2026-09-05T01:01:00.000Z",
    endedAt: "2026-09-05T05:00:00.000Z",
  }, tokens.superAdmin);
  assert.equal(result.status, 423);
  assert.equal(await db.prepare("SELECT started_at FROM shift_sessions WHERE id = 'attendance-locked'").first("started_at"), "2026-09-05T01:00:00.000Z");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'attendance-locked'").first("count"), 0);
});

test("an audit insert failure rolls back the attendance source update", async () => {
  const loaded = await read("attendance-store-a", "attendance-audit-fail");
  await db.prepare(`CREATE TRIGGER reject_attendance_adjustment_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'MANAGER_ATTENDANCE_UPDATE'
    BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`).run();
  try {
    const result = await edit({
      id: "attendance-audit-fail",
      storeId: "attendance-store-a",
      versionToken: loaded.body.versionToken,
      reason: "Kiểm tra rollback audit",
      startedAt: "2026-08-24T01:10:00.000Z",
      endedAt: "2026-08-24T05:00:00.000Z",
    });
    assert.equal(result.status, 400);
    assert.equal(await db.prepare("SELECT started_at FROM shift_sessions WHERE id = 'attendance-audit-fail'").first("started_at"), "2026-08-24T01:00:00.000Z");
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'attendance-audit-fail'").first("count"), 0);
  } finally {
    await db.prepare("DROP TRIGGER reject_attendance_adjustment_audit").run();
  }
});

test("manager attendance UI edits explicit timestamps and requires an audit reason", async () => {
  const source = await readFile(new URL("../app/components/ReferenceStoreModules.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/attendance-adjustments/);
  assert.match(source, /type="datetime-local"/);
  assert.match(source, /Lý do thay đổi \*/);
  assert.match(source, /reason: adjustment\.reason/);
  assert.match(source, /Ca đang làm chỉ được sửa giờ vào/);
});
