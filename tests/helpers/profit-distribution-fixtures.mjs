import { readFile } from "node:fs/promises";
import { createSqliteDatabase } from "../../db/sqlite.ts";
import * as financeEngine from "../../app/lib/finance-engine.ts";

export const policy = {
  schemaVersion: 1,
  managerMonthlySalaryVnd: 3_000_000,
  managerKpiRateBasisPoints: 200,
  employeeKpiTiers: [],
  allowances: {},
  profitSharingMembers: [
    { memberId: "member-a", name: "Thành viên A", rateBasisPoints: 4_000 },
    { memberId: "member-b", name: "Thành viên B", rateBasisPoints: 6_000 },
  ],
};

export async function seedPolicy(db, overrides = {}) {
  const selected = { ...policy, ...overrides };
  await db.prepare(`INSERT INTO financial_policy_versions
      (id, version, effective_from_period, policy_json, created_by, created_at)
    VALUES ('policy-v3', 3, '2026-08', ?, 'admin-a', '2026-08-01T00:00:00.000Z')`)
    .bind(JSON.stringify(selected))
    .run();
}

function financeForFinalProfit(finalProfit) {
  return financeEngine.calculateFinance({
    grossRevenue: Math.max(0, finalProfit),
    fixedExpense: Math.max(0, -finalProfit),
    variableExpense: 0,
    inventoryCost: 0,
    inventoryShippingCost: 0,
    employeeSalary: 0,
    managerSalary: 0,
    manualEmployeeBonus: 0,
    employeeAllowance: 0,
    employeeKpiTotal: 0,
    managerKpi: 0,
    monthEndExpense: 0,
  });
}

export async function seedPeriod(db, storeId, finalProfit, options = {}) {
  const status = options.status ?? "LOCKED";
  const finance = financeForFinalProfit(finalProfit);
  const snapshot = options.snapshot ?? {
    schemaVersion: 1,
    storeId,
    period: "2026-08",
    status,
    policyVersionId: "policy-v3",
    configVersion: 3,
    finance,
    totalHoursSeconds: 0,
    salaryAdvance: 0,
    employeePayrollRows: [],
    managerPayroll: {},
    configSnapshot: { policyVersionId: "policy-v3", configVersion: 3 },
    confirmedAt: "2026-09-01T00:00:00.000Z",
    confirmedBy: "manager-a",
    paidAt: status === "CONFIRMED" ? null : "2026-09-02T00:00:00.000Z",
    paidBy: status === "CONFIRMED" ? null : "manager-a",
    lockedAt: status === "LOCKED" ? "2026-09-03T00:00:00.000Z" : null,
    lockedBy: status === "LOCKED" ? "admin-a" : null,
  };
  const lifecycle = {
    calculatedAt: "2026-08-31T17:00:00.000Z",
    calculatedBy: "SYSTEM",
    confirmedAt: "2026-09-01T00:00:00.000Z",
    confirmedBy: "manager-a",
    paidAt: status === "CONFIRMED" ? null : "2026-09-02T00:00:00.000Z",
    paidBy: status === "CONFIRMED" ? null : "manager-a",
    lockedAt: status === "LOCKED" ? "2026-09-03T00:00:00.000Z" : null,
    lockedBy: status === "LOCKED" ? "admin-a" : null,
  };
  await db.prepare(`INSERT INTO financial_periods
      (id, store_id, period, status, policy_version_id, config_version, revision,
       gross_revenue, fixed_expense, variable_expense, inventory_cost,
       inventory_shipping_cost, employee_salary, manager_salary, manual_bonus,
       allowance, total_hours_seconds, employee_kpi_total, manager_kpi,
       operating_profit, profit_after_kpi, month_end_expense, final_profit,
       distributable_profit, salary_advance, employee_payroll_rows_json,
       manager_payroll_json, config_snapshot_json, snapshot_json,
       calculated_at, calculated_by, confirmed_at, confirmed_by, paid_at, paid_by,
       locked_at, locked_by, created_at, updated_at)
    VALUES (?, ?, '2026-08', ?, 'policy-v3', 3, 6,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, '[]', '{}', '{}', ?,
      ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-09-03T00:00:00.000Z')`)
    .bind(
      `period-${storeId}`,
      storeId,
      status,
      finance.grossRevenue,
      finance.fixedExpense,
      finance.variableExpense,
      finance.inventoryCost,
      finance.inventoryShippingCost,
      finance.employeeSalary,
      finance.managerSalary,
      finance.manualEmployeeBonus,
      finance.employeeAllowance,
      finance.employeeKpiTotal,
      finance.managerKpi,
      finance.operatingProfit,
      finance.profitAfterKpi,
      finance.monthEndExpense,
      finance.finalProfit,
      finance.distributableProfit,
      JSON.stringify(snapshot),
      lifecycle.calculatedAt,
      lifecycle.calculatedBy,
      lifecycle.confirmedAt,
      lifecycle.confirmedBy,
      lifecycle.paidAt,
      lifecycle.paidBy,
      lifecycle.lockedAt,
      lifecycle.lockedBy,
    )
    .run();
}

function migrationStatements(source) {
  return source.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

export async function createProfitDistributionDatabase(storeIds = ["store-a", "store-b", "store-c", "store-d"], withSetup = true) {
  const db = await createSqliteDatabase(":memory:");
  await db.prepare(`CREATE TABLE stores (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT,
    store_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  )`).run();
  const [foundation, distributionMigration] = await Promise.all([
    readFile(new URL("../../drizzle/0027_finance_engine_foundation.sql", import.meta.url), "utf8"),
    readFile(new URL("../../drizzle/0032_profit_distributions.sql", import.meta.url), "utf8"),
  ]);
  // Policy/period tables and indexes are the first seven statements. The
  // remaining foundation tables have their own focused migration tests.
  for (const statement of migrationStatements(foundation).slice(0, 7)) await db.prepare(statement).run();
  for (const statement of migrationStatements(distributionMigration)) await db.prepare(statement).run();
  const setupMigration = await readFile(new URL("../../drizzle/0033_profit_setup_repayment.sql", import.meta.url), "utf8");
  if (withSetup) for (const statement of migrationStatements(setupMigration)) await db.prepare(statement).run();
  const savedSetupMigration = await readFile(new URL("../../drizzle/0035_saved_profit_setup_repayments.sql", import.meta.url), "utf8");
  for (const statement of migrationStatements(savedSetupMigration)) await db.prepare(statement).run();
  const createdAt = "2026-08-01T00:00:00.000Z";
  for (const id of storeIds) {
    await db.prepare("INSERT INTO stores (id, name, status, created_at) VALUES (?, ?, 'ACTIVE', ?)")
      .bind(id, `DORE ${id.toUpperCase()}`, createdAt)
      .run();
  }
  return db;
}
