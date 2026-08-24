import { initDb } from "../../../db/runtime";
import { durationMinutes, durationSeconds, formatVnd, isVnd, tenderDifferences, utcTimestamp } from "../../lib/finance";
import {
  addDays,
  attendanceDeltaMinutes,
  attendanceStatusAt,
  shiftUtcRange,
} from "../../lib/scheduling";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import {
  buildCashflowEntry,
  prepareCashflowEntryInsertWhere,
} from "../_lib/cashflow-ledger";
import {
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
import { loadAttendancePolicy } from "../_lib/attendance-policy";
import type { AttendancePolicySnapshot } from "../../lib/attendance-policy";

type ScheduleSnapshot = {
  name: string;
  start: string;
  end: string;
  workDate: string;
  startAt: string;
  endAt: string;
  sourceScheduleRecordId: string;
  sourceScheduleUpdatedAt: string;
};

type ResolvedScheduleCandidate = ScheduleSnapshot & {
  candidateId: string;
  selectionKind: "CURRENT" | "UPCOMING";
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE";
  attendanceDeltaMinutes: number;
  attendanceGraceMinutes: number;
  policyVersion: number;
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
  attendanceGraceMinutes: number;
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
  attendanceGraceMinutes: number;
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

function classifyScheduleCandidates(now: Date, candidates: ScheduleSnapshot[], policy: AttendancePolicySnapshot) {
  const nowTime = now.getTime();
  const current = candidates
    .filter((item) => nowTime >= new Date(item.startAt).getTime() && nowTime < new Date(item.endAt).getTime())
    .sort((left, right) => new Date(right.startAt).getTime() - new Date(left.startAt).getTime())[0];
  const upcoming = candidates
    .filter((item) => {
      const untilStart = new Date(item.startAt).getTime() - nowTime;
      return untilStart > 0 && untilStart <= policy.earlyClockInWindowMinutes * 60_000;
    })
    .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())[0];
  return [current, upcoming].flatMap((schedule, index) => {
    if (!schedule || (index === 1 && current?.startAt === schedule.startAt && current.endAt === schedule.endAt)) return [];
    const attendanceDelta = attendanceDeltaMinutes(now, schedule.startAt);
    const attendanceStatus = attendanceStatusAt(now, schedule.startAt, policy.lateGraceMinutes);
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
  policy: AttendancePolicySnapshot,
) {
  const input = new TextEncoder().encode([
    "attendance", storeId, employeeId, schedule.workDate,
    schedule.name, schedule.start, schedule.end, schedule.startAt, schedule.endAt,
    schedule.sourceScheduleRecordId, schedule.sourceScheduleUpdatedAt,
    policy.version, policy.lateGraceMinutes, policy.earlyClockInWindowMinutes,
    policy.maxShiftDurationMinutes,
  ].join("|"));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function attachCandidateIds(
  storeId: string,
  employeeId: string,
  candidates: Array<Omit<ResolvedScheduleCandidate, "candidateId" | "attendanceGraceMinutes" | "policyVersion">>,
  policy: AttendancePolicySnapshot,
): Promise<ResolvedScheduleCandidate[]> {
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    candidateId: await scheduleCandidateId(storeId, employeeId, candidate, policy),
    attendanceGraceMinutes: policy.lateGraceMinutes,
    policyVersion: policy.version,
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
    attendanceGraceMinutes: candidate.attendanceGraceMinutes,
    policyVersion: candidate.policyVersion,
  };
}

async function resolveScheduleCandidates(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  employeeId: string,
  now = new Date(),
  policy: AttendancePolicySnapshot,
): Promise<ResolvedScheduleCandidate[]> {
  const workDate = localDate(now);
  const previousDate = addDays(workDate, -1);
  const nextDate = addDays(workDate, 1);
  const scheduled = await db.prepare("SELECT id, data_json AS dataJson, updated_at AS updatedAt FROM business_records WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
    .bind(storeId).all<{ id: string; dataJson: string; updatedAt: string }>();
  const candidates = scheduled.results.flatMap((row): ScheduleSnapshot[] => {
    try {
      const data = JSON.parse(row.dataJson) as ScheduleData;
      if (![previousDate, workDate, nextDate].includes(data.date ?? "") || !data.employeeIds?.includes(employeeId) || !data.shiftName || !data.start || !data.end) return [];
      const range = shiftUtcRange(data.date!, data.start, data.end);
      return range ? [{
        name: data.shiftName,
        start: data.start,
        end: data.end,
        workDate: data.date!,
        sourceScheduleRecordId: row.id,
        sourceScheduleUpdatedAt: row.updatedAt,
        ...range,
      }] : [];
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

  const assignedChoices = classifyScheduleCandidates(now, availableCandidates, policy);
  if (assignedChoices.length > 0) return attachCandidateIds(storeId, employeeId, assignedChoices, policy);

  const next = availableCandidates
    .filter((item) => new Date(item.startAt).getTime() > now.getTime())
    .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())[0];
  const suffix = next ? ` Ca tiếp theo bắt đầu lúc ${next.start}.` : "";
  throw new Error(next
    ? `Chưa đến thời gian bắt đầu ca làm việc.${suffix}`
    : "Bạn chưa được phân ca làm việc cho thời điểm này. Vui lòng liên hệ quản lý.");
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

function prepareGuardedStructuredAudit(
  db: Awaited<ReturnType<typeof initDb>>,
  input: {
    userId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    storeId: string | null;
    before?: unknown;
    after?: unknown;
    reason: string;
    detail?: string | null;
    createdAt: string;
  },
  guardSql: string,
  guardBindings: unknown[],
) {
  return db.prepare(`INSERT INTO audit_logs
      (id, user_id, action, entity_type, entity_id, detail, created_at,
        before_json, after_json, reason, store_id)
    SELECT ?, ?, ?, CASE WHEN ${guardSql} THEN ? ELSE NULL END, ?, ?, ?, ?, ?, ?, ?`)
    .bind(
      crypto.randomUUID(),
      input.userId,
      input.action,
      ...guardBindings,
      input.entityType,
      input.entityId,
      input.detail ?? null,
      input.createdAt,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason,
      input.storeId,
    );
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
    attendanceGraceMinutes: session.attendanceGraceMinutes,
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
      , attendance_grace_minutes AS attendanceGraceMinutes
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
        , s.attendance_grace_minutes AS attendanceGraceMinutes
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
  const currentPolicy = await loadAttendancePolicy(db);
  if (new URL(request.url).searchParams.get("preview") === "start") {
    if (!user.storeId || !user.employeeId) {
      return json({ message: "Tài khoản chưa được gắn với nhân viên và cửa hàng." }, 409);
    }
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    if (!await isStoreActive(user.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
    try {
      const candidates = await resolveScheduleCandidates(db, user.storeId, user.employeeId, new Date(requestReceivedAt), currentPolicy);
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
        attendancePolicy: {
          currentGraceMinutes: currentPolicy.lateGraceMinutes,
          version: currentPolicy.version,
          rule: "LATE_WHEN_GREATER_THAN_GRACE",
        },
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
    tiktokAllowance: reconciled.tiktokAllowance ?? user.employeeTiktokAllowance ?? 0,
    serverNow: utcTimestamp(),
    storeId: user.storeId,
    storeName: user.storeName,
    activeTransferId: user.activeTransferId,
    isSupporting: user.isSupporting,
    attendancePolicy: {
      currentGraceMinutes: currentPolicy.lateGraceMinutes,
      version: currentPolicy.version,
      rule: "LATE_WHEN_GREATER_THAN_GRACE",
    },
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
    attendanceGraceMinutes: currentPolicy.lateGraceMinutes,
    tiktokAllowance: user.employeeTiktokAllowance ?? 0,
    storeId: user.storeId,
    storeName: user.storeName,
    activeTransferId: user.activeTransferId,
    isSupporting: user.isSupporting,
    attendancePolicy: {
      currentGraceMinutes: currentPolicy.lateGraceMinutes,
      version: currentPolicy.version,
      rule: "LATE_WHEN_GREATER_THAN_GRACE",
    },
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
    let policy: AttendancePolicySnapshot;
    try {
      policy = await loadAttendancePolicy(db);
      candidates = await resolveScheduleCandidates(db, user.storeId, user.employeeId, new Date(requestReceivedAt), policy);
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
      ? await db.prepare("SELECT support_hourly_rate AS rate, support_allowance AS supportAllowance, shifts_json AS shiftsJson FROM employee_transfers WHERE id = ? AND status IN ('SCHEDULED', 'ACTIVE') LIMIT 1")
        .bind(user.activeTransferId).first<{ rate: number; supportAllowance: number; shiftsJson: string }>()
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
    const assignmentGuard = `EXISTS (
      SELECT 1 FROM business_records assigned
      WHERE assigned.id = ? AND assigned.category = 'LICH_PHAN_CA'
        AND assigned.store_id = ? AND assigned.status != 'DELETED'
        AND assigned.updated_at = ?
        AND json_extract(assigned.data_json, '$.date') = ?
        AND json_extract(assigned.data_json, '$.shiftName') = ?
        AND json_extract(assigned.data_json, '$.start') = ?
        AND json_extract(assigned.data_json, '$.end') = ?
        AND EXISTS (
          SELECT 1 FROM json_each(json_extract(assigned.data_json, '$.employeeIds')) employee_assignment
          WHERE employee_assignment.value = ?
        )
    )`;
    const assignmentBindings = [
      schedule.sourceScheduleRecordId,
      user.storeId,
      schedule.sourceScheduleUpdatedAt,
      schedule.workDate,
      schedule.name,
      schedule.start,
      schedule.end,
      user.employeeId,
    ];
    const startSnapshot = {
      shiftCode,
      storeId: user.storeId,
      employeeId: user.employeeId,
      transferId: user.activeTransferId,
      shiftName: schedule.name,
      scheduledStartAt: schedule.startAt,
      scheduledEndAt: schedule.endAt,
      workDate: schedule.workDate,
      sourceScheduleRecordId: schedule.sourceScheduleRecordId,
      sourceScheduleUpdatedAt: schedule.sourceScheduleUpdatedAt,
      candidateId: schedule.candidateId,
      selectionKind: schedule.selectionKind,
      attendanceStatus,
      attendanceDeltaMinutes: attendanceDelta,
      attendanceGraceMinutes: policy.lateGraceMinutes,
      attendanceEarlyWindowMinutes: policy.earlyClockInWindowMinutes,
      attendanceMaxShiftMinutes: policy.maxShiftDurationMinutes,
      attendancePolicyVersion: policy.version,
      clockInLocationCapturedAt: clockInLocation.capturedAt,
      clockInLocationAccuracyMeters: clockInLocation.accuracyMeters,
    };
    let results: unknown[];
    try {
      results = await db.batch([
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
          AND ${assignmentGuard}
          AND EXISTS (SELECT 1 FROM system_state WHERE key = ? AND value = ? AND updated_at = ?)
          AND ${incomingStorePeriodUnlockedSql}`)
        .bind(
          shiftCode, startedAt, user.id, user.homeStoreId,
          user.employeeId, user.homeStoreId, user.homeStoreId, user.storeId,
          user.employeeId, schedule.workDate, schedule.start, schedule.end,
          user.activeTransferId, user.activeTransferId, user.employeeId, user.homeStoreId, user.storeId,
          transfer?.shiftsJson ?? null,
          schedule.workDate, schedule.workDate,
          ...assignmentBindings,
          "attendance_late_grace_policy_v1", policy.rawValue, policy.updatedAt,
          user.storeId, shiftPeriod,
        ),
      db.prepare(`INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end, scheduled_start_at, scheduled_end_at, work_date, transfer_id, source_schedule_record_id, source_schedule_updated_at, attendance_early_window_minutes, attendance_max_shift_minutes, applied_hourly_rate, applied_tiktok_allowance, applied_support_allowance, started_at, attendance_status, attendance_delta_minutes, attendance_grace_minutes, clock_in_latitude, clock_in_longitude, clock_in_accuracy_meters, clock_in_location_captured_at, previous_session_id, close_reason, close_status, status)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE(
            (SELECT support_hourly_rate FROM employee_transfers
              WHERE id = ? AND employee_id = ? AND target_store_id = ?
                AND status IN ('SCHEDULED', 'ACTIVE')
                AND start_date <= ? AND end_date >= ?),
            (SELECT hourly_rate FROM employees WHERE id = ?),
            0
          ),
          (SELECT tiktok_allowance FROM employees WHERE id = ?),
          ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'OPEN', 'ACTIVE'
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
          AND ${assignmentGuard}
          AND EXISTS (SELECT 1 FROM system_state WHERE key = ? AND value = ? AND updated_at = ?)
          AND ${incomingStorePeriodUnlockedSql}`)
        .bind(
          sessionId, shiftCode, user.storeId, user.employeeId, schedule.name, schedule.start, schedule.end,
          schedule.startAt, schedule.endAt, schedule.workDate, user.activeTransferId,
          schedule.sourceScheduleRecordId, schedule.sourceScheduleUpdatedAt,
          policy.earlyClockInWindowMinutes, policy.maxShiftDurationMinutes,
          user.activeTransferId, user.employeeId, user.storeId, schedule.workDate, schedule.workDate, user.employeeId,
          user.employeeId, transfer?.supportAllowance ?? 0, startedAt, attendanceStatus, attendanceDelta,
          policy.lateGraceMinutes,
          clockInLocation.latitude, clockInLocation.longitude, clockInLocation.accuracyMeters, clockInLocation.capturedAt,
          user.id, user.homeStoreId, shiftCode, user.employeeId, user.homeStoreId, user.homeStoreId, user.storeId,
          user.employeeId, schedule.workDate, schedule.start, schedule.end,
          user.activeTransferId, user.activeTransferId, user.employeeId, user.homeStoreId, user.storeId,
          transfer?.shiftsJson ?? null,
          schedule.workDate, schedule.workDate,
          ...assignmentBindings,
          "attendance_late_grace_policy_v1", policy.rawValue, policy.updatedAt,
          user.storeId, shiftPeriod,
        ),
      prepareGuardedStructuredAudit(db, {
        userId: user.id,
        action: "SHIFT_START",
        entityType: "SHIFT_SESSION",
        entityId: sessionId,
        storeId: user.storeId,
        before: null,
        after: startSnapshot,
        reason: "Nhân viên điểm danh bắt đầu ca đã được phân lịch.",
        createdAt: startedAt,
      }, `EXISTS (
        SELECT 1 FROM shift_sessions started
        JOIN users actor ON actor.id = ?
        WHERE started.id = ? AND started.status = 'ACTIVE'
          AND actor.shift_active = 1 AND actor.current_shift = started.shift_code
      )`, [user.id, sessionId]),
      ]) as unknown[];
    } catch {
      if (await isStorePeriodLocked(db, user.storeId, shiftPeriod)) {
        return json({ message: "Kỳ chấm công của cửa hàng đang được chốt hoặc đã khóa sổ. Bạn không thể bắt đầu ca mới trong kỳ này." }, 423);
      }
      const assignmentStillCurrent = await db.prepare(`SELECT 1 AS valid WHERE ${assignmentGuard}`)
        .bind(...assignmentBindings).first<{ valid: number }>();
      if (!assignmentStillCurrent) {
        return json({ message: "Lịch phân ca vừa thay đổi. Vui lòng tải lại trước khi điểm danh." }, 409);
      }
      const eligibilityStillCurrent = await db.prepare(`SELECT 1 AS valid
        FROM users actor
        JOIN employees employee ON employee.id = ?
        JOIN stores home_store ON home_store.id = ?
        JOIN stores target_store ON target_store.id = ?
        WHERE actor.id = ? AND actor.store_id = ? AND actor.shift_active = 0
          AND employee.store_id = ? AND employee.status = 'ACTIVE'
          AND home_store.status = 'ACTIVE' AND target_store.status = 'ACTIVE'`)
        .bind(
          user.employeeId, user.homeStoreId, user.storeId,
          user.id, user.homeStoreId, user.homeStoreId,
        ).first<{ valid: number }>();
      if (!eligibilityStillCurrent) {
        return json({ message: "Thông tin nhân viên, cửa hàng hoặc quyền hỗ trợ vừa thay đổi. Vui lòng đăng nhập hoặc tải lại trước khi điểm danh." }, 409);
      }
      const active = await db.prepare("SELECT id FROM shift_sessions WHERE employee_id = ? AND status = 'ACTIVE' LIMIT 1")
        .bind(user.employeeId).first<{ id: string }>();
      if (active) return json({ message: "Bạn đã có một ca đang hoạt động. Vui lòng tải lại trang." }, 409);
      return json({ message: "Không thể ghi nhận điểm danh và nhật ký kiểm toán một cách an toàn. Vui lòng thử lại." }, 500);
    }
    if (affectedRows(results[1]) === 0) {
      if (await isStorePeriodLocked(db, user.storeId, shiftPeriod)) {
        return json({ message: "Kỳ chấm công của cửa hàng đang được chốt hoặc đã khóa sổ. Bạn không thể bắt đầu ca mới trong kỳ này." }, 423);
      }
      const latestPolicy = await loadAttendancePolicy(db);
      if (latestPolicy.version !== policy.version || latestPolicy.rawValue !== policy.rawValue) {
        return json({
          message: "Chính sách thời gian đi trễ vừa thay đổi. Vui lòng kiểm tra và điểm danh lại.",
          attendancePolicy: {
            currentGraceMinutes: latestPolicy.lateGraceMinutes,
            version: latestPolicy.version,
            rule: "LATE_WHEN_GREATER_THAN_GRACE",
          },
        }, 409);
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
      attendanceGraceMinutes: policy.lateGraceMinutes,
      attendancePolicyVersion: policy.version,
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
        transfer_id AS transferId, applied_tiktok_allowance AS appliedTikTokAllowance,
        attendance_early_window_minutes AS attendanceEarlyWindowMinutes,
        attendance_max_shift_minutes AS attendanceMaxShiftMinutes,
        source_schedule_record_id AS sourceScheduleRecordId,
        source_schedule_updated_at AS sourceScheduleUpdatedAt,
        reconciliation_status AS reconciliationStatus,
        started_at AS startedAt
      FROM shift_sessions
      WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE' LIMIT 1`)
      .bind(user.currentShift, user.employeeId).first<{
        id: string; storeId: string; workDate: string | null; shiftName: string | null;
        scheduledStart: string | null; scheduledEnd: string | null;
        scheduledStartAt: string | null; scheduledEndAt: string | null;
        transferId: string | null; appliedTikTokAllowance: number | null;
        attendanceEarlyWindowMinutes: number | null; attendanceMaxShiftMinutes: number | null;
        sourceScheduleRecordId: string | null; sourceScheduleUpdatedAt: string | null;
        reconciliationStatus: "CLEAR" | "REQUIRED" | "CONFIRMED"; startedAt: string;
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
    const attendancePolicy = activeSession.attendanceMaxShiftMinutes === null
      ? await loadAttendancePolicy(db)
      : null;
    const maxShiftMinutes = activeSession.attendanceMaxShiftMinutes
      ?? attendancePolicy?.maxShiftDurationMinutes;
    if (!Number.isSafeInteger(maxShiftMinutes) || Number(maxShiftMinutes) <= 0) {
      return json({ message: "Không thể xác định giới hạn thời lượng ca để kết ca an toàn. Vui lòng liên hệ quản lý." }, 500);
    }
    const reconciliationRequired = workedMinutes > Number(maxShiftMinutes);
    const reconciliationReason = reconciliationRequired
      ? `Thời lượng ${workedMinutes.toFixed(2)} phút vượt giới hạn ${maxShiftMinutes} phút đã áp dụng khi kết ca.`
      : null;
    const reconciliationStatus = reconciliationRequired ? "REQUIRED" as const : "CLEAR" as const;
    const shiftPeriod = (activeSession.workDate ?? localDate(new Date(activeSession.startedAt))).slice(0, 7);
    const appliedTikTokAllowance = employeeTikTokAllowanceSnapshot(activeSession.appliedTikTokAllowance);
    if (appliedTikTokAllowance === null) {
      return json({ message: "Không thể xác định phụ cấp TikTok đã áp dụng cho ca này." }, 500);
    }
    const allowance = body.tiktok ? appliedTikTokAllowance : 0;
    const closeToken = `END:${crypto.randomUUID()}`;
    const cashflowGuard = `EXISTS (
      SELECT 1 FROM shift_sessions closed
      WHERE closed.id = ? AND closed.status = 'COMPLETED' AND closed.close_status = ?
    )`;
    const cashflowEntries = await Promise.all([
      cashRevenue > 0 ? buildCashflowEntry({
        storeId: activeSession.storeId,
        direction: "IN",
        amount: cashRevenue,
        category: "SHIFT_REVENUE",
        sourceType: "SHIFT_REVENUE_CASH",
        sourceId: activeSession.id,
        occurredAt: endedAt,
        createdBy: user.id,
        clientRequestId: `shift-close:${activeSession.id}:cash`,
        note: `${activeSession.shiftName ?? "Ca làm"} · Doanh thu tiền mặt`,
        createdAt: endedAt,
      }) : null,
      transferRevenue > 0 ? buildCashflowEntry({
        storeId: activeSession.storeId,
        direction: "IN",
        amount: transferRevenue,
        category: "SHIFT_REVENUE",
        sourceType: "SHIFT_REVENUE_BANK",
        sourceId: activeSession.id,
        occurredAt: endedAt,
        createdBy: user.id,
        clientRequestId: `shift-close:${activeSession.id}:bank`,
        note: `${activeSession.shiftName ?? "Ca làm"} · Doanh thu chuyển khoản`,
        createdAt: endedAt,
      }) : null,
      expenseAmount > 0 ? buildCashflowEntry({
        storeId: activeSession.storeId,
        direction: "OUT",
        amount: expenseAmount,
        category: "SHIFT_EXPENSE",
        sourceType: "SHIFT_EXPENSE",
        sourceId: activeSession.id,
        occurredAt: endedAt,
        createdBy: user.id,
        clientRequestId: `shift-close:${activeSession.id}:expense`,
        note: body.expenseNote?.trim() || `${activeSession.shiftName ?? "Ca làm"} · Chi phí trong ca`,
        createdAt: endedAt,
      }) : null,
    ]);
    const endBefore = {
      id: activeSession.id,
      shiftCode: user.currentShift,
      status: "ACTIVE",
      startedAt: activeSession.startedAt,
      scheduledStartAt,
      scheduledEndAt,
      workDate: activeSession.workDate,
      sourceScheduleRecordId: activeSession.sourceScheduleRecordId,
      sourceScheduleUpdatedAt: activeSession.sourceScheduleUpdatedAt,
      attendanceMaxShiftMinutes: activeSession.attendanceMaxShiftMinutes,
      reconciliationStatus: activeSession.reconciliationStatus,
    };
    const endAfter = {
      ...endBefore,
      status: "COMPLETED",
      endedAt,
      durationSeconds: workedSeconds,
      durationMinutes: workedMinutes,
      tiktok: Boolean(body.tiktok),
      tiktokAllowance: allowance,
      expenseAmount,
      expenseNote: body.expenseNote?.trim() || null,
      cashRevenue,
      transferRevenue,
      orderCount,
      earlyEnd,
      attendanceMaxShiftMinutes: Number(maxShiftMinutes),
      reconciliationStatus,
      reconciliationReason,
      closeStatus: "CONFIRMED",
    };
    let results: unknown[];
    try {
      results = await db.batch([
      db.prepare(`UPDATE shift_sessions SET
          scheduled_start_at = COALESCE(scheduled_start_at, ?),
          scheduled_end_at = COALESCE(scheduled_end_at, ?),
          attendance_max_shift_minutes = COALESCE(attendance_max_shift_minutes, ?),
          ended_at = ?, duration_seconds = ?, tiktok = ?,
          tiktok_allowance = ?,
          tasks_completed = 1, expense_amount = ?, expense_note = ?,
          cash_revenue = ?, transfer_revenue = ?, close_reason = ?,
          close_status = ?, reconciliation_status = ?, reconciliation_reason = ?,
          reconciled_at = NULL, reconciled_by = NULL, status = 'COMPLETED'
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
          )
          AND ${incomingStorePeriodUnlockedSql}`)
        .bind(
          scheduledStartAt, scheduledEndAt, Number(maxShiftMinutes), endedAt, workedSeconds,
          body.tiktok ? 1 : 0, allowance,
          expenseAmount, body.expenseNote?.trim() || null,
          cashRevenue, transferRevenue, earlyEnd ? "MANUAL_EARLY" : "MANUAL",
          closeToken, reconciliationStatus, reconciliationReason, activeSession.id,
          user.id, user.currentShift, user.employeeId,
          activeSession.storeId, user.employeeId, user.currentShift, cashRevenue,
          activeSession.storeId, user.employeeId, user.currentShift, transferRevenue,
          activeSession.storeId, user.employeeId, user.currentShift,
          activeSession.storeId, shiftPeriod,
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
      ...cashflowEntries
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .map((entry) => prepareCashflowEntryInsertWhere(
          db,
          entry,
          cashflowGuard,
          [activeSession.id, closeToken],
        )),
      db.prepare("UPDATE shift_sessions SET close_status = 'CONFIRMED' WHERE id = ? AND status = 'COMPLETED' AND close_status = ?")
        .bind(activeSession.id, closeToken),
      ...(activeSession.transferId ? [prepareGuardedStructuredAudit(db, {
        userId: user.id,
        action: "TRANSFER_COMPLETE_AFTER_SHIFT",
        entityType: "EMPLOYEE_TRANSFER",
        entityId: activeSession.transferId,
        storeId: activeSession.storeId,
        before: {
          id: activeSession.transferId,
          employeeId: user.employeeId,
          status: "ACTIVE_OR_SCHEDULED",
        },
        after: {
          id: activeSession.transferId,
          employeeId: user.employeeId,
          status: "COMPLETED",
          endedAt,
          returnedToStoreId: user.homeStoreId,
          shiftSessionId: activeSession.id,
        },
        reason: "Hoàn tất điều chuyển hỗ trợ khi nhân viên kết ca.",
        createdAt: endedAt,
      }, `EXISTS (
        SELECT 1 FROM employee_transfers completed_transfer
        WHERE completed_transfer.id = ? AND completed_transfer.employee_id = ?
          AND completed_transfer.status = 'COMPLETED' AND completed_transfer.ended_at = ?
      )`, [activeSession.transferId, user.employeeId, endedAt])] : []),
      prepareGuardedStructuredAudit(db, {
        userId: user.id,
        action: "SHIFT_END",
        entityType: "SHIFT_SESSION",
        entityId: activeSession.id,
        storeId: activeSession.storeId,
        before: endBefore,
        after: endAfter,
        reason: reconciliationRequired
          ? "Nhân viên kết ca; thời lượng vượt ngưỡng và được chuyển sang chờ quản lý đối soát."
          : earlyEnd
            ? "Nhân viên xác nhận kết ca trước giờ dự kiến."
            : "Nhân viên kết ca theo lịch đã phân.",
        createdAt: endedAt,
      }, `EXISTS (
        SELECT 1 FROM shift_sessions closed
        WHERE closed.id = ? AND closed.status = 'COMPLETED'
          AND closed.close_status = 'CONFIRMED'
          AND closed.ended_at = ?
      )`, [activeSession.id, endedAt]),
      ]) as unknown[];
    } catch {
      if (await isStorePeriodLocked(db, activeSession.storeId, shiftPeriod)) {
        return json({ message: "Kỳ chấm công của cửa hàng đã khóa sổ. Không thể kết ca hoặc thay đổi dữ liệu trong kỳ này." }, 423);
      }
      const stillActive = await db.prepare("SELECT id FROM shift_sessions WHERE id = ? AND status = 'ACTIVE' LIMIT 1")
        .bind(activeSession.id).first<{ id: string }>();
      if (!stillActive) {
        return json({ message: "Ca làm đã được kết thúc bởi một yêu cầu khác. Vui lòng tải lại trang." }, 409);
      }
      const latestOrderRows = await db.prepare(`
        SELECT payment_method AS paymentMethod, COALESCE(SUM(amount), 0) AS amount
        FROM orders
        WHERE store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'
        GROUP BY payment_method
      `).bind(activeSession.storeId, user.employeeId, user.currentShift)
        .all<{ paymentMethod: string; amount: number }>();
      const latestTender = latestOrderRows.results.reduce((totals, row) => {
        if (row.paymentMethod === "CASH") totals.cash += Number(row.amount);
        if (row.paymentMethod === "BANK_TRANSFER") totals.bankTransfer += Number(row.amount);
        return totals;
      }, { cash: 0, bankTransfer: 0 });
      if (latestTender.cash !== cashRevenue || latestTender.bankTransfer !== transferRevenue) {
        return json({
          message: "Đơn hàng hoặc doanh thu đã thay đổi trong lúc kết ca. Vui lòng tải lại số liệu, đối soát và thử lại.",
          revenueChanged: true,
          reconciliation: {
            expected: latestTender,
            entered: { cash: cashRevenue, bankTransfer: transferRevenue },
            differences: tenderDifferences(latestTender, { cash: cashRevenue, bankTransfer: transferRevenue }),
          },
        }, 409);
      }
      return json({ message: "Không thể kết ca, ghi dòng tiền và nhật ký kiểm toán một cách an toàn. Không có dữ liệu nào được ghi; vui lòng thử lại." }, 500);
    }
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
    const returnedToHomeStore = Boolean(activeSession.transferId);
    return json({
      active: false,
      endedAt,
      message: reconciliationRequired
        ? "Đã kết ca. Thời lượng bất thường đang chờ quản lý đối soát và chưa được tính vào lương."
        : "Đã kết ca và ghi nhận lịch sử ca làm.",
      tiktokAllowance: allowance,
      employeeTiktokAllowance: appliedTikTokAllowance,
      expenseAmount,
      cashRevenue,
      transferRevenue,
      totalRevenue: cashRevenue + transferRevenue,
      workedSeconds,
      workedMinutes,
      reconciliationRequired,
      reconciliationStatus,
      reconciliationReason,
      attendanceMaxShiftMinutes: Number(maxShiftMinutes),
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
