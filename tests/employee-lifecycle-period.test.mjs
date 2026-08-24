import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-employee-period-state-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [{ initDb }, auth, payrollRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/payroll/route.ts"),
]);

const managerToken = "employee-period-manager";
let db;

function request(path, method = "GET", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `dore_session=${encodeURIComponent(managerToken)}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function preview(period) {
  const response = await payrollRoute.GET(request(`/api/payroll?storeId=st-can-tho&period=${period}`));
  assert.equal(response.status, 200);
  return (await response.json()).summary;
}

before(async () => {
  db = await initDb();
  const expiresAt = Date.now() + 600_000;
  await db.batch([
    db.prepare("UPDATE stores SET created_at = '2026-01-01T00:00:00.000Z', status = 'ACTIVE' WHERE id = 'st-can-tho'"),
    db.prepare("UPDATE users SET is_super_admin = 0 WHERE id = 'user-manager'"),
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('employee-period-session', 'user-manager', ?, ?, ?)")
      .bind(await auth.sha256(managerToken), expiresAt, new Date().toISOString()),
    db.prepare(`INSERT INTO employees
        (id, store_id, code, name, position, phone, province, ward, address_line,
          hourly_rate, tiktok_allowance, status, inactive_at, status_updated_at, lifecycle_version)
      VALUES ('employee-period', 'st-can-tho', 'NVPERIOD', 'Nhân viên theo kỳ', 'Bán hàng',
        '0900000000', 'Cần Thơ', 'Ninh Kiều', 'Đường kiểm thử',
        23000, 0, 'TERMINATED', '2026-07-15T03:00:00.000Z',
        '2026-07-15T03:00:00.000Z', 1)`),
    db.prepare(`INSERT INTO employee_status_history
        (id, employee_id, store_id, from_status, to_status, effective_at,
          actor_user_id, reason, created_at)
      VALUES ('employee-period-terminated', 'employee-period', 'st-can-tho',
        'ACTIVE', 'TERMINATED', '2026-07-15T03:00:00.000Z', 'user-manager',
        'Nghỉ việc trong tháng 7', '2026-07-15T03:00:00.000Z')`),
    ...Array.from({ length: 14 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return db.prepare(`INSERT INTO shift_sessions
          (id, shift_code, store_id, employee_id, shift_name, work_date,
            applied_hourly_rate, applied_tiktok_allowance, started_at, ended_at,
            duration_seconds, expense_amount, cash_revenue, transfer_revenue,
            close_status, status)
        VALUES (?, ?, 'st-can-tho', 'employee-period', 'Ca 1', ?, 23000, 0, ?, ?,
          3600, 0, 500000, 0, 'CONFIRMED', 'COMPLETED')`)
        .bind(
          `employee-period-shift-${day}`,
          `EMPLOYEE-PERIOD-SHIFT-${day}`,
          `2026-07-${day}`,
          `2026-07-${day}T01:00:00.000Z`,
          `2026-07-${day}T02:00:00.000Z`,
        );
    }),
  ]);
});

after(async () => {
  db?.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("termination in July and reactivation in August keep historical payroll and finance point-in-time", async () => {
  const julyBefore = await preview("2026-07");
  const julyEmployeeBefore = julyBefore.items.find((item) => item.employeeId === "employee-period");
  assert.equal(julyEmployeeBefore.employmentStatus, "INACTIVE");
  assert.equal(julyEmployeeBefore.kpiEligible, true);
  assert.equal(julyEmployeeBefore.kpiBonus, 0);
  assert.equal(julyBefore.costBreakdown.employeeKpiBonus, 0);

  await db.batch([
    db.prepare(`UPDATE employees SET status = 'ACTIVE',
        status_updated_at = '2026-08-02T03:00:00.000Z', lifecycle_version = 2
      WHERE id = 'employee-period'`),
    db.prepare(`INSERT INTO employee_status_history
        (id, employee_id, store_id, from_status, to_status, effective_at,
          actor_user_id, reason, created_at)
      VALUES ('employee-period-reactivated', 'employee-period', 'st-can-tho',
        'TERMINATED', 'ACTIVE', '2026-08-02T03:00:00.000Z', 'user-manager',
        'Làm việc trở lại trong tháng 8', '2026-08-02T03:00:00.000Z')`),
  ]);

  const julyAfter = await preview("2026-07");
  const julyEmployeeAfter = julyAfter.items.find((item) => item.employeeId === "employee-period");
  assert.deepEqual({
    employmentStatus: julyEmployeeAfter.employmentStatus,
    kpiEligible: julyEmployeeAfter.kpiEligible,
    kpiBonus: julyEmployeeAfter.kpiBonus,
    financeKpi: julyAfter.costBreakdown.employeeKpiBonus,
  }, {
    employmentStatus: julyEmployeeBefore.employmentStatus,
    kpiEligible: julyEmployeeBefore.kpiEligible,
    kpiBonus: julyEmployeeBefore.kpiBonus,
    financeKpi: julyBefore.costBreakdown.employeeKpiBonus,
  });

  const august = await preview("2026-08");
  const augustEmployee = august.items.find((item) => item.employeeId === "employee-period");
  assert.equal(augustEmployee.employmentStatus, "ACTIVE");

  const closingResponse = await payrollRoute.POST(request("/api/payroll", "POST", {
    storeId: "st-can-tho",
    period: "2026-07",
    action: "FINALIZE_SINGLE_EMPLOYEE",
    employeeId: "employee-period",
  }));
  assert.equal(closingResponse.status, 201);
  const closingBody = await closingResponse.json();
  assert.equal(closingBody.employeeClosing.employeeStatusAtLock, "INACTIVE");

  await db.prepare("UPDATE employees SET status = 'SUSPENDED' WHERE id = 'employee-period'").run();
  const julyWithLockedEmployee = await preview("2026-07");
  const lockedEmployee = julyWithLockedEmployee.items.find((item) => item.employeeId === "employee-period");
  assert.equal(lockedEmployee.employmentStatus, "INACTIVE");
  assert.equal(lockedEmployee.baseSalary, julyEmployeeAfter.baseSalary);
});
