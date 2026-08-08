import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, hashPassword, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";

type EmployeeBody = {
  id?: string;
  storeId?: string;
  code?: string;
  name?: string;
  position?: string;
  phone?: string;
  province?: string;
  ward?: string;
  addressLine?: string;
  age?: number | string;
  cccdImageKey?: string;
  cccdImageName?: string;
  hourlyRate?: number | string;
  username?: string;
  password?: string;
  status?: "ACTIVE" | "INACTIVE";
};

const cccdKeyPattern = /^cccd\/[a-f0-9-]+\.(jpg|png|webp)$/;

function profileValues(body: EmployeeBody) {
  return {
    province: body.province?.trim() ?? "",
    ward: body.ward?.trim() ?? "",
    addressLine: body.addressLine?.trim() ?? "",
    age: Number(body.age),
    cccdImageKey: body.cccdImageKey?.trim() ?? "",
    cccdImageName: body.cccdImageName?.trim() ?? "",
  };
}

function validProfile(profile: ReturnType<typeof profileValues>) {
  return Boolean(profile.province && profile.ward && profile.addressLine
    && Number.isInteger(profile.age) && profile.age >= 15 && profile.age <= 100
    && cccdKeyPattern.test(profile.cccdImageKey));
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  if (user.role === "EMPLOYEE") {
    if (!user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên." }, 409);
    const own = await db.prepare("SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.id = ? AND e.status != 'ARCHIVED' LIMIT 1")
      .bind(user.employeeId).all();
    return json({ employees: own.results });
  }
  const params = new URL(request.url).searchParams;
  const storeId = params.get("storeId");
  const includeSupport = params.get("includeSupport") === "1";
  const result = storeId && includeSupport
    ? await db.prepare(`SELECT e.*, u.username, e.store_id AS homeStoreId, hs.name AS homeStoreName,
        CASE WHEN e.store_id = ? THEN 0 ELSE 1 END AS isSupport
      FROM employees e
      LEFT JOIN users u ON u.employee_id = e.id
      LEFT JOIN stores hs ON hs.id = e.store_id
      WHERE e.status = 'ACTIVE' AND (
        e.store_id = ? OR EXISTS (
          SELECT 1 FROM employee_transfers t
          WHERE t.employee_id = e.id AND t.target_store_id = ? AND t.status != 'CANCELLED'
        )
      )
      ORDER BY isSupport, e.code`).bind(storeId, storeId, storeId).all()
    : storeId
      ? await db.prepare("SELECT e.*, u.username, e.store_id AS homeStoreId, 0 AS isSupport FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.store_id = ? AND e.status != 'ARCHIVED' ORDER BY e.code").bind(storeId).all()
      : await db.prepare("SELECT e.*, u.username, e.store_id AS homeStoreId, 0 AS isSupport FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.status != 'ARCHIVED' ORDER BY e.store_id, e.code").all();
  return json({ employees: result.results });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as EmployeeBody;
  const hourlyRate = Number(body.hourlyRate ?? 20000);
  const profile = profileValues(body);
  if (!body.storeId || !body.code?.trim() || !body.name?.trim() || !body.position?.trim() || !body.phone?.trim() || !body.username?.trim() || !body.password || body.password.length < 6 || !Number.isInteger(hourlyRate) || hourlyRate <= 0 || !validProfile(profile)) return json({ message: "Vui lòng nhập đủ mã, tên, SĐT, địa chỉ, tuổi, ảnh CCCD; mật khẩu tối thiểu 6 ký tự." }, 400);
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const employeeId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare("INSERT INTO employees (id, store_id, code, name, position, phone, province, ward, address_line, age, cccd_image_key, cccd_image_name, hourly_rate, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')")
        .bind(employeeId, body.storeId, body.code.trim().toUpperCase(), body.name.trim(), body.position.trim(), body.phone.trim(), profile.province, profile.ward, profile.addressLine, profile.age, profile.cccdImageKey, profile.cccdImageName || null, hourlyRate),
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
  const status = body.status ?? "ACTIVE";
  const profile = profileValues(body);
  if (!body.id || !body.storeId || !body.code?.trim() || !body.name?.trim() || !body.position?.trim() || !body.phone?.trim() || !["ACTIVE", "INACTIVE"].includes(status) || !Number.isInteger(hourlyRate) || hourlyRate <= 0 || !validProfile(profile) || (body.password !== undefined && body.password.length < 6)) return json({ message: "Dữ liệu nhân viên, địa chỉ, tuổi, ảnh CCCD hoặc mật khẩu không hợp lệ." }, 400);
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const existing = await db.prepare("SELECT store_id AS storeId FROM employees WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
    .bind(body.id).first<{ storeId: string }>();
  if (!existing) return json({ message: "Không tìm thấy nhân viên." }, 404);
  if (status === "INACTIVE" || existing.storeId !== body.storeId) {
    const activeShift = await db.prepare("SELECT id FROM shift_sessions WHERE employee_id = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(body.id).first<{ id: string }>();
    if (activeShift) return json({ message: "Nhân viên đang làm ca, không thể đổi cửa hàng hoặc ngừng hoạt động." }, 409);
  }
  if (status === "INACTIVE" || existing.storeId !== body.storeId) {
    const activeTransfer = await db.prepare("SELECT id FROM employee_transfers WHERE employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE') LIMIT 1")
      .bind(body.id).first<{ id: string }>();
    if (activeTransfer) return json({ message: "Nhân viên còn lịch hỗ trợ cửa hàng khác, không thể đổi cửa hàng chính hoặc ngừng hoạt động." }, 409);
  }
  try {
    await db.batch([
      db.prepare("UPDATE employees SET store_id = ?, code = ?, name = ?, position = ?, phone = ?, province = ?, ward = ?, address_line = ?, age = ?, cccd_image_key = ?, cccd_image_name = ?, hourly_rate = ?, status = ? WHERE id = ?")
        .bind(body.storeId, body.code.trim().toUpperCase(), body.name.trim(), body.position.trim(), body.phone.trim(), profile.province, profile.ward, profile.addressLine, profile.age, profile.cccdImageKey, profile.cccdImageName || null, hourlyRate, status, body.id),
      body.username?.trim()
        ? db.prepare("UPDATE users SET name = ?, store_id = ?, username = ? WHERE employee_id = ?").bind(body.name.trim(), body.storeId, body.username.trim().toLowerCase(), body.id)
        : db.prepare("UPDATE users SET name = ?, store_id = ? WHERE employee_id = ?").bind(body.name.trim(), body.storeId, body.id),
    ]);
  } catch {
    return json({ message: "Mã nhân viên hoặc tên đăng nhập đã tồn tại." }, 409);
  }
  if (status === "INACTIVE") {
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)").bind(body.id),
      db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE employee_id = ?").bind(body.id),
    ]);
  }
  if (body.password) await db.prepare("UPDATE users SET password_hash = ? WHERE employee_id = ?").bind(await hashPassword(body.password), body.id).run();
  await writeAudit(user.id, "UPDATE", "EMPLOYEE", body.id, body.code);
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  return json({ message: "Không hỗ trợ xóa nhân viên. Hãy sửa trạng thái thành nghỉ làm." }, 405, { Allow: "GET, POST, PATCH" });
}
