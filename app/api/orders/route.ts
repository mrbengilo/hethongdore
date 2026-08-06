import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  let result;
  if (user.role === "MANAGER") {
    const storeId = new URL(request.url).searchParams.get("storeId");
    result = storeId
      ? await db.prepare("SELECT o.*, e.name AS employeeName FROM orders o JOIN employees e ON e.id = o.employee_id WHERE o.store_id = ? ORDER BY o.created_at DESC LIMIT 100").bind(storeId).all()
      : await db.prepare("SELECT o.*, e.name AS employeeName FROM orders o JOIN employees e ON e.id = o.employee_id ORDER BY o.created_at DESC LIMIT 100").all();
  } else if (user.shiftActive && user.currentShift) {
    result = await db.prepare("SELECT o.*, e.name AS employeeName FROM orders o JOIN employees e ON e.id = o.employee_id WHERE o.store_id = ? AND o.employee_id = ? AND o.shift_code = ? ORDER BY o.created_at DESC")
      .bind(user.storeId, user.employeeId, user.currentShift).all();
  } else {
    return json({ orders: [], active: false, message: "Bạn chưa bắt đầu ca làm việc" });
  }
  return json({ orders: result.results, active: Boolean(user.shiftActive) });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Chỉ nhân viên mới tạo đơn trong ca." }, 403);
  if (!user.shiftActive || !user.currentShift || !user.employeeId || !user.storeId) return json({ message: "Bạn chưa bắt đầu ca làm việc" }, 409);
  const body = await request.json().catch(() => ({})) as { customerName?: string; phone?: string; age?: number | string; amount?: number | string; paymentMethod?: string };
  const amount = Number(body.amount);
  const age = body.age === "" || body.age == null ? null : Number(body.age);
  if (!Number.isInteger(amount) || amount <= 0) return json({ message: "Giá trị đơn hàng phải lớn hơn 0." }, 400);
  if (age != null && (!Number.isInteger(age) || age < 1 || age > 120)) return json({ message: "Tuổi không hợp lệ." }, 400);
  if (!['CASH', 'BANK_TRANSFER'].includes(body.paymentMethod ?? "")) return json({ message: "Hình thức thanh toán không hợp lệ." }, 400);
  const db = await initDb();
  const sequence = await db.prepare("SELECT COUNT(*) AS count FROM orders").first<{ count: number }>();
  const code = `DH${String(Number(sequence?.count ?? 0) + 1).padStart(5, "0")}`;
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO orders (id, code, store_id, employee_id, shift_code, customer_name, phone, age, amount, payment_method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)")
    .bind(id, code, user.storeId, user.employeeId, user.currentShift, body.customerName?.trim() || null, body.phone?.trim() || null, age, amount, body.paymentMethod, new Date().toISOString()).run();
  await writeAudit(user.id, "CREATE", "ORDER", id, code);
  return json({ id, code }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Chỉ nhân viên mới cập nhật đơn trong ca." }, 403);
  if (!user.shiftActive || !user.currentShift || !user.employeeId || !user.storeId) return json({ message: "Bạn chưa bắt đầu ca làm việc" }, 409);
  const body = await request.json().catch(() => ({})) as { id?: string; customerName?: string; phone?: string; age?: number | string; amount?: number | string; paymentMethod?: string };
  const amount = Number(body.amount);
  const age = body.age === "" || body.age == null ? null : Number(body.age);
  if (!body.id) return json({ message: "Thiếu mã đơn hàng cần cập nhật." }, 400);
  if (!Number.isInteger(amount) || amount <= 0) return json({ message: "Giá trị đơn hàng phải lớn hơn 0." }, 400);
  if (age != null && (!Number.isInteger(age) || age < 1 || age > 120)) return json({ message: "Tuổi không hợp lệ." }, 400);
  if (!["CASH", "BANK_TRANSFER"].includes(body.paymentMethod ?? "")) return json({ message: "Hình thức thanh toán không hợp lệ." }, 400);
  const db = await initDb();
  const order = await db.prepare("SELECT id, code FROM orders WHERE id = ? AND store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'")
    .bind(body.id, user.storeId, user.employeeId, user.currentShift).first<{ id: string; code: string }>();
  if (!order) return json({ message: "Không tìm thấy đơn thuộc ca hiện tại của bạn." }, 404);
  await db.prepare("UPDATE orders SET customer_name = ?, phone = ?, age = ?, amount = ?, payment_method = ? WHERE id = ? AND store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'")
    .bind(body.customerName?.trim() || null, body.phone?.trim() || null, age, amount, body.paymentMethod, body.id, user.storeId, user.employeeId, user.currentShift).run();
  await writeAudit(user.id, "UPDATE", "ORDER", body.id, order.code);
  return json({ ok: true, code: order.code });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE" || !user.shiftActive || !user.currentShift || !user.employeeId || !user.storeId) return json({ message: "Không thể hủy đơn ngoài ca hiện tại." }, 403);
  const id = new URL(request.url).searchParams.get("id");
  const db = await initDb();
  const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'").bind(id, user.storeId, user.employeeId, user.currentShift).first();
  if (!order) return json({ message: "Không tìm thấy đơn thuộc ca hiện tại." }, 404);
  await db.prepare("UPDATE orders SET status = 'VOID' WHERE id = ? AND store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'").bind(id, user.storeId, user.employeeId, user.currentShift).run();
  await writeAudit(user.id, "VOID", "ORDER", id);
  return json({ ok: true });
}
