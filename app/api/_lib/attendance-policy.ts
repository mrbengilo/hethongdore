import {
  ATTENDANCE_POLICY_STATE_KEY,
  parseAttendancePolicy,
  type AttendancePolicySnapshot,
} from "../../lib/attendance-policy";

type PolicyDatabase = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
};

export async function loadAttendancePolicy(db: PolicyDatabase): Promise<AttendancePolicySnapshot> {
  const row = await db.prepare("SELECT value, updated_at AS updatedAt FROM system_state WHERE key = ? LIMIT 1")
    .bind(ATTENDANCE_POLICY_STATE_KEY).first<{ value: string; updatedAt: string }>();
  const policy = row ? parseAttendancePolicy(row.value, row.updatedAt) : null;
  if (!policy) throw new Error("Chính sách thời gian đi trễ chưa hợp lệ. Vui lòng liên hệ quản trị cấp cao.");
  return policy;
}
