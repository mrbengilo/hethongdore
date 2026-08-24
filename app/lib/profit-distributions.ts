import { parsePersistedFinancialPeriodSnapshot } from "../api/_lib/financial-period";
import { multiplyRatioVnd, requireVnd } from "./finance";

export type ProfitDistributionErrorCode =
  | "INVALID_INPUT"
  | "MISSING_PERIOD"
  | "PERIOD_NOT_LOCKED"
  | "CORRUPT_SNAPSHOT"
  | "POLICY_MISMATCH"
  | "POLICY_NOT_CONFIGURED"
  | "ALREADY_CLOSED"
  | "INTEGRITY_ERROR"
  | "ATOMIC_WRITE_FAILED";

export class ProfitDistributionError extends Error {
  constructor(
    public readonly code: ProfitDistributionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfitDistributionError";
  }
}

export type DistributionJsonPrimitive = string | number | boolean | null;
export type DistributionJsonValue =
  | DistributionJsonPrimitive
  | DistributionJsonObject
  | readonly DistributionJsonValue[];
export type DistributionJsonObject = Readonly<{ [key: string]: DistributionJsonValue }>;

export type ProfitDistributionStore = Readonly<{
  storeId: string;
  storeName: string;
  financialPeriodId: string;
  financialPeriodRevision: number;
  policyVersionId: string;
  configVersion: number;
  finalProfit: number;
  distributableProfit: number;
  financialSnapshot: DistributionJsonObject;
  ordinal: number;
}>;

export type ProfitDistributionMember = Readonly<{
  memberId: string;
  name: string;
  rateBasisPoints: number;
  amount: number;
  memberSnapshot: DistributionJsonObject;
  ordinal: number;
}>;

export type ProfitDistributionPreview = Readonly<{
  period: string;
  policyVersionId: string;
  configVersion: number;
  policySnapshot: DistributionJsonObject;
  totalFinalProfit: number;
  totalDistributableProfit: number;
  stores: readonly ProfitDistributionStore[];
  members: readonly ProfitDistributionMember[];
}>;

export type ProfitDistributionRecord = ProfitDistributionPreview & Readonly<{
  id: string;
  status: "LOCKED";
  closedBy: string;
  closedAt: string;
  reason: string;
  createdAt: string;
}>;

export type ProfitDistributionSummary = Readonly<{
  id: string;
  period: string;
  status: "LOCKED";
  policyVersionId: string;
  configVersion: number;
  totalFinalProfit: number;
  totalDistributableProfit: number;
  storeCount: number;
  memberCount: number;
  closedBy: string;
  closedAt: string;
  reason: string;
}>;

type RawLockedPeriodRow = {
  id: unknown;
  storeId: unknown;
  storeName: unknown;
  status: unknown;
  period: unknown;
  policyVersionId: unknown;
  configVersion: unknown;
  revision: unknown;
  finalProfit: unknown;
  distributableProfit: unknown;
  snapshotJson: unknown;
  lockedAt: unknown;
  lockedBy: unknown;
};

type RawPolicyRow = {
  id: unknown;
  version: unknown;
  effectiveFromPeriod: unknown;
  policyJson: unknown;
};

type RawDistributionHeader = {
  id: unknown;
  period: unknown;
  status: unknown;
  policyVersionId: unknown;
  configVersion: unknown;
  policySnapshotJson: unknown;
  totalFinalProfit: unknown;
  totalDistributableProfit: unknown;
  storeCount: unknown;
  memberCount: unknown;
  closedBy: unknown;
  closedAt: unknown;
  reason: unknown;
  createdAt: unknown;
};

const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const BASIS_POINT_DENOMINATOR = 10_000;

function fail(code: ProfitDistributionErrorCode, message: string, cause?: unknown): never {
  throw new ProfitDistributionError(code, message, cause === undefined ? undefined : { cause });
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_INPUT", `${field} is required`);
  return value.trim();
}

function requiredPeriod(value: unknown) {
  if (typeof value !== "string" || !PERIOD_PATTERN.test(value)) {
    fail("INVALID_INPUT", "period must use YYYY-MM format");
  }
  return value;
}

function safeInteger(value: unknown, field: string, options: Readonly<{ negative?: boolean; positive?: boolean }> = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || (!options.negative && value < 0) || (options.positive && value <= 0)) {
    fail("INTEGRITY_ERROR", `${field} must be a safe integer`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string) {
  if (typeof value !== "string") fail("INTEGRITY_ERROR", `${field} must be a canonical timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("INTEGRITY_ERROR", `${field} must be a canonical timestamp`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value: unknown, field: string): DistributionJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => cloneJson(item, `${field}[${index}]`)));
  if (!isPlainObject(value)) fail("INTEGRITY_ERROR", `${field} must contain JSON values only`);
  const result: Record<string, DistributionJsonValue> = Object.create(null) as Record<string, DistributionJsonValue>;
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      fail("INTEGRITY_ERROR", `${field} contains an unsafe property`);
    }
    result[key] = cloneJson(item, `${field}.${key}`);
  }
  return Object.freeze(result);
}

function jsonObject(value: unknown, field: string): DistributionJsonObject {
  const cloned = cloneJson(value, field);
  if (!isPlainObject(cloned)) {
    fail("INTEGRITY_ERROR", `${field} must be a JSON object`);
  }
  return cloned as DistributionJsonObject;
}

function parseJsonObject(value: unknown, field: string) {
  if (typeof value !== "string") fail("INTEGRITY_ERROR", `${field} must be persisted JSON`);
  try {
    return jsonObject(JSON.parse(value) as unknown, field);
  } catch (error) {
    if (error instanceof ProfitDistributionError) throw error;
    return fail("INTEGRITY_ERROR", `${field} is not valid JSON`, error);
  }
}

function safeSignedSum(values: readonly number[], field: string) {
  const total = values.reduce((sum, value) => sum + BigInt(requireVnd(value, field, true)), 0n);
  const result = Number(total);
  if (!Number.isSafeInteger(result)) fail("INTEGRITY_ERROR", `${field} exceeds the safe integer range`);
  return result;
}

function normalizeMember(
  value: unknown,
  ordinal: number,
): Omit<ProfitDistributionMember, "amount"> {
  const snapshot = jsonObject(value, `profitSharingMembers[${ordinal}]`);
  const memberId = requiredString(snapshot.memberId, `profitSharingMembers[${ordinal}].memberId`);
  const name = requiredString(
    snapshot.name ?? snapshot.displayName ?? snapshot.memberName ?? memberId,
    `profitSharingMembers[${ordinal}].name`,
  );
  const rateBasisPoints = safeInteger(
    snapshot.rateBasisPoints,
    `profitSharingMembers[${ordinal}].rateBasisPoints`,
  );
  if (rateBasisPoints > BASIS_POINT_DENOMINATOR) {
    fail("POLICY_NOT_CONFIGURED", `profitSharingMembers[${ordinal}].rateBasisPoints cannot exceed 10000`);
  }
  return Object.freeze({ memberId, name, rateBasisPoints, memberSnapshot: snapshot, ordinal });
}

function membersFromPolicy(policy: DistributionJsonObject) {
  const values = policy.profitSharingMembers;
  if (!Array.isArray(values) || values.length === 0) {
    fail("POLICY_NOT_CONFIGURED", "Profit-sharing members have not been configured for this policy version");
  }
  const members = values.map((value, ordinal) => normalizeMember(value, ordinal));
  const ids = new Set<string>();
  let totalRate = 0;
  for (const member of members) {
    if (ids.has(member.memberId)) fail("POLICY_NOT_CONFIGURED", `Duplicate profit-sharing member: ${member.memberId}`);
    ids.add(member.memberId);
    totalRate += member.rateBasisPoints;
  }
  if (totalRate !== BASIS_POINT_DENOMINATOR) {
    fail("POLICY_NOT_CONFIGURED", "Profit-sharing member rates must total exactly 10000 basis points");
  }
  return Object.freeze(members);
}

/** Exact integer-VND allocation with deterministic cumulative rounding. */
export function allocateProfitSharingMembers(
  totalDistributableProfit: number,
  members: readonly Omit<ProfitDistributionMember, "amount">[],
): readonly ProfitDistributionMember[] {
  const total = requireVnd(totalDistributableProfit, "totalDistributableProfit");
  if (members.length === 0) fail("POLICY_NOT_CONFIGURED", "At least one profit-sharing member is required");
  let cumulativeRate = 0;
  let allocated = 0;
  return Object.freeze(members.map((member) => {
    cumulativeRate += member.rateBasisPoints;
    const target = multiplyRatioVnd(total, cumulativeRate, BASIS_POINT_DENOMINATOR);
    const amount = target - allocated;
    allocated = target;
    return Object.freeze({ ...member, amount });
  }));
}

function lockedStoreFromRow(row: RawLockedPeriodRow, expectedPeriod: string): ProfitDistributionStore {
  const storeId = requiredString(row.storeId, "financial_periods.store_id");
  const storeName = requiredString(row.storeName, `stores[${storeId}].name`);
  const financialPeriodId = requiredString(row.id, `financial_periods[${storeId}].id`);
  if (row.status !== "LOCKED") {
    fail("PERIOD_NOT_LOCKED", `Store ${storeName} does not have a LOCKED financial period for ${expectedPeriod}`);
  }
  if (row.period !== expectedPeriod) fail("CORRUPT_SNAPSHOT", `Store ${storeName} has the wrong financial period`);
  const policyVersionId = requiredString(row.policyVersionId, `financial_periods[${storeId}].policy_version_id`);
  const configVersion = safeInteger(row.configVersion, `financial_periods[${storeId}].config_version`, { positive: true });
  const financialPeriodRevision = safeInteger(row.revision, `financial_periods[${storeId}].revision`);
  const finalProfit = safeInteger(row.finalProfit, `financial_periods[${storeId}].final_profit`, { negative: true });
  const distributableProfit = safeInteger(row.distributableProfit, `financial_periods[${storeId}].distributable_profit`);
  if (distributableProfit !== Math.max(0, finalProfit)) {
    fail("CORRUPT_SNAPSHOT", `Store ${storeName} has a non-canonical distributable profit`);
  }
  const financialSnapshot = parseJsonObject(row.snapshotJson, `financial_periods[${storeId}].snapshot_json`);
  let parsedSnapshot;
  try {
    parsedSnapshot = parsePersistedFinancialPeriodSnapshot(financialSnapshot);
  } catch (error) {
    return fail("CORRUPT_SNAPSHOT", `Store ${storeName} has a corrupt financial snapshot`, error);
  }
  if (parsedSnapshot.status !== "LOCKED"
    || parsedSnapshot.storeId !== storeId
    || parsedSnapshot.period !== expectedPeriod
    || parsedSnapshot.configVersion !== configVersion
    || parsedSnapshot.finance.finalProfit !== finalProfit
    || parsedSnapshot.finance.distributableProfit !== distributableProfit
    || financialSnapshot.policyVersionId !== policyVersionId
    || parsedSnapshot.lockedAt !== row.lockedAt
    || parsedSnapshot.lockedBy !== row.lockedBy) {
    fail("CORRUPT_SNAPSHOT", `Store ${storeName} snapshot does not match its locked normalized row`);
  }
  return Object.freeze({
    storeId,
    storeName,
    financialPeriodId,
    financialPeriodRevision,
    policyVersionId,
    configVersion,
    finalProfit,
    distributableProfit,
    financialSnapshot,
    ordinal: -1,
  });
}

async function loadPolicy(
  db: D1Database,
  policyVersionId: string,
  configVersion: number,
  period: string,
) {
  const row = await db.prepare(`SELECT id, version, effective_from_period AS effectiveFromPeriod,
      policy_json AS policyJson
    FROM financial_policy_versions WHERE id = ? LIMIT 1`)
    .bind(policyVersionId)
    .first<RawPolicyRow>();
  if (!row) fail("POLICY_MISMATCH", `Financial policy ${policyVersionId} is missing`);
  if (row.id !== policyVersionId || row.version !== configVersion) {
    fail("POLICY_MISMATCH", "The locked financial period policy version does not match its config version");
  }
  const effectiveFromPeriod = requiredPeriod(row.effectiveFromPeriod);
  if (effectiveFromPeriod > period) fail("POLICY_MISMATCH", "The locked policy was not effective for this period");
  const policySnapshot = parseJsonObject(row.policyJson, "financial_policy_versions.policy_json");
  if (policySnapshot.schemaVersion !== 1) fail("POLICY_MISMATCH", "Financial policy schemaVersion must be 1");
  return Object.freeze({ policySnapshot, members: membersFromPolicy(policySnapshot) });
}

/**
 * Preview a close from canonical LOCKED store snapshots only. Current live
 * expenses, payroll or policy values are never consulted.
 */
export async function previewProfitDistribution(
  db: D1Database,
  periodInput: string,
): Promise<ProfitDistributionPreview> {
  const period = requiredPeriod(periodInput);
  const [periodResult, expectedStoreResult] = await Promise.all([
    db.prepare(`SELECT period_row.id, period_row.store_id AS storeId, store.name AS storeName,
        period_row.status, period_row.period, period_row.policy_version_id AS policyVersionId,
        period_row.config_version AS configVersion, period_row.revision,
        period_row.final_profit AS finalProfit,
        period_row.distributable_profit AS distributableProfit,
        period_row.snapshot_json AS snapshotJson, period_row.locked_at AS lockedAt,
        period_row.locked_by AS lockedBy
      FROM financial_periods period_row
      INNER JOIN stores store ON store.id = period_row.store_id
      WHERE period_row.period = ? ORDER BY period_row.store_id`)
      .bind(period)
      .all<RawLockedPeriodRow>(),
    db.prepare("SELECT id FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY id")
      .all<{ id: string }>(),
  ]);
  const rows = periodResult.results;
  if (rows.length === 0) fail("MISSING_PERIOD", `No financial periods exist for ${period}`);
  const presentStoreIds = new Set(rows.map((row) => String(row.storeId)));
  const missing = expectedStoreResult.results.map((row) => row.id).filter((id) => !presentStoreIds.has(id));
  if (missing.length > 0) {
    fail("MISSING_PERIOD", `Missing financial period for stores: ${missing.join(", ")}`);
  }

  const stores = rows.map((row, ordinal) => Object.freeze({ ...lockedStoreFromRow(row, period), ordinal }));
  const policyVersionId = stores[0].policyVersionId;
  const configVersion = stores[0].configVersion;
  if (stores.some((store) => store.policyVersionId !== policyVersionId || store.configVersion !== configVersion)) {
    fail("POLICY_MISMATCH", "All store snapshots in a distribution must use the same policy/config version");
  }
  const { policySnapshot, members: policyMembers } = await loadPolicy(db, policyVersionId, configVersion, period);
  const totalFinalProfit = safeSignedSum(stores.map((store) => store.finalProfit), "totalFinalProfit");
  const totalDistributableProfit = safeSignedSum(
    stores.map((store) => store.distributableProfit),
    "totalDistributableProfit",
  );
  const members = allocateProfitSharingMembers(totalDistributableProfit, policyMembers);
  return Object.freeze({
    period,
    policyVersionId,
    configVersion,
    policySnapshot,
    totalFinalProfit,
    totalDistributableProfit,
    stores: Object.freeze(stores),
    members,
  });
}

function headerFromRow(row: RawDistributionHeader) {
  const status = row.status;
  if (status !== "LOCKED") fail("INTEGRITY_ERROR", "Persisted profit distribution status must be LOCKED");
  return Object.freeze({
    id: requiredString(row.id, "profit_distributions.id"),
    period: requiredPeriod(row.period),
    status,
    policyVersionId: requiredString(row.policyVersionId, "profit_distributions.policy_version_id"),
    configVersion: safeInteger(row.configVersion, "profit_distributions.config_version", { positive: true }),
    policySnapshot: parseJsonObject(row.policySnapshotJson, "profit_distributions.policy_snapshot_json"),
    totalFinalProfit: safeInteger(row.totalFinalProfit, "profit_distributions.total_final_profit", { negative: true }),
    totalDistributableProfit: safeInteger(row.totalDistributableProfit, "profit_distributions.total_distributable_profit"),
    storeCount: safeInteger(row.storeCount, "profit_distributions.store_count", { positive: true }),
    memberCount: safeInteger(row.memberCount, "profit_distributions.member_count", { positive: true }),
    closedBy: requiredString(row.closedBy, "profit_distributions.closed_by"),
    closedAt: canonicalTimestamp(row.closedAt, "profit_distributions.closed_at"),
    reason: requiredString(row.reason, "profit_distributions.reason"),
    createdAt: canonicalTimestamp(row.createdAt, "profit_distributions.created_at"),
  });
}

/** Strict immutable-ledger read. Any count, formula or allocation drift fails closed. */
export async function readProfitDistribution(
  db: D1Database,
  periodInput: string,
): Promise<ProfitDistributionRecord | null> {
  const period = requiredPeriod(periodInput);
  const headerRow = await db.prepare(`SELECT id, period, status,
      policy_version_id AS policyVersionId, config_version AS configVersion,
      policy_snapshot_json AS policySnapshotJson, total_final_profit AS totalFinalProfit,
      total_distributable_profit AS totalDistributableProfit, store_count AS storeCount,
      member_count AS memberCount, closed_by AS closedBy, closed_at AS closedAt,
      reason, created_at AS createdAt
    FROM profit_distributions WHERE period = ? LIMIT 1`)
    .bind(period)
    .first<RawDistributionHeader>();
  if (!headerRow) return null;
  const header = headerFromRow(headerRow);
  const [storeResult, memberResult] = await Promise.all([
    db.prepare(`SELECT store_id AS storeId, store_name_snapshot AS storeName,
        financial_period_id AS financialPeriodId,
        financial_period_revision AS financialPeriodRevision,
        policy_version_id AS policyVersionId, config_version AS configVersion,
        final_profit AS finalProfit, distributable_profit AS distributableProfit,
        financial_snapshot_json AS financialSnapshotJson, ordinal
      FROM profit_distribution_stores WHERE distribution_id = ? ORDER BY ordinal`)
      .bind(header.id)
      .all<Record<string, unknown>>(),
    db.prepare(`SELECT member_id AS memberId, member_name_snapshot AS memberName,
        rate_basis_points AS rateBasisPoints, amount,
        member_snapshot_json AS memberSnapshotJson, ordinal
      FROM profit_distribution_members WHERE distribution_id = ? ORDER BY ordinal`)
      .bind(header.id)
      .all<Record<string, unknown>>(),
  ]);
  if (storeResult.results.length !== header.storeCount || memberResult.results.length !== header.memberCount) {
    fail("INTEGRITY_ERROR", "Profit distribution row counts do not match the immutable header");
  }

  const stores = storeResult.results.map((row, ordinal) => {
    if (row.ordinal !== ordinal) fail("INTEGRITY_ERROR", "Profit distribution store ordinals are not contiguous");
    const storeId = requiredString(row.storeId, `profit_distribution_stores[${ordinal}].store_id`);
    const financialSnapshot = parseJsonObject(
      row.financialSnapshotJson,
      `profit_distribution_stores[${ordinal}].financial_snapshot_json`,
    );
    const finalProfit = safeInteger(row.finalProfit, `profit_distribution_stores[${ordinal}].final_profit`, { negative: true });
    const distributableProfit = safeInteger(row.distributableProfit, `profit_distribution_stores[${ordinal}].distributable_profit`);
    const configVersion = safeInteger(row.configVersion, `profit_distribution_stores[${ordinal}].config_version`, { positive: true });
    const policyVersionId = requiredString(row.policyVersionId, `profit_distribution_stores[${ordinal}].policy_version_id`);
    let parsed;
    try {
      parsed = parsePersistedFinancialPeriodSnapshot(financialSnapshot);
    } catch (error) {
      return fail("INTEGRITY_ERROR", `Profit distribution store ${storeId} contains a corrupt snapshot`, error);
    }
    if (parsed.status !== "LOCKED" || parsed.storeId !== storeId || parsed.period !== header.period
      || parsed.configVersion !== configVersion || parsed.finance.finalProfit !== finalProfit
      || parsed.finance.distributableProfit !== distributableProfit
      || financialSnapshot.policyVersionId !== policyVersionId
      || policyVersionId !== header.policyVersionId || configVersion !== header.configVersion
      || distributableProfit !== Math.max(0, finalProfit)) {
      fail("INTEGRITY_ERROR", `Profit distribution store ${storeId} does not match its source snapshot`);
    }
    return Object.freeze({
      storeId,
      storeName: requiredString(row.storeName, `profit_distribution_stores[${ordinal}].store_name_snapshot`),
      financialPeriodId: requiredString(row.financialPeriodId, `profit_distribution_stores[${ordinal}].financial_period_id`),
      financialPeriodRevision: safeInteger(row.financialPeriodRevision, `profit_distribution_stores[${ordinal}].financial_period_revision`),
      policyVersionId,
      configVersion,
      finalProfit,
      distributableProfit,
      financialSnapshot,
      ordinal,
    });
  });

  const policyMembers = membersFromPolicy(header.policySnapshot);
  const expectedMembers = allocateProfitSharingMembers(header.totalDistributableProfit, policyMembers);
  const members = memberResult.results.map((row, ordinal) => {
    if (row.ordinal !== ordinal) fail("INTEGRITY_ERROR", "Profit distribution member ordinals are not contiguous");
    const snapshot = parseJsonObject(row.memberSnapshotJson, `profit_distribution_members[${ordinal}].member_snapshot_json`);
    const normalized = normalizeMember(snapshot, ordinal);
    const expected = expectedMembers[ordinal];
    const amount = safeInteger(row.amount, `profit_distribution_members[${ordinal}].amount`);
    if (!expected || normalized.memberId !== row.memberId || normalized.name !== row.memberName
      || normalized.rateBasisPoints !== row.rateBasisPoints
      || expected.memberId !== normalized.memberId || expected.amount !== amount) {
      fail("INTEGRITY_ERROR", `Profit distribution member ${ordinal} does not match its policy snapshot`);
    }
    return Object.freeze({ ...normalized, amount });
  });

  if (safeSignedSum(stores.map((store) => store.finalProfit), "totalFinalProfit") !== header.totalFinalProfit
    || safeSignedSum(stores.map((store) => store.distributableProfit), "totalDistributableProfit") !== header.totalDistributableProfit
    || safeSignedSum(members.map((member) => member.amount), "memberAllocation") !== header.totalDistributableProfit) {
    fail("INTEGRITY_ERROR", "Profit distribution totals do not reconcile");
  }
  return Object.freeze({
    id: header.id,
    period: header.period,
    status: "LOCKED",
    policyVersionId: header.policyVersionId,
    configVersion: header.configVersion,
    policySnapshot: header.policySnapshot,
    totalFinalProfit: header.totalFinalProfit,
    totalDistributableProfit: header.totalDistributableProfit,
    stores: Object.freeze(stores),
    members: Object.freeze(members),
    closedBy: header.closedBy,
    closedAt: header.closedAt,
    reason: header.reason,
    createdAt: header.createdAt,
  });
}

export async function listProfitDistributions(
  db: D1Database,
  options: Readonly<{ limit?: number; beforePeriod?: string }> = {},
): Promise<readonly ProfitDistributionSummary[]> {
  const limit = options.limit === undefined ? 24 : safeInteger(options.limit, "limit", { positive: true });
  if (limit > 100) fail("INVALID_INPUT", "limit cannot exceed 100");
  const beforePeriod = options.beforePeriod === undefined ? null : requiredPeriod(options.beforePeriod);
  const result = await db.prepare(`SELECT id, period, status,
      policy_version_id AS policyVersionId, config_version AS configVersion,
      total_final_profit AS totalFinalProfit,
      total_distributable_profit AS totalDistributableProfit, store_count AS storeCount,
      member_count AS memberCount, closed_by AS closedBy, closed_at AS closedAt, reason
    FROM profit_distributions
    WHERE (? IS NULL OR period < ?)
    ORDER BY period DESC LIMIT ?`)
    .bind(beforePeriod, beforePeriod, limit)
    .all<Record<string, unknown>>();
  return Object.freeze(result.results.map((row) => {
    if (row.status !== "LOCKED") fail("INTEGRITY_ERROR", "Profit distribution history contains a non-LOCKED row");
    return Object.freeze({
      id: requiredString(row.id, "profit_distributions.id"),
      period: requiredPeriod(row.period),
      status: "LOCKED" as const,
      policyVersionId: requiredString(row.policyVersionId, "profit_distributions.policy_version_id"),
      configVersion: safeInteger(row.configVersion, "profit_distributions.config_version", { positive: true }),
      totalFinalProfit: safeInteger(row.totalFinalProfit, "profit_distributions.total_final_profit", { negative: true }),
      totalDistributableProfit: safeInteger(row.totalDistributableProfit, "profit_distributions.total_distributable_profit"),
      storeCount: safeInteger(row.storeCount, "profit_distributions.store_count", { positive: true }),
      memberCount: safeInteger(row.memberCount, "profit_distributions.member_count", { positive: true }),
      closedBy: requiredString(row.closedBy, "profit_distributions.closed_by"),
      closedAt: canonicalTimestamp(row.closedAt, "profit_distributions.closed_at"),
      reason: requiredString(row.reason, "profit_distributions.reason"),
    });
  }));
}

function generatedId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export async function closeProfitDistribution(
  db: D1Database,
  input: Readonly<{
    period: string;
    actorId: string;
    reason: string;
    now?: Date | string;
    id?: string;
    auditId?: string;
  }>,
): Promise<ProfitDistributionRecord> {
  const period = requiredPeriod(input.period);
  const actorId = requiredString(input.actorId, "actorId");
  const reason = requiredString(input.reason, "reason");
  const nowValue = input.now instanceof Date ? input.now.toISOString() : input.now ?? new Date().toISOString();
  const now = canonicalTimestamp(nowValue, "now");
  const existing = await readProfitDistribution(db, period);
  if (existing) fail("ALREADY_CLOSED", `Profit distribution ${period} is already closed`);
  const preview = await previewProfitDistribution(db, period);
  const id = input.id ? requiredString(input.id, "id") : generatedId(`profit-distribution:${period}`);
  const auditId = input.auditId ? requiredString(input.auditId, "auditId") : generatedId("audit:profit-distribution");
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO profit_distributions
      (id, period, status, policy_version_id, config_version, policy_snapshot_json,
       total_final_profit, total_distributable_profit, store_count, member_count,
       closed_by, closed_at, reason, created_at)
      VALUES (?, ?, 'LOCKED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        id,
        period,
        preview.policyVersionId,
        preview.configVersion,
        JSON.stringify(preview.policySnapshot),
        preview.totalFinalProfit,
        preview.totalDistributableProfit,
        preview.stores.length,
        preview.members.length,
        actorId,
        now,
        reason,
        now,
      ),
  ];
  for (const store of preview.stores) {
    statements.push(db.prepare(`INSERT INTO profit_distribution_stores
      (id, distribution_id, store_id, store_name_snapshot, financial_period_id,
       financial_period_revision, policy_version_id, config_version, final_profit,
       distributable_profit, financial_snapshot_json, ordinal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        `${id}:store:${store.ordinal}`,
        id,
        store.storeId,
        store.storeName,
        store.financialPeriodId,
        store.financialPeriodRevision,
        store.policyVersionId,
        store.configVersion,
        store.finalProfit,
        store.distributableProfit,
        JSON.stringify(store.financialSnapshot),
        store.ordinal,
      ));
  }
  for (const member of preview.members) {
    statements.push(db.prepare(`INSERT INTO profit_distribution_members
      (id, distribution_id, member_id, member_name_snapshot, rate_basis_points,
       amount, member_snapshot_json, ordinal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        `${id}:member:${member.ordinal}`,
        id,
        member.memberId,
        member.name,
        member.rateBasisPoints,
        member.amount,
        JSON.stringify(member.memberSnapshot),
        member.ordinal,
      ));
  }
  const after = {
    id,
    period,
    status: "LOCKED",
    policyVersionId: preview.policyVersionId,
    configVersion: preview.configVersion,
    totalFinalProfit: preview.totalFinalProfit,
    totalDistributableProfit: preview.totalDistributableProfit,
    stores: preview.stores.map((store) => ({
      storeId: store.storeId,
      financialPeriodId: store.financialPeriodId,
      financialPeriodRevision: store.financialPeriodRevision,
      finalProfit: store.finalProfit,
      distributableProfit: store.distributableProfit,
    })),
    members: preview.members.map((member) => ({
      memberId: member.memberId,
      name: member.name,
      rateBasisPoints: member.rateBasisPoints,
      amount: member.amount,
    })),
    closedBy: actorId,
    closedAt: now,
  };
  statements.push(db.prepare(`INSERT INTO audit_logs
      (id, user_id, store_id, action, entity_type, entity_id, detail,
       before_json, after_json, reason, created_at)
    VALUES (?, ?, NULL, 'PROFIT_DISTRIBUTION_CLOSE', 'PROFIT_DISTRIBUTION', ?, ?,
      'null', ?, ?, ?)`)
    .bind(
      auditId,
      actorId,
      id,
      JSON.stringify({ period, storeCount: preview.stores.length, memberCount: preview.members.length }),
      JSON.stringify(after),
      reason,
      now,
    ));

  try {
    const results = await db.batch(statements);
    if (results.length !== statements.length || results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
      fail("ATOMIC_WRITE_FAILED", "Profit distribution close did not persist every immutable row and audit entry");
    }
  } catch (error) {
    if (error instanceof ProfitDistributionError) throw error;
    const conflict = await db.prepare("SELECT id FROM profit_distributions WHERE period = ? LIMIT 1")
      .bind(period)
      .first<{ id: string }>();
    if (conflict) fail("ALREADY_CLOSED", `Profit distribution ${period} is already closed`, error);
    fail("ATOMIC_WRITE_FAILED", "Profit distribution close was rolled back", error);
  }
  const record = await readProfitDistribution(db, period);
  if (!record) fail("ATOMIC_WRITE_FAILED", "Profit distribution close is missing after commit");
  return record;
}
