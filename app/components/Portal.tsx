"use client";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BadgeDollarSign, Banknote, BarChart3, Bell, Calendar, CalendarDays, CalendarRange, CheckCircle2, ClipboardCheck, Clock3, Download, Eye, Flower2, Gift, History, Home, LayoutDashboard, LogOut, Menu, PackageOpen, Pencil, Percent, PieChart, Plus, ReceiptText, RefreshCw, Settings, ShoppingBag, ShoppingCart, Store, Trash2, TrendingUp, UserRound, UsersRound, WalletCards, X, type LucideIcon } from "lucide-react";
import { FunctionalEmployeeTasks, FunctionalSettings, FunctionalTaskManager } from "./FunctionalModules";
import { ReferenceManagerCashflow, ReferenceManagerDividend, ReferenceManagerPayroll, ReferenceManagerReports, ReferenceManagerTransfer } from "./ReferenceManagerModules";
import { ReferenceEmployeeCashflow, ReferenceEmployeePayroll, ReferenceEmployeeRevenue, ReferenceEmployeeShiftHistory } from "./ReferenceEmployeeModules";
import { ReferenceEmployeeHome } from "./ReferenceEmployeeHome";
import { ReferenceEmployees, ReferenceStoreModule } from "./ReferenceStoreModules";
import { FixedCostManagement } from "./FixedCostManagement";
import { StoreScheduleManagement, StoreShiftManagement } from "./StoreSchedulingModules";
type Role = "MANAGER" | "EMPLOYEE";
type User = {
    id: string;
    username: string;
    role: Role;
    name: string;
    employeeId: string | null;
    storeId: string | null;
    homeStoreId: string | null;
    storeName: string | null;
    homeStoreName: string | null;
    employeeCode: string | null;
    employeePosition: string | null;
    employeePhone: string | null;
    activeTransferId: string | null;
    isSupporting: boolean;
    shiftActive: number;
    currentShift: string | null;
    shiftStartedAt: string | null;
    currentShiftName: string | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
};
type EmployeeShiftState = {
    active: boolean;
    shiftCode: string | null;
    startedAt: string | null;
    shiftName: string | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
};
type Store = {
    id: string;
    name: string;
    address: string;
    revenue: number;
    expense: number;
    profit: number;
    status: string;
};
type Order = {
    id: string;
    code: string;
    employeeName: string;
    customer_name: string | null;
    phone: string | null;
    age: number | null;
    amount: number;
    payment_method: "CASH" | "BANK_TRANSFER";
    status: string;
    created_at: string;
};
type ShiftClosePayload = {
    tasksCompleted: boolean;
    expenseAmount: number;
    expenseNote: string;
    cashRevenue: number;
    transferRevenue: number;
};
const money = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value)) + " đ";
const compactMoney = (value: number) => value >= 1000000000 ? `${(value / 1000000000).toFixed(2)} tỷ` : value >= 1000000 ? `${(value / 1000000).toFixed(1)} tr` : money(value);
const dateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
const localDate = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
function exportCsvFile(filename: string, rows: Array<Array<string | number | null>>) {
    const cell = (value: string | number | null) => { const raw = String(value ?? ""); const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; };
    const blob = new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
export function calculateEmployeeBonus(profit: number, totalHours: number, employeeHours: number) {
    if (profit <= 0 || totalHours <= 0 || employeeHours <= 0)
        return 0;
    const profitPerHour = profit / totalHours;
    const rate = profitPerHour >= 30000 ? 0.07 : profitPerHour >= 15000 ? 0.05 : profitPerHour >= 7000 ? 0.03 : 0;
    return Math.round((employeeHours / totalHours) * profit * rate);
}
const managerMenu = ["Tổng quan", "Cửa hàng", "Giao việc", "Dòng tiền", "Lương thưởng quản lý", "Báo cáo", "Cổ tức", "Điều chuyển nhân sự", "Cài đặt"];
const storeMenu = ["Tổng quan", "Ca làm việc", "Lịch phân ca", "Nhân viên", "Nhập hàng", "Chi phí cố định", "Chấm công", "Lương thưởng", "Đơn hàng", "Dòng tiền", "Báo cáo", "Cài đặt"];
const employeeMenu = ["Trang chủ", "Đơn hàng", "Doanh thu", "Bảng lương", "Dòng tiền", "Lịch sử ca làm"];
const menuIcons: Record<string, LucideIcon> = { "Tổng quan": LayoutDashboard, "Cửa hàng": Store, "Giao việc": ClipboardCheck, "Dòng tiền": WalletCards, "Lương thưởng quản lý": BadgeDollarSign, "Báo cáo": BarChart3, "Điều chuyển nhân sự": UsersRound, "Cổ tức": PieChart, "Cài đặt": Settings, "Ca làm việc": CalendarDays, "Lịch phân ca": CalendarRange, "Nhân viên": UserRound, "Nhập hàng": PackageOpen, "Chi phí cố định": ReceiptText, "Chấm công": Clock3, "Lương thưởng": BadgeDollarSign, "Đơn hàng": ShoppingCart, "Trang chủ": Home, "Doanh thu": TrendingUp, "Bảng lương": BadgeDollarSign, "Lịch sử ca làm": History };
const statIcons: Record<string, LucideIcon> = { "₫": Banknote, "▤": ReceiptText, "▥": BarChart3, "%": Percent, "♕": BadgeDollarSign, "✦": Gift, "✓": CheckCircle2, "▧": ShoppingBag, "↓": ReceiptText, "↗": TrendingUp };
export default function Portal({ expectedRole }: {
    expectedRole: Role;
}) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetch("/api/auth/me").then(async (response) => response.ok ? response.json() : null).then((data) => {
            if (!data?.user)
                return window.location.replace("/");
            if (data.user.role !== expectedRole)
                return window.location.replace(data.user.role === "MANAGER" ? "/manager" : "/employee");
            setUser(data.user);
        }).finally(() => setLoading(false));
    }, [expectedRole]);
    if (loading || !user)
        return <div className="app-loading"><div className="pulse-logo">DORE</div><p>Đang tải dữ liệu vận hành...</p></div>;
    return expectedRole === "MANAGER" ? <ManagerPortal user={user}/> : <EmployeePortal user={user} onUser={setUser}/>;
}
function AppShell({ brand, subtitle, menu, active, onActive, user, children, onBack, accent = "dark" }: {
    brand: string;
    subtitle: string;
    menu: string[];
    active: string;
    onActive: (item: string) => void;
    user: User;
    children: ReactNode;
    onBack?: () => void;
    accent?: "dark" | "light" | "employee";
}) {
    const [open, setOpen] = useState(false);
    async function logout() { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/"; }
    return <div className={`app-shell ${accent}`}>
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-brand"><div className="mini-mark">{accent === "dark" ? <Flower2 size={27}/> : accent === "employee" ? <b>DORE</b> : <Store size={24}/>}</div><div><strong>{brand}</strong><span>{subtitle}</span></div><button className="close-menu" onClick={() => setOpen(false)} aria-label="Đóng menu"><X size={21}/></button></div>
      {onBack && <button className="back-system" onClick={onBack}><ArrowLeft size={17}/> Tổng quan hệ thống</button>}
      <nav>{menu.map((item) => { const Icon = menuIcons[item] ?? LayoutDashboard; return <button key={item} className={active === item ? "active" : ""} onClick={() => { onActive(item); setOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}><i><Icon size={19} strokeWidth={1.8}/></i>{item}</button>; })}</nav>
      <div className="sidebar-user"><div className="avatar"><UserRound size={20}/></div><div><b>{user.name}</b><span>{user.role === "MANAGER" ? "Quản lý hệ thống" : `${user.employeeCode ?? "NV"} · ${user.employeePosition ?? "Nhân viên"}`}</span></div></div>
      <button className="logout-button" onClick={logout}><LogOut size={18}/> Đăng xuất</button>
    </aside>
    <section className="main-area"><header className="mobile-header"><button onClick={() => setOpen(true)} aria-label="Mở menu"><Menu size={23}/></button><b>{brand}</b><Bell size={19}/></header>{children}</section>
    {open && <button className="menu-overlay" aria-label="Đóng menu" onClick={() => setOpen(false)}/>} 
  </div>;
}
function ManagerPortal({ user }: {
    user: User;
}) {
    const [view, setView] = useState("Tổng quan");
    const [storeView, setStoreView] = useState("Tổng quan");
    const [selectedStore, setSelectedStore] = useState<Store | null>(null);
    const [stores, setStores] = useState<Store[]>([]);
    const [loading, setLoading] = useState(true);
    const loadStores = useCallback(async () => {
        const response = await fetch("/api/stores");
        const data = await response.json();
        setStores(data.stores ?? []);
        setLoading(false);
    }, []);
    useEffect(() => { loadStores(); }, [loadStores]);
    if (selectedStore)
        return <AppShell brand={selectedStore.name} subtitle="Quản lý cửa hàng" menu={storeMenu} active={storeView} onActive={setStoreView} user={user} onBack={() => setSelectedStore(null)} accent="light"><StoreWorkspace store={selectedStore} view={storeView}/></AppShell>;
    return <AppShell brand="DORE" subtitle="Quản lý toàn hệ thống" menu={managerMenu} active={view} onActive={setView} user={user}><ManagerHeader view={view}/><ManagerView view={view} stores={stores} loading={loading} reload={loadStores} openStore={setSelectedStore}/></AppShell>;
}
function ManagerHeader({ view }: {
    view: string;
}) {
    const subtitles: Record<string, string> = {
        "Tổng quan": "Xin chào, Quản trị viên! Đây là tổng quan hoạt động của tất cả cửa hàng.",
        "Cửa hàng": "Quản lý thông tin cửa hàng, nhân sự và kết quả hoạt động của từng cửa hàng.",
        "Giao việc": "Danh sách công việc cho từng ca làm – giúp nhân viên dễ dàng theo dõi và thực hiện.",
        "Dòng tiền": "Theo dõi doanh thu, chi phí và lợi nhuận của từng cửa hàng.",
        "Lương thưởng quản lý": "Quản lý lương cố định và thưởng 2% lợi nhuận theo từng cửa hàng.",
        "Báo cáo": "Theo dõi và phân tích kết quả hoạt động của hệ thống.",
        "Cổ tức": "Quản lý lợi nhuận sau cùng và phân chia cổ tức cho cổ đông.",
        "Điều chuyển nhân sự": "Quản lý nhân viên hỗ trợ giữa các cửa hàng theo thời gian và ca làm việc.",
        "Cài đặt": "Quản lý thông tin tài khoản và các thiết lập hệ thống.",
    };
    return <div className="page-header"><div><h1>{view}</h1><p>{subtitles[view]}</p></div><div className="header-actions"><label className="date-control"><Calendar size={17}/><input aria-label="Tháng báo cáo" type="month" defaultValue="2026-08"/></label><button className="bell" aria-label="Thông báo" onClick={() => alert("Bạn có 3 thông báo vận hành mới.")}><Bell size={20}/><span>3</span></button></div></div>;
}
function StatCard({ label, value, note, tone = "green", icon = "↗" }: {
    label: string;
    value: string;
    note?: string;
    tone?: string;
    icon?: string;
}) {
    const Icon = statIcons[icon] ?? TrendingUp;
    return <article className={`stat-card ${tone}`}><div className="stat-icon"><Icon size={25} strokeWidth={1.9}/></div><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}
function ManagerView({ view, stores, loading, reload, openStore }: {
    view: string;
    stores: Store[];
    loading: boolean;
    reload: () => Promise<void>;
    openStore: (store: Store) => void;
}) {
    const totals = useMemo(() => stores.reduce((sum, store) => ({ revenue: sum.revenue + store.revenue, expense: sum.expense + store.expense, profit: sum.profit + store.profit }), { revenue: 0, expense: 0, profit: 0 }), [stores]);
    if (view === "Tổng quan")
        return <DashboardOverview stores={stores} totals={totals} loading={loading} openStore={openStore}/>;
    if (view === "Cửa hàng")
        return <StoresView stores={stores} totals={totals} reload={reload} openStore={openStore}/>;
    if (view === "Giao việc")
        return <FunctionalTaskManager stores={stores}/>;
    if (view === "Dòng tiền")
        return <ReferenceManagerCashflow stores={stores} totals={totals}/>;
    if (view === "Lương thưởng quản lý")
        return <ReferenceManagerPayroll stores={stores}/>;
    if (view === "Báo cáo")
        return <ReferenceManagerReports stores={stores} totals={totals}/>;
    if (view === "Điều chuyển nhân sự")
        return <ReferenceManagerTransfer stores={stores}/>;
    if (view === "Cổ tức")
        return <ReferenceManagerDividend totals={totals}/>;
    return <FunctionalSettings name="Quản trị viên" email="admin@dore.vn"/>;
}
function DashboardOverview({ stores, totals, loading, openStore }: {
    stores: Store[];
    totals: {
        revenue: number;
        expense: number;
        profit: number;
    };
    loading: boolean;
    openStore: (store: Store) => void;
}) {
    return <div className="page-content">
    <div className="stats-grid three"><StatCard label="TỔNG DOANH THU" value={compactMoney(totals.revenue)} note="↑ 12,45% so với tháng trước" icon="₫"/><StatCard label="TỔNG CHI PHÍ" value={compactMoney(totals.expense)} note="↑ 8,32% so với tháng trước" tone="orange" icon="▤"/><StatCard label="TỔNG LỢI NHUẬN" value={compactMoney(totals.profit)} note="↑ 16,78% so với tháng trước" tone="blue" icon="▥"/></div>
    <div className="section-title"><div><h2>Quản lý cửa hàng</h2><p>Chọn cửa hàng để xem và quản lý chi tiết.</p></div><span>{stores.filter((store) => store.status === "ACTIVE").length} cửa hàng đang hoạt động</span></div>
    <div className="store-grid">{loading ? Array.from({ length: 5 }, (_, i) => <div className="store-card loading-card" key={i}/>) : stores.map((store, index) => <article className={`store-card ${store.status === "INACTIVE" ? "inactive" : ""}`} key={store.id}><div className={`store-cover cover-${index % 5}`}><div className="shop-sign"><b>DORE</b><span>{store.name.replace("DORE ", "")}</span></div><div className="shop-front"><i /><i /><i /></div></div><div className="store-card-body"><div className={`store-status ${store.status === "INACTIVE" ? "inactive" : ""}`}>● {store.status === "INACTIVE" ? "Ngưng hoạt động" : "Đang hoạt động"}</div><h3>{store.name}</h3><p>⌖ {store.address}</p><div className="store-numbers"><span>Doanh thu tháng <b>{money(store.revenue)}</b></span><span>Lợi nhuận <b>{money(store.profit)}</b></span></div><button className="store-open" onClick={() => openStore(store)}>Xem cửa hàng <span>→</span></button></div></article>)}</div>
  </div>;
}
function StoresView({ stores, totals, reload, openStore }: {
    stores: Store[];
    totals: {
        revenue: number;
        expense: number;
        profit: number;
    };
    reload: () => Promise<void>;
    openStore: (store: Store) => void;
}) {
    const [showForm, setShowForm] = useState(false);
    const [editing, setEditing] = useState<Store | null>(null);
    const [name, setName] = useState("");
    const [address, setAddress] = useState("");
    const [status, setStatus] = useState<"ACTIVE" | "INACTIVE">("ACTIVE");
    const [message, setMessage] = useState("");
    const [query, setQuery] = useState("");
    const filteredStores = stores.filter((store) => `${store.name} ${store.address}`.toLocaleLowerCase("vi-VN").includes(query.toLocaleLowerCase("vi-VN")));
    function beginEdit(store?: Store) { setEditing(store ?? null); setName(store?.name ?? "DORE "); setAddress(store?.address ?? ""); setStatus(store?.status === "INACTIVE" ? "INACTIVE" : "ACTIVE"); setMessage(""); setShowForm(true); }
    async function save(event: FormEvent) { event.preventDefault(); const response = await fetch("/api/stores", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: editing?.id, name, address, status }) }); const data = await response.json(); if…12619 tokens truncated…ze={23}/></span><div><h2>ĐƠN HÀNG</h2><p>Quản lý danh sách đơn hàng</p></div></div>
                <div className="orders-actions"><button className="secondary-button" onClick={exportCsv} disabled={filtered.length === 0}><Download size={17}/> Xuất Excel</button><button className="primary-button" disabled={!shift.active} onClick={beginAdd}><Plus size={18}/> Thêm đơn hàng</button></div>
            </div>
            <div className="order-stats">
                <div className="order-stat-card"><i><ShoppingBag size={26}/></i><span>Tổng số đơn<strong>{completed.length}</strong></span></div>
                <div className="order-stat-card"><i><BadgeDollarSign size={26}/></i><span>Tổng tiền CK<strong>{money(bank)}</strong></span></div>
                <div className="order-stat-card"><i><Banknote size={26}/></i><span>Tổng tiền TM<strong>{money(cash)}</strong></span></div>
                <div className="order-stat-card"><i><WalletCards size={26}/></i><span>Tổng tiền<strong>{money(cash + bank)}</strong></span></div>
            </div>
            <div className="order-filters">
                <label className="order-search"><span className="sr-only">Tìm kiếm đơn hàng</span><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Tìm kiếm mã đơn hàng, tên khách hàng, SĐT..."/></label>
                <label><span className="sr-only">Từ ngày</span><input type="date" value={fromDate} onChange={event => { setFromDate(event.target.value); setPage(1); }}/></label>
                <label><span className="sr-only">Đến ngày</span><input type="date" value={toDate} onChange={event => { setToDate(event.target.value); setPage(1); }}/></label>
                <label><span>Hình thức thanh toán</span><select value={payment} onChange={event => { setPayment(event.target.value); setPage(1); }}><option value="ALL">Tất cả</option><option value="CASH">Tiền mặt</option><option value="BANK_TRANSFER">Chuyển khoản</option></select></label>
                <button className="refresh-button" onClick={resetFilters}><RefreshCw size={17}/> Làm mới</button>
            </div>
            <div className="data-table-wrap">
                <table className="order-table"><thead><tr><th>STT</th><th>Mã đơn hàng</th><th>Tên khách hàng</th><th>SĐT</th><th>Tuổi</th><th>NV bán hàng</th><th>Giá trị đơn hàng</th><th>Hình thức thanh toán</th><th>Thời gian tạo</th><th>Thao tác</th></tr></thead>
                    <tbody>{paged.length === 0 ? <tr><td colSpan={10} className="empty-cell">{shift.active ? "Chưa có đơn hàng phù hợp trong ca hiện tại." : "Bạn chưa bắt đầu ca làm việc"}</td></tr> : paged.map((order, index) => <tr key={order.id} className={order.status === "VOID" ? "void-order" : ""}><td>{(Math.min(page, pages) - 1) * pageSize + index + 1}</td><td><b className="order-code">{order.code}</b></td><td>{order.customer_name || "—"}</td><td>{order.phone || "—"}</td><td>{order.age ?? "—"}</td><td><b>{order.employeeName}</b><small>{shift.shiftCode ? `(${shift.shiftCode})` : ""}</small></td><td><b>{money(order.amount)}</b></td><td><span className={`order-payment ${order.payment_method === "CASH" ? "cash" : "bank"}`}>{order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</span></td><td>{dateTime(order.created_at)}</td><td><div className="order-row-actions"><button title="Xem chi tiết" onClick={() => setDetail(order)}><Eye size={15}/></button><button title="Sửa đơn" disabled={!shift.active || order.status !== "COMPLETED"} onClick={() => beginEdit(order)}><Pencil size={15}/></button><button className="danger" title="Hủy đơn" disabled={!shift.active || order.status !== "COMPLETED"} onClick={() => cancel(order.id)}><Trash2 size={15}/></button></div></td></tr>)}</tbody>
                </table>
            </div>
            <div className="order-pagination"><span>Hiển thị {filtered.length === 0 ? 0 : (Math.min(page, pages) - 1) * pageSize + 1} - {Math.min(Math.min(page, pages) * pageSize, filtered.length)} của {filtered.length} đơn hàng</span><div><button disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>‹</button>{Array.from({ length: pages }, (_, index) => index + 1).slice(0, 5).map(number => <button key={number} className={Math.min(page, pages) === number ? "active" : ""} onClick={() => setPage(number)}>{number}</button>)}<button disabled={page >= pages} onClick={() => setPage(current => Math.min(pages, current + 1))}>›</button></div></div>
        </div>
        <div className="order-form-card" ref={formRef}>
            <div className="order-form-title"><ShoppingCart size={21}/><h2>{editing ? `SỬA ĐƠN HÀNG ${editing.code}` : "THÊM ĐƠN HÀNG MỚI"}</h2></div>
            <form onSubmit={save}>
                <fieldset disabled={!shift.active}>
                    <div className="order-form-grid">
                        <label>Mã đơn hàng<input value={editing?.code ?? "Tự động khi lưu"} disabled/><small>Mã đơn hàng được tạo tự động</small></label>
                        <label>Tên khách hàng <small>(không bắt buộc)</small><input value={form.customerName} onChange={event => updateForm("customerName", event.target.value)} placeholder="Nhập tên khách hàng" maxLength={100}/></label>
                        <label>SĐT <small>(không bắt buộc)</small><input value={form.phone} onChange={event => updateForm("phone", event.target.value)} placeholder="Nhập số điện thoại" inputMode="tel" maxLength={20}/></label>
                        <label>Tuổi <small>(không bắt buộc)</small><input value={form.age} onChange={event => updateForm("age", event.target.value)} placeholder="Nhập tuổi" type="number" min="1" max="120"/></label>
                        <label>NV bán hàng<input value={`${user.name}${shift.shiftName ? ` (${shift.shiftName})` : shift.shiftCode ? ` (${shift.shiftCode})` : ""}`} disabled/><small>Tự động gắn theo tài khoản và ca hiện tại</small></label>
                        <label>Giá trị đơn hàng<input value={form.amount} onChange={event => updateForm("amount", event.target.value)} placeholder="Nhập giá trị đơn hàng" type="number" min="1" step="1" required/></label>
                        <label>Hình thức thanh toán<select value={form.paymentMethod} onChange={event => updateForm("paymentMethod", event.target.value)} required><option value="CASH">Tiền mặt</option><option value="BANK_TRANSFER">Chuyển khoản</option></select></label>
                    </div>
                </fieldset>
                {message && <div className="form-message">{message}</div>}
                {success && <div className="order-success">✓ {success}</div>}
                <div className="order-form-actions"><button type="button" className="secondary-button" onClick={resetForm}>Hủy</button><button className="primary-button" disabled={!shift.active}>{editing ? "Lưu thay đổi" : "Lưu đơn hàng"}</button></div>
            </form>
        </div>
        {detail && <div className="modal-backdrop"><div className="modal order-detail-modal"><div className="modal-title"><h2>Chi tiết đơn {detail.code}</h2><button onClick={() => setDetail(null)}>×</button></div><dl><div><dt>Khách hàng</dt><dd>{detail.customer_name || "Khách lẻ"}</dd></div><div><dt>Số điện thoại</dt><dd>{detail.phone || "Không cung cấp"}</dd></div><div><dt>Tuổi</dt><dd>{detail.age ?? "Không cung cấp"}</dd></div><div><dt>Nhân viên / ca</dt><dd>{detail.employeeName} · {shift.shiftCode}</dd></div><div><dt>Thanh toán</dt><dd>{detail.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</dd></div><div><dt>Giá trị</dt><dd>{money(detail.amount)}</dd></div><div><dt>Thời gian tạo</dt><dd>{dateTime(detail.created_at)}</dd></div><div><dt>Trạng thái</dt><dd>{detail.status === "COMPLETED" ? "Hoàn tất" : "Đã hủy"}</dd></div></dl></div></div>}
    </section>;
}
function OrderTable({ orders, onCancel }: {
    orders: Order[];
    onCancel?: (id: string) => void;
}) { return <div className="table-card"><div className="table-head"><h2>Danh sách đơn</h2><span>{orders.length} đơn trong ca</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Mã đơn</th><th>Thời gian</th><th>Khách hàng</th><th>Nhân viên</th><th>Thanh toán</th><th>Giá trị</th><th>Trạng thái</th>{onCancel && <th />}</tr></thead><tbody>{orders.length === 0 ? <tr><td colSpan={8} className="empty-cell">Chưa có đơn hàng trong ca hiện tại.</td></tr> : orders.map(o => <tr key={o.id}><td><b>{o.code}</b></td><td>{dateTime(o.created_at)}</td><td>{o.customer_name || "Khách lẻ"}</td><td>{o.employeeName}</td><td>{o.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</td><td><b>{money(o.amount)}</b></td><td><span className={o.status === "COMPLETED" ? "status-pill" : "void-pill"}>{o.status === "COMPLETED" ? "Hoàn tất" : "Đã hủy"}</span></td>{onCancel && <td><button className="danger-link" disabled={o.status !== "COMPLETED"} onClick={() => onCancel(o.id)}>Hủy</button></td>}</tr>)}</tbody></table></div></div>; }
function EmployeePayroll() { return <><div className="filter-card"><label>Tháng<input type="month" defaultValue="2026-08"/></label><label>Đến ngày<input type="date" defaultValue="2026-08-06"/></label><button className="primary-button">Xem thống kê</button></div><div className="stats-grid four"><StatCard label="TỔNG THU NHẬP" value="5.250.000 đ"/><StatCard label="TỔNG LƯƠNG" value="4.800.000 đ" tone="blue"/><StatCard label="TỔNG THƯỞNG" value="450.000 đ" tone="orange"/><StatCard label="HOÀN THÀNH CA" value="100%" icon="✓"/></div><div className="table-card"><div className="table-head"><h2>Chi tiết lương theo ca</h2><span>Đơn giá 20.000 đ/giờ</span></div><table className="data-table"><thead><tr><th>Ngày làm</th><th>Ca</th><th>Giờ vào</th><th>Giờ kết</th><th>Số giờ</th><th>Lương cứng</th><th>Thưởng</th><th>Thành tiền</th></tr></thead><tbody>{[["05/08/2026", "Ca 1", "07:02", "12:05", "5,05", "101.000 đ", "50.000 đ", "151.000 đ"], ["04/08/2026", "Ca 2", "12:01", "17:03", "5,03", "100.600 đ", "0 đ", "100.600 đ"], ["03/08/2026", "Ca 3", "17:00", "23:03", "6,05", "121.000 đ", "80.000 đ", "201.000 đ"]].map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j} className={j === 7 ? "money-green" : ""}>{x}</td>)}</tr>)}</tbody></table></div></>; }
export function EmployeeCashflow({ shift, orders }: {
    shift: {
        active: boolean;
    };
    orders: Order[];
}) { const active = orders.filter(o => o.status === "COMPLETED"); const revenue = active.reduce((a, o) => a + o.amount, 0); const cost = shift.active ? 350000 : 0; return <>{!shift.active && <div className="locked-banner"><b>Bạn chưa bắt đầu ca làm việc</b><span>Số liệu dòng tiền sẽ xuất hiện khi ca được kích hoạt.</span></div>}<div className="stats-grid three"><StatCard label="DOANH THU CA" value={money(revenue)} note={`${active.length} đơn hàng`}/><StatCard label="CHI PHÍ CA" value={money(cost)} tone="orange" note="Chi phí phát sinh"/><StatCard label="LỢI NHUẬN TẠM TÍNH" value={money(Math.max(0, revenue - cost))} tone="blue" note="Doanh thu - Chi phí"/></div><div className="table-card"><div className="table-head"><h2>Lịch sử dòng tiền các ca</h2><button>Xuất Excel ↓</button></div><table className="data-table"><thead><tr><th>Ngày</th><th>Ca</th><th>Số đơn</th><th>Doanh thu</th><th>Chi phí</th><th>Lợi nhuận</th><th>Trạng thái</th></tr></thead><tbody><tr><td>05/08/2026</td><td>Ca 1</td><td>56</td><td>2.350.000 đ</td><td>320.000 đ</td><td className="money-green">2.030.000 đ</td><td><span className="status-pill">Đã kết ca</span></td></tr><tr><td>04/08/2026</td><td>Ca 2</td><td>49</td><td>2.100.000 đ</td><td>310.000 đ</td><td className="money-green">1.790.000 đ</td><td><span className="status-pill">Đã kết ca</span></td></tr></tbody></table></div></>; }
function EmployeeHistory() { return <><div className="filter-card"><label>Từ ngày<input type="date" defaultValue="2026-08-01"/></label><label>Đến ngày<input type="date" defaultValue="2026-08-31"/></label><label>Ca làm<select><option>Tất cả</option><option>Ca 1</option><option>Ca 2</option></select></label><button className="primary-button">Tìm kiếm</button></div><div className="table-card"><div className="table-head"><h2>Lịch sử ca làm</h2><button>Xuất Excel ↓</button></div><table className="data-table"><thead><tr><th>Ngày làm</th><th>Mã nhân viên</th><th>Ca</th><th>Giờ vào</th><th>Giờ kết</th><th>Số giờ</th><th>Lương giờ</th><th>Lương dự tính</th></tr></thead><tbody>{[["05/08/2026", "NV001", "Ca 1", "07:02", "12:05", "5,05 giờ", "20.000 đ", "101.000 đ"], ["04/08/2026", "NV001", "Ca 2", "12:01", "17:03", "5,03 giờ", "20.000 đ", "100.600 đ"], ["03/08/2026", "NV001", "Ca 3", "17:00", "23:03", "6,05 giờ", "20.000 đ", "121.000 đ"], ["02/08/2026", "NV001", "Ca 1", "07:00", "12:00", "5,00 giờ", "20.000 đ", "100.000 đ"]].map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j} className={j === 7 ? "money-green" : ""}>{x}</td>)}</tr>)}</tbody></table></div></>; }

// Kept as visual fallbacks while the functional modules above handle all active routes.
void [TasksView, ManagerPayroll, TransferView, DividendView, EmployeeHome, EmployeePayroll, EmployeeHistory];
