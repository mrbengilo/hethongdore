import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-super-admin-reset-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, resetRoute, itemRoute, payrollRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/admin/reset-data/route.ts"),
  import("../app/api/admin/reset-data/items/route.ts"),
  import("../app/api/payroll/route.ts"),
]);

let db;
const superToken = "super-admin-session-token";
const normalToken = "normal-manager-session-token";

before(async () => { db = await initDb(); });
after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of ["sessions", "admin_reset_archives", "notifications", "orders", "audit_logs", "employee_payroll_closings", "shift_sessions", "employees"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM business_records").run();
  await db.prepare("DELETE FROM users WHERE id != 'user-manager'").run();
  await db.prepare("UPDATE users SET is_super_admin = 1, failed_attempts = 0, locked_until = NULL WHERE id = 'user-manager'").run();
  await db.prepare(`INSERT INTO users
    (id, username, password_hash, role, name, shift_active, is_super_admin)
    VALUES ('manager-normal', 'manager-normal', 'unused', 'MANAGER', 'Quản lý thường', 0, 0)`).run();
  await db.prepare("UPDATE stores SET revenue = 150000, expense = 12000, status = 'ACTIVE' WHERE id = 'st-can-tho'").run();
  await db.prepare(`INSERT INTO employees
    (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
    VALUES ('employee-reset', 'st-can-tho', 'RESET01', 'Nhân viên Reset', 'Nhân viên bán hàng', '0900000000', 20000, 25000, 'ACTIVE')`).run();
  await db.prepare(`INSERT INTO shift_sessions
    (id, shift_code, store_id, employee_id, shift_name, work_date, started_at, ended_at,
      cash_revenue, transfer_revenue, expense_amount, status, close_status)
    VALUES ('shift-reset', 'SHIFT-RESET', 'st-can-tho', 'employee-reset', 'Ca 1', '2026-08-10',
      '2026-08-10T01:00:00.000Z', '2026-08-10T05:00:00.000Z', 100000, 50000, 12000, 'COMPLETED', 'CONFIRMED')`).run();
  await db.prepare(`INSERT INTO orders
    (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
    VALUES
      ('order-cash', 'DHRESET1', 'st-can-tho', 'employee-reset', 'SHIFT-RESET', 100000, 'CASH', 'COMPLETED', '2026-08-10T02:00:00.000Z'),
      ('order-bank', 'DHRESET2', 'st-can-tho', 'employee-reset', 'SHIFT-RESET', 50000, 'BANK_TRANSFER', 'COMPLETED', '2026-08-10T03:00:00.000Z')`).run();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('session-super', 'user-manager', ?, ?, ?)")
    .bind(await sha256(superToken), Date.now() + 60_000, new Date().toISOString()).run();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('session-normal', 'manager-normal', ?, ?, ?)")
    .bind(await sha256(normalToken), Date.now() + 60_000, new Date().toISOString()).run();
});

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { cookie: `dore_session=${encodeURIComponent(token)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const orderFilter = {
  storeId: "st-can-tho",
  kind: "ORDERS",
  range: "MONTH",
  period: "2026-08",
  employeeId: "employee-reset",
};

async function preview(filter, token = superToken) {
  const query = new URLSearchParams(filter).toString();
  const response = await resetRoute.GET(request(`/api/admin/reset-data?${query}`, token));
  return { response, body: await response.json() };
}

async function itemList(resource = "ORDERS", extra = {}, token = superToken) {
  const query = new URLSearchParams({ storeId: "st-can-tho", resource, range: "ALL", ...extra }).toString();
  const response = await itemRoute.GET(request(`/api/admin/reset-data/items?${query}`, token));
  return { response, body: await response.json() };
}

async function itemMutation(method, body, token = superToken) {
  const response = await itemRoute[method](request("/api/admin/reset-data/items", token, method, body));
  return { response, body: await response.json() };
}

test("normal managers cannot inspect or execute store reset", async () => {
  const result = await preview(orderFilter, normalToken);
  assert.equal(result.response.status, 403);
  const post = await resetRoute.POST(request("/api/admin/reset-data", normalToken, "POST", { ...orderFilter, confirmation: "DORE CẦN THƠ", previewToken: "x" }));
  assert.equal(post.status, 403);
});

test("store reset navigation is exposed only by the super-admin flag", async () => {
  const portal = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  assert.match(portal, /Number\(user\.isSuperAdmin\) === 1 \? superAdminStoreMenu : storeMenu/u);
  assert.match(portal, /view === "Reset Dữ Liệu" && isSuperAdmin \? <SuperAdminReset/u);
  assert.match(portal, /"Reset Dữ Liệu": DatabaseBackup/u);
});

test("super-admin order reset is preview-bound, archived and reconciles shift/store revenue", async () => {
  await db.prepare(`INSERT INTO notifications
    (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, created_at)
    VALUES ('notice-reset', 'user-manager', 'st-can-tho', 'NEW_ORDER', 'ORDER', 'order-cash',
      'Đơn mới', 'Đơn hàng cần xem', '{}', '2026-08-10T02:00:01.000Z')`).run();
  const first = await preview(orderFilter);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.summary.count, 2);
  assert.equal(first.body.summary.amount, 150000);

  const wrong = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...orderFilter,
    previewToken: first.body.previewToken,
    confirmation: "sai",
  }));
  assert.equal(wrong.status, 400);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), 2);

  const completed = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...orderFilter,
    previewToken: first.body.previewToken,
    confirmation: "DORE CẦN THƠ",
  }));
  assert.equal(completed.status, 200);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), 0);
  assert.deepEqual(
    { ...await db.prepare("SELECT cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue FROM shift_sessions WHERE id = 'shift-reset'").first() },
    { cashRevenue: 0, transferRevenue: 0 },
  );
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives WHERE kind = 'ORDERS'").first("count"), 1);
  const archived = JSON.parse(await db.prepare("SELECT snapshot_json FROM admin_reset_archives WHERE kind = 'ORDERS'").first("snapshot_json"));
  assert.equal(archived.schemaVersion, 1);
  assert.equal(archived.kind, "ORDERS");
  assert.deepEqual(archived.store, { id: "st-can-tho", revenue: 150000, expense: 12000 });
  assert.equal(archived.rows.length, 2);
  assert.ok(Object.hasOwn(archived.rows[0], "code"));
  assert.ok(Object.hasOwn(archived.rows[0], "shiftDurationSeconds"));
  assert.equal(archived.rows.flatMap((row) => row.notifications).length, 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SUPER_ADMIN_STORE_DATA_RESET'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM employees WHERE id = 'employee-reset'").first("count"), 1);
});

test("attendance reset requires orders first and then reconciles expense without touching employees", async () => {
  const attendanceFilter = { storeId: "st-can-tho", kind: "ATTENDANCE", range: "DAY", date: "2026-08-10", shiftCode: "SHIFT-RESET" };
  let attendance = await preview(attendanceFilter);
  let blocked = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...attendanceFilter,
    previewToken: attendance.body.previewToken,
    confirmation: "DORE CẦN THƠ",
  }));
  assert.equal(blocked.status, 409);

  const orders = await preview(orderFilter);
  await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", { ...orderFilter, previewToken: orders.body.previewToken, confirmation: "DORE CẦN THƠ" }));
  attendance = await preview(attendanceFilter);
  const completed = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...attendanceFilter,
    previewToken: attendance.body.previewToken,
    confirmation: "DORE CẦN THƠ",
  }));
  assert.equal(completed.status, 200);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE id = 'shift-reset'").first("count"), 0);
  assert.equal(await db.prepare("SELECT expense FROM stores WHERE id = 'st-can-tho'").first("expense"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM employees WHERE id = 'employee-reset'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives").first("count"), 2);
});

test("a locked employee payroll period blocks destructive reset", async () => {
  await db.prepare(`INSERT INTO employee_payroll_closings
    (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
    VALUES ('lock-reset', 'st-can-tho', 'employee-reset', '2026-08', '{}', 'ACTIVE', 'LOCKED', ?, 'user-manager')`)
    .bind(new Date().toISOString()).run();
  const first = await preview(orderFilter);
  const response = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...orderFilter,
    previewToken: first.body.previewToken,
    confirmation: "DORE CẦN THƠ",
  }));
  assert.equal(response.status, 423);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), 2);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives").first("count"), 0);
});

test("completed orders without a persisted shift fail closed without changing store revenue", async () => {
  await db.prepare("DELETE FROM shift_sessions WHERE id = 'shift-reset'").run();
  const first = await preview(orderFilter);
  const response = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...orderFilter, previewToken: first.body.previewToken, confirmation: "DORE CẦN THƠ",
  }));
  assert.equal(response.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), 2);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 150000);
});

test("orders from an active shift cannot be reset or recreate an old idempotency request", async () => {
  await db.prepare("UPDATE shift_sessions SET status = 'ACTIVE', ended_at = NULL WHERE id = 'shift-reset'").run();
  const first = await preview(orderFilter);
  const response = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...orderFilter, previewToken: first.body.previewToken, confirmation: "DORE CẦN THƠ",
  }));
  assert.equal(response.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), 2);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives").first("count"), 0);
});

test("an inconsistent store counter is rejected instead of clamped to zero", async () => {
  await db.prepare("UPDATE stores SET revenue = 100000 WHERE id = 'st-can-tho'").run();
  const first = await preview(orderFilter);
  const response = await resetRoute.POST(request("/api/admin/reset-data", superToken, "POST", {
    ...orderFilter, previewToken: first.body.previewToken, confirmation: "DORE CẦN THƠ",
  }));
  assert.equal(response.status, 409);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 100000);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), 2);
});

test("filter options remain available when a broad preview exceeds the archive size cap", async () => {
  await db.prepare("UPDATE orders SET customer_name = ? WHERE id = 'order-cash'").bind("X".repeat(910000)).run();
  const broad = await preview(orderFilter);
  assert.equal(broad.response.status, 400);
  const query = new URLSearchParams(orderFilter);
  query.set("mode", "options");
  const response = await resetRoute.GET(request(`/api/admin/reset-data?${query}`, superToken));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.employees.some((employee) => employee.id === "employee-reset"), true);
  assert.equal(body.shifts.some((shift) => shift.code === "SHIFT-RESET"), true);
});

test("record management is super-admin only, store scoped, private and non-cacheable", async () => {
  const denied = await itemList("ORDERS", {}, normalToken);
  assert.equal(denied.response.status, 403);

  const allowed = await itemList();
  assert.equal(allowed.response.status, 200);
  assert.match(allowed.response.headers.get("cache-control") ?? "", /private, no-store/u);
  assert.match(allowed.response.headers.get("vary") ?? "", /Cookie/iu);
  assert.equal(allowed.body.rows.length, 2);

  const row = allowed.body.rows.find((item) => item.id === "order-cash");
  const crossStore = await itemMutation("PATCH", {
    storeId: "st-thot-not", resource: "ORDERS", id: row.id, versionToken: row.versionToken,
    reason: "Kiểm tra phạm vi cửa hàng", customerName: "Không đổi", phone: "", age: "",
    amount: 120000, paymentMethod: "CASH",
  });
  assert.equal(crossStore.response.status, 404);
  assert.equal(await db.prepare("SELECT amount FROM orders WHERE id = 'order-cash'").first("amount"), 100000);
});

test("record list pagination is stable, bounded and includes support employees and shift filters", async () => {
  await db.prepare(`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 55
    ) INSERT INTO orders
      (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
    SELECT 'item-page-' || printf('%03d', value), 'ITEM-PAGE-' || printf('%03d', value),
      'st-can-tho', 'employee-reset', 'SHIFT-RESET', 1000, 'CASH', 'COMPLETED',
      printf('2026-08-10T04:%02d:00.000Z', value % 60) FROM sequence`).run();
  await db.prepare(`INSERT INTO employees
    (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
    VALUES ('employee-support-option', 'st-thot-not', 'SUP001', 'Nhân viên hỗ trợ', 'Nhân viên bán hàng', '0900000011', 20000, 0, 'ACTIVE')`).run();
  await db.prepare(`INSERT INTO shift_sessions
    (id, shift_code, store_id, employee_id, shift_name, work_date, started_at, ended_at, status)
    VALUES ('shift-support-option', 'SHIFT-SUPPORT', 'st-can-tho', 'employee-support-option', 'Ca hỗ trợ',
      '2026-08-10', '2026-08-10T01:00:00.000Z', '2026-08-10T02:00:00.000Z', 'COMPLETED')`).run();

  const first = await itemList("ORDERS", { page: "1", pageSize: "500", shiftCode: "SHIFT-RESET" });
  const second = await itemList("ORDERS", { page: "2", pageSize: "50", shiftCode: "SHIFT-RESET" });
  assert.equal(first.body.pagination.pageSize, 50);
  assert.equal(first.body.pagination.total, 57);
  assert.equal(first.body.rows.length, 50);
  assert.equal(second.body.rows.length, 7);
  assert.equal(new Set([...first.body.rows, ...second.body.rows].map((row) => row.id)).size, 57);
  assert.equal(first.body.employees.some((employee) => employee.id === "employee-support-option"), true);

  const supportAttendance = await itemList("ATTENDANCE", { employeeId: "employee-support-option", shiftCode: "SHIFT-SUPPORT" });
  assert.equal(supportAttendance.body.rows.length, 1);
  assert.equal(supportAttendance.body.rows[0].storeId, "st-can-tho");
});

test("order edit and delete archive full preimages and reconcile shift/store revenue exactly", async () => {
  await db.prepare(`UPDATE orders SET customer_name = 'Khách cũ', phone = '0909000000', age = 30,
    client_request_id = 'client-request-1', client_request_fingerprint = 'fingerprint-1'
    WHERE id = 'order-cash'`).run();
  for (const [id, type, readAt] of [["notice-b", "NEW_ORDER", null], ["notice-a", "ORDER_REVIEW", "2026-08-10T03:00:00.000Z"]]) {
    await db.prepare(`INSERT INTO notifications
      (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, read_at, created_at)
      VALUES (?, 'user-manager', 'st-can-tho', ?, 'ORDER', 'order-cash', 'Đơn mới', 'Nội dung', '{"focus":"order-cash"}', ?, ?)`)
      .bind(id, type, readAt, `2026-08-10T02:00:0${id === "notice-a" ? 1 : 2}.000Z`).run();
  }
  await db.prepare(`UPDATE shift_sessions SET scheduled_start = '08:00', scheduled_end = '12:00',
    scheduled_start_at = '2026-08-10T01:00:00.000Z', scheduled_end_at = '2026-08-10T05:00:00.000Z',
    applied_hourly_rate = 20000, applied_tiktok_allowance = 25000,
    attendance_status = 'ON_TIME', attendance_delta_minutes = 0,
    clock_in_latitude = 10.0301, clock_in_longitude = 105.7702,
    clock_in_accuracy_meters = 8.5, clock_in_location_captured_at = '2026-08-10T01:00:00.000Z',
    duration_seconds = 14400, tiktok = 2, tiktok_allowance = 25000, tasks_completed = 6,
    expense_note = 'Chi phí ca', close_reason = 'Kết ca', close_status = 'CONFIRMED'
    WHERE id = 'shift-reset'`).run();

  const listed = await itemList();
  const row = listed.body.rows.find((item) => item.id === "order-cash");
  const edited = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ORDERS", id: row.id, versionToken: row.versionToken,
    reason: "Điều chỉnh đơn theo đối soát", customerName: "Khách mới", phone: "0911000000",
    age: 31, amount: 120000, paymentMethod: "BANK_TRANSFER",
  });
  assert.equal(edited.response.status, 200);
  assert.deepEqual({ ...await db.prepare("SELECT amount, payment_method AS paymentMethod FROM orders WHERE id = 'order-cash'").first() }, {
    amount: 120000, paymentMethod: "BANK_TRANSFER",
  });
  assert.deepEqual({ ...await db.prepare("SELECT cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue FROM shift_sessions WHERE id = 'shift-reset'").first() }, {
    cashRevenue: 0, transferRevenue: 170000,
  });
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 170000);

  const editArchive = JSON.parse(await db.prepare("SELECT snapshot_json FROM admin_reset_archives WHERE kind = 'ORDER_EDIT'").first("snapshot_json"));
  assert.equal(editArchive.before.clientRequestId, "client-request-1");
  assert.equal(editArchive.before.clientRequestFingerprint, "fingerprint-1");
  assert.deepEqual(editArchive.before.notifications.map((notice) => notice.id), ["notice-a", "notice-b"]);
  for (const field of ["scheduledStartAt", "clockInLatitude", "durationSeconds", "adminAdjustedDurationSeconds", "expenseNote", "closeStatus"]) {
    assert.ok(Object.hasOwn(editArchive.before.shiftSnapshot, field), `shift snapshot must retain ${field}`);
  }
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SUPER_ADMIN_ORDER_UPDATE'").first("count"), 1);

  const stale = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ORDERS", id: row.id, versionToken: row.versionToken,
    reason: "Yêu cầu cũ không được ghi", customerName: "Stale", phone: "", age: "",
    amount: 130000, paymentMethod: "CASH",
  });
  assert.equal(stale.response.status, 409);

  const refreshed = await itemList();
  const current = refreshed.body.rows.find((item) => item.id === "order-cash");
  const deleted = await itemMutation("DELETE", {
    storeId: "st-can-tho", resource: "ORDERS", id: current.id, versionToken: current.versionToken,
    reason: "Xóa đơn theo biên bản đối soát",
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'order-cash'").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE entity_id = 'order-cash'").first("count"), 0);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 50000);
});

test("notification changes between load and mutation abort order deletion without partial archive", async () => {
  await db.prepare(`INSERT INTO notifications
    (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, created_at)
    VALUES ('notice-race', 'user-manager', 'st-can-tho', 'NEW_ORDER', 'ORDER', 'order-cash', 'Đơn mới', 'Nội dung', '{}', '2026-08-10T02:00:01.000Z')`).run();
  const listed = await itemList();
  const row = listed.body.rows.find((item) => item.id === "order-cash");
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await db.prepare("UPDATE notifications SET read_at = '2026-08-10T06:00:00.000Z' WHERE id = 'notice-race'").run();
    }
    return originalBatch(statements);
  };
  try {
    const response = await itemMutation("DELETE", {
      storeId: "st-can-tho", resource: "ORDERS", id: row.id, versionToken: row.versionToken,
      reason: "Kiểm tra xung đột thông báo",
    });
    assert.equal(response.response.status, 409);
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'order-cash'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE id = 'notice-race'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives").first("count"), 0);
});

test("attendance override preserves raw evidence, supports explicit zero and propagates to payroll", async () => {
  await db.prepare(`UPDATE shift_sessions SET duration_seconds = 0, admin_adjusted_duration_seconds = NULL,
    scheduled_start_at = '2026-08-10T01:00:00.000Z', scheduled_end_at = '2026-08-10T05:00:00.000Z',
    clock_in_latitude = 10.0301, clock_in_longitude = 105.7702,
    clock_in_accuracy_meters = 7.25, clock_in_location_captured_at = '2026-08-10T01:00:00.000Z'
    WHERE id = 'shift-reset'`).run();
  const before = await db.prepare(`SELECT started_at AS startedAt, ended_at AS endedAt,
    duration_seconds AS rawDuration, admin_adjusted_duration_seconds AS adjusted,
    clock_in_latitude AS latitude, clock_in_longitude AS longitude,
    clock_in_accuracy_meters AS accuracy FROM shift_sessions WHERE id = 'shift-reset'`).first();
  assert.equal(before.adjusted, null, "existing rows must remain unmodified after additive migration");

  let listed = await itemList("ATTENDANCE");
  let row = listed.body.rows[0];
  const edited = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Điều chỉnh giờ theo biên bản", durationHours: "3.5",
  });
  assert.equal(edited.response.status, 200);
  let persisted = await db.prepare(`SELECT started_at AS startedAt, ended_at AS endedAt,
    duration_seconds AS rawDuration, admin_adjusted_duration_seconds AS adjusted,
    clock_in_latitude AS latitude, clock_in_longitude AS longitude,
    clock_in_accuracy_meters AS accuracy FROM shift_sessions WHERE id = 'shift-reset'`).first();
  assert.deepEqual({ ...persisted }, { ...before, adjusted: 12600 });
  let payroll = await payrollRoute.GET(request("/api/payroll?storeId=st-can-tho&period=2026-08", superToken));
  let payrollBody = await payroll.json();
  assert.equal(payrollBody.summary.totalHours, 3.5);

  listed = await itemList("ATTENDANCE");
  row = listed.body.rows[0];
  const blank = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Không được hiểu ô trống là số không", durationHours: "",
  });
  assert.equal(blank.response.status, 400);
  assert.equal(await db.prepare("SELECT admin_adjusted_duration_seconds FROM shift_sessions WHERE id = 'shift-reset'").first("admin_adjusted_duration_seconds"), 12600);

  const zero = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Xác nhận điều chỉnh về không giờ", durationHours: "0",
  });
  assert.equal(zero.response.status, 200);
  persisted = await db.prepare("SELECT duration_seconds AS rawDuration, admin_adjusted_duration_seconds AS adjusted FROM shift_sessions WHERE id = 'shift-reset'").first();
  assert.deepEqual({ ...persisted }, { rawDuration: 0, adjusted: 0 });
  payroll = await payrollRoute.GET(request("/api/payroll?storeId=st-can-tho&period=2026-08", superToken));
  payrollBody = await payroll.json();
  assert.equal(payrollBody.summary.totalHours, 0);
  assert.equal(payrollBody.summary.totalBaseSalary, 0);
});

test("attendance timestamp edit recomputes duration and signed status while preserving finance", async () => {
  await db.prepare(`UPDATE shift_sessions SET
      scheduled_start = '08:00', scheduled_end = '12:00',
      scheduled_start_at = '2026-08-10T01:00:00.000Z',
      scheduled_end_at = '2026-08-10T05:00:00.000Z',
      duration_seconds = 14400, admin_adjusted_duration_seconds = 12600,
      attendance_status = 'ON_TIME', attendance_delta_minutes = 0
    WHERE id = 'shift-reset'`).run();

  const listed = await itemList("ATTENDANCE");
  const row = listed.body.rows[0];
  assert.deepEqual({
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    scheduledStartAt: row.scheduledStartAt,
    scheduledEndAt: row.scheduledEndAt,
  }, {
    scheduledStart: "08:00",
    scheduledEnd: "12:00",
    scheduledStartAt: "2026-08-10T01:00:00.000Z",
    scheduledEndAt: "2026-08-10T05:00:00.000Z",
  });

  const wrongAccountingDate = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Không cho chuyển chấm công sang kỳ khác",
    startedAt: "2026-07-31T00:45:00.000Z",
    endedAt: "2026-07-31T05:15:00.000Z",
  });
  assert.equal(wrongAccountingDate.response.status, 400);
  assert.match(wrongAccountingDate.body.message, /đúng ngày chấm công/iu);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives WHERE kind = 'ATTENDANCE_EDIT'").first("count"), 0);

  const edited = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Điều chỉnh giờ vào và kết ca theo biên bản",
    startedAt: "2026-08-10T00:45:00.000Z",
    endedAt: "2026-08-10T05:15:00.000Z",
  });
  assert.equal(edited.response.status, 200);
  assert.deepEqual({ ...await db.prepare(`SELECT started_at AS startedAt, ended_at AS endedAt,
      duration_seconds AS durationSeconds, admin_adjusted_duration_seconds AS adjusted,
      status, attendance_status AS attendanceStatus,
      attendance_delta_minutes AS attendanceDeltaMinutes
    FROM shift_sessions WHERE id = 'shift-reset'`).first() }, {
    startedAt: "2026-08-10T00:45:00.000Z",
    endedAt: "2026-08-10T05:15:00.000Z",
    durationSeconds: 16200,
    adjusted: null,
    status: "COMPLETED",
    attendanceStatus: "EARLY",
    attendanceDeltaMinutes: -15,
  });
  assert.deepEqual({ ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'st-can-tho'").first() }, {
    revenue: 150000,
    expense: 12000,
  });
  const archive = JSON.parse(await db.prepare("SELECT snapshot_json FROM admin_reset_archives WHERE kind = 'ATTENDANCE_EDIT'").first("snapshot_json"));
  assert.equal(archive.schemaVersion, 2);
  assert.equal(archive.before.startedAt, "2026-08-10T01:00:00.000Z");
  assert.deepEqual(archive.after, {
    startedAt: "2026-08-10T00:45:00.000Z",
    endedAt: "2026-08-10T05:15:00.000Z",
    durationSeconds: 16200,
    status: "COMPLETED",
    attendanceStatus: "EARLY",
    attendanceDeltaMinutes: -15,
  });

  const stale = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Không ghi yêu cầu dùng phiên bản cũ",
    startedAt: "2026-08-10T01:00:00.000Z",
    endedAt: "2026-08-10T05:00:00.000Z",
  });
  assert.equal(stale.response.status, 409);
});

test("attendance timestamp edits keep exact +15 minutes on time and classify the next millisecond late", async () => {
  await db.prepare(`UPDATE shift_sessions SET
      scheduled_start = '08:00', scheduled_end = '12:00',
      scheduled_start_at = '2026-08-10T01:00:00.000Z',
      scheduled_end_at = '2026-08-10T05:00:00.000Z',
      attendance_status = 'LATE', attendance_delta_minutes = 99
    WHERE id = 'shift-reset'`).run();

  let row = (await itemList("ATTENDANCE")).body.rows[0];
  const exact = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Kiểm tra biên đúng mười lăm phút",
    startedAt: "2026-08-10T01:15:00.000Z",
    endedAt: "2026-08-10T05:00:00.000Z",
  });
  assert.equal(exact.response.status, 200);
  assert.deepEqual({ ...await db.prepare(`SELECT attendance_status AS status,
    attendance_delta_minutes AS delta FROM shift_sessions WHERE id = 'shift-reset'`).first() }, {
    status: "ON_TIME", delta: 15,
  });

  row = (await itemList("ATTENDANCE")).body.rows[0];
  const late = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Kiểm tra sau biên một mili giây",
    startedAt: "2026-08-10T01:15:00.001Z",
    endedAt: "2026-08-10T05:00:00.000Z",
  });
  assert.equal(late.response.status, 200);
  assert.deepEqual({ ...await db.prepare(`SELECT attendance_status AS status,
    attendance_delta_minutes AS delta FROM shift_sessions WHERE id = 'shift-reset'`).first() }, {
    status: "LATE", delta: 16,
  });
});

test("active attendance accepts only a start-time correction and cannot bypass atomic close", async () => {
  await db.prepare(`UPDATE shift_sessions SET
      scheduled_start = '08:00', scheduled_end = '12:00',
      scheduled_start_at = '2026-08-10T01:00:00.000Z',
      scheduled_end_at = '2026-08-10T05:00:00.000Z',
      started_at = '2026-08-10T01:00:00.000Z', ended_at = NULL,
      duration_seconds = 0, status = 'ACTIVE', attendance_status = 'ON_TIME',
      attendance_delta_minutes = 0
    WHERE id = 'shift-reset'`).run();
  await db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id,
       shift_active, current_shift, shift_started_at)
    VALUES ('active-attendance-user', 'active-attendance', 'unused', 'EMPLOYEE', 'Nhân viên đang ca',
      'employee-reset', 'st-can-tho', 1, 'SHIFT-RESET', '2026-08-10T01:00:00.000Z')`).run();

  let listed = await itemList("ATTENDANCE");
  let row = listed.body.rows[0];
  const corrected = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Sửa giờ vào ca đang hoạt động",
    startedAt: "2026-08-10T00:40:00.000Z",
    endedAt: null,
  });
  assert.equal(corrected.response.status, 200);
  assert.deepEqual({ ...await db.prepare(`SELECT started_at AS startedAt, ended_at AS endedAt,
      duration_seconds AS durationSeconds, status, attendance_status AS attendanceStatus,
      attendance_delta_minutes AS attendanceDeltaMinutes
    FROM shift_sessions WHERE id = 'shift-reset'`).first() }, {
    startedAt: "2026-08-10T00:40:00.000Z",
    endedAt: null,
    durationSeconds: 0,
    status: "ACTIVE",
    attendanceStatus: "EARLY",
    attendanceDeltaMinutes: -20,
  });
  assert.deepEqual({ ...await db.prepare(`SELECT shift_active AS shiftActive, current_shift AS currentShift,
      shift_started_at AS shiftStartedAt FROM users WHERE id = 'active-attendance-user'`).first() }, {
    shiftActive: 1,
    currentShift: "SHIFT-RESET",
    shiftStartedAt: "2026-08-10T00:40:00.000Z",
  });

  listed = await itemList("ATTENDANCE");
  row = listed.body.rows[0];
  const forbiddenClose = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Không được đóng ca ngoài quy trình kết ca",
    startedAt: row.startedAt,
    endedAt: "2026-08-10T05:00:00.000Z",
  });
  assert.equal(forbiddenClose.response.status, 409);
  assert.equal(await db.prepare("SELECT status FROM shift_sessions WHERE id = 'shift-reset'").first("status"), "ACTIVE");
  assert.deepEqual({ ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'st-can-tho'").first() }, {
    revenue: 150000,
    expense: 12000,
  });
});

test("attendance timestamp race aborts without a partial archive or mutation", async () => {
  await db.prepare(`UPDATE shift_sessions SET scheduled_start = '08:00', scheduled_end = '12:00',
      scheduled_start_at = '2026-08-10T01:00:00.000Z', scheduled_end_at = '2026-08-10T05:00:00.000Z',
      duration_seconds = 14400 WHERE id = 'shift-reset'`).run();
  const listed = await itemList("ATTENDANCE");
  const row = listed.body.rows[0];
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await db.prepare("UPDATE shift_sessions SET started_at = '2026-08-10T01:01:00.000Z' WHERE id = 'shift-reset'").run();
    }
    return originalBatch(statements);
  };
  try {
    const result = await itemMutation("PATCH", {
      storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
      reason: "Kiểm tra xung đột cập nhật giờ",
      startedAt: "2026-08-10T00:55:00.000Z",
      endedAt: "2026-08-10T05:00:00.000Z",
    });
    assert.equal(result.response.status, 409);
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(await db.prepare("SELECT started_at FROM shift_sessions WHERE id = 'shift-reset'").first("started_at"), "2026-08-10T01:01:00.000Z");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM admin_reset_archives").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SUPER_ADMIN_ATTENDANCE_UPDATE'").first("count"), 0);
});

test("attendance delete rejects active, linked and negative-counter states then archives a full row", async () => {
  let listed = await itemList("ATTENDANCE");
  let row = listed.body.rows[0];
  let result = await itemMutation("DELETE", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Không xóa khi còn đơn liên kết",
  });
  assert.equal(result.response.status, 409);

  for (;;) {
    const orders = await itemList("ORDERS");
    if (!orders.body.rows.length) break;
    const order = orders.body.rows[0];
    result = await itemMutation("DELETE", {
      storeId: "st-can-tho", resource: "ORDERS", id: order.id, versionToken: order.versionToken,
      reason: "Xóa đơn trước khi xóa chấm công",
    });
    assert.equal(result.response.status, 200);
  }
  await db.prepare("UPDATE stores SET expense = 0 WHERE id = 'st-can-tho'").run();
  listed = await itemList("ATTENDANCE");
  row = listed.body.rows[0];
  result = await itemMutation("DELETE", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Không cho phép âm tổng chi phí",
  });
  assert.equal(result.response.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE id = 'shift-reset'").first("count"), 1);

  await db.prepare("UPDATE stores SET expense = 12000 WHERE id = 'st-can-tho'").run();
  listed = await itemList("ATTENDANCE");
  row = listed.body.rows[0];
  result = await itemMutation("DELETE", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Xóa chấm công đã đối soát",
  });
  assert.equal(result.response.status, 200);
  assert.equal(await db.prepare("SELECT expense FROM stores WHERE id = 'st-can-tho'").first("expense"), 0);
  const archive = JSON.parse(await db.prepare("SELECT snapshot_json FROM admin_reset_archives WHERE kind = 'ATTENDANCE_DELETE'").first("snapshot_json"));
  for (const field of ["scheduledStartAt", "clockInLatitude", "adminAdjustedDurationSeconds", "expenseNote", "closeStatus"]) {
    assert.ok(Object.hasOwn(archive.before, field), `attendance archive must retain ${field}`);
  }
});

test("active attendance and every store payroll lifecycle status fail closed", async () => {
  await db.prepare("UPDATE shift_sessions SET status = 'ACTIVE', ended_at = NULL WHERE id = 'shift-reset'").run();
  let listed = await itemList("ATTENDANCE");
  let row = listed.body.rows[0];
  let blocked = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
    reason: "Không sửa ca đang hoạt động", durationHours: "2",
  });
  assert.equal(blocked.response.status, 409);
  await db.prepare("UPDATE shift_sessions SET status = 'COMPLETED', ended_at = '2026-08-10T05:00:00.000Z' WHERE id = 'shift-reset'").run();

  const lifecycle = ["MANAGER_FINALIZED", "SALARY_CONFIRMED", "REWARDS_CONFIRMED", "PAYMENT_CONFIRMED", "LOCKED", "FUTURE_STATUS"];
  for (const status of lifecycle) {
    await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES (?, 'PAYROLL_CLOSING', 'st-can-tho', NULL, 'Khóa kỳ', '{"period":"2026-08"}', ?, ?, ?)`)
      .bind(`closing-${status}`, status, new Date().toISOString(), new Date().toISOString()).run();
    listed = await itemList("ATTENDANCE");
    row = listed.body.rows[0];
    assert.equal(row.locked, 1, `status ${status} must mark the row locked`);
    blocked = await itemMutation("PATCH", {
      storeId: "st-can-tho", resource: "ATTENDANCE", id: row.id, versionToken: row.versionToken,
      reason: `Không sửa sau trạng thái ${status}`, durationHours: "2",
    });
    assert.equal(blocked.response.status, 423, `status ${status} must block mutation`);
    await db.prepare("DELETE FROM business_records WHERE id = ?").bind(`closing-${status}`).run();
  }

  await db.prepare(`INSERT INTO employee_payroll_closings
    (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
    VALUES ('future-employee-lock', 'st-can-tho', 'employee-reset', '2026-08', '{}', 'ACTIVE', 'FUTURE_STATUS', ?, 'user-manager')`)
    .bind(new Date().toISOString()).run();
  listed = await itemList("ATTENDANCE");
  assert.equal(listed.body.rows[0].locked, 1);
  blocked = await itemMutation("PATCH", {
    storeId: "st-can-tho", resource: "ATTENDANCE", id: listed.body.rows[0].id,
    versionToken: listed.body.rows[0].versionToken, reason: "Khóa nhân viên trạng thái mới", durationHours: "2",
  });
  assert.equal(blocked.response.status, 423);
});

test("record-management UI has mobile cards, shift filter and an isolated accessible dialog", async () => {
  const [component, css, reports] = await Promise.all([
    readFile(new URL("../app/components/SuperAdminDataRecords.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SuperAdminDataRecords.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReferenceStoreModules.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(component, /shiftCode/u);
  assert.match(component, /dialogRef/u);
  assert.match(component, /setAttribute\("inert"/u);
  assert.match(component, /document\.body\.style\.overflow = "hidden"/u);
  assert.match(component, /triggerRef\.current/u);
  assert.match(component, /type="datetime-local"/u);
  assert.match(component, /body\.startedAt = localDateTimeInputToIso/u);
  assert.match(component, /body\.endedAt = localDateTimeInputToIso/u);
  assert.match(component, /scheduledStart.*scheduledEnd/u);
  assert.match(component, /styles\.early.*styles\.late.*styles\.onTime/u);
  assert.match(component, /DatePickerControl/u);
  assert.match(component, /formatDateVn/u);
  assert.match(css, /min-height: 44px/u);
  assert.match(css, /\.status\.early[\s\S]*\.status\.onTime[\s\S]*\.status\.late/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.table tr \{ display: block/u);
  assert.match(reports, /sessionSeconds\(s\)\/3600/u);
  assert.doesNotMatch(reports, /hours\|\|210|wages\|\|4200000|extras\|\|900000/u);
});
