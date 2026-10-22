export const OPERATING_EXPENSE_COMPONENTS = [
  "fixedExpense",
  "variableExpense",
  "inventoryCost",
  "inventoryShippingCost",
  "employeeSalary",
  "managerSalary",
  "manualEmployeeBonus",
  "employeeAllowance",
] as const;

export const KPI_EXPENSE_COMPONENTS = ["employeeKpiTotal", "managerKpi"] as const;

export const FINANCE_COMPONENTS = [
  "grossRevenue",
  ...OPERATING_EXPENSE_COMPONENTS,
  ...KPI_EXPENSE_COMPONENTS,
  "monthEndExpense",
] as const;

export type OperatingExpenseComponent = (typeof OPERATING_EXPENSE_COMPONENTS)[number];
export type KpiExpenseComponent = (typeof KPI_EXPENSE_COMPONENTS)[number];
export type FinanceComponent = (typeof FINANCE_COMPONENTS)[number];

export type FinanceEngineInput = Readonly<Record<FinanceComponent, number>>;

export type FinanceEngineResult = Readonly<
  FinanceEngineInput & {
    operatingExpense: number;
    operatingProfit: number;
    kpiExpense: number;
    profitAfterKpi: number;
    totalExpense: number;
    finalProfit: number;
    distributableProfit: number;
  }
>;

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = -MAX_SAFE_INTEGER;

function assertInputComponent(name: FinanceComponent, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a finite, non-negative safe integer`);
  }
}

function toSafeNumber(value: bigint, name: string): number {
  if (value < MIN_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} exceeds the safe integer range`);
  }
  return Number(value);
}

function sumComponents(
  input: FinanceEngineInput,
  components: readonly FinanceComponent[],
): bigint {
  return components.reduce((total, component) => total + BigInt(input[component]), 0n);
}

/**
 * Calculates a financial period from already-normalized integer components.
 *
 * This function deliberately contains no rates, thresholds, defaults, period
 * rules, or persistence logic. Callers must resolve and snapshot those values
 * before invoking the engine.
 */
export function calculateFinance(input: FinanceEngineInput): FinanceEngineResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("finance input must be an object");
  }

  for (const component of FINANCE_COMPONENTS) {
    assertInputComponent(component, input[component]);
  }

  const grossRevenue = BigInt(input.grossRevenue);
  const operatingExpense = sumComponents(input, OPERATING_EXPENSE_COMPONENTS);
  const kpiExpense = sumComponents(input, KPI_EXPENSE_COMPONENTS);
  const monthEndExpense = BigInt(input.monthEndExpense);
  const operatingProfit = grossRevenue - operatingExpense;
  const profitAfterKpi = operatingProfit - kpiExpense;
  const totalExpense = operatingExpense + kpiExpense + monthEndExpense;
  const finalProfit = profitAfterKpi - monthEndExpense;
  const distributableProfit = finalProfit > 0n ? finalProfit : 0n;

  return Object.freeze({
    ...input,
    operatingExpense: toSafeNumber(operatingExpense, "operatingExpense"),
    operatingProfit: toSafeNumber(operatingProfit, "operatingProfit"),
    kpiExpense: toSafeNumber(kpiExpense, "kpiExpense"),
    profitAfterKpi: toSafeNumber(profitAfterKpi, "profitAfterKpi"),
    totalExpense: toSafeNumber(totalExpense, "totalExpense"),
    finalProfit: toSafeNumber(finalProfit, "finalProfit"),
    distributableProfit: toSafeNumber(distributableProfit, "distributableProfit"),
  });
}
