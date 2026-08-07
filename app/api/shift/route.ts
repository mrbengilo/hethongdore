import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { endEmployeeShift, ensureActiveShiftRollover, SHIFT_GRACE_MINUTES, startEmployeeShift } from "../_lib/shift-rollover";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  const db = await initDb();
  const state = await ensureActiveShiftRollover(user, db);
  return json({ ...state, graceMinutes: SHIFT_GRACE_MINUTES });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as { action?: "start" | "end"; tiktok?: boolean };
  const db = await initDb();

  if (body.action === "start") {
    if (user.shiftActive) {
      const current = await ensureActiveShiftRollover(user, db);
      return json({ message: "Bạn đã có một ca đang hoạt động.", ...current }, 409);
    }
    try {
      const state = await startEmployeeShift(user, db);
      return json({ ...state, graceMinutes: SHIFT_GRACE_MINUTES });
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "Không thể bắt đầu ca" }, 409);
    }
  }

  if (body.action === "end") {
    try {
      const state = await endEmployeeShift(user, db, Boolean(body.tiktok));
      return json({ ...state, graceMinutes: SHIFT_GRACE_MINUTES });
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "Không thể kết ca" }, 409);
    }
  }

  return json({ message: "Thao tác không hợp lệ." }, 400);
}
