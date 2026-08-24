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
  await db.prepare(`CREATE TABLE business_records (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, store_id TEXT, owner_id TEXT,
    title TEXT NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
  await db.prepare("CREATE TABLE employee_payroll_closings (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE financial_periods (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL)").run();
  await db.prepare(`CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, store_id TEXT, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT,
    before_json TEXT, after_json TEXT, reason TEXT, created_at TEXT NOT NULL
  )`).run();
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
      reason: "Điều chỉnh giờ ca",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "INACTIVE");
    await assert.rejects(deleteDailyShift(db, {
      id: created.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: 1,
      now: "2026-08-11T00:01:00.000Z",
      reason: "Xóa ca không dùng",
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
        reason: "Điều chỉnh giờ ca A",
      }),
      updateDailyShift(db, {
        id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 1,
        values: values("2026-08-11", "Ca sáng B", "09:00", "12:00"), now: "2026-08-11T00:02:00.000Z",
        reason: "Điều chỉnh giờ ca B",
      }),
    ]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competing.filter((result) => result.status === "rejected"
      && result.reason instanceof DailyShiftConflictError && result.reason.reason === "STALE").length, 1);
    assert.equal((await getDailyShift(db, created.id)).version, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'UPDATE_DAILY_SHIFT'").first()).count, 1);

    await db.prepare("UPDATE users SET store_id = 'store-2' WHERE id = 'manager-1'").run();
    await assert.rejects(updateDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 2,
      values: values("2026-08-11", "Unauthorized shift", "10:00", "12:00"), now: "2026-08-11T00:03:00.000Z",
      reason: "Thử sửa trái quyền",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "FORBIDDEN");
    await assert.rejects(deleteDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 2, now: "2026-08-11T00:03:00.000Z",
      reason: "Thử xóa trái quyền",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "FORBIDDEN");
    assert.equal((await getDailyShift(db, created.id)).version, 2);
  } finally {
    db.close();
  }
});

test("daily shift deletion preserves schedule and attendance snapshots", async () => {
  const db = await database();
  try {
    await db.prepare("CREATE TABLE shift_sessions (id TEXT PRIMARY KEY, shift_name TEXT, scheduled_start TEXT, scheduled_end TEXT, status TEXT)").run();
    const snapshot = JSON.stringify({ date: "2026-08-11", shiftName: "Ca sáng", start: "07:00", end: "12:00", employeeIds: ["employee-1"] });
    await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('schedule-1', 'LICH_PHAN_CA', 'store-1', 'manager-1', 'Ca sáng', ?, 'ACTIVE', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`).bind(snapshot).run();
    await db.prepare("INSERT INTO shift_sessions VALUES ('session-1', 'Ca sáng', '07:00', '12:00', 'ACTIVE')").run();
    const created = await createDailyShift(db, {
      storeId: "store-1", actorId: "manager-1",
      clientRequestId: "ae621745-0c45-4df1-80fd-96ca48ecfa2c",
      values: values(), now: "2026-08-11T00:00:00.000Z",
    });
    await deleteDailyShift(db, { id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 1, now: "2026-08-11T01:00:00.000Z", reason: "Xóa ca không còn dùng" });
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

test("daily shift mutations write one structured audit with before, after, actor, reason and timestamp", async () => {
  const db = await database();
  try {
    const created = await createDailyShift(db, {
      storeId: "store-1", actorId: "manager-1",
      clientRequestId: "7b13e20f-96d2-4b44-bde7-7a6fd6ddc192",
      values: values(), now: "2026-08-11T00:00:00.000Z", reason: "Tạo ca sáng theo lịch mới",
    });
    await updateDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 1,
      values: values("2026-08-11", "Ca sáng mới", "08:00", "12:00"),
      now: "2026-08-11T00:05:00.000Z", reason: "Điều chỉnh giờ mở cửa",
    });
    await deleteDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 2,
      now: "2026-08-11T00:10:00.000Z", reason: "Hủy ca do cửa hàng nghỉ",
    });
    const audits = await db.prepare(`SELECT user_id AS userId, store_id AS storeId, action,
      before_json AS beforeJson, after_json AS afterJson, reason, created_at AS createdAt
      FROM audit_logs ORDER BY created_at`).all();
    assert.equal(audits.results.length, 3);
    assert.deepEqual(audits.results.map((row) => row.action), [
      "CREATE_DAILY_SHIFT", "UPDATE_DAILY_SHIFT", "DELETE_DAILY_SHIFT",
    ]);
    for (const row of audits.results) {
      assert.equal(row.userId, "manager-1");
      assert.equal(row.storeId, "store-1");
      assert.ok(row.reason.length >= 5);
      assert.match(row.createdAt, /^2026-08-11T/u);
      assert.ok(JSON.parse(row.afterJson));
    }
    assert.equal(audits.results[0].beforeJson, null);
    assert.equal(JSON.parse(audits.results[1].beforeJson).version, 1);
    assert.equal(JSON.parse(audits.results[1].afterJson).version, 2);
    assert.equal(JSON.parse(audits.results[2].afterJson).status, "DELETED");
  } finally {
    db.close();
  }
});

test("daily shift mutations honor canonical lifecycle before the legacy fully-locked fallback", async () => {
  const db = await database();
  try {
    const created = await createDailyShift(db, {
      storeId: "store-1", actorId: "manager-1",
      clientRequestId: "a3acb958-31da-4f34-bf52-ec35f857482a",
      values: values(), now: "2026-08-11T00:00:00.000Z", reason: "Tạo ca trước khóa kỳ",
    });
    await db.prepare(`INSERT INTO business_records VALUES
      ('legacy-lock', 'PAYROLL_CLOSING', 'store-1', 'manager-1', 'Khóa cũ', '{"period":"2026-08"}', 'LOCKED', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`).run();
    await db.prepare("INSERT INTO financial_periods VALUES ('period-1', 'store-1', '2026-08', 'DRAFT')").run();

    let version = 1;
    for (const [status, name] of [["DRAFT", "Ca bản nháp"], ["CALCULATED", "Ca đã tính"], ["RECONCILING", "Ca đối soát"]]) {
      await db.prepare("UPDATE financial_periods SET status = ? WHERE id = 'period-1'").bind(status).run();
      const updated = await updateDailyShift(db, {
        id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: version,
        values: values("2026-08-11", name, "08:00", "12:00"),
        now: `2026-08-11T00:0${version}:00.000Z`, reason: `Sửa ca khi kỳ ở trạng thái ${status}`,
      });
      version = updated.version;
    }
    assert.equal(version, 4);

    for (const status of ["CONFIRMED", "PAID", "LOCKED"]) {
      await db.prepare("UPDATE financial_periods SET status = ? WHERE id = 'period-1'").bind(status).run();
      await assert.rejects(updateDailyShift(db, {
        id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: version,
        values: values("2026-08-11", `Ca bị chặn ${status}`, "09:00", "12:00"),
        now: "2026-08-11T00:05:00.000Z", reason: `Không được sửa ở trạng thái ${status}`,
      }), (error) => error instanceof DailyShiftConflictError && error.reason === "LOCKED");
      assert.equal((await getDailyShift(db, created.id)).version, version);
    }

    await db.prepare("UPDATE financial_periods SET status = 'DRAFT' WHERE id = 'period-1'").run();
    await deleteDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: version,
      now: "2026-08-11T00:06:00.000Z", reason: "Xóa ca khi kỳ chuẩn còn chỉnh sửa",
    });
    assert.equal((await getDailyShift(db, created.id)).status, "DELETED");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs").first()).count, 5);

    await db.prepare("DELETE FROM financial_periods WHERE id = 'period-1'").run();
    await assert.rejects(createDailyShift(db, {
      storeId: "store-1", actorId: "manager-1",
      clientRequestId: "576dbaad-bf3b-48b8-a401-416774c2ae2b",
      values: values("2026-08-12", "Ca chiều", "12:00", "17:00"),
      now: "2026-08-11T00:07:00.000Z", reason: "Tạo ca trong kỳ khóa cũ",
    }), (error) => error instanceof DailyShiftConflictError && error.reason === "LOCKED");
  } finally {
    db.close();
  }
});

test("audit insertion failure rolls daily shift mutations back", async () => {
  const db = await database();
  try {
    await db.prepare(`CREATE TRIGGER reject_daily_audit BEFORE INSERT ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'audit failure'); END`).run();
    await assert.rejects(createDailyShift(db, {
      storeId: "store-1", actorId: "manager-1",
      clientRequestId: "ea447851-504d-4b18-9f5e-9ad1b9685998",
      values: values(), now: "2026-08-11T00:00:00.000Z", reason: "Tạo ca để kiểm tra audit",
    }), /audit failure/u);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM daily_shift_definitions").first()).count, 0);

    await db.prepare("DROP TRIGGER reject_daily_audit").run();
    const created = await createDailyShift(db, {
      storeId: "store-1", actorId: "manager-1",
      clientRequestId: "72bbbfec-fe95-44dd-acbb-71218823b674",
      values: values(), now: "2026-08-11T00:01:00.000Z", reason: "Tạo ca hợp lệ",
    });
    await db.prepare(`CREATE TRIGGER reject_update_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'UPDATE_DAILY_SHIFT'
      BEGIN SELECT RAISE(ABORT, 'audit update failure'); END`).run();
    await assert.rejects(updateDailyShift(db, {
      id: created.id, storeId: "store-1", actorId: "manager-1", expectedVersion: 1,
      values: values("2026-08-11", "Ca sửa", "08:00", "12:00"),
      now: "2026-08-11T00:02:00.000Z", reason: "Sửa ca để kiểm tra audit",
    }), /audit update failure/u);
    assert.equal((await getDailyShift(db, created.id)).version, 1);
    assert.equal((await getDailyShift(db, created.id)).name, "Ca sáng");
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
