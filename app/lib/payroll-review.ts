import { durationMinutes, multiplyRatioVnd, requireVnd, sumVnd } from "./finance";

export const PAYROLL_REVIEW_CATEGORY = "PAYROLL_REVIEW";
export const MAX_REVIEW_SECONDS = 31 * 24 * 3_600;
export const payrollReviewFields = ["durationSeconds", "kpiDurationSeconds", "tiktokAllowance", "supportAllowance", "manualAllowance", "manualBonus"] as const;
export type PayrollReviewValues = Record<typeof payrollReviewFields[number], number> & { kpiBonus: number | null };
export type PayrollReviewSource = PayrollReviewValues & { baseSalary: number; hourlyRate: number };
export type PayrollReview = {
  employeeId: string; period: string; version: number; values: PayrollReviewValues;
  source: PayrollReviewSource; reason: string; updatedAt: string; updatedBy: string;
};
export type PayrollReviewState = PayrollReview & { stale: boolean };

export function payrollReviewSource(item: PayrollReviewSource): PayrollReviewSource {
  return { durationSeconds: item.durationSeconds, kpiDurationSeconds: item.kpiDurationSeconds,
    baseSalary: item.baseSalary, hourlyRate: item.hourlyRate, tiktokAllowance: item.tiktokAllowance,
    supportAllowance: item.supportAllowance, manualAllowance: item.manualAllowance,
    manualBonus: item.manualBonus, kpiBonus: null };
}

export function reviewSourceMatches(left: PayrollReviewSource, right: PayrollReviewSource) {
  return JSON.stringify(payrollReviewSource(left)) === JSON.stringify(payrollReviewSource(right));
}

/** Preserve the period's weighted shift rates when correcting payroll hours. */
export function applyPayrollReview<T extends PayrollReviewSource>(item: T, review?: PayrollReview): T {
  if (!review) return item;
  const { values } = review;
  const baseSalary = item.durationSeconds > 0
    ? multiplyRatioVnd(item.baseSalary, values.durationSeconds, item.durationSeconds)
    : multiplyRatioVnd(item.hourlyRate, values.durationSeconds, 3_600);
  return { ...item, ...values, baseSalary, kpiBonus: values.kpiBonus ?? item.kpiBonus,
    durationMinutes: durationMinutes(values.durationSeconds), hours: values.durationSeconds / 3_600,
    kpiHours: values.kpiDurationSeconds / 3_600 };
}

export function reviewedKpiAmount(employeeId: string, calculated: number, reviews: ReadonlyMap<string, PayrollReview>) {
  return reviews.get(employeeId)?.values.kpiBonus ?? calculated;
}

export class PayrollReviewError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}

export function validatePayrollReviewValues(input: unknown): PayrollReviewValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PayrollReviewError("Số liệu đối soát không hợp lệ.", 400);
  const value = input as Record<string, unknown>;
  const result: Record<string, number | null> = {};
  for (const field of [...payrollReviewFields, "kpiBonus"] as const) {
    if (field === "kpiBonus" && value[field] === null) { result[field] = null; continue; }
    if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new PayrollReviewError("Giờ phải hợp lệ; phụ cấp và thưởng phải là số đồng nguyên không âm.", 400);
    }
    result[field] = value[field];
  }
  const values = result as PayrollReviewValues;
  if (values.durationSeconds > MAX_REVIEW_SECONDS || values.kpiDurationSeconds > values.durationSeconds) {
    throw new PayrollReviewError("Giờ tính KPI không được vượt giờ tính lương; tổng giờ không được vượt 744 giờ/kỳ.", 400);
  }
  try { sumVnd([values.tiktokAllowance, values.supportAllowance, values.manualAllowance, values.manualBonus, values.kpiBonus ?? 0]); }
  catch { throw new PayrollReviewError("Tổng phụ cấp và thưởng vượt giới hạn số tiền.", 400); }
  return values;
}

export async function readPayrollReviews(db: D1Database, storeId: string, period: string) {
  const rows = await db.prepare(`SELECT data_json FROM business_records
    WHERE category = 'PAYROLL_REVIEW' AND store_id = ? AND status = 'ACTIVE'
      AND json_extract(data_json, '$.period') = ? ORDER BY id`).bind(storeId, period).all<{ data_json: string }>();
  return new Map(rows.results.map((row) => {
    const review = JSON.parse(row.data_json) as PayrollReview;
    return [review.employeeId, review] as const;
  }));
}

export async function savePayrollReview(db: D1Database, input: {
  storeId: string; period: string; employeeId: string; actorId: string; expectedVersion: unknown;
  values: unknown; source: PayrollReviewSource; reason: string;
}) {
  const { storeId, period, employeeId, actorId, expectedVersion } = input;
  const values = validatePayrollReviewValues(input.values);
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) {
    throw new PayrollReviewError("Phiên bản đối soát không hợp lệ.", 400);
  }
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) throw new PayrollReviewError("Nhập lý do sửa từ 5 đến 500 ký tự.", 400);
  const before = (await readPayrollReviews(db, storeId, period)).get(employeeId) ?? null;
  if ((before?.version ?? 0) !== expectedVersion) throw new PayrollReviewError("Số liệu vừa được người khác sửa. Tải lại trước khi lưu.");
  const updatedAt = new Date().toISOString();
  const after: PayrollReview = { employeeId, period, version: expectedVersion + 1,
    values, source: payrollReviewSource(input.source), reason, updatedAt, updatedBy: actorId };
  try {
    const baseSalary = requireVnd(applyPayrollReview(input.source, after).baseSalary, "Lương sau đối soát");
    sumVnd([baseSalary, values.tiktokAllowance, values.supportAllowance, values.manualAllowance, values.manualBonus, values.kpiBonus ?? 0]);
  } catch { throw new PayrollReviewError("Tổng lương sau cập nhật vượt giới hạn số tiền.", 400); }
  const id = `payroll-review:${storeId}:${employeeId}:${period}`;
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
        SELECT ?, 'PAYROLL_REVIEW', ?, ?, 'Đối soát lương nhân viên', ?, 'ACTIVE', ?, ?
        WHERE COALESCE((SELECT json_extract(data_json, '$.version') FROM business_records WHERE id = ?), 0) = ?
        ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, owner_id = excluded.owner_id,
          updated_at = excluded.updated_at WHERE json_extract(business_records.data_json, '$.version') = ?`)
        .bind(id, storeId, actorId, JSON.stringify(after), updatedAt, updatedAt, id, expectedVersion, expectedVersion),
      db.prepare(`INSERT INTO audit_logs
        (id, user_id, store_id, action, entity_type, entity_id, before_json, after_json, reason, created_at)
        SELECT ?, ?, ?, 'PAYROLL_REVIEW_SAVE', 'PAYROLL_REVIEW', ?, ?, ?, ?, ? WHERE changes() = 1`)
        .bind(crypto.randomUUID(), actorId, storeId, id, JSON.stringify(before), JSON.stringify(after), reason, updatedAt),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1) throw new PayrollReviewError("Số liệu vừa thay đổi. Tải lại trước khi lưu.");
  } catch (error) {
    if (String(error).includes("payroll review is frozen")) throw new PayrollReviewError("Kỳ đã chốt hoặc đang chốt lương; không thể sửa số liệu.");
    throw error;
  }
  return after;
}
