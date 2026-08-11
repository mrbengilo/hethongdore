import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-store-orders-manager-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, orderRoute, shiftRoute, storeCashflowRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/orders/route.ts"),
  import("../app/api/shift/route.ts"),
  import("../app/api/store-cashflow/route.ts"),
]);

let db;
const managerToken = "manager-orders-session";
const employeeToken = "employee-orders-session";
const managerCookie = `dore_session=${encodeURIComponent(managerToken)}`;
const employeeCookie = `dore_session=${encodeURIComponent(employeeToken)}`;

before(async () => {
  db = await initDb();
});

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

async function seedOrder({ completed = true, amount = 100_000, paymentMethod = "CASH" } = {}) {
  for (const table of ["sessions", "notifications", "orders", "audit_logs", "employee_payroll_closings", "business_records", "shift_sessions", "employees"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM users WHERE id IN ('manager-orders', 'employee-orders-user')").run();
  await db.prepare("UPDATE stores SET status = 'ACTIVE', revenue = ?, expense = 0 WHERE id = 'st-can-tho'")
    .bind(completed ? amount : 0).run();
  await db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
      VALUES ('employee-orders', 'st-can-tho', 'ORD001', 'Nguyễn Bán Hàng', 'Nhân viên bán hàng', '0900000001', 20000, 25000, 'ACTIVE')`).run();
  await db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, is_super_admin)
      VALUES ('manager-orders', 'manager-orders', 'unused', 'MANAGER', 'Quản lý Đơn hàng', 0)`).run();
  await db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id, shift_active, current_shift, shift_started_at)
      VALUES ('employee-orders-user', 'employee-orders-user', 'unused', 'EMPLOYEE', 'Nguyễn Bán Hàng', 'employee-orders', 'st-can-tho', ?, ?, ?)`)
    .bind(completed ? 0 : 1, completed ? null : "SHIFT-ORDERS", completed ? null : "2026-08-10T01:00:00.000Z").run();
  await db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end,
       scheduled_start_at, scheduled_end_at, work_date, applied_hourly_rate, applied_tiktok_allowance,
       started_at, ended_at, duration_seconds, cash_revenue, transfer_revenue, close_status, status)
      VALUES ('shift-orders', 'SHIFT-ORDERS', 'st-can-tho', 'employee-orders', 'Ca 1', '08:00', '12:00',
        '2026-08-10T01:00:00.000Z', '2026-08-10T05:00:00.000Z', '2026-08-10', 20000, 25000,
        '2026-08-10T01:00:00.000Z', ?, ?, ?, ?, ?, ?)`)
    .bind(
      completed ? "2026-08-10T05:00:00.000Z" : null,
      completed ? 14_400 : 0,
      completed && paymentMethod === "CASH" ? amount : 0,
      completed && paymentMethod === "BANK_TRANSFER" ? amount : 0,
      completed ? "CONFIRMED" : "OPEN",
      completed ? "COMPLETED" : "ACTIVE",
    ).run();
  await db.prepare(`INSERT INTO orders
      (id, code, store_id, employee_id, shift_code, customer_name, phone, age, amount, payment_method, status, created_at)
      VALUES ('order-manager', 'DH-MANAGER', 'st-can-tho', 'employee-orders', 'SHIFT-ORDERS', 'Khách cũ', '0909000000', 30, ?, ?, 'COMPLETED', '2026-08-10T02:00:00.000Z')`)
    .bind(amount, paymentMethod).run();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('manager-login', 'manager-orders', ?, ?, ?)")
    .bind(await sha256(managerToken), Date.now() + 3_600_000, new Date().toISOString()).run();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('employee-login', 'employee-orders-user', ?, ?, ?)")
    .bind(await sha256(employeeToken), Date.now() + 3_600_000, new Date().toISOString()).run();
}

function request(path, method = "GET", body, cookie = managerCookie) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function responseOf(response) {
  return { status: response.status, body: await response.json() };
}

test("manager order UI is wired to store/period filters, grouping, focus, edit, soft delete and mobile layout", async () => {
  const [component, portal, css] = await Promise.all([
    readFile(new URL("../app/components/StoreOrdersManagement.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreOrdersManagement.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /new URLSearchParams\(\{ storeId: store\.id, period \}\)/u);
  assert.match(component, /Theo ca/u);
  assert.match(component, /Theo nhân viên/u);
  assert.match(component, /createdByName/u);
  assert.match(component, /shiftName/u);
  assert.match(component, /lastUpdatedAt/u);
  assert.match(component, /method: "PATCH"/u);
  assert.match(component, /method: "DELETE"/u);
  assert.match(component, /scrollIntoView/u);
  assert.match(component, /periodOrders = orders\.filter/u);
  assert.match(portal, /<StoreOrdersManagement store=\{store\} period=\{period\} focusedOrderId=\{focusedOrderId\} focusRequestKey=\{focusedOrderRequest\} onChanged=\{onReload\}/u);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.table thead \{ display: none;/u);
});

function patchBody(amount, paymentMethod = "CASH") {
  return {
    id: "order-manager",
    storeId: "st-can-tho",
    customerName: "Khách mới",
    phone: "0911000000",
    age: 31,
    amount,
    paymentMethod,
  };
}

test("manager order list filters a store/period and returns complete creator, shift, time and lock metadata", async () => {
  await seedOrder();
  const response = await responseOf(await orderRoute.GET(request("/api/orders?storeId=st-can-tho&period=2026-08")));
  assert.equal(response.status, 200);
  assert.equal(response.body.orders.length, 1);
  assert.deepEqual({
    id: response.body.orders[0].id,
    employeeName: response.body.orders[0].employeeName,
    employeeCode: response.body.orders[0].employeeCode,
    shiftSessionId: response.body.orders[0].shiftSessionId,
    shiftName: response.body.orders[0].shiftName,
    workDate: response.body.orders[0].workDate,
    shiftStatus: response.body.orders[0].shiftStatus,
    period: response.body.orders[0].period,
    locked: response.body.orders[0].locked,
  }, {
    id: "order-manager",
    employeeName: "Nguyễn Bán Hàng",
    employeeCode: "ORD001",
    shiftSessionId: "shift-orders",
    shiftName: "Ca 1",
    workDate: "2026-08-10",
    shiftStatus: "COMPLETED",
    period: "2026-08",
    locked: 0,
  });
  const empty = await responseOf(await orderRoute.GET(request("/api/orders?storeId=st-can-tho&period=2026-07")));
  assert.equal(empty.body.orders.length, 0);

  await db.prepare(`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 500
    ) INSERT INTO orders
      (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
    SELECT 'order-bulk-' || value, printf('DH-BULK-%03d', value), 'st-can-tho', 'employee-orders', 'SHIFT-ORDERS',
      1000, 'CASH', 'COMPLETED', '2026-08-10T03:00:00.000Z' FROM sequence`).run();
  const completePeriod = await responseOf(await orderRoute.GET(request("/api/orders?storeId=st-can-tho&period=2026-08")));
  assert.equal(completePeriod.body.orders.length, 501, "a selected month must not silently truncate after 500 orders");
});

test("store cashflow API exposes daily/monthly/employee/shift revenue and monthly attendance from real rows", async () => {
  await seedOrder();
  const response = await responseOf(await storeCashflowRoute.GET(request("/api/store-cashflow?storeId=st-can-tho&mode=month&anchor=2026-08")));
  assert.equal(response.status, 200);
  assert.equal(response.body.totals.revenue, 100_000);
  assert.deepEqual(response.body.revenueBreakdowns.daily.map(({ date, revenue }) => ({ date, revenue })), [{ date: "2026-08-10", revenue: 100_000 }]);
  assert.deepEqual(response.body.revenueBreakdowns.monthly.map(({ period, revenue }) => ({ period, revenue })), [{ period: "2026-08", revenue: 100_000 }]);
  assert.deepEqual(response.body.revenueBreakdowns.employees.map(({ employeeCode, revenue }) => ({ employeeCode, revenue })), [{ employeeCode: "ORD001", revenue: 100_000 }]);
  assert.deepEqual(response.body.revenueBreakdowns.shifts.map(({ shiftName, revenue }) => ({ shiftName, revenue })), [{ shiftName: "Ca 1", revenue: 100_000 }]);
  assert.deepEqual(response.body.attendance.totals, { early: 0, onTime: 1, late: 0, unknown: 0, total: 1 });
  assert.equal(response.body.attendance.employees[0].averageDeltaMinutes, 0);
});

test("manager PATCH on a completed shift atomically refreshes order, shift tender, store revenue and audit", async () => {
  await seedOrder();
  const response = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(130_000, "BANK_TRANSFER"))));
  assert.equal(response.status, 200);
  assert.deepEqual({ ...await db.prepare("SELECT amount, payment_method AS paymentMethod, customer_name AS customerName FROM orders WHERE id = 'order-manager'").first() }, {
    amount: 130_000,
    paymentMethod: "BANK_TRANSFER",
    customerName: "Khách mới",
  });
  assert.deepEqual({ ...await db.prepare("SELECT cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue FROM shift_sessions WHERE id = 'shift-orders'").first() }, {
    cashRevenue: 0,
    transferRevenue: 130_000,
  });
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 130_000);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'order-manager' AND action = 'MANAGER_ORDER_UPDATE'").first("count"), 1);
});

test("manager DELETE is a reversible-history soft void and subtracts the completed shift once", async () => {
  await seedOrder();
  const response = await responseOf(await orderRoute.DELETE(request("/api/orders?id=order-manager&storeId=st-can-tho", "DELETE")));
  assert.equal(response.status, 200);
  assert.equal(await db.prepare("SELECT status FROM orders WHERE id = 'order-manager'").first("status"), "VOID");
  assert.deepEqual({ ...await db.prepare("SELECT cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue FROM shift_sessions WHERE id = 'shift-orders'").first() }, {
    cashRevenue: 0,
    transferRevenue: 0,
  });
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'order-manager'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'order-manager' AND action = 'MANAGER_ORDER_VOID'").first("count"), 1);
});

test("manager PATCH fails closed when a legacy store counter would become negative", async () => {
  await seedOrder();
  await db.prepare("UPDATE stores SET revenue = 25000 WHERE id = 'st-can-tho'").run();

  const response = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(50_000))));

  assert.equal(response.status, 409);
  assert.deepEqual(
    { ...await db.prepare("SELECT customer_name AS customerName, amount, payment_method AS paymentMethod, status FROM orders WHERE id = 'order-manager'").first() },
    { customerName: "Khách cũ", amount: 100_000, paymentMethod: "CASH", status: "COMPLETED" },
  );
  assert.deepEqual(
    { ...await db.prepare("SELECT cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue FROM shift_sessions WHERE id = 'shift-orders'").first() },
    { cashRevenue: 100_000, transferRevenue: 0 },
  );
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 25_000);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'order-manager'").first("count"), 0);
});

test("manager VOID fails closed when a legacy store counter would become negative", async () => {
  await seedOrder();
  await db.prepare("UPDATE stores SET revenue = 25000 WHERE id = 'st-can-tho'").run();

  const response = await responseOf(await orderRoute.DELETE(request("/api/orders?id=order-manager&storeId=st-can-tho", "DELETE")));

  assert.equal(response.status, 409);
  assert.equal(await db.prepare("SELECT status FROM orders WHERE id = 'order-manager'").first("status"), "COMPLETED");
  assert.deepEqual(
    { ...await db.prepare("SELECT cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue FROM shift_sessions WHERE id = 'shift-orders'").first() },
    { cashRevenue: 100_000, transferRevenue: 0 },
  );
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 25_000);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'order-manager'").first("count"), 0);
});

test("period locks reject manager order edits without changing historical values", async () => {
  await seedOrder();
  await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('locked-kpi', 'KPI_SUMMARY', 'st-can-tho', NULL, 'Kỳ đã khóa', '{"period":"2026-08"}', 'LOCKED', ?, ?)`)
    .bind(new Date().toISOString(), new Date().toISOString()).run();
  const response = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(140_000))));
  assert.equal(response.status, 409);
  assert.match(response.body.message, /khóa sổ|đã chốt/u);
  assert.equal(await db.prepare("SELECT amount FROM orders WHERE id = 'order-manager'").first("amount"), 100_000);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 100_000);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'order-manager'").first("count"), 0);
});

test("store-wide KPI/payroll lifecycles block every manager and employee order mutation atomically", async () => {
  await seedOrder({ completed: false });
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
    VALUES ('manager-finalized-payroll', 'PAYROLL_CLOSING', 'st-can-tho', NULL, 'Payroll', '{"period":"2026-08"}', 'MANAGER_FINALIZED', ?, ?)`)
    .bind(now, now).run();

  const managerPatch = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(140_000))));
  const managerDelete = await responseOf(await orderRoute.DELETE(request("/api/orders?id=order-manager&storeId=st-can-tho", "DELETE")));
  assert.equal(managerPatch.status, 409);
  assert.equal(managerDelete.status, 409);
  assert.deepEqual(
    { ...await db.prepare("SELECT amount, status FROM orders WHERE id = 'order-manager'").first() },
    { amount: 100_000, status: "COMPLETED" },
  );

  await db.prepare("DELETE FROM business_records WHERE id = 'manager-finalized-payroll'").run();
  await db.prepare(`INSERT INTO employee_payroll_closings
      (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
    VALUES ('other-employee-closing', 'st-can-tho', 'different-employee', '2026-08', '{}', 'ACTIVE', 'CLOSING', ?, 'manager-orders')`)
    .bind(now).run();

  const employeePatch = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", {
    id: "order-manager",
    customerName: "Không được sửa",
    amount: 110_000,
    paymentMethod: "CASH",
  }, employeeCookie)));
  const employeeDelete = await responseOf(await orderRoute.DELETE(request("/api/orders?id=order-manager", "DELETE", undefined, employeeCookie)));
  const employeeCreate = await responseOf(await orderRoute.POST(request("/api/orders", "POST", {
    customerName: "Không được tạo",
    amount: 50_000,
    paymentMethod: "CASH",
    clientRequestId: "locked-order-create-0001",
  }, employeeCookie)));
  assert.equal(employeePatch.status, 403);
  assert.equal(employeeDelete.status, 403);
  assert.equal(employeeCreate.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE client_request_id = 'locked-order-create-0001'").first("count"), 0);
  assert.deepEqual(
    { ...await db.prepare("SELECT customer_name AS customerName, amount, status FROM orders WHERE id = 'order-manager'").first() },
    { customerName: "Khách cũ", amount: 100_000, status: "COMPLETED" },
  );
});

test("same-order optimistic gate makes a stale manager request inert after a rival manager update", async () => {
  await seedOrder();
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      const rival = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(120_000))));
      assert.equal(rival.status, 200);
    }
    return originalBatch(statements);
  };
  try {
    const stale = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(150_000))));
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /yêu cầu khác|tải lại/u);
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(await db.prepare("SELECT amount FROM orders WHERE id = 'order-manager'").first("amount"), 120_000);
  assert.equal(await db.prepare("SELECT cash_revenue FROM shift_sessions WHERE id = 'shift-orders'").first("cash_revenue"), 120_000);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 120_000);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = 'order-manager'").first("count"), 1);
});

test("stale manager DELETE cannot void an order after a rival edit wins", async () => {
  await seedOrder();
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      const rival = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(125_000))));
      assert.equal(rival.status, 200);
    }
    return originalBatch(statements);
  };
  try {
    const staleDelete = await responseOf(await orderRoute.DELETE(request("/api/orders?id=order-manager&storeId=st-can-tho", "DELETE")));
    assert.equal(staleDelete.status, 409);
  } finally {
    db.batch = originalBatch;
  }
  assert.deepEqual({ ...await db.prepare("SELECT amount, status FROM orders WHERE id = 'order-manager'").first() }, { amount: 125_000, status: "COMPLETED" });
  assert.equal(await db.prepare("SELECT cash_revenue FROM shift_sessions WHERE id = 'shift-orders'").first("cash_revenue"), 125_000);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 125_000);
});

test("manager edit on an active shift stays unrecognized until END snapshots the updated order", async () => {
  await seedOrder({ completed: false });
  const updated = await responseOf(await orderRoute.PATCH(request("/api/orders", "PATCH", patchBody(135_000))));
  assert.equal(updated.status, 200);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 0);
  assert.equal(await db.prepare("SELECT cash_revenue FROM shift_sessions WHERE id = 'shift-orders'").first("cash_revenue"), 0);

  const closed = await responseOf(await shiftRoute.POST(request("/api/shift", "POST", {
    action: "end",
    tasksCompleted: true,
    expenseAmount: 0,
    expenseNote: "",
    cashRevenue: 135_000,
    transferRevenue: 0,
    earlyEndConfirmed: true,
    tiktok: false,
  }, employeeCookie)));
  assert.equal(closed.status, 200);
  assert.equal(await db.prepare("SELECT cash_revenue FROM shift_sessions WHERE id = 'shift-orders'").first("cash_revenue"), 135_000);
  assert.equal(await db.prepare("SELECT revenue FROM stores WHERE id = 'st-can-tho'").first("revenue"), 135_000);
});
