import type { initDb } from "../../../db/runtime";
import { sha256 } from "./auth";
import { isStorePeriodLocked, storePeriodUnlockedSql } from "./store-period-lock";
import { attendanceDeltaMinutes, attendanceStatusAt, localDate } from "../../lib/scheduling";

type Database = Awaited<ReturnType<typeof initDb>>;

export type AttendanceAdjustmentSnapshot = {
  id: string;
  storeId: string;
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
  shiftCode: string;
  shiftName: string | null;
  workDate: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  adminAdjustedDurationSeconds: number | null;
  status: "ACTIVE" | "COMPLETED";
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
  attendanceDeltaMinutes: number | null;
  attendanceGraceMinutes: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  period: string;
  locked: number;
};

export type AttendanceTimestampEdit = {
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  status: "ACTIVE" | "COMPLETED";
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
  attendanceDeltaMinutes: number | null;
};

function affectedRows(result: unknown) {
  const row = result as { meta?: { changes?: number }; changes?: number } | undefined;
  return Number(row?.meta?.changes ?? row?.changes ?? 0);
}

function normalizeIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Vui lòng nhập ${label}.`);
  const parsed = new Date(value.trim());
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} không hợp lệ.`);
  return parsed.toISOString();
}

function canonicalPeriod(workDate: string, startedAt: string) {
  const accountingDate = /^\d{4}-\d{2}-\d{2}$/u.test(workDate)
    ? workDate
    : localDate(new Date(startedAt));
  return accountingDate.slice(0, 7);
}

/**
 * The accounting day is immutable, but an overnight occurrence legitimately
 * spans two local dates. Constraining the corrected start to the persisted
 * scheduled occurrence prevents moving pay into an unrelated day while still
 * allowing an after-midnight clock-in for an overnight shift.
 */
function assertSameScheduledOccurrence(previous: AttendanceAdjustmentSnapshot, startedAt: string) {
  const started = new Date(startedAt);
  const scheduledStart = previous.scheduledStartAt ? new Date(previous.scheduledStartAt) : null;
  const scheduledEnd = previous.scheduledEndAt ? new Date(previous.scheduledEndAt) : null;
  if (scheduledStart && scheduledEnd
    && Number.isFinite(scheduledStart.getTime()) && Number.isFinite(scheduledEnd.getTime())) {
    const firstLocalDate = localDate(scheduledStart);
    const lastLocalDate = localDate(scheduledEnd);
    const correctedLocalDate = localDate(started);
    if (correctedLocalDate < firstLocalDate || correctedLocalDate > lastLocalDate
      || started.getTime() > scheduledEnd.getTime()) {
      throw new Error(`Giờ vào ca phải thuộc đúng ngày chấm công ${previous.workDate} hoặc phần qua đêm của chính ca này.`);
    }
    return;
  }
  if (localDate(started) !== previous.workDate) {
    throw new Error(`Giờ vào ca phải thuộc đúng ngày chấm công ${previous.workDate}; không thể chuyển bản ghi sang ngày hoặc kỳ lương khác.`);
  }
}

export function parseAttendanceTimestampEdit(
  body: Record<string, unknown>,
  previous: AttendanceAdjustmentSnapshot,
): AttendanceTimestampEdit {
  const startedAt = normalizeIsoTimestamp(body.startedAt, "giờ vào ca");
  const endedAt = body.endedAt === "" || body.endedAt == null
    ? null
    : normalizeIsoTimestamp(body.endedAt, "giờ kết ca");
  assertSameScheduledOccurrence(previous, startedAt);
  if (previous.status === "ACTIVE" && endedAt) {
    throw new Error("Ca đang làm chỉ được sửa giờ vào; hãy kết ca bằng quy trình kết ca để đối soát đơn hàng và dòng tiền.");
  }
  if (previous.status === "COMPLETED" && !endedAt) {
    throw new Error("Không thể mở lại ca đã hoàn tất. Vui lòng nhập giờ kết ca.");
  }
  const startTime = new Date(startedAt).getTime();
  const endTime = endedAt ? new Date(endedAt).getTime() : null;
  if (endTime !== null && endTime < startTime) throw new Error("Giờ kết ca không được trước giờ vào ca.");
  const durationSeconds = endTime === null ? 0 : Math.round((endTime - startTime) / 1_000);
  const delta = previous.scheduledStartAt
    ? attendanceDeltaMinutes(startedAt, previous.scheduledStartAt)
    : null;
  return {
    startedAt,
    endedAt,
    durationSeconds,
    status: previous.status,
    attendanceStatus: previous.scheduledStartAt
      ? attendanceStatusAt(startedAt, previous.scheduledStartAt, previous.attendanceGraceMinutes)
      : null,
    attendanceDeltaMinutes: delta,
  };
}

export function attendanceAdjustmentVersionState(row: AttendanceAdjustmentSnapshot) {
  return {
    id: row.id,
    storeId: row.storeId,
    employeeId: row.employeeId,
    shiftCode: row.shiftCode,
    workDate: row.workDate,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    adminAdjustedDurationSeconds: row.adminAdjustedDurationSeconds,
    status: row.status,
    attendanceStatus: row.attendanceStatus,
    attendanceDeltaMinutes: row.attendanceDeltaMinutes,
    attendanceGraceMinutes: row.attendanceGraceMinutes,
    scheduledStartAt: row.scheduledStartAt,
    scheduledEndAt: row.scheduledEndAt,
  };
}

export async function attendanceAdjustmentVersionToken(row: AttendanceAdjustmentSnapshot) {
  return sha256(JSON.stringify(attendanceAdjustmentVersionState(row)));
}

export async function loadAttendanceAdjustment(
  db: Database,
  storeId: string,
  id: string,
): Promise<AttendanceAdjustmentSnapshot | null> {
  const accountingDateSql = "COALESCE(NULLIF(s.work_date, ''), date(datetime(s.started_at, '+7 hours')))";
  const periodSql = `substr(${accountingDateSql}, 1, 7)`;
  const unlockedSql = storePeriodUnlockedSql("s.store_id", periodSql);
  const row = await db.prepare(`SELECT
      s.id, s.store_id AS storeId, s.employee_id AS employeeId,
      e.code AS employeeCode, e.name AS employeeName,
      s.shift_code AS shiftCode, s.shift_name AS shiftName,
      ${accountingDateSql} AS workDate,
      s.started_at AS startedAt, s.ended_at AS endedAt,
      s.duration_seconds AS durationSeconds,
      s.admin_adjusted_duration_seconds AS adminAdjustedDurationSeconds,
      s.status, s.attendance_status AS attendanceStatus,
      s.attendance_delta_minutes AS attendanceDeltaMinutes,
      s.attendance_grace_minutes AS attendanceGraceMinutes,
      s.scheduled_start AS scheduledStart, s.scheduled_end AS scheduledEnd,
      s.scheduled_start_at AS scheduledStartAt, s.scheduled_end_at AS scheduledEndAt,
      ${periodSql} AS period,
      CASE WHEN ${unlockedSql} THEN 0 ELSE 1 END AS locked
    FROM shift_sessions s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.id = ? AND s.store_id = ? LIMIT 1`)
    .bind(id, storeId)
    .first<AttendanceAdjustmentSnapshot>();
  return row ?? null;
}

function exactSnapshotGateSql() {
  const accountingDateSql = "COALESCE(NULLIF(s.work_date, ''), date(datetime(s.started_at, '+7 hours')))";
  const periodSql = `substr(${accountingDateSql}, 1, 7)`;
  return `EXISTS (
    SELECT 1 FROM shift_sessions s
    WHERE s.id = ? AND s.store_id = ? AND s.employee_id = ? AND s.shift_code = ?
      AND ${accountingDateSql} = ?
      AND s.started_at = ? AND s.ended_at IS ? AND s.duration_seconds = ?
      AND s.admin_adjusted_duration_seconds IS ? AND s.status = ?
      AND s.attendance_status IS ? AND s.attendance_delta_minutes IS ?
      AND s.attendance_grace_minutes = ?
      AND s.scheduled_start_at IS ? AND s.scheduled_end_at IS ?
      AND ${storePeriodUnlockedSql("s.store_id", periodSql)}
  )`;
}

function exactSnapshotGateBindings(previous: AttendanceAdjustmentSnapshot) {
  return [
    previous.id,
    previous.storeId,
    previous.employeeId,
    previous.shiftCode,
    previous.workDate,
    previous.startedAt,
    previous.endedAt,
    previous.durationSeconds,
    previous.adminAdjustedDurationSeconds,
    previous.status,
    previous.attendanceStatus,
    previous.attendanceDeltaMinutes,
    previous.attendanceGraceMinutes,
    previous.scheduledStartAt,
    previous.scheduledEndAt,
  ];
}

export async function updateAttendanceTimestamps(
  db: Database,
  actorUserId: string,
  previous: AttendanceAdjustmentSnapshot,
  edit: AttendanceTimestampEdit,
  reason: string,
  action = "MANAGER_ATTENDANCE_UPDATE",
) {
  if (previous.locked) throw new Error("Kỳ lương/KPI của chấm công đã khóa; không thể thay đổi dữ liệu.");
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3 || normalizedReason.length > 500) {
    throw new Error("Vui lòng nhập lý do thay đổi từ 3 đến 500 ký tự.");
  }
  const gateSql = exactSnapshotGateSql();
  const gateBindings = exactSnapshotGateBindings(previous);
  const createdAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const after: AttendanceAdjustmentSnapshot = {
    ...previous,
    startedAt: edit.startedAt,
    endedAt: edit.endedAt,
    durationSeconds: edit.durationSeconds,
    adminAdjustedDurationSeconds: null,
    status: edit.status,
    attendanceStatus: edit.attendanceStatus,
    attendanceDeltaMinutes: edit.attendanceDeltaMinutes,
    locked: 0,
  };
  const audit = db.prepare(`INSERT INTO audit_logs
      (id, user_id, action, entity_type, entity_id, detail, created_at,
       before_json, after_json, reason, store_id)
    SELECT ?, ?, ?, 'SHIFT_SESSION', ?, ?, ?, ?, ?, ?, ?
    WHERE ${gateSql}`)
    .bind(
      auditId,
      actorUserId,
      action,
      previous.id,
      `Điều chỉnh chấm công ${previous.employeeCode ?? previous.employeeId} · ${previous.shiftName ?? previous.shiftCode}`,
      createdAt,
      JSON.stringify(previous),
      JSON.stringify(after),
      normalizedReason,
      previous.storeId,
      ...gateBindings,
    );
  const userMutation = edit.status === "ACTIVE"
    ? db.prepare(`UPDATE users SET shift_started_at = ?
        WHERE employee_id = ? AND shift_active = 1 AND current_shift = ? AND ${gateSql}`)
      .bind(edit.startedAt, previous.employeeId, previous.shiftCode, ...gateBindings)
    : db.prepare(`UPDATE users SET shift_started_at = shift_started_at
        WHERE employee_id = ? AND ${gateSql}`)
      .bind(previous.employeeId, ...gateBindings);
  const mutation = db.prepare(`UPDATE shift_sessions SET
      started_at = ?, ended_at = ?, duration_seconds = ?, admin_adjusted_duration_seconds = NULL,
      attendance_status = ?, attendance_delta_minutes = ?
    WHERE id = ? AND store_id = ? AND ${gateSql}`)
    .bind(
      edit.startedAt,
      edit.endedAt,
      edit.durationSeconds,
      edit.attendanceStatus,
      edit.attendanceDeltaMinutes,
      previous.id,
      previous.storeId,
      ...gateBindings,
    );
  const results = await db.batch([audit, userMutation, mutation]);
  if (affectedRows(results[0]) !== 1 || affectedRows(results[2]) !== 1) {
    if (await isStorePeriodLocked(db, previous.storeId, canonicalPeriod(previous.workDate, previous.startedAt))) {
      throw new Error("Kỳ lương/KPI của chấm công đã khóa; không thể thay đổi dữ liệu.");
    }
    throw new Error("Chấm công đã thay đổi bởi một yêu cầu khác. Vui lòng tải lại trước khi thao tác.");
  }
  return { auditId, after };
}
