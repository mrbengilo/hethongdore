import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const { createSqliteDatabase } = await import("../db/sqlite.ts");
const { requestIsCurrent } = await import("../app/lib/request-guard.ts");
const {
  commitScheduleBatch,
  scheduleBatchEntryId,
  scheduleBatchMarkerId,
  scheduleBatchPayloadHash,
  ScheduleBatchConflictError,
} = await import("../app/lib/schedule-batch.ts");

async function scheduleDatabase() {
  const db = await createSqliteDatabase();
  await db.prepare(`CREATE TABLE business_records (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    store_id TEXT,
    owner_id TEXT,
    title TEXT NOT NULL,
    data_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE daily_shift_definitions (
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL, work_date TEXT NOT NULL,
    name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    version INTEGER NOT NULL, status TEXT NOT NULL
  )`).run();
  await db.prepare("CREATE TABLE stores (id TEXT PRIMARY KEY, status TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, store_id TEXT, is_super_admin INTEGER NOT NULL DEFAULT 0)").run();
  await db.prepare("CREATE TABLE employees (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, status TEXT NOT NULL)").run();
  await db.prepare(`CREATE TABLE employee_transfers (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, target_store_id TEXT NOT NULL,
    status TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE employee_payroll_closings (
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE financial_periods (
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, store_id TEXT, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT,
    before_json TEXT, after_json TEXT, reason TEXT, created_at TEXT NOT NULL
  )`).run();
  await db.prepare("INSERT INTO stores (id, status) VALUES ('store-1', 'ACTIVE')").run();
  await db.prepare("INSERT INTO users (id, role, store_id, is_super_admin) VALUES ('manager-1', 'MANAGER', 'store-1', 0)").run();
  await db.prepare("INSERT INTO employees (id, store_id, status) VALUES ('employee-1', 'store-1', 'ACTIVE')").run();
  return db;
}

async function scheduleBatchInput({
  clientRequestId = "d11a849d-d2de-458d-995b-f773b032fe30",
  note = "Ca cuối tuần",
  shiftIds = ["default-1", "default-2"],
  definitionVersion,
} = {}) {
  const storeId = "store-1";
  const date = "2026-08-09";
  const employeeIds = ["employee-1"];
  const definitions = {
    "default-1": { shiftName: "Ca 1", start: "08:00", end: "12:00", startAt: "2026-08-09T01:00:00.000Z", endAt: "2026-08-09T05:00:00.000Z" },
    "default-2": { shiftName: "Ca 2", start: "12:00", end: "17:00", startAt: "2026-08-09T05:00:00.000Z", endAt: "2026-08-09T10:00:00.000Z" },
  };
  const canonicalEntries = shiftIds.map((shiftId) => ({ shiftId, ...definitions[shiftId], ...(definitionVersion ? { shiftDefinitionVersion: definitionVersion } : {}) }));
  const payloadHash = await scheduleBatchPayloadHash({
    storeId,
    date,
    employeeIds,
    note,
    entries: canonicalEntries.map(({ shiftId, shiftName, start, end }) => ({ shiftId, shiftName, start, end })),
  });
  const entries = await Promise.all(canonicalEntries.map(async (definition) => ({
    id: await scheduleBatchEntryId(storeId, clientRequestId, definition.shiftId),
    title: `${definition.shiftName} · ${date}`,
    data: { date, ...definition, employeeIds, note, batchRequestId: clientRequestId, batchPayloadHash: payloadHash },
  })));
  return {
    markerId: await scheduleBatchMarkerId(storeId, clientRequestId),
    storeId,
    ownerId: "manager-1",
    clientRequestId,
    payloadHash,
    date,
    entries,
    now: "2026-08-09T00:00:00.000Z",
    reason: "Tạo lịch phân ca theo kế hoạch",
  };
}

async function schedulingModule() {
  const source = await readFile(new URL("../app/lib/scheduling.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("calculates regular and overnight shift durations", async () => {
  const { formatShiftDuration, isOvernightShift, shiftDurationMinutes } = await schedulingModule();
  assert.equal(shiftDurationMinutes("07:00", "15:00"), 480);
  assert.equal(shiftDurationMinutes("22:00", "07:00"), 540);
  assert.equal(shiftDurationMinutes("07:00", "07:00"), 0);
  assert.equal(shiftDurationMinutes("not-a-clock", "07:00"), 0);
  assert.equal(isOvernightShift("22:00", "07:00"), true);
  assert.equal(isOvernightShift("07:00", "15:00"), false);
  assert.equal(formatShiftDuration(540), "9 giờ");
});

test("latest-request predicate rejects both stale and aborted responses", () => {
  const first = new AbortController();
  assert.equal(requestIsCurrent(1, 1, first.signal.aborted), true);
  assert.equal(requestIsCurrent(1, 2, first.signal.aborted), false);
  const second = new AbortController();
  second.abort();
  assert.equal(requestIsCurrent(2, 2, second.signal.aborted), false);
});

test("builds a Monday-to-Sunday week around the selected date", async () => {
  const { addDays, weekDates } = await schedulingModule();
  assert.equal(addDays("2026-08-06", 1), "2026-08-07");
  assert.equal(addDays("2026-08-01", -1), "2026-07-31");
  assert.deepEqual(weekDates("2026-08-06"), [
    "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
    "2026-08-07", "2026-08-08", "2026-08-09",
  ]);
});

test("detects conflicts including an overnight shift crossing into the next day", async () => {
  const { shiftsOverlap } = await schedulingModule();
  assert.equal(shiftsOverlap("2026-08-06", "07:00", "15:00", "2026-08-06", "14:00", "22:00"), true);
  assert.equal(shiftsOverlap("2026-08-06", "07:00", "15:00", "2026-08-06", "15:00", "22:00"), false);
  assert.equal(shiftsOverlap("2026-08-06", "22:00", "07:00", "2026-08-07", "06:00", "10:00"), true);
  assert.equal(shiftsOverlap("2026-08-06", "22:00", "07:00", "2026-08-07", "07:00", "15:00"), false);
});

test("orders numbered shifts from Ca 1 to Ca 2 to Ca 3 regardless of API order", async () => {
  const { compareShiftDefinitions } = await schedulingModule();
  const shifts = [
    { name: "Ca 3", start: "17:00", end: "21:00" },
    { name: "Ca 1", start: "08:00", end: "12:00" },
    { name: "Ca 2", start: "12:00", end: "17:00" },
  ];
  assert.deepEqual(shifts.sort(compareShiftDefinitions).map((shift) => shift.name), ["Ca 1", "Ca 2", "Ca 3"]);
});

test("builds one stable record id for every retried schedule request", async () => {
  const { normalizeScheduleClientRequestId, scheduleRecordId } = await schedulingModule();
  const requestId = "d11a849d-d2de-458d-995b-f773b032fe30:default-1";
  assert.equal(normalizeScheduleClientRequestId(requestId), requestId);
  assert.equal(normalizeScheduleClientRequestId("short"), null);
  const first = await scheduleRecordId("store-1", requestId);
  const retry = await scheduleRecordId("store-1", requestId);
  assert.equal(first, retry);
  assert.match(first, /^schedule-[a-f0-9]{64}$/u);
});

test("schedule batch rolls back every row when any insert fails", async () => {
  const db = await scheduleDatabase();
  try {
    const input = await scheduleBatchInput();
    const colliding = input.entries[1];
    await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES (?, 'LEGACY', ?, ?, 'legacy', '{}', 'ACTIVE', ?, ?)`)
      .bind(colliding.id, input.storeId, input.ownerId, input.now, input.now).run();

    await assert.rejects(commitScheduleBatch(db, input));
    const rows = await db.prepare("SELECT id, category FROM business_records ORDER BY id").all();
    assert.deepEqual(rows.results.map((row) => ({ ...row })), [{ id: colliding.id, category: "LEGACY" }]);
  } finally {
    db.close();
  }
});

test("retrying an identical schedule batch is idempotent", async () => {
  const db = await scheduleDatabase();
  try {
    const input = await scheduleBatchInput();
    assert.deepEqual(await commitScheduleBatch(db, input), { status: "CREATED", entryIds: input.entries.map((entry) => entry.id) });
    assert.deepEqual(await commitScheduleBatch(db, input), { status: "IDEMPOTENT", entryIds: input.entries.map((entry) => entry.id).sort() });
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 3);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs").first()).count, 1);
    const audit = await db.prepare(`SELECT user_id AS userId, store_id AS storeId, action,
      before_json AS beforeJson, after_json AS afterJson, reason, created_at AS createdAt
      FROM audit_logs`).first();
    assert.deepEqual({ userId: audit.userId, storeId: audit.storeId, action: audit.action, beforeJson: audit.beforeJson }, {
      userId: "manager-1", storeId: "store-1", action: "CREATE_SCHEDULE_BATCH", beforeJson: null,
    });
    assert.equal(JSON.parse(audit.afterJson).entries.length, 2);
    assert.equal(audit.reason, input.reason);
    assert.equal(audit.createdAt, input.now);
  } finally {
    db.close();
  }
});

test("reusing a schedule batch key with different payload is rejected without writes", async () => {
  const db = await scheduleDatabase();
  try {
    const original = await scheduleBatchInput();
    const changed = await scheduleBatchInput({ note: "Nội dung đã đổi" });
    await commitScheduleBatch(db, original);
    const result = await commitScheduleBatch(db, changed);
    assert.equal(result.status, "PAYLOAD_MISMATCH");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 3);
    const stored = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE id = ?").bind(original.entries[0].id).first();
    assert.equal(JSON.parse(stored.dataJson).note, "Ca cuối tuần");
  } finally {
    db.close();
  }
});

test("atomic commit guard prevents a different request from racing into an overlapping assignment", async () => {
  const db = await scheduleDatabase();
  try {
    const first = await scheduleBatchInput({ shiftIds: ["default-1"] });
    const competing = await scheduleBatchInput({
      clientRequestId: "06b331d5-f981-456e-b66c-da592e0d7948",
      shiftIds: ["default-1"],
    });
    await commitScheduleBatch(db, first);
    await assert.rejects(commitScheduleBatch(db, competing), ScheduleBatchConflictError);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 2);
  } finally {
    db.close();
  }
});

test("atomic batch rejects a daily shift changed between validation and commit", async () => {
  const db = await scheduleDatabase();
  try {
    const input = await scheduleBatchInput({ shiftIds: ["default-1"], definitionVersion: 1 });
    await db.prepare(`INSERT INTO daily_shift_definitions
      (id, store_id, work_date, name, start_time, end_time, version, status)
      VALUES ('default-1', 'store-1', '2026-08-09', 'Ca 1', '08:00', '12:00', 1, 'ACTIVE')`).run();
    await db.prepare("UPDATE daily_shift_definitions SET start_time = '09:00', version = 2 WHERE id = 'default-1'").run();
    await assert.rejects(commitScheduleBatch(db, input), ScheduleBatchConflictError);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 0);
  } finally {
    db.close();
  }
});

test("store deletion winning between validation and marker commit leaves the schedule batch inert", async () => {
  const db = await scheduleDatabase();
  const originalBatch = db.batch.bind(db);
  let deletionInjected = false;
  db.batch = async (statements) => {
    if (!deletionInjected) {
      deletionInjected = true;
      await db.prepare("UPDATE stores SET status = 'DELETED' WHERE id = 'store-1'").run();
    }
    return originalBatch(statements);
  };
  try {
    const input = await scheduleBatchInput({ shiftIds: ["default-1"] });
    await assert.rejects(commitScheduleBatch(db, input), ScheduleBatchConflictError);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 0);
    assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'store-1'").first("status"), "DELETED");
  } finally {
    db.batch = originalBatch;
    db.close();
  }
});

test("marker atomically rechecks manager and employee invariants without treating an employee closing as a store lock", async () => {
  const db = await scheduleDatabase();
  try {
    const input = await scheduleBatchInput({ shiftIds: ["default-1"] });

    await db.prepare("UPDATE users SET store_id = 'store-2' WHERE id = 'manager-1'").run();
    await assert.rejects(commitScheduleBatch(db, input), ScheduleBatchConflictError);
    await db.prepare("UPDATE users SET store_id = 'store-1' WHERE id = 'manager-1'").run();

    await db.prepare("UPDATE employees SET status = 'INACTIVE' WHERE id = 'employee-1'").run();
    await assert.rejects(commitScheduleBatch(db, input), ScheduleBatchConflictError);
    await db.prepare("UPDATE employees SET status = 'ACTIVE' WHERE id = 'employee-1'").run();

    await db.prepare("INSERT INTO employee_payroll_closings (id, store_id, period, status) VALUES ('lock-1', 'store-1', '2026-08', 'LOCKED')").run();
    assert.deepEqual(await commitScheduleBatch(db, input), {
      status: "CREATED",
      entryIds: input.entries.map((entry) => entry.id),
    });
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs").first()).count, 1);
  } finally {
    db.close();
  }
});

test("canonical confirmed lifecycle states block the schedule marker, entries and audit atomically", async () => {
  for (const status of ["CONFIRMED", "PAID", "LOCKED"]) {
    const db = await scheduleDatabase();
    try {
      const input = await scheduleBatchInput({
        clientRequestId: `d11a849d-d2de-458d-995b-f773b032f${status === "CONFIRMED" ? "e31" : status === "PAID" ? "e32" : "e33"}`,
        shiftIds: ["default-1"],
      });
      await db.prepare("INSERT INTO financial_periods VALUES (?, 'store-1', '2026-08', ?)")
        .bind(`period-${status}`, status).run();
      await assert.rejects(commitScheduleBatch(db, input), ScheduleBatchConflictError);
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 0, status);
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs").first()).count, 0, status);
    } finally {
      db.close();
    }
  }
});

test("schedule marker uses canonical editable state before legacy fallback and preserves old locked-period compatibility", async () => {
  const canonicalDb = await scheduleDatabase();
  try {
    const input = await scheduleBatchInput({ clientRequestId: "d11a849d-d2de-458d-995b-f773b032fe34", shiftIds: ["default-1"] });
    await canonicalDb.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('legacy-lock', 'PAYROLL_CLOSING', 'store-1', 'manager-1', 'Khóa cũ', '{"period":"2026-08"}', 'LOCKED', ?, ?)`)
      .bind(input.now, input.now).run();
    await canonicalDb.prepare("INSERT INTO financial_periods VALUES ('period-draft', 'store-1', '2026-08', 'DRAFT')").run();
    assert.equal((await commitScheduleBatch(canonicalDb, input)).status, "CREATED");
  } finally {
    canonicalDb.close();
  }

  const legacyDb = await scheduleDatabase();
  try {
    const input = await scheduleBatchInput({ clientRequestId: "d11a849d-d2de-458d-995b-f773b032fe35", shiftIds: ["default-1"] });
    await legacyDb.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('legacy-lock', 'PAYROLL_CLOSING', 'store-1', 'manager-1', 'Khóa cũ', '{"period":"2026-08"}', 'LOCKED', ?, ?)`)
      .bind(input.now, input.now).run();
    await assert.rejects(commitScheduleBatch(legacyDb, input), ScheduleBatchConflictError);
    assert.equal((await legacyDb.prepare("SELECT COUNT(*) AS count FROM business_records WHERE category = 'LICH_PHAN_CA_BATCH'").first()).count, 0);
    assert.equal((await legacyDb.prepare("SELECT COUNT(*) AS count FROM audit_logs").first()).count, 0);
  } finally {
    legacyDb.close();
  }
});

test("schedule batch rolls marker and every entry back when structured audit insertion fails", async () => {
  const db = await scheduleDatabase();
  try {
    await db.prepare(`CREATE TRIGGER reject_schedule_audit BEFORE INSERT ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'schedule audit failure'); END`).run();
    const input = await scheduleBatchInput();
    await assert.rejects(commitScheduleBatch(db, input), /schedule audit failure/u);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM business_records").first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs").first()).count, 0);
  } finally {
    db.close();
  }
});

test("serializes Vietnam-local shifts as complete UTC ranges", async () => {
  const { shiftUtcRange } = await schedulingModule();
  assert.deepEqual(shiftUtcRange("2026-08-06", "07:00", "15:00"), {
    startAt: "2026-08-06T00:00:00.000Z",
    endAt: "2026-08-06T08:00:00.000Z",
  });
  assert.deepEqual(shiftUtcRange("2026-08-06", "22:00", "07:00"), {
    startAt: "2026-08-06T15:00:00.000Z",
    endAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(shiftUtcRange("2026-08-06", "07:00", "07:00"), null);
});

test("resolves only the occurrence that is actually open, including boundaries and overnight shifts", async () => {
  const { shiftOccurrenceAt } = await schedulingModule();
  const shifts = [
    { name: "Ca 1", start: "07:00", end: "12:00" },
    { name: "Ca 2", start: "12:00", end: "17:00" },
    { name: "Ca đêm", start: "22:00", end: "06:00" },
  ];

  assert.equal(shiftOccurrenceAt("2026-08-06T04:59:59.999Z", shifts)?.name, "Ca 1");
  assert.equal(shiftOccurrenceAt("2026-08-06T05:00:00.000Z", shifts)?.name, "Ca 2");
  assert.equal(shiftOccurrenceAt("2026-08-06T11:00:00.000Z", shifts), null);
  assert.deepEqual(shiftOccurrenceAt("2026-08-06T20:00:00.000Z", shifts), {
    name: "Ca đêm",
    start: "22:00",
    end: "06:00",
    workDate: "2026-08-06",
    startAt: "2026-08-06T15:00:00.000Z",
    endAt: "2026-08-06T23:00:00.000Z",
  });
});

test("attendance is on time through exactly 15 minutes and late one millisecond later", async () => {
  const {
    ATTENDANCE_ON_TIME_GRACE_MINUTES,
    attendanceDeltaMinutes,
    attendanceOccurrenceAt,
    attendanceStatusAt,
  } = await schedulingModule();
  const shifts = [{ name: "Ca 1", start: "08:00", end: "12:00" }];

  assert.equal(ATTENDANCE_ON_TIME_GRACE_MINUTES, 15);
  assert.equal(attendanceOccurrenceAt("2026-08-05T23:00:00.000Z", shifts)?.name, "Ca 1");
  assert.equal(attendanceOccurrenceAt("2026-08-05T22:59:59.999Z", shifts), null);
  assert.equal(attendanceStatusAt("2026-08-06T00:59:00.000Z", "2026-08-06T01:00:00.000Z"), "EARLY");
  assert.equal(attendanceStatusAt("2026-08-06T00:59:59.999Z", "2026-08-06T01:00:00.000Z"), "EARLY");
  assert.equal(attendanceStatusAt("2026-08-06T01:00:00.000Z", "2026-08-06T01:00:00.000Z"), "ON_TIME");
  assert.equal(attendanceStatusAt("2026-08-06T01:01:00.000Z", "2026-08-06T01:00:00.000Z"), "ON_TIME");
  assert.equal(attendanceStatusAt("2026-08-06T01:15:00.000Z", "2026-08-06T01:00:00.000Z"), "ON_TIME");
  assert.equal(attendanceStatusAt("2026-08-06T01:15:00.001Z", "2026-08-06T01:00:00.000Z"), "LATE");
  assert.equal(attendanceDeltaMinutes("2026-08-06T00:59:59.999Z", "2026-08-06T01:00:00.000Z"), -1);
  assert.equal(attendanceDeltaMinutes("2026-08-06T01:00:00.001Z", "2026-08-06T01:00:00.000Z"), 1);
  assert.equal(attendanceDeltaMinutes("2026-08-06T01:15:00.000Z", "2026-08-06T01:00:00.000Z"), 15);
  assert.equal(attendanceDeltaMinutes("2026-08-06T01:15:00.001Z", "2026-08-06T01:00:00.000Z"), 16);
});

test("attendance candidates use the same inclusive 15-minute boundary as START preview", async () => {
  const { attendanceCandidatesAt } = await schedulingModule();
  const shifts = [{ name: "Ca 1", start: "08:00", end: "12:00" }];

  const exactBoundary = attendanceCandidatesAt("2026-08-06T01:15:00.000Z", shifts)[0];
  const oneMillisecondLate = attendanceCandidatesAt("2026-08-06T01:15:00.001Z", shifts)[0];
  assert.deepEqual({ status: exactBoundary.attendanceStatus, delta: exactBoundary.attendanceDeltaMinutes }, {
    status: "ON_TIME", delta: 15,
  });
  assert.deepEqual({ status: oneMillisecondLate.attendanceStatus, delta: oneMillisecondLate.attendanceDeltaMinutes }, {
    status: "LATE", delta: 16,
  });
});

test("attendance grace migration normalizes every historical row and is idempotent", async () => {
  const migration = await readFile(new URL("../drizzle/0021_attendance_grace_period.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE shift_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      scheduled_start_at TEXT,
      attendance_status TEXT,
      attendance_delta_minutes INTEGER
    );
    INSERT INTO shift_sessions VALUES
      ('early', '2026-08-06T00:59:59.999Z', '2026-08-06T01:00:00.000Z', 'LATE', 99),
      ('start', '2026-08-06T01:00:00.000Z', '2026-08-06T01:00:00.000Z', 'LATE', 99),
      ('grace', '2026-08-06T01:15:00.000Z', '2026-08-06T01:00:00.000Z', 'LATE', 99),
      ('late', '2026-08-06T01:15:00.001Z', '2026-08-06T01:00:00.000Z', 'ON_TIME', 15);`);
    database.exec(migration);
    const normalized = database.prepare(`SELECT id, attendance_status AS status,
      attendance_delta_minutes AS delta FROM shift_sessions ORDER BY id`).all().map((row) => ({ ...row }));
    assert.deepEqual(normalized, [
      { id: "early", status: "EARLY", delta: -1 },
      { id: "grace", status: "ON_TIME", delta: 15 },
      { id: "late", status: "LATE", delta: 16 },
      { id: "start", status: "ON_TIME", delta: 0 },
    ]);
    database.exec(migration);
    assert.deepEqual(
      database.prepare(`SELECT id, attendance_status AS status,
        attendance_delta_minutes AS delta FROM shift_sessions ORDER BY id`).all().map((row) => ({ ...row })),
      normalized,
    );
  } finally {
    database.close();
  }
});

test("START snapshots the current policy while closures and admin edits reuse each row snapshot", async () => {
  const [shiftApi, lifecycle, employeesApi, resetItems, runtime] = await Promise.all([
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_lib/employee-lifecycle.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/employees/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/reset-data/items/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [shiftApi, lifecycle, employeesApi, resetItems]) assert.match(source, /attendanceStatusAt\(/u);
  for (const source of [lifecycle, employeesApi, resetItems]) assert.match(source, /attendanceGraceMinutes/u);
  assert.match(shiftApi, /loadAttendancePolicy/u);
  assert.match(shiftApi, /attendance_grace_minutes/u);
  assert.match(runtime, /COALESCE\(attendance_grace_minutes, \$\{DEFAULT_ATTENDANCE_GRACE_MINUTES\}\) \* 60000/u);
  assert.match(runtime, /attendance_status IS NULL OR attendance_delta_minutes IS NULL/u);
});

test("attendance candidates expose current and eligible next shifts with signed deltas", async () => {
  const { attendanceCandidatesAt } = await schedulingModule();
  const shifts = [
    { name: "Ca 1", start: "08:00", end: "12:00" },
    { name: "Ca 2", start: "12:00", end: "17:00" },
    { name: "Ca 3", start: "17:00", end: "21:00" },
  ];

  const choices = attendanceCandidatesAt("2026-08-06T03:30:00.000Z", shifts);
  assert.deepEqual(choices.map((choice) => ({
    name: choice.name,
    selectionKind: choice.selectionKind,
    attendanceStatus: choice.attendanceStatus,
    attendanceDeltaMinutes: choice.attendanceDeltaMinutes,
  })), [
    { name: "Ca 1", selectionKind: "CURRENT", attendanceStatus: "LATE", attendanceDeltaMinutes: 150 },
    { name: "Ca 2", selectionKind: "UPCOMING", attendanceStatus: "EARLY", attendanceDeltaMinutes: -90 },
  ]);
});

test("schedule interface exposes the requested day, week, employee and save flow", async () => {
  const source = await readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8");
  assert.match(source, />Theo ngày</u);
  assert.match(source, />Theo tuần</u);
  assert.match(source, />Theo nhân viên</u);
  assert.match(source, /Chọn ca làm việc/u);
  assert.match(source, /Chọn nhân viên/u);
  assert.match(source, /: "LƯU"\}/u);
});

test("schedule editor keeps shifts, employees, note and save on one continuous screen", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url), "utf8"),
  ]);
  const editor = source.slice(source.lastIndexOf("{open &&"));
  const shiftPosition = editor.indexOf("scheduleShiftPicker");
  const employeePosition = editor.indexOf("employeePicker");
  const notePosition = editor.indexOf("Ghi chú");
  const savePosition = editor.indexOf('aria-label={editing ? "Cập nhật lịch phân ca" : "Lưu lịch phân ca"}');
  assert.ok(shiftPosition >= 0 && shiftPosition < employeePosition);
  assert.ok(employeePosition < notePosition && notePosition < savePosition);
  assert.doesNotMatch(source, /setStep\(/u);
  assert.match(source, /Chọn một hoặc nhiều ca, nhân viên và ghi chú trên cùng một màn hình/u);
  assert.match(css, /\.scheduleShiftPicker\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/su);
});

test("schedule creation uses one atomic idempotent batch while editing remains single-record", async () => {
  const [source, recordsApi, batchSource] = await Promise.all([
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/records/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/schedule-batch.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /const \[shiftIds, setShiftIds\] = useState<string\[\]>\(\[\]\)/u);
  assert.match(source, /type=\{editing \? "radio" : "checkbox"\}/u);
  assert.match(source, /await saveScheduleBatch\(\{/u);
  assert.doesNotMatch(source, /Promise\.all\(selectedShifts\.map/u);
  assert.match(source, /action: "CREATE_SCHEDULE_BATCH"/u);
  assert.ok((source.match(/setBatchRequestId\(crypto\.randomUUID\(\)\)/g) ?? []).length >= 4);
  assert.match(recordsApi, /if \(body\.action === "CREATE_SCHEDULE_BATCH"\) \{/u);
  assert.match(recordsApi, /if \(!body\.storeId \|\| !managerCanAccessStore\(user, body\.storeId\)\) return json\(\{ message: MANAGER_STORE_SCOPE_MESSAGE \}, 403\);/u);
  assert.match(recordsApi, /return createScheduleBatch\(db, user\.id, body\);/u);
  assert.match(recordsApi, /const previous = await inspectScheduleBatch\(db, commitBase\)[\s\S]*previous\?\.status === "IDEMPOTENT"[\s\S]*const validations = await Promise\.all/su);
  assert.match(recordsApi, /body\.category === "LICH_PHAN_CA"[\s\S]*thao tác lô nguyên tử/su);
  assert.match(batchSource, /const results = await db\.batch\(statements\)/u);
  assert.match(batchSource, /AND NOT EXISTS \([\s\S]*json_each\(json_extract\(existing\.data_json, '\$\.employeeIds'\)\)/su);
  assert.match(batchSource, /json_extract\(existing\.data_json, '\$\.startAt'\) < \?[\s\S]*json_extract\(existing\.data_json, '\$\.endAt'\) > \?/su);
  assert.doesNotMatch(batchSource, /ON CONFLICT/u);
  assert.match(recordsApi, /DEFAULT_SHIFT_DEFINITIONS\[Number\(defaultMatch\[1\]\) - 1\]/u);
});

test("schedule edit and delete couple CAS, period locks and structured audit to one mutation", async () => {
  const [source, editor] = await Promise.all([
    readFile(new URL("../app/api/records/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /existingCategory === "LICH_PHAN_CA"[\s\S]*scheduleMutationId = `schedule-update:\$\{crypto\.randomUUID\(\)\}`[\s\S]*const results = await db\.batch\(\[/u);
  assert.match(source, /category = 'LICH_PHAN_CA' AND status != 'DELETED' AND updated_at = \?[\s\S]*oldPeriodGuard[\s\S]*incomingPeriodLockGuardSql/u);
  assert.match(source, /'UPDATE_SCHEDULE', 'LICH_PHAN_CA'[\s\S]*before_json, after_json, reason, created_at/u);
  assert.match(source, /json_extract\(schedule\.data_json, '\$\.scheduleMutationId'\) = \?/u);
  assert.match(source, /existing\.category === "LICH_PHAN_CA" && existing\.storeId[\s\S]*scheduleMutationId = `schedule-delete:\$\{crypto\.randomUUID\(\)\}`[\s\S]*const results = await db\.batch\(\[/u);
  assert.match(source, /SET data_json = \?, status = 'DELETED', updated_at = \?[\s\S]*schedulePeriodGuard/u);
  assert.match(source, /'DELETE_SCHEDULE', 'LICH_PHAN_CA'[\s\S]*requestedDeleteReason/u);
  assert.match(source, /Vui lòng nhập lý do chỉnh sửa lịch phân ca/u);
  assert.match(source, /Vui lòng nhập lý do xóa lịch phân ca/u);
  assert.match(editor, /scheduleReason/u);
  assert.match(editor, /window\.prompt\("Nhập lý do xóa lịch phân ca/u);
});

test("schedule screen creates versioned shifts for only the selected day and mobile cards stay compact", async () => {
  const [source, dailyApi, dailyLibrary, shiftApi, portal, css] = await Promise.all([
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/daily-shifts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/daily-shifts.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /useDailyShifts\(store\.id, date\)/u);
  assert.match(source, /Tạo ca làm việc/u);
  assert.match(source, /workDate: date/u);
  assert.match(source, /version: editingShift\?\.version/u);
  assert.match(source, /Lịch đã phân và ca đã phát sinh vẫn được giữ nguyên/u);
  assert.match(dailyLibrary, /CREATE_DAILY_SHIFT/u);
  assert.match(dailyLibrary, /UPDATE_DAILY_SHIFT/u);
  assert.match(dailyLibrary, /DELETE_DAILY_SHIFT/u);
  assert.doesNotMatch(dailyApi, /writeAudit/u);
  assert.match(dailyLibrary, /status = 'DELETED', version = version \+ 1/u);
  assert.match(shiftApi, /category = 'LICH_PHAN_CA' AND store_id = \? AND status != 'DELETED'/u);
  const storeMenu = portal.match(/const storeMenu = \[([^\]]+)\]/u)?.[1] ?? "";
  assert.doesNotMatch(storeMenu, /Ca làm việc/u);
  assert.match(storeMenu, /Lịch phân ca/u);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.shiftCard\s*\{[\s\S]*?flex:\s*0 0 min\(198px, 66vw\);[\s\S]*?min-height:\s*90px;/u);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.shiftCard\s*\{[\s\S]*?flex-basis:\s*min\(180px, 72vw\);[\s\S]*?min-height:\s*84px;/u);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.shiftCard > i,[\s\S]*?display:\s*none;/u);
});

test("schedule data hooks abort superseded requests and guard success, failure and loading state", async () => {
  const source = await readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/const requestSequence = useRef\(0\)/gu) ?? []).length, 3);
  assert.equal((source.match(/const requestController = useRef<AbortController \| null>\(null\)/gu) ?? []).length, 3);
  assert.equal((source.match(/requestController\.current\?\.abort\(\)/gu) ?? []).length, 6);
  assert.equal((source.match(/const requestId = \+\+requestSequence\.current/gu) ?? []).length, 3);
  assert.ok((source.match(/requestIsCurrent\(requestId, requestSequence\.current, controller\.signal\.aborted\)/gu) ?? []).length >= 9);
  assert.match(source, /fetch\(`\/api\/records\?\$\{query\}`, \{ signal: controller\.signal \}\)/u);
  assert.match(source, /fetch\(`\/api\/employees\?storeId=[^`]+`, \{ signal: controller\.signal \}\)/u);
  assert.match(source, /fetch\(`\/api\/daily-shifts\?\$\{query\}`, \{ cache: "no-store", signal: controller\.signal \}\)/u);
});

test("shift cards never wrap and persisted shifts and schedules show a 24-hour update timestamp", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.shiftCards\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/su);
  assert.match(css, /\.compactShiftCards/u);
  assert.match(source, /hourCycle:\s*"h23"/u);
  assert.match(source, /timeZone:\s*"Asia\/Ho_Chi_Minh"/u);
  assert.match(source, /shift\.updatedAt \?\? shift\.record\?\.updated_at \?\? shift\.record\?\.created_at/u);
  assert.match(source, /entry\.record\.updated_at \?\? entry\.record\.created_at/u);
  assert.match(css, /\.scheduleTable thead th b,[\s\S]*display:\s*block;/u);
});
