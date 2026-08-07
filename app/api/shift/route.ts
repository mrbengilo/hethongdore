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
  const body = await request.json().catch(() => ({})) as {
    action?: "start" | "end"; tiktok?: boolean; tasksCompleted?: boolean;
    expenseAmount?: number; expenseNote?: string; cashRevenue?: number; transferRevenue?: number;
  };
  const db = await initDb();
  if (body.action === "start") {
    if (!user.storeId || !user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên và cửa hàng." }, 409);
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    const shiftCode = `CA-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const startedAt = new Date().toISOString();
    await db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ?").bind(shiftCode, startedAt, user.id).run();
    await db.prepare("INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, started_at, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')")
      .bind(crypto.randomUUID(), shiftCode, user.storeId, user.employeeId, startedAt).run();
    await writeAudit(user.id, "SHIFT_START", "SHIFT", shiftCode);
    return json({ active: true, shiftCode, startedAt });
  }
  if (body.action === "end") {
    if (!user.shiftActive) return json({ message: "Bạn chưa bắt đầu ca làm việc." }, 409);
    const expenseAmount = Number(body.expenseAmount ?? 0);
    const cashRevenue = Number(body.cashRevenue);
    const transferRevenue = Number(body.transferRevenue);
    if (!body.tasksCompleted) return json({ message: "Bạn phải hoàn thành tất cả công việc trước khi kết ca." }, 400);
    if (![expenseAmount, cashRevenue, transferRevenue].every((value) => Number.isFinite(value) && value >= 0)) return json({ message: "Doanh thu và chi phí phải là số không âm." }, 400);
    if (expenseAmount > 0 && !body.expenseNote?.trim()) return json({ message: "Vui lòng nhập nội dung chi phí phát sinh." }, 400);
    const allowance = body.tiktok ? 25000 : 0;
    await db.batch([
      db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = ?").bind(user.id),
      db.prepare("UPDATE shift_sessions SET ended_at = ?, tiktok = ?, tiktok_allowance = ?, tasks_completed = 1, expense_amount = ?, expense_note = ?, cash_revenue = ?, transfer_revenue = ?, status = 'COMPLETED' WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE'")
        .bind(new Date().toISOString(), body.tiktok ? 1 : 0, allowance, expenseAmount, body.expenseNote?.trim() || null, cashRevenue, transferRevenue, user.currentShift, user.employeeId),
    ]);
    await writeAudit(user.id, "SHIFT_END", "SHIFT", user.currentShift, JSON.stringify({ tiktok: Boolean(body.tiktok), expenseAmount, cashRevenue, transferRevenue }));
    return json({ active: false, tiktokAllowance: allowance, expenseAmount, cashRevenue, transferRevenue, totalRevenue: cashRevenue + transferRevenue });
  }
  return json({ message: "Thao tác không hợp lệ." }, 400);
}
