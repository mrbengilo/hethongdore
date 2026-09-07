import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-support-context-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const [{ initDb }, { sha256, getSessionUser }, shift, orders, transfers, records, payroll, attendance] = await Promise.all([
  import("../db/runtime.ts"), import("../app/api/_lib/auth.ts"), import("../app/api/shift/route.ts"),
  import("../app/api/orders/route.ts"), import("../app/api/transfers/route.ts"), import("../app/api/records/route.ts"),
  import("../app/api/payroll/route.ts"), import("../app/api/attendance-stats/route.ts"),
]);
let db;
const HOME = "st-can-tho", SUPPORT = "st-thot-not";
const instant = (time) => new Date(`2026-09-03T${time}:00+07:00`).getTime();
const req = (path, body, actor = "employee", method = body ? "POST" : "GET") => new Request(`http://localhost${path}`, {
  method, headers: { cookie: `dore_session=support-${actor}`, "Content-Type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function ok(response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
before(async () => { db = await initDb(); });
after(async () => { db?.close?.(); await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => {
  for (const table of ["sessions", "notifications", "orders", "audit_logs", "employee_payroll_closings", "financial_periods", "business_records", "shift_sessions", "employee_transfers", "users", "employees"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("UPDATE stores SET status = 'ACTIVE', revenue = 0, expense = 0").run();
  await db.prepare(`INSERT INTO employees (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
    VALUES ('support-employee', ?, 'SUP01', 'Nhân viên hỗ trợ A', 'Nhân viên', '', 20000, 0, 'ACTIVE')`).bind(HOME).run();
  for (const actor of ["employee", "admin"]) {
    await db.prepare(`INSERT INTO users (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
      VALUES (?, ?, 'unused', ?, ?, ?, ?, ?)`)
      .bind(`support-${actor}`, `support-${actor}`, actor === "admin" ? "MANAGER" : "EMPLOYEE", actor,
        actor === "admin" ? null : "support-employee", actor === "admin" ? null : HOME, actor === "admin" ? 1 : 0).run();
    await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(`support-session-${actor}`, `support-${actor}`, await sha256(`support-${actor}`), Date.UTC(2030, 0, 1), "2026-09-01T00:00:00Z").run();
  }
});
async function schedule(storeId, name, start, end) {
  await db.prepare(`INSERT INTO business_records (id, category, store_id, title, data_json, status, created_at, updated_at)
    VALUES (?, 'LICH_PHAN_CA', ?, ?, ?, 'ACTIVE', ?, ?)`)
    .bind(`schedule-${storeId}`, storeId, name, JSON.stringify({ date: "2026-09-03", employeeIds: ["support-employee"], employeeNames: ["Nhân viên hỗ trợ A"], shiftName: name, start, end }), "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").run();
}
async function transfer() {
  await db.prepare(`INSERT INTO employee_transfers (id, employee_id, source_store_id, target_store_id,
    start_date, end_date, shifts_json, support_hourly_rate, support_allowance, reason, status, created_by, created_at, updated_at)
    VALUES ('support-transfer', 'support-employee', ?, ?, '2026-09-03', '2026-09-03', '["Cả ngày"]', 30000, 50000, 'Hỗ trợ', 'SCHEDULED', 'support-admin', ?, ?)`)
    .bind(HOME, SUPPORT, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").run();
}
async function start() {
  const preview = await ok(await shift.GET(req("/api/shift?preview=start")));
  return ok(await shift.POST(req("/api/shift", { action: "start", expectedStart: preview.startCandidates[0],
    clockInLocation: { latitude: 10.045162, longitude: 105.746857, accuracyMeters: 10, capturedAt: new Date().toISOString() } })));
}
async function end(cashRevenue = 0) {
  return ok(await shift.POST(req("/api/shift", { action: "end", tasksCompleted: true, tiktok: false, expenseAmount: 0,
    cashRevenue, transferRevenue: 0, earlyEndConfirmed: true })));
}
async function order(amount = 20000) {
  return ok(await orders.POST(req("/api/orders", { amount, paymentMethod: "CASH", customerName: "Khách kiểm thử", phone: "0900000000", clientRequestId: crypto.randomUUID() })), 201);
}
async function task(storeId) {
  const id = `task-${storeId}`;
  await db.prepare(`INSERT INTO business_records (id, category, store_id, title, data_json, status, created_at, updated_at) VALUES (?, 'TASKS', ?, 'Kiểm thử công việc', ?, 'ACTIVE', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')`)
    .bind(id, storeId, JSON.stringify({ date: "2026-09-03", items: [{ content: "Bàn giao", completedBy: [] }] })).run();
  return records.PATCH(req("/api/records", { id, completedIndex: 0 }, "employee", "PATCH"));
}

test("home shift wins after support starts; only END switches to support attendance, and support stays until END", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: instant("08:00") });
  await schedule(HOME, "Ca sáng", "08:00", "12:00");
  await schedule(SUPPORT, "Ca chiều", "12:00", "21:00");
  await transfer();
  const startedHome = await start();
  assert.equal(startedHome.storeId, HOME); assert.equal(startedHome.activeTransferId, null);
  t.mock.timers.setTime(instant("12:30"));
  assert.equal((await getSessionUser(req("/api/auth/me"))).storeId, HOME);
  assert.equal((await ok(await shift.GET(req("/api/shift")))).storeId, HOME);
  await order(); await ok(await task(HOME));
  assert.equal((await task(SUPPORT)).status, 403);
  const closedHome = await end(20000);
  assert.equal(closedHome.storeId, SUPPORT);
  assert.equal(closedHome.activeTransferId, "support-transfer");
  assert.equal(closedHome.isSupporting, true);
  assert.equal(closedHome.active, false);
  const startedSupport = await start();
  assert.equal(startedSupport.storeId, SUPPORT); assert.equal(startedSupport.activeTransferId, "support-transfer");
  t.mock.timers.setTime(instant("21:30"));
  const overtime = await getSessionUser(req("/api/auth/me"));
  assert.equal(overtime.storeId, SUPPORT); assert.equal(overtime.shiftActive, 1);
  await order();
  await ok(await records.PATCH(req("/api/records", { id: `task-${SUPPORT}`, completedIndex: 0 }, "employee", "PATCH")));
  const closedSupport = await end(20000);
  assert.equal(closedSupport.storeId, HOME); assert.equal(closedSupport.activeTransferId, null);
  assert.equal(closedSupport.returnedToHomeStore, true);
  assert.equal((await getSessionUser(req("/api/auth/me"))).storeId, HOME);
  const [homePay, supportPay] = await Promise.all([HOME, SUPPORT].map(async (storeId) => ok(await payroll.GET(req(`/api/payroll?storeId=${storeId}&period=2026-09`, undefined, "admin")))));
  const homeItem = homePay.summary.items.find((item) => item.employeeId === "support-employee");
  const supportItem = supportPay.summary.items.find((item) => item.employeeId === "support-employee");
  assert.equal(homeItem.baseSalary, 90000); assert.equal(homeItem.supportAllowance, 0);
  assert.equal(supportItem.baseSalary, 270000); assert.equal(supportItem.supportAllowance, 50000);
  assert.equal(homeItem.isSupport, false); assert.equal(supportItem.isSupport, true);
  assert.equal(supportItem.sourceStoreName, "DORE CẦN THƠ");
  const managerOrders = await ok(await orders.GET(req(`/api/orders?storeId=${SUPPORT}`, undefined, "admin")));
  assert.equal(managerOrders.orders[0].isSupport, 1);
  assert.equal(managerOrders.orders[0].sourceStoreName, "DORE CẦN THƠ");
  const stats = await ok(await attendance.GET(req(`/api/attendance-stats?storeId=${SUPPORT}&mode=month&anchor=2026-09-03`, undefined, "admin")));
  assert.equal(stats.rows.find((row) => row.employeeId === "support-employee").isSupport, true);
});

test("date expiry and manager END/CANCEL cannot revoke a support shift that is still open", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: instant("08:00") });
  await schedule(SUPPORT, "Ca sáng", "08:00", "12:00"); await transfer(); await start();
  t.mock.timers.setTime(instant("12:30"));
  await order();
  t.mock.timers.setTime(new Date("2026-09-04T00:05:00+07:00").getTime());
  const list = await ok(await transfers.GET(req("/api/transfers", undefined, "admin")));
  assert.equal(list.transfers[0].status, "ACTIVE"); assert.equal(list.transfers[0].has_open_shift, 1);
  for (const action of ["END", "CANCEL"]) {
    assert.equal((await transfers.PATCH(req("/api/transfers", { id: "support-transfer", action }, "admin", "PATCH"))).status, 409);
  }
  assert.equal((await getSessionUser(req("/api/auth/me"))).storeId, SUPPORT);
  await order(); await ok(await task(SUPPORT));
  const closed = await end(40000);
  assert.equal(closed.storeId, HOME);
  assert.equal(await db.prepare("SELECT status FROM employee_transfers WHERE id = 'support-transfer'").first("status"), "COMPLETED");
});

test("expired transfer with no open shift expires normally and does not capture the home account", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-04T09:00:00+07:00").getTime() });
  await transfer();
  const list = await ok(await transfers.GET(req("/api/transfers", undefined, "admin")));
  assert.equal(list.transfers[0].status, "COMPLETED");
  const user = await getSessionUser(req("/api/auth/me"));
  assert.equal(user.storeId, HOME); assert.equal(user.isSupporting, false);
});

test("active shift is authoritative even when the cached user shift pointer is stale", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: instant("08:00") });
  await schedule(HOME, "Ca sáng", "08:00", "12:00"); await start();
  await transfer(); await schedule(SUPPORT, "Ca chiều", "12:00", "21:00");
  await db.prepare("UPDATE users SET current_shift = 'stale-pointer' WHERE id = 'support-employee'").run();
  t.mock.timers.setTime(instant("13:00"));
  const user = await getSessionUser(req("/api/auth/me"));
  assert.equal(user.storeId, HOME); assert.equal(user.shiftActive, 1); assert.notEqual(user.currentShift, "stale-pointer");
  assert.equal((await ok(await shift.GET(req("/api/shift")))).storeId, HOME);
});
