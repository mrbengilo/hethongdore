import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const storeId = new URL(request.url).searchParams.get("storeId");
  const select = `SELECT s.*,
    s.shift_name AS shiftName,
    s.scheduled_start AS scheduledStart,
    s.scheduled_end AS scheduledEnd,
    COALESCE(s.work_date, date(s.started_at, '+7 hours')) AS workDate,
    COALESCE(s.applied_hourly_rate, e.hourly_rate) AS appliedHourlyRate,
    e.code AS employeeCode,
    e.name AS employeeName,
    e.hourly_rate AS hourlyRate
    FROM shift_sessions s
    JOIN employees e ON e.id = s.employee_id`;
  const result = user.role === "EMPLOYEE"
    ? await db.prepare(`${select} WHERE s.employee_id = ? ORDER BY s.started_at DESC LIMIT 100`).bind(user.employeeId).all()
    : storeId
      ? await db.prepare(`${select} WHERE s.store_id = ? ORDER BY s.started_at DESC LIMIT 200`).bind(storeId).all()
      : await db.prepare(`${select} ORDER BY s.started_at DESC LIMIT 200`).all();
  return json({ shifts: result.results });
}
