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

export const DEFAULT_SHIFT_DEFINITIONS: ShiftClockDefinition[] = [
  { name: "Ca 1", start: "07:00", end: "12:00" },
  { name: "Ca 2", start: "12:00", end: "17:00" },
  { name: "Ca 3", start: "17:00", end: "23:00" },
];

const clockPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

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
 * The employee gets a 60-minute grace period after the scheduled end. Once
 * that instant is reached, attendance is split at the scheduled end itself so
 * the old and new sessions remain continuous without overlapping.
 */
export function shouldRollOverShift(
  scheduledEndAt: string,
  now: Date | string = new Date(),
  graceMinutes = 60,
) {
  const end = new Date(scheduledEndAt).getTime();
  const current = typeof now === "string" ? new Date(now).getTime() : now.getTime();
  return Number.isFinite(end)
    && Number.isFinite(current)
    && Number.isFinite(graceMinutes)
    && graceMinutes >= 0
    && current >= end + graceMinutes * 60_000;
}

/**
 * Find the next configured shift occurrence at or after an attendance split.
 * The actual next session may start earlier than its scheduled start when
 * configured shifts have a gap; its `started_at` is deliberately kept at the
 * split boundary by the caller to preserve continuous paid time.
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
