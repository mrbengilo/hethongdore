// This module accepts a D1 binding so the same domain runs in isolated workerd tests.
export type ScheduleDb = D1Database;
export type ScheduleActor = { id: string; role: string };
export class ScheduleError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function validDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new ScheduleError("INVALID_DATE", "Ngày không hợp lệ.", 400);
  return value;
}
export function requiredText(value: unknown, name: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ScheduleError("INVALID_INPUT", `Thiếu hoặc sai ${name}.`, 400);
  return value.trim();
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ScheduleError("INVALID_VERSION", "Thiếu phiên bản lịch. Vui lòng tải lại.", 400);
  return Number(value);
}
export function scheduleWindow(date: string, start: string, end: string) {
  validDate(date);
  if (![start, end].every((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)) || start === end) throw new ScheduleError("INVALID_TIME", "Giờ ca không hợp lệ hoặc thời lượng bằng 0.", 400);
  const from = new Date(`${date}T${start}:00+07:00`);
  const to = new Date(`${date}T${end}:00+07:00`);
  if (end < start) to.setUTCDate(to.getUTCDate() + 1);
  return { start: from.toISOString(), end: to.toISOString() };
}
export async function scopedStores(db: ScheduleDb, actor: ScheduleActor) {
  if (!["MANAGER", "STORE_MANAGER", "HTKD"].includes(actor.role)) throw new ScheduleError("FORBIDDEN", "Không có quyền quản lý lịch phân ca.", 403);
  const rows = await db.prepare(`SELECT s.id,s.name FROM stores s JOIN users u ON u.id=? WHERE s.status='ACTIVE' AND (u.role='MANAGER' OR (u.role IN ('STORE_MANAGER','HTKD') AND EXISTS (SELECT 1 FROM user_store_scopes p WHERE p.user_id=u.id AND p.store_id=s.id))) ORDER BY s.name`).bind(actor.id).all<{id:string;name:string}>();
  return rows.results;
}
export async function requireScope(db: ScheduleDb, actor: ScheduleActor, storeId: string) {
  if (!(await scopedStores(db, actor)).some((s) => s.id === storeId)) throw new ScheduleError("NOT_FOUND", "Không tìm thấy cửa hàng trong phạm vi được cấp.", 404);
}
export function databaseError(error: unknown): never {
  if (error instanceof ScheduleError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const errors: Record<string, string> = {
    SCHEDULE_CONFLICT: "Lịch đã thay đổi. Vui lòng tải lại lịch.",
    SCHEDULE_OVERLAP: "Ca sau đổi bị trùng hoặc chồng giờ với lịch khác.",
    SCHEDULE_STARTED: "Ca đã bắt đầu hoặc đã phát sinh chấm công; không thể sửa lịch dự kiến.",
    SCHEDULE_LOCKED: "Kỳ lương liên quan đã khóa; không thể sửa lịch.",
    SCHEDULE_ELIGIBILITY: "Nhân viên không còn hoạt động tại cửa hàng này.",
    SCHEDULE_FORBIDDEN: "Quyền thao tác đã bị thu hồi.",
    SCHEDULE_NOOP: "Hai ca giống nhau; không có thay đổi cần thực hiện.",
  };
  for (const [code, explanation] of Object.entries(errors)) if (message.includes(code)) throw new ScheduleError(code, explanation);
  // Do not expose SQL, identities or schema details to the caller.
  throw new ScheduleError("SCHEDULE_WRITE_FAILED", "Không thể ghi lịch. Vui lòng tải lại và thử lại.", 500);
}
export async function createDefinition(db: ScheduleDb, actor: ScheduleActor, body: Record<string, unknown>) {
  const storeId = requiredText(body.storeId, "cửa hàng");
  await requireScope(db, actor, storeId);
  const name = requiredText(body.name, "tên ca", 80);
  const start = requiredText(body.startTime, "giờ bắt đầu", 5), end = requiredText(body.endTime, "giờ kết thúc", 5);
  scheduleWindow("2030-01-01", start, end);
  const id = crypto.randomUUID();
  try { await db.prepare("INSERT INTO shift_definitions(id,store_id,name,start_time,end_time,created_by,created_at) VALUES(?,?,?,?,?,?,?)").bind(id, storeId, name, start, end, actor.id, new Date().toISOString()).run(); } catch (error) { databaseError(error); }
  return { id, store_id: storeId, name, start_time: start, end_time: end };
}
export async function createAssignment(db: ScheduleDb, actor: ScheduleActor, body: Record<string, unknown>) {
  const storeId = requiredText(body.storeId, "cửa hàng"), date = validDate(body.date);
  await requireScope(db, actor, storeId);
  const employeeId = requiredText(body.employeeId, "nhân viên"), definitionId = requiredText(body.definitionId, "ca");
  const definition = await db.prepare("SELECT * FROM shift_definitions WHERE id=? AND store_id=?").bind(definitionId, storeId).first<{name:string;start_time:string;end_time:string}>();
  if (!definition) throw new ScheduleError("NOT_FOUND", "Không tìm thấy ca.", 404);
  const window = scheduleWindow(date, definition.start_time, definition.end_time);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  try { await db.prepare(`INSERT INTO shift_assignments(id,store_id,employee_id,business_date,definition_id,shift_name,scheduled_start_at,scheduled_end_at,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, storeId, employeeId, date, definitionId, definition.name, window.start, window.end, actor.id, actor.id, now, now).run(); } catch (error) { databaseError(error); }
  return db.prepare("SELECT * FROM shift_assignments WHERE id=?").bind(id).first();
}
export async function cancelAssignment(db: ScheduleDb, actor: ScheduleActor, body: Record<string, unknown>) {
  const storeId = requiredText(body.storeId, "cửa hàng"), id = requiredText(body.assignmentId, "phân công"), expectedVersion = version(body.expectedVersion);
  await requireScope(db, actor, storeId);
  try {
    const result = await db.prepare("UPDATE shift_assignments SET status='CANCELLED',version=version+1,updated_by=?,updated_at=? WHERE id=? AND store_id=? AND version=? AND status='PLANNED' RETURNING id").bind(actor.id, new Date().toISOString(), id, storeId, expectedVersion).all();
    // D1 meta.changes also counts trigger audit writes; RETURNING counts the CAS row.
    if (result.results.length !== 1) throw new ScheduleError("SCHEDULE_CONFLICT", "Lịch đã thay đổi. Vui lòng tải lại.");
  } catch (error) { databaseError(error); }
  return { ok: true };
}
export async function swapAssignments(db: ScheduleDb, actor: ScheduleActor, body: Record<string, unknown>) {
  const storeId = requiredText(body.storeId, "cửa hàng"), date = validDate(body.date);
  await requireScope(db, actor, storeId);
  const a = requiredText(body.assignmentAId, "ca A"), b = requiredText(body.assignmentBId, "ca B");
  const va = version(body.expectedVersionA), vb = version(body.expectedVersionB);
  const key = requiredText(body.idempotencyKey, "mã yêu cầu");
  const reason = body.reason == null || body.reason === "" ? "Đổi lịch dự kiến giữa hai nhân viên theo yêu cầu quản lý" : requiredText(body.reason, "lý do", 500);
  if (a === b) throw new ScheduleError("INVALID_PAIR", "Phải chọn hai phân công khác nhau.", 400);
  const payload = JSON.stringify({ storeId, date, a, b, va, vb, reason });
  const saved = () => db.prepare("SELECT id,payload,result_json FROM shift_swaps WHERE actor_id=? AND idempotency_key=?").bind(actor.id,key).first<{id:string;payload:string;result_json:string}>();
  const replay = (row: {id:string;payload:string;result_json:string}) => {
    if (row.payload !== payload) throw new ScheduleError("IDEMPOTENCY_CONFLICT", "Mã yêu cầu đã được dùng cho nội dung khác.");
    return { operationId: row.id, assignments: JSON.parse(row.result_json), replayed: true };
  };
  const previous = await saved();
  if (previous) return replay(previous);
  // All predicates, both writes, audit and persisted response run in ONE SQLite
  // statement via the migration trigger. RAISE(ABORT) rolls the statement back,
  // including a failed second UPDATE; a zero-row CAS cannot silently half-commit.
  const id = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO shift_swaps(id,actor_id,store_id,business_date,assignment_a_id,assignment_b_id,version_a,version_b,idempotency_key,payload,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,actor.id,storeId,date,a,b,va,vb,key,payload,reason,new Date().toISOString()).run();
  } catch (error) {
    // Another request may have committed the same operation while we waited.
    // Replay its stored response rather than swapping the assignments back.
    const concurrent = await saved();
    if (concurrent) return replay(concurrent);
    databaseError(error);
  }
  const result = await saved();
  if (!result) throw new ScheduleError("UNKNOWN_RESULT", "Chưa xác định kết quả. Thử lại cùng yêu cầu.", 503);
  return { ...replay(result), replayed: false };
}
