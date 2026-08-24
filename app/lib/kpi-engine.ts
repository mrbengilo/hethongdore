export type EmployeeKpiTier = Readonly<{
  minProfitPerHour: number;
  employeeRateBps: number;
}>;

export type KpiEngineConfig = Readonly<{
  tiers: readonly EmployeeKpiTier[];
  managerRateBps: number;
}>;

export type EmployeeKpiInput = Readonly<{
  employeeId: string;
  actualSeconds: number;
}>;

export type KpiEngineInput = Readonly<{
  operatingProfit: number;
  employees: readonly EmployeeKpiInput[];
  config: KpiEngineConfig;
}>;

export type EmployeeKpiAllocation = Readonly<{
  employeeId: string;
  actualSeconds: number;
  actualHours: number;
  employeeKpi: number;
}>;

export type KpiEngineResult = Readonly<{
  operatingProfit: number;
  totalEmployeeSeconds: number;
  totalEmployeeHours: number;
  profitPerHour: number;
  selectedTier: EmployeeKpiTier | null;
  employeeRateBps: number;
  employeeKpiPool: number;
  employeeKpiTotal: number;
  employeeAllocations: readonly EmployeeKpiAllocation[];
  managerRateBps: number;
  managerKpi: number;
}>;

const BASIS_POINTS_DENOMINATOR = 10_000n;
const SECONDS_PER_HOUR = 3_600n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = -MAX_SAFE_INTEGER;

function assertSafeInteger(value: unknown, name: string, allowNegative = false): asserts value is number {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isSafeInteger(value)
    || (!allowNegative && value < 0)) {
    throw new TypeError(`${name} must be a finite ${allowNegative ? "" : "non-negative "}safe integer`);
  }
}

function assertBasisPoints(value: unknown, name: string): asserts value is number {
  assertSafeInteger(value, name);
  if (value > Number(BASIS_POINTS_DENOMINATOR)) {
    throw new RangeError(`${name} must be between 0 and 10000 basis points`);
  }
}

function toSafeNumber(value: bigint, name: string): number {
  if (value < MIN_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} exceeds the safe integer range`);
  }
  return Number(value);
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("rounding denominator must be positive");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function amountAtBasisPoints(amount: number, rateBps: number, name: string): number {
  return toSafeNumber(
    roundHalfUp(BigInt(amount) * BigInt(rateBps), BASIS_POINTS_DENOMINATOR),
    name,
  );
}

function validateConfig(config: KpiEngineConfig): EmployeeKpiTier[] {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("KPI config must be an object");
  }
  if (!Array.isArray(config.tiers)) throw new TypeError("KPI tiers must be an array");
  assertBasisPoints(config.managerRateBps, "managerRateBps");

  const thresholds = new Set<number>();
  const tiers = config.tiers.map((tier, index) => {
    if (tier === null || typeof tier !== "object" || Array.isArray(tier)) {
      throw new TypeError(`tiers[${index}] must be an object`);
    }
    assertSafeInteger(tier.minProfitPerHour, `tiers[${index}].minProfitPerHour`);
    assertBasisPoints(tier.employeeRateBps, `tiers[${index}].employeeRateBps`);
    if (thresholds.has(tier.minProfitPerHour)) {
      throw new TypeError(`KPI tier threshold ${tier.minProfitPerHour} is duplicated`);
    }
    thresholds.add(tier.minProfitPerHour);
    return Object.freeze({
      minProfitPerHour: tier.minProfitPerHour,
      employeeRateBps: tier.employeeRateBps,
    });
  });

  const highestEmployeeRateBps = tiers.reduce(
    (highest, tier) => Math.max(highest, tier.employeeRateBps),
    0,
  );
  if (config.managerRateBps + highestEmployeeRateBps > Number(BASIS_POINTS_DENOMINATOR)) {
    throw new RangeError("combined manager and employee KPI rates must not exceed 10000 basis points");
  }

  return tiers.sort((left, right) => right.minProfitPerHour - left.minProfitPerHour);
}

function normalizeEmployees(employees: readonly EmployeeKpiInput[]) {
  if (!Array.isArray(employees)) throw new TypeError("employees must be an array");
  const employeeIds = new Set<string>();
  let totalSeconds = 0n;

  const normalized = employees.map((employee, index) => {
    if (employee === null || typeof employee !== "object" || Array.isArray(employee)) {
      throw new TypeError(`employees[${index}] must be an object`);
    }
    const employeeId = typeof employee.employeeId === "string" ? employee.employeeId.trim() : "";
    if (!employeeId) throw new TypeError(`employees[${index}].employeeId must be a non-empty string`);
    if (employeeIds.has(employeeId)) throw new TypeError(`employeeId ${employeeId} is duplicated`);
    employeeIds.add(employeeId);
    assertSafeInteger(employee.actualSeconds, `employees[${index}].actualSeconds`);
    const actualSeconds = employee.actualSeconds;
    totalSeconds += BigInt(actualSeconds);
    return { employeeId, actualSeconds };
  });

  return {
    employees: normalized,
    totalSeconds: toSafeNumber(totalSeconds, "totalEmployeeSeconds"),
  };
}

function selectTier(
  operatingProfit: number,
  totalEmployeeSeconds: number,
  tiersDescending: readonly EmployeeKpiTier[],
) {
  if (operatingProfit <= 0 || totalEmployeeSeconds <= 0) return null;
  const profitPerHourNumerator = BigInt(operatingProfit) * SECONDS_PER_HOUR;
  const totalSeconds = BigInt(totalEmployeeSeconds);
  return tiersDescending.find((tier) => (
    profitPerHourNumerator >= BigInt(tier.minProfitPerHour) * totalSeconds
  )) ?? null;
}

function allocateEmployeePool(
  employeePool: number,
  employees: readonly { employeeId: string; actualSeconds: number }[],
  totalEmployeeSeconds: number,
) {
  if (employeePool <= 0 || totalEmployeeSeconds <= 0) return employees.map(() => 0);

  const pool = BigInt(employeePool);
  const denominator = BigInt(totalEmployeeSeconds);
  let baseTotal = 0n;
  const shares = employees.map((employee, index) => {
    const weightedPool = pool * BigInt(employee.actualSeconds);
    const base = weightedPool / denominator;
    baseTotal += base;
    return {
      index,
      employeeId: employee.employeeId,
      actualSeconds: employee.actualSeconds,
      base,
      remainder: weightedPool % denominator,
    };
  });

  const remaining = toSafeNumber(pool - baseTotal, "employeeKpiRoundingRemainder");
  const priority = shares
    .filter((share) => share.actualSeconds > 0)
    .sort((left, right) => {
      if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
      if (left.employeeId === right.employeeId) return left.index - right.index;
      return left.employeeId < right.employeeId ? -1 : 1;
    });
  if (remaining > priority.length) throw new RangeError("employee KPI rounding remainder is invalid");

  const roundedUp = new Set(priority.slice(0, remaining).map((share) => share.index));
  return shares.map((share) => toSafeNumber(
    share.base + (roundedUp.has(share.index) ? 1n : 0n),
    `employeeKpi:${share.employeeId}`,
  ));
}

/**
 * Calculate KPI from an already-normalized operating profit and actual worked
 * seconds. Rates and thresholds are supplied by the caller so this engine has
 * no store, period, or policy defaults of its own.
 */
export function calculateKpi(input: KpiEngineInput): KpiEngineResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("KPI input must be an object");
  }
  assertSafeInteger(input.operatingProfit, "operatingProfit", true);
  const tiers = validateConfig(input.config);
  const normalized = normalizeEmployees(input.employees);
  const selectedTier = selectTier(input.operatingProfit, normalized.totalSeconds, tiers);
  const profitPerHour = input.operatingProfit > 0 && normalized.totalSeconds > 0
    ? toSafeNumber(
      BigInt(input.operatingProfit) * SECONDS_PER_HOUR / BigInt(normalized.totalSeconds),
      "profitPerHour",
    )
    : 0;
  const employeeRateBps = selectedTier?.employeeRateBps ?? 0;
  const employeeKpiPool = selectedTier
    ? amountAtBasisPoints(input.operatingProfit, employeeRateBps, "employeeKpiPool")
    : 0;
  const employeeKpis = allocateEmployeePool(
    employeeKpiPool,
    normalized.employees,
    normalized.totalSeconds,
  );
  const employeeKpiTotal = employeeKpis.reduce((total, amount) => total + BigInt(amount), 0n);
  const managerKpi = input.operatingProfit > 0
    ? amountAtBasisPoints(input.operatingProfit, input.config.managerRateBps, "managerKpi")
    : 0;

  return Object.freeze({
    operatingProfit: input.operatingProfit,
    totalEmployeeSeconds: normalized.totalSeconds,
    totalEmployeeHours: normalized.totalSeconds / Number(SECONDS_PER_HOUR),
    profitPerHour,
    selectedTier: selectedTier ? Object.freeze({ ...selectedTier }) : null,
    employeeRateBps,
    employeeKpiPool,
    employeeKpiTotal: toSafeNumber(employeeKpiTotal, "employeeKpiTotal"),
    employeeAllocations: Object.freeze(normalized.employees.map((employee, index) => Object.freeze({
      ...employee,
      actualHours: employee.actualSeconds / Number(SECONDS_PER_HOUR),
      employeeKpi: employeeKpis[index],
    }))),
    managerRateBps: input.config.managerRateBps,
    managerKpi,
  });
}
