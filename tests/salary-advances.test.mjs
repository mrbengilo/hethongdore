import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-salary-advances-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, advancesRoute, payrollRoute, cashflowRoute, salaryAdvanceLibrary, finance] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/salary-advances/route.ts"),
  import("../app/api/payroll/route.ts"),
  import("../app/api/cashflow/route.ts"),
  import("../app/lib/salary-advances.ts"),
  import("../app/lib/finance.ts"),
]);

const db = await runtime.initDb();
const tokenA = "salary-advance-manager-a-token";
const tokenB = "salary-advance-manager-b-token";
const storeA = "salary-advance-store-a";
const storeB = "salary-advance-store-b";
const employeeA = "salary-advance-employee-a";
const period = "2026-08";

function periodLifecycleSnapshot(status, metadata = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    status,
    fixture: "salary-advance-lifecycle",
    paidAt: metadata.paidAt ?? null,
    paidBy: metadata.paidBy ?? null,
    lockedAt: metadata.lockedAt ?? null,
    lockedBy: metadata.lockedBy ?? null,
  });
}

function request(path, token, method = "GET", body, idempotencyKey) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `dore_session=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function response(responsePromise) {
  const result = await responsePromise;
  return { status: result.status, headers: result.headers, body: await result.json() };
}

before(async () => {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES (?, 'SALARY ADVANCE STORE A', 'A', 0, 0, 'ACTIVE', ?),
             (?, 'SALARY ADVANCE STORE B', 'B', 0, 0, 'ACTIVE', ?)`)
      .bind(storeA, now, storeB, now),
    db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, province, ward, address_line,
       hourly_rate, tiktok_allowance, status)
      VALUES (?, ?, 'SAL-A', 'Nhân viên ứng lương', 'Bán hàng', '0900000991', '', '', '', 100000, 0, 'ACTIVE')`)
      .bind(employeeA, storeA),
    db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
      VALUES ('salary-manager-a', 'salary-manager-a', 'unused', 'MANAGER', 'Quản lý A', NULL, ?, 0),
             ('salary-manager-b', 'salary-manager-b', 'unused', 'MANAGER', 'Quản lý B', NULL, ?, 0)`)
      .bind(storeA, storeB),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, shift_name, work_date, applied_hourly_rate,
       started_at, ended_at, duration_seconds, tiktok_allowance, close_status, status)
      VALUES ('salary-shift-a', 'SALARY-SHIFT-A', ?, ?, 'Ca 1', '2026-08-05', 100000,
       '2026-08-05T01:00:00.000Z', '2026-08-05T02:00:00.000Z', 3600, 0, 'CLOSED', 'COMPLETED')`)
      .bind(storeA, employeeA),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('salary-session-a', 'salary-manager-a', ?, ?, ?),
           ('salary-session-b', 'salary-manager-b', ?, ?, ?)`)
    .bind(
      await auth.sha256(tokenA), Date.now() + 600_000, now,
      await auth.sha256(tokenB), Date.now() + 600_000, now,
    ).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("salary advance coverage exposes paid debt and pending reservation gaps", () => {
  assert.deepEqual(salaryAdvanceLibrary.salaryAdvanceSettlementSplit({
    employeeBaseSalary: 100000,
    employeeTotalPay: 100000,
    managerSalary: 10000,
    managerBonus: 0,
    advanceAmount: 50000,
  }), {
    advanceAgainstSalary: 50000,
    advanceAgainstRewards: 0,
    employeeRemaining: 50000,
    salaryTotal: 60000,
    rewardAllowanceTotal: 0,
    grandTotal: 60000,
  });

  const paidDebt = salaryAdvanceLibrary.salaryAdvanceCoverage([{
    employeeId: "employee-paid-debt",
    totalPay: 80000,
    salaryAdvancePending: 0,
    salaryAdvancePaid: 90000,
    salaryAdvanceReserved: 90000,
  }]);
  assert.equal(paidDebt.covered, false);
  assert.equal(paidDebt.totalCoverageGap, 10000);
  assert.equal(paidDebt.totalOverpaymentDebt, 10000);

  const pendingGap = salaryAdvanceLibrary.salaryAdvanceCoverage([{
    employeeId: "employee-pending-gap",
    totalPay: 70000,
    salaryAdvancePending: 30000,
    salaryAdvancePaid: 50000,
    salaryAdvanceReserved: 80000,
  }]);
  assert.equal(pendingGap.covered, false);
  assert.equal(pendingGap.totalCoverageGap, 10000);
  assert.equal(pendingGap.totalOverpaymentDebt, 0);
});

test("salary advances are store-scoped, no-store, idempotent and bounded by earned payroll", async () => {
  const crossStore = await response(advancesRoute.GET(request(`/api/salary-advances?storeId=${storeA}&period=${period}`, tokenB)));
  assert.equal(crossStore.status, 403);

  const initialPayroll = await response(payrollRoute.GET(request(`/api/payroll?storeId=${storeA}&period=${period}`, tokenA)));
  assert.equal(initialPayroll.status, 200);
  assert.equal(initialPayroll.body.summary.items[0].totalPay, 100000);

  const stalePayrollRevision = await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA);
  await db.prepare("UPDATE shift_sessions SET duration_seconds = 1800 WHERE id = 'salary-shift-a'").run();
  try {
    await assert.rejects(
      salaryAdvanceLibrary.createSalaryAdvance(db, {
        id: "salary-stale-preview",
        storeId: storeA,
        employeeId: employeeA,
        period,
        advanceDate: "2026-08-06",
        amount: 49999,
        note: "Stale payroll preview",
        actorId: "salary-manager-a",
        clientRequestId: "salary-stale-preview-request",
        payloadHash: "salary-stale-preview-payload",
        payrollRevision: stalePayrollRevision,
        grossEntitlement: 100000,
        now: new Date().toISOString(),
      }),
      (error) => error instanceof salaryAdvanceLibrary.SalaryAdvanceConflictError && error.reason === "STALE",
    );
  } finally {
    await db.prepare("UPDATE shift_sessions SET duration_seconds = 3600 WHERE id = 'salary-shift-a'").run();
  }

  const equalToAvailable = await response(advancesRoute.POST(request("/api/salary-advances", tokenA, "POST", {
    storeId: storeA,
    employeeId: employeeA,
    period,
    advanceDate: "2026-08-06",
    amount: 100000,
    note: "Được ứng bằng toàn bộ khả dụng",
  }, "salary-request-equal-boundary")));
  assert.equal(equalToAvailable.status, 201);
  assert.equal(equalToAvailable.body.advance.remainingAfterSnapshot, 0);
  const equalAudit = await db.prepare(`SELECT store_id AS storeId, before_json AS beforeJson,
      after_json AS afterJson, reason FROM audit_logs
    WHERE action = 'SALARY_ADVANCE_CREATE' AND entity_id = ? LIMIT 1`)
    .bind(equalToAvailable.body.advance.id).first();
  assert.equal(equalAudit.storeId, storeA);
  assert.equal(JSON.parse(equalAudit.beforeJson), null);
  assert.equal(JSON.parse(equalAudit.afterJson).amount, 100000);
  assert.equal(equalAudit.reason, "Tạo khoản ứng lương");
  await db.batch([
    db.prepare("DELETE FROM audit_logs WHERE entity_type = 'SALARY_ADVANCE' AND entity_id = ?")
      .bind(equalToAvailable.body.advance.id),
    db.prepare("DELETE FROM salary_advances WHERE id = ?").bind(equalToAvailable.body.advance.id),
  ]);

  const body = {
    storeId: storeA,
    employeeId: employeeA,
    period,
    advanceDate: "2026-08-06",
    amount: 40000,
    note: "Ứng chi phí cá nhân",
  };
  const created = await response(advancesRoute.POST(request("/api/salary-advances", tokenA, "POST", body, "salary-request-0001")));
  assert.equal(created.status, 201);
  assert.equal(created.body.advance.status, "DRAFT");
  assert.equal(created.body.advance.version, 1);
  assert.equal(created.body.advance.grossEntitlementSnapshot, 100000);
  assert.equal(created.body.advance.availableBeforeSnapshot, 100000);
  assert.equal(created.body.advance.remainingAfterSnapshot, 60000);
  assert.match(created.body.advance.createdAt, /^\d{4}-\d{2}-\d{2}T/u);

  const replay = await response(advancesRoute.POST(request("/api/salary-advances", tokenA, "POST", body, "salary-request-0001")));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.advance.id, created.body.advance.id);
  const conflictingReplay = await response(advancesRoute.POST(request("/api/salary-advances", tokenA, "POST", { ...body, amount: 41000 }, "salary-request-0001")));
  assert.equal(conflictingReplay.status, 409);

  const list = await response(advancesRoute.GET(request(`/api/salary-advances?storeId=${storeA}&period=${period}`, tokenA)));
  assert.equal(list.status, 200);
  assert.match(list.headers.get("cache-control") ?? "", /no-store/u);
  assert.equal(list.body.advances.length, 1);
  assert.equal(list.body.employees[0].availableAmount, 60000);

  const overLimit = await response(advancesRoute.POST(request("/api/salary-advances", tokenA, "POST", { ...body, amount: 60001 }, "salary-request-0002")));
  assert.equal(overLimit.status, 409);
});

test("draft advances support CAS editing, payment confirmation and payroll net availability without double-counting expense", async () => {
  const expenseBeforeConfirmation = (await response(
    payrollRoute.GET(request(`/api/payroll?storeId=${storeA}&period=${period}`, tokenA)),
  )).body.summary.expense;
  let list = await response(advancesRoute.GET(request(`/api/salary-advances?storeId=${storeA}&period=${period}`, tokenA)));
  const original = list.body.advances[0];
  const updated = await response(advancesRoute.PATCH(request("/api/salary-advances", tokenA, "PATCH", {
    id: original.id,
    storeId: storeA,
    version: original.version,
    advanceDate: "2026-08-07",
    amount: 50000,
    note: "Ứng lương đã cập nhật",
  })));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.advance.version, 2);
  assert.equal(updated.body.advance.amount, 50000);
  assert.equal(updated.body.advance.grossEntitlementSnapshot, 100000);
  assert.equal(updated.body.advance.availableBeforeSnapshot, 100000);
  assert.equal(updated.body.advance.remainingAfterSnapshot, 50000);
  const updateAudit = await db.prepare(`SELECT store_id AS storeId, before_json AS beforeJson,
      after_json AS afterJson, reason FROM audit_logs
    WHERE action = 'SALARY_ADVANCE_UPDATE' AND entity_id = ? LIMIT 1`)
    .bind(original.id).first();
  assert.equal(updateAudit.storeId, storeA);
  assert.equal(JSON.parse(updateAudit.beforeJson).amount, 40000);
  assert.equal(JSON.parse(updateAudit.afterJson).amount, 50000);
  assert.equal(updateAudit.reason, "Chỉnh sửa khoản ứng lương");

  const stale = await response(advancesRoute.PATCH(request("/api/salary-advances", tokenA, "PATCH", {
    id: original.id,
    storeId: storeA,
    version: 1,
    advanceDate: "2026-08-08",
    amount: 45000,
    note: "Bản ghi cũ",
  })));
  assert.equal(stale.status, 409);

  await db.prepare("UPDATE shift_sessions SET duration_seconds = 720 WHERE id = 'salary-shift-a'").run();
  try {
    const blockedByFreshPayroll = await response(advancesRoute.PATCH(request("/api/salary-advances", tokenA, "PATCH", {
      action: "CONFIRM_PAYMENT",
      id: original.id,
      storeId: storeA,
      version: 2,
    })));
    assert.equal(blockedByFreshPayroll.status, 409, "50k draft must not be paid after gross payroll falls to 20k");
    const inertDraft = await db.prepare(`SELECT status, version, paid_at AS paidAt FROM salary_advances WHERE id = ?`)
      .bind(original.id).first();
    assert.equal(inertDraft.status, "DRAFT");
    assert.equal(inertDraft.version, 2);
    assert.equal(inertDraft.paidAt, null);
    const blockedAudit = await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs
      WHERE entity_type = 'SALARY_ADVANCE' AND entity_id = ? AND action = 'SALARY_ADVANCE_PAYMENT_CONFIRM'`)
      .bind(original.id).first();
    assert.equal(Number(blockedAudit.count), 0, "blocked payment must be audit/cashflow inert");
  } finally {
    await db.prepare("UPDATE shift_sessions SET duration_seconds = 3600 WHERE id = 'salary-shift-a'").run();
  }

  const confirmed = await response(advancesRoute.PATCH(request("/api/salary-advances", tokenA, "PATCH", {
    action: "CONFIRM_PAYMENT",
    id: original.id,
    storeId: storeA,
    version: 2,
  })));
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.advance.status, "PAID");
  assert.equal(confirmed.body.advance.version, 3);
  const confirmReplay = await response(advancesRoute.PATCH(request("/api/salary-advances", tokenA, "PATCH", {
    action: "CONFIRM_PAYMENT",
    id: original.id,
    storeId: storeA,
    version: 2,
  })));
  assert.equal(confirmReplay.status, 200);
  assert.equal(confirmReplay.body.advance.id, original.id);

  const payroll = await response(payrollRoute.GET(request(`/api/payroll?storeId=${storeA}&period=${period}`, tokenA)));
  assert.equal(payroll.status, 200);
  assert.equal(payroll.body.summary.items[0].salaryAdvancePaid, 50000);
  assert.equal(payroll.body.summary.items[0].availablePay, 50000);
  assert.equal(payroll.body.summary.totalAvailablePay, 50000);
  assert.equal(
    payroll.body.summary.expense,
    expenseBeforeConfirmation,
    "advance settles payroll liability and must not duplicate salary expense",
  );

  const paidDate = finance.localDate(new Date(confirmed.body.advance.paidAt));
  const cashflow = await response(cashflowRoute.GET(request(
    `/api/cashflow?storeId=${storeA}&period=${period}&granularity=day&from=2026-08-01&to=${paidDate}`,
    tokenA,
  )));
  assert.equal(cashflow.status, 200);
  const advanceCashEntry = cashflow.body.entries.find((entry) => entry.source === "Ứng lương nhân viên");
  assert.equal(advanceCashEntry?.outflow, 50000);
  assert.equal(cashflow.body.totals.outflow, 50000, "advance payment must be visible in actual cashflow exactly once");

  await db.prepare("UPDATE shift_sessions SET duration_seconds = 1440 WHERE id = 'salary-shift-a'").run();
  await db.prepare("UPDATE employees SET status = 'TERMINATED', inactive_at = '2026-08-10T00:00:00.000Z' WHERE id = ?")
    .bind(employeeA).run();
  try {
    const underfundedPayroll = await response(payrollRoute.GET(request(`/api/payroll?storeId=${storeA}&period=${period}`, tokenA)));
    assert.equal(underfundedPayroll.status, 200);
    assert.equal(underfundedPayroll.body.summary.items[0].totalPay, 40000);
    assert.equal(underfundedPayroll.body.summary.items[0].salaryAdvanceCoverageGap, 10000);
    assert.equal(underfundedPayroll.body.summary.items[0].salaryAdvanceOverpaymentDebt, 10000);
    assert.equal(underfundedPayroll.body.summary.totalSalaryAdvanceCoverageGap, 10000);
    assert.equal(underfundedPayroll.body.summary.totalSalaryAdvanceOverpaymentDebt, 10000);

    const blockedClose = await response(payrollRoute.POST(request("/api/payroll", tokenA, "POST", {
      action: "FINALIZE_SINGLE_EMPLOYEE",
      storeId: storeA,
      period,
      employeeId: employeeA,
    })));
    assert.equal(blockedClose.status, 409);
    assert.equal(blockedClose.body.code, "SALARY_ADVANCE_UNDERFUNDED");
    assert.equal(blockedClose.body.salaryAdvanceCoverage.totalOverpaymentDebt, 10000);
    const closingCount = await db.prepare(`SELECT COUNT(*) AS count FROM employee_payroll_closings
      WHERE store_id = ? AND period = ?`).bind(storeA, period).first();
    assert.equal(Number(closingCount.count), 0, "coverage failure must release the closing gate without a snapshot");
  } finally {
    await db.prepare("UPDATE shift_sessions SET duration_seconds = 3600 WHERE id = 'salary-shift-a'").run();
    await db.prepare("UPDATE employees SET status = 'ACTIVE', inactive_at = NULL WHERE id = ?").bind(employeeA).run();
  }

  const auditCounts = await db.prepare(`SELECT action, COUNT(*) AS count FROM audit_logs
    WHERE entity_type = 'SALARY_ADVANCE' GROUP BY action`).all();
  assert.deepEqual(Object.fromEntries(auditCounts.results.map((row) => [row.action, Number(row.count)])), {
    SALARY_ADVANCE_CREATE: 1,
    SALARY_ADVANCE_PAYMENT_CONFIRM: 1,
    SALARY_ADVANCE_UPDATE: 1,
  });
});

test("canonical financial periods, payroll attribution and optimistic revisions govern every advance mutation", async () => {
  const supportEmployee = "salary-advance-support-archived";
  const transferId = "salary-advance-support-transfer";
  const supportShift = "salary-advance-support-shift";
  const now = new Date().toISOString();
  const policy = await db.prepare(`SELECT id, version FROM financial_policy_versions
    ORDER BY version DESC LIMIT 1`).first();
  assert.ok(policy?.id);
  assert.ok(Number(policy.version) > 0);

  await db.batch([
    db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, province, ward, address_line,
       hourly_rate, tiktok_allowance, status, inactive_at)
      VALUES (?, ?, 'SAL-SUPPORT', 'Nhân viên hỗ trợ lưu trữ', 'Bán hàng', '0900000992',
       '', '', '', 100000, 0, 'ARCHIVED', ?)`)
      .bind(supportEmployee, storeB, now),
    db.prepare(`INSERT INTO employee_transfers
      (id, employee_id, source_store_id, target_store_id, start_date, end_date,
       shifts_json, support_hourly_rate, support_allowance, reason, status,
       created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, '2026-09-01', '2026-11-30', '[]', 100000, 5000,
       'Hỗ trợ cửa hàng A', 'ACTIVE', 'salary-manager-a', ?, ?)`)
      .bind(transferId, supportEmployee, storeB, storeA, now, now),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, shift_name, work_date, transfer_id,
       applied_hourly_rate, started_at, ended_at, duration_seconds, tiktok_allowance,
       close_status, reconciliation_status, status)
      VALUES (?, 'SALARY-SUPPORT-SHIFT', ?, ?, 'Ca hỗ trợ', '2026-09-05', ?, 100000,
       '2026-09-05T01:00:00.000Z', '2026-09-05T02:00:00.000Z', 3600, 0,
       'CLOSED', 'CLEAR', 'COMPLETED')`)
      .bind(supportShift, storeA, supportEmployee, transferId),
    db.prepare(`INSERT INTO financial_periods
      (id, store_id, period, status, created_at, updated_at)
      VALUES ('salary-period-allowed', ?, '2026-09', 'DRAFT', ?, ?),
             ('salary-period-paid-block', ?, '2026-11', 'DRAFT', ?, ?)`)
      .bind(storeA, now, now, storeA, now, now),
    db.prepare(`INSERT INTO financial_periods
      (id, store_id, period, status, created_at, updated_at)
      VALUES ('salary-period-confirmed-block', ?, '2026-10', 'DRAFT', ?, ?)`)
      .bind(storeA, now, now),
  ]);
  await db.prepare(`UPDATE financial_periods SET status = 'CALCULATED', revision = revision + 1,
    policy_version_id = ?, config_version = ?, calculated_at = ?,
    calculated_by = 'salary-manager-a', updated_at = ?
    WHERE id = 'salary-period-confirmed-block'`)
    .bind(policy.id, Number(policy.version), now, now).run();
  await db.prepare(`UPDATE financial_periods SET status = 'RECONCILING', revision = revision + 1,
    updated_at = ? WHERE id = 'salary-period-confirmed-block'`).bind(now).run();
  await db.prepare(`UPDATE financial_periods SET status = 'CONFIRMED', revision = revision + 1,
    snapshot_json = ?, confirmed_at = ?, confirmed_by = 'salary-manager-a', updated_at = ?
    WHERE id = 'salary-period-confirmed-block'`)
    .bind(periodLifecycleSnapshot("CONFIRMED"), now, now).run();

  const clearRevision = await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA);
  const clearRevisionData = JSON.parse(clearRevision);
  assert.ok(clearRevisionData.policyVersions.length >= 1);
  assert.equal(
    clearRevisionData.financialPeriods.find((item) => item[1] === "2026-09")[2],
    "DRAFT",
  );
  await db.prepare(`UPDATE shift_sessions SET reconciliation_status = 'REQUIRED',
    reconciliation_reason = 'Cần quản lý đối soát' WHERE id = ?`).bind(supportShift).run();
  const reconciliationRevision = await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA);
  assert.notEqual(reconciliationRevision, clearRevision);
  await db.prepare(`UPDATE shift_sessions SET reconciliation_status = 'CLEAR',
    reconciliation_reason = NULL WHERE id = ?`).bind(supportShift).run();

  const createInput = async (id, selectedPeriod, amount) => salaryAdvanceLibrary.createSalaryAdvance(db, {
    id,
    storeId: storeA,
    employeeId: supportEmployee,
    period: selectedPeriod,
    advanceDate: `${selectedPeriod}-06`,
    amount,
    note: `Ứng lương ${selectedPeriod}`,
    actorId: "salary-manager-a",
    clientRequestId: `${id}-request`,
    payloadHash: `${id}-payload`,
    payrollRevision: await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA),
    grossEntitlement: 100000,
    now: new Date().toISOString(),
  });

  const allowedCreate = await createInput("salary-allowed-lifecycle", "2026-09", 100000);
  assert.equal(allowedCreate.status, "CREATED");
  assert.equal(allowedCreate.advance.remainingAfterSnapshot, 0);

  await db.prepare(`UPDATE financial_periods SET status = 'CALCULATED', revision = revision + 1,
    calculated_at = ?, calculated_by = 'salary-manager-a', updated_at = ?
    WHERE id = 'salary-period-allowed'`).bind(now, now).run();
  const calculatedRevision = await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA);
  assert.notEqual(calculatedRevision, clearRevision);
  const allowedUpdate = await salaryAdvanceLibrary.updateSalaryAdvance(db, {
    id: allowedCreate.advance.id,
    storeId: storeA,
    expectedVersion: 1,
    advanceDate: "2026-09-07",
    amount: 100000,
    note: "Điều chỉnh trong CALCULATED",
    actorId: "salary-manager-a",
    payrollRevision: calculatedRevision,
    grossEntitlement: 100000,
    now: new Date().toISOString(),
  });
  assert.equal(allowedUpdate.version, 2);
  assert.equal(allowedUpdate.remainingAfterSnapshot, 0);

  await db.prepare(`UPDATE financial_periods SET status = 'RECONCILING', revision = revision + 1,
    updated_at = ? WHERE id = 'salary-period-allowed'`).bind(new Date().toISOString()).run();
  const allowedConfirm = await salaryAdvanceLibrary.confirmSalaryAdvance(db, {
    id: allowedCreate.advance.id,
    storeId: storeA,
    expectedVersion: 2,
    actorId: "salary-manager-a",
    payrollRevision: await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA),
    grossEntitlement: 100000,
    now: new Date().toISOString(),
  });
  assert.equal(allowedConfirm.status, "CONFIRMED");
  assert.equal(allowedConfirm.advance.status, "PAID");

  await assert.rejects(
    createInput("salary-confirmed-create-block", "2026-10", 50000),
    (error) => error instanceof salaryAdvanceLibrary.SalaryAdvanceConflictError && error.reason === "LOCKED",
  );
  assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs
    WHERE entity_id = 'salary-confirmed-create-block'`).first()).count), 0);

  const paidBlockedDraft = await createInput("salary-paid-update-block", "2026-11", 50000);
  await db.prepare(`UPDATE financial_periods SET status = 'CALCULATED', revision = revision + 1,
    policy_version_id = ?, config_version = ?, calculated_at = ?,
    calculated_by = 'salary-manager-a', updated_at = ?
    WHERE id = 'salary-period-paid-block'`)
    .bind(policy.id, Number(policy.version), now, now).run();
  await db.prepare(`UPDATE financial_periods SET status = 'RECONCILING', revision = revision + 1,
    updated_at = ? WHERE id = 'salary-period-paid-block'`).bind(now).run();
  await db.prepare(`UPDATE financial_periods SET status = 'CONFIRMED', revision = revision + 1,
    snapshot_json = ?, confirmed_at = ?, confirmed_by = 'salary-manager-a', updated_at = ?
    WHERE id = 'salary-period-paid-block'`)
    .bind(periodLifecycleSnapshot("CONFIRMED"), now, now).run();
  const paidAt = new Date().toISOString();
  await db.prepare(`UPDATE financial_periods SET status = 'PAID', revision = revision + 1,
    snapshot_json = ?, paid_at = ?, paid_by = 'salary-manager-a', updated_at = ?
    WHERE id = 'salary-period-paid-block'`)
    .bind(periodLifecycleSnapshot("PAID", {
      paidAt,
      paidBy: "salary-manager-a",
    }), paidAt, paidAt).run();
  await assert.rejects(
    salaryAdvanceLibrary.updateSalaryAdvance(db, {
      id: paidBlockedDraft.advance.id,
      storeId: storeA,
      expectedVersion: 1,
      advanceDate: "2026-11-07",
      amount: 50000,
      note: "Không được sửa sau PAID",
      actorId: "salary-manager-a",
      payrollRevision: await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA),
      grossEntitlement: 100000,
      now: new Date().toISOString(),
    }),
    (error) => error instanceof salaryAdvanceLibrary.SalaryAdvanceConflictError && error.reason === "LOCKED",
  );

  const lockedAt = new Date().toISOString();
  await db.prepare(`UPDATE financial_periods SET status = 'LOCKED', revision = revision + 1,
    snapshot_json = ?, locked_at = ?, locked_by = 'salary-manager-a', updated_at = ?
    WHERE id = 'salary-period-paid-block'`).bind(periodLifecycleSnapshot("LOCKED", {
      paidAt,
      paidBy: "salary-manager-a",
      lockedAt,
      lockedBy: "salary-manager-a",
    }), lockedAt, lockedAt).run();
  await assert.rejects(
    salaryAdvanceLibrary.confirmSalaryAdvance(db, {
      id: paidBlockedDraft.advance.id,
      storeId: storeA,
      expectedVersion: 1,
      actorId: "salary-manager-a",
      payrollRevision: await salaryAdvanceLibrary.salaryAdvancePayrollRevision(db, storeA),
      grossEntitlement: 100000,
      now: new Date().toISOString(),
    }),
    (error) => error instanceof salaryAdvanceLibrary.SalaryAdvanceConflictError && error.reason === "LOCKED",
  );
});

test("concurrent reservations cannot exceed available payroll and pending advances block payroll locks", async () => {
  const candidates = await Promise.all([
    response(advancesRoute.POST(request("/api/salary-advances", tokenA, "POST", {
      storeId: storeA, employeeId: employeeA, period, advanceDate: "2026-08-09", amount: 30000, note: "Ứng song song A",
    }, "salary-request-race-a"))),
    response(advancesRoute.POST(request("/api/salary-advances", tokenA, "POST", {
      storeId: storeA, employeeId: employeeA, period, advanceDate: "2026-08-09", amount: 30000, note: "Ứng song song B",
    }, "salary-request-race-b"))),
  ]);
  assert.equal(candidates.filter((item) => item.status === 201).length, 1);
  assert.equal(candidates.filter((item) => item.status === 409).length, 1);

  await db.prepare("UPDATE employees SET status = 'TERMINATED', inactive_at = '2026-08-10T00:00:00.000Z' WHERE id = ?")
    .bind(employeeA).run();
  const lockAttempt = await response(payrollRoute.POST(request("/api/payroll", tokenA, "POST", {
    action: "FINALIZE_SINGLE_EMPLOYEE",
    storeId: storeA,
    period,
    employeeId: employeeA,
  })));
  assert.equal(lockAttempt.status, 409);
  assert.match(lockAttempt.body.message, /ứng lương/u);

  const pending = (await response(advancesRoute.GET(request(`/api/salary-advances?storeId=${storeA}&period=${period}`, tokenA))))
    .body.advances.find((item) => item.status === "DRAFT");
  await db.prepare(`INSERT INTO employee_payroll_closings
    (id, store_id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at, locked_by)
    VALUES ('salary-manual-lock', ?, ?, ?, '{}', 'INACTIVE', 'LOCKED', ?, 'salary-manager-a')`)
    .bind(storeA, employeeA, period, new Date().toISOString()).run();
  const blockedConfirmation = await response(advancesRoute.PATCH(request("/api/salary-advances", tokenA, "PATCH", {
    action: "CONFIRM_PAYMENT",
    id: pending.id,
    storeId: storeA,
    version: pending.version,
  })));
  assert.equal(blockedConfirmation.status, 423);
});
