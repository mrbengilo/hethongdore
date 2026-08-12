import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = await mkdtemp(join(tmpdir(), "dore-employee-lifecycle-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, auth, employeesRoute, adminEmployeesRoute, loginRoute, shiftRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/employees/route.ts"),
  import("../app/api/admin/employees/route.ts"),
  import("../app/api/auth/login/route.ts"),
  import("../app/api/shift/route.ts"),
]);

const managerToken = "employee-lifecycle-manager";
const superToken = "employee-lifecycle-super";
const employeeToken = "employee-lifecycle-employee";
const password = "Employee-Secret-2026";
let db;

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(token ? { cookie: `dore_session=${encodeURIComponent(token)}` } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assertNoExactAttendanceLocation(value, path = "retained payload") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoExactAttendanceLocation(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
    if ([
      "clockinlatitude",
      "clockinlongitude",
      "clockinaccuracymeters",
      "clockinlocationcapturedat",
      "shiftclockinlatitude",
      "shiftclockinlongitude",
      "shiftclockinaccuracymeters",
      "shiftclockinlocationcapturedat",
    ].includes(normalizedKey)) {
      assert.equal(entry, null, `${path}.${key} retained an exact attendance location`);
      continue;
    }
    assertNoExactAttendanceLocation(entry, `${path}.${key}`);
  }
}

async function statusChange(status, expectedVersion, token = managerToken) {
  const response = await employeesRoute.PATCH(request("/api/employees", token, "PATCH", {
    action: "SET_STATUS",
    storeId: "st-can-tho",
    id: "employee-life",
    status,
    expectedVersion,
    reason: `Kiểm thử chuyển trạng thái ${status}`,
  }));
  return { response, body: await response.json() };
}

async function adminList(token = superToken) {
  const response = await adminEmployeesRoute.GET(request(
    "/api/admin/employees?storeId=st-can-tho&page=1&pageSize=20",
    token,
  ));
  return { response, body: await response.json() };
}

async function unlockFixturePeriod() {
  await db.prepare("UPDATE employee_payroll_closings SET period = '2026-07' WHERE id = 'payroll-life'").run();
}

function profilePatch(overrides = {}) {
  return {
    id: "employee-life",
    storeId: "st-can-tho",
    code: "NVLIFE",
    name: "Hồ sơ vừa cập nhật",
    position: "Bán hàng",
    phone: "0987654321",
    province: "Cần Thơ",
    ward: "Ninh Kiều",
    addressLine: "Đường hồ sơ mới",
    age: 26,
    cccdNumber: "092000000222",
    cccdImageKey: "cccd/22222222-2222-4222-8222-222222222222.jpg",
    cccdImageName: "cccd-new.jpg",
    hourlyRate: 23000,
    tiktokAllowance: 27000,
    username: "employee-life-new",
    expectedVersion: 0,
    ...overrides,
  };
}

before(async () => { db = await initDb(); });

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of [
    "sessions", "notifications", "cccd_deletion_outbox", "cccd_upload_registry", "employee_status_history", "employee_transfers",
    "orders", "employee_payroll_closings", "shift_sessions", "business_records",
    "admin_reset_archives", "audit_logs", "employees",
  ]) await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare("DELETE FROM users WHERE id != 'user-manager'").run();
  await db.prepare("UPDATE users SET is_super_admin = 1, failed_attempts = 0, locked_until = NULL WHERE id = 'user-manager'").run();
  await db.prepare("UPDATE stores SET status = 'ACTIVE', revenue = 120000, expense = 10000 WHERE id = 'st-can-tho'").run();

  const employeeHash = await auth.hashPassword(password);
  const pendingUploadedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, shift_active, is_super_admin)
      VALUES ('manager-life', 'manager-life', 'unused', 'MANAGER', 'Quản lý thường', 0, 0)`),
    db.prepare(`INSERT INTO cccd_upload_registry
      (key, actor_user_id, actor_store_id, actor_global_access, original_name,
       content_type, created_at, claim_status, deletion_status, updated_at)
      VALUES ('cccd/22222222-2222-4222-8222-222222222222.jpg', 'manager-life', NULL, 1,
        'cccd-new.jpg', 'image/jpeg', ?, 'PENDING', 'NONE', ?)`)
      .bind(pendingUploadedAt, pendingUploadedAt),
    db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, province, ward, address_line, age,
        cccd_image_key, cccd_image_name, hourly_rate, tiktok_allowance, status,
        status_updated_at, lifecycle_version)
      VALUES ('employee-life', 'st-can-tho', 'NVLIFE', 'Nguyễn Nhân Viên', 'Bán hàng',
        '0901234567', 'Cần Thơ', 'Ninh Kiều', 'Đường kiểm thử', 25,
        'cccd/11111111-1111-4111-8111-111111111111.jpg', 'cccd.jpg', 23000, 27000,
        'ACTIVE', '2026-08-10T00:00:00.000Z', 0)`),
    db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id,
        failed_attempts, shift_active, current_shift, shift_started_at)
      VALUES ('user-life', 'employee-life', ?, 'EMPLOYEE', 'Nguyễn Nhân Viên',
        'employee-life', 'st-can-tho', 0, 1, 'SHIFT-LIFE', '2026-08-10T01:00:00.000Z')`).bind(employeeHash),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, shift_name, work_date, applied_hourly_rate,
        applied_tiktok_allowance, started_at, ended_at, duration_seconds, expense_amount,
        cash_revenue, transfer_revenue, close_status, status)
      VALUES ('shift-life', 'SHIFT-LIFE', 'st-can-tho', 'employee-life', 'Ca 1', '2026-08-10',
        NULL, NULL, '2026-08-10T01:00:00.000Z', NULL, 0, 10000, 120000, 0, 'PENDING', 'ACTIVE')`),
    db.prepare(`INSERT INTO orders
      (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
      VALUES ('order-life', 'DH99001', 'st-can-tho', 'employee-life', 'SHIFT-LIFE',
        120000, 'CASH', 'COMPLETED', '2026-08-10T02:00:00.000Z')`),
    db.prepare(`INSERT INTO employee_payroll_closings
      (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock,
        status, locked_at, locked_by)
      VALUES ('payroll-life', 'st-can-tho', 'employee-life', '2026-08',
        '{"employeeId":"employee-life","employeeName":"Nguyễn Nhân Viên","employeeCode":"NVLIFE","employeePhone":"0901234567","pay":230000}',
        'ACTIVE', 'LOCKED', '2026-08-10T03:00:00.000Z', 'user-manager')`),
    db.prepare(`INSERT INTO employee_transfers
      (id, employee_id, source_store_id, target_store_id, start_date, end_date,
        shifts_json, support_hourly_rate, support_allowance, reason, status,
        created_by, created_at, updated_at)
      VALUES ('transfer-life', 'employee-life', 'st-can-tho', 'st-thot-not',
        '2026-08-10', '2026-08-20',
        '[{"employeeId":"employee-life","employeeName":"Nguyễn Nhân Viên","employeeCode":"NVLIFE","employeePhone":"0901234567","shift":"Ca 1"}]',
        25000, 0, 'Hỗ trợ Nguyễn Nhân Viên NVLIFE 0901234567', 'ACTIVE',
        'user-manager', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`),
    db.prepare(`INSERT INTO employee_transfers
      (id, employee_id, source_store_id, target_store_id, start_date, end_date,
        shifts_json, support_hourly_rate, support_allowance, reason, status,
        created_by, created_at, updated_at, ended_at)
      SELECT 'transfer-completed-life', e.id, e.store_id, 'st-thot-not',
        '2026-07-01', '2026-07-05',
        json_array(json_object('employeeId', e.id, 'employeeName', e.name,
          'employeeCode', e.code, 'employeePhone', e.phone, 'shift', 'Ca 2')),
        24000, 0, 'Completed ' || e.name || ' ' || e.code || ' ' || e.phone,
        'COMPLETED', 'user-manager', '2026-07-01T00:00:00.000Z',
        '2026-07-05T12:00:00.000Z', '2026-07-05T12:00:00.000Z'
      FROM employees e WHERE e.id = 'employee-life'`),
    db.prepare(`INSERT INTO employee_transfers
      (id, employee_id, source_store_id, target_store_id, start_date, end_date,
        shifts_json, support_hourly_rate, support_allowance, reason, status,
        created_by, created_at, updated_at, ended_at)
      SELECT 'transfer-cancelled-life', e.id, e.store_id, 'st-thot-not',
        '2026-07-10', '2026-07-15',
        json_array(json_object('employeeId', e.id, 'employeeName', e.name,
          'employeeCode', e.code, 'employeePhone', e.phone, 'shift', 'Ca 3')),
        24000, 0, 'Cancelled ' || e.name || ' ' || e.code || ' ' || e.phone,
        'CANCELLED', 'user-manager', '2026-07-10T00:00:00.000Z',
        '2026-07-11T12:00:00.000Z', NULL
      FROM employees e WHERE e.id = 'employee-life'`),
    db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('record-life', 'LUONG_THUONG', 'st-can-tho', 'user-life',
        'Lương Nguyễn Nhân Viên',
        '{"employeeId":"employee-life","employeeName":"Nguyễn Nhân Viên","amount":123000}',
        'ACTIVE', '2026-08-10T03:00:00.000Z', '2026-08-10T03:00:00.000Z')`),
    db.prepare(`INSERT INTO admin_reset_archives
      (id, store_id, actor_user_id, kind, filter_json, summary_json, snapshot_json, created_at)
      VALUES ('archive-life-before', 'st-can-tho', 'user-manager', 'ORDER_EDIT',
        '{"employeeId":"employee-life","employeeCode":"NVLIFE"}',
        '{"count":1,"employeePhone":"0901234567"}',
        '{"employeeId":"employee-life","employeeName":"Nguyễn Nhân Viên","amount":120000}',
        '2026-08-10T03:00:00.000Z')`),
    db.prepare(`INSERT INTO notifications
      (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, created_at)
      VALUES ('notice-life', 'user-life', 'st-can-tho', 'TEST', 'EMPLOYEE', 'employee-life',
        'Thông báo', 'Kiểm thử', '{}', '2026-08-10T03:00:00.000Z')`),
    db.prepare(`INSERT INTO notifications
      (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message,
        data_json, read_at, created_at)
      SELECT 'notice-manager-order-life', 'manager-life', o.store_id, 'NEW_ORDER',
        'ORDER', o.id, 'Order ' || e.code || ' by ' || e.name,
        e.name || ' ' || e.code || ' ' || e.phone || ' created ' || o.code,
        json_object('orderId', o.id, 'orderCode', o.code, 'employeeId', e.id,
          'employeeName', e.name, 'employeeCode', e.code, 'employeePhone', e.phone),
        '2026-08-10T03:15:00.000Z', '2026-08-10T03:00:00.000Z'
      FROM orders o JOIN employees e ON e.id = o.employee_id
      WHERE o.id = 'order-life'`),
  ]);

  const expiry = Date.now() + 600_000;
  await db.batch([
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('session-manager-life', 'manager-life', ?, ?, ?)")
      .bind(await auth.sha256(managerToken), expiry, new Date().toISOString()),
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('session-super-life', 'user-manager', ?, ?, ?)")
      .bind(await auth.sha256(superToken), expiry, new Date().toISOString()),
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('session-employee-life', 'user-life', ?, ?, ?)")
      .bind(await auth.sha256(employeeToken), expiry, new Date().toISOString()),
  ]);
});

test("super-admin employee API keeps user-facing Vietnamese in valid UTF-8", async () => {
  const source = await readFile(new URL("../app/api/admin/employees/route.ts", import.meta.url), "utf8");
  const mojibake = /[\u00c3\u00c4\u00c6]|\u00e1[\u00ba\u00bb]|\u00e2\u20ac/u;
  assert.doesNotMatch(source, mojibake);
});

test("0016 adds lifecycle schema without rewriting a legacy INACTIVE row", async () => {
  const migration = await readFile(new URL("../drizzle/0016_employee_lifecycle.sql", import.meta.url), "utf8");
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`CREATE TABLE employees (
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL, code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE', inactive_at TEXT
  )`);
  const inactiveAt = "2026-07-15T08:30:00.123Z";
  legacy.prepare("INSERT INTO employees VALUES ('legacy', 'store', 'NV001', 'INACTIVE', ?)").run(inactiveAt);
  for (const statement of migration.split(/-->\s*statement-breakpoint/u).map((value) => value.trim()).filter(Boolean)) {
    legacy.exec(statement);
  }
  const row = legacy.prepare(`SELECT status, hex(status) AS statusBytes, inactive_at AS inactiveAt,
      status_updated_at AS statusUpdatedAt, lifecycle_version AS lifecycleVersion, deleted_at AS deletedAt
    FROM employees WHERE id = 'legacy'`).get();
  assert.equal(row.status, "INACTIVE");
  assert.equal(row.statusBytes, Buffer.from("INACTIVE").toString("hex").toUpperCase());
  assert.equal(row.inactiveAt, inactiveAt);
  assert.equal(row.statusUpdatedAt, null);
  assert.equal(row.lifecycleVersion, 0);
  assert.equal(row.deletedAt, null);
  assert.equal(legacy.prepare("SELECT COUNT(*) AS count FROM employee_status_history").get().count, 0);
  legacy.close();
});

test("profile edits preserve a legacy INACTIVE status and keep its account signed out", async () => {
  const inactiveAt = "2026-07-15T08:30:00.123Z";
  await db.prepare(`UPDATE employees SET status = 'INACTIVE', inactive_at = ?,
      status_updated_at = NULL, lifecycle_version = 0
    WHERE id = 'employee-life'`).bind(inactiveAt).run();
  const response = await employeesRoute.PATCH(request(
    "/api/employees",
    managerToken,
    "PATCH",
    profilePatch(),
  ));
  assert.equal(response.status, 200);
  assert.deepEqual({ ...await db.prepare(`SELECT name, status, hex(status) AS statusBytes,
      inactive_at AS inactiveAt, status_updated_at AS statusUpdatedAt,
      COALESCE(lifecycle_version, 0) AS lifecycleVersion
    FROM employees WHERE id = 'employee-life'`).first() }, {
    name: "Hồ sơ vừa cập nhật",
    status: "INACTIVE",
    statusBytes: Buffer.from("INACTIVE").toString("hex").toUpperCase(),
    inactiveAt,
    statusUpdatedAt: null,
    lifecycleVersion: 0,
  });
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
  const login = await loginRoute.POST(request("/api/auth/login", null, "POST", {
    username: "employee-life-new",
    password,
  }));
  assert.equal(login.status, 403);
  assert.match((await login.json()).message, /đã nghỉ việc/iu);
});

test("manager transitions revoke login atomically and preserve active operational history", async () => {
  await unlockFixturePeriod();
  const payrollBefore = await db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE id = 'payroll-life'").first("snapshot_json");
  const suspended = await statusChange("SUSPENDED", 0);
  assert.equal(suspended.response.status, 200);
  assert.equal(suspended.body.status, "SUSPENDED");
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'employee-life'").first("status"), "SUSPENDED");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
  const statusClosedShift = await db.prepare(`SELECT status, ended_at AS endedAt,
      cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue,
      expense_amount AS expenseAmount, close_reason AS closeReason
    FROM shift_sessions WHERE id = 'shift-life'`).first();
  assert.equal(statusClosedShift.status, "COMPLETED");
  assert.ok(statusClosedShift.endedAt);
  assert.equal(statusClosedShift.cashRevenue, 120000);
  assert.equal(statusClosedShift.transferRevenue, 0);
  assert.equal(statusClosedShift.expenseAmount, 10000);
  assert.equal(statusClosedShift.closeReason, "EMPLOYEE_STATUS_CHANGE:SUSPENDED");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'order-life'").first("count"), 1);
  assert.equal(await db.prepare("SELECT status FROM employee_transfers WHERE id = 'transfer-life'").first("status"), "CANCELLED");
  assert.equal(await db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE id = 'payroll-life'").first("snapshot_json"), payrollBefore);
  assert.deepEqual({ ...await db.prepare("SELECT shift_active AS shiftActive, current_shift AS currentShift FROM users WHERE id = 'user-life'").first() }, {
    shiftActive: 0, currentShift: null,
  });
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM employee_status_history WHERE employee_id = 'employee-life'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'EMPLOYEE_STATUS_CHANGE' AND entity_id = 'employee-life'").first("count"), 1);
  assert.equal(await auth.getSessionUser(request("/api/session", employeeToken)), null);

  let login = await loginRoute.POST(request("/api/auth/login", null, "POST", { username: "employee-life", password }));
  assert.equal(login.status, 403);
  assert.match((await login.json()).message, /tạm ngưng/iu);

  const active = await statusChange("ACTIVE", 1);
  assert.equal(active.response.status, 200);
  login = await loginRoute.POST(request("/api/auth/login", null, "POST", { username: "employee-life", password }));
  assert.equal(login.status, 200);

  const terminated = await statusChange("TERMINATED", 2);
  assert.equal(terminated.response.status, 200);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
  login = await loginRoute.POST(request("/api/auth/login", null, "POST", { username: "employee-life", password }));
  assert.equal(login.status, 403);
  assert.match((await login.json()).message, /đã nghỉ việc/iu);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE id = 'shift-life' AND status = 'ACTIVE'").first("count"), 0);
});

test("the lifecycle version allows only one winner for competing status changes", async () => {
  await unlockFixturePeriod();
  const results = await Promise.all([
    statusChange("SUSPENDED", 0),
    statusChange("TERMINATED", 0),
  ]);
  assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 409]);
  assert.equal(await db.prepare("SELECT lifecycle_version FROM employees WHERE id = 'employee-life'").first("lifecycle_version"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM employee_status_history WHERE employee_id = 'employee-life'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
});

test("a stale profile update cannot overwrite a concurrent status transition", async () => {
  await unlockFixturePeriod();
  const originalBatch = db.batch.bind(db);
  let injected = false;
  let transitionStatus = 0;
  const interceptProfileBatch = async (statements) => {
    if (!injected) {
      injected = true;
      db.batch = originalBatch;
      transitionStatus = (await statusChange("SUSPENDED", 0)).response.status;
      db.batch = interceptProfileBatch;
    }
    return originalBatch(statements);
  };
  db.batch = interceptProfileBatch;
  let response;
  try {
    response = await employeesRoute.PATCH(request(
      "/api/employees",
      managerToken,
      "PATCH",
      profilePatch({ password: "Replacement-Secret-2026" }),
    ));
  } finally {
    db.batch = originalBatch;
  }

  assert.equal(transitionStatus, 200);
  assert.equal(response.status, 409);
  assert.deepEqual({ ...await db.prepare(`SELECT name, phone, status,
      COALESCE(lifecycle_version, 0) AS lifecycleVersion
    FROM employees WHERE id = 'employee-life'`).first() }, {
    name: "Nguyễn Nhân Viên",
    phone: "0901234567",
    status: "SUSPENDED",
    lifecycleVersion: 1,
  });
  assert.deepEqual({ ...await db.prepare("SELECT name, username FROM users WHERE id = 'user-life'").first() }, {
    name: "Nguyễn Nhân Viên",
    username: "employee-life",
  });
});

test("a stale profile update cannot resurrect a concurrently purged employee", async () => {
  await unlockFixturePeriod();
  const listed = await adminList();
  const row = listed.body.rows[0];
  const originalBatch = db.batch.bind(db);
  let injected = false;
  let purgeStatus = 0;
  const interceptProfileBatch = async (statements) => {
    if (!injected) {
      injected = true;
      db.batch = originalBatch;
      const purge = await adminEmployeesRoute.DELETE(request("/api/admin/employees", superToken, "DELETE", {
        storeId: "st-can-tho",
        id: row.id,
        versionToken: row.versionToken,
        reason: "Kiểm tra tranh chấp xóa và cập nhật hồ sơ",
        confirmation: row.code,
      }));
      purgeStatus = purge.status;
      db.batch = interceptProfileBatch;
    }
    return originalBatch(statements);
  };
  db.batch = interceptProfileBatch;
  let response;
  try {
    response = await employeesRoute.PATCH(request(
      "/api/employees",
      managerToken,
      "PATCH",
      profilePatch({ password: "Replacement-Secret-2026" }),
    ));
  } finally {
    db.batch = originalBatch;
  }

  assert.equal(purgeStatus, 200);
  assert.equal(response.status, 404);
  const tombstone = await db.prepare(`SELECT name, phone, status, deleted_at AS deletedAt,
      COALESCE(lifecycle_version, 0) AS lifecycleVersion
    FROM employees WHERE id = 'employee-life'`).first();
  assert.equal(tombstone.name, "Nhân viên đã xóa");
  assert.equal(tombstone.phone, "");
  assert.equal(tombstone.status, "ARCHIVED");
  assert.ok(tombstone.deletedAt);
  assert.equal(tombstone.lifecycleVersion, 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM users WHERE employee_id = 'employee-life'").first("count"), 0);

  const managerList = await employeesRoute.GET(request("/api/employees?storeId=st-can-tho", managerToken));
  assert.equal(managerList.status, 200);
  assert.deepEqual((await managerList.json()).employees, []);
});

test("status transition closes an active shift without orders and preserves store expense", async () => {
  await unlockFixturePeriod();
  await db.prepare("DELETE FROM orders WHERE id = 'order-life'").run();
  await db.prepare("UPDATE shift_sessions SET cash_revenue = 0, transfer_revenue = 0, expense_amount = 7000 WHERE id = 'shift-life'").run();
  await db.prepare("UPDATE stores SET revenue = 55000, expense = 23000 WHERE id = 'st-can-tho'").run();
  const changed = await statusChange("SUSPENDED", 0);
  assert.equal(changed.response.status, 200);
  assert.deepEqual({ ...await db.prepare(`SELECT status, cash_revenue AS cashRevenue,
      transfer_revenue AS transferRevenue, expense_amount AS expenseAmount,
      close_reason AS closeReason FROM shift_sessions WHERE id = 'shift-life'`).first() }, {
    status: "COMPLETED", cashRevenue: 0, transferRevenue: 0,
    expenseAmount: 7000, closeReason: "EMPLOYEE_STATUS_CHANGE:SUSPENDED",
  });
  assert.deepEqual({ ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'st-can-tho'").first() }, {
    revenue: 55000, expense: 23000,
  });
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
});

test("status transition respects a locked active accounting period", async () => {
  const changed = await statusChange("SUSPENDED", 0);
  assert.equal(changed.response.status, 423);
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'employee-life'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT status FROM shift_sessions WHERE id = 'shift-life'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'EMPLOYEE_STATUS_CHANGE%'").first("count"), 0);
});

test("a concurrent login can never leave a session after suspension", async () => {
  await unlockFixturePeriod();
  const [login, transition] = await Promise.all([
    loginRoute.POST(request("/api/auth/login", null, "POST", { username: "employee-life", password })),
    statusChange("SUSPENDED", 0),
  ]);
  assert.equal(transition.response.status, 200);
  assert.ok([200, 403].includes(login.status));
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'employee-life'").first("status"), "SUSPENDED");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
});

test("super-admin employee list is scoped, private and rejects normal managers", async () => {
  const denied = await adminList(managerToken);
  assert.equal(denied.response.status, 403);
  const allowed = await adminList();
  assert.equal(allowed.response.status, 200);
  assert.match(allowed.response.headers.get("cache-control") ?? "", /private, no-store/u);
  assert.match(allowed.response.headers.get("vary") ?? "", /Cookie/iu);
  assert.equal(allowed.body.pagination.total, 1);
  assert.equal(allowed.body.rows[0].id, "employee-life");
  assert.equal(allowed.body.rows[0].status, "ACTIVE");
  assert.equal(typeof allowed.body.rows[0].versionToken, "string");
});

test("super-admin status action is versioned and unavailable to a normal manager", async () => {
  await unlockFixturePeriod();
  const listed = await adminList();
  const row = listed.body.rows[0];
  const payload = {
    storeId: "st-can-tho", id: row.id, status: "SUSPENDED",
    versionToken: row.versionToken, reason: "Tạm ngưng từ màn hình quản trị cấp cao",
  };
  let response = await adminEmployeesRoute.PATCH(request("/api/admin/employees", managerToken, "PATCH", payload));
  assert.equal(response.status, 403);
  response = await adminEmployeesRoute.PATCH(request("/api/admin/employees", superToken, "PATCH", payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).row.status, "SUSPENDED");
  response = await adminEmployeesRoute.PATCH(request("/api/admin/employees", superToken, "PATCH", {
    ...payload, status: "TERMINATED",
  }));
  assert.equal(response.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
});

test("super-admin purge refuses to mutate an active shift in a locked accounting period", async () => {
  const listed = await adminList();
  const row = listed.body.rows[0];
  const response = await adminEmployeesRoute.DELETE(request("/api/admin/employees", superToken, "DELETE", {
    storeId: "st-can-tho", id: row.id, versionToken: row.versionToken,
    reason: "Kiểm tra khóa kỳ trước khi xóa", confirmation: row.code,
  }));
  const body = await response.json();
  assert.equal(response.status, 423);
  assert.deepEqual(body.lockedPeriods, ["2026-08"]);
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'employee-life'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT status FROM shift_sessions WHERE id = 'shift-life'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM users WHERE employee_id = 'employee-life'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives WHERE kind = 'EMPLOYEE_PURGE'").first("count"), 0);
});

test("super-admin purge atomically closes active attendance and preserves financial history", async () => {
  await db.prepare("UPDATE employee_payroll_closings SET period = '2026-07' WHERE id = 'payroll-life'").run();
  await db.batch([
    db.prepare(`UPDATE shift_sessions SET
        clock_in_latitude = 10.031234,
        clock_in_longitude = 105.771234,
        clock_in_accuracy_meters = 7.25,
        clock_in_location_captured_at = '2026-08-10T00:59:58.000Z'
      WHERE id = 'shift-life'`),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, shift_name, work_date,
        applied_hourly_rate, applied_tiktok_allowance,
        started_at, ended_at, duration_seconds,
        clock_in_latitude, clock_in_longitude, clock_in_accuracy_meters,
        clock_in_location_captured_at, expense_amount, cash_revenue,
        transfer_revenue, close_reason, close_status, status)
      VALUES ('shift-life-historical', 'SHIFT-HISTORICAL', 'st-can-tho', 'employee-life',
        'Ca lịch sử', '2026-07-20', 23000, 27000,
        '2026-07-20T01:00:00.000Z', '2026-07-20T05:00:00.000Z', 14400,
        10.041234, 105.781234, 5.5, '2026-07-20T00:59:55.000Z',
        4300, 40000, 30000, 'EMPLOYEE_END', 'CONFIRMED', 'COMPLETED')`),
  ]);
  const listed = await adminList();
  const row = listed.body.rows[0];
  const payrollBefore = await db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE id = 'payroll-life'").first("snapshot_json");
  const recordJsonBefore = await db.prepare("SELECT data_json FROM business_records WHERE id = 'record-life'").first("data_json");
  const archiveBefore = await db.prepare("SELECT snapshot_json FROM admin_reset_archives WHERE id = 'archive-life-before'").first("snapshot_json");
  const employeeIdentityBefore = await db.prepare(`SELECT name, code, phone
    FROM employees WHERE id = 'employee-life'`).first();
  const legacyIdentityFingerprint = await auth.sha256(JSON.stringify({
    id: row.id,
    storeId: row.storeId,
    code: row.code,
    name: row.name,
    phone: row.phone,
    username: row.username,
    status: row.status,
    lifecycleVersion: row.lifecycleVersion,
  }));
  const purgeReasonWithPii = "PURGE-REQUEST-PII 0901234567 SECRET-REASON-7B1B9";
  const response = await adminEmployeesRoute.DELETE(request("/api/admin/employees", superToken, "DELETE", {
    storeId: "st-can-tho",
    id: row.id,
    versionToken: row.versionToken,
    reason: purgeReasonWithPii,
    confirmation: row.code,
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.attendanceReview.length, 0);
  assert.equal(body.closedAttendance.length, 1);
  assert.equal(body.closedAttendance[0].id, "shift-life");
  assert.ok(body.warning === null || typeof body.warning === "string");

  const tombstone = await db.prepare(`SELECT code, name, phone, province, ward,
      address_line AS addressLine, cccd_image_key AS cccdImageKey,
      hourly_rate AS hourlyRate, tiktok_allowance AS tiktokAllowance,
      status, deleted_at AS deletedAt
    FROM employees WHERE id = 'employee-life'`).first();
  assert.match(tombstone.code, /^DEL-/u);
  assert.equal(tombstone.name, "Nhân viên đã xóa");
  assert.equal(tombstone.phone, "");
  assert.equal(tombstone.province, "");
  assert.equal(tombstone.ward, "");
  assert.equal(tombstone.addressLine, "");
  assert.equal(tombstone.cccdImageKey, null);
  assert.equal(tombstone.hourlyRate, 0);
  assert.equal(tombstone.tiktokAllowance, 0);
  assert.equal(tombstone.status, "ARCHIVED");
  assert.ok(tombstone.deletedAt);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM users WHERE employee_id = 'employee-life'").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'user-life'").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = 'user-life'").first("count"), 0);
  const transferAfter = await db.prepare(`SELECT status, reason, shifts_json AS shiftsJson
    FROM employee_transfers WHERE id = 'transfer-life'`).first();
  assert.equal(transferAfter.status, "CANCELLED");
  assert.equal(transferAfter.reason.includes("Nguyễn Nhân Viên"), false);
  assert.equal(transferAfter.reason.includes("NVLIFE"), false);
  assert.equal(transferAfter.reason.includes("0901234567"), false);
  const transferShifts = JSON.parse(transferAfter.shiftsJson);
  assert.equal(transferShifts[0].employeeId, "employee-life");
  assert.equal(transferShifts[0].employeeName, "Nhân viên đã xóa");
  assert.equal(transferShifts[0].employeeCode, tombstone.code);
  assert.equal(transferShifts[0].employeePhone, "");
  assert.equal(transferShifts[0].shift, "Ca 1");

  const historicalTransfers = (await db.prepare(`SELECT id, status, ended_at AS endedAt,
      reason, shifts_json AS shiftsJson
    FROM employee_transfers
    WHERE id IN ('transfer-completed-life', 'transfer-cancelled-life')
    ORDER BY id`).all()).results;
  assert.deepEqual(historicalTransfers.map(({ id, status, endedAt }) => ({ id, status, endedAt })), [
    { id: "transfer-cancelled-life", status: "CANCELLED", endedAt: null },
    {
      id: "transfer-completed-life",
      status: "COMPLETED",
      endedAt: "2026-07-05T12:00:00.000Z",
    },
  ]);
  for (const historicalTransfer of historicalTransfers) {
    const serialized = `${historicalTransfer.reason}\n${historicalTransfer.shiftsJson}`;
    assert.equal(serialized.includes(employeeIdentityBefore.name), false);
    assert.equal(serialized.includes(employeeIdentityBefore.code), false);
    assert.equal(serialized.includes(employeeIdentityBefore.phone), false);
    const snapshot = JSON.parse(historicalTransfer.shiftsJson);
    assert.equal(snapshot[0].employeeId, "employee-life");
    assert.equal(snapshot[0].employeeName, tombstone.name);
    assert.equal(snapshot[0].employeeCode, tombstone.code);
    assert.equal(snapshot[0].employeePhone, "");
  }

  const managerOrderNotice = await db.prepare(`SELECT id, recipient_user_id AS recipientUserId,
      entity_type AS entityType, entity_id AS entityId, title, message,
      data_json AS dataJson, read_at AS readAt, created_at AS createdAt
    FROM notifications WHERE id = 'notice-manager-order-life'`).first();
  assert.deepEqual({
    id: managerOrderNotice.id,
    recipientUserId: managerOrderNotice.recipientUserId,
    entityType: managerOrderNotice.entityType,
    entityId: managerOrderNotice.entityId,
    readAt: managerOrderNotice.readAt,
    createdAt: managerOrderNotice.createdAt,
  }, {
    id: "notice-manager-order-life",
    recipientUserId: "manager-life",
    entityType: "ORDER",
    entityId: "order-life",
    readAt: "2026-08-10T03:15:00.000Z",
    createdAt: "2026-08-10T03:00:00.000Z",
  });
  const managerNoticeSnapshot = JSON.parse(managerOrderNotice.dataJson);
  assert.equal(managerNoticeSnapshot.orderId, "order-life");
  assert.equal(managerNoticeSnapshot.orderCode, "DH99001");
  assert.equal(managerNoticeSnapshot.employeeId, "employee-life");
  assert.equal(managerNoticeSnapshot.employeeName, tombstone.name);
  assert.equal(managerNoticeSnapshot.employeeCode, tombstone.code);
  assert.equal(managerNoticeSnapshot.employeePhone, "");
  for (const pii of Object.values(employeeIdentityBefore)) {
    assert.equal(`${managerOrderNotice.title}\n${managerOrderNotice.message}\n${managerOrderNotice.dataJson}`.includes(pii), false);
  }

  const closedShift = await db.prepare(`SELECT status, ended_at AS endedAt,
      duration_seconds AS durationSeconds, close_reason AS closeReason,
      close_status AS closeStatus, applied_hourly_rate AS appliedHourlyRate,
      applied_tiktok_allowance AS appliedTiktokAllowance,
      clock_in_latitude AS clockInLatitude,
      clock_in_longitude AS clockInLongitude,
      clock_in_accuracy_meters AS clockInAccuracyMeters,
      clock_in_location_captured_at AS clockInLocationCapturedAt,
      cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue,
      expense_amount AS expenseAmount
    FROM shift_sessions WHERE id = 'shift-life'`).first();
  assert.equal(closedShift.status, "COMPLETED");
  assert.ok(closedShift.endedAt);
  assert.ok(closedShift.durationSeconds > 0);
  assert.equal(closedShift.closeReason, "SUPER_ADMIN_EMPLOYEE_PURGE");
  assert.equal(closedShift.closeStatus, "CONFIRMED");
  assert.equal(closedShift.appliedHourlyRate, 23000);
  assert.equal(closedShift.appliedTiktokAllowance, 27000);
  assert.equal(closedShift.clockInLatitude, null);
  assert.equal(closedShift.clockInLongitude, null);
  assert.equal(closedShift.clockInAccuracyMeters, null);
  assert.equal(closedShift.clockInLocationCapturedAt, null);
  assert.equal(closedShift.cashRevenue, 120000);
  assert.equal(closedShift.transferRevenue, 0);
  assert.equal(closedShift.expenseAmount, 10000);
  assert.deepEqual({ ...await db.prepare(`SELECT status,
      started_at AS startedAt, ended_at AS endedAt,
      duration_seconds AS durationSeconds,
      clock_in_latitude AS clockInLatitude,
      clock_in_longitude AS clockInLongitude,
      clock_in_accuracy_meters AS clockInAccuracyMeters,
      clock_in_location_captured_at AS clockInLocationCapturedAt,
      applied_hourly_rate AS appliedHourlyRate,
      applied_tiktok_allowance AS appliedTiktokAllowance,
      cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue,
      expense_amount AS expenseAmount, close_reason AS closeReason,
      close_status AS closeStatus
    FROM shift_sessions WHERE id = 'shift-life-historical'`).first() }, {
    status: "COMPLETED",
    startedAt: "2026-07-20T01:00:00.000Z",
    endedAt: "2026-07-20T05:00:00.000Z",
    durationSeconds: 14400,
    clockInLatitude: null,
    clockInLongitude: null,
    clockInAccuracyMeters: null,
    clockInLocationCapturedAt: null,
    appliedHourlyRate: 23000,
    appliedTiktokAllowance: 27000,
    cashRevenue: 40000,
    transferRevenue: 30000,
    expenseAmount: 4300,
    closeReason: "EMPLOYEE_END",
    closeStatus: "CONFIRMED",
  });
  assert.deepEqual({ ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'st-can-tho'").first() }, {
    revenue: 120000,
    expense: 10000,
  });
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'order-life'").first("count"), 1);
  const payrollAfter = JSON.parse(await db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE id = 'payroll-life'").first("snapshot_json"));
  assert.equal(payrollAfter.employeeId, "employee-life");
  assert.equal(payrollAfter.employeeName, "Nhân viên đã xóa");
  assert.equal(payrollAfter.employeeCode, tombstone.code);
  assert.equal(payrollAfter.employeePhone, "");
  assert.equal(payrollAfter.pay, 230000);
  assert.notEqual(JSON.stringify(payrollAfter), payrollBefore);
  const liveRecordAfter = JSON.parse(await db.prepare("SELECT data_json FROM business_records WHERE id = 'record-life'").first("data_json"));
  assert.equal(liveRecordAfter.employeeId, "employee-life");
  assert.equal(liveRecordAfter.employeeName, "Nhân viên đã xóa");
  assert.equal(liveRecordAfter.amount, 123000);
  assert.notEqual(JSON.stringify(liveRecordAfter), recordJsonBefore);
  const historicalArchiveAfter = await db.prepare(`SELECT filter_json AS filterJson,
      summary_json AS summaryJson, snapshot_json AS snapshotJson
    FROM admin_reset_archives WHERE id = 'archive-life-before'`).first();
  const historicalFilter = JSON.parse(historicalArchiveAfter.filterJson);
  const historicalSummary = JSON.parse(historicalArchiveAfter.summaryJson);
  const historicalSnapshot = JSON.parse(historicalArchiveAfter.snapshotJson);
  assert.equal(historicalFilter.employeeId, "employee-life");
  assert.equal(historicalFilter.employeeCode, tombstone.code);
  assert.equal(historicalSummary.count, 1);
  assert.equal(historicalSummary.employeePhone, "");
  assert.equal(historicalSnapshot.employeeId, "employee-life");
  assert.equal(historicalSnapshot.employeeName, "Nhân viên đã xóa");
  assert.equal(historicalSnapshot.amount, 120000);
  assert.notEqual(historicalArchiveAfter.snapshotJson, archiveBefore);
  assert.equal(JSON.stringify(historicalArchiveAfter).includes("Nguyễn Nhân Viên"), false);
  assert.equal(JSON.stringify(historicalArchiveAfter).includes("NVLIFE"), false);
  assert.equal(JSON.stringify(historicalArchiveAfter).includes("0901234567"), false);
  assert.doesNotThrow(() => JSON.parse(payrollBefore));
  assert.doesNotThrow(() => JSON.parse(recordJsonBefore));
  assert.doesNotThrow(() => JSON.parse(archiveBefore));

  const after = await adminList();
  assert.equal(after.body.rows.length, 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SUPER_ADMIN_EMPLOYEE_PURGE'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SUPER_ADMIN_EMPLOYEE_PURGE_SHIFT_CLOSE' AND entity_id = 'shift-life'").first("count"), 1);
  const purgeArchive = JSON.parse(await db.prepare("SELECT snapshot_json FROM admin_reset_archives WHERE kind = 'EMPLOYEE_PURGE'").first("snapshot_json"));
  assert.equal(purgeArchive.schemaVersion, 3);
  assert.equal(purgeArchive.piiRetainedInLiveProfile, false);
  assert.equal(purgeArchive.historicalFinancialSnapshotsRetained, true);
  assert.deepEqual(purgeArchive.tombstone, {
    employeeId: "employee-life",
    code: tombstone.code,
    lifecycleVersion: 1,
  });
  assert.equal(purgeArchive.reasonCategory, "SUPER_ADMIN_EMPLOYEE_PURGE");
  assert.equal(purgeArchive.activeShiftClosures.length, 1);
  assert.equal(purgeArchive.activeShiftClosures[0].before.status, "ACTIVE");
  assert.equal(purgeArchive.activeShiftClosures[0].after.status, "COMPLETED");
  assert.equal(JSON.stringify(purgeArchive).includes("Nguyễn Nhân Viên"), false);
  assert.equal(JSON.stringify(purgeArchive).includes("0901234567"), false);
  assertNoExactAttendanceLocation(purgeArchive, "purge archive");

  const purgeAuditRows = (await db.prepare(`SELECT action, detail
    FROM audit_logs
    WHERE action IN ('SUPER_ADMIN_EMPLOYEE_PURGE', 'SUPER_ADMIN_EMPLOYEE_PURGE_SHIFT_CLOSE')
    ORDER BY action`).all()).results;
  assert.equal(purgeAuditRows.length, 2);
  const purgeAuditPayloads = purgeAuditRows.map((entry) => JSON.parse(entry.detail));
  purgeAuditPayloads.forEach((payload, index) => assertNoExactAttendanceLocation(payload, `purge audit ${index}`));
  const retainedPurgeHistory = JSON.stringify({
    archive: purgeArchive,
    audit: purgeAuditPayloads,
    statusReason: await db.prepare(`SELECT reason FROM employee_status_history
      WHERE employee_id = 'employee-life' AND to_status = 'ARCHIVED'`).first("reason"),
  });
  assert.equal(retainedPurgeHistory.includes(purgeReasonWithPii), false);
  assert.equal(retainedPurgeHistory.includes("SECRET-REASON-7B1B9"), false);
  assert.equal(retainedPurgeHistory.includes(legacyIdentityFingerprint), false);
  assert.equal(retainedPurgeHistory.includes('"fingerprint"'), false);
  assert.equal(JSON.parse(retainedPurgeHistory).statusReason, "SUPER_ADMIN_EMPLOYEE_PURGE");

  const repeated = await adminEmployeesRoute.DELETE(request("/api/admin/employees", superToken, "DELETE", {
    storeId: "st-can-tho", id: row.id, versionToken: row.versionToken,
    reason: "Lặp lại yêu cầu xóa", confirmation: row.code,
  }));
  assert.equal(repeated.status, 404);
  const login = await loginRoute.POST(request("/api/auth/login", null, "POST", { username: "employee-life", password }));
  assert.equal(login.status, 401);
});

test("super-admin purge closes an active shift without orders without changing store finance", async () => {
  await db.prepare("UPDATE employee_payroll_closings SET period = '2026-07' WHERE id = 'payroll-life'").run();
  await db.prepare("DELETE FROM orders WHERE id = 'order-life'").run();
  await db.prepare("UPDATE shift_sessions SET cash_revenue = 0, transfer_revenue = 0, expense_amount = 7000 WHERE id = 'shift-life'").run();
  await db.prepare("UPDATE stores SET revenue = 55000, expense = 23000 WHERE id = 'st-can-tho'").run();
  const listed = await adminList();
  const row = listed.body.rows[0];
  const response = await adminEmployeesRoute.DELETE(request("/api/admin/employees", superToken, "DELETE", {
    storeId: "st-can-tho", id: row.id, versionToken: row.versionToken,
    reason: "Xóa nhân viên có ca không phát sinh đơn", confirmation: row.code,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual({ ...await db.prepare(`SELECT status, cash_revenue AS cashRevenue,
      transfer_revenue AS transferRevenue, expense_amount AS expenseAmount,
      close_reason AS closeReason
    FROM shift_sessions WHERE id = 'shift-life'`).first() }, {
    status: "COMPLETED", cashRevenue: 0, transferRevenue: 0,
    expenseAmount: 7000, closeReason: "SUPER_ADMIN_EMPLOYEE_PURGE",
  });
  assert.deepEqual({ ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'st-can-tho'").first() }, {
    revenue: 55000, expense: 23000,
  });
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'employee-life'").first("status"), "ARCHIVED");
});

test("END and employee purge race has one financial close winner and never leaves an orphan active shift", async () => {
  await db.prepare("UPDATE employee_payroll_closings SET period = '2026-07' WHERE id = 'payroll-life'").run();
  await db.prepare("UPDATE shift_sessions SET cash_revenue = 0, transfer_revenue = 0, expense_amount = 0 WHERE id = 'shift-life'").run();
  await db.prepare("UPDATE stores SET revenue = 0, expense = 0 WHERE id = 'st-can-tho'").run();
  const listed = await adminList();
  const row = listed.body.rows[0];
  const [endResponse, purgeResponse] = await Promise.all([
    shiftRoute.POST(request("/api/shift", employeeToken, "POST", {
      action: "end", tasksCompleted: true, tiktok: false,
      expenseAmount: 0, cashRevenue: 120000, transferRevenue: 0,
      earlyEndConfirmed: true,
    })),
    adminEmployeesRoute.DELETE(request("/api/admin/employees", superToken, "DELETE", {
      storeId: "st-can-tho", id: row.id, versionToken: row.versionToken,
      reason: "Kiểm tra tranh chấp kết ca và xóa", confirmation: row.code,
    })),
  ]);
  assert.ok(endResponse.status === 200 || purgeResponse.status === 200);
  assert.ok([endResponse.status, purgeResponse.status].every((status) => [200, 401, 409].includes(status)));
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE id = 'shift-life' AND status = 'ACTIVE'").first("count"), 0);
  assert.deepEqual({ ...await db.prepare("SELECT status, cash_revenue AS cashRevenue FROM shift_sessions WHERE id = 'shift-life'").first() }, {
    status: "COMPLETED", cashRevenue: 120000,
  });
  assert.deepEqual({ ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'st-can-tho'").first() }, {
    revenue: 120000, expense: 0,
  });
  const closeAudits = await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs
    WHERE entity_id IN ('SHIFT-LIFE', 'shift-life')
      AND action IN ('SHIFT_END', 'SUPER_ADMIN_EMPLOYEE_PURGE_SHIFT_CLOSE')`).first("count");
  assert.equal(closeAudits, 1);
});

test("purge rejects a negative store revenue reconciliation before mutating anything", async () => {
  await db.prepare("UPDATE employee_payroll_closings SET period = '2026-07' WHERE id = 'payroll-life'").run();
  await db.prepare("DELETE FROM orders WHERE id = 'order-life'").run();
  await db.prepare("UPDATE stores SET revenue = 100000 WHERE id = 'st-can-tho'").run();
  const listed = await adminList();
  const row = listed.body.rows[0];
  const response = await adminEmployeesRoute.DELETE(request("/api/admin/employees", superToken, "DELETE", {
    storeId: "st-can-tho", id: row.id, versionToken: row.versionToken,
    reason: "Kiểm tra bất biến doanh thu âm", confirmation: row.code,
  }));
  assert.equal(response.status, 409);
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'employee-life'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT status FROM shift_sessions WHERE id = 'shift-life'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 100000);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives WHERE kind = 'EMPLOYEE_PURGE'").first("count"), 0);
});
