export const ATTENDANCE_POLICY_STATE_KEY = "attendance_late_grace_policy_v1";
export const DEFAULT_ATTENDANCE_GRACE_MINUTES = 15;
export const MIN_ATTENDANCE_GRACE_MINUTES = 0;
export const MAX_ATTENDANCE_GRACE_MINUTES = 120;

export type StoredAttendancePolicy = {
  schemaVersion: 1;
  lateGraceMinutes: number;
  version: number;
  updatedBy: string | null;
  mutationToken: string | null;
};

export type AttendancePolicySnapshot = StoredAttendancePolicy & {
  rawValue: string;
  updatedAt: string;
};

export function isAttendanceGraceMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && Number(value) >= MIN_ATTENDANCE_GRACE_MINUTES
    && Number(value) <= MAX_ATTENDANCE_GRACE_MINUTES;
}

export function serializeAttendancePolicy(policy: StoredAttendancePolicy) {
  return JSON.stringify({
    schemaVersion: 1,
    lateGraceMinutes: policy.lateGraceMinutes,
    version: policy.version,
    updatedBy: policy.updatedBy,
    mutationToken: policy.mutationToken,
  });
}

export function defaultAttendancePolicy(updatedAt = new Date(0).toISOString()): AttendancePolicySnapshot {
  const stored: StoredAttendancePolicy = {
    schemaVersion: 1,
    lateGraceMinutes: DEFAULT_ATTENDANCE_GRACE_MINUTES,
    version: 1,
    updatedBy: null,
    mutationToken: null,
  };
  return { ...stored, rawValue: serializeAttendancePolicy(stored), updatedAt };
}

export function parseAttendancePolicy(rawValue: string, updatedAt: string): AttendancePolicySnapshot | null {
  try {
    const value = JSON.parse(rawValue) as Partial<StoredAttendancePolicy>;
    if (value.schemaVersion !== 1
      || !isAttendanceGraceMinutes(value.lateGraceMinutes)
      || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || (value.updatedBy !== null && typeof value.updatedBy !== "string")
      || (value.mutationToken !== null && typeof value.mutationToken !== "string")) return null;
    return {
      schemaVersion: 1,
      lateGraceMinutes: value.lateGraceMinutes,
      version: Number(value.version),
      updatedBy: value.updatedBy,
      mutationToken: value.mutationToken,
      rawValue,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function attendancePolicyPayload(policy: AttendancePolicySnapshot, updatedByName: string | null = null) {
  return {
    lateGraceMinutes: policy.lateGraceMinutes,
    version: policy.version,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    updatedByName,
    appliesTo: "NEW_CLOCK_INS_ONLY" as const,
  };
}
