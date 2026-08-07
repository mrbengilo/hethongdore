import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { ensureActiveShiftRollover, reconcileActiveShifts } from "../_lib/shift-rollover";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const storeId = new URL(request.url).searchParams.get("storeId");

  if (user.role === "EMPLOYEE") await ensureActiveShiftRollover(user, db);
  else await reconcileActiveShifts(db, storeId);

  const result = user.role === "EMPLOYEE"
    ? await db.prepare("SELECT s.*, e.code AS employeeCode, e.name AS employeeName, e.hourly_rate AS hourlyRate FROM shift_sessions s JOIN employees e ON e.id = s.employee_id WHERE s.employee_id = ? ORDER BY s.started_at DESC LIMIT 100").bind(user.employeeId).all()
    : storeId
      ? await db.prepare("SELECT s.*, e.code AS employeeCode, e.name AS employeeName, e.hourly_rate AS hourlyRate FROM shift_sessions s JOIN employees e ON e.id = s.employee_id WHERE s.store_id = ? ORDER BY s.started_at DESC LIMIT 200").bind(storeId).all()
      : await db.prepare("SELECT s.*, e.code AS employeeCode, e.name AS employeeName, e.hourly_rate AS hourlyRate FROM shift_sessions s JOIN employees e ON e.id = s.employee_id ORDER BY s.started_at DESC LIMIT 200").all();
  return json({ shifts: result.results });
}
