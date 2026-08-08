import { initDb, writeAudit } from "../../../db/runtime";
import { durationMinutes, durationSeconds, formatVnd, isVnd, tenderDifferences, utcTimestamp } from "../../lib/finance";
import {
  addDays,
  DEFAULT_SHIFT_DEFINITIONS,
  nextShiftOccurrence,
  shiftOccurrenceAt,
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

type RolloverTransferPermission = {
  employeeId: string;
  targetStoreId: string;
  startDate: string;
  endDate: string;
  shiftsJson: string;
  status: string;
  employeeStatus: string;
  targetStoreStatus: string;
};

type RolloverResult = {
  rolledOver: boolean;
  rolloverPending: boolean;
  active: boolean;
  shiftCode: string | null;
  startedAt: string | null;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  rolloverBlocked?: boolean;
  message?: string;
  previousShiftCode?: string;
  nextShift?: {
    name: string;
    start: string;
    end: string;
    workDate: string;
  };
};

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
}

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function supportShiftLabel(schedule: ScheduleSnapshot) {
  const numbered = schedule.name.match(/(?:^|\s)([1-3])(?:\s|$)/)?.[1];
  if (numbered === "1") return "Ca sáng";
  if (numbered === "2") return "Ca chiều";
  if (numbered === "3") return "Ca tối";
  const start = timeMinutes(schedule.start);
  return start < 12 * 60 ? "Ca sáng" : start < 18 * 60 ? "Ca chiều" : "Ca tối";
}

const SUPPORT_ROLLOVER_BLOCKED_MESSAGE = "Quyền hỗ trợ không còn áp dụng cho ca tiếp theo. Vui lòng kết ca hiện tại; hệ thống sẽ tự trở về cửa hàng chính.";

const rolloverAccessSql = `
  EXISTS (SELECT 1 FROM employees approved_employee WHERE approved_employee.id = ? AND approved_employee.status = 'ACTIVE')
  AND EXISTS (SELECT 1 FROM stores approved_store WHERE approved_store.id = ? AND approved_store.status = 'ACTIVE')
  AND (? IS NULL OR EXISTS (
    SELECT 1 FROM employee_transfers approved_transfer
    WHERE approved_transfer.id = ?
      AND approved_transfer.employee_id = ?
      AND approved_transfer.target_store_id = ?
      AND approved_transfer.status IN ('SCHEDULED', 'ACTIVE')
      AND approved_transfer.start_date <= ? AND approved_transfer.end_date >= ?
      AND EXISTS (
        SELECT 1 FROM json_each(approved_transfer.shifts_json) approved_shift
        WHERE CAST(approved_shift.value AS TEXT) IN ('Cả ngày', ?)
      )
  ))`;

function rolloverAccessBindings(active: ActiveShiftSession, next: ScheduleSnapshot) {
  return [
    active.employeeId,
    active.storeId,
    active.transferId,
    active.transferId,
    active.employeeId,
    active.storeId,
    next.workDate,
    next.workDate,
    supportShiftLabel(next),
  ];
}

async function hasRolloverAccess(
  db: Awaited<ReturnType<typeof initDb>>,
  active: ActiveShiftSession,
  next: ScheduleSnapshot,
) {
  const operatingContext = await db.prepare(`SELECT
      e.status AS employeeStatus, target.status AS targetStoreStatus
    FROM employees e JOIN stores target ON target.id = ?
    WHERE e.id = ? LIMIT 1`)
    .bind(active.storeId, active.employeeId)
    .first<{ employeeStatus: string; targetStoreStatus: string }>();
  if (operatingContext?.employeeStatus !== "ACTIVE" || operatingContext.targetStoreStatus !== "ACTIVE") return false;
  if (!active.transferId) return true;

  const transfer = await db.prepare(`SELECT
      t.employee_id AS employeeId, t.target_store_id AS targetStoreId,
      t.start_date AS startDate, t.end_date AS endDate, t.shifts_json AS shiftsJson,
      t.status, e.status AS employeeStatus, target.status AS targetStoreStatus
    FROM employee_transfers t
    JOIN employees e ON e.id = t.employee_id
    JOIN stores target ON target.id = t.target_store_id
    WHERE t.id = ? LIMIT 1`)
    .bind(active.transferId).first<RolloverTransferPermission>();
  if (!transfer
    || transfer.employeeId !== active.employeeId
    || transfer.targetStoreId !== active.storeId
    || !["SCHEDULED", "ACTIVE"].includes(transfer.status)
    || transfer.employeeStatus !== "ACTIVE"
    || transfer.targetStoreStatus !== "ACTIVE"
    || transfer.startDate > next.workDate
    || transfer.endDate < next.workDate) return false;
  let allowedShifts: string[] = [];
  try {
    const parsed = JSON.parse(transfer.shiftsJson) as unknown;
    allowedShifts = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    allowedShifts = [];
  }
  const label = supportShiftLabel(next);
  return allowedShifts.includes("Cả ngày") || allowedShifts.includes(label);
}

async function hasAtomicRolloverAccess(
  db: Awaited<ReturnType<typeof initDb>>,
  active: ActiveShiftSession,
  next: ScheduleSnapshot,
) {
  const result = await db.prepare(`SELECT 1 AS allowed WHERE ${rolloverAccessSql}`)
    .bind(...rolloverAccessBindings(active, next)).first<{ allowed: number }>();
  return result?.allowed === 1;
}

async function resolveSchedule(db: Awaited<ReturnType<typeof initDb>>, storeId: string, employeeId: string): Promise<ScheduleSnapshot> {
  const now = new Date();
  const workDate = localDate(now);
  const previousDate = addDays(workDate, -1);
  const nowTime = now.getTime();
  const scheduled = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
    .bind(storeId).all<{ dataJson: string }>();
  const candidates = scheduled.results.flatMap((row): ScheduleSnapshot[] => {
    try {
      const data = JSON.parse(row.dataJson) as ScheduleData;
      if (![workDate, previousDate].includes(data.date ?? "") || !data.employeeIds?.includes(employeeId) || !data.shiftName || !data.start || !data.end) return [];
      const range = shiftUtcRange(data.date!, data.start, data.end);
      return range ? [{ name: data.shiftName, start: data.start, end: data.end, workDate: data.date!, ...range }] : [];
    } catch { return []; }
  });
  const matched = candidates.find((item) => nowTime >= new Date(item.startAt).getTime() && nowTime < new Date(item.endAt).getTime());
  if (matched) return matched;

  // A schedule explicitly assigned for today is authoritative. Do not fall
  // back to another store clock before the assigned next shift begins.
  if (candidates.some((item) => item.workDate === workDate)) {
    const next = candidates
      .filter((item) => new Date(item.startAt).getTime() > nowTime)
      .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())[0];
    const suffix = next ? ` Ca tiếp theo bắt đầu lúc ${next.start}.` : "";
    throw new Error(`Chưa đến thời gian bắt đầu ca làm việc.${suffix}`);
  }

  // If no assignment exists, use this store's configured clocks. The global
  // defaults are only returned by loadShiftDefinitions for an empty store.
  const definitions = await loadShiftDefinitions(db, storeId);
  const fallback = shiftOccurrenceAt(now, definitions);
  if (fallback) return fallback;
  const next = nextShiftOccurrence(now.toISOString(), definitions);
  const suffix = next ? ` Ca tiếp theo bắt đầu lúc ${next.start}.` : "";
  throw new Error(`Chưa đến thời gian bắt đầu ca làm việc.${suffix}`);
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
  // Once a store has configured its own shifts, that list is authoritative.
  // Defaults are only for legacy stores that do not have any shift records yet.
  return configured.length > 0 ? configured : DEFAULT_SHIFT_DEFINITIONS;
}

function rolloverState(
  session: ActiveShiftSession,
  rolledOver: boolean,
  previousShiftCode?: string,
  pending?: RolloverResult["nextShift"],
): RolloverResult {
  return {
    rolledOver,
    rolloverPending: Boolean(pending),
    active: true,
    shiftCode: session.shiftCode,
    startedAt: session.startedAt,
    shiftName: session.shiftName,
    scheduledStart: session.scheduledStart,
    scheduledEnd: session.scheduledEnd,
    scheduledStartAt: session.scheduledStartAt,
    scheduledEndAt: session.scheduledEndAt,
    ...(previousShiftCode ? { previousShiftCode } : {}),
    ...(pending ? { nextShift: pending } : {}),
  };
}

function blockedRolloverState(session: ActiveShiftSession): RolloverResult {
  return {
    ...rolloverState(session, false),
    rolloverBlocked: true,
    message: SUPPORT_ROLLOVER_BLOCKED_MESSAGE,
  };
}

function sessionScheduleSnapshot(session: ActiveShiftSession): ScheduleSnapshot | null {
  if (!session.shiftName || !session.scheduledStart || !session.scheduledEnd
    || !session.scheduledStartAt || !session.scheduledEndAt || !session.workDate) return null;
  return {
    name: session.shiftName,
    start: session.scheduledStart,
    end: session.scheduledEnd,
    startAt: session.scheduledStartAt,
    endAt: session.scheduledEndAt,
    workDate: session.workDate,
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
  confirmRollover = false,
  rolloverTikTok = false,
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
    const existingSchedule = sessionScheduleSnapshot(existingSuccessor);
    if (!existingSchedule || !await hasRolloverAccess(db, active, existingSchedule)) return blockedRolloverState(hydratedActive);
    const pointerUpdate = await db.prepare(`UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ?
      WHERE id = ? AND current_shift = ? AND ${rolloverAccessSql}`)
      .bind(
        existingSuccessor.shiftCode, existingSuccessor.startedAt, user.id, active.shiftCode,
        ...rolloverAccessBindings(active, existingSchedule),
      ).run();
    if (affectedRows(pointerUpdate) === 0) return blockedRolloverState(hydratedActive);
    return rolloverState(existingSuccessor, true, active.shiftCode);
  }

  const definitions = await loadShiftDefinitions(db, active.storeId);
  const next = nextShiftOccurrence(scheduledEndAt, definitions)
    ?? nextShiftOccurrence(scheduledEndAt, DEFAULT_SHIFT_DEFINITIONS);
  if (!next) return rolloverState(hydratedActive, false);
  if (!await hasRolloverAccess(db, active, next)) return blockedRolloverState(hydratedActive);

  // Polling only reports that a decision is due. The employee must explicitly
  // choose "Có" before any attendance, revenue, order or user row is changed.
  if (!confirmRollover) {
    return rolloverState(hydratedActive, false, undefined, {
      name: next.name,
      start: next.start,
      end: next.end,
      workDate: next.workDate,
    });
  }

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
  const tiktokAllowance = rolloverTikTok ? 25000 : 0;
  const nextSessionId = crypto.randomUUID();
  const nextShiftCode = `CA-TIEP-${active.id}`;

  const results = await db.batch([
    // Create the guarded successor first. The remaining statements require
    // that row, and D1 executes the entire batch transactionally; therefore a
    // revoked transfer can never close or charge the predecessor on its own.
    db.prepare(`INSERT INTO shift_sessions (
        id, shift_code, store_id, employee_id, shift_name,
        scheduled_start, scheduled_end, scheduled_start_at, scheduled_end_at,
        work_date, transfer_id, applied_hourly_rate, started_at,
        previous_session_id, close_reason, close_status, status
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', 'ACTIVE'
      WHERE EXISTS (
          SELECT 1 FROM shift_sessions predecessor
          WHERE predecessor.id = ? AND predecessor.status = 'ACTIVE'
        )
        AND NOT EXISTS (SELECT 1 FROM shift_sessions WHERE previous_session_id = ?)
        AND ${rolloverAccessSql}`)
      .bind(
        nextSessionId, nextShiftCode, active.storeId, active.employeeId, next.name,
        next.start, next.end, next.startAt, next.endAt,
        next.workDate, active.transferId, active.appliedHourlyRate, scheduledEndAt,
        active.id, active.id, active.id,
        ...rolloverAccessBindings(active, next),
      ),
    db.prepare(`UPDATE stores SET revenue = revenue + ?
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM shift_sessions predecessor WHERE predecessor.id = ? AND predecessor.status = 'ACTIVE')
        AND EXISTS (SELECT 1 FROM shift_sessions successor WHERE successor.previous_session_id = ? AND successor.status = 'ACTIVE')
        AND ${rolloverAccessSql}`)
      .bind(totalRevenue, active.storeId, active.id, active.id, ...rolloverAccessBindings(active, next)),
    db.prepare(`UPDATE shift_sessions SET
        scheduled_start_at = COALESCE(scheduled_start_at, ?),
        scheduled_end_at = COALESCE(scheduled_end_at, ?),
        ended_at = ?, duration_seconds = ?, cash_revenue = ?, transfer_revenue = ?,
        tiktok = ?, tiktok_allowance = ?, tasks_completed = 1,
        close_reason = 'CONTINUE_NEXT_SHIFT', close_status = 'PENDING', status = 'COMPLETED'
      WHERE id = ? AND status = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM shift_sessions successor WHERE successor.previous_session_id = ? AND successor.status = 'ACTIVE')
        AND ${rolloverAccessSql}`)
      .bind(
        scheduledStartAt, scheduledEndAt, scheduledEndAt, workedSeconds, cashRevenue, transferRevenue,
        rolloverTikTok ? 1 : 0, tiktokAllowance, active.id, active.id,
        ...rolloverAccessBindings(active, next),
      ),
    db.prepare(`UPDATE orders SET shift_code = ? WHERE store_id = ? AND employee_id = ? AND shift_code = ? AND created_at >= ?
        AND EXISTS (
          SELECT 1 FROM shift_sessions successor
          WHERE successor.previous_session_id = ? AND successor.status = 'ACTIVE'
        )`)
      .bind(nextShiftCode, active.storeId, active.employeeId, active.shiftCode, scheduledEndAt, active.id),
    db.prepare(`UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ?
      WHERE id = ? AND current_shift = ?
        AND EXISTS (
          SELECT 1 FROM shift_sessions successor
          WHERE successor.previous_session_id = ? AND successor.shift_code = ? AND successor.status = 'ACTIVE'
        )`)
      .bind(nextShiftCode, scheduledEndAt, user.id, active.shiftCode, active.id, nextShiftCode),
  ]);

  const successorCreated = affectedRows(results[0]) > 0;
  const closedByThisRequest = affectedRows(results[2]) > 0;
  const successor = await findSuccessor(db, active.id);
  if (!successor) {
    if (successorCreated || closedByThisRequest) {
      throw new Error("Không thể hoàn tất chuyển ca an toàn; phiên ca hiện tại được giữ nguyên.");
    }
    if (!await hasAtomicRolloverAccess(db, active, next)) return blockedRolloverState(hydratedActive);
    return rolloverState(hydratedActive, false);
  }
  if (closedByThisRequest) {
    await writeAudit(user.id, "SHIFT_CONFIRMED_ROLLOVER", "SHIFT", active.shiftCode, JSON.stringify({
      previousSessionId: active.id,
      nextSessionId: successor.id,
      nextShiftCode: successor.shiftCode,
      boundaryAt: scheduledEndAt,
      cashRevenue,
      transferRevenue,
      tiktok: rolloverTikTok,
      tiktokAllowance,
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
  if (reconciled) return json({
    ...reconciled,
    storeId: user.storeId,
    storeName: user.storeName,
    activeTransferId: user.activeTransferId,
    isSupporting: user.isSupporting,
  });
  return json({
    rolledOver: false,
    rolloverPending: false,
    active: Boolean(user.shiftActive),
    shiftCode: user.currentShift,
    startedAt: user.shiftStartedAt,
    shiftName: user.currentShiftName,
    scheduledStart: user.scheduledStart,
    scheduledEnd: user.scheduledEnd,
    scheduledStartAt: null,
    scheduledEndAt: null,
    storeId: user.storeId,
    storeName: user.storeName,
    activeTransferId: user.activeTransferId,
    isSupporting: user.isSupporting,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  if (!await isStoreActive(user.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const body = await request.json().catch(() => ({})) as {
    action?: "start" | "end" | "rollover";
    expectedShiftCode?: string;
    tiktok?: boolean;
    tasksCompleted?: boolean;
    expenseAmount?: number;
    expenseNote?: string;
    cashRevenue?: number;
    transferRevenue?: number;
    earlyEndConfirmed?: boolean;
  };
  const db = await initDb();

  if (body.action === "rollover") {
    if (!user.shiftActive || !user.currentShift || !user.employeeId) {
      return json({ message: "Bạn chưa có ca đang hoạt động để chuyển tiếp." }, 409);
    }

    // A repeated confirmation may arrive after the first request already
    // moved the user's pointer. Return the current ACTIVE session instead of
    // creating another successor.
    if (body.expectedShiftCode && body.expectedShiftCode !== user.currentShift) {
      const current = await reconcileActiveShift(db, user);
      if (current?.rolloverBlocked) {
        return json({ ...current, message: current.message ?? SUPPORT_ROLLOVER_BLOCKED_MESSAGE }, 409);
      }
      if (current) return json({
        ...current,
        rolledOver: true,
        rolloverPending: false,
        previousShiftCode: body.expectedShiftCode,
        message: "Đã chuyển sang ca tiếp theo; ca trước được lưu riêng và thời gian làm vẫn liên tục.",
      });
      return json({ message: "Ca làm đã thay đổi. Vui lòng tải lại màn hình." }, 409);
    }

    const reconciled = await reconcileActiveShift(db, user, utcTimestamp(), true, Boolean(body.tiktok));
    if (reconciled?.rolloverBlocked) {
      return json({ ...reconciled, message: reconciled.message ?? SUPPORT_ROLLOVER_BLOCKED_MESSAGE }, 409);
    }
    if (!reconciled?.rolledOver) {
      return json({
        message: "Ca hiện tại chưa quá giờ kết thúc 60 phút hoặc chưa xác định được ca tiếp theo.",
      }, 409);
    }
    return json({
      ...reconciled,
      rolloverPending: false,
      message: "Đã chuyển sang ca tiếp theo; ca trước được lưu riêng và thời gian làm vẫn liên tục.",
    });
  }

  if (body.action === "start") {
    if (!user.storeId || !user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên và cửa hàng." }, 409);
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    let schedule: ScheduleSnapshot;
    try {
      schedule = await resolveSchedule(db, user.storeId, user.employeeId);
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "Chưa đến thời gian bắt đầu ca làm việc." }, 409);
    }
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
      db.prepare(`UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ?
        WHERE id = ? AND shift_active = 0
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ACTIVE')
          AND NOT EXISTS (
            SELECT 1 FROM shift_sessions closed
            WHERE closed.employee_id = ? AND closed.work_date = ?
              AND closed.scheduled_start = ? AND closed.scheduled_end = ?
              AND closed.status = 'COMPLETED'
          )
          AND NOT EXISTS (
            SELECT 1 FROM shift_sessions early_closed
            WHERE early_closed.employee_id = ? AND early_closed.status = 'COMPLETED'
              AND early_closed.close_reason = 'MANUAL_EARLY'
              AND early_closed.ended_at <= ? AND early_closed.scheduled_end_at > ?
          )
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM employee_transfers transfer
            WHERE transfer.id = ? AND transfer.employee_id = ? AND transfer.target_store_id = ?
              AND transfer.status IN ('SCHEDULED', 'ACTIVE')
              AND transfer.start_date <= ? AND transfer.end_date >= ?
          ))`)
        .bind(
          shiftCode, startedAt, user.id, user.employeeId,
          user.employeeId, schedule.workDate, schedule.start, schedule.end,
          user.employeeId, startedAt, startedAt,
          user.activeTransferId, user.activeTransferId, user.employeeId, user.storeId,
          schedule.workDate, schedule.workDate,
        ),
      db.prepare(`INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end, scheduled_start_at, scheduled_end_at, work_date, transfer_id, applied_hourly_rate, started_at, previous_session_id, close_reason, close_status, status)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'OPEN', 'ACTIVE'
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND shift_active = 1 AND current_shift = ?)
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND status = 'ACTIVE')
          AND NOT EXISTS (
            SELECT 1 FROM shift_sessions closed
            WHERE closed.employee_id = ? AND closed.work_date = ?
              AND closed.scheduled_start = ? AND closed.scheduled_end = ?
              AND closed.status = 'COMPLETED'
          )
          AND NOT EXISTS (
            SELECT 1 FROM shift_sessions early_closed
            WHERE early_closed.employee_id = ? AND early_closed.status = 'COMPLETED'
              AND early_closed.close_reason = 'MANUAL_EARLY'
              AND early_closed.ended_at <= ? AND early_closed.scheduled_end_at > ?
          )
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM employee_transfers transfer
            WHERE transfer.id = ? AND transfer.employee_id = ? AND transfer.target_store_id = ?
              AND transfer.status IN ('SCHEDULED', 'ACTIVE')
              AND transfer.start_date <= ? AND transfer.end_date >= ?
          ))`)
        .bind(
          sessionId, shiftCode, user.storeId, user.employeeId, schedule.name, schedule.start, schedule.end,
          schedule.startAt, schedule.endAt, schedule.workDate, user.activeTransferId, appliedHourlyRate, startedAt,
          user.id, shiftCode, user.employeeId,
          user.employeeId, schedule.workDate, schedule.start, schedule.end,
          user.employeeId, startedAt, startedAt,
          user.activeTransferId, user.activeTransferId, user.employeeId, user.storeId,
          schedule.workDate, schedule.workDate,
        ),
    ]);
    if (affectedRows(results[1]) === 0) {
      const closedOccurrence = await db.prepare(`SELECT id FROM shift_sessions
        WHERE employee_id = ? AND status = 'COMPLETED'
          AND ((work_date = ? AND scheduled_start = ? AND scheduled_end = ?)
            OR (close_reason = 'MANUAL_EARLY' AND ended_at <= ? AND scheduled_end_at > ?))
        LIMIT 1`)
        .bind(user.employeeId, schedule.workDate, schedule.start, schedule.end, startedAt, startedAt).first<{ id: string }>();
      return json({ message: closedOccurrence
        ? "Bạn đã kết ca này và không thể điểm danh lại. Bạn chỉ có thể điểm danh khi ca tiếp theo bắt đầu."
        : "Bạn đã có một ca đang hoạt động hoặc quyền hỗ trợ đã kết thúc. Vui lòng tải lại trang." }, 409);
    }
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
    const activeSession = await db.prepare(`SELECT id, store_id AS storeId, work_date AS workDate,
        shift_name AS shiftName, scheduled_start AS scheduledStart, scheduled_end AS scheduledEnd,
        scheduled_start_at AS scheduledStartAt, scheduled_end_at AS scheduledEndAt,
        transfer_id AS transferId, started_at AS startedAt
      FROM shift_sessions
      WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE' LIMIT 1`)
      .bind(user.currentShift, user.employeeId).first<{
        id: string; storeId: string; workDate: string | null; shiftName: string | null;
        scheduledStart: string | null; scheduledEnd: string | null;
        scheduledStartAt: string | null; scheduledEndAt: string | null;
        transferId: string | null; startedAt: string;
      }>();
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
    const legacyRange = !activeSession.scheduledEndAt && activeSession.workDate && activeSession.scheduledStart && activeSession.scheduledEnd
      ? shiftUtcRange(activeSession.workDate, activeSession.scheduledStart, activeSession.scheduledEnd)
      : null;
    const scheduledStartAt = activeSession.scheduledStartAt ?? legacyRange?.startAt ?? null;
    const scheduledEndAt = activeSession.scheduledEndAt ?? legacyRange?.endAt ?? null;
    const scheduledEndTime = scheduledEndAt ? new Date(scheduledEndAt).getTime() : Number.NaN;
    const earlyEnd = Number.isFinite(scheduledEndTime) && new Date(endedAt).getTime() < scheduledEndTime;
    if (earlyEnd && body.earlyEndConfirmed !== true) {
      return json({
        message: "Chưa hết giờ kết ca, bạn có muốn kết ca không?",
        requiresEarlyEndConfirmation: true,
        scheduledEndAt,
      }, 409);
    }
    const workedSeconds = durationSeconds(activeSession.startedAt, endedAt);
    const workedMinutes = durationMinutes(workedSeconds);
    const results = await db.batch([
      db.prepare("UPDATE stores SET revenue = revenue + ?, expense = expense + ? WHERE id = ? AND EXISTS (SELECT 1 FROM shift_sessions WHERE id = ? AND status = 'ACTIVE')")
        .bind(cashRevenue + transferRevenue, expenseAmount, activeSession.storeId, activeSession.id),
      db.prepare("UPDATE shift_sessions SET scheduled_start_at = COALESCE(scheduled_start_at, ?), scheduled_end_at = COALESCE(scheduled_end_at, ?), ended_at = ?, duration_seconds = ?, tiktok = ?, tiktok_allowance = ?, tasks_completed = 1, expense_amount = ?, expense_note = ?, cash_revenue = ?, transfer_revenue = ?, close_reason = ?, close_status = 'CONFIRMED', status = 'COMPLETED' WHERE id = ? AND status = 'ACTIVE'")
        .bind(scheduledStartAt, scheduledEndAt, endedAt, workedSeconds, body.tiktok ? 1 : 0, allowance, expenseAmount, body.expenseNote?.trim() || null, cashRevenue, transferRevenue, earlyEnd ? "MANUAL_EARLY" : "MANUAL", activeSession.id),
      db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = ? AND current_shift = ?").bind(user.id, user.currentShift),
      db.prepare(`UPDATE employee_transfers SET
          status = 'COMPLETED', ended_at = COALESCE(ended_at, ?), updated_at = ?
        WHERE id = ? AND employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE')
          AND EXISTS (
            SELECT 1 FROM shift_sessions closed
            WHERE closed.id = ? AND closed.transfer_id = employee_transfers.id
              AND closed.status = 'COMPLETED'
          )`)
        .bind(endedAt, endedAt, activeSession.transferId, user.employeeId, activeSession.id),
    ]);
    if (affectedRows(results[1]) === 0) return json({ message: "Ca làm đã được kết thúc bởi một yêu cầu khác. Vui lòng tải lại trang." }, 409);
    await writeAudit(user.id, "SHIFT_END", "SHIFT", user.currentShift, JSON.stringify({ tiktok: Boolean(body.tiktok), expenseAmount, cashRevenue, transferRevenue, orderCount, workedSeconds, workedMinutes, earlyEnd, scheduledEndAt }));
    const completedSupportTransfer = Boolean(activeSession.transferId && affectedRows(results[3]) > 0);
    const returnedToHomeStore = Boolean(activeSession.transferId);
    if (completedSupportTransfer) {
      await writeAudit(user.id, "TRANSFER_COMPLETE_AFTER_SHIFT", "EMPLOYEE_TRANSFER", activeSession.transferId, JSON.stringify({
        employeeId: user.employeeId,
        shiftSessionId: activeSession.id,
        returnedToStoreId: user.homeStoreId,
        endedAt,
      }));
    }
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
      earlyEnd,
      scheduledEndAt,
      returnedToHomeStore,
      storeId: returnedToHomeStore ? user.homeStoreId : user.storeId,
      storeName: returnedToHomeStore ? user.homeStoreName : user.storeName,
      isSupporting: returnedToHomeStore ? false : user.isSupporting,
    });
  }

  return json({ message: "Thao tác không hợp lệ." }, 400);
}
