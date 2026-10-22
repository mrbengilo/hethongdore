import { initDb, writeAudit } from "../../../../db/runtime";
import { getSessionUser, hashPassword, json, readCookie, sha256, verifyPassword } from "../../_lib/auth";

type PasswordChangeBody = {
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
};

const responseHeaders = { "Cache-Control": "no-store" };

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Phiên đăng nhập đã hết hạn." }, 401, responseHeaders);
  if (user.role !== "MANAGER") return json({ message: "Chỉ tài khoản quản lý được đổi mật khẩu tại đây." }, 403, responseHeaders);

  const body = await request.json().catch(() => ({})) as PasswordChangeBody;
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  if (!currentPassword || currentPassword.length > 128) return json({ message: "Vui lòng nhập đúng mật khẩu hiện tại." }, 400, responseHeaders);
  if (newPassword.length < 8 || newPassword.length > 128) return json({ message: "Mật khẩu mới phải có từ 8 đến 128 ký tự." }, 400, responseHeaders);
  if (newPassword !== confirmPassword) return json({ message: "Xác nhận mật khẩu mới chưa khớp." }, 400, responseHeaders);
  if (newPassword === currentPassword) return json({ message: "Mật khẩu mới phải khác mật khẩu hiện tại." }, 400, responseHeaders);

  const db = await initDb();
  const account = await db.prepare("SELECT password_hash AS passwordHash FROM users WHERE id = ? AND role = 'MANAGER' LIMIT 1")
    .bind(user.id).first<{ passwordHash: string }>();
  if (!account || !await verifyPassword(currentPassword, account.passwordHash)) {
    await writeAudit(user.id, "PASSWORD_CHANGE_REJECTED", "USER", user.id, "reason=current_password_mismatch");
    return json({ message: "Mật khẩu hiện tại không đúng." }, 400, responseHeaders);
  }
  if (await verifyPassword(newPassword, account.passwordHash)) return json({ message: "Mật khẩu mới phải khác mật khẩu hiện tại." }, 400, responseHeaders);

  const token = readCookie(request, "dore_session");
  if (!token) return json({ message: "Phiên đăng nhập đã hết hạn." }, 401, responseHeaders);
  const currentTokenHash = await sha256(token);
  const nextHash = await hashPassword(newPassword);
  await db.batch([
    db.prepare("UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ? AND role = 'MANAGER'").bind(nextHash, user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, currentTokenHash),
  ]);
  await writeAudit(user.id, "PASSWORD_CHANGED", "USER", user.id, "other_sessions_revoked=true");
  return json({ ok: true, message: "Đã đổi mật khẩu. Các phiên đăng nhập khác đã được thu hồi." }, 200, responseHeaders);
}
