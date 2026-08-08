import { initDb, writeAudit } from "../../../db/runtime";
import { durationMinutes, durationSeconds, formatVnd, isVnd, tenderDifferences, utcTimestamp } from "../../lib/finance";
import {
  DEFAULT_SHIFT_DEFINITIONS,
  nextShiftOccurrence,
  shiftUtcRange,
  shouldRollOverShift,
  type ShiftClockDefinition,
} from "../../lib/scheduling";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";

type ScheduleSnapshot = {
  name: string;
  start: string;
  end: string;
  workDate: string;
  startAt: string;
  endAt: string;
};

type ScheduleData = {
  date?: string;
  shiftName?: string;
  start?: string;
  end?: string;
  employeeIds?: string[];
};

type ActiveShiftSession = {
  id: string;
  shiftCode: string;
  storeId: string;
  employeeId: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  workDate: string | null;
  transferId: string | null;
  appliedHourlyRate: number | null;
  startedAt: string;
};

type ShiftRevenue = {
  paymentMethod: string;
  amount: number;
};

type RolloverResult = {
  rolledOver: boolean;
  active: boolean;
  shiftCode: string | null;
  startedAt: string | null;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  previousShiftCode?: string;
};

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
}

function localMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function isInsideShift(start: string, end: string, minute: number) {
  const from = timeMinutes(start);
  const to = timeMinutes(end);
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

function supportShiftLabel(schedule: ScheduleSnapshot) {
  const numbered = schedule.name.match(/(?:^|\s)([1-3])(?:\s|$)/)?.[1];
  if (numbered === "1") return "Ca sáng";
  if (numbered === "2") return "Ca chiều";
  if (numbered === "3") return "Ca tối";
  const start = timeMinutes(schedule.start);
  return start < 12 * 60 ? "Ca sáng" : start < 18 * 60 ? "Ca chiều" : "Ca tối";
}

async function resolveSchedule(db: Awaited<ReturnType<typeof initDb>>, storeId: string, employeeId: string): Promise<ScheduleSnapshot> {
  const workDate = localDate();
  const minute = localMinutes();
  const scheduled = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
    .bind(storeId).all<{ dataJson: string }>();
  const candidates = scheduled.results.flatMap((row) => {
    try {
      const data = JSON.parse(row.dataJson) as ScheduleData;
      return data.date === workDate && data.employeeIds?.includes(employeeId) && data.shiftName && data.start && data.end ? [data] : [];
    } catch { return []; }
  });
  const matched = candidates.find((item) => isInsideShift(item.start!, item.end!, minute)) ?? candidates[0];
  if (matched) {
    const range = shiftUtcRange(workDate, matched.start!, matched.end!);
    if (range) return { name: matched.shiftName!, start: matched.start!, end: matched.end!, workDate, ...range };
  }

  // Safe fallback for stores that have not configured a schedule yet.
  const fallback = DEFAULT_SHIFT_DEFINITIONS.find((item) => isInsideShift(item.start, item.end, minute)) ?? DEFAULT_SHIFT_DEFINITIONS[0];
  const range = shiftUtcRange(workDate, fallback.start, fallback.end);
  if (!range) throw new Error("Không thể xác định khoảng thời gian ca làm việc.");
  return { ...fallback, workDate, ...range };
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

async function loadShiftDefinitions(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
): Promise<ShiftClockDefinition[]> {
  const rows = await db.prepare("SELECT title, data_json AS dataJson FROM business_records WHERE category = 'CA_LAM_VIEC' AND store_id = ? AND status != 'DELETED' ORDER BY created_at, id")
    .bind(storeId).all<{ title: string; dataJson: string }>();
  const configured = rows.results.flatMap((row) => {
    try {
      const data = JSON.parse(row.dataJson) as { start?: string; end?: string };
      return typeof data.start === "string" && typeof data.end === "string"
        ? [{ name: row.title, start: data.start, end: data.end }]
        : [];
    } catch {
      return [];
    }
  });
  const normalized = (value: string) => value.trim().toLocaleLowerCase("vi-VN");
  const matched = new Set<number>();
  const defaults = DEFAULT_SHIFT_DEFINITIONS.map((fallback) => {
    const index = configured.findIndex((item) => normalized(item.name) === normalized(fallback.name));
    if (index >= 0) matched.add(index);
    return index >= 0 ? configured[index] : fallback;
  });
  return [...defaults, ...configured.filter((_, index) => !matched.has(index))];
}

function rolloverState(
  session: ActiveShiftSession,
  rolledOver: boolean,
  previousShiftCode?: string,
): RolloverResult {
  return {
    rolledOver,
    active: true,
    shiftCode: session.shiftCode,
    startedAt: session.startedAt,
    shiftName: session.shiftName,
    scheduledStart: session.scheduledStart,
    scheduledEnd: session.scheduledEnd,
    scheduledStartAt: session.scheduledStartAt,
    scheduledEndAt: session.scheduledEndAt,
    ...(previousShiftCode ? { previousShiftCode } : {}),
  };
}

async function findSuccessor(
  db: Awaited<ReturnType<typeof initDb>>,
  previousSessionId: string,
) {
  return db.prepare(`SELECT id,
      shift_code AS shiftCode,
      store_id AS storeId,
      employee_id AS employeeId,
      shift_name AS shiftName,
      scheduled_start AS scheduledStart,
      scheduled_end AS scheduledEnd,
      scheduled_start_at AS scheduledStartAt,
      scheduled_end_at AS scheduledEndAt,
      work_date AS workDate,
      transfer_id AS transferId,
      applied_hourly_rate AS appliedHourlyRate,
      started_at AS startedAt
    FROM shift_sessions
    WHERE previous_session_id = ? AND status = 'ACTIVE'
    ORDER BY started_at DESC LIMIT 1`)
    .bind(previousSessionId).first<ActiveShiftSession>();
}

async function reconcileActiveShift(
  db: Awaited<ReturnType<typeof initDb>>,
  user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  now = utcTimestamp(),
): Promise<RolloverResult | null> {
  if (user.role !== "EMPLOYEE" || !user.shiftActive || !user.currentShift || !user.employeeId) return null;

  const active = await db.prepare(`SELECT id,
      shift_code AS shiftCode,
      store_id AS storeId,
      employee_id AS employeeId,
      shift_name AS shiftName,
      scheduled_start AS scheduledStart,
      scheduled_end AS scheduledEnd,
      scheduled_start_at AS scheduledStartAt,
      scheduled_end_at AS scheduledEndAt,
      work_date AS workDate,
      transfer_id AS transferId,
      applied_hourly_rate AS appliedHourlyRate,
      started_at AS startedAt
    FROM shift_sessions
    WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE'
    LIMIT 1`)
    .bind(user.currentShift, user.employeeId).first<ActiveShiftSession>();

  if (!active) {
    const current = await db.prepare(`SELECT s.id,
        s.shift_code AS shiftCode,
        s.store_id AS storeId,
        s.employee_id AS employeeId,
        s.shift_name AS shiftName,
        s.scheduled_start AS scheduledStart,
        s.scheduled_end AS scheduledEnd,
        s.scheduled_start_at AS scheduledStartAt,
        s.scheduled_end_at AS scheduledEndAt,
        s.work_date AS workDate,
        s.transfer_id AS transferId,
        s.applied_hourly_rate AS appliedHourlyRate,
        s.started_at AS startedAt
      FROM users u JOIN shift_sessions s ON s.shift_code = u.current_shift
      WHERE u.id = ? AND u.shift_active = 1 AND s.status = 'ACTIVE'
      LIMIT 1`).bind(user.id).first<ActiveShiftSession>();
    return current ? rolloverState(current, current.shiftCode !== user.currentShift, user.currentShift) : null;
  }

  let scheduledStartAt = active.scheduledStartAt;
  let scheduledEndAt = active.scheduledEndAt;
  if ((!scheduledStartAt || !scheduledEndAt) && active.workDate && active.scheduledStart && active.scheduledEnd) {
    const legacyRange = shiftUtcRange(active.workDate, active.scheduledStart, active.scheduledEnd);
    scheduledStartAt = legacyRange?.startAt ?? null;
    scheduledEndAt = legacyRange?.endAt ?? null;
  }
  const hydratedActive = { ...active, scheduledStartAt, scheduledEndAt };
  if (!scheduledEndAt || !shouldRollOverShift(scheduledEndAt, now)) return rolloverState(hydratedActive, false);
  if (new Date(scheduledEndAt).getTime() < new Date(active.startedAt).getTime()) return rolloverState(hydratedActive, false);

  const existingSuccessor = await findSuccessor(db, active.id);
  if (existingSuccessor) {
    await db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ? AND current_shift = ?")
      .bind(existingSuccessor.shiftCode, existingSuccessor.startedAt, user.id, active.shiftCode).run();
    return rolloverState(existingSuccessor, true, active.shiftCode);
  }

  const definitions = await loadShiftDefinitions(db, active.storeId);
  const next = nextShiftOccurrence(scheduledEndAt, definitions)
    ?? nextShiftOccurrence(scheduledEndAt, DEFAULT_SHIFT_DEFINITIONS);
  if (!next) return rolloverState(hydratedActive, false);

  const revenueRows = await db.prepare(`SELECT payment_method AS paymentMethod, COALESCE(SUM(amount), 0) AS amount
      FROM orders
      WHERE store_id = ? AND employee_id = ? AND shift_code = ?
        AND status = 'COMPLETED' AND created_at < ?
      GROUP BY payment_method`)
    .bind(active.storeId, active.employeeId, active.shiftCode, scheduledEndAt).all<ShiftRevenue>();
  const cashRevenue = revenueRows.results
    .filter((row) => row.paymentMethod === "CASH")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const transferRevenue = revenueRows.results
    .filter((row) => row.paymentMethod === "BANK_TRANSFER")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const totalRevenue = cashRevenue + transferRevenue;
  const workedSeconds = durationSeconds(active.startedAt, scheduledEndAt);
  const nextSessionId = crypto.randomUUID();
  const nextShiftCode = `CA-AUTO-${active.id}`;

  const results = await db.batch([
    // This must run before the ACTIVE -> COMPLETED transition. D1 batches are
    // transactional, so a retry sees no ACTIVE predecessor and cannot count
    // the same revenue twice.
    db.prepare("UPDATE stores SET revenue = revenue + ? WHERE id = ? AND EXISTS (SELECT 1 FROM shift_sessions WHERE id = ? AND status = 'ACTIVE')")
      .bind(totalRevenue, active.storeId, active.id),
    db.prepare(`UPDATE shift_sessions SET
        scheduled_start_at = COALESCE(scheduled_start_at, ?),
        scheduled_end_at = COALESCE(scheduled_end_at, ?),
        ended_at = ?, duration_seconds = ?, cash_revenue = ?, transfer_revenue = ?,
        close_reason = 'AUTO_ROLLOVER', close_status = 'PENDING', status = 'COMPLETED'
      WHERE id = ? AND status = 'ACTIVE'`)
      .bind(scheduledStartAt, scheduledEndAt, scheduledEndAt, workedSeconds, cashRevenue, transferRevenue, active.id),
    db.prepare("UPDATE orders SET shift_code = ? WHERE store_id = ? AND employee_id = ? AND shift_code = ? AND created_at >= ?")
      .bind(nextShiftCode, active.storeId, active.employeeId, active.shiftCode, scheduledEndAt),
    db.prepare(`INSERT INTO shift_sessions (
        id, shift_code, store_id, employee_id, shift_name,
        scheduled_start, scheduled_end, scheduled_start_at, scheduled_end_at,
        work_date, transfer_id, applied_hourly_rate, started_at,
        previous_session_id, close_reason, close_status, status
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', 'ACTIVE'
      WHERE NOT EXISTS (SELECT 1 FROM shift_sessions WHERE previous_session_id = ?)`)
      .bind(
        nextSessionId, nextShiftCode, active.storeId, active.employeeId, next.name,
        next.start, next.end, next.startAt, next.endAt,
        next.workDate, active.transferId, active.appliedHourlyRate, scheduledEndAt,
        active.id, active.id,
      ),
    db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ? AND current_shift = ?")
      .bind(nextShiftCode, scheduledEndAt, user.id, active.shiftCode),
  ]);

  const closedByThisRequest = affectedRows(results[1]) > 0;
  const successor = await findSuccessor(db, active.id);
  if (!successor) return rolloverState(hydratedActive, false);
  if (closedByThisRequest) {
    await writeAudit(user.id, "SHIFT_AUTO_ROLLOVER", "SHIFT", active.shiftCode, JSON.stringify({
      previousSessionId: active.id,
      nextSessionId: successor.id,
      nextShiftCode: successor.shiftCode,
      boundaryAt: scheduledEndAt,
      cashRevenue,
      transferRevenue,
      workedSeconds,
    }));
  }
  return rolloverState(successor, true, active.shiftCode);
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  const db = await initDb();
  const reconciled = await reconcileActiveShift(db, user);
  if (reconciled) return json(reconciled);
  return json({
    rolledOver: false,
    active: Boolean(user.shiftActive),
    shiftCode: user.currentShift,
    startedAt: user.shiftStartedAt,
    shiftName: user.currentShiftName,
    scheduledStart: user.scheduledStart,
    scheduledEnd: user.scheduledEnd,
    scheduledStartAt: null,
    scheduledEndAt: null,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  if (!await isStoreActive(user.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const body = await request.json().catch(() => ({})) as {
    action?: "start" | "end";
    tiktok?: boolean;
    tasksCompleted?: boolean;
    expenseAmount?: number;
    expenseNote?: string;
    cashRevenue?: number;
    transferRevenue?: number;
  };
  const db = await initDb();

  if (body.action === "start") {
    if (!user.storeId || !user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên và cửa hàng." }, 409);
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    const schedule = await resolveSchedule(db, user.storeId, user.employeeId);
    const shiftCode = `CA-${schedule.workDate}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const startedAt = utcTimestamp();
    const transfer = user.activeTransferId
      ? await db.prepare("SELECT support_hourly_rate AS rate, shifts_json AS shiftsJson FROM employee_transfers WHERE id = ? AND status IN ('SCHEDULED', 'ACTIVE') LIMIT 1")
        .bind(user.activeTransferId).first<{ rate: number; shiftsJson: string }>()
      : null;
    if (transfer) {
      let allowedShifts: string[] = [];
      try { allowedShifts = JSON.parse(transfer.shiftsJson) as string[]; } catch { allowedShifts = []; }
      const currentLabel = supportShiftLabel(schedule);
      if (!allowedShifts.includes("Cả ngày") && !allowedShifts.includes(currentLabel)) {
        return json({ message: `Điều chuyển hỗ trợ không áp dụng cho ${currentLabel}. Vui lòng kiểm tra lịch đã được duyệt.` }, 403);
      }
    }
    const supportRate = transfer?.rate ?? null;
    const employeeRate = (await db.prepare("SELECT hourly_rate AS rate FROM employees WHERE id = ? LIMIT 1").bind(user.employeeId).first<{ rate: number }>())?.rate ?? 0;
    const appliedHourlyRate = Number(supportRate ?? employeeRate);
    const sessionId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ? AND shift_active = 0").bind(shiftCode, startedAt, user.id),
      db.prepare(`INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end, scheduled_start_at, scheduled_end_at, work_date, transfer_id, applied_hourly_rate, started_at, previous_session_id, close_reason, close_status, status)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'OPEN', 'ACTIVE'
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND shift_active = 1 AND current_shift = ?)`)
        .bind(sessionId, shiftCode, user.storeId, user.employeeId, schedule.name, schedule.start, schedule.end, schedule.startAt, schedule.endAt, schedule.workDate, user.activeTransferId, appliedHourlyRate, startedAt, user.id, shiftCode),
    ]);
    if (affectedRows(results[1]) === 0) return json({ message: "Bạn đã có một ca đang hoạt động. Vui lòng tải lại trang." }, 409);
    await writeAudit(user.id, "SHIFT_START", "SHIFT", shiftCode, JSON.stringify({ storeId: user.storeId, transferId: user.activeTransferId, shiftName: schedule.name }));
    return json({
      rolledOver: false,
      active: true,
      shiftCode,
      startedAt,
      shiftName: schedule.name,
      scheduledStart: schedule.start,
      scheduledEnd: schedule.end,
      scheduledStartAt: schedule.startAt,
      scheduledEndAt: schedule.endAt,
    });
  }

  if (body.action === "end") {
    if (!user.shiftActive || !user.currentShift || !user.employeeId) return json({ message: "Bạn chưa bắt đầu ca làm việc." }, 409);
    const activeSession = await db.prepare("SELECT id, store_id AS storeId, work_date AS workDate, shift_name AS shiftName, started_at AS startedAt FROM shift_sessions WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(user.currentShift, user.employeeId).first<{ id: string; storeId: string; workDate: string | null; shiftName: string | null; startedAt: string }>();
    if (!activeSession) return json({ message: "Không tìm thấy phiên ca đang hoạt động. Vui lòng tải lại trang hoặc liên hệ quản lý." }, 409);
    if (!body.tasksCompleted) return json({ message: "Bạn phải hoàn thành tất cả công việc trước khi kết ca." }, 400);
    if (body.expenseAmount === undefined || body.expenseAmount === null || body.cashRevenue === undefined || body.cashRevenue === null || body.transferRevenue === undefined || body.transferRevenue === null) {
      return json({ message: "Vui lòng nhập chi phí, tiền mặt và chuyển khoản trước khi kết ca (nhập 0 nếu không phát sinh)." }, 400);
    }
    const expenseAmount = Number(body.expenseAmount);
    const cashRevenue = Number(body.cashRevenue);
    const transferRevenue = Number(body.transferRevenue);
    if (![expenseAmount, cashRevenue, transferRevenue].every((value) => isVnd(value) && value >= 0)) return json({ message: "Doanh thu và chi phí phải là số nguyên VND không âm." }, 400);
    if (expenseAmount > 0 && !body.expenseNote?.trim()) return json({ message: "Vui lòng nhập nội dung chi phí phát sinh." }, 400);

    // Verify persisted manager-assigned tasks whenever they exist. The client flag
    // remains the fallback for stores still using the default checklist.
    const taskRows = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'TASKS' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
      .bind(activeSession.storeId).all<{ dataJson: string }>();
    const assignedItems = taskRows.results.flatMap((row) => {
      try {
        const data = JSON.parse(row.dataJson) as { date?: string; shift?: string; items?: Array<{ completedBy?: string[] }> };
        const dateMatches = !data.date || data.date === (activeSession.workDate ?? localDate());
        const shiftMatches = !data.shift || !activeSession.shiftName || data.shift.toLocaleLowerCase("vi-VN").includes(activeSession.shiftName.toLocaleLowerCase("vi-VN"));
        return dateMatches && shiftMatches ? (data.items ?? []) : [];
      } catch { return []; }
    });
    if (assignedItems.some((item) => !item.completedBy?.includes(user.id))) return json({ message: "Bạn phải hoàn thành tất cả công việc được giao trước khi kết ca." }, 400);

    const orderRows = await db.prepare(`
      SELECT payment_method AS paymentMethod, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
      FROM orders
      WHERE store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'
      GROUP BY payment_method
    `).bind(activeSession.storeId, user.employeeId, user.currentShift)
      .all<{ paymentMethod: string; count: number; amount: number }>();
    const orderCount = orderRows.results.reduce((total, row) => total + Number(row.count), 0);
    const expectedTender = orderRows.results.reduce((totals, row) => {
      if (row.paymentMethod === "CASH") totals.cash += Number(row.amount);
      if (row.paymentMethod === "BANK_TRANSFER") totals.bankTransfer += Number(row.amount);
      return totals;
    }, { cash: 0, bankTransfer: 0 });
    if (cashRevenue + transferRevenue > 0 && orderCount === 0) {
      return json({ message: "Doanh thu lớn hơn 0. Vui lòng nhập ít nhất một đơn hàng trước khi kết ca." }, 400);
    }
    const enteredTender = { cash: cashRevenue, bankTransfer: transferRevenue };
    const differences = tenderDifferences(expectedTender, enteredTender);
    if (differences.cash !== 0 || differences.bankTransfer !== 0) {
      return json({
        message: [
          "Đối soát doanh thu chưa khớp với đơn hàng trong ca.",
          `Tiền mặt: đơn hàng ${formatVnd(expectedTender.cash)}, đã nhập ${formatVnd(enteredTender.cash)}, chênh lệch ${formatVnd(differences.cash)}.`,
          `Chuyển khoản: đơn hàng ${formatVnd(expectedTender.bankTransfer)}, đã nhập ${formatVnd(enteredTender.bankTransfer)}, chênh lệch ${formatVnd(differences.bankTransfer)}.`,
        ].join(" "),
        reconciliation: { expected: expectedTender, entered: enteredTender, differences, orderCount },
      }, 409);
    }

    const allowance = body.tiktok ? 25000 : 0;
    const endedAt = utcTimestamp();
    const workedSeconds = durationSeconds(activeSession.startedAt, endedAt);
    const workedMinutes = durationMinutes(workedSeconds);
    const results = await db.batch([
      db.prepare("UPDATE stores SET revenue = revenue + ?, expense = expense + ? WHERE id = ? AND EXISTS (SELECT 1 FROM shift_sessions WHERE id = ? AND status = 'ACTIVE')")
        .bind(cashRevenue + transferRevenue, expenseAmount, activeSession.storeId, activeSession.id),
      db.prepare("UPDATE shift_sessions SET ended_at = ?, duration_seconds = ?, tiktok = ?, tiktok_allowance = ?, tasks_completed = 1, expense_amount = ?, expense_note = ?, cash_revenue = ?, transfer_revenue = ?, close_reason = 'MANUAL', close_status = 'CONFIRMED', status = 'COMPLETED' WHERE id = ? AND status = 'ACTIVE'")
        .bind(endedAt, workedSeconds, body.tiktok ? 1 : 0, allowance, expenseAmount, body.expenseNote?.trim() || null, cashRevenue, transferRevenue, activeSession.id),
      db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = ? AND current_shift = ?").bind(user.id, user.currentShift),
    ]);
    if (affectedRows(results[1]) === 0) return json({ message: "Ca làm đã được kết thúc bởi một yêu cầu khác. Vui lòng tải lại trang." }, 409);
    await writeAudit(user.id, "SHIFT_END", "SHIFT", user.currentShift, JSON.stringify({ tiktok: Boolean(body.tiktok), expenseAmount, cashRevenue, transferRevenue, orderCount, workedSeconds, workedMinutes }));
    return json({
      active: false,
      endedAt,
      message: "Đã kết ca và ghi nhận lịch sử ca làm.",
      tiktokAllowance: allowance,
      expenseAmount,
      cashRevenue,
      transferRevenue,
      totalRevenue: cashRevenue + transferRevenue,
      workedSeconds,
      workedMinutes,
    });
  }

  return json({ message: "Thao tác không hợp lệ." }, 400);
}
