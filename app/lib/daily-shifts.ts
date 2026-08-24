import { isOvernightShift, shiftDurationMinutes, validClock } from "./scheduling";
import {
  incomingStorePeriodUnlockedSql,
  isStorePeriodLocked,
  storePeriodUnlockedSql,
} from "../api/_lib/store-period-lock";

const requestIdPattern = /^[a-zA-Z0-9:_-]{16,200}$/u;
const datePattern = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/u;

export type DailyShiftRow = {
  id: string;
  storeId: string;
  workDate: string;
  name: string;
  nameKey: string;
  start: string;
  end: string;
  version: number;
  status: "ACTIVE" | "DELETED";
  clientRequestId: string | null;
  payloadHash: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type DailyShiftValues = {
  workDate: string;
  name: string;
  nameKey: string;
  start: string;
  end: string;
  durationMinutes: number;
  overnight: boolean;
};

export class DailyShiftConflictError extends Error {
  readonly reason: "DUPLICATE" | "STALE" | "REQUEST_MISMATCH" | "INACTIVE" | "FORBIDDEN" | "LOCKED";

  constructor(reason: "DUPLICATE" | "STALE" | "REQUEST_MISMATCH" | "INACTIVE" | "FORBIDDEN" | "LOCKED") {
    super(reason);
    this.name = "DailyShiftConflictError";
    this.reason = reason;
  }
}

export function normalizeDailyShiftMutationReason(value: unknown) {
  const reason = String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  return reason.length >= 5 && reason.length <= 500 ? reason : null;
}

async function storeIsActive(db: D1Database, storeId: string) {
  const row = await db.prepare("SELECT 1 AS active FROM stores WHERE id = ? AND status = 'ACTIVE' LIMIT 1")
    .bind(storeId).first<{ active: number }>();
  return Boolean(row?.active);
}

async function actorCanManageStore(db: D1Database, actorId: string, storeId: string) {
  const row = await db.prepare(`SELECT 1 AS allowed FROM users
    WHERE id = ? AND role = 'MANAGER'
      AND (is_super_admin = 1 OR store_id IS NULL OR store_id = ?)
    LIMIT 1`).bind(actorId, storeId).first<{ allowed: number }>();
  return Boolean(row?.allowed);
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

export function normalizeDailyShiftRequestId(value: unknown) {
  const normalized = String(value ?? "").trim();
  return requestIdPattern.test(normalized) ? normalized : null;
}

export function normalizeDailyShiftName(value: unknown) {
  const name = String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 50) return null;
  return { name, nameKey: name.toLocaleLowerCase("vi-VN") };
}

export function validDailyShiftDate(value: string) {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

export function dailyShiftValues(source: Record<string, unknown>): DailyShiftValues | null {
  const workDate = String(source.workDate ?? source.date ?? "");
  const normalizedName = normalizeDailyShiftName(source.name);
  const start = String(source.start ?? "");
  const end = String(source.end ?? "");
  const durationMinutes = shiftDurationMinutes(start, end);
  if (!validDailyShiftDate(workDate) || !normalizedName || !validClock(start) || !validClock(end) || durationMinutes <= 0) return null;
  return {
    workDate,
    ...normalizedName,
    start,
    end,
    durationMinutes,
    overnight: isOvernightShift(start, end),
  };
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function dailyShiftId(storeId: string, clientRequestId: string) {
  return `daily-shift-${await sha256(`${storeId}:${clientRequestId}`)}`;
}

export async function dailyShiftPayloadHash(storeId: string, values: DailyShiftValues) {
  return sha256(JSON.stringify({
    storeId,
    workDate: values.workDate,
    name: values.name,
    start: values.start,
    end: values.end,
  }));
}

const selectDailyShiftSql = `SELECT id, store_id AS storeId, work_date AS workDate,
    name, name_key AS nameKey, start_time AS start, end_time AS end,
    version, status, client_request_id AS clientRequestId, payload_hash AS payloadHash,
    created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
  FROM daily_shift_definitions`;

export async function getDailyShift(db: D1Database, id: string) {
  return db.prepare(`${selectDailyShiftSql} WHERE id = ? LIMIT 1`).bind(id).first<DailyShiftRow>();
}

export async function listDailyShifts(db: D1Database, storeId: string, workDate: string) {
  const [rows, state] = await Promise.all([
    db.prepare(`${selectDailyShiftSql}
      WHERE store_id = ? AND work_date = ? AND status = 'ACTIVE'
      ORDER BY start_time, name_key, id`).bind(storeId, workDate).all<DailyShiftRow>(),
    db.prepare(`SELECT COUNT(*) AS count FROM daily_shift_definitions
      WHERE store_id = ? AND work_date = ?`).bind(storeId, workDate).first<{ count: number }>(),
  ]);
  return { shifts: rows.results, initialized: Number(state?.count ?? 0) > 0 };
}

export async function createDailyShift(db: D1Database, input: {
  storeId: string;
  actorId: string;
  clientRequestId: string;
  values: DailyShiftValues;
  now: string;
  reason: string;
}) {
  const id = await dailyShiftId(input.storeId, input.clientRequestId);
  const payloadHash = await dailyShiftPayloadHash(input.storeId, input.values);
  const existingBefore = await getDailyShift(db, id);
  if (existingBefore?.storeId === input.storeId
    && existingBefore.clientRequestId === input.clientRequestId
    && existingBefore.payloadHash === payloadHash
    && existingBefore.status === "ACTIVE") {
    return { status: "IDEMPOTENT" as const, id, version: existingBefore.version };
  }
  const reason = normalizeDailyShiftMutationReason(input.reason) ?? `Tạo ca làm việc ${input.values.name}`;
  const after = {
    id,
    storeId: input.storeId,
    workDate: input.values.workDate,
    name: input.values.name,
    nameKey: input.values.nameKey,
    start: input.values.start,
    end: input.values.end,
    version: 1,
    status: "ACTIVE",
    clientRequestId: input.clientRequestId,
    payloadHash,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
  };
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(`INSERT INTO daily_shift_definitions
        (id, store_id, work_date, name, name_key, start_time, end_time, status,
          version, client_request_id, payload_hash, created_by, created_at, updated_at, deleted_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?, ?, ?, NULL
      WHERE EXISTS (SELECT 1 FROM stores WHERE id = ? AND status = 'ACTIVE')
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.role = 'MANAGER'
            AND (actor.is_super_admin = 1 OR actor.store_id IS NULL OR actor.store_id = ?)
        )
        AND ${incomingStorePeriodUnlockedSql}
      ON CONFLICT(id) DO NOTHING`)
      .bind(
        id, input.storeId, input.values.workDate, input.values.name, input.values.nameKey,
        input.values.start, input.values.end, input.clientRequestId, payloadHash,
        input.actorId, input.now, input.now, input.storeId, input.actorId, input.storeId,
        input.storeId, input.values.workDate.slice(0, 7),
      ),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
            before_json, after_json, reason, created_at)
        SELECT ?, ?, shift.store_id, 'CREATE_DAILY_SHIFT', 'DAILY_SHIFT', shift.id, ?,
          NULL, ?, ?, ?
        FROM daily_shift_definitions shift
        WHERE shift.id = ? AND shift.store_id = ? AND shift.status = 'ACTIVE'
          AND shift.version = 1 AND shift.created_at = ?
          AND shift.client_request_id = ? AND shift.payload_hash = ?`)
        .bind(
          `daily-shift-audit:create:${id}`, input.actorId,
          `Tạo ${input.values.name} ngày ${input.values.workDate}`,
          JSON.stringify(after), reason, input.now,
          id, input.storeId, input.now, input.clientRequestId, payloadHash,
        ),
    ]);
  } catch (error) {
    const raced = await getDailyShift(db, id);
    if (raced?.storeId === input.storeId
      && raced.clientRequestId === input.clientRequestId
      && raced.payloadHash === payloadHash
      && raced.status === "ACTIVE") {
      return { status: "IDEMPOTENT" as const, id, version: raced.version };
    }
    if (/UNIQUE constraint failed: daily_shift_definitions/iu.test(error instanceof Error ? error.message : String(error))) {
      throw new DailyShiftConflictError("DUPLICATE");
    }
    throw error;
  }
  if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) {
    return { status: "CREATED" as const, id, version: 1 };
  }

  const existing = await getDailyShift(db, id);
  if (existing?.storeId === input.storeId
    && existing.clientRequestId === input.clientRequestId
    && existing.payloadHash === payloadHash
    && existing.status === "ACTIVE") {
    return { status: "IDEMPOTENT" as const, id, version: existing.version };
  }
  if (!await storeIsActive(db, input.storeId)) throw new DailyShiftConflictError("INACTIVE");
  if (!await actorCanManageStore(db, input.actorId, input.storeId)) throw new DailyShiftConflictError("FORBIDDEN");
  if (await isStorePeriodLocked(db, input.storeId, input.values.workDate.slice(0, 7))) throw new DailyShiftConflictError("LOCKED");
  throw new DailyShiftConflictError("REQUEST_MISMATCH");
}

export async function updateDailyShift(db: D1Database, input: {
  id: string;
  storeId: string;
  actorId: string;
  expectedVersion: number;
  values: DailyShiftValues;
  now: string;
  reason: string;
}) {
  const before = await getDailyShift(db, input.id);
  const reason = normalizeDailyShiftMutationReason(input.reason);
  if (!reason) throw new TypeError("Daily shift update reason is required");
  const after = before ? {
    ...before,
    name: input.values.name,
    nameKey: input.values.nameKey,
    start: input.values.start,
    end: input.values.end,
    version: input.expectedVersion + 1,
    updatedAt: input.now,
  } : null;
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(`UPDATE daily_shift_definitions SET
        name = ?, name_key = ?, start_time = ?, end_time = ?, version = version + 1,
        updated_at = ?
      WHERE id = ? AND store_id = ? AND work_date = ? AND status = 'ACTIVE' AND version = ?
        AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND status = 'ACTIVE')
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.role = 'MANAGER'
            AND (actor.is_super_admin = 1 OR actor.store_id IS NULL OR actor.store_id = ?)
        )
        AND ${storePeriodUnlockedSql("daily_shift_definitions.store_id", "substr(daily_shift_definitions.work_date, 1, 7)")}`)
      .bind(
        input.values.name, input.values.nameKey, input.values.start, input.values.end, input.now,
        input.id, input.storeId, input.values.workDate, input.expectedVersion, input.storeId,
        input.actorId, input.storeId,
      ),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
            before_json, after_json, reason, created_at)
        SELECT ?, ?, shift.store_id, 'UPDATE_DAILY_SHIFT', 'DAILY_SHIFT', shift.id, ?,
          ?, ?, ?, ?
        FROM daily_shift_definitions shift
        WHERE shift.id = ? AND shift.store_id = ? AND shift.status = 'ACTIVE'
          AND shift.version = ? AND shift.updated_at = ?`)
        .bind(
          `daily-shift-audit:update:${input.id}:${input.expectedVersion + 1}`,
          input.actorId, `Sửa ${input.values.name} ngày ${input.values.workDate}`,
          JSON.stringify(before), JSON.stringify(after), reason, input.now,
          input.id, input.storeId, input.expectedVersion + 1, input.now,
        ),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: daily_shift_definitions/iu.test(error instanceof Error ? error.message : String(error))) {
      throw new DailyShiftConflictError("DUPLICATE");
    }
    if (/UNIQUE constraint failed: audit_logs\.id/iu.test(error instanceof Error ? error.message : String(error))) {
      throw new DailyShiftConflictError("STALE");
    }
    throw error;
  }
  if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1) {
    if (!await storeIsActive(db, input.storeId)) throw new DailyShiftConflictError("INACTIVE");
    if (!await actorCanManageStore(db, input.actorId, input.storeId)) throw new DailyShiftConflictError("FORBIDDEN");
    if (await isStorePeriodLocked(db, input.storeId, input.values.workDate.slice(0, 7))) throw new DailyShiftConflictError("LOCKED");
    throw new DailyShiftConflictError("STALE");
  }
  return { id: input.id, version: input.expectedVersion + 1 };
}

export async function deleteDailyShift(db: D1Database, input: {
  id: string;
  storeId: string;
  actorId: string;
  expectedVersion: number;
  now: string;
  reason: string;
}) {
  const before = await getDailyShift(db, input.id);
  const reason = normalizeDailyShiftMutationReason(input.reason);
  if (!reason) throw new TypeError("Daily shift delete reason is required");
  const after = before ? {
    ...before,
    status: "DELETED",
    version: input.expectedVersion + 1,
    updatedAt: input.now,
    deletedAt: input.now,
  } : null;
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(`UPDATE daily_shift_definitions SET
        status = 'DELETED', version = version + 1, updated_at = ?, deleted_at = ?
      WHERE id = ? AND store_id = ? AND status = 'ACTIVE' AND version = ?
        AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND status = 'ACTIVE')
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.role = 'MANAGER'
            AND (actor.is_super_admin = 1 OR actor.store_id IS NULL OR actor.store_id = ?)
        )
        AND ${storePeriodUnlockedSql("daily_shift_definitions.store_id", "substr(daily_shift_definitions.work_date, 1, 7)")}`)
      .bind(input.now, input.now, input.id, input.storeId, input.expectedVersion,
        input.storeId, input.actorId, input.storeId),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
            before_json, after_json, reason, created_at)
        SELECT ?, ?, shift.store_id, 'DELETE_DAILY_SHIFT', 'DAILY_SHIFT', shift.id, ?,
          ?, ?, ?, ?
        FROM daily_shift_definitions shift
        WHERE shift.id = ? AND shift.store_id = ? AND shift.status = 'DELETED'
          AND shift.version = ? AND shift.updated_at = ? AND shift.deleted_at = ?`)
        .bind(
          `daily-shift-audit:delete:${input.id}:${input.expectedVersion + 1}`,
          input.actorId, `Xóa ca ngày ${before?.workDate ?? ""}`,
          JSON.stringify(before), JSON.stringify(after), reason, input.now,
          input.id, input.storeId, input.expectedVersion + 1, input.now, input.now,
        ),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: audit_logs\.id/iu.test(error instanceof Error ? error.message : String(error))) {
      throw new DailyShiftConflictError("STALE");
    }
    throw error;
  }
  if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1) {
    if (!await storeIsActive(db, input.storeId)) throw new DailyShiftConflictError("INACTIVE");
    if (!await actorCanManageStore(db, input.actorId, input.storeId)) throw new DailyShiftConflictError("FORBIDDEN");
    if (before?.workDate && await isStorePeriodLocked(db, input.storeId, before.workDate.slice(0, 7))) throw new DailyShiftConflictError("LOCKED");
    throw new DailyShiftConflictError("STALE");
  }
  return { id: input.id, version: input.expectedVersion + 1 };
}
