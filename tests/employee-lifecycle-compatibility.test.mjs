import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";

const execFileAsync = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "dore-employee-lifecycle-compat-"));
const databasePath = join(directory, "dore.sqlite");
const employeePassword = "Legacy-Employee-Secret-2026";
const employeeToken = "legacy-inactive-employee-session";
const managerToken = "legacy-inactive-manager-session";
const inactiveAt = "2026-08-09T08:30:00.123Z";

process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = databasePath;
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const runtimeUrl = pathToFileURL(resolve("db/runtime.ts")).href;
const authUrl = pathToFileURL(resolve("app/api/_lib/auth.ts")).href;
const seedScript = `
  const [{ initDb }, { hashPassword, sha256 }] = await Promise.all([
    import(${JSON.stringify(runtimeUrl)}),
    import(${JSON.stringify(authUrl)}),
  ]);
  const db = await initDb();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(\`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line, age,
          cccd_image_key, cccd_image_name, hourly_rate, tiktok_allowance, status,
          inactive_at, status_updated_at, lifecycle_version, deleted_at)
      VALUES ('legacy-inactive', 'st-can-tho', 'NV-LEGACY', 'Nhân viên cũ', 'Bán hàng',
        '0901234567', 'Cần Thơ', 'Ninh Kiều', 'Địa chỉ cũ', 27,
        'cccd/33333333-3333-4333-8333-333333333333.jpg', 'legacy.jpg', 23000, 27000,
        'INACTIVE', ?, NULL, 0, NULL)\`).bind(${JSON.stringify(inactiveAt)}),
    db.prepare(\`INSERT INTO users
        (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, shift_active)
      VALUES ('legacy-user', 'legacy-inactive', ?, 'EMPLOYEE', 'Nhân viên cũ',
        'legacy-inactive', 'st-can-tho', 0, 0)\`).bind(await hashPassword(${JSON.stringify(employeePassword)})),
    db.prepare(\`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ('legacy-session', 'legacy-user', ?, ?, ?)\`)
      .bind(await sha256(${JSON.stringify(employeeToken)}), Date.now() + 600000, now),
  ]);
  db.close?.();
`;

await execFileAsync(process.execPath, [
  "--require", "./tests/tsx-windows-userinfo.cjs",
  "--import", "tsx",
  "--input-type=module",
  "--eval", seedScript,
], {
  cwd: resolve("."),
  env: { ...process.env },
});

const [{ initDb }, auth, loginRoute, payrollRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/auth/login/route.ts"),
  import("../app/api/payroll/route.ts"),
]);

const db = await initDb();

function request(path, token, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(token ? { cookie: `dore_session=${encodeURIComponent(token)}` } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("runtime init preserves legacy INACTIVE bytes and blocks employee login and payroll access", async () => {
  const row = await db.prepare(`SELECT status, hex(status) AS statusBytes,
      inactive_at AS inactiveAt, status_updated_at AS statusUpdatedAt,
      COALESCE(lifecycle_version, 0) AS lifecycleVersion, deleted_at AS deletedAt
    FROM employees WHERE id = 'legacy-inactive'`).first();
  assert.deepEqual({ ...row }, {
    status: "INACTIVE",
    statusBytes: Buffer.from("INACTIVE").toString("hex").toUpperCase(),
    inactiveAt,
    statusUpdatedAt: null,
    lifecycleVersion: 0,
    deletedAt: null,
  });

  const login = await loginRoute.POST(request("/api/auth/login", null, "POST", {
    username: "legacy-inactive",
    password: employeePassword,
  }));
  assert.equal(login.status, 403);
  assert.match((await login.json()).message, /đã nghỉ việc/iu);

  const employeePayroll = await payrollRoute.GET(request("/api/payroll?period=2026-08", employeeToken));
  assert.equal(employeePayroll.status, 401);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'legacy-session'").first("count"), 0);

  const expiry = Date.now() + 600_000;
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ('legacy-manager-session', 'user-manager', ?, ?, ?)`)
    .bind(await auth.sha256(managerToken), expiry, new Date().toISOString()).run();
  const managerPayroll = await payrollRoute.GET(request(
    "/api/payroll?storeId=st-can-tho&period=2026-08",
    managerToken,
  ));
  assert.equal(managerPayroll.status, 200);
  const payrollBody = await managerPayroll.json();
  const legacyItem = payrollBody.summary.items.find((item) => item.employeeId === "legacy-inactive");
  assert.equal(legacyItem.employmentStatus, "INACTIVE");
  assert.equal(legacyItem.kpiEligible, false);
  assert.equal(await db.prepare("SELECT status FROM employees WHERE id = 'legacy-inactive'").first("status"), "INACTIVE");
});
