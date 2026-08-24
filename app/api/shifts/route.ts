import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { MANAGER_STORE_SCOPE_MESSAGE, resolveManagerStoreScope } from "../_lib/manager-scope";

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

function nextPeriod(period: string) {
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText ?? "");
  const month = Number(monthText ?? "");
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const params = new URL(request.url).searchParams;
  const requestedStoreId = params.get("storeId");
  const requestedPeriod = params.get("period")?.trim() ?? "";
  if (requestedPeriod && !PERIOD_PATTERN.test(requestedPeriod)) {
    return json({ message: "Kỳ chấm công không hợp lệ." }, 400, {
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
  }
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
  const periodPredicate = `COALESCE(NULLIF(s.work_date, ''), date(s.started_at, '+7 hours')) >= ?
    AND COALESCE(NULLIF(s.work_date, ''), date(s.started_at, '+7 hours')) < ?`;
  const periodStart = requestedPeriod ? `${requestedPeriod}-01` : "";
  const periodEnd = requestedPeriod ? `${nextPeriod(requestedPeriod)}-01` : "";
  let pagination: { page: number; pageSize: number; total: number; pages: number } | null = null;
  let result;
  if (requestedPeriod) {
    const scopePredicate = user.role === "EMPLOYEE"
      ? `s.employee_id = ? AND ${periodPredicate}`
      : storeId ? `s.store_id = ? AND ${periodPredicate}` : periodPredicate;
    const scopeBindings = user.role === "EMPLOYEE"
      ? [user.employeeId, periodStart, periodEnd]
      : storeId ? [storeId, periodStart, periodEnd] : [periodStart, periodEnd];
    // A selected month is intentionally returned by one SQLite statement.
    // Splitting it across HTTP pages would allow a concurrent clock-in or
    // timestamp correction to move rows between offsets, producing a history
    // that is missing or duplicated even though every request succeeds.
    result = await db.prepare(`${select} WHERE ${scopePredicate} ORDER BY s.started_at DESC, s.id DESC`)
      .bind(...scopeBindings).all();
    const total = result.results.length;
    pagination = { page: 1, pageSize: total, total, pages: 1 };
  } else {
    result = user.role === "EMPLOYEE"
      ? await db.prepare(`${select} WHERE s.employee_id = ? ORDER BY s.started_at DESC LIMIT 100`).bind(user.employeeId).all()
      : storeId
        ? await db.prepare(`${select} WHERE s.store_id = ? ORDER BY s.started_at DESC LIMIT 200`).bind(storeId).all()
        : await db.prepare(`${select} ORDER BY s.started_at DESC LIMIT 200`).all();
  }
  // Attendance can contain precise clock-in coordinates. Never allow a
  // shared proxy or the browser HTTP cache to retain this authenticated data.
  return json({ shifts: result.results, period: requestedPeriod || null, storeId, pagination }, 200, {
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
  });
}
