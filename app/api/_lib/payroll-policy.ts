import type { initDb } from "../../../db/runtime";
import {
  defaultPayrollPolicy,
  parsePayrollPolicy,
  PAYROLL_POLICY_STATE_KEY,
} from "../../lib/payroll-policy";

type Db = Awaited<ReturnType<typeof initDb>>;

export async function loadPayrollPolicy(db: Db) {
  const row = await db.prepare("SELECT value, updated_at AS updatedAt FROM system_state WHERE key = ? LIMIT 1")
    .bind(PAYROLL_POLICY_STATE_KEY).first<{ value: string; updatedAt: string }>();
  if (!row) return defaultPayrollPolicy();
  const policy = parsePayrollPolicy(row.value, row.updatedAt);
  if (!policy) throw new Error("Chính sách lương và KPI chưa hợp lệ. Vui lòng liên hệ quản trị cấp cao.");
  return policy;
}
