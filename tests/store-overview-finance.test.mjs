import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-store-overview-finance-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, storesRoute, finance, storeFinance] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/stores/route.ts"),
  import("../app/lib/finance.ts"),
  import("../app/api/_lib/store-finance.ts"),
]);

const db = await runtime.initDb();
const token = "store-overview-finance-token";
const storeId = "overview-fixed-cost-store";
const secondStoreId = "overview-fixed-cost-second-store";
const period = finance.localPeriod();

function request(path) {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: `dore_session=${encodeURIComponent(token)}` },
  });
}

before(async () => {
  const now = new Date().toISOString();
  const createdAt = new Date(`${period}-01T00:00:00+07:00`).toISOString();
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES (?, 'DORE KIỂM THỬ VĨNH LONG', 'Test', 0, 0, 'ACTIVE', ?)`)
      .bind(storeId, createdAt),
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES (?, 'DORE KIỂM THỬ CẦN THƠ', 'Test', 0, 0, 'ACTIVE', ?)`)
      .bind(secondStoreId, createdAt),
    db.prepare(`INSERT INTO users (id, username, password_hash, role, name, is_super_admin)
      VALUES ('overview-finance-manager', 'overview-finance-manager', ?, 'MANAGER', 'Quản trị', 1)`)
      .bind(process.env.DORE_MANAGER_PASSWORD_HASH),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('overview-fixed-cost-record', 'CHI_PHI_CO_DINH', ?, 'overview-finance-manager',
        'Chi phí cố định', ?, 'ACTIVE', ?, ?)`)
      .bind(storeId, JSON.stringify({ period, total: 7_400_000 }), now, now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('overview-fixed-cost-second-record', 'CHI_PHI_CO_DINH', ?, 'overview-finance-manager',
        'Chi phí cố định', ?, 'ACTIVE', ?, ?)`)
      .bind(secondStoreId, JSON.stringify({ period, total: 3_250_000 }), now, now),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('overview-finance-session', 'overview-finance-manager', ?, ?, ?)`)
    .bind(await auth.sha256(token), Date.now() + 300_000, now).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("overview reconciliation replaces a prorated fixed cost and keeps every total exact", () => {
  const empty = {
    fixedCosts: 0,
    incidentalCosts: 0,
    inventoryGoods: 0,
    inventoryShipping: 0,
    employeeBaseSalary: 0,
    tiktokAllowance: 0,
    supportAllowance: 0,
    manualAllowance: 0,
    manualBonus: 0,
    managerSalary: 0,
    employeeKpiBonus: 0,
    managerBonus: 0,
  };
  const range = {
    id: storeId,
    name: "DORE VĨNH LONG",
    address: "Test",
    status: "ACTIVE",
    range: { from: `${period}-01`, to: `${period}-05` },
    activeDayCount: 5,
    revenue: 10_000_000,
    expense: 2_233_336,
    profit: 7_766_664,
    profitBeforePerformanceRewards: 7_766_664,
    expenseBreakdown: { ...empty, fixedCosts: 1_233_336, incidentalCosts: 1_000_000 },
    calculationStatus: "PROVISIONAL",
    settlementStatus: "OPEN",
    periodStatuses: [],
    timeline: [
      { date: `${period}-01`, revenue: 4_000_000, expense: 1_000_000, profit: 3_000_000, expenseBreakdown: { ...empty, fixedCosts: 600_000, incidentalCosts: 400_000 } },
      { date: `${period}-05`, revenue: 6_000_000, expense: 1_233_336, profit: 4_766_664, expenseBreakdown: { ...empty, fixedCosts: 633_336, incidentalCosts: 600_000 } },
    ],
  };
  const monthly = {
    id: storeId,
    name: range.name,
    address: range.address,
    status: range.status,
    period,
    revenue: range.revenue,
    expense: 8_400_000,
    profit: 1_600_000,
    profitBeforePerformanceRewards: 1_600_000,
    expenseBreakdown: { ...empty, fixedCosts: 7_400_000, incidentalCosts: 1_000_000 },
    calculationStatus: "PROVISIONAL",
    settlementStatus: "OPEN",
  };

  const reconciled = storeFinance.recognizeFullPeriodFixedCostsForOverview(range, monthly);
  assert.equal(reconciled.expenseBreakdown.fixedCosts, 7_400_000);
  assert.equal(reconciled.expense, 8_400_000);
  assert.equal(reconciled.profit, 1_600_000);
  assert.equal(reconciled.timeline.reduce((sum, day) => sum + day.expense, 0), reconciled.expense);
  assert.equal(range.expenseBreakdown.fixedCosts, 1_233_336, "the source range remains immutable");
});

test("overview reconciliation preserves the other month's accrual when the comparable range crosses two months", () => {
  const empty = {
    fixedCosts: 0,
    incidentalCosts: 0,
    inventoryGoods: 0,
    inventoryShipping: 0,
    employeeBaseSalary: 0,
    tiktokAllowance: 0,
    supportAllowance: 0,
    manualAllowance: 0,
    manualBonus: 0,
    managerSalary: 0,
    employeeKpiBonus: 0,
    managerBonus: 0,
  };
  const recognizedFixedCosts = 7_877_428;
  const timeline = Array.from({ length: 30 }, (_, index) => {
    const fixedCosts = Math.floor(recognizedFixedCosts / 30) + (index < recognizedFixedCosts % 30 ? 1 : 0);
    return {
      date: index < 2 ? `2026-01-${String(index + 30).padStart(2, "0")}` : `2026-02-${String(index - 1).padStart(2, "0")}`,
      revenue: 0,
      expense: fixedCosts,
      profit: -fixedCosts,
      expenseBreakdown: { ...empty, fixedCosts },
    };
  });
  assert.equal(timeline.reduce((sum, day) => sum + day.expense, 0), recognizedFixedCosts);
  const range = {
    id: storeId,
    name: "DORE VĨNH LONG",
    address: "Test",
    status: "ACTIVE",
    range: { from: "2026-01-30", to: "2026-02-28" },
    activeDayCount: 30,
    revenue: 0,
    expense: recognizedFixedCosts,
    profit: -recognizedFixedCosts,
    profitBeforePerformanceRewards: -recognizedFixedCosts,
    expenseBreakdown: { ...empty, fixedCosts: recognizedFixedCosts },
    calculationStatus: "PROVISIONAL",
    settlementStatus: "OPEN",
    periodStatuses: [],
    timeline,
  };
  const monthly = {
    id: storeId,
    name: range.name,
    address: range.address,
    status: range.status,
    period: "2026-02",
    revenue: 0,
    expense: 7_400_000,
    profit: -7_400_000,
    profitBeforePerformanceRewards: -7_400_000,
    expenseBreakdown: { ...empty, fixedCosts: 7_400_000 },
    calculationStatus: "PROVISIONAL",
    settlementStatus: "OPEN",
  };

  const reconciled = storeFinance.recognizeFullPeriodFixedCostsForOverview(range, monthly);
  const januaryAccrual = timeline
    .filter((day) => day.date.startsWith("2026-01"))
    .reduce((sum, day) => sum + day.expenseBreakdown.fixedCosts, 0);
  const expectedFixedCosts = januaryAccrual + 7_400_000;
  assert.equal(reconciled.expenseBreakdown.fixedCosts, expectedFixedCosts);
  assert.equal(reconciled.expense, expectedFixedCosts);
  assert.equal(reconciled.profit, -expectedFixedCosts);
  assert.equal(reconciled.timeline.reduce((sum, day) => sum + day.expense, 0), expectedFixedCosts);
  assert.equal(
    reconciled.timeline.filter((day) => day.date.startsWith("2026-01")).reduce((sum, day) => sum + day.expense, 0),
    januaryAccrual,
  );
  assert.ok(reconciled.timeline.every((day) => day.expenseBreakdown.fixedCosts >= 0));
});

test("store overview returns the full configured monthly fixed cost for every store", async () => {
  const response = await storesRoute.GET(request(`/api/stores?period=${encodeURIComponent(period)}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  const store = body.stores.find((item) => item.id === storeId);
  const secondStore = body.stores.find((item) => item.id === secondStoreId);
  assert.ok(store);
  assert.ok(secondStore);
  assert.equal(store.expenseBreakdown.fixedCosts, 7_400_000);
  assert.equal(store.expense, 7_400_000);
  assert.equal(store.profit, -7_400_000);
  assert.equal(store.timeline.reduce((sum, day) => sum + day.expense, 0), store.expense);
  assert.equal(secondStore.expenseBreakdown.fixedCosts, 3_250_000);
  assert.equal(secondStore.expense, 3_250_000);
  assert.equal(secondStore.profit, -3_250_000);
  assert.equal(secondStore.timeline.reduce((sum, day) => sum + day.expense, 0), secondStore.expense);
});
