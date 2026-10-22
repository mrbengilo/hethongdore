import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL("../drizzle/0029_shift_attendance_integrity.sql", import.meta.url);
const journalUrl = new URL("../drizzle/meta/_journal.json", import.meta.url);
const runtimeUrl = new URL("../db/runtime.ts", import.meta.url);
const schemaUrl = new URL("../db/schema.ts", import.meta.url);

const integrityColumns = [
  "source_schedule_record_id",
  "source_schedule_updated_at",
  "attendance_early_window_minutes",
  "attendance_max_shift_minutes",
  "reconciliation_status",
  "reconciliation_reason",
  "reconciled_at",
  "reconciled_by",
];

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function applyMigration(db, source) {
  for (const statement of migrationStatements(source)) db.exec(statement);
}

function expectDbError(callback, pattern = /integrity|ACTIVE shift|LOCKED financial period|constraint/u) {
  assert.throws(callback, pattern);
}

function createLegacyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE financial_periods (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (store_id, period)
    );

    CREATE TABLE daily_shift_definitions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      work_date TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      version INTEGER NOT NULL DEFAULT 1,
      client_request_id TEXT,
      payload_hash TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE shift_sessions (
      id TEXT PRIMARY KEY,
      shift_code TEXT NOT NULL UNIQUE,
      store_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      shift_name TEXT,
      scheduled_start TEXT,
      scheduled_end TEXT,
      scheduled_start_at TEXT,
      scheduled_end_at TEXT,
      work_date TEXT,
      previous_session_id TEXT,
      transfer_id TEXT,
      applied_hourly_rate INTEGER,
      applied_tiktok_allowance INTEGER,
      started_at TEXT NOT NULL,
      attendance_status TEXT,
      attendance_delta_minutes INTEGER,
      attendance_grace_minutes INTEGER NOT NULL DEFAULT 15,
      clock_in_latitude REAL,
      clock_in_longitude REAL,
      clock_in_accuracy_meters REAL,
      clock_in_location_captured_at TEXT,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      admin_adjusted_duration_seconds INTEGER,
      tiktok INTEGER NOT NULL DEFAULT 0,
      tiktok_allowance INTEGER NOT NULL DEFAULT 0,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      expense_amount INTEGER NOT NULL DEFAULT 0,
      expense_note TEXT,
      cash_revenue INTEGER NOT NULL DEFAULT 0,
      transfer_revenue INTEGER NOT NULL DEFAULT 0,
      close_reason TEXT,
      close_status TEXT NOT NULL DEFAULT 'PENDING',
      status TEXT NOT NULL DEFAULT 'ACTIVE'
    );

    INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, started_at, work_date, status)
    VALUES
      ('legacy-active-1', 'LEGACY-1', 'legacy-store', 'legacy-employee',
       '2026-08-20T01:00:00.000Z', '2026-08-20', 'ACTIVE'),
      ('legacy-active-2', 'LEGACY-2', 'legacy-store', 'legacy-employee',
       '2026-08-20T02:00:00.000Z', '2026-08-20', 'ACTIVE');

    INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, started_at, work_date,
       attendance_status, attendance_delta_minutes, ended_at, duration_seconds, status)
    VALUES
      ('legacy-completed', 'LEGACY-COMPLETED', 'legacy-store', 'former-employee',
       'legacy timestamp', NULL, 'LATE', 30, NULL, 0, 'COMPLETED');
  `);
  return db;
}

function insertSession(db, overrides = {}) {
  const row = {
    id: "session-1",
    shiftCode: "SHIFT-1",
    storeId: "store-1",
    employeeId: "employee-1",
    shiftName: "Ca 1",
    scheduledStart: "08:00",
    scheduledEnd: "12:00",
    scheduledStartAt: "2026-08-24T01:00:00.000Z",
    scheduledEndAt: "2026-08-24T05:00:00.000Z",
    workDate: "2026-08-24",
    sourceScheduleRecordId: "schedule-1",
    sourceScheduleUpdatedAt: "2026-08-23T10:00:00.000Z",
    appliedHourlyRate: 20_000,
    appliedTikTokAllowance: 25_000,
    startedAt: "2026-08-24T01:00:00.000Z",
    attendanceStatus: "ON_TIME",
    attendanceDeltaMinutes: 0,
    attendanceGraceMinutes: 15,
    attendanceEarlyWindowMinutes: 60,
    attendanceMaxShiftMinutes: 480,
    clockInLatitude: 10.762622,
    clockInLongitude: 106.660172,
    clockInAccuracyMeters: 12.5,
    clockInLocationCapturedAt: "2026-08-24T01:00:00.000Z",
    endedAt: null,
    durationSeconds: 0,
    adminAdjustedDurationSeconds: null,
    tiktok: 0,
    tiktokAllowance: 0,
    tasksCompleted: 0,
    expenseAmount: 0,
    cashRevenue: 0,
    transferRevenue: 0,
    reconciliationStatus: "CLEAR",
    reconciliationReason: null,
    reconciledAt: null,
    reconciledBy: null,
    status: "ACTIVE",
    ...overrides,
  };

  return db.prepare(`INSERT INTO shift_sessions (
      id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end,
      scheduled_start_at, scheduled_end_at, work_date,
      source_schedule_record_id, source_schedule_updated_at,
      applied_hourly_rate, applied_tiktok_allowance, started_at,
      attendance_status, attendance_delta_minutes, attendance_grace_minutes,
      attendance_early_window_minutes, attendance_max_shift_minutes,
      clock_in_latitude, clock_in_longitude, clock_in_accuracy_meters,
      clock_in_location_captured_at, ended_at, duration_seconds,
      admin_adjusted_duration_seconds, tiktok, tiktok_allowance, tasks_completed,
      expense_amount, cash_revenue, transfer_revenue,
      reconciliation_status, reconciliation_reason, reconciled_at, reconciled_by, status
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`).run(
    row.id, row.shiftCode, row.storeId, row.employeeId, row.shiftName,
    row.scheduledStart, row.scheduledEnd, row.scheduledStartAt, row.scheduledEndAt,
    row.workDate, row.sourceScheduleRecordId, row.sourceScheduleUpdatedAt,
    row.appliedHourlyRate, row.appliedTikTokAllowance, row.startedAt,
    row.attendanceStatus, row.attendanceDeltaMinutes, row.attendanceGraceMinutes,
    row.attendanceEarlyWindowMinutes, row.attendanceMaxShiftMinutes,
    row.clockInLatitude, row.clockInLongitude, row.clockInAccuracyMeters,
    row.clockInLocationCapturedAt, row.endedAt, row.durationSeconds,
    row.adminAdjustedDurationSeconds, row.tiktok, row.tiktokAllowance,
    row.tasksCompleted, row.expenseAmount, row.cashRevenue, row.transferRevenue,
    row.reconciliationStatus, row.reconciliationReason, row.reconciledAt,
    row.reconciledBy, row.status,
  );
}

function insertDailyShift(db, overrides = {}) {
  const row = {
    id: "daily-1",
    storeId: "store-1",
    workDate: "2026-08-24",
    name: "Ca 1",
    nameKey: "ca 1",
    startTime: "08:00",
    endTime: "12:00",
    status: "ACTIVE",
    version: 1,
    createdBy: "actor-1",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
  return db.prepare(`INSERT INTO daily_shift_definitions
      (id, store_id, work_date, name, name_key, start_time, end_time, status,
       version, created_by, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id, row.storeId, row.workDate, row.name, row.nameKey,
      row.startTime, row.endTime, row.status, row.version, row.createdBy,
      row.createdAt, row.updatedAt, row.deletedAt,
    );
}

test("0029 is additive, journaled once, and aligned with runtime/schema", async () => {
  const [migration, journalSource, runtime, schema] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(journalUrl, "utf8"),
    readFile(runtimeUrl, "utf8"),
    readFile(schemaUrl, "utf8"),
  ]);
  const journal = JSON.parse(journalSource);
  const entries = journal.entries.filter((entry) => entry.tag === "0029_shift_attendance_integrity");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].idx, 29);
  assert.equal(entries[0].version, "6");
  assert.equal(entries[0].breakpoints, true);
  assert.ok(
    journal.entries.some((entry) => entry.idx > 29),
    "later additive migrations must not invalidate the 0029 contract",
  );
  assert.doesNotMatch(migration, /^\s*(?:DROP\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b|TRUNCATE\b|RENAME\b)/imu);
  assert.doesNotMatch(migration, /CREATE\s+UNIQUE\s+INDEX[^;]*employee_id[^;]*status/iu);

  for (const column of integrityColumns) {
    assert.match(migration, new RegExp("ADD COLUMN `" + column + "`", "u"));
    assert.match(runtime, new RegExp("\\b" + column + "\\b", "u"));
    assert.match(schema, new RegExp("[\"']" + column + "[\"']", "u"));
  }
  for (const trigger of [
    "trg_shift_sessions_one_active_insert",
    "trg_shift_sessions_validate_insert_v2",
    "trg_shift_sessions_locked_update",
    "trg_daily_shift_definitions_locked_update",
  ]) {
    assert.match(migration, new RegExp(trigger, "u"));
    assert.match(runtime, new RegExp(trigger, "u"));
  }
  assert.match(runtime, /Install the daily-shift LOCKED guards before any compatibility backfill/u);
  assert.match(runtime, /FROM snapshots\s+WHERE NOT EXISTS \(\s+SELECT 1 FROM financial_periods locked_period/su);
});

test("migration preserves legacy anomalies and prevents new ACTIVE duplicates", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const db = createLegacyDatabase();
  try {
    const before = db.prepare("SELECT * FROM shift_sessions ORDER BY id").all();
    applyMigration(db, migration);

    const columns = db.prepare("PRAGMA table_info(shift_sessions)").all().map((row) => row.name);
    assert.deepEqual(columns.slice(-8), integrityColumns);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'legacy-employee' AND status = 'ACTIVE'").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shift_sessions").get().count, before.length);
    assert.equal(db.prepare("SELECT started_at FROM shift_sessions WHERE id = 'legacy-completed'").get().started_at, "legacy timestamp");

    expectDbError(() => insertSession(db, {
      id: "legacy-third",
      shiftCode: "LEGACY-3",
      storeId: "legacy-store",
      employeeId: "legacy-employee",
    }), /ACTIVE shift session/u);

    db.prepare(`UPDATE shift_sessions SET status = 'COMPLETED', ended_at = ?, duration_seconds = ?
      WHERE id = ?`).run("2026-08-20T03:00:00.000Z", 7_200, "legacy-active-1");
    expectDbError(() => insertSession(db, {
      id: "legacy-still-duplicate",
      shiftCode: "LEGACY-4",
      storeId: "legacy-store",
      employeeId: "legacy-employee",
    }), /ACTIVE shift session/u);
    db.prepare(`UPDATE shift_sessions SET status = 'COMPLETED', ended_at = ?, duration_seconds = ?
      WHERE id = ?`).run("2026-08-20T04:00:00.000Z", 7_200, "legacy-active-2");
    assert.equal(insertSession(db, {
      id: "legacy-recovered",
      shiftCode: "LEGACY-5",
      storeId: "legacy-store",
      employeeId: "legacy-employee",
    }).changes, 1);
  } finally {
    db.close();
  }
});

test("new session writes enforce snapshots, money, booleans, location, completion, and reconciliation", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const db = createLegacyDatabase();
  try {
    applyMigration(db, migration);

    const invalidRows = [
      { id: "bad-schedule-pair", shiftCode: "BAD-1", employeeId: "bad-1", scheduledEndAt: null },
      { id: "bad-provenance-pair", shiftCode: "BAD-2", employeeId: "bad-2", sourceScheduleUpdatedAt: null },
      { id: "bad-rate", shiftCode: "BAD-3", employeeId: "bad-3", appliedHourlyRate: -1 },
      { id: "bad-boolean", shiftCode: "BAD-4", employeeId: "bad-4", tiktok: 2 },
      { id: "bad-location", shiftCode: "BAD-5", employeeId: "bad-5", clockInLongitude: null },
      { id: "bad-early", shiftCode: "BAD-6", employeeId: "bad-6", attendanceEarlyWindowMinutes: -1 },
      { id: "bad-active-end", shiftCode: "BAD-7", employeeId: "bad-7", endedAt: "2026-08-24T02:00:00.000Z" },
      { id: "bad-reconciliation", shiftCode: "BAD-8", employeeId: "bad-8", reconciliationStatus: "REQUIRED" },
    ];
    for (const invalid of invalidRows) expectDbError(() => insertSession(db, invalid));

    assert.equal(insertSession(db).changes, 1);
    expectDbError(() => db.prepare(`UPDATE shift_sessions SET status = 'COMPLETED', ended_at = ?, duration_seconds = ?
      WHERE id = 'session-1'`).run("2026-08-24T09:00:00.000Z", 1), /integrity/u);
    assert.equal(db.prepare(`UPDATE shift_sessions SET status = 'COMPLETED', ended_at = ?, duration_seconds = ?
      WHERE id = 'session-1'`).run("2026-08-24T09:00:00.000Z", 28_800).changes, 1);

    insertSession(db, {
      id: "session-overtime",
      shiftCode: "SHIFT-OVERTIME",
      employeeId: "employee-overtime",
      attendanceMaxShiftMinutes: 60,
    });
    expectDbError(() => db.prepare(`UPDATE shift_sessions SET status = 'COMPLETED', ended_at = ?, duration_seconds = ?
      WHERE id = 'session-overtime'`).run("2026-08-24T03:00:00.000Z", 7_200), /integrity/u);
    assert.equal(db.prepare(`UPDATE shift_sessions
      SET status = 'COMPLETED', ended_at = ?, duration_seconds = ?,
          reconciliation_status = 'REQUIRED', reconciliation_reason = ?
      WHERE id = 'session-overtime'`)
      .run("2026-08-24T03:00:00.000Z", 7_200, "Ca vượt ngưỡng cần đối soát").changes, 1);
    assert.equal(db.prepare(`UPDATE shift_sessions
      SET reconciliation_status = 'CONFIRMED', reconciled_at = ?, reconciled_by = ?
      WHERE id = 'session-overtime'`)
      .run("2026-08-24T04:00:00.000Z", "manager-1").changes, 1);
  } finally {
    db.close();
  }
});

test("LOCKED is the canonical mutation guard while non-LOCKED periods remain editable", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const db = createLegacyDatabase();
  try {
    applyMigration(db, migration);

    insertSession(db, {
      id: "locked-source",
      shiftCode: "LOCKED-SOURCE",
      storeId: "locked-store",
      employeeId: "locked-employee",
      workDate: "2026-09-01",
      startedAt: "2026-08-31T17:00:00.000Z",
      scheduledStartAt: "2026-08-31T17:00:00.000Z",
      scheduledEndAt: "2026-08-31T21:00:00.000Z",
    });
    insertDailyShift(db, { id: "locked-daily", storeId: "locked-store", workDate: "2026-09-01" });
    db.prepare("INSERT INTO financial_periods (id, store_id, period, status) VALUES (?, ?, ?, ?)")
      .run("locked-period", "locked-store", "2026-09", "LOCKED");

    expectDbError(() => insertSession(db, {
      id: "locked-insert",
      shiftCode: "LOCKED-INSERT",
      storeId: "locked-store",
      employeeId: "other-locked-employee",
      workDate: "2026-09-02",
      startedAt: "2026-09-01T17:00:00.000Z",
      scheduledStartAt: "2026-09-01T17:00:00.000Z",
      scheduledEndAt: "2026-09-01T21:00:00.000Z",
    }), /LOCKED financial period/u);
    expectDbError(() => db.prepare("UPDATE shift_sessions SET shift_name = 'Changed' WHERE id = 'locked-source'").run(), /LOCKED financial period/u);
    expectDbError(() => db.prepare("DELETE FROM shift_sessions WHERE id = 'locked-source'").run(), /LOCKED financial period/u);
    expectDbError(() => insertDailyShift(db, { id: "locked-daily-insert", storeId: "locked-store", workDate: "2026-09-02" }), /LOCKED financial period/u);
    expectDbError(() => db.prepare("UPDATE daily_shift_definitions SET name = 'Changed' WHERE id = 'locked-daily'").run(), /LOCKED financial period/u);
    expectDbError(() => db.prepare("DELETE FROM daily_shift_definitions WHERE id = 'locked-daily'").run(), /LOCKED financial period/u);

    for (const [period, status] of [["2026-10", "DRAFT"], ["2026-11", "CALCULATED"]]) {
      db.prepare("INSERT INTO financial_periods (id, store_id, period, status) VALUES (?, ?, ?, ?)")
        .run(`period-${status}`, "open-store", period, status);
      const suffix = period.slice(-2);
      assert.equal(insertSession(db, {
        id: `open-${suffix}`,
        shiftCode: `OPEN-${suffix}`,
        storeId: "open-store",
        employeeId: `open-employee-${suffix}`,
        workDate: `${period}-02`,
        startedAt: `${period}-01T17:00:00.000Z`,
        scheduledStartAt: `${period}-01T17:00:00.000Z`,
        scheduledEndAt: `${period}-01T21:00:00.000Z`,
      }).changes, 1);
      assert.equal(db.prepare("UPDATE shift_sessions SET shift_name = ? WHERE id = ?")
        .run(`Changed ${status}`, `open-${suffix}`).changes, 1);
      assert.equal(db.prepare("DELETE FROM shift_sessions WHERE id = ?").run(`open-${suffix}`).changes, 1);

      assert.equal(insertDailyShift(db, {
        id: `open-daily-${suffix}`,
        storeId: "open-store",
        workDate: `${period}-02`,
      }).changes, 1);
      assert.equal(db.prepare("UPDATE daily_shift_definitions SET name = ? WHERE id = ?")
        .run(`Changed ${status}`, `open-daily-${suffix}`).changes, 1);
      assert.equal(db.prepare("DELETE FROM daily_shift_definitions WHERE id = ?")
        .run(`open-daily-${suffix}`).changes, 1);
    }
  } finally {
    db.close();
  }
});

test("daily shift definitions reject invalid new state without rewriting legacy rows", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const db = createLegacyDatabase();
  try {
    db.prepare(`INSERT INTO daily_shift_definitions
        (id, store_id, work_date, name, name_key, start_time, end_time,
         status, version, created_by, created_at, updated_at, deleted_at)
      VALUES ('legacy-daily', 'legacy-store', 'legacy-date', 'Legacy', 'legacy',
        'bad', 'bad', 'ACTIVE', 1, 'legacy', 'legacy', 'legacy', NULL)`).run();
    applyMigration(db, migration);
    assert.equal(db.prepare("SELECT work_date FROM daily_shift_definitions WHERE id = 'legacy-daily'").get().work_date, "legacy-date");

    for (const invalid of [
      { id: "daily-bad-date", workDate: "2026-02-30" },
      { id: "daily-bad-time", startTime: "25:00" },
      { id: "daily-zero", startTime: "08:00", endTime: "08:00" },
      { id: "daily-deleted-no-meta", status: "DELETED" },
      { id: "daily-active-with-meta", deletedAt: "2026-08-23T00:00:00.000Z" },
    ]) expectDbError(() => insertDailyShift(db, invalid));
    assert.equal(insertDailyShift(db).changes, 1);
  } finally {
    db.close();
  }
});
