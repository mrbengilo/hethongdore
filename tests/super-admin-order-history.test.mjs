import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-super-order-history-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, orders, history] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/orders/route.ts"),
  import("../app/api/admin/order-history/route.ts"),
]);

const db = await initDb();
const tokens = { manager: "order-history-manager-token", super: "order-history-super-token" };

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `dore_session=${encodeURIComponent(token)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function result(response) {
  return { response, status: response.status, body: await response.json() };
}

before(async () => {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES ('history-store', 'HISTORY STORE', 'A', 100000, 0, 'ACTIVE', ?),
             ('history-other', 'HISTORY OTHER', 'B', 50000, 0, 'ACTIVE', ?)`)
      .bind(now, now),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
      VALUES ('history-employee', 'history-store', 'HIS001', 'Nhân viên lịch sử', 'Bán hàng', '0900000301', 20000, 0, 'ACTIVE'),
             ('history-other-employee', 'history-other', 'HIS002', 'Nhân viên cửa hàng khác', 'Bán hàng', '0900000302', 20000, 0, 'ACTIVE')`),
    db.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, store_id, is_super_admin)
      VALUES ('history-manager', 'history-manager', 'unused', 'MANAGER', 'Quản lý sửa đơn', 'history-store', 0),
             ('history-super', 'history-super', 'unused', 'MANAGER', 'Quản trị cấp cao', NULL, 1)`),
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end,
         scheduled_start_at, scheduled_end_at, work_date, started_at, ended_at, duration_seconds,
         cash_revenue, transfer_revenue, close_status, status)
      VALUES ('history-shift', 'HISTORY-SHIFT', 'history-store', 'history-employee', 'Ca lịch sử', '08:00', '12:00',
              '2026-08-11T01:00:00.000Z', '2026-08-11T05:00:00.000Z', '2026-08-11',
              '2026-08-11T01:00:00.000Z', '2026-08-11T05:00:00.000Z', 14400, 100000, 0, 'CONFIRMED', 'COMPLETED')`),
    db.prepare(`INSERT INTO orders
        (id, code, store_id, employee_id, shift_code, customer_name, phone, age, amount, payment_method, status, created_at)
      VALUES ('history-order', 'HIS-00001', 'history-store', 'history-employee', 'HISTORY-SHIFT',
              'Khách ban đầu', '0909000001', 30, 100000, 'CASH', 'COMPLETED', '2026-08-11T02:00:00.000Z')`),
    db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ('history-manager-session', 'history-manager', ?, ?, ?),
             ('history-super-session', 'history-super', ?, ?, ?)`)
      .bind(
        await sha256(tokens.manager), Date.now() + 3_600_000, now,
        await sha256(tokens.super), Date.now() + 3_600_000, now,
      ),
  ]);
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("manager update and void history is visible only to superadmin, store-scoped and no-store", async () => {
  const updated = await result(await orders.PATCH(request("/api/orders", tokens.manager, "PATCH", {
    id: "history-order",
    storeId: "history-store",
    customerName: "Khách đã sửa",
    phone: "0911000001",
    age: 31,
    amount: 125000,
    paymentMethod: "BANK_TRANSFER",
  })));
  assert.equal(updated.status, 200);
  const removed = await result(await orders.DELETE(request("/api/orders?id=history-order&storeId=history-store", tokens.manager, "DELETE")));
  assert.equal(removed.status, 200);

  const denied = await result(await history.GET(request("/api/admin/order-history?storeId=history-store", tokens.manager)));
  assert.equal(denied.status, 403);

  const first = await result(await history.GET(request("/api/admin/order-history?storeId=history-store&page=1&pageSize=1", tokens.super)));
  assert.equal(first.status, 200);
  assert.match(first.response.headers.get("cache-control") ?? "", /private, no-store/u);
  assert.deepEqual(first.body.pagination, { page: 1, pageSize: 1, total: 2, pages: 2 });
  assert.equal(first.body.rows[0].orderCode, "HIS-00001");
  assert.equal(first.body.rows[0].action, "MANAGER_ORDER_VOID");
  assert.equal(first.body.rows[0].actorName, "Quản lý sửa đơn");
  assert.equal(first.body.rows[0].change.before.status, "COMPLETED");
  assert.equal(first.body.rows[0].change.after.status, "VOID");

  const updates = await result(await history.GET(request("/api/admin/order-history?storeId=history-store&action=UPDATE&search=Quản%20lý", tokens.super)));
  assert.equal(updates.status, 200);
  assert.equal(updates.body.pagination.total, 1);
  assert.equal(updates.body.rows[0].action, "MANAGER_ORDER_UPDATE");
  assert.deepEqual({
    customerName: updates.body.rows[0].change.before.customerName,
    amount: updates.body.rows[0].change.before.amount,
    paymentMethod: updates.body.rows[0].change.before.paymentMethod,
  }, { customerName: "Khách ban đầu", amount: 100000, paymentMethod: "CASH" });
  assert.deepEqual({
    customerName: updates.body.rows[0].change.after.customerName,
    amount: updates.body.rows[0].change.after.amount,
    paymentMethod: updates.body.rows[0].change.after.paymentMethod,
  }, { customerName: "Khách đã sửa", amount: 125000, paymentMethod: "BANK_TRANSFER" });

  const otherStore = await result(await history.GET(request("/api/admin/order-history?storeId=history-other", tokens.super)));
  assert.equal(otherStore.status, 200);
  assert.equal(otherStore.body.pagination.total, 0, "history from another store must never leak into this store");
});

test("superadmin history UI requests uncached data and renders actor plus before/after values", async () => {
  const [component, resetPage] = await Promise.all([
    readFile(new URL("../app/components/SuperAdminOrderHistory.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SuperAdminReset.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(component, /\/api\/admin\/order-history/u);
  assert.match(component, /cache: "no-store"/u);
  assert.match(component, /Người thực hiện/u);
  assert.match(component, /Thay đổi đã ghi nhận/u);
  assert.match(component, /row\.change\.before/u);
  assert.match(component, /row\.change\.after/u);
  assert.match(resetPage, /<SuperAdminOrderHistory store=\{store\}\/>/u);
});
