import type { CccdStorage } from "./cccd-storage";

type Database = D1Database;

export const DEFAULT_CCCD_PENDING_GRACE_MS = 24 * 60 * 60 * 1000;

export type PendingCccdUploadInput = {
  db: Database;
  storage: CccdStorage;
  key: string;
  actorUserId: string;
  actorStoreId: string | null;
  actorGlobalAccess: boolean;
  originalName: string;
  contentType: string;
  createdAt: string;
};

export type CccdClaimInput = {
  key: string;
  currentKey: string | null;
  actorUserId: string;
  targetStoreId: string;
  employeeId: string;
};

export type RetireCccdUploadInput = {
  key: string;
  replacementKey?: string | null;
  requestedAt: string;
};

/**
 * Registers bytes that have already been written to object storage. The
 * database row and the privacy-safe audit entry are one transaction. If that
 * transaction fails, the just-written object is removed before the error is
 * returned, so a failed upload response cannot create an untracked object.
 */
export async function registerPendingCccdUpload(input: PendingCccdUploadInput) {
  try {
    await input.db.batch([
      input.db.prepare(`INSERT INTO cccd_upload_registry
          (key, actor_user_id, actor_store_id, actor_global_access, original_name,
           content_type, created_at, claim_status, deletion_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'NONE', ?)`)
        .bind(
          input.key,
          input.actorUserId,
          input.actorStoreId,
          input.actorGlobalAccess ? 1 : 0,
          input.originalName,
          input.contentType,
          input.createdAt,
          input.createdAt,
        ),
      // Never duplicate the original filename into the general audit log. It
      // remains available only in the short-lived, purpose-specific registry.
      input.db.prepare(`INSERT INTO audit_logs
          (id, user_id, action, entity_type, entity_id, detail, created_at)
        VALUES (?, ?, 'UPLOAD', 'EMPLOYEE_CCCD', ?, ?, ?)`)
        .bind(
          crypto.randomUUID(),
          input.actorUserId,
          input.key,
          JSON.stringify({ claimStatus: "PENDING", contentType: input.contentType }),
          input.createdAt,
        ),
    ]);
  } catch (databaseError) {
    try {
      await input.storage.delete(input.key);
    } catch (deletionError) {
      throw new AggregateError(
        [databaseError, deletionError],
        "CCCD_UPLOAD_REGISTRATION_AND_ROLLBACK_FAILED",
      );
    }
    throw databaseError;
  }
}

/**
 * A registry-less key is accepted only when it is already the employee's live
 * key. This is the compatibility path for profiles created before the upload
 * registry existed. Every newly attached key must be an unclaimed upload made
 * by the same actor in an authorized store scope.
 */
export const pendingCccdAttachmentGuardSql = `(
  ? IS ? OR (
    EXISTS (
      SELECT 1 FROM cccd_upload_registry pending_upload
      WHERE pending_upload.key = ?
        AND pending_upload.actor_user_id = ?
        AND pending_upload.claim_status = 'PENDING'
        AND pending_upload.deletion_status = 'NONE'
        AND (pending_upload.actor_global_access = 1 OR pending_upload.actor_store_id = ?)
    )
    AND NOT EXISTS (
      SELECT 1 FROM employees cccd_owner
      WHERE cccd_owner.cccd_image_key = ? AND cccd_owner.id != ?
        AND cccd_owner.status != 'ARCHIVED' AND cccd_owner.deleted_at IS NULL
    )
  )
)`;

export function pendingCccdAttachmentGuardBindings(input: CccdClaimInput) {
  return [
    input.key,
    input.currentKey,
    input.key,
    input.actorUserId,
    input.targetStoreId,
    input.key,
    input.employeeId,
  ];
}

export async function actorCanClaimPendingCccd(db: Database, input: CccdClaimInput) {
  const allowed = await db.prepare(`SELECT CASE WHEN ${pendingCccdAttachmentGuardSql}
      THEN 1 ELSE 0 END AS allowed`)
    .bind(...pendingCccdAttachmentGuardBindings(input))
    .first<{ allowed: number }>();
  return Number(allowed?.allowed) === 1;
}

/** Add this statement to the same db.batch as the employee INSERT/UPDATE. */
export function claimPendingCccdUploadStatement(
  db: Database,
  input: CccdClaimInput & { claimedAt: string },
) {
  return db.prepare(`UPDATE cccd_upload_registry SET
      claim_status = 'CLAIMED', claimed_at = ?, claimed_employee_id = ?, updated_at = ?
    WHERE key = ? AND ? IS NOT ?
      AND actor_user_id = ? AND claim_status = 'PENDING' AND deletion_status = 'NONE'
      AND (actor_global_access = 1 OR actor_store_id = ?)
      AND EXISTS (
        SELECT 1 FROM employees attached_employee
        WHERE attached_employee.id = ? AND attached_employee.store_id = ?
          AND attached_employee.cccd_image_key = cccd_upload_registry.key
          AND attached_employee.status != 'ARCHIVED' AND attached_employee.deleted_at IS NULL
      )`)
    .bind(
      input.claimedAt,
      input.employeeId,
      input.claimedAt,
      input.key,
      input.key,
      input.currentKey,
      input.actorUserId,
      input.targetStoreId,
      input.employeeId,
      input.targetStoreId,
    );
}

/**
 * Add these statements to the same transaction that detaches or purges a key.
 * They remove original-name detail before physical deletion is attempted.
 */
export function retireCccdUploadStatements(db: Database, input: RetireCccdUploadInput) {
  const replacementKey = input.replacementKey ?? null;
  return [
    db.prepare(`UPDATE cccd_upload_registry SET
        original_name = NULL,
        deletion_status = 'PENDING',
        delete_requested_at = COALESCE(delete_requested_at, ?),
        updated_at = ?
      WHERE key = ? AND key IS NOT ? AND deletion_status != 'DELETED'
        AND EXISTS (SELECT 1 FROM cccd_deletion_outbox deletion WHERE deletion.key = cccd_upload_registry.key)`)
      .bind(input.requestedAt, input.requestedAt, input.key, replacementKey),
    // Old releases wrote the original filename directly as audit detail. New
    // releases use JSON without it, but clearing both forms is intentionally
    // idempotent and covers legacy rows during replacement or purge.
    db.prepare(`UPDATE audit_logs SET detail = NULL
      WHERE action = 'UPLOAD' AND entity_type = 'EMPLOYEE_CCCD' AND entity_id = ?
        AND ? IS NOT ?
        AND EXISTS (SELECT 1 FROM cccd_deletion_outbox deletion WHERE deletion.key = ?)`)
      .bind(input.key, input.key, replacementKey, input.key),
  ];
}

export function markCccdUploadDeletedStatement(db: Database, key: string, deletedAt: string) {
  return db.prepare(`UPDATE cccd_upload_registry SET
      original_name = NULL, deletion_status = 'DELETED', deleted_at = ?,
      last_deletion_error = NULL, updated_at = ?
    WHERE key = ?`)
    .bind(deletedAt, deletedAt, key);
}

export function markCccdUploadDeletionFailureStatement(
  db: Database,
  key: string,
  error: string,
  attemptedAt: string,
) {
  return db.prepare(`UPDATE cccd_upload_registry SET
      original_name = NULL, deletion_status = 'PENDING',
      deletion_attempts = deletion_attempts + 1,
      last_deletion_error = ?, updated_at = ?
    WHERE key = ?`)
    .bind(error.slice(0, 500), attemptedAt, key);
}

type PendingRegistryRow = {
  key: string;
  actorUserId: string;
};

/**
 * Moves expired, still-unclaimed uploads into the durable deletion outbox.
 * Repeated or concurrent runs are safe: both the registry and outbox keys are
 * unique, and every mutation rechecks PENDING/NONE inside one transaction.
 */
export async function queueExpiredPendingCccdUploads(options: {
  db: Database;
  now?: Date;
  graceMs?: number;
  limit?: number;
}): Promise<{ queued: number }> {
  const now = options.now ?? new Date();
  const graceMs = Math.max(60_000, Math.trunc(options.graceMs ?? DEFAULT_CCCD_PENDING_GRACE_MS));
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const threshold = new Date(now.getTime() - graceMs).toISOString();
  const requestedAt = now.toISOString();
  const candidates = await options.db.prepare(`SELECT key, actor_user_id AS actorUserId
      FROM cccd_upload_registry
      WHERE claim_status = 'PENDING' AND deletion_status = 'NONE' AND created_at <= ?
      ORDER BY created_at, key LIMIT ?`)
    .bind(threshold, limit).all<PendingRegistryRow>();

  let queued = 0;
  for (const row of candidates.results) {
    const results = await options.db.batch([
      options.db.prepare(`INSERT OR IGNORE INTO cccd_deletion_outbox
          (key, employee_id, requested_by, reason, attempts, last_error, created_at, updated_at)
        SELECT key, '__PENDING_UPLOAD__', actor_user_id, 'UNCLAIMED_CCCD_UPLOAD_EXPIRED',
          0, NULL, ?, ?
        FROM cccd_upload_registry
        WHERE key = ? AND actor_user_id = ?
          AND claim_status = 'PENDING' AND deletion_status = 'NONE' AND created_at <= ?`)
        .bind(requestedAt, requestedAt, row.key, row.actorUserId, threshold),
      options.db.prepare(`UPDATE cccd_upload_registry SET
          original_name = NULL, deletion_status = 'PENDING',
          delete_requested_at = COALESCE(delete_requested_at, ?), updated_at = ?
        WHERE key = ? AND actor_user_id = ?
          AND claim_status = 'PENDING' AND deletion_status = 'NONE' AND created_at <= ?
          AND EXISTS (SELECT 1 FROM cccd_deletion_outbox deletion WHERE deletion.key = cccd_upload_registry.key)`)
        .bind(requestedAt, requestedAt, row.key, row.actorUserId, threshold),
      options.db.prepare(`UPDATE audit_logs SET detail = NULL
        WHERE action = 'UPLOAD' AND entity_type = 'EMPLOYEE_CCCD' AND entity_id = ?
          AND EXISTS (SELECT 1 FROM cccd_upload_registry upload
            WHERE upload.key = audit_logs.entity_id AND upload.deletion_status = 'PENDING')`)
        .bind(row.key),
    ]);
    const changes = Number((results[1] as { meta?: { changes?: number } }).meta?.changes ?? 0);
    queued += changes > 0 ? 1 : 0;
  }
  return { queued };
}
