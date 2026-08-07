import { initDb, writeAudit } from "../../../db/runtime";
import type { SessionUser } from "./auth";

type Db = Awaited<ReturnType<typeof initDb>>;
type Row = Record<string, unknown>;

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
export const SHIFT_GRACE_MINUTES = 60;
const GRACE_MS = SHIFT_GRACE_MINUTES * 60 * 1000;

const SHIFT_SLOTS = [
  { key: "CA1", name: "Ca 1", startHour: 7, endHour: 12 },
  { key: "CA2", name: "Ca 2", startHour: 12, endHour: 17 },
  { key: "CA3", name: "Ca 3", startHour: 17, endHour: 23 },
] as const;

type ShiftSlot = typeof SHIFT_SLOTS[number];
type ActiveUser = Pick<SessionUser, "id" | "employeeId" | "storeId" | "shiftActive" | "currentShift" | "shiftStartedAt">;

export type ShiftRolloverEvent = {
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  splitAt: string;
};

export type ActiveShiftState = {
  active: boolean;
  shiftCode: string | null;
  shiftName: string | null;
  startedAt: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  graceEndsAt: string | null;
  autoRolled: boolean;
  rollovers: ShiftRolloverEvent[];
};

function localParts(value: Date) {
  const shifted = new Date(value.getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function localDateKey(value: Date) {
  const parts = localParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addLocalDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function vietnamLocalIso(dateKey: string, hour: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour) - VN_OFFSET_MS).toISOString();
}

function slotFromCode(code?: string | null) {
  return SHIFT_SLOTS.find((slot) => code?.startsWith(slot.key)) ?? null;
}

function slotForInstant(value: Date): { slot: ShiftSlot; dateKey: string } {
  const parts = localParts(value);
  const dateKey = localDateKey(value);
  if (parts.hour >= 12 && parts.hour < 17) return { slot: SHIFT_SLOTS[1], dateKey };
  if (parts.hour >= 17) return { slot: SHIFT_SLOTS[2], dateKey };
  return { slot: SHIFT_SLOTS[0], dateKey };
}

function scheduleFor(slot: ShiftSlot, dateKey: string) {
  return {
    slot,
    dateKey,
    scheduledStartAt: vietnamLocalIso(dateKey, slot.startHour),
    scheduledEndAt: vietnamLocalIso(dateKey, slot.endHour),
  };
}

function inferSchedule(startedAt: string, code?: string | null) {
  const instant = new Date(startedAt);
  const inferred = slotForInstant(instant);
  const slot = slotFromCode(code) ?? inferred.slot;
  return scheduleFor(slot, inferred.dateKey);
}

function nextSchedule(current: ReturnType<typeof scheduleFor>) {
  const index = SHIFT_SLOTS.findIndex((slot) => slot.key === current.slot.key);
  if (index < SHIFT_SLOTS.length - 1) return scheduleFor(SHIFT_SLOTS[index + 1], current.dateKey);
  return scheduleFor(SHIFT_SLOTS[0], addLocalDays(current.dateKey, 1));
}

function newShiftCode(slot: ShiftSlot, dateKey: string) {
  return `${slot.key}-${dateKey}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

function stateFromRow(row: Row | null, rollovers: ShiftRolloverEvent[] = []): ActiveShiftState {
  if (!row) return { active: false, shiftCode: null, shiftName: null, startedAt: null, scheduledStartAt: null, scheduledEndAt: null, graceEndsAt: null, autoRolled: false, rollovers };
  const scheduledEndAt = row.scheduled_end_at ? String(row.scheduled_end_at) : null;
  return {
    active: true,
    shiftCode: String(row.shift_code),
    shiftName: String(row.shift_name ?? "Ca làm việc"),
    startedAt: String(row.started_at),
    scheduledStartAt: row.scheduled_start_at ? String(row.scheduled_start_at) : null,
    scheduledEndAt,
    graceEndsAt: scheduledEndAt ? new Date(new Date(scheduledEndAt).getTime() + GRACE_MS).toISOString() : null,
    autoRolled: rollovers.length > 0,
    rollovers,
  };
}

async function findActiveRow(db: Db, employeeId: string, shiftCode: string) {
  return db.prepare("SELECT * FROM shift_sessions WHERE employee_id = ? AND shift_code = ? AND ended_at IS NULL LIMIT 1")
    .bind(employeeId, shiftCode).first<Row>();
}

async function ensureLegacyRow(user: ActiveUser, db: Db) {
  if (!user.employeeId || !user.storeId || !user.currentShift || !user.shiftStartedAt) return null;
  const existing = await findActiveRow(db, user.employeeId, user.currentShift);
  if (existing) return existing;
  const schedule = inferSchedule(user.shiftStartedAt, user.currentShift);
  const workSessionId = crypto.randomUUID();
  await db.prepare("INSERT INTO shift_sessions (id, shift_code, shift_name, store_id, employee_id, started_at, scheduled_start_at, scheduled_end_at, work_session_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')")
    .bind(crypto.randomUUID(), user.currentShift, schedule.slot.name, user.storeId, user.employeeId, user.shiftStartedAt, schedule.scheduledStartAt, schedule.scheduledEndAt, workSessionId).run();
  return findActiveRow(db, user.employeeId, user.currentShift);
}

export async function startEmployeeShift(user: ActiveUser, db: Db, now = new Date()) {
  if (!user.employeeId || !user.storeId) throw new Error("Tài khoản chưa được gắn với nhân viên/cửa hàng.");
  const schedule = slotForInstant(now);
  const window = scheduleFor(schedule.slot, schedule.dateKey);
  const shiftCode = newShiftCode(schedule.slot, schedule.dateKey);
  const startedAt = now.toISOString();
  const workSessionId = crypto.randomUUID();
  await db.batch([
    db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ?").bind(shiftCode, startedAt, user.id),
    db.prepare("INSERT INTO shift_sessions (id, shift_code, shift_name, store_id, employee_id, started_at, scheduled_start_at, scheduled_end_at, work_session_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')")
      .bind(crypto.randomUUID(), shiftCode, schedule.slot.name, user.storeId, user.employeeId, startedAt, window.scheduledStartAt, window.scheduledEndAt, workSessionId),
  ]);
  await writeAudit(user.id, "SHIFT_START", "SHIFT", shiftCode, `${schedule.slot.name}; grace=${SHIFT_GRACE_MINUTES}m`);
  return stateFromRow(await findActiveRow(db, user.employeeId, shiftCode));
}

export async function ensureActiveShiftRollover(user: ActiveUser, db: Db, now = new Date()): Promise<ActiveShiftState> {
  if (!user.shiftActive || !user.employeeId || !user.storeId || !user.currentShift) return stateFromRow(null);
  let active = await ensureLegacyRow(user, db);
  if (!active) return stateFromRow(null);
  const rollovers: ShiftRolloverEvent[] = [];

  for (let guard = 0; guard < 12; guard += 1) {
    const schedule = active.scheduled_end_at
      ? {
          ...inferSchedule(String(active.scheduled_start_at ?? active.started_at), String(active.shift_code)),
          scheduledStartAt: String(active.scheduled_start_at ?? active.started_at),
          scheduledEndAt: String(active.scheduled_end_at),
        }
      : inferSchedule(String(active.started_at), String(active.shift_code));
    const scheduledEnd = new Date(schedule.scheduledEndAt);
    if (Number.isNaN(scheduledEnd.getTime()) || now.getTime() <= scheduledEnd.getTime() + GRACE_MS) break;

    const following = nextSchedule(schedule);
    const splitAt = schedule.scheduledEndAt;
    const nextCode = newShiftCode(following.slot, following.dateKey);
    const workSessionId = String(active.work_session_id ?? crypto.randomUUID());
    await db.batch([
      db.prepare("UPDATE shift_sessions SET ended_at = ?, status = 'AUTO_COMPLETED', auto_rolled = 1 WHERE id = ? AND ended_at IS NULL")
        .bind(splitAt, String(active.id)),
      db.prepare("INSERT INTO shift_sessions (id, shift_code, shift_name, store_id, employee_id, started_at, scheduled_start_at, scheduled_end_at, rollover_from, work_session_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')")
        .bind(crypto.randomUUID(), nextCode, following.slot.name, user.storeId, user.employeeId, splitAt, following.scheduledStartAt, following.scheduledEndAt, String(active.shift_code), workSessionId),
      db.prepare("UPDATE users SET current_shift = ?, shift_started_at = ?, shift_active = 1 WHERE id = ?")
        .bind(nextCode, splitAt, user.id),
    ]);

    const event = {
      fromCode: String(active.shift_code),
      fromName: String(active.shift_name ?? schedule.slot.name),
      toCode: nextCode,
      toName: following.slot.name,
      splitAt,
    };
    rollovers.push(event);
    await writeAudit(user.id, "SHIFT_AUTO_ROLLOVER", "SHIFT", nextCode, `${event.fromCode} -> ${event.toCode}; split=${splitAt}; grace=${SHIFT_GRACE_MINUTES}m`);
    active = await findActiveRow(db, user.employeeId, nextCode);
    if (!active) break;
  }

  return stateFromRow(active, rollovers);
}

export async function reconcileActiveShifts(db: Db, storeId?: string | null, now = new Date()) {
  const result = storeId
    ? await db.prepare("SELECT id, employee_id AS employeeId, store_id AS storeId, shift_active AS shiftActive, current_shift AS currentShift, shift_started_at AS shiftStartedAt FROM users WHERE role = 'EMPLOYEE' AND shift_active = 1 AND store_id = ?").bind(storeId).all()
    : await db.prepare("SELECT id, employee_id AS employeeId, store_id AS storeId, shift_active AS shiftActive, current_shift AS currentShift, shift_started_at AS shiftStartedAt FROM users WHERE role = 'EMPLOYEE' AND shift_active = 1").all();
  for (const row of result.results as unknown as ActiveUser[]) await ensureActiveShiftRollover(row, db, now);
}

export async function endEmployeeShift(user: ActiveUser, db: Db, tiktok: boolean, now = new Date()) {
  const current = await ensureActiveShiftRollover(user, db, now);
  if (!current.active || !user.employeeId || !current.shiftCode) throw new Error("Bạn chưa bắt đầu ca làm việc.");
  const endedAt = now.toISOString();
  const tiktokAllowance = tiktok ? 25_000 : 0;
  await db.batch([
    db.prepare("UPDATE shift_sessions SET ended_at = ?, tiktok = ?, tiktok_allowance = ?, status = 'COMPLETED' WHERE employee_id = ? AND shift_code = ? AND ended_at IS NULL")
      .bind(endedAt, tiktok ? 1 : 0, tiktokAllowance, user.employeeId, current.shiftCode),
    db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = ?").bind(user.id),
  ]);
  await writeAudit(user.id, "SHIFT_END", "SHIFT", current.shiftCode, tiktok ? "TikTok=1" : "TikTok=0");
  return { active: false, shiftCode: current.shiftCode, shiftName: current.shiftName, startedAt: current.startedAt, endedAt, tiktokAllowance, rollovers: current.rollovers };
}
