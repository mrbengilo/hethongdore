import { initDb } from "../../../db/runtime";
import {
  addDays, attendanceOccurrenceAt, ATTENDANCE_EARLY_WINDOW_MINUTES, DEFAULT_SHIFT_DEFINITIONS, localDate, shiftUtcRange, type ShiftClockDefinition,
} from "../../lib/scheduling";

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
  employeeTiktokAllowance: number | null;
  activeTransferId: string | null;
  isSupporting: boolean;
  shiftActive: number;
  currentShift: string | null;
  shiftStartedAt: string | null;
  currentShiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  isSuperAdmin: number;
};

type BaseSessionUser = Omit<SessionUser, "storeId" | "storeName" | "activeTransferId" | "isSupporting" | "currentShiftName" | "scheduledStart" | "scheduledEnd"> & {
  employeeStatus: string | null;
  homeStoreStatus: string | null;
};

type TransferCandidate = {
  id: string;
  targetStoreId: string;
  shiftsJson: string;
};

type CurrentTransferShift = {
  name: string;
  start: string;
};

export function transferShiftAllows(shiftsJson: string, currentShiftName: string, currentShiftStart: string) {
  let allowed: string[] = [];
  try {
    const parsed = JSON.parse(shiftsJson) as unknown;
    allowed = Array.isArray(parsed) ? parsed.map((value) => String(value).trim()).filter(Boolean) : [];
  } catch {
    allowed = [];
  }
  if (allowed.includes("Cả ngày") || allowed.includes(currentShiftName)) return true;

  const numbered = currentShiftName.match(/(?:^|\s)([1-3])(?:\s|$)/u)?.[1];
  const hour = Number(currentShiftStart.split(":")[0]);
  const legacyLabel = numbered === "1" ? "Ca sáng"
    : numbered === "2" ? "Ca chiều"
      : numbered === "3" ? "Ca tối"
        : Number.isFinite(hour) && hour < 12 ? "Ca sáng"
          : Number.isFinite(hour) && hour < 18 ? "Ca chiều"
            : "Ca tối";
  return allowed.includes(legacyLabel);
}

async function currentTransferShift(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  employeeId: string,
  now: Date,
): Promise<CurrentTransferShift | null> {
  const workDate = localDate(now);
  const previousDate = addDays(workDate, -1);
  const nextDate = addDays(workDate, 1);
  const nowTime = now.getTime();
  const schedules = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
    .bind(storeId).all<{ dataJson: string }>();
  const assigned = schedules.results.flatMap((row): Array<CurrentTransferShift & { workDate: string; startAt: string; endAt: string }> => {
    try {
      const data = JSON.parse(row.dataJson) as { date?: string; employeeIds?: string[]; shiftName?: string; start?: string; end?: string };
      if (![previousDate, workDate, nextDate].includes(data.date ?? "") || !data.employeeIds?.includes(employeeId) || !data.shiftName || !data.start || !data.end) return [];
      const range = shiftUtcRange(data.date!, data.start, data.end);
      return range ? [{ name: data.shiftName, start: data.start, workDate: data.date!, ...range }] : [];
    } catch {
      return [];
    }
  });
  const assignedNow = assigned.find((shift) => nowTime >= new Date(shift.startAt).getTime() && nowTime < new Date(shift.endAt).getTime());
  if (assignedNow) return { name: assignedNow.name, start: assignedNow.start };
  const assignedEarly = assigned
    .filter((shift) => {
      const untilStart = new Date(shift.startAt).getTime() - nowTime;
      return untilStart >= 0 && untilStart <= ATTENDANCE_EARLY_WINDOW_MINUTES * 60_000;
    })
    .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())[0];
  if (assignedEarly) return { name: assignedEarly.name, start: assignedEarly.start };
  if (assigned.some((shift) => shift.workDate === workDate)) return null;

  const rows = await db.prepare("SELECT title, data_json AS dataJson FROM business_records WHERE category = 'CA_LAM_VIEC' AND store_id = ? AND status != 'DELETED' ORDER BY created_at, id")
    .bind(storeId).all<{ title: string; dataJson: string }>();
  const configured = rows.results.flatMap((row): ShiftClockDefinition[] => {
    try {
      const data = JSON.parse(row.dataJson) as { start?: string; end?: string };
      return typeof data.start === "string" && typeof data.end === "string"
        ? [{ name: row.title, start: data.start, end: data.end }]
        : [];
    } catch {
      return [];
    }
  });
  const occurrence = attendanceOccurrenceAt(now, configured.length > 0 ? configured : DEFAULT_SHIFT_DEFINITIONS);
  return occurrence ? { name: occurrence.name, start: occurrence.start } : null;
}

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

export const INACTIVE_STORE_MESSAGE = "Cửa hàng đã ngưng hoạt động. Bạn chỉ có thể xem dữ liệu lịch sử.";

export async function isStoreActive(storeId: string | null | undefined) {
  if (!storeId) return false;
  const db = await initDb();
  const store = await db.prepare("SELECT status FROM stores WHERE id = ? LIMIT 1")
    .bind(storeId).first<{ status: string }>();
  return store?.status === "ACTIVE";
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function firstForwardedProtocol(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto) return forwardedProto;
  const forwarded = request.headers.get("forwarded") ?? "";
  return forwarded.match(/(?:^|;)\s*proto=(?:"([^"]+)"|([^;,\s]+))/iu)?.slice(1).find(Boolean)?.toLowerCase();
}

export function shouldUseSecureSessionCookie(request: Request) {
  const production = typeof process !== "undefined" && process.env.NODE_ENV === "production";
  return production
    || new URL(request.url).protocol === "https:"
    || firstForwardedProtocol(request) === "https";
}

export function sessionCookieHeader(request: Request, token: string, maxAge: number) {
  const secure = shouldUseSecureSessionCookie(request) ? "; Secure" : "";
  return `dore_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request, "dore_session");
  if (!token) return null;
  const db = await initDb();
  const tokenHash = await sha256(token);
  const row = await db.prepare(`SELECT u.id, u.username, u.role, u.name, u.employee_id AS employeeId, u.store_id AS homeStoreId, hs.name AS homeStoreName, hs.status AS homeStoreStatus, e.code AS employeeCode, e.position AS employeePosition, e.phone AS employeePhone, e.tiktok_allowance AS employeeTiktokAllowance, e.status AS employeeStatus, u.shift_active AS shiftActive, u.current_shift AS currentShift, u.shift_started_at AS shiftStartedAt, COALESCE(u.is_super_admin, 0) AS isSuperAdmin FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN stores hs ON hs.id = u.store_id WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Date.now()).first<BaseSessionUser>();
  if (!row) return null;

  // Status changes revoke an employee account immediately, including sessions
  // that were issued before the manager disabled the employee.
  if (row.role === "EMPLOYEE" && (row.employeeStatus !== "ACTIVE" || row.homeStoreStatus !== "ACTIVE")) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  if (row.role === "MANAGER" && Number(row.isSuperAdmin) !== 1 && row.homeStoreId && row.homeStoreStatus === "DELETED") {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }

  let storeId = row.homeStoreId;
  let storeName = row.homeStoreName;
  let activeTransferId: string | null = null;
  let currentShiftName: string | null = null;
  let scheduledStart: string | null = null;
  let scheduledEnd: string | null = null;
  let employeeTiktokAllowance = row.employeeTiktokAllowance;

  if (row.role === "EMPLOYEE" && row.employeeId) {
    // A running shift keeps its original store snapshot even if a transfer ends
    // while the employee is still closing the shift.
    const runningShift = row.currentShift
      ? await db.prepare("SELECT store_id AS storeId, transfer_id AS transferId, shift_name AS shiftName, scheduled_start AS scheduledStart, scheduled_end AS scheduledEnd, applied_tiktok_allowance AS appliedTikTokAllowance FROM shift_sessions WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE' LIMIT 1")
        .bind(row.currentShift, row.employeeId).first<{ storeId: string; transferId: string | null; shiftName: string | null; scheduledStart: string | null; scheduledEnd: string | null; appliedTikTokAllowance: number | null }>()
      : null;
    if (runningShift) {
      storeId = runningShift.storeId;
      activeTransferId = runningShift.transferId;
      currentShiftName = runningShift.shiftName;
      scheduledStart = runningShift.scheduledStart;
      scheduledEnd = runningShift.scheduledEnd;
      employeeTiktokAllowance = runningShift.appliedTikTokAllowance;
    } else {
      const now = new Date();
      const today = localDate(now);
      const candidates = await db.prepare(`SELECT t.id, t.target_store_id AS targetStoreId, t.shifts_json AS shiftsJson
          FROM employee_transfers t
          JOIN stores target ON target.id = t.target_store_id AND target.status = 'ACTIVE'
          WHERE t.employee_id = ? AND t.start_date <= ? AND t.end_date >= ?
            AND t.status IN ('SCHEDULED', 'ACTIVE')
          ORDER BY t.start_date DESC, t.created_at DESC`)
        .bind(row.employeeId, today, today).all<TransferCandidate>();
      for (const transfer of candidates.results) {
        const currentShift = await currentTransferShift(db, transfer.targetStoreId, row.employeeId, now);
        if (!currentShift || !transferShiftAllows(transfer.shiftsJson, currentShift.name, currentShift.start)) continue;
        storeId = transfer.targetStoreId;
        activeTransferId = transfer.id;
        await db.prepare(`UPDATE employee_transfers SET status = 'ACTIVE', updated_at = ?
            WHERE id = ? AND employee_id = ? AND start_date <= ? AND end_date >= ? AND status = 'SCHEDULED'`)
          .bind(now.toISOString(), transfer.id, row.employeeId, today, today).run();
        break;
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
    employeeTiktokAllowance,
  };
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}
