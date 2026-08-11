import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { createSqliteDatabase } = await import("../db/sqlite.ts");
const {
  createDailyShift,
  dailyShiftValues,
  DailyShiftConflictError,
  deleteDailyShift,
  getDailyShift,
  listDailyShifts,
  updateDailyShift,
} = await import("../app/lib/daily-shifts.ts");

const dailyShiftSchema = `CREATE TABLE daily_shift_definitions (
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
CREATE UNIQUE INDEX idx_daily_shift_store_request
  ON daily_shift_definitions(store_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX idx_daily_shift_store_date_identity
  ON daily_shift_definitions(store_id, work_date, name_key, start_time, end_time) WHERE status = 'ACTIVE';`;

async function database() {
  const db = await createSqliteDatabase();
  await db.prepare("CREATE TABLE stores (id TEXT PRIMARY KEY, status TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, store_id TEXT, is_super_admin INTEGER NOT NULL DEFAULT 0)").run();
  for (const statement of dailyShiftSchema.split(";").map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO stores (id, status) VALUES ('store-1', 'ACTIVE')").run();
  await db.prepare("INSERT INTO users (id, role, store_id, is_super_admin) VALUES ('manager-1', 'MANAGER', 'store-1', 0)").run();
  return db;
}

function values(workDate = "2026-08-11", name = "Ca sáng", start = "07:00", end = "12:00") {
  const result = dailyShiftValues({ workDate, name, start, end });
  assert.ok(result);
  return result;
}

test("daily shifts are idempotent per request and independent per date", async () => {
  const db = await database();
  try {
    const first = {
      storeId: "store-1",
      actorId: "manager-1",
      clientRequestId: "67fd8661-1be3-4535-891e-a75141743cac",
      values: values(),
      now: "2026-08-11T00:00:00.000Z",
    };
    const created = await createDailyShift(db, first);
    assert.equal(created.status, "CREATED");
    assert.equal((await createDailyShift(db, first)).status, "IDEMPOTENT");

    await assert.rejects(createDailyShift(db, {
      ...first,
      clientRequestId: "0b45c3b4-e6d5-4f54-8776-e596aa631dcf",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "DUPLICATE");

    await createDailyShift(db, {
      ...first,
      clientRequestId: "51f8b956-50c6-453d-b938-07052167f9a8",
      values: values("2026-08-12"),
    });
    assert.equal((await listDailyShifts(db, "store-1", "2026-08-11")).shifts.length, 1);
    assert.equal((await listDailyShifts(db, "store-1", "2026-08-12")).shifts.length, 1);
  } finally {
    db.close();
  }
});

test("daily shift CAS serializes updates and store inactivation wins inside every mutation", async () => {
  const db = await database();
  try {
    const created = await createDailyShift(db, {
      storeId: "store-1",
      actorId: "manager-1",
      clientRequestId: "7e1114f7-75d8-46c7-a1f4-c037db58d00a",
      values: values(),
      now: "2026-08-11T00:00:00.000Z",
    });

    await db.prepare("UPDATE stores SET status = 'INACTIVE' WHERE id = 'store-1'").run();
    await assert.rejects(updateDailyShift(db, {
      id: created.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: 1,
      values: values("2026-08-11", "Ca sáng", "08:00", "12:00"),
      now: "2026-08-11T00:01:00.000Z",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "INACTIVE");
    await assert.rejects(deleteDailyShift(db, {
      id: created.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: 1,
      now: "2026-08-11T00:01:00.000Z",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "INACTIVE");
    await assert.rejects(createDailyShift(db, {
      storeId: "store-1",
      actorId: "manager-1",
      clientRequestId: "db2af6bb-f928-4c50-9a98-f38c0a52c140",
      values: values("2026-08-11", "Ca chiều", "12:00", "17:00"),
      now: "2026-08-11T00:01:00.000Z",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "INACTIVE");
    assert.equal((await getDailyShift(db, created.id)).version, 1);
    assert.equal((await listDailyShifts(db, "store-1", "2026-08-11")).shifts.length, 1);

    await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id = 'store-1'").run();
    const competing = await Promise.allSettled([
      updateDailyShift(db, {
        id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 1,
        values: values("2026-08-11", "Ca sáng A", "08:00", "12:00"), now: "2026-08-11T00:02:00.000Z",
      }),
      updateDailyShift(db, {
        id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 1,
        values: values("2026-08-11", "Ca sáng B", "09:00", "12:00"), now: "2026-08-11T00:02:00.001Z",
      }),
    ]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competing.filter((result) => result.status === "rejected"
      && result.reason instanceof DailyShiftConflictError && result.reason.reason === "STALE").length, 1);
    assert.equal((await getDailyShift(db, created.id)).version, 2);

    await db.prepare("UPDATE users SET store_id = 'store-2' WHERE id = 'manager-1'").run();
    await assert.rejects(updateDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 2,
      values: values("2026-08-11", "Unauthorized shift", "10:00", "12:00"), now: "2026-08-11T00:03:00.000Z",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "FORBIDDEN");
    await assert.rejects(deleteDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 2, now: "2026-08-11T00:03:00.000Z",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "FORBIDDEN");
    assert.equal((await getDailyShift(db, created.id)).version, 2);
  } finally {
    db.close();
  }
});

test("daily shift deletion preserves schedule and attendance snapshots", async () => {
  const db = await database();
  try {
    await db.prepare("CREATE TABLE business_records (id TEXT PRIMARY KEY, data_json TEXT NOT NULL)").run();
    await db.prepare("CREATE TABLE shift_sessions (id TEXT PRIMARY KEY, shift_name TEXT, scheduled_start TEXT, scheduled_end TEXT, status TEXT)").run();
    const snapshot = JSON.stringify({ date: "2026-08-11", shiftName: "Ca sáng", start: "07:00", end: "12:00", employeeIds: ["employee-1"] });
    await db.prepare("INSERT INTO business_records (id, data_json) VALUES ('schedule-1', ?)").bind(snapshot).run();
    await db.prepare("INSERT INTO shift_sessions VALUES ('session-1', 'Ca sáng', '07:00', '12:00', 'ACTIVE')").run();
    const created = await createDailyShift(db, {
      storeId: "store-1", actorId: "manager-1",
      clientRequestId: "ae621745-0c45-4df1-80fd-96ca48ecfa2c",
      values: values(), now: "2026-08-11T00:00:00.000Z",
    });
    await deleteDailyShift(db, { id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 1, now: "2026-08-11T01:00:00.000Z" });
    assert.equal((await getDailyShift(db, created.id)).status, "DELETED");
    assert.equal((await listDailyShifts(db, "store-1", "2026-08-11")).initialized, true);
    assert.equal((await listDailyShifts(db, "store-1", "2026-08-11")).shifts.length, 0);
    assert.equal((await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE id = 'schedule-1'").first()).dataJson, snapshot);
    assert.deepEqual({ ...(await db.prepare("SELECT shift_name, scheduled_start, scheduled_end, status FROM shift_sessions").first()) }, {
      shift_name: "Ca sáng", scheduled_start: "07:00", scheduled_end: "12:00", status: "ACTIVE",
    });
  } finally {
    db.close();
  }
});

test("additive migration backfills schedule snapshots without rewriting operational history", async () => {
  const db = await createSqliteDatabase();
  try {
    await db.prepare(`CREATE TABLE business_records (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, store_id TEXT, owner_id TEXT,
      title TEXT NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`).run();
    await db.prepare("CREATE TABLE shift_sessions (id TEXT PRIMARY KEY, shift_name TEXT)").run();
    const snapshot = JSON.stringify({ date: "2026-08-10", shiftId: "legacy-1", shiftName: "Ca cũ", start: "08:00", end: "13:00" });
    await db.prepare("INSERT INTO business_records VALUES ('schedule-old', 'LICH_PHAN_CA', 'store-1', 'manager-1', 'Ca cũ', ?, 'ACTIVE', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')").bind(snapshot).run();
    await db.prepare("INSERT INTO shift_sessions VALUES ('session-old', 'Ca cũ')").run();
    const migration = await readFile(new URL("../drizzle/0020_daily_shift_definitions.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM daily_shift_definitions").first()).count, 1);
    assert.equal((await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE id = 'schedule-old'").first()).dataJson, snapshot);
    assert.equal((await db.prepare("SELECT shift_name AS shiftName FROM shift_sessions WHERE id = 'session-old'").first()).shiftName, "Ca cũ");
  } finally {
    db.close();
  }
});
