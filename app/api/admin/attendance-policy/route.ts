import { initDb } from "../../../../db/runtime";
import {
  ATTENDANCE_POLICY_STATE_KEY,
  attendancePolicyPayload,
  isAttendanceEarlyWindowMinutes,
  isAttendanceGraceMinutes,
  isMaxShiftDurationMinutes,
  MAX_ATTENDANCE_EARLY_WINDOW_MINUTES,
  MAX_ATTENDANCE_GRACE_MINUTES,
  MAX_MAX_SHIFT_DURATION_MINUTES,
  MIN_ATTENDANCE_EARLY_WINDOW_MINUTES,
  MIN_ATTENDANCE_GRACE_MINUTES,
  MIN_MAX_SHIFT_DURATION_MINUTES,
  serializeAttendancePolicy,
} from "../../../lib/attendance-policy";
import { getSessionUser, json as responseJson } from "../../_lib/auth";
import { loadAttendancePolicy } from "../../_lib/attendance-policy";

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
  const policy = await loadAttendancePolicy(db);
  const actor = policy.updatedBy
    ? await db.prepare("SELECT name FROM users WHERE id = ? LIMIT 1").bind(policy.updatedBy).first<{ name: string }>()
    : null;
  return {
    policy: attendancePolicyPayload(policy, actor?.name ?? null),
    limits: { min: MIN_ATTENDANCE_GRACE_MINUTES, max: MAX_ATTENDANCE_GRACE_MINUTES },
    earlyWindowLimits: { min: MIN_ATTENDANCE_EARLY_WINDOW_MINUTES, max: MAX_ATTENDANCE_EARLY_WINDOW_MINUTES },
    maxShiftDurationLimits: { min: MIN_MAX_SHIFT_DURATION_MINUTES, max: MAX_MAX_SHIFT_DURATION_MINUTES },
    rule: "LATE_WHEN_GREATER_THAN_GRACE" as const,
  };
}

export async function GET(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị viên cấp cao được xem chính sách hệ thống." }, 403);
  const db = await initDb();
  return json(await responseData(db));
}

export async function PATCH(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị viên cấp cao được thay đổi chính sách hệ thống." }, 403);
  const body = await request.json().catch(() => ({})) as {
    lateGraceMinutes?: unknown;
    earlyClockInWindowMinutes?: unknown;
    maxShiftDurationMinutes?: unknown;
    expectedVersion?: unknown;
  };
  const lateGraceMinutes = body.lateGraceMinutes;
  const earlyClockInWindowMinutes = body.earlyClockInWindowMinutes;
  const maxShiftDurationMinutes = body.maxShiftDurationMinutes;
  const expectedVersion = body.expectedVersion;
  if (typeof lateGraceMinutes !== "number" || !isAttendanceGraceMinutes(lateGraceMinutes)) {
    return json({ message: `Thời gian đi trễ phải là số phút nguyên từ ${MIN_ATTENDANCE_GRACE_MINUTES} đến ${MAX_ATTENDANCE_GRACE_MINUTES}.` }, 400);
  }
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return json({ message: "Phiên bản chính sách không hợp lệ. Vui lòng tải lại." }, 400);
  }

  const db = await initDb();
  const current = await loadAttendancePolicy(db);
  if (current.version !== expectedVersion) {
    return json({ ...(await responseData(db)), message: "Chính sách vừa được cập nhật bởi một yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  const nextEarlyWindow = earlyClockInWindowMinutes === undefined
    ? current.earlyClockInWindowMinutes
    : earlyClockInWindowMinutes;
  const nextMaxShiftDuration = maxShiftDurationMinutes === undefined
    ? current.maxShiftDurationMinutes
    : maxShiftDurationMinutes;
  if (typeof nextEarlyWindow !== "number" || !isAttendanceEarlyWindowMinutes(nextEarlyWindow)) {
    return json({ message: `Thời gian điểm danh sớm phải là số phút nguyên từ ${MIN_ATTENDANCE_EARLY_WINDOW_MINUTES} đến ${MAX_ATTENDANCE_EARLY_WINDOW_MINUTES}.` }, 400);
  }
  if (typeof nextMaxShiftDuration !== "number" || !isMaxShiftDurationMinutes(nextMaxShiftDuration)) {
    return json({ message: `Giới hạn ca cần đối soát phải là số phút nguyên từ ${MIN_MAX_SHIFT_DURATION_MINUTES} đến ${MAX_MAX_SHIFT_DURATION_MINUTES}.` }, 400);
  }

  const updatedAt = new Date().toISOString();
  const mutationToken = crypto.randomUUID();
  const nextValue = serializeAttendancePolicy({
    schemaVersion: 1,
    lateGraceMinutes,
    earlyClockInWindowMinutes: nextEarlyWindow,
    maxShiftDurationMinutes: nextMaxShiftDuration,
    version: current.version + 1,
    updatedBy: user.id,
    mutationToken,
  });
  const auditId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`UPDATE system_state SET value = ?, updated_at = ?
      WHERE key = ? AND value = ? AND updated_at = ?`)
      .bind(nextValue, updatedAt, ATTENDANCE_POLICY_STATE_KEY, current.rawValue, current.updatedAt),
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, 'ATTENDANCE_POLICY_UPDATE', 'SYSTEM_POLICY', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM system_state WHERE key = ? AND value = ? AND updated_at = ?
      )`)
      .bind(
        auditId, user.id, ATTENDANCE_POLICY_STATE_KEY,
        JSON.stringify({
          before: {
            lateGraceMinutes: current.lateGraceMinutes,
            earlyClockInWindowMinutes: current.earlyClockInWindowMinutes,
            maxShiftDurationMinutes: current.maxShiftDurationMinutes,
            version: current.version,
          },
          after: {
            lateGraceMinutes,
            earlyClockInWindowMinutes: nextEarlyWindow,
            maxShiftDurationMinutes: nextMaxShiftDuration,
            version: current.version + 1,
          },
          appliesTo: "NEW_CLOCK_INS_ONLY",
          mutationToken,
        }),
        updatedAt, ATTENDANCE_POLICY_STATE_KEY, nextValue, updatedAt,
      ),
  ]);
  if (affectedRows(results[0]) !== 1 || affectedRows(results[1]) !== 1) {
    return json({ ...(await responseData(db)), message: "Chính sách vừa được cập nhật bởi một yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  return json({ ...(await responseData(db)), message: `Đã lưu thời gian đi trễ ${lateGraceMinutes} phút.` });
}
