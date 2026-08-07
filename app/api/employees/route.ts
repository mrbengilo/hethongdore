import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, hashPassword, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";

type EmployeeBody = { id?: string; storeId?: string; code?: string; name?: string; position?: string; phone?: string; hourlyRate?: number | string; username?: string; password?: string };

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const storeId = user.role === "EMPLOYEE" ? user.storeId : new URL(request.url).searchParams.get("storeId");
  const result = storeId
    ? await db.prepare("SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.store_id = ? AND e.status != 'ARCHIVED' ORDER BY e.code").bind(storeId).all()
    : await db.prepare("SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.status != 'ARCHIVED' ORDER BY e.store_id, e.code").all();
  return json({ employees: result.results });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as EmployeeBody;
  const hourlyRate = Number(body.hourlyRate ?? 20000);
  if (!body.storeId || !body.code?.trim() || !body.name?.trim() || !body.position?.trim() || !body.phone?.trim() || !body.username?.trim() || !body.password || body.password.length < 6 || !Number.isInteger(hourlyRate) || hourlyRate <= 0) return json({ message: "Vui lòng nhập đủ thông tin; mật khẩu tối thiểu 6 ký tự." }, 400);
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const employeeId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare("INSERT INTO employees (id, store_id, code, name, position, phone, hourly_rate, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')").bind(employeeId, body.storeId, body.code.trim().toUpperCase(), body.name.trim(), body.position.trim(), body.phone.trim(), hourlyRate),
      db.prepare("INSERT INTO users (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, shift_active) VALUES (?, ?, ?, 'EMPLOYEE', ?, ?, ?, 0, 0)").bind(userId, body.username.trim().toLowerCase(), await hashPassword(body.password), body.name.trim(), employeeId, body.storeId),
    ]);
  } catch { return json({ message: "Mã nhân viên hoặc tên đăng nhập đã tồn tại." }, 409); }
  await writeAudit(user.id, "CREATE", "EMPLOYEE", employeeId, body.code);
  return json({ id: employeeId, storeId: body.storeId }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as EmployeeBody;
  const hourlyRate = Number(body.hourlyRate ?? 20000);
  if (!body.id || !body.storeId || !body.code?.trim() || !body.name?.trim() || !body.position?.trim() || !body.phone?.trim() || !Number.isInteger(hourlyRate) || hourlyRate <= 0) return json({ message: "Dữ liệu không hợp lệ" }, 400);
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  await db.batch([
    db.prepare("UPDATE employees SET store_id = ?, code = ?, name = ?, position = ?, phone = ?, hourly_rate = ? WHERE id = ?").bind(body.storeId, body.code.trim().toUpperCase(), body.name.trim(), body.position.trim(), body.phone.trim(), hourlyRate, body.id),
    db.prepare("UPDATE users SET name = ?, store_id = ? WHERE employee_id = ?").bind(body.name.trim(), body.storeId, body.id),
  ]);
  if (body.password) await db.prepare("UPDATE users SET password_hash = ? WHERE employee_id = ?").bind(await hashPassword(body.password), body.id).run();
  await writeAudit(user.id, "UPDATE", "EMPLOYEE", body.id, body.code);
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ message: "Thiếu mã nhân viên" }, 400);
  const db = await initDb();
  const employee = await db.prepare("SELECT store_id AS storeId FROM employees WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
    .bind(id).first<{ storeId: string }>();
  if (!employee) return json({ message: "Không tìm thấy nhân viên." }, 404);
  if (!await isStoreActive(employee.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  await db.batch([
    db.prepare("UPDATE employees SET status = 'ARCHIVED' WHERE id = ?").bind(id),
    db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)").bind(id),
  ]);
  await writeAudit(user.id, "ARCHIVE", "EMPLOYEE", id);
  return json({ ok: true });
}
