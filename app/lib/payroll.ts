import { multiplyDecimalRatioVnd, multiplyRatioVnd, sumVnd } from "./finance";
import {
  defaultPayrollPolicy,
  employeeKpiRateBasisPointsFromSeconds,
  managerKpiBonusFromPolicy,
  rateFromBasisPoints,
  type PayrollPolicySnapshot,
} from "./payroll-policy";

export type EmployeePayComponents = {
  baseSalary: number;
  tiktokAllowance: number;
  supportAllowance: number;
  manualAllowance: number;
  manualBonus: number;
};

export const PAYROLL_UPDATED_EVENT = "dore:payroll-updated";

export type PayrollAdjustmentComponent = {
  kind: "ALLOWANCE" | "BONUS";
  amount: number;
};

/**
 * Keep manager-created allowances and bonuses as two explicit payroll
 * components.  The same totals are then carried into previews and immutable
 * closing snapshots instead of being reconstructed differently by each UI.
 */
export function payrollAdjustmentTotals(adjustments: PayrollAdjustmentComponent[]) {
  return {
    manualAllowance: sumVnd(adjustments
      .filter((adjustment) => adjustment.kind === "ALLOWANCE")
      .map((adjustment) => adjustment.amount)),
    manualBonus: sumVnd(adjustments
      .filter((adjustment) => adjustment.kind === "BONUS")
      .map((adjustment) => adjustment.amount)),
  };
}

export function employeePayWithKpi(components: EmployeePayComponents, finalizedKpiBonus: number) {
  return sumVnd([
    components.baseSalary,
    components.tiktokAllowance,
    components.supportAllowance,
    components.manualAllowance,
    components.manualBonus,
    finalizedKpiBonus,
  ]);
}

export type EmployeeKpiInput = {
  employeeId: string;
  hours: number;
};

export type EmployeeKpiResult = EmployeeKpiInput & {
  bonus: number;
};

export const INACTIVE_EMPLOYEE_KPI_MIN_COMPLETED_SHIFTS = 15;
export const MANAGER_FIXED_WORK_HOURS_PER_STORE = 140;
export const MANAGER_FIXED_WORK_SECONDS_PER_STORE = MANAGER_FIXED_WORK_HOURS_PER_STORE * 3_600;

export type EmployeeKpiPolicyInput = {
  employeeId: string;
  employmentStatus: "ACTIVE" | "INACTIVE";
  completedShiftCount: number;
  durationSeconds: number;
};

export type EmployeeKpiPolicyResult = EmployeeKpiPolicyInput & {
  eligible: boolean;
  bonus: number;
};

export type StoreKpiDistribution = {
  employees: EmployeeKpiPolicyResult[];
  manager: {
    durationSeconds: number;
    hours: number;
    bonus: number;
  };
  eligibleEmployeeDurationSeconds: number;
  eligibleEmployeeHours: number;
  totalDurationSeconds: number;
  totalHours: number;
  profitPerHour: number;
  kpiRate: number;
  kpiPool: number;
  employeeBonusTotal: number;
  managerBonus: number;
};

export type EmployeePayrollSourceState = {
  locked: boolean;
  paymentStatus: string;
};

export function employeePayrollOverallState(sources: EmployeePayrollSourceState[]) {
  const locked = sources.length > 0 && sources.every((source) => source.locked);
  const paid = locked && sources.every((source) => (
    source.paymentStatus === "PAYMENT_CONFIRMED" || source.paymentStatus === "LOCKED"
  ));
  return { locked, paid };
}

/**
 * Return the single KPI tier reached by the store for a payroll period.
 * Tiers are deliberately checked from highest to lowest and never stack.
 */
export function employeeKpiRate(profit: number, totalHours: number) {
  if (!Number.isFinite(profit) || !Number.isFinite(totalHours) || profit <= 0 || totalHours <= 0) return 0;
  return employeeKpiRateFromSeconds(profit, Math.round(totalHours * 3_600));
}

export function employeeKpiRateFromSeconds(profit: number, totalSeconds: number) {
  const policy = defaultPayrollPolicy();
  return rateFromBasisPoints(employeeKpiRateBasisPointsFromSeconds(profit, totalSeconds, policy.employeeKpiTiers));
}

export function employeeKpiBonus(profit: number, totalHours: number, employeeHours: number) {
  if (!Number.isFinite(employeeHours) || employeeHours <= 0) return 0;
  return employeeKpiBonusFromSeconds(profit, Math.round(totalHours * 3_600), Math.round(employeeHours * 3_600));
}

export function employeeKpiBonusFromSeconds(profit: number, totalSeconds: number, employeeSeconds: number) {
  if (!Number.isSafeInteger(employeeSeconds) || employeeSeconds <= 0) return 0;
  const rate = employeeKpiRateFromSeconds(profit, totalSeconds);
  if (rate === 0) return 0;
  return multiplyDecimalRatioVnd(profit, rate.toFixed(2), employeeSeconds, totalSeconds);
}

/**
 * Employees who are still active always share the store KPI by their actual
 * worked time. An employee who left during the period remains in the KPI pool
 * only after completing at least 15 real, completed shifts in that period.
 */
export function isEmployeeEligibleForKpi(
  employmentStatus: EmployeeKpiPolicyInput["employmentStatus"],
  completedShiftCount: number,
) {
  if (employmentStatus === "ACTIVE") return true;
  return Number.isSafeInteger(completedShiftCount)
    && completedShiftCount >= INACTIVE_EMPLOYEE_KPI_MIN_COMPLETED_SHIFTS;
}

export function distributeEmployeeKpiByPolicy(
  profit: number,
  employees: EmployeeKpiPolicyInput[],
): EmployeeKpiPolicyResult[] {
  const normalized = employees.map((employee) => ({
    ...employee,
    completedShiftCount: Number.isSafeInteger(employee.completedShiftCount)
      ? Math.max(0, employee.completedShiftCount)
      : 0,
    durationSeconds: Number.isSafeInteger(employee.durationSeconds)
      ? Math.max(0, employee.durationSeconds)
      : 0,
  }));
  const eligibleSeconds = normalized.reduce((sum, employee) => (
    isEmployeeEligibleForKpi(employee.employmentStatus, employee.completedShiftCount)
      ? sum + employee.durationSeconds
      : sum
  ), 0);
  const safeEligibleSeconds = Number.isSafeInteger(eligibleSeconds) ? eligibleSeconds : 0;

  return normalized.map((employee) => {
    const eligible = isEmployeeEligibleForKpi(employee.employmentStatus, employee.completedShiftCount);
    return {
      ...employee,
      eligible,
      bonus: eligible
        ? employeeKpiBonusFromSeconds(profit, safeEligibleSeconds, employee.durationSeconds)
        : 0,
    };
  });
}

/**
 * Allocate one store KPI pool between eligible main-store employees and the
 * manager. Support shifts must be removed by the caller before this function;
 * the manager always contributes 140 fixed hours to both the threshold and
 * allocation denominator. Cumulative rounding preserves every VND in the pool.
 */
export function distributeStoreKpiByPolicy(
  profit: number,
  employees: EmployeeKpiPolicyInput[],
  policy: PayrollPolicySnapshot = defaultPayrollPolicy(),
): StoreKpiDistribution {
  const normalized = employees.map((employee) => ({
    ...employee,
    completedShiftCount: Number.isSafeInteger(employee.completedShiftCount)
      ? Math.max(0, employee.completedShiftCount)
      : 0,
    durationSeconds: Number.isSafeInteger(employee.durationSeconds)
      ? Math.max(0, employee.durationSeconds)
      : 0,
  }));
  const eligible = normalized.map((employee) => ({
    ...employee,
    eligible: isEmployeeEligibleForKpi(employee.employmentStatus, employee.completedShiftCount),
  }));
  const eligibleEmployeeDurationSeconds = eligible.reduce((total, employee) => (
    employee.eligible ? total + employee.durationSeconds : total
  ), 0);
  if (!Number.isSafeInteger(eligibleEmployeeDurationSeconds)) {
    throw new Error("Tổng thời gian KPI vượt giới hạn an toàn.");
  }
  const totalDurationSeconds = eligibleEmployeeDurationSeconds + MANAGER_FIXED_WORK_SECONDS_PER_STORE;
  if (!Number.isSafeInteger(totalDurationSeconds)) {
    throw new Error("Tổng thời gian cửa hàng vượt giới hạn an toàn.");
  }
  const kpiRateBasisPoints = employeeKpiRateBasisPointsFromSeconds(
    profit,
    totalDurationSeconds,
    policy.employeeKpiTiers,
  );
  const kpiRate = rateFromBasisPoints(kpiRateBasisPoints);
  const kpiPool = kpiRateBasisPoints > 0
    ? multiplyRatioVnd(profit, kpiRateBasisPoints, 10_000)
    : 0;
  const configuredManagerBonus = policy.managerKpiRateBasisPoints === null
    ? null
    : managerKpiBonusFromPolicy(profit, policy.managerKpiRateBasisPoints);
  // A store with no eligible employee must not report an unallocated employee
  // KPI pool. The manager percentage remains independent when explicitly set.
  const employeePool = eligibleEmployeeDurationSeconds > 0 ? kpiPool : 0;
  const weights = eligible.map((employee) => employee.eligible ? employee.durationSeconds : 0);
  let cumulativeSeconds = 0;
  let allocated = 0;
  const bonuses = weights.map((seconds) => {
    cumulativeSeconds += seconds;
    const denominator = configuredManagerBonus === null
      ? totalDurationSeconds
      : eligibleEmployeeDurationSeconds;
    const cumulativeAllocation = employeePool > 0 && denominator > 0
      ? multiplyRatioVnd(employeePool, cumulativeSeconds, denominator)
      : 0;
    const bonus = cumulativeAllocation - allocated;
    allocated = cumulativeAllocation;
    return bonus;
  });
  const employeeResults = eligible.map((employee, index) => ({
    ...employee,
    bonus: bonuses[index],
  }));
  const managerBonus = configuredManagerBonus === null
    ? (kpiPool > 0 ? multiplyRatioVnd(kpiPool, MANAGER_FIXED_WORK_SECONDS_PER_STORE, totalDurationSeconds) : 0)
    : configuredManagerBonus;
  const employeeBonusTotal = sumVnd(employeeResults.map((employee) => employee.bonus));
  return {
    employees: employeeResults,
    manager: {
      durationSeconds: MANAGER_FIXED_WORK_SECONDS_PER_STORE,
      hours: MANAGER_FIXED_WORK_HOURS_PER_STORE,
      bonus: managerBonus,
    },
    eligibleEmployeeDurationSeconds,
    eligibleEmployeeHours: eligibleEmployeeDurationSeconds / 3_600,
    totalDurationSeconds,
    totalHours: totalDurationSeconds / 3_600,
    profitPerHour: profit > 0 ? multiplyRatioVnd(profit, 3_600, totalDurationSeconds, "DOWN") : 0,
    kpiRate,
    kpiPool: configuredManagerBonus === null ? kpiPool : sumVnd([employeePool, managerBonus]),
    employeeBonusTotal,
    managerBonus,
  };
}

export function distributeEmployeeKpi(profit: number, employees: EmployeeKpiInput[]): EmployeeKpiResult[] {
  const seconds = employees.map((employee) => Math.max(0, Math.round(employee.hours * 3_600)));
  const totalSeconds = seconds.reduce((sum, value) => sum + value, 0);
  return employees.map((employee) => ({
    ...employee,
    bonus: employeeKpiBonusFromSeconds(profit, totalSeconds, Math.max(0, Math.round(employee.hours * 3_600))),
  }));
}
