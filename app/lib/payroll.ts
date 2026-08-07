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
  const profitPerHour = profit / totalHours;
  if (profitPerHour >= 30_000) return 0.07;
  if (profitPerHour >= 15_000) return 0.05;
  if (profitPerHour >= 7_000) return 0.03;
  return 0;
}

export function employeeKpiBonus(profit: number, totalHours: number, employeeHours: number) {
  if (!Number.isFinite(employeeHours) || employeeHours <= 0) return 0;
  const rate = employeeKpiRate(profit, totalHours);
  if (rate === 0) return 0;
  return Math.round((employeeHours / totalHours) * profit * rate);
}

export function distributeEmployeeKpi(profit: number, employees: EmployeeKpiInput[]): EmployeeKpiResult[] {
  const totalHours = employees.reduce((sum, employee) => sum + Math.max(0, employee.hours), 0);
  return employees.map((employee) => ({
    ...employee,
    bonus: employeeKpiBonus(profit, totalHours, employee.hours),
  }));
}
