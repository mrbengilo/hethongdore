export const ATTENDANCE_POLICY_STATE_KEY = "attendance_late_grace_policy_v1";
export const DEFAULT_ATTENDANCE_GRACE_MINUTES = 15;
export const MIN_ATTENDANCE_GRACE_MINUTES = 0;
export const MAX_ATTENDANCE_GRACE_MINUTES = 120;
export const DEFAULT_ATTENDANCE_EARLY_WINDOW_MINUTES = 120;
export const MIN_ATTENDANCE_EARLY_WINDOW_MINUTES = 0;
export const MAX_ATTENDANCE_EARLY_WINDOW_MINUTES = 720;
export const DEFAULT_MAX_SHIFT_DURATION_MINUTES = 960;
export const MIN_MAX_SHIFT_DURATION_MINUTES = 60;
export const MAX_MAX_SHIFT_DURATION_MINUTES = 2_880;

export type StoredAttendancePolicy = {
  schemaVersion: 1;
  lateGraceMinutes: number;
  earlyClockInWindowMinutes: number;
  maxShiftDurationMinutes: number;
  version: number;
  updatedBy: string | null;
  mutationToken: string | null;
};

type StoredAttendancePolicyInput = Omit<StoredAttendancePolicy,
  "earlyClockInWindowMinutes" | "maxShiftDurationMinutes"> & {
  earlyClockInWindowMinutes?: number;
  maxShiftDurationMinutes?: number;
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

export function isAttendanceEarlyWindowMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && Number(value) >= MIN_ATTENDANCE_EARLY_WINDOW_MINUTES
    && Number(value) <= MAX_ATTENDANCE_EARLY_WINDOW_MINUTES;
}

export function isMaxShiftDurationMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && Number(value) >= MIN_MAX_SHIFT_DURATION_MINUTES
    && Number(value) <= MAX_MAX_SHIFT_DURATION_MINUTES;
}

export function serializeAttendancePolicy(policy: StoredAttendancePolicyInput) {
  return JSON.stringify({
    schemaVersion: 1,
    lateGraceMinutes: policy.lateGraceMinutes,
    earlyClockInWindowMinutes: policy.earlyClockInWindowMinutes ?? DEFAULT_ATTENDANCE_EARLY_WINDOW_MINUTES,
    maxShiftDurationMinutes: policy.maxShiftDurationMinutes ?? DEFAULT_MAX_SHIFT_DURATION_MINUTES,
    version: policy.version,
    updatedBy: policy.updatedBy,
    mutationToken: policy.mutationToken,
  });
}

export function defaultAttendancePolicy(updatedAt = new Date(0).toISOString()): AttendancePolicySnapshot {
  const stored: StoredAttendancePolicy = {
    schemaVersion: 1,
    lateGraceMinutes: DEFAULT_ATTENDANCE_GRACE_MINUTES,
    earlyClockInWindowMinutes: DEFAULT_ATTENDANCE_EARLY_WINDOW_MINUTES,
    maxShiftDurationMinutes: DEFAULT_MAX_SHIFT_DURATION_MINUTES,
    version: 1,
    updatedBy: null,
    mutationToken: null,
  };
  return { ...stored, rawValue: serializeAttendancePolicy(stored), updatedAt };
}

export function parseAttendancePolicy(rawValue: string, updatedAt: string): AttendancePolicySnapshot | null {
  try {
    const value = JSON.parse(rawValue) as Partial<StoredAttendancePolicy>;
    const earlyClockInWindowMinutes = value.earlyClockInWindowMinutes ?? DEFAULT_ATTENDANCE_EARLY_WINDOW_MINUTES;
    const maxShiftDurationMinutes = value.maxShiftDurationMinutes ?? DEFAULT_MAX_SHIFT_DURATION_MINUTES;
    if (value.schemaVersion !== 1
      || !isAttendanceGraceMinutes(value.lateGraceMinutes)
      || !isAttendanceEarlyWindowMinutes(earlyClockInWindowMinutes)
      || !isMaxShiftDurationMinutes(maxShiftDurationMinutes)
      || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || (value.updatedBy !== null && typeof value.updatedBy !== "string")
      || (value.mutationToken !== null && typeof value.mutationToken !== "string")) return null;
    return {
      schemaVersion: 1,
      lateGraceMinutes: value.lateGraceMinutes,
      earlyClockInWindowMinutes,
      maxShiftDurationMinutes,
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
    earlyClockInWindowMinutes: policy.earlyClockInWindowMinutes,
    maxShiftDurationMinutes: policy.maxShiftDurationMinutes,
    version: policy.version,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    updatedByName,
    appliesTo: "NEW_CLOCK_INS_ONLY" as const,
  };
}
