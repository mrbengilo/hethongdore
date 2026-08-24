"use client";
/* eslint-disable @next/next/no-img-element -- Logo thương hiệu tĩnh do người dùng cung cấp và dùng đồng nhất trong toàn hệ thống. */
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BadgeDollarSign, Banknote, BarChart3, Bell, Calendar, CalendarDays, CalendarRange, CheckCircle2, ClipboardCheck, Clock3, DatabaseBackup, Download, Eye, Gift, History, Home, LayoutDashboard, LogOut, Menu, PackageOpen, Percent, PieChart, Plus, ReceiptText, RefreshCw, Settings, ShoppingBag, ShoppingCart, SlidersHorizontal, Store, Trash2, TrendingUp, UserRound, UsersRound, WalletCards, X, type LucideIcon } from "lucide-react";
import { FunctionalSettings, FunctionalTaskManager } from "./FunctionalModules";
import { ReferenceManagerTransfer } from "./ReferenceManagerModules";
import { ReferenceEmployeeCashflow, ReferenceEmployeePayroll, ReferenceEmployeeRevenue, ReferenceEmployeeShiftHistory } from "./ReferenceEmployeeModules";
import { normalizeEmployeeTiktokAllowance, ReferenceEmployeeHome, resolveEmployeeTiktokAllowanceSnapshot, type EmployeeClosingDraft, type ShiftActionResult } from "./ReferenceEmployeeHome";
import { ReferenceStoreModule } from "./ReferenceStoreModules";
import { FixedCostManagement } from "./FixedCostManagement";
import { StoreScheduleManagement } from "./StoreSchedulingModules";
import { ManagerProfitSharingClosing, StoreFinancialReport } from "./FinancialReports";
import { ManagerBusinessReport, ManagerCashflow } from "./ManagerFinanceViews";
import { StoreInventoryManagement } from "./InventoryManagement";
import { StoreEmployeeManagement } from "./EmployeeManagement";
import { StoreOperatingExpense } from "./StoreOperatingExpense";
import { MonthEndExpensePanel } from "./MonthEndExpensePanel";
import { StoreShiftCashflow } from "./StoreCashflow";
import { StoreOrdersManagement } from "./StoreOrdersManagement";
import { SuperAdminReset } from "./SuperAdminReset";
import { AttendancePolicySettings } from "./AttendancePolicySettings";
import { SuperAdminEmployeeDirectory } from "./SuperAdminEmployeeDirectory";
import { useAccessibleModal } from "./useAccessibleModal";
import { formatMonthVn, formatVndInput, parseVndInput } from "../lib/format";
import { readNavigationSnapshot, writeNavigationSnapshot, type NavigationSnapshot } from "../lib/navigation-state";
import type { ClockInLocation } from "../lib/attendance-location";
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
    employeeTiktokAllowance?: number | null;
    activeTransferId: string | null;
    isSupporting: boolean;
    shiftActive: number;
    currentShift: string | null;
    shiftStartedAt: string | null;
    currentShiftName: string | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    isSuperAdmin: number;
};
type EmployeeShiftState = {
    active: boolean;
    shiftCode: string | null;
    startedAt: string | null;
    shiftName: string | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    scheduledEndAt: string | null;
    attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
    attendanceDeltaMinutes: number | null;
};
type Store = {
    id: string;
    name: string;
    address: string;
    revenue: number;
    expense: number;
    profit: number;
    status: string;
    period?: string;
    profitBeforePerformanceRewards?: number;
    expenseBreakdown?: Record<string, number>;
    previous?: { period: string; revenue: number; expense: number; profit: number } | null;
    employeeCount?: number;
    lifetimeOrderCount?: number;
    salaryAdvanceCount?: number;
    canDelete?: boolean;
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
type ManagerNotification = {
    id: string;
    storeId: string;
    storeName: string | null;
    type: string;
    entityType: string;
    entityId: string;
    title: string;
    message: string;
    dataJson: string;
    readAt: string | null;
    createdAt: string;
};
type ShiftClosePayload = {
    tasksCompleted: boolean;
    expenseAmount: number;
    expenseNote: string;
    cashRevenue: number;
    transferRevenue: number;
    earlyEndConfirmed?: boolean;
};
type ShiftStartExpectation = {
    expectedStart: {
        candidateId: string;
        selectionKind: "CURRENT" | "UPCOMING";
        shiftName: string;
        scheduledStart: string;
        scheduledEnd: string;
        workDate: string;
        attendanceGraceMinutes?: number;
        policyVersion?: number;
    };
    clockInLocation: ClockInLocation;
};
type ShiftActionPayload = ShiftClosePayload | ShiftStartExpectation;
const EMPTY_EMPLOYEE_CLOSING_DRAFT: EmployeeClosingDraft = {
    expenseAmount: "",
    expenseNote: "",
    cashRevenue: "",
    transferRevenue: "",
};
const money = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value)) + " đồng";
const comparisonNote = (current: number, previous: number) => {
    if (previous === 0) return current === 0 ? "→ 0,00% so với kỳ trước" : "Chưa có số liệu kỳ trước";
    const change = (current - previous) / Math.abs(previous) * 100;
    const percent = Math.abs(change).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${change > 0 ? "↑" : change < 0 ? "↓" : "→"} ${percent}% so với kỳ trước`;
};
const dateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }).format(new Date(value));
const localDate = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
const todayLocalDate = () => localDate(new Date().toISOString());
function exportCsvFile(filename: string, rows: Array<Array<string | number | null>>) {
    const cell = (value: string | number | null) => { const raw = String(value ?? ""); const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; };
    const blob = new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
const managerMenu = ["Tổng quan", "Cửa hàng", "Giao việc", "Dòng tiền", "Lương thưởng quản lý", "Báo cáo", "Chia lợi nhuận", "Điều chuyển nhân sự", "Cài đặt"];
const superAdminManagerMenu = [...managerMenu.slice(0, -1), "Quản Lý Nhân Viên", "Cài Đặt Chính Sách", managerMenu.at(-1) ?? "Cài đặt"];
const storeMenu = ["Tổng quan", "Lịch phân ca", "Nhân viên", "Nhập hàng", "Chi phí cố định", "Chấm công", "Lương thưởng", "Đơn hàng", "Dòng tiền", "Chi phí cuối kỳ", "Báo cáo", "Cài đặt"];
const superAdminStoreMenu = [...storeMenu.slice(0, -1), "Reset Dữ Liệu", storeMenu.at(-1) ?? "Cài đặt"];
const employeeMenu = ["Trang chủ", "Đơn hàng", "Doanh thu", "Bảng lương", "Dòng tiền", "Lịch sử ca làm"];
const navigationMenus = { manager: managerMenu, store: storeMenu, employee: employeeMenu };
const menuIcons: Record<string, LucideIcon> = { "Tổng quan": LayoutDashboard, "Cửa hàng": Store, "Giao việc": ClipboardCheck, "Dòng tiền": WalletCards, "Lương thưởng quản lý": BadgeDollarSign, "Báo cáo": BarChart3, "Điều chuyển nhân sự": UsersRound, "Chia lợi nhuận": PieChart, "Cài đặt": Settings, "Cài Đặt Chính Sách": SlidersHorizontal, "Ca làm việc": CalendarDays, "Lịch phân ca": CalendarRange, "Nhân viên": UserRound, "Nhập hàng": PackageOpen, "Chi phí cố định": ReceiptText, "Chi phí cuối kỳ": ReceiptText, "Chấm công": Clock3, "Lương thưởng": BadgeDollarSign, "Đơn hàng": ShoppingCart, "Reset Dữ Liệu": DatabaseBackup, "Trang chủ": Home, "Doanh thu": TrendingUp, "Bảng lương": BadgeDollarSign, "Lịch sử ca làm": History };
const statIcons: Record<string, LucideIcon> = { "₫": Banknote, "▤": ReceiptText, "▥": BarChart3, "%": Percent, "♕": BadgeDollarSign, "✦": Gift, "✓": CheckCircle2, "▧": ShoppingBag, "↓": ReceiptText, "↗": TrendingUp };
menuIcons["Quản Lý Nhân Viên"] = UsersRound;
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
        return <div className="app-loading"><div className="pulse-logo"><img className="brand-logo-image" src="/logo.jpg" alt="Logo DORE Quản Lý" width={1254} height={1254}/></div><p>Đang tải dữ liệu vận hành...</p></div>;
    return expectedRole === "MANAGER" ? <ManagerPortal user={user}/> : <EmployeePortal user={user} onUser={setUser}/>;
}
function AppShell({ brand, subtitle, menu, active, onActive, user, children, onBack, shellAction, accent = "dark" }: {
    brand: string;
    subtitle: string;
    menu: string[];
    active: string;
    onActive: (item: string) => void;
    user: User;
    children: ReactNode;
    onBack?: () => void;
    shellAction?: ReactNode;
    accent?: "dark" | "light" | "employee";
}) {
    const [open, setOpen] = useState(false);
    async function logout() { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/"; }
    return <div className={`app-shell ${accent}`}>
    <aside id="app-navigation-sidebar" className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-brand"><div className="mini-mark"><img className="brand-logo-image" src="/logo.jpg" alt="Logo DORE Quản Lý" width={1254} height={1254}/></div><div><strong>{brand}</strong><span>{subtitle}</span></div><button className="close-menu" onClick={() => setOpen(false)} aria-label="Đóng menu"><X size={21}/></button></div>
      {onBack && <button className="back-system" onClick={onBack}><ArrowLeft size={17}/> Quay về trang quản lý chính</button>}
      <nav>{menu.map((item) => { const Icon = menuIcons[item] ?? LayoutDashboard; return <button key={item} className={active === item ? "active" : ""} onClick={() => { onActive(item); setOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}><i><Icon size={19} strokeWidth={1.8}/></i>{item}</button>; })}</nav>
      <div className="sidebar-user"><div className="avatar"><UserRound size={20}/></div><div><b>{user.name}</b><span>{user.role === "MANAGER" ? Number(user.isSuperAdmin) === 1 ? "Quản trị cấp cao" : "Quản lý hệ thống" : `${user.employeeCode ?? "NV"} · ${user.employeePosition ?? "Nhân viên"}`}</span></div></div>
      <button className="logout-button" onClick={logout}><LogOut size={18}/> Đăng xuất</button>
    </aside>
    <section className={`main-area ${shellAction ? "has-shell-action" : ""}`}><header className="mobile-header"><button onClick={() => setOpen(true)} aria-label="Mở menu" aria-controls="app-navigation-sidebar" aria-expanded={open}><Menu size={23}/></button><b>{brand}</b>{shellAction ? <span className="mobile-action-placeholder" aria-hidden="true"/> : <Bell size={19}/>}</header>{shellAction && <div className="shell-notification-action">{shellAction}</div>}{children}</section>
    {open && <button className="menu-overlay" aria-label="Đóng menu" onClick={() => setOpen(false)}/>} 
  </div>;
}
function ManagerPortal({ user }: {
    user: User;
}) {
    const navigationIdentity = useMemo(() => ({ userId: user.id, role: "MANAGER" as const }), [user.id]);
    const activeManagerMenu = useMemo(() => Number(user.isSuperAdmin) === 1 ? superAdminManagerMenu : managerMenu, [user.isSuperAdmin]);
    const activeStoreMenu = useMemo(() => Number(user.isSuperAdmin) === 1 ? superAdminStoreMenu : storeMenu, [user.isSuperAdmin]);
    const managerNavigationMenus = useMemo(() => ({ manager: activeManagerMenu, store: activeStoreMenu, employee: employeeMenu }), [activeManagerMenu, activeStoreMenu]);
    const [navigationReady, setNavigationReady] = useState(false);
    const [view, setView] = useState(managerMenu[0]);
    const [storeView, setStoreView] = useState(storeMenu[0]);
    const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
    const [stores, setStores] = useState<Store[]>([]);
    const [loading, setLoading] = useState(true);
    const [storeListResolved, setStoreListResolved] = useState(false);
    const [storeLoadError, setStoreLoadError] = useState("");
    const [period, setPeriod] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()));
    const [notifications, setNotifications] = useState<ManagerNotification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [notificationError, setNotificationError] = useState("");
    const [clearingNotifications, setClearingNotifications] = useState(false);
    const [focusedOrderId, setFocusedOrderId] = useState<string | null>(null);
    const [focusedOrderRequest, setFocusedOrderRequest] = useState(0);
    const loadRequest = useRef(0);
    const notificationRequest = useRef(0);
    const notificationMutationRequest = useRef(0);
    const selectedNotificationScope = useRef<string | null>(null);
    useEffect(() => { selectedNotificationScope.current = selectedStoreId; }, [selectedStoreId]);
    const loadNotificationsForStore = useCallback(async (scopeStoreId: string | null) => {
        const requestId = ++notificationRequest.current;
        try {
            const notificationUrl = scopeStoreId ? `/api/notifications?storeId=${encodeURIComponent(scopeStoreId)}` : "/api/notifications";
            const response = await fetch(notificationUrl, { cache: "no-store" });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !Array.isArray(data.notifications)) throw new Error(data.message ?? "Không thể tải thông báo.");
            if (requestId !== notificationRequest.current) return;
            setNotifications(data.notifications);
            setUnreadCount(Number(data.unreadCount ?? 0));
            setNotificationError("");
        } catch (error) {
            if (requestId !== notificationRequest.current) return;
            setNotificationError(error instanceof Error ? error.message : "Không thể tải thông báo.");
        }
    }, []);
    const loadNotifications = useCallback(() => loadNotificationsForStore(selectedStoreId), [loadNotificationsForStore, selectedStoreId]);
    const loadStores = useCallback(async () => {
        const requestId = ++loadRequest.current;
        setLoading(true);
        setStoreLoadError("");
        try {
            const response = await fetch(`/api/stores?period=${encodeURIComponent(period)}`, { cache: "no-store" });
            const data = await response.json();
            if (!response.ok || !Array.isArray(data.stores)) throw new Error(data.error ?? "Không thể tải danh sách cửa hàng.");
            if (requestId !== loadRequest.current) return;
            setStores(data.stores);
            setStoreListResolved(true);
        } catch (error) {
            if (requestId !== loadRequest.current) return;
            setStoreLoadError(error instanceof Error ? error.message : "Không thể tải danh sách cửa hàng.");
        } finally {
            if (requestId === loadRequest.current) setLoading(false);
        }
    }, [period]);
    useEffect(() => {
        void loadNotifications();
        const refresh = () => { if (document.visibilityState === "visible") void loadNotifications(); };
        const interval = window.setInterval(refresh, 20_000);
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [loadNotifications]);
    useEffect(() => { if (navigationReady) void loadStores(); }, [loadStores, navigationReady]);
    const selectedStore = useMemo(() => stores.find((store) => store.id === selectedStoreId) ?? null, [selectedStoreId, stores]);
    useEffect(() => {
        const restored = readNavigationSnapshot(navigationIdentity, managerNavigationMenus);
        setView(restored.managerView);
        setStoreView(restored.storeView);
        setSelectedStoreId(restored.storeId);
        if (restored.managerPeriod) setPeriod(restored.managerPeriod);
        setNavigationReady(true);
    }, [managerNavigationMenus, navigationIdentity]);
    useEffect(() => {
        if (!navigationReady) return;
        writeNavigationSnapshot(navigationIdentity, managerNavigationMenus, {
            managerView: view,
            storeId: selectedStoreId,
            storeView,
            employeeView: employeeMenu[0],
            managerPeriod: period,
        });
    }, [managerNavigationMenus, navigationIdentity, navigationReady, period, selectedStoreId, storeView, view]);
    useEffect(() => {
        if (navigationReady && storeListResolved && !loading && !storeLoadError && selectedStoreId && !selectedStore) setSelectedStoreId(null);
    }, [loading, navigationReady, selectedStore, selectedStoreId, storeListResolved, storeLoadError]);
    function returnToSystemOverview() {
        const overview: NavigationSnapshot = {
            managerView: managerMenu[0],
            storeId: null,
            storeView: storeMenu[0],
            employeeView: employeeMenu[0],
            managerPeriod: period,
        };
        writeNavigationSnapshot(navigationIdentity, managerNavigationMenus, overview);
        setView(overview.managerView);
        setStoreView(overview.storeView);
        setSelectedStoreId(null);
        setFocusedOrderId(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
    function openNotification(notification: ManagerNotification) {
        if (!notification.readAt) {
            const nextNotificationScope = notification.type === "NEW_ORDER" && notification.entityType === "ORDER"
                ? notification.storeId
                : selectedStoreId;
            notificationRequest.current += 1;
            setNotifications((current) => current.filter((item) => item.id !== notification.id));
            setUnreadCount((current) => Math.max(0, current - 1));
            void fetch("/api/notifications", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: notification.id, ...(nextNotificationScope ? { storeId: nextNotificationScope } : {}) }),
            }).then(
                () => loadNotificationsForStore(nextNotificationScope),
                () => loadNotificationsForStore(nextNotificationScope),
            );
        }
        if (notification.type === "NEW_ORDER" && notification.entityType === "ORDER") {
            setFocusedOrderId(notification.entityId);
            setFocusedOrderRequest((current) => current + 1);
            setStoreView("Đơn hàng");
            setSelectedStoreId(notification.storeId);
            window.scrollTo({ top: 0, behavior: "auto" });
        }
    }
    const clearNotifications = useCallback(async () => {
        if (clearingNotifications || unreadCount === 0) return;
        const clearedScope = selectedStoreId;
        const requestId = ++notificationMutationRequest.current;
        notificationRequest.current += 1;
        const previous = { notifications, unreadCount };
        setClearingNotifications(true);
        setNotifications([]);
        setUnreadCount(0);
        setNotificationError("");
        try {
            const query = clearedScope ? `?storeId=${encodeURIComponent(clearedScope)}` : "";
            const response = await fetch(`/api/notifications${query}`, { method: "DELETE" });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message ?? "Không thể xóa tất cả thông báo.");
            if (requestId !== notificationMutationRequest.current) return;
            notificationRequest.current += 1;
            if (selectedNotificationScope.current === clearedScope) {
                setNotifications([]);
                setUnreadCount(Number(data.unreadCount ?? 0));
            } else {
                void loadNotificationsForStore(selectedNotificationScope.current);
            }
        } catch (error) {
            if (requestId !== notificationMutationRequest.current) return;
            notificationRequest.current += 1;
            if (selectedNotificationScope.current === clearedScope) {
                setNotifications(previous.notifications);
                setUnreadCount(previous.unreadCount);
                setNotificationError(error instanceof Error ? error.message : "Không thể xóa tất cả thông báo.");
            } else {
                void loadNotificationsForStore(selectedNotificationScope.current);
            }
        } finally {
            if (requestId === notificationMutationRequest.current) setClearingNotifications(false);
        }
    }, [clearingNotifications, loadNotificationsForStore, notifications, selectedStoreId, unreadCount]);
    const notificationCenter = <ManagerNotificationCenter notifications={notifications} unreadCount={unreadCount} error={notificationError} clearing={clearingNotifications} onClear={clearNotifications} onRefresh={loadNotifications} onOpen={openNotification}/>;
    if (!navigationReady || (selectedStoreId && loading && !selectedStore))
        return <div className="app-loading"><div className="pulse-logo"><img className="brand-logo-image" src="/logo.jpg" alt="Logo DORE Quản Lý" width={1254} height={1254}/></div><p>Đang mở lại màn hình gần nhất...</p></div>;
    if (selectedStoreId && !selectedStore && storeLoadError)
        return <div className="app-loading"><div className="pulse-logo"><img className="brand-logo-image" src="/logo.jpg" alt="Logo DORE Quản Lý" width={1254} height={1254}/></div><p>{storeLoadError}</p><button type="button" className="primary-button" onClick={() => void loadStores()}>Thử tải lại</button></div>;
    if (selectedStore)
        return <AppShell brand={selectedStore.name} subtitle={Number(user.isSuperAdmin) === 1 ? "Quản trị cấp cao" : "Quản lý cửa hàng"} menu={activeStoreMenu} active={storeView} onActive={(item) => { setStoreView(item); if (item !== "Đơn hàng") setFocusedOrderId(null); }} user={user} onBack={returnToSystemOverview} shellAction={notificationCenter} accent="light"><StoreWorkspace store={selectedStore} view={storeView} period={period} onPeriodChange={setPeriod} onReload={loadStores} focusedOrderId={focusedOrderId} focusedOrderRequest={focusedOrderRequest} isSuperAdmin={Number(user.isSuperAdmin) === 1}/></AppShell>;
    const financeOwnsHeader = view === "Báo cáo" || view === "Dòng tiền" || view === "Quản Lý Nhân Viên" || view === "Cài Đặt Chính Sách";
    return <AppShell brand="DORE" subtitle="Quản lý toàn hệ thống" menu={activeManagerMenu} active={view} onActive={setView} user={user} shellAction={notificationCenter}>{financeOwnsHeader ? null : <ManagerHeader view={view} period={period} onPeriodChange={setPeriod}/>}<ManagerView view={view} stores={stores} loading={loading} reload={loadStores} openStore={(store) => { setFocusedOrderId(null); setStoreView(storeMenu[0]); setSelectedStoreId(store.id); }} isSuperAdmin={Number(user.isSuperAdmin) === 1}/></AppShell>;
}
function ManagerNotificationCenter({ notifications, unreadCount, error, clearing, onClear, onRefresh, onOpen }: {
    notifications: ManagerNotification[];
    unreadCount: number;
    error: string;
    clearing: boolean;
    onClear: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onOpen: (notification: ManagerNotification) => void;
}) {
    const [open, setOpen] = useState(false);
    const centerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent) => {
            if (!centerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", closeOutside);
        document.addEventListener("keydown", closeEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOutside);
            document.removeEventListener("keydown", closeEscape);
        };
    }, [open]);
    return <div className="manager-notification-center" ref={centerRef}>
        <button type="button" className="bell manager-notification-button" aria-label={`Thông báo đơn hàng${unreadCount ? `, ${unreadCount} chưa đọc` : ""}`} aria-expanded={open} aria-controls="manager-notification-panel" onClick={() => setOpen((current) => !current)}>
            <Bell size={20}/>{unreadCount > 0 && <span className="notification-count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
        {open && <section className="manager-notification-panel" id="manager-notification-panel" aria-label="Thông báo mới">
            <div className="notification-panel-head"><div><h2>Thông báo</h2><p>{unreadCount ? `${unreadCount} thông báo chưa đọc` : "Đã đọc tất cả thông báo"}</p></div><div className="notification-panel-actions"><button type="button" className="notification-clear-button" aria-label="Xóa tất cả thông báo chưa đọc" title="Xóa tất cả thông báo" disabled={clearing || unreadCount === 0} onClick={() => void onClear()}>{clearing ? <RefreshCw className="notification-spin" size={17}/> : <Trash2 size={17}/>}</button><button type="button" aria-label="Tải lại thông báo" title="Tải lại thông báo" disabled={clearing} onClick={() => void onRefresh()}><RefreshCw size={17}/></button></div></div>
            {error && <div className="notification-error" role="status">{error}<button type="button" onClick={() => void onRefresh()}>Thử lại</button></div>}
            <div className="notification-list" aria-busy={clearing}>{notifications.length === 0 && !error ? <p className="notification-empty">{clearing ? "Đang xóa thông báo…" : "Không còn thông báo chưa đọc."}</p> : notifications.map((notification) => <button type="button" key={notification.id} className={`notification-item ${notification.readAt ? "" : "unread"}`} onClick={() => { setOpen(false); onOpen(notification); }}>
                <span className="notification-item-icon"><ShoppingCart size={17}/></span><span><b>{notification.title}</b><small>{notification.storeName ?? "Cửa hàng"} · {dateTime(notification.createdAt)}</small><em>{notification.message}</em></span>{!notification.readAt && <i aria-label="Chưa đọc"/>}
            </button>)}</div>
        </section>}
    </div>;
}
function showMonthPicker(input: HTMLInputElement) {
    if (typeof input.showPicker !== "function") return false;
    try {
        input.showPicker();
        return true;
    } catch {
        return false;
    }
}
function MonthPickerControl({ value, onChange, ariaLabel, prefix }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
    prefix?: string;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const monthLabel = formatMonthVn(value);
    return <label className="date-control month-picker-control">
        <Calendar size={18} aria-hidden="true"/>
        <span aria-hidden="true">{prefix ? `${prefix}${monthLabel.replace(/^Tháng\s+/, "")}` : monthLabel}</span>
        <input
            ref={inputRef}
            className="month-picker-native"
            aria-label={ariaLabel}
            type="month"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onClick={(event) => showMonthPicker(event.currentTarget)}
            onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                if (showMonthPicker(inputRef.current ?? event.currentTarget)) event.preventDefault();
            }}
        />
    </label>;
}
function ManagerHeader({ view, period, onPeriodChange }: {
    view: string;
    period: string;
    onPeriodChange: (period: string) => void;
}) {
    const subtitles: Record<string, string> = {
        "Tổng quan": "Xin chào, Quản trị viên! Đây là tổng quan hoạt động của tất cả cửa hàng.",
        "Cửa hàng": "Quản lý thông tin cửa hàng, nhân sự và kết quả hoạt động của từng cửa hàng.",
        "Giao việc": "Danh sách công việc cho từng ca làm – giúp nhân viên dễ dàng theo dõi và thực hiện.",
        "Dòng tiền": "Theo dõi doanh thu, chi phí và lợi nhuận của từng cửa hàng.",
        "Lương thưởng quản lý": "Xem lương quản lý và thưởng theo số liệu tài chính đã ghi nhận của từng cửa hàng.",
        "Báo cáo": "Theo dõi và phân tích kết quả hoạt động của hệ thống.",
        "Chia lợi nhuận": "Phân chia lợi nhuận sau cùng đã khóa cho hai thành viên theo tỷ lệ cố định.",
        "Điều chuyển nhân sự": "Quản lý nhân viên hỗ trợ giữa các cửa hàng theo thời gian và ca làm việc.",
        "Cài Đặt Chính Sách": "Thiết lập quy tắc vận hành dùng chung cho toàn hệ thống.",
        "Quản Lý Nhân Viên": "Xem và quản lý hồ sơ, tài khoản nhân viên của tất cả cửa hàng.",
        "Cài đặt": "Quản lý thông tin tài khoản và các thiết lập hệ thống.",
    };
    return <div className="page-header"><div><h1>{view}</h1><p>{subtitles[view]}</p></div><div className="header-actions"><MonthPickerControl ariaLabel="Tháng báo cáo" value={period} onChange={onPeriodChange}/></div></div>;
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
function ManagerView({ view, stores, loading, reload, openStore, isSuperAdmin }: {
    view: string;
    stores: Store[];
    loading: boolean;
    reload: () => Promise<void>;
    openStore: (store: Store) => void;
    isSuperAdmin: boolean;
}) {
    const totals = useMemo(() => stores.reduce((sum, store) => ({ revenue: sum.revenue + store.revenue, expense: sum.expense + store.expense, profit: sum.profit + store.profit }), { revenue: 0, expense: 0, profit: 0 }), [stores]);
    if (view === "Tổng quan")
        return <DashboardOverview stores={stores} totals={totals} loading={loading} openStore={openStore}/>;
    if (view === "Cửa hàng")
        return <StoresView stores={stores} totals={totals} reload={reload} openStore={openStore} isSuperAdmin={isSuperAdmin}/>;
    if (view === "Giao việc")
        return <FunctionalTaskManager stores={stores}/>;
    if (view === "Dòng tiền")
        return <ManagerCashflow/>;
    if (view === "Lương thưởng quản lý")
        return <ManagerPayroll/>;
    if (view === "Báo cáo")
        return <ManagerBusinessReport/>;
    if (view === "Điều chuyển nhân sự")
        return <ReferenceManagerTransfer stores={stores}/>;
    if (view === "Chia lợi nhuận")
        return <ManagerProfitSharingClosing/>;
    if (view === "Quản Lý Nhân Viên" && isSuperAdmin)
        return <SuperAdminEmployeeDirectory/>;
    if (view === "Cài Đặt Chính Sách" && isSuperAdmin)
        return <AttendancePolicySettings/>;
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
    const storesWithComparison = stores.filter((store) => store.previous);
    const hasCompleteComparison = stores.length > 0 && storesWithComparison.length === stores.length;
    const previousTotals = storesWithComparison.reduce((sum, store) => ({
        revenue: sum.revenue + Number(store.previous?.revenue ?? 0),
        expense: sum.expense + Number(store.previous?.expense ?? 0),
        profit: sum.profit + Number(store.previous?.profit ?? 0),
    }), { revenue: 0, expense: 0, profit: 0 });
    const note = (key: keyof typeof totals) => hasCompleteComparison
        ? comparisonNote(totals[key], previousTotals[key])
        : "Chưa đủ số liệu tháng trước";
    return <div className="page-content">
    <div className="stats-grid three"><StatCard label="TỔNG DOANH THU" value={money(totals.revenue)} note={note("revenue")} icon="₫"/><StatCard label="TỔNG CHI PHÍ" value={money(totals.expense)} note={note("expense")} tone="orange" icon="▤"/><StatCard label="TỔNG LỢI NHUẬN" value={money(totals.profit)} note={note("profit")} tone="blue" icon="▥"/></div>
    <div className="section-title"><div><h2>Quản lý cửa hàng</h2><p>Chọn cửa hàng để xem và quản lý chi tiết.</p></div><span>{stores.filter((store) => store.status === "ACTIVE").length} cửa hàng đang hoạt động</span></div>
    <div className="store-grid">{loading ? Array.from({ length: 5 }, (_, i) => <div className="store-card loading-card" key={i}/>) : stores.map((store, index) => <article className={`store-card ${store.status === "INACTIVE" ? "inactive" : ""}`} key={store.id}><div className={`store-cover cover-${index % 5}`}><div className="shop-sign"><img className="store-logo-image" src="/logo.jpg" alt={`Logo ${store.name}`} width={1254} height={1254}/><span>{store.name}</span></div><div className="shop-front"><i /><i /><i /></div></div><div className="store-card-body"><div className={`store-status ${store.status === "INACTIVE" ? "inactive" : ""}`}>● {store.status === "INACTIVE" ? "Ngưng hoạt động" : "Đang hoạt động"}</div><h3 className="store-card-title">{store.name}</h3><p>⌖ {store.address}</p><div className="store-numbers"><span>Doanh thu tháng <b>{money(store.revenue)}</b></span><span>Lợi nhuận <b>{money(store.profit)}</b></span></div><button className="store-open" onClick={() => openStore(store)}>Xem cửa hàng <span>→</span></button></div></article>)}</div>
  </div>;
}
function StoresView({ stores, totals, reload, openStore, isSuperAdmin }: {
    stores: Store[];
    totals: {
        revenue: number;
        expense: number;
        profit: number;
    };
    reload: () => Promise<void>;
    openStore: (store: Store) => void;
    isSuperAdmin: boolean;
}) {
    const [showForm, setShowForm] = useState(false);
    const [editing, setEditing] = useState<Store | null>(null);
    const [name, setName] = useState("");
    const [address, setAddress] = useState("");
    const [status, setStatus] = useState<"ACTIVE" | "INACTIVE">("ACTIVE");
    const [message, setMessage] = useState("");
    const [query, setQuery] = useState("");
    const [deleteCandidate, setDeleteCandidate] = useState<Store | null>(null);
    const [deletingStoreId, setDeletingStoreId] = useState<string | null>(null);
    const [deleteMessage, setDeleteMessage] = useState("");
    const deleteRootRef = useRef<HTMLDivElement>(null);
    const deleteDialogRef = useRef<HTMLFormElement>(null);
    const deleteCancelRef = useRef<HTMLButtonElement>(null);
    const deleteTriggerRef = useRef<HTMLButtonElement>(null);
    const closeDeleteDialog = () => {
      if (deletingStoreId) return;
      setDeleteCandidate(null);
      setDeleteMessage("");
    };
    useAccessibleModal({
      open: deleteCandidate !== null,
      rootRef: deleteRootRef,
      dialogRef: deleteDialogRef,
      initialFocusRef: deleteCancelRef,
      returnFocusRef: deleteTriggerRef,
      onDismiss: closeDeleteDialog,
      dismissDisabled: deletingStoreId !== null,
    });
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
    function beginDelete(store: Store, trigger: HTMLButtonElement) {
      deleteTriggerRef.current = trigger;
      setDeleteCandidate(store);
      setDeleteMessage("");
    }
    async function deleteStore(event: FormEvent) {
      event.preventDefault();
      if (!deleteCandidate || deletingStoreId) return;
      setDeletingStoreId(deleteCandidate.id);
      setDeleteMessage("");
      try {
        const response = await fetch("/api/stores", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: deleteCandidate.id }),
        });
        const data = await response.json().catch(() => ({})) as { message?: string };
        if (!response.ok) {
          setDeleteMessage(data.message ?? "Không thể xóa cửa hàng.");
          return;
        }
        setDeleteCandidate(null);
        await reload();
      } catch {
        setDeleteMessage("Không thể kết nối để xóa cửa hàng. Vui lòng thử lại.");
      } finally {
        setDeletingStoreId(null);
      }
    }
    const activeCount = stores.filter((store) => store.status === "ACTIVE").length;
    const totalEmployees = stores.reduce((sum, store) => sum + Number(store.employeeCount ?? 0), 0);
    return <div className="page-content">
      <div className="store-admin-metrics"><StatCard label="TỔNG SỐ CỬA HÀNG" value={String(stores.length)} note={`${activeCount} đang hoạt động`} icon="▧"/><StatCard label="TỔNG NHÂN VIÊN" value={String(totalEmployees)} note="toàn hệ thống" icon="✓"/><StatCard label="TỔNG DOANH THU" value={money(totals.revenue)} note="trong khoảng thời gian chọn" icon="↗"/><StatCard label="TỔNG CHI PHÍ" value={money(totals.expense)} note="trong khoảng thời gian chọn" tone="orange" icon="▤"/><StatCard label="TỔNG LỢI NHUẬN" value={money(totals.profit)} note="trong khoảng thời gian chọn" tone="blue" icon="▥"/></div>
      <div className="toolbar"><div className="stats-inline"><b>{stores.length}</b> cửa hàng · <b>{money(totals.revenue)}</b> doanh thu</div><div className="store-toolbar-actions"><input aria-label="Tìm kiếm cửa hàng" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm kiếm cửa hàng..."/><button className="primary-button" onClick={() => beginEdit()}>＋ Thêm cửa hàng</button></div></div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus lets users scroll the wide store table. */}
      <div className="table-card"><div className="table-head"><h2>Danh sách cửa hàng</h2></div><div className="data-table-wrap" role="region" tabIndex={0} aria-label="Danh sách cửa hàng, cuộn ngang để xem đầy đủ"><table className="data-table"><thead><tr><th>#</th><th>Cửa hàng</th><th>Địa chỉ</th><th>Nhân viên</th><th>Doanh thu</th><th>Chi phí</th><th>Lợi nhuận</th>{isSuperAdmin ? <th>Đơn hàng đã phát sinh</th> : null}<th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{filteredStores.map((store, index) => {
        const hasOrders = Number(store.lifetimeOrderCount ?? 0) > 0;
        const hasSalaryAdvances = Number(store.salaryAdvanceCount ?? 0) > 0;
        const cannotDelete = store.canDelete === false || hasOrders || hasSalaryAdvances;
        const deleteReason = hasOrders
          ? "Không thể xóa vì cửa hàng đã phát sinh đơn hàng"
          : hasSalaryAdvances
            ? "Không thể xóa vì cửa hàng còn lịch sử ứng lương cần đối soát"
            : `Xóa ${store.name}`;
        return <tr key={store.id}><td>{index + 1}</td><td><button className="table-link" onClick={() => openStore(store)}>{store.name}</button></td><td>{store.address}</td><td><b>{store.employeeCount ?? 0}</b> nhân viên</td><td className="money-green">{money(store.revenue)}</td><td className="money-orange">{money(store.expense)}</td><td className="money-blue">{money(store.profit)}</td>{isSuperAdmin ? <td><b>{Number(store.lifetimeOrderCount ?? 0)}</b> đơn</td> : null}<td><span className={`status-pill ${store.status === "INACTIVE" ? "inactive" : ""}`}>{store.status === "INACTIVE" ? "Ngưng hoạt động" : "Đang hoạt động"}</span></td><td><div className="row-actions"><button onClick={() => beginEdit(store)}>Sửa</button><button className={store.status === "ACTIVE" ? "danger" : ""} onClick={() => toggleStatus(store)}>{store.status === "ACTIVE" ? "Ngưng hoạt động" : "Kích hoạt lại"}</button>{isSuperAdmin ? <button className="danger store-delete-button" disabled={cannotDelete} title={deleteReason} onClick={(event) => beginDelete(store, event.currentTarget)}>Xóa</button> : null}</div></td></tr>;
      })}</tbody></table></div></div>
      {showForm ? <div className="modal-backdrop"><form className="modal" onSubmit={save}><div className="modal-title"><h2>{editing ? "Cập nhật cửa hàng" : "Thêm cửa hàng mới"}</h2><button type="button" aria-label="Đóng" onClick={() => setShowForm(false)}>×</button></div><label>Tên cửa hàng<input value={name} onChange={e => setName(e.target.value)} required/></label><label>Địa chỉ<input value={address} onChange={e => setAddress(e.target.value)} required/></label>{editing ? <label>Trạng thái<select value={status} onChange={(event) => setStatus(event.target.value as "ACTIVE" | "INACTIVE")}><option value="ACTIVE">Đang hoạt động</option><option value="INACTIVE">Ngưng hoạt động</option></select></label> : null}<div className="info-box">{editing ? "Khi ngưng hoạt động, cửa hàng chỉ được xem dữ liệu lịch sử và không thể phát sinh thao tác mới." : "Hệ thống sẽ tự tạo ca làm, danh mục chi phí, lương thưởng, nhân viên, đơn hàng, dòng tiền và báo cáo cho cửa hàng mới."}</div>{message ? <div className="form-message">{message}</div> : null}<div className="modal-actions"><button type="button" onClick={() => setShowForm(false)}>Hủy</button><button type="submit" className="primary-button">{editing ? "Lưu thay đổi" : "Tạo cửa hàng"}</button></div></form></div> : null}
      {deleteCandidate ? <div className="modal-backdrop" ref={deleteRootRef}><form className="modal store-delete-modal" ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="store-delete-title" aria-describedby="store-delete-description" tabIndex={-1} onSubmit={deleteStore}><div className="modal-title"><div><h2 id="store-delete-title">Xóa cửa hàng khỏi hệ thống?</h2><p>{deleteCandidate.name}</p></div><button type="button" aria-label="Đóng hộp thoại xóa cửa hàng" disabled={deletingStoreId !== null} onClick={closeDeleteDialog}>×</button></div><div className="store-delete-warning" id="store-delete-description"><b>Chỉ xóa được cửa hàng chưa từng phát sinh đơn hàng và không còn khoản ứng lương cần đối soát.</b><p>Cửa hàng sẽ biến mất khỏi danh sách và các tài khoản liên quan bị ngắt truy cập ngay. Dữ liệu phụ được giữ nội bộ để không làm mất lịch sử hoặc tạo bản ghi mồ côi.</p></div>{deleteMessage ? <div className="form-message" role="alert">{deleteMessage}</div> : null}<div className="modal-actions"><button ref={deleteCancelRef} type="button" disabled={deletingStoreId !== null} onClick={closeDeleteDialog}>Giữ lại cửa hàng</button><button type="submit" className="primary-button store-delete-confirm" disabled={deletingStoreId !== null}>{deletingStoreId ? "Đang xóa..." : "Xóa cửa hàng"}</button></div></form></div> : null}
    </div>;
}
type ManagerPayrollRow = {
    period: string;
    storeId: string;
    storeName: string;
    profitBeforePerformanceRewards: number;
    employeeKpiBonus: number;
    finalProfit: number;
    managerHours?: number;
    employeeEligibleHours?: number;
    totalKpiHours?: number;
    profitPerKpiHour?: number;
    kpiRate?: number;
    managerSalary: number;
    managerBonus: number;
    managerTotal: number;
    paymentConfirmedAt: string | null;
    closedAt: string | null;
    status: "LOCKED";
};
type ManagerPayrollReport = {
    period: string;
    policy: {
        salaryPerStore: number;
        managerHoursPerStore?: number;
        managerKpiRate: number | null;
        tiers?: Array<{ minimumProfitPerHour: number; rate: number }>;
    };
    rows: ManagerPayrollRow[];
    totals: { storeCount: number; totalSalary: number; totalBonus: number; totalPay: number };
};
function ManagerPayroll() {
    const [period, setPeriod] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()));
    const [report, setReport] = useState<ManagerPayrollReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const payrollRequest = useRef(0);
    const payrollController = useRef<AbortController | null>(null);
    const load = useCallback(async () => {
        const requestedPeriod = period;
        const requestId = ++payrollRequest.current;
        payrollController.current?.abort();
        const controller = new AbortController();
        payrollController.current = controller;
        setLoading(true);
        setError("");
        try {
            const params = new URLSearchParams({ scope: "manager", period: requestedPeriod });
            const response = await fetch(`/api/payroll?${params}`, { cache: "no-store", signal: controller.signal });
            const payload = await response.json() as { managerPayroll?: ManagerPayrollReport; message?: string };
            if (!response.ok || !payload.managerPayroll) throw new Error(payload.message || "Không thể tải lương thưởng quản lý.");
            if (payload.managerPayroll.period !== requestedPeriod) throw new Error("Dữ liệu lương quản lý phản hồi không đúng kỳ đã chọn.");
            if (requestId !== payrollRequest.current || controller.signal.aborted) return;
            setReport(payload.managerPayroll);
        } catch (cause) {
            if (requestId !== payrollRequest.current || controller.signal.aborted) return;
            setReport(null);
            setError(cause instanceof Error ? cause.message : "Không thể tải lương thưởng quản lý.");
        } finally {
            if (requestId === payrollRequest.current) setLoading(false);
            if (payrollController.current === controller) payrollController.current = null;
        }
    }, [period]);
    useEffect(() => {
        void load();
        return () => payrollController.current?.abort();
    }, [load]);

    const exportReport = () => {
        if (!report) return;
        exportCsvFile(`luong-thuong-quan-ly-${report.period}.csv`, [
            ["Cửa hàng", "Kỳ", "Lợi nhuận cơ sở", "Giờ KPI nhân viên chính", "Giờ quản lý", "Tổng giờ KPI", "Lợi nhuận/giờ", "Mức KPI", "Lương quản lý", "Thưởng KPI quản lý", "Tổng nhận", "Lợi nhuận sau cùng", "Đã chi lúc", "Khóa lúc"],
            ...report.rows.map((row) => [row.storeName, row.period, row.profitBeforePerformanceRewards, row.employeeEligibleHours ?? 0, row.managerHours ?? report.policy.managerHoursPerStore ?? "", row.totalKpiHours ?? 0, row.profitPerKpiHour ?? 0, `${((row.kpiRate ?? 0) * 100).toFixed(0)}%`, row.managerSalary, row.managerBonus, row.managerTotal, row.finalProfit, row.paymentConfirmedAt, row.closedAt]),
        ]);
    };
    const policy = report?.policy ?? null;
    const employeeTierText = (policy?.tiers ?? [])
        .map((tier) => `${(tier.rate * 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}% khi lợi nhuận/giờ từ ${money(tier.minimumProfitPerHour)}`)
        .join("; ");
    const managerPolicyText = policy?.managerKpiRate == null
        ? "Tỷ lệ KPI quản lý được đọc từ chính sách có phiên bản của kỳ; giao diện không tự gán giá trị thay thế."
        : `KPI quản lý hiện hành là ${(policy.managerKpiRate * 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}% lợi nhuận cơ sở.`;
    const rowManagerHours = (row: ManagerPayrollRow) => row.managerHours ?? policy?.managerHoursPerStore ?? null;
    const totals = report?.totals ?? { storeCount: 0, totalSalary: 0, totalBonus: 0, totalPay: 0 };
    const rows = report?.rows ?? [];
    return <div className="page-content manager-reference payroll-page">
        <div className="ref-toolbar"><div><h2>LƯƠNG THƯỞNG QUẢN LÝ</h2><p>Chỉ ghi nhận số liệu thật từ các cửa hàng đã xác nhận chi và khóa kỳ.</p></div><div className="ref-toolbar-actions"><input aria-label="Kỳ lương quản lý" type="month" value={period} onChange={(event) => setPeriod(event.target.value)}/><button onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> {loading ? "Đang tải…" : "Làm mới"}</button><button onClick={exportReport} disabled={!rows.length}><Download size={16}/> Xuất CSV</button></div></div>
        <div className="notice-banner">ℹ {policy ? <>Chính sách phiên bản áp dụng cho kỳ: lương quản lý {money(policy.salaryPerStore)}/cửa hàng/kỳ. {managerPolicyText} Mức KPI nhân viên: {employeeTierText || "chưa cấu hình"}.</> : <>Chính sách lương và KPI được tải từ Finance Engine theo kỳ đã chọn; không có giá trị mặc định ở giao diện.</>} Các dòng đã khóa bên dưới giữ nguyên chính sách tại thời điểm chốt.</div>
        {error && <div className="form-message">{error}</div>}
        <div className="stats-grid four"><StatCard label="TỔNG LƯƠNG QUẢN LÝ" value={money(totals.totalSalary)} note={`${totals.storeCount} cửa hàng đã khóa kỳ`} icon="♕"/><StatCard label="TỔNG THƯỞNG KPI" value={money(totals.totalBonus)} note={policy?.managerKpiRate == null ? "Theo snapshot và chính sách của kỳ" : `Tỷ lệ hiện hành ${(policy.managerKpiRate * 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}%`} tone="orange" icon="✦"/><StatCard label="TỔNG THỰC NHẬN" value={money(totals.totalPay)} note={`Kỳ ${period}`} tone="blue" icon="₫"/><StatCard label="CỬA HÀNG ĐÃ CHỐT" value={String(totals.storeCount)} note="Đã xác nhận chi và khóa" icon="✓"/></div>
        <section className="table-card"><div className="table-head"><div><h2>Lương thưởng theo từng cửa hàng · {period}</h2><p>Số liệu được lấy từ bản chốt bất biến của mỗi cửa hàng.</p></div><span className="status-pill">{rows.length} kỳ cửa hàng đã khóa</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Cửa hàng</th><th>Lợi nhuận cơ sở</th><th>Giờ xét KPI</th><th>Lợi nhuận/giờ</th><th>Mức KPI</th><th>Lương quản lý (snapshot)</th><th>Thưởng KPI quản lý</th><th>Tổng thực nhận</th><th>Lợi nhuận sau cùng</th><th>Đã chi lúc</th><th>Khóa kỳ lúc</th><th>Trạng thái</th></tr></thead><tbody>
            {loading && !report ? <tr><td colSpan={12} className="empty-cell">Đang tải số liệu lương thưởng quản lý…</td></tr> : rows.length === 0 ? <tr><td colSpan={12} className="empty-cell">Chưa có cửa hàng nào hoàn tất xác nhận chi và khóa kỳ {period}.</td></tr> : rows.map((row) => { const managerHours = rowManagerHours(row); return <tr key={`${row.storeId}-${row.period}`}><td><b>{row.storeName}</b></td><td>{money(row.profitBeforePerformanceRewards)}</td><td><small>NV {Number(row.employeeEligibleHours ?? 0).toFixed(2)} giờ · QL {managerHours == null ? "chưa có snapshot" : `${Number(managerHours).toFixed(2)} giờ`}</small><br/><b>{Number(row.totalKpiHours ?? 0).toFixed(2)} giờ</b></td><td>{money(row.profitPerKpiHour ?? 0)}/giờ</td><td>{((row.kpiRate ?? 0) * 100).toFixed(0)}%</td><td>{money(row.managerSalary)}</td><td className="money-green">{money(row.managerBonus)}</td><td><b>{money(row.managerTotal)}</b></td><td>{money(row.finalProfit)}</td><td>{row.paymentConfirmedAt ? dateTime(row.paymentConfirmedAt) : "—"}</td><td>{row.closedAt ? dateTime(row.closedAt) : "—"}</td><td><span className="status-pill">Đã khóa</span></td></tr>; })}
        </tbody><tfoot><tr><td>TỔNG CỘNG</td><td colSpan={4}/><td>{money(totals.totalSalary)}</td><td>{money(totals.totalBonus)}</td><td>{money(totals.totalPay)}</td><td colSpan={5}/></tr></tfoot></table></div></section>
    </div>;
}
function StoreWorkspace({ store, view, period, onPeriodChange, onReload, focusedOrderId, focusedOrderRequest, isSuperAdmin }: {
    store: Store;
    view: string;
    period: string;
    onPeriodChange: (period: string) => void;
    onReload: () => Promise<void>;
    focusedOrderId: string | null;
    focusedOrderRequest: number;
    isSuperAdmin: boolean;
}) {
    useEffect(() => { if (view === "Tổng quan") void onReload(); }, [onReload, store.id, view]);
    const title = view === "Tổng quan" ? `Tổng quan ${store.name}` : view;
    const inactive = store.status === "INACTIVE";
    const costLabels: Record<string, string> = { fixedCosts: "Chi phí cố định", incidentalCosts: "Chi phí phát sinh", inventoryGoods: "Tiền nhập hàng", inventoryShipping: "Vận chuyển", employeeBaseSalary: "Lương nhân viên", tiktokAllowance: "Phụ cấp TikTok", supportAllowance: "Phụ cấp hỗ trợ", manualAllowance: "Phụ cấp khác", manualBonus: "Thưởng nhân viên", managerSalary: "Lương quản lý", employeeKpiBonus: "Thưởng KPI nhân viên", managerBonus: "Thưởng KPI quản lý", monthEndExpenses: "Chi phí cuối kỳ" };
    return <><div className={`page-header store-header ${view === "Tổng quan" ? "store-header-overview" : ""}`}><div className="store-header-context"><span className="breadcrumb">CỬA HÀNG · {store.address}</span><p>Dữ liệu vận hành độc lập của {store.name}.</p></div><h1 className="store-workspace-title">{title}</h1><div className="header-actions"><span className={`store-state ${inactive ? "inactive" : ""}`}>{inactive ? "Ngưng hoạt động" : "Đang hoạt động"}</span><MonthPickerControl ariaLabel={`Kỳ dữ liệu của ${store.name}`} value={period} onChange={onPeriodChange} prefix="Kỳ "/></div></div><div className={`page-content ${inactive ? "store-readonly" : ""}`}>{inactive && <div className="inactive-store-banner">Cửa hàng đang ngưng hoạt động. Các thao tác tạo hoặc sửa dữ liệu đã khóa; lịch sử dòng tiền và báo cáo vẫn được giữ nguyên.</div>}{view === "Tổng quan" && <><div className="stats-grid four"><StatCard label="Doanh thu từ các ca" value={money(store.revenue)}/><StatCard label="Tổng tất cả chi phí" value={money(store.expense)} tone="orange"/><StatCard label="Lợi nhuận sau cùng" value={money(store.profit)} tone="blue"/><StatCard label="Biên lợi nhuận" value={`${store.revenue ? (store.profit / store.revenue * 100).toFixed(2) : "0.00"}%`} icon="%" tone="purple"/></div><section className="table-card store-expense-breakdown"><div className="table-head"><div><h2>Cơ cấu tổng chi phí cửa hàng</h2><p>Đã cộng chi phí cố định, phát sinh, nhập hàng, vận chuyển, lương, thưởng, phụ cấp và chi phí cuối kỳ</p></div><b>{money(store.expense)}</b></div><div className="comparison-grid">{Object.entries(store.expenseBreakdown ?? {}).map(([key, value]) => <p key={key}><span>{costLabels[key] ?? key}</span><b>{money(Number(value))}</b><em>{store.expense ? `${(Number(value) / store.expense * 100).toFixed(1)}%` : "0%"}</em></p>)}</div></section><StoreFinancialReport store={store} initialPeriod={period} onPeriodChange={onPeriodChange}/></>}{view === "Reset Dữ Liệu" && isSuperAdmin ? <SuperAdminReset store={store} onReset={onReload}/> : view === "Đơn hàng" ? <StoreOrdersManagement store={store} period={period} focusedOrderId={focusedOrderId} focusRequestKey={focusedOrderRequest} onChanged={onReload}/> : view === "Chi phí cố định" ? <FixedCostManagement store={store} onSaved={onReload}/> : view !== "Tổng quan" && <StoreModule store={store} view={view} period={period} onPeriodChange={onPeriodChange} onChanged={onReload}/>}</div></>;
}
function StoreCashflowView({ store, period, onPeriodChange }: { store: Store; period: string; onPeriodChange: (period: string) => void }) {
    const [reportVersion, setReportVersion] = useState(0);
    const refreshFinance = () => setReportVersion((version) => version + 1);
    return <div className="reference-module store-cashflow-page">
        <StoreOperatingExpense store={store} onSaved={refreshFinance}/>
        <StoreShiftCashflow key={store.id} store={store} period={period} onPeriodChange={onPeriodChange} refreshVersion={reportVersion}/>
        <StoreFinancialReport key={`${store.id}-${reportVersion}`} store={store} initialPeriod={period} onPeriodChange={onPeriodChange}/>
    </div>;
}
function StoreModule({ store, view, period, onPeriodChange, onChanged }: {
    store: Store;
    view: string;
    period: string;
    onPeriodChange: (period: string) => void;
    onChanged: () => void | Promise<void>;
}) {
    if (view === "Cài đặt") return <FunctionalSettings name={`Quản lý ${store.name}`} email="quanly@dore.vn" storeId={store.id}/>;
    if (view === "Lịch phân ca") return <StoreScheduleManagement store={store}/>;
    if (view === "Nhân viên") return <StoreEmployeeManagement store={store}/>;
    if (view === "Nhập hàng") return <StoreInventoryManagement store={store}/>;
    if (view === "Dòng tiền") return <StoreCashflowView store={store} period={period} onPeriodChange={onPeriodChange}/>;
    if (view === "Chi phí cuối kỳ") return <MonthEndExpensePanel store={store} period={period} onChanged={onChanged}/>;
    if (view === "Báo cáo") return <StoreFinancialReport store={store} initialPeriod={period} onPeriodChange={onPeriodChange}/>;
    return <ReferenceStoreModule store={store} view={view}/>;
}
function EmployeePortal({ user, onUser }: {
    user: User;
    onUser: (user: User) => void;
}) {
    const navigationIdentity = useMemo(() => ({ userId: user.id, role: "EMPLOYEE" as const }), [user.id]);
    const [navigationReady, setNavigationReady] = useState(false);
    const [view, setView] = useState(employeeMenu[0]);
    const [shift, setShift] = useState<EmployeeShiftState>({
        active: Boolean(user.shiftActive), shiftCode: user.currentShift, startedAt: user.shiftStartedAt,
        shiftName: user.currentShiftName, scheduledStart: user.scheduledStart, scheduledEnd: user.scheduledEnd,
        scheduledEndAt: null,
        attendanceStatus: null,
        attendanceDeltaMinutes: null,
    });
    const [orders, setOrders] = useState<Order[]>([]);
    const [tiktok, setTiktok] = useState(false);
    const [closingDraft, setClosingDraft] = useState<EmployeeClosingDraft>(EMPTY_EMPLOYEE_CLOSING_DRAFT);
    useEffect(() => {
        const restored = readNavigationSnapshot(navigationIdentity, navigationMenus);
        setView(restored.employeeView);
        setNavigationReady(true);
    }, [navigationIdentity]);
    useEffect(() => {
        if (!navigationReady) return;
        writeNavigationSnapshot(navigationIdentity, navigationMenus, {
            managerView: managerMenu[0],
            storeId: null,
            storeView: storeMenu[0],
            employeeView: view,
            managerPeriod: null,
        });
    }, [navigationIdentity, navigationReady, view]);
    const loadOrders = useCallback(() => fetch("/api/orders").then(response => response.json()).then(data => setOrders(data.orders ?? [])), []);
    const syncShift = useCallback(async () => {
        const response = await fetch("/api/shift", { cache: "no-store" });
        if (!response.ok)
            return;
        const data = await response.json();
        const nextShiftCode = data.active ? data.shiftCode : null;
        const changedShift = Boolean(shift.shiftCode && nextShiftCode && shift.shiftCode !== nextShiftCode);
        const storeContextChanged = (typeof data.storeId === "string" || data.storeId === null) && data.storeId !== user.storeId;
        if (changedShift) {
            setTiktok(false);
            setClosingDraft(EMPTY_EMPLOYEE_CLOSING_DRAFT);
            await loadOrders();
        }
        setShift({
            active: Boolean(data.active),
            shiftCode: nextShiftCode,
            startedAt: data.active ? data.startedAt : null,
            shiftName: data.active ? data.shiftName : null,
            scheduledStart: data.active ? data.scheduledStart : null,
            scheduledEnd: data.active ? data.scheduledEnd : null,
            scheduledEndAt: data.active ? data.scheduledEndAt : null,
            attendanceStatus: data.active && (data.attendanceStatus === "EARLY" || data.attendanceStatus === "ON_TIME" || data.attendanceStatus === "LATE") ? data.attendanceStatus : null,
            attendanceDeltaMinutes: data.active && Number.isInteger(data.attendanceDeltaMinutes) ? data.attendanceDeltaMinutes : null,
        });
        const nextEmployeeTiktokAllowance = resolveEmployeeTiktokAllowanceSnapshot("sync", data, user.employeeTiktokAllowance);
        const tiktokAllowanceChanged = nextEmployeeTiktokAllowance !== normalizeEmployeeTiktokAllowance(user.employeeTiktokAllowance);
        if (changedShift || storeContextChanged || tiktokAllowanceChanged || Boolean(user.shiftActive) !== Boolean(data.active)) onUser({
            ...user,
            storeId: typeof data.storeId === "string" || data.storeId === null ? data.storeId : user.storeId,
            storeName: typeof data.storeName === "string" || data.storeName === null ? data.storeName : user.storeName,
            isSupporting: typeof data.isSupporting === "boolean" ? data.isSupporting : user.isSupporting,
            activeTransferId: typeof data.activeTransferId === "string" || data.activeTransferId === null ? data.activeTransferId : user.activeTransferId,
            employeeTiktokAllowance: nextEmployeeTiktokAllowance,
            shiftActive: data.active ? 1 : 0,
            currentShift: nextShiftCode,
            shiftStartedAt: data.active ? data.startedAt : null,
            currentShiftName: data.active ? data.shiftName : null,
            scheduledStart: data.active ? data.scheduledStart : null,
            scheduledEnd: data.active ? data.scheduledEnd : null,
        });
    }, [loadOrders, onUser, shift.shiftCode, user]);
    useEffect(() => {
        if (view === "Đơn hàng" || view === "Dòng tiền" || view === "Trang chủ")
            loadOrders();
    }, [view, loadOrders, shift.active]);
    useEffect(() => {
        void syncShift();
        const timer = window.setInterval(() => void syncShift(), 30_000);
        const syncWhenVisible = () => { if (document.visibilityState === "visible") void syncShift(); };
        document.addEventListener("visibilitychange", syncWhenVisible);
        window.addEventListener("focus", syncWhenVisible);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", syncWhenVisible);
            window.removeEventListener("focus", syncWhenVisible);
        };
    }, [syncShift]);
    async function shiftAction(action: "start" | "end", payload?: ShiftActionPayload): Promise<ShiftActionResult> {
        const response = await fetch("/api/shift", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, tiktok, ...payload }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return {
            ok: false,
            message: data.message ?? "Không thể cập nhật ca làm việc. Vui lòng thử lại.",
            requiresEarlyEndConfirmation: data.requiresEarlyEndConfirmation === true,
            scheduledEndAt: typeof data.scheduledEndAt === "string" ? data.scheduledEndAt : null,
            serverNow: typeof data.serverNow === "string" ? data.serverNow : null,
        };
        const next = {
            ...user,
            storeId: typeof data.storeId === "string" || data.storeId === null ? data.storeId : user.storeId,
            storeName: typeof data.storeName === "string" || data.storeName === null ? data.storeName : user.storeName,
            isSupporting: typeof data.isSupporting === "boolean" ? data.isSupporting : user.isSupporting,
            activeTransferId: data.returnedToHomeStore ? null : user.activeTransferId,
            employeeTiktokAllowance: resolveEmployeeTiktokAllowanceSnapshot(action, data, user.employeeTiktokAllowance),
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
            scheduledEndAt: data.active ? data.scheduledEndAt : null,
            attendanceStatus: data.active && (data.attendanceStatus === "EARLY" || data.attendanceStatus === "ON_TIME" || data.attendanceStatus === "LATE") ? data.attendanceStatus : null,
            attendanceDeltaMinutes: data.active && Number.isInteger(data.attendanceDeltaMinutes) ? data.attendanceDeltaMinutes : null,
        });
        if (action === "end")
            alert(data.tiktokAllowance ? `${data.message} Phụ cấp TikTok: ${money(data.tiktokAllowance)}.` : (data.message ?? "Đã kết ca và ghi nhận lịch sử ca làm."));
        if (action === "end") {
            setTiktok(false);
            setClosingDraft(EMPTY_EMPLOYEE_CLOSING_DRAFT);
        }
        loadOrders();
        return {
            ok: true,
            message: data.message,
            startedAt: typeof data.startedAt === "string" ? data.startedAt : null,
            attendanceStatus: data.attendanceStatus === "EARLY" || data.attendanceStatus === "ON_TIME" || data.attendanceStatus === "LATE"
                ? data.attendanceStatus : null,
            attendanceDeltaMinutes: Number.isInteger(data.attendanceDeltaMinutes) ? data.attendanceDeltaMinutes : null,
        };
    }
    if (!navigationReady)
        return <div className="app-loading"><div className="pulse-logo"><img className="brand-logo-image" src="/logo.jpg" alt="Logo DORE Quản Lý" width={1254} height={1254}/></div><p>Đang mở lại màn hình gần nhất...</p></div>;
    const employeeStoreName = user.storeName ?? user.homeStoreName ?? "DORE";
    return <AppShell brand={employeeStoreName} subtitle={user.isSupporting ? "Đang hỗ trợ tạm thời" : "Hệ thống làm việc nhân viên"} menu={employeeMenu} active={view} onActive={setView} user={user} accent="employee">
        <div className="page-header employee-header employee-brand-header">
            <div><div className="employee-brand-title"><strong>{employeeStoreName}</strong><span>{user.isSupporting ? `ĐANG HỖ TRỢ · CỬA HÀNG CHÍNH: ${user.homeStoreName ?? "DORE"}` : `${view.toLocaleUpperCase("vi-VN")} · HỆ THỐNG LÀM VIỆC NHÂN VIÊN`}</span></div></div>
            <div className="header-user"><button className="bell" aria-label="Thông báo"><Bell size={20}/><span>2</span></button><div className="avatar"><UserRound size={20}/></div><span><b>{user.name}</b><small>{user.employeeCode ?? "NV"}</small></span></div>
        </div>
        <div className="page-content"><EmployeeView user={user} view={view} shift={shift} orders={orders} onShift={shiftAction} tiktok={tiktok} setTiktok={setTiktok} closingDraft={closingDraft} onClosingDraftChange={setClosingDraft} reloadOrders={loadOrders}/></div>
    </AppShell>;
}
function EmployeeView({ user, view, shift, orders, onShift, tiktok, setTiktok, closingDraft, onClosingDraftChange, reloadOrders }: {
    user: User;
    view: string;
    shift: EmployeeShiftState;
    orders: Order[];
    onShift: (action: "start" | "end", payload?: ShiftActionPayload) => void | ShiftActionResult | Promise<void | ShiftActionResult>;
    tiktok: boolean;
    setTiktok: (v: boolean) => void;
    closingDraft: EmployeeClosingDraft;
    onClosingDraftChange: (draft: EmployeeClosingDraft) => void;
    reloadOrders: () => void;
}) { if (view === "Trang chủ")
    return <ReferenceEmployeeHome user={user} shift={shift} orders={orders} onShift={onShift} tiktok={tiktok} setTiktok={setTiktok} closingDraft={closingDraft} onClosingDraftChange={onClosingDraftChange}/>; if (view === "Đơn hàng")
    return <EmployeeOrders user={user} shift={shift} orders={orders} reload={reloadOrders}/>; if (view === "Doanh thu")
    return <ReferenceEmployeeRevenue/>; if (view === "Bảng lương")
    return <ReferenceEmployeePayroll/>; if (view === "Dòng tiền")
    return <ReferenceEmployeeCashflow shift={shift} orders={orders}/>; return <ReferenceEmployeeShiftHistory/>; }
function EmployeeOrders({ user, shift, orders, reload }: {
    user: User;
    shift: EmployeeShiftState;
    orders: Order[];
    reload: () => void;
}) {
    const emptyForm = { customerName: "", phone: "", age: "", amount: "", paymentMethod: "CASH" };
    const [search, setSearch] = useState("");
    const [fromDate, setFromDate] = useState(todayLocalDate);
    const [toDate, setToDate] = useState(todayLocalDate);
    const [payment, setPayment] = useState("ALL");
    const [page, setPage] = useState(1);
    const [message, setMessage] = useState("");
    const [success, setSuccess] = useState("");
    const [detail, setDetail] = useState<Order | null>(null);
    const [form, setForm] = useState(emptyForm);
    const [saving, setSaving] = useState(false);
    const formRef = useRef<HTMLDivElement | null>(null);
    const createRequestId = useRef<string | null>(null);
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
        createRequestId.current = null;
        setForm(emptyForm);
        setMessage("");
        setSuccess("");
        scrollToForm();
    }
    function resetForm() {
        createRequestId.current = null;
        setForm(emptyForm);
        setMessage("");
    }
    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!shift.active)
            return setMessage("Bạn chưa bắt đầu ca làm việc");
        setMessage("");
        setSuccess("");
        const parsedAmount = parseVndInput(form.amount);
        if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0)
            return setMessage("Giá trị đơn hàng phải là số tiền hợp lệ lớn hơn 0.");
        const payload = { ...form, amount: parsedAmount };
        const clientRequestId = createRequestId.current ??= crypto.randomUUID();
        setSaving(true);
        try {
            const response = await fetch("/api/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Idempotency-Key": clientRequestId },
                body: JSON.stringify({ ...payload, clientRequestId }),
            });
            const result = await response.json();
            if (!response.ok) return setMessage(result.message ?? "Không thể lưu đơn hàng.");
            setSuccess(`Đã tạo đơn ${result.code}.`);
            resetForm();
            reload();
        } catch {
            // Keep the same request key. If the server committed before the
            // connection dropped, pressing save again returns that same order.
            setMessage("Mất kết nối khi lưu đơn. Vui lòng thử lại, hệ thống sẽ không tạo đơn trùng.");
        } finally {
            setSaving(false);
        }
    }
    function resetFilters() {
        const today = todayLocalDate();
        setSearch("");
        setFromDate(today);
        setToDate(today);
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
                <div className="orders-heading"><span className="orders-heading-icon"><ShoppingCart size={23}/></span><div><h2>ĐƠN HÀNG</h2><p>Tạo đơn mới và xem lịch sử đã ghi nhận</p><small className="orders-readonly-note">Đơn đã lưu chỉ được xem; chỉnh sửa hoặc hủy do quản lý thực hiện.</small></div></div>
                <div className="orders-actions"><button className="secondary-button" onClick={exportCsv} disabled={filtered.length === 0}><Download size={17}/> Xuất Excel</button><button className="primary-button" disabled={!shift.active} onClick={beginAdd}><Plus size={18}/> Thêm đơn hàng</button></div>
            </div>
            <div className="order-stats">
                <div className="order-stat-card order-stat-orders"><i><ShoppingBag size={26}/></i><span>Tổng số đơn<strong>{completed.length}</strong></span></div>
                <div className="order-stat-card order-stat-bank"><i><BadgeDollarSign size={26}/></i><span>Tổng tiền CK<strong>{money(bank)}</strong></span></div>
                <div className="order-stat-card order-stat-cash"><i><Banknote size={26}/></i><span>Tổng tiền TM<strong>{money(cash)}</strong></span></div>
                <div className="order-stat-card order-stat-total"><i><WalletCards size={26}/></i><span>Tổng tiền<strong>{money(cash + bank)}</strong></span></div>
            </div>
            <div className="order-filters">
                <label className="order-search"><span className="sr-only">Tìm kiếm đơn hàng</span><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Tìm kiếm mã đơn hàng, tên khách hàng, SĐT..."/></label>
                <label><span className="order-filter-label">Từ ngày</span><input type="date" aria-label="Từ ngày" value={fromDate} onChange={event => { setFromDate(event.target.value); setPage(1); }}/></label>
                <label><span className="order-filter-label">Đến ngày</span><input type="date" aria-label="Đến ngày" value={toDate} onChange={event => { setToDate(event.target.value); setPage(1); }}/></label>
                <label><span>Hình thức thanh toán</span><select value={payment} onChange={event => { setPayment(event.target.value); setPage(1); }}><option value="ALL">Tất cả</option><option value="CASH">Tiền mặt</option><option value="BANK_TRANSFER">Chuyển khoản</option></select></label>
                <button className="refresh-button" onClick={resetFilters}><RefreshCw size={17}/> Làm mới</button>
            </div>
            <div className="data-table-wrap">
                <table className="order-table"><thead><tr><th>STT</th><th>Mã đơn hàng</th><th>Tên khách hàng</th><th>SĐT</th><th>Tuổi</th><th>NV bán hàng</th><th>Giá trị đơn hàng</th><th>Hình thức thanh toán</th><th>Thời gian tạo</th><th>Chi tiết</th></tr></thead>
                    <tbody>{paged.length === 0 ? <tr><td colSpan={10} className="empty-cell">{shift.active ? "Chưa có đơn hàng phù hợp trong ca hiện tại." : "Bạn chưa bắt đầu ca làm việc"}</td></tr> : paged.map((order, index) => <tr key={order.id} className={order.status === "VOID" ? "void-order" : ""}><td data-label="STT">{(Math.min(page, pages) - 1) * pageSize + index + 1}</td><td data-label="Mã đơn"><b className="order-code">{order.code}</b></td><td data-label="Khách hàng">{order.customer_name || "—"}</td><td data-label="SĐT">{order.phone || "—"}</td><td data-label="Tuổi">{order.age ?? "—"}</td><td data-label="Nhân viên / ca"><b>{order.employeeName}</b><small>{shift.shiftCode ? `(${shift.shiftCode})` : ""}</small></td><td data-label="Giá trị"><b>{money(order.amount)}</b></td><td data-label="Thanh toán"><span className={`order-payment ${order.payment_method === "CASH" ? "cash" : "bank"}`}>{order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</span></td><td data-label="Tạo lúc">{dateTime(order.created_at)}</td><td data-label="Chi tiết"><div className="order-row-actions"><button type="button" aria-label={`Xem chi tiết đơn ${order.code}`} title="Xem chi tiết" onClick={() => setDetail(order)}><Eye size={15}/></button></div></td></tr>)}</tbody>
                </table>
            </div>
            <div className="order-pagination"><span>Hiển thị {filtered.length === 0 ? 0 : (Math.min(page, pages) - 1) * pageSize + 1} - {Math.min(Math.min(page, pages) * pageSize, filtered.length)} của {filtered.length} đơn hàng</span><div><button disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>‹</button>{Array.from({ length: pages }, (_, index) => index + 1).slice(0, 5).map(number => <button key={number} className={Math.min(page, pages) === number ? "active" : ""} onClick={() => setPage(number)}>{number}</button>)}<button disabled={page >= pages} onClick={() => setPage(current => Math.min(pages, current + 1))}>›</button></div></div>
        </div>
        <div className="order-form-card" ref={formRef}>
            <div className="order-form-title"><ShoppingCart size={21}/><h2>THÊM ĐƠN HÀNG MỚI</h2></div>
            <form onSubmit={save}>
                <fieldset disabled={!shift.active}>
                    <div className="order-form-grid">
                        <label>Mã đơn hàng<input value="Tự động khi lưu" disabled/><small>Mã đơn hàng được tạo tự động</small></label>
                        <label>Tên khách hàng <small>(không bắt buộc)</small><input value={form.customerName} onChange={event => updateForm("customerName", event.target.value)} placeholder="Nhập tên khách hàng" maxLength={100}/></label>
                        <label>SĐT <small>(không bắt buộc)</small><input value={form.phone} onChange={event => updateForm("phone", event.target.value)} placeholder="Nhập số điện thoại" inputMode="tel" maxLength={20}/></label>
                        <label>Tuổi <small>(không bắt buộc)</small><input value={form.age} onChange={event => updateForm("age", event.target.value)} placeholder="Nhập tuổi" type="number" min="1" max="120"/></label>
                        <label>NV bán hàng<input value={`${user.name}${shift.shiftName ? ` (${shift.shiftName})` : shift.shiftCode ? ` (${shift.shiftCode})` : ""}`} disabled/><small>Tự động gắn theo tài khoản và ca hiện tại</small></label>
                        <label>Giá trị đơn hàng<input value={form.amount} onChange={event => updateForm("amount", formatVndInput(event.target.value))} placeholder="Nhập giá trị đơn hàng" inputMode="numeric" required/><small>Ví dụ: 15000 sẽ hiển thị 15,000.</small></label>
                        <label>Hình thức thanh toán<select value={form.paymentMethod} onChange={event => updateForm("paymentMethod", event.target.value)} required><option value="CASH">Tiền mặt</option><option value="BANK_TRANSFER">Chuyển khoản</option></select></label>
                    </div>
                </fieldset>
                {message && <div className="form-message">{message}</div>}
                {success && <div className="order-success">✓ {success}</div>}
                <div className="order-form-actions"><button type="button" className="secondary-button" onClick={resetForm} disabled={saving}>Hủy</button><button className="primary-button" disabled={!shift.active || saving}>{saving ? "Đang lưu..." : "Lưu đơn hàng"}</button></div>
            </form>
        </div>
        {detail && <div className="modal-backdrop"><div className="modal order-detail-modal"><div className="modal-title"><h2>Chi tiết đơn {detail.code}</h2><button onClick={() => setDetail(null)}>×</button></div><dl><div><dt>Khách hàng</dt><dd>{detail.customer_name || "Khách lẻ"}</dd></div><div><dt>Số điện thoại</dt><dd>{detail.phone || "Không cung cấp"}</dd></div><div><dt>Tuổi</dt><dd>{detail.age ?? "Không cung cấp"}</dd></div><div><dt>Nhân viên / ca</dt><dd>{detail.employeeName} · {shift.shiftCode}</dd></div><div><dt>Thanh toán</dt><dd>{detail.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</dd></div><div><dt>Giá trị</dt><dd>{money(detail.amount)}</dd></div><div><dt>Thời gian tạo</dt><dd>{dateTime(detail.created_at)}</dd></div><div><dt>Trạng thái</dt><dd>{detail.status === "COMPLETED" ? "Hoàn tất" : "Đã hủy"}</dd></div></dl></div></div>}
    </section>;
}
// End of the employee order module.
