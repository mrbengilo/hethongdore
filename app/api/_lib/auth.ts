import { initDb } from "../../../db/runtime";

export type SessionUser = {
  id: string;
  username: string;
  role: "MANAGER" | "EMPLOYEE";
  name: string;
  employeeId: string | null;
  storeId: string | null;
  homeStoreId: string | null;
  storeName: string | null;
  homeStoreName: string | null;
  employeeCode: string | null;
  employeePosition: string | null;
  employeePhone: string | null;
  activeTransferId: string | null;
  isSupporting: boolean;
  shiftActive: number;
  currentShift: string | null;
  shiftStartedAt: string | null;
  currentShiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
};

type BaseSessionUser = Omit<SessionUser, "storeId" | "storeName" | "activeTransferId" | "isSupporting" | "currentShiftName" | "scheduledStart" | "scheduledEnd">;

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

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return `pbkdf2$100000$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
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
  const row = await db.prepare(`SELECT u.id, u.username, u.role, u.name, u.employee_id AS employeeId, u.store_id AS homeStoreId, hs.name AS homeStoreName, e.code AS employeeCode, e.position AS employeePosition, e.phone AS employeePhone, u.shift_active AS shiftActive, u.current_shift AS currentShift, u.shift_started_at AS shiftStartedAt FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN stores hs ON hs.id = u.store_id WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Date.now()).first<BaseSessionUser>();
  if (!row) return null;

  let storeId = row.homeStoreId;
  let storeName = row.homeStoreName;
  let activeTransferId: string | null = null;
  let currentShiftName: string | null = null;
  let scheduledStart: string | null = null;
  let scheduledEnd: string | null = null;

  if (row.role === "EMPLOYEE" && row.employeeId) {
    // A running shift keeps its original store snapshot even if a transfer ends
    // while the employee is still closing the shift.
    const runningShift = row.currentShift
      ? await db.prepare("SELECT store_id AS storeId, transfer_id AS transferId, shift_name AS shiftName, scheduled_start AS scheduledStart, scheduled_end AS scheduledEnd FROM shift_sessions WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE' LIMIT 1")
        .bind(row.currentShift, row.employeeId).first<{ storeId: string; transferId: string | null; shiftName: string | null; scheduledStart: string | null; scheduledEnd: string | null }>()
      : null;
    if (runningShift) {
      storeId = runningShift.storeId;
      activeTransferId = runningShift.transferId;
      currentShiftName = runningShift.shiftName;
      scheduledStart = runningShift.scheduledStart;
      scheduledEnd = runningShift.scheduledEnd;
    } else {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
      const transfer = await db.prepare("SELECT id, target_store_id AS targetStoreId FROM employee_transfers WHERE employee_id = ? AND start_date <= ? AND end_date >= ? AND status IN ('SCHEDULED', 'ACTIVE') ORDER BY start_date DESC, created_at DESC LIMIT 1")
        .bind(row.employeeId, today, today).first<{ id: string; targetStoreId: string }>();
      if (transfer) {
        storeId = transfer.targetStoreId;
        activeTransferId = transfer.id;
        await db.prepare("UPDATE employee_transfers SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status = 'SCHEDULED'").bind(new Date().toISOString(), transfer.id).run();
      }
    }
    if (storeId && storeId !== row.homeStoreId) {
      storeName = (await db.prepare("SELECT name FROM stores WHERE id = ? LIMIT 1").bind(storeId).first<{ name: string }>())?.name ?? storeName;
    }
  }

  return {
    ...row,
    storeId,
    storeName,
    activeTransferId,
    isSupporting: Boolean(storeId && row.homeStoreId && storeId !== row.homeStoreId),
    currentShiftName,
    scheduledStart,
    scheduledEnd,
  };
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}
