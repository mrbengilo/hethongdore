import { initDb } from "../../../db/runtime";

export type SessionUser = {
  id: string;
  username: string;
  role: "MANAGER" | "EMPLOYEE";
  name: string;
  employeeId: string | null;
  storeId: string | null;
  shiftActive: number;
  currentShift: string | null;
  shiftStartedAt: string | null;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterationsRaw, salt, expected] = encoded.split("$");
  if (algorithm !== "pbkdf2" || !iterationsRaw || !salt || !expected) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(salt), iterations: Number(iterationsRaw) }, key, 256);
  const actual = new Uint8Array(bits);
  const expectedBytes = base64ToBytes(expected);
  if (actual.length !== expectedBytes.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i += 1) mismatch |= actual[i] ^ expectedBytes[i];
  return mismatch === 0;
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request, "dore_session");
  if (!token) return null;
  const db = await initDb();
  const tokenHash = await sha256(token);
  const row = await db.prepare(`SELECT u.id, u.username, u.role, u.name, u.employee_id AS employeeId, u.store_id AS storeId, u.shift_active AS shiftActive, u.current_shift AS currentShift, u.shift_started_at AS shiftStartedAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Date.now()).first<SessionUser>();
  return row ?? null;
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}

