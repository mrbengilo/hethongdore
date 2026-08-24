"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarCheck2, ClockAlert } from "lucide-react";
import { formatDateVn } from "../lib/format";
import type { AttendanceEvaluationCode, AttendanceStatsMode, AttendanceStatsRow } from "../lib/attendance-stats";
import { DatePickerControl } from "./DatePickerControl";
import styles from "./AttendanceStatsPanel.module.css";

type EvaluationRule = {
  code: AttendanceEvaluationCode;
  label: string;
  description: string;
};

type AttendanceStatsResponse = {
  store: { id: string; name: string };
  request: { storeId: string; mode: AttendanceStatsMode; anchor: string };
  filter: { mode: AttendanceStatsMode; anchor: string; from: string; to: string; timeZone: string };
  policy: {
    onTimeGraceMinutes: number;
    version: number;
    updatedAt: string;
    classificationSource: "PERSISTED_SNAPSHOT";
    description: string;
  };
  evaluationRules: EvaluationRule[];
  totals: {
    employees: number;
    early: number;
    onTime: number;
    late: number;
    unknown: number;
    classifiedCount: number;
    totalLateMinutes: number;
  };
  rows: AttendanceStatsRow[];
  message?: string;
};

const MODE_LABELS: Record<AttendanceStatsMode, string> = {
  day: "Ngày",
  week: "Tuần",
  month: "Tháng",
};

function localToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

function evaluationClass(code: AttendanceEvaluationCode) {
  if (code === "EXCELLENT") return styles.excellent;
  if (code === "GOOD") return styles.good;
  if (code === "FAIR") return styles.fair;
  if (code === "NEEDS_IMPROVEMENT") return styles.needsImprovement;
  return styles.noData;
}

function Evaluation({ row }: { row: AttendanceStatsRow }) {
  return <div className={styles.evaluation}>
    <span className={`${styles.evaluationTag} ${evaluationClass(row.evaluation.code)}`}>{row.evaluation.label}</span>
    <small>{row.evaluation.reason} {row.classifiedCount ? `(${row.lateRatePercent}% trễ · ${row.classifiedCount} ca)` : ""}</small>
  </div>;
}

export default function AttendanceStatsPanel({ storeId }: { storeId: string }) {
  const [mode, setMode] = useState<AttendanceStatsMode>("month");
  const [anchor, setAnchor] = useState(localToday);
  const [data, setData] = useState<AttendanceStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    const requestedScope = { storeId, mode, anchor };
    setData(null);
    setError("");
    setLoading(true);
    const query = new URLSearchParams(requestedScope);

    void fetch(`/api/attendance-stats?${query}`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      const payload = await response.json() as AttendanceStatsResponse;
      if (!response.ok) throw new Error(payload.message || "Không thể tải thống kê chuyên cần.");
      if (payload.request.storeId !== requestedScope.storeId
        || payload.request.mode !== requestedScope.mode
        || payload.request.anchor !== requestedScope.anchor) {
        throw new Error("Kết quả thống kê không khớp bộ lọc đang chọn.");
      }
      if (requestId !== requestSequence.current || controller.signal.aborted) return;
      setData(payload);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || requestId !== requestSequence.current) return;
      setData(null);
      setError(cause instanceof Error ? cause.message : "Không thể tải thống kê chuyên cần.");
    }).finally(() => {
      if (requestId === requestSequence.current && !controller.signal.aborted) setLoading(false);
    });

    return () => controller.abort();
  }, [anchor, mode, storeId]);

  const chooseMode = (nextMode: AttendanceStatsMode) => {
    setData(null);
    setMode(nextMode);
  };
  const chooseAnchor = (nextAnchor: string) => {
    setData(null);
    setAnchor(nextAnchor);
  };
  const rangeLabel = data
    ? data.filter.from === data.filter.to
      ? formatDateVn(data.filter.from)
      : `${formatDateVn(data.filter.from)} – ${formatDateVn(data.filter.to)}`
    : "Đang xác định khoảng ngày";

  return <section className={styles.panel} aria-labelledby="attendance-stats-title">
    <header className={styles.header}>
      <div className={styles.title}>
        <span className={styles.titleIcon} aria-hidden="true"><CalendarCheck2 size={22}/></span>
        <div>
          <h3 id="attendance-stats-title">THỐNG KÊ ĐI LÀM ĐÚNG GIỜ</h3>
          <p>Tổng hợp theo từng nhân viên từ dữ liệu điểm danh đã lưu.</p>
        </div>
      </div>
      <div className={styles.controls}>
        <div className={styles.segmented} role="group" aria-label="Khoảng thống kê đi làm đúng giờ">
          {(Object.keys(MODE_LABELS) as AttendanceStatsMode[]).map((item) => <button
            key={item}
            type="button"
            className={mode === item ? styles.active : ""}
            aria-pressed={mode === item}
            onClick={() => chooseMode(item)}
          >{MODE_LABELS[item]}</button>)}
        </div>
        <DatePickerControl
          className={styles.anchorPicker}
          ariaLabel="Ngày tham chiếu thống kê chuyên cần"
          hint="Ngày tham chiếu"
          value={anchor}
          onChange={chooseAnchor}
        />
      </div>
    </header>

    <div className={styles.scopeLine}>
      <ClockAlert size={17} aria-hidden="true"/>
      <span><b>{MODE_LABELS[mode]}:</b> {rangeLabel}</span>
      {data ? <span>{data.totals.classifiedCount} ca đã phân loại · {data.totals.totalLateMinutes} phút trễ</span> : null}
    </div>

    {loading ? <p className={styles.state} role="status" aria-live="polite">Đang tải thống kê chuyên cần…</p> : null}
    {error ? <p className={`${styles.state} ${styles.error}`} role="alert">{error}</p> : null}
    {!loading && !error && data?.rows.length === 0
      ? <p className={styles.state}>Chưa có nhân viên hoặc dữ liệu điểm danh trong cửa hàng này.</p>
      : null}

    {data?.rows.length ? <>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus lets users scroll the desktop table. */}
      <div className={styles.desktopRegion} role="region" tabIndex={0} aria-label="Bảng thống kê đi làm đúng giờ, cuộn ngang để xem đầy đủ">
        <table className={styles.table}>
          <thead><tr><th>STT</th><th>Nhân viên</th><th>Đi trễ</th><th>Đúng giờ</th><th>Đi sớm</th><th>Tổng phút trễ</th><th>Đánh giá chuyên cần</th></tr></thead>
          <tbody>{data.rows.map((row, index) => <tr key={row.employeeId}>
            <td>{index + 1}</td>
            <td><b>{row.employeeName}</b><small>{row.employeeCode}</small></td>
            <td className={styles.lateValue}>{row.late}</td>
            <td className={styles.onTimeValue}>{row.onTime}</td>
            <td className={styles.earlyValue}>{row.early}</td>
            <td><b>{row.totalLateMinutes} phút</b></td>
            <td><Evaluation row={row}/></td>
          </tr>)}</tbody>
        </table>
      </div>

      <ol className={styles.mobileList} aria-label="Danh sách thống kê đi làm đúng giờ">
        {data.rows.map((row, index) => <li className={styles.mobileCard} key={row.employeeId}>
          <header><span className={styles.index} aria-label={`Dòng ${index + 1}`}>{index + 1}</span><div><b>{row.employeeName}</b><small>{row.employeeCode}</small></div><Evaluation row={row}/></header>
          <dl>
            <div><dt>Đi trễ</dt><dd className={styles.lateValue}>{row.late}</dd></div>
            <div><dt>Đúng giờ</dt><dd className={styles.onTimeValue}>{row.onTime}</dd></div>
            <div><dt>Đi sớm</dt><dd className={styles.earlyValue}>{row.early}</dd></div>
            <div><dt>Tổng phút trễ</dt><dd>{row.totalLateMinutes} phút</dd></div>
          </dl>
        </li>)}
      </ol>
    </> : null}

    {data ? <aside className={styles.legend} aria-labelledby="attendance-evaluation-legend">
      <div>
        <h4 id="attendance-evaluation-legend">Cách đánh giá chuyên cần</h4>
        <p>{data.policy.description} Ngưỡng hiện hành: đi trễ sau {data.policy.onTimeGraceMinutes} phút kể từ giờ bắt đầu ca.</p>
        {data.totals.unknown > 0 ? <p><b>{data.totals.unknown} ca chưa có ảnh chụp trạng thái</b> nên không được đưa vào tỷ lệ đánh giá.</p> : null}
      </div>
      <ul>{data.evaluationRules.map((rule) => <li key={rule.code}><span className={`${styles.evaluationTag} ${evaluationClass(rule.code)}`}>{rule.label}</span><small>{rule.description}</small></li>)}</ul>
    </aside> : null}
  </section>;
}
