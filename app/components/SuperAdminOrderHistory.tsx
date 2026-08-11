"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History, RefreshCw, Search } from "lucide-react";
import { formatDateTime24, formatDateVn } from "../lib/format";
import styles from "./SuperAdminOrderHistory.module.css";

type Store = { id: string; name: string };
type OrderSnapshot = {
  customerName: string | null;
  phone: string | null;
  age: number | null;
  amount: number | null;
  paymentMethod: string | null;
  status: string | null;
};
type HistoryRow = {
  id: string;
  orderId: string;
  orderCode: string;
  action: "MANAGER_ORDER_UPDATE" | "MANAGER_ORDER_VOID";
  changedAt: string;
  actorName: string | null;
  actorUsername: string | null;
  employeeName: string | null;
  employeeCode: string | null;
  shiftName: string | null;
  shiftCode: string;
  workDate: string | null;
  currentStatus: string;
  change: { before: OrderSnapshot | null; after: OrderSnapshot | null };
};
type HistoryResponse = {
  rows: HistoryRow[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
};

const fields: Array<{ key: keyof OrderSnapshot; label: string }> = [
  { key: "customerName", label: "Khách hàng" },
  { key: "phone", label: "Số điện thoại" },
  { key: "age", label: "Tuổi" },
  { key: "amount", label: "Giá trị đơn" },
  { key: "paymentMethod", label: "Thanh toán" },
  { key: "status", label: "Trạng thái" },
];

function money(value: number) {
  return `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đồng`;
}

function displayValue(key: keyof OrderSnapshot, value: OrderSnapshot[keyof OrderSnapshot]) {
  if (key === "amount" && typeof value === "number") return money(value);
  if (key === "paymentMethod") return value === "BANK_TRANSFER" ? "Chuyển khoản" : value === "CASH" ? "Tiền mặt" : "—";
  if (key === "status") return value === "COMPLETED" ? "Hoàn tất" : value === "VOID" ? "Đã xóa/hủy" : String(value ?? "—");
  if (key === "customerName" && !value) return "Khách lẻ";
  return value == null || value === "" ? "—" : String(value);
}

function changedFields(row: HistoryRow) {
  if (!row.change.before || !row.change.after) return [];
  return fields.filter(({ key }) => row.change.before?.[key] !== row.change.after?.[key]);
}

export function SuperAdminOrderHistory({ store }: { store: Store }) {
  const [action, setAction] = useState<"ALL" | "UPDATE" | "VOID">("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ storeId: store.id, action, page: String(page), pageSize: "20" });
    if (search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/admin/order-history?${params.toString()}`, { cache: "no-store", signal });
      const data = await response.json().catch(() => ({})) as Partial<HistoryResponse> & { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Không thể tải lịch sử đơn hàng.");
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setPagination(data.pagination ?? { page, pageSize: 20, total: 0, pages: 1 });
    } catch (requestError) {
      if (signal?.aborted) return;
      setRows([]);
      setError(requestError instanceof Error ? requestError.message : "Không thể tải lịch sử đơn hàng.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [action, page, search, store.id]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  function changeFilter(update: () => void) {
    update();
    setPage(1);
  }

  return <section className={styles.panel} aria-labelledby="super-admin-order-history-title">
    <header className={styles.header}>
      <div><h2 id="super-admin-order-history-title"><History size={21}/> Lịch sử quản lý sửa/xóa đơn hàng</h2><p>Hiển thị người thực hiện, thời điểm và toàn bộ giá trị trước/sau; dữ liệu chỉ thuộc {store.name}.</p></div>
      <button type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={17} className={loading ? "spin" : ""}/> Làm mới</button>
    </header>
    <div className={styles.filters}>
      <label>Loại thao tác<select value={action} onChange={(event) => changeFilter(() => setAction(event.target.value as "ALL" | "UPDATE" | "VOID"))}><option value="ALL">Tất cả chỉnh sửa và xóa</option><option value="UPDATE">Chỉnh sửa đơn</option><option value="VOID">Xóa/hủy đơn</option></select></label>
      <label className={styles.search}><span>Tìm kiếm</span><span><Search size={16}/><input type="search" value={search} onChange={(event) => changeFilter(() => setSearch(event.target.value))} placeholder="Mã đơn hoặc tên quản lý"/></span></label>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    <div className={styles.tableWrap} aria-busy={loading}>
      {loading ? <div className={styles.empty}>Đang tải lịch sử…</div> : rows.length === 0 ? <div className={styles.empty}>Chưa có thao tác chỉnh sửa hoặc xóa đơn hàng.</div> : <table className={styles.table}>
        <thead><tr><th>Đơn hàng</th><th>Người thực hiện</th><th>Thời điểm</th><th>Thay đổi đã ghi nhận</th></tr></thead>
        <tbody>{rows.map((row) => {
          const changes = changedFields(row);
          const isVoid = row.action === "MANAGER_ORDER_VOID";
          return <tr key={row.id}>
            <td data-label="Đơn hàng"><b>{row.orderCode}</b><span className={isVoid ? styles.voidAction : styles.updateAction}>{isVoid ? "Xóa/hủy đơn" : "Chỉnh sửa đơn"}</span><small>{row.employeeCode ?? "—"} · {row.employeeName ?? "Nhân viên đã xóa"}</small><small>{row.shiftName ?? row.shiftCode}{row.workDate ? ` · ${formatDateVn(row.workDate)}` : ""}</small></td>
            <td data-label="Người thực hiện"><b>{row.actorName ?? "Tài khoản quản lý đã xóa"}</b><small>{row.actorUsername ? `@${row.actorUsername}` : "Không còn tài khoản đăng nhập"}</small></td>
            <td data-label="Thời điểm"><b>{formatDateTime24(row.changedAt)}</b></td>
            <td data-label="Thay đổi đã ghi nhận">{changes.length ? <ul className={styles.changes}>{changes.map(({ key, label }) => <li key={key}><span>{label}</span><del>{displayValue(key, row.change.before?.[key] ?? null)}</del><i aria-hidden="true">→</i><ins>{displayValue(key, row.change.after?.[key] ?? null)}</ins></li>)}</ul> : <small>Nhật ký cũ không có bản chụp chi tiết.</small>}</td>
          </tr>;
        })}</tbody>
      </table>}
    </div>
    <footer className={styles.pagination}><span>{pagination.total} thao tác · Trang {pagination.page}/{pagination.pages}</span><div><button type="button" aria-label="Trang lịch sử trước" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={18}/></button><button type="button" aria-label="Trang lịch sử sau" disabled={loading || page >= pagination.pages} onClick={() => setPage((current) => Math.min(pagination.pages, current + 1))}><ChevronRight size={18}/></button></div></footer>
  </section>;
}
