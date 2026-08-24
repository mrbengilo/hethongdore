import {
  FINANCE_COMPONENTS,
  calculateFinance,
  type FinanceEngineInput,
  type FinanceEngineResult,
} from "../../lib/finance-engine";
import {
  assertFinancialPeriodTransition,
  isFinancialPeriodStatus,
  parsePersistedFinancialPeriodSnapshot,
  type FinancialPeriodStatus,
  type SnapshotFinancialPeriodStatus,
} from "./financial-period";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type FinancialPeriodCalculationInput = Readonly<{
  policyVersionId: string;
  configVersion: number;
  finance: FinanceEngineInput;
  totalHoursSeconds: number;
  salaryAdvance: number;
  employeePayrollRows: readonly unknown[];
  managerPayroll: unknown;
  configSnapshot: unknown;
}>;

export type FinancialPeriodCalculationPayload = Readonly<{
  policyVersionId: string;
  configVersion: number;
  finance: FinanceEngineResult;
  totalHoursSeconds: number;
  salaryAdvance: number;
  employeePayrollRows: readonly JsonObject[];
  managerPayroll: JsonObject;
  configSnapshot: JsonObject;
}>;

/**
 * Complete, immutable payload persisted at CONFIRMED and carried forward to
 * PAID/LOCKED. The normalized JSON columns intentionally duplicate these
 * fields so old read models can migrate without creating another source of
 * truth.
 */
export type CanonicalFinancialPeriodSnapshot = Readonly<{
  schemaVersion: 1;
  storeId: string;
  period: string;
  status: SnapshotFinancialPeriodStatus;
  policyVersionId: string;
  configVersion: number;
  finance: FinanceEngineResult;
  totalHoursSeconds: number;
  salaryAdvance: number;
  employeePayrollRows: readonly JsonObject[];
  managerPayroll: JsonObject;
  configSnapshot: JsonObject;
  confirmedAt: string;
  confirmedBy: string;
  paidAt: string | null;
  paidBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
}>;

export type FinancialPeriodLifecycleRow = Readonly<{
  id: string;
  storeId: string;
  period: string;
  status: FinancialPeriodStatus;
  revision: number;
  calculation: FinancialPeriodCalculationPayload | null;
  snapshot: CanonicalFinancialPeriodSnapshot | null;
  calculatedAt: string | null;
  calculatedBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type FinancialPeriodDraftPlan = Readonly<{
  kind: "CREATE_DRAFT";
  id: string;
  storeId: string;
  period: string;
  statements: readonly [D1PreparedStatement, D1PreparedStatement];
  mutationStatementIndex: 0;
  auditStatementIndex: 1;
}>;

export type FinancialPeriodTransitionPlan = Readonly<{
  kind: "TRANSITION" | "RECALCULATE";
  id: string;
  storeId: string;
  period: string;
  fromStatus: FinancialPeriodStatus;
  toStatus: FinancialPeriodStatus;
  expectedRevision: number;
  nextRevision: number;
  next: FinancialPeriodLifecycleRow;
  statements: readonly [D1PreparedStatement, D1PreparedStatement];
  mutationStatementIndex: 0;
  auditStatementIndex: 1;
}>;

export class FinancialPeriodLifecycleConflictError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "STALE" | "INCOMPLETE_AUDIT",
    message: string,
  ) {
    super(message);
    this.name = "FinancialPeriodLifecycleConflictError";
  }
}

type RawFinancialPeriodRow = {
  id: unknown;
  storeId: unknown;
  period: unknown;
  status: unknown;
  policyVersionId: unknown;
  configVersion: unknown;
  revision: unknown;
  grossRevenue: unknown;
  fixedExpense: unknown;
  variableExpense: unknown;
  inventoryCost: unknown;
  inventoryShippingCost: unknown;
  employeeSalary: unknown;
  managerSalary: unknown;
  manualBonus: unknown;
  allowance: unknown;
  totalHoursSeconds: unknown;
  employeeKpiTotal: unknown;
  managerKpi: unknown;
  operatingProfit: unknown;
  profitAfterKpi: unknown;
  monthEndExpense: unknown;
  finalProfit: unknown;
  distributableProfit: unknown;
  salaryAdvance: unknown;
  employeePayrollRowsJson: unknown;
  managerPayrollJson: unknown;
  configSnapshotJson: unknown;
  snapshotJson: unknown;
  calculatedAt: unknown;
  calculatedBy: unknown;
  confirmedAt: unknown;
  confirmedBy: unknown;
  paidAt: unknown;
  paidBy: unknown;
  lockedAt: unknown;
  lockedBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

const CALCULATION_COLUMN_NAMES = [
  "policy_version_id",
  "config_version",
  "gross_revenue",
  "fixed_expense",
  "variable_expense",
  "inventory_cost",
  "inventory_shipping_cost",
  "employee_salary",
  "manager_salary",
  "manual_bonus",
  "allowance",
  "total_hours_seconds",
  "employee_kpi_total",
  "manager_kpi",
  "operating_profit",
  "profit_after_kpi",
  "month_end_expense",
  "final_profit",
  "distributable_profit",
  "salary_advance",
  "employee_payroll_rows_json",
  "manager_payroll_json",
  "config_snapshot_json",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function requiredPeriod(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new TypeError("period must use YYYY-MM format");
  }
  return value;
}

function safeInteger(value: unknown, name: string, options: { positive?: boolean } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || (options.positive ? value <= 0 : value < 0)) {
    throw new TypeError(`${name} must be a ${options.positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function integerFromDatabase(value: unknown, name: string, options: { positive?: boolean } = {}) {
  const parsed = typeof value === "number" ? value : Number(value);
  return safeInteger(parsed, name, options);
}

function signedIntegerFromDatabase(value: unknown, name: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} must be a safe integer`);
  return parsed;
}

function canonicalTimestamp(value: unknown, name: string) {
  const timestamp = requiredString(value, name);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function optionalString(value: unknown, name: string) {
  if (value === null || value === undefined) return null;
  return requiredString(value, name);
}

function optionalTimestamp(value: unknown, name: string) {
  if (value === null || value === undefined) return null;
  return canonicalTimestamp(value, name);
}

function normalizeJsonValue(value: unknown, name: string, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain only finite JSON numbers`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${name} must contain only JSON-compatible values`);
  if (seen.has(value)) throw new TypeError(`${name} must not contain circular references`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeJsonValue(entry, `${name}[${index}]`, seen));
    }
    if (!isPlainObject(value)) throw new TypeError(`${name} must contain only plain JSON objects`);
    const normalized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeJsonValue(entry, `${name}.${key}`, seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function normalizeJsonObject(value: unknown, name: string): JsonObject {
  const normalized = normalizeJsonValue(value, name, new Set());
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new TypeError(`${name} must be a JSON object`);
  }
  return Object.freeze(normalized);
}

function normalizePayrollRows(value: unknown, name: string): readonly JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return Object.freeze(value.map((row, index) => normalizeJsonObject(row, `${name}[${index}]`)));
}

function parseJson(value: unknown, name: string) {
  if (typeof value !== "string") throw new TypeError(`${name} must be serialized JSON`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${name} must be valid JSON`);
  }
}

function assertDerivedFinanceMatches(source: RawFinancialPeriodRow, finance: FinanceEngineResult) {
  for (const metric of [
    "operatingProfit",
    "profitAfterKpi",
    "finalProfit",
    "distributableProfit",
  ] as const) {
    if (signedIntegerFromDatabase(source[metric], metric) !== finance[metric]) {
      throw new TypeError(`${metric} does not match the canonical Finance Engine result`);
    }
  }
}

function calculationFromRaw(source: RawFinancialPeriodRow): FinancialPeriodCalculationPayload | null {
  if (source.policyVersionId === null || source.policyVersionId === undefined) return null;
  const financeInput = Object.fromEntries(FINANCE_COMPONENTS.map((component) => {
    const databaseName = component === "manualEmployeeBonus"
      ? "manualBonus"
      : component === "employeeAllowance"
        ? "allowance"
        : component;
    return [component, integerFromDatabase(source[databaseName as keyof RawFinancialPeriodRow], component)];
  })) as FinanceEngineInput;
  const finance = calculateFinance(financeInput);
  assertDerivedFinanceMatches(source, finance);
  return Object.freeze({
    policyVersionId: requiredString(source.policyVersionId, "policyVersionId"),
    configVersion: integerFromDatabase(source.configVersion, "configVersion", { positive: true }),
    finance,
    totalHoursSeconds: integerFromDatabase(source.totalHoursSeconds, "totalHoursSeconds"),
    salaryAdvance: integerFromDatabase(source.salaryAdvance, "salaryAdvance"),
    employeePayrollRows: normalizePayrollRows(
      parseJson(source.employeePayrollRowsJson, "employeePayrollRowsJson"),
      "employeePayrollRows",
    ),
    managerPayroll: normalizeJsonObject(
      parseJson(source.managerPayrollJson, "managerPayrollJson"),
      "managerPayroll",
    ),
    configSnapshot: normalizeJsonObject(
      parseJson(source.configSnapshotJson, "configSnapshotJson"),
      "configSnapshot",
    ),
  });
}

function snapshotFromRaw(
  source: RawFinancialPeriodRow,
  status: FinancialPeriodStatus,
  calculation: FinancialPeriodCalculationPayload | null,
): CanonicalFinancialPeriodSnapshot | null {
  if (status !== "CONFIRMED" && status !== "PAID" && status !== "LOCKED") return null;
  if (!calculation) throw new TypeError("confirmed financial periods require a calculation payload");
  const base = parsePersistedFinancialPeriodSnapshot(source.snapshotJson);
  const decoded = normalizeJsonObject(parseJson(source.snapshotJson, "snapshotJson"), "snapshotJson");
  const policyVersionId = decoded.policyVersionId === undefined
    ? calculation.policyVersionId
    : requiredString(decoded.policyVersionId, "snapshot.policyVersionId");
  const totalHoursSeconds = decoded.totalHoursSeconds === undefined
    ? calculation.totalHoursSeconds
    : safeInteger(decoded.totalHoursSeconds, "snapshot.totalHoursSeconds");
  const salaryAdvance = decoded.salaryAdvance === undefined
    ? calculation.salaryAdvance
    : safeInteger(decoded.salaryAdvance, "snapshot.salaryAdvance");
  const employeePayrollRows = decoded.employeePayrollRows === undefined
    ? calculation.employeePayrollRows
    : normalizePayrollRows(decoded.employeePayrollRows, "snapshot.employeePayrollRows");
  const managerPayroll = decoded.managerPayroll === undefined
    ? calculation.managerPayroll
    : normalizeJsonObject(decoded.managerPayroll, "snapshot.managerPayroll");
  const configSnapshot = decoded.configSnapshot === undefined
    ? calculation.configSnapshot
    : normalizeJsonObject(decoded.configSnapshot, "snapshot.configSnapshot");

  if (base.storeId !== source.storeId || base.period !== source.period || base.status !== status) {
    throw new TypeError("snapshot identity/status does not match the financial period row");
  }
  if (base.configVersion !== calculation.configVersion || policyVersionId !== calculation.policyVersionId) {
    throw new TypeError("snapshot policy does not match the financial period row");
  }
  if (JSON.stringify(base.finance) !== JSON.stringify(calculation.finance)
    || totalHoursSeconds !== calculation.totalHoursSeconds
    || salaryAdvance !== calculation.salaryAdvance
    || JSON.stringify(employeePayrollRows) !== JSON.stringify(calculation.employeePayrollRows)
    || JSON.stringify(managerPayroll) !== JSON.stringify(calculation.managerPayroll)
    || JSON.stringify(configSnapshot) !== JSON.stringify(calculation.configSnapshot)) {
    throw new TypeError("snapshot payload does not match the normalized financial period columns");
  }

  // Keep the exact canonical key order emitted by
  // buildCanonicalFinancialPeriodSnapshot. SQLite's lifecycle guard removes
  // settlement fields and compares the remaining serialized JSON; rebuilding
  // this object in a different order would make an otherwise identical
  // CONFIRMED snapshot look mutated when it advances to PAID/LOCKED.
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    storeId: base.storeId,
    period: base.period,
    status: base.status,
    policyVersionId,
    configVersion: base.configVersion,
    finance: base.finance,
    totalHoursSeconds,
    salaryAdvance,
    employeePayrollRows,
    managerPayroll,
    configSnapshot,
    confirmedAt: base.confirmedAt,
    confirmedBy: base.confirmedBy,
    paidAt: base.paidAt,
    paidBy: base.paidBy,
    lockedAt: base.lockedAt,
    lockedBy: base.lockedBy,
  });
}

function parseLifecycleRow(source: RawFinancialPeriodRow): FinancialPeriodLifecycleRow {
  const status = source.status;
  if (!isFinancialPeriodStatus(status)) throw new TypeError("financial period row has an invalid status");
  const calculation = calculationFromRaw(source);
  return Object.freeze({
    id: requiredString(source.id, "id"),
    storeId: requiredString(source.storeId, "storeId"),
    period: requiredPeriod(source.period),
    status,
    revision: integerFromDatabase(source.revision, "revision"),
    calculation,
    snapshot: snapshotFromRaw(source, status, calculation),
    calculatedAt: optionalTimestamp(source.calculatedAt, "calculatedAt"),
    calculatedBy: optionalString(source.calculatedBy, "calculatedBy"),
    confirmedAt: optionalTimestamp(source.confirmedAt, "confirmedAt"),
    confirmedBy: optionalString(source.confirmedBy, "confirmedBy"),
    paidAt: optionalTimestamp(source.paidAt, "paidAt"),
    paidBy: optionalString(source.paidBy, "paidBy"),
    lockedAt: optionalTimestamp(source.lockedAt, "lockedAt"),
    lockedBy: optionalString(source.lockedBy, "lockedBy"),
    createdAt: requiredString(source.createdAt, "createdAt"),
    updatedAt: requiredString(source.updatedAt, "updatedAt"),
  });
}

export function buildFinancialPeriodCalculation(
  input: FinancialPeriodCalculationInput,
): FinancialPeriodCalculationPayload {
  return Object.freeze({
    policyVersionId: requiredString(input.policyVersionId, "policyVersionId"),
    configVersion: safeInteger(input.configVersion, "configVersion", { positive: true }),
    finance: calculateFinance(input.finance),
    totalHoursSeconds: safeInteger(input.totalHoursSeconds, "totalHoursSeconds"),
    salaryAdvance: safeInteger(input.salaryAdvance, "salaryAdvance"),
    employeePayrollRows: normalizePayrollRows(input.employeePayrollRows, "employeePayrollRows"),
    managerPayroll: normalizeJsonObject(input.managerPayroll, "managerPayroll"),
    configSnapshot: normalizeJsonObject(input.configSnapshot, "configSnapshot"),
  });
}

export function buildCanonicalFinancialPeriodSnapshot(input: Readonly<{
  storeId: string;
  period: string;
  calculation: FinancialPeriodCalculationInput | FinancialPeriodCalculationPayload;
  confirmedAt: string;
  confirmedBy: string;
}>): CanonicalFinancialPeriodSnapshot {
  const calculation = buildFinancialPeriodCalculation(input.calculation);
  return Object.freeze({
    schemaVersion: 1,
    storeId: requiredString(input.storeId, "storeId"),
    period: requiredPeriod(input.period),
    status: "CONFIRMED",
    ...calculation,
    confirmedAt: canonicalTimestamp(input.confirmedAt, "confirmedAt"),
    confirmedBy: requiredString(input.confirmedBy, "confirmedBy"),
    paidAt: null,
    paidBy: null,
    lockedAt: null,
    lockedBy: null,
  });
}

export function advanceCanonicalFinancialPeriodSnapshot(
  current: CanonicalFinancialPeriodSnapshot,
  input: Readonly<{
    toStatus: Extract<SnapshotFinancialPeriodStatus, "PAID" | "LOCKED">;
    actorId: string;
    now: string;
  }>,
): CanonicalFinancialPeriodSnapshot {
  assertFinancialPeriodTransition(current.status, input.toStatus);
  const now = canonicalTimestamp(input.now, "now");
  const actorId = requiredString(input.actorId, "actorId");
  if (input.toStatus === "PAID") {
    if (now < current.confirmedAt) throw new TypeError("paidAt cannot be earlier than confirmedAt");
    return Object.freeze({ ...current, status: "PAID", paidAt: now, paidBy: actorId });
  }
  if (current.paidAt === null || current.paidBy === null) {
    throw new TypeError("LOCKED requires a previously paid canonical snapshot");
  }
  if (now < current.paidAt) throw new TypeError("lockedAt cannot be earlier than paidAt");
  return Object.freeze({ ...current, status: "LOCKED", lockedAt: now, lockedBy: actorId });
}

export async function readFinancialPeriodLifecycleRow(
  db: D1Database,
  storeId: string,
  period: string,
) {
  const row = await db.prepare(`SELECT
      id, store_id AS storeId, period, status,
      policy_version_id AS policyVersionId, config_version AS configVersion, revision,
      gross_revenue AS grossRevenue, fixed_expense AS fixedExpense,
      variable_expense AS variableExpense, inventory_cost AS inventoryCost,
      inventory_shipping_cost AS inventoryShippingCost,
      employee_salary AS employeeSalary, manager_salary AS managerSalary,
      manual_bonus AS manualBonus, allowance,
      total_hours_seconds AS totalHoursSeconds,
      employee_kpi_total AS employeeKpiTotal, manager_kpi AS managerKpi,
      operating_profit AS operatingProfit, profit_after_kpi AS profitAfterKpi,
      month_end_expense AS monthEndExpense, final_profit AS finalProfit,
      distributable_profit AS distributableProfit, salary_advance AS salaryAdvance,
      employee_payroll_rows_json AS employeePayrollRowsJson,
      manager_payroll_json AS managerPayrollJson,
      config_snapshot_json AS configSnapshotJson, snapshot_json AS snapshotJson,
      calculated_at AS calculatedAt, calculated_by AS calculatedBy,
      confirmed_at AS confirmedAt, confirmed_by AS confirmedBy,
      paid_at AS paidAt, paid_by AS paidBy,
      locked_at AS lockedAt, locked_by AS lockedBy,
      created_at AS createdAt, updated_at AS updatedAt
    FROM financial_periods WHERE store_id = ? AND period = ? LIMIT 1`)
    .bind(requiredString(storeId, "storeId"), requiredPeriod(period))
    .first<RawFinancialPeriodRow>();
  return row ? parseLifecycleRow(row) : null;
}

function calculationBindings(payload: FinancialPeriodCalculationPayload) {
  const finance = payload.finance;
  return [
    payload.policyVersionId,
    payload.configVersion,
    finance.grossRevenue,
    finance.fixedExpense,
    finance.variableExpense,
    finance.inventoryCost,
    finance.inventoryShippingCost,
    finance.employeeSalary,
    finance.managerSalary,
    finance.manualEmployeeBonus,
    finance.employeeAllowance,
    payload.totalHoursSeconds,
    finance.employeeKpiTotal,
    finance.managerKpi,
    finance.operatingProfit,
    finance.profitAfterKpi,
    finance.monthEndExpense,
    finance.finalProfit,
    finance.distributableProfit,
    payload.salaryAdvance,
    JSON.stringify(payload.employeePayrollRows),
    JSON.stringify(payload.managerPayroll),
    JSON.stringify(payload.configSnapshot),
  ] as const;
}

function rowAuditState(row: FinancialPeriodLifecycleRow) {
  return {
    id: row.id,
    storeId: row.storeId,
    period: row.period,
    status: row.status,
    revision: row.revision,
    calculation: row.calculation,
    snapshot: row.snapshot,
    calculatedAt: row.calculatedAt,
    calculatedBy: row.calculatedBy,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
    paidAt: row.paidAt,
    paidBy: row.paidBy,
    lockedAt: row.lockedAt,
    lockedBy: row.lockedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nextLifecycleRow(
  current: FinancialPeriodLifecycleRow,
  toStatus: FinancialPeriodStatus,
  actorId: string,
  now: string,
  calculation: FinancialPeriodCalculationPayload | null,
  snapshot: CanonicalFinancialPeriodSnapshot | null,
): FinancialPeriodLifecycleRow {
  return Object.freeze({
    ...current,
    status: toStatus,
    revision: current.revision + 1,
    calculation: calculation ?? current.calculation,
    snapshot,
    calculatedAt: toStatus === "CALCULATED" ? now : current.calculatedAt,
    calculatedBy: toStatus === "CALCULATED" ? actorId : current.calculatedBy,
    confirmedAt: toStatus === "CONFIRMED" ? now : current.confirmedAt,
    confirmedBy: toStatus === "CONFIRMED" ? actorId : current.confirmedBy,
    paidAt: toStatus === "PAID" ? now : current.paidAt,
    paidBy: toStatus === "PAID" ? actorId : current.paidBy,
    lockedAt: toStatus === "LOCKED" ? now : current.lockedAt,
    lockedBy: toStatus === "LOCKED" ? actorId : current.lockedBy,
    updatedAt: now,
  });
}

export function prepareFinancialPeriodDraftPlan(
  db: D1Database,
  input: Readonly<{
    id: string;
    storeId: string;
    period: string;
    actorId: string;
    now: string;
    reason: string;
    auditId?: string;
  }>,
): FinancialPeriodDraftPlan {
  const id = requiredString(input.id, "id");
  const storeId = requiredString(input.storeId, "storeId");
  const period = requiredPeriod(input.period);
  const actorId = requiredString(input.actorId, "actorId");
  const now = canonicalTimestamp(input.now, "now");
  const reason = requiredString(input.reason, "reason");
  const auditId = input.auditId ? requiredString(input.auditId, "auditId") : crypto.randomUUID();
  const after = JSON.stringify({ id, storeId, period, status: "DRAFT", revision: 0, createdAt: now, updatedAt: now });
  const mutation = db.prepare(`INSERT OR IGNORE INTO financial_periods
      (id, store_id, period, status, revision, created_at, updated_at)
    VALUES (?, ?, ?, 'DRAFT', 0, ?, ?)`).bind(id, storeId, period, now, now);
  const audit = db.prepare(`INSERT INTO audit_logs
      (id, user_id, store_id, action, entity_type, entity_id, detail,
       before_json, after_json, reason, created_at)
    SELECT ?, ?, row.store_id, 'FINANCIAL_PERIOD_CREATE', 'FINANCIAL_PERIOD', row.id, ?,
      'null', ?, ?, ?
    FROM financial_periods row
    WHERE row.id = ? AND row.store_id = ? AND row.period = ? AND row.status = 'DRAFT'
      AND row.revision = 0 AND row.created_at = ? AND row.updated_at = ?`)
    .bind(
      auditId,
      actorId,
      JSON.stringify({ storeId, period, status: "DRAFT", revision: 0 }),
      after,
      reason,
      now,
      id,
      storeId,
      period,
      now,
      now,
    );
  return Object.freeze({
    kind: "CREATE_DRAFT",
    id,
    storeId,
    period,
    statements: Object.freeze([mutation, audit]) as readonly [D1PreparedStatement, D1PreparedStatement],
    mutationStatementIndex: 0,
    auditStatementIndex: 1,
  });
}

function prepareMutationAndAudit(
  db: D1Database,
  input: Readonly<{
    current: FinancialPeriodLifecycleRow;
    toStatus: FinancialPeriodStatus;
    actorId: string;
    now: string;
    reason: string;
    auditId?: string;
    calculation?: FinancialPeriodCalculationInput | FinancialPeriodCalculationPayload;
    recalculateOnly?: boolean;
  }>,
): FinancialPeriodTransitionPlan {
  const current = input.current;
  const actorId = requiredString(input.actorId, "actorId");
  const now = canonicalTimestamp(input.now, "now");
  const reason = requiredString(input.reason, "reason");
  const auditId = input.auditId ? requiredString(input.auditId, "auditId") : crypto.randomUUID();
  if (input.recalculateOnly) {
    if (current.status !== "CALCULATED" && current.status !== "RECONCILING") {
      throw new Error("Only CALCULATED or RECONCILING periods can be recalculated");
    }
    if (input.toStatus !== current.status) throw new Error("Recalculation cannot change lifecycle status");
  } else {
    assertFinancialPeriodTransition(current.status, input.toStatus);
  }

  let calculation = input.calculation ? buildFinancialPeriodCalculation(input.calculation) : null;
  if ((input.toStatus === "CALCULATED" || input.toStatus === "CONFIRMED" || input.recalculateOnly)
    && !calculation) {
    throw new TypeError(`${input.recalculateOnly ? "RECALCULATE" : input.toStatus} requires a calculation payload`);
  }
  if (input.toStatus === "RECONCILING" && !calculation) calculation = current.calculation;

  let snapshot: CanonicalFinancialPeriodSnapshot | null = current.snapshot;
  if (input.toStatus === "CONFIRMED") {
    if (!calculation) throw new TypeError("CONFIRMED requires a calculation payload");
    snapshot = buildCanonicalFinancialPeriodSnapshot({
      storeId: current.storeId,
      period: current.period,
      calculation,
      confirmedAt: now,
      confirmedBy: actorId,
    });
  } else if (input.toStatus === "PAID" || input.toStatus === "LOCKED") {
    if (!current.snapshot) throw new TypeError(`${input.toStatus} requires the previous canonical snapshot`);
    snapshot = advanceCanonicalFinancialPeriodSnapshot(current.snapshot, {
      toStatus: input.toStatus,
      actorId,
      now,
    });
  }

  const toStatus = input.toStatus;
  const next = nextLifecycleRow(current, toStatus, actorId, now, calculation, snapshot);
  const assignments = ["status = ?", "revision = revision + 1", "updated_at = ?"];
  const bindings: unknown[] = [toStatus, now];

  if (calculation) {
    assignments.push(...CALCULATION_COLUMN_NAMES.map((column) => `${column} = ?`));
    bindings.push(...calculationBindings(calculation));
  }
  if (toStatus === "CALCULATED") {
    assignments.push("calculated_at = ?", "calculated_by = ?");
    bindings.push(now, actorId);
  }
  if (toStatus === "CONFIRMED") {
    assignments.push("confirmed_at = ?", "confirmed_by = ?", "snapshot_json = ?");
    bindings.push(now, actorId, JSON.stringify(snapshot));
  }
  if (toStatus === "PAID") {
    assignments.push("paid_at = ?", "paid_by = ?", "snapshot_json = ?");
    bindings.push(now, actorId, JSON.stringify(snapshot));
  }
  if (toStatus === "LOCKED") {
    assignments.push("locked_at = ?", "locked_by = ?", "snapshot_json = ?");
    bindings.push(now, actorId, JSON.stringify(snapshot));
  }

  const mutation = db.prepare(`UPDATE financial_periods SET ${assignments.join(", ")}
    WHERE id = ? AND store_id = ? AND period = ? AND status = ? AND revision = ?`)
    .bind(
      ...bindings,
      current.id,
      current.storeId,
      current.period,
      current.status,
      current.revision,
    );
  const action = input.recalculateOnly
    ? "FINANCIAL_PERIOD_RECALCULATE"
    : `FINANCIAL_PERIOD_${toStatus}`;
  const detail = JSON.stringify({
    storeId: current.storeId,
    period: current.period,
    fromStatus: current.status,
    toStatus,
    expectedRevision: current.revision,
    nextRevision: current.revision + 1,
    snapshotSchemaVersion: snapshot?.schemaVersion ?? null,
  });
  const audit = db.prepare(`INSERT INTO audit_logs
      (id, user_id, store_id, action, entity_type, entity_id, detail,
       before_json, after_json, reason, created_at)
    SELECT ?, ?, row.store_id, ?, 'FINANCIAL_PERIOD', row.id, ?, ?, ?, ?, ?
    FROM financial_periods row
    WHERE row.id = ? AND row.store_id = ? AND row.period = ?
      AND row.status = ? AND row.revision = ? AND row.updated_at = ?`)
    .bind(
      auditId,
      actorId,
      action,
      detail,
      JSON.stringify(rowAuditState(current)),
      JSON.stringify(rowAuditState(next)),
      reason,
      now,
      current.id,
      current.storeId,
      current.period,
      toStatus,
      current.revision + 1,
      now,
    );

  return Object.freeze({
    kind: input.recalculateOnly ? "RECALCULATE" : "TRANSITION",
    id: current.id,
    storeId: current.storeId,
    period: current.period,
    fromStatus: current.status,
    toStatus,
    expectedRevision: current.revision,
    nextRevision: current.revision + 1,
    next,
    statements: Object.freeze([mutation, audit]) as readonly [D1PreparedStatement, D1PreparedStatement],
    mutationStatementIndex: 0,
    auditStatementIndex: 1,
  });
}

export function prepareFinancialPeriodTransitionPlan(
  db: D1Database,
  input: Readonly<{
    current: FinancialPeriodLifecycleRow;
    toStatus: FinancialPeriodStatus;
    actorId: string;
    now: string;
    reason: string;
    auditId?: string;
    calculation?: FinancialPeriodCalculationInput | FinancialPeriodCalculationPayload;
  }>,
) {
  return prepareMutationAndAudit(db, input);
}

export function prepareFinancialPeriodRecalculationPlan(
  db: D1Database,
  input: Readonly<{
    current: FinancialPeriodLifecycleRow;
    actorId: string;
    now: string;
    reason: string;
    auditId?: string;
    calculation: FinancialPeriodCalculationInput | FinancialPeriodCalculationPayload;
  }>,
) {
  return prepareMutationAndAudit(db, {
    ...input,
    toStatus: input.current.status,
    recalculateOnly: true,
  });
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

export function assertFinancialPeriodPlanApplied(
  results: readonly unknown[],
  plan: FinancialPeriodDraftPlan | FinancialPeriodTransitionPlan,
  offset = 0,
) {
  const mutationChanges = affectedRows(results[offset + plan.mutationStatementIndex]);
  const auditChanges = affectedRows(results[offset + plan.auditStatementIndex]);
  if (mutationChanges !== 1) {
    throw new FinancialPeriodLifecycleConflictError(
      "STALE",
      "Financial period state/revision changed before the mutation was committed",
    );
  }
  if (auditChanges !== 1) {
    throw new FinancialPeriodLifecycleConflictError(
      "INCOMPLETE_AUDIT",
      "Financial period mutation did not persist its audit event",
    );
  }
}

export async function executeFinancialPeriodTransition(
  db: D1Database,
  plan: FinancialPeriodTransitionPlan,
) {
  const results = await db.batch([...plan.statements]);
  assertFinancialPeriodPlanApplied(results, plan);
  const row = await readFinancialPeriodLifecycleRow(db, plan.storeId, plan.period);
  if (!row) {
    throw new FinancialPeriodLifecycleConflictError("NOT_FOUND", "Financial period was not found after transition");
  }
  return row;
}
