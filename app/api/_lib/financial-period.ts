import {
  FINANCE_COMPONENTS,
  calculateFinance,
  type FinanceEngineInput,
  type FinanceEngineResult,
} from "../../lib/finance-engine";

export const FINANCIAL_PERIOD_STATES = [
  "DRAFT",
  "CALCULATED",
  "RECONCILING",
  "CONFIRMED",
  "PAID",
  "LOCKED",
] as const;

export type FinancialPeriodStatus = (typeof FINANCIAL_PERIOD_STATES)[number];
export type SnapshotFinancialPeriodStatus = Extract<
  FinancialPeriodStatus,
  "CONFIRMED" | "PAID" | "LOCKED"
>;

const LEGAL_TRANSITIONS: Readonly<Record<FinancialPeriodStatus, FinancialPeriodStatus | null>> = Object.freeze({
  DRAFT: "CALCULATED",
  CALCULATED: "RECONCILING",
  RECONCILING: "CONFIRMED",
  CONFIRMED: "PAID",
  PAID: "LOCKED",
  LOCKED: null,
});

const SNAPSHOT_STATUSES = new Set<FinancialPeriodStatus>(["CONFIRMED", "PAID", "LOCKED"]);
const DERIVED_FINANCE_METRICS = [
  "operatingExpense",
  "operatingProfit",
  "kpiExpense",
  "profitAfterKpi",
  "totalExpense",
  "finalProfit",
  "distributableProfit",
] as const satisfies readonly (keyof FinanceEngineResult)[];

export type PersistedFinancialPeriodSnapshot = Readonly<{
  schemaVersion: 1;
  storeId: string;
  period: string;
  status: SnapshotFinancialPeriodStatus;
  configVersion: number;
  finance: FinanceEngineResult;
  confirmedAt: string;
  confirmedBy: string;
  paidAt: string | null;
  paidBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredObject(value: unknown, name: string) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function requiredSafeInteger(value: unknown, name: string, allowNegative = false) {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isSafeInteger(value)
    || (!allowNegative && value < 0)) {
    throw new TypeError(`${name} must be a finite ${allowNegative ? "" : "non-negative "}safe integer`);
  }
  return value;
}

function optionalCanonicalTimestamp(value: unknown, name: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be an ISO timestamp or null`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function optionalActor(value: unknown, name: string) {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function requiredPeriod(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new TypeError("period must use YYYY-MM format");
  }
  return value;
}

function snapshotStatus(value: unknown): SnapshotFinancialPeriodStatus {
  if (value === "CONFIRMED" || value === "PAID" || value === "LOCKED") return value;
  throw new TypeError("snapshot status must be CONFIRMED, PAID, or LOCKED");
}

function parseCanonicalFinance(value: unknown): FinanceEngineResult {
  const source = requiredObject(value, "finance");
  const components: Partial<Record<(typeof FINANCE_COMPONENTS)[number], number>> = {};
  for (const component of FINANCE_COMPONENTS) {
    components[component] = requiredSafeInteger(source[component], `finance.${component}`);
  }
  const canonical = calculateFinance(components as FinanceEngineInput);

  for (const metric of DERIVED_FINANCE_METRICS) {
    const persisted = requiredSafeInteger(source[metric], `finance.${metric}`, true);
    if (persisted !== canonical[metric]) {
      throw new TypeError(`finance.${metric} does not match the canonical Finance Engine result`);
    }
  }
  return canonical;
}

function requirePair(
  left: string | null,
  right: string | null,
  leftName: string,
  rightName: string,
) {
  if ((left === null) !== (right === null)) {
    throw new TypeError(`${leftName} and ${rightName} must be recorded together`);
  }
}

export function isFinancialPeriodStatus(value: unknown): value is FinancialPeriodStatus {
  return typeof value === "string" && (FINANCIAL_PERIOD_STATES as readonly string[]).includes(value);
}

export function canTransitionFinancialPeriod(from: FinancialPeriodStatus, to: FinancialPeriodStatus) {
  return LEGAL_TRANSITIONS[from] === to;
}

export function assertFinancialPeriodTransition(from: FinancialPeriodStatus, to: FinancialPeriodStatus) {
  if (!canTransitionFinancialPeriod(from, to)) {
    throw new Error(`Illegal financial period transition: ${from} -> ${to}`);
  }
}

/** Only a fully locked period is no longer directly mutable. */
export function isFinancialPeriodImmutable(status: FinancialPeriodStatus) {
  return status === "LOCKED";
}

export function usesPersistedFinancialSnapshot(status: FinancialPeriodStatus) {
  return SNAPSHOT_STATUSES.has(status);
}

/**
 * Draft calculation and reconciliation screens use live values. From
 * confirmation onward, an available persisted snapshot takes precedence.
 */
export function preferPersistedFinancialSnapshot<T>(
  status: FinancialPeriodStatus,
  liveValue: T,
  persistedValue: T | null | undefined,
) {
  return usesPersistedFinancialSnapshot(status) && persistedValue != null
    ? persistedValue
    : liveValue;
}

export function parsePersistedFinancialPeriodSnapshot(
  value: unknown,
): PersistedFinancialPeriodSnapshot {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      throw new TypeError("financial period snapshot must be valid JSON");
    }
  }
  const source = requiredObject(decoded, "financial period snapshot");
  if (source.schemaVersion !== 1) throw new TypeError("snapshot schemaVersion must be 1");

  const status = snapshotStatus(source.status);
  const confirmedAt = optionalCanonicalTimestamp(source.confirmedAt, "confirmedAt");
  const confirmedBy = optionalActor(source.confirmedBy, "confirmedBy");
  const paidAt = optionalCanonicalTimestamp(source.paidAt, "paidAt");
  const paidBy = optionalActor(source.paidBy, "paidBy");
  const lockedAt = optionalCanonicalTimestamp(source.lockedAt, "lockedAt");
  const lockedBy = optionalActor(source.lockedBy, "lockedBy");
  requirePair(confirmedAt, confirmedBy, "confirmedAt", "confirmedBy");
  requirePair(paidAt, paidBy, "paidAt", "paidBy");
  requirePair(lockedAt, lockedBy, "lockedAt", "lockedBy");

  if (confirmedAt === null || confirmedBy === null) {
    throw new TypeError("confirmedAt and confirmedBy are required for persisted snapshots");
  }
  if ((status === "PAID" || status === "LOCKED") && (paidAt === null || paidBy === null)) {
    throw new TypeError("paidAt and paidBy are required for PAID and LOCKED snapshots");
  }
  if (status === "LOCKED" && (lockedAt === null || lockedBy === null)) {
    throw new TypeError("lockedAt and lockedBy are required for LOCKED snapshots");
  }
  if (status === "CONFIRMED" && (paidAt !== null || lockedAt !== null)) {
    throw new TypeError("CONFIRMED snapshots cannot contain payment or lock metadata");
  }
  if (status === "PAID" && lockedAt !== null) {
    throw new TypeError("PAID snapshots cannot contain lock metadata");
  }
  if (paidAt !== null && paidAt < confirmedAt) {
    throw new TypeError("paidAt cannot be earlier than confirmedAt");
  }
  if (lockedAt !== null && (paidAt === null || lockedAt < paidAt)) {
    throw new TypeError("lockedAt cannot be earlier than paidAt");
  }

  return Object.freeze({
    schemaVersion: 1,
    storeId: requiredString(source.storeId, "storeId"),
    period: requiredPeriod(source.period),
    status,
    configVersion: requiredSafeInteger(source.configVersion, "configVersion"),
    finance: parseCanonicalFinance(source.finance),
    confirmedAt,
    confirmedBy,
    paidAt,
    paidBy,
    lockedAt,
    lockedBy,
  });
}

export function serializePersistedFinancialPeriodSnapshot(
  snapshot: PersistedFinancialPeriodSnapshot,
) {
  return JSON.stringify(parsePersistedFinancialPeriodSnapshot(snapshot));
}
