"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarCheck2 } from "lucide-react";
import type { AttendanceEvaluationCode, AttendanceStatsRow } from "../lib/attendance-stats";
import { formatDateVn } from "../lib/format";
import styles from "./EmployeeAttendanceSummary.module.css";

type EmployeeAttendanceResponse = {
  request: { period: string; through: string };
  filter: { from: string; to: string; timeZone: string };
  scope: { kind: "EMPLOYEE_SELF"; employeeId: string; employeeCode: string; employeeName: string };
  policy: {
    onTimeGraceMinutes: number;
    classificationSource: "PERSISTED_SNAPSHOT";
    description: string;
  };
  row: AttendanceStatsRow;
  message?: string;
};

function evaluationClass(code: AttendanceEvaluationCode) {
  if (code === "NEEDS_IMPROVEMENT") return styles.needsImprovement;
  if (code === "FAIR") return styles.fair;
  if (code === "GOOD") return styles.good;
  if (code === "NO_DATA") return styles.noData;
  return "";
}

export default function EmployeeAttendanceSummary({ period, through, refreshKey = 0 }: {
  period: string;
  through: string;
  refreshKey?: number;
}) {
  const [data, setData] = useState<EmployeeAttendanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    const requested = { period, through };
    setData(null);
    setError("");
    setLoading(true);
    const query = new URLSearchParams(requested);
    void fetch(`/api/employee-attendance-stats?${query}`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      const payload = await response.json() as EmployeeAttendanceResponse;
      if (!response.ok) throw new Error(payload.message || "Không thể tải thống kê chuyên cần.");
      if (payload.request.period !== requested.period || payload.request.through !== requested.through) {
        throw new Error("Kết quả chuyên cần không khớp thời gian đang chọn.");
      }
      if (requestId !== requestSequence.current || controller.signal.aborted) return;
      setData(payload);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || requestId !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : "Không thể tải thống kê chuyên cần.");
    }).finally(() => {
      if (requestId === requestSequence.current && !controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [period, refreshKey, through]);

  const row = data?.row;
  return <section className={styles.panel} aria-labelledby="employee-attendance-summary-title">
    <header className={styles.header}>
      <div className={styles.title}><span className={styles.titleIcon} aria-hidden="true"><CalendarCheck2 size={21}/></span><div>
        <h2 id="employee-attendance-summary-title">THỐNG KÊ CHUYÊN CẦN CỦA BẠN</h2>
        <p>Số liệu điểm danh và đánh giá minh bạch trong kỳ lương đang chọn.</p>
      </div></div>
      <span className={styles.range}>{data ? `${formatDateVn(data.filter.from)} – ${formatDateVn(data.filter.to)}` : "Đang xác định thời gian"}</span>
    </header>
    {loading ? <p className={styles.state} role="status" aria-live="polite">Đang tải thống kê chuyên cần…</p> : null}
    {error ? <p className={`${styles.state} ${styles.error}`} role="alert">{error}</p> : null}
    {row ? <div className={styles.content}>
      <div className={styles.metrics} role="list" aria-label="Số lần điểm danh theo trạng thái">
        <div className={`${styles.metric} ${styles.late}`} role="listitem"><span>ĐI TRỄ</span><strong>{row.late} lần</strong><small>{row.lateRatePercent}% trong {row.classifiedCount} ca</small></div>
        <div className={`${styles.metric} ${styles.onTime}`} role="listitem"><span>ĐI ĐÚNG GIỜ</span><strong>{row.onTime} lần</strong><small>Trạng thái đã lưu khi điểm danh</small></div>
        <div className={`${styles.metric} ${styles.early}`} role="listitem"><span>ĐI SỚM</span><strong>{row.early} lần</strong><small>Trước thời gian bắt đầu ca</small></div>
        <div className={`${styles.metric} ${styles.minutes}`} role="listitem"><span>TỔNG THỜI GIAN ĐI TRỄ</span><strong>{row.totalLateMinutes} phút</strong><small>Chỉ cộng số phút của ca gắn tag đi trễ</small></div>
      </div>
      <aside className={`${styles.evaluation} ${evaluationClass(row.evaluation.code)}`} aria-label="Đánh giá hiệu suất và chuyên cần">
        <span>ĐÁNH GIÁ HIỆU SUẤT & CHUYÊN CẦN</span>
        <strong>{row.evaluation.label}</strong>
        <p>{row.evaluation.reason}</p>
        <small>{data.policy.description} Ngưỡng hiện hành: quá {data.policy.onTimeGraceMinutes} phút.</small>
      </aside>
    </div> : null}
  </section>;
}
