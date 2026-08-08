import { multiplyDecimalRatioVnd, sumVnd } from "./finance";

export type EmployeePayComponents = {
  baseSalary: number;
  tiktokAllowance: number;
  supportAllowance: number;
  manualAllowance: number;
  manualBonus: number;
};

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

/**
 * Return the single KPI tier reached by the store for a payroll period.
 * Tiers are deliberately checked from highest to lowest and never stack.
 */
export function employeeKpiRate(profit: number, totalHours: number) {
  if (!Number.isFinite(profit) || !Number.isFinite(totalHours) || profit <= 0 || totalHours <= 0) return 0;
  return employeeKpiRateFromSeconds(profit, Math.round(totalHours * 3_600));
}

export function employeeKpiRateFromSeconds(profit: number, totalSeconds: number) {
  if (!Number.isSafeInteger(profit) || !Number.isSafeInteger(totalSeconds) || profit <= 0 || totalSeconds <= 0) return 0;
  const annualized = BigInt(profit) * 3_600n;
  if (annualized >= 30_000n * BigInt(totalSeconds)) return 0.07;
  if (annualized >= 15_000n * BigInt(totalSeconds)) return 0.05;
  if (annualized >= 7_000n * BigInt(totalSeconds)) return 0.03;
  return 0;
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

export function distributeEmployeeKpi(profit: number, employees: EmployeeKpiInput[]): EmployeeKpiResult[] {
  const seconds = employees.map((employee) => Math.max(0, Math.round(employee.hours * 3_600)));
  const totalSeconds = seconds.reduce((sum, value) => sum + value, 0);
  return employees.map((employee) => ({
    ...employee,
    bonus: employeeKpiBonusFromSeconds(profit, totalSeconds, Math.max(0, Math.round(employee.hours * 3_600))),
  }));
}
