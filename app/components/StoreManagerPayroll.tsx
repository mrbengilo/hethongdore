"use client";

import { ActionButton, ActionForm } from "./ActionFeedback";
import { actionFetch as fetch } from "../lib/action-feedback";

import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeDollarSign, Download, Gift, RefreshCw, Save, WalletCards } from "lucide-react";
import { readFinancialResponse } from "../lib/financial-response";
import { formatVndInput, parseVndInput } from "../lib/format";
import { exportCsvFile } from "../lib/export-csv";

type Store = { id: string; name: string; status?: string };
type PayrollData = {
  period: string;
  financialPeriod?: { status: string; paidAt?: string | null; lockedAt?: string | null };
  closing?: { status: string } | null;
  summary: {
    storeId: string; period: string; status: string;
    managerSalary: number; managerSalaryVersion?: number; managerBonus: number; managerTotal: number;
    netProfit?: number; profit: number;
    payrollPolicy?: { managerKpiRatePercent: number | null };
  };
};
const money = (value: number) => `${value.toLocaleString("en-US")} đồng`;
const dateTime = (value?: string | null) => value
  ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }) : "—";

export default function StoreManagerPayroll({ store, period, onChanged }: {
  store: Store; period: string; onChanged: () => void | Promise<void>;
}) {
  const [data, setData] = useState<PayrollData | null>(null);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const activeScope = useRef<string | null>(null);
  const scope = `${store.id}:${period}`;
  const load = useCallback(async () => {
    const id = ++request.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError("");
    setData(null);
    try {
      const params = new URLSearchParams({ storeId: store.id, period });
      const response = await fetch(`/api/payroll?${params}`, { cache: "no-store", signal: abort.signal });
      const payload = await readFinancialResponse<PayrollData>(response);
      if (payload.period !== period || payload.summary?.period !== period || payload.summary.storeId !== store.id) {
        throw new Error("Dữ liệu lương quản lý không khớp cửa hàng hoặc kỳ đã chọn.");
      }
      if (request.current !== id || abort.signal.aborted) return;
      setData(payload);
      setAmount(formatVndInput(payload.summary.managerSalary));
    } catch (cause) {
      if (request.current === id && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Không thể tải lương quản lý.");
    } finally {
      if (request.current === id && !abort.signal.aborted) setLoading(false);
    }
  }, [period, store.id]);
  useEffect(() => {
    activeScope.current = scope;
    void load();
    return () => { activeScope.current = null; controller.current?.abort(); };
  }, [load, scope]);
  const summary = data?.summary;
  const editable = Boolean(summary) && !loading && !saving && store.status !== "INACTIVE"
    && (!data?.financialPeriod || data.financialPeriod.status === "DRAFT") && !data?.closing && summary?.status !== "LOCKED";
  const validAmount = /^[\d,]+$/.test(amount) && Number.isSafeInteger(parseVndInput(amount));
  const rate = summary?.payrollPolicy?.managerKpiRatePercent;
  const exportReport = () => {
    if (!summary) return;
    exportCsvFile(`luong-quan-ly-${store.id}-${period}.csv`, [
      ["Cửa hàng", "Kỳ", "Lương quản lý", "Tỷ lệ thưởng (%)", "Thưởng quản lý", "Tổng chi quản lý", "Lợi nhuận hoạt động", "Lợi nhuận sau cùng", "Trạng thái", "Đã chi lúc", "Khóa lúc"],
      [store.name, period, summary.managerSalary, rate, summary.managerBonus, summary.managerTotal,
        summary.profit, summary.netProfit, data?.financialPeriod?.status ?? "DRAFT",
        dateTime(data?.financialPeriod?.paidAt), dateTime(data?.financialPeriod?.lockedAt)],
    ]);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editable || !validAmount || !summary || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/payroll", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SET_MANAGER_SALARY", storeId: store.id, period,
          managerSalary: parseVndInput(amount), expectedSalaryVersion: summary.managerSalaryVersion ?? 0 }),
      });
      const payload = await readFinancialResponse<{ message: string }>(response);
      if (activeScope.current !== scope) return;
      await load();
      if (activeScope.current !== scope) return;
      setMessage(payload.message);
      await onChanged();
    } catch (cause) {
      if (activeScope.current !== scope) return;
      await load();
      if (activeScope.current !== scope) return;
      setError(cause instanceof Error ? cause.message : "Không thể lưu lương quản lý.");
    } finally { inFlight.current = false; setSaving(false); }
  };

  return <div className="store-manager-payroll">
    <div className="ref-toolbar"><div><h2>LƯƠNG THƯỞNG QUẢN LÝ</h2><p>{store.name} · Kỳ {period}</p></div>
      <div className="ref-toolbar-actions">
        <ActionButton type="button" onClick={() => load()} disabled={loading || saving}><RefreshCw size={16}/> Làm mới</ActionButton>
        <ActionButton type="button" onClick={exportReport} disabled={loading || saving || !summary}><Download size={16}/> Xuất CSV</ActionButton>
      </div></div>
    {error && <div className="form-message" role="alert">{error}</div>}
    {message && <div className="success-banner" role="status">{message}</div>}
    {loading && <p role="status">Đang tải lương thưởng quản lý…</p>}
    {summary && <>
      <div className="manager-metrics three">
        {[
          { label: "Lương quản lý", value: summary.managerSalary, icon: BadgeDollarSign },
          { label: "Thưởng KPI quản lý", value: summary.managerBonus, icon: Gift },
          { label: "Tổng chi cho quản lý", value: summary.managerTotal, icon: WalletCards },
        ].map(({ label, value, icon: Icon }) => <article className="manager-metric" key={label}>
          <div className="metric-icon"><Icon size={22}/></div><div><span>{label}</span><strong>{money(value)}</strong></div>
        </article>)}
      </div>
      <section className="manager-panel">
        <h2>ĐỐI SOÁT CHI PHÍ TRONG KỲ</h2>
        <dl className="compact-data-list">
          <div><dt>Lợi nhuận hoạt động để tính thưởng</dt><dd>{money(summary.profit)}</dd></div>
          <div><dt>Tỷ lệ thưởng quản lý</dt><dd>{rate == null ? "Theo chính sách kỳ" : `${rate.toLocaleString("vi-VN")}%`}</dd></div>
          <div><dt>Lợi nhuận sau cùng của cửa hàng</dt><dd>{summary.netProfit === undefined ? "—" : money(summary.netProfit)}</dd></div>
          <div><dt>Đã xác nhận chi lúc</dt><dd>{dateTime(data?.financialPeriod?.paidAt)}</dd></div>
          <div><dt>Đã khóa kỳ lúc</dt><dd>{dateTime(data?.financialPeriod?.lockedAt)}</dd></div>
        </dl>
      </section>
      <ActionForm className="manager-panel" onSubmit={(event) => save(event)}>
        <h2>MỨC LƯƠNG ÁP DỤNG CHO KỲ</h2>
        <div className="setup-repayment-fields">
          <label>Lương quản lý (đồng)
            <input type="text" inputMode="numeric" pattern="[0-9,]*"
              value={amount} disabled={!editable} aria-invalid={editable && !validAmount} onChange={(event) => setAmount(formatVndInput(event.target.value))} aria-describedby="manager-salary-note"/>
          </label>
          <ActionButton className="primary-button" type="submit" disabled={!editable || !validAmount}>
            <Save size={17}/>{saving ? "Đang lưu…" : "Lưu lương quản lý"}
          </ActionButton>
        </div>
        {editable && !validAmount && <p role="alert">Nhập số nguyên đồng, lớn hơn hoặc bằng 0.</p>}
        <p id="manager-salary-note">{editable
          ? "Nhập mức lương riêng cho cửa hàng và kỳ này trước khi xác nhận lương thưởng. Chưa nhập riêng thì áp dụng mức lương trong chính sách của kỳ."
          : "Kỳ đã bắt đầu chốt hoặc cửa hàng ngưng hoạt động. Mức lương được giữ nguyên để đối soát."}</p>
        <p>Thưởng quản lý = {rate == null ? "tỷ lệ trong chính sách kỳ" : `${rate.toLocaleString("vi-VN")}%`} × lợi nhuận hoạt động dương. Thưởng được tính tự động theo công thức hiện có.</p>
      </ActionForm>
      <div className="report-profit-note">Lương và thưởng quản lý đã được tính vào chi phí cửa hàng. Xác nhận số liệu, xác nhận đã chi và khóa kỳ tại mục “Lương thưởng”. Lợi nhuận chia lấy từ số liệu sau các khoản này.</div>
    </>}
  </div>;
}
