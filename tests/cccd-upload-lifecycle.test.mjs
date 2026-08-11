import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-cccd-upload-lifecycle-"));
const uploadRoot = join(directory, "uploads");
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_UPLOAD_DIR = uploadRoot;
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, registry, storageModule, deletionModule, maintenanceRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/cccd-upload-registry.ts"),
  import("../app/api/_lib/cccd-storage.ts"),
  import("../app/api/_lib/cccd-deletion.ts"),
  import("../app/api/admin/maintenance/cccd/route.ts"),
]);

const db = await runtime.initDb();
const storage = await storageModule.getCccdStorage();
assert.ok(storage);

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

function objectPath(key) {
  return join(uploadRoot, ...key.split("/"));
}

async function putObject(key, marker) {
  const path = objectPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, marker]));
}

async function register({ key, originalName, createdAt, actor = "upload-manager", storeId = "upload-store" }) {
  await putObject(key, originalName.length % 250);
  await registry.registerPendingCccdUpload({
    db,
    storage,
    key,
    actorUserId: actor,
    actorStoreId: storeId,
    actorGlobalAccess: false,
    originalName,
    contentType: "image/jpeg",
    createdAt,
  });
}

function changes(result) {
  return Number(result?.meta?.changes ?? 0);
}

test("a registry write failure removes the just-written object", async () => {
  let deletedKey = null;
  const databaseError = new Error("simulated registry outage");
  const fakeStatement = { bind() { return this; } };
  const fakeDb = {
    prepare: () => fakeStatement,
    batch: async () => { throw databaseError; },
  };
  const fakeStorage = { delete: async (key) => { deletedKey = key; } };

  await assert.rejects(registry.registerPendingCccdUpload({
    db: fakeDb,
    storage: fakeStorage,
    key: "cccd/10000000-0000-4000-8000-000000000001.jpg",
    actorUserId: "actor",
    actorStoreId: "store",
    actorGlobalAccess: false,
    originalName: "sensitive-original.jpg",
    contentType: "image/jpeg",
    createdAt: "2026-08-10T00:00:00.000Z",
  }), databaseError);
  assert.equal(deletedKey, "cccd/10000000-0000-4000-8000-000000000001.jpg");
});

test("a cancelled upload is queued once after grace, redacted, and deleted by the janitor", async () => {
  const key = "cccd/20000000-0000-4000-8000-000000000002.jpg";
  const originalName = "cancelled-personal-name.jpg";
  await register({ key, originalName, createdAt: "2026-08-08T00:00:00.000Z" });

  const auditBefore = await db.prepare("SELECT detail FROM audit_logs WHERE entity_id = ?")
    .bind(key).first("detail");
  assert.equal(String(auditBefore).includes(originalName), false,
    "the general audit log must never duplicate an upload's original filename");

  assert.deepEqual(await registry.queueExpiredPendingCccdUploads({
    db,
    now: new Date("2026-08-10T00:00:00.000Z"),
    graceMs: 24 * 60 * 60 * 1000,
  }), { queued: 1 });
  assert.deepEqual(await registry.queueExpiredPendingCccdUploads({
    db,
    now: new Date("2026-08-10T00:00:00.000Z"),
    graceMs: 24 * 60 * 60 * 1000,
  }), { queued: 0 }, "re-running the janitor must not duplicate an outbox job");

  const pending = await db.prepare(`SELECT original_name AS originalName,
      deletion_status AS deletionStatus FROM cccd_upload_registry WHERE key = ?`)
    .bind(key).first();
  assert.equal(pending.originalName, null);
  assert.equal(pending.deletionStatus, "PENDING");
  assert.equal(await db.prepare("SELECT detail FROM audit_logs WHERE entity_id = ?")
    .bind(key).first("detail"), null);
  assert.equal(await registry.actorCanClaimPendingCccd(db, {
    key,
    currentKey: null,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId: "cancelled-upload-owner",
  }), false, "a key queued for deletion must not be attachable");

  assert.deepEqual(await deletionModule.processCccdDeletionOutbox({ key, limit: 1 }), {
    deleted: 1,
    pending: 0,
  });
  await assert.rejects(stat(objectPath(key)), (error) => error?.code === "ENOENT");
  assert.equal(await db.prepare("SELECT deletion_status FROM cccd_upload_registry WHERE key = ?")
    .bind(key).first("deletion_status"), "DELETED");
  assert.equal(await registry.actorCanClaimPendingCccd(db, {
    key,
    currentKey: null,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId: "cancelled-upload-owner",
  }), false, "a deleted key must not be attachable");
});

test("the authenticated maintenance path runs the same idempotent janitor", async () => {
  const key = "cccd/25000000-0000-4000-8000-000000000025.jpg";
  await register({
    key,
    originalName: "scheduled-maintenance.jpg",
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  process.env.DORE_MAINTENANCE_TOKEN = "maintenance-test-secret";
  const denied = await maintenanceRoute.POST(new Request("http://localhost/api/admin/maintenance/cccd", {
    method: "POST",
    headers: { authorization: "Bearer wrong-secret" },
  }));
  assert.equal(denied.status, 403);
  const response = await maintenanceRoute.POST(new Request("http://localhost/api/admin/maintenance/cccd", {
    method: "POST",
    headers: { authorization: "Bearer maintenance-test-secret" },
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(await db.prepare("SELECT deletion_status FROM cccd_upload_registry WHERE key = ?")
    .bind(key).first("deletion_status"), "DELETED");
  await assert.rejects(stat(objectPath(key)), (error) => error?.code === "ENOENT");
  delete process.env.DORE_MAINTENANCE_TOKEN;
});

test("a live legacy employee key remains editable without a fabricated registry row", async () => {
  const key = "cccd/28000000-0000-4000-8000-000000000028.jpg";
  await db.prepare(`INSERT OR IGNORE INTO stores
      (id, name, address, revenue, expense, status, created_at)
    VALUES ('upload-store', 'UPLOAD STORE', 'A', 0, 0, 'ACTIVE', '2026-08-10T00:00:00.000Z')`).run();
  await db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, province, ward, address_line, age,
       cccd_image_key, cccd_image_name, hourly_rate, tiktok_allowance, status)
    VALUES ('legacy-registryless', 'upload-store', 'LEGACY28', 'Legacy Name', 'Staff',
      '0900000028', 'A', 'A', 'A', 28, ?, 'legacy.jpg', 20000, 0, 'ACTIVE')`)
    .bind(key).run();
  const input = {
    key,
    currentKey: key,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId: "legacy-registryless",
  };
  assert.equal(await registry.actorCanClaimPendingCccd(db, input), true);
  const updated = await db.prepare(`UPDATE employees SET name = 'Legacy Updated'
      WHERE id = 'legacy-registryless' AND ${registry.pendingCccdAttachmentGuardSql}`)
    .bind(...registry.pendingCccdAttachmentGuardBindings(input)).run();
  assert.equal(changes(updated), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) FROM cccd_upload_registry WHERE key = ?")
    .bind(key).first("COUNT(*)"), 0);
});

test("a failed employee save rolls back the claim and leaves the upload eligible for cleanup", async () => {
  const key = "cccd/30000000-0000-4000-8000-000000000003.jpg";
  const createdAt = "2026-08-08T01:00:00.000Z";
  await register({ key, originalName: "failed-save.jpg", createdAt });
  await db.prepare(`INSERT OR IGNORE INTO stores
      (id, name, address, revenue, expense, status, created_at)
    VALUES ('upload-store', 'UPLOAD STORE', 'A', 0, 0, 'ACTIVE', ?)`)
    .bind(createdAt).run();
  await db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, province, ward, address_line, age,
       hourly_rate, tiktok_allowance, status)
    VALUES ('duplicate-code-owner', 'upload-store', 'DUPLICATE', 'Existing', 'Staff',
      '0900000000', 'A', 'A', 'A', 25, 20000, 0, 'ACTIVE')`).run();

  const claimInput = {
    key,
    currentKey: null,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId: "failed-created-employee",
  };
  assert.equal(await registry.actorCanClaimPendingCccd(db, claimInput), true);
  await assert.rejects(db.batch([
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
         cccd_image_key, hourly_rate, tiktok_allowance, status)
      SELECT ?, ?, 'DUPLICATE', 'Failed', 'Staff', '0900000001', 'A', 'A', 'A', 25,
        ?, 20000, 0, 'ACTIVE'
      WHERE ${registry.pendingCccdAttachmentGuardSql}`)
      .bind(
        claimInput.employeeId,
        claimInput.targetStoreId,
        claimInput.key,
        ...registry.pendingCccdAttachmentGuardBindings(claimInput),
      ),
    registry.claimPendingCccdUploadStatement(db, {
      ...claimInput,
      claimedAt: "2026-08-10T01:00:00.000Z",
    }),
  ]), /UNIQUE/iu);

  assert.equal(await db.prepare("SELECT COUNT(*) FROM employees WHERE id = ?")
    .bind(claimInput.employeeId).first("COUNT(*)"), 0);
  const registryAfterFailure = await db.prepare(`SELECT claim_status AS claimStatus,
      deletion_status AS deletionStatus FROM cccd_upload_registry WHERE key = ?`)
    .bind(key).first();
  assert.equal(registryAfterFailure.claimStatus, "PENDING");
  assert.equal(registryAfterFailure.deletionStatus, "NONE");

  assert.deepEqual(await registry.queueExpiredPendingCccdUploads({
    db,
    now: new Date("2026-08-10T02:00:00.000Z"),
    graceMs: 24 * 60 * 60 * 1000,
  }), { queued: 1 });
  await deletionModule.processCccdDeletionOutbox({ key, limit: 1 });
  assert.equal(await db.prepare("SELECT deletion_status FROM cccd_upload_registry WHERE key = ?")
    .bind(key).first("deletion_status"), "DELETED");
});

test("replacement redacts original-name data and a failed physical delete retries idempotently", async () => {
  const oldKey = "cccd/40000000-0000-4000-8000-000000000004.jpg";
  const newKey = "cccd/50000000-0000-4000-8000-000000000005.jpg";
  const employeeId = "registry-live-employee";
  const oldClaim = {
    key: oldKey,
    currentKey: null,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId,
  };
  await register({ key: oldKey, originalName: "old-sensitive-name.jpg", createdAt: "2026-08-10T03:00:00.000Z" });
  let results = await db.batch([
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
         cccd_image_key, cccd_image_name, hourly_rate, tiktok_allowance, status)
      SELECT ?, ?, 'REGISTRY1', 'Registry Employee', 'Staff', '0900000002', 'A', 'A', 'A',
        25, ?, 'old-sensitive-name.jpg', 20000, 0, 'ACTIVE'
      WHERE ${registry.pendingCccdAttachmentGuardSql}`)
      .bind(employeeId, "upload-store", oldKey, ...registry.pendingCccdAttachmentGuardBindings(oldClaim)),
    registry.claimPendingCccdUploadStatement(db, {
      ...oldClaim,
      claimedAt: "2026-08-10T03:01:00.000Z",
    }),
  ]);
  assert.equal(changes(results[0]), 1);
  assert.equal(changes(results[1]), 1);

  await register({ key: newKey, originalName: "new-sensitive-name.jpg", createdAt: "2026-08-10T04:00:00.000Z" });
  const newClaim = { ...oldClaim, key: newKey, currentKey: oldKey };
  const replacedAt = "2026-08-10T04:01:00.000Z";
  results = await db.batch([
    db.prepare(`UPDATE employees SET cccd_image_key = ?, cccd_image_name = 'new-sensitive-name.jpg'
      WHERE id = ? AND cccd_image_key IS ? AND ${registry.pendingCccdAttachmentGuardSql}`)
      .bind(newKey, employeeId, oldKey, ...registry.pendingCccdAttachmentGuardBindings(newClaim)),
    registry.claimPendingCccdUploadStatement(db, { ...newClaim, claimedAt: replacedAt }),
    deletionModule.enqueueCccdDeletionStatement(db, {
      key: oldKey,
      replacementKey: newKey,
      employeeId,
      requestedBy: "upload-manager",
      reason: "EMPLOYEE_CCCD_REPLACED",
      requestedAt: replacedAt,
    }),
    ...registry.retireCccdUploadStatements(db, {
      key: oldKey,
      replacementKey: newKey,
      requestedAt: replacedAt,
    }),
  ]);
  assert.equal(changes(results[0]), 1);
  assert.equal(changes(results[1]), 1);
  const retired = await db.prepare(`SELECT original_name AS originalName,
      deletion_status AS deletionStatus FROM cccd_upload_registry WHERE key = ?`)
    .bind(oldKey).first();
  assert.equal(retired.originalName, null);
  assert.equal(retired.deletionStatus, "PENDING");
  assert.equal(await db.prepare("SELECT detail FROM audit_logs WHERE entity_id = ?")
    .bind(oldKey).first("detail"), null);
  assert.equal(await registry.actorCanClaimPendingCccd(db, {
    key: oldKey,
    currentKey: newKey,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId,
  }), false, "a detached key cannot be reattached while deletion is pending");

  const configuredRoot = process.env.DORE_UPLOAD_DIR;
  process.env.DORE_UPLOAD_DIR = "relative-storage-outage";
  try {
    const failed = await deletionModule.processCccdDeletionOutbox({ key: oldKey, limit: 1 });
    assert.deepEqual(failed, { deleted: 0, pending: 1 });
  } finally {
    process.env.DORE_UPLOAD_DIR = configuredRoot;
  }
  const failedRegistry = await db.prepare(`SELECT deletion_status AS deletionStatus,
      deletion_attempts AS attempts, last_deletion_error AS lastError
    FROM cccd_upload_registry WHERE key = ?`).bind(oldKey).first();
  assert.equal(failedRegistry.deletionStatus, "PENDING");
  assert.ok(failedRegistry.attempts >= 1);
  assert.equal(typeof failedRegistry.lastError, "string");

  assert.deepEqual(await deletionModule.processCccdDeletionOutbox({ key: oldKey, limit: 1 }), {
    deleted: 1,
    pending: 0,
  });
  assert.equal(await db.prepare("SELECT deletion_status FROM cccd_upload_registry WHERE key = ?")
    .bind(oldKey).first("deletion_status"), "DELETED");
  assert.equal(await registry.actorCanClaimPendingCccd(db, {
    key: oldKey,
    currentKey: newKey,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId,
  }), false, "a detached key cannot be reattached after deletion");
  assert.equal(await db.prepare("SELECT claim_status FROM cccd_upload_registry WHERE key = ?")
    .bind(newKey).first("claim_status"), "CLAIMED");
});

test("purge retirement redacts both registry and legacy upload audit detail", async () => {
  const key = "cccd/60000000-0000-4000-8000-000000000006.jpg";
  const employeeId = "registry-purge-employee";
  const claimedAt = "2026-08-10T05:00:00.000Z";
  await register({ key, originalName: "purge-sensitive-name.jpg", createdAt: claimedAt });
  const claimInput = {
    key,
    currentKey: null,
    actorUserId: "upload-manager",
    targetStoreId: "upload-store",
    employeeId,
  };
  await db.batch([
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
         cccd_image_key, cccd_image_name, hourly_rate, tiktok_allowance, status)
      SELECT ?, ?, 'REGISTRY2', 'Purge Employee', 'Staff', '0900000003', 'A', 'A', 'A',
        25, ?, 'purge-sensitive-name.jpg', 20000, 0, 'ACTIVE'
      WHERE ${registry.pendingCccdAttachmentGuardSql}`)
      .bind(employeeId, "upload-store", key, ...registry.pendingCccdAttachmentGuardBindings(claimInput)),
    registry.claimPendingCccdUploadStatement(db, { ...claimInput, claimedAt }),
  ]);
  // Simulate the pre-registry audit shape to prove retirement also scrubs it.
  await db.prepare("UPDATE audit_logs SET detail = 'purge-sensitive-name.jpg' WHERE entity_id = ?")
    .bind(key).run();
  const purgedAt = "2026-08-10T05:10:00.000Z";
  await db.batch([
    db.prepare(`UPDATE employees SET status = 'ARCHIVED', deleted_at = ?,
        cccd_image_key = NULL, cccd_image_name = NULL WHERE id = ? AND cccd_image_key = ?`)
      .bind(purgedAt, employeeId, key),
    db.prepare(`INSERT OR IGNORE INTO cccd_deletion_outbox
        (key, employee_id, requested_by, reason, attempts, created_at, updated_at)
      VALUES (?, ?, 'upload-manager', 'EMPLOYEE_PURGED', 0, ?, ?)`)
      .bind(key, employeeId, purgedAt, purgedAt),
    ...registry.retireCccdUploadStatements(db, { key, requestedAt: purgedAt }),
  ]);
  const retired = await db.prepare(`SELECT original_name AS originalName,
      deletion_status AS deletionStatus FROM cccd_upload_registry WHERE key = ?`)
    .bind(key).first();
  assert.equal(retired.originalName, null);
  assert.equal(retired.deletionStatus, "PENDING");
  assert.equal(await db.prepare("SELECT detail FROM audit_logs WHERE entity_id = ?")
    .bind(key).first("detail"), null);
  await deletionModule.processCccdDeletionOutbox({ key, limit: 1 });
  assert.equal(await db.prepare("SELECT deletion_status FROM cccd_upload_registry WHERE key = ?")
    .bind(key).first("deletion_status"), "DELETED");
});
