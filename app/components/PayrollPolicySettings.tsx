"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { BadgeDollarSign, Percent, RefreshCw, Save, ShieldCheck } from "lucide-react";
import styles from "./PayrollPolicySettings.module.css";

type Tier = { minimumProfitPerHour: number; ratePercent: number };
type PolicyResponse = {
  policy?: {
    managerMonthlySalaryVnd: number;
    managerKpiRatePercent: number | null;
    employeeKpiTiers: Tier[];
    version: number;
    updatedAt: string;
    updatedByName: string | null;
  };
  limits?: {
    managerSalary: { min: number; max: number };
    percent: { min: number; max: number };
  };
  message?: string;
};

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
const dateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short", timeStyle: "medium", hourCycle: "h23", timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date(value));

export function PayrollPolicySettings() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [salary, setSalary] = useState("");
  const [managerRate, setManagerRate] = useState("");
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requestVersion = useRef(0);

  const hydrate = useCallback((body: PolicyResponse) => {
    if (!body.policy) return;
    setData(body);
    setSalary(String(body.policy.managerMonthlySalaryVnd));
    setManagerRate(String(body.policy.managerKpiRatePercent ?? 0));
    setTiers(body.policy.employeeKpiTiers);
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestVersion.current;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/payroll-policy", { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as PolicyResponse;
      if (!response.ok || !body.policy || !body.limits) throw new Error(body.message ?? "Không thể tải chính sách lương và KPI.");
      if (requestId === requestVersion.current) hydrate(body);
    } catch (cause) {
      if (requestId === requestVersion.current) setError(cause instanceof Error ? cause.message : "Không thể tải chính sách lương và KPI.");
    } finally { if (requestId === requestVersion.current) setLoading(false); }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!data?.policy || !data.limits || saving) return;
    const managerMonthlySalaryVnd = Number(salary);
    const managerKpiRatePercent = Number(managerRate);
    if (!Number.isSafeInteger(managerMonthlySalaryVnd)
      || managerMonthlySalaryVnd < data.limits.managerSalary.min
      || managerMonthlySalaryVnd > data.limits.managerSalary.max) {
      setError("Mức lương quản lý phải là số nguyên đồng hợp lệ."); return;
    }
    const rates = [managerKpiRatePercent, ...tiers.map((tier) => tier.ratePercent)];
    if (rates.some((rate) => !Number.isFinite(rate) || rate < data.limits!.percent.min || rate > data.limits!.percent.max)) {
      setError("Các tỷ lệ KPI phải nằm trong khoảng 0% đến 100%."); return;
    }
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/payroll-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          managerMonthlySalaryVnd,
          managerKpiRatePercent,
          employeeKpiTiers: tiers,
          expectedVersion: data.policy.version,
        }),
      });
      const body = await response.json().catch(() => ({})) as PolicyResponse;
      if (!response.ok || !body.policy || !body.limits) {
        if (body.policy && body.limits) hydrate(body);
        throw new Error(body.message ?? "Không thể lưu chính sách lương và KPI.");
      }
      requestVersion.current += 1;
      hydrate(body);
      setMessage(body.message ?? "Đã lưu chính sách lương và KPI cho toàn bộ cửa hàng.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Không thể lưu chính sách lương và KPI."); }
    finally { setSaving(false); }
  }

  if (loading) return <p className={styles.loading} role="status">Đang tải chính sách lương và KPI...</p>;
  if (!data?.policy || !data.limits) return <div className={styles.error} role="alert">{error || "Không thể tải chính sách lương và KPI."}</div>;
  return <section className={styles.card} aria-labelledby="payroll-policy-title">
    <header><span><ShieldCheck size={23} aria-hidden="true"/></span><div><h3 id="payroll-policy-title">Chính sách lương và KPI toàn hệ thống</h3><p>Thiết lập này dùng chung cho mọi cửa hàng và chỉ tác động đến kỳ chưa khóa hoặc kỳ mới.</p></div><button type="button" onClick={() => void load()} disabled={saving}><RefreshCw size={16}/> Làm mới</button></header>
    <form onSubmit={submit}>
      <fieldset><legend><BadgeDollarSign size={19}/> Cài đặt mức lương cho quản lý</legend><label htmlFor="manager-policy-salary">Mức lương quản lý mỗi cửa hàng/tháng</label><div className={styles.moneyInput}><input id="manager-policy-salary" type="number" inputMode="numeric" min={data.limits.managerSalary.min} max={data.limits.managerSalary.max} step="1" required value={salary} onChange={(event) => setSalary(event.target.value)}/><span>đồng</span></div><small>Mức đang nhập: {money(Number(salary) || 0)} đồng.</small></fieldset>
      <fieldset><legend><Percent size={19}/> Cài đặt mức thưởng KPI cho quản lý</legend><label htmlFor="manager-policy-kpi">Tỷ lệ thưởng KPI quản lý</label><div className={styles.percentInput}><input id="manager-policy-kpi" type="number" inputMode="decimal" min="0" max="100" step="0.01" required value={managerRate} onChange={(event) => setManagerRate(event.target.value)}/><span>%</span></div></fieldset>
      <fieldset className={styles.wide}><legend><Percent size={19}/> Tỷ lệ thưởng KPI nhân viên theo lợi nhuận/giờ</legend><div className={styles.tiers}>{tiers.map((tier, index) => <label key={tier.minimumProfitPerHour}>Lợi nhuận ≥ {money(tier.minimumProfitPerHour)} đồng/giờ<div className={styles.percentInput}><input type="number" inputMode="decimal" min="0" max="100" step="0.01" required aria-label={`Tỷ lệ KPI nhân viên khi lợi nhuận từ ${tier.minimumProfitPerHour} đồng mỗi giờ`} value={tier.ratePercent} onChange={(event) => setTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ratePercent: Number(event.target.value) } : item))}/><span>%</span></div></label>)}</div><small>Mức lợi nhuận cao hơn phải có tỷ lệ bằng hoặc cao hơn mức thấp hơn; hệ thống chỉ chọn một ngưỡng cao nhất đạt được.</small></fieldset>
      <div className={styles.scope}><b>Phạm vi áp dụng</b><span>Kỳ lương đã khóa giữ nguyên toàn bộ số liệu. Chính sách mới tự động dùng cho bản xem trước, báo cáo tài chính chưa khóa và các kỳ được chốt sau thời điểm lưu.</span></div>
      <div className={styles.actions}><p>Phiên bản {data.policy.version} · cập nhật {dateTime(data.policy.updatedAt)}{data.policy.updatedByName ? ` bởi ${data.policy.updatedByName}` : ""}</p><button type="submit" disabled={saving}><Save size={17}/> {saving ? "Đang lưu..." : "LƯU CHÍNH SÁCH"}</button></div>
      {message && <div className={styles.success} role="status">{message}</div>}{error && <div className={styles.error} role="alert">{error}</div>}
    </form>
  </section>;
}
