"use client";

import { ActionButton, ActionForm } from "./ActionFeedback";

import { useState, type FormEvent } from "react";
import { validatePayrollReviewValues, type PayrollReviewSource, type PayrollReviewState, type PayrollReviewValues } from "../lib/payroll-review";
import { formatVndInput, parseVndInput } from "../lib/format";
import styles from "./StorePayrollClosing.module.css";

type ReviewItem = PayrollReviewSource & {
  employeeName: string; employeeCode: string; review?: PayrollReviewState;
};
const amounts = [
  ["tiktokAllowance", "Phụ cấp TikTok"], ["supportAllowance", "Phụ cấp hỗ trợ"],
  ["manualAllowance", "Phụ cấp khác"], ["manualBonus", "Thưởng khác"],
] as const;

export default function PayrollReviewEditor({ item, busy, onUpdate, onCancel }: {
  item: ReviewItem; busy: boolean;
  onUpdate: (values: PayrollReviewValues, reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState(() => ({
    hours: String(Number((item.durationSeconds / 3_600).toFixed(6))),
    kpiHours: String(Number((item.kpiDurationSeconds / 3_600).toFixed(6))),
    tiktokAllowance: formatVndInput(item.tiktokAllowance), supportAllowance: formatVndInput(item.supportAllowance),
    manualAllowance: formatVndInput(item.manualAllowance), manualBonus: formatVndInput(item.manualBonus),
    kpiBonus: formatVndInput(item.review?.values.kpiBonus ?? item.kpiBonus ?? 0),
    kpiAutomatic: item.review?.values.kpiBonus == null,
    reason: "",
  }));
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    try {
      const required = [fields.hours, fields.kpiHours, ...amounts.map(([key]) => fields[key]), ...(fields.kpiAutomatic ? [] : [fields.kpiBonus])];
      if (required.some((value) => !value.trim())) throw new Error("Nhập đầy đủ số liệu; khoản không có nhập 0.");
      const hours = Number(fields.hours), kpiHours = Number(fields.kpiHours);
      if (!Number.isFinite(hours) || !Number.isFinite(kpiHours) || hours < 0 || kpiHours < 0 || hours > 744 || kpiHours > hours) {
        throw new Error("Giờ tính KPI không được vượt giờ tính lương; giờ phải từ 0 đến 744.");
      }
      const values = validatePayrollReviewValues({
        durationSeconds: Math.round(hours * 3_600), kpiDurationSeconds: Math.round(kpiHours * 3_600),
        ...Object.fromEntries(amounts.map(([key]) => [key, parseVndInput(fields[key])])),
        kpiBonus: fields.kpiAutomatic ? null : parseVndInput(fields.kpiBonus),
      });
      if (fields.reason.trim().length < 5) throw new Error("Nhập lý do sửa ít nhất 5 ký tự để lưu lịch sử đối soát.");
      await onUpdate(values, fields.reason.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Không thể cập nhật số liệu."); }
  };
  return <section className={`manager-panel ${styles.reviewPanel}`} aria-labelledby="payroll-review-title" id="payroll-review-editor">
    <h3 id="payroll-review-title">Cập nhật số liệu · {item.employeeName}</h3>
    <p>{item.employeeCode} · Cập nhật xong, xem lại bảng lương rồi mới chốt.</p>
    {item.review?.stale && <p className="form-message">Dữ liệu nguồn đã thay đổi sau lần cập nhật trước. Kiểm tra lại các số dưới đây.</p>}
    <ActionForm onSubmit={(event) => submit(event)}>
      <fieldset disabled={busy} className={styles.reviewFields}>
        <legend className="sr-only">Giờ, phụ cấp và thưởng của {item.employeeName}</legend>
        <label>Giờ tính lương<input type="number" min="0" max="744" step="any" inputMode="decimal" required value={fields.hours} onChange={(event) => setFields({ ...fields, hours: event.target.value })}/></label>
        <label>Giờ tính KPI<input type="number" min="0" max="744" step="any" inputMode="decimal" required value={fields.kpiHours} onChange={(event) => setFields({ ...fields, kpiHours: event.target.value })}/></label>
        {amounts.map(([key, label]) => <label key={key}>{label} (đồng)<input type="text" inputMode="numeric" pattern="[0-9,]*" required value={fields[key]} onChange={(event) => setFields({ ...fields, [key]: formatVndInput(event.target.value) })}/></label>)}
        <label>Thưởng KPI (đồng)<input type="text" inputMode="numeric" pattern="[0-9,]*" required={!fields.kpiAutomatic} disabled={fields.kpiAutomatic} value={fields.kpiBonus} onChange={(event) => setFields({ ...fields, kpiBonus: formatVndInput(event.target.value) })}/></label>
        <label className={styles.reviewCheckbox}><input type="checkbox" checked={fields.kpiAutomatic} onChange={(event) => setFields({ ...fields, kpiAutomatic: event.target.checked })}/> Thưởng KPI theo công thức</label>
        <label className={styles.reviewReason}>Lý do sửa<textarea rows={2} minLength={5} maxLength={500} required value={fields.reason} onChange={(event) => setFields({ ...fields, reason: event.target.value })}/></label>
      </fieldset>
      <p className={styles.reviewHint}>Nhập tổng số cuối cùng cho từng khoản. Lương tính theo đơn giá bình quân của các ca trong kỳ; giờ KPI được xét riêng. Giờ chấm công gốc được giữ để đối chiếu.</p>
      {error && <div className="form-message" role="alert">{error}</div>}
      <div className={styles.reviewActions}>
        <ActionButton type="submit" disabled={busy}>{busy ? "Đang cập nhật…" : "Cập nhật số liệu"}</ActionButton>
        <ActionButton type="button" disabled={busy} onClick={onCancel}>Hủy sửa</ActionButton>
      </div>
    </ActionForm>
  </section>;
}
