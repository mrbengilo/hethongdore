"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";

export type FinanceEmployee = {
  id: string; code: string; name: string; hourlyRate: number; hours: number; salary: number;
  manualBonus: number; allowance: number; kpi: number; totalPay: number;
};

export type StoreFinance = {
  id: string; storeId: string; name: string; address: string; status: string; month: string;
  revenue: number; expense: number; profit: number; profitPerHour: number; kpiRate: number;
  employeeKpiTotal: number; managerKpi: number; distributableProfit: number; totalHours: number;
  expenseBreakdown: { fixed: number; variable: number; inventory: number; shipping: number; employeeSalary: number; managerSalary: number; employeeBonus: number; employeeAllowance: number };
  employees: FinanceEmployee[];
  manager: { salary: number; kpi: number; totalPay: number };
};

export type BusinessRecord = {
  id: string; category: string; store_id: string | null; title: string; data: Record<string, unknown>;
  status: string; created_at: string; updated_at: string;
};

export const money = (value: number | string | null | undefined) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(Number(value ?? 0)))} đồng`;
export const number = (value: number | string | null | undefined, digits = 2) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(Number(value ?? 0));
export const monthNow = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7);
export const dateTime24 = (value: string) => new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false, timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date(value));

export function Stat({ label, value, note, tone = "green" }: { label: string; value: string; note?: string; tone?: "green" | "orange" | "blue" | "red" }) {
  return <article className={`op-stat ${tone}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="op-panel"><div className="op-panel-head"><h2>{title}</h2>{action}</div>{children}</section>;
}

export function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "success" | "warning" }) {
  return <div className={`op-notice ${kind}`}>{children}</div>;
}

export function useRecords(category: string, storeId?: string | null) {
  const [records, setRecords] = useState<BusinessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ category });
    if (storeId) query.set("storeId", storeId);
    const response = await fetch(`/api/records?${query}`);
    const result = await response.json();
    setRecords(result.records ?? []);
    setLoading(false);
  }, [category, storeId]);
  useEffect(() => { void reload(); }, [reload]);
  return { records, loading, reload };
}

export async function createRecord(category: string, storeId: string | null, title: string, data: Record<string, unknown>) {
  const response = await fetch("/api/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, storeId, title, data }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "Không thể lưu dữ liệu");
  return result;
}

export function comparisonLabel(value: number) {
  if (value > 0) return `↑ ${number(value)}% so với kỳ trước`;
  if (value < 0) return `↓ ${number(Math.abs(value))}% so với kỳ trước`;
  return "Không đổi so với kỳ trước";
}
