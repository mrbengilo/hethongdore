import { initDb, writeAudit } from "../../../db/runtime";
import { durationMinutes, durationSeconds, formatVnd, isVnd, tenderDifferences, utcTimestamp } from "../../lib/finance";
import {
  addDays,
  attendanceCandidatesAt,
  attendanceDeltaMinutes,
  attendanceStatusAt,
  ATTENDANCE_EARLY_WINDOW_MINUTES,
  DEFAULT_SHIFT_DEFINITIONS,
  nextShiftOccurrence,
  shiftUtcRange,
  type ShiftClockDefinition,
} from "../../lib/scheduling";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import {
  DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE,
  employeeTikTokAllowanceSnapshot,
} from "../../lib/employee-tiktok";
import {
  CLOCK_IN_LOCATION_MAX_ACCURACY_METERS,
  CLOCK_IN_LOCATION_MAX_AGE_MS,
  validateClockInLocation,
} from "../../lib/attendance-location";
import {
  incomingStorePeriodUnlockedSql,
  isStorePeriodLocked,
} from "../_lib/store-period-lock";

type ScheduleSnapshot = {
  name: string;
  start: string;
  end: string;
  workDate: string;
  startAt: string;
  endAt: string;
};

type ResolvedScheduleCandidate = ScheduleSnapshot & {
  candidateId: string;
  selectionKind: "CURRENT" | "UPCOMING";
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE";
  attendanceDeltaMinutes: number;
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
  appliedTikTokAllowance: number | null;
  startedAt: string;
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
  attendanceDeltaMinutes: number | null;
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
  tiktokAllowance: number | null;
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
  attendanceDeltaMinutes: number | null;
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

function classifyScheduleCandidates(now: Date, candidates: ScheduleSnapshot[]) {
  const nowTime = now.getTime();
  const current = candidates
    .filter((item) => nowTime >= new Date(item.startAt).getTime() && nowTime < new Date(item.endAt).getTime())
    .sort((left, right) => new Date(right.startAt).getTime() - new Date(left.startAt).getTime())[0];
  const upcoming = candidates
    .filter((item) => {
      const untilStart = new Date(item.startAt).getTime() - nowTime;
      return untilStart > 0 && untilStart <= ATTENDANCE_EARLY_WINDOW_MINUTES * 60_000;
    })
    .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())[0];
  return [current, upcoming].flatMap((schedule, index) => {
    if (!schedule || (index === 1 && current?.startAt === schedule.startAt && current.endAt === schedule.endAt)) return [];
    const attendanceDelta = attendanceDeltaMinutes(now, schedule.startAt);
    const attendanceStatus = attendanceStatusAt(now, schedule.startAt);
    if (attendanceDelta === null || attendanceStatus === null) return [];
    const selectionKind = index === 0 && current === schedule ? "CURRENT" as const : "UPCOMING" as const;
    return [{
      ...schedule,
      selectionKind,
      attendanceStatus,
      attendanceDeltaMinutes: attendanceDelta,
    }];
  });
}

async function scheduleCandidateId(
  storeId: string,
  employeeId: string,
  schedule: ScheduleSnapshot,
) {
  const input = new TextEncoder().encode([
    "attendance", storeId, employeeId, schedule.workDate,
    schedule.name, schedule.start, schedule.end, schedule.startAt, schedule.endAt,
  ].join("|"));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function attachCandidateIds(
  storeId: string,
  employeeId: string,
  candidates: Array<Omit<ResolvedScheduleCandidate, "candidateId">>,
): Promise<ResolvedScheduleCandidate[]> {
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    candidateId: await scheduleCandidateId(storeId, employeeId, candidate),
  })));
}

function publicStartCandidate(candidate: ResolvedScheduleCandidate) {
  return {
    candidateId: candidate.candidateId,
    selectionKind: candidate.selectionKind,
    shiftName: candidate.name,
    scheduledStart: candidate.start,
    scheduledEnd: candidate.end,
    scheduledStartAt: candidate.startAt,
    scheduledEndAt: candidate.endAt,
    workDate: candidate.workDate,
    attendanceStatus: candidate.attendanceStatus,
    attendanceDeltaMinutes: candidate.attendanceDeltaMinutes,
    earlyMinutes: candidate.attendanceDeltaMinutes < 0 ? Math.abs(candidate.attendanceDeltaMinutes) : 0,
  };
}

async function resolveScheduleCandidates(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  employeeId: string,
  now = new Date(),
): Promise<ResolvedScheduleCandidate[]> {
  const workDate = localDate(now);
  const previousDate = addDays(workDate, -1);
  const nextDate = addDays(workDate, 1);
  const nowTime = now.getTime();
  const scheduled = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
    .bind(storeId).all<{ dataJson: string }>();
  const candidates = scheduled.results.flatMap((row): ScheduleSnapshot[] => {
    try {
      const data = JSON.parse(row.dataJson) as ScheduleData;
      if (![previousDate, workDate, nextDate].includes(data.date ?? "") || !data.employeeIds?.includes(employeeId) || !data.shiftName || !data.start || !data.end) return [];
      const range = shiftUtcRange(data.date!, data.start, data.end);
      return range ? [{ name: data.shiftName, start: data.start, end: data.end, workDate: data.date!, ...range }] : [];
    } catch { return []; }
  });
  const completed = await db.prepare(`SELECT work_date AS workDate,
      scheduled_start AS scheduledStart,
      scheduled_end AS scheduledEnd
    FROM shift_sessions
    WHERE employee_id = ? AND status = 'COMPLETED'
      AND work_date IN (?, ?, ?)`)
    .bind(employeeId, previousDate, workDate, nextDate)
    .all<{ workDate: string; scheduledStart: string; scheduledEnd: string }>();
  const completedOccurrences = new Set(completed.results.map((row) =>
    `${row.workDate}|${row.scheduledStart}|${row.scheduledEnd}`));
  const availableCandidates = candidates.filter((item) =>
    !completedOccurrences.has(`${item.workDate}|${item.start}|${item.end}`));

  const assignedChoices = classifyScheduleCandidates(now, availableCandidates);
  if (assignedChoices.length > 0) return attachCandidateIds(storeId, employeeId, assignedChoices);

  // A schedule explicitly assigned for today is authoritative. Do not fall
  // back to another store clock before the assigned next shift begins.
  if (candidates.some((item) => item.workDate === workDate)) {
    const next = availableCandidates
      .filter((item) => new Date(item.startAt).getTime() > nowTime)
      .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())[0];
    const suffix = next ? ` Ca tiếp theo bắt đầu lúc ${next.start}.` : "";
    throw new Error(`Chưa đến thời gian bắt đầu ca làm việc.${suffix}`);
  }

  // Daily definitions are exact occurrences, not weekly templates. Once this
  // store has entered the daily workflow (including all shifts later being
  // deleted), an empty date stays empty instead of reviving legacy templates.
  const dailyDefinitions = await loadDailyShiftOccurrences(db, storeId, [previousDate, workDate, nextDate]);
  if (dailyDefinitions.initialized) {
    const dailyChoices = classifyScheduleCandidates(now, dailyDefinitions.occurrences);
    if (dailyChoices.length > 0) return attachCandidateIds(storeId, employeeId, dailyChoices);
    const next = dailyDefinitions.occurrences
      .filter((item) => new Date(item.startAt).getTime() > nowTime)
      .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())[0];
    const suffix = next ? ` Ca tiếp theo bắt đầu lúc ${next.start}.` : "";
    throw new Error(`Chưa đến thời gian bắt đầu ca làm việc.${suffix}`);
  }

  // Compatibility fallback only for a store that has never created or
  // migrated any daily shift.
  const definitions = await loadLegacyShiftDefinitions(db, storeId);
  const fallback = attendanceCandidatesAt(now, definitions).map((candidate) => ({
    name: candidate.name,
    start: candidate.start,
    end: candidate.end,
    workDate: candidate.workDate,
    startAt: candidate.startAt,
    endAt: candidate.endAt,
    selectionKind: candidate.selectionKind,
    attendanceStatus: candidate.attendanceStatus,
    attendanceDeltaMinutes: candidate.attendanceDeltaMinutes,
  }));
  if (fallback.length > 0) return attachCandidateIds(storeId, employeeId, fallback);
  const next = nextShiftOccurrence(now.toISOString(), definitions);
  const suffix = next ? ` Ca tiếp theo bắt đầu lúc ${next.start}.` : "";
  throw new Error(`Chưa đến thời gian bắt đầu ca làm việc.${suffix}`);
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

async function configuredTikTokAllowance(
  db: Awaited<ReturnType<typeof initDb>>,
  employeeId: string,
) {
  const row = await db.prepare("SELECT tiktok_allowance AS tiktokAllowance FROM employees WHERE id = ? LIMIT 1")
    .bind(employeeId).first<{ tiktokAllowance: number }>();
  const value = employeeTikTokAllowanceSnapshot(row?.tiktokAllowance ?? DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE);
  if (value === null) throw new Error("Phụ cấp TikTok của nhân viên không hợp lệ.");
  return value;
}

async function loadDailyShiftOccurrences(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  workDates: string[],
) {
  const dates = [...new Set(workDates)];
  const placeholders = dates.map(() => "?").join(",");
  const [rows, storeState] = await Promise.all([
    db.prepare(`SELECT work_date AS workDate, name, start_time AS start,
        end_time AS end, status
      FROM daily_shift_definitions
      WHERE store_id = ? AND work_date IN (${placeholders})
      ORDER BY work_date, start_time, name_key, id`)
      .bind(storeId, ...dates).all<{ workDate: string; name: string; start: string; end: string; status: string }>(),
    db.prepare("SELECT 1 AS initialized FROM daily_shift_definitions WHERE store_id = ? LIMIT 1")
      .bind(storeId).first<{ initialized: number }>(),
  ]);
  const occurrences = rows.results.flatMap((row): ScheduleSnapshot[] => {
    if (row.status !== "ACTIVE") return [];
    const range = shiftUtcRange(row.workDate, row.start, row.end);
    return range ? [{ name: row.name, start: row.start, end: row.end, workDate: row.workDate, ...range }] : [];
  });
  return { initialized: Boolean(storeState?.initialized), occurrences };
}

async function loadLegacyShiftDefinitions(
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

function timeMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function supportShiftLabel(schedule: ScheduleSnapshot) {
  const numbered = schedule.name.match(/(?:^|\s)([1-3])(?:\s|$)/)?.[1];
  if (numbered === "1") return "Ca sáng";
  if (numbered === "2") return "Ca chiều";
  if (numbered === "3") return "Ca tối";
  const start = timeMinutes(schedule.start);
  return start < 12 * 60 ? "Ca sáng" : start < 18 * 60 ? "Ca chiều" : "Ca tối";
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
    tiktokAllowance: session.appliedTikTokAllowance,
    attendanceStatus: session.attendanceStatus,
    attendanceDeltaMinutes: session.attendanceDeltaMinutes,
    ...(previousShiftCode ? { previousShiftCode } : {}),
    ...(pending ? { nextShift: pending } : {}),
  };
}

async function reconcileActiveShift(
  db: Awaited<ReturnType<typeof initDb>>,
  user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
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
      applied_tiktok_allowance AS appliedTikTokAllowance,
      started_at AS startedAt,
      attendance_status AS attendanceStatus,
      attendance_delta_minutes AS attendanceDeltaMinutes
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
        s.applied_tiktok_allowance AS appliedTikTokAllowance,
        s.started_at AS startedAt,
        s.attendance_status AS attendanceStatus,
        s.attendance_delta_minutes AS attendanceDeltaMinutes
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
  // An ACTIVE attendance session is never split by elapsed scheduled time.
  // Orders continue to use the same shift_code until the employee explicitly
  // completes END, including orders created after scheduled_end_at.
  return rolloverState(hydratedActive, false);
}

export async function GET(request: Request) {
  const requestReceivedAt = utcTimestamp();
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  const db = await initDb();
  if (new URL(request.url).searchParams.get("preview") === "start") {
    if (!user.storeId || !user.employeeId) {
      return json({ message: "Tài khoản chưa được gắn với nhân viên và cửa hàng." }, 409);
    }
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    if (!await isStoreActive(user.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
    try {
      const candidates = await resolveScheduleCandidates(db, user.storeId, user.employeeId, new Date(requestReceivedAt));
      const startCandidates = candidates.map(publicStartCandidate);
      const mode = startCandidates.length > 1 ? "CURRENT_OR_NEXT"
        : startCandidates[0]?.selectionKind === "UPCOMING" ? "EARLY_CONFIRM" : "CURRENT_CONFIRM";
      return json({
        active: false,
        serverNow: requestReceivedAt,
        locationRequired: true,
        clockInLocationConstraints: {
          maxAgeSeconds: CLOCK_IN_LOCATION_MAX_AGE_MS / 1000,
          maxAccuracyMeters: CLOCK_IN_LOCATION_MAX_ACCURACY_METERS,
        },
        startMode: mode,
        startCandidates,
        // Kept for older clients during a rolling deployment. New clients use
        // the candidate list and must POST the selected candidate identity.
        startPreview: startCandidates[0],
      });
    } catch (error) {
      return json({
        message: error instanceof Error ? error.message : "Chưa đến thời gian bắt đầu ca làm việc.",
      }, 409);
    }
  }
  const reconciled = await reconcileActiveShift(db, user);
  if (reconciled) return json({
    ...reconciled,
    tiktokAllowance: reconciled.tiktokAllowance ?? user.employeeTiktokAllowance ?? DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE,
    serverNow: utcTimestamp(),
    storeId: user.storeId,
    storeName: user.storeName,
    activeTransferId: user.activeTransferId,
    isSupporting: user.isSupporting,
  });
  return json({
    serverNow: utcTimestamp(),
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
    attendanceStatus: null,
    attendanceDeltaMinutes: null,
    tiktokAllowance: user.employeeTiktokAllowance ?? DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE,
    storeId: user.storeId,
    storeName: user.storeName,
    activeTransferId: user.activeTransferId,
    isSupporting: user.isSupporting,
  });
}

export async function POST(request: Request) {
  // Capture the attendance instant before authentication, schema checks or
  // network I/O. All server-side validation still applies, but a slow request
  // can no longer move the recorded clock-in/out time several minutes later.
  const requestReceivedAt = utcTimestamp();
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
    expectedStart?: {
      candidateId?: string;
      selectionKind?: "CURRENT" | "UPCOMING";
      shiftName?: string;
      scheduledStart?: string;
      scheduledEnd?: string;
      workDate?: string;
    };
    clockInLocation?: {
      latitude?: number;
      longitude?: number;
      accuracyMeters?: number;
      capturedAt?: string;
    };
  };
  const db = await initDb();

  if (body.action === "rollover") {
    return json({
      message: "Ca đang làm sẽ tiếp tục ghi nhận cho đến khi bạn chọn KẾT CA; hệ thống không tự chuyển ca.",
      rolloverDisabled: true,
    }, 410);
  }

  if (body.action === "start") {
    if (!user.storeId || !user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên và cửa hàng." }, 409);
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    let candidates: ResolvedScheduleCandidate[];
    try {
      candidates = await resolveScheduleCandidates(db, user.storeId, user.employeeId, new Date(requestReceivedAt));
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "Chưa đến thời gian bắt đầu ca làm việc." }, 409);
    }
    const schedule = candidates.find((candidate) =>
      body.expectedStart?.candidateId === candidate.candidateId
      && body.expectedStart.selectionKind === candidate.selectionKind);
    if (!schedule || body.expectedStart?.shiftName !== schedule.name
      || body.expectedStart.scheduledStart !== schedule.start
      || body.expectedStart.scheduledEnd !== schedule.end
      || body.expectedStart.workDate !== schedule.workDate) {
      return json({
        message: "Ca làm đã thay đổi sau khi xác nhận. Vui lòng kiểm tra và điểm danh lại.",
        serverNow: requestReceivedAt,
        startCandidates: candidates.map(publicStartCandidate),
      }, 409);
    }
    const validatedLocation = validateClockInLocation(body.clockInLocation, requestReceivedAt);
    if (!validatedLocation.ok) {
      return json({
        message: validatedLocation.message,
        code: validatedLocation.code,
        locationRequired: true,
      }, validatedLocation.code === "LOCATION_REQUIRED" ? 428 : 400);
    }
    const clockInLocation = validatedLocation.location;
    const shiftCode = `CA-${schedule.workDate}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const startedAt = requestReceivedAt;
    const attendanceStatus = schedule.attendanceStatus;
    const attendanceDelta = schedule.attendanceDeltaMinutes;
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
    const sessionId = crypto.randomUUID();
    const shiftPeriod = schedule.workDate.slice(0, 7);
    const results = await db.batch([
      db.prepare(`UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ?
        WHERE id = ? AND store_id = ? AND shift_active = 0
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND store_id = ? AND status = 'ACTIVE')
          AND EXISTS (SELECT 1 FROM stores home_store WHERE home_store.id = ? AND home_store.status = 'ACTIVE')
          AND EXISTS (SELECT 1 FROM stores target_store WHERE target_store.id = ? AND target_store.status = 'ACTIVE')
          AND NOT EXISTS (
            SELECT 1 FROM shift_sessions closed
            WHERE closed.employee_id = ? AND closed.work_date = ?
              AND closed.scheduled_start = ? AND closed.scheduled_end = ?
              AND closed.status = 'COMPLETED'
          )
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM employee_transfers transfer
            WHERE transfer.id = ? AND transfer.employee_id = ?
              AND transfer.source_store_id = ? AND transfer.target_store_id = ?
              AND transfer.shifts_json = ?
              AND transfer.status IN ('SCHEDULED', 'ACTIVE')
              AND transfer.start_date <= ? AND transfer.end_date >= ?
          ))
          AND ${incomingStorePeriodUnlockedSql}`)
        .bind(
          shiftCode, startedAt, user.id, user.homeStoreId,
          user.employeeId, user.homeStoreId, user.homeStoreId, user.storeId,
          user.employeeId, schedule.workDate, schedule.start, schedule.end,
          user.activeTransferId, user.activeTransferId, user.employeeId, user.homeStoreId, user.storeId,
          transfer?.shiftsJson ?? null,
          schedule.workDate, schedule.workDate,
          user.storeId, shiftPeriod,
        ),
      db.prepare(`INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end, scheduled_start_at, scheduled_end_at, work_date, transfer_id, applied_hourly_rate, applied_tiktok_allowance, started_at, attendance_status, attendance_delta_minutes, clock_in_latitude, clock_in_longitude, clock_in_accuracy_meters, clock_in_location_captured_at, previous_session_id, close_reason, close_status, status)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE(
            (SELECT support_hourly_rate FROM employee_transfers
              WHERE id = ? AND employee_id = ? AND target_store_id = ?
                AND status IN ('SCHEDULED', 'ACTIVE')
                AND start_date <= ? AND end_date >= ?),
            (SELECT hourly_rate FROM employees WHERE id = ?),
            0
          ),
          COALESCE((SELECT tiktok_allowance FROM employees WHERE id = ?), ?),
          ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'OPEN', 'ACTIVE'
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND store_id = ? AND shift_active = 1 AND current_shift = ?)
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND store_id = ? AND status = 'ACTIVE')
          AND EXISTS (SELECT 1 FROM stores home_store WHERE home_store.id = ? AND home_store.status = 'ACTIVE')
          AND EXISTS (SELECT 1 FROM stores target_store WHERE target_store.id = ? AND target_store.status = 'ACTIVE')
          AND NOT EXISTS (
            SELECT 1 FROM shift_sessions closed
            WHERE closed.employee_id = ? AND closed.work_date = ?
              AND closed.scheduled_start = ? AND closed.scheduled_end = ?
              AND closed.status = 'COMPLETED'
          )
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM employee_transfers transfer
            WHERE transfer.id = ? AND transfer.employee_id = ?
              AND transfer.source_store_id = ? AND transfer.target_store_id = ?
              AND transfer.shifts_json = ?
              AND transfer.status IN ('SCHEDULED', 'ACTIVE')
              AND transfer.start_date <= ? AND transfer.end_date >= ?
          ))
          AND ${incomingStorePeriodUnlockedSql}`)
        .bind(
          sessionId, shiftCode, user.storeId, user.employeeId, schedule.name, schedule.start, schedule.end,
          schedule.startAt, schedule.endAt, schedule.workDate, user.activeTransferId,
          user.activeTransferId, user.employeeId, user.storeId, schedule.workDate, schedule.workDate, user.employeeId,
          user.employeeId, DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE, startedAt, attendanceStatus, attendanceDelta,
          clockInLocation.latitude, clockInLocation.longitude, clockInLocation.accuracyMeters, clockInLocation.capturedAt,
          user.id, user.homeStoreId, shiftCode, user.employeeId, user.homeStoreId, user.homeStoreId, user.storeId,
          user.employeeId, schedule.workDate, schedule.start, schedule.end,
          user.activeTransferId, user.activeTransferId, user.employeeId, user.homeStoreId, user.storeId,
          transfer?.shiftsJson ?? null,
          schedule.workDate, schedule.workDate,
          user.storeId, shiftPeriod,
        ),
    ]);
    if (affectedRows(results[1]) === 0) {
      if (await isStorePeriodLocked(db, user.storeId, shiftPeriod)) {
        return json({ message: "Kỳ chấm công của cửa hàng đang được chốt hoặc đã khóa sổ. Bạn không thể bắt đầu ca mới trong kỳ này." }, 423);
      }
      const closedOccurrence = await db.prepare(`SELECT id FROM shift_sessions
        WHERE employee_id = ? AND status = 'COMPLETED'
          AND work_date = ? AND scheduled_start = ? AND scheduled_end = ?
        LIMIT 1`)
        .bind(user.employeeId, schedule.workDate, schedule.start, schedule.end).first<{ id: string }>();
      return json({ message: closedOccurrence
        ? "Bạn đã kết ca này và không thể điểm danh lại. Bạn chỉ có thể điểm danh khi ca tiếp theo bắt đầu."
        : "Bạn đã có một ca đang hoạt động hoặc quyền hỗ trợ đã kết thúc. Vui lòng tải lại trang." }, 409);
    }
    const createdSession = await db.prepare("SELECT applied_tiktok_allowance AS appliedTikTokAllowance FROM shift_sessions WHERE id = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(sessionId).first<{ appliedTikTokAllowance: number }>();
    const appliedTikTokAllowance = employeeTikTokAllowanceSnapshot(createdSession?.appliedTikTokAllowance);
    if (appliedTikTokAllowance === null) throw new Error("Invalid TikTok allowance snapshot");
    await writeAudit(user.id, "SHIFT_START", "SHIFT", shiftCode, JSON.stringify({
      storeId: user.storeId,
      transferId: user.activeTransferId,
      shiftName: schedule.name,
      candidateId: schedule.candidateId,
      selectionKind: schedule.selectionKind,
      appliedTikTokAllowance,
      attendanceStatus,
      attendanceDeltaMinutes: attendanceDelta,
      locationCapturedAt: clockInLocation.capturedAt,
      locationAccuracyMeters: clockInLocation.accuracyMeters,
    }));
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
      candidateId: schedule.candidateId,
      selectionKind: schedule.selectionKind,
      attendanceStatus,
      attendanceDeltaMinutes: attendanceDelta,
      earlyMinutes: attendanceDelta < 0 ? Math.abs(attendanceDelta) : 0,
      locationCapturedAt: clockInLocation.capturedAt,
      locationAccuracyMeters: clockInLocation.accuracyMeters,
      tiktokAllowance: appliedTikTokAllowance,
    });
  }

  if (body.action === "end") {
    if (!user.shiftActive || !user.currentShift || !user.employeeId) return json({ message: "Bạn chưa bắt đầu ca làm việc." }, 409);
    const activeSession = await db.prepare(`SELECT id, store_id AS storeId, work_date AS workDate,
        shift_name AS shiftName, scheduled_start AS scheduledStart, scheduled_end AS scheduledEnd,
        scheduled_start_at AS scheduledStartAt, scheduled_end_at AS scheduledEndAt,
        transfer_id AS transferId, applied_tiktok_allowance AS appliedTikTokAllowance, started_at AS startedAt
      FROM shift_sessions
      WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE' LIMIT 1`)
      .bind(user.currentShift, user.employeeId).first<{
        id: string; storeId: string; workDate: string | null; shiftName: string | null;
        scheduledStart: string | null; scheduledEnd: string | null;
        scheduledStartAt: string | null; scheduledEndAt: string | null;
        transferId: string | null; appliedTikTokAllowance: number | null; startedAt: string;
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

    const endedAt = requestReceivedAt;
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
    const closeToken = `END:${crypto.randomUUID()}`;
    const results = await db.batch([
      db.prepare(`UPDATE shift_sessions SET
          scheduled_start_at = COALESCE(scheduled_start_at, ?),
          scheduled_end_at = COALESCE(scheduled_end_at, ?),
          ended_at = ?, duration_seconds = ?, tiktok = ?,
          tiktok_allowance = CASE WHEN ? = 1
            THEN COALESCE(applied_tiktok_allowance,
              (SELECT tiktok_allowance FROM employees WHERE id = ?), ?)
            ELSE 0 END,
          tasks_completed = 1, expense_amount = ?, expense_note = ?,
          cash_revenue = ?, transfer_revenue = ?, close_reason = ?,
          close_status = ?, status = 'COMPLETED'
        WHERE id = ? AND status = 'ACTIVE'
          AND EXISTS (
            SELECT 1 FROM users actor
            WHERE actor.id = ? AND actor.role = 'EMPLOYEE' AND actor.shift_active = 1
              AND actor.current_shift = ? AND actor.employee_id = ?
          )
          AND COALESCE((
            SELECT SUM(cash_order.amount) FROM orders cash_order
            WHERE cash_order.store_id = ? AND cash_order.employee_id = ? AND cash_order.shift_code = ?
              AND cash_order.status = 'COMPLETED' AND cash_order.payment_method = 'CASH'
          ), 0) = ?
          AND COALESCE((
            SELECT SUM(transfer_order.amount) FROM orders transfer_order
            WHERE transfer_order.store_id = ? AND transfer_order.employee_id = ? AND transfer_order.shift_code = ?
              AND transfer_order.status = 'COMPLETED' AND transfer_order.payment_method = 'BANK_TRANSFER'
          ), 0) = ?
          AND NOT EXISTS (
            SELECT 1 FROM orders unknown_tender
            WHERE unknown_tender.store_id = ? AND unknown_tender.employee_id = ? AND unknown_tender.shift_code = ?
              AND unknown_tender.status = 'COMPLETED'
              AND unknown_tender.payment_method NOT IN ('CASH', 'BANK_TRANSFER')
          )`)
        .bind(
          scheduledStartAt, scheduledEndAt, endedAt, workedSeconds,
          body.tiktok ? 1 : 0, body.tiktok ? 1 : 0,
          user.employeeId, DEFAULT_EMPLOYEE_TIKTOK_ALLOWANCE,
          expenseAmount, body.expenseNote?.trim() || null,
          cashRevenue, transferRevenue, earlyEnd ? "MANUAL_EARLY" : "MANUAL",
          closeToken, activeSession.id,
          user.id, user.currentShift, user.employeeId,
          activeSession.storeId, user.employeeId, user.currentShift, cashRevenue,
          activeSession.storeId, user.employeeId, user.currentShift, transferRevenue,
          activeSession.storeId, user.employeeId, user.currentShift,
        ),
      db.prepare(`UPDATE stores SET revenue = revenue + ?, expense = expense + ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM shift_sessions closed
          WHERE closed.id = ? AND closed.status = 'COMPLETED' AND closed.close_status = ?
        )`)
        .bind(cashRevenue + transferRevenue, expenseAmount, activeSession.storeId, activeSession.id, closeToken),
      db.prepare(`UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL
        WHERE id = ? AND current_shift = ? AND EXISTS (
          SELECT 1 FROM shift_sessions closed
          WHERE closed.id = ? AND closed.status = 'COMPLETED' AND closed.close_status = ?
        )`)
        .bind(user.id, user.currentShift, activeSession.id, closeToken),
      db.prepare(`UPDATE employee_transfers SET
          status = 'COMPLETED', ended_at = COALESCE(ended_at, ?), updated_at = ?
        WHERE id = ? AND employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE')
          AND EXISTS (
            SELECT 1 FROM shift_sessions closed
            WHERE closed.id = ? AND closed.transfer_id = employee_transfers.id
              AND closed.status = 'COMPLETED' AND closed.close_status = ?
          )`)
        .bind(endedAt, endedAt, activeSession.transferId, user.employeeId, activeSession.id, closeToken),
      db.prepare("UPDATE shift_sessions SET close_status = 'CONFIRMED' WHERE id = ? AND status = 'COMPLETED' AND close_status = ?")
        .bind(activeSession.id, closeToken),
    ]);
    if (affectedRows(results[0]) === 0) {
      const stillActive = await db.prepare("SELECT id FROM shift_sessions WHERE id = ? AND status = 'ACTIVE' LIMIT 1")
        .bind(activeSession.id).first<{ id: string }>();
      return json({
        message: stillActive
          ? "Đơn hàng hoặc doanh thu đã thay đổi trong lúc kết ca. Vui lòng tải lại số liệu, đối soát và thử lại."
          : "Ca làm đã được kết thúc bởi một yêu cầu khác. Vui lòng tải lại trang.",
        revenueChanged: Boolean(stillActive),
      }, 409);
    }
    const completedSession = await db.prepare("SELECT tiktok_allowance AS tiktokAllowance FROM shift_sessions WHERE id = ? AND status = 'COMPLETED' LIMIT 1")
      .bind(activeSession.id).first<{ tiktokAllowance: number }>();
    const allowance = Number(completedSession?.tiktokAllowance ?? 0);
    const employeeTiktokAllowance = await configuredTikTokAllowance(db, user.employeeId);
    await writeAudit(user.id, "SHIFT_END", "SHIFT", user.currentShift, JSON.stringify({ tiktok: Boolean(body.tiktok), tiktokAllowance: allowance, expenseAmount, cashRevenue, transferRevenue, orderCount, workedSeconds, workedMinutes, earlyEnd, scheduledEndAt }));
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
      employeeTiktokAllowance,
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
