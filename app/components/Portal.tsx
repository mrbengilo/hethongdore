"use client";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BadgeDollarSign, Banknote, BarChart3, Bell, Calendar, CalendarDays, CalendarRange, CheckCircle2, ClipboardCheck, Clock3, Download, Eye, Flower2, Gift, History, Home, LayoutDashboard, LogOut, Menu, PackageOpen, Pencil, Percent, PieChart, Plus, ReceiptText, RefreshCw, Settings, ShoppingBag, ShoppingCart, Store, Trash2, TrendingUp, UserRound, UsersRound, WalletCards, X, type LucideIcon } from "lucide-react";
import { FunctionalEmployeeTasks, FunctionalSettings, FunctionalTaskManager } from "./FunctionalModules";
import { ReferenceManagerCashflow, ReferenceManagerDividend, ReferenceManagerPayroll, ReferenceManagerReports, ReferenceManagerTransfer } from "./ReferenceManagerModules";
import { ReferenceEmployeeCashflow, ReferenceEmployeePayroll, ReferenceEmployeeShiftHistory } from "./ReferenceEmployeeModules";
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
const employeeMenu = ["Trang chủ", "Đơn hàng", "Bảng lương", "Dòng tiền", "Lịch sử ca làm"];
const menuIcons: Record<string, LucideIcon> = { "Tổng quan": LayoutDashboard, "Cửa hàng": Store, "Giao việc": ClipboardCheck, "Dòng tiền": WalletCards, "Lương thưởng quản lý": BadgeDollarSign, "Báo cáo": BarChart3, "Điều chuyển nhân sự": UsersRound, "Cổ tức": PieChart, "Cài đặt": Settings, "Ca làm việc": CalendarDays, "Lịch phân ca": CalendarRange, "Nhân viên": UserRound, "Nhập hàng": PackageOpen, "Chi phí cố định": ReceiptText, "Chấm công": Clock3, "Lương thưởng": BadgeDollarSign, "Đơn hàng": ShoppingCart, "Trang chủ": Home, "Bảng lương": BadgeDollarSign, "Lịch sử ca làm": History };
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
    async function save(event: FormEvent) { event.preventDefault(); const response = await fetch("/api/stores", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: editing?.id, name, address, status }) }); const data = await response.json(); if (!response.ok)
        return setMessage(data.message); setShowForm(false); await reload(); }
    async function toggleStatus(store: Store) {
      const nextStatus = store.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
      const verb = nextStatus === "INACTIVE" ? "ngưng hoạt động" : "kích hoạt lại";
      if (!confirm(`Bạn có chắc muốn ${verb} ${store.name}? Dữ liệu lịch sử vẫn được giữ nguyên.`)) return;
      const response = await fetch("/api/stores", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: store.id, name: store.name, address: store.address, status: nextStatus }) });
      const data = await response.json();
      if (!response.ok) return alert(data.message);
      await reload();
    }
    const activeCount = stores.filter((store) => store.status === "ACTIVE").length;
    return <div className="page-content"><div className="store-admin-metrics"><StatCard label="TỔNG SỐ CỬA HÀNG" value={String(stores.length)} note={`${activeCount} đang hoạt động`} icon="▧"/><StatCard label="TỔNG NHÂN VIÊN" value="14" note="toàn hệ thống" icon="✓"/><StatCard label="TỔNG DOANH THU" value={money(totals.revenue)} note="trong khoảng thời gian chọn" icon="↗"/><StatCard label="TỔNG CHI PHÍ" value={money(totals.expense)} note="trong khoảng thời gian chọn" tone="orange" icon="▤"/><StatCard label="TỔNG LỢI NHUẬN" value={money(totals.profit)} note="trong khoảng thời gian chọn" tone="blue" icon="▥"/></div><div className="toolbar"><div className="stats-inline"><b>{stores.length}</b> cửa hàng · <b>{money(totals.revenue)}</b> doanh thu</div><div className="store-toolbar-actions"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm kiếm cửa hàng..."/><button className="primary-button" onClick={() => beginEdit()}>＋ Thêm cửa hàng</button></div></div><div className="table-card"><div className="table-head"><h2>Danh sách cửa hàng</h2></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>#</th><th>Cửa hàng</th><th>Địa chỉ</th><th>Nhân viên</th><th>Doanh thu</th><th>Chi phí</th><th>Lợi nhuận</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{filteredStores.map((store, index) => <tr key={store.id}><td>{index + 1}</td><td><button className="table-link" onClick={() => openStore(store)}>{store.name}</button></td><td>{store.address}</td><td><b>{index % 2 ? 4 : 3}</b> nhân viên</td><td className="money-green">{money(store.revenue)}</td><td className="money-orange">{money(store.expense)}</td><td className="money-blue">{money(store.profit)}</td><td><span className={`status-pill ${store.status === "INACTIVE" ? "inactive" : ""}`}>{store.status === "INACTIVE" ? "Ngưng hoạt động" : "Đang hoạt động"}</span></td><td><div className="row-actions"><button onClick={() => beginEdit(store)}>Sửa</button><button className={store.status === "ACTIVE" ? "danger" : ""} onClick={() => toggleStatus(store)}>{store.status === "ACTIVE" ? "Ngưng hoạt động" : "Kích hoạt lại"}</button></div></td></tr>)}</tbody></table></div></div>{showForm && <div className="modal-backdrop"><form className="modal" onSubmit={save}><div className="modal-title"><h2>{editing ? "Cập nhật cửa hàng" : "Thêm cửa hàng mới"}</h2><button type="button" onClick={() => setShowForm(false)}>×</button></div><label>Tên cửa hàng<input value={name} onChange={e => setName(e.target.value)} required/></label><label>Địa chỉ<input value={address} onChange={e => setAddress(e.target.value)} required/></label>{editing && <label>Trạng thái<select value={status} onChange={(event) => setStatus(event.target.value as "ACTIVE" | "INACTIVE")}><option value="ACTIVE">Đang hoạt động</option><option value="INACTIVE">Ngưng hoạt động</option></select></label>}<div className="info-box">{editing ? "Khi ngưng hoạt động, cửa hàng chỉ được xem dữ liệu lịch sử và không thể phát sinh thao tác mới." : "Hệ thống sẽ tự tạo ca làm, danh mục chi phí, lương thưởng, nhân viên, đơn hàng, dòng tiền và báo cáo cho cửa hàng mới."}</div>{message && <div className="form-message">{message}</div>}<div className="modal-actions"><button type="button" onClick={() => setShowForm(false)}>Hủy</button><button type="submit" className="primary-button">{editing ? "Lưu thay đổi" : "Tạo cửa hàng"}</button></div></form></div>}</div>;
}
function TasksView({ stores }: {
    stores: Store[];
}) { const [tasks, setTasks] = useState(["Mở cửa hàng, kiểm tra vệ sinh", "Sắp xếp và bổ sung hàng trên kệ", "Tư vấn và hỗ trợ khách hàng", "Báo cáo doanh thu cuối ca"]); const [sent, setSent] = useState(false); return <div className="page-content split-layout"><section className="form-card"><div className="form-grid three"><label>Cửa hàng<select>{stores.map(s => <option key={s.id}>{s.name}</option>)}</select></label><label>Ca làm<select><option>Ca 1 · 07:00 - 12:00</option><option>Ca 2 · 12:00 - 17:00</option><option>Ca 3 · 17:00 - 23:00</option></select></label><label>Ngày áp dụng<input type="date" defaultValue="2026-08-06"/></label></div><h2>Danh sách công việc</h2><div className="task-editor">{tasks.map((task, index) => <div key={index}><span>{index + 1}</span><input value={task} onChange={e => setTasks(tasks.map((t, i) => i === index ? e.target.value : t))}/><button onClick={() => setTasks(tasks.filter((_, i) => i !== index))}>×</button></div>)}</div><button className="ghost-button" onClick={() => setTasks([...tasks, ""])}>＋ Thêm công việc</button><button className="primary-button send-button" onClick={() => setSent(true)}>➤ Lưu và gửi</button>{sent && <div className="success-banner">✓ Đã gửi {tasks.length} công việc đến nhân viên trong ca.</div>}</section><aside className="help-card"><h2>Hướng dẫn</h2><ol><li>Chọn cửa hàng, ca và ngày áp dụng.</li><li>Nhập công việc cùng ghi chú cụ thể.</li><li>Nhân viên nhận việc trên trang chủ và tick khi hoàn thành.</li></ol><div className="phone-preview"><b>✓ Công việc cần làm</b><span>{tasks.length}</span></div></aside></div>; }
export function CashflowView({ stores, totals }: {
    stores: Store[];
    totals: {
        revenue: number;
        expense: number;
        profit: number;
    };
}) { return <div className="page-content"><div className="stats-grid three"><StatCard label="DOANH THU" value={money(totals.revenue)} note="↑ 12,45% so với kỳ trước"/><StatCard label="CHI PHÍ" value={money(totals.expense)} note="↑ 8,32% so với kỳ trước" tone="orange" icon="↓"/><StatCard label="LỢI NHUẬN" value={money(totals.profit)} note="↑ 16,78% so với kỳ trước" tone="blue" icon="▥"/></div><div className="chart-grid"><ChartCard title="Biểu đồ dòng tiền" values={[62, 70, 65, 80, 78, 73, 86]} labels={["01", "05", "10", "15", "20", "25", "31"]}/><DonutCard revenue={totals.revenue} expense={totals.expense} profit={totals.profit}/></div><div className="table-card"><div className="table-head"><h2>Chi tiết theo cửa hàng</h2><button onClick={() => exportCsvFile("dong-tien-he-thong.csv", [["Cửa hàng", "Doanh thu", "Chi phí", "Lợi nhuận", "Biên lợi nhuận"], ...stores.map(s => [s.name, s.revenue, s.expense, s.profit, `${((s.profit / Math.max(1, s.revenue)) * 100).toFixed(2)}%`])])}>Xuất báo cáo ↓</button></div><table className="data-table"><thead><tr><th>Cửa hàng</th><th>Doanh thu</th><th>Chi phí</th><th>Lợi nhuận</th><th>Biên lợi nhuận</th></tr></thead><tbody>{stores.map(s => <tr key={s.id}><td>{s.name}</td><td>{money(s.revenue)}</td><td>{money(s.expense)}</td><td className="money-green">{money(s.profit)}</td><td>{((s.profit / Math.max(1, s.revenue)) * 100).toFixed(2)}%</td></tr>)}</tbody></table></div></div>; }
function ChartCard({ title, values, labels }: {
    title: string;
    values: number[];
    labels: string[];
}) { return <section className="chart-card"><div className="chart-title"><h2>{title}</h2><span>● Doanh thu　● Chi phí　● Lợi nhuận</span></div><div className="bar-chart">{values.map((v, i) => <div key={i} className="bar-column"><div className="bar greenbar" style={{ height: `${v}%` }}/><div className="bar orangebar" style={{ height: `${Math.max(18, v - 31)}%` }}/><div className="bar bluebar" style={{ height: `${Math.max(12, v - 43)}%` }}/><span>{labels[i]}</span></div>)}</div></section>; }
function DonutCard({ revenue, expense, profit }: {
    revenue: number;
    expense: number;
    profit: number;
}) { const total = revenue + expense + profit; return <section className="chart-card"><h2>Tỷ lệ cơ cấu</h2><div className="donut-layout"><div className="donut" style={{ background: `conic-gradient(#07863b 0 ${(revenue / total) * 100}%,#ff7a15 0 ${((revenue + expense) / total) * 100}%,#2376ee 0)` }}><div><small>Tổng</small><b>{compactMoney(revenue)}</b></div></div><div className="legend"><span><i className="green-dot"/>Doanh thu <b>{money(revenue)}</b></span><span><i className="orange-dot"/>Chi phí <b>{money(expense)}</b></span><span><i className="blue-dot"/>Lợi nhuận <b>{money(profit)}</b></span></div></div></section>; }
function ManagerPayroll({ stores }: {
    stores: Store[];
}) { const rows = stores.map(s => ({ ...s, salary: 3000000, bonus: Math.max(0, Math.round(s.profit * .02)) })); const total = rows.reduce((a, s) => a + s.salary + s.bonus, 0); return <div className="page-content"><div className="notice-banner">ℹ Lương cố định quản lý là 3.000.000 đ/cửa hàng/tháng. Thưởng = 2% lợi nhuận cơ sở dương; không có phụ cấp.</div><div className="stats-grid three"><StatCard label="TỔNG LƯƠNG" value={money(rows.length * 3000000)} icon="♕"/><StatCard label="TỔNG THƯỞNG" value={money(rows.reduce((a, s) => a + s.bonus, 0))} tone="orange" icon="✦"/><StatCard label="TỔNG NHẬN" value={money(total)} tone="blue" icon="₫"/></div><div className="table-card"><div className="table-head"><h2>Lương thưởng theo cửa hàng · 08/2026</h2><span className="status-pill">Đã tính</span></div><table className="data-table"><thead><tr><th>Cửa hàng</th><th>Lợi nhuận cơ sở</th><th>Lương cố định</th><th>Thưởng 2%</th><th>Tổng nhận</th></tr></thead><tbody>{rows.map(s => <tr key={s.id}><td>{s.name}</td><td>{money(s.profit)}</td><td>{money(s.salary)}</td><td className="money-green">{money(s.bonus)}</td><td><b>{money(s.salary + s.bonus)}</b></td></tr>)}</tbody><tfoot><tr><td>TỔNG CỘNG</td><td /><td>{money(rows.length * 3000000)}</td><td>{money(rows.reduce((a, s) => a + s.bonus, 0))}</td><td>{money(total)}</td></tr></tfoot></table></div></div>; }
export function ReportsView({ stores, totals }: {
    stores: Store[];
    totals: {
        revenue: number;
        expense: number;
        profit: number;
    };
}) { return <div className="page-content"><div className="stats-grid four"><StatCard label="Tổng doanh thu" value={compactMoney(totals.revenue)}/><StatCard label="Tổng chi phí" value={compactMoney(totals.expense)} tone="orange"/><StatCard label="Tổng lợi nhuận" value={compactMoney(totals.profit)} tone="blue"/><StatCard label="Tỷ lệ lợi nhuận" value={`${(totals.profit / totals.revenue * 100).toFixed(2)}%`} icon="%"/></div><div className="chart-grid"><ChartCard title="Xu hướng 7 kỳ gần nhất" values={[54, 62, 58, 69, 65, 77, 81]} labels={["T2", "T3", "T4", "T5", "T6", "T7", "T8"]}/><DonutCard revenue={totals.revenue} expense={totals.expense} profit={totals.profit}/></div><div className="analysis-strip">▥ <b>Xu hướng:</b> Doanh thu và lợi nhuận tăng ổn định; {stores[1]?.name ?? "DORE CẦN THƠ"} đang dẫn đầu doanh thu tháng.</div></div>; }
function TransferView({ stores }: {
    stores: Store[];
}) { const [saved, setSaved] = useState(false); return <div className="page-content"><div className="transfer-layout"><section className="form-card"><h2>1. Thông tin nhân viên</h2><div className="employee-profile"><div className="avatar large">A</div><div><b>Nguyễn Văn An · NV0015</b><span>Nhân viên bán hàng</span><small>Đang làm tại cửa hàng chính</small></div></div><div className="detail-list"><span>Cửa hàng chính <b>DORE CẦN THƠ</b></span><span>Lương theo giờ <b>35.000 đ</b></span><span>Phụ cấp hỗ trợ <b>500.000 đ</b></span></div></section><section className="form-card"><h2>2. Thông tin điều chuyển</h2><div className="form-grid two"><label>Cửa hàng nhận<select>{stores.slice(1).map(s => <option key={s.id}>{s.name}</option>)}</select></label><label>Người phê duyệt<select><option>Quản trị viên DORE</option></select></label><label>Ngày bắt đầu<input type="date" defaultValue="2026-08-10"/></label><label>Ngày kết thúc<input type="date" defaultValue="2026-08-20"/></label></div><label>Ca áp dụng<div className="check-row"><span>☑ Ca sáng</span><span>☑ Ca chiều</span><span>☐ Ca tối</span></div></label><label>Lý do<textarea defaultValue="Hỗ trợ khai trương và ổn định hoạt động cửa hàng."/></label><button className="primary-button" onClick={() => setSaved(true)}>Lưu điều chuyển</button>{saved && <div className="success-banner">✓ Điều chuyển đã được lưu và chờ duyệt.</div>}</section><aside className="policy-card"><h2>3. Quyền truy cập</h2><p>✓ Được đăng nhập cửa hàng nhận trong thời gian hỗ trợ.</p><p>× Tự thu hồi quyền sau khi hết hạn.</p><p>⌂ Tự trở về cửa hàng chính.</p><hr /><h2>4. Lương & chi phí</h2><p>Lương, thưởng, phụ cấp phát sinh được tính cho cửa hàng nhận hỗ trợ.</p></aside></div><div className="table-card"><div className="table-head"><h2>Lịch sử điều chuyển</h2><button>Gia hạn thời gian</button></div><table className="data-table"><thead><tr><th>Thời gian</th><th>Cửa hàng hỗ trợ</th><th>Ca làm việc</th><th>Người duyệt</th><th>Trạng thái</th></tr></thead><tbody><tr><td>10/08 - 20/08/2026</td><td>DORE VĨNH LONG</td><td>Sáng, Chiều</td><td>Quản trị viên</td><td><span className="status-pill">Đang hỗ trợ</span></td></tr></tbody></table></div></div>; }
function DividendView({ totals }: {
    totals: {
        revenue: number;
        expense: number;
        profit: number;
    };
}) { const profit = Math.max(0, totals.profit); const vi = Math.round(profit * .6); const thuy = profit - vi; const [locked, setLocked] = useState(false); return <div className="page-content"><div className="stats-grid four"><StatCard label="DOANH THU THÁNG" value={compactMoney(totals.revenue)}/><StatCard label="TỔNG CHI PHÍ" value={compactMoney(totals.expense)} tone="orange"/><StatCard label="LỢI NHUẬN SAU CÙNG" value={compactMoney(profit)} tone="blue"/><StatCard label="TỶ LỆ LỢI NHUẬN" value={`${(profit / totals.revenue * 100).toFixed(2)}%`} icon="%"/></div><div className="chart-grid dividend-grid"><section className="chart-card"><h2>Thông tin cổ đông</h2><div className="shareholder"><span>TRƯƠNG VIỆT VI <b>60%</b></span><strong>{money(vi)}</strong></div><div className="shareholder"><span>PHẠM THỊ DIỄM THÚY <b>40%</b></span><strong>{money(thuy)}</strong></div><div className="share-total"><span>Tổng cổ tức</span><b>{money(profit)}</b></div><button disabled={locked} className="primary-button wide" onClick={() => setLocked(true)}>{locked ? "✓ Kỳ cổ tức đã khóa" : "Xác nhận chia cổ tức"}</button></section><ChartCard title="Lợi nhuận 8 tháng gần nhất" values={[40, 48, 44, 58, 71, 50, 62, 78]} labels={["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]}/></div><div className="table-card"><div className="table-head"><h2>Lịch sử chia cổ tức</h2><button>Xuất Excel ↓</button></div><table className="data-table"><thead><tr><th>Kỳ</th><th>Doanh thu</th><th>Chi phí</th><th>Lợi nhuận</th><th>Việt Vi (60%)</th><th>Diễm Thúy (40%)</th><th>Trạng thái</th></tr></thead><tbody><tr><td>08/2026</td><td>{money(totals.revenue)}</td><td>{money(totals.expense)}</td><td>{money(profit)}</td><td>{money(vi)}</td><td>{money(thuy)}</td><td><span className="status-pill">{locked ? "Đã khóa" : "Chờ xác nhận"}</span></td></tr></tbody></table></div><div className="ai-analysis"><div className="analysis-illustration">↗</div><div><h2>📈 Kết luận phân tích kỳ 08/2026</h2><p>Lợi nhuận sau cùng đạt <b>{compactMoney(profit)}</b>, tương đương biên lợi nhuận <b>{(profit / totals.revenue * 100).toFixed(2)}%</b>. Doanh thu tăng nhanh hơn chi phí, cho thấy hiệu quả vận hành được cải thiện. Cổ đông Trương Việt Vi nhận {compactMoney(vi)} và Phạm Thị Diễm Thúy nhận {compactMoney(thuy)}.</p></div></div></div>; }
function SettingsView({ name, email }: {
    name: string;
    email: string;
}) { const [saved, setSaved] = useState(false); return <div className="page-content settings-layout"><aside className="settings-nav"><h2>Cài đặt</h2><button className="active">▣ Thông tin cá nhân</button><button>▢ Đổi mật khẩu</button><button>♧ Thông báo</button><button>◎ Ngôn ngữ</button></aside><section className="form-card"><h2>Thông tin cá nhân</h2><p className="muted">Cập nhật thông tin tài khoản của bạn.</p><div className="profile-form"><div className="profile-photo">{name.slice(0, 1)}<button>⌁</button></div><div className="form-grid two"><label>Họ và tên<input defaultValue={name}/></label><label>Email<input defaultValue={email}/></label><label>Số điện thoại<input defaultValue="0901 234 567"/></label><label>Chức vụ<select><option>Quản lý hệ thống</option></select></label></div></div><label>Địa chỉ<input defaultValue="Ninh Kiều, TP. Cần Thơ"/></label><label>Giới thiệu<textarea defaultValue="Quản lý hệ thống chuỗi cửa hàng DORE."/></label><button className="primary-button align-right" onClick={() => setSaved(true)}>Lưu thay đổi</button>{saved && <div className="success-banner">✓ Đã lưu thông tin.</div>}</section></div>; }
function StoreWorkspace({ store, view }: {
    store: Store;
    view: string;
}) {
    const [orders, setOrders] = useState<Order[]>([]);
    useEffect(() => { if (view === "Đơn hàng")
        fetch(`/api/orders?storeId=${store.id}`).then(r => r.json()).then(d => setOrders(d.orders ?? [])); }, [view, store.id]);
    const title = view === "Tổng quan" ? `Tổng quan ${store.name}` : view;
    const inactive = store.status === "INACTIVE";
    return <><div className="page-header store-header"><div><span className="breadcrumb">CỬA HÀNG · {store.address}</span><h1>{title}</h1><p>Dữ liệu vận hành độc lập của {store.name}.</p></div><div className="header-actions"><span className={`store-state ${inactive ? "inactive" : ""}`}>{inactive ? "Ngưng hoạt động" : "Đang hoạt động"}</span><span className="date-control">▣ Tháng {new Date().toLocaleDateString("vi-VN", { month: "2-digit", year: "numeric" })}</span></div></div><div className={`page-content ${inactive ? "store-readonly" : ""}`}>{inactive && <div className="inactive-store-banner">Cửa hàng đang ngưng hoạt động. Các thao tác tạo hoặc sửa dữ liệu đã khóa; lịch sử dòng tiền và báo cáo vẫn được giữ nguyên.</div>}{view === "Tổng quan" && <><div className="stats-grid four"><StatCard label="Doanh thu" value={money(store.revenue)}/><StatCard label="Tổng chi phí" value={money(store.expense)} tone="orange"/><StatCard label="Lợi nhuận" value={money(store.profit)} tone="blue"/><StatCard label="Biên lợi nhuận" value={`${store.revenue ? (store.profit / store.revenue * 100).toFixed(2) : "0.00"}%`} icon="%"/></div><div className="chart-grid"><ChartCard title="Doanh thu & lợi nhuận theo ngày" values={[38, 55, 43, 68, 61, 77, 59]} labels={["01", "05", "10", "15", "20", "25", "31"]}/><section className="chart-card"><h2>Hoạt động hôm nay</h2><div className="activity-list"><span><i>{inactive ? 0 : 6}</i> Nhân viên đang làm</span><span><i>{inactive ? 0 : 3}</i> Ca làm việc</span><span><i>{orders.filter((order) => order.status === "COMPLETED").length}</i> Đơn hàng đã ghi nhận</span><span><i>{inactive ? 0 : 2}</i> Nhân sự hỗ trợ</span></div></section></div></>}{view === "Đơn hàng" ? <ManagerOrders orders={orders}/> : view === "Chi phí cố định" ? <FixedCostManagement store={store}/> : view !== "Tổng quan" && <StoreModule store={store} view={view}/>}</div></>;
}
function ManagerOrders({ orders }: {
    orders: Order[];
}) { const active = orders.filter(o => o.status === "COMPLETED"); const cash = active.filter(o => o.payment_method === "CASH").reduce((a, o) => a + o.amount, 0); const bank = active.filter(o => o.payment_method === "BANK_TRANSFER").reduce((a, o) => a + o.amount, 0); return <><div className="stats-grid four"><StatCard label="Tổng số đơn" value={String(active.length)} icon="▧"/><StatCard label="Tiền chuyển khoản" value={money(bank)} tone="blue"/><StatCard label="Tiền mặt" value={money(cash)} tone="orange"/><StatCard label="Tổng doanh thu" value={money(cash + bank)}/></div><OrderTable orders={orders}/></>; }
function StoreModule({ store, view }: {
    store: Store;
    view: string;
}) {
    if (view === "Cài đặt") return <FunctionalSettings name={`Quản lý ${store.name}`} email="quanly@dore.vn" storeId={store.id}/>;
    if (view === "Ca làm việc") return <StoreShiftManagement store={store}/>;
    if (view === "Lịch phân ca") return <StoreScheduleManagement store={store}/>;
    if (view === "Nhân viên") return <ReferenceEmployees store={store}/>;
    return <ReferenceStoreModule store={store} view={view}/>;
    const moduleData: Record<string, {
    stats: [
        string,
        string
    ][];
    columns: string[];
    rows: string[][];
}> = { "Ca làm việc": { stats: [["Tổng ca", "3 ca"], ["Tổng nhân viên", "18 người"], ["Tổng lượt ca", "32 lượt"]], columns: ["Ca", "Thời gian", "Nhân viên", "Trạng thái"], rows: [["Ca 1", "07:00 - 12:00", "6 nhân viên", "Đang hoạt động"], ["Ca 2", "12:00 - 17:00", "7 nhân viên", "Sắp tới"], ["Ca 3", "17:00 - 23:00", "5 nhân viên", "Sắp tới"]] }, "Lịch phân ca": { stats: [["Ca hôm nay", "3"], ["Nhân viên", "18"], ["Ca trống", "2"]], columns: ["Nhân viên", "Ca 1", "Ca 2", "Ca 3"], rows: [["Nguyễn Thị An", "07:00 - 12:00", "-", "-"], ["Trần Văn Bình", "-", "12:00 - 17:00", "-"], ["Lê Thị Cúc", "07:00 - 12:00", "-", "17:00 - 23:00"]] }, "Nhân viên": { stats: [["Tổng nhân viên", "3"], ["Đang làm việc", "3"], ["Tạm nghỉ", "0"]], columns: ["Mã NV", "Họ và tên", "Chức vụ", "SĐT", "Trạng thái"], rows: [["NV001", "Nguyễn Thị An", "Bán hàng", "0765 109 784", "Đang làm"], ["NV002", "Trần Văn Bình", "Bán hàng", "0923 456 789", "Đang làm"], ["NV003", "Lê Thị Cúc", "Thu ngân", "0812 345 678", "Đang làm"]] }, "Nhập hàng": { stats: [["Tổng mặt hàng", "28"], ["Số lượng", "128 bao"], ["Chi phí nhập", "124.850.000 đ"]], columns: ["Mặt hàng", "Số lượng", "Cân nặng", "Đơn giá/kg", "Thành tiền"], rows: [["Chân váy", "15 bao", "120 kg", "120.000 đ", "14.415.000 đ"], ["Đồ nam", "20 bao", "210,5 kg", "150.000 đ", "31.595.000 đ"], ["Áo dài", "10 bao", "80 kg", "200.000 đ", "16.015.000 đ"]] }, "Chấm công": { stats: [["Nhân viên", "6"], ["Tổng giờ làm", "27,91 giờ"], ["Tổng lương", "558.200 đ"]], columns: ["Nhân viên", "Ca", "Giờ vào", "Giờ kết ca", "Số giờ", "Lương nhận"], rows: [["Nguyễn Thị An", "Ca 1", "06:58", "12:05", "5,07", "101.400 đ"], ["Trần Văn Bình", "Ca 2", "11:59", "17:02", "5,05", "101.000 đ"], ["Lê Thị Cúc", "Ca 3", "16:58", "23:05", "6,12", "122.400 đ"]] }, "Lương thưởng": { stats: [["Tổng giờ", "612,5 giờ"], ["Lương cứng", "12.250.000 đ"], ["Tổng chi trả", "20.950.000 đ"]], columns: ["Nhân viên", "Giờ làm", "Lương cứng", "Phụ cấp TikTok", "Thưởng", "Tổng nhận"], rows: [["Nguyễn Thị An", "208,5", "4.170.000 đ", "500.000 đ", "3.000.000 đ", "7.670.000 đ"], ["Trần Văn Bình", "201", "4.020.000 đ", "700.000 đ", "2.000.000 đ", "6.720.000 đ"], ["Lê Thị Cúc", "203", "4.060.000 đ", "300.000 đ", "1.700.000 đ", "6.560.000 đ"]] }, "Dòng tiền": { stats: [["Doanh thu", money(store.revenue)], ["Chi phí", money(store.expense)], ["Lợi nhuận", money(store.profit)]], columns: ["Loại chi phí", "Số tiền", "Kỳ", "Ghi chú"], rows: [["Mặt bằng", "18.000.000 đ", "08/2026", "Chi phí cố định"], ["Marketing", "5.000.000 đ", "08/2026", "Quảng cáo tháng"], ["Điện, nước, wifi", "4.600.000 đ", "08/2026", "Đã đối soát"]] }, "Báo cáo": { stats: [["Nhân viên", "3"], ["Giờ làm", "612,5"], ["Tổng lương", "20.950.000 đ"]], columns: ["Nhân viên", "Giờ làm", "Lương cứng", "Thưởng", "Phụ cấp", "Lương nhận"], rows: [["Nguyễn Thị An", "208,5", "4.170.000 đ", "3.000.000 đ", "500.000 đ", "7.670.000 đ"], ["Trần Văn Bình", "201", "4.020.000 đ", "2.000.000 đ", "700.000 đ", "6.720.000 đ"]] } }; if (view === "Cài đặt")
    return <SettingsView name={`Quản lý ${store.name}`} email="quanly@dore.vn"/>; const data = moduleData[view] ?? moduleData["Ca làm việc"]; return <><div className="stats-grid three">{data.stats.map(([label, value], i) => <StatCard key={label} label={label} value={value} tone={i === 1 ? "orange" : i === 2 ? "blue" : "green"}/>)}</div><div className="table-card"><div className="table-head"><h2>Chi tiết {view.toLowerCase()}</h2><div><button>Bộ lọc</button><button>Xuất Excel ↓</button></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr>{data.columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{data.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className={j === row.length - 1 ? "money-green" : ""}>{cell}</td>)}</tr>)}</tbody></table></div></div></>; }
function EmployeePortal({ user, onUser }: {
    user: User;
    onUser: (user: User) => void;
}) {
    const [view, setView] = useState("Trang chủ");
    const [shift, setShift] = useState<EmployeeShiftState>({
        active: Boolean(user.shiftActive), shiftCode: user.currentShift, startedAt: user.shiftStartedAt,
        shiftName: user.currentShiftName, scheduledStart: user.scheduledStart, scheduledEnd: user.scheduledEnd,
    });
    const [orders, setOrders] = useState<Order[]>([]);
    const [tiktok, setTiktok] = useState(false);
    const loadOrders = useCallback(() => fetch("/api/orders").then(response => response.json()).then(data => setOrders(data.orders ?? [])), []);
    useEffect(() => {
        if (view === "Đơn hàng" || view === "Dòng tiền" || view === "Trang chủ")
            loadOrders();
    }, [view, loadOrders, shift.active]);
    async function shiftAction(action: "start" | "end", closing?: ShiftClosePayload) {
        const response = await fetch("/api/shift", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, tiktok, ...closing }) });
        const data = await response.json();
        if (!response.ok)
            return alert(data.message);
        const next = {
            ...user,
            shiftActive: data.active ? 1 : 0,
            currentShift: data.active ? data.shiftCode : null,
            shiftStartedAt: data.active ? data.startedAt : null,
            currentShiftName: data.active ? data.shiftName : null,
            scheduledStart: data.active ? data.scheduledStart : null,
            scheduledEnd: data.active ? data.scheduledEnd : null,
        };
        onUser(next);
        setShift({
            active: data.active,
            shiftCode: data.active ? data.shiftCode : null,
            startedAt: data.active ? data.startedAt : null,
            shiftName: data.active ? data.shiftName : null,
            scheduledStart: data.active ? data.scheduledStart : null,
            scheduledEnd: data.active ? data.scheduledEnd : null,
        });
        if (action === "end")
            alert(data.tiktokAllowance ? `${data.message} Phụ cấp TikTok: ${money(data.tiktokAllowance)}.` : (data.message ?? "Đã kết ca và ghi nhận lịch sử ca làm."));
        if (action === "end") setTiktok(false);
        loadOrders();
    }
    const showStoreBrand = view === "Trang chủ" || view === "Đơn hàng";
    const employeeStoreName = user.storeName ?? user.homeStoreName ?? "DORE";
    return <AppShell brand={employeeStoreName} subtitle={user.isSupporting ? "Đang hỗ trợ tạm thời" : "Hệ thống làm việc nhân viên"} menu={employeeMenu} active={view} onActive={setView} user={user} accent="employee">
        <div className={`page-header employee-header ${showStoreBrand ? "employee-brand-header" : ""}`}>
            <div>{showStoreBrand ? <div className="employee-brand-title"><strong>{employeeStoreName}</strong><span>{user.isSupporting ? `ĐANG HỖ TRỢ · CỬA HÀNG CHÍNH: ${user.homeStoreName ?? "DORE"}` : "HỆ THỐNG LÀM VIỆC NHÂN VIÊN"}</span></div> : <><span className="breadcrumb">NHÂN VIÊN · {user.employeeCode ?? "NV"}</span><h1>{view}</h1><p>Dữ liệu cá nhân và ca làm việc hiện tại của bạn.</p></>}</div>
            <div className="header-user"><button className="bell" aria-label="Thông báo"><Bell size={20}/><span>2</span></button><div className="avatar"><UserRound size={20}/></div><span><b>{user.name}</b><small>{user.employeeCode ?? "NV"}</small></span></div>
        </div>
        <div className="page-content"><EmployeeView user={user} view={view} shift={shift} orders={orders} onShift={shiftAction} tiktok={tiktok} setTiktok={setTiktok} reloadOrders={loadOrders}/></div>
    </AppShell>;
}
function EmployeeView({ user, view, shift, orders, onShift, tiktok, setTiktok, reloadOrders }: {
    user: User;
    view: string;
    shift: EmployeeShiftState;
    orders: Order[];
    onShift: (action: "start" | "end", closing?: ShiftClosePayload) => void;
    tiktok: boolean;
    setTiktok: (v: boolean) => void;
    reloadOrders: () => void;
}) { if (view === "Trang chủ")
    return <ReferenceEmployeeHome user={user} shift={shift} orders={orders} onShift={onShift} tiktok={tiktok} setTiktok={setTiktok}/>; if (view === "Đơn hàng")
    return <EmployeeOrders user={user} shift={shift} orders={orders} reload={reloadOrders}/>; if (view === "Bảng lương")
    return <ReferenceEmployeePayroll/>; if (view === "Dòng tiền")
    return <ReferenceEmployeeCashflow shift={shift} orders={orders}/>; return <ReferenceEmployeeShiftHistory/>; }
function EmployeeHome({ user, shift, orders, onShift, tiktok, setTiktok }: {
    user: User;
    shift: EmployeeShiftState;
    orders: Order[];
    onShift: (a: "start" | "end", closing?: ShiftClosePayload) => void;
    tiktok: boolean;
    setTiktok: (v: boolean) => void;
}) { const activeOrders = orders.filter(o => o.status === "COMPLETED"); const total = activeOrders.reduce((a, o) => a + o.amount, 0); return <><div className="employee-hero-grid"><section className="attendance-card"><span>ĐIỂM DANH</span><strong>{new Date().toLocaleTimeString("vi-VN")}</strong><button className={shift.active ? "end-shift" : "primary-button"} onClick={() => onShift(shift.active ? "end" : "start")}>{shift.active ? "KẾT CA" : "ĐIỂM DANH VÀO CA"}</button><small>{shift.active ? `Đang làm · ${shift.shiftCode}` : "Bạn chưa bắt đầu ca làm việc"}</small></section><section className="info-card"><span>THÔNG TIN NHÂN VIÊN</span><p>Mã nhân viên <b>NV001</b></p><p>Họ và tên <b>{user.name}</b></p><p>Chức vụ <b>Nhân viên bán hàng</b></p><p>Cửa hàng <b>DORE THỐT NỐT</b></p></section><section className="shift-card"><span>CA LÀM VIỆC HÔM NAY</span><div><b>CA 1</b><strong>07:00 - 12:00</strong></div><small className={shift.active ? "active-text" : "warning-text"}>{shift.active ? "● Đang trong ca" : "Chưa điểm danh"}</small></section></div><FunctionalEmployeeTasks user={user}/><section className="closing-card"><div><h2>Thông tin kết ca</h2><p>Tổng số đơn <b>{activeOrders.length}</b></p><p>Doanh thu theo đơn <b>{money(total)}</b></p></div><label className="tiktok-box"><b>♪ CLIP TIKTOK</b><span>Nếu ca này có làm clip TikTok, vui lòng tick bên dưới.</span><span><input type="checkbox" checked={tiktok} onChange={e => setTiktok(e.target.checked)}/> Ca này có làm clip TikTok (+25.000 đ)</span></label></section></>; }
function EmployeeOrders({ user, shift, orders, reload }: {
    user: User;
    shift: {
        active: boolean;
        shiftCode: string | null;
        startedAt: string | null;
    };
    orders: Order[];
    reload: () => void;
}) {
    const emptyForm = { customerName: "", phone: "", age: "", amount: "", paymentMethod: "CASH" };
    const [search, setSearch] = useState("");
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    const [payment, setPayment] = useState("ALL");
    const [page, setPage] = useState(1);
    const [message, setMessage] = useState("");
    const [success, setSuccess] = useState("");
    const [editing, setEditing] = useState<Order | null>(null);
    const [detail, setDetail] = useState<Order | null>(null);
    const [form, setForm] = useState(emptyForm);
    const formRef = useRef<HTMLDivElement | null>(null);
    const pageSize = 5;
    const filtered = useMemo(() => orders.filter(order => {
        const keyword = search.trim().toLocaleLowerCase("vi-VN");
        const matchesSearch = !keyword || [order.code, order.customer_name ?? "", order.phone ?? ""].some(value => value.toLocaleLowerCase("vi-VN").includes(keyword));
        const createdDate = localDate(order.created_at);
        return matchesSearch && (!fromDate || createdDate >= fromDate) && (!toDate || createdDate <= toDate) && (payment === "ALL" || order.payment_method === payment);
    }), [orders, search, fromDate, toDate, payment]);
    const completed = filtered.filter(order => order.status === "COMPLETED");
    const cash = completed.filter(order => order.payment_method === "CASH").reduce((sum, order) => sum + order.amount, 0);
    const bank = completed.filter(order => order.payment_method === "BANK_TRANSFER").reduce((sum, order) => sum + order.amount, 0);
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const paged = filtered.slice((Math.min(page, pages) - 1) * pageSize, Math.min(page, pages) * pageSize);

    function scrollToForm() {
        setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
    }
    function beginAdd() {
        if (!shift.active)
            return;
        setEditing(null);
        setForm(emptyForm);
        setMessage("");
        setSuccess("");
        scrollToForm();
    }
    function beginEdit(order: Order) {
        if (!shift.active || order.status !== "COMPLETED")
            return;
        setEditing(order);
        setForm({ customerName: order.customer_name ?? "", phone: order.phone ?? "", age: order.age?.toString() ?? "", amount: order.amount.toString(), paymentMethod: order.payment_method });
        setMessage("");
        setSuccess("");
        scrollToForm();
    }
    function resetForm() {
        setEditing(null);
        setForm(emptyForm);
        setMessage("");
    }
    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!shift.active)
            return setMessage("Bạn chưa bắt đầu ca làm việc");
        setMessage("");
        setSuccess("");
        const response = await fetch("/api/orders", {
            method: editing ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(editing ? { id: editing.id, ...form } : form),
        });
        const result = await response.json();
        if (!response.ok)
            return setMessage(result.message ?? "Không thể lưu đơn hàng.");
        setSuccess(editing ? `Đã cập nhật đơn ${editing.code}.` : `Đã tạo đơn ${result.code}.`);
        resetForm();
        reload();
    }
    async function cancel(id: string) {
        if (!confirm("Hủy đơn này? Dữ liệu vẫn được giữ lại để đối soát."))
            return;
        const response = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        const result = await response.json();
        if (!response.ok)
            return setMessage(result.message ?? "Không thể hủy đơn hàng.");
        if (editing?.id === id)
            resetForm();
        setSuccess("Đơn hàng đã được hủy và lưu trong lịch sử.");
        reload();
    }
    function resetFilters() {
        setSearch("");
        setFromDate("");
        setToDate("");
        setPayment("ALL");
        setPage(1);
        reload();
    }
    function exportCsv() {
        const csvCell = (value: string | number | null) => {
            const raw = String(value ?? "");
            const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
            return `"${safe.replaceAll('"', '""')}"`;
        };
        const rows = [
            ["STT", "Mã đơn hàng", "Tên khách hàng", "SĐT", "Tuổi", "NV bán hàng", "Ca", "Giá trị đơn hàng", "Hình thức thanh toán", "Thời gian tạo", "Trạng thái"],
            ...filtered.map((order, index) => [index + 1, order.code, order.customer_name ?? "", order.phone ?? "", order.age ?? "", order.employeeName, shift.shiftCode ?? "", order.amount, order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản", dateTime(order.created_at), order.status === "COMPLETED" ? "Hoàn tất" : "Đã hủy"]),
        ];
        const blob = new Blob(["\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `don-hang-${shift.shiftCode ?? "ca-hien-tai"}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    }
    function updateForm(field: keyof typeof form, value: string) {
        setForm(current => ({ ...current, [field]: value }));
    }

    return <section className="employee-orders-screen">
        {!shift.active && <div className="locked-banner">🔒 <b>Bạn chưa bắt đầu ca làm việc</b><span>Hãy điểm danh tại Trang chủ để mở chức năng thêm đơn hàng.</span></div>}
        <div className="orders-panel">
            <div className="orders-panel-head">
                <div className="orders-heading"><span className="orders-heading-icon"><ShoppingCart size={23}/></span><div><h2>ĐƠN HÀNG</h2><p>Quản lý danh sách đơn hàng</p></div></div>
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
