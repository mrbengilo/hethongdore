import { initDb } from "../../../db/runtime";
import {
  ATTENDANCE_EVALUATION_RULES,
  attendanceStatsDateRange,
  buildAttendanceStats,
  type AttendanceEmployeeSeed,
  type AttendanceSnapshot,
  type AttendanceStatsMode,
} from "../../lib/attendance-stats";
import { loadAttendancePolicy } from "../_lib/attendance-policy";
import { getSessionUser, json } from "../_lib/auth";
import { MANAGER_STORE_SCOPE_MESSAGE, resolveManagerStoreScope } from "../_lib/manager-scope";

const MODES = new Set<AttendanceStatsMode>(["day", "week", "month"]);
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function noStoreJson(data: unknown, status = 200) {
  return json(data, status, NO_STORE_HEADERS);
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập." }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được xem thống kê chuyên cần." }, 403);

  const params = new URL(request.url).searchParams;
  const scope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!scope.allowed) return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!scope.storeId) return noStoreJson({ message: "Vui lòng chọn cửa hàng." }, 400);

  const requestedMode = params.get("mode")?.trim() ?? "month";
  const anchor = params.get("anchor")?.trim() ?? "";
  if (!MODES.has(requestedMode as AttendanceStatsMode)) {
    return noStoreJson({ message: "Khoảng thống kê chuyên cần không hợp lệ." }, 400);
  }
  const mode = requestedMode as AttendanceStatsMode;
  let range: { from: string; to: string };
  try {
    range = attendanceStatsDateRange(mode, anchor);
  } catch (error) {
    return noStoreJson({
      message: error instanceof Error ? error.message : "Ngày tham chiếu không hợp lệ.",
    }, 400);
  }

  const db = await initDb();
  const store = await db.prepare(`SELECT id, name FROM stores
    WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1`)
    .bind(scope.storeId).first<{ id: string; name: string }>();
  if (!store) return noStoreJson({ message: "Cửa hàng không tồn tại." }, 404);

  const [policy, employeeResult, snapshotResult] = await Promise.all([
    loadAttendancePolicy(db),
    db.prepare(`SELECT id AS employeeId, code AS employeeCode, name AS employeeName
      FROM employees
      WHERE store_id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
      ORDER BY name, code, id`)
      .bind(store.id).all<AttendanceEmployeeSeed>(),
    db.prepare(`SELECT
        s.employee_id AS employeeId,
        e.code AS employeeCode,
        e.name AS employeeName,
        s.attendance_status AS attendanceStatus,
        s.attendance_delta_minutes AS attendanceDeltaMinutes
      FROM shift_sessions s
      JOIN employees e ON e.id = s.employee_id
        AND e.status != 'ARCHIVED' AND e.deleted_at IS NULL
      WHERE s.store_id = ?
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date <= ?)
          OR (NULLIF(s.work_date, '') IS NULL
            AND date(s.started_at, '+7 hours') >= ?
            AND date(s.started_at, '+7 hours') <= ?)
        )
      ORDER BY COALESCE(NULLIF(s.work_date, ''), date(s.started_at, '+7 hours')), s.started_at, s.id`)
      .bind(store.id, range.from, range.to, range.from, range.to)
      .all<AttendanceSnapshot>(),
  ]);

  // Persisted status/delta fields are the historical evidence. Do not
  // reclassify old attendance when a shift schedule or grace policy changes.
  const rows = buildAttendanceStats(snapshotResult.results, employeeResult.results);
  const totals = rows.reduce((summary, row) => ({
    employees: summary.employees + 1,
    early: summary.early + row.early,
    onTime: summary.onTime + row.onTime,
    late: summary.late + row.late,
    unknown: summary.unknown + row.unknown,
    classifiedCount: summary.classifiedCount + row.classifiedCount,
    totalLateMinutes: summary.totalLateMinutes + row.totalLateMinutes,
  }), { employees: 0, early: 0, onTime: 0, late: 0, unknown: 0, classifiedCount: 0, totalLateMinutes: 0 });

  return noStoreJson({
    store,
    request: { storeId: store.id, mode, anchor },
    filter: { mode, anchor, ...range, timeZone: "Asia/Ho_Chi_Minh" },
    policy: {
      onTimeGraceMinutes: policy.lateGraceMinutes,
      version: policy.version,
      updatedAt: policy.updatedAt,
      classificationSource: "PERSISTED_SNAPSHOT",
      description: "Trạng thái được lấy từ ảnh chụp đã lưu tại thời điểm điểm danh; thay đổi lịch ca sau đó không làm đổi lịch sử.",
    },
    evaluationRules: ATTENDANCE_EVALUATION_RULES,
    totals,
    rows,
  });
}
