import { initDb, writeAudit } from "../../../../db/runtime";
import { getSessionUser, json, readCookie, sessionCookieHeader, sha256 } from "../../_lib/auth";

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  const token = readCookie(request, "dore_session");
  if (token) {
    const db = await initDb();
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  }
  if (user) await writeAudit(user.id, "LOGOUT", "USER", user.id);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookieHeader(request, "", 0) });
}
