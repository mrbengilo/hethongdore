import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-shift-order-atomicity-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, orderRoute, shiftRoute, payrollRoute, employeeRoute, storesRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/orders/route.ts"),
  import("../app/api/shift/route.ts"),
  import("../app/api/payroll/route.ts"),
  import("../app/api/employees/route.ts"),
  import("../app/api/stores/route.ts"),
]);

let db;
const token = "atomic-employee-session";
const cookie = `dore_session=${encodeURIComponent(token)}`;
const managerToken = "atomic-manager-session";
const managerCookie = `dore_session=${encodeURIComponent(managerToken)}`;

before(async () => {
  db = await initDb();
});

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

async function seedActiveShift({
  shiftCode = "SHIFT-ACTIVE",
  startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
  scheduledEndAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
} = {}) {
  for (const table of ["sessions", "notifications", "cccd_deletion_outbox", "cccd_upload_registry", "orders", "audit_logs", "employee_payroll_closings", "employee_transfers", "business_records", "shift_sessions", "employees"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM users WHERE role = 'EMPLOYEE' OR id = 'manager-atomic'").run();
  await db.prepare("UPDATE stores SET status = 'ACTIVE', revenue = 0, expense = 0 WHERE id = 'st-can-tho'").run();
  await db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
      VALUES ('employee-atomic', 'st-can-tho', 'ATOMIC01', 'Nhân viên Atomic', 'Nhân viên bán hàng', '0900000000', 20000, 25000, 'ACTIVE')`).run();
  await db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id, shift_active, current_shift, shift_started_at)
      VALUES ('user-atomic', 'atomic01', 'unused', 'EMPLOYEE', 'Nhân viên Atomic', 'employee-atomic', 'st-can-tho', 1, ?, ?)`)
    .bind(shiftCode, startedAt).run();
  await db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end,
       scheduled_start_at, scheduled_end_at, work_date, applied_hourly_rate, applied_tiktok_allowance,
       started_at, close_status, status)
      VALUES ('session-atomic', ?, 'st-can-tho', 'employee-atomic', 'Ca 1', '08:00', '12:00',
        ?, ?, '2026-08-09', 20000, 25000, ?, 'OPEN', 'ACTIVE')`)
    .bind(shiftCode, startedAt, scheduledEndAt, startedAt).run();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('session-login', 'user-atomic', ?, ?, ?)")
    .bind(await sha256(token), Date.now() + 60_000, new Date().toISOString()).run();
  return { shiftCode, startedAt, scheduledEndAt };
}

async function seedManagerSession() {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, is_super_admin)
      VALUES ('manager-atomic', 'manager-atomic', 'unused', 'MANAGER', 'Quản lý Atomic', 0)`).run();
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ('manager-session-login', 'manager-atomic', ?, ?, ?)`)
    .bind(await sha256(managerToken), Date.now() + 60_000, now).run();
  await db.prepare(`INSERT OR REPLACE INTO cccd_upload_registry
      (key, actor_user_id, actor_store_id, actor_global_access, original_name,
       content_type, created_at, claim_status, deletion_status, updated_at)
    VALUES
      ('cccd/00000000-0000-4000-8000-000000000001.jpg', 'manager-atomic', NULL, 1,
        'cccd.jpg', 'image/jpeg', ?, 'PENDING', 'NONE', ?),
      ('cccd/00000000-0000-4000-8000-000000000099.jpg', 'manager-atomic', NULL, 1,
        'cccd-create.jpg', 'image/jpeg', ?, 'PENDING', 'NONE', ?)`)
    .bind(now, now, now, now).run();
}

async function insertOrder({ id, amount, paymentMethod = "CASH", shiftCode = "SHIFT-ACTIVE", createdAt = new Date().toISOString() }) {
  await db.prepare(`INSERT INTO orders
      (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
      VALUES (?, ?, 'st-can-tho', 'employee-atomic', ?, ?, ?, 'COMPLETED', ?)`)
    .bind(id, `DH-${id}`, shiftCode, amount, paymentMethod, createdAt).run();
}

function jsonRequest(path, method, body, extraHeaders = {}, requestCookie = cookie) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { cookie: requestCookie, "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function responseBody(response) {
  return { status: response.status, body: await response.json() };
}

function closePayload(cashRevenue) {
  return {
    action: "end",
    tasksCompleted: true,
    expenseAmount: 0,
    expenseNote: "",
    cashRevenue,
    transferRevenue: 0,
    earlyEndConfirmed: true,
    tiktok: false,
  };
}

test("END rechecks tender inside its batch when a rival POST commits after the pre-read", async () => {
  await seedActiveShift();
  await insertOrder({ id: "order-before", amount: 100_000 });

  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await insertOrder({ id: "order-between-read-and-batch", amount: 50_000 });
    }
    return originalBatch(statements);
  };
  try {
    const staleClose = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", closePayload(100_000))));
    assert.equal(staleClose.status, 409);
    assert.equal(staleClose.body.revenueChanged, true);
  } finally {
    db.batch = originalBatch;
  }

  assert.deepEqual(
    { ...await db.prepare("SELECT status, cash_revenue AS cashRevenue FROM shift_sessions WHERE id = 'session-atomic'").first() },
    { status: "ACTIVE", cashRevenue: 0 },
  );
  assert.deepEqual(
    { ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'st-can-tho'").first() },
    { revenue: 0, expense: 0 },
  );

  const retried = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", closePayload(150_000))));
  assert.equal(retried.status, 200);
  assert.deepEqual(
    { ...await db.prepare("SELECT status, cash_revenue AS cashRevenue, close_status AS closeStatus FROM shift_sessions WHERE id = 'session-atomic'").first() },
    { status: "COMPLETED", cashRevenue: 150_000, closeStatus: "CONFIRMED" },
  );
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 150_000);

  const orderAfterEnd = await responseBody(await orderRoute.POST(jsonRequest("/api/orders", "POST", {
    customerName: "Khách sau kết ca",
    amount: 25_000,
    paymentMethod: "CASH",
    clientRequestId: "atomic-order-after-end-0001",
  }, { "Idempotency-Key": "atomic-order-after-end-0001" })));
  assert.equal(orderAfterEnd.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE client_request_id = 'atomic-order-after-end-0001'").first("count"), 0);
});

test("order creation rechecks ACTIVE store and shift inside the order-notification batch", async () => {
  await seedActiveShift();
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await db.prepare("UPDATE stores SET status = 'INACTIVE' WHERE id = 'st-can-tho'").run();
    }
    return originalBatch(statements);
  };
  try {
    const result = await responseBody(await orderRoute.POST(jsonRequest("/api/orders", "POST", {
      customerName: "Khách Atomic",
      amount: 125_000,
      paymentMethod: "CASH",
      clientRequestId: "atomic-store-stop-0001",
    }, { "Idempotency-Key": "atomic-store-stop-0001" })));
    assert.equal(result.status, 409);
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM notifications").first("count"), 0);
});

test("employee PATCH and DELETE are rejected without mutating an active-shift order", async () => {
  await seedActiveShift();
  await insertOrder({ id: "order-patch-race", amount: 100_000 });
  const patch = await responseBody(await orderRoute.PATCH(jsonRequest("/api/orders", "PATCH", {
    id: "order-patch-race",
    customerName: "Tên mới",
    amount: 120_000,
    paymentMethod: "CASH",
  })));
  assert.equal(patch.status, 403);
  assert.deepEqual(
    { ...await db.prepare("SELECT customer_name AS customerName, amount FROM orders WHERE id = 'order-patch-race'").first() },
    { customerName: null, amount: 100_000 },
  );

  const cancellation = await responseBody(await orderRoute.DELETE(new Request("http://localhost/api/orders?id=order-patch-race", {
    method: "DELETE",
    headers: { cookie },
  })));
  assert.equal(cancellation.status, 403);
  assert.equal(await db.prepare("SELECT status FROM orders WHERE id = 'order-patch-race'").first("status"), "COMPLETED");
});
test("an ACTIVE shift stays open after scheduled end and later orders keep the same shift", async () => {
  const scheduledEndAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const startedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { shiftCode } = await seedActiveShift({ startedAt, scheduledEndAt });

  const sync = await responseBody(await shiftRoute.GET(jsonRequest("/api/shift", "GET")));
  assert.equal(sync.status, 200);
  assert.equal(sync.body.active, true);
  assert.equal(sync.body.shiftCode, shiftCode);
  assert.equal(sync.body.rolloverPending, false);

  const disabledRollover = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", {
    action: "rollover",
    expectedShiftCode: shiftCode,
    expenseAmount: 0,
  })));
  assert.equal(disabledRollover.status, 410);

  const order = await responseBody(await orderRoute.POST(jsonRequest("/api/orders", "POST", {
    customerName: "Khách sau giờ lịch",
    amount: 90_000,
    paymentMethod: "CASH",
    clientRequestId: "active-after-scheduled-end-0001",
  }, { "Idempotency-Key": "active-after-scheduled-end-0001" })));
  assert.equal(order.status, 201);
  assert.equal(
    await db.prepare("SELECT shift_code AS shiftCode FROM orders WHERE client_request_id = 'active-after-scheduled-end-0001'").first("shiftCode"),
    shiftCode,
  );
  assert.equal(await db.prepare("SELECT status FROM shift_sessions WHERE id = 'session-atomic'").first("status"), "ACTIVE");
});

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

async function seedStartableEarlySchedule() {
  await seedActiveShift();
  await db.prepare("DELETE FROM shift_sessions WHERE employee_id = 'employee-atomic'").run();
  await db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = 'user-atomic'").run();

  const now = new Date();
  const scheduledStart = new Date(now.getTime() + 30 * 60_000);
  const scheduledEnd = new Date(scheduledStart.getTime() + 4 * 60 * 60_000);
  const start = vietnamDateAndClock(scheduledStart);
  const end = vietnamDateAndClock(scheduledEnd);
  await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('attendance-early-schedule', 'LICH_PHAN_CA', 'st-can-tho', 'manager-1', 'Ca sớm', ?, 'ACTIVE', ?, ?)`)
    .bind(JSON.stringify({
      date: start.date,
      shiftId: "default-1",
      shiftName: "Ca sớm",
      start: start.clock,
      end: end.clock,
      employeeIds: ["employee-atomic"],
    }), now.toISOString(), now.toISOString()).run();

  const preview = await responseBody(await shiftRoute.GET(jsonRequest("/api/shift?preview=start", "GET")));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.startPreview.attendanceStatus, "EARLY");
  assert.ok(preview.body.startPreview.earlyMinutes >= 29 && preview.body.startPreview.earlyMinutes <= 30);
  return { preview: preview.body.startPreview, period: start.date.slice(0, 7) };
}

async function seedStartableSupportSchedule() {
  await seedActiveShift();
  await db.prepare("DELETE FROM shift_sessions WHERE employee_id = 'employee-atomic'").run();
  await db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = 'user-atomic'").run();
  await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id IN ('st-can-tho', 'st-thot-not')").run();

  const now = new Date();
  const scheduledStart = new Date(now.getTime() + 30 * 60_000);
  const scheduledEnd = new Date(scheduledStart.getTime() + 4 * 60 * 60_000);
  const start = vietnamDateAndClock(scheduledStart);
  const end = vietnamDateAndClock(scheduledEnd);
  const timestamp = now.toISOString();
  await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('attendance-support-schedule', 'LICH_PHAN_CA', 'st-thot-not', 'manager-1', 'Ca 1', ?, 'ACTIVE', ?, ?)`)
    .bind(JSON.stringify({
      date: start.date,
      shiftId: "support-default-1",
      shiftName: "Ca 1",
      start: start.clock,
      end: end.clock,
      employeeIds: ["employee-atomic"],
    }), timestamp, timestamp).run();
  await db.prepare(`INSERT INTO employee_transfers
      (id, employee_id, source_store_id, target_store_id, start_date, end_date, shifts_json,
       support_hourly_rate, support_allowance, reason, status, created_by, created_at, updated_at)
      VALUES ('support-start-race-transfer', 'employee-atomic', 'st-can-tho', 'st-thot-not', ?, ?, ?,
        30000, 0, 'Support START race', 'SCHEDULED', 'manager-1', ?, ?)`)
    .bind(start.date, start.date, JSON.stringify(["Ca 1", "Ca s\u00e1ng"]), timestamp, timestamp).run();

  const preview = await responseBody(await shiftRoute.GET(jsonRequest("/api/shift?preview=start", "GET")));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.startPreview.shiftName, "Ca 1");
  return { preview: preview.body.startPreview };
}

async function seedInactivePayrollTarget(period, { withCompletedShift = false } = {}) {
  const workDate = `${period}-01`;
  const startedAt = `${workDate}T01:00:00.000Z`;
  const endedAt = `${workDate}T05:00:00.000Z`;
  await db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status, inactive_at)
      VALUES ('employee-payroll-target', 'st-can-tho', 'PAYROLL01', 'Nhân viên đã nghỉ',
        'Nhân viên bán hàng', '0900000002', 20000, 25000, 'INACTIVE', ?)`).bind(endedAt).run();
  if (withCompletedShift) {
    await db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end,
         scheduled_start_at, scheduled_end_at, work_date, applied_hourly_rate, applied_tiktok_allowance,
         started_at, ended_at, duration_seconds, close_status, status)
        VALUES ('payroll-target-shift', 'PAYROLL-TARGET-SHIFT', 'st-can-tho', 'employee-payroll-target',
          'Ca đã hoàn tất', '08:00', '12:00', ?, ?, ?, 20000, 25000, ?, ?, 14400, 'CONFIRMED', 'COMPLETED')`)
      .bind(startedAt, endedAt, workDate, startedAt, endedAt).run();
  }
}

async function insertEmployeeClosing(prepare, id, period, status = "CLOSING") {
  await prepare(`INSERT INTO employee_payroll_closings
      (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
    VALUES (?, 'st-can-tho', 'different-employee', ?, '{}', 'ACTIVE', ?, ?, 'manager-atomic')`)
    .bind(id, period, status, new Date().toISOString()).run();
}

function payrollRequest(period) {
  return jsonRequest("/api/payroll", "POST", {
    action: "FINALIZE_SINGLE_EMPLOYEE",
    storeId: "st-can-tho",
    period,
    employeeId: "employee-payroll-target",
  }, {}, managerCookie);
}

test("FINALIZE_SINGLE_EMPLOYEE wins before START and blocks the new store-period shift", async () => {
  const { preview, period } = await seedStartableEarlySchedule();
  await seedManagerSession();
  await seedInactivePayrollTarget(period, { withCompletedShift: true });

  const finalized = await responseBody(await payrollRoute.POST(payrollRequest(period)));
  assert.equal(finalized.status, 201);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM employee_payroll_closings WHERE store_id = 'st-can-tho' AND period = ?").bind(period).first("count"),
    1,
  );

  const start = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", {
    action: "start",
    expectedStart: preview,
    clockInLocation: {
      latitude: 10.045162,
      longitude: 105.746857,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    },
  })));
  assert.equal(start.status, 423);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'employee-atomic' AND status = 'ACTIVE'").first("count"), 0);
  assert.equal(await db.prepare("SELECT shift_active FROM users WHERE id = 'user-atomic'").first("shift_active"), 0);
});

test("START wins before FINALIZE_SINGLE_EMPLOYEE and any unended store shift blocks finalization", async () => {
  await seedActiveShift();
  await seedManagerSession();
  const period = vietnamDateAndClock(new Date()).date.slice(0, 7);
  await seedInactivePayrollTarget(period);

  const finalized = await responseBody(await payrollRoute.POST(payrollRequest(period)));
  assert.equal(finalized.status, 409);
  assert.match(finalized.body.message, /ca làm chưa kết thúc|kết toàn bộ ca/u);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM employee_payroll_closings WHERE employee_id = 'employee-payroll-target' AND period = ?").bind(period).first("count"),
    0,
  );
  assert.equal(await db.prepare("SELECT status FROM shift_sessions WHERE id = 'session-atomic'").first("status"), "ACTIVE");
});

function employeePatchBody(overrides = {}) {
  return {
    id: "employee-atomic",
    storeId: "st-can-tho",
    code: "ATOMIC01",
    name: "Nhân viên Atomic",
    position: "Nhân viên bán hàng",
    phone: "0900000000",
    province: "Cần Thơ",
    ward: "Phường Thốt Nốt",
    addressLine: "1 Đường thử nghiệm",
    age: 25,
    cccdImageKey: "cccd/00000000-0000-4000-8000-000000000001.jpg",
    cccdImageName: "cccd.jpg",
    hourlyRate: 20000,
    ...overrides,
  };
}

function employeeCreateBody(overrides = {}) {
  return {
    storeId: "st-thot-not",
    code: "ATOMIC-CREATE-01",
    name: "NhÃ¢n viÃªn táº¡o race",
    position: "NhÃ¢n viÃªn bÃ¡n hÃ ng",
    phone: "0900000099",
    province: "Cáº§n ThÆ¡",
    ward: "PhÆ°á»ng Thá»‘t Ná»‘t",
    addressLine: "99 ÄÆ°á»ng thá»­ nghiá»‡m",
    age: 26,
    cccdImageKey: "cccd/00000000-0000-4000-8000-000000000099.jpg",
    cccdImageName: "cccd-create.jpg",
    hourlyRate: 20000,
    tiktokAllowance: 25000,
    username: "atomic-create-01",
    password: "temporary-password",
    ...overrides,
  };
}

function storePatchBody(id, status) {
  return {
    id,
    name: id === "st-can-tho" ? "DORE Cáº¦N THÆ " : "DORE THá»T Ná»T",
    address: "Äá»‹a chá»‰ thá»­ nghiá»‡m",
    status,
  };
}

test("employee lifecycle ignores payroll locks while payroll configuration races still fail closed", async () => {
  await seedActiveShift();
  await db.prepare("DELETE FROM shift_sessions WHERE employee_id = 'employee-atomic'").run();
  await db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = 'user-atomic'").run();
  await seedManagerSession();
  const period = vietnamDateAndClock(new Date()).date.slice(0, 7);

  await insertEmployeeClosing(db.prepare.bind(db), "status-race-lock", period);
  const statusChange = await responseBody(await employeeRoute.PATCH(jsonRequest("/api/employees", "PATCH", {
    action: "SET_STATUS",
    id: "employee-atomic",
    storeId: "st-can-tho",
    status: "SUSPENDED",
    expectedVersion: 0,
    reason: "Tạm ngưng không phụ thuộc kỳ lương",
  }, {}, managerCookie)));
  assert.equal(statusChange.status, 200);
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'employee-atomic'").first("status"), "SUSPENDED");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'employee-atomic' AND action = 'EMPLOYEE_STATUS_CHANGE'").first("count"), 1);

  await db.prepare("DELETE FROM employee_payroll_closings WHERE id = 'status-race-lock'").run();
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await insertEmployeeClosing(db.prepare.bind(db), "payroll-config-race-lock", period, "MANAGER_FINALIZED");
    }
    return originalBatch(statements);
  };
  try {
    const payrollConfigChange = await responseBody(await employeeRoute.PATCH(jsonRequest("/api/employees", "PATCH", employeePatchBody({
      name: "Tên không được lưu",
      hourlyRate: 21000,
      tiktokAllowance: 49000,
    }), {}, managerCookie)));
    assert.equal(payrollConfigChange.status, 423);
  } finally {
    db.batch = originalBatch;
  }
  assert.deepEqual(
    { ...await db.prepare("SELECT name, hourly_rate AS hourlyRate, tiktok_allowance AS tiktokAllowance FROM employees WHERE id = 'employee-atomic'").first() },
    { name: "Nhân viên Atomic", hourlyRate: 20000, tiktokAllowance: 25000 },
  );
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'employee-atomic' AND action = 'EMPLOYEE_PAYROLL_CONFIG_UPDATE'").first("count"), 0);

  const profileOnly = await responseBody(await employeeRoute.PATCH(jsonRequest("/api/employees", "PATCH", employeePatchBody({
    name: "Hồ sơ mới",
    hourlyRate: undefined,
  }), {}, managerCookie)));
  assert.equal(profileOnly.status, 200);
  assert.equal(await db.prepare("SELECT name FROM employees WHERE id = 'employee-atomic'").first("name"), "Hồ sơ mới");
  assert.equal(await db.prepare("SELECT hourly_rate FROM employees WHERE id = 'employee-atomic'").first("hourly_rate"), 20000);
  assert.equal(await db.prepare("SELECT tiktok_allowance FROM employees WHERE id = 'employee-atomic'").first("tiktok_allowance"), 25000);
});

test("employee store reassignment is blocked when either source or target store period is locked", async () => {
  await seedActiveShift();
  await db.prepare("DELETE FROM shift_sessions WHERE employee_id = 'employee-atomic'").run();
  await db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = 'user-atomic'").run();
  await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id = 'st-thot-not'").run();
  await seedManagerSession();
  const period = vietnamDateAndClock(new Date()).date.slice(0, 7);

  const assertReassignmentBlocked = async (lockStoreId, lockId) => {
    await db.prepare(`INSERT INTO employee_payroll_closings
        (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
      VALUES (?, ?, 'different-employee', ?, '{}', 'ACTIVE', 'BASE_LOCKED', ?, 'manager-atomic')`)
      .bind(lockId, lockStoreId, period, new Date().toISOString()).run();
    const response = await responseBody(await employeeRoute.PATCH(jsonRequest("/api/employees", "PATCH", employeePatchBody({
      storeId: "st-thot-not",
    }), {}, managerCookie)));
    assert.equal(response.status, 423);
    assert.deepEqual(
      { ...await db.prepare("SELECT e.store_id AS employeeStore, u.store_id AS userStore FROM employees e JOIN users u ON u.employee_id = e.id WHERE e.id = 'employee-atomic'").first() },
      { employeeStore: "st-can-tho", userStore: "st-can-tho" },
    );
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'employee-atomic'").first("count"), 0);
    await db.prepare("DELETE FROM employee_payroll_closings WHERE id = ?").bind(lockId).run();
  };

  await assertReassignmentBlocked("st-can-tho", "source-store-move-lock");
  await assertReassignmentBlocked("st-thot-not", "target-store-move-lock");

  const assertReassignmentRaceBlocked = async (inject, cleanup) => {
    const originalBatch = db.batch.bind(db);
    let injected = false;
    db.batch = async (statements) => {
      if (!injected) {
        injected = true;
        await inject();
      }
      return originalBatch(statements);
    };
    try {
      const response = await responseBody(await employeeRoute.PATCH(jsonRequest("/api/employees", "PATCH", employeePatchBody({
        storeId: "st-thot-not",
      }), {}, managerCookie)));
      assert.equal(response.status, 409);
    } finally {
      db.batch = originalBatch;
    }
    assert.deepEqual(
      { ...await db.prepare("SELECT e.store_id AS employeeStore, u.store_id AS userStore FROM employees e JOIN users u ON u.employee_id = e.id WHERE e.id = 'employee-atomic'").first() },
      { employeeStore: "st-can-tho", userStore: "st-can-tho" },
    );
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'employee-atomic'").first("count"), 0);
    await cleanup();
  };

  await assertReassignmentRaceBlocked(
    () => db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, started_at, close_status, status)
      VALUES ('store-move-race-shift', 'STORE-MOVE-RACE-SHIFT', 'st-can-tho', 'employee-atomic', 'Ca race', ?, 'OPEN', 'ACTIVE')`)
      .bind(new Date().toISOString()).run(),
    () => db.prepare("DELETE FROM shift_sessions WHERE id = 'store-move-race-shift'").run(),
  );

  await assertReassignmentRaceBlocked(
    () => db.prepare(`INSERT INTO employee_transfers
        (id, employee_id, source_store_id, target_store_id, start_date, end_date, shifts_json,
          support_hourly_rate, support_allowance, reason, status, created_by, created_at, updated_at)
      VALUES ('store-move-race-transfer', 'employee-atomic', 'st-can-tho', 'st-thot-not', ?, ?, '[]',
        20000, 0, 'Race test', 'SCHEDULED', 'manager-atomic', ?, ?)`)
      .bind(`${period}-01`, `${period}-28`, new Date().toISOString(), new Date().toISOString()).run(),
    () => db.prepare("DELETE FROM employee_transfers WHERE id = 'store-move-race-transfer'").run(),
  );

  await assertReassignmentRaceBlocked(
    () => db.prepare("UPDATE stores SET status = 'INACTIVE' WHERE id = 'st-thot-not'").run(),
    () => db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id = 'st-thot-not'").run(),
  );
});

test("employee creation becomes inert when its target store is deactivated after the pre-read", async () => {
  await seedActiveShift();
  await seedManagerSession();
  await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id = 'st-thot-not'").run();

  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await db.prepare("UPDATE stores SET status = 'INACTIVE' WHERE id = 'st-thot-not'").run();
    }
    return originalBatch(statements);
  };
  try {
    const created = await responseBody(await employeeRoute.POST(jsonRequest(
      "/api/employees",
      "POST",
      employeeCreateBody(),
      {},
      managerCookie,
    )));
    assert.equal(created.status, 409);
  } finally {
    db.batch = originalBatch;
  }

  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM employees WHERE code = 'ATOMIC-CREATE-01'").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'atomic-create-01'").first("count"), 0);
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'st-thot-not'").first("status"), "INACTIVE");
});

test("START snapshots the manager rate that committed before its atomic insert", async () => {
  const { preview } = await seedStartableEarlySchedule();
  await seedManagerSession();
  const originalBatch = db.batch.bind(db);
  let injected = false;
  const interceptStartBatch = async (statements) => {
    if (!injected) {
      injected = true;
      db.batch = originalBatch;
      const rateUpdate = await responseBody(await employeeRoute.PATCH(jsonRequest("/api/employees", "PATCH", employeePatchBody({
        hourlyRate: 49000,
      }), {}, managerCookie)));
      assert.equal(rateUpdate.status, 200);
      db.batch = interceptStartBatch;
    }
    return originalBatch(statements);
  };
  db.batch = interceptStartBatch;
  try {
    const started = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", {
      action: "start",
      expectedStart: preview,
      clockInLocation: {
        latitude: 10.045162,
        longitude: 105.746857,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
    })));
    assert.equal(started.status, 200);
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(await db.prepare("SELECT hourly_rate FROM employees WHERE id = 'employee-atomic'").first("hourly_rate"), 49000);
  assert.equal(await db.prepare("SELECT applied_hourly_rate FROM shift_sessions WHERE employee_id = 'employee-atomic' AND status = 'ACTIVE'").first("applied_hourly_rate"), 49000);
});

test("employee reassignment that commits before START makes the stale START inert", async () => {
  const { preview } = await seedStartableEarlySchedule();
  await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id = 'st-thot-not'").run();
  await seedManagerSession();
  const originalBatch = db.batch.bind(db);
  let injected = false;
  const interceptStartBatch = async (statements) => {
    if (!injected) {
      injected = true;
      db.batch = originalBatch;
      const reassignment = await responseBody(await employeeRoute.PATCH(jsonRequest("/api/employees", "PATCH", employeePatchBody({
        storeId: "st-thot-not",
      }), {}, managerCookie)));
      assert.equal(reassignment.status, 200);
      db.batch = interceptStartBatch;
    }
    return originalBatch(statements);
  };
  db.batch = interceptStartBatch;
  try {
    const staleStart = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", {
      action: "start",
      expectedStart: preview,
      clockInLocation: {
        latitude: 10.045162,
        longitude: 105.746857,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
    })));
    assert.equal(staleStart.status, 409);
  } finally {
    db.batch = originalBatch;
  }
  assert.deepEqual(
    { ...await db.prepare("SELECT e.store_id AS employeeStore, u.store_id AS userStore, u.shift_active AS shiftActive FROM employees e JOIN users u ON u.employee_id = e.id WHERE e.id = 'employee-atomic'").first() },
    { employeeStore: "st-thot-not", userStore: "st-thot-not", shiftActive: 0 },
  );
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'employee-atomic'").first("count"), 0);
});

test("store deactivation and START serialize without leaving an active shift in an inactive store", async () => {
  let seeded = await seedStartableEarlySchedule();
  await seedManagerSession();

  const originalBatch = db.batch.bind(db);
  let injected = false;
  const interceptStartBatch = async (statements) => {
    if (!injected) {
      injected = true;
      db.batch = originalBatch;
      const stopped = await responseBody(await storesRoute.PATCH(jsonRequest(
        "/api/stores",
        "PATCH",
        storePatchBody("st-can-tho", "INACTIVE"),
        {},
        managerCookie,
      )));
      assert.equal(stopped.status, 200);
      db.batch = interceptStartBatch;
    }
    return originalBatch(statements);
  };
  db.batch = interceptStartBatch;
  try {
    const staleStart = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", {
      action: "start",
      expectedStart: seeded.preview,
      clockInLocation: {
        latitude: 10.045162,
        longitude: 105.746857,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
    })));
    assert.equal(staleStart.status, 409);
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'st-can-tho'").first("status"), "INACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'employee-atomic'").first("count"), 0);
  assert.equal(await db.prepare("SELECT shift_active FROM users WHERE id = 'user-atomic'").first("shift_active"), 0);

  seeded = await seedStartableEarlySchedule();
  await seedManagerSession();
  const started = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", {
    action: "start",
    expectedStart: seeded.preview,
    clockInLocation: {
      latitude: 10.045162,
      longitude: 105.746857,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    },
  })));
  assert.equal(started.status, 200);

  const stoppedAfterStart = await responseBody(await storesRoute.PATCH(jsonRequest(
    "/api/stores",
    "PATCH",
    storePatchBody("st-can-tho", "INACTIVE"),
    {},
    managerCookie,
  )));
  assert.equal(stoppedAfterStart.status, 409);
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'st-can-tho'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'employee-atomic' AND status = 'ACTIVE'").first("count"), 1);
});

test("an active support shift blocks deactivating the employee home store", async () => {
  await seedActiveShift();
  await seedManagerSession();
  await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id IN ('st-can-tho', 'st-thot-not')").run();
  await db.prepare("UPDATE shift_sessions SET store_id = 'st-thot-not' WHERE id = 'session-atomic'").run();

  const stoppedHome = await responseBody(await storesRoute.PATCH(jsonRequest(
    "/api/stores",
    "PATCH",
    storePatchBody("st-can-tho", "INACTIVE"),
    {},
    managerCookie,
  )));
  assert.equal(stoppedHome.status, 409);
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'st-can-tho'").first("status"), "ACTIVE");
  assert.deepEqual(
    { ...await db.prepare("SELECT store_id AS storeId, status FROM shift_sessions WHERE id = 'session-atomic'").first() },
    { storeId: "st-thot-not", status: "ACTIVE" },
  );
});

test("a support START becomes inert when its home store is deactivated after authentication", async () => {
  const { preview } = await seedStartableSupportSchedule();

  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await db.prepare("UPDATE stores SET status = 'INACTIVE' WHERE id = 'st-can-tho'").run();
    }
    return originalBatch(statements);
  };
  try {
    const staleSupportStart = await responseBody(await shiftRoute.POST(jsonRequest("/api/shift", "POST", {
      action: "start",
      expectedStart: preview,
      clockInLocation: {
        latitude: 10.045162,
        longitude: 105.746857,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
    })));
    assert.equal(staleSupportStart.status, 409);
  } finally {
    db.batch = originalBatch;
  }

  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'st-can-tho'").first("status"), "INACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE employee_id = 'employee-atomic'").first("count"), 0);
  assert.equal(await db.prepare("SELECT shift_active FROM users WHERE id = 'user-atomic'").first("shift_active"), 0);
});

test("two concurrent early START requests create exactly one durable EARLY attendance session", async () => {
  const { preview } = await seedStartableEarlySchedule();

  const startRequest = () => shiftRoute.POST(jsonRequest("/api/shift", "POST", {
    action: "start",
    expectedStart: preview,
    clockInLocation: {
      latitude: 10.045162,
      longitude: 105.746857,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    },
  }));
  const requestWindowStart = Date.now();
  const responses = await Promise.all([startRequest(), startRequest()]);
  const requestWindowEnd = Date.now();
  const results = await Promise.all(responses.map(responseBody));
  assert.deepEqual(results.map((result) => result.status).sort((a, b) => a - b), [200, 409]);

  const sessions = await db.prepare(`SELECT started_at AS startedAt, scheduled_start_at AS scheduledStartAt,
      attendance_status AS attendanceStatus, attendance_delta_minutes AS attendanceDeltaMinutes
    FROM shift_sessions WHERE employee_id = 'employee-atomic' AND status = 'ACTIVE'`).all();
  assert.equal(sessions.results.length, 1);
  const session = sessions.results[0];
  assert.equal(session.attendanceStatus, "EARLY");
  assert.ok(Number(session.attendanceDeltaMinutes) < 0);
  const persistedStart = new Date(session.startedAt).getTime();
  assert.ok(persistedStart >= requestWindowStart && persistedStart <= requestWindowEnd);
  assert.ok(persistedStart < new Date(session.scheduledStartAt).getTime());
});
