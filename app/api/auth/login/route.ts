import { initDb, writeAudit } from "../../../../db/runtime";
import { json, sessionCookieHeader, sha256, verifyPassword } from "../../_lib/auth";

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number }; changes?: number } | null)?.meta?.changes ?? 0);
}

function employeeStatusMessage(status: unknown) {
  return status === "SUSPENDED"
    ? "Tài khoản nhân viên đang tạm ngưng và không thể đăng nhập."
    : status === "TERMINATED" || status === "INACTIVE"
      ? "Tài khoản nhân viên đã nghỉ việc và không thể đăng nhập."
      : "Tài khoản nhân viên không còn hiệu lực.";
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { username?: string; password?: string; remember?: boolean };
  const username = body.username?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!username || !password) return json({ message: "Vui lòng nhập tên đăng nhập và mật khẩu." }, 400);

  const db = await initDb();
  const user = await db.prepare(`SELECT u.*, e.status AS employee_status, st.status AS store_status
    FROM users u
    LEFT JOIN employees e ON e.id = u.employee_id
    LEFT JOIN stores st ON st.id = u.store_id
    WHERE u.username = ?`).bind(username).first<Record<string, unknown>>();
  const now = Date.now();
  if (user && Number(user.locked_until ?? 0) > now) {
    return json({ message: "Tài khoản đang bị khóa tạm thời. Vui lòng thử lại sau." }, 423);
  }

  const valid = user ? await verifyPassword(password, String(user.password_hash)) : false;
  if (!user || !valid) {
    if (user) {
      const attempts = Number(user.failed_attempts ?? 0) + 1;
      const lockedUntil = attempts >= 10 ? now + 15 * 60 * 1000 : null;
      await db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?").bind(lockedUntil ? 0 : attempts, lockedUntil, String(user.id)).run();
      await writeAudit(String(user.id), "LOGIN_FAILED", "USER", String(user.id), `attempt=${attempts}`);
    }
    return json({ message: "Tên đăng nhập hoặc mật khẩu không đúng." }, 401);
  }

  if (user.role === "EMPLOYEE" && user.employee_status !== "ACTIVE") {
    return json({ message: employeeStatusMessage(user.employee_status) }, 403);
  }
  if (user.role === "EMPLOYEE" && user.store_status !== "ACTIVE") {
    return json({ message: "Cửa hàng đã ngưng hoạt động. Tài khoản nhân viên tạm thời bị khóa." }, 403);
  }
  if (user.role === "MANAGER" && Number(user.is_super_admin) !== 1 && user.store_id && user.store_status === "DELETED") {
    return json({ message: "Cửa hàng đã bị xóa. Tài khoản quản lý không còn quyền truy cập." }, 403);
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256(token);
  const maxAge = body.remember ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
  const createdAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?")
      .bind(String(user.id)),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    // Recheck account and store lifecycle in the same serialized batch that
    // inserts the session. A concurrent suspend/terminate/delete either wins
    // first and makes this insert inert, or wins second and revokes this token.
    db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      SELECT ?, u.id, ?, ?, ?
      FROM users u
      LEFT JOIN employees e ON e.id = u.employee_id
      LEFT JOIN stores st ON st.id = u.store_id
      WHERE u.id = ?
        AND (u.role != 'EMPLOYEE' OR (e.status = 'ACTIVE' AND st.status = 'ACTIVE'))
        AND (u.role != 'MANAGER' OR COALESCE(u.is_super_admin, 0) = 1
          OR u.store_id IS NULL OR st.status IN ('ACTIVE', 'INACTIVE'))`)
      .bind(crypto.randomUUID(), tokenHash, now + maxAge * 1000, createdAt, String(user.id)),
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, u.id, 'LOGIN_SUCCESS', 'USER', u.id, NULL, ?
      FROM users u JOIN sessions s ON s.user_id = u.id AND s.token_hash = ?
      WHERE u.id = ?`)
      .bind(auditId, createdAt, tokenHash, String(user.id)),
  ]);
  if (affectedRows(results[2]) !== 1) {
    const current = await db.prepare(`SELECT u.role, u.store_id, COALESCE(u.is_super_admin, 0) AS is_super_admin,
        e.status AS employee_status, st.status AS store_status
      FROM users u
      LEFT JOIN employees e ON e.id = u.employee_id
      LEFT JOIN stores st ON st.id = u.store_id
      WHERE u.id = ? LIMIT 1`).bind(String(user.id)).first<Record<string, unknown>>();
    if (!current) return json({ message: "Tên đăng nhập hoặc mật khẩu không đúng." }, 401);
    if (current.role === "EMPLOYEE" && current.employee_status !== "ACTIVE") {
      return json({ message: employeeStatusMessage(current.employee_status) }, 403);
    }
    if (current.role === "EMPLOYEE" && current.store_status !== "ACTIVE") {
      return json({ message: "Cửa hàng đã ngưng hoạt động. Tài khoản nhân viên tạm thời bị khóa." }, 403);
    }
    if (current.role === "MANAGER" && Number(current.is_super_admin) !== 1 && current.store_id && current.store_status === "DELETED") {
      return json({ message: "Cửa hàng đã bị xóa. Tài khoản quản lý không còn quyền truy cập." }, 403);
    }
    return json({ message: "Tài khoản vừa thay đổi. Vui lòng thử đăng nhập lại." }, 409);
  }

  const cookie = sessionCookieHeader(request, token, maxAge);
  return json({ role: user.role, redirect: user.role === "MANAGER" ? "/manager" : "/employee" }, 200, { "Set-Cookie": cookie });
}
