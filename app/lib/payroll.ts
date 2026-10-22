import { sumVnd } from "./finance";

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
