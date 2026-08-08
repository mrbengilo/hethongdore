import { initDb, writeAudit } from "../../../db/runtime";
import { localPeriod } from "../../lib/finance";
import { getSessionUser, hashPassword, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";

type EmployeeBody = {
  action?: "SET_STATUS";
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

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
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
  if (body.action === "SET_STATUS") {
    if (!body.id || !body.storeId || !body.status || !["ACTIVE", "INACTIVE"].includes(body.status)) {
      return json({ message: "Trạng thái nhân viên không hợp lệ." }, 400);
    }
    if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
    const db = await initDb();
    const existing = await db.prepare("SELECT id, store_id AS storeId, code, name, status, inactive_at AS inactiveAt FROM employees WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
      .bind(body.id).first<{ id: string; storeId: string; code: string; name: string; status: string; inactiveAt: string | null }>();
    if (!existing || existing.storeId !== body.storeId) return json({ message: "Không tìm thấy nhân viên trong cửa hàng." }, 404);

    if (body.status === "INACTIVE" && existing.status !== "INACTIVE") {
      const activeShift = await db.prepare("SELECT id FROM shift_sessions WHERE employee_id = ? AND status = 'ACTIVE' LIMIT 1")
        .bind(body.id).first<{ id: string }>();
      if (activeShift) return json({ message: "Nhân viên đang làm ca, hãy kết ca trước khi chuyển sang ngưng làm việc." }, 409);
      const activeTransfer = await db.prepare("SELECT id FROM employee_transfers WHERE employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE') LIMIT 1")
        .bind(body.id).first<{ id: string }>();
      if (activeTransfer) return json({ message: "Nhân viên còn lịch hỗ trợ cửa hàng khác, hãy kết thúc lịch hỗ trợ trước khi ngưng làm việc." }, 409);
    }
    if (body.status === "ACTIVE" && existing.status === "INACTIVE") {
      const inactiveInstant = existing.inactiveAt ? new Date(existing.inactiveAt) : null;
      const inactivePeriod = inactiveInstant && Number.isFinite(inactiveInstant.getTime()) ? localPeriod(inactiveInstant) : localPeriod();
      const requiredOffboardingLock = await db.prepare(`SELECT id FROM employee_payroll_closings
        WHERE employee_id = ? AND store_id = ? AND period = ? AND status IN ('BASE_LOCKED', 'LOCKED') LIMIT 1`)
        .bind(body.id, body.storeId, inactivePeriod).first<{ id: string }>();
      if (!requiredOffboardingLock) {
        return json({ message: `Hãy chốt lương và khóa sổ riêng cho nhân viên ở kỳ ${inactivePeriod} trước khi chuyển lại sang đang làm việc.` }, 409);
      }
      const currentPayrollLock = await db.prepare("SELECT id FROM employee_payroll_closings WHERE employee_id = ? AND period = ? AND status IN ('BASE_LOCKED', 'LOCKED') LIMIT 1")
        .bind(body.id, localPeriod()).first<{ id: string }>();
      if (currentPayrollLock) {
        return json({ message: "Lương của nhân viên đã khóa sổ trong tháng hiện tại. Chỉ có thể chuyển lại sang đang làm việc từ tháng tiếp theo." }, 409);
      }
    }

    const transitionAt = new Date().toISOString();
    let changed = existing.status !== body.status;
    if (changed && body.status === "INACTIVE") {
      // The NOT EXISTS guards and the shift-start employee-status guard are
      // evaluated by D1 as serialized writes. Whichever request wins makes
      // the other fail, so an ACTIVE shift cannot be orphaned after logout.
      const transition = await db.prepare(`UPDATE employees SET status = 'INACTIVE', inactive_at = ?
        WHERE id = ? AND store_id = ? AND status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM shift_sessions WHERE employee_id = ? AND status = 'ACTIVE')
          AND NOT EXISTS (SELECT 1 FROM employee_transfers WHERE employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE'))`)
        .bind(transitionAt, body.id, body.storeId, body.id, body.id).run();
      if (affectedRows(transition) === 0) {
        const current = await db.prepare("SELECT status FROM employees WHERE id = ? AND store_id = ? LIMIT 1")
          .bind(body.id, body.storeId).first<{ status: string }>();
        if (current?.status !== "INACTIVE") {
          const activeShift = await db.prepare("SELECT id FROM shift_sessions WHERE employee_id = ? AND status = 'ACTIVE' LIMIT 1")
            .bind(body.id).first<{ id: string }>();
          return json({ message: activeShift
            ? "Nhân viên vừa bắt đầu ca. Hãy kết ca trước khi chuyển sang ngưng làm việc."
            : "Trạng thái nhân viên vừa thay đổi hoặc còn lịch hỗ trợ. Vui lòng tải lại và thử lại." }, 409);
        }
        changed = false;
      }
    } else if (changed) {
      const transition = await db.prepare("UPDATE employees SET status = 'ACTIVE', inactive_at = NULL WHERE id = ? AND store_id = ? AND status = 'INACTIVE'")
        .bind(body.id, body.storeId).run();
      if (affectedRows(transition) === 0) {
        const current = await db.prepare("SELECT status FROM employees WHERE id = ? AND store_id = ? LIMIT 1")
          .bind(body.id, body.storeId).first<{ status: string }>();
        if (current?.status !== "ACTIVE") return json({ message: "Trạng thái nhân viên vừa thay đổi. Vui lòng tải lại và thử lại." }, 409);
        changed = false;
      }
    }
    if (body.status === "INACTIVE") {
      await db.prepare("UPDATE employees SET inactive_at = COALESCE(inactive_at, ?) WHERE id = ? AND status = 'INACTIVE'")
        .bind(transitionAt, body.id).run();
      // Idempotently revoke every login session and clear legacy shift flags.
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)").bind(body.id),
        db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE employee_id = ?").bind(body.id),
      ]);
    }
    if (changed) {
      await writeAudit(user.id, "EMPLOYEE_STATUS_CHANGE", "EMPLOYEE", body.id, JSON.stringify({
        storeId: body.storeId,
        employeeCode: existing.code,
        from: existing.status,
        to: body.status,
        at: transitionAt,
      }));
    }
    return json({
      ok: true,
      status: body.status,
      payrollClosingRequired: body.status === "INACTIVE",
      message: body.status === "INACTIVE"
        ? "Đã chuyển nhân viên sang ngưng làm việc, khóa tài khoản và thu hồi phiên đăng nhập. Hãy chốt lương riêng cho nhân viên tại mục Lương thưởng."
        : "Đã chuyển nhân viên sang đang làm việc và mở lại quyền đăng nhập.",
    });
  }
  const hourlyRate = Number(body.hourlyRate ?? 20000);
  const status = body.status ?? "ACTIVE";
  const profile = profileValues(body);
  if (!body.id || !body.storeId || !body.code?.trim() || !body.name?.trim() || !body.position?.trim() || !body.phone?.trim() || !["ACTIVE", "INACTIVE"].includes(status) || !Number.isInteger(hourlyRate) || hourlyRate <= 0 || !validProfile(profile) || (body.password !== undefined && body.password !== "" && body.password.length < 6)) return json({ message: "Dữ liệu nhân viên, địa chỉ, tuổi, ảnh CCCD hoặc mật khẩu không hợp lệ." }, 400);
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const existing = await db.prepare("SELECT store_id AS storeId, status FROM employees WHERE id = ? AND status != 'ARCHIVED' LIMIT 1")
    .bind(body.id).first<{ storeId: string; status: string }>();
  if (!existing) return json({ message: "Không tìm thấy nhân viên." }, 404);
  if (body.status !== undefined && body.status !== existing.status) {
    return json({ message: "Vui lòng dùng nút trạng thái riêng để đổi trạng thái làm việc của nhân viên." }, 409);
  }
  const persistedStatus = existing.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  if (existing.storeId !== body.storeId) {
    const activeShift = await db.prepare("SELECT id FROM shift_sessions WHERE employee_id = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(body.id).first<{ id: string }>();
    if (activeShift) return json({ message: "Nhân viên đang làm ca, không thể đổi cửa hàng hoặc ngừng hoạt động." }, 409);
  }
  if (existing.storeId !== body.storeId) {
    const activeTransfer = await db.prepare("SELECT id FROM employee_transfers WHERE employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE') LIMIT 1")
      .bind(body.id).first<{ id: string }>();
    if (activeTransfer) return json({ message: "Nhân viên còn lịch hỗ trợ cửa hàng khác, không thể đổi cửa hàng chính hoặc ngừng hoạt động." }, 409);
  }
  try {
    await db.batch([
      db.prepare("UPDATE employees SET store_id = ?, code = ?, name = ?, position = ?, phone = ?, province = ?, ward = ?, address_line = ?, age = ?, cccd_image_key = ?, cccd_image_name = ?, hourly_rate = ?, status = ? WHERE id = ?")
        .bind(body.storeId, body.code.trim().toUpperCase(), body.name.trim(), body.position.trim(), body.phone.trim(), profile.province, profile.ward, profile.addressLine, profile.age, profile.cccdImageKey, profile.cccdImageName || null, hourlyRate, persistedStatus, body.id),
      body.username?.trim()
        ? db.prepare("UPDATE users SET name = ?, store_id = ?, username = ? WHERE employee_id = ?").bind(body.name.trim(), body.storeId, body.username.trim().toLowerCase(), body.id)
        : db.prepare("UPDATE users SET name = ?, store_id = ? WHERE employee_id = ?").bind(body.name.trim(), body.storeId, body.id),
    ]);
  } catch {
    return json({ message: "Mã nhân viên hoặc tên đăng nhập đã tồn tại." }, 409);
  }
  if (persistedStatus === "INACTIVE") {
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
