import {
  incomingStorePeriodUnlockedSql,
  isStorePeriodLocked,
  storePeriodUnlockedSql,
} from "../api/_lib/store-period-lock";
import { sumVnd } from "./finance";

const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/u;
const requestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/u;

export type MonthEndExpenseStatus = "ACTIVE" | "VOID";

export type MonthEndExpenseRow = {
  id: string;
  storeId: string;
  period: string;
  title: string;
  category: string;
  amount: number;
  note: string;
  status: MonthEndExpenseStatus;
  version: number;
  clientRequestId: string;
  payloadHash: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string;
  voidedBy: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
};

export type MonthEndExpenseDetails = {
  title: string;
  category: string;
  amount: number;
  note: string;
};

export type MonthEndExpenseValues = MonthEndExpenseDetails & {
  period: string;
};

type MonthEndExpenseConflictReason =
  | "FORBIDDEN"
  | "INACTIVE"
  | "LOCKED"
  | "NOT_FOUND"
  | "VOID"
  | "STALE"
  | "IDEMPOTENCY"
  | "CONFLICT";

export class MonthEndExpenseConflictError extends Error {
  constructor(public readonly reason: MonthEndExpenseConflictReason) {
    super(reason);
    this.name = "MonthEndExpenseConflictError";
  }
}

function normalizedText(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function normalizeMonthEndExpensePeriod(value: unknown) {
  const period = String(value ?? "").trim();
  return periodPattern.test(period) ? period : null;
}

export function normalizeMonthEndExpenseRequestId(value: unknown) {
  const requestId = String(value ?? "").trim();
  return requestIdPattern.test(requestId) ? requestId : null;
}

export function normalizeMonthEndExpenseReason(value: unknown) {
  const reason = normalizedText(value);
  return reason.length >= 5 && reason.length <= 500 ? reason : null;
}

export function monthEndExpenseDetails(source: Record<string, unknown>): MonthEndExpenseDetails | null {
  const title = normalizedText(source.title);
  const category = normalizedText(source.category);
  const note = normalizedText(source.note);
  const amount = Number(source.amount);
  if (title.length < 2 || title.length > 120) return null;
  if (category.length < 2 || category.length > 80) return null;
  if (note.length < 2 || note.length > 1_000) return null;
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return { title, category, amount, note };
}

export function monthEndExpenseValues(source: Record<string, unknown>): MonthEndExpenseValues | null {
  const period = normalizeMonthEndExpensePeriod(source.period);
  const details = monthEndExpenseDetails(source);
  return period && details ? { period, ...details } : null;
}

export function monthEndExpenseVersion(value: unknown) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function monthEndExpenseId(storeId: string, actorId: string, clientRequestId: string) {
  return `month-end-expense-${await sha256(`${storeId}\u0000${actorId}\u0000${clientRequestId}`)}`;
}

export async function monthEndExpensePayloadHash(input: {
  storeId: string;
  values: MonthEndExpenseValues;
}) {
  return sha256(JSON.stringify({
    storeId: input.storeId,
    period: input.values.period,
    title: input.values.title,
    category: input.values.category,
    amount: input.values.amount,
    note: input.values.note,
  }));
}

const selectMonthEndExpenseSql = `SELECT
    expense.id,
    expense.store_id AS storeId,
    expense.period,
    expense.title,
    expense.category,
    expense.amount,
    COALESCE(expense.note, '') AS note,
    expense.status,
    expense.version,
    expense.client_request_id AS clientRequestId,
    expense.payload_hash AS payloadHash,
    expense.created_by AS createdBy,
    COALESCE(creator.name, 'Tài khoản đã xóa') AS createdByName,
    expense.created_at AS createdAt,
    expense.updated_by AS updatedBy,
    CASE WHEN expense.updated_by IS NULL THEN NULL ELSE COALESCE(updater.name, 'Tài khoản đã xóa') END AS updatedByName,
    expense.updated_at AS updatedAt,
    expense.voided_by AS voidedBy,
    CASE WHEN expense.voided_by IS NULL THEN NULL ELSE COALESCE(voider.name, 'Tài khoản đã xóa') END AS voidedByName,
    expense.voided_at AS voidedAt
  FROM month_end_expenses expense
  LEFT JOIN users creator ON creator.id = expense.created_by
  LEFT JOIN users updater ON updater.id = expense.updated_by
  LEFT JOIN users voider ON voider.id = expense.voided_by`;

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

function sourceSnapshot(row: MonthEndExpenseRow) {
  return {
    id: row.id,
    storeId: row.storeId,
    period: row.period,
    title: row.title,
    category: row.category,
    amount: row.amount,
    note: row.note,
    status: row.status,
    version: row.version,
    clientRequestId: row.clientRequestId,
    payloadHash: row.payloadHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    voidedBy: row.voidedBy,
    voidedAt: row.voidedAt,
  };
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

async function getByRequest(db: D1Database, storeId: string, actorId: string, clientRequestId: string) {
  return db.prepare(`${selectMonthEndExpenseSql}
    WHERE expense.store_id = ? AND expense.created_by = ? AND expense.client_request_id = ?
    LIMIT 1`).bind(storeId, actorId, clientRequestId).first<MonthEndExpenseRow>();
}

export async function getMonthEndExpense(db: D1Database, id: string, storeId: string) {
  return db.prepare(`${selectMonthEndExpenseSql}
    WHERE expense.id = ? AND expense.store_id = ? LIMIT 1`)
    .bind(id, storeId).first<MonthEndExpenseRow>();
}

export async function listMonthEndExpenses(db: D1Database, storeId: string, period: string) {
  const rows = await db.prepare(`${selectMonthEndExpenseSql}
    WHERE expense.store_id = ? AND expense.period = ?
    ORDER BY expense.created_at DESC, expense.id DESC`)
    .bind(storeId, period).all<MonthEndExpenseRow>();
  const expenses = rows.results;
  const total = sumVnd(expenses
    .filter((expense) => expense.status === "ACTIVE")
    .map((expense) => expense.amount));
  return { expenses, total };
}

async function assertActiveStoreAndActor(db: D1Database, input: {
  storeId: string;
  actorId: string;
}) {
  if (!await storeIsActive(db, input.storeId)) throw new MonthEndExpenseConflictError("INACTIVE");
  if (!await actorCanManageStore(db, input.actorId, input.storeId)) throw new MonthEndExpenseConflictError("FORBIDDEN");
}

async function classifyCreateFailure(db: D1Database, input: {
  storeId: string;
  actorId: string;
  period: string;
}) {
  await assertActiveStoreAndActor(db, input);
  if (await isStorePeriodLocked(db, input.storeId, input.period)) throw new MonthEndExpenseConflictError("LOCKED");
}

async function classifyExistingMutationFailure(db: D1Database, input: {
  id: string;
  storeId: string;
  actorId: string;
  expectedVersion: number;
}, originalError?: unknown): Promise<never> {
  if (!await storeIsActive(db, input.storeId)) throw new MonthEndExpenseConflictError("INACTIVE");
  if (!await actorCanManageStore(db, input.actorId, input.storeId)) throw new MonthEndExpenseConflictError("FORBIDDEN");
  const current = await getMonthEndExpense(db, input.id, input.storeId);
  if (!current) throw new MonthEndExpenseConflictError("NOT_FOUND");
  if (current.status !== "ACTIVE") throw new MonthEndExpenseConflictError("VOID");
  if (await isStorePeriodLocked(db, input.storeId, current.period)) throw new MonthEndExpenseConflictError("LOCKED");
  if (current.version !== input.expectedVersion) throw new MonthEndExpenseConflictError("STALE");
  if (originalError) throw originalError;
  throw new MonthEndExpenseConflictError("CONFLICT");
}

export async function createMonthEndExpense(db: D1Database, input: {
  storeId: string;
  actorId: string;
  clientRequestId: string;
  values: MonthEndExpenseValues;
  now: string;
  reason?: string;
}) {
  await assertActiveStoreAndActor(db, input);
  const payloadHash = await monthEndExpensePayloadHash({ storeId: input.storeId, values: input.values });
  const existing = await getByRequest(db, input.storeId, input.actorId, input.clientRequestId);
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new MonthEndExpenseConflictError("IDEMPOTENCY");
    return { status: "IDEMPOTENT" as const, expense: existing };
  }
  if (await isStorePeriodLocked(db, input.storeId, input.values.period)) {
    throw new MonthEndExpenseConflictError("LOCKED");
  }

  const id = await monthEndExpenseId(input.storeId, input.actorId, input.clientRequestId);
  const reason = normalizeMonthEndExpenseReason(input.reason)
    ?? `Tạo chi phí cuối kỳ: ${input.values.title}`.slice(0, 500);
  const after = {
    id,
    storeId: input.storeId,
    ...input.values,
    status: "ACTIVE" as const,
    version: 1,
    clientRequestId: input.clientRequestId,
    payloadHash,
    createdBy: input.actorId,
    createdAt: input.now,
    updatedBy: input.actorId,
    updatedAt: input.now,
    voidedBy: null,
    voidedAt: null,
  };

  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO month_end_expenses
          (id, store_id, period, title, category, amount, note, status, version,
           client_request_id, payload_hash, created_by, created_at, updated_by, updated_at,
           voided_by, voided_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?, ?, ?, ?, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM stores WHERE id = ? AND status = 'ACTIVE')
          AND EXISTS (
            SELECT 1 FROM users actor
            WHERE actor.id = ? AND actor.role = 'MANAGER'
              AND (actor.is_super_admin = 1 OR actor.store_id IS NULL OR actor.store_id = ?)
          )
          AND ${incomingStorePeriodUnlockedSql}
        ON CONFLICT DO NOTHING`)
        .bind(
          id, input.storeId, input.values.period, input.values.title, input.values.category,
          input.values.amount, input.values.note, input.clientRequestId, payloadHash,
          input.actorId, input.now, input.actorId, input.now, input.storeId,
          input.actorId, input.storeId, input.storeId, input.values.period,
        ),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
           before_json, after_json, reason, created_at)
        VALUES (?, ?, ?, CASE WHEN changes() = 1 THEN 'CREATE_MONTH_END_EXPENSE' END,
          'MONTH_END_EXPENSE', ?, ?, NULL, ?, ?, ?)`)
        .bind(
          `month-end-expense-audit:create:${id}`,
          input.actorId, input.storeId, id, `Tạo chi phí cuối kỳ ${input.values.title}`,
          JSON.stringify(after), reason, input.now,
        ),
    ]);
    if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) {
      const expense = await getMonthEndExpense(db, id, input.storeId);
      if (expense) return { status: "CREATED" as const, expense };
    }
  } catch (error) {
    const replay = await getByRequest(db, input.storeId, input.actorId, input.clientRequestId);
    if (replay) {
      if (replay.payloadHash !== payloadHash) throw new MonthEndExpenseConflictError("IDEMPOTENCY");
      return { status: "IDEMPOTENT" as const, expense: replay };
    }
    await classifyCreateFailure(db, {
      storeId: input.storeId,
      actorId: input.actorId,
      period: input.values.period,
    });
    throw error;
  }
  throw new MonthEndExpenseConflictError("CONFLICT");
}

export async function updateMonthEndExpense(db: D1Database, input: {
  id: string;
  storeId: string;
  actorId: string;
  expectedVersion: number;
  values: MonthEndExpenseDetails;
  now: string;
  reason: string;
}) {
  const before = await getMonthEndExpense(db, input.id, input.storeId);
  if (!before) throw new MonthEndExpenseConflictError("NOT_FOUND");
  if (before.status !== "ACTIVE") throw new MonthEndExpenseConflictError("VOID");
  if (before.version !== input.expectedVersion) throw new MonthEndExpenseConflictError("STALE");
  const reason = normalizeMonthEndExpenseReason(input.reason);
  if (!reason) throw new TypeError("Month-end expense update reason is required");
  const after = {
    ...sourceSnapshot(before),
    ...input.values,
    version: input.expectedVersion + 1,
    updatedBy: input.actorId,
    updatedAt: input.now,
  };

  try {
    const results = await db.batch([
      db.prepare(`UPDATE month_end_expenses SET
          title = ?, category = ?, amount = ?, note = ?, version = version + 1,
          updated_by = ?, updated_at = ?
        WHERE id = ? AND store_id = ? AND status = 'ACTIVE' AND version = ?
          AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND status = 'ACTIVE')
          AND EXISTS (
            SELECT 1 FROM users actor
            WHERE actor.id = ? AND actor.role = 'MANAGER'
              AND (actor.is_super_admin = 1 OR actor.store_id IS NULL OR actor.store_id = ?)
          )
          AND ${storePeriodUnlockedSql("month_end_expenses.store_id", "month_end_expenses.period")}`)
        .bind(
          input.values.title, input.values.category, input.values.amount, input.values.note,
          input.actorId, input.now, input.id, input.storeId, input.expectedVersion,
          input.storeId, input.actorId, input.storeId,
        ),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
           before_json, after_json, reason, created_at)
        VALUES (?, ?, ?, CASE WHEN changes() = 1 THEN 'UPDATE_MONTH_END_EXPENSE' END,
          'MONTH_END_EXPENSE', ?, ?, ?, ?, ?, ?)`)
        .bind(
          `month-end-expense-audit:update:${input.id}:${input.expectedVersion + 1}`,
          input.actorId, input.storeId, input.id, `Sửa chi phí cuối kỳ ${before.title}`,
          JSON.stringify(sourceSnapshot(before)), JSON.stringify(after), reason, input.now,
        ),
    ]);
    if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) {
      const expense = await getMonthEndExpense(db, input.id, input.storeId);
      if (expense) return expense;
    }
  } catch (error) {
    return classifyExistingMutationFailure(db, input, error);
  }
  return classifyExistingMutationFailure(db, input);
}

export async function voidMonthEndExpense(db: D1Database, input: {
  id: string;
  storeId: string;
  actorId: string;
  expectedVersion: number;
  now: string;
  reason: string;
}) {
  const before = await getMonthEndExpense(db, input.id, input.storeId);
  if (!before) throw new MonthEndExpenseConflictError("NOT_FOUND");
  if (before.status !== "ACTIVE") throw new MonthEndExpenseConflictError("VOID");
  if (before.version !== input.expectedVersion) throw new MonthEndExpenseConflictError("STALE");
  const reason = normalizeMonthEndExpenseReason(input.reason);
  if (!reason) throw new TypeError("Month-end expense void reason is required");
  const after = {
    ...sourceSnapshot(before),
    status: "VOID" as const,
    version: input.expectedVersion + 1,
    updatedBy: input.actorId,
    updatedAt: input.now,
    voidedBy: input.actorId,
    voidedAt: input.now,
  };

  try {
    const results = await db.batch([
      db.prepare(`UPDATE month_end_expenses SET
          status = 'VOID', version = version + 1, updated_by = ?, updated_at = ?,
          voided_by = ?, voided_at = ?
        WHERE id = ? AND store_id = ? AND status = 'ACTIVE' AND version = ?
          AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND status = 'ACTIVE')
          AND EXISTS (
            SELECT 1 FROM users actor
            WHERE actor.id = ? AND actor.role = 'MANAGER'
              AND (actor.is_super_admin = 1 OR actor.store_id IS NULL OR actor.store_id = ?)
          )
          AND ${storePeriodUnlockedSql("month_end_expenses.store_id", "month_end_expenses.period")}`)
        .bind(
          input.actorId, input.now, input.actorId, input.now,
          input.id, input.storeId, input.expectedVersion, input.storeId,
          input.actorId, input.storeId,
        ),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
           before_json, after_json, reason, created_at)
        VALUES (?, ?, ?, CASE WHEN changes() = 1 THEN 'VOID_MONTH_END_EXPENSE' END,
          'MONTH_END_EXPENSE', ?, ?, ?, ?, ?, ?)`)
        .bind(
          `month-end-expense-audit:void:${input.id}:${input.expectedVersion + 1}`,
          input.actorId, input.storeId, input.id, `Hủy chi phí cuối kỳ ${before.title}`,
          JSON.stringify(sourceSnapshot(before)), JSON.stringify(after), reason, input.now,
        ),
    ]);
    if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) {
      const expense = await getMonthEndExpense(db, input.id, input.storeId);
      if (expense) return expense;
    }
  } catch (error) {
    return classifyExistingMutationFailure(db, input, error);
  }
  return classifyExistingMutationFailure(db, input);
}
