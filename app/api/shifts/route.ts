import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { MANAGER_STORE_SCOPE_MESSAGE, resolveManagerStoreScope } from "../_lib/manager-scope";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const requestedStoreId = new URL(request.url).searchParams.get("storeId");
  const managerScope = user.role === "MANAGER" ? resolveManagerStoreScope(user, requestedStoreId) : null;
  if (managerScope && !managerScope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = user.role === "MANAGER" ? managerScope?.storeId ?? null : requestedStoreId;
  const select = `SELECT s.*,
    s.shift_name AS shiftName,
    s.scheduled_start AS scheduledStart,
    s.scheduled_end AS scheduledEnd,
    s.clock_in_latitude AS clockInLatitude,
    s.clock_in_longitude AS clockInLongitude,
    s.clock_in_accuracy_meters AS clockInAccuracyMeters,
    s.clock_in_location_captured_at AS clockInLocationCapturedAt,
    s.admin_adjusted_duration_seconds AS adminAdjustedDurationSeconds,
    COALESCE(s.work_date, date(s.started_at, '+7 hours')) AS workDate,
    COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
    e.code AS employeeCode,
    e.name AS employeeName,
    e.hourly_rate AS hourlyRate,
    t.support_allowance AS supportAllowance,
    source.name AS sourceStoreName,
    target.name AS targetStoreName
    FROM shift_sessions s
    JOIN employees e ON e.id = s.employee_id
    LEFT JOIN employee_transfers t ON t.id = s.transfer_id
    LEFT JOIN stores source ON source.id = t.source_store_id
    LEFT JOIN stores target ON target.id = t.target_store_id`;
  const result = user.role === "EMPLOYEE"
    ? await db.prepare(`${select} WHERE s.employee_id = ? ORDER BY s.started_at DESC LIMIT 100`).bind(user.employeeId).all()
    : storeId
      ? await db.prepare(`${select} WHERE s.store_id = ? ORDER BY s.started_at DESC LIMIT 200`).bind(storeId).all()
      : await db.prepare(`${select} ORDER BY s.started_at DESC LIMIT 200`).all();
  // Attendance can contain precise clock-in coordinates. Never allow a
  // shared proxy or the browser HTTP cache to retain this authenticated data.
  return json({ shifts: result.results }, 200, {
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
  });
}
