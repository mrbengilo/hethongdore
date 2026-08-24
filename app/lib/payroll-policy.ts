import { multiplyDecimalVnd } from "./finance";

export const PAYROLL_POLICY_STATE_KEY = "global_payroll_policy_v1";
export const DEFAULT_MANAGER_MONTHLY_SALARY_VND = 3_000_000;
// Canonical compatibility value for legacy payroll-policy rows that predate
// the explicit manager KPI setting. New financial policy versions always
// persist a concrete rate so period calculations can never branch on null.
export const DEFAULT_MANAGER_KPI_RATE_BASIS_POINTS = 200;
export const MIN_MANAGER_MONTHLY_SALARY_VND = 0;
export const MAX_MANAGER_MONTHLY_SALARY_VND = 1_000_000_000;
export const MIN_KPI_RATE_BASIS_POINTS = 0;
export const MAX_KPI_RATE_BASIS_POINTS = 10_000;

export const EMPLOYEE_KPI_THRESHOLDS = [30_000, 15_000, 7_000] as const;
export type EmployeeKpiThreshold = typeof EMPLOYEE_KPI_THRESHOLDS[number];

export type EmployeeKpiTierPolicy = {
  minimumProfitPerHour: EmployeeKpiThreshold;
  rateBasisPoints: number;
};

export type StoredPayrollPolicy = {
  schemaVersion: 1;
  managerMonthlySalaryVnd: number;
  /**
   * A null rate is a migration-only compatibility state. It keeps the former
   * 140-hour shared-pool manager calculation until a superadmin explicitly
   * saves the new manager KPI percentage. This prevents a deployment by
   * itself from changing an open payroll period.
   */
  managerKpiRateBasisPoints: number | null;
  employeeKpiTiers: EmployeeKpiTierPolicy[];
  version: number;
  updatedBy: string | null;
  mutationToken: string | null;
};

export type PayrollPolicySnapshot = StoredPayrollPolicy & {
  rawValue: string;
  updatedAt: string;
};

const DEFAULT_EMPLOYEE_KPI_TIERS: EmployeeKpiTierPolicy[] = [
  { minimumProfitPerHour: 30_000, rateBasisPoints: 700 },
  { minimumProfitPerHour: 15_000, rateBasisPoints: 500 },
  { minimumProfitPerHour: 7_000, rateBasisPoints: 300 },
];

export function isSafeManagerSalary(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= MIN_MANAGER_MONTHLY_SALARY_VND
    && Number(value) <= MAX_MANAGER_MONTHLY_SALARY_VND;
}

export function isSafeKpiRateBasisPoints(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= MIN_KPI_RATE_BASIS_POINTS
    && Number(value) <= MAX_KPI_RATE_BASIS_POINTS;
}

export function normalizeEmployeeKpiTiers(value: unknown): EmployeeKpiTierPolicy[] | null {
  if (!Array.isArray(value) || value.length !== EMPLOYEE_KPI_THRESHOLDS.length) return null;
  const byThreshold = new Map<number, number>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!EMPLOYEE_KPI_THRESHOLDS.includes(Number(row.minimumProfitPerHour) as EmployeeKpiThreshold)
      || !isSafeKpiRateBasisPoints(row.rateBasisPoints)) return null;
    byThreshold.set(Number(row.minimumProfitPerHour), Number(row.rateBasisPoints));
  }
  if (byThreshold.size !== EMPLOYEE_KPI_THRESHOLDS.length) return null;
  const normalized = EMPLOYEE_KPI_THRESHOLDS.map((minimumProfitPerHour) => ({
    minimumProfitPerHour,
    rateBasisPoints: byThreshold.get(minimumProfitPerHour) ?? -1,
  }));
  // Higher profit thresholds may never pay a lower percentage than a lower
  // threshold. This catches transposed fields without guessing user intent.
  if (normalized.some((tier, index) => index > 0
    && normalized[index - 1].rateBasisPoints < tier.rateBasisPoints)) return null;
  return normalized;
}

export function validatePayrollPolicyCombination(
  managerKpiRateBasisPoints: number | null,
  employeeKpiTiers: EmployeeKpiTierPolicy[],
) {
  if (managerKpiRateBasisPoints === null) return true;
  return managerKpiRateBasisPoints + employeeKpiTiers[0].rateBasisPoints <= 10_000;
}

export function serializePayrollPolicy(policy: StoredPayrollPolicy) {
  return JSON.stringify({
    schemaVersion: 1,
    managerMonthlySalaryVnd: policy.managerMonthlySalaryVnd,
    managerKpiRateBasisPoints: policy.managerKpiRateBasisPoints,
    employeeKpiTiers: policy.employeeKpiTiers,
    version: policy.version,
    updatedBy: policy.updatedBy,
    mutationToken: policy.mutationToken,
  });
}

export function defaultPayrollPolicy(updatedAt = new Date(0).toISOString()): PayrollPolicySnapshot {
  const stored: StoredPayrollPolicy = {
    schemaVersion: 1,
    managerMonthlySalaryVnd: DEFAULT_MANAGER_MONTHLY_SALARY_VND,
    managerKpiRateBasisPoints: null,
    employeeKpiTiers: DEFAULT_EMPLOYEE_KPI_TIERS,
    version: 1,
    updatedBy: null,
    mutationToken: null,
  };
  return { ...stored, rawValue: serializePayrollPolicy(stored), updatedAt };
}

export function parsePayrollPolicy(rawValue: string, updatedAt: string): PayrollPolicySnapshot | null {
  try {
    const value = JSON.parse(rawValue) as Partial<StoredPayrollPolicy>;
    const employeeKpiTiers = normalizeEmployeeKpiTiers(value.employeeKpiTiers);
    if (value.schemaVersion !== 1
      || !isSafeManagerSalary(value.managerMonthlySalaryVnd)
      || (value.managerKpiRateBasisPoints !== null && !isSafeKpiRateBasisPoints(value.managerKpiRateBasisPoints))
      || !employeeKpiTiers
      || !validatePayrollPolicyCombination(value.managerKpiRateBasisPoints ?? null, employeeKpiTiers)
      || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || (value.updatedBy !== null && typeof value.updatedBy !== "string")
      || (value.mutationToken !== null && typeof value.mutationToken !== "string")) return null;
    return {
      schemaVersion: 1,
      managerMonthlySalaryVnd: Number(value.managerMonthlySalaryVnd),
      managerKpiRateBasisPoints: value.managerKpiRateBasisPoints ?? null,
      employeeKpiTiers,
      version: Number(value.version),
      updatedBy: value.updatedBy ?? null,
      mutationToken: value.mutationToken ?? null,
      rawValue,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function rateFromBasisPoints(rateBasisPoints: number) {
  if (!isSafeKpiRateBasisPoints(rateBasisPoints)) throw new Error("Tỷ lệ KPI vượt giới hạn an toàn.");
  return rateBasisPoints / 10_000;
}

export function employeeKpiRateBasisPointsFromSeconds(
  profit: number,
  totalSeconds: number,
  tiers: EmployeeKpiTierPolicy[],
) {
  if (!Number.isSafeInteger(profit) || !Number.isSafeInteger(totalSeconds) || profit <= 0 || totalSeconds <= 0) return 0;
  const normalized = normalizeEmployeeKpiTiers(tiers);
  if (!normalized) throw new Error("Chính sách KPI nhân viên không hợp lệ.");
  const annualized = BigInt(profit) * 3_600n;
  return normalized.find((tier) => annualized >= BigInt(tier.minimumProfitPerHour) * BigInt(totalSeconds))?.rateBasisPoints ?? 0;
}

export function managerKpiBonusFromPolicy(profit: number, rateBasisPoints: number) {
  if (!Number.isSafeInteger(profit) || profit <= 0) return 0;
  if (!isSafeKpiRateBasisPoints(rateBasisPoints)) throw new Error("Tỷ lệ KPI quản lý không hợp lệ.");
  return multiplyDecimalVnd(profit, (rateBasisPoints / 10_000).toFixed(4));
}

export function payrollPolicyPayload(policy: PayrollPolicySnapshot, updatedByName: string | null = null) {
  return {
    managerMonthlySalaryVnd: policy.managerMonthlySalaryVnd,
    managerKpiRatePercent: policy.managerKpiRateBasisPoints === null
      ? null
      : policy.managerKpiRateBasisPoints / 100,
    employeeKpiTiers: policy.employeeKpiTiers.map((tier) => ({
      minimumProfitPerHour: tier.minimumProfitPerHour,
      ratePercent: tier.rateBasisPoints / 100,
    })),
    version: policy.version,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    updatedByName,
    appliesTo: "OPEN_AND_FUTURE_PERIODS_ONLY" as const,
  };
}
