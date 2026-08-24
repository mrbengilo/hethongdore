"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Clock3, RefreshCw, Save, ShieldCheck } from "lucide-react";
import styles from "./AttendancePolicySettings.module.css";
import { PayrollPolicySettings } from "./PayrollPolicySettings";

type PolicyResponse = {
  policy?: {
    lateGraceMinutes: number;
    earlyClockInWindowMinutes: number;
    maxShiftDurationMinutes: number;
    version: number;
    updatedAt: string;
    updatedByName: string | null;
    appliesTo: "NEW_CLOCK_INS_ONLY";
  };
  limits?: { min: number; max: number };
  earlyWindowLimits?: { min: number; max: number };
  maxShiftDurationLimits?: { min: number; max: number };
  message?: string;
};

const formatDateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "medium",
  hourCycle: "h23",
  timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date(value));

export function AttendancePolicySettings() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [minutes, setMinutes] = useState("");
  const [earlyMinutes, setEarlyMinutes] = useState("");
  const [maxShiftMinutes, setMaxShiftMinutes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/attendance-policy", { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as PolicyResponse;
      if (!response.ok || !body.policy || !body.limits) throw new Error(body.message ?? "Không thể tải chính sách đi trễ.");
      if (requestId !== requestVersion.current) return;
      setData(body);
      setMinutes(String(body.policy.lateGraceMinutes));
      setEarlyMinutes(String(body.policy.earlyClockInWindowMinutes));
      setMaxShiftMinutes(String(body.policy.maxShiftDurationMinutes));
    } catch (cause) {
      if (requestId === requestVersion.current) setError(cause instanceof Error ? cause.message : "Không thể tải chính sách đi trễ.");
    } finally {
      if (requestId === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!data?.policy || !data.limits || saving) return;
    const value = Number(minutes);
    const earlyValue = Number(earlyMinutes);
    const maxShiftValue = Number(maxShiftMinutes);
    if (!Number.isInteger(value) || value < data.limits.min || value > data.limits.max) {
      setError(`Nhập số phút nguyên từ ${data.limits.min} đến ${data.limits.max}.`);
      return;
    }
    if (!data.earlyWindowLimits || !Number.isInteger(earlyValue)
      || earlyValue < data.earlyWindowLimits.min || earlyValue > data.earlyWindowLimits.max) {
      setError("Thời gian điểm danh sớm không hợp lệ.");
      return;
    }
    if (!data.maxShiftDurationLimits || !Number.isInteger(maxShiftValue)
      || maxShiftValue < data.maxShiftDurationLimits.min || maxShiftValue > data.maxShiftDurationLimits.max) {
      setError("Giới hạn thời lượng ca cần đối soát không hợp lệ.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/attendance-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lateGraceMinutes: value,
          earlyClockInWindowMinutes: earlyValue,
          maxShiftDurationMinutes: maxShiftValue,
          expectedVersion: data.policy.version,
        }),
      });
      const body = await response.json().catch(() => ({})) as PolicyResponse;
      if (!response.ok || !body.policy || !body.limits) {
        if (body.policy && body.limits) {
          setData(body);
          setMinutes(String(body.policy.lateGraceMinutes));
          setEarlyMinutes(String(body.policy.earlyClockInWindowMinutes));
          setMaxShiftMinutes(String(body.policy.maxShiftDurationMinutes));
        }
        throw new Error(body.message ?? "Không thể lưu chính sách đi trễ.");
      }
      requestVersion.current += 1;
      setData(body);
      setMinutes(String(body.policy.lateGraceMinutes));
      setEarlyMinutes(String(body.policy.earlyClockInWindowMinutes));
      setMaxShiftMinutes(String(body.policy.maxShiftDurationMinutes));
      setMessage(`Đã lưu thời gian đi trễ ${body.policy.lateGraceMinutes} phút.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể lưu chính sách đi trễ.");
    } finally {
      setSaving(false);
    }
  }

  return <main className={styles.page} aria-labelledby="attendance-policy-title">
    <section className={styles.intro}>
      <span><ShieldCheck size={25} aria-hidden="true"/></span>
      <div><h2 id="attendance-policy-title">Cài Đặt Chính Sách</h2><p>Thiết lập quy tắc chấm công dùng chung cho toàn hệ thống DORE.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={17} aria-hidden="true"/> Làm mới</button>
    </section>
    <section className={styles.card} aria-labelledby="late-policy-title">
      <header><span><Clock3 size={23} aria-hidden="true"/></span><div><h3 id="late-policy-title">Set thời gian đi trễ</h3><p>Nhân viên chỉ được gắn trạng thái “Đi trễ” khi thời điểm điểm danh vượt quá số phút này sau giờ bắt đầu ca.</p></div></header>
      {loading ? <p className={styles.loading} role="status">Đang tải chính sách...</p> : error && !data ? <div className={styles.error} role="alert">{error}</div> : <form onSubmit={submit}>
        <div className={styles.policyGrid}>
          <div><label htmlFor="late-grace-minutes">Ngưỡng đi trễ</label><div className={styles.numberField}>
            <input id="late-grace-minutes" type="number" inputMode="numeric" min={data?.limits?.min ?? 0} max={data?.limits?.max ?? 120} step="1" required value={minutes} onChange={(event) => setMinutes(event.target.value)}/><span>phút</span>
          </div></div>
          <div><label htmlFor="early-clock-in-minutes">Cho phép điểm danh sớm</label><div className={styles.numberField}>
            <input id="early-clock-in-minutes" type="number" inputMode="numeric" min={data?.earlyWindowLimits?.min ?? 0} max={data?.earlyWindowLimits?.max ?? 720} step="1" required value={earlyMinutes} onChange={(event) => setEarlyMinutes(event.target.value)}/><span>phút</span>
          </div></div>
          <div><label htmlFor="max-shift-duration-minutes">Ca dài hơn phải đối soát</label><div className={styles.numberField}>
            <input id="max-shift-duration-minutes" type="number" inputMode="numeric" min={data?.maxShiftDurationLimits?.min ?? 60} max={data?.maxShiftDurationLimits?.max ?? 2880} step="1" required value={maxShiftMinutes} onChange={(event) => setMaxShiftMinutes(event.target.value)}/><span>phút</span>
          </div></div>
        </div>
        <div className={styles.actionRow}><button type="submit" disabled={saving}><Save size={17} aria-hidden="true"/> {saving ? "Đang lưu..." : "LƯU CHÍNH SÁCH"}</button></div>
        <p className={styles.example}>Ví dụ: đặt 15 phút thì điểm danh đúng 15 phút sau giờ bắt đầu vẫn là “Đúng giờ”; từ thời điểm vượt quá 15 phút mới là “Đi trễ”.</p>
        <div className={styles.notice}><b>Phạm vi áp dụng</b><span>Chỉ áp dụng cho lượt điểm danh mới. Mỗi ca lưu ngưỡng tại thời điểm điểm danh nên lịch sử không thay đổi khi chính sách được chỉnh sửa.</span></div>
        {data?.policy && <p className={styles.meta}>Phiên bản {data.policy.version} · cập nhật {formatDateTime(data.policy.updatedAt)}{data.policy.updatedByName ? ` bởi ${data.policy.updatedByName}` : ""}</p>}
        {message && <div className={styles.success} role="status">{message}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
      </form>}
    </section>
    <PayrollPolicySettings/>
  </main>;
}
