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
    const shiftCode = `CA-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const startedAt = new Date().toISOString();
    await db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ?").bind(shiftCode, startedAt, user.id).run();
    await writeAudit(user.id, "SHIFT_START", "SHIFT", shiftCode);
    return json({ active: true, shiftCode, startedAt });
  }
  if (body.action === "end") {
    if (!user.shiftActive) return json({ message: "Bạn chưa bắt đầu ca làm việc." }, 409);
    await db.prepare("UPDATE users SET shift_active = 0 WHERE id = ?").bind(user.id).run();
    await writeAudit(user.id, "SHIFT_END", "SHIFT", user.currentShift, body.tiktok ? "TikTok=1" : "TikTok=0");
    return json({ active: false, tiktokAllowance: body.tiktok ? 25000 : 0 });
  }
  return json({ message: "Thao tác không hợp lệ." }, 400);
}

