import { initDb } from "../../../db/runtime";
import {
  ATTENDANCE_EVALUATION_RULES,
  attendanceStatsDateRange,
  buildAttendanceStats,
  type AttendanceEmployeeSeed,
  type AttendanceSnapshot,
} from "../../lib/attendance-stats";
import { loadAttendancePolicy } from "../_lib/attendance-policy";
import { getSessionUser, json } from "../_lib/auth";

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function noStoreJson(data: unknown, status = 200) {
  return json(data, status, NO_STORE_HEADERS);
}

function effectiveRange(period: string, through: string) {
  if (!PERIOD_PATTERN.test(period)) throw new Error("Kỳ thống kê không hợp lệ.");
  const month = attendanceStatsDateRange("month", `${period}-01`);
  if (!through) return month;
  const day = attendanceStatsDateRange("day", through);
  if (day.from < month.from || day.to > month.to) {
    throw new Error("Ngày kết thúc phải thuộc kỳ thống kê đã chọn.");
  }
  return { from: month.from, to: day.to };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập." }, 401);
  if (user.role !== "EMPLOYEE" || !user.employeeId) {
    return noStoreJson({ message: "Chỉ nhân viên được xem thống kê chuyên cần của chính mình." }, 403);
  }

  const params = new URL(request.url).searchParams;
  // The employee identity always comes from the authenticated session. Never
  // accept an employee/store selector on this self-service endpoint.
  if (params.has("employeeId") || params.has("storeId")) {
    return noStoreJson({ message: "Không được chọn nhân viên hoặc cửa hàng khác." }, 400);
  }
  const period = params.get("period")?.trim() ?? "";
  const through = params.get("through")?.trim() ?? "";
  let range: { from: string; to: string };
  try {
    range = effectiveRange(period, through);
  } catch (error) {
    return noStoreJson({
      message: error instanceof Error ? error.message : "Thời gian thống kê không hợp lệ.",
    }, 400);
  }

  const db = await initDb();
  const [policy, employee, snapshots] = await Promise.all([
    loadAttendancePolicy(db),
    db.prepare(`SELECT id AS employeeId, code AS employeeCode, name AS employeeName
      FROM employees
      WHERE id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
      LIMIT 1`)
      .bind(user.employeeId).first<AttendanceEmployeeSeed>(),
    db.prepare(`SELECT
        s.employee_id AS employeeId,
        e.code AS employeeCode,
        e.name AS employeeName,
        s.attendance_status AS attendanceStatus,
        s.attendance_delta_minutes AS attendanceDeltaMinutes
      FROM shift_sessions s
      JOIN employees e ON e.id = s.employee_id
        AND e.status != 'ARCHIVED' AND e.deleted_at IS NULL
      WHERE s.employee_id = ?
        AND (
          (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date <= ?)
          OR (NULLIF(s.work_date, '') IS NULL
            AND date(s.started_at, '+7 hours') >= ?
            AND date(s.started_at, '+7 hours') <= ?)
        )
      ORDER BY COALESCE(NULLIF(s.work_date, ''), date(s.started_at, '+7 hours')), s.started_at, s.id`)
      .bind(user.employeeId, range.from, range.to, range.from, range.to)
      .all<AttendanceSnapshot>(),
  ]);
  if (!employee) return noStoreJson({ message: "Không tìm thấy hồ sơ nhân viên đang đăng nhập." }, 404);

  // Persisted status/delta fields are the point-in-time evidence. Support
  // shifts at another store still belong to this employee's own attendance.
  const row = buildAttendanceStats(snapshots.results, [employee])[0];
  return noStoreJson({
    request: { period, through: through || range.to },
    filter: { ...range, timeZone: "Asia/Ho_Chi_Minh" },
    scope: {
      kind: "EMPLOYEE_SELF",
      employeeId: employee.employeeId,
      employeeCode: employee.employeeCode?.trim() || "CHƯA CÓ MÃ",
      employeeName: employee.employeeName?.trim() || user.name,
    },
    policy: {
      onTimeGraceMinutes: policy.lateGraceMinutes,
      version: policy.version,
      updatedAt: policy.updatedAt,
      classificationSource: "PERSISTED_SNAPSHOT",
      description: "Trạng thái lấy từ ảnh chụp đã lưu tại lúc điểm danh; thay đổi lịch ca hoặc chính sách sau đó không làm đổi lịch sử.",
    },
    evaluationRules: ATTENDANCE_EVALUATION_RULES,
    row,
  });
}
