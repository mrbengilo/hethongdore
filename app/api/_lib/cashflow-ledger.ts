/**
 * Append-only actual-money ledger. Accounting profit must continue to use the
 * originating business records; this module deliberately exposes no sum API.
 */

export type CashflowDirection = "IN" | "OUT";

export type CashflowEntryInput = {
  id?: string;
  storeId: string;
  direction: CashflowDirection;
  amount: number;
  category: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
  createdBy: string;
  clientRequestId: string;
  note?: string | null;
  reversesEntryId?: string | null;
  createdAt?: string;
};

export type CashflowLedgerEntry = {
  id: string;
  storeId: string;
  direction: CashflowDirection;
  amount: number;
  category: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
  createdBy: string;
  note: string | null;
  createdAt: string;
  clientRequestId: string;
  payloadHash: string;
  reversesEntryId: string | null;
};

export type AppendCashflowEntryResult = {
  entry: CashflowLedgerEntry;
  created: boolean;
};

type ExistingCashflowRow = {
  id: string;
  storeId: string;
  direction: CashflowDirection;
  amount: number;
  category: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
  createdBy: string;
  note: string | null;
  createdAt: string;
  clientRequestId: string;
  payloadHash: string;
  reversesEntryId: string | null;
};

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

export class CashflowLedgerConflictError extends Error {
  readonly code = "CASHFLOW_IDEMPOTENCY_CONFLICT";

  constructor(message = "Cashflow source or request was already used with a different payload") {
    super(message);
    this.name = "CashflowLedgerConflictError";
  }
}

export class CashflowLedgerLockedError extends Error {
  readonly code = "CASHFLOW_PERIOD_LOCKED";

  constructor(message = "The financial period is locked") {
    super(message);
    this.name = "CashflowLedgerLockedError";
  }
}

function requiredText(value: unknown, field: string, maxLength = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} is required and must be at most ${maxLength} characters`);
  }
  return normalized;
}

function canonicalIso(value: unknown, field: string) {
  const normalized = requiredText(value, field, 40);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new TypeError(`${field} must be a canonical UTC ISO timestamp`);
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().filter((key) => source[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizedNote(value: unknown) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (normalized.length > 2_000) throw new TypeError("note must be at most 2000 characters");
  return normalized || null;
}

/** Build and hash before constructing a caller-owned atomic db.batch. */
export async function buildCashflowEntry(input: CashflowEntryInput): Promise<CashflowLedgerEntry> {
  const storeId = requiredText(input.storeId, "storeId");
  const direction = input.direction;
  if (direction !== "IN" && direction !== "OUT") throw new TypeError("direction must be IN or OUT");
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new TypeError("amount must be a positive safe integer in VND");
  }
  const category = requiredText(input.category, "category");
  const sourceType = requiredText(input.sourceType, "sourceType");
  const sourceId = requiredText(input.sourceId, "sourceId");
  const occurredAt = canonicalIso(input.occurredAt, "occurredAt");
  const createdBy = requiredText(input.createdBy, "createdBy");
  const clientRequestId = requiredText(input.clientRequestId, "clientRequestId");
  if (!requestIdPattern.test(clientRequestId)) {
    throw new TypeError("clientRequestId must be 16-200 URL-safe characters");
  }
  const reversesEntryId = input.reversesEntryId == null
    ? null
    : requiredText(input.reversesEntryId, "reversesEntryId");
  if (reversesEntryId !== null && (sourceType !== "REVERSAL" || sourceId !== reversesEntryId)) {
    throw new TypeError("A cashflow reversal must use sourceType REVERSAL and sourceId equal to reversesEntryId");
  }
  if (reversesEntryId === null && sourceType === "REVERSAL") {
    throw new TypeError("A REVERSAL cashflow entry must reference the original entry");
  }
  const note = normalizedNote(input.note);
  const createdAt = canonicalIso(input.createdAt ?? new Date().toISOString(), "createdAt");
  const payloadHash = await sha256(canonicalJson({
    amount: input.amount,
    category,
    direction,
    note,
    occurredAt,
    reversesEntryId,
    sourceId,
    sourceType,
    storeId,
  }));
  const deterministicId = `cashflow-${await sha256(`${storeId}\u0000${sourceType}\u0000${sourceId}`)}`;
  return {
    id: input.id == null ? deterministicId : requiredText(input.id, "id"),
    storeId,
    direction,
    amount: input.amount,
    category,
    sourceType,
    sourceId,
    occurredAt,
    createdBy,
    note,
    createdAt,
    clientRequestId,
    payloadHash,
    reversesEntryId,
  };
}

/** Prepared statement only; callers may include it with business + audit writes in db.batch. */
function cashflowEntryBindings(entry: CashflowLedgerEntry) {
  return [
    entry.id,
    entry.storeId,
    entry.direction,
    entry.amount,
    entry.category,
    entry.sourceType,
    entry.sourceId,
    entry.occurredAt,
    entry.createdBy,
    entry.note,
    entry.createdAt,
    entry.clientRequestId,
    entry.payloadHash,
    entry.reversesEntryId,
  ];
}

export function prepareCashflowEntryInsert(db: D1Database, entry: CashflowLedgerEntry) {
  return db.prepare(`INSERT OR IGNORE INTO cashflow_entries
      (id, store_id, direction, amount, category, source_type, source_id, occurred_at,
        created_by, note, created_at, client_request_id, payload_hash, reverses_entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(...cashflowEntryBindings(entry));
}

/**
 * Gate a ledger insert on the same source mutation token used in db.batch.
 * `guardSql` is internal application SQL (never request text); guard values
 * remain bound. This prevents a stale/no-op source UPDATE from emitting money.
 */
export function prepareCashflowEntryInsertWhere(
  db: D1Database,
  entry: CashflowLedgerEntry,
  guardSql: string,
  guardBindings: unknown[] = [],
) {
  const normalizedGuard = guardSql.trim();
  if (!normalizedGuard || normalizedGuard.includes(";")) {
    throw new TypeError("guardSql must be one internal SQL predicate");
  }
  return db.prepare(`INSERT OR IGNORE INTO cashflow_entries
      (id, store_id, direction, amount, category, source_type, source_id, occurred_at,
        created_by, note, created_at, client_request_id, payload_hash, reverses_entry_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (${normalizedGuard})`)
    .bind(...cashflowEntryBindings(entry), ...guardBindings);
}

/** Same SQL shape, but fails before db.batch when a reversal link was omitted. */
export function prepareCashflowReversalInsert(db: D1Database, entry: CashflowLedgerEntry) {
  if (!entry.reversesEntryId) throw new TypeError("A cashflow reversal must reference the original entry");
  return prepareCashflowEntryInsert(db, entry);
}

export function prepareCashflowReversalInsertWhere(
  db: D1Database,
  entry: CashflowLedgerEntry,
  guardSql: string,
  guardBindings: unknown[] = [],
) {
  if (!entry.reversesEntryId) throw new TypeError("A cashflow reversal must reference the original entry");
  return prepareCashflowEntryInsertWhere(db, entry, guardSql, guardBindings);
}

function rowToEntry(row: ExistingCashflowRow): CashflowLedgerEntry {
  return { ...row };
}

async function findIdempotentEntry(db: D1Database, entry: CashflowLedgerEntry) {
  return db.prepare(`SELECT id, store_id AS storeId, direction, amount, category,
      source_type AS sourceType, source_id AS sourceId, occurred_at AS occurredAt,
      created_by AS createdBy, note, created_at AS createdAt,
      client_request_id AS clientRequestId, payload_hash AS payloadHash,
      reverses_entry_id AS reversesEntryId
    FROM cashflow_entries
    WHERE store_id = ? AND (
      (source_type = ? AND source_id = ?)
      OR (created_by = ? AND client_request_id = ?)
    )
    ORDER BY CASE WHEN source_type = ? AND source_id = ? THEN 0 ELSE 1 END, id
    LIMIT 1`)
    .bind(
      entry.storeId,
      entry.sourceType,
      entry.sourceId,
      entry.createdBy,
      entry.clientRequestId,
      entry.sourceType,
      entry.sourceId,
    )
    .first<ExistingCashflowRow>();
}

function normalizeDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/cashflow idempotency conflict|UNIQUE constraint failed: cashflow_entries\.(?:store_id|id)/iu.test(message)) {
    throw new CashflowLedgerConflictError();
  }
  if (/LOCKED financial period/iu.test(message)) throw new CashflowLedgerLockedError();
  throw error;
}

/** Convenience wrapper; multi-write APIs should prefer the prepared builder. */
export async function appendCashflowEntry(
  db: D1Database,
  input: CashflowEntryInput,
): Promise<AppendCashflowEntryResult> {
  const entry = await buildCashflowEntry(input);
  const existing = await findIdempotentEntry(db, entry);
  if (existing) {
    if (existing.payloadHash !== entry.payloadHash) throw new CashflowLedgerConflictError();
    return { entry: rowToEntry(existing), created: false };
  }
  try {
    const result = await prepareCashflowEntryInsert(db, entry).run();
    if ((result.meta?.changes ?? 0) > 0) return { entry, created: true };
  } catch (error) {
    normalizeDatabaseError(error);
  }
  const concurrent = await findIdempotentEntry(db, entry);
  if (concurrent?.payloadHash === entry.payloadHash) {
    return { entry: rowToEntry(concurrent), created: false };
  }
  throw new CashflowLedgerConflictError();
}
