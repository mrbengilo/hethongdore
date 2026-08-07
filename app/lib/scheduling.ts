export const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

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
