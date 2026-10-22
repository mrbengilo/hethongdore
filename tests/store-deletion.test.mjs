import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-store-deletion-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, stores, login] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/stores/route.ts"),
  import("../app/api/auth/login/route.ts"),
]);

const db = await runtime.initDb();
const password = "store-delete-password";
const tokens = {
  super: "store-delete-super-token",
  regular: "store-delete-regular-token",
  scoped: "store-delete-scoped-token",
  employee: "store-delete-employee-token",
  supporting: "store-delete-supporting-token",
};

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `dore_session=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function responseBody(response) {
  return { status: response.status, body: await response.json() };
}

before(async () => {
  const now = new Date().toISOString();
  const passwordHash = await auth.hashPassword(password);
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES ('delete-empty', 'DELETE EMPTY', 'A', 0, 0, 'ACTIVE', ?),
             ('delete-with-order', 'DELETE WITH ORDER', 'B', 0, 0, 'INACTIVE', ?),
             ('delete-with-advance', 'DELETE WITH ADVANCE', 'B2', 0, 0, 'ACTIVE', ?),
             ('delete-race', 'DELETE RACE', 'C', 0, 0, 'ACTIVE', ?),
             ('delete-other', 'DELETE OTHER', 'D', 7000, 3000, 'ACTIVE', ?)`)
      .bind(now, now, now, now, now),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
      VALUES ('delete-employee', 'delete-empty', 'DEL001', 'Nhân viên cần khóa', 'Bán hàng', '0900000201', 20000, 0, 'ACTIVE'),
             ('delete-supporting', 'delete-other', 'DEL002', 'Nhân viên hỗ trợ', 'Bán hàng', '0900000202', 20000, 0, 'ACTIVE')`),
    db.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, employee_id, store_id,
         shift_active, current_shift, shift_started_at, is_super_admin)
      VALUES ('delete-super', 'delete-super', ?, 'MANAGER', 'Super', NULL, NULL, 0, NULL, NULL, 1),
             ('delete-regular', 'delete-regular', ?, 'MANAGER', 'Regular', NULL, NULL, 0, NULL, NULL, 0),
             ('delete-scoped', 'delete-scoped', ?, 'MANAGER', 'Scoped', NULL, 'delete-empty', 0, NULL, NULL, 0),
             ('delete-employee-user', 'delete-employee-user', ?, 'EMPLOYEE', 'Nhân viên cần khóa', 'delete-employee', 'delete-empty', 1, 'DELETE-HOME-SUPPORT-SHIFT', ?, 0),
             ('delete-supporting-user', 'delete-supporting-user', ?, 'EMPLOYEE', 'Nhân viên hỗ trợ', 'delete-supporting', 'delete-other', 1, 'DELETE-TARGET-SUPPORT-SHIFT', ?, 0)`)
      .bind(passwordHash, passwordHash, passwordHash, passwordHash, now, passwordHash, now),
    db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, transfer_id, started_at,
         tiktok, tiktok_allowance, expense_amount, expense_note, close_status, status)
      VALUES ('delete-home-support-session', 'DELETE-HOME-SUPPORT-SHIFT', 'delete-other', 'delete-employee', 'Ca hỗ trợ ngoài', 'delete-support-transfer', ?,
               1, 25000, 14000, 'Giữ chi phí ca hỗ trợ', 'OPEN', 'ACTIVE'),
             ('delete-target-support-session', 'DELETE-TARGET-SUPPORT-SHIFT', 'delete-empty', 'delete-supporting', 'Ca hỗ trợ vào', NULL, ?,
               1, 18000, 9000, 'Giữ chi phí ca tại cửa hàng', 'OPEN', 'ACTIVE')`)
      .bind(now, now),
    db.prepare(`INSERT INTO employee_transfers
        (id, employee_id, source_store_id, target_store_id, start_date, end_date, shifts_json,
         support_hourly_rate, support_allowance, reason, status, created_by, created_at, updated_at)
      VALUES ('delete-support-transfer', 'delete-employee', 'delete-empty', 'delete-other', '2026-08-01', '2026-08-31', '["Ca hỗ trợ ngoài"]',
              25000, 50000, 'Hỗ trợ cửa hàng khác', 'ACTIVE', 'delete-super', ?, ?)`)
      .bind(now, now),
    db.prepare(`INSERT INTO business_records
        (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES ('delete-record', 'TASKS', 'delete-empty', 'delete-scoped', 'Giữ lịch sử', '{}', 'ACTIVE', ?, ?)`)
      .bind(now, now),
    db.prepare(`INSERT INTO orders
        (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
      VALUES ('delete-voided-order', 'DEL-VOIDED-1', 'delete-with-order', 'delete-employee', 'OLD-SHIFT', 10000, 'CASH', 'VOIDED', ?)`)
      .bind(now),
    db.prepare(`INSERT INTO orders
        (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
      VALUES ('delete-support-cash-order', 'DEL-SUPPORT-CASH', 'delete-other', 'delete-employee', 'DELETE-HOME-SUPPORT-SHIFT', 32000, 'CASH', 'COMPLETED', ?),
             ('delete-support-bank-order', 'DEL-SUPPORT-BANK', 'delete-other', 'delete-employee', 'DELETE-HOME-SUPPORT-SHIFT', 48000, 'BANK_TRANSFER', 'COMPLETED', ?),
             ('delete-support-void-order', 'DEL-SUPPORT-VOID', 'delete-other', 'delete-employee', 'DELETE-HOME-SUPPORT-SHIFT', 99000, 'CASH', 'VOIDED', ?)`)
      .bind(now, now, now),
    db.prepare(`INSERT INTO salary_advances
        (id, store_id, employee_id, period, advance_date, amount,
         gross_entitlement_snapshot, available_before_snapshot, remaining_after_snapshot,
         note, status, version, client_request_id, payload_hash, mutation_token,
         created_by, created_at, updated_by, updated_at)
      VALUES ('delete-salary-advance', 'delete-with-advance', 'delete-employee', '2026-08', '2026-08-10', 10000,
        50000, 50000, 40000, 'Khoản ứng cần giữ để đối soát', 'DRAFT', 1,
        'delete-advance-request', 'hash', 'token', 'delete-super', ?, 'delete-super', ?)`)
      .bind(now, now),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('delete-super-session', 'delete-super', ?, ?, ?),
           ('delete-regular-session', 'delete-regular', ?, ?, ?),
           ('delete-scoped-session', 'delete-scoped', ?, ?, ?),
           ('delete-employee-session', 'delete-employee-user', ?, ?, ?),
           ('delete-supporting-session', 'delete-supporting-user', ?, ?, ?)`)
    .bind(
      await auth.sha256(tokens.super), Date.now() + 300_000, now,
      await auth.sha256(tokens.regular), Date.now() + 300_000, now,
      await auth.sha256(tokens.scoped), Date.now() + 300_000, now,
      await auth.sha256(tokens.employee), Date.now() + 300_000, now,
      await auth.sha256(tokens.supporting), Date.now() + 300_000, now,
    ).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("ordinary managers cannot delete a store", async () => {
  const result = await responseBody(await stores.DELETE(request("/api/stores", tokens.regular, "DELETE", { id: "delete-empty" })));
  assert.equal(result.status, 403);
  assert.match(result.body.message, /quản trị cấp cao/iu);
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'delete-empty'").first("status"), "ACTIVE");
});

test("every historical order, including VOIDED, permanently blocks store deletion", async () => {
  const result = await responseBody(await stores.DELETE(request("/api/stores", tokens.super, "DELETE", { id: "delete-with-order" })));
  assert.equal(result.status, 409);
  assert.match(result.body.message, /đã phát sinh đơn hàng/iu);
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'delete-with-order'").first("status"), "INACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'DELETE' AND entity_id = 'delete-with-order'").first("count"), 0);
});

test("salary advance history blocks store deletion without writing a tombstone audit", async () => {
  const result = await responseBody(await stores.DELETE(request("/api/stores", tokens.super, "DELETE", { id: "delete-with-advance" })));
  assert.equal(result.status, 409);
  assert.match(result.body.message, /ứng lương/iu);
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'delete-with-advance'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'DELETE' AND entity_id = 'delete-with-advance'").first("count"), 0);
});

test("a stale no-order read cannot delete after an order wins immediately before the atomic batch", async () => {
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      await db.prepare(`INSERT INTO orders
          (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
        VALUES ('delete-race-order', 'DEL-RACE-1', 'delete-race', 'delete-employee', 'RACE-SHIFT', 15000, 'CASH', 'COMPLETED', ?)`)
        .bind(new Date().toISOString()).run();
    }
    return originalBatch(statements);
  };
  try {
    const result = await responseBody(await stores.DELETE(request("/api/stores", tokens.super, "DELETE", { id: "delete-race" })));
    assert.equal(result.status, 409);
    assert.match(result.body.message, /đã phát sinh đơn hàng/iu);
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'delete-race'").first("status"), "ACTIVE");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'DELETE' AND entity_id = 'delete-race'").first("count"), 0);
});

test("superadmin tombstones an orderless store, closes every linked active shift, preserves history and revokes access", async () => {
  const result = await responseBody(await stores.DELETE(request("/api/stores", tokens.super, "DELETE", { id: "delete-empty" })));
  assert.equal(result.status, 200);
  assert.equal(await db.prepare("SELECT status FROM stores WHERE id = 'delete-empty'").first("status"), "DELETED");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM employees WHERE store_id = 'delete-empty'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE id IN ('delete-home-support-session', 'delete-target-support-session')").first("count"), 2);
  const closedShifts = await db.prepare(`SELECT id, status, close_status AS closeStatus, close_reason AS closeReason,
      ended_at AS endedAt, duration_seconds AS durationSeconds, tiktok, tiktok_allowance AS tiktokAllowance,
      expense_amount AS expenseAmount, expense_note AS expenseNote
    FROM shift_sessions
    WHERE id IN ('delete-home-support-session', 'delete-target-support-session')
    ORDER BY id`).all();
  assert.equal(closedShifts.results.length, 2);
  for (const shift of closedShifts.results) {
    assert.equal(shift.status, "COMPLETED");
    assert.equal(shift.closeStatus, "ADMIN_CLOSED");
    assert.equal(shift.closeReason, "STORE_DELETED");
    assert.ok(shift.endedAt);
    assert.ok(Number(shift.durationSeconds) >= 0);
    assert.equal(shift.tiktok, 1);
  }
  assert.deepEqual(
    closedShifts.results.map((shift) => [shift.id, shift.tiktokAllowance, shift.expenseAmount, shift.expenseNote]),
    [
      ["delete-home-support-session", 25000, 14000, "Giữ chi phí ca hỗ trợ"],
      ["delete-target-support-session", 18000, 9000, "Giữ chi phí ca tại cửa hàng"],
    ],
  );
  assert.equal(await db.prepare(`SELECT COUNT(*) AS count FROM shift_sessions
    WHERE (status = 'ACTIVE' OR ended_at IS NULL)
      AND (store_id = 'delete-empty' OR employee_id IN (
        SELECT id FROM employees WHERE store_id = 'delete-empty'
      ))`).first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM business_records WHERE store_id = 'delete-empty'").first("count"), 1);
  assert.deepEqual(
    { ...await db.prepare("SELECT revenue, expense FROM stores WHERE id = 'delete-other'").first() },
    { revenue: 87000, expense: 17000 },
  );
  assert.deepEqual(
    { ...await db.prepare("SELECT cash_revenue AS cashRevenue, transfer_revenue AS transferRevenue FROM shift_sessions WHERE id = 'delete-home-support-session'").first() },
    { cashRevenue: 32000, transferRevenue: 48000 },
  );
  assert.equal(await db.prepare("SELECT status FROM employee_transfers WHERE id = 'delete-support-transfer'").first("status"), "COMPLETED");
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id IN ('delete-scoped', 'delete-employee-user', 'delete-supporting-user')").first("count"), 0);
  assert.deepEqual(
    { ...await db.prepare("SELECT shift_active AS shiftActive, current_shift AS currentShift, shift_started_at AS shiftStartedAt FROM users WHERE id = 'delete-supporting-user'").first() },
    { shiftActive: 0, currentShift: null, shiftStartedAt: null },
  );
  assert.deepEqual(
    { ...await db.prepare("SELECT shift_active AS shiftActive, current_shift AS currentShift, shift_started_at AS shiftStartedAt FROM users WHERE id = 'delete-employee-user'").first() },
    { shiftActive: 0, currentShift: null, shiftStartedAt: null },
  );
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'delete-super'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'DELETE' AND entity_type = 'STORE' AND entity_id = 'delete-empty'").first("count"), 1);

  const visible = await responseBody(await stores.GET(request("/api/stores?period=2026-08", tokens.super)));
  assert.equal(visible.status, 200);
  assert.equal(visible.body.stores.some((store) => store.id === "delete-empty"), false);

  const staleSession = await auth.getSessionUser(request("/api/auth/me", tokens.scoped));
  assert.equal(staleSession, null);
  const relogin = await responseBody(await login.POST(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "delete-scoped", password }),
  })));
  assert.equal(relogin.status, 403);
  assert.match(relogin.body.message, /Cửa hàng đã bị xóa/iu);
});

test("a deleted store releases its display name atomically while a live duplicate remains blocked", async () => {
  await db.prepare("UPDATE stores SET status = 'DELETED' WHERE id = 'delete-empty'").run();

  const created = await responseBody(await stores.POST(request("/api/stores", tokens.super, "POST", {
    name: "DELETE EMPTY",
    address: "Địa chỉ cửa hàng thay thế",
  })));
  assert.equal(created.status, 201);

  const rows = await db.prepare(`SELECT id, name, status FROM stores
    WHERE id = 'delete-empty' OR id = ? ORDER BY id`)
    .bind(created.body.id).all();
  assert.equal(rows.results.length, 2);
  const tombstone = rows.results.find((row) => row.id === "delete-empty");
  const replacement = rows.results.find((row) => row.id === created.body.id);
  assert.equal(tombstone.status, "DELETED");
  assert.match(tombstone.name, /^DELETE EMPTY · ĐÃ XÓA · delete-empty$/u);
  assert.deepEqual({ name: replacement.name, status: replacement.status }, { name: "DELETE EMPTY", status: "ACTIVE" });
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'CREATE' AND entity_id = ?")
    .bind(created.body.id).first("count"), 1);

  const duplicate = await responseBody(await stores.POST(request("/api/stores", tokens.super, "POST", {
    name: "delete empty",
    address: "Không được tạo",
  })));
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.message, /đã tồn tại/iu);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM stores WHERE name = 'DELETE EMPTY' AND status IN ('ACTIVE', 'INACTIVE')").first("count"), 1);
});
