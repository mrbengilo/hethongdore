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
import { isVnd, localPeriod } from "../../../lib/finance";
import { getSessionUser, json as responseJson } from "../../_lib/auth";
import {
  financialPolicyFromPayrollSnapshot,
  financialPolicyTikTokAllowanceVnd,
  loadFinancialPolicyForPeriod,
  normalizeProfitSharingMembers,
  serializeFinancialPolicy,
  TIKTOK_ALLOWANCE_POLICY_KEY,
} from "../../_lib/financial-policy";
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
  const financialPolicyVersion = await loadFinancialPolicyForPeriod(db, localPeriod());
  const actor = policy.updatedBy
    ? await db.prepare("SELECT name FROM users WHERE id = ? LIMIT 1").bind(policy.updatedBy).first<{ name: string }>()
    : null;
  return {
    policy: {
      ...payrollPolicyPayload(policy, actor?.name ?? null),
      employeeTikTokAllowanceVnd: financialPolicyTikTokAllowanceVnd(financialPolicyVersion.policy),
      profitSharingMembers: financialPolicyVersion.policy.profitSharingMembers.map((member) => ({
        memberId: member.memberId,
        name: member.name,
        ratePercent: member.rateBasisPoints / 100,
      })),
      financialPolicyVersion: financialPolicyVersion.version,
    },
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
    employeeTikTokAllowanceVnd?: unknown;
    employeeKpiTiers?: Array<{ minimumProfitPerHour?: unknown; ratePercent?: unknown }>;
    profitSharingMembers?: Array<{ memberId?: unknown; name?: unknown; ratePercent?: unknown }>;
    expectedVersion?: unknown;
  };
  const expectedVersion = body.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    return json({ message: "Phiên bản chính sách không hợp lệ. Vui lòng tải lại." }, 400);
  }
  if (!isSafeManagerSalary(body.managerMonthlySalaryVnd)) {
    return json({ message: `Lương quản lý phải là số nguyên từ ${MIN_MANAGER_MONTHLY_SALARY_VND.toLocaleString("vi-VN")} đến ${MAX_MANAGER_MONTHLY_SALARY_VND.toLocaleString("vi-VN")} đồng.` }, 400);
  }
  if (body.employeeTikTokAllowanceVnd !== undefined && !isVnd(body.employeeTikTokAllowanceVnd)) {
    return json({ message: "Phụ cấp TikTok mặc định phải là số nguyên VND từ 0 đồng trở lên." }, 400);
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
  const rawProfitSharingMembers = body.profitSharingMembers?.map((member) => ({
    memberId: member.memberId,
    name: member.name,
    rateBasisPoints: typeof member.ratePercent === "number" ? Math.round(member.ratePercent * 100) : NaN,
  }));
  const profitSharingMembers = rawProfitSharingMembers === undefined
    ? undefined
    : normalizeProfitSharingMembers(rawProfitSharingMembers);
  if (rawProfitSharingMembers !== undefined && !profitSharingMembers) {
    return json({ message: "Danh sách người nhận chia lợi nhuận không hợp lệ; mã phải duy nhất và tổng tỷ lệ phải đúng 100%." }, 400);
  }
  if (profitSharingMembers && body.profitSharingMembers?.some((member, index) => (
    typeof member.ratePercent !== "number" || !Number.isFinite(member.ratePercent)
      || Math.abs(profitSharingMembers[index].rateBasisPoints / 100 - member.ratePercent) > 1e-9
  ))) {
    return json({ message: "Tỷ lệ chia lợi nhuận chỉ hỗ trợ tối đa 2 chữ số thập phân." }, 400);
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
  const effectiveFromPeriod = localPeriod();
  const currentFinancialPolicyVersion = await loadFinancialPolicyForPeriod(db, effectiveFromPeriod, {
    createdBy: user.id,
    now: updatedAt,
  });
  const currentTikTokAllowanceVnd = financialPolicyTikTokAllowanceVnd(currentFinancialPolicyVersion.policy);
  const nextTikTokAllowanceVnd = body.employeeTikTokAllowanceVnd === undefined
    ? currentTikTokAllowanceVnd
    : Number(body.employeeTikTokAllowanceVnd);
  const financialVersionRow = await db.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 AS nextVersion FROM financial_policy_versions",
  ).first<{ nextVersion: number }>();
  const financialVersion = Number(financialVersionRow?.nextVersion);
  if (!Number.isSafeInteger(financialVersion) || financialVersion < 1) {
    throw new RangeError("Phiên bản chính sách tài chính tiếp theo không hợp lệ.");
  }
  const nextSnapshot = {
    ...next,
    rawValue: nextValue,
    updatedAt,
  };
  const nextFinancialPolicy = financialPolicyFromPayrollSnapshot(nextSnapshot, {
    allowances: nextTikTokAllowanceVnd === null
      ? currentFinancialPolicyVersion.policy.allowances
      : {
        ...currentFinancialPolicyVersion.policy.allowances,
        [TIKTOK_ALLOWANCE_POLICY_KEY]: { amountVnd: nextTikTokAllowanceVnd },
      },
    profitSharingMembers: profitSharingMembers ?? currentFinancialPolicyVersion.policy.profitSharingMembers,
  });
  const nextFinancialPolicyJson = serializeFinancialPolicy(nextFinancialPolicy);
  const financialPolicyVersionId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const before = {
    managerMonthlySalaryVnd: current.managerMonthlySalaryVnd,
    managerKpiRateBasisPoints: current.managerKpiRateBasisPoints,
    employeeKpiTiers: current.employeeKpiTiers,
    employeeTikTokAllowanceVnd: currentTikTokAllowanceVnd,
    profitSharingMembers: currentFinancialPolicyVersion.policy.profitSharingMembers,
    payrollPolicyVersion: current.version,
    financialPolicyVersion: currentFinancialPolicyVersion.version,
    financialPolicyVersionId: currentFinancialPolicyVersion.id,
  };
  const after = {
    ...next,
    mutationToken: undefined,
    payrollPolicyVersion: next.version,
    financialPolicyVersion: financialVersion,
    financialPolicyVersionId,
    effectiveFromPeriod,
    employeeTikTokAllowanceVnd: nextTikTokAllowanceVnd,
    profitSharingMembers: nextFinancialPolicy.profitSharingMembers,
  };
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  const detail = JSON.stringify({
    before,
    after,
    appliesTo: "OPEN_AND_FUTURE_PERIODS_ONLY",
    effectiveFromPeriod,
    mutationToken,
  });
  let results: unknown[];
  try {
    results = await db.batch([
      db.prepare(`UPDATE system_state SET value = ?, updated_at = ?
        WHERE key = ? AND value = ? AND updated_at = ?`)
        .bind(nextValue, updatedAt, PAYROLL_POLICY_STATE_KEY, current.rawValue, current.updatedAt),
      db.prepare(`INSERT INTO financial_policy_versions
          (id, version, effective_from_period, policy_json, created_by, created_at, superseded_at)
        SELECT ?, ?, ?, ?, ?, ?, NULL
        WHERE EXISTS (
          SELECT 1 FROM system_state WHERE key = ? AND value = ? AND updated_at = ?
        )`)
        .bind(financialPolicyVersionId, financialVersion, effectiveFromPeriod, nextFinancialPolicyJson,
          user.id, updatedAt, PAYROLL_POLICY_STATE_KEY, nextValue, updatedAt),
      db.prepare(`UPDATE financial_policy_versions SET superseded_at = ?
        WHERE id = ? AND superseded_at IS NULL
          AND EXISTS (
            SELECT 1 FROM financial_policy_versions WHERE id = ? AND version = ?
          )`)
        .bind(updatedAt, currentFinancialPolicyVersion.id, financialPolicyVersionId, financialVersion),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, action, entity_type, entity_id, detail, created_at,
           before_json, after_json, reason, store_id)
        SELECT ?, ?, 'PAYROLL_POLICY_UPDATE', 'SYSTEM_POLICY', ?, ?, ?, ?, ?,
               'GLOBAL_POLICY_UPDATE', NULL
        WHERE EXISTS (
          SELECT 1 FROM financial_policy_versions WHERE id = ? AND version = ?
        )`)
        .bind(auditId, user.id, PAYROLL_POLICY_STATE_KEY, detail, updatedAt,
          beforeJson, afterJson, financialPolicyVersionId, financialVersion),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: financial_policy_versions\.version/u.test(message)) {
      return json({ ...(await responseData(db)), message: "Chính sách vừa được cập nhật ở một phiên khác. Dữ liệu mới nhất đã được tải lại." }, 409);
    }
    throw error;
  }
  if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1 || affectedRows(results[3]) !== 1) {
    return json({ ...(await responseData(db)), message: "Chính sách vừa được cập nhật ở một phiên khác. Dữ liệu mới nhất đã được tải lại." }, 409);
  }
  return json({ ...(await responseData(db)), message: "Đã lưu chính sách lương và KPI cho toàn bộ cửa hàng." });
}
