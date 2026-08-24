import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-attendance-stats-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, auth, route, stats, attendancePolicy] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/attendance-stats/route.ts"),
  import("../app/lib/attendance-stats.ts"),
  import("../app/lib/attendance-policy.ts"),
]);

const db = await initDb();
const tokens = {
  manager: "attendance-stats-manager-token",
  global: "attendance-stats-global-token",
  employee: "attendance-stats-employee-token",
};

function request(path, token) {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: `dore_session=${encodeURIComponent(token)}` },
  });
}

async function body(response) {
  return { status: response.status, body: await response.json(), headers: response.headers };
}

before(async () => {
  const now = "2026-08-11T03:00:00.000Z";
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES ('attendance-store-a', 'DORE QA A', 'A', 0, 0, 'ACTIVE', ?),
             ('attendance-store-b', 'DORE QA B', 'B', 0, 0, 'ACTIVE', ?)`).bind(now, now),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
         cccd_image_key, hourly_rate, tiktok_allowance, status)
      VALUES ('attendance-a1', 'attendance-store-a', 'A001', 'An', 'Bán hàng', '0900000201', 'A', 'A', 'A', 25,
               'cccd/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg', 20000, 0, 'ACTIVE'),
             ('attendance-a2', 'attendance-store-a', 'A002', 'Bình', 'Bán hàng', '0900000202', 'A', 'A', 'A', 25,
               'cccd/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg', 20000, 0, 'ACTIVE'),
             ('attendance-a3', 'attendance-store-a', 'A003', 'Chưa chấm công', 'Bán hàng', '0900000203', 'A', 'A', 'A', 25,
               'cccd/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg', 20000, 0, 'ACTIVE'),
             ('attendance-b1', 'attendance-store-b', 'B001', 'Ngoài phạm vi', 'Bán hàng', '0900000204', 'B', 'B', 'B', 25,
               'cccd/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg', 20000, 0, 'ACTIVE')`),
    db.prepare(`INSERT INTO users (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
      VALUES ('attendance-manager', 'attendance-manager', 'unused', 'MANAGER', 'Manager A', NULL, 'attendance-store-a', 0),
             ('attendance-global', 'attendance-global', 'unused', 'MANAGER', 'Global', NULL, NULL, 1),
             ('attendance-employee-user', 'attendance-employee', 'unused', 'EMPLOYEE', 'An', 'attendance-a1', 'attendance-store-a', 0)`),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
         cccd_image_key, hourly_rate, tiktok_allowance, status, deleted_at)
      VALUES ('attendance-archived', 'attendance-store-a', 'A999', 'Đã xóa', 'Bán hàng', '0900000299', 'A', 'A', 'A', 25,
              'cccd/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg', 20000, 0, 'ARCHIVED', ?)`)
      .bind(now),
  ]);
  await db.prepare("UPDATE system_state SET value = ?, updated_at = ? WHERE key = ?")
    .bind(attendancePolicy.serializeAttendancePolicy({
      schemaVersion: 1,
      lateGraceMinutes: 22,
      version: 3,
      updatedBy: "attendance-global",
      mutationToken: "attendance-policy-test",
    }), now, attendancePolicy.ATTENDANCE_POLICY_STATE_KEY).run();

  const shifts = [];
  for (let index = 0; index < 10; index += 1) {
    const day = String(3 + (index % 7)).padStart(2, "0");
    const isLateSnapshot = index === 9;
    shifts.push(db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, work_date, started_at,
       attendance_status, attendance_delta_minutes, status)
      VALUES (?, ?, 'attendance-store-a', 'attendance-a1', ?, ?, ?, ?, 'COMPLETED')`).bind(
      `attendance-a1-${index}`,
      `ATT-A1-${index}`,
      `2026-08-${day}`,
      `2026-08-${day}T01:00:00.000Z`,
      isLateSnapshot ? "LATE" : index % 2 ? "EARLY" : "ON_TIME",
      isLateSnapshot ? 9 : index % 2 ? -5 : 0,
    ));
  }
  shifts.push(
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, work_date, started_at, attendance_status, attendance_delta_minutes, status)
      VALUES ('attendance-a2-1', 'ATT-A2-1', 'attendance-store-a', 'attendance-a2', '2026-08-04', '2026-08-04T01:00:00.000Z', 'EARLY', -10, 'ACTIVE')`),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, work_date, started_at, attendance_status, attendance_delta_minutes, status)
      VALUES ('attendance-b1-1', 'ATT-B1-1', 'attendance-store-b', 'attendance-b1', '2026-08-04', '2026-08-04T01:00:00.000Z', 'LATE', 50, 'COMPLETED')`),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, work_date, started_at, attendance_status, attendance_delta_minutes, status)
      VALUES ('attendance-support-1', 'ATT-SUPPORT-1', 'attendance-store-a', 'attendance-b1', '2026-08-05', '2026-08-05T01:00:00.000Z', 'ON_TIME', 0, 'COMPLETED')`),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, work_date, started_at, attendance_status, attendance_delta_minutes, status)
      VALUES ('attendance-archived-1', 'ATT-ARCHIVED-1', 'attendance-store-a', 'attendance-archived', '2026-08-05', '2026-08-05T01:00:00.000Z', 'LATE', 99, 'COMPLETED')`),
  );
  await db.batch(shifts);

  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('attendance-session-manager', 'attendance-manager', ?, ?, ?),
           ('attendance-session-global', 'attendance-global', ?, ?, ?),
           ('attendance-session-employee', 'attendance-employee-user', ?, ?, ?)`)
    .bind(
      await auth.sha256(tokens.manager), Date.now() + 300_000, now,
      await auth.sha256(tokens.global), Date.now() + 300_000, now,
      await auth.sha256(tokens.employee), Date.now() + 300_000, now,
    ).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("day, Monday week and calendar month ranges are deterministic", () => {
  assert.deepEqual(stats.attendanceStatsDateRange("day", "2026-08-09"), { from: "2026-08-09", to: "2026-08-09" });
  assert.deepEqual(stats.attendanceStatsDateRange("week", "2026-08-09"), { from: "2026-08-03", to: "2026-08-09" });
  assert.deepEqual(stats.attendanceStatsDateRange("week", "2026-08-03"), { from: "2026-08-03", to: "2026-08-09" });
  assert.deepEqual(stats.attendanceStatsDateRange("month", "2028-02-12"), { from: "2028-02-01", to: "2028-02-29" });
  assert.throws(() => stats.attendanceStatsDateRange("day", "2026-02-30"), /không hợp lệ/u);
});

test("evaluation is transparent and late minutes only sum positive persisted LATE deltas", () => {
  const snapshots = [
    ...Array.from({ length: 9 }, (_, index) => ({ employeeId: "good", employeeCode: "G1", employeeName: "Tốt", attendanceStatus: "ON_TIME", attendanceDeltaMinutes: index })),
    { employeeId: "good", employeeCode: "G1", employeeName: "Tốt", attendanceStatus: "LATE", attendanceDeltaMinutes: 9 },
    { employeeId: "fair", employeeCode: "F1", employeeName: "Khá", attendanceStatus: "LATE", attendanceDeltaMinutes: 45 },
    { employeeId: "fair", employeeCode: "F1", employeeName: "Khá", attendanceStatus: "ON_TIME", attendanceDeltaMinutes: 0 },
    { employeeId: "fair", employeeCode: "F1", employeeName: "Khá", attendanceStatus: "EARLY", attendanceDeltaMinutes: -2 },
    { employeeId: "fair", employeeCode: "F1", employeeName: "Khá", attendanceStatus: "ON_TIME", attendanceDeltaMinutes: 0 },
    { employeeId: "needs", employeeCode: "N1", employeeName: "Cần cải thiện", attendanceStatus: "LATE", attendanceDeltaMinutes: 61 },
    { employeeId: "negative", employeeCode: "N2", employeeName: "Trễ âm", attendanceStatus: "LATE", attendanceDeltaMinutes: -9 },
  ];
  const rows = stats.buildAttendanceStats(snapshots, [{ employeeId: "none", employeeCode: "N0", employeeName: "Không có dữ liệu" }]);
  const byId = new Map(rows.map((row) => [row.employeeId, row]));
  assert.deepEqual({ code: byId.get("good").evaluation.code, rate: byId.get("good").lateRatePercent, minutes: byId.get("good").totalLateMinutes }, { code: "GOOD", rate: 10, minutes: 9 });
  assert.deepEqual({ code: byId.get("fair").evaluation.code, rate: byId.get("fair").lateRatePercent, minutes: byId.get("fair").totalLateMinutes }, { code: "FAIR", rate: 25, minutes: 45 });
  assert.equal(byId.get("needs").evaluation.code, "NEEDS_IMPROVEMENT");
  assert.equal(byId.get("negative").totalLateMinutes, 0);
  assert.equal(byId.get("none").evaluation.code, "NO_DATA");
  assert.equal(stats.buildAttendanceStats([{ employeeId: "excellent", employeeCode: "E1", employeeName: "Xuất sắc", attendanceStatus: "EARLY", attendanceDeltaMinutes: -10 }])[0].evaluation.code, "EXCELLENT");
});

test("manager API is store scoped, uses historical snapshots and returns dynamic policy", async () => {
  const result = await body(await route.GET(request(
    "/api/attendance-stats?storeId=attendance-store-a&mode=week&anchor=2026-08-09",
    tokens.manager,
  )));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.filter, {
    mode: "week", anchor: "2026-08-09", from: "2026-08-03", to: "2026-08-09", timeZone: "Asia/Ho_Chi_Minh",
  });
  assert.deepEqual(result.body.rows.map((row) => row.employeeId).sort(), ["attendance-a1", "attendance-a2", "attendance-a3", "attendance-b1"]);
  assert.ok(result.body.rows.some((row) => row.employeeId === "attendance-b1"), "a live support worker with a snapshot in this store remains visible");
  assert.ok(!result.body.rows.some((row) => row.employeeId === "attendance-archived"), "archived/deleted tombstones must never reappear");
  const employee = result.body.rows.find((row) => row.employeeId === "attendance-a1");
  assert.equal(employee.late, 1, "persisted LATE remains authoritative even below the current grace threshold");
  assert.equal(employee.totalLateMinutes, 9);
  assert.equal(employee.evaluation.code, "GOOD");
  assert.equal(result.body.totals.totalLateMinutes, 9, "foreign-store late minutes must not leak into the result");
  assert.equal(result.body.policy.classificationSource, "PERSISTED_SNAPSHOT");
  assert.equal(result.body.policy.onTimeGraceMinutes, 22);
  assert.equal(result.body.policy.version, 3);
  assert.equal(result.headers.get("cache-control"), "private, no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(result.headers.get("vary"), "Cookie");

  assert.equal((await route.GET(request("/api/attendance-stats?storeId=attendance-store-b&mode=month&anchor=2026-08-04", tokens.manager))).status, 403);
  assert.equal((await route.GET(request("/api/attendance-stats?storeId=attendance-store-a&mode=month&anchor=2026-08-04", tokens.employee))).status, 403);
  assert.equal((await route.GET(request("/api/attendance-stats?storeId=attendance-store-b&mode=month&anchor=2026-08-04", tokens.global))).status, 200);
  assert.equal((await route.GET(request("/api/attendance-stats?storeId=attendance-store-a&mode=year&anchor=2026-08-04", tokens.manager))).status, 400);
});

test("attendance stats UI exposes accessible filters, responsive cards and stale-request protection", async () => {
  const [component, css, reference, api] = await Promise.all([
    readFile(new URL("../app/components/AttendanceStatsPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AttendanceStatsPanel.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReferenceStoreModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attendance-stats/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(reference, /<AttendanceStatsPanel storeId=\{store\.id\}\/>/u);
  assert.match(reference, /attendanceGraceMinutes\?: number \| null; attendance_grace_minutes\?: number \| null/u);
  assert.match(reference, /attendanceStatusAt\(shift\.started_at, shift\.scheduled_start_at, graceMinutes\)/u);
  assert.doesNotMatch(reference, /ATTENDANCE_ON_TIME_GRACE_MINUTES/u);
  assert.match(component, /THỐNG KÊ ĐI LÀM ĐÚNG GIỜ/u);
  for (const label of ["Ngày", "Tuần", "Tháng", "Đi trễ", "Đúng giờ", "Đi sớm", "Tổng phút trễ", "Đánh giá chuyên cần"]) {
    assert.match(component, new RegExp(label, "u"));
  }
  assert.match(component, /role="group" aria-label="Khoảng thống kê đi làm đúng giờ"/u);
  assert.match(component, /aria-pressed=\{mode === item\}/u);
  assert.match(component, /className=\{styles\.desktopRegion\} role="region" tabIndex=\{0\}/u);
  assert.match(component, /<ol className=\{styles\.mobileList\} aria-label="Danh sách thống kê đi làm đúng giờ">/u);
  assert.match(component, /const requestSequence = useRef\(0\)/u);
  assert.match(component, /const requestId = \+\+requestSequence\.current/u);
  assert.match(component, /const controller = new AbortController\(\)/u);
  assert.match(component, /payload\.request\.storeId !== requestedScope\.storeId/u);
  assert.match(component, /requestId !== requestSequence\.current \|\| controller\.signal\.aborted/u);
  assert.match(component, /return \(\) => controller\.abort\(\)/u);
  assert.doesNotMatch(component, /sau 15 phút|15 phút kể từ giờ bắt đầu/u, "the policy threshold must come from the API");
  assert.match(component, /data\.policy\.onTimeGraceMinutes/u);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.desktopRegion \{ display: none; \}[\s\S]*\.mobileList \{ display: grid/u);
  assert.match(css, /\.panel \{[\s\S]*min-width: 0;[\s\S]*max-width: 100%;[\s\S]*overflow: hidden;/u);
  assert.match(api, /s\.attendance_status AS attendanceStatus/u);
  assert.match(api, /s\.attendance_delta_minutes AS attendanceDeltaMinutes/u);
  assert.match(api, /loadAttendancePolicy\(db\)/u);
  assert.match(api, /JOIN employees e ON e\.id = s\.employee_id[\s\S]*e\.status != 'ARCHIVED' AND e\.deleted_at IS NULL/u);
  assert.match(api, /status != 'ARCHIVED' AND deleted_at IS NULL/u);
  assert.doesNotMatch(api, /attendanceStatusAt|attendanceDeltaMinutes\(/u, "historical snapshots must not be reclassified");
});
