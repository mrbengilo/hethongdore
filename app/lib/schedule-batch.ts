export const SCHEDULE_BATCH_CATEGORY = "LICH_PHAN_CA_BATCH";

export type ScheduleBatchEntry = {
  id: string;
  title: string;
  data: Record<string, unknown>;
};

export type ScheduleBatchCommitInput = {
  markerId: string;
  storeId: string;
  ownerId: string;
  clientRequestId: string;
  payloadHash: string;
  date: string;
  entries: ScheduleBatchEntry[];
  now: string;
};

export type ScheduleBatchCommitResult =
  | { status: "CREATED"; entryIds: string[] }
  | { status: "IDEMPOTENT"; entryIds: string[] }
  | { status: "PAYLOAD_MISMATCH"; entryIds: string[] }
  | { status: "INCOMPLETE"; entryIds: string[] };

type MarkerRow = { dataJson: string; storeId: string | null };

export class ScheduleBatchConflictError extends Error {
  constructor() {
    super("Schedule batch conflicts with an existing assignment");
    this.name = "ScheduleBatchConflictError";
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

export function canonicalScheduleBatchPayload(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function scheduleBatchPayloadHash(value: unknown) {
  return sha256(canonicalScheduleBatchPayload(value));
}

export async function scheduleBatchMarkerId(storeId: string, clientRequestId: string) {
  return `schedule-batch-${await sha256(`${storeId}:${clientRequestId}`)}`;
}

export async function scheduleBatchEntryId(storeId: string, clientRequestId: string, shiftId: string) {
  return `schedule-${await sha256(`${storeId}:${clientRequestId}:${shiftId}`)}`;
}

export async function inspectScheduleBatch(
  db: D1Database,
  input: ScheduleBatchCommitInput,
): Promise<ScheduleBatchCommitResult | null> {
  const marker = await db.prepare(`SELECT store_id AS storeId, data_json AS dataJson
    FROM business_records WHERE id = ? AND category = ? LIMIT 1`)
    .bind(input.markerId, SCHEDULE_BATCH_CATEGORY).first<MarkerRow>();
  if (!marker) return null;

  let data: Record<string, unknown> = {};
  try { data = JSON.parse(marker.dataJson) as Record<string, unknown>; } catch { return { status: "INCOMPLETE", entryIds: [] }; }
  const markerEntryIds = Array.isArray(data.entryIds) ? data.entryIds.map(String) : [];
  if (marker.storeId !== input.storeId
    || data.clientRequestId !== input.clientRequestId
    || data.payloadHash !== input.payloadHash) {
    return { status: "PAYLOAD_MISMATCH", entryIds: markerEntryIds };
  }

  const expectedIds = input.entries.map((entry) => entry.id).sort();
  if (markerEntryIds.length !== expectedIds.length
    || markerEntryIds.slice().sort().some((id, index) => id !== expectedIds[index])) {
    return { status: "INCOMPLETE", entryIds: markerEntryIds };
  }
  const placeholders = expectedIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT id, data_json AS dataJson FROM business_records
    WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND id IN (${placeholders}) AND status != 'DELETED'`)
    .bind(input.storeId, ...expectedIds).all<{ id: string; dataJson: string }>();
  if (rows.results.length !== expectedIds.length) return { status: "INCOMPLETE", entryIds: markerEntryIds };
  for (const row of rows.results) {
    try {
      const entryData = JSON.parse(row.dataJson) as Record<string, unknown>;
      if (entryData.batchRequestId !== input.clientRequestId || entryData.batchPayloadHash !== input.payloadHash) {
        return { status: "INCOMPLETE", entryIds: markerEntryIds };
      }
    } catch {
      return { status: "INCOMPLETE", entryIds: markerEntryIds };
    }
  }
  return { status: "IDEMPOTENT", entryIds: expectedIds };
}

/**
 * D1 batch and the local SQLite adapter are transactional. The marker is the
 * serialization point: a concurrent retry either observes the complete first
 * batch or rolls back before writing any schedule entry.
 */
export async function commitScheduleBatch(
  db: D1Database,
  input: ScheduleBatchCommitInput,
): Promise<ScheduleBatchCommitResult> {
  const existing = await inspectScheduleBatch(db, input);
  if (existing) return existing;

  const entryIds = input.entries.map((entry) => entry.id);
  const markerData = JSON.stringify({
    clientRequestId: input.clientRequestId,
    payloadHash: input.payloadHash,
    date: input.date,
    entryIds,
    entryCount: entryIds.length,
  });
  const employeeIds = [...new Set(input.entries.flatMap((entry) => Array.isArray(entry.data.employeeIds)
    ? entry.data.employeeIds.map(String)
    : []))];
  if (employeeIds.length === 0) throw new ScheduleBatchConflictError();
  const period = input.date.slice(0, 7);
  const ranges = input.entries.map((entry) => ({
    startAt: String(entry.data.startAt ?? ""),
    endAt: String(entry.data.endAt ?? ""),
  }));
  const overlapSql = ranges.map(() => `(json_extract(existing.data_json, '$.startAt') < ?
        AND json_extract(existing.data_json, '$.endAt') > ?)`).join(" OR ");
  const conflictGuard = employeeIds.length && ranges.every((range) => range.startAt && range.endAt)
    ? `AND NOT EXISTS (
      SELECT 1 FROM business_records existing
      WHERE existing.category = 'LICH_PHAN_CA'
        AND existing.store_id = ?
        AND existing.status NOT IN ('DELETED', 'VOID')
        AND EXISTS (
          SELECT 1 FROM json_each(json_extract(existing.data_json, '$.employeeIds')) assigned
          WHERE assigned.value IN (SELECT value FROM json_each(?))
        )
        AND (${overlapSql})
    )`
    : "";
  const dailyDefinitions = input.entries.flatMap((entry) => {
    const version = Number(entry.data.shiftDefinitionVersion);
    if (!Number.isInteger(version) || version < 1) return [];
    return [{
      id: String(entry.data.shiftId ?? ""),
      workDate: String(entry.data.date ?? ""),
      name: String(entry.data.shiftName ?? ""),
      start: String(entry.data.start ?? ""),
      end: String(entry.data.end ?? ""),
      version,
    }];
  });
  const dailyDefinitionGuard = dailyDefinitions.map(() => `AND EXISTS (
      SELECT 1 FROM daily_shift_definitions daily_shift
      WHERE daily_shift.id = ? AND daily_shift.store_id = ? AND daily_shift.work_date = ?
        AND daily_shift.name = ? AND daily_shift.start_time = ? AND daily_shift.end_time = ?
        AND daily_shift.version = ? AND daily_shift.status = 'ACTIVE'
    )`).join(" ");
  // These predicates are deliberately attached to the marker INSERT, which is
  // the batch serialization point. A store deletion/deactivation, manager
  // reassignment, employee move/deactivation or period close that commits
  // after route validation but before this batch therefore makes every
  // statement in this batch inert.
  const invariantGuard = `AND EXISTS (
      SELECT 1 FROM stores schedule_store
      WHERE schedule_store.id = ? AND schedule_store.status = 'ACTIVE'
    )
    AND EXISTS (
      SELECT 1 FROM users schedule_actor
      WHERE schedule_actor.id = ? AND schedule_actor.role = 'MANAGER'
        AND (schedule_actor.is_super_admin = 1 OR schedule_actor.store_id IS NULL OR schedule_actor.store_id = ?)
    )
    AND (
      SELECT COUNT(DISTINCT eligible_employee.id)
      FROM employees eligible_employee
      WHERE eligible_employee.status = 'ACTIVE'
        AND eligible_employee.id IN (SELECT value FROM json_each(?))
        AND (
          eligible_employee.store_id = ? OR EXISTS (
            SELECT 1 FROM employee_transfers eligible_transfer
            WHERE eligible_transfer.employee_id = eligible_employee.id
              AND eligible_transfer.target_store_id = ?
              AND eligible_transfer.status IN ('SCHEDULED', 'ACTIVE')
              AND eligible_transfer.start_date <= ? AND eligible_transfer.end_date >= ?
          )
        )
    ) = ?
    AND NOT EXISTS (
      SELECT 1 FROM (SELECT ? AS store_id, ? AS period) schedule_scope
      WHERE EXISTS (
        SELECT 1 FROM business_records store_period_lock
        WHERE store_period_lock.category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING')
          AND store_period_lock.store_id = schedule_scope.store_id
          AND COALESCE(store_period_lock.status, '') != 'DELETED'
          AND json_extract(store_period_lock.data_json, '$.period') = schedule_scope.period
      ) OR EXISTS (
        SELECT 1 FROM employee_payroll_closings employee_period_lock
        WHERE employee_period_lock.store_id = schedule_scope.store_id
          AND employee_period_lock.period = schedule_scope.period
          AND COALESCE(employee_period_lock.status, '') != 'DELETED'
      )
    )`;
  const markerStatement = db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?
      WHERE 1 = 1 ${invariantGuard} ${conflictGuard} ${dailyDefinitionGuard}`)
    .bind(
      input.markerId,
      SCHEDULE_BATCH_CATEGORY,
      input.storeId,
      input.ownerId,
      `Lô lịch phân ca ${input.date}`,
      markerData,
      input.now,
      input.now,
      input.storeId,
      input.ownerId,
      input.storeId,
      JSON.stringify(employeeIds),
      input.storeId,
      input.storeId,
      input.date,
      input.date,
      employeeIds.length,
      input.storeId,
      period,
      ...(conflictGuard ? [input.storeId, JSON.stringify(employeeIds), ...ranges.flatMap((range) => [range.endAt, range.startAt])] : []),
      ...dailyDefinitions.flatMap((definition) => [
        definition.id, input.storeId, definition.workDate, definition.name,
        definition.start, definition.end, definition.version,
      ]),
    );
  const statements = [
    markerStatement,
    ...input.entries.map((entry) => db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      SELECT ?, 'LICH_PHAN_CA', ?, ?, ?, ?, 'ACTIVE', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM business_records marker
        WHERE marker.id = ? AND marker.category = ? AND marker.store_id = ?
          AND json_extract(marker.data_json, '$.clientRequestId') = ?
          AND json_extract(marker.data_json, '$.payloadHash') = ?
      )`)
      .bind(
        entry.id,
        input.storeId,
        input.ownerId,
        entry.title,
        JSON.stringify(entry.data),
        input.now,
        input.now,
        input.markerId,
        SCHEDULE_BATCH_CATEGORY,
        input.storeId,
        input.clientRequestId,
        input.payloadHash,
      )),
  ];

  try {
    const results = await db.batch(statements);
    if (Number(results[0]?.meta?.changes ?? 0) === 0) throw new ScheduleBatchConflictError();
    return { status: "CREATED", entryIds };
  } catch (error) {
    const raced = await inspectScheduleBatch(db, input);
    if (raced) return raced;
    throw error;
  }
}
