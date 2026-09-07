import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedPolicy } from "./helpers/profit-distribution-fixtures.mjs";

const directory = await mkdtemp(join(tmpdir(), "dore-store-manager-payroll-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const [runtime, auth, payroll, finance, distributions, salary, guards] = await Promise.all([
  import("../db/runtime.ts"), import("../app/api/_lib/auth.ts"), import("../app/api/payroll/route.ts"),
  import("../app/api/_lib/store-finance.ts"), import("../app/lib/profit-distributions.ts"),
  import("../app/lib/store-manager-salary.ts"), import("../db/store-manager-salary-guards.ts"),
]);
const db = await runtime.initDb();
const period = "2026-08";
const storeId = "salary-store";
const token = "salary-store-token";
const req = (body, session = token) => new Request(`http://localhost/api/payroll?storeId=${storeId}&period=${period}`, {
  method: body ? "POST" : "GET", headers: { cookie: `dore_session=${session}`, "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const save = (managerSalary, expectedSalaryVersion, extra = {}) => payroll.POST(req({
  action: "SET_MANAGER_SALARY", storeId, period, managerSalary, expectedSalaryVersion, ...extra,
}));

before(async () => {
  await db.prepare("DELETE FROM stores").run();
  await db.prepare(`INSERT INTO stores (id,name,address,status,created_at) VALUES
    (?, 'DORE salary', '', 'ACTIVE', '2026-08-01T00:00:00.000Z'),
    ('other-store', 'DORE future', '', 'ACTIVE', '2026-09-01T00:00:00.000Z')`).bind(storeId).run();
  await db.prepare(`INSERT INTO users (id,username,password_hash,role,name,store_id,is_super_admin)
    VALUES ('salary-manager','salary-manager','unused','MANAGER','Manager',?,0)`).bind(storeId).run();
  await db.prepare(`INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at)
    VALUES ('salary-session','salary-manager',?,?,?)`).bind(await auth.sha256(token), Date.now() + 600_000, new Date().toISOString()).run();
  await seedPolicy(db, { employeeKpiTiers: [
    { minimumProfitPerHour: 30_000, rateBasisPoints: 0 },
    { minimumProfitPerHour: 15_000, rateBasisPoints: 0 },
    { minimumProfitPerHour: 7_000, rateBasisPoints: 0 },
  ] });
  await db.prepare(`INSERT INTO employees (id,store_id,code,name,position,phone,hourly_rate,status)
    VALUES ('salary-employee',?,'SALARY-001','Employee','Bán hàng','0900000001',0,'ACTIVE')`).bind(storeId).run();
  await db.prepare(`INSERT INTO shift_sessions
    (id,shift_code,store_id,employee_id,shift_name,work_date,applied_hourly_rate,started_at,ended_at,duration_seconds,tiktok_allowance,close_status,status)
    VALUES ('salary-shift','SALARY-SHIFT',?,'salary-employee','Ca 1','2026-08-10',0,
      '2026-08-10T01:00:00.000Z','2026-08-10T02:00:00.000Z',3600,0,'CLOSED','COMPLETED')`).bind(storeId).run();
  await db.prepare(`INSERT INTO orders (id,code,store_id,employee_id,shift_code,amount,payment_method,status,created_at)
    VALUES ('salary-order','SALARY-ORDER',?,'salary-employee','SALARY-SHIFT',10000000,'CASH','COMPLETED','2026-08-10T02:00:00.000Z')`).bind(storeId).run();
});
after(async () => { db.close?.(); await rm(directory, { recursive: true, force: true }); });

test("salary configuration validates scope, amount and version; concurrent saves cannot overwrite", async () => {
  assert.equal((await save(4_000_000, 0, { storeId: "other-store" })).status, 403);
  assert.equal((await payroll.POST(req({ action: "SET_MANAGER_SALARY", storeId, period, managerSalary: 1, expectedSalaryVersion: 0 }, "anonymous"))).status, 403);
  for (const amount of [-1, 1.5, "4000000", null, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await save(amount, 0)).status, 400);
  assert.equal((await save(1, -1)).status, 400);
  assert.equal((await save(1, Number.MAX_SAFE_INTEGER)).status, 400);
  const responses = await Promise.all([save(4_000_000, 0), save(5_000_000, 0)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const first = await salary.readStoreManagerSalary(db, storeId, period);
  assert.equal(first.version, 1);
  assert.equal((await save(4_000_000, 1)).status, 200);
  assert.equal((await save(9_000_000, 1)).status, 409);
  assert.equal(await db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action='STORE_MANAGER_SALARY_SET'").first("COUNT(*)"), 2);
});

test("store payroll and profit sharing deduct manager salary and formula bonus exactly once", async () => {
  let response = await payroll.GET(req());
  assert.equal(response.status, 200);
  let data = await response.json();
  assert.equal(data.summary.managerSalary, 4_000_000);
  assert.equal(data.summary.managerSalaryVersion, 2);
  assert.equal(data.summary.managerBonus, 120_000);
  assert.equal(data.summary.managerTotal, 4_120_000);
  assert.equal(data.summary.netProfit, 5_880_000);
  let financial = await finance.storePeriodFinance(db, storeId, period);
  assert.equal(financial.expense, 4_120_000);
  assert.equal(financial.finalProfit, 5_880_000);
  for (const action of ["CONFIRM_PERIOD", "CONFIRM_PAYMENT", "CLOSE_PERIOD"]) {
    response = await payroll.POST(req({ action, storeId, period, expectedRevision: data.financialPeriod?.revision ?? 0 }));
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal((await save(9_000_000, 2)).status, 409, "salary stays frozen throughout settlement");
    data = await (await payroll.GET(req())).json();
    assert.equal(data.summary.managerSalary, 4_000_000);
  }
  financial = await finance.storePeriodFinance(db, storeId, period);
  assert.equal(financial.finalProfit, 5_880_000);
  assert.equal(await db.prepare("SELECT SUM(amount) AS amount FROM cashflow_entries WHERE store_id = ?").bind(storeId).first("amount"), 4_120_000);
  const sharing = await distributions.closeProfitDistribution(db, {
    period, actorId: "salary-manager", reason: "Test", setupRepayments: [{ storeId, amount: 2_000_000 }],
  });
  assert.equal(sharing.totalFinalProfit, 5_880_000);
  assert.equal(sharing.totalDistributableProfit, 3_880_000);
  assert.deepEqual(sharing.members.map((member) => member.amount), [1_552_000, 2_328_000]);
  await assert.rejects(db.prepare("UPDATE business_records SET data_json = json_set(data_json, '$.amount', 1) WHERE category='STORE_MANAGER_SALARY'").run(), /manager salary is frozen/);
});

test("salary migration and runtime enforce identical guards", async () => {
  const sql = await readFile(new URL("../drizzle/0034_store_manager_salary.sql", import.meta.url), "utf8");
  assert.equal(sql, guards.storeManagerSalaryGuardStatements.join(";\n--> statement-breakpoint\n") + ";\n");
});

test("manager payroll CSV preserves values and quotes untrusted store names safely", async () => {
  const { csvContent } = await import("../app/lib/export-csv.ts");
  const output = csvContent([["Cửa hàng", "Lương", "Lợi nhuận"], ['DORE "A", B', 4_000_000, -100], ["=1+1", 0, null]]);
  assert.equal(output, '\uFEFF"Cửa hàng","Lương","Lợi nhuận"\r\n"DORE ""A"", B","4000000","-100"\r\n"\'=1+1","0",""');
});

test("a salary edit during calculation rejects the stale financial snapshot atomically", async () => {
  const lifecycle = await import("../app/api/_lib/financial-period-lifecycle.ts");
  const context = { storeId, period: "2026-09", actorId: "salary-manager", now: "2026-10-01T00:00:00.000Z", reason: "Race test" };
  await db.batch(lifecycle.prepareFinancialPeriodDraftPlan(db, { ...context, id: "salary-race-period" }).statements);
  const current = await lifecycle.readFinancialPeriodLifecycleRow(db, storeId, context.period);
  const plan = lifecycle.prepareFinancialPeriodTransitionPlan(db, {
    ...context, current, toStatus: "CALCULATED", calculation: {
      policyVersionId: "policy-v3", configVersion: 3, totalHoursSeconds: 0, salaryAdvance: 0,
      employeePayrollRows: [], managerPayroll: {}, configSnapshot: { payrollSummary: { managerSalaryVersion: 0 } },
      finance: { grossRevenue: 10_000_000, managerSalary: 3_000_000, employeeSalary: 0,
        fixedExpense: 0, variableExpense: 0, inventoryCost: 0, inventoryShippingCost: 0,
        manualEmployeeBonus: 0, employeeAllowance: 0, employeeKpiTotal: 0, managerKpi: 0, monthEndExpense: 0 },
    },
  });
  await salary.saveStoreManagerSalary(db, { ...context, amount: 4_000_000, expectedVersion: 0 });
  await assert.rejects(db.batch(plan.statements), /manager salary changed during calculation/);
  assert.equal((await lifecycle.readFinancialPeriodLifecycleRow(db, storeId, context.period)).status, "DRAFT");
});
