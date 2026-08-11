import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-manager-store-scope-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, employees, orders, records, payroll, stores, shifts, cashflow, reports, storeCashflow, transfers, notifications] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/employees/route.ts"),
  import("../app/api/orders/route.ts"),
  import("../app/api/records/route.ts"),
  import("../app/api/payroll/route.ts"),
  import("../app/api/stores/route.ts"),
  import("../app/api/shifts/route.ts"),
  import("../app/api/cashflow/route.ts"),
  import("../app/api/reports/route.ts"),
  import("../app/api/store-cashflow/route.ts"),
  import("../app/api/transfers/route.ts"),
  import("../app/api/notifications/route.ts"),
]);

const db = await runtime.initDb();
const tokens = {
  scoped: "manager-scope-scoped-token",
  global: "manager-scope-global-token",
  super: "manager-scope-super-token",
  employeeA: "manager-scope-employee-a-token",
};

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `dore_session=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function jsonBody(response) {
  return { status: response.status, body: await response.json() };
}

before(async () => {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES ('scope-store-a', 'SCOPE STORE A', 'A', 0, 0, 'ACTIVE', ?),
             ('scope-store-b', 'SCOPE STORE B', 'B', 0, 0, 'ACTIVE', ?)`)
      .bind(now, now),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
         cccd_image_key, hourly_rate, tiktok_allowance, status)
      VALUES ('scope-employee-a', 'scope-store-a', 'SCOPE-A', 'Nhân viên A', 'Bán hàng', '0900000101', 'A', 'A', 'A', 25,
               'cccd/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg', 20000, 0, 'ACTIVE'),
             ('scope-employee-b', 'scope-store-b', 'SCOPE-B', 'Nhân viên B', 'Bán hàng', '0900000102', 'B', 'B', 'B', 25,
               'cccd/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg', 20000, 0, 'ACTIVE')`),
    db.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
      VALUES ('scope-manager-a', 'scope-manager-a', 'unused', 'MANAGER', 'Manager A', NULL, 'scope-store-a', 0),
             ('scope-manager-global', 'scope-manager-global', 'unused', 'MANAGER', 'Manager Global', NULL, NULL, 0),
             ('scope-manager-super', 'scope-manager-super', 'unused', 'MANAGER', 'Manager Super', NULL, 'scope-store-a', 1),
             ('scope-user-a', 'scope-user-a', 'unused', 'EMPLOYEE', 'Nhân viên A', 'scope-employee-a', 'scope-store-a', 0)`),
    db.prepare("UPDATE users SET shift_active = 1, current_shift = 'SCOPE-SHIFT-A', shift_started_at = ? WHERE id = 'scope-user-a'")
      .bind(now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('scope-record-a', 'TASKS', 'scope-store-a', 'scope-manager-a', 'A', '{"items":[]}', 'ACTIVE', ?, ?),
             ('scope-record-b', 'TASKS', 'scope-store-b', 'scope-manager-global', 'B', '{"items":[]}', 'ACTIVE', ?, ?)`)
      .bind(now, now, now, now),
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, started_at, close_status, status)
      VALUES ('scope-shift-a', 'SCOPE-SHIFT-A', 'scope-store-a', 'scope-employee-a', 'Ca 1', ?, 'OPEN', 'ACTIVE'),
             ('scope-shift-b', 'SCOPE-SHIFT-B', 'scope-store-b', 'scope-employee-b', 'Ca 1', ?, 'OPEN', 'ACTIVE')`)
      .bind(now, now),
    db.prepare(`INSERT INTO orders
        (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
      VALUES ('scope-order-a', 'DH88001', 'scope-store-a', 'scope-employee-a', 'SCOPE-SHIFT-A', 10000, 'CASH', 'COMPLETED', ?),
             ('scope-order-b', 'DH88002', 'scope-store-b', 'scope-employee-b', 'SCOPE-SHIFT-B', 20000, 'CASH', 'COMPLETED', ?)`)
      .bind(now, now),
    db.prepare(`INSERT INTO notifications
        (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, created_at)
      VALUES ('scope-notice-a', 'scope-manager-a', 'scope-store-a', 'TEST', 'ORDER', 'scope-order-a', 'A', 'A', '{}', ?),
             ('scope-notice-b', 'scope-manager-a', 'scope-store-b', 'TEST', 'ORDER', 'scope-order-b', 'B', 'B', '{}', ?)`)
      .bind(now, now),
    db.prepare(`INSERT INTO employee_transfers
        (id, employee_id, source_store_id, target_store_id, start_date, end_date,
         shifts_json, support_hourly_rate, support_allowance, reason, status,
         created_by, created_at, updated_at)
      VALUES ('scope-transfer-a', 'scope-employee-a', 'scope-store-a', 'scope-store-b', '2099-01-01', '2099-01-31', '["Ca sáng"]', 20000, 0, 'A sang B', 'SCHEDULED', 'scope-manager-global', ?, ?),
             ('scope-transfer-b', 'scope-employee-b', 'scope-store-b', 'scope-store-a', '2099-02-01', '2099-02-28', '["Ca sáng"]', 20000, 0, 'B sang A', 'SCHEDULED', 'scope-manager-global', ?, ?)`)
      .bind(now, now, now, now),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('scope-session-a', 'scope-manager-a', ?, ?, ?),
           ('scope-session-global', 'scope-manager-global', ?, ?, ?),
           ('scope-session-super', 'scope-manager-super', ?, ?, ?),
           ('scope-session-employee-a', 'scope-user-a', ?, ?, ?)`)
    .bind(
      await auth.sha256(tokens.scoped), Date.now() + 300_000, now,
      await auth.sha256(tokens.global), Date.now() + 300_000, now,
      await auth.sha256(tokens.super), Date.now() + 300_000, now,
      await auth.sha256(tokens.employeeA), Date.now() + 300_000, now,
    ).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("scoped manager cross-store reads are denied across the manager route matrix", async () => {
  const crossReads = [
    ["employees", () => employees.GET(request("/api/employees?storeId=scope-store-b", tokens.scoped))],
    ["orders", () => orders.GET(request("/api/orders?storeId=scope-store-b", tokens.scoped))],
    ["records", () => records.GET(request("/api/records?category=TASKS&storeId=scope-store-b", tokens.scoped))],
    ["payroll", () => payroll.GET(request("/api/payroll?period=2026-08&storeId=scope-store-b", tokens.scoped))],
    ["shifts", () => shifts.GET(request("/api/shifts?storeId=scope-store-b", tokens.scoped))],
    ["cashflow", () => cashflow.GET(request("/api/cashflow?period=2026-08&granularity=day&from=2026-08-01&to=2026-08-10&storeId=scope-store-b", tokens.scoped))],
    ["reports", () => reports.GET(request("/api/reports?period=2026-08&granularity=day&from=2026-08-01&to=2026-08-10&storeId=scope-store-b", tokens.scoped))],
    ["store-cashflow", () => storeCashflow.GET(request("/api/store-cashflow?mode=month&anchor=2026-08&storeId=scope-store-b", tokens.scoped))],
    ["notifications", () => notifications.GET(request("/api/notifications?storeId=scope-store-b", tokens.scoped))],
  ];
  for (const [name, call] of crossReads) {
    const response = await call();
    assert.equal(response.status, 403, `${name} must reject an explicit foreign store`);
  }
});

test("omitted storeId defaults to the scoped manager home store while global roles retain cross-store reads", async () => {
  const employeeDefault = await jsonBody(await employees.GET(request("/api/employees", tokens.scoped)));
  assert.equal(employeeDefault.status, 200);
  assert.deepEqual(employeeDefault.body.employees.map((row) => row.id), ["scope-employee-a"]);

  const orderDefault = await jsonBody(await orders.GET(request("/api/orders", tokens.scoped)));
  assert.equal(orderDefault.status, 200);
  assert.deepEqual(orderDefault.body.orders.map((row) => row.id), ["scope-order-a"]);

  const recordDefault = await jsonBody(await records.GET(request("/api/records?category=TASKS", tokens.scoped)));
  assert.equal(recordDefault.status, 200);
  assert.deepEqual(recordDefault.body.records.map((row) => row.id), ["scope-record-a"]);

  const shiftDefault = await jsonBody(await shifts.GET(request("/api/shifts", tokens.scoped)));
  assert.equal(shiftDefault.status, 200);
  assert.deepEqual(shiftDefault.body.shifts.map((row) => row.id), ["scope-shift-a"]);

  const noticeDefault = await jsonBody(await notifications.GET(request("/api/notifications", tokens.scoped)));
  assert.equal(noticeDefault.status, 200);
  assert.deepEqual(noticeDefault.body.notifications.map((row) => row.id), ["scope-notice-a"]);

  const storeDefault = await jsonBody(await stores.GET(request("/api/stores?period=2026-08", tokens.scoped)));
  assert.equal(storeDefault.status, 200);
  assert.deepEqual(storeDefault.body.stores.map((row) => row.id), ["scope-store-a"]);

  const transferDefault = await jsonBody(await transfers.GET(request("/api/transfers", tokens.scoped)));
  assert.equal(transferDefault.status, 200);
  assert.deepEqual(transferDefault.body.transfers.map((row) => row.id), ["scope-transfer-a"]);

  const reportDefault = await jsonBody(await reports.GET(request(
    "/api/reports?period=2026-08&granularity=day&from=2026-08-01&to=2026-08-10",
    tokens.scoped,
  )));
  assert.equal(reportDefault.status, 200);
  assert.deepEqual(reportDefault.body.storeOptions.map((row) => row.id), ["scope-store-a"]);
  assert.deepEqual(reportDefault.body.profitSharingHistory, [], "scoped report must not expose global DIVIDEND history");
  assert.deepEqual(reportDefault.body.profitSharingMembers, [], "scoped report must not expose global profit-sharing identities");
  assert.equal(reportDefault.body.profitSharingPreview, null);

  for (const token of [tokens.global, tokens.super]) {
    assert.equal((await employees.GET(request("/api/employees?storeId=scope-store-b", token))).status, 200);
    assert.equal((await orders.GET(request("/api/orders?storeId=scope-store-b", token))).status, 200);
    assert.equal((await records.GET(request("/api/records?category=TASKS&storeId=scope-store-b", token))).status, 200);
  }
});

test("scoped manager cross-store and global-only writes are denied before mutation", async () => {
  const attempts = [
    ["employee create", employees.POST(request("/api/employees", tokens.scoped, "POST", { storeId: "scope-store-b" }))],
    ["record create", records.POST(request("/api/records", tokens.scoped, "POST", { category: "TASKS", storeId: "scope-store-b", title: "Denied", data: { items: [] } }))],
    ["record update", records.PATCH(request("/api/records", tokens.scoped, "PATCH", { id: "scope-record-b", title: "Denied", data: { items: [] } }))],
    ["record delete", records.DELETE(request("/api/records?id=scope-record-b", tokens.scoped, "DELETE"))],
    ["payroll", payroll.POST(request("/api/payroll", tokens.scoped, "POST", { storeId: "scope-store-b", period: "2026-08", action: "FINALIZE_EMPLOYEE" }))],
    ["order update", orders.PATCH(request("/api/orders", tokens.scoped, "PATCH", { id: "scope-order-b", storeId: "scope-store-b", amount: 21000, paymentMethod: "CASH" }))],
    ["order delete", orders.DELETE(request("/api/orders?id=scope-order-b&storeId=scope-store-b", tokens.scoped, "DELETE"))],
    ["store create", stores.POST(request("/api/stores", tokens.scoped, "POST", { name: "DENIED", address: "DENIED" }))],
    ["store update", stores.PATCH(request("/api/stores", tokens.scoped, "PATCH", { id: "scope-store-b", name: "DENIED", address: "B", status: "ACTIVE" }))],
    ["profit sharing", reports.POST(request("/api/reports", tokens.scoped, "POST", { action: "CLOSE_PROFIT_SHARING", period: "2026-07" }))],
    ["notification", notifications.PATCH(request("/api/notifications", tokens.scoped, "PATCH", { id: "scope-notice-b" }))],
    ["transfer update", transfers.PATCH(request("/api/transfers", tokens.scoped, "PATCH", { id: "scope-transfer-b", action: "CANCEL" }))],
    ["transfer create", transfers.POST(request("/api/transfers", tokens.scoped, "POST", {
      employeeId: "scope-employee-b", targetStoreId: "scope-store-a", startDate: "2099-03-01", endDate: "2099-03-31",
      shifts: ["Ca sáng"], supportHourlyRate: 20000, supportAllowance: 0, reason: "Denied cross-store transfer",
    }))],
  ];
  for (const [name, pending] of attempts) {
    const response = await pending;
    assert.equal(response.status, 403, `${name} must be denied`);
  }

  assert.equal(await db.prepare("SELECT title FROM business_records WHERE id = 'scope-record-b'").first("title"), "B");
  assert.equal(await db.prepare("SELECT read_at FROM notifications WHERE id = 'scope-notice-b'").first("read_at"), null);
  assert.equal(await db.prepare("SELECT status FROM employee_transfers WHERE id = 'scope-transfer-b'").first("status"), "SCHEDULED");
  assert.equal(await db.prepare("SELECT name FROM stores WHERE id = 'scope-store-b'").first("name"), "SCOPE STORE B");
});

test("unsafe VND inputs and unsafe order aggregates are rejected without partial mutation", async () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const orderCountBefore = await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count");
  const sequenceBefore = await db.prepare("SELECT last_value AS lastValue FROM order_code_sequence WHERE id = 1").first("lastValue");
  const unsafeCreate = await orders.POST(request("/api/orders", tokens.employeeA, "POST", {
    amount: unsafe,
    paymentMethod: "CASH",
    clientRequestId: "scope-unsafe-order-create",
  }));
  assert.equal(unsafeCreate.status, 400);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), orderCountBefore);
  assert.equal(await db.prepare("SELECT last_value AS lastValue FROM order_code_sequence WHERE id = 1").first("lastValue"), sequenceBefore);

  const unsafeEdit = await orders.PATCH(request("/api/orders", tokens.scoped, "PATCH", {
    id: "scope-order-a", storeId: "scope-store-a", amount: unsafe, paymentMethod: "CASH",
  }));
  assert.equal(unsafeEdit.status, 400);
  assert.equal(await db.prepare("SELECT amount FROM orders WHERE id = 'scope-order-a'").first("amount"), 10000);

  const profile = {
    id: "scope-employee-a", storeId: "scope-store-a", code: "SCOPE-A", name: "Nhân viên A",
    position: "Bán hàng", phone: "0900000101", province: "A", ward: "A", addressLine: "A", age: 25,
    cccdImageKey: "cccd/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg", cccdImageName: "a.jpg", expectedVersion: 0,
  };
  assert.equal((await employees.PATCH(request("/api/employees", tokens.scoped, "PATCH", {
    ...profile, hourlyRate: unsafe,
  }))).status, 400);
  assert.equal((await employees.PATCH(request("/api/employees", tokens.scoped, "PATCH", {
    ...profile, hourlyRate: 20000, tiktokAllowance: unsafe,
  }))).status, 400);
  assert.deepEqual({ ...await db.prepare("SELECT hourly_rate AS hourlyRate, tiktok_allowance AS tiktokAllowance FROM employees WHERE id = 'scope-employee-a'").first() }, {
    hourlyRate: 20000,
    tiktokAllowance: 0,
  });

  const transferCountBefore = await db.prepare("SELECT COUNT(*) AS count FROM employee_transfers").first("count");
  for (const [field, value] of [["supportHourlyRate", unsafe], ["supportAllowance", unsafe]]) {
    const transferResponse = await transfers.POST(request("/api/transfers", tokens.global, "POST", {
      employeeId: "scope-employee-a", targetStoreId: "scope-store-b",
      startDate: "2099-04-01", endDate: "2099-04-30", shifts: ["Ca sáng"],
      supportHourlyRate: 20000, supportAllowance: 0, reason: "Unsafe amount must not persist",
      [field]: value,
    }));
    assert.equal(transferResponse.status, 400, `${field} must reject unsafe integers`);
  }
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM employee_transfers").first("count"), transferCountBefore);

  await db.prepare(`INSERT INTO orders
      (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
    VALUES ('scope-order-a2', 'DH88003', 'scope-store-a', 'scope-employee-a', 'SCOPE-SHIFT-A', 1, 'CASH', 'COMPLETED', ?)`)
    .bind(new Date().toISOString()).run();
  const aggregateEdit = await orders.PATCH(request("/api/orders", tokens.scoped, "PATCH", {
    id: "scope-order-a", storeId: "scope-store-a", amount: Number.MAX_SAFE_INTEGER, paymentMethod: "CASH",
  }));
  assert.equal(aggregateEdit.status, 409, "a safe individual value must still be rejected when its shift aggregate becomes unsafe");
  assert.equal(await db.prepare("SELECT amount FROM orders WHERE id = 'scope-order-a'").first("amount"), 10000);
  await db.prepare("DELETE FROM orders WHERE id = 'scope-order-a2'").run();

  await db.prepare("UPDATE orders SET amount = ? WHERE id = 'scope-order-a'")
    .bind(Number.MAX_SAFE_INTEGER).run();
  const aggregateCreate = await orders.POST(request("/api/orders", tokens.employeeA, "POST", {
    amount: 1,
    paymentMethod: "CASH",
    clientRequestId: "scope-order-aggregate-overflow",
  }));
  assert.equal(aggregateCreate.status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders").first("count"), orderCountBefore);
  assert.equal(await db.prepare("SELECT last_value AS lastValue FROM order_code_sequence WHERE id = 1").first("lastValue"), sequenceBefore);
  await db.prepare("UPDATE orders SET amount = 10000 WHERE id = 'scope-order-a'").run();
});

test("all manager store routes declare centralized scope enforcement", async () => {
  const contracts = new Map([
    ["employees", ["resolveManagerStoreScope", "managerCanAccessStore"]],
    ["orders", ["resolveManagerStoreScope", "managerCanAccessStore"]],
    ["records", ["resolveManagerStoreScope", "managerCanAccessStore"]],
    ["payroll", ["resolveManagerStoreScope", "managerCanAccessStore"]],
    ["stores", ["managerHasGlobalStoreAccess", "managerCanAccessStore"]],
    ["shifts", ["resolveManagerStoreScope"]],
    ["cashflow", ["resolveManagerStoreScope"]],
    ["reports", ["resolveManagerStoreScope", "managerHasGlobalStoreAccess"]],
    ["store-cashflow", ["resolveManagerStoreScope"]],
    ["transfers", ["managerCanAccessStore", "managerHasGlobalStoreAccess"]],
    ["notifications", ["resolveManagerStoreScope", "managerCanAccessStore"]],
    ["uploads", ["managerHasGlobalStoreAccess", "status != 'ARCHIVED'", "deleted_at IS NULL"]],
  ]);
  for (const [route, markers] of contracts) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    for (const marker of markers) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `${route} missing ${marker}`);
  }
});
