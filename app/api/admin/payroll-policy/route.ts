import { initDb } from "../../../../db/runtime";
import {
  EMPLOYEE_KPI_THRESHOLDS,
  isSafeKpiRateBasisPoints,
  isSafeManagerSalary,
  MAX_KPI_RATE_BASIS_POINTS,
  MAX_MANAGER_MONTHLY_SALARY_VND,
  MIN_KPI_RATE_BASIS_POINTS,
  MIN_MANAGER_MONTHLY_SALARY_VND,
  normalizeEmployeeKpiTiers,
  payrollPolicyPayload,
  PAYROLL_POLICY_STATE_KEY,
  serializePayrollPolicy,
  validatePayrollPolicyCombination,
} from "../../../lib/payroll-policy";
import { getSessionUser, json as responseJson } from "../../_lib/auth";
import { loadPayrollPolicy } from "../../_lib/payroll-policy";

function json(data: unknown, status = 200) {
  return responseJson(data, status, {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie",
  });
}

function affectedRows(result: unknown) {
  const value = result as { meta?: { changes?: number }; changes?: number } | undefined;
  return Number(value?.meta?.changes ?? value?.changes ?? 0);
}

async function requireSuperAdmin(request: Request) {
  const user = await getSessionUser(request);
  return user?.role === "MANAGER" && Number(user.isSuperAdmin) === 1 ? user : null;
}

async function responseData(db: Awaited<ReturnType<typeof initDb>>) {
  const policy = await loadPayrollPolicy(db);
  const actor = policy.updatedBy
    ? await db.prepare("SELECT name FROM users WHERE id = ? LIMIT 1").bind(policy.updatedBy).first<{ name: string }>()
    : null;
  return {
    policy: payrollPolicyPayload(policy, actor?.name ?? null),
    limits: {
      managerSalary: { min: MIN_MANAGER_MONTHLY_SALARY_VND, max: MAX_MANAGER_MONTHLY_SALARY_VND },
      percent: { min: MIN_KPI_RATE_BASIS_POINTS / 100, max: MAX_KPI_RATE_BASIS_POINTS / 100 },
      employeeProfitPerHourThresholds: EMPLOYEE_KPI_THRESHOLDS,
    },
  };
}

export async function GET(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị viên cấp cao được xem chính sách lương và KPI." }, 403);
  const db = await initDb();
  return json(await responseData(db));
}

export async function PATCH(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị viên cấp cao được thay đổi chính sách lương và KPI." }, 403);
  const body = await request.json().catch(() => ({})) as {
    managerMonthlySalaryVnd?: unknown;
    managerKpiRatePercent?: unknown;
    employeeKpiTiers?: Array<{ minimumProfitPerHour?: unknown; ratePercent?: unknown }>;
    expectedVersion?: unknown;
  };
  const expectedVersion = body.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    return json({ message: "Phiên bản chính sách không hợp lệ. Vui lòng tải lại." }, 400);
  }
  if (!isSafeManagerSalary(body.managerMonthlySalaryVnd)) {
    return json({ message: `Lương quản lý phải là số nguyên từ ${MIN_MANAGER_MONTHLY_SALARY_VND.toLocaleString("vi-VN")} đến ${MAX_MANAGER_MONTHLY_SALARY_VND.toLocaleString("vi-VN")} đồng.` }, 400);
  }
  const managerKpiRateBasisPoints = typeof body.managerKpiRatePercent === "number"
    ? Math.round(body.managerKpiRatePercent * 100)
    : NaN;
  if (!Number.isInteger(body.managerKpiRatePercent)
    && !(typeof body.managerKpiRatePercent === "number" && Number.isFinite(body.managerKpiRatePercent))) {
    return json({ message: "Tỷ lệ KPI quản lý phải là số hợp lệ." }, 400);
  }
  if (Math.abs(managerKpiRateBasisPoints / 100 - Number(body.managerKpiRatePercent)) > 1e-9
    || !isSafeKpiRateBasisPoints(managerKpiRateBasisPoints)) {
    return json({ message: "Tỷ lệ KPI chỉ hỗ trợ tối đa 2 chữ số thập phân, trong khoảng 0% đến 100%." }, 400);
  }
  const employeeKpiTiers = normalizeEmployeeKpiTiers(body.employeeKpiTiers?.map((tier) => ({
    minimumProfitPerHour: tier.minimumProfitPerHour,
    rateBasisPoints: typeof tier.ratePercent === "number" ? Math.round(tier.ratePercent * 100) : NaN,
  })));
  if (!employeeKpiTiers || body.employeeKpiTiers?.some((tier, index) => (
    typeof tier.ratePercent !== "number" || !Number.isFinite(tier.ratePercent)
      || Math.abs(employeeKpiTiers[index].rateBasisPoints / 100 - tier.ratePercent) > 1e-9
  ))) {
    return json({ message: "Các tỷ lệ KPI nhân viên phải từ 0% đến 100%, tối đa 2 chữ số thập phân và không giảm khi đạt ngưỡng cao hơn." }, 400);
  }
  if (!validatePayrollPolicyCombination(managerKpiRateBasisPoints, employeeKpiTiers)) {
    return json({ message: "Tổng tỷ lệ KPI quản lý và mức KPI nhân viên cao nhất không được vượt quá 100%." }, 400);
  }

  const db = await initDb();
  const current = await loadPayrollPolicy(db);
  if (current.version !== Number(expectedVersion)) {
    return json({ ...(await responseData(db)), message: "Chính sách vừa được cập nhật ở một phiên khác. Dữ liệu mới nhất đã được tải lại." }, 409);
  }

  const updatedAt = new Date().toISOString();
  const mutationToken = crypto.randomUUID();
  const next = {
    schemaVersion: 1 as const,
    managerMonthlySalaryVnd: body.managerMonthlySalaryVnd,
    managerKpiRateBasisPoints,
    employeeKpiTiers,
    version: current.version + 1,
    updatedBy: user.id,
    mutationToken,
  };
  const nextValue = serializePayrollPolicy(next);
  const auditId = crypto.randomUUID();
  const detail = JSON.stringify({
    before: {
      managerMonthlySalaryVnd: current.managerMonthlySalaryVnd,
      managerKpiRateBasisPoints: current.managerKpiRateBasisPoints,
      employeeKpiTiers: current.employeeKpiTiers,
      version: current.version,
    },
    after: { ...next, mutationToken: undefined },
    appliesTo: "OPEN_AND_FUTURE_PERIODS_ONLY",
    mutationToken,
  });
  const results = await db.batch([
    db.prepare(`UPDATE system_state SET value = ?, updated_at = ?
      WHERE key = ? AND value = ? AND updated_at = ?`)
      .bind(nextValue, updatedAt, PAYROLL_POLICY_STATE_KEY, current.rawValue, current.updatedAt),
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, 'PAYROLL_POLICY_UPDATE', 'SYSTEM_POLICY', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM system_state WHERE key = ? AND value = ? AND updated_at = ?
      )`)
      .bind(auditId, user.id, PAYROLL_POLICY_STATE_KEY, detail, updatedAt,
        PAYROLL_POLICY_STATE_KEY, nextValue, updatedAt),
  ]);
  if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1) {
    return json({ ...(await responseData(db)), message: "Chính sách vừa được cập nhật ở một phiên khác. Dữ liệu mới nhất đã được tải lại." }, 409);
  }
  return json({ ...(await responseData(db)), message: "Đã lưu chính sách lương và KPI cho toàn bộ cửa hàng." });
}
