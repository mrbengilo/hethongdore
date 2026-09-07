import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// This command only accepts a new, empty preview directory directly under the
// operating system's temporary directory. It never opens an existing database.
const input = process.argv[2];
assert.ok(input, "Pass a new directory created with mktemp -d /tmp/dore-preview-XXXXXX");
const directory = resolve(input);
const stat = await lstat(directory);
assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Preview directory must not be a symlink");
assert.equal(await realpath(directory), directory, "Preview path must be canonical");
assert.equal(dirname(directory), await realpath(tmpdir()), "Preview must be inside the system temporary directory");
assert.match(basename(directory), /^dore-preview-[A-Za-z0-9]+$/u);
assert.deepEqual(await readdir(directory), [], "Preview directory must be empty; existing data is never reused");

process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_UPLOAD_DIR = join(directory, "uploads");
const password = randomBytes(18).toString("base64url");
const { hashPassword } = await import("../../app/api/_lib/auth.ts");
process.env.DORE_MANAGER_PASSWORD_HASH = await hashPassword(password);
await mkdir(process.env.DORE_UPLOAD_DIR, { mode: 0o700 });
const { initDb } = await import("../../db/runtime.ts");
const db = await initDb();
const period = "2026-08";

try {
  // Bootstrap only ever ran against the new database above.
  await db.prepare("DELETE FROM stores").run();
  await db.prepare("UPDATE users SET username = 'qa-admin', name = 'KIỂM THỬ · Quản trị', is_super_admin = 1 WHERE id = 'user-manager'").run();
  await db.prepare(`INSERT INTO stores (id, name, address, status, created_at) VALUES
    ('qa-locked', 'KIỂM THỬ A · Đã khóa kỳ · Tên cửa hàng dài để kiểm tra bố cục', 'Dữ liệu mẫu', 'ACTIVE', '2026-08-01T00:00:00.000Z'),
    ('qa-open', 'KIỂM THỬ B · Đang mở · Nhập lương quản lý tại đây', 'Dữ liệu mẫu', 'ACTIVE', '2026-08-01T00:00:00.000Z'),
    ('qa-future', 'KIỂM THỬ C · Mở từ tháng 09', 'Dữ liệu mẫu', 'ACTIVE', '2026-08-31T17:00:00.000Z')`).run();
  const { seedPolicy } = await import("../../tests/helpers/profit-distribution-fixtures.mjs");
  await seedPolicy(db, {
    employeeKpiTiers: [
      { minimumProfitPerHour: 30_000, rateBasisPoints: 0 },
      { minimumProfitPerHour: 15_000, rateBasisPoints: 0 },
      { minimumProfitPerHour: 7_000, rateBasisPoints: 0 },
    ],
    profitSharingMembers: [
      { memberId: "qa-member-b", name: "Thành viên B · Tên dài để kiểm tra hiển thị", rateBasisPoints: 4_000 },
      { memberId: "qa-member-c", name: "Thành viên C", rateBasisPoints: 6_000 },
    ],
  });

  for (const storeId of ["qa-locked", "qa-open"]) {
    for (let index = 1; index <= 3; index += 1) {
      const employeeId = `${storeId}-employee-${index}`;
      const shiftId = `${storeId}-shift-${index}`;
      await db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
        VALUES (?, ?, ?, ?, 'Bán hàng', '', 25000, 0, 'ACTIVE')`)
        .bind(employeeId, storeId, employeeId, `Nhân viên kiểm thử ${index} · Họ và tên dài để kiểm tra bố cục`).run();
      await db.prepare(`INSERT INTO shift_sessions
        (id, shift_code, store_id, employee_id, shift_name, work_date, applied_hourly_rate,
         started_at, ended_at, duration_seconds, tiktok_allowance, close_status, status)
        VALUES (?, ?, ?, ?, 'Ca sáng', '2026-08-10', 25000,
          '2026-08-10T01:00:00.000Z', '2026-08-10T09:00:00.000Z', 28800, 0, 'CLOSED', 'COMPLETED')`)
        .bind(shiftId, shiftId, storeId, employeeId).run();
    }
    await db.prepare(`INSERT INTO orders
      (id, code, store_id, employee_id, shift_code, amount, payment_method, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'CASH', 'COMPLETED', '2026-08-10T09:00:00.000Z')`)
      .bind(`${storeId}-order`, `${storeId}-order`, storeId, `${storeId}-employee-1`, `${storeId}-shift-1`,
        storeId === "qa-locked" ? 8_702_041 : 10_000_000).run();
  }
  await db.prepare(`INSERT INTO users (id, username, password_hash, role, name, store_id, employee_id) VALUES
    ('qa-manager', 'qa-manager', ?, 'MANAGER', 'KIỂM THỬ · Quản lý cửa hàng B', 'qa-open', NULL),
    ('qa-employee', 'qa-employee', ?, 'EMPLOYEE', 'KIỂM THỬ · Nhân viên', 'qa-open', 'qa-open-employee-1')`)
    .bind(process.env.DORE_MANAGER_PASSWORD_HASH, process.env.DORE_MANAGER_PASSWORD_HASH).run();

  // Exercise the real login and payroll handlers. No test session is injected
  // into a browser, and the preparation session is revoked when seeding ends.
  const login = await import("../../app/api/auth/login/route.ts");
  const payroll = await import("../../app/api/payroll/route.ts");
  const logout = await import("../../app/api/auth/logout/route.ts");
  const response = await login.POST(new Request("http://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "qa-admin", password }),
  }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const headers = { cookie, "content-type": "application/json" };
  const readPayroll = async () => {
    const result = await payroll.GET(new Request(`http://localhost/api/payroll?storeId=qa-locked&period=${period}`, { headers }));
    assert.equal(result.status, 200);
    return result.json();
  };
  let payrollData = await readPayroll();
  for (const action of ["CONFIRM_PERIOD", "CONFIRM_PAYMENT", "CLOSE_PERIOD"]) {
    const result = await payroll.POST(new Request("http://localhost/api/payroll", {
      method: "POST", headers,
      body: JSON.stringify({ action, storeId: "qa-locked", period, expectedRevision: payrollData.financialPeriod?.revision ?? 0 }),
    }));
    assert.equal(result.status, 200, await result.text());
    payrollData = await readPayroll();
  }
  assert.equal(payrollData.summary.netProfit, 5_000_000);
  const reports = await import("../../app/api/reports/route.ts");
  const reportResponse = await reports.GET(new Request(`http://localhost/api/reports?period=${period}`, { headers }));
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.profitSharingReadiness.status, "PARTIAL");
  assert.equal(report.profitSharingReadiness.expectedStoreCount, 2);
  const distributions = await import("../../app/lib/profit-distributions.ts");
  const distribution = await distributions.readProfitDistributionAvailability(db, period, [{ storeId: "qa-locked", amount: 2_000_000 }]);
  assert.equal(distribution.preview.totalDistributableProfit, 3_000_000);
  assert.deepEqual(distribution.preview.members.map((member) => member.amount), [1_200_000, 1_800_000]);
  await logout.POST(new Request("http://localhost/api/auth/logout", { method: "POST", headers }));
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions").first("count"), 0);

  await writeFile(join(directory, "manager.hash"), process.env.DORE_MANAGER_PASSWORD_HASH, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "credentials.txt"),
    `BẢN KIỂM THỬ RIÊNG · DỮ LIỆU MẪU · KỲ ${period}\n` +
    `Tài khoản: qa-admin / qa-manager / qa-employee\nMật khẩu chung: ${password}\n` +
    "Cửa hàng A: lợi nhuận 5.000.000; nhập setup 2.000.000 → chia 3.000.000 (1.200.000 / 1.800.000).\n" +
    "Cửa hàng B: đang mở, dùng để lưu lương quản lý và thử chốt kỳ.\n",
    { mode: 0o600, flag: "wx" });
  console.log("Preview fixtures verified: isolated database, partial period, 5m − 2m, 40/60 allocation, no active sessions.");
} finally {
  db.close?.();
}
