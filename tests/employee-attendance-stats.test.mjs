import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-employee-attendance-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, route] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/employee-attendance-stats/route.ts"),
]);
const db = await initDb();
const tokens = { employee: "employee-attendance-token", foreign: "foreign-attendance-token", manager: "manager-attendance-token" };

function request(path, token) {
  return new Request(`http://localhost${path}`, { headers: { cookie: `dore_session=${encodeURIComponent(token)}` } });
}

async function responseOf(response) {
  return { status: response.status, body: await response.json(), headers: response.headers };
}

before(async () => {
  const now = "2026-08-12T02:00:00.000Z";
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES ('employee-att-store-a', 'DORE EMPLOYEE A', 'A', 0, 0, 'ACTIVE', ?),
             ('employee-att-store-b', 'DORE EMPLOYEE B', 'B', 0, 0, 'ACTIVE', ?)`).bind(now, now),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
         cccd_image_key, hourly_rate, tiktok_allowance, status)
      VALUES ('employee-att-a', 'employee-att-store-a', 'EA001', 'Nhân viên A', 'Bán hàng', '0900000301', 'A', 'A', 'A', 25,
              'cccd/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg', 20000, 0, 'ACTIVE'),
             ('employee-att-b', 'employee-att-store-b', 'EB001', 'Nhân viên B', 'Bán hàng', '0900000302', 'B', 'B', 'B', 25,
              'cccd/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg', 20000, 0, 'ACTIVE')`),
    db.prepare(`INSERT INTO users (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
      VALUES ('employee-att-user-a', 'employee-att-a', 'unused', 'EMPLOYEE', 'Nhân viên A', 'employee-att-a', 'employee-att-store-a', 0),
             ('employee-att-user-b', 'employee-att-b', 'unused', 'EMPLOYEE', 'Nhân viên B', 'employee-att-b', 'employee-att-store-b', 0),
             ('employee-att-manager', 'employee-att-manager', 'unused', 'MANAGER', 'Quản lý', NULL, 'employee-att-store-a', 0)`),
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, work_date, started_at, attendance_status, attendance_delta_minutes, status)
      VALUES ('employee-att-a-early', 'EA-EARLY', 'employee-att-store-a', 'employee-att-a', '2026-08-02', '2026-08-02T00:50:00.000Z', 'EARLY', -10, 'COMPLETED'),
             ('employee-att-a-ontime', 'EA-ON', 'employee-att-store-a', 'employee-att-a', '2026-08-03', '2026-08-03T01:05:00.000Z', 'ON_TIME', 5, 'COMPLETED'),
             ('employee-att-a-late', 'EA-LATE', 'employee-att-store-b', 'employee-att-a', '2026-08-04', '2026-08-04T01:21:00.000Z', 'LATE', 21, 'COMPLETED'),
             ('employee-att-a-after-through', 'EA-FUTURE', 'employee-att-store-a', 'employee-att-a', '2026-08-20', '2026-08-20T01:30:00.000Z', 'LATE', 30, 'COMPLETED'),
             ('employee-att-b-late', 'EB-LATE', 'employee-att-store-b', 'employee-att-b', '2026-08-04', '2026-08-04T01:50:00.000Z', 'LATE', 50, 'COMPLETED')`),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('employee-att-session-a', 'employee-att-user-a', ?, ?, ?),
           ('employee-att-session-b', 'employee-att-user-b', ?, ?, ?),
           ('employee-att-session-manager', 'employee-att-manager', ?, ?, ?)`)
    .bind(
      await sha256(tokens.employee), Date.now() + 300_000, now,
      await sha256(tokens.foreign), Date.now() + 300_000, now,
      await sha256(tokens.manager), Date.now() + 300_000, now,
    ).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("employee endpoint derives identity from the session and includes own support shifts", async () => {
  const result = await responseOf(await route.GET(request(
    "/api/employee-attendance-stats?period=2026-08&through=2026-08-12",
    tokens.employee,
  )));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.request, { period: "2026-08", through: "2026-08-12" });
  assert.deepEqual(result.body.filter, { from: "2026-08-01", to: "2026-08-12", timeZone: "Asia/Ho_Chi_Minh" });
  assert.equal(result.body.scope.kind, "EMPLOYEE_SELF");
  assert.equal(result.body.scope.employeeId, "employee-att-a");
  assert.deepEqual({ early: result.body.row.early, onTime: result.body.row.onTime, late: result.body.row.late, minutes: result.body.row.totalLateMinutes }, {
    early: 1, onTime: 1, late: 1, minutes: 21,
  });
  assert.equal(result.body.row.evaluation.code, "NEEDS_IMPROVEMENT");
  assert.equal(result.body.policy.classificationSource, "PERSISTED_SNAPSHOT");
  assert.equal(result.headers.get("cache-control"), "private, no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(result.headers.get("vary"), "Cookie");
});

test("employee cannot select another identity and manager cannot use self-service statistics", async () => {
  assert.equal((await route.GET(request("/api/employee-attendance-stats?period=2026-08&through=2026-08-12&employeeId=employee-att-b", tokens.employee))).status, 400);
  assert.equal((await route.GET(request("/api/employee-attendance-stats?period=2026-08&through=2026-08-12&storeId=employee-att-store-b", tokens.employee))).status, 400);
  assert.equal((await route.GET(request("/api/employee-attendance-stats?period=2026-08&through=2026-08-12", tokens.manager))).status, 403);
  const foreign = await responseOf(await route.GET(request("/api/employee-attendance-stats?period=2026-08&through=2026-08-12", tokens.foreign)));
  assert.equal(foreign.body.scope.employeeId, "employee-att-b");
  assert.equal(foreign.body.row.totalLateMinutes, 50);
});

test("employee filter validates calendar bounds without leaking data", async () => {
  assert.equal((await route.GET(request("/api/employee-attendance-stats?period=2026-13&through=2026-08-12", tokens.employee))).status, 400);
  assert.equal((await route.GET(request("/api/employee-attendance-stats?period=2026-08&through=2026-09-01", tokens.employee))).status, 400);
  assert.equal((await route.GET(request("/api/employee-attendance-stats?period=2026-08&through=2026-02-30", tokens.employee))).status, 400);
});

test("payroll UI renders responsive employee-only attendance summary with stale request protection", async () => {
  const [payroll, component, css, api] = await Promise.all([
    readFile(new URL("../app/components/ReferenceEmployeeModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/EmployeeAttendanceSummary.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/EmployeeAttendanceSummary.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employee-attendance-stats/route.ts", import.meta.url), "utf8"),
  ]);
  assert.ok(payroll.includes("<EmployeeAttendanceSummary period={month} through={through} refreshKey={refreshKey}/>"));
  assert.match(payroll, /const payrollRequest = useRef\(0\)/u);
  assert.match(payroll, /payrollController\.current\?\.abort\(\)/u);
  assert.match(payroll, /data\.period !== requestedPeriod/u);
  assert.match(payroll, /setThrough\(defaultThroughForPeriod\(next\)\)/u);
  assert.match(payroll, /const isFullPeriodView = through === monthLastDay\(month\)/u);
  assert.match(payroll, /adjustment\.kind === "ALLOWANCE" && adjustment\.date <= through/u);
  assert.match(payroll, /adjustment\.kind === "BONUS" && adjustment\.date <= through/u);
  assert.match(payroll, /const finalizedKpiBonus = isFullPeriodView/u);
  assert.match(payroll, /Nguồn chi trả và KPI là số liệu chốt theo cả kỳ/u);
  for (const label of ["THỐNG KÊ CHUYÊN CẦN CỦA BẠN", "ĐI TRỄ", "ĐI ĐÚNG GIỜ", "ĐI SỚM", "TỔNG THỜI GIAN ĐI TRỄ", "ĐÁNH GIÁ HIỆU SUẤT & CHUYÊN CẦN"]) {
    assert.match(component, new RegExp(label, "u"));
  }
  assert.match(component, /const requestSequence = useRef\(0\)/u);
  assert.match(component, /const controller = new AbortController\(\)/u);
  assert.match(component, /payload\.request\.period !== requested\.period/u);
  assert.match(component, /return \(\) => controller\.abort\(\)/u);
  assert.match(component, /role="list" aria-label="Số lần điểm danh theo trạng thái"/u);
  assert.match(component, /aria-label="Đánh giá hiệu suất và chuyên cần"/u);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.metrics \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/u);
  assert.match(api, /user\.role !== "EMPLOYEE" \|\| !user\.employeeId/u);
  assert.match(api, /s\.employee_id = \?/u);
  assert.doesNotMatch(api, /attendanceStatusAt|attendanceDeltaMinutes\(/u);
});
