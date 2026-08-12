import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = await mkdtemp(join(tmpdir(), "dore-payroll-policy-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, route, payroll, payrollPolicy] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/admin/payroll-policy/route.ts"),
  import("../app/lib/payroll.ts"),
  import("../app/lib/payroll-policy.ts"),
]);
const db = await runtime.initDb();
const superToken = "payroll-policy-super-token";
const managerToken = "payroll-policy-manager-token";

function request(token, method = "GET", body) {
  return new Request("http://localhost/api/admin/payroll-policy", {
    method,
    headers: { cookie: `dore_session=${encodeURIComponent(token)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function response(result) { return { status: result.status, body: await result.json(), headers: result.headers }; }
function payload(version, salary = 4_500_000, managerRate = 2.5) {
  return {
    managerMonthlySalaryVnd: salary,
    managerKpiRatePercent: managerRate,
    employeeKpiTiers: [
      { minimumProfitPerHour: 30_000, ratePercent: 8 },
      { minimumProfitPerHour: 15_000, ratePercent: 5.5 },
      { minimumProfitPerHour: 7_000, ratePercent: 3.25 },
    ],
    expectedVersion: version,
  };
}

before(async () => {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO users (id, username, password_hash, role, name, is_super_admin)
      VALUES ('pay-policy-super', 'pay-policy-super', 'unused', 'MANAGER', 'Quản trị chính sách', 1),
             ('pay-policy-manager', 'pay-policy-manager', 'unused', 'MANAGER', 'Quản lý thường', 0)`),
    db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ('pay-policy-session-super', 'pay-policy-super', ?, ?, ?),
             ('pay-policy-session-manager', 'pay-policy-manager', ?, ?, ?)`)
      .bind(await auth.sha256(superToken), Date.now() + 600_000, now,
        await auth.sha256(managerToken), Date.now() + 600_000, now),
    db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('kpi-history', 'KPI_SUMMARY', 'store-old', 'pay-policy-super', 'Kỳ đã khóa',
      '{"period":"2026-07","managerSalary":3000000,"kpiRate":0.07}', 'LOCKED', ?, ?)`)
      .bind(now, now),
  ]);
});

after(async () => { db.close?.(); await rm(directory, { recursive: true, force: true }); });

test("payroll policy is superadmin-only, private and no-store", async () => {
  assert.equal((await route.GET(request(managerToken))).status, 403);
  assert.equal((await route.PATCH(request(managerToken, "PATCH", payload(1)))).status, 403);
  const result = await response(await route.GET(request(superToken)));
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") ?? "", /private/u);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/u);
  assert.equal(result.body.policy.managerMonthlySalaryVnd, 3_000_000);
  assert.equal(result.body.policy.managerKpiRatePercent, null);
  assert.deepEqual(result.body.policy.employeeKpiTiers.map((tier) => tier.ratePercent), [7, 5, 3]);
});

test("payroll policy rejects unsafe salary, percent, precision and unordered tiers", async () => {
  const version = (await response(await route.GET(request(superToken)))).body.policy.version;
  const invalid = [
    payload(version, -1), payload(version, 1.25), payload(version, Number.MAX_SAFE_INTEGER),
    payload(version, 3_000_000, -1), payload(version, 3_000_000, 100.001),
    { ...payload(version), employeeKpiTiers: [
      { minimumProfitPerHour: 30_000, ratePercent: 2 },
      { minimumProfitPerHour: 15_000, ratePercent: 5 },
      { minimumProfitPerHour: 7_000, ratePercent: 3 },
    ] },
  ];
  for (const body of invalid) assert.equal((await route.PATCH(request(superToken, "PATCH", body))).status, 400);
});

test("optimistic update admits one writer, writes one audit and leaves locked history byte-identical", async () => {
  const initial = await response(await route.GET(request(superToken)));
  const before = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE id = 'kpi-history'").first();
  const raced = await Promise.all([
    response(await route.PATCH(request(superToken, "PATCH", payload(initial.body.policy.version)))),
    response(await route.PATCH(request(superToken, "PATCH", payload(initial.body.policy.version, 5_000_000, 3)))),
  ]);
  assert.deepEqual(raced.map((item) => item.status).sort(), [200, 409]);
  const current = await response(await route.GET(request(superToken)));
  assert.equal(current.body.policy.version, initial.body.policy.version + 1);
  assert.equal(current.body.policy.updatedByName, "Quản trị chính sách");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'PAYROLL_POLICY_UPDATE'").first()).count, 1);
  const afterRow = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE id = 'kpi-history'").first();
  assert.equal(afterRow.dataJson, before.dataJson);
});

test("employee KPI payout preserves a fractional 5.50 percent policy rate", () => {
  const policy = {
    ...payrollPolicy.defaultPayrollPolicy(),
    managerKpiRateBasisPoints: 250,
    employeeKpiTiers: [
      { minimumProfitPerHour: 30_000, rateBasisPoints: 800 },
      { minimumProfitPerHour: 15_000, rateBasisPoints: 550 },
      { minimumProfitPerHour: 7_000, rateBasisPoints: 325 },
    ],
  };
  const result = payroll.distributeStoreKpiByPolicy(3_000_000, [{
    employeeId: "employee-fractional-rate",
    employmentStatus: "ACTIVE",
    completedShiftCount: 1,
    durationSeconds: 60 * 3_600,
  }], policy);

  assert.equal(result.profitPerHour, 15_000);
  assert.equal(result.kpiRate, 0.055);
  assert.equal(result.employeeBonusTotal, 165_000);
  assert.equal(result.employees[0].bonus, 165_000);
  assert.equal(result.managerBonus, 75_000);
});

test("migration is additive and seeds compatibility defaults", async () => {
  const migration = await readFile(new URL("../drizzle/0024_payroll_policy.sql", import.meta.url), "utf8");
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec("CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    legacy.exec(migration.replaceAll("--> statement-breakpoint", ""));
    const stored = JSON.parse(legacy.prepare("SELECT value FROM system_state WHERE key = 'global_payroll_policy_v1'").get().value);
    assert.equal(stored.managerMonthlySalaryVnd, 3_000_000);
    assert.equal(stored.managerKpiRateBasisPoints, null);
    assert.deepEqual(stored.employeeKpiTiers.map((tier) => tier.rateBasisPoints), [700, 500, 300]);
  } finally { legacy.close(); }
});
