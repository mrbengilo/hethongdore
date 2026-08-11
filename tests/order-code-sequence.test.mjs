import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-order-code-sequence-"));
const databasePath = join(directory, "dore.sqlite");

// Reproduce a deployed pre-migration database before importing the singleton
// runtime. All historical codes, including an already issued store-style code,
// must remain byte-for-byte unchanged.
const legacyDb = new DatabaseSync(databasePath);
legacyDb.exec(`
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    store_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    shift_code TEXT NOT NULL,
    customer_name TEXT,
    phone TEXT,
    age INTEGER,
    amount INTEGER NOT NULL,
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'COMPLETED',
    created_at TEXT NOT NULL
  );
  INSERT INTO orders (id, code, store_id, employee_id, shift_code, amount, payment_method, created_at) VALUES
    ('legacy-a', 'DH00001', 'legacy-store', 'legacy-employee', 'legacy-shift', 1000, 'CASH', '2026-08-01T00:00:00.000Z'),
    ('legacy-b', 'DHF00BA47C12', 'legacy-store', 'legacy-employee', 'legacy-shift', 2000, 'CASH', '2026-08-01T00:01:00.000Z'),
    ('legacy-c', 'DHCURRENTBAD', 'legacy-store', 'legacy-employee', 'legacy-shift', 3000, 'BANK_TRANSFER', '2026-08-01T00:02:00.000Z'),
    ('legacy-ct', 'CT-00007', 'st-can-tho', 'legacy-employee', 'legacy-shift', 4000, 'CASH', '2026-08-01T00:03:00.000Z');
`);
legacyDb.close();

process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = databasePath;
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, orderRoute, storeRoute, { storeOrderCodePrefix }] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/orders/route.ts"),
  import("../app/api/stores/route.ts"),
  import("../app/lib/order-code.ts"),
]);

let db;
const managerToken = "order-code-manager-session";
const actors = {
  ct: {
    storeId: "st-can-tho",
    employeeId: "order-code-employee-ct",
    userId: "order-code-user-ct",
    shiftCode: "SHIFT-SEQUENCE-CT",
    token: "order-code-employee-session-ct",
  },
  tn: {
    storeId: "st-thot-not",
    employeeId: "order-code-employee-tn",
    userId: "order-code-user-tn",
    shiftCode: "SHIFT-SEQUENCE-TN",
    token: "order-code-employee-session-tn",
  },
  ct2: {
    storeId: "st-cua-tiem",
    employeeId: "order-code-employee-ct2",
    userId: "order-code-user-ct2",
    shiftCode: "SHIFT-SEQUENCE-CT2",
    token: "order-code-employee-session-ct2",
  },
};

before(async () => {
  db = await initDb();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
    VALUES ('st-cua-tiem', 'DORE CỬA TIỆM', 'Cần Thơ', 0, 0, 'ACTIVE', ?)`)
    .bind(now).run();
  for (const [key, actor] of Object.entries(actors)) {
    await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id = ?").bind(actor.storeId).run();
    await db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
        VALUES (?, ?, ?, ?, 'Nhân viên bán hàng', '0900000000', 20000, 25000, 'ACTIVE')`)
      .bind(actor.employeeId, actor.storeId, `SEQ-${key.toUpperCase()}`, `Nhân viên mã đơn ${key.toUpperCase()}`).run();
    await db.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, employee_id, store_id, shift_active, current_shift, shift_started_at)
        VALUES (?, ?, 'unused', 'EMPLOYEE', ?, ?, ?, 1, ?, ?)`)
      .bind(actor.userId, actor.userId, `Nhân viên mã đơn ${key.toUpperCase()}`, actor.employeeId, actor.storeId, actor.shiftCode, now).run();
    await db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, work_date, started_at, close_status, status)
        VALUES (?, ?, ?, ?, 'Ca 1', '2026-08-10', ?, 'OPEN', 'ACTIVE')`)
      .bind(`order-code-shift-${key}`, actor.shiftCode, actor.storeId, actor.employeeId, now).run();
    await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)`)
      .bind(`order-code-login-${key}`, actor.userId, await sha256(actor.token), Date.now() + 3_600_000, now).run();
  }
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind("order-code-manager-login", "user-manager", await sha256(managerToken), Date.now() + 3_600_000, now).run();
});

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

function requestId(storeKey, index) {
  return `order-${storeKey}-request-${String(index).padStart(4, "0")}`;
}

function createRequest(storeKey, index, amount = 10_000) {
  const actor = actors[storeKey];
  const idempotencyKey = requestId(storeKey, index);
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: {
      cookie: `dore_session=${encodeURIComponent(actor.token)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      customerName: `Khách ${storeKey}-${index}`,
      amount,
      paymentMethod: "CASH",
      clientRequestId: idempotencyKey,
    }),
  });
}

async function responseOf(response) {
  return { status: response.status, body: await response.json() };
}

function createStoreRequest(name) {
  return new Request("http://localhost/api/stores", {
    method: "POST",
    headers: {
      cookie: `dore_session=${encodeURIComponent(managerToken)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, address: `Địa chỉ ${name}` }),
  });
}

test("store prefix is derived from Vietnamese store names and excludes the brand", () => {
  assert.equal(storeOrderCodePrefix("DORE CẦN THƠ"), "CT");
  assert.equal(storeOrderCodePrefix("DORE THỐT NỐT"), "TN");
  assert.equal(storeOrderCodePrefix("DORE VĨNH LONG"), "VL");
  assert.equal(storeOrderCodePrefix("Cửa hàng DORE Sóc Trăng"), "ST");
});

test("0019 migration is additive, idempotent and preserves historical codes", async () => {
  const migration = await readFile(new URL("../drizzle/0019_store_order_code_sequence.sql", import.meta.url), "utf8");
  const path = join(directory, "migration-contract.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL);
      INSERT INTO orders VALUES ('a', 'DH00012', 'store-a'), ('b', 'CT-00003', 'store-a'), ('c', 'DHWRONG', 'store-b');`);
    database.exec(migration);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM store_order_code_sequences").get().count, 0);
    assert.deepEqual(database.prepare("SELECT code FROM orders ORDER BY id").all().map((row) => row.code), ["DH00012", "CT-00003", "DHWRONG"]);
    database.prepare("INSERT INTO store_order_code_sequences VALUES (?, ?, ?, ?)").run("store-a", "CT", 30, "2026-08-11T00:00:00.000Z");
    assert.throws(() => database.prepare("INSERT INTO store_order_code_sequences VALUES (?, ?, ?, ?)")
      .run("store-b", "CT", 0, "2026-08-11T00:00:00.000Z"), /UNIQUE constraint failed/u);
    database.exec(migration);
    assert.deepEqual({ ...database.prepare("SELECT store_id AS storeId, code_prefix AS prefix, last_value AS value FROM store_order_code_sequences").get() }, {
      storeId: "store-a", prefix: "CT", value: 30,
    });
  } finally {
    database.close();
  }
});

test("each store starts or resumes only its own sequence and exact retry keeps its code", async () => {
  const oldCodesBefore = (await db.prepare("SELECT id, code FROM orders WHERE id LIKE 'legacy-%' ORDER BY id").all()).results;
  const ct = await responseOf(await orderRoute.POST(createRequest("ct", 1, 25_000)));
  assert.deepEqual(ct, { status: 201, body: { id: ct.body.id, code: "CT-00008" } });

  const replayed = await responseOf(await orderRoute.POST(createRequest("ct", 1, 25_000)));
  assert.deepEqual(replayed, { status: 200, body: { id: ct.body.id, code: "CT-00008", replayed: true } });
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM orders WHERE employee_id = ? AND client_request_id = ?")
    .bind(actors.ct.employeeId, requestId("ct", 1)).first("count"), 1);

  const tn = await responseOf(await orderRoute.POST(createRequest("tn", 1, 26_000)));
  assert.equal(tn.status, 201);
  assert.equal(tn.body.code, "TN-00001");
  assert.deepEqual((await db.prepare("SELECT id, code FROM orders WHERE id LIKE 'legacy-%' ORDER BY id").all()).results, oldCodesBefore);

  const sequences = (await db.prepare("SELECT store_id AS storeId, code_prefix AS prefix, last_value AS value FROM store_order_code_sequences WHERE store_id IN ('st-can-tho', 'st-thot-not') ORDER BY store_id").all()).results
    .map((row) => ({ ...row }));
  assert.deepEqual(sequences, [
    { storeId: "st-can-tho", prefix: "CT", value: 8 },
    { storeId: "st-thot-not", prefix: "TN", value: 1 },
  ]);

  const notification = await db.prepare("SELECT title, data_json AS dataJson FROM notifications WHERE entity_id = ? LIMIT 1").bind(ct.body.id).first();
  assert.match(notification.title, /CT-00008/u);
  assert.equal(JSON.parse(notification.dataJson).orderCode, "CT-00008");
});

test("persisted prefix survives store rename and duplicate initials receive a unique suffix", async () => {
  await db.prepare("UPDATE stores SET name = 'DORE MIỀN TÂY' WHERE id = ?").bind(actors.ct.storeId).run();
  const renamed = await responseOf(await orderRoute.POST(createRequest("ct", 500, 27_000)));
  assert.equal(renamed.status, 201);
  assert.equal(renamed.body.code, "CT-00009");
  assert.equal(await db.prepare("SELECT code_prefix FROM store_order_code_sequences WHERE store_id = ?")
    .bind(actors.ct.storeId).first("code_prefix"), "CT");

  const duplicateInitials = await responseOf(await orderRoute.POST(createRequest("ct2", 1, 28_000)));
  assert.equal(duplicateInitials.status, 201);
  assert.equal(duplicateInitials.body.code, "CT2-00001");
  const prefixes = (await db.prepare("SELECT code_prefix AS prefix FROM store_order_code_sequences WHERE store_id IN (?, ?) ORDER BY store_id")
    .bind(actors.ct.storeId, actors.ct2.storeId).all()).results.map((row) => row.prefix);
  assert.deepEqual(prefixes.sort(), ["CT", "CT2"]);
  assert.equal(new Set(prefixes).size, prefixes.length);
  assert.equal(await db.prepare("SELECT code FROM orders WHERE id = 'legacy-ct'").first("code"), "CT-00007");
});

test("concurrent store creation serializes the same initials into unique immutable prefixes", async () => {
  const created = await Promise.all([
    storeRoute.POST(createStoreRequest("DORE CAO TẦNG")).then(responseOf),
    storeRoute.POST(createStoreRequest("DORE CỬA TRỜI")).then(responseOf),
  ]);
  assert.ok(created.every((result) => result.status === 201));
  const ids = created.map((result) => result.body.id);
  const rows = (await db.prepare(`SELECT s.id, s.name, sequence.code_prefix AS prefix
      FROM stores s JOIN store_order_code_sequences sequence ON sequence.store_id = s.id
      WHERE s.id IN (?, ?) ORDER BY sequence.code_prefix`)
    .bind(ids[0], ids[1]).all()).results.map((row) => ({ ...row }));
  assert.deepEqual(rows.map((row) => row.prefix), ["CT3", "CT4"]);
  await db.prepare("UPDATE stores SET name = 'DORE ĐỔI TÊN' WHERE id = ?").bind(ids[0]).run();
  assert.equal(await db.prepare("SELECT code_prefix FROM store_order_code_sequences WHERE store_id = ?")
    .bind(ids[0]).first("code_prefix"), rows.find((row) => row.id === ids[0]).prefix);
});

test("concurrent requests stay unique and contiguous independently in both stores", async () => {
  const perStore = 12;
  const jobs = [];
  for (let offset = 0; offset < perStore; offset += 1) {
    jobs.push(orderRoute.POST(createRequest("ct", offset + 2, 30_000 + offset)).then(responseOf));
    jobs.push(orderRoute.POST(createRequest("tn", offset + 2, 40_000 + offset)).then(responseOf));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every((result) => result.status === 201));
  const ctCodes = results.map((result) => result.body.code).filter((code) => code.startsWith("CT-")).sort();
  const tnCodes = results.map((result) => result.body.code).filter((code) => code.startsWith("TN-")).sort();
  assert.deepEqual(ctCodes, Array.from({ length: perStore }, (_, offset) => `CT-${String(offset + 10).padStart(5, "0")}`));
  assert.deepEqual(tnCodes, Array.from({ length: perStore }, (_, offset) => `TN-${String(offset + 2).padStart(5, "0")}`));
  assert.equal(new Set(results.map((result) => result.body.code)).size, results.length);
});

test("a rejected create does not consume that store's number and employee PATCH/DELETE remain forbidden", async () => {
  const prior = await db.prepare("SELECT last_value FROM store_order_code_sequences WHERE store_id = ?").bind(actors.ct.storeId).first("last_value");
  await db.prepare("UPDATE shift_sessions SET status = 'COMPLETED' WHERE shift_code = ?").bind(actors.ct.shiftCode).run();
  const rejected = await responseOf(await orderRoute.POST(createRequest("ct", 100, 45_000)));
  assert.equal(rejected.status, 409);
  assert.equal(await db.prepare("SELECT last_value FROM store_order_code_sequences WHERE store_id = ?").bind(actors.ct.storeId).first("last_value"), prior);

  await db.prepare("UPDATE shift_sessions SET status = 'ACTIVE' WHERE shift_code = ?").bind(actors.ct.shiftCode).run();
  const created = await responseOf(await orderRoute.POST(createRequest("ct", 101, 45_000)));
  assert.equal(created.status, 201);
  assert.equal(created.body.code, `CT-${String(prior + 1).padStart(5, "0")}`);

  const actor = actors.ct;
  const cookie = `dore_session=${encodeURIComponent(actor.token)}`;
  const beforeRow = await db.prepare("SELECT customer_name AS customerName, amount, status FROM orders WHERE id = ?").bind(created.body.id).first();
  const patch = await responseOf(await orderRoute.PATCH(new Request("http://localhost/api/orders", {
    method: "PATCH",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ id: created.body.id, customerName: "Không được sửa", amount: 1, paymentMethod: "CASH" }),
  })));
  const deletion = await responseOf(await orderRoute.DELETE(new Request(`http://localhost/api/orders?id=${created.body.id}`, {
    method: "DELETE",
    headers: { cookie },
  })));
  assert.equal(patch.status, 403);
  assert.equal(deletion.status, 403);
  assert.deepEqual({ ...await db.prepare("SELECT customer_name AS customerName, amount, status FROM orders WHERE id = ?").bind(created.body.id).first() }, { ...beforeRow });
});

test("route keeps per-store allocation, guarded insert and notification in one batch", async () => {
  const source = await readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8");
  assert.match(source, /INSERT INTO store_order_code_sequences/u);
  assert.match(source, /reserveStoreOrderCodePrefix/u);
  assert.match(source, /ON CONFLICT\(store_id\) DO UPDATE/u);
  assert.doesNotMatch(source, /code_prefix = excluded\.code_prefix/u);
  assert.match(source, /printf\('%s-%05d', sequence\.code_prefix, sequence\.last_value\)/u);
  assert.match(source, /const \[, orderInsert, , createdOrderResult\] = await db\.batch/u);
  assert.doesNotMatch(source, /UPDATE orders SET code/u);
});
