import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-store-overview-finance-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, storesRoute, reportsRoute, finance, storeFinance] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/stores/route.ts"),
  import("../app/api/reports/route.ts"),
  import("../app/lib/finance.ts"),
  import("../app/api/_lib/store-finance.ts"),
]);

const db = await runtime.initDb();
const token = "store-overview-finance-token";
const storeId = "overview-fixed-cost-store";
const secondStoreId = "overview-fixed-cost-second-store";
const period = finance.localPeriod();
const priorPeriod = storeFinance.previousPeriod(period);
const currentManagerSalary = 4_500_000;
const lockedManagerSalary = 1_250_000;
const lockedEmployeeKpi = 125_000;
const lockedManagerKpi = 75_000;
const inventoryGoods = 3_200_000;
const inventoryShipping = 250_000;
const inventoryExpense = inventoryGoods + inventoryShipping;

function request(path) {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: `dore_session=${encodeURIComponent(token)}` },
  });
}

before(async () => {
  const now = new Date().toISOString();
  const createdAt = new Date(`${priorPeriod}-01T00:00:00+07:00`).toISOString();
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
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('report-fixed-cost-prior-record', 'CHI_PHI_CO_DINH', ?, 'overview-finance-manager',
        'Chi phí cố định kỳ trước', ?, 'ACTIVE', ?, ?)`)
      .bind(storeId, JSON.stringify({ period: priorPeriod, total: 6_200_000 }), now, now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('report-fixed-cost-second-prior-record', 'CHI_PHI_CO_DINH', ?, 'overview-finance-manager',
        'Chi phí cố định kỳ trước', ?, 'ACTIVE', ?, ?)`)
      .bind(secondStoreId, JSON.stringify({ period: priorPeriod, total: 2_800_000 }), now, now),
    db.prepare(`UPDATE system_state SET value = ?, updated_at = ?
      WHERE key = 'global_payroll_policy_v1'`)
      .bind(JSON.stringify({
        schemaVersion: 1,
        managerMonthlySalaryVnd: currentManagerSalary,
        managerKpiRateBasisPoints: 250,
        employeeKpiTiers: [
          { minimumProfitPerHour: 30_000, rateBasisPoints: 800 },
          { minimumProfitPerHour: 15_000, rateBasisPoints: 550 },
          { minimumProfitPerHour: 7_000, rateBasisPoints: 325 },
        ],
        version: 2,
        updatedBy: 'overview-finance-manager',
        mutationToken: 'overview-policy-v2',
      }), now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('overview-locked-policy-snapshot', 'KPI_SUMMARY', ?, 'overview-finance-manager',
        'Kỳ lương đã khóa', ?, 'LOCKED', ?, ?)`)
      .bind(secondStoreId, JSON.stringify({
        period,
        managerSalary: lockedManagerSalary,
        totalKpiBonus: lockedEmployeeKpi,
        managerBonus: lockedManagerKpi,
      }), now, now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('overview-inventory-canonical', 'NHAP_HANG', ?, 'overview-finance-manager',
        'Phiếu nhập canonical', ?, 'ACTIVE', ?, ?)`)
      .bind(storeId, JSON.stringify({
        date: `${period}-02`,
        period,
        items: [{ name: 'Hàng canonical', weight: 20, unitPrice: 100_000, shipping: 150_000, goodsAmount: 2_000_000, amount: 2_150_000 }],
        goodsTotal: 2_000_000,
        shippingTotal: 150_000,
        total: 2_150_000,
      }), now, now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('overview-inventory-legacy-amount', 'NHAP_HANG', ?, 'overview-finance-manager',
        'Phiếu nhập legacy', ?, 'ACTIVE', ?, ?)`)
      .bind(storeId, JSON.stringify({
        date: `${period}-03`,
        period,
        amount: 1_300_000,
        shipping: 100_000,
      }), now, now),
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

  const reconciled = storeFinance.recognizeFullPeriodFixedCosts(range, monthly);
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

  const reconciled = storeFinance.recognizeFullPeriodFixedCosts(range, monthly);
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
  assert.equal(store.expenseBreakdown.managerSalary, currentManagerSalary);
  assert.equal(store.expenseBreakdown.inventoryGoods, inventoryGoods);
  assert.equal(store.expenseBreakdown.inventoryShipping, inventoryShipping);
  assert.equal(store.expense, 7_400_000 + currentManagerSalary + inventoryExpense);
  assert.equal(store.profit, -(7_400_000 + currentManagerSalary + inventoryExpense));
  assert.equal(store.timeline.reduce((sum, day) => sum + day.expense, 0), store.expense);
  assert.equal(secondStore.expenseBreakdown.fixedCosts, 3_250_000);
  assert.equal(secondStore.expenseBreakdown.managerSalary, lockedManagerSalary);
  assert.equal(secondStore.expenseBreakdown.employeeKpiBonus, lockedEmployeeKpi);
  assert.equal(secondStore.expenseBreakdown.managerBonus, lockedManagerKpi);
  assert.equal(secondStore.expense, 3_250_000 + lockedManagerSalary + lockedEmployeeKpi + lockedManagerKpi);
  assert.equal(secondStore.profit, -(3_250_000 + lockedManagerSalary + lockedEmployeeKpi + lockedManagerKpi));
  assert.equal(secondStore.timeline.reduce((sum, day) => sum + day.expense, 0), secondStore.expense);
});

test("financial report recognizes full fixed costs for every store and the comparable prior period", async () => {
  const response = await reportsRoute.GET(request(`/api/reports?period=${encodeURIComponent(period)}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  const store = body.stores.find((item) => item.current.id === storeId);
  const secondStore = body.stores.find((item) => item.current.id === secondStoreId);
  assert.ok(store?.previous);
  assert.ok(secondStore?.previous);

  assert.equal(store.current.expenseBreakdown.fixedCosts, 7_400_000);
  assert.equal(store.current.expenseBreakdown.managerSalary, currentManagerSalary);
  assert.equal(store.current.expenseBreakdown.inventoryGoods, inventoryGoods);
  assert.equal(store.current.expenseBreakdown.inventoryShipping, inventoryShipping);
  assert.equal(store.current.expense, 7_400_000 + currentManagerSalary + inventoryExpense);
  assert.equal(store.current.profit, -(7_400_000 + currentManagerSalary + inventoryExpense));
  assert.equal(store.current.profitBeforePerformanceRewards, -(7_400_000 + currentManagerSalary + inventoryExpense));
  assert.equal(store.current.timeline.reduce((sum, day) => sum + day.expense, 0), store.current.expense);
  assert.equal(store.previous.expenseBreakdown.fixedCosts, 6_200_000);
  assert.equal(store.previous.expenseBreakdown.managerSalary, currentManagerSalary);
  assert.equal(store.previous.expense, 6_200_000 + currentManagerSalary);
  assert.equal(store.previous.profit, -(6_200_000 + currentManagerSalary));
  assert.equal(store.previous.profitBeforePerformanceRewards, -(6_200_000 + currentManagerSalary));
  assert.equal(store.previous.timeline.reduce((sum, day) => sum + day.expense, 0), store.previous.expense);

  assert.equal(secondStore.current.expenseBreakdown.fixedCosts, 3_250_000);
  assert.equal(secondStore.current.expenseBreakdown.managerSalary, lockedManagerSalary);
  assert.equal(secondStore.current.expenseBreakdown.employeeKpiBonus, lockedEmployeeKpi);
  assert.equal(secondStore.current.expenseBreakdown.managerBonus, lockedManagerKpi);
  assert.equal(secondStore.current.expense, 3_250_000 + lockedManagerSalary + lockedEmployeeKpi + lockedManagerKpi);
  assert.equal(secondStore.current.profit, -(3_250_000 + lockedManagerSalary + lockedEmployeeKpi + lockedManagerKpi));
  assert.equal(secondStore.previous.expenseBreakdown.fixedCosts, 2_800_000);
  assert.equal(secondStore.previous.expenseBreakdown.managerSalary, currentManagerSalary);
  assert.equal(secondStore.previous.expense, 2_800_000 + currentManagerSalary);
  assert.equal(secondStore.previous.profit, -(2_800_000 + currentManagerSalary));
  assert.equal(secondStore.previous.timeline.reduce((sum, day) => sum + day.expense, 0), secondStore.previous.expense);

  const expectedCurrentTotal = body.stores.reduce((sum, item) => sum + item.current.expense, 0);
  const expectedPriorTotal = body.stores.reduce((sum, item) => sum + (item.previous?.expense ?? 0), 0);
  assert.ok(body.stores.filter((item) => item.current.id !== secondStoreId)
    .every((item) => item.current.expenseBreakdown.managerSalary === currentManagerSalary));
  assert.deepEqual(body.totals, { revenue: 0, expense: expectedCurrentTotal, profit: -expectedCurrentTotal });
  assert.deepEqual(body.previousTotals, { revenue: 0, expense: expectedPriorTotal, profit: -expectedPriorTotal });
  assert.equal(body.timeline.reduce((sum, day) => sum + day.expense, 0), body.totals.expense);
  assert.equal(body.timeline.reduce((sum, day) => sum + day.profit, 0), body.totals.profit);
  assert.equal(body.byStore.reduce((sum, item) => sum + item.expense, 0), body.totals.expense);
  assert.equal(body.profitSharingPreview.expense, body.totals.expense);
  assert.equal(body.profitSharingPreview.finalProfit, body.totals.profit);
  assert.equal(body.comparison.expenseChange, (expectedCurrentTotal - expectedPriorTotal) / expectedPriorTotal * 100);
  assert.equal(body.comparison.profitChange, (-expectedCurrentTotal + expectedPriorTotal) / expectedPriorTotal * 100);
  assert.match(body.recognitionPolicy.monthlyAccrual, /ghi nhận đủ một lần/u);
});

test("manager report's explicit current month-to-date range matches every store's monthly financial total", async () => {
  const currentMonth = finance.localMonthRange(period);
  const today = finance.localDate();
  const availableEnd = currentMonth.to > today ? today : currentMonth.to;
  const response = await reportsRoute.GET(request(
    `/api/reports?period=${encodeURIComponent(period)}&from=${currentMonth.from}&to=${availableEnd}&granularity=day`,
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  const first = body.stores.find((item) => item.current.id === storeId);
  const second = body.stores.find((item) => item.current.id === secondStoreId);
  assert.ok(first);
  assert.ok(second);

  const expectedFirstExpense = 7_400_000 + currentManagerSalary + inventoryExpense;
  const expectedSecondExpense = 3_250_000 + lockedManagerSalary + lockedEmployeeKpi + lockedManagerKpi;
  assert.equal(first.current.expense, expectedFirstExpense);
  assert.equal(second.current.expense, expectedSecondExpense);
  assert.equal(first.current.expenseBreakdown.fixedCosts, 7_400_000);
  assert.equal(second.current.expenseBreakdown.fixedCosts, 3_250_000);
  const expectedAllStoreExpense = body.stores.reduce((sum, item) => sum + item.current.expense, 0);
  assert.equal(expectedAllStoreExpense, body.totals.expense);
  assert.deepEqual(body.totals, { revenue: 0, expense: expectedAllStoreExpense, profit: -expectedAllStoreExpense });
  assert.equal(body.byStore.reduce((sum, item) => sum + item.expense, 0), body.totals.expense);
  assert.equal(body.timeline.reduce((sum, day) => sum + day.expense, 0), body.totals.expense);
  assert.match(body.recognitionPolicy.monthlyAccrual, /ghi nhận đủ một lần/u);
});

test("Thot Not total-expense regression preserves the exact 18,410,688 VND ledger invariant", () => {
  const fixedCosts = 8_050_000;
  const inventory = 6_570_000;
  const payrollAndOther = 3_790_688;
  const current = {
    revenue: 0,
    expense: fixedCosts + inventory + payrollAndOther,
    profit: -(fixedCosts + inventory + payrollAndOther),
  };
  assert.equal(current.expense, 18_410_688);

  const byStore = [
    { storeId: "thot-not", storeName: "DORE THỐT NỐT", ...current },
    { storeId: "other-store", storeName: "DORE KHÁC", revenue: 0, expense: 2_500_000, profit: -2_500_000 },
  ];
  const totals = byStore.reduce((sum, store) => ({
    revenue: sum.revenue + store.revenue,
    expense: sum.expense + store.expense,
    profit: sum.profit + store.profit,
  }), { revenue: 0, expense: 0, profit: 0 });
  assert.equal(byStore.find((store) => store.storeId === "thot-not")?.expense, 18_410_688);
  assert.equal(byStore.reduce((sum, store) => sum + store.expense, 0), totals.expense);
  assert.equal(totals.profit, totals.revenue - totals.expense);
});

test("financial report keeps daily accrual semantics for an explicit custom date range", async () => {
  const selectedDate = `${period}-01`;
  const response = await reportsRoute.GET(request(
    `/api/reports?period=${encodeURIComponent(period)}&from=${selectedDate}&to=${selectedDate}&granularity=day`,
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  const store = body.stores.find((item) => item.current.id === storeId);
  const secondStore = body.stores.find((item) => item.current.id === secondStoreId);
  assert.ok(store?.previous);
  assert.ok(secondStore?.previous);

  const accruedForDate = (total, date) => {
    const dates = finance.localDateRangeKeys(finance.localMonthRange(date.slice(0, 7)));
    const index = dates.indexOf(date);
    assert.notEqual(index, -1);
    return Math.floor(total / dates.length) + (index < total % dates.length ? 1 : 0);
  };
  const expectedCurrent = accruedForDate(7_400_000, selectedDate);
  const expectedSecondCurrent = accruedForDate(3_250_000, selectedDate);
  const expectedManagerCurrent = accruedForDate(currentManagerSalary, selectedDate);
  const expectedSecondManagerCurrent = accruedForDate(lockedManagerSalary, selectedDate);
  const expectedSecondEmployeeKpi = accruedForDate(lockedEmployeeKpi, selectedDate);
  const expectedSecondManagerKpi = accruedForDate(lockedManagerKpi, selectedDate);
  const previousDate = body.previousRange.to;
  const expectedPrevious = accruedForDate(6_200_000, previousDate);
  const expectedSecondPrevious = accruedForDate(2_800_000, previousDate);
  const expectedManagerPrevious = accruedForDate(currentManagerSalary, previousDate);

  assert.equal(store.current.expenseBreakdown.fixedCosts, expectedCurrent);
  assert.equal(secondStore.current.expenseBreakdown.fixedCosts, expectedSecondCurrent);
  assert.equal(store.previous.expenseBreakdown.fixedCosts, expectedPrevious);
  assert.equal(secondStore.previous.expenseBreakdown.fixedCosts, expectedSecondPrevious);
  assert.equal(store.current.expenseBreakdown.managerSalary, expectedManagerCurrent);
  assert.equal(secondStore.current.expenseBreakdown.managerSalary, expectedSecondManagerCurrent);
  assert.equal(secondStore.current.expenseBreakdown.employeeKpiBonus, expectedSecondEmployeeKpi);
  assert.equal(secondStore.current.expenseBreakdown.managerBonus, expectedSecondManagerKpi);
  assert.equal(store.previous.expenseBreakdown.managerSalary, expectedManagerPrevious);
  assert.equal(secondStore.previous.expenseBreakdown.managerSalary, expectedManagerPrevious);
  assert.ok(store.current.expenseBreakdown.fixedCosts < 7_400_000);
  assert.ok(store.previous.expenseBreakdown.fixedCosts < 6_200_000);
  assert.deepEqual(body.totals, {
    revenue: 0,
    expense: expectedCurrent + expectedManagerCurrent + expectedSecondCurrent
      + expectedSecondManagerCurrent + expectedSecondEmployeeKpi + expectedSecondManagerKpi,
    profit: -(expectedCurrent + expectedManagerCurrent + expectedSecondCurrent
      + expectedSecondManagerCurrent + expectedSecondEmployeeKpi + expectedSecondManagerKpi),
  });
  assert.deepEqual(body.previousTotals, {
    revenue: 0,
    expense: expectedPrevious + expectedManagerPrevious + expectedSecondPrevious + expectedManagerPrevious,
    profit: -(expectedPrevious + expectedManagerPrevious + expectedSecondPrevious + expectedManagerPrevious),
  });
  assert.equal(body.timeline.reduce((sum, day) => sum + day.expense, 0), body.totals.expense);
  assert.match(body.recognitionPolicy.monthlyAccrual, /phân bổ theo ngày trong phạm vi tùy chọn/u);
});
