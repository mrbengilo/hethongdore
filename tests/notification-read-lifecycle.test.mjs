import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-notification-read-"));
const databasePath = join(directory, "dore.sqlite");

process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = databasePath;
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, notificationRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/notifications/route.ts"),
]);

let db;
const managers = {
  ct: { id: "notice-manager-ct", storeId: "st-can-tho", token: "notice-manager-token-ct", superAdmin: 0 },
  tn: { id: "notice-manager-tn", storeId: "st-thot-not", token: "notice-manager-token-tn", superAdmin: 0 },
  global: { id: "notice-manager-global", storeId: null, token: "notice-manager-token-global", superAdmin: 1 },
};

before(async () => {
  db = await initDb();
  const now = new Date().toISOString();
  for (const [key, manager] of Object.entries(managers)) {
    await db.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
        VALUES (?, ?, 'unused', 'MANAGER', ?, NULL, ?, ?)`)
      .bind(manager.id, manager.id, `Quản lý ${key}`, manager.storeId, manager.superAdmin).run();
    await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`notice-session-${key}`, manager.id, await sha256(manager.token), Date.now() + 3_600_000, now).run();
  }

  const notifications = [
    ["ct-1", managers.ct.id, "st-can-tho", null, "2026-08-11T01:00:00.000Z"],
    ["ct-2", managers.ct.id, "st-can-tho", null, "2026-08-11T02:00:00.000Z"],
    ["ct-read", managers.ct.id, "st-can-tho", "2026-08-11T02:30:00.000Z", "2026-08-11T00:30:00.000Z"],
    // Deliberately malformed legacy scope row: a store manager must not see or
    // mutate it merely because recipient_user_id matches.
    ["ct-foreign", managers.ct.id, "st-thot-not", null, "2026-08-11T03:00:00.000Z"],
    ["tn-1", managers.tn.id, "st-thot-not", null, "2026-08-11T01:00:00.000Z"],
    ["global-ct", managers.global.id, "st-can-tho", null, "2026-08-11T01:00:00.000Z"],
    ["global-tn", managers.global.id, "st-thot-not", null, "2026-08-11T02:00:00.000Z"],
  ];
  await db.batch(notifications.map(([id, recipient, storeId, readAt, createdAt]) => db.prepare(`INSERT INTO notifications
      (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, read_at, created_at)
      VALUES (?, ?, ?, 'NEW_ORDER', 'ORDER', ?, ?, ?, '{}', ?, ?)`)
    .bind(id, recipient, storeId, `order-${id}`, `Đơn ${id}`, `Thông báo ${id}`, readAt, createdAt)));
});

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

function request(managerKey, path = "", init = {}) {
  const manager = managers[managerKey];
  return new Request(`http://localhost/api/notifications${path}`, {
    ...init,
    headers: {
      cookie: `dore_session=${encodeURIComponent(manager.token)}`,
      ...(init.headers ?? {}),
    },
  });
}

async function responseOf(response) {
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function readRequest(managerKey, id, storeId) {
  return request(managerKey, "", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, storeId }),
  });
}

function clearRequest(managerKey, storeId) {
  return request(managerKey, storeId ? `?storeId=${encodeURIComponent(storeId)}` : "", {
    method: "DELETE",
  });
}

test("GET returns only unread rows in the manager's store and an exact badge count", async () => {
  const result = await responseOf(await notificationRoute.GET(request("ct")));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.notifications.map((item) => item.id), ["ct-2", "ct-1"]);
  assert.equal(result.body.unreadCount, 2);
  assert.ok(result.body.notifications.every((item) => item.readAt === null && item.storeId === "st-can-tho"));
  assert.equal(result.headers.get("cache-control"), "private, no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(result.headers.get("vary"), "Cookie");
});

test("concurrent/repeated reads persist one timestamp, remove the row and keep count correct", async () => {
  const [first, raced] = await Promise.all([
    notificationRoute.PATCH(readRequest("ct", "ct-2", "st-can-tho")).then(responseOf),
    notificationRoute.PATCH(readRequest("ct", "ct-2", "st-can-tho")).then(responseOf),
  ]);
  assert.equal(first.status, 200);
  assert.equal(raced.status, 200);
  assert.equal(first.body.readAt, raced.body.readAt);
  assert.equal(first.body.unreadCount, 1);
  assert.equal(raced.body.unreadCount, 1);

  const repeated = await responseOf(await notificationRoute.PATCH(readRequest("ct", "ct-2", "st-can-tho")));
  assert.equal(repeated.body.readAt, first.body.readAt);
  assert.equal(repeated.body.unreadCount, 1);
  const refreshed = await responseOf(await notificationRoute.GET(request("ct")));
  assert.deepEqual(refreshed.body.notifications.map((item) => item.id), ["ct-1"]);
  assert.equal(refreshed.body.unreadCount, 1);
});

test("store scope blocks a manager from reading a foreign-store recipient row", async () => {
  const forbidden = await responseOf(await notificationRoute.PATCH(readRequest("ct", "ct-foreign", "st-thot-not")));
  assert.equal(forbidden.status, 403);
  assert.equal(await db.prepare("SELECT read_at FROM notifications WHERE id = 'ct-foreign'").first("read_at"), null);

  const foreignQuery = await responseOf(await notificationRoute.GET(request("ct", "?storeId=st-thot-not")));
  assert.equal(foreignQuery.status, 403);
});

test("global manager can scope list and returned count to the selected store", async () => {
  const scoped = await responseOf(await notificationRoute.GET(request("global", "?storeId=st-can-tho")));
  assert.deepEqual(scoped.body.notifications.map((item) => item.id), ["global-ct"]);
  assert.equal(scoped.body.unreadCount, 1);

  const read = await responseOf(await notificationRoute.PATCH(readRequest("global", "global-ct", "st-can-tho")));
  assert.equal(read.status, 200);
  assert.equal(read.body.unreadCount, 0);
  const allStores = await responseOf(await notificationRoute.GET(request("global")));
  assert.deepEqual(allStores.body.notifications.map((item) => item.id), ["global-tn"]);
  assert.equal(allStores.body.unreadCount, 1);
});

test("clear-all atomically tombstones only unread notifications in the authenticated scope", async () => {
  const [first, raced] = await Promise.all([
    notificationRoute.DELETE(clearRequest("tn", "st-thot-not")).then(responseOf),
    notificationRoute.DELETE(clearRequest("tn", "st-thot-not")).then(responseOf),
  ]);
  assert.equal(first.status, 200);
  assert.equal(raced.status, 200);
  assert.equal(first.body.unreadCount, 0);
  assert.equal(raced.body.unreadCount, 0);
  assert.equal(first.body.clearedCount + raced.body.clearedCount, 1, "one racing request owns the unread row");
  assert.ok(await db.prepare("SELECT read_at FROM notifications WHERE id = 'tn-1'").first("read_at"));
  assert.equal(await db.prepare("SELECT read_at FROM notifications WHERE id = 'ct-foreign'").first("read_at"), null);

  const repeated = await responseOf(await notificationRoute.DELETE(clearRequest("tn", "st-thot-not")));
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.clearedCount, 0);
  assert.equal(repeated.body.unreadCount, 0);

  const forbidden = await responseOf(await notificationRoute.DELETE(clearRequest("ct", "st-thot-not")));
  assert.equal(forbidden.status, 403);
  assert.equal(await db.prepare("SELECT read_at FROM notifications WHERE id = 'ct-foreign'").first("read_at"), null);
});

test("clear-all UI exposes an accessible destructive action and stale-scope guard", async () => {
  const portal = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"));
  assert.match(portal, /aria-label="Xóa tất cả thông báo chưa đọc"/u);
  assert.match(portal, /<Trash2 size=\{17\}/u);
  assert.match(portal, /method: "DELETE"/u);
  assert.match(portal, /const notificationMutationRequest = useRef\(0\)/u);
  assert.match(portal, /selectedNotificationScope\.current === clearedScope/u);
  assert.match(portal, /disabled=\{clearing \|\| unreadCount === 0\}/u);
  assert.match(portal, /aria-busy=\{clearing\}/u);
});
