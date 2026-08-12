import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-super-admin-directory-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, auth, route] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/admin/employees/route.ts"),
]);

let db;
const superToken = "directory-super-token";
const employeeToken = "directory-employee-token";
const initialPassword = "Initial-Pass-2026";

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { ...(token ? { cookie: `dore_session=${encodeURIComponent(token)}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function list(token = superToken) {
  const response = await route.GET(request("/api/admin/employees?page=1&pageSize=20", token));
  return { response, body: await response.json() };
}

before(async () => { db = await initDb(); });
after(async () => { db?.close?.(); await rm(directory, { recursive: true, force: true }); });

beforeEach(async () => {
  for (const table of ["sessions", "notifications", "employee_status_history", "orders", "employee_payroll_closings", "shift_sessions", "business_records", "admin_reset_archives", "audit_logs", "employees"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM users WHERE id != 'user-manager'").run();
  await db.prepare("UPDATE users SET is_super_admin = 1 WHERE id = 'user-manager'").run();
  const passwordHash = await auth.hashPassword(initialPassword);
  await db.batch([
    db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, province, ward, address_line, age,
       hourly_rate, tiktok_allowance, status, status_updated_at, lifecycle_version)
      VALUES ('directory-employee', 'st-can-tho', 'CT099', 'Nhân Viên Kiểm Thử', 'Bán hàng',
       '0909000000', 'Cần Thơ', 'Ninh Kiều', 'Đường kiểm thử', 24, 20000, 25000,
       'ACTIVE', '2026-08-12T00:00:00.000Z', 0)`),
    db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, shift_active)
      VALUES ('directory-user', 'directory.user', ?, 'EMPLOYEE', 'Nhân Viên Kiểm Thử',
       'directory-employee', 'st-can-tho', 3, 0)`).bind(passwordHash),
  ]);
  const expiresAt = Date.now() + 600_000;
  await db.batch([
    db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ('directory-super-session','user-manager',?,?,?)")
      .bind(await auth.sha256(superToken), expiresAt, new Date().toISOString()),
    db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ('directory-employee-session','directory-user',?,?,?)")
      .bind(await auth.sha256(employeeToken), expiresAt, new Date().toISOString()),
  ]);
});

test("global directory is super-admin only and never returns a password or hash", async () => {
  const denied = await list(employeeToken);
  assert.equal(denied.response.status, 403);

  const listed = await list();
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.rows.length, 1);
  assert.equal(listed.body.rows[0].storeName, "DORE CẦN THƠ");
  assert.equal(listed.body.rows[0].username, "directory.user");
  assert.equal(listed.body.rows[0].accountStatus, "ENABLED");
  assert.ok(!Object.hasOwn(listed.body.rows[0], "passwordHash"));
  assert.ok(!Object.hasOwn(listed.body.rows[0], "password"));
  assert.doesNotMatch(JSON.stringify(listed.body), /pbkdf2|Initial-Pass/iu);
});

test("password reset hashes on the server, revokes sessions and writes an audit record atomically", async () => {
  const row = (await list()).body.rows[0];
  const response = await route.PATCH(request("/api/admin/employees", superToken, "PATCH", {
    action: "RESET_PASSWORD", storeId: row.storeId, id: row.id, versionToken: row.versionToken,
    reason: "Nhân viên yêu cầu đặt lại mật khẩu", password: "New-Secure-2026", passwordConfirmation: "New-Secure-2026",
  }));
  assert.equal(response.status, 200);
  const account = await db.prepare("SELECT password_hash AS passwordHash, failed_attempts AS failedAttempts, locked_until AS lockedUntil FROM users WHERE id = 'directory-user'").first();
  assert.notEqual(account.passwordHash, "New-Secure-2026");
  assert.ok(await auth.verifyPassword("New-Secure-2026", account.passwordHash));
  assert.equal(account.failedAttempts, 0);
  assert.equal(account.lockedUntil, null);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'directory-user'").first("count"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SUPER_ADMIN_EMPLOYEE_PASSWORD_RESET' AND entity_id = 'directory-employee'").first("count"), 1);
  const detail = await db.prepare("SELECT detail FROM audit_logs WHERE action = 'SUPER_ADMIN_EMPLOYEE_PASSWORD_RESET'").first("detail");
  assert.doesNotMatch(detail, /New-Secure-2026|passwordHash|pbkdf2/iu);
});

test("two concurrent password resets using the same version token allow exactly one winner", async () => {
  const row = (await list()).body.rows[0];
  const reset = (password, reason) => route.PATCH(request("/api/admin/employees", superToken, "PATCH", {
    action: "RESET_PASSWORD", storeId: row.storeId, id: row.id, versionToken: row.versionToken,
    reason, password, passwordConfirmation: password,
  }));

  const [first, second] = await Promise.all([
    reset("Concurrent-First-2026", "Concurrent password reset request one"),
    reset("Concurrent-Second-2026", "Concurrent password reset request two"),
  ]);
  assert.deepEqual([first.status, second.status].sort((left, right) => left - right), [200, 409]);

  const passwordHash = await db.prepare("SELECT password_hash FROM users WHERE id = 'directory-user'").first("password_hash");
  const winningPasswords = await Promise.all([
    auth.verifyPassword("Concurrent-First-2026", passwordHash),
    auth.verifyPassword("Concurrent-Second-2026", passwordHash),
  ]);
  assert.equal(winningPasswords.filter(Boolean).length, 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SUPER_ADMIN_EMPLOYEE_PASSWORD_RESET' AND entity_id = 'directory-employee'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'directory-user'").first("count"), 0);
});

test("profile edit audit records useful fields without password material", async () => {
  const row = (await list()).body.rows[0];
  const response = await route.PATCH(request("/api/admin/employees", superToken, "PATCH", {
    action: "EDIT_PROFILE", storeId: row.storeId, id: row.id, versionToken: row.versionToken,
    reason: "Cập nhật hồ sơ theo yêu cầu", name: "Nhân Viên Đã Cập Nhật",
    position: row.position, phone: row.phone, province: row.province, ward: row.ward,
    addressLine: row.addressLine, age: row.age, hourlyRate: row.hourlyRate,
    tiktokAllowance: row.tiktokAllowance, username: row.username,
  }));
  assert.equal(response.status, 200);
  const detail = await db.prepare(`SELECT detail FROM audit_logs
    WHERE action = 'SUPER_ADMIN_EMPLOYEE_PROFILE_UPDATE' AND entity_id = 'directory-employee'`).first("detail");
  assert.match(detail, /Nhân Viên Đã Cập Nhật/u);
  assert.doesNotMatch(detail, /password|passwordHash|pbkdf2|Initial-Pass/iu);
});

test("stale edit and password reset lose the lifecycle/version race without partial writes", async () => {
  const row = (await list()).body.rows[0];
  await db.prepare("UPDATE employees SET name = 'Tên đã đổi', lifecycle_version = 1 WHERE id = 'directory-employee'").run();
  const staleEdit = await route.PATCH(request("/api/admin/employees", superToken, "PATCH", {
    action: "EDIT_PROFILE", storeId: row.storeId, id: row.id, versionToken: row.versionToken, reason: "Sửa hồ sơ bị cũ",
    name: "Tên ghi đè", position: row.position, phone: row.phone, province: row.province, ward: row.ward,
    addressLine: row.addressLine, age: row.age, hourlyRate: row.hourlyRate, tiktokAllowance: row.tiktokAllowance, username: row.username,
  }));
  assert.equal(staleEdit.status, 409);
  assert.equal(await db.prepare("SELECT name FROM employees WHERE id = 'directory-employee'").first("name"), "Tên đã đổi");

  const staleReset = await route.PATCH(request("/api/admin/employees", superToken, "PATCH", {
    action: "RESET_PASSWORD", storeId: row.storeId, id: row.id, versionToken: row.versionToken, reason: "Đặt lại bị cũ",
    password: "Another-Secure-2026", passwordConfirmation: "Another-Secure-2026",
  }));
  assert.equal(staleReset.status, 409);
  const hash = await db.prepare("SELECT password_hash FROM users WHERE id = 'directory-user'").first("password_hash");
  assert.ok(await auth.verifyPassword(initialPassword, hash));
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'directory-user'").first("count"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'SUPER_ADMIN_EMPLOYEE_%' ").first("count"), 0);
});

test("top-level UI is responsive, accessible and explains safe password handling", async () => {
  const [portal, component, css] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SuperAdminEmployeeDirectory.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SuperAdminEmployeeDirectory.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /"Quản Lý Nhân Viên"/u);
  assert.match(portal, /view === "Quản Lý Nhân Viên" && isSuperAdmin[\s\S]*<SuperAdminEmployeeDirectory\/>/u);
  assert.match(component, /Mật khẩu hiện tại luôn được mã hóa và không thể xem/u);
  assert.match(component, /role="dialog" aria-modal="true"/u);
  assert.match(component, /error && !action[\s\S]*role="alert"[\s\S]*<h3 id="employee-directory-dialog-title"[\s\S]*error \? <p className=\{styles\.error\} role="alert"/u);
  assert.match(component, /useAccessibleModal/u);
  assert.match(component, /autoComplete="new-password"/u);
  assert.doesNotMatch(component, /passwordHash/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.table tr \{ display: grid/u);
  assert.match(css, /min-height: 44px/u);
});
