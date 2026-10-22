import { initDb } from "../../../db/runtime";
import { CCCD_UPLOAD_KEY_PATTERN, getCccdStorage } from "./cccd-storage";
import {
  markCccdUploadDeletedStatement,
  markCccdUploadDeletionFailureStatement,
  queueExpiredPendingCccdUploads,
} from "./cccd-upload-registry";

type Database = Awaited<ReturnType<typeof initDb>>;

type OutboxRow = {
  key: string;
  attempts: number;
};

type EnqueueCccdDeletionInput = {
  key: string;
  replacementKey: string;
  employeeId: string;
  requestedBy: string;
  reason: string;
  requestedAt: string;
};

type EnqueuePurgedCccdDeletionInput = {
  key: string;
  employeeId: string;
  storeId: string;
  requestedBy: string;
  reason: string;
  deletedAt: string;
};

export function enqueueCccdDeletionStatement(db: Database, input: EnqueueCccdDeletionInput) {
  return db.prepare(`INSERT OR IGNORE INTO cccd_deletion_outbox
      (key, employee_id, requested_by, reason, attempts, last_error, created_at, updated_at)
    SELECT ?, ?, ?, ?, 0, NULL, ?, ?
    WHERE ? != ? AND EXISTS (
      SELECT 1 FROM employees
      WHERE id = ? AND cccd_image_key = ?
        AND status != 'ARCHIVED' AND deleted_at IS NULL
    )`)
    .bind(
      input.key, input.employeeId, input.requestedBy, input.reason,
      input.requestedAt, input.requestedAt,
      input.key, input.replacementKey, input.employeeId, input.replacementKey,
    );
}

export function enqueuePurgedCccdDeletionStatement(db: Database, input: EnqueuePurgedCccdDeletionInput) {
  return db.prepare(`INSERT OR IGNORE INTO cccd_deletion_outbox
      (key, employee_id, requested_by, reason, attempts, last_error, created_at, updated_at)
    SELECT ?, ?, ?, ?, 0, NULL, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM employees
      WHERE id = ? AND store_id = ? AND status = 'ARCHIVED'
        AND deleted_at = ? AND cccd_image_key IS NULL
    )`)
    .bind(
      input.key, input.employeeId, input.requestedBy, input.reason,
      input.deletedAt, input.deletedAt,
      input.employeeId, input.storeId, input.deletedAt,
    );
}

export async function processCccdDeletionOutbox(options: { key?: string; limit?: number } = {}) {
  const db = await initDb();
  const limit = Math.max(1, Math.min(25, Math.trunc(options.limit ?? 5)));
  await queueExpiredPendingCccdUploads({ db, limit });
  const rows = options.key
    ? await db.prepare(`SELECT key, attempts FROM cccd_deletion_outbox
        WHERE key = ? ORDER BY created_at, key LIMIT ?`)
      .bind(options.key, limit).all<OutboxRow>()
    : await db.prepare(`SELECT key, attempts FROM cccd_deletion_outbox
        ORDER BY created_at, key LIMIT ?`)
      .bind(limit).all<OutboxRow>();
  if (rows.results.length === 0) return { deleted: 0, pending: 0 };

  let storage: Awaited<ReturnType<typeof getCccdStorage>> = null;
  let storageError = "UPLOAD_STORAGE_UNAVAILABLE";
  try {
    storage = await getCccdStorage();
  } catch (error) {
    storageError = error instanceof Error ? error.message.slice(0, 500) : "UPLOAD_STORAGE_CONFIGURATION_FAILED";
  }
  if (!storage) {
    const now = new Date().toISOString();
    await db.batch(rows.results.flatMap((row) => [
      db.prepare(`UPDATE cccd_deletion_outbox
          SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE key = ?`)
        .bind(storageError, now, row.key),
      markCccdUploadDeletionFailureStatement(db, row.key, storageError, now),
    ]));
    return { deleted: 0, pending: rows.results.length };
  }

  let deleted = 0;
  let pending = 0;
  for (const row of rows.results) {
    // A key may have been reattached after it entered the queue. Never delete
    // bytes that currently belong to any live employee.
    const liveReference = await db.prepare(`SELECT 1 AS present FROM employees
        WHERE cccd_image_key = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
        LIMIT 1`).bind(row.key).first<{ present: number }>();
    if (liveReference) {
      await db.batch([
        db.prepare("DELETE FROM cccd_deletion_outbox WHERE key = ?").bind(row.key),
        db.prepare(`UPDATE cccd_upload_registry SET
            deletion_status = 'NONE', delete_requested_at = NULL,
            last_deletion_error = 'LIVE_REFERENCE_RETAINED', updated_at = ?
          WHERE key = ? AND deletion_status = 'PENDING'`)
          .bind(new Date().toISOString(), row.key),
      ]);
      continue;
    }
    if (!CCCD_UPLOAD_KEY_PATTERN.test(row.key)) {
      // Invalid legacy keys cannot be mapped to either local or R2 storage.
      // Removing them from the queue is safe because the read endpoint also
      // rejects their format before accessing storage.
      const deletedAt = new Date().toISOString();
      await db.batch([
        db.prepare("DELETE FROM cccd_deletion_outbox WHERE key = ?").bind(row.key),
        markCccdUploadDeletedStatement(db, row.key, deletedAt),
      ]);
      continue;
    }
    try {
      await storage.delete(row.key);
      const deletedAt = new Date().toISOString();
      await db.batch([
        db.prepare("DELETE FROM cccd_deletion_outbox WHERE key = ?").bind(row.key),
        markCccdUploadDeletedStatement(db, row.key, deletedAt),
      ]);
      deleted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "UPLOAD_DELETE_FAILED";
      const attemptedAt = new Date().toISOString();
      await db.batch([
        db.prepare(`UPDATE cccd_deletion_outbox
            SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE key = ?`)
          .bind(message, attemptedAt, row.key),
        markCccdUploadDeletionFailureStatement(db, row.key, message, attemptedAt),
      ]);
      pending += 1;
    }
  }
  return { deleted, pending };
}
