"use client";
/* eslint-disable @next/next/no-img-element -- Logo thÆ°Æ¡ng hiá»‡u tÄ©nh do ngÆ°á»i dÃ¹ng cung cáº¥p vÃ  dÃ¹ng Ä‘á»“ng nháº¥t trong toÃ n há»‡ thá»‘ng. */
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BadgeDollarSign, Banknote, BarChart3, Bell, Calendar, CalendarDays, CalendarRange, CheckCircle2, ClipboardCheck, Clock3, DatabaseBackup, Download, Eye, Gift, History, Home, LayoutDashboard, LogOut, Menu, PackageOpen, Percent, PieChart, Plus, ReceiptText, RefreshCw, Settings, ShoppingBag, ShoppingCart, Store, TrendingUp, UserRound, UsersRound, WalletCards, X, type LucideIcon } from "lucide-react";
import { FunctionalEmployeeTasks, FunctionalSettings, FunctionalTaskManager } from "./FunctionalModules";
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
import { StoreShiftCashflow } from "./StoreCashflow";
import { StoreOrdersManagement } from "./StoreOrdersManagement";
import { SuperAdminReset } from "./SuperAdminReset";
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
const money = (value: number) => new Intl.NumberFormat("en-US").format(Math.round(value)) + " Ä‘á»“ng";
const compactMoney = (value: number) => value >= 1000000000 ? `${(value / 1000000000).toFixed(2)} tá»·` : value >= 1000000 ? `${(value / 1000000).toFixed(1)} tr` : money(value);
const comparisonNote = (current: number, previous: number) => {
    if (previous === 0) return current === 0 ? "â†’ 0,00% so vá»›i ká»³ trÆ°á»›c" : "ChÆ°a cÃ³ sá»‘ liá»‡u ká»³ trÆ°á»›c";
    const change = (current - previous) / Math.abs(previous) * 100;
    const percent = Math.abs(change).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${change > 0 ? "â†‘" : change < 0 ? "â†“" : "â†’"} ${percent}% so vá»›i ká»³ trÆ°á»›c`;
};
const dateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh", hourCycle: "h23" }).format(new Date(value));
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
const managerMenu = ["Tá»•ng quan", "Cá»­a hÃ ng", "Giao viá»‡c", "DÃ²ng tiá»n", "LÆ°Æ¡ng thÆ°á»Ÿng quáº£n lÃ½", "BÃ¡o cÃ¡o", "Chia lá»£i nhuáº­n", "Äiá»u chuyá»ƒn nhÃ¢n sá»±", "CÃ i Ä‘áº·t"];
const storeMenu = ["Tá»•ng quan", "Lá»‹ch phÃ¢n ca", "NhÃ¢n viÃªn", "Nháº­p hÃ ng", "Chi phÃ­ cá»‘ Ä‘á»‹nh", "Cháº¥m cÃ´ng", "LÆ°Æ¡ng thÆ°á»Ÿng", "ÄÆ¡n hÃ ng", "DÃ²ng tiá»n", "BÃ¡o cÃ¡o", "CÃ i Ä‘áº·t"];
const superAdminStoreMenu = [...storeMenu.slice(0, -1), "Reset Dá»¯ Liá»‡u", storeMenu.at(-1) ?? "CÃ i Ä‘áº·t"];
const employeeMenu = ["Trang chá»§", "ÄÆ¡n hÃ ng", "Doanh thu", "Báº£ng lÆ°Æ¡ng", "DÃ²ng tiá»n", "Lá»‹ch sá»­ ca lÃ m"];
const navigationMenus = { manager: managerMenu, store: storeMenu, employee: employeeMenu };
const menuIcons: Record<string, LucideIcon> = { "Tá»•ng quan": LayoutDashboard, "Cá»­a hÃ ng": Store, "Giao viá»‡c": ClipboardCheck, "DÃ²ng tiá»n": WalletCards, "LÆ°Æ¡ng thÆ°á»Ÿng quáº£n lÃ½": BadgeDollarSign, "BÃ¡o cÃ¡o": BarChart3, "Äiá»u chuyá»ƒn nhÃ¢n sá»±": UsersRound, "Chia lá»£i nhuáº­n": PieChart, "CÃ i Ä‘áº·t": Settings, "Ca lÃ m viá»‡c": CalendarDays, "Lá»‹ch phÃ¢n ca": CalendarRange, "NhÃ¢n viÃªn": UserRound, "Nháº­p hÃ ng": PackageOpen, "Chi phÃ­ cá»‘ Ä‘á»‹nh": ReceiptText, "Cháº¥m cÃ´ng": Clock3, "LÆ°Æ¡ng thÆ°á»Ÿng": BadgeDollarSign, "ÄÆ¡n hÃ ng": ShoppingCart, "Reset Dá»¯ Liá»‡u": DatabaseBackup, "Trang chá»§": Home, "Doanh thu": TrendingUp, "Báº£ng lÆ°Æ¡ng": BadgeDollarSign, "Lá»‹ch sá»­ ca lÃ m": History };
const statIcons: Record<string, LucideIcon> = { "â‚«": Banknote, "â–¤": ReceiptText, "â–¥": BarChart3, "%": Percent, "â™•": BadgeDollarSign, "âœ¦": Gift, "âœ“": CheckCircle2, "â–§": ShoppingBag, "â†“": ReceiptText, "â†—": TrendingUp };
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
        return <div className="app-loading"><div className="pulse-logo"><img className="brand-logo-image" src="/logo.jpg" alt="Logo DORE Quáº£n LÃ½" width={1254} height={1254}/></div><p>Äang táº£i dá»¯ liá»‡u váº­n hÃ nh...</p></div>;
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
      <div className="sidebar-brand"><div className="mini-mark"><img className="brand-logo-image" src="/logo.jpg" alt="Logo DORE Quáº£n LÃ½" width={1254} height={1254}/></div><div><strong>{brand}</strong><span>{subtitle}</span></div><button className="close-menu" onClick={() => setOpen(false)} aria-label="ÄÃ³ng menu"><X size={21}/></button></div>
      {onBack && <button className="back-system" onClick={onBack}><ArrowLeft size={17}/> Quay vá» trang quáº£n lÃ½ chÃ­nh</button>}
      <nav>{menu.map((item) => { const Icon = menuIcons[item] ?? LayoutDashboard; return <button key={item} className={active === item ? "active" : ""} onClick={() => { onActive(item); setOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}><i><Icon size={19} strokeWidth={1.8}/></i>{item}</button>; })}</nav>
      <div className="sidebar-user"><div className="avatar"><UserRound size={20}/></div><div><b>{user.name}</b><span>{user.role === "MANAGER" ? Number(user.isSuperAdmin) === 1 ? "Quáº£n trá»‹ cáº¥p cao" : "Quáº£n lÃ½ há»‡ thá»‘ng" : `${user.employeeCode ?? "NV"} Â· ${user.employeePosition ?? "NhÃ¢n viÃªn"}`}</span></div></div>
      <button className="logout-button" onClick={logout}><LogOut size={18}/> ÄÄƒng xuáº¥t</button>
    </aside>
    <section className={`main-area ${shellAction ? "has-shell-action" : ""}`}><header className="mobile-header"><button onClick={() => setOpen(true)} aria-label="Má»Ÿ menu" aria-controls="app-navigation-sidebar" aria-expanded={open}><Menu size={23}/></button><b>{brand}</b>{shellAction ? <span className="mobile-action-placeholder" aria-hidden="true"/> : <Bell size={19}/>}</header>{shellAction && <div className="shell-notification-action">{shellAction}</div>}{children}</section>
    {open && <button className="menu-overlay" aria-label="ÄÃ³ng menu" onClick={() => setOpen(false)}/>} 
  </div>;
}
function ManagerPortal({ user }: {
    user: User;
}) {
    const navigationIdentity = useMemo(() => ({ userId: user.id, role: "MANAGER" as const }), [user.id]);
    const activeStoreMenu = useMemo(() => Number(user.isSuperAdmin) === 1 ? superAdminStoreMenu : storeMenu, [user.isSuperAdmin]);
    const managerNavigationMenus = useMemo(() => ({ manager: managerMenu, store: activeStoreMenu, employee: employeeMenu }), [activeStoreMenu]);
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
    const [focusedOrderId, setFocusedOrderId] = useState<string | null>(null);
    const [focusedOrderRequest, setFocusedOrderRequest] = useState(0);
    const loadRequest = useRef(0);
    const notificationRequest = useRef(0);
    const loadNotificationsForStore = useCallback(async (scopeStoreId: string | null) => {
        const requestId = ++notificationRequest.current;
        try {
            const notificationUrl = scopeStoreId ? `/api/notifications?storeId=${encodeURIComponent(scopeStoreId)}` : "/api/notifications";
            const response = await fetch(notificationUrl, { cache: "no-store" });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !Array.isArray(data.notifications)) throw new Error(data.message ?? "KhÃ´ng thá»ƒ táº£i thÃ´ng bÃ¡o.");
            if (requestId !== notificationRequest.current) return;
            setNotifications(data.notifications);
            setUnreadCount(Number(data.unreadCount ?? 0));
            setNotificationError("");
        } catch (error) {
            if (requestId !== notificationRequest.current) return;
            setNotificationError(error instanceof Error ? error.message : "KhÃ´ng thá»ƒ táºÛuîÚ$z{-®éÜj×’â–bF†R6W'fW"6öÖÖ—GFVB&Vf÷&RF†P¢òò6öææV7F–öâG&÷VBÂ&W76–ær6fRv–â&WGW&ç2F†B6ÖR÷&FW"à¢6WDÖW76vR‚$ŞªWB¾«÷Bî¹’¶†’ÌkRIjââgV’Ì;&ærFºÒÎª’Â¸rF¹ær>«Ò¶Œ;FærNªòIjâG,;–ærâ"“°¢Òf–æÆÇ’°¢6WE6f–ær†fÇ6R“°¢Ğ¢ĞĞ¢gVæ7F–öâ&W6WDf–ÇFW'2‚’°Ğ¢6WE6V&6‚‚""“°Ğ¢6WDg&öÔFFR‚""“°Ğ¢6WEFôFFR‚""“°Ğ¢6WE–ÖVçB‚$ÄÂ"“°Ğ¢6WEvRƒ“°Ğ¢&VÆöB‚“°Ğ¢ĞĞ¢gVæ7F–öâW‡÷'D77b‚’°Ğ¢6öç7B77d6VÆÂÒ‡fÇVS¢7G&–ærÂçVÖ&W"ÂçVÆÂ’Óâ°Ğ¢6öç7B&rÒ7G&–ær‡fÇVRóò""“°Ğ¢6öç7B6fRÒõå³ÒµÂÔÒòçFW7B‡&r’òrG·&wÖ¢&s°Ğ¢&WGW&â"G·6fRç&WÆ6TÆÂ‚r"rÂr""r—Ò&°Ğ¢Ó°Ğ¢6öç7B&÷w2Ò°Ğ¢²%5EB"Â$Ü:2IjâŒ:ær"Â%L:¦â¶Œ:6‚Œ:ær"Â%<IB"Â%G^¹V’"Â$åb,:âŒ:ær"Â$6"Â$vœ:G.¸²IjâŒ:ær"Â$Œ:Ææ‚Fº–2F†æ‚Fü:â"Â%F¹Ö’v–âNªò"Â%G.ªærFŒ:’%ÒÀĞ¢ââæf–ÇFW&VBæÖ‚†÷&FW"Â–æFW‚’Óâ¶–æFW‚²Â÷&FW"æ6öFRÂ÷&FW"æ7W7FöÖW%öæÖRóò""Â÷&FW"ç†öæRóò""Â÷&FW"ævRóò""Â÷&FW"æV×Æ÷–VTæÖRÂ6†–gBç6†–gD6öFRóò""Â÷&FW"æÖ÷VçBÂ÷&FW"ç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò%F¸âŞ«wB"¢$6‡W¸6â¶†şª6â"ÂFFUF–ÖR†÷&FW"æ7&VFVEöB’Â÷&FW"ç7FGW2ÓÓÒ$4ôÕÄUDTB"ò$†ü:âNªWB"¢,I:2ºw’%Ò’ÀĞ¢Ó°Ğ¢6öç7B&Æö"ÒæWr&Æö"…²%ÇTdTdb"²&÷w2æÖ‡&÷rÓâ&÷ræÖ†77d6VÆÂ’æ¦ö–â‚"Â"’’æ¦ö–â‚%Ç%Æâ"•ÒÂ²G—S¢'FW‡Bö77c¶6†'6WC×WFbÓ‚"Ò“°Ğ¢6öç7BW&ÂÒU$Âæ7&VFTö&¦V7EU$Â†&Æö"“°Ğ¢6öç7BÆ–æ²ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚&"“°Ğ¢Æ–æ²æ‡&VbÒW&Ã°Ğ¢Æ–æ²æF÷væÆöBÒFöâÖ†ærÒG·6†–gBç6†–gD6öFRóò&6Ö†–Vâ×F’'Òæ77f°Ğ¢Æ–æ²æ6Æ–6²‚“°Ğ¢U$Âç&Wfö¶Tö&¦V7EU$Â‡W&Â“°Ğ¢ĞĞ¢gVæ7F–öâWFFTf÷&Ò†f–VÆC¢¶W–öbG—Vöbf÷&ÒÂfÇVS¢7G&–ær’°Ğ¢6WDf÷&Ò†7W'&VçBÓâ‡²ââæ7W'&VçBÂ¶f–VÆEÓ¢fÇVRÒ’“°Ğ¢ĞĞ Ğ¢&WGW&âÇ6V7F–öâ6Æ74æÖSÒ&V×Æ÷–VRÖ÷&FW'2×67&VVâ#àĞ¢²6†–gBæ7F—fRbbÆF—b6Æ74æÖSÒ&Æö6¶VBÖ&ææW"#ï	ùI"Æ#ä.ªâ6Œk.ª÷BIªwR6Ì:Òf¸v3Âö#ãÇ7ãäŒ:7’I¸6ÒFæ‚Nª’G&ær6ºrI¸2Ş¹ò6º–2ìH6ærFŒ:¦ÒIjâŒ:ærãÂ÷7ããÂöF—cçĞĞ¢ÆF—b6Æ74æÖSÒ&÷&FW'2×æVÂ#àĞ¢ÆF—b6Æ74æÖSÒ&÷&FW'2×æVÂÖ†VB#àĞ¢ÆF—b6Æ74æÖSÒ&÷&FW'2Ö†VF–ær#ãÇ7â6Æ74æÖSÒ&÷&FW'2Ö†VF–ærÖ–6öâ#ãÅ6†÷–æt6'B6—¦S×³#7ÒóãÂ÷7ããÆF—cãÆƒ#ìIjâŒ8äsÂöƒ#ãÇåNªòIjâŞ¹¶’l:†VÒÎ¸¶6‚>ºÒI:2v†’æªÖãÂ÷ãÇ6ÖÆÂ6Æ74æÖSÒ&÷&FW'2×&VFöæÇ’Öæ÷FR#ìIjâI:2ÌkR6¸’Ikº62†VÓ²6¸–æ‚>ºÖ†ş«v2ºw’Fò^ª6âÌ;ÒF»2†¸vâãÂ÷6ÖÆÃãÂöF—cãÂöF—cà¢ÆF—b6Æ74æÖSÒ&÷&FW'2Ö7F–öç2#ãÆ'WGFöâ6Æ74æÖSÒ'6V6öæF'’Ö'WGFöâ"öä6Æ–6³×¶W‡÷'D77gÒF—6&ÆVC×¶f–ÇFW&VBæÆVæwF‚ÓÓÒÓãÄF÷væÆöB6—¦S×³wÒóâ‡^ªWBW†6VÃÂö'WGFöããÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ"F—6&ÆVC×²6†–gBæ7F—fWÒöä6Æ–6³×¶&Vv–äFGÓãÅÇW26—¦S×³‡ÒóâFŒ:¦ÒIjâŒ:æsÂö'WGFöããÂöF—càĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FG2#àĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÅ6†÷–æt&r6—¦S×³#gÒóãÂö“ãÇ7ãåN¹Vær>¹IjãÇ7G&öæsç¶6ö×ÆWFVBæÆVæwF‡ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÄ&FvTFöÆÆ%6–vâ6—¦S×³#gÒóãÂö“ãÇ7ãåN¹VærF¸â4³Ç7G&öæsç¶ÖöæW’†&æ²—ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÄ&æ¶æ÷FR6—¦S×³#gÒóãÂö“ãÇ7ãåN¹VærF¸âDÓÇ7G&öæsç¶ÖöæW’†66‚—ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÅvÆÆWD6&G26—¦S×³#gÒóãÂö“ãÇ7ãåN¹VærF¸ãÇ7G&öæsç¶ÖöæW’†66‚²&æ²—ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf–ÇFW'2#àĞ¢ÆÆ&VÂ6Æ74æÖSÒ&÷&FW"×6V&6‚#ãÇ7â6Æ74æÖSÒ'7"ÖöæÇ’#åL:ÆÒ¶«öÒIjâŒ:æsÂ÷7ããÆ–çWBfÇVS×·6V&6‡Òöä6†ævS×¶WfVçBÓâ²6WE6V&6‚†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÒÆ6V†öÆFW#Ò%L:ÆÒ¶«öÒÜ:2IjâŒ:ærÂL:¦â¶Œ:6‚Œ:ærÂ<IBâââ"óãÂöÆ&VÃàĞ¢ÆÆ&VÃãÇ7â6Æ74æÖSÒ'7"ÖöæÇ’#åNº²æ|:“Â÷7ããÆ–çWBG—SÒ&FFR"fÇVS×¶g&öÔFFWÒöä6†ævS×¶WfVçBÓâ²6WDg&öÔFFR†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃãÇ7â6Æ74æÖSÒ'7"ÖöæÇ’#ìI«öâæ|:“Â÷7ããÆ–çWBG—SÒ&FFR"fÇVS×·FôFFWÒöä6†ævS×¶WfVçBÓâ²6WEFôFFR†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃãÇ7ãäŒ:Ææ‚Fº–2F†æ‚Fü:ãÂ÷7ããÇ6VÆV7BfÇVS×·–ÖVçGÒöä6†ævS×¶WfVçBÓâ²6WE–ÖVçB†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÓãÆ÷F–öâfÇVSÒ$ÄÂ#åNªWB>ª3Âö÷F–öããÆ÷F–öâfÇVSÒ$44‚#åF¸âŞ«wCÂö÷F–öããÆ÷F–öâfÇVSÒ$$äµõE$å4dU"#ä6‡W¸6â¶†şª6ãÂö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃàĞ¢Æ'WGFöâ6Æ74æÖSÒ'&Vg&W6‚Ö'WGFöâ"öä6Æ–6³×·&W6WDf–ÇFW'7ÓãÅ&Vg&W6„7r6—¦S×³wÒóâÌ:ÒŞ¹¶“Âö'WGFöãàĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&FF×F&ÆR×w&#àĞ¢ÇF&ÆR6Æ74æÖSÒ&÷&FW"×F&ÆR#ãÇF†VCãÇG#ãÇFƒå5ECÂ÷FƒãÇFƒäÜ:2IjâŒ:æsÂ÷FƒãÇFƒåL:¦â¶Œ:6‚Œ:æsÂ÷FƒãÇFƒå<ICÂ÷FƒãÇFƒåG^¹V“Â÷FƒãÇFƒäåb,:âŒ:æsÂ÷FƒãÇFƒävœ:G.¸²IjâŒ:æsÂ÷FƒãÇFƒäŒ:Ææ‚Fº–2F†æ‚Fü:ãÂ÷FƒãÇFƒåF¹Ö’v–âNªóÂ÷FƒãÇFƒä6†’F«÷CÂ÷FƒãÂ÷G#ãÂ÷F†VCà¢ÇF&öG“ç·vVBæÆVæwF‚ÓÓÒòÇG#ãÇFB6öÅ7ã×³Ò6Æ74æÖSÒ&V×G’Ö6VÆÂ#ç·6†–gBæ7F—fRò$6Œk<;2IjâŒ:ærŒ;’º7G&öær6†¸vâNª’â"¢$.ªâ6Œk.ª÷BIªwR6Ì:Òf¸v2'ÓÂ÷FCãÂ÷G#â¢vVBæÖ‚†÷&FW"Â–æFW‚’ÓâÇG"¶W“×¶÷&FW"æ–GÒ6Æ74æÖS×¶÷&FW"ç7FGW2ÓÓÒ%dô”B"ò'fö–BÖ÷&FW""¢"'ÓãÇFBFFÖÆ&VÃÒ%5EB#ç²„ÖF‚æÖ–â‡vRÂvW2’Ò’¢vU6—¦R²–æFW‚²ÓÂ÷FCãÇFBFFÖÆ&VÃÒ$Ü:2Ijâ#ãÆ"6Æ74æÖSÒ&÷&FW"Ö6öFR#ç¶÷&FW"æ6öFWÓÂö#ãÂ÷FCãÇFBFFÖÆ&VÃÒ$¶Œ:6‚Œ:ær#ç¶÷&FW"æ7W7FöÖW%öæÖRÇÂ.(	B'ÓÂ÷FCãÇFBFFÖÆ&VÃÒ%<IB#ç¶÷&FW"ç†öæRÇÂ.(	B'ÓÂ÷FCãÇFBFFÖÆ&VÃÒ%G^¹V’#ç¶÷&FW"ævRóò.(	B'ÓÂ÷FCãÇFBFFÖÆ&VÃÒ$æŒ:&âfœ:¦âò6#ãÆ#ç¶÷&FW"æV×Æ÷–VTæÖWÓÂö#ãÇ6ÖÆÃç·6†–gBç6†–gD6öFRò‚G·6†–gBç6†–gD6öFWÒ–¢"'ÓÂ÷6ÖÆÃãÂ÷FCãÇFBFFÖÆ&VÃÒ$vœ:G.¸²#ãÆ#ç¶ÖöæW’†÷&FW"æÖ÷VçB—ÓÂö#ãÂ÷FCãÇFBFFÖÆ&VÃÒ%F†æ‚Fü:â#ãÇ7â6Æ74æÖS×¶÷&FW"×–ÖVçBG¶÷&FW"ç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò&66‚"¢&&æ²'ÖÓç¶÷&FW"ç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò%F¸âŞ«wB"¢$6‡W¸6â¶†şª6â'ÓÂ÷7ããÂ÷FCãÇFBFFÖÆ&VÃÒ%NªòÌ;¦2#ç¶FFUF–ÖR†÷&FW"æ7&VFVEöB—ÓÂ÷FCãÇFBFFÖÆ&VÃÒ$6†’F«÷B#ãÆF—b6Æ74æÖSÒ&÷&FW"×&÷rÖ7F–öç2#ãÆ'WGFöâG—SÒ&'WGFöâ"&–ÖÆ&VÃ×¶†VÒ6†’F«÷BIjâG¶÷&FW"æ6öFWÖÒF—FÆSÒ%†VÒ6†’F«÷B"öä6Æ–6³×²‚’Óâ6WDFWF–Â†÷&FW"—ÓãÄW–R6—¦S×³WÒóãÂö'WGFöããÂöF—cãÂ÷FCãÂ÷G#â—ÓÂ÷F&öG“à¢Â÷F&ÆSàĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×v–æF–öâ#ãÇ7ãä†¸6âF¸²¶f–ÇFW&VBæÆVæwF‚ÓÓÒò¢„ÖF‚æÖ–â‡vRÂvW2’Ò’¢vU6—¦R²ÒÒ´ÖF‚æÖ–â„ÖF‚æÖ–â‡vRÂvW2’¢vU6—¦RÂf–ÇFW&VBæÆVæwF‚—Ò>ºv¶f–ÇFW&VBæÆVæwF‡ÒIjâŒ:æsÂ÷7ããÆF—cãÆ'WGFöâF—6&ÆVC×·vRÃÒÒöä6Æ–6³×²‚’Óâ6WEvR†7W'&VçBÓâÖF‚æÖ‚ƒÂ7W'&VçBÒ’—Óî(“Âö'WGFöãç´'&’æg&öÒ‡²ÆVæwFƒ¢vW2ÒÂ…òÂ–æFW‚’Óâ–æFW‚²’ç6Æ–6RƒÂR’æÖ†çVÖ&W"ÓâÆ'WGFöâ¶W“×¶çVÖ&W'Ò6Æ74æÖS×´ÖF‚æÖ–â‡vRÂvW2’ÓÓÒçVÖ&W"ò&7F—fR"¢"'Òöä6Æ–6³×²‚’Óâ6WEvR†çVÖ&W"—Óç¶çVÖ&W'ÓÂö'WGFöãâ—ÓÆ'WGFöâF—6&ÆVC×·vRãÒvW7Òöä6Æ–6³×²‚’Óâ6WEvR†7W'&VçBÓâÖF‚æÖ–â‡vW2Â7W'&VçB²’—Óî(£Âö'WGFöããÂöF—cãÂöF—càĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&ÒÖ6&B"&Vc×¶f÷&Õ&VgÓàĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&Ò×F—FÆR#ãÅ6†÷–æt6'B6—¦S×³#ÒóãÆƒ#åDŒ8¤ÒIjâŒ8ärŞ¹¤“Âöƒ#ãÂöF—cà¢Æf÷&Òöå7V&Ö—C×·6fWÓàĞ¢Æf–VÆG6WBF—6&ÆVC×²6†–gBæ7F—fWÓàĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&ÒÖw&–B#àĞ¢ÆÆ&VÃäÜ:2IjâŒ:æsÆ–çWBfÇVSÒ%N»I¹–ær¶†’ÌkR"F—6&ÆVBóãÇ6ÖÆÃäÜ:2IjâŒ:ærIkº62NªòN»I¹–æsÂ÷6ÖÆÃãÂöÆ&VÃà¢ÆÆ&VÃåL:¦â¶Œ:6‚Œ:ærÇ6ÖÆÃâ†¶Œ;Fær.ª÷B'^¹–2“Â÷6ÖÆÃãÆ–çWBfÇVS×¶f÷&Òæ7W7FöÖW$æÖWÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚&7W7FöÖW$æÖR"ÂWfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#Ò$æª×L:¦â¶Œ:6‚Œ:ær"Ö„ÆVæwFƒ×³ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃå<IBÇ6ÖÆÃâ†¶Œ;Fær.ª÷B'^¹–2“Â÷6ÖÆÃãÆ–çWBfÇVS×¶f÷&Òç†öæWÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚'†öæR"ÂWfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#Ò$æª×>¹I¸vâF†şª’"–çWDÖöFSÒ'FVÂ"Ö„ÆVæwFƒ×³#ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃåG^¹V’Ç6ÖÆÃâ†¶Œ;Fær.ª÷B'^¹–2“Â÷6ÖÆÃãÆ–çWBfÇVS×¶f÷&ÒævWÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚&vR"ÂWfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#Ò$æª×G^¹V’"G—SÒ&çVÖ&W""Ö–ãÒ#"ÖƒÒ##"óãÂöÆ&VÃàĞ¢ÆÆ&VÃäåb,:âŒ:æsÆ–çWBfÇVS×¶G·W6W"ææÖWÒG·6†–gBç6†–gDæÖRò‚G·6†–gBç6†–gDæÖWÒ–¢6†–gBç6†–gD6öFRò‚G·6†–gBç6†–gD6öFWÒ–¢"'ÖÒF—6&ÆVBóãÇ6ÖÆÃåN»I¹–ær~ªöâF†VòL:’¶†şª6âl:6†¸vâNª“Â÷6ÖÆÃãÂöÆ&VÃàĞ¢ÆÆ&VÃävœ:G.¸²IjâŒ:æsÆ–çWBfÇVS×¶f÷&ÒæÖ÷VçGÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚&Ö÷VçB"Âf÷&ÖEfæD–çWB†WfVçBçF&vWBçfÇVR’—ÒÆ6V†öÆFW#Ò$æª×vœ:G.¸²IjâŒ:ær"–çWDÖöFSÒ&çVÖW&–2"&WV—&VBóãÇ6ÖÆÃål:ÒNºS¢S>«Ò†¸6âF¸²RÃãÂ÷6ÖÆÃãÂöÆ&VÃà¢ÆÆ&VÃäŒ:Ææ‚Fº–2F†æ‚Fü:ãÇ6VÆV7BfÇVS×¶f÷&Òç–ÖVçDÖWF†öGÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚'–ÖVçDÖWF†öB"ÂWfVçBçF&vWBçfÇVR—Ò&WV—&VCãÆ÷F–öâfÇVSÒ$44‚#åF¸âŞ«wCÂö÷F–öããÆ÷F–öâfÇVSÒ$$äµõE$å4dU"#ä6‡W¸6â¶†şª6ãÂö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃàĞ¢ÂöF—càĞ¢Âöf–VÆG6WCàĞ¢¶ÖW76vRbbÆF—b6Æ74æÖSÒ&f÷&ÒÖÖW76vR#ç¶ÖW76vWÓÂöF—cçĞĞ¢·7V66W72bbÆF—b6Æ74æÖSÒ&÷&FW"×7V66W72#î)É2·7V66W77ÓÂöF—cçĞĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&ÒÖ7F–öç2#ãÆ'WGFöâG—SÒ&'WGFöâ"6Æ74æÖSÒ'6V6öæF'’Ö'WGFöâ"öä6Æ–6³×·&W6WDf÷&×ÒF—6&ÆVC×·6f–æwÓäºw“Âö'WGFöããÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ"F—6&ÆVC×²6†–gBæ7F—fRÇÂ6f–æwÓç·6f–ærò,IærÌkRâââ"¢$ÌkRIjâŒ:ær'ÓÂö'WGFöããÂöF—cà¢Âöf÷&ÓàĞ¢ÂöF—càĞ¢¶FWF–ÂbbÆF—b6Æ74æÖSÒ&ÖöFÂÖ&6¶G&÷#ãÆF—b6Æ74æÖSÒ&ÖöFÂ÷&FW"ÖFWF–ÂÖÖöFÂ#ãÆF—b6Æ74æÖSÒ&ÖöFÂ×F—FÆR#ãÆƒ#ä6†’F«÷BIjâ¶FWF–Âæ6öFWÓÂöƒ#ãÆ'WGFöâöä6Æ–6³×²‚’Óâ6WDFWF–Â†çVÆÂ—Óì9sÂö'WGFöããÂöF—cãÆFÃãÆF—cãÆGCä¶Œ:6‚Œ:æsÂöGCãÆFCç¶FWF–Âæ7W7FöÖW%öæÖRÇÂ$¶Œ:6‚Î«²'ÓÂöFCãÂöF—cãÆF—cãÆGCå>¹I¸vâF†şª“ÂöGCãÆFCç¶FWF–Âç†öæRÇÂ$¶Œ;Fær7Vær>ªW'ÓÂöFCãÂöF—cãÆF—cãÆGCåG^¹V“ÂöGCãÆFCç¶FWF–ÂævRóò$¶Œ;Fær7Vær>ªW'ÓÂöFCãÂöF—cãÆF—cãÆGCäæŒ:&âfœ:¦âò6ÂöGCãÆFCç¶FWF–ÂæV×Æ÷–VTæÖWÒ+r·6†–gBç6†–gD6öFWÓÂöFCãÂöF—cãÆF—cãÆGCåF†æ‚Fü:ãÂöGCãÆFCç¶FWF–Âç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò%F¸âŞ«wB"¢$6‡W¸6â¶†şª6â'ÓÂöFCãÂöF—cãÆF—cãÆGCävœ:G.¸³ÂöGCãÆFCç¶ÖöæW’†FWF–ÂæÖ÷VçB—ÓÂöFCãÂöF—cãÆF—cãÆGCåF¹Ö’v–âNªóÂöGCãÆFCç¶FFUF–ÖR†FWF–Âæ7&VFVEöB—ÓÂöFCãÂöF—cãÆF—cãÆGCåG.ªærFŒ:“ÂöGCãÆFCç¶FWF–Âç7FGW2ÓÓÒ$4ôÕÄUDTB"ò$†ü:âNªWB"¢,I:2ºw’'ÓÂöFCãÂöF—cãÂöFÃãÂöF—cãÂöF—cçĞĞ¢Â÷6V7F–öãã°Ğ§ĞĞ¦gVæ7F–öâV×Æ÷–VU—&öÆÂ‚’²&WGW&âÃãÆF—b6Æ74æÖSÒ&f–ÇFW"Ö6&B#ãÆÆ&VÃåFŒ:æsÆ–çWBG—SÒ&ÖöçF‚"FVfVÇEfÇVSÒ###bÓ‚"óãÂöÆ&VÃãÆÆ&VÃìI«öâæ|:“Æ–çWBG—SÒ&FFR"FVfVÇEfÇVSÒ###bÓ‚Ób"óãÂöÆ&VÃãÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ#å†VÒF¹ær¼:£Âö'WGFöããÂöF—cãÆF—b6Æ74æÖSÒ'7FG2Öw&–Bf÷W"#ãÅ7FD6&BÆ&VÃÒ%N¹DärD…RäªÅ"fÇVSÒ#Rã#SãI"óãÅ7FD6&BÆ&VÃÒ%N¹DärÌjüjär"fÇVSÒ#BãƒãI"FöæSÒ&&ÇVR"óãÅ7FD6&BÆ&VÃÒ%N¹DärDŒjş¹äär"fÇVSÒ#CSãI"FöæSÒ&÷&ævR"óãÅ7FD6&BÆ&VÃÒ$„ü8âDŒ8ä‚4"fÇVSÒ#R"–6öãÒ.)É2"óãÂöF—cãÆF—b6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#ä6†’F«÷BÌkjærF†Vò6Âöƒ#ãÇ7ãìIjâvœ:#ãIöv¹ÓÂ÷7ããÂöF—cãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæ|:’Ì:ÓÂ÷FƒãÇFƒä6Â÷FƒãÇFƒäv¹Òl:óÂ÷FƒãÇFƒäv¹Ò¾«÷CÂ÷FƒãÇFƒå>¹v¹ÓÂ÷FƒãÇFƒäÌkjær>º–æsÂ÷FƒãÇFƒåFŒk¹öæsÂ÷FƒãÇFƒåFŒ:æ‚F¸ãÂ÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“çµµ²#Ró‚ó##b"Â$6"Â#s£""Â##£R"Â#RÃR"Â#ãI"Â#SãI"Â#SãI%ÒÂ²#Bó‚ó##b"Â$6""Â##£"Â#s£2"Â#RÃ2"Â#ãcI"Â#I"Â#ãcI%ÒÂ²#2ó‚ó##b"Â$62"Â#s£"Â##3£2"Â#bÃR"Â##ãI"Â#ƒãI"Â##ãI%ÕÒæÖ‚‡"Â’’ÓâÇG"¶W“×¶—Óç·"æÖ‚‡‚Â¢’ÓâÇFB¶W“×¶§Ò6Æ74æÖS×¶¢ÓÓÒrò&ÖöæW’Öw&VVâ"¢"'Óç·‡ÓÂ÷FCâ—ÓÂ÷G#â—ÓÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂóã²ĞĞ¦W‡÷'BgVæ7F–öâV×Æ÷–VT66†fÆ÷r‡²6†–gBÂ÷&FW'2Ó¢°Ğ¢6†–gC¢°Ğ¢7F—fS¢&ööÆVã°Ğ¢Ó°Ğ¢÷&FW'3¢÷&FW%µÓ°Ğ§Ò’²6öç7B7F—fRÒ÷&FW'2æf–ÇFW"†òÓâòç7FGW2ÓÓÒ$4ôÕÄUDTB"“²6öç7B&WfVçVRÒ7F—fRç&VGV6R‚†Âò’Óâ²òæÖ÷VçBÂ“²6öç7B6÷7BÒ6†–gBæ7F—fRò3S¢²&WGW&âÃç²6†–gBæ7F—fRbbÆF—b6Æ74æÖSÒ&Æö6¶VBÖ&ææW"#ãÆ#ä.ªâ6Œk.ª÷BIªwR6Ì:Òf¸v3Âö#ãÇ7ãå>¹Æ¸wRL;&ærF¸â>«Ò‡^ªWB†¸vâ¶†’6Ikº62¼:Ö6‚†şªBãÂ÷7ããÂöF—cçÓÆF—b6Æ74æÖSÒ'7FG2Öw&–BF‡&VR#ãÅ7FD6&BÆ&VÃÒ$Dôä‚D…R4"fÇVS×¶ÖöæW’‡&WfVçVR—Òæ÷FS×¶G¶7F—fRæÆVæwF‡ÒIjâŒ:ævÒóãÅ7FD6&BÆ&VÃÒ$4„’Œ8Ò4"fÇVS×¶ÖöæW’†6÷7B—ÒFöæSÒ&÷&ævR"æ÷FSÒ$6†’Œ:ÒŒ:B6–æ‚"óãÅ7FD6&BÆ&VÃÒ$Îº$’ä…^ªÄâNªÒL8Ôä‚"fÇVS×¶ÖöæW’„ÖF‚æÖ‚ƒÂ&WfVçVRÒ6÷7B’—ÒFöæSÒ&&ÇVR"æ÷FSÒ$Föæ‚F‡RÒ6†’Œ:Ò"óãÂöF—cãÆF—b6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#äÎ¸¶6‚>ºÒL;&ærF¸â<:26Âöƒ#ãÆ'WGFöãå‡^ªWBW†6VÂ(i3Âö'WGFöããÂöF—cãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæ|:“Â÷FƒãÇFƒä6Â÷FƒãÇFƒå>¹IjãÂ÷FƒãÇFƒäFöæ‚F‡SÂ÷FƒãÇFƒä6†’Œ:ÓÂ÷FƒãÇFƒäÎº6’æ‡^ªÖãÂ÷FƒãÇFƒåG.ªærFŒ:“Â÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“ãÇG#ãÇFCãRó‚ó##cÂ÷FCãÇFCä6Â÷FCãÇFCãScÂ÷FCãÇFCã"ã3SãIÂ÷FCãÇFCã3#ãIÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Öw&VVâ#ã"ã3ãIÂ÷FCãÇFCãÇ7â6Æ74æÖSÒ'7FGW2×–ÆÂ#ìI:2¾«÷B6Â÷7ããÂ÷FCãÂ÷G#ãÇG#ãÇFCãBó‚ó##cÂ÷FCãÇFCä6#Â÷FCãÇFCãC“Â÷FCãÇFCã"ããIÂ÷FCãÇFCã3ãIÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Öw&VVâ#ããs“ãIÂ÷FCãÇFCãÇ7â6Æ74æÖSÒ'7FGW2×–ÆÂ#ìI:2¾«÷B6Â÷7ããÂ÷FCãÂ÷G#ãÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂóã²ĞĞ¦gVæ7F–öâV×Æ÷–VT†—7F÷'’‚’²&WGW&âÃãÆF—b6Æ74æÖSÒ&f–ÇFW"Ö6&B#ãÆÆ&VÃåNº²æ|:“Æ–çWBG—SÒ&FFR"FVfVÇEfÇVSÒ###bÓ‚Ó"óãÂöÆ&VÃãÆÆ&VÃìI«öâæ|:“Æ–çWBG—SÒ&FFR"FVfVÇEfÇVSÒ###bÓ‚Ó3"óãÂöÆ&VÃãÆÆ&VÃä6Ì:ÓÇ6VÆV7CãÆ÷F–öãåNªWB>ª3Âö÷F–öããÆ÷F–öãä6Âö÷F–öããÆ÷F–öãä6#Âö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃãÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ#åL:ÆÒ¶«öÓÂö'WGFöããÂöF—cãÆF—b6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#äÎ¸¶6‚>ºÒ6Ì:ÓÂöƒ#ãÆ'WGFöãå‡^ªWBW†6VÂ(i3Âö'WGFöããÂöF—cãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæ|:’Ì:ÓÂ÷FƒãÇFƒäÜ:2æŒ:&âfœ:¦ãÂ÷FƒãÇFƒä6Â÷FƒãÇFƒäv¹Òl:óÂ÷FƒãÇFƒäv¹Ò¾«÷CÂ÷FƒãÇFƒå>¹v¹ÓÂ÷FƒãÇFƒäÌkjærv¹ÓÂ÷FƒãÇFƒäÌkjærN»L:ÖæƒÂ÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“çµµ²#Ró‚ó##b"Â$åc"Â$6"Â#s£""Â##£R"Â#RÃRv¹Ò"Â##ãI"Â#ãI%ÒÂ²#Bó‚ó##b"Â$åc"Â$6""Â##£"Â#s£2"Â#RÃ2v¹Ò"Â##ãI"Â#ãcI%ÒÂ²#2ó‚ó##b"Â$åc"Â$62"Â#s£"Â##3£2"Â#bÃRv¹Ò"Â##ãI"Â##ãI%ÒÂ²#"ó‚ó##b"Â$åc"Â$6"Â#s£"Â##£"Â#RÃv¹Ò"Â##ãI"Â#ãI%ÕÒæÖ‚‡"Â’’ÓâÇG"¶W“×¶—Óç·"æÖ‚‡‚Â¢’ÓâÇFB¶W“×¶§Ò6Æ74æÖS×¶¢ÓÓÒrò&ÖöæW’Öw&VVâ"¢"'Óç·‡ÓÂ÷FCâ—ÓÂ÷G#â—ÓÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂóã²ĞĞ Ğ¢òò¶WB2f—7VÂfÆÆ&6·2v†–ÆRF†RgVæ7F–öæÂÖöGVÆW2&÷fR†æFÆRÆÂ7F—fR&÷WFW2àĞ§fö–BµF6·5f–WrÂÖævW%—&öÆÂÂG&ç6fW%f–WrÂF—f–FVæEf–WrÂV×Æ÷–VT†öÖRÂV×Æ÷–VU—&öÆÂÂV×Æ÷–VT†—7F÷'•Ó°Ğ 