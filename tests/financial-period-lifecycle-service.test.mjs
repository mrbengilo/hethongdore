import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [{ createSqliteDatabase }, lifecycle] = await Promise.all([
  import("../db/sqlite.ts"),
  import("../app/api/_lib/financial-period-lifecycle.ts"),
]);

function migrationStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function database() {
  const db = await createSqliteDatabase(":memory:");
  await db.prepare("CREATE TABLE stores (id TEXT PRIMARY KEY NOT NULL)").run();
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
  const migration = await readFile(new URL("../drizzle/0027_finance_engine_foundation.sql", import.meta.url), "utf8");
  // The service only needs the policy and canonical-period tables. Dedicated
  // migration tests cover the remaining ledger tables and triggers.
  for (const statement of migrationStatements(migration).slice(0, 7)) await db.prepare(statement).run();
  await db.prepare("INSERT INTO stores (id) VALUES (?)").bind("store-a").run();
  await db.prepare(`INSERT INTO financial_policy_versions
      (id, version, effective_from_period, policy_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind("policy-v3", 3, "2026-08", '{"managerSalary":5000000}', "admin-a", "2026-08-01T00:00:00.000Z")
    .run();
  return db;
}

function calculation(overrides = {}) {
  return {
    policyVersionId: "policy-v3",
    configVersion: 3,
    finance: {
      grossRevenue: 100_000_000,
      fixedExpense: 10_000_000,
      variableExpense: 5_000_000,
      inventoryCost: 30_000_000,
      inventoryShippingCost: 2_000_000,
      employeeSalary: 15_000_000,
      managerSalary: 5_000_000,
      manualEmployeeBonus: 2_000_000,
      employeeAllowance: 1_000_000,
      employeeKpiTotal: 1_500_000,
      managerKpi: 600_000,
      monthEndExpense: 2_900_000,
      ...(overrides.finance ?? {}),
    },
    totalHoursSeconds: 288_000,
    salaryAdvance: 3_000_000,
    employeePayrollRows: [
      { employeeId: "employee-a", salary: 15_000_000, advance: 3_000_000, netPayable: 13_000_000 },
    ],
    managerPayroll: { managerSalary: 5_000_000, managerKpi: 600_000, total: 5_600_000 },
    configSnapshot: {
      policyVersionId: "policy-v3",
      managerSalary: 5_000_000,
      employeeKpiThresholds: [{ threshold: 30_000, rate: 7 }],
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "finance")),
  };
}

async function applyPlan(db, plan) {
  const results = await db.batch([...plan.statements]);
  lifecycle.assertFinancialPeriodPlanApplied(results, plan);
  return lifecycle.readFinancialPeriodLifecycleRow(db, plan.storeId, plan.period);
}

test("canonical lifecycle plans enforce adjacent transitions, CAS revisions, full snapshots and audit history", async () => {
  const db = await database();
  try {
    const draftPlan = lifecycle.prepareFinancialPeriodDraftPlan(db, {
      id: "period-a-2026-08",
      storeId: "store-a",
      period: "2026-08",
      actorId: "admin-a",
      now: "2026-09-01T00:00:00.000Z",
      reason: "Khởi tạo kỳ tài chính tháng",
      auditId: "audit-draft",
    });
    let row = await applyPlan(db, draftPlan);
    assert.equal(row.status, "DRAFT");
    assert.equal(row.revision, 0);

    const calculatedPlan = lifecycle.prepareFinancialPeriodTransitionPlan(db, {
      current: row,
      toStatus: "CALCULATED",
      actorId: "admin-a",
      now: "2026-09-01T00:01:00.000Z",
      reason: "Tổng hợp dữ liệu nguồn",
      calculation: calculation(),
      auditId: "audit-calculated",
    });
    row = await applyPlan(db, calculatedPlan);
    const staleCalculated = row;
    assert.equal(row.status, "CALCULATED");
    assert.equal(row.revision, 1);
    assert.equal(row.calculation.finance.operatingProfit, 30_000_000);
    assert.equal(row.snapshot, null);

    const reconcilingPlan = lifecycle.prepareFinancialPeriodTransitionPlan(db, {
      current: row,
      toStatus: "RECONCILING",
      actorId: "manager-a",
      now: "2026-09-01T00:02:00.000Z",
      reason: "Bắt đầu đối soát",
      auditId: "audit-reconciling",
    });
    row = await applyPlan(db, reconcilingPlan);
    assert.equal(row.status, "RECONCILING");
    assert.equal(row.revision, 2);

    const stalePlan = lifecycle.prepareFinancialPeriodTransitionPlan(db, {
      current: staleCalculated,
      toStatus: "RECONCILING",
      actorId: "manager-a",
      now: "2026-09-01T00:02:30.000Z",
      reason: "Yêu cầu đồng thời đã cũ",
      auditId: "audit-stale",
    });
    const staleResults = await db.batch([...stalePlan.statements]);
    assert.throws(
      () => lifecycle.assertFinancialPeriodPlanApplied(staleResults, stalePlan),
      (error) => error instanceof lifecycle.FinancialPeriodLifecycleConflictError && error.code === "STALE",
    );
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE id = 'audit-stale'").first("count"), 0);

    const reconciledCalculation = calculation({ finance: { fixedExpense: 11_000_000 } });
    const recalculationPlan = lifecycle.prepareFinancialPeriodRecalculationPlan(db, {
      current: row,
      actorId: "manager-a",
      now: "2026-09-01T00:03:00.000Z",
      reason: "Đối soát bổ sung chi phí cố định",
      calculation: reconciledCalculation,
      auditId: "audit-recalculated",
    });
    row = await applyPlan(db, recalculationPlan);
    assert.equal(row.status, "RECONCILING");
    assert.equal(row.revision, 3);
    assert.equal(row.calculation.finance.operatingProfit, 29_000_000);

    const confirmationPlan = lifecycle.prepareFinancialPeriodTransitionPlan(db, {
      current: row,
      toStatus: "CONFIRMED",
      actorId: "manager-a",
      now: "2026-09-02T01:00:00.000Z",
      reason: "Xác nhận số liệu đã đối soát",
      calculation: reconciledCalculation,
      auditId: "audit-confirmed",
    });
    row = await applyPlan(db, confirmationPlan);
    assert.equal(row.status, "CONFIRMED");
    assert.equal(row.revision, 4);
    assert.equal(row.snapshot.finance.finalProfit, 24_000_000);
    assert.equal(row.snapshot.finance.distributableProfit, 24_000_000);
    assert.equal(row.snapshot.salaryAdvance, 3_000_000);
    assert.equal(row.snapshot.totalHoursSeconds, 288_000);
    assert.equal(row.snapshot.employeePayrollRows[0].employeeId, "employee-a");
    assert.equal(row.snapshot.managerPayroll.managerSalary, 5_000_000);
    assert.equal(row.snapshot.configSnapshot.managerSalary, 5_000_000);

    const rawConfirmed = await db.prepare(`SELECT employee_payroll_rows_json AS employees,
        manager_payroll_json AS manager, config_snapshot_json AS config, snapshot_json AS snapshot
      FROM financial_periods WHERE id = ?`).bind(row.id).first();
    const fullSnapshot = JSON.parse(rawConfirmed.snapshot);
    assert.deepEqual(JSON.parse(rawConfirmed.employees), fullSnapshot.employeePayrollRows);
    assert.deepEqual(JSON.parse(rawConfirmed.manager), fullSnapshot.managerPayroll);
    assert.deepEqual(JSON.parse(rawConfirmed.config), fullSnapshot.configSnapshot);
    assert.equal(fullSnapshot.salaryAdvance, 3_000_000);
    assert.equal(fullSnapshot.finance.totalExpense, 76_000_000);

    const paidPlan = lifecycle.prepareFinancialPeriodTransitionPlan(db, {
      current: row,
      toStatus: "PAID",
      actorId: "manager-a",
      now: "2026-09-03T01:00:00.000Z",
      reason: "Xác nhận đã chi",
      auditId: "audit-paid",
    });
    row = await applyPlan(db, paidPlan);
    assert.equal(row.status, "PAID");
    assert.equal(row.revision, 5);
    assert.equal(row.snapshot.paidBy, "manager-a");
    assert.equal(row.snapshot.finance.finalProfit, 24_000_000);

    const lockedPlan = lifecycle.prepareFinancialPeriodTransitionPlan(db, {
      current: row,
      toStatus: "LOCKED",
      actorId: "admin-a",
      now: "2026-09-04T01:00:00.000Z",
      reason: "Khóa sổ kỳ tài chính",
      auditId: "audit-locked",
    });
    row = await applyPlan(db, lockedPlan);
    assert.equal(row.status, "LOCKED");
    assert.equal(row.revision, 6);
    assert.equal(row.snapshot.lockedBy, "admin-a");
    assert.equal(row.snapshot.employeePayrollRows[0].netPayable, 13_000_000);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs").first("count"), 7);

    const actions = (await db.prepare("SELECT action FROM audit_logs ORDER BY created_at, id").all()).results
      .map((entry) => entry.action);
    assert.deepEqual(actions, [
      "FINANCIAL_PERIOD_CREATE",
      "FINANCIAL_PERIOD_CALCULATED",
      "FINANCIAL_PERIOD_RECONCILING",
      "FINANCIAL_PERIOD_RECALCULATE",
      "FINANCIAL_PERIOD_CONFIRMED",
      "FINANCIAL_PERIOD_PAID",
      "FINANCIAL_PERIOD_LOCKED",
    ]);
  } finally {
    db.close();
  }
});

test("snapshot builders reject malformed payroll/config data and invalid lifecycle chronology", () => {
  assert.throws(
    () => lifecycle.buildFinancialPeriodCalculation(calculation({ employeePayrollRows: [null] })),
    /employeePayrollRows\[0\] must be a JSON object/u,
  );
  assert.throws(
    () => lifecycle.buildFinancialPeriodCalculation(calculation({ configSnapshot: { invalid: Number.NaN } })),
    /finite JSON numbers/u,
  );

  const confirmed = lifecycle.buildCanonicalFinancialPeriodSnapshot({
    storeId: "store-a",
    period: "2026-08",
    calculation: calculation(),
    confirmedAt: "2026-09-02T01:00:00.000Z",
    confirmedBy: "manager-a",
  });
  assert.throws(
    () => lifecycle.advanceCanonicalFinancialPeriodSnapshot({ ...confirmed, status: "PAID" }, {
      toStatus: "LOCKED",
      actorId: "admin-a",
      now: "2026-09-04T01:00:00.000Z",
    }),
    /LOCKED requires a previously paid/u,
  );
  assert.throws(
    () => lifecycle.advanceCanonicalFinancialPeriodSnapshot(confirmed, {
      toStatus: "PAID",
      actorId: "manager-a",
      now: "2026-09-01T01:00:00.000Z",
    }),
    /paidAt cannot be earlier/u,
  );
});
