import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = await mkdtemp(join(tmpdir(), "dore-attendance-location-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, locationModule, shiftRoute, shiftsRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/lib/attendance-location.ts"),
  import("../app/api/shift/route.ts"),
  import("../app/api/shifts/route.ts"),
]);

let db;
const employeeToken = "location-employee-token";
const managerToken = "location-manager-token";

before(async () => {
  db = await initDb();
});

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

function authenticatedRequest(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { cookie: `dore_session=${encodeURIComponent(token)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function vietnamDateAndClock(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}` };
}

async function seedClockInSchedule() {
  for (const table of ["sessions", "business_records", "shift_sessions", "employees"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM users WHERE id IN ('location-employee-user', 'location-manager-user')").run();
  await db.prepare(`INSERT OR REPLACE INTO stores
      (id, name, address, revenue, expense, status, created_at)
      VALUES ('location-store', 'DORE LOCATION TEST', 'Test', 0, 0, 'ACTIVE', ?)`)
    .bind(new Date().toISOString()).run();
  await db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
      VALUES ('location-employee', 'location-store', 'LOC001', 'Nhân viên vị trí', 'Nhân viên', '0900000000', 20000, 25000, 'ACTIVE')`).run();
  await db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id, shift_active)
      VALUES ('location-employee-user', 'location.employee', 'unused', 'EMPLOYEE', 'Nhân viên vị trí', 'location-employee', 'location-store', 0),
             ('location-manager-user', 'location.manager', 'unused', 'MANAGER', 'Quản lý vị trí', NULL, NULL, 0)`).run();
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ('location-employee-login', 'location-employee-user', ?, ?, ?),
             ('location-manager-login', 'location-manager-user', ?, ?, ?)`)
    .bind(
      await sha256(employeeToken), Date.now() + 120_000, new Date().toISOString(),
      await sha256(managerToken), Date.now() + 120_000, new Date().toISOString(),
    ).run();

  const now = new Date();
  const start = vietnamDateAndClock(new Date(now.getTime() - 10 * 60_000));
  const end = vietnamDateAndClock(new Date(now.getTime() + 30 * 60_000));
  await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('location-schedule', 'LICH_PHAN_CA', 'location-store', 'location-manager-user', 'Ca định vị', ?, 'ACTIVE', ?, ?)`)
    .bind(JSON.stringify({
      date: start.date,
      shiftId: "location-shift",
      shiftName: "Ca định vị",
      start: start.clock,
      end: end.clock,
      employeeIds: ["location-employee"],
    }), now.toISOString(), now.toISOString()).run();
}

async function seedCurrentAndUpcomingSchedules() {
  await seedClockInSchedule();
  await db.prepare("DELETE FROM business_records").run();
  const now = new Date();
  const currentStart = vietnamDateAndClock(new Date(now.getTime() - 60 * 60_000));
  const boundary = vietnamDateAndClock(new Date(now.getTime() + 60 * 60_000));
  const nextEnd = vietnamDateAndClock(new Date(now.getTime() + 3 * 60 * 60_000));
  const timestamp = now.toISOString();
  const schedules = [
    {
      id: "location-current-schedule",
      title: "Ca hiện tại",
      data: {
        date: currentStart.date,
        shiftId: "location-current",
        shiftName: "Ca hiện tại",
        start: currentStart.clock,
        end: boundary.clock,
        employeeIds: ["location-employee"],
      },
    },
    {
      id: "location-upcoming-schedule",
      title: "Ca sau",
      data: {
        date: boundary.date,
        shiftId: "location-upcoming",
        shiftName: "Ca sau",
        start: boundary.clock,
        end: nextEnd.clock,
        employeeIds: ["location-employee"],
      },
    },
  ];
  for (const schedule of schedules) {
    await db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES (?, 'LICH_PHAN_CA', 'location-store', 'location-manager-user', ?, ?, 'ACTIVE', ?, ?)`)
      .bind(schedule.id, schedule.title, JSON.stringify(schedule.data), timestamp, timestamp).run();
  }
}

test("location validator enforces coordinates, bounded accuracy and server-relative freshness", () => {
  const serverNow = "2026-08-10T05:00:00.000Z";
  const valid = locationModule.validateClockInLocation({
    latitude: 10.045162,
    longitude: 105.746857,
    accuracyMeters: 12.5,
    capturedAt: "2026-08-10T04:59:30Z",
  }, serverNow);
  assert.equal(valid.ok, true);
  assert.equal(valid.location.capturedAt, "2026-08-10T04:59:30.000Z");

  assert.equal(locationModule.validateClockInLocation(undefined, serverNow).code, "LOCATION_REQUIRED");
  assert.equal(locationModule.validateClockInLocation({ latitude: 90.01, longitude: 0, accuracyMeters: 1, capturedAt: serverNow }, serverNow).code, "LOCATION_INVALID");
  assert.equal(locationModule.validateClockInLocation({ latitude: 0, longitude: -180.01, accuracyMeters: 1, capturedAt: serverNow }, serverNow).code, "LOCATION_INVALID");
  assert.equal(locationModule.validateClockInLocation({ latitude: 0, longitude: 0, accuracyMeters: -1, capturedAt: serverNow }, serverNow).code, "LOCATION_INVALID");
  assert.equal(locationModule.validateClockInLocation({ latitude: 0, longitude: 0, accuracyMeters: 100_001, capturedAt: serverNow }, serverNow).code, "LOCATION_INVALID");
  assert.equal(locationModule.validateClockInLocation({ latitude: 0, longitude: 0, accuracyMeters: 1, capturedAt: "2026-08-10T04:54:59.999Z" }, serverNow).code, "LOCATION_STALE");
  assert.equal(locationModule.validateClockInLocation({ latitude: 0, longitude: 0, accuracyMeters: 1, capturedAt: "2026-08-10T05:01:00.001Z" }, serverNow).code, "LOCATION_STALE");
});

test("additive migration preserves legacy attendance and leaves its location nullable", async () => {
  const migrationDb = new DatabaseSync(join(directory, "legacy-location.sqlite"));
  try {
    migrationDb.exec(`CREATE TABLE shift_sessions (
      id TEXT PRIMARY KEY, shift_code TEXT NOT NULL, started_at TEXT NOT NULL
    );
    INSERT INTO shift_sessions (id, shift_code, started_at)
      VALUES ('legacy-shift', 'LEGACY-1', '2026-08-01T00:00:00.000Z');`);
    migrationDb.exec(await readFile(new URL("../drizzle/0013_attendance_location.sql", import.meta.url), "utf8"));
    const legacy = migrationDb.prepare(`SELECT shift_code AS shiftCode,
      clock_in_latitude AS latitude, clock_in_longitude AS longitude,
      clock_in_accuracy_meters AS accuracyMeters,
      clock_in_location_captured_at AS capturedAt
      FROM shift_sessions WHERE id = 'legacy-shift'`).get();
    assert.deepEqual({ ...legacy }, {
      shiftCode: "LEGACY-1", latitude: null, longitude: null, accuracyMeters: null, capturedAt: null,
    });
  } finally {
    migrationDb.close();
  }
});

test("START requires a fresh location, records server attendance time, and exposes the immutable snapshot to managers", async () => {
  await seedClockInSchedule();
  const previewResponse = await shiftRoute.GET(authenticatedRequest("/api/shift?preview=start", employeeToken));
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.locationRequired, true);

  const missingResponse = await shiftRoute.POST(authenticatedRequest("/api/shift", employeeToken, "POST", {
    action: "start", expectedStart: preview.startPreview,
  }));
  assert.equal(missingResponse.status, 428);
  assert.equal((await missingResponse.json()).code, "LOCATION_REQUIRED");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'location-employee'").first()).count, 0);

  const capturedAt = new Date(Date.now() - 45_000).toISOString();
  const beforeRequest = Date.now();
  const startResponse = await shiftRoute.POST(authenticatedRequest("/api/shift", employeeToken, "POST", {
    action: "start",
    expectedStart: preview.startPreview,
    clockInLocation: { latitude: 10.045162, longitude: 105.746857, accuracyMeters: 8.25, capturedAt },
  }));
  const afterRequest = Date.now();
  const started = await startResponse.json();
  assert.equal(startResponse.status, 200);
  assert.ok(Date.parse(started.startedAt) >= beforeRequest && Date.parse(started.startedAt) <= afterRequest);
  assert.notEqual(started.startedAt, capturedAt, "client location time must not replace official server attendance time");

  const managerResponse = await shiftsRoute.GET(authenticatedRequest("/api/shifts?storeId=location-store", managerToken));
  const managerPayload = await managerResponse.json();
  assert.equal(managerResponse.status, 200);
  assert.equal(managerPayload.shifts.length, 1);
  assert.equal(managerPayload.shifts[0].clockInLatitude, 10.045162);
  assert.equal(managerPayload.shifts[0].clockInLongitude, 105.746857);
  assert.equal(managerPayload.shifts[0].clockInAccuracyMeters, 8.25);
  assert.equal(managerPayload.shifts[0].clockInLocationCapturedAt, capturedAt);

  const duplicateResponse = await shiftRoute.POST(authenticatedRequest("/api/shift", employeeToken, "POST", {
    action: "start",
    expectedStart: preview.startPreview,
    clockInLocation: { latitude: 0, longitude: 0, accuracyMeters: 1, capturedAt: new Date().toISOString() },
  }));
  assert.equal(duplicateResponse.status, 409);
  const persisted = await db.prepare(`SELECT clock_in_latitude AS latitude, clock_in_longitude AS longitude
    FROM shift_sessions WHERE employee_id = 'location-employee'`).first();
  assert.deepEqual({ ...persisted }, { latitude: 10.045162, longitude: 105.746857 });
});

test("START offers current and next shifts, rejects a changed identity, and persists the selected next shift", async () => {
  await seedCurrentAndUpcomingSchedules();
  const previewResponse = await shiftRoute.GET(authenticatedRequest("/api/shift?preview=start", employeeToken));
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.startMode, "CURRENT_OR_NEXT");
  assert.equal(preview.startCandidates.length, 2);
  const current = preview.startCandidates.find((candidate) => candidate.selectionKind === "CURRENT");
  const upcoming = preview.startCandidates.find((candidate) => candidate.selectionKind === "UPCOMING");
  assert.equal(current.attendanceStatus, "LATE");
  assert.ok(current.attendanceDeltaMinutes > 0);
  assert.equal(upcoming.attendanceStatus, "EARLY");
  assert.ok(upcoming.attendanceDeltaMinutes < 0);
  assert.match(upcoming.candidateId, /^[a-f0-9]{64}$/u);

  const tampered = await shiftRoute.POST(authenticatedRequest("/api/shift", employeeToken, "POST", {
    action: "start",
    expectedStart: { ...upcoming, selectionKind: "CURRENT" },
    clockInLocation: {
      latitude: 10.045162,
      longitude: 105.746857,
      accuracyMeters: 8,
      capturedAt: new Date().toISOString(),
    },
  }));
  assert.equal(tampered.status, 409);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'location-employee'").first()).count, 0);

  const startedResponse = await shiftRoute.POST(authenticatedRequest("/api/shift", employeeToken, "POST", {
    action: "start",
    expectedStart: upcoming,
    clockInLocation: {
      latitude: 10.045162,
      longitude: 105.746857,
      accuracyMeters: 8,
      capturedAt: new Date().toISOString(),
    },
  }));
  const started = await startedResponse.json();
  assert.equal(startedResponse.status, 200);
  assert.equal(started.shiftName, "Ca sau");
  assert.equal(started.selectionKind, "UPCOMING");
  assert.equal(started.attendanceStatus, "EARLY");
  const persisted = await db.prepare(`SELECT shift_name AS shiftName, status,
      attendance_status AS attendanceStatus, attendance_delta_minutes AS attendanceDeltaMinutes
    FROM shift_sessions WHERE employee_id = 'location-employee'`).first();
  assert.deepEqual({ ...persisted }, {
    shiftName: "Ca sau",
    status: "ACTIVE",
    attendanceStatus: "EARLY",
    attendanceDeltaMinutes: upcoming.attendanceDeltaMinutes,
  });
});
