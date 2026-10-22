import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-inventory-receipt-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, route, code] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/records/route.ts"),
  import("../app/lib/inventory-receipt-code.ts"),
]);

let db;
const token = "inventory-receipt-manager-session";

before(async () => {
  db = await initDb();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind("inventory-manager-session", "user-manager", await sha256(token), Date.now() + 3_600_000, now).run();
});

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

function createRequest(index, overrides = {}) {
  const clientRequestId = overrides.clientRequestId ?? `inventory-request-${String(index).padStart(5, "0")}`;
  return new Request("http://localhost/api/records", {
    method: "POST",
    headers: { cookie: `dore_session=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "NHAP_HANG",
      storeId: overrides.storeId ?? "st-can-tho",
      title: `Phiếu nhập ${index}`,
      data: {
        clientRequestId,
        date: overrides.date ?? "2026-01-02",
        items: [{ name: `Hàng ${index}`, quantity: 1, unit: "Bao", weight: 1, unitPrice: 1000, shipping: 0 }],
      },
    }),
  });
}

async function responseOf(response) {
  return { status: response.status, body: await response.json() };
}

test("format is PN-ddMMyyyy-00001 and date uses Vietnam server time", () => {
  assert.equal(code.inventoryReceiptServerDate("2026-08-12T17:30:00.000Z"), "2026-08-13");
  assert.equal(code.inventoryReceiptCode("2026-08-13", 1), "PN-13082026-00001");
  assert.equal(code.inventoryReceiptCode("2026-08-14", 2), "PN-14082026-00002");
});

test("the global suffix continues across server-day rollover and ignores the selected business date", async () => {
  const RealDate = globalThis.Date;
  let now = "2026-08-12T17:30:00.000Z";
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
  };
  try {
    const first = await responseOf(await route.POST(createRequest(8001, { date: "2026-01-02" })));
    now = "2026-08-13T17:30:00.000Z";
    const second = await responseOf(await route.POST(createRequest(8002, { date: "2026-01-03" })));
    assert.equal(first.body.receiptNo, "PN-13082026-00001");
    assert.equal(second.body.receiptNo, "PN-14082026-00002");
  } finally {
    globalThis.Date = RealDate;
    await db.batch([
      db.prepare("DELETE FROM business_records WHERE category = 'NHAP_HANG'"),
      db.prepare("DELETE FROM inventory_receipt_requests"),
      db.prepare("DELETE FROM inventory_receipt_code_sequences"),
    ]);
  }
});

test("concurrent creates receive one global contiguous sequence and exact retry is idempotent", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => route.POST(createRequest(index + 1)).then(responseOf)));
  assert.ok(results.every((result) => result.status === 201));
  const suffixes = results.map((result) => Number(result.body.receiptNo.slice(-5))).sort((a, b) => a - b);
  assert.deepEqual(suffixes, Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(new Set(results.map((result) => result.body.receiptNo)).size, 12);

  const replay = await responseOf(await route.POST(createRequest(1)));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.receiptNo, results[0].body.receiptNo);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM business_records WHERE category = 'NHAP_HANG'").first("count"), 12);
});

test("store scope and locked period reject atomically without consuming a number", async () => {
  const before = await db.prepare("SELECT last_value AS value FROM inventory_receipt_code_sequences WHERE id = 1").first("value");
  const forbidden = await responseOf(await route.POST(createRequest(90, { storeId: "missing-store" })));
  assert.equal(forbidden.status, 409);
  assert.equal(await db.prepare("SELECT last_value AS value FROM inventory_receipt_code_sequences WHERE id = 1").first("value"), before);

  await db.prepare(`INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
    VALUES ('inventory-period-lock', 'PAYROLL_CLOSING', 'st-can-tho', 'user-manager', 'lock', '{"period":"2026-01"}', 'LOCKED', ?, ?)`)
    .bind(new Date().toISOString(), new Date().toISOString()).run();
  const locked = await responseOf(await route.POST(createRequest(91)));
  assert.equal(locked.status, 400);
  assert.equal(await db.prepare("SELECT last_value AS value FROM inventory_receipt_code_sequences WHERE id = 1").first("value"), before);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM inventory_receipt_requests WHERE client_request_id = ?")
    .bind("inventory-request-00091").first("count"), 0);
});

test("an actor-scope change between validation and commit is rejected by the atomic write gate", async () => {
  const before = await db.prepare("SELECT last_value AS value FROM inventory_receipt_code_sequences WHERE id = 1").first("value");
  const originalBatch = db.batch.bind(db);
  let intercepted = false;
  db.batch = async (statements) => {
    if (!intercepted) {
      intercepted = true;
      await db.prepare("UPDATE users SET is_super_admin = 0, store_id = 'st-thot-not' WHERE id = 'user-manager'").run();
    }
    return originalBatch(statements);
  };
  try {
    const response = await responseOf(await route.POST(createRequest(92, { date: "2026-02-02" })));
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Quyền quản lý cửa hàng đã thay đổi/u);
    assert.equal(await db.prepare("SELECT last_value AS value FROM inventory_receipt_code_sequences WHERE id = 1").first("value"), before);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM inventory_receipt_requests WHERE client_request_id = ?")
      .bind("inventory-request-00092").first("count"), 0);
  } finally {
    db.batch = originalBatch;
    await db.prepare("UPDATE users SET is_super_admin = 1, store_id = NULL WHERE id = 'user-manager'").run();
  }
});
