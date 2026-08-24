import type { initDb } from "../../../db/runtime";
import {
  DEFAULT_MANAGER_KPI_RATE_BASIS_POINTS,
  isSafeKpiRateBasisPoints,
  isSafeManagerSalary,
  normalizeEmployeeKpiTiers,
  validatePayrollPolicyCombination,
  type EmployeeKpiTierPolicy,
  type PayrollPolicySnapshot,
} from "../../lib/payroll-policy";
import { loadPayrollPolicy } from "./payroll-policy";

type Db = Awaited<ReturnType<typeof initDb>>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type ProfitSharingMemberPolicy = Readonly<{
  memberId: string;
  name: string;
  rateBasisPoints: number;
}>;

export type FinancialPolicy = Readonly<{
  schemaVersion: 1;
  managerMonthlySalaryVnd: number;
  managerKpiRateBasisPoints: number;
  employeeKpiTiers: readonly EmployeeKpiTierPolicy[];
  allowances: JsonObject;
  profitSharingMembers: readonly ProfitSharingMemberPolicy[];
}>;

export type FinancialPolicyVersionRow = {
  id: string;
  version: number;
  effectiveFromPeriod: string;
  policyJson: string;
  createdBy: string;
  createdAt: string;
  supersededAt: string | null;
};

export type FinancialPolicyVersion = Readonly<{
  id: string;
  version: number;
  effectiveFromPeriod: string;
  policy: FinancialPolicy;
  policyJson: string;
  createdBy: string;
  createdAt: string;
  supersededAt: string | null;
}>;

export type FinancialPolicyExtensions = Readonly<{
  allowances?: JsonObject;
  profitSharingMembers?: readonly ProfitSharingMemberPolicy[];
}>;

export const TIKTOK_ALLOWANCE_POLICY_KEY = "TIKTOK";

/**
 * Return the versioned per-shift TikTok allowance. Missing legacy policy data
 * is intentionally reported as null instead of silently applying a code
 * constant; an administrator must persist the business value before it can be
 * used as a default for new employees.
 */
export function financialPolicyTikTokAllowanceVnd(
  policy: Pick<FinancialPolicy, "allowances">,
): number | null {
  const entry = policy.allowances[TIKTOK_ALLOWANCE_POLICY_KEY];
  if (!isRecord(entry)) return null;
  const amount = entry.amountVnd;
  return Number.isSafeInteger(amount) && Number(amount) >= 0 ? Number(amount) : null;
}

const INVALID_JSON = Symbol("INVALID_JSON");
const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const LEGACY_ADAPTER_ACTOR = "SYSTEM_FINANCIAL_POLICY_ADAPTER";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): JsonValue | typeof INVALID_JSON {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_JSON;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const normalized = cloneJsonValue(item);
      if (normalized === INVALID_JSON) return INVALID_JSON;
      result.push(normalized);
    }
    return result;
  }
  if (!isRecord(value)) return INVALID_JSON;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return INVALID_JSON;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return INVALID_JSON;
    const normalized = cloneJsonValue(item);
    if (normalized === INVALID_JSON) return INVALID_JSON;
    result[key] = normalized;
  }
  return result;
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreezeJson(item);
    Object.freeze(value);
  }
  return value;
}

function normalizeJsonObject(value: unknown): JsonObject | null {
  const normalized = cloneJsonValue(value);
  if (normalized === INVALID_JSON || !isRecord(normalized)) return null;
  return deepFreezeJson(normalized as JsonObject);
}

export function normalizeProfitSharingMembers(value: unknown): readonly ProfitSharingMemberPolicy[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 20) return null;
  const members: ProfitSharingMemberPolicy[] = [];
  const memberIds = new Set<string>();
  let totalRateBasisPoints = 0;
  for (const item of value) {
    if (!isRecord(item)) return null;
    const memberId = typeof item.memberId === "string" ? item.memberId.trim() : "";
    // Older versioned rows only carried memberId. Preserve their readability
    // while every newly saved policy persists an explicit display name.
    const name = typeof item.name === "string" && item.name.trim().length > 0
      ? item.name.trim()
      : memberId;
    const rateBasisPoints = item.rateBasisPoints;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/u.test(memberId)
      || name.length < 1 || name.length > 160
      || !Number.isSafeInteger(rateBasisPoints) || Number(rateBasisPoints) < 0 || Number(rateBasisPoints) > 10_000
      || memberIds.has(memberId)) return null;
    memberIds.add(memberId);
    totalRateBasisPoints += Number(rateBasisPoints);
    members.push(Object.freeze({ memberId, name, rateBasisPoints: Number(rateBasisPoints) }));
  }
  // An empty list explicitly means “not configured”. Once configured, every
  // distributable VND must have exactly one destination across all members.
  if (members.length > 0 && totalRateBasisPoints !== 10_000) return null;
  return Object.freeze(members);
}

export function isFinancialPeriod(value: unknown): value is string {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

export function normalizeFinancialPolicy(value: unknown): FinancialPolicy | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isSafeManagerSalary(value.managerMonthlySalaryVnd)) {
    return null;
  }
  if (!isSafeKpiRateBasisPoints(value.managerKpiRateBasisPoints)) return null;
  const employeeKpiTiers = normalizeEmployeeKpiTiers(value.employeeKpiTiers);
  const allowances = normalizeJsonObject(value.allowances);
  const profitSharingMembers = normalizeProfitSharingMembers(value.profitSharingMembers);
  if (!employeeKpiTiers || !allowances || !profitSharingMembers
    || !validatePayrollPolicyCombination(value.managerKpiRateBasisPoints, employeeKpiTiers)) return null;

  return Object.freeze({
    schemaVersion: 1,
    managerMonthlySalaryVnd: Number(value.managerMonthlySalaryVnd),
    managerKpiRateBasisPoints: Number(value.managerKpiRateBasisPoints),
    employeeKpiTiers: Object.freeze(employeeKpiTiers.map((tier) => Object.freeze({ ...tier }))),
    allowances,
    profitSharingMembers,
  });
}

export function serializeFinancialPolicy(policy: FinancialPolicy): string {
  const normalized = normalizeFinancialPolicy(policy);
  if (!normalized) throw new TypeError("Financial policy is invalid");
  return JSON.stringify({
    schemaVersion: normalized.schemaVersion,
    managerMonthlySalaryVnd: normalized.managerMonthlySalaryVnd,
    managerKpiRateBasisPoints: normalized.managerKpiRateBasisPoints,
    employeeKpiTiers: normalized.employeeKpiTiers,
    allowances: normalized.allowances,
    profitSharingMembers: normalized.profitSharingMembers,
  });
}

export function parseFinancialPolicy(policyJson: string): FinancialPolicy | null {
  try {
    return normalizeFinancialPolicy(JSON.parse(policyJson));
  } catch {
    return null;
  }
}

export function financialPolicyFromPayrollSnapshot(
  payrollPolicy: PayrollPolicySnapshot,
  extensions: FinancialPolicyExtensions = {},
): FinancialPolicy {
  const policy = normalizeFinancialPolicy({
    schemaVersion: 1,
    managerMonthlySalaryVnd: payrollPolicy.managerMonthlySalaryVnd,
    managerKpiRateBasisPoints: payrollPolicy.managerKpiRateBasisPoints
      ?? DEFAULT_MANAGER_KPI_RATE_BASIS_POINTS,
    employeeKpiTiers: payrollPolicy.employeeKpiTiers,
    allowances: extensions.allowances ?? {},
    profitSharingMembers: extensions.profitSharingMembers ?? [],
  });
  if (!policy) throw new TypeError("Current payroll policy cannot be adapted to a financial policy");
  return policy;
}

export function parseFinancialPolicyVersionRow(value: unknown): FinancialPolicyVersion | null {
  if (!isRecord(value)
    || typeof value.id !== "string" || value.id.trim().length === 0
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || !isFinancialPeriod(value.effectiveFromPeriod)
    || typeof value.policyJson !== "string"
    || typeof value.createdBy !== "string" || value.createdBy.trim().length === 0
    || typeof value.createdAt !== "string" || value.createdAt.trim().length === 0
    || (value.supersededAt !== null && typeof value.supersededAt !== "string")) return null;
  const policy = parseFinancialPolicy(value.policyJson);
  if (!policy) return null;
  return Object.freeze({
    id: value.id,
    version: Number(value.version),
    effectiveFromPeriod: value.effectiveFromPeriod,
    policy,
    policyJson: value.policyJson,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    supersededAt: value.supersededAt,
  });
}

async function selectFinancialPolicyVersion(db: Db, period: string) {
  return db.prepare(`SELECT
      id,
      version,
      effective_from_period AS effectiveFromPeriod,
      policy_json AS policyJson,
      created_by AS createdBy,
      created_at AS createdAt,
      superseded_at AS supersededAt
    FROM financial_policy_versions
    WHERE effective_from_period <= ?
    ORDER BY effective_from_period DESC, version DESC
    LIMIT 1`)
    .bind(period)
    .first<FinancialPolicyVersionRow>();
}

function requireParsedVersion(row: FinancialPolicyVersionRow | null | undefined) {
  if (!row) return null;
  const parsed = parseFinancialPolicyVersionRow(row);
  if (!parsed) throw new Error("Financial policy version is invalid");
  return parsed;
}

export async function loadFinancialPolicyForPeriod(
  db: Db,
  period: string,
  options: Readonly<{ createdBy?: string; now?: string }> = {},
): Promise<FinancialPolicyVersion> {
  if (!isFinancialPeriod(period)) throw new TypeError("Financial period must use YYYY-MM format");

  const existing = requireParsedVersion(await selectFinancialPolicyVersion(db, period));
  if (existing) return existing;

  // Legacy defaults are resolved exclusively by the existing payroll-policy
  // adapter. This layer copies resolved values and never defines rates itself.
  const payrollPolicy = await loadPayrollPolicy(db);
  const policy = financialPolicyFromPayrollSnapshot(payrollPolicy);
  const createdBy = (options.createdBy ?? payrollPolicy.updatedBy ?? LEGACY_ADAPTER_ACTOR).trim();
  if (!createdBy) throw new TypeError("Financial policy creator is required");
  const createdAt = options.now ?? new Date().toISOString();
  if (typeof createdAt !== "string" || !createdAt.trim()) throw new TypeError("Financial policy timestamp is required");

  const id = `financial-policy-legacy-${period}-v${payrollPolicy.version}`;
  const policyJson = serializeFinancialPolicy(policy);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nextVersionRow = await db.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS nextVersion FROM financial_policy_versions",
    ).first<{ nextVersion: number }>();
    const nextVersion = Number(nextVersionRow?.nextVersion);
    if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) {
      throw new RangeError("Next financial policy version is invalid");
    }

    await db.prepare(`INSERT OR IGNORE INTO financial_policy_versions
        (id, version, effective_from_period, policy_json, created_by, created_at, superseded_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .bind(id, nextVersion, period, policyJson, createdBy, createdAt)
      .run();

    // Always re-read the effective policy. This makes concurrent bootstrap
    // calls idempotent. A retry also handles an unrelated version winning the
    // unique-number race while this policy was being inserted.
    const inserted = requireParsedVersion(await selectFinancialPolicyVersion(db, period));
    if (inserted) return inserted;
  }
  throw new Error("Financial policy version could not be initialized");
}
