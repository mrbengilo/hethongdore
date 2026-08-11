export type AttendanceStatsMode = "day" | "week" | "month";
export type AttendanceSnapshotStatus = "EARLY" | "ON_TIME" | "LATE";
export type AttendanceEvaluationCode = "NO_DATA" | "EXCELLENT" | "GOOD" | "FAIR" | "NEEDS_IMPROVEMENT";

export type AttendanceEmployeeSeed = {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string | null;
};

export type AttendanceSnapshot = AttendanceEmployeeSeed & {
  attendanceStatus: string | null;
  attendanceDeltaMinutes: number | null;
};

export type AttendanceEvaluation = {
  code: AttendanceEvaluationCode;
  label: string;
  reason: string;
};

export type AttendanceStatsRow = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  early: number;
  onTime: number;
  late: number;
  unknown: number;
  classifiedCount: number;
  totalLateMinutes: number;
  lateRatePercent: number;
  evaluation: AttendanceEvaluation;
};

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const ATTENDANCE_EVALUATION_RULES = [
  { code: "NO_DATA", label: "Chưa có dữ liệu", description: "Chưa có ca với trạng thái điểm danh đã được lưu." },
  { code: "EXCELLENT", label: "Xuất sắc", description: "Không có ca đi trễ." },
  { code: "GOOD", label: "Tốt", description: "Tỷ lệ đi trễ không quá 10% và tổng thời gian trễ không quá 15 phút." },
  { code: "FAIR", label: "Khá", description: "Tỷ lệ đi trễ không quá 25% và tổng thời gian trễ không quá 60 phút." },
  { code: "NEEDS_IMPROVEMENT", label: "Cần cải thiện", description: "Vượt một trong các ngưỡng của mức Khá." },
] as const;

function validLocalDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function addLocalDays(value: string, amount: number) {
  if (!validLocalDate(value) || !Number.isSafeInteger(amount)) throw new Error("Ngày tham chiếu không hợp lệ.");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day + amount));
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

export function attendanceStatsDateRange(mode: AttendanceStatsMode, anchor: string) {
  if (!validLocalDate(anchor)) throw new Error("Ngày tham chiếu không hợp lệ.");
  if (mode === "day") return { from: anchor, to: anchor };
  if (mode === "week") {
    const [year, month, day] = anchor.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const from = addLocalDays(anchor, -((weekday + 6) % 7));
    return { from, to: addLocalDays(from, 6) };
  }
  const [year, month] = anchor.split("-").map(Number);
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, "0")}` };
}

function publicEmployee(seed: AttendanceEmployeeSeed) {
  return {
    employeeId: seed.employeeId,
    employeeCode: seed.employeeCode?.trim() || "CHƯA CÓ MÃ",
    employeeName: seed.employeeName?.trim() || "Nhân viên không còn trong danh sách",
  };
}

function evaluation(late: number, classifiedCount: number, totalLateMinutes: number): AttendanceEvaluation {
  if (classifiedCount === 0) return {
    code: "NO_DATA",
    label: "Chưa có dữ liệu",
    reason: "Chưa có ca với trạng thái điểm danh đã được lưu.",
  };
  if (late === 0) return { code: "EXCELLENT", label: "Xuất sắc", reason: "Không có ca đi trễ." };
  const lateRate = late / classifiedCount;
  if (lateRate <= 0.1 && totalLateMinutes <= 15) return {
    code: "GOOD",
    label: "Tốt",
    reason: "Tỷ lệ trễ ≤ 10% và tổng phút trễ ≤ 15.",
  };
  if (lateRate <= 0.25 && totalLateMinutes <= 60) return {
    code: "FAIR",
    label: "Khá",
    reason: "Tỷ lệ trễ ≤ 25% và tổng phút trễ ≤ 60.",
  };
  return {
    code: "NEEDS_IMPROVEMENT",
    label: "Cần cải thiện",
    reason: "Tỷ lệ trễ hoặc tổng phút trễ vượt ngưỡng mức Khá.",
  };
}

export function buildAttendanceStats(
  snapshots: AttendanceSnapshot[],
  employeeSeeds: AttendanceEmployeeSeed[] = [],
): AttendanceStatsRow[] {
  const employees = new Map<string, AttendanceStatsRow>();
  const ensure = (seed: AttendanceEmployeeSeed) => {
    const existing = employees.get(seed.employeeId);
    if (existing) return existing;
    const employee = publicEmployee(seed);
    const row: AttendanceStatsRow = {
      ...employee,
      early: 0,
      onTime: 0,
      late: 0,
      unknown: 0,
      classifiedCount: 0,
      totalLateMinutes: 0,
      lateRatePercent: 0,
      evaluation: evaluation(0, 0, 0),
    };
    employees.set(seed.employeeId, row);
    return row;
  };

  for (const seed of employeeSeeds) ensure(seed);
  for (const snapshot of snapshots) {
    const row = ensure(snapshot);
    const status = snapshot.attendanceStatus;
    if (status === "EARLY") row.early += 1;
    else if (status === "ON_TIME") row.onTime += 1;
    else if (status === "LATE") {
      row.late += 1;
      const delta = Number(snapshot.attendanceDeltaMinutes);
      if (Number.isSafeInteger(delta) && delta > 0) row.totalLateMinutes += delta;
    } else row.unknown += 1;
  }

  for (const row of employees.values()) {
    row.classifiedCount = row.early + row.onTime + row.late;
    row.lateRatePercent = row.classifiedCount
      ? Math.round(row.late / row.classifiedCount * 1_000) / 10
      : 0;
    row.evaluation = evaluation(row.late, row.classifiedCount, row.totalLateMinutes);
  }

  return [...employees.values()].sort((left, right) => (
    right.late - left.late
    || right.totalLateMinutes - left.totalLateMinutes
    || left.employeeName.localeCompare(right.employeeName, "vi")
    || left.employeeCode.localeCompare(right.employeeCode, "vi")
  ));
}
