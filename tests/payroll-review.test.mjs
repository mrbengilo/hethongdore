import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedPolicy } from "./helpers/profit-distribution-fixtures.mjs";

const directory = await mkdtemp(join(tmpdir(), "dore-payroll-review-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const [runtime, auth, payroll, finance, reviews, guards, lifecycle, records] = await Promise.all([
  import("../db/runtime.ts"), import("../app/api/_lib/auth.ts"), import("../app/api/payroll/route.ts"),
  import("../app/api/_lib/store-finance.ts"), import("../app/lib/payroll-review.ts"),
  import("../db/payroll-review-guards.ts"), import("../app/api/_lib/financial-period-lifecycle.ts"),
  import("../app/api/records/route.ts"),
]);
const db = await runtime.initDb();
const storeId = "review-store", period = "2026-08", employeeId = "review-one";
const request = (body, session = "review-manager", scope = storeId, month = period) => new Request(`http://localhost/api/payroll?storeId=${scope}&period=${month}`, {
  method: body ? "POST" : "GET", headers: { cookie: `dore_session=${session}`, "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function preview(scope = storeId, month = period) {
  const response = await payroll.GET(request(null, "review-admin", scope, month));
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
const values = { durationSeconds: 10800, kpiDurationSeconds: 3600, tiktokAllowance: 40000,
  supportAllowance: 50000, manualAllowance: 60000, manualBonus: 70000, kpiBonus: null };
async function save(data, override = {}, session = "review-manager") {
  const employee = data.summary.items.find((item) => item.employeeId === employeeId);
  return payroll.POST(request({ action: "SAVE_EMPLOYEE_REVIEW", storeId, period, employeeId,
    expectedReviewToken: data.reviewToken, expectedReviewVersion: employee?.review?.version ?? 0,
    values, reason: "Đối chiếu giờ và bổ sung phụ cấp", ...override }, session));
}
async function action(name, data = null, override = {}) {
  const source = data ?? await preview();
  return payroll.POST(request({ action: name, storeId, period, employeeId,
    expectedReviewToken: source.reviewToken, expectedRevision: source.financialPeriod?.revision ?? 0, ...override }));
}
async function okay(response, status = 200) {
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}
async function matched(data) {
  const financial = await finance.storePeriodFinance(db, storeId, period);
  assert.deepEqual(data.summary.costBreakdown, financial.expenseBreakdown);
  assert.equal(data.summary.netProfit, financial.finalProfit);
  const report = await finance.storeDateRangeFinance(db, storeId, { from: "2026-08-01", to: "2026-08-31" }, { payrollRecognition: "PREVIEW" });
  assert.deepEqual(report.expenseBreakdown, financial.expenseBreakdown);
  assert.equal(report.finalProfit, financial.finalProfit);
  const accounting = await finance.storeDateRangeFinance(db, storeId, { from: "2026-08-01", to: "2026-08-31" });
  for (const field of ["employeeBaseSalary","tiktokAllowance","supportAllowance","manualAllowance","manualBonus"]) {
    assert.equal(accounting.expenseBreakdown[field],financial.expenseBreakdown[field],`cash-flow accounting ${field}`);
  }
  if (data.financialPeriod.status === "LOCKED") assert.deepEqual(accounting.expenseBreakdown,financial.expenseBreakdown);
}

before(async () => {
  await db.prepare("DELETE FROM stores").run();
  await db.prepare(`INSERT INTO stores (id,name,address,status,created_at) VALUES
    (?, 'DORE review', '', 'ACTIVE', '2026-08-01T00:00:00.000Z'),
    ('review-other', 'DORE other', '', 'ACTIVE', '2026-09-01T00:00:00.000Z')`).bind(storeId).run();
  await db.prepare(`INSERT INTO employees (id,store_id,code,name,position,phone,hourly_rate,status) VALUES
    (?,?,'REV-001','Nhân viên Một','Bán hàng','0900000101',30000,'ACTIVE'),
    ('review-two',?,'REV-002','Nhân viên Hai','Bán hàng','0900000102',40000,'ACTIVE'),
    ('review-foreign','review-other','REV-003','Khác cửa hàng','Bán hàng','0900000103',25000,'ACTIVE')`).bind(employeeId,storeId,storeId).run();
  for (const [id, role, superAdmin] of [["review-manager","MANAGER",0],["review-admin","MANAGER",1],["review-employee","EMPLOYEE",0]]) {
    await db.prepare(`INSERT INTO users (id,username,password_hash,role,name,store_id,is_super_admin,employee_id)
      VALUES (?,?, 'unused',?,?, ?,?,?)`).bind(id,id,role,id,storeId,superAdmin,role === "EMPLOYEE" ? employeeId : null).run();
    await db.prepare(`INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)`)
      .bind(id,id,await auth.sha256(id),Date.now()+600000,new Date().toISOString()).run();
  }
  await seedPolicy(db, { employeeKpiTiers: [
    { minimumProfitPerHour: 30000, rateBasisPoints: 700 },
    { minimumProfitPerHour: 15000, rateBasisPoints: 500 },
    { minimumProfitPerHour: 7000, rateBasisPoints: 300 },
  ] });
  for (const [id, employee, rate, tik, date] of [["rev-1",employeeId,20000,10000,"10"],["rev-2",employeeId,30000,20000,"11"],["rev-3","review-two",40000,0,"12"]]) {
    await db.prepare(`INSERT INTO shift_sessions
      (id,shift_code,store_id,employee_id,shift_name,work_date,applied_hourly_rate,started_at,ended_at,duration_seconds,tiktok_allowance,close_status,status)
      VALUES (?,?,?,?,'Ca 1',?,?,?, ?,3600,?,'CLOSED','COMPLETED')`)
      .bind(id,id,storeId,employee,`2026-08-${date}`,rate,`2026-08-${date}T01:00:00.000Z`,`2026-08-${date}T02:00:00.000Z`,tik).run();
  }
  await db.prepare(`INSERT INTO orders (id,code,store_id,employee_id,shift_code,amount,payment_method,status,created_at)
    VALUES ('rev-order','REV-ORDER',?,?,'rev-1',10000000,'CASH','COMPLETED','2026-08-10T02:00:00.000Z')`).bind(storeId,employeeId).run();
});
after(async () => { db.close?.(); await rm(directory, { recursive: true, force: true }); });

test("review save enforces authorization, employee/store/month scope, numeric limits and dedicated API", async () => {
  const data = await preview();
  for (const token of ["anonymous","review-employee"]) assert.equal((await save(data,{},token)).status,403);
  assert.equal((await save(data,{storeId:"review-other"})).status,403);
  assert.equal((await save(data,{employeeId:"review-foreign"})).status,404);
  assert.equal((await save(data,{period:"2026-13"})).status,400);
  assert.equal((await save(data,{period:"2026-09"})).status,409);
  for (const invalid of [null,{}, {...values,manualBonus:-1}, {...values,manualBonus:1.2}, {...values,durationSeconds:2678401},
    {...values,kpiDurationSeconds:10801}, {...values,manualAllowance:Number.MAX_SAFE_INTEGER,manualBonus:1}]) {
    assert.equal((await save(data,{values:invalid})).status,400);
  }
  assert.equal((await save(data,{reason:""})).status,400);
  assert.equal((await save(data,{expectedReviewVersion:-1})).status,400);
  assert.equal((await save(data,{expectedReviewToken:"stale"})).status,409);
  assert.ok([400,403].includes((await records.POST(request({category:"PAYROLL_REVIEW",storeId,title:"Bypass",data:{period,employeeId}}))).status));
  assert.equal((await reviews.readPayrollReviews(db,storeId,period)).size,0);
});

test("update persists weighted salary, independent KPI hours and all allowances; recalculates finance before confirmation", async () => {
  const before = await preview();
  await okay(await save(before));
  const data = await preview(), item = data.summary.items.find((row) => row.employeeId === employeeId);
  assert.notEqual(data.reviewToken,before.reviewToken);
  assert.equal(item.baseSalary,75000, "two historical rates are preserved as a weighted average");
  assert.equal(item.durationSeconds,10800); assert.equal(item.kpiDurationSeconds,3600);
  assert.equal(item.kpiBonus,233275); assert.equal(item.totalPay,528275);
  assert.equal(data.summary.managerBonus,133300);
  assert.equal(item.review.version,1); assert.equal(item.review.stale,false);
  assert.equal(data.financialPeriod.status,"DRAFT");
  await matched(data);
  const audit = await db.prepare("SELECT before_json,after_json,reason,user_id FROM audit_logs WHERE action='PAYROLL_REVIEW_SAVE'").first();
  assert.equal(JSON.parse(audit.before_json),null); assert.equal(JSON.parse(audit.after_json).values.durationSeconds,10800);
  assert.equal(audit.user_id,"review-manager"); assert.ok(audit.reason);
  assert.equal(await db.prepare("SELECT SUM(duration_seconds) n FROM shift_sessions WHERE employee_id=?").bind(employeeId).first("n"),7200);
  assert.equal((await action("CONFIRM_PERIOD",before)).status,409,"cannot confirm the view before updating");
  assert.equal((await action("CONFIRM_PERIOD",data,{expectedReviewToken:undefined})).status,409,"updated payroll requires an explicitly reviewed token");
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM cashflow_entries").first("n"),0,"update never pays or confirms payroll");
});

test("admin can update and concurrent saves cannot overwrite; KPI manual override is applied exactly once", async () => {
  const before = await preview();
  const responses = await Promise.all([save(before,{values:{...values,kpiBonus:12345}},"review-admin"),save(before,{values:{...values,kpiBonus:12345}})]);
  assert.deepEqual(responses.map((row) => row.status).sort(),[200,409]);
  const data = await preview(), item = data.summary.items.find((row) => row.employeeId === employeeId);
  assert.equal(item.review.version,2); assert.equal(item.kpiBonus,12345); assert.equal(item.totalPay,307345);
  assert.equal(data.summary.totalKpiBonus,245620);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='PAYROLL_REVIEW_SAVE'").first("n"),2);
  await matched(data);
});

test("source changes require another update and review; preconfirmed individual snapshots stay intact", async () => {
  const before = await preview();
  await db.prepare("UPDATE shift_sessions SET tiktok_allowance=20000 WHERE id='rev-1'").run();
  assert.equal((await action("CONFIRM_PERIOD",before)).status,409);
  let data = await preview(); assert.equal(data.summary.items.find((row)=>row.employeeId===employeeId).review.stale,true);
  await okay(await save(data)); data = await preview();
  await okay(await action("FINALIZE_SINGLE_EMPLOYEE", data),201);
  const original = await db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE employee_id=?").bind(employeeId).first("snapshot_json");
  data = await preview();
  await okay(await save(data,{values:{...values,durationSeconds:14400,kpiDurationSeconds:7200}}));
  data = await preview();
  assert.equal(data.summary.items.find((row)=>row.employeeId===employeeId).baseSalary,100000);
  assert.equal(await db.prepare("SELECT snapshot_json FROM employee_payroll_closings WHERE employee_id=?").bind(employeeId).first("snapshot_json"),original);
  await matched(data);
});

test("updates during reconciliation rebuild closing totals, then confirmation/payment/lock remain immutable", async () => {
  await okay(await action("FINALIZE_SINGLE_EMPLOYEE",null,{employeeId:"review-two"}),201);
  await okay(await action("FINALIZE_EMPLOYEE"),201);
  await okay(await action("FINALIZE_MANAGER"),201);
  await okay(await action("CONFIRM_SALARY"));
  const before = await preview();
  await okay(await save(before,{values:{...values,manualBonus:170000,kpiBonus:50000}}));
  const data = await preview();
  assert.equal(data.financialPeriod.status,"RECONCILING");
  assert.notEqual(data.closing.grandTotal,data.summary.totalPay + data.summary.managerTotal);
  assert.equal((await action("CONFIRM_REWARDS",before)).status,409);
  await okay(await action("CONFIRM_PERIOD",data));
  const confirmed = await preview();
  assert.equal(confirmed.financialPeriod.status,"CONFIRMED");
  assert.equal(confirmed.closing.grandTotal,data.summary.totalPay + data.summary.managerTotal);
  assert.deepEqual(confirmed.summary.items,data.summary.items);
  const lockedTotals = JSON.stringify(confirmed.summary);
  for (const step of ["CONFIRM_PAYMENT","CLOSE_PERIOD"]) {
    assert.equal((await save(await preview())).status,409);
    await okay(await action(step));
    assert.equal(JSON.stringify((await preview()).summary),lockedTotals);
  }
  assert.equal(await db.prepare("SELECT SUM(amount) n FROM cashflow_entries WHERE store_id=?").bind(storeId).first("n"),confirmed.closing.grandTotal);
  await matched(await preview());
  await assert.rejects(db.prepare("DELETE FROM business_records WHERE category='PAYROLL_REVIEW'").run(),/payroll review is frozen/);
  await assert.rejects(db.prepare("UPDATE business_records SET data_json=json_set(data_json,'$.version',json_extract(data_json,'$.version')+1) WHERE category='PAYROLL_REVIEW'").run(),/payroll review is frozen/);
});

test("review versions protect snapshot transitions atomically and migration matches runtime", async () => {
  const context = {storeId,period:"2026-09",actorId:"review-manager",now:"2026-10-01T00:00:00.000Z",reason:"Concurrent review"};
  await db.batch(lifecycle.prepareFinancialPeriodDraftPlan(db,{...context,id:"review-race-period"}).statements);
  const current = await lifecycle.readFinancialPeriodLifecycleRow(db,storeId,context.period);
  const plan = lifecycle.prepareFinancialPeriodTransitionPlan(db,{...context,current,toStatus:"CALCULATED",calculation:{
    policyVersionId:"policy-v3",configVersion:3,totalHoursSeconds:0,salaryAdvance:0,employeePayrollRows:[],managerPayroll:{},
    configSnapshot:{payrollSummary:{managerSalaryVersion:0,reviewVersions:[]}},
    finance:{grossRevenue:10000000,managerSalary:3000000,employeeSalary:0,fixedExpense:0,variableExpense:0,
      inventoryCost:0,inventoryShippingCost:0,manualEmployeeBonus:0,employeeAllowance:0,employeeKpiTotal:0,managerKpi:0,monthEndExpense:0},
  }});
  await reviews.savePayrollReview(db,{...context,employeeId,expectedVersion:0,values,
    source:{...values,baseSalary:75000,hourlyRate:30000}});
  await assert.rejects(db.batch(plan.statements),/payroll review changed during confirmation/);
  assert.equal((await lifecycle.readFinancialPeriodLifecycleRow(db,storeId,context.period)).status,"DRAFT");
  const sql = await readFile(new URL("../drizzle/0036_payroll_review.sql",import.meta.url),"utf8");
  assert.equal(sql,guards.payrollReviewGuardStatements.join(";\n--> statement-breakpoint\n")+";\n");
});


test("a zero-hour employee can be reviewed and confirmed directly from DRAFT without double-applying changes", async () => {
  const month = "2026-07";
  // A separate past store period covers the compact action's complete preparation path.
  await db.prepare("UPDATE stores SET created_at='2026-07-01T00:00:00.000Z' WHERE id='review-other'").run();
  const foreignId = "review-foreign";
  const data = await preview("review-other",month);
  await okay(await payroll.POST(request({action:"SAVE_EMPLOYEE_REVIEW",storeId:"review-other",period:month,
    employeeId:foreignId,expectedReviewVersion:0,expectedReviewToken:data.reviewToken,
    values:{...values,durationSeconds:7200,kpiDurationSeconds:3600,kpiBonus:10000},reason:"Bổ sung giờ còn thiếu"},"review-admin")));
  const updated = await preview("review-other",month);
  assert.equal(updated.summary.items[0].baseSalary,50000,"configured rate is used when no source hours exist");
  await okay(await payroll.POST(request({action:"CONFIRM_PERIOD",storeId:"review-other",period:month,
    expectedRevision:updated.financialPeriod.revision,expectedReviewToken:updated.reviewToken},"review-admin")));
  const confirmed = await preview("review-other",month);
  assert.equal(confirmed.financialPeriod.status,"CONFIRMED");
  assert.equal(confirmed.summary.items[0].baseSalary,50000);
  assert.equal(confirmed.summary.items[0].kpiBonus,10000);
  assert.equal(confirmed.closing.grandTotal,updated.summary.totalPay+updated.summary.managerTotal);
});

test("audit failure rolls back the employee update and can be retried with the same version", async () => {
  const month = "2026-06";
  await db.prepare("UPDATE stores SET created_at='2026-06-01T00:00:00.000Z' WHERE id='review-other'").run();
  const data = await preview("review-other",month);
  const input = {action:"SAVE_EMPLOYEE_REVIEW",storeId:"review-other",period:month,employeeId:"review-foreign",
    expectedReviewVersion:0,expectedReviewToken:data.reviewToken,values,reason:"Kiểm thử lưu nguyên tử"};
  await db.prepare(`CREATE TRIGGER fail_review_audit BEFORE INSERT ON audit_logs WHEN NEW.action='PAYROLL_REVIEW_SAVE'
    BEGIN SELECT RAISE(ABORT,'test audit failure'); END`).run();
  try {
    assert.equal((await payroll.POST(request(input,"review-admin"))).status,500);
    assert.equal((await reviews.readPayrollReviews(db,"review-other",month)).size,0);
  } finally { await db.prepare("DROP TRIGGER fail_review_audit").run(); }
  await okay(await payroll.POST(request(input,"review-admin")));
  assert.equal((await reviews.readPayrollReviews(db,"review-other",month)).get("review-foreign").version,1);
});
