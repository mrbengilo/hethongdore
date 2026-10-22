import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-cccd-privacy-"));
const uploadRoot = join(directory, "uploads");
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_UPLOAD_DIR = uploadRoot;
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, { sha256 }, uploadRoute, employeeRoute, adminEmployeesRoute, cccdDeletion] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/uploads/route.ts"),
  import("../app/api/employees/route.ts"),
  import("../app/api/admin/employees/route.ts"),
  import("../app/api/_lib/cccd-deletion.ts"),
]);

const db = await initDb();

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

const keys = {
  liveA: "cccd/00000000-0000-4000-8000-000000000001.jpg",
  liveB: "cccd/00000000-0000-4000-8000-000000000002.jpg",
  archived: "cccd/00000000-0000-4000-8000-000000000003.jpg",
  deleted: "cccd/00000000-0000-4000-8000-000000000004.jpg",
  orphan: "cccd/00000000-0000-4000-8000-000000000005.jpg",
  replacement: "cccd/00000000-0000-4000-8000-000000000006.jpg",
  liveA2: "cccd/00000000-0000-4000-8000-000000000007.jpg",
  shared: "cccd/00000000-0000-4000-8000-000000000008.jpg",
  race: "cccd/00000000-0000-4000-8000-000000000009.jpg",
};

function objectPath(key) {
  return join(uploadRoot, ...key.split("/"));
}

async function putObject(key, marker) {
  const path = objectPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, marker]));
}

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

async function seed() {
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR REPLACE INTO stores
      (id, name, address, revenue, expense, status, created_at)
    VALUES ('cccd-store-a', 'CCCD STORE A', 'A', 0, 0, 'ACTIVE', ?),
           ('cccd-store-b', 'CCCD STORE B', 'B', 0, 0, 'ACTIVE', ?)`)
    .bind(now, now).run();

  await db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, province, ward, address_line, age,
       cccd_image_key, cccd_image_name, hourly_rate, tiktok_allowance, status, deleted_at)
    VALUES
      ('cccd-live-a', 'cccd-store-a', 'CCCD-A', 'Live A', 'Nhân viên', '0900000001', 'A', 'A', 'A', 25, ?, 'a.jpg', 20000, 25000, 'ACTIVE', NULL),
      ('cccd-live-b', 'cccd-store-b', 'CCCD-B', 'Live B', 'Nhân viên', '0900000002', 'B', 'B', 'B', 26, ?, 'b.jpg', 20000, 25000, 'SUSPENDED', NULL),
      ('cccd-live-a2', 'cccd-store-a', 'CCCD-A2', 'Live A2', 'Nhân viên', '0900000005', 'A', 'A', 'A', 24, ?, 'a2.jpg', 20000, 25000, 'ACTIVE', NULL),
      ('cccd-shared-keeper', 'cccd-store-a', 'CCCD-S1', 'Shared Keeper', 'Nhân viên', '0900000006', 'A', 'A', 'A', 29, ?, 'shared.jpg', 20000, 25000, 'ACTIVE', NULL),
      ('cccd-shared-purge', 'cccd-store-b', 'CCCD-S2', 'Shared Purge', 'Nhân viên', '0900000007', 'B', 'B', 'B', 30, ?, 'shared.jpg', 20000, 25000, 'SUSPENDED', NULL),
      ('cccd-archived', 'cccd-store-a', 'CCCD-C', 'Archived', 'Nhân viên', '0900000003', 'A', 'A', 'A', 27, ?, 'c.jpg', 20000, 25000, 'ARCHIVED', ?),
      ('cccd-deleted', 'cccd-store-a', 'CCCD-D', 'Deleted', 'Nhân viên', '0900000004', 'A', 'A', 'A', 28, ?, 'd.jpg', 20000, 25000, 'ACTIVE', ?)`)
    .bind(keys.liveA, keys.liveB, keys.liveA2, keys.shared, keys.shared, keys.archived, now, keys.deleted, now).run();

  await db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
    VALUES
      ('cccd-manager-a', 'cccd-manager-a', 'unused', 'MANAGER', 'Manager A', NULL, 'cccd-store-a', 0),
      ('cccd-manager-global', 'cccd-manager-global', 'unused', 'MANAGER', 'Manager Global', NULL, NULL, 0),
      ('cccd-super', 'cccd-super', 'unused', 'MANAGER', 'Super', NULL, 'cccd-store-a', 1),
      ('cccd-employee-user', 'cccd-employee-user', 'unused-a1', 'EMPLOYEE', 'Live A', 'cccd-live-a', 'cccd-store-a', 0),
      ('cccd-employee-user-a2', 'cccd-employee-user-a2', 'unused-a2', 'EMPLOYEE', 'Live A2', 'cccd-live-a2', 'cccd-store-a', 0)`)
    .run();

  await db.prepare(`INSERT INTO cccd_upload_registry
      (key, actor_user_id, actor_store_id, actor_global_access, original_name,
       content_type, created_at, claim_status, deletion_status, updated_at)
    VALUES (?, 'cccd-manager-a', 'cccd-store-a', 0, 'replacement.jpg',
      'image/jpeg', ?, 'PENDING', 'NONE', ?)`)
    .bind(keys.replacement, now, now).run();

  const tokens = {
    scoped: "cccd-scoped-token",
    global: "cccd-global-token",
    super: "cccd-super-token",
  };
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES
      ('cccd-session-a', 'cccd-manager-a', ?, ?, ?),
      ('cccd-session-global', 'cccd-manager-global', ?, ?, ?),
      ('cccd-session-super', 'cccd-super', ?, ?, ?)`)
    .bind(
      await sha256(tokens.scoped), Date.now() + 120_000, now,
      await sha256(tokens.global), Date.now() + 120_000, now,
      await sha256(tokens.super), Date.now() + 120_000, now,
    ).run();

  let marker = 1;
  for (const key of Object.values(keys)) await putObject(key, marker++);
  return tokens;
}

async function getImage(key, token) {
  return uploadRoute.GET(request(`/api/uploads?key=${encodeURIComponent(key)}`, token));
}

test("CCCD reads require a live attached employee and replacements securely retire the old object", async () => {
  const tokens = await seed();

  const ownStore = await getImage(keys.liveA, tokens.scoped);
  assert.equal(ownStore.status, 200);
  assert.equal(ownStore.headers.get("cache-control"), "private, no-store");
  assert.equal(ownStore.headers.get("vary"), "Cookie");

  const configuredUploadRoot = process.env.DORE_UPLOAD_DIR;
  delete process.env.DORE_UPLOAD_DIR;
  try {
    assert.equal((await getImage(keys.orphan, tokens.scoped)).status, 404,
      "orphan authorization must fail before an unavailable storage backend is consulted");
    assert.equal((await getImage(keys.liveA, tokens.scoped)).status, 503,
      "an attached key reaches storage only after the database access guard passes");
  } finally {
    process.env.DORE_UPLOAD_DIR = configuredUploadRoot;
  }

  assert.equal((await getImage(keys.liveB, tokens.scoped)).status, 404, "scoped manager must not read another store");
  assert.equal((await getImage(keys.archived, tokens.scoped)).status, 404, "archived employee key must be denied");
  assert.equal((await getImage(keys.deleted, tokens.scoped)).status, 404, "soft-deleted employee key must be denied");
  assert.equal((await getImage(keys.orphan, tokens.scoped)).status, 404, "orphan bytes must be denied before storage read");
  assert.equal((await getImage(keys.liveB, tokens.global)).status, 200, "global manager may read every live store");
  assert.equal((await getImage(keys.liveB, tokens.super)).status, 200, "super-admin may read every live store");

  const update = await employeeRoute.PATCH(request("/api/employees", tokens.scoped, "PATCH", {
    id: "cccd-live-a",
    storeId: "cccd-store-a",
    code: "CCCD-A",
    name: "Live A",
    position: "Nhân viên",
    phone: "0900000001",
    province: "A",
    ward: "A",
    addressLine: "A",
    age: 25,
    cccdNumber: "092000000001",
    cccdImageKey: keys.replacement,
    cccdImageName: "replacement.jpg",
    expectedVersion: 0,
  }));
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), { ok: true, cccdCleanupPending: false });

  assert.equal((await getImage(keys.liveA, tokens.scoped)).status, 404, "replaced key must be denied immediately");
  assert.equal((await getImage(keys.replacement, tokens.scoped)).status, 200);
  await assert.rejects(stat(objectPath(keys.liveA)), (error) => error?.code === "ENOENT");
  assert.equal(await db.prepare("SELECT COUNT(*) FROM cccd_deletion_outbox").first("COUNT(*)"), 0);

  const unauthorizedReattach = await employeeRoute.PATCH(request("/api/employees", tokens.scoped, "PATCH", {
    id: "cccd-live-a",
    storeId: "cccd-store-a",
    code: "CCCD-A",
    name: "Must Not Persist",
    position: "Nhân viên",
    phone: "0900000001",
    province: "A",
    ward: "A",
    addressLine: "A",
    age: 25,
    cccdNumber: "092000000001",
    cccdImageKey: keys.orphan,
    cccdImageName: "orphan.jpg",
    username: "must-not-persist",
    password: "Must-not-persist-2026",
    expectedVersion: 0,
  }));
  assert.equal(unauthorizedReattach.status, 403, "a storage key without an actor-owned pending registry claim is denied");
  assert.equal(await db.prepare("SELECT name FROM employees WHERE id = 'cccd-live-a'").first("name"), "Live A");
  assert.equal(await db.prepare("SELECT username FROM users WHERE employee_id = 'cccd-live-a'").first("username"), "cccd-employee-user");

  const raceCreatedAt = new Date().toISOString();
  await db.prepare(`INSERT INTO cccd_upload_registry
      (key, actor_user_id, actor_store_id, actor_global_access, original_name,
       content_type, created_at, claim_status, deletion_status, updated_at)
    VALUES (?, 'cccd-manager-a', 'cccd-store-a', 0, 'race.jpg',
      'image/jpeg', ?, 'PENDING', 'NONE', ?)`)
    .bind(keys.race, raceCreatedAt, raceCreatedAt).run();
  const raceBodies = [
    {
      id: "cccd-live-a", storeId: "cccd-store-a", code: "CCCD-A", name: "Race Winner A1",
      position: "Nhân viên", phone: "0900000001", province: "A", ward: "A", addressLine: "A", age: 25, cccdNumber: "092000000011",
      cccdImageKey: keys.race, cccdImageName: "race.jpg", username: "cccd-race-a1", password: "Race-secret-a1", expectedVersion: 0,
    },
    {
      id: "cccd-live-a2", storeId: "cccd-store-a", code: "CCCD-A2", name: "Race Winner A2",
      position: "Nhân viên", phone: "0900000005", province: "A", ward: "A", addressLine: "A", age: 24, cccdNumber: "092000000012",
      cccdImageKey: keys.race, cccdImageName: "race.jpg", username: "cccd-race-a2", password: "Race-secret-a2", expectedVersion: 0,
    },
  ];
  const raceResponses = await Promise.all(raceBodies.map((body) => employeeRoute.PATCH(
    request("/api/employees", tokens.scoped, "PATCH", body),
  )));
  assert.equal(raceResponses.filter((response) => response.status === 200).length, 1,
    "an uploaded CCCD key can be claimed by exactly one live employee");
  assert.equal(raceResponses.filter((response) => response.status === 403 || response.status === 409).length, 1);
  const losingIndex = raceResponses.findIndex((response) => response.status !== 200);
  const losingBody = raceBodies[losingIndex];
  const losingEmployee = await db.prepare("SELECT name, cccd_image_key AS cccdImageKey FROM employees WHERE id = ?")
    .bind(losingBody.id).first();
  assert.equal(losingEmployee.name, losingBody.id === "cccd-live-a" ? "Live A" : "Live A2",
    "a lost atomic claim must not partially update employee identity");
  assert.notEqual(losingEmployee.cccdImageKey, keys.race);
  const losingLogin = await db.prepare("SELECT name, username, password_hash AS passwordHash FROM users WHERE employee_id = ?")
    .bind(losingBody.id).first();
  assert.deepEqual({ ...losingLogin }, losingBody.id === "cccd-live-a"
    ? { name: "Live A", username: "cccd-employee-user", passwordHash: "unused-a1" }
    : { name: "Live A2", username: "cccd-employee-user-a2", passwordHash: "unused-a2" },
  "a lost atomic claim must not partially update login credentials");

  const listResponse = await adminEmployeesRoute.GET(request(
    "/api/admin/employees?storeId=cccd-store-b&page=1&pageSize=20",
    tokens.super,
  ));
  assert.equal(listResponse.status, 200);
  const storeBRows = (await listResponse.json()).rows;
  const sharedPurgeTarget = storeBRows.find((row) => row.id === "cccd-shared-purge");
  assert.ok(sharedPurgeTarget);
  const sharedPurge = await adminEmployeesRoute.DELETE(request(
    "/api/admin/employees",
    tokens.super,
    "DELETE",
    {
      storeId: "cccd-store-b",
      id: sharedPurgeTarget.id,
      versionToken: sharedPurgeTarget.versionToken,
      reason: "Kiểm thử khóa ảnh cũ đang được hồ sơ còn sống cùng tham chiếu",
      confirmation: sharedPurgeTarget.code,
    },
  ));
  assert.equal(sharedPurge.status, 200);
  assert.equal((await stat(objectPath(keys.shared))).isFile(), true,
    "purging one legacy duplicate reference must not delete bytes still used by another live employee");
  assert.equal(await db.prepare("SELECT COUNT(*) FROM cccd_deletion_outbox WHERE key = ?")
    .bind(keys.shared).first("COUNT(*)"), 0);
  assert.equal((await getImage(keys.shared, tokens.scoped)).status, 200);

  const purgeTarget = storeBRows.find((row) => row.id === "cccd-live-b");
  assert.ok(purgeTarget);
  assert.equal(purgeTarget.id, "cccd-live-b");

  // Force both the immediate attempt and the post-commit processor away from
  // the real upload root. The employee purge must still commit, deny reads,
  // and retain a durable retry row instead of losing the object cleanup job.
  process.env.DORE_UPLOAD_DIR = "relative-storage-outage";
  const purgeResponse = await adminEmployeesRoute.DELETE(request(
    "/api/admin/employees",
    tokens.super,
    "DELETE",
    {
      storeId: "cccd-store-b",
      id: purgeTarget.id,
      versionToken: purgeTarget.versionToken,
      reason: "Kiểm thử hàng đợi xóa ảnh CCCD khi kho tạm lỗi",
      confirmation: purgeTarget.code,
    },
  ));
  assert.equal(purgeResponse.status, 200);
  const purgeBody = await purgeResponse.json();
  assert.equal(typeof purgeBody.warning, "string");
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'cccd-live-b'").first("status"), "ARCHIVED");
  assert.equal(await db.prepare("SELECT cccd_number FROM employees WHERE id = 'cccd-live-b'").first("cccd_number"), null,
    "purge must erase the government identifier from the live employee row");
  assert.equal((await getImage(keys.liveB, tokens.super)).status, 404,
    "purged CCCD must be denied before the failed physical delete is retried");
  assert.equal(await db.prepare("SELECT COUNT(*) FROM cccd_deletion_outbox WHERE key = ?")
    .bind(keys.liveB).first("COUNT(*)"), 1);
  assert.equal((await stat(objectPath(keys.liveB))).isFile(), true);

  process.env.DORE_UPLOAD_DIR = uploadRoot;
  const retried = await cccdDeletion.processCccdDeletionOutbox({ key: keys.liveB, limit: 1 });
  assert.deepEqual(retried, { deleted: 1, pending: 0 });
  assert.equal(await db.prepare("SELECT COUNT(*) FROM cccd_deletion_outbox WHERE key = ?")
    .bind(keys.liveB).first("COUNT(*)"), 0);
  await assert.rejects(stat(objectPath(keys.liveB)), (error) => error?.code === "ENOENT");
});

test("privacy cleanup is durable and ordered after the profile transaction", async () => {
  const [runtime, employeeApi, uploadApi, deletion] = await Promise.all([
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/uploads/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_lib/cccd-deletion.ts", import.meta.url), "utf8"),
  ]);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS cccd_deletion_outbox/u);
  assert.match(employeeApi, /statements\.push\(enqueueCccdDeletionStatement/u);
  assert.match(employeeApi, /await db\.batch\(statements\)[\s\S]*processCccdDeletionOutbox/u);
  assert.match(uploadApi, /attached[\s\S]*if \(!attached\)[\s\S]*getCccdStorage\(\)/u);
  assert.match(deletion, /liveReference[\s\S]*storage\.delete\(row\.key\)/u);
});
