export const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

export type ShiftClockDefinition = {
  name: string;
  start: string;
  end: string;
};

export type ShiftOccurrence = ShiftClockDefinition & {
  workDate: string;
  startAt: string;
  endAt: string;
};

export type OrderedShiftDefinition = ShiftClockDefinition & {
  sortOrder?: number;
};

export type AttendanceStatus = "EARLY" | "ON_TIME" | "LATE";

/** Employees may clock in up to two hours before the scheduled start. */
export const ATTENDANCE_EARLY_WINDOW_MINUTES = 120;

/** Legacy/default grace. New clock-ins receive a database policy snapshot. */
export const ATTENDANCE_ON_TIME_GRACE_MINUTES = 15;

export const DEFAULT_SHIFT_DEFINITIONS: ShiftClockDefinition[] = [
  { name: "Ca 1", start: "07:00", end: "12:00" },
  { name: "Ca 2", start: "12:00", end: "17:00" },
  { name: "Ca 3", start: "17:00", end: "23:00" },
];

const clockPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const numberedShiftPattern = /^\s*ca\s*0*(\d+)(?:\D|$)/iu;
const scheduleRequestPattern = /^[a-zA-Z0-9:_-]{16,200}$/;

export function shiftNumber(name: string) {
  const match = name.match(numberedShiftPattern);
  return match ? Number(match[1]) : null;
}

/** Keep numbered shifts in the familiar Ca 1 -> Ca 2 -> Ca 3 order. */
export function compareShiftDefinitions(left: OrderedShiftDefinition, right: OrderedShiftDefinition) {
  const leftOrder = Number.isInteger(left.sortOrder) && Number(left.sortOrder) > 0
    ? Number(left.sortOrder)
    : shiftNumber(left.name);
  const rightOrder = Number.isInteger(right.sortOrder) && Number(right.sortOrder) > 0
    ? Number(right.sortOrder)
    : shiftNumber(right.name);
  if (leftOrder !== null || rightOrder !== null) {
    if (leftOrder === null) return 1;
    if (rightOrder === null) return -1;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  }
  return left.start.localeCompare(right.start) || left.name.localeCompare(right.name, "vi");
}

export function normalizeScheduleClientRequestId(value: unknown) {
  const normalized = String(value ?? "").trim();
  return scheduleRequestPattern.test(normalized) ? normalized : null;
}

/** A deterministic id makes a retried multi-shift save safe and idempotent. */
export async function scheduleRecordId(storeId: string, clientRequestId: string) {
  const source = new TextEncoder().encode(`schedule:${storeId}:${clientRequestId}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `schedule-${hash}`;
}

export function validClock(value: string) {
  return clockPattern.test(value);
}

export function clockMinutes(value: string) {
  const match = value.match(clockPattern);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isOvernightShift(start: string, end: string) {
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  return Number.isFinite(from) && Number.isFinite(to) && to < from;
}

export function shiftDurationMinutes(start: string, end: string) {
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return 0;
  return to > from ? to - from : 24 * 60 - from + to;
}

export function formatShiftDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} phút`;
  return remainder ? `${hours} giờ ${remainder} phút` : `${hours} giờ`;
}

export function localDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: VIETNAM_TIME_ZONE }).format(value);
}

export function addDays(value: string, amount: number) {
  if (!datePattern.test(value)) return value;
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + amount));
  return next.toISOString().slice(0, 10);
}

export function weekDates(anchor: string) {
  if (!datePattern.test(anchor)) return [];
  const [year, month, day] = anchor.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return Array.from({ length: 7 }, (_, index) => addDays(anchor, mondayOffset + index));
}

function localTimestamp(date: string, clock: string) {
  if (!datePattern.test(date) || !validClock(clock)) return Number.NaN;
  return Date.parse(`${date}T${clock}:00+07:00`);
}

export function shiftInterval(date: string, start: string, end: string) {
  const from = localTimestamp(date, start);
  const duration = shiftDurationMinutes(start, end);
  if (!Number.isFinite(from) || duration <= 0) return null;
  return { from, to: from + duration * 60_000 };
}

/**
 * Convert a Vietnam-local work date and clock range into stable UTC timestamps.
 * The interval calculation deliberately carries an overnight shift into the
 * following calendar day before serializing it.
 */
export function shiftUtcRange(date: string, start: string, end: string) {
  const interval = shiftInterval(date, start, end);
  if (!interval) return null;
  return {
    startAt: new Date(interval.from).toISOString(),
    endAt: new Date(interval.to).toISOString(),
  };
}

/**
 * Resolve the configured occurrence which is open at an exact instant.
 * Checking complete UTC intervals (instead of only the local clock) prevents
 * a completed occurrence from being mistaken for yesterday's shift and also
 * handles overnight shifts consistently.
 */
export function shiftOccurrenceAt(
  now: Date | string,
  definitions: ShiftClockDefinition[],
): ShiftOccurrence | null {
  const instant = typeof now === "string" ? new Date(now) : now;
  const instantTime = instant.getTime();
  if (!Number.isFinite(instantTime)) return null;

  const anchor = localDate(instant);
  const dates = [addDays(anchor, -1), anchor];
  const occurrences = definitions.flatMap((definition, definitionIndex) => {
    if (!definition.name.trim() || !validClock(definition.start) || !validClock(definition.end)) return [];
    return dates.flatMap((workDate) => {
      const range = shiftUtcRange(workDate, definition.start, definition.end);
      if (!range) return [];
      const startTime = new Date(range.startAt).getTime();
      const endTime = new Date(range.endAt).getTime();
      if (instantTime < startTime || instantTime >= endTime) return [];
      return [{ ...definition, workDate, ...range, definitionIndex }];
    });
  });

  occurrences.sort((left, right) => {
    const byStart = new Date(right.startAt).getTime() - new Date(left.startAt).getTime();
    return byStart || left.definitionIndex - right.definitionIndex;
  });
  const current = occurrences[0];
  if (!current) return null;
  const { definitionIndex: _definitionIndex, ...occurrence } = current;
  void _definitionIndex;
  return occurrence;
}

/**
 * Resolve the occurrence available for attendance. An occurrence already in
 * progress wins; otherwise the next occurrence is available from exactly the
 * configured early window before its scheduled start. The scheduled timestamps remain intact
 * so payroll and attendance reports never replace actual clock-in time.
 */
export function attendanceOccurrenceAt(
  now: Date | string,
  definitions: ShiftClockDefinition[],
  earlyWindowMinutes = ATTENDANCE_EARLY_WINDOW_MINUTES,
) {
  const instant = typeof now === "string" ? new Date(now) : now;
  const instantTime = instant.getTime();
  if (!Number.isFinite(instantTime)) return null;
  const current = shiftOccurrenceAt(instant, definitions);
  if (current) return current;
  const next = nextShiftOccurrence(instant.toISOString(), definitions);
  if (!next) return null;
  const untilStart = new Date(next.startAt).getTime() - instantTime;
  const earlyWindowMs = Math.max(0, earlyWindowMinutes) * 60_000;
  return untilStart >= 0 && untilStart <= earlyWindowMs ? next : null;
}

export type AttendanceCandidate = ShiftOccurrence & {
  selectionKind: "CURRENT" | "UPCOMING";
  attendanceStatus: AttendanceStatus;
  attendanceDeltaMinutes: number;
};

/**
 * Return the server-authoritative attendance choices at an exact instant.
 * A running occurrence is first. The immediately upcoming occurrence is also
 * offered only while it is inside the early clock-in window. This lets the UI
 * ask "current or next" near a shift boundary without ever trusting a client
 * supplied clock or schedule.
 */
export function attendanceCandidatesAt(
  now: Date | string,
  definitions: ShiftClockDefinition[],
  earlyWindowMinutes = ATTENDANCE_EARLY_WINDOW_MINUTES,
  graceMinutes = ATTENDANCE_ON_TIME_GRACE_MINUTES,
): AttendanceCandidate[] {
  const instant = typeof now === "string" ? new Date(now) : now;
  const instantTime = instant.getTime();
  if (!Number.isFinite(instantTime)) return [];

  const candidates: AttendanceCandidate[] = [];
  const current = shiftOccurrenceAt(instant, definitions);
  if (current) {
    const delta = attendanceDeltaMinutes(instant, current.startAt);
    const status = attendanceStatusAt(instant, current.startAt, graceMinutes);
    if (delta !== null && status !== null) {
      candidates.push({
        ...current,
        selectionKind: "CURRENT",
        attendanceStatus: status,
        attendanceDeltaMinutes: delta,
      });
    }
  }

  const next = nextShiftOccurrence(instant.toISOString(), definitions);
  if (next && (!current || next.startAt !== current.startAt || next.endAt !== current.endAt)) {
    const untilStart = new Date(next.startAt).getTime() - instantTime;
    const earlyWindowMs = Math.max(0, earlyWindowMinutes) * 60_000;
    if (untilStart > 0 && untilStart <= earlyWindowMs) {
      const delta = attendanceDeltaMinutes(instant, next.startAt);
      if (delta !== null) {
        candidates.push({
          ...next,
          selectionKind: "UPCOMING",
          attendanceStatus: "EARLY",
          attendanceDeltaMinutes: delta,
        });
      }
    }
  }
  return candidates;
}

/** Signed whole minutes: negative is early, positive is late. */
export function attendanceDeltaMinutes(actualStartedAt: Date | string, scheduledStartAt: Date | string) {
  const actual = new Date(actualStartedAt).getTime();
  const scheduled = new Date(scheduledStartAt).getTime();
  if (!Number.isFinite(actual) || !Number.isFinite(scheduled)) return null;
  const difference = (actual - scheduled) / 60_000;
  if (difference === 0) return 0;
  return difference > 0 ? Math.ceil(difference) : Math.floor(difference);
}

export function attendanceStatusAt(
  actualStartedAt: Date | string,
  scheduledStartAt: Date | string,
  graceMinutes = ATTENDANCE_ON_TIME_GRACE_MINUTES,
): AttendanceStatus | null {
  const actual = new Date(actualStartedAt).getTime();
  const scheduled = new Date(scheduledStartAt).getTime();
  if (!Number.isFinite(actual) || !Number.isFinite(scheduled)) return null;
  if (actual < scheduled) return "EARLY";
  return actual <= scheduled + Math.max(0, graceMinutes) * 60_000 ? "ON_TIME" : "LATE";
}

export function shiftsOverlap(
  firstDate: string,
  firstStart: string,
  firstEnd: string,
  secondDate: string,
  secondStart: string,
  secondEnd: string,
) {
  const first = shiftInterval(firstDate, firstStart, firstEnd);
  const second = shiftInterval(secondDate, secondStart, secondEnd);
  if (!first || !second) return false;
  return first.from < second.to && second.from < first.to;
}

/**
 * Find the next configured shift occurrence at or after an instant. This is
 * used to preview an upcoming clock-in without changing an ACTIVE session.
 */
export function nextShiftOccurrence(
  boundaryAt: string,
  definitions: ShiftClockDefinition[],
): ShiftOccurrence | null {
  const boundary = new Date(boundaryAt);
  const boundaryTime = boundary.getTime();
  if (!Number.isFinite(boundaryTime)) return null;

  const anchor = localDate(boundary);
  const dates = [anchor, addDays(anchor, 1), addDays(anchor, 2)];
  const candidates = definitions.flatMap((definition, definitionIndex) => {
    if (!definition.name.trim() || !validClock(definition.start) || !validClock(definition.end)) return [];
    return dates.flatMap((workDate) => {
      const range = shiftUtcRange(workDate, definition.start, definition.end);
      if (!range || new Date(range.startAt).getTime() < boundaryTime) return [];
      return [{
        ...definition,
        workDate,
        startAt: range.startAt,
        endAt: range.endAt,
        definitionIndex,
      }];
    });
  });

  candidates.sort((left, right) => {
    const byStart = new Date(left.startAt).getTime() - new Date(right.startAt).getTime();
    return byStart || left.definitionIndex - right.definitionIndex;
  });
  const next = candidates[0];
  if (!next) return null;
  const { definitionIndex: _definitionIndex, ...occurrence } = next;
  void _definitionIndex;
  return occurrence;
}
