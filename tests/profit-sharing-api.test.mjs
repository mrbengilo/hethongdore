import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedPolicy } from "./helpers/profit-distribution-fixtures.mjs";
import * as lifecycle from "../app/api/_lib/financial-period-lifecycle.ts";

const directory = await mkdtemp(join(tmpdir(), "dore-profit-sharing-api-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const [runtime, auth, reports] = await Promise.all([
  import("../db/runtime.ts"), import("../app/api/_lib/auth.ts"), import("../app/api/reports/route.ts"),
]);
const db = await runtime.initDb();
const period = "2026-08";
const token = "profit-sharing-api-admin-token";
const scopedToken = "profit-sharing-api-scoped-token";

async function lockStorePeriod(storeId, finalProfit) {
  const context = { storeId, period, actorId: "sharing-admin", now: "2026-09-01T00:00:00.000Z", reason: "API test source" };
  const draft = lifecycle.prepareFinancialPeriodDraftPlan(db, { ...context, id: `period-${storeId}` });
  await db.batch(draft.statements);
  let current = await lifecycle.readFinancialPeriodLifecycleRow(db, storeId, period);
  const calculation = {
    policyVersionId: "policy-v3", configVersion: 3, totalHoursSeconds: 0,
    salaryAdvance: 0, employeePayrollRows: [], managerPayroll: {}, configSnapshot: {},
    finance: {
      grossRevenue: finalProfit + 4_000_000, employeeSalary: 1_000_000, managerSalary: 3_000_000,
      fixedExpense: 0, variableExpense: 0, inventoryCost: 0, inventoryShippingCost: 0,
      manualEmployeeBonus: 0, employeeAllowance: 0, employeeKpiTotal: 0, managerKpi: 0, monthEndExpense: 0,
    },
  };
  let confirmedPayload;
  for (const toStatus of ["CALCULATED", "RECONCILING", "CONFIRMED", "PAID", "LOCKED"]) {
    current = await lifecycle.executeFinancialPeriodTransition(db, lifecycle.prepareFinancialPeriodTransitionPlan(db, {
      ...context, current, toStatus, ...(["CALCULATED", "CONFIRMED"].includes(toStatus) ? { calculation } : {}),
    }));
    const payload = await db.prepare(`SELECT json_remove(snapshot_json, '$.status', '$.paidAt', '$.paidBy', '$.lockedAt', '$.lockedBy') AS payload
      FROM financial_periods WHERE store_id = ? AND period = ?`).bind(storeId, period).first("payload");
    if (toStatus === "CONFIRMED") confirmedPayload = payload;
    if (["PAID", "LOCKED"].includes(toStatus)) assert.equal(payload, confirmedPayload, "settlement preserves source JSON even with different key order");
  }
}

function request(method, body, session = token) {
  return new Request(`http://localhost/api/reports?period=${period}`, {
    method, headers: { "content-type": "application/json", cookie: `dore_session=${session}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

before(async () => {
  const now = new Date().toISOString();
  await db.prepare("DELETE FROM stores").run();
  for (const storeId of ["store-a", "store-b"]) {
    await db.prepare("INSERT INTO stores (id, name, address, status, created_at) VALUES (?, ?, 'Test', 'ACTIVE', '2026-08-01T00:00:00.000Z')")
      .bind(storeId, `DORE ${storeId}`).run();
  }
  await db.prepare(`INSERT INTO users (id, username, password_hash, role, name, store_id, is_super_admin)
    VALUES ('sharing-admin', 'sharing-admin', 'unused', 'MANAGER', 'Admin', NULL, 1),
      ('sharing-scoped', 'sharing-scoped', 'unused', 'MANAGER', 'Store manager', 'store-a', 0)`).run();
  for (const [userId, session] of [["sharing-admin", token], ["sharing-scoped", scopedToken]]) {
    await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`session-${userId}`, userId, await auth.sha256(session), Date.now() + 600_000, now).run();
  }
  await seedPolicy(db, { employeeKpiTiers: [
    { minimumProfitPerHour: 30_000, rateBasisPoints: 0 },
    { minimumProfitPerHour: 15_000, rateBasisPoints: 0 },
    { minimumProfitPerHour: 7_000, rateBasisPoints: 0 },
  ] });
  await lockStorePeriod("store-a", 5_000_000);
});

after(async () => { db.close?.(); await rm(directory, { recursive: true, force: true }); });

test("locked stores remain visible while another store is missing or still open", async () => {
  const read = async () => (await reports.GET(request("GET"))).json();
  let report = await read();
  assert.equal(report.profitSharingPreview?.finalProfit, 5_000_000);
  assert.deepEqual(report.profitSharingPreview.storeAllocations.map((store) => store.storeId), ["store-a"]);
  assert.equal(report.profitSharingReadiness.ready, false);
  assert.equal(report.profitSharingReadiness.status, "PARTIAL");
  assert.equal(report.profitSharingReadiness.expectedStoreCount, 2);
  assert.deepEqual(report.profitSharingReadiness.pendingStores, [
    { storeId: "store-b", storeName: "DORE store-b", status: "MISSING" },
  ]);
  const close = await reports.POST(request("POST", {
    action: "CLOSE_PROFIT_SHARING", period, setupRepayments: [{ storeId: "store-a", amount: 2_000_000 }],
  }));
  assert.equal(close.status, 409, "partial preview must not allow a global close");
  assert.equal(await db.prepare("SELECT COUNT(*) FROM profit_distributions").first("COUNT(*)"), 0);
  // A store created exactly at September's Vietnam-time boundary must not block August.
  await db.prepare("INSERT INTO stores (id, name, address, status, created_at) VALUES ('future', 'Future store', '', 'ACTIVE', '2026-08-31T17:00:00.000Z')").run();
  report = await read();
  assert.equal(report.profitSharingReadiness.expectedStoreCount, 2);
  await lockStorePeriod("store-b", 1_000_000);
  report = await read();
  assert.equal(report.profitSharingReadiness.ready, true);
  assert.deepEqual(report.profitSharingReadiness.pendingStores, []);
  assert.equal(report.profitSharingPreview.finalProfit, 6_000_000);
});

test("only global admins can close setup-adjusted shares; invalid values cannot write", async () => {
  const body = { action: "CLOSE_PROFIT_SHARING", period, setupRepayments: [{ storeId: "store-a", amount: 2_000_000 }] };
  assert.equal((await reports.POST(request("POST", body, "anonymous"))).status, 403);
  assert.equal((await reports.POST(request("POST", body, scopedToken))).status, 403);
  for (const malformed of [null, [], "invalid", { ...body, period: 202608 }, { ...body, reason: {} }]) {
    assert.equal((await reports.POST(request("POST", malformed))).status, 400);
  }
  const invalid = await reports.POST(request("POST", { ...body, setupRepayments: [{ storeId: "store-a", amount: -1 }] }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_INPUT");
  assert.equal(await db.prepare("SELECT COUNT(*) FROM profit_distributions").first("COUNT(*)"), 0);
});

test("HTTP preview, close and history reconcile each store and each member after setup", async () => {
  const before = await reports.GET(request("GET"));
  assert.equal(before.status, 200);
  const preview = (await before.json()).profitSharingPreview;
  assert.equal(preview.setupRepayment, 0);
  assert.equal(preview.distributableProfit, 6_000_000);
  const body = { action: "CLOSE_PROFIT_SHARING", period, setupRepayments: [{ storeId: "store-a", amount: 2_000_000 }] };
  const responses = await Promise.all([reports.POST(request("POST", body)), reports.POST(request("POST", body))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const closed = await responses.find((response) => response.status === 201).json();
  assert.equal(closed.record.setupRepayment, 2_000_000);
  assert.equal(closed.record.accountingProfit, 6_000_000);
  assert.equal(closed.record.distributableProfit, 4_000_000);
  assert.deepEqual(closed.record.memberAllocations.map((member) => member.amount), [1_600_000, 2_400_000]);
  const storeA = closed.record.storeAllocations.find((store) => store.storeId === "store-a");
  assert.equal(storeA.finalProfit, 5_000_000);
  assert.equal(storeA.setupRepayment, 2_000_000);
  assert.equal(storeA.distributableProfit, 3_000_000);
  assert.deepEqual(storeA.memberAllocations.map((member) => member.amount), [1_200_000, 1_800_000]);
  for (const member of closed.record.memberAllocations) {
    assert.equal(member.amount, closed.record.storeAllocations.reduce((total, store) => total
      + store.memberAllocations.find((entry) => entry.memberId === member.memberId).amount, 0));
  }
  const after = await reports.GET(request("GET"));
  assert.equal(after.status, 200);
  const history = await after.json();
  assert.equal(history.profitSharingPreview, null);
  assert.equal(history.profitSharingReadiness.status, "LOCKED");
  assert.deepEqual(history.profitSharingHistory[0], closed.record);
  assert.equal(await db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'PROFIT_DISTRIBUTION_CLOSE'").first("COUNT(*)"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) FROM cashflow_entries").first("COUNT(*)"), 0, "allocation does not fabricate a cash disbursement");
});
