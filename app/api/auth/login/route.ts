import { initDb, writeAudit } from "../../../../db/runtime";
import { json, sha256, verifyPassword } from "../../_lib/auth";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { username?: string; password?: string; remember?: boolean };
  const username = body.username?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!username || !password) return json({ message: "Vui lòng nhập tên đăng nhập và mật khẩu." }, 400);

  const db = await initDb();
  const user = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<Record<string, unknown>>();
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

  await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(String(user.id)).run();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256(token);
  const maxAge = body.remember ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), String(user.id), tokenHash, now + maxAge * 1000, new Date().toISOString()).run();
  await writeAudit(String(user.id), "LOGIN_SUCCESS", "USER", String(user.id));

  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const cookie = `dore_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  return json({ role: user.role, redirect: user.role === "MANAGER" ? "/manager" : "/employee" }, 200, { "Set-Cookie": cookie });
}

