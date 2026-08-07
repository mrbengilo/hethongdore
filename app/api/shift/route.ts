import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  return json({ active: Boolean(user.shiftActive), shiftCode: user.currentShift, startedAt: user.shiftStartedAt });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as { action?: "start" | "end"; tiktok?: boolean };
  const db = await initDb();

  if (body.action === "start") {
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    if (!user.employeeId || !user.storeId) return json({ message: "Tài khoản chưa được gắn với nhân viên/cửa hàng." }, 409);
    const now = new Date();
    const localDate = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const shiftCode = `CA-${localDate}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const startedAt = now.toISOString();
    await db.batch([
      db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ?").bind(shiftCode, startedAt, user.id),
      db.prepare("INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, started_at, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')")
        .bind(crypto.randomUUID(), shiftCode, user.storeId, user.employeeId, startedAt),
    ]);
    await writeAudit(user.id, "SHIFT_START", "SHIFT", shiftCode);
    return json({ active: true, shiftCode, startedAt });
  }

  if (body.action === "end") {
    if (!user.shiftActive || !user.currentShift) return json({ message: "Bạn chưa bắt đầu ca làm việc." }, 409);
    const endedAt = new Date().toISOString();
    const tiktokAllowance = body.tiktok ? 25000 : 0;
    await db.batch([
      db.prepare("UPDATE users SET shift_active = 0, shift_started_at = NULL WHERE id = ?").bind(user.id),
      db.prepare("UPDATE shift_sessions SET ended_at = ?, tiktok = ?, tiktok_allowance = ?, status = 'COMPLETED' WHERE shift_code = ? AND employee_id = ? AND ended_at IS NULL")
        .bind(endedAt, body.tiktok ? 1 : 0, tiktokAllowance, user.currentShift, user.employeeId),
    ]);
    await writeAudit(user.id, "SHIFT_END", "SHIFT", user.currentShift, body.tiktok ? "TikTok=1" : "TikTok=0");
    return json({ active: false, shiftCode: user.currentShift, endedAt, tiktokAllowance });
  }

  return json({ message: "Thao tác không hợp lệ." }, 400);
}
