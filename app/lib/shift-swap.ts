import { isStorePeriodLocked } from "../api/_lib/store-period-lock";
import { scheduleActorAllowedSql } from "../../db/shift-swap";
import { validDailyShiftDate } from "./daily-shifts";
import { scheduleBatchPayloadHash } from "./schedule-batch";
import { shiftUtcRange } from "./scheduling";

export type ScheduleActor = { id: string; role: string; homeStoreId?: string | null; isSuperAdmin?: number };
export type ShiftSwapInput = {
  storeId: string; date: string; assignmentAId: string; assignmentBId: string;
  expectedVersionA: string; expectedVersionB: string; idempotencyKey: string; reason: string;
  expectedActorId?: string;
};
type ScheduleRow = { id: string; storeId: string; dataJson: string; updatedAt: string; status: string };
type Employee = { id: string; name: string; code: string };
export type ShiftSwapAssignment = {
  id: string; recordId: string; employeeId: string; shiftName: string; start: string; end: string;
  startAt: string; endAt: string; workDate: string; version: string; eligible: boolean; blockedReason: string | null;
};
export class ShiftSwapError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); this.name = "ShiftSwapError"; }
}

function dataOf(row: ScheduleRow): Record<string, unknown> {
  try { return JSON.parse(row.dataJson) as Record<string, unknown>; }
  catch { throw new ShiftSwapError("INVALID_SCHEDULE", "Lịch phân ca có dữ liệu không hợp lệ. Vui lòng kiểm tra lịch."); }
}
function idsOf(data: Record<string, unknown>) { return Array.isArray(data.employeeIds) ? data.employeeIds.map(String) : []; }

/** Slot identity belongs to the place in the schedule, not its current employee. */
export function scheduleAssignmentIds(recordId: string, data: Record<string, unknown>): string[] {
  const employees = idsOf(data);
  const slots = Array.isArray(data.assignmentIds) ? data.assignmentIds : [];
  if (slots.length === employees.length && slots.every((id) => typeof id === "string" && id.startsWith(`${recordId}:`))
    && new Set(slots).size === slots.length) return slots as string[];
  // Read-only compatibility: never rewrite historical schedules to assign IDs.
  return employees.map((_, index) => `${recordId}:${index}`);
}

/** Generic schedule edits retain the identity of each surviving assignment. */
export function retainScheduleAssignmentIds(recordId: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  const oldEmployees = idsOf(before);
  const oldSlots = scheduleAssignmentIds(recordId, before);
  return idsOf(after).map((employee) => {
    const index = oldEmployees.indexOf(employee);
    return index < 0 ? `${recordId}:${crypto.randomUUID()}` : oldSlots[index];
  });
}

async function assertAccess(db: D1Database, actor: ScheduleActor, storeId: string) {
  if (!actor || !["MANAGER", "HTKD"].includes(actor.role)) throw new ShiftSwapError("FORBIDDEN", "Không có quyền đổi ca.", 403);
  const allowed = await db.prepare(`SELECT 1 AS allowed WHERE ${scheduleActorAllowedSql("?", "?")}`)
    // The expression repeats the store placeholder twice.
    .bind(actor.id, storeId, storeId).first();
  if (!allowed) throw new ShiftSwapError("FORBIDDEN", "Không có quyền truy cập lịch của cửa hàng này.", 403);
}

export async function listShiftSwapStores(db: D1Database, actor: ScheduleActor) {
  if (!actor || !["MANAGER", "HTKD"].includes(actor.role)) throw new ShiftSwapError("FORBIDDEN", "Không có quyền đổi ca.", 403);
  return (await db.prepare(`SELECT id,name,status FROM stores s WHERE ${scheduleActorAllowedSql("?", "s.id")} ORDER BY name`)
    .bind(actor.id).all<{ id: string; name: string; status: string }>()).results;
}

async function scheduleRows(db: D1Database, storeId: string, date: string) {
  return (await db.prepare(`SELECT id,store_id AS storeId,data_json AS dataJson,updated_at AS updatedAt,status
    FROM business_records WHERE category='LICH_PHAN_CA' AND store_id=? AND status NOT IN ('DELETED','VOID')
      AND json_extract(data_json,'$.date')=? ORDER BY json_extract(data_json,'$.start'),id`)
    .bind(storeId, date).all<ScheduleRow>()).results;
}

async function assignmentViews(row: ScheduleRow, now: string, blockedReason: string | null = null) {
  const data = dataOf(row);
  const workDate = String(data.date ?? "");
  const start = String(data.start ?? ""); const end = String(data.end ?? "");
  const range = shiftUtcRange(workDate, start, end);
  const version = await scheduleBatchPayloadHash({ dataJson: row.dataJson, updatedAt: row.updatedAt });
  const reason = blockedReason ?? (!range ? "Dữ liệu thời gian ca không hợp lệ."
    : Date.parse(range.startAt) <= Date.parse(now) ? "Ca đã bắt đầu, không thể đổi lịch dự kiến." : null);
  return idsOf(data).map((employeeId, index): ShiftSwapAssignment => ({
    id: scheduleAssignmentIds(row.id, data)[index], recordId: row.id, employeeId,
    shiftName: String(data.shiftName ?? ""), start, end, startAt: range?.startAt ?? "", endAt: range?.endAt ?? "",
    workDate, version, eligible: reason === null && row.status === "ACTIVE", blockedReason: reason,
  }));
}

export async function listShiftSwapAssignments(db: D1Database, actor: ScheduleActor, storeId: string, date: string, now = new Date().toISOString()) {
  await assertAccess(db, actor, storeId);
  if (!validDailyShiftDate(date)) throw new ShiftSwapError("INVALID_DATE", "Ngày làm việc không hợp lệ.", 400);
  const store = await db.prepare("SELECT status FROM stores WHERE id=?").bind(storeId).first<{ status: string }>();
  const employees = (await db.prepare(`SELECT e.id,e.name,e.code FROM employees e WHERE e.status='ACTIVE' AND (
    e.store_id=? OR EXISTS(SELECT 1 FROM employee_transfers t WHERE t.employee_id=e.id AND t.target_store_id=?
      AND t.status IN ('SCHEDULED','ACTIVE') AND t.start_date<=? AND t.end_date>=?)) ORDER BY e.name,e.id`)
    .bind(storeId, storeId, date, date).all<Employee>()).results;
  const rows = await scheduleRows(db, storeId, date);
  const locked = await isStorePeriodLocked(db, storeId, date.slice(0, 7));
  const assignments = (await Promise.all(rows.map(async (row) => {
    const data = dataOf(row);
    const range = shiftUtcRange(date, String(data.start), String(data.end));
    // Intervals are half open: a shift ending at 00:00 does not use the next day.
    const endPeriod = range ? new Date(Date.parse(range.endAt) - 1 + 7 * 3600_000).toISOString().slice(0, 7) : date.slice(0, 7);
    const overnightLocked = endPeriod !== date.slice(0, 7) && await isStorePeriodLocked(db, storeId, endPeriod);
    const attended = await db.prepare(`SELECT 1 FROM shift_sessions WHERE source_schedule_record_id=?
      OR (store_id=? AND work_date=? AND scheduled_start=? AND scheduled_end=?
        AND employee_id IN (SELECT value FROM json_each(?))) LIMIT 1`)
      .bind(row.id, storeId, date, String(data.start), String(data.end), JSON.stringify(idsOf(data))).first();
    return assignmentViews(row, now, store?.status !== "ACTIVE" ? "Cửa hàng đã ngừng hoạt động."
      : locked || overnightLocked ? "Kỳ tài chính của ca đã chốt hoặc khóa."
        : attended ? "Ca đã phát sinh chấm công, không thể đổi lịch dự kiến." : null);
  }))).flat().map((assignment) => employees.some((employee) => employee.id === assignment.employeeId) ? assignment
    : { ...assignment, eligible: false, blockedReason: "Nhân viên không còn hợp lệ tại cửa hàng trong ngày này." });
  return { actorId: actor.id, employees, assignments, serverTime: now };
}

type SwapResult = { ok: true; operationId: string; idempotent: boolean; assignments: ShiftSwapAssignment[] };

const conflictMessages: Record<string, string> = {
  STALE: "Lịch đã thay đổi. Vui lòng tải lại và chọn ca mới nhất.",
  STARTED: "Ca đã bắt đầu, không thể đổi lịch dự kiến.",
  ATTENDED: "Ca đã phát sinh chấm công, không thể đổi lịch dự kiến.",
  LOCKED: "Kỳ tài chính của ca đã chốt hoặc khóa.",
  OVERLAP: "Sau khi đổi, một trong hai nhân viên bị trùng lịch làm việc.",
  EMPLOYEE: "Nhân viên không còn hợp lệ tại cửa hàng trong ngày này.",
  INACTIVE: "Cửa hàng đã ngừng hoạt động.",
  FORBIDDEN: "Quyền đổi ca đã thay đổi. Vui lòng đăng nhập lại.",
  INCOMPLETE: "Không thể ghi trọn thao tác đổi ca. Cả hai lịch được giữ nguyên.",
};

export async function commitShiftSwap(db: D1Database, actor: ScheduleActor, rawInput: ShiftSwapInput, now = new Date().toISOString()): Promise<SwapResult> {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) throw new ShiftSwapError("INVALID_REQUEST", "Yêu cầu đổi ca không hợp lệ.", 400);
  const stringFields = ["storeId", "date", "assignmentAId", "assignmentBId", "expectedVersionA", "expectedVersionB", "idempotencyKey", "reason"] as const;
  if (stringFields.some((key) => typeof rawInput[key] !== "string" || rawInput[key].length > 1000)
    || (rawInput.expectedActorId !== undefined && typeof rawInput.expectedActorId !== "string")) {
    throw new ShiftSwapError("INVALID_REQUEST", "Yêu cầu đổi ca không hợp lệ.", 400);
  }
  const input = { ...rawInput, reason: String(rawInput.reason ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ") };
  await assertAccess(db, actor, input.storeId);
  if (input.expectedActorId && input.expectedActorId !== actor.id) throw new ShiftSwapError("ACTOR_CHANGED", "Tài khoản đăng nhập đã thay đổi. Vui lòng tải lại biểu mẫu đổi ca.", 403);
  if (!validDailyShiftDate(input.date) || !/^[a-zA-Z0-9:_-]{16,200}$/.test(input.idempotencyKey ?? "")
    || input.reason.length < 5 || input.reason.length > 500
    || !input.assignmentAId || !input.assignmentBId || !input.expectedVersionA || !input.expectedVersionB) {
    throw new ShiftSwapError("INVALID_REQUEST", "Vui lòng chọn đủ hai ca, nhập lý do từ 5 đến 500 ký tự và tải lại lịch nếu cần.", 400);
  }
  const payloadHash = await scheduleBatchPayloadHash(input);
  const replay = async (): Promise<SwapResult | null> => {
    const row = await db.prepare("SELECT payload_hash AS payloadHash,result_json AS resultJson,status FROM shift_swap_operations WHERE actor_id=? AND request_key=?")
      .bind(actor.id, input.idempotencyKey).first<{ payloadHash: string; resultJson: string; status: string }>();
    if (!row) return null;
    if (row.payloadHash !== payloadHash) throw new ShiftSwapError("IDEMPOTENCY_MISMATCH", "Mã yêu cầu đã được dùng cho nội dung khác.");
    if (row.status !== "COMPLETED") throw new ShiftSwapError("INCOMPLETE", conflictMessages.INCOMPLETE);
    return { ...JSON.parse(row.resultJson) as SwapResult, idempotent: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const rows = await scheduleRows(db, input.storeId, input.date);
  const find = (assignmentId: string) => rows.find((row) => scheduleAssignmentIds(row.id, dataOf(row)).includes(assignmentId));
  const a = find(input.assignmentAId); const b = find(input.assignmentBId);
  if (!a || !b) throw new ShiftSwapError("STALE", conflictMessages.STALE);
  if (a.id === b.id) throw new ShiftSwapError("NO_CHANGE", "Hai phân công phải thuộc hai vị trí ca khác nhau.", 400);
  const beforeA = dataOf(a); const beforeB = dataOf(b);
  const slotA = scheduleAssignmentIds(a.id, beforeA).indexOf(input.assignmentAId);
  const slotB = scheduleAssignmentIds(b.id, beforeB).indexOf(input.assignmentBId);
  const employeeA = idsOf(beforeA)[slotA]; const employeeB = idsOf(beforeB)[slotB];
  if (employeeA === employeeB) throw new ShiftSwapError("SAME_EMPLOYEE", "Phải chọn hai nhân viên khác nhau.", 400);
  const viewsA = await assignmentViews(a, now); const viewsB = await assignmentViews(b, now);
  if (viewsA[slotA].version !== input.expectedVersionA || viewsB[slotB].version !== input.expectedVersionB) throw new ShiftSwapError("STALE", conflictMessages.STALE);
  if (viewsA[slotA].startAt === viewsB[slotB].startAt && viewsA[slotA].endAt === viewsB[slotB].endAt) throw new ShiftSwapError("NO_CHANGE", "Hai ca có cùng thời gian, không cần đổi.", 400);
  if (!viewsA[slotA].eligible || !viewsB[slotB].eligible) throw new ShiftSwapError("STARTED", conflictMessages.STARTED);
  const names = (await db.prepare("SELECT id,name FROM employees WHERE id IN (?,?)").bind(employeeA, employeeB).all<{ id: string; name: string }>()).results;
  const after = (row: ScheduleRow, data: Record<string, unknown>, slot: number, employee: string) => {
    const employeeIds = idsOf(data); employeeIds[slot] = employee;
    const employeeNames = Array.isArray(data.employeeNames) ? data.employeeNames.map(String) : idsOf(data).map((id) => names.find((entry) => entry.id === id)?.name ?? id);
    employeeNames[slot] = names.find((entry) => entry.id === employee)?.name ?? employee;
    return { ...data, employeeIds, employeeNames, assignmentIds: scheduleAssignmentIds(row.id, data) };
  };
  const aAfter = JSON.stringify(after(a, beforeA, slotA, employeeB));
  const bAfter = JSON.stringify(after(b, beforeB, slotB, employeeA));
  // updated_at is also the existing attendance route's concurrency token.
  // Ensure a distinct value even for two changes within the same millisecond.
  const changedAt = new Date(Math.max(Date.parse(now), Date.parse(a.updatedAt) + 1, Date.parse(b.updatedAt) + 1)).toISOString();
  const operationId = crypto.randomUUID();
  const result: SwapResult = { ok: true, operationId, idempotent: false, assignments: [
    (await assignmentViews({ ...a, dataJson: aAfter, updatedAt: changedAt }, now))[slotA],
    (await assignmentViews({ ...b, dataJson: bAfter, updatedAt: changedAt }, now))[slotB],
  ] };
  try {
    await db.prepare(`INSERT INTO shift_swap_operations
      (id,actor_id,store_id,work_date,request_key,payload_hash,a_id,b_id,a_slot,b_slot,a_employee,b_employee,
        a_before,b_before,a_after,b_after,a_updated,b_updated,result_json,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      operationId, actor.id, input.storeId, input.date, input.idempotencyKey, payloadHash, a.id, b.id, slotA, slotB, employeeA, employeeB,
      a.dataJson, b.dataJson, aAfter, bAfter, a.updatedAt, b.updatedAt, JSON.stringify(result), input.reason, changedAt,
    ).run();
    const confirmed = await replay();
    if (!confirmed) throw new ShiftSwapError("INCOMPLETE", conflictMessages.INCOMPLETE);
    return { ...confirmed, idempotent: false };
  } catch (error) {
    // A duplicate key may be a concurrent successful request, or a response
    // lost after commit. Only its durable, actor-bound result permits replay.
    const committed = await replay();
    if (committed) return committed;
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/(?:SWAP|SCHEDULE)_([A-Z_]+)/u)?.[1];
    if (code && conflictMessages[code]) throw new ShiftSwapError(code, conflictMessages[code], code === "FORBIDDEN" ? 403 : 409);
    throw new ShiftSwapError("WRITE_FAILED", "Không thể hoàn tất đổi ca. Vui lòng thử lại cùng yêu cầu.", 500);
  }
}
