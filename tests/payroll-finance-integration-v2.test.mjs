import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-payroll-finance-v2-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, payrollRoute, storeFinance, financialPolicy] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/payroll/route.ts"),
  import("../app/api/_lib/store-finance.ts"),
  import("../app/api/_lib/financial-policy.ts"),
]);

const db = await runtime.initDb();
const token = "payroll-finance-integration-v2-token";
const storeId = "payroll-finance-v2-store";
const employeeId = "payroll-finance-v2-employee";

function policy(managerSalary, managerRate, employeeRate) {
  const normalized = financialPolicy.normalizeFinancialPolicy({
    schemaVersion: 1,
    managerMonthlySalaryVnd: managerSalary,
    managerKpiRateBasisPoints: managerRate,
    employeeKpiTiers: [
      { minimumProfitPerHour: 30_000, rateBasisPoints: employeeRate },
      { minimumProfitPerHour: 15_000, rateBasisPoints: employeeRate },
      { minimumProfitPerHour: 7_000, rateBasisPoints: employeeRate },
    ],
    allowances: {},
    profitSharingMembers: [],
  });
  assert.ok(normalized);
  return normalized;
}

const mayPolicy = policy(1_000_000, 200, 300);
const junePolicy = policy(2_000_000, 400, 500);

function request(path) {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: `dore_session=${encodeURIComponent(token)}` },
  });
}

async function payroll(period, extra = "") {
  const response = await payrollRoute.GET(request(`/api/payroll?storeId=${storeId}&period=${period}${extra}`));
  assert.equal(response.status, 200);
  return response.json();
}

before(async () => {
  const now = "2026-04-01T00:00:00.000Z";
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES (?, 'DORE PAYROLL FINANCE V2', 'Test', 0, 0, 'ACTIVE', ?)`)
      .bind(storeId, now),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line,
         hourly_rate, tiktok_allowance, status)
      VALUES (?, ?, 'PFV2001', 'Nhân viên Finance V2', 'Bán hàng', '0900000200',
        'Test', 'Test', 'Test', 20000, 0, 'ACTIVE')`)
      .bind(employeeId, storeId),
    db.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, store_id, is_super_admin)
      VALUES ('payroll-finance-v2-manager', 'payroll-finance-v2-manager', ?,
        'MANAGER', 'Quản lý Finance V2', ?, 0)`)
      .bind(process.env.DORE_MANAGER_PASSWORD_HASH, storeId),
    db.prepare(`INSERT INTO financial_policy_versions
        (id, version, effective_from_period, policy_json, created_by, created_at)
      VALUES ('payroll-policy-may', 1, '2026-05', ?, 'payroll-finance-v2-manager', ?),
             ('payroll-policy-june', 2, '2026-06', ?, 'payroll-finance-v2-manager', ?)`)
      .bind(
        financialPolicy.serializeFinancialPolicy(mayPolicy), now,
        financialPolicy.serializeFinancialPolicy(junePolicy), now,
      ),
    db.prepare(`INSERT INTO employee_transfers
        (id, employee_id, source_store_id, target_store_id, start_date, end_date,
         shifts_json, support_hourly_rate, support_allowance, reason, status,
         created_by, created_at, updated_at)
      VALUES ('payroll-transfer-may', ?, 'payroll-home-store', ?, '2026-05-01', '2026-05-31',
        '["Ca 1"]', 20000, 0, 'Hỗ trợ kiểm thử', 'COMPLETED',
        'payroll-finance-v2-manager', ?, ?)`)
      .bind(employeeId, storeId, now, now),
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, work_date, transfer_id,
         applied_hourly_rate, started_at, ended_at, duration_seconds,
         tiktok_allowance, close_status, status)
      VALUES ('payroll-shift-may', 'PFV2-MAY', ?, ?, 'Ca 1', '2026-05-10',
        'payroll-transfer-may', 20000, '2026-05-10T01:00:00.000Z',
        '2026-05-10T02:00:00.000Z', 3600, 0, 'CLOSED', 'COMPLETED'),
       ('payroll-shift-june', 'PFV2-JUNE', ?, ?, 'Ca 1', '2026-06-10',
        NULL, 20000, '2026-06-10T01:00:00.000Z',
        '2026-06-10T02:00:00.000Z', 3600, 0, 'CLOSED', 'COMPLETED'),
       ('payroll-shift-june-reconciliation', 'PFV2-JUNE-RECONCILIATION', ?, ?, 'Ca bất thường', '2026-06-11',
        NULL, 20000, '2026-06-11T01:00:00.000Z',
        '2026-06-11T03:00:00.000Z', 7200, 0, 'CLOSED', 'COMPLETED')`)
      .bind(storeId, employeeId, storeId, employeeId, storeId, employeeId),
    db.prepare(`UPDATE shift_sessions
      SET attendance_max_shift_minutes = 60,
        reconciliation_status = 'REQUIRED',
        reconciliation_reason = 'Ca vượt thời lượng, chờ quản lý đối soát'
      WHERE id = 'payroll-shift-june-reconciliation'`),
    db.prepare(`INSERT INTO orders
        (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
      VALUES ('payroll-order-may', 'PFV2-00001', ?, ?, 'PFV2-MAY', 10000000, 'CASH', 'COMPLETED', '2026-05-10T02:30:00.000Z'),
             ('payroll-order-june', 'PFV2-00002', ?, ?, 'PFV2-JUNE', 10000000, 'CASH', 'COMPLETED', '2026-06-10T02:30:00.000Z'),
             ('payroll-order-july', 'PFV2-00003', ?, ?, 'PFV2-JULY', 2000000, 'CASH', 'COMPLETED', '2026-07-10T02:30:00.000Z')`)
      .bind(storeId, employeeId, storeId, employeeId, storeId, employeeId),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('payroll-finance-v2-session', 'payroll-finance-v2-manager', ?, ?, ?)`)
    .bind(await auth.sha256(token), Date.now() + 300_000, now).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("payroll preview uses the effective immutable policy and exactly matches store finance", async () => {
  for (const [period, expectedPolicy, version] of [
    ["2026-05", mayPolicy, 1],
    ["2026-06", junePolicy, 2],
  ]) {
    const body = await payroll(period);
    const summary = body.summary;
    const finance = await storeFinance.storePeriodFinance(db, storeId, period, expectedPolicy);
    assert.ok(finance);
    assert.equal(summary.payrollPolicy.version, version);
    assert.equal(summary.payrollPolicy.managerMonthlySalaryVnd, expectedPolicy.managerMonthlySalaryVnd);
    assert.equal(summary.payrollPolicy.managerKpiRatePercent, expectedPolicy.managerKpiRateBasisPoints / 100);
    assert.equal(summary.managerSalary, expectedPolicy.managerMonthlySalaryVnd);
    assert.equal(summary.revenue, finance.revenue);
    assert.equal(summary.profit, finance.operatingProfit);
    assert.equal(summary.totalKpiBonus, finance.expenseBreakdown.employeeKpiBonus);
    assert.equal(summary.managerBonus, finance.expenseBreakdown.managerBonus);
    assert.equal(summary.expense, finance.expense);
    assert.equal(summary.netProfit, finance.finalProfit);
    assert.equal(summary.totalDurationSeconds, 3600);
    assert.equal(summary.kpiEligibleDurationSeconds, 3600);
    assert.equal(summary.items[0].kpiDurationSeconds, 3600);
    assert.equal(summary.items[0].kpiCompletedShiftCount, 1);
  }
});

test("attendance awaiting reconciliation is excluded from payroll and Finance Engine inputs", async () => {
  const body = (await payroll("2026-06")).summary;
  const finance = await storeFinance.storePeriodFinance(db, storeId, "2026-06", junePolicy);
  assert.ok(finance);
  assert.equal(body.totalDurationSeconds, 3600);
  assert.equal(body.items[0].durationSeconds, 3600);
  assert.equal(body.items[0].baseSalary, 20_000);
  assert.equal(finance.expenseBreakdown.employeeBaseSalary, 20_000);
});

test("multiple short shifts round salary once per employee and snapshotted rate", async () => {
  await db.batch([
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, work_date,
         applied_hourly_rate, started_at, ended_at, duration_seconds,
         tiktok_allowance, close_status, status)
      VALUES ('payroll-rounding-shift-1', 'PFV2-ROUND-1', ?, ?, 'Ca ngắn 1', '2026-09-10',
        20000, '2026-09-10T01:00:00.000Z', '2026-09-10T01:00:01.000Z', 1,
        0, 'CLOSED', 'COMPLETED')`)
      .bind(storeId, employeeId),
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, work_date,
         applied_hourly_rate, started_at, ended_at, duration_seconds,
         tiktok_allowance, close_status, status)
      VALUES ('payroll-rounding-shift-2', 'PFV2-ROUND-2', ?, ?, 'Ca ngắn 2', '2026-09-11',
        20000, '2026-09-11T01:00:00.000Z', '2026-09-11T01:00:01.000Z', 1,
        0, 'CLOSED', 'COMPLETED')`)
      .bind(storeId, employeeId),
  ]);

  const body = (await payroll("2026-09")).summary;
  const finance = await storeFinance.storePeriodFinance(db, storeId, "2026-09", junePolicy);
  assert.ok(finance);
  assert.equal(body.items[0].durationSeconds, 2);
  assert.equal(body.items[0].baseSalary, 11);
  assert.equal(body.totalBaseSalary, 11);
  assert.equal(finance.expenseBreakdown.employeeBaseSalary, 11);
});

test("zero and negative operating profit never create employee or manager KPI", async () => {
  const zero = (await payroll("2026-07")).summary;
  assert.equal(zero.profit, 0);
  assert.equal(zero.totalKpiBonus, 0);
  assert.equal(zero.managerBonus, 0);
  assert.equal(zero.netProfit, 0);

  const negative = (await payroll("2026-08")).summary;
  assert.equal(negative.profit, -2_000_000);
  assert.equal(negative.totalKpiBonus, 0);
  assert.equal(negative.managerBonus, 0);
  assert.equal(negative.netProfit, -2_000_000);
});

test("locked manager rows retain snapshot amounts while metadata stays period-effective", async () => {
  const now = "2026-05-31T17:00:00.000Z";
  const snapshot = (await payroll("2026-05")).summary;
  await db.batch([
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES (?, 'KPI_SUMMARY', ?, 'payroll-finance-v2-manager', 'Snapshot khóa', ?, 'LOCKED', ?, ?)`)
      .bind(`kpi-summary:${storeId}:2026-05`, storeId, JSON.stringify(snapshot), now, now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES (?, 'PAYROLL_CLOSING', ?, 'payroll-finance-v2-manager', 'Chốt kỳ', ?, 'LOCKED', ?, ?)`)
      .bind(`payroll-closing:${storeId}:2026-05`, storeId, JSON.stringify({
        period: "2026-05",
        storeId,
        storeName: "DORE PAYROLL FINANCE V2",
        managerSalary: 333_333,
        managerBonus: 77_777,
        status: "LOCKED",
        closedAt: now,
      }), now, now),
  ]);

  const body = await payroll("2026-05", "&scope=manager");
  assert.equal(body.managerPayroll.policy.version, 1);
  assert.equal(body.managerPayroll.policy.salaryPerStore, mayPolicy.managerMonthlySalaryVnd);
  assert.equal(body.managerPayroll.policy.managerKpiRate, 0.02);
  assert.equal(body.managerPayroll.rows[0].managerSalary, 333_333);
  assert.equal(body.managerPayroll.rows[0].managerBonus, 77_777);
});
