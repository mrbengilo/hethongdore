import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function legacyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL,
      employee_id TEXT NOT NULL, shift_code TEXT NOT NULL, customer_name TEXT, phone TEXT, age INTEGER,
      amount INTEGER NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL);
    INSERT INTO stores VALUES ('store-a', 'DORE A'), ('store-b', 'DORE B');
    INSERT INTO employees VALUES ('employee-a', 'Nhân viên A');
    INSERT INTO users VALUES ('manager-a', 'MANAGER'), ('manager-b', 'MANAGER'), ('employee-user', 'EMPLOYEE');
    INSERT INTO orders (id, code, store_id, employee_id, shift_code, amount, payment_method, created_at)
      VALUES ('legacy-order', 'DH00001', 'store-a', 'employee-a', 'SHIFT-1', 100000, 'CASH', '2026-08-01T00:00:00.000Z');
  `);
  db.exec(await readFile(new URL("../drizzle/0010_order_notifications.sql", import.meta.url), "utf8"));
  return db;
}

function createOrder(db, { id, code, requestId, fingerprint, storeId = "store-a" }) {
  const existing = db.prepare("SELECT id, code, client_request_fingerprint AS fingerprint FROM orders WHERE employee_id = ? AND client_request_id = ? LIMIT 1").get("employee-a", requestId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error("REQUEST_KEY_MISMATCH");
    return { id: existing.id, code: existing.code, replayed: true };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO orders (id, code, store_id, employee_id, shift_code, amount, payment_method, status, client_request_id, client_request_fingerprint, created_at)
      VALUES (?, ?, ?, 'employee-a', 'SHIFT-1', 150000, 'CASH', 'COMPLETED', ?, ?, '2026-08-09T00:00:00.000Z')`).run(id, code, storeId, requestId, fingerprint);
    db.prepare(`INSERT INTO notifications (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, read_at, created_at)
      SELECT 'new-order:' || ? || ':' || u.id, u.id, ?, 'NEW_ORDER', 'ORDER', ?, ?, ?, '{}', NULL, '2026-08-09T00:00:00.000Z'
      FROM users u WHERE u.role = 'MANAGER'
      ON CONFLICT(recipient_user_id, type, entity_id) DO NOTHING`).run(id, storeId, id, `Đơn hàng mới ${code}`, `Đơn ${code}`);
    db.exec("COMMIT");
    return { id, code, replayed: false };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("0010 preserves legacy orders and adds nullable idempotency metadata", async () => {
  const db = await legacyDatabase();
  const legacy = db.prepare("SELECT id, code, amount, client_request_id AS requestId, client_request_fingerprint AS fingerprint FROM orders WHERE id = 'legacy-order'").get();
  assert.deepEqual({ ...legacy }, { id: "legacy-order", code: "DH00001", amount: 100000, requestId: null, fingerprint: null });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 0);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("order and per-manager notifications are atomic and exact retry is idempotent", async () => {
  const db = await legacyDatabase();
  assert.equal(createOrder(db, { id: "order-new", code: "DHABC123", requestId: "request-0001", fingerprint: "fingerprint-a" }).replayed, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE entity_id = 'order-new'").get().count, 2);
  assert.deepEqual(createOrder(db, { id: "ignored", code: "IGNORED", requestId: "request-0001", fingerprint: "fingerprint-a" }), { id: "order-new", code: "DHABC123", replayed: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE client_request_id = 'request-0001'").get().count, 1);
  assert.throws(() => createOrder(db, { id: "other", code: "OTHER", requestId: "request-0001", fingerprint: "changed" }), /REQUEST_KEY_MISMATCH/u);

  db.exec(`CREATE TRIGGER fail_notification BEFORE INSERT ON notifications WHEN NEW.entity_id = 'order-fail'
    BEGIN SELECT RAISE(ABORT, 'forced notification failure'); END;`);
  assert.throws(() => createOrder(db, { id: "order-fail", code: "DHFAIL", requestId: "request-fail", fingerprint: "fail" }), /forced notification failure/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'order-fail'").get().count, 0);
});

test("unread state is durable per manager, idempotent and store scoped", async () => {
  const db = await legacyDatabase();
  createOrder(db, { id: "order-a", code: "DHA", requestId: "request-a", fingerprint: "a", storeId: "store-a" });
  createOrder(db, { id: "order-b", code: "DHB", requestId: "request-b", fingerprint: "b", storeId: "store-b" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = 'manager-a' AND store_id = 'store-a' AND read_at IS NULL").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = 'manager-a' AND read_at IS NULL").get().count, 2);
  db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE recipient_user_id = ? AND entity_id = ?").run("2026-08-09T01:00:00.000Z", "manager-a", "order-a");
  db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE recipient_user_id = ? AND entity_id = ?").run("2026-08-09T02:00:00.000Z", "manager-a", "order-a");
  assert.equal(db.prepare("SELECT read_at AS readAt FROM notifications WHERE recipient_user_id = 'manager-a' AND entity_id = 'order-a'").get().readAt, "2026-08-09T01:00:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = 'manager-a' AND read_at IS NULL").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = 'manager-b' AND read_at IS NULL").get().count, 2);
  assert.deepEqual(db.prepare("SELECT entity_id AS entityId FROM notifications WHERE recipient_user_id = 'manager-a' AND read_at IS NULL ORDER BY entity_id").all().map((row) => row.entityId), ["order-b"]);
});

test("API and UI contracts cover auth, stable request key, store scope and exact focus", async () => {
  const [orders, notifications, portal, storeOrders, storeOrdersStyles, runtime, reset] = await Promise.all([
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreOrdersManagement.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreOrdersManagement.module.css", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../ops/scripts/reset-operational-data.sh", import.meta.url), "utf8"),
  ]);
  assert.match(orders, /Idempotency-Key/u);
  assert.match(orders, /await db\.batch\(\[/u);
  assert.match(orders, /INSERT INTO notifications/u);
  assert.match(orders, /JOIN shift_sessions active_shift/u);
  assert.match(orders, /orderInsert\.meta\.changes/u);
  assert.match(notifications, /user\?\.role === "MANAGER"/u);
  assert.match(notifications, /storeClause/u);
  assert.match(notifications, /recipient_user_id = \?/u);
  assert.match(notifications, /WHERE n\.recipient_user_id = \? AND n\.read_at IS NULL/u);
  assert.match(notifications, /const \[items, count\] = await db\.batch/u);
  assert.match(notifications, /SET read_at = COALESCE\(read_at, \?\)/u);
  assert.match(notifications, /unreadCount: Number\(countRow\?\.count \?\? 0\)/u);
  assert.match(portal, /clientRequestId.*crypto\.randomUUID\(\)/u);
  assert.match(portal, /setStoreView\("Đơn hàng"\)/u);
  assert.match(portal, /setSelectedStoreId\(notification\.storeId\)/u);
  assert.match(portal, /setFocusedOrderId\(notification\.entityId\)/u);
  assert.match(portal, /setFocusedOrderRequest\(\(current\) => current \+ 1\)/u);
  assert.match(portal, /focusedOrderRequest=\{focusedOrderRequest\}/u);
  assert.match(portal, /notificationRequest\.current \+= 1/u);
  assert.match(portal, /setNotifications\(\(current\) => current\.filter\(\(item\) => item\.id !== notification\.id\)\)/u);
  assert.match(portal, /const loadNotificationsForStore = useCallback\(async \(scopeStoreId: string \| null\)/u);
  assert.match(portal, /JSON\.stringify\(\{ id: notification\.id, \.\.\.\(nextNotificationScope \? \{ storeId: nextNotificationScope \} : \{\}\) \}\)/u);
  assert.ok((portal.match(/loadNotificationsForStore\(nextNotificationScope\)/gu) ?? []).length >= 2);
  assert.match(storeOrders, /if \(focusedOrderId\) query\.set\("orderId", focusedOrderId\)/u);
  assert.match(storeOrders, /if \(!focusedOrderId\) return;[\s\S]*?setSearch\(""\);[\s\S]*?setEmployeeId\("ALL"\);[\s\S]*?setShiftId\("ALL"\);[\s\S]*?setStatus\("ALL"\);/u);
  assert.match(storeOrders, /focusedOnce\.current === focusRequestKey/u);
  assert.match(storeOrders, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*?document\.getElementById\(`store-order-\$\{focusedOrderId\}`\)/u);
  assert.match(storeOrders, /document\.getElementById\(`store-order-\$\{focusedOrderId\}`\)/u);
  assert.match(storeOrders, /target\.scrollIntoView/u);
  assert.match(storeOrders, /target\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(storeOrders, /window\.cancelAnimationFrame\(frame\)/u);
  assert.match(storeOrders, /className=\{focusedOrderId === order\.id \? styles\.highlight : undefined\}/u);
  assert.match(storeOrdersStyles, /\.highlight\s*\{/u);
  assert.doesNotMatch(runtime, /DELETE FROM notifications/u);
  assert.match(reset, /DELETE FROM notifications;/u);
});
