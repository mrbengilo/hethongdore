"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BarChart3, Boxes, Building2, ChevronRight, Clock3, FileBarChart, LogOut, Menu, PackagePlus, ReceiptText, Store, UsersRound, WalletCards, X } from "lucide-react";
import CostsPanel from "./operations/CostsPanel";
import EmployeesPanel from "./operations/EmployeesPanel";
import InventoryPanel from "./operations/InventoryPanel";
import PayrollPanel from "./operations/PayrollPanel";
import { DividendPanel, ReportsPanel } from "./operations/ReportsDividendPanel";
import { comparisonLabel, dateTime24, money, monthNow, Notice, Panel, Stat, StoreFinance } from "./operations/shared";

type User = { id: string; name: string; role: "MANAGER" | "EMPLOYEE" };
type FinanceResponse = {
  month: string;
  stores: StoreFinance[];
  totals: { revenue: number; expense: number; profit: number; distributableProfit: number; employeeKpiTotal: number; managerKpi: number };
  comparison: { revenue: number; expense: number; profit: number };
};
type Order = { id: string; code: string; employeeName: string; customer_name: string | null; amount: number; payment_method: string; status: string; created_at: string };
type Shift = { id: string; shift_code: string; started_at: string; ended_at: string | null; tiktok_allowance: number; employeeCode: string; employeeName: string; hourlyRate: number; status: string };

const systemMenu = ["Tổng quan", "Báo cáo", "Cổ tức"] as const;
const storeMenu = ["Tổng quan", "Chi phí", "Nhập hàng", "Nhân viên", "Ca làm việc", "Đơn hàng", "Lương thưởng", "Báo cáo"] as const;
type SystemView = typeof systemMenu[number];
type StoreView = typeof storeMenu[number];

const systemIcons = { "Tổng quan": BarChart3, "Báo cáo": FileBarChart, "Cổ tức": WalletCards };
const storeIcons = { "Tổng quan": BarChart3, "Chi phí": ReceiptText, "Nhập hàng": PackagePlus, "Nhân viên": UsersRound, "Ca làm việc": Clock3, "Đơn hàng": Boxes, "Lương thưởng": WalletCards, "Báo cáo": FileBarChart };

function localMonth(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

export default function ManagerOperations() {
  const [user, setUser] = useState<User | null>(null);
  const [month, setMonth] = useState(monthNow());
  const [finance, setFinance] = useState<FinanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [systemView, setSystemView] = useState<SystemView>("Tổng quan");
  const [storeView, setStoreView] = useState<StoreView>("Tổng quan");
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clock, setClock] = useState("");

  useEffect(() => {
    fetch("/api/auth/me").then(async (response) => response.ok ? response.json() : null).then((result) => {
      if (!result?.user) return window.location.replace("/");
      if (result.user.role !== "MANAGER") return window.location.replace("/employee");
      setUser(result.user);
    });
  }, []);

  useEffect(() => {
    const update = () => setClock(new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()));
    update(); const id = window.setInterval(update, 1000); return () => window.clearInterval(id);
  }, []);

  const loadFinance = useCallback(async () => {
    setLoading(true); setMessage("");
    const response = await fetch(`/api/finance?month=${encodeURIComponent(month)}`);
    const result = await response.json();
    if (!response.ok) setMessage(result.message ?? "Không thể tải dữ liệu tài chính.");
    else setFinance(result);
    setLoading(false);
  }, [month]);
  useEffect(() => { if (user) void loadFinance(); }, [user, loadFinance]);

  const selectedStore = useMemo(() => finance?.stores.find((store) => store.id === selectedStoreId) ?? null, [finance, selectedStoreId]);
  useEffect(() => { if (selectedStoreId && finance && !selectedStore) setSelectedStoreId(null); }, [finance, selectedStore, selectedStoreId]);

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/"; }
  function openStore(id: string) { setSelectedStoreId(id); setStoreView("Tổng quan"); setMenuOpen(false); }
  function closeStore() { setSelectedStoreId(null); setSystemView("Tổng quan"); setMenuOpen(false); }

  if (!user || loading && !finance) return <div className="op-loading"><div>DORE</div><p>Đang tổng hợp dữ liệu vận hành thực...</p></div>;
  if (!finance) return <div className="op-loading"><Notice kind="warning">{message || "Không tải được dữ liệu."}</Notice></div>;

  const activeMenu = selectedStore ? storeMenu : systemMenu;
  const activeView = selectedStore ? storeView : systemView;
  return <div className="op-shell">
    <aside className={`op-sidebar ${menuOpen ? "open" : ""}`}>
      <div className="op-brand"><div className="op-brand-mark"><Store size={25} /></div><div><strong>DORE</strong><span>{selectedStore ? selectedStore.name : "QUẢN LÝ HỆ THỐNG"}</span></div><button className="op-sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Đóng menu"><X size={20} /></button></div>
      {selectedStore && <button className="op-back" onClick={closeStore}><ArrowLeft size={17} /> Tổng quan hệ thống</button>}
      <nav>{activeMenu.map((item) => { const Icon = selectedStore ? storeIcons[item as StoreView] : systemIcons[item as SystemView]; return <button key={item} className={activeView === item ? "active" : ""} onClick={() => { if (selectedStore) setStoreView(item as StoreView); else setSystemView(item as SystemView); setMenuOpen(false); }}><Icon size={19} />{item}</button>; })}</nav>
      <div className="op-sidebar-user"><span>Quản lý</span><b>{user.name}</b></div>
      <button className="op-logout" onClick={logout}><LogOut size={18} /> Đăng xuất</button>
    </aside>

    <main className="op-main">
      <header className="op-header"><div className="op-header-title"><button className="op-mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Mở menu"><Menu size={22} /></button><div><span>{selectedStore ? `CỬA HÀNG · ${selectedStore.address}` : "HỆ THỐNG DORE"}</span><h1>{selectedStore ? `${storeView} · ${selectedStore.name}` : systemView}</h1></div></div><div className="op-header-controls"><label>Kỳ dữ liệu<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><div className="op-clock"><Clock3 size={17} /><span>{clock}</span></div></div></header>
      <section className="op-content">
        {message && <Notice kind="warning">{message}</Notice>}
        {selectedStore ? <StoreWorkspace store={selectedStore} view={storeView} month={month} reload={loadFinance} /> : <SystemWorkspace finance={finance} view={systemView} month={month} openStore={openStore} />}
      </section>
    </main>
    {menuOpen && <button className="op-overlay" aria-label="Đóng menu" onClick={() => setMenuOpen(false)} />}
  </div>;
}

function SystemWorkspace({ finance, view, month, openStore }: { finance: FinanceResponse; view: SystemView; month: string; openStore: (id: string) => void }) {
  if (view === "Báo cáo") return <ReportsPanel month={month} />;
  if (view === "Cổ tức") return <DividendPanel month={month} />;
  const totals = finance.totals;
  return <div className="op-stack">
    <div className="op-stats four"><Stat label="TỔNG DOANH THU TỪ CA" value={money(totals.revenue)} note={comparisonLabel(finance.comparison.revenue)} /><Stat label="TỔNG TẤT CẢ CHI PHÍ" value={money(totals.expense)} note={comparisonLabel(finance.comparison.expense)} tone="orange" /><Stat label="TỔNG LỢI NHUẬN CƠ SỞ" value={money(totals.profit)} note={comparisonLabel(finance.comparison.profit)} tone="blue" /><Stat label="LN CÓ THỂ CHIA SAU KPI" value={money(totals.distributableProfit)} /></div>
    <Notice>Doanh thu trên hệ thống được cộng trực tiếp từ các đơn hàng <b>COMPLETED</b> phát sinh trong ca làm việc của nhân viên. Chi phí là tổng chi phí cố định + phát sinh + nhập hàng + vận chuyển + lương + thưởng + phụ cấp.</Notice>
    <Panel title={`Cửa hàng · kỳ ${month}`}><div className="op-store-grid">{finance.stores.map((store) => <button className="op-store-card" key={store.id} onClick={() => openStore(store.id)}><div className="op-store-icon"><Building2 size={24} /></div><div><span>● Hoạt động</span><h3>{store.name}</h3><p>{store.address}</p><div className="op-store-values"><small>Doanh thu<b>{money(store.revenue)}</b></small><small>Tổng chi phí<b>{money(store.expense)}</b></small><small>Lợi nhuận<b>{money(store.profit)}</b></small></div></div><ChevronRight size={20} /></button>)}</div></Panel>
  </div>;
}

function StoreWorkspace({ store, view, month, reload }: { store: StoreFinance; view: StoreView; month: string; reload: () => Promise<void> }) {
  if (view === "Chi phí") return <CostsPanel store={store} month={month} onChanged={reload} />;
  if (view === "Nhập hàng") return <InventoryPanel store={store} month={month} onChanged={reload} />;
  if (view === "Nhân viên") return <EmployeesPanel store={store} />;
  if (view === "Lương thưởng") return <PayrollPanel store={store} month={month} onChanged={reload} />;
  if (view === "Báo cáo") return <ReportsPanel storeId={store.id} month={month} />;
  if (view === "Đơn hàng") return <OrdersPanel store={store} month={month} />;
  if (view === "Ca làm việc") return <ShiftsPanel store={store} month={month} />;

  const margin = store.revenue > 0 ? store.profit / store.revenue * 100 : 0;
  const b = store.expenseBreakdown;
  return <div className="op-stack">
    <div className="op-stats four"><Stat label="DOANH THU TỪ CA" value={money(store.revenue)} /><Stat label="TỔNG TẤT CẢ CHI PHÍ" value={money(store.expense)} tone="orange" /><Stat label="LỢI NHUẬN CƠ SỞ" value={money(store.profit)} tone="blue" /><Stat label="BIÊN LỢI NHUẬN" value={`${margin.toFixed(2)}%`} /></div>
    <Panel title="Cơ cấu tổng chi phí"><div className="op-breakdown-grid"><span>Chi phí cố định<b>{money(b.fixed)}</b></span><span>Chi phí phát sinh<b>{money(b.variable)}</b></span><span>Nhập hàng<b>{money(b.inventory)}</b></span><span>Vận chuyển<b>{money(b.shipping)}</b></span><span>Lương nhân viên<b>{money(b.employeeSalary)}</b></span><span>Lương quản lý<b>{money(b.managerSalary)}</b></span><span>Thưởng nhân viên<b>{money(b.employeeBonus)}</b></span><span>Phụ cấp nhân viên<b>{money(b.employeeAllowance)}</b></span></div><div className="op-total-row"><span>Tổng tất cả chi phí của cửa hàng</span><strong>{money(store.expense)}</strong></div></Panel>
    <div className="op-stats three"><Stat label="TỔNG GIỜ LÀM" value={`${store.totalHours.toFixed(2)} giờ`} /><Stat label={`KPI NHÂN VIÊN (${Math.round(store.kpiRate * 100)}%)`} value={money(store.employeeKpiTotal)} tone="orange" /><Stat label="KPI QUẢN LÝ 2%" value={money(store.managerKpi)} tone="blue" /></div>
    <Notice>Lợi nhuận có thể chia sau KPI của {store.name}: <b>{money(store.distributableProfit)}</b>.</Notice>
  </div>;
}

function OrdersPanel({ store, month }: { store: StoreFinance; month: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); fetch(`/api/orders?storeId=${encodeURIComponent(store.id)}`).then((response) => response.json()).then((result) => setOrders(result.orders ?? [])).finally(() => setLoading(false)); }, [store.id]);
  const rows = orders.filter((order) => localMonth(order.created_at) === month);
  return <Panel title={`Đơn hàng · ${month}`}>{loading ? <p>Đang tải...</p> : <div className="op-table-wrap"><table><thead><tr><th>Thời gian</th><th>Mã đơn</th><th>Nhân viên</th><th>Khách hàng</th><th>Thanh toán</th><th>Giá trị</th><th>Trạng thái</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={7}>Chưa có đơn hàng trong kỳ.</td></tr> : rows.map((order) => <tr key={order.id}><td>{dateTime24(order.created_at)}</td><td><b>{order.code}</b></td><td>{order.employeeName}</td><td>{order.customer_name ?? "—"}</td><td>{order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</td><td>{money(order.amount)}</td><td>{order.status}</td></tr>)}</tbody></table></div>}</Panel>;
}

function ShiftsPanel({ store, month }: { store: StoreFinance; month: string }) {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setLoading(true);
    fetch(`/api/shifts?storeId=${encodeURIComponent(store.id)}`).then((response) => response.json()).then((result) => setShifts(result.shifts ?? [])).finally(() => setLoading(false));
    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const interval = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(interval);
  }, [store.id]);
  const rows = shifts.filter((shift) => localMonth(shift.started_at) === month);
  return <div className="op-stack"><div className="op-stats three"><Stat label="SỐ CA GHI NHẬN" value={String(rows.length)} /><Stat label="TỔNG GIỜ LÀM" value={`${store.totalHours.toFixed(2)} giờ`} tone="blue" /><Stat label="PHỤ CẤP TIKTOK" value={money(rows.reduce((sum, row) => sum + Number(row.tiktok_allowance ?? 0), 0))} tone="orange" /></div><Panel title={`Lịch sử ca làm việc · ${month}`}>{loading ? <p>Đang tải...</p> : <div className="op-table-wrap"><table><thead><tr><th>Mã ca</th><th>Nhân viên</th><th>Vào ca</th><th>Kết ca</th><th>Số giờ</th><th>Lương/giờ</th><th>Phụ cấp</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={7}>Chưa có ca làm việc trong kỳ.</td></tr> : rows.map((shift) => { const start = new Date(shift.started_at).getTime(); const end = shift.ended_at ? new Date(shift.ended_at).getTime() : nowMs ?? start; const hours = Math.max(0, Math.min(24, (end - start) / 3_600_000)); return <tr key={shift.id}><td><b>{shift.shift_code}</b></td><td>{shift.employeeCode} · {shift.employeeName}</td><td>{dateTime24(shift.started_at)}</td><td>{shift.ended_at ? dateTime24(shift.ended_at) : "Đang làm"}</td><td>{hours.toFixed(2)} giờ</td><td>{money(shift.hourlyRate)}</td><td>{money(shift.tiktok_allowance)}</td></tr>; })}</tbody></table></div>}</Panel></div>;
}
