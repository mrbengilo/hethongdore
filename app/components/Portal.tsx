"use client";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BadgeDollarSign, Banknote, BarChart3, Bell, Calendar, CalendarDays, CalendarRange, CheckCircle2, ClipboardCheck, Clock3, Download, Eye, Flower2, Gift, History, Home, LayoutDashboard, LogOut, Menu, PackageOpen, Pencil, Percent, PieChart, Plus, ReceiptText, RefreshCw, Settings, ShoppingBag, ShoppingCart, Store, Trash2, TrendingUp, UserRound, UsersRound, WalletCards, X, type LucideIcon } from "lucide-react";
import { FunctionalDividend, FunctionalEmployeeHistory, FunctionalEmployeeTasks, FunctionalManagerPayroll, FunctionalSettings, FunctionalTaskManager, FunctionalTransfer } from "./FunctionalModules";
import { ReferenceEmployees, ReferenceStoreModule } from "./ReferenceStoreModules";
type Role = "MANAGER" | "EMPLOYEE";
type User = {
    id: string;
    username: string;
    role: Role;
    name: string;
    employeeId: string | null;
    storeId: string | null;
    shiftActive: number;
    currentShift: string | null;
    shiftStartedAt: string | null;
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
const money = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value)) + " Ä‘";
const compactMoney = (value: number) => value >= 1000000000 ? `${(value / 1000000000).toFixed(2)} tá»·` : value >= 1000000 ? `${(value / 1000000).toFixed(1)} tr` : money(value);
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
const managerMenu = ["Tá»•ng quan", "Cá»­a hÃ ng", "Giao viá»‡c", "DÃ²ng tiá»n", "LÆ°Æ¡ng thÆ°á»Ÿng quáº£n lÃ½", "BÃ¡o cÃ¡o", "Äiá»u chuyá»ƒn nhÃ¢n sá»±", "Cá»• tá»©c", "CÃ i Ä‘áº·t"];
const storeMenu = ["Tá»•ng quan", "Ca lÃ m viá»‡c", "Lá»‹ch phÃ¢n ca", "NhÃ¢n viÃªn", "Nháº­p hÃ ng", "Cháº¥m cÃ´ng", "LÆ°Æ¡ng thÆ°á»Ÿng", "ÄÆ¡n hÃ ng", "DÃ²ng tiá»n", "BÃ¡o cÃ¡o", "CÃ i Ä‘áº·t"];
const employeeMenu = ["Trang chá»§", "ÄÆ¡n hÃ ng", "Báº£ng lÆ°Æ¡ng", "DÃ²ng tiá»n", "Lá»‹ch sá»­ ca lÃ m"];
const menuIcons: Record<string, LucideIcon> = { "Tá»•ng quan": LayoutDashboard, "Cá»­a hÃ ng": Store, "Giao viá»‡c": ClipboardCheck, "DÃ²ng tiá»n": WalletCards, "LÆ°Æ¡ng thÆ°á»Ÿng quáº£n lÃ½": BadgeDollarSign, "BÃ¡o cÃ¡o": BarChart3, "Äiá»u chuyá»ƒn nhÃ¢n sá»±": UsersRound, "Cá»• tá»©c": PieChart, "CÃ i Ä‘áº·t": Settings, "Ca lÃ m viá»‡c": CalendarDays, "Lá»‹ch phÃ¢n ca": CalendarRange, "NhÃ¢n viÃªn": UserRound, "Nháº­p hÃ ng": PackageOpen, "Cháº¥m cÃ´ng": Clock3, "LÆ°Æ¡ng thÆ°á»Ÿng": BadgeDollarSign, "ÄÆ¡n hÃ ng": ShoppingCart, "Trang chá»§": Home, "Báº£ng lÆ°Æ¡ng": BadgeDollarSign, "Lá»‹ch sá»­ ca lÃ m": History };
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
        return <div className="app-loading"><div className="pulse-logo">DORE</div><p>Äang táº£i dá»¯ liá»‡u váº­n hÃ nh...</p></div>;
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
      <div className="sidebar-brand"><div className="mini-mark">{accent === "dark" ? <Flower2 size={27}/> : accent === "employee" ? <b>DORE</b> : <Store size={24}/>}</div><div><strong>{brand}</strong><span>{subtitle}</span></div><button className="close-menu" onClick={() => setOpen(false)} aria-label="ÄÃ³ng menu"><X size={21}/></button></div>
      {onBack && <button className="back-system" onClick={onBack}><ArrowLeft size={17}/> Tá»•ng quan há»‡ thá»‘ng</button>}
      <nav>{menu.map((item) => { const Icon = menuIcons[item] ?? LayoutDashboard; return <button key={item} className={active === item ? "active" : ""} onClick={() => { onActive(item); setOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}><i><Icon size={19} strokeWidth={1.8}/></i>{item}</button>; })}</nav>
      <div className="sidebar-user"><div className="avatar"><UserRound size={20}/></div><div><b>{user.name}</b><span>{user.role === "MANAGER" ? "Quáº£n lÃ½ há»‡ thá»‘ng" : "NV001 Â· BÃ¡n hÃ ng"}</span></div></div>
      <button className="logout-button" onClick={logout}><LogOut size={18}/> ÄÄƒng xuáº¥t</button>
    </aside>
    <section className="main-area"><header className="mobile-header"><button onClick={() => setOpen(true)} aria-label="Má»Ÿ menu"><Menu size={23}/></button><b>{brand}</b><Bell size={19}/></header>{children}</section>
    {open && <button className="menu-overlay" aria-label="ÄÃ³ng menu" onClick={() => setOpen(false)}/>} 
  </div>;
}
function ManagerPortal({ user }: {
    user: User;
}) {
    const [view, setView] = useState("Tá»•ng quan");
    const [storeView, setStoreView] = useState("Tá»•ng quan");
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
        return <AppShell brand={selectedStore.name} subtitle="Quáº£n lÃ½ cá»­a hÃ ng" menu={storeMenu} active={storeView} onActive={setStoreView} user={user} onBack={() => setSelectedStore(null)} accent="light"><StoreWorkspace store={selectedStore} view={storeView}/></AppShell>;
    return <AppShell brand="DORE" subtitle="Quáº£n lÃ½ toÃ n há»‡ thá»‘ng" menu={managerMenu} active={view} onActive={setView} user={user}><ManagerHeader view={view}/><ManagerView view={view} stores={stores} loading={loading} reload={loadStores} openStore={setSelectedStore}/></AppShell>;
}
function ManagerHeader({ view }: {
    view: string;
}) {
    return <div className="page-header"><div><span className="breadcrumb">Há»† THá»NG DORE Â· 5 Cá»¬A HÃ€NG</span><h1>{view}</h1><p>{view === "Tá»•ng quan" ? "Theo dÃµi toÃ n bá»™ hoáº¡t Ä‘á»™ng cá»§a chuá»—i cá»­a hÃ ng trong má»™t nÆ¡i." : `Quáº£n lÃ½ ${view.toLowerCase()} vá»›i dá»¯ liá»‡u cáº­p nháº­t theo cá»­a hÃ ng.`}</p></div><div className="header-actions"><label className="date-control"><Calendar size={17}/><input aria-label="ThÃ¡ng bÃ¡o cÃ¡o" type="month" defaultValue="2026-08"/></label><button className="bell" aria-label="ThÃ´ng bÃ¡o" onClick={() => alert("Báº¡n cÃ³ 3 thÃ´ng bÃ¡o váº­n hÃ nh má»›i.")}><Bell size={20}/><span>3</span></button></div></div>;
}
function StatCard({ label, value, note, tone = "green", icon = "â†—" }: {
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
    if (view === "Tá»•ng quan")
        return <DashboardOverview stores={stores} totals={totals} loading={loading} openStore={openStore}/>;
    if (view === "Cá»­a hÃ ng")
        return <StoresView stores={stores} totals={totals} reload={reload} openStore={openStore}/>;
    if (view === "Giao viá»‡c")
        return <FunctionalTaskManager stores={stores}/>;
    if (view === "DÃ²ng tiá»n")
        return <CashflowView stores={stores} totals={totals}/>;
    if (view === "LÆ°Æ¡ng thÆ°á»Ÿng quáº£n lÃ½")
        return <FunctionalManagerPayroll stores={stores}/>;
    if (view === "BÃ¡o cÃ¡o")
        return <ReportsView stores={stores} totals={totals}/>;
    if (view === "Äiá»u chuyá»ƒn nhÃ¢n sá»±")
        return <FunctionalTransfer stores={stores}/>;
    if (view === "Cá»• tá»©c")
        return <FunctionalDividend totals={totals}/>;
    return <FunctionalSettings name="Quáº£n trá»‹ viÃªn" email="admin@dore.vn"/>;
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
    <div className="stats-grid three"><StatCard label="Tá»”NG DOANH THU" value={compactMoney(totals.revenue)} note="â†‘ 12,45% so vá»›i thÃ¡ng trÆ°á»›c" icon="â‚«"/><StatCard label="Tá»”NG CHI PHÃ" value={compactMoney(totals.expense)} note="â†‘ 8,32% so vá»›i thÃ¡ng trÆ°á»›c" tone="orange" icon="â–¤"/><StatCard label="Tá»”NG Lá»¢I NHUáº¬N" value={compactMoney(totals.profit)} note="â†‘ 16,78% so vá»›i thÃ¡ng trÆ°á»›c" tone="blue" icon="â–¥"/></div>
    <div className="section-title"><div><h2>Quáº£n lÃ½ cá»­a hÃ ng</h2><p>Chá»n cá»­a hÃ ng Ä‘á»ƒ xem vÃ  quáº£n lÃ½ chi tiáº¿t.</p></div><span>{stores.length} cá»­a hÃ ng Ä‘ang hoáº¡t Ä‘á»™ng</span></div>
    <div className="store-grid">{loading ? Array.from({ length: 5 }, (_, i) => <div className="store-card loading-card" key={i}/>) : stores.map((store, index) => <article className="store-card" key={store.id}><div className={`store-cover cover-${index % 5}`}><div className="shop-sign"><b>DORE</b><span>{store.name.replace("DORE ", "")}</span></div><div className="shop-front"><i /><i /><i /></div></div><div className="store-card-body"><div className="store-status">â— Hoáº¡t Ä‘á»™ng</div><h3>{store.name}</h3><p>âŒ– {store.address}</p><div className="store-numbers"><span>Doanh thu thÃ¡ng <b>{money(store.revenue)}</b></span><span>Lá»£i nhuáº­n <b>{money(store.profit)}</b></span></div><button className="store-open" onClick={() => openStore(store)}>Quáº£n lÃ½ cá»­a hÃ ng <span>â†’</span></button></div></article>)}</div>
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
    const [message, setMessage] = useState("");
    const [query, setQuery] = useState("");
    const filteredStores = stores.filter((store) => `${store.name} ${store.address}`.toLocaleLowerCase("vi-VN").includes(query.toLocaleLowerCase("vi-VN")));
    function beginEdit(store?: Store) { setEditing(store ?? null); setName(store?.name ?? "DORE "); setAddress(store?.address ?? ""); setMessage(""); setShowForm(true); }
    async function save(event: FormEvent) { event.preventDefault(); const response = await fetch("/api/stores", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: editing?.id, name, address }) }); const data = await response.json(); if (!response.ok)
        return setMessage(data.message); setShowForm(false); await reload(); }
    async function archive(store: Store) { if (!confirm(`LÆ°u trá»¯ ${store.name}? Dá»¯ liá»‡u lá»‹ch sá»­ váº«n Ä‘Æ°á»£c giá»¯ láº¡i.`))
        return; await fetch(`/api/stores?id=${store.id}`, { method: "DELETE" }); await reload(); }
    return <div className="page-content"><div className="toolbar"><div className="stats-inline"><b>{stores.length}</b> cá»­a hÃ ng Â· <b>{money(totals.revenue)}</b> doanh thu</div><button className="primary-button" onClick={() => beginEdit()}>ï¼‹ ThÃªm cá»­a hÃ ng</button></div><×]¼âÚ$z{-®éÜj×FW&VBæÖ‚†÷&FW"Â–æFW‚’Óâ¶–æFW‚²Â÷&FW"æ6öFRÂ÷&FW"æ7W7FöÖW%öæÖRóò""Â÷&FW"ç†öæRóò""Â÷&FW"ævRóò""Â÷&FW"æV×Æ÷–VTæÖRÂ6†–gBç6†–gD6öFRóò""Â÷&FW"æÖ÷VçBÂ÷&FW"ç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò%F¸âŞ«wB"¢$6‡W¸6â¶†şª6â"ÂFFUF–ÖR†÷&FW"æ7&VFVEöB’Â÷&FW"ç7FGW2ÓÓÒ$4ôÕÄUDTB"ò$†ü:âNªWB"¢,I:2ºw’%Ò’ÀĞ¢Ó°Ğ¢6öç7B&Æö"ÒæWr&Æö"…²%ÇTdTdb"²&÷w2æÖ‡&÷rÓâ&÷ræÖ†77d6VÆÂ’æ¦ö–â‚"Â"’’æ¦ö–â‚%Ç%Æâ"•ÒÂ²G—S¢'FW‡Bö77c¶6†'6WC×WFbÓ‚"Ò“°Ğ¢6öç7BW&ÂÒU$Âæ7&VFTö&¦V7EU$Â†&Æö"“°Ğ¢6öç7BÆ–æ²ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚&"“°Ğ¢Æ–æ²æ‡&VbÒW&Ã°Ğ¢Æ–æ²æF÷væÆöBÒFöâÖ†ærÒG·6†–gBç6†–gD6öFRóò&6Ö†–Vâ×F’'Òæ77f°Ğ¢Æ–æ²æ6Æ–6²‚“°Ğ¢U$Âç&Wfö¶Tö&¦V7EU$Â‡W&Â“°Ğ¢ĞĞ¢gVæ7F–öâWFFTf÷&Ò†f–VÆC¢¶W–öbG—Vöbf÷&ÒÂfÇVS¢7G&–ær’°Ğ¢6WDf÷&Ò†7W'&VçBÓâ‡²ââæ7W'&VçBÂ¶f–VÆEÓ¢fÇVRÒ’“°Ğ¢ĞĞ Ğ¢&WGW&âÇ6V7F–öâ6Æ74æÖSÒ&V×Æ÷–VRÖ÷&FW'2×67&VVâ#àĞ¢²6†–gBæ7F—fRbbÆF—b6Æ74æÖSÒ&Æö6¶VBÖ&ææW"#ï	ùI"Æ#ä.ªâ6Œk.ª÷BIªwR6Ì:Òf¸v3Âö#ãÇ7ãäŒ:7’I¸6ÒFæ‚Nª’G&ær6ºrI¸2Ş¹ò6º–2ìH6ærFŒ:¦ÒIjâŒ:ærãÂ÷7ããÂöF—cçĞĞ¢ÆF—b6Æ74æÖSÒ&÷&FW'2×æVÂ#àĞ¢ÆF—b6Æ74æÖSÒ&÷&FW'2×æVÂÖ†VB#àĞ¢ÆF—b6Æ74æÖSÒ&÷&FW'2Ö†VF–ær#ãÇ7â6Æ74æÖSÒ&÷&FW'2Ö†VF–ærÖ–6öâ#ãÅ6†÷–æt6'B6—¦S×³#7ÒóãÂ÷7ããÆF—cãÆƒ#ìIjâŒ8äsÂöƒ#ãÇå^ª6âÌ;ÒFæ‚<:6‚IjâŒ:æsÂ÷ãÂöF—cãÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW'2Ö7F–öç2#ãÆ'WGFöâ6Æ74æÖSÒ'6V6öæF'’Ö'WGFöâ"öä6Æ–6³×¶W‡÷'D77gÒF—6&ÆVC×¶f–ÇFW&VBæÆVæwF‚ÓÓÒÓãÄF÷væÆöB6—¦S×³wÒóâ‡^ªWBW†6VÃÂö'WGFöããÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ"F—6&ÆVC×²6†–gBæ7F—fWÒöä6Æ–6³×¶&Vv–äFGÓãÅÇW26—¦S×³‡ÒóâFŒ:¦ÒIjâŒ:æsÂö'WGFöããÂöF—càĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FG2#àĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÅ6†÷–æt&r6—¦S×³#gÒóãÂö“ãÇ7ãåN¹Vær>¹IjãÇ7G&öæsç¶6ö×ÆWFVBæÆVæwF‡ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÄ&FvTFöÆÆ%6–vâ6—¦S×³#gÒóãÂö“ãÇ7ãåN¹VærF¸â4³Ç7G&öæsç¶ÖöæW’†&æ²—ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÄ&æ¶æ÷FR6—¦S×³#gÒóãÂö“ãÇ7ãåN¹VærF¸âDÓÇ7G&öæsç¶ÖöæW’†66‚—ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×7FBÖ6&B#ãÆ“ãÅvÆÆWD6&G26—¦S×³#gÒóãÂö“ãÇ7ãåN¹VærF¸ãÇ7G&öæsç¶ÖöæW’†66‚²&æ²—ÓÂ÷7G&öæsãÂ÷7ããÂöF—càĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf–ÇFW'2#àĞ¢ÆÆ&VÂ6Æ74æÖSÒ&÷&FW"×6V&6‚#ãÇ7â6Æ74æÖSÒ'7"ÖöæÇ’#åL:ÆÒ¶«öÒIjâŒ:æsÂ÷7ããÆ–çWBfÇVS×·6V&6‡Òöä6†ævS×¶WfVçBÓâ²6WE6V&6‚†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÒÆ6V†öÆFW#Ò%L:ÆÒ¶«öÒÜ:2IjâŒ:ærÂL:¦â¶Œ:6‚Œ:ærÂ<IBâââ"óãÂöÆ&VÃàĞ¢ÆÆ&VÃãÇ7â6Æ74æÖSÒ'7"ÖöæÇ’#åNº²æ|:“Â÷7ããÆ–çWBG—SÒ&FFR"fÇVS×¶g&öÔFFWÒöä6†ævS×¶WfVçBÓâ²6WDg&öÔFFR†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃãÇ7â6Æ74æÖSÒ'7"ÖöæÇ’#ìI«öâæ|:“Â÷7ããÆ–çWBG—SÒ&FFR"fÇVS×·FôFFWÒöä6†ævS×¶WfVçBÓâ²6WEFôFFR†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃãÇ7ãäŒ:Ææ‚Fº–2F†æ‚Fü:ãÂ÷7ããÇ6VÆV7BfÇVS×·–ÖVçGÒöä6†ævS×¶WfVçBÓâ²6WE–ÖVçB†WfVçBçF&vWBçfÇVR“²6WEvRƒ“²×ÓãÆ÷F–öâfÇVSÒ$ÄÂ#åNªWB>ª3Âö÷F–öããÆ÷F–öâfÇVSÒ$44‚#åF¸âŞ«wCÂö÷F–öããÆ÷F–öâfÇVSÒ$$äµõE$å4dU"#ä6‡W¸6â¶†şª6ãÂö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃàĞ¢Æ'WGFöâ6Æ74æÖSÒ'&Vg&W6‚Ö'WGFöâ"öä6Æ–6³×·&W6WDf–ÇFW'7ÓãÅ&Vg&W6„7r6—¦S×³wÒóâÌ:ÒŞ¹¶“Âö'WGFöãàĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&FF×F&ÆR×w&#àĞ¢ÇF&ÆR6Æ74æÖSÒ&÷&FW"×F&ÆR#ãÇF†VCãÇG#ãÇFƒå5ECÂ÷FƒãÇFƒäÜ:2IjâŒ:æsÂ÷FƒãÇFƒåL:¦â¶Œ:6‚Œ:æsÂ÷FƒãÇFƒå<ICÂ÷FƒãÇFƒåG^¹V“Â÷FƒãÇFƒäåb,:âŒ:æsÂ÷FƒãÇFƒävœ:G.¸²IjâŒ:æsÂ÷FƒãÇFƒäŒ:Ææ‚Fº–2F†æ‚Fü:ãÂ÷FƒãÇFƒåF¹Ö’v–âNªóÂ÷FƒãÇFƒåF†òL:3Â÷FƒãÂ÷G#ãÂ÷F†VCàĞ¢ÇF&öG“ç·vVBæÆVæwF‚ÓÓÒòÇG#ãÇFB6öÅ7ã×³Ò6Æ74æÖSÒ&V×G’Ö6VÆÂ#ç·6†–gBæ7F—fRò$6Œk<;2IjâŒ:ærŒ;’º7G&öær6†¸vâNª’â"¢$.ªâ6Œk.ª÷BIªwR6Ì:Òf¸v2'ÓÂ÷FCãÂ÷G#â¢vVBæÖ‚†÷&FW"Â–æFW‚’ÓâÇG"¶W“×¶÷&FW"æ–GÒ6Æ74æÖS×¶÷&FW"ç7FGW2ÓÓÒ%dô”B"ò'fö–BÖ÷&FW""¢"'ÓãÇFCç²„ÖF‚æÖ–â‡vRÂvW2’Ò’¢vU6—¦R²–æFW‚²ÓÂ÷FCãÇFCãÆ"6Æ74æÖSÒ&÷&FW"Ö6öFR#ç¶÷&FW"æ6öFWÓÂö#ãÂ÷FCãÇFCç¶÷&FW"æ7W7FöÖW%öæÖRÇÂ.(	B'ÓÂ÷FCãÇFCç¶÷&FW"ç†öæRÇÂ.(	B'ÓÂ÷FCãÇFCç¶÷&FW"ævRóò.(	B'ÓÂ÷FCãÇFCãÆ#ç¶÷&FW"æV×Æ÷–VTæÖWÓÂö#ãÇ6ÖÆÃç·6†–gBç6†–gD6öFRò‚G·6†–gBç6†–gD6öFWÒ–¢"'ÓÂ÷6ÖÆÃãÂ÷FCãÇFCãÆ#ç¶ÖöæW’†÷&FW"æÖ÷VçB—ÓÂö#ãÂ÷FCãÇFCãÇ7â6Æ74æÖS×¶÷&FW"×–ÖVçBG¶÷&FW"ç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò&66‚"¢&&æ²'ÖÓç¶÷&FW"ç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò%F¸âŞ«wB"¢$6‡W¸6â¶†şª6â'ÓÂ÷7ããÂ÷FCãÇFCç¶FFUF–ÖR†÷&FW"æ7&VFVEöB—ÓÂ÷FCãÇFCãÆF—b6Æ74æÖSÒ&÷&FW"×&÷rÖ7F–öç2#ãÆ'WGFöâF—FÆSÒ%†VÒ6†’F«÷B"öä6Æ–6³×²‚’Óâ6WDFWF–Â†÷&FW"—ÓãÄW–R6—¦S×³WÒóãÂö'WGFöããÆ'WGFöâF—FÆSÒ%>ºÖIjâ"F—6&ÆVC×²6†–gBæ7F—fRÇÂ÷&FW"ç7FGW2ÓÒ$4ôÕÄUDTB'Òöä6Æ–6³×²‚’Óâ&Vv–äVF—B†÷&FW"—ÓãÅVæ6–Â6—¦S×³WÒóãÂö'WGFöããÆ'WGFöâ6Æ74æÖSÒ&FævW""F—FÆSÒ$ºw’Ijâ"F—6&ÆVC×²6†–gBæ7F—fRÇÂ÷&FW"ç7FGW2ÓÒ$4ôÕÄUDTB'Òöä6Æ–6³×²‚’Óâ6æ6VÂ†÷&FW"æ–B—ÓãÅG&6ƒ"6—¦S×³WÒóãÂö'WGFöããÂöF—cãÂ÷FCãÂ÷G#â—ÓÂ÷F&öG“àĞ¢Â÷F&ÆSàĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"×v–æF–öâ#ãÇ7ãä†¸6âF¸²¶f–ÇFW&VBæÆVæwF‚ÓÓÒò¢„ÖF‚æÖ–â‡vRÂvW2’Ò’¢vU6—¦R²ÒÒ´ÖF‚æÖ–â„ÖF‚æÖ–â‡vRÂvW2’¢vU6—¦RÂf–ÇFW&VBæÆVæwF‚—Ò>ºv¶f–ÇFW&VBæÆVæwF‡ÒIjâŒ:æsÂ÷7ããÆF—cãÆ'WGFöâF—6&ÆVC×·vRÃÒÒöä6Æ–6³×²‚’Óâ6WEvR†7W'&VçBÓâÖF‚æÖ‚ƒÂ7W'&VçBÒ’—Óî(“Âö'WGFöãç´'&’æg&öÒ‡²ÆVæwFƒ¢vW2ÒÂ…òÂ–æFW‚’Óâ–æFW‚²’ç6Æ–6RƒÂR’æÖ†çVÖ&W"ÓâÆ'WGFöâ¶W“×¶çVÖ&W'Ò6Æ74æÖS×´ÖF‚æÖ–â‡vRÂvW2’ÓÓÒçVÖ&W"ò&7F—fR"¢"'Òöä6Æ–6³×²‚’Óâ6WEvR†çVÖ&W"—Óç¶çVÖ&W'ÓÂö'WGFöãâ—ÓÆ'WGFöâF—6&ÆVC×·vRãÒvW7Òöä6Æ–6³×²‚’Óâ6WEvR†7W'&VçBÓâÖF‚æÖ–â‡vW2Â7W'&VçB²’—Óî(£Âö'WGFöããÂöF—cãÂöF—càĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&ÒÖ6&B"&Vc×¶f÷&Õ&VgÓàĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&Ò×F—FÆR#ãÅ6†÷–æt6'B6—¦S×³#ÒóãÆƒ#ç¶VF—F–ærò>ºÄIjâŒ8ärG¶VF—F–æræ6öFWÖ¢%DŒ8¤ÒIjâŒ8ärŞ¹¤’'ÓÂöƒ#ãÂöF—càĞ¢Æf÷&Òöå7V&Ö—C×·6fWÓàĞ¢Æf–VÆG6WBF—6&ÆVC×²6†–gBæ7F—fWÓàĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&ÒÖw&–B#àĞ¢ÆÆ&VÃäÜ:2IjâŒ:æsÆ–çWBfÇVS×¶VF—F–æsòæ6öFRóò%N»I¹–ær¶†’ÌkR'ÒF—6&ÆVBóãÇ6ÖÆÃäÜ:2IjâŒ:ærIkº62NªòN»I¹–æsÂ÷6ÖÆÃãÂöÆ&VÃàĞ¢ÆÆ&VÃåL:¦â¶Œ:6‚Œ:ærÇ6ÖÆÃâ†¶Œ;Fær.ª÷B'^¹–2“Â÷6ÖÆÃãÆ–çWBfÇVS×¶f÷&Òæ7W7FöÖW$æÖWÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚&7W7FöÖW$æÖR"ÂWfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#Ò$æª×L:¦â¶Œ:6‚Œ:ær"Ö„ÆVæwFƒ×³ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃå<IBÇ6ÖÆÃâ†¶Œ;Fær.ª÷B'^¹–2“Â÷6ÖÆÃãÆ–çWBfÇVS×¶f÷&Òç†öæWÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚'†öæR"ÂWfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#Ò$æª×>¹I¸vâF†şª’"–çWDÖöFSÒ'FVÂ"Ö„ÆVæwFƒ×³#ÒóãÂöÆ&VÃàĞ¢ÆÆ&VÃåG^¹V’Ç6ÖÆÃâ†¶Œ;Fær.ª÷B'^¹–2“Â÷6ÖÆÃãÆ–çWBfÇVS×¶f÷&ÒævWÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚&vR"ÂWfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#Ò$æª×G^¹V’"G—SÒ&çVÖ&W""Ö–ãÒ#"ÖƒÒ##"óãÂöÆ&VÃàĞ¢ÆÆ&VÃäåb,:âŒ:æsÆ–çWBfÇVS×¶æwW¸VâF¸²âG·6†–gBç6†–gD6öFRò‚G·6†–gBç6†–gD6öFWÒ–¢"'ÖÒF—6&ÆVBóãÇ6ÖÆÃåN»I¹–ær~ªöâF†VòL:’¶†şª6âl:6†¸vâNª“Â÷6ÖÆÃãÂöÆ&VÃàĞ¢ÆÆ&VÃävœ:G.¸²IjâŒ:æsÆ–çWBfÇVS×¶f÷&ÒæÖ÷VçGÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚&Ö÷VçB"ÂWfVçBçF&vWBçfÇVR—ÒÆ6V†öÆFW#Ò$æª×vœ:G.¸²IjâŒ:ær"G—SÒ&çVÖ&W""Ö–ãÒ#"7FWÒ#"&WV—&VBóãÂöÆ&VÃàĞ¢ÆÆ&VÃäŒ:Ææ‚Fº–2F†æ‚Fü:ãÇ6VÆV7BfÇVS×¶f÷&Òç–ÖVçDÖWF†öGÒöä6†ævS×¶WfVçBÓâWFFTf÷&Ò‚'–ÖVçDÖWF†öB"ÂWfVçBçF&vWBçfÇVR—Ò&WV—&VCãÆ÷F–öâfÇVSÒ$44‚#åF¸âŞ«wCÂö÷F–öããÆ÷F–öâfÇVSÒ$$äµõE$å4dU"#ä6‡W¸6â¶†şª6ãÂö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃàĞ¢ÂöF—càĞ¢Âöf–VÆG6WCàĞ¢¶ÖW76vRbbÆF—b6Æ74æÖSÒ&f÷&ÒÖÖW76vR#ç¶ÖW76vWÓÂöF—cçĞĞ¢·7V66W72bbÆF—b6Æ74æÖSÒ&÷&FW"×7V66W72#î)É2·7V66W77ÓÂöF—cçĞĞ¢ÆF—b6Æ74æÖSÒ&÷&FW"Öf÷&ÒÖ7F–öç2#ãÆ'WGFöâG—SÒ&'WGFöâ"6Æ74æÖSÒ'6V6öæF'’Ö'WGFöâ"öä6Æ–6³×·&W6WDf÷&×Óäºw“Âö'WGFöããÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ"F—6&ÆVC×²6†–gBæ7F—fWÓç¶VF—F–ærò$ÌkRF†’I¹V’"¢$ÌkRIjâŒ:ær'ÓÂö'WGFöããÂöF—càĞ¢Âöf÷&ÓàĞ¢ÂöF—càĞ¢¶FWF–ÂbbÆF—b6Æ74æÖSÒ&ÖöFÂÖ&6¶G&÷#ãÆF—b6Æ74æÖSÒ&ÖöFÂ÷&FW"ÖFWF–ÂÖÖöFÂ#ãÆF—b6Æ74æÖSÒ&ÖöFÂ×F—FÆR#ãÆƒ#ä6†’F«÷BIjâ¶FWF–Âæ6öFWÓÂöƒ#ãÆ'WGFöâöä6Æ–6³×²‚’Óâ6WDFWF–Â†çVÆÂ—Óì9sÂö'WGFöããÂöF—cãÆFÃãÆF—cãÆGCä¶Œ:6‚Œ:æsÂöGCãÆFCç¶FWF–Âæ7W7FöÖW%öæÖRÇÂ$¶Œ:6‚Î«²'ÓÂöFCãÂöF—cãÆF—cãÆGCå>¹I¸vâF†şª“ÂöGCãÆFCç¶FWF–Âç†öæRÇÂ$¶Œ;Fær7Vær>ªW'ÓÂöFCãÂöF—cãÆF—cãÆGCåG^¹V“ÂöGCãÆFCç¶FWF–ÂævRóò$¶Œ;Fær7Vær>ªW'ÓÂöFCãÂöF—cãÆF—cãÆGCäæŒ:&âfœ:¦âò6ÂöGCãÆFCç¶FWF–ÂæV×Æ÷–VTæÖWÒ+r·6†–gBç6†–gD6öFWÓÂöFCãÂöF—cãÆF—cãÆGCåF†æ‚Fü:ãÂöGCãÆFCç¶FWF–Âç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò%F¸âŞ«wB"¢$6‡W¸6â¶†şª6â'ÓÂöFCãÂöF—cãÆF—cãÆGCävœ:G.¸³ÂöGCãÆFCç¶ÖöæW’†FWF–ÂæÖ÷VçB—ÓÂöFCãÂöF—cãÆF—cãÆGCåF¹Ö’v–âNªóÂöGCãÆFCç¶FFUF–ÖR†FWF–Âæ7&VFVEöB—ÓÂöFCãÂöF—cãÆF—cãÆGCåG.ªærFŒ:“ÂöGCãÆFCç¶FWF–Âç7FGW2ÓÓÒ$4ôÕÄUDTB"ò$†ü:âNªWB"¢,I:2ºw’'ÓÂöFCãÂöF—cãÂöFÃãÂöF—cãÂöF—cçĞĞ¢Â÷6V7F–öãã°Ğ§ĞĞ¦gVæ7F–öâ÷&FW%F&ÆR‡²÷&FW'2Âöä6æ6VÂÓ¢°Ğ¢÷&FW'3¢÷&FW%µÓ°Ğ¢öä6æ6VÃó¢†–C¢7G&–ær’Óâfö–C°Ğ§Ò’²&WGW&âÆF—b6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#äFæ‚<:6‚IjãÂöƒ#ãÇ7ãç¶÷&FW'2æÆVæwF‡ÒIjâG&öær6Â÷7ããÂöF—cãÆF—b6Æ74æÖSÒ&FF×F&ÆR×w&#ãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäÜ:2IjãÂ÷FƒãÇFƒåF¹Ö’v–ãÂ÷FƒãÇFƒä¶Œ:6‚Œ:æsÂ÷FƒãÇFƒäæŒ:&âfœ:¦ãÂ÷FƒãÇFƒåF†æ‚Fü:ãÂ÷FƒãÇFƒävœ:G.¸³Â÷FƒãÇFƒåG.ªærFŒ:“Â÷Fƒç¶öä6æ6VÂbbÇF‚óçÓÂ÷G#ãÂ÷F†VCãÇF&öG“ç¶÷&FW'2æÆVæwF‚ÓÓÒòÇG#ãÇFB6öÅ7ã×³‡Ò6Æ74æÖSÒ&V×G’Ö6VÆÂ#ä6Œk<;2IjâŒ:ærG&öær6†¸vâNª’ãÂ÷FCãÂ÷G#â¢÷&FW'2æÖ†òÓâÇG"¶W“×¶òæ–GÓãÇFCãÆ#ç¶òæ6öFWÓÂö#ãÂ÷FCãÇFCç¶FFUF–ÖR†òæ7&VFVEöB—ÓÂ÷FCãÇFCç¶òæ7W7FöÖW%öæÖRÇÂ$¶Œ:6‚Î«²'ÓÂ÷FCãÇFCç¶òæV×Æ÷–VTæÖWÓÂ÷FCãÇFCç¶òç–ÖVçEöÖWF†öBÓÓÒ$44‚"ò%F¸âŞ«wB"¢$6‡W¸6â¶†şª6â'ÓÂ÷FCãÇFCãÆ#ç¶ÖöæW’†òæÖ÷VçB—ÓÂö#ãÂ÷FCãÇFCãÇ7â6Æ74æÖS×¶òç7FGW2ÓÓÒ$4ôÕÄUDTB"ò'7FGW2×–ÆÂ"¢'fö–B×–ÆÂ'Óç¶òç7FGW2ÓÓÒ$4ôÕÄUDTB"ò$†ü:âNªWB"¢,I:2ºw’'ÓÂ÷7ããÂ÷FCç¶öä6æ6VÂbbÇFCãÆ'WGFöâ6Æ74æÖSÒ&FævW"ÖÆ–æ²"F—6&ÆVC×¶òç7FGW2ÓÒ$4ôÕÄUDTB'Òöä6Æ–6³×²‚’Óâöä6æ6VÂ†òæ–B—Óäºw“Âö'WGFöããÂ÷FCçÓÂ÷G#â—ÓÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂöF—cã²ĞĞ¦gVæ7F–öâV×Æ÷–VU—&öÆÂ‚’²&WGW&âÃãÆF—b6Æ74æÖSÒ&f–ÇFW"Ö6&B#ãÆÆ&VÃåFŒ:æsÆ–çWBG—SÒ&ÖöçF‚"FVfVÇEfÇVSÒ###bÓ‚"óãÂöÆ&VÃãÆÆ&VÃìI«öâæ|:“Æ–çWBG—SÒ&FFR"FVfVÇEfÇVSÒ###bÓ‚Ób"óãÂöÆ&VÃãÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ#å†VÒF¹ær¼:£Âö'WGFöããÂöF—cãÆF—b6Æ74æÖSÒ'7FG2Öw&–Bf÷W"#ãÅ7FD6&BÆ&VÃÒ%N¹DärD…RäªÅ"fÇVSÒ#Rã#SãI"óãÅ7FD6&BÆ&VÃÒ%N¹DärÌjüjär"fÇVSÒ#BãƒãI"FöæSÒ&&ÇVR"óãÅ7FD6&BÆ&VÃÒ%N¹DärDŒjş¹äär"fÇVSÒ#CSãI"FöæSÒ&÷&ævR"óãÅ7FD6&BÆ&VÃÒ$„ü8âDŒ8ä‚4"fÇVSÒ#R"–6öãÒ.)É2"óãÂöF—cãÆF—b6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#ä6†’F«÷BÌkjærF†Vò6Âöƒ#ãÇ7ãìIjâvœ:#ãIöv¹ÓÂ÷7ããÂöF—cãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæ|:’Ì:ÓÂ÷FƒãÇFƒä6Â÷FƒãÇFƒäv¹Òl:óÂ÷FƒãÇFƒäv¹Ò¾«÷CÂ÷FƒãÇFƒå>¹v¹ÓÂ÷FƒãÇFƒäÌkjær>º–æsÂ÷FƒãÇFƒåFŒk¹öæsÂ÷FƒãÇFƒåFŒ:æ‚F¸ãÂ÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“çµµ²#Ró‚ó##b"Â$6"Â#s£""Â##£R"Â#RÃR"Â#ãI"Â#SãI"Â#SãI%ÒÂ²#Bó‚ó##b"Â$6""Â##£"Â#s£2"Â#RÃ2"Â#ãcI"Â#I"Â#ãcI%ÒÂ²#2ó‚ó##b"Â$62"Â#s£"Â##3£2"Â#bÃR"Â##ãI"Â#ƒãI"Â##ãI%ÕÒæÖ‚‡"Â’’ÓâÇG"¶W“×¶—Óç·"æÖ‚‡‚Â¢’ÓâÇFB¶W“×¶§Ò6Æ74æÖS×¶¢ÓÓÒrò&ÖöæW’Öw&VVâ"¢"'Óç·‡ÓÂ÷FCâ—ÓÂ÷G#â—ÓÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂóã²ĞĞ¦gVæ7F–öâV×Æ÷–VT66†fÆ÷r‡²6†–gBÂ÷&FW'2Ó¢°Ğ¢6†–gC¢°Ğ¢7F—fS¢&ööÆVã°Ğ¢Ó°Ğ¢÷&FW'3¢÷&FW%µÓ°Ğ§Ò’²6öç7B7F—fRÒ÷&FW'2æf–ÇFW"†òÓâòç7FGW2ÓÓÒ$4ôÕÄUDTB"“²6öç7B&WfVçVRÒ7F—fRç&VGV6R‚†Âò’Óâ²òæÖ÷VçBÂ“²6öç7B6÷7BÒ6†–gBæ7F—fRò3S¢²&WGW&âÃç²6†–gBæ7F—fRbbÆF—b6Æ74æÖSÒ&Æö6¶VBÖ&ææW"#ãÆ#ä.ªâ6Œk.ª÷BIªwR6Ì:Òf¸v3Âö#ãÇ7ãå>¹Æ¸wRL;&ærF¸â>«Ò‡^ªWB†¸vâ¶†’6Ikº62¼:Ö6‚†şªBãÂ÷7ããÂöF—cçÓÆF—b6Æ74æÖSÒ'7FG2Öw&–BF‡&VR#ãÅ7FD6&BÆ&VÃÒ$Dôä‚D…R4"fÇVS×¶ÖöæW’‡&WfVçVR—Òæ÷FS×¶G¶7F—fRæÆVæwF‡ÒIjâŒ:ævÒóãÅ7FD6&BÆ&VÃÒ$4„’Œ8Ò4"fÇVS×¶ÖöæW’†6÷7B—ÒFöæSÒ&÷&ævR"æ÷FSÒ$6†’Œ:ÒŒ:B6–æ‚"óãÅ7FD6&BÆ&VÃÒ$Îº$’ä…^ªÄâNªÒL8Ôä‚"fÇVS×¶ÖöæW’„ÖF‚æÖ‚ƒÂ&WfVçVRÒ6÷7B’—ÒFöæSÒ&&ÇVR"æ÷FSÒ$Föæ‚F‡RÒ6†’Œ:Ò"óãÂöF—cãÆF—b6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#äÎ¸¶6‚>ºÒL;&ærF¸â<:26Âöƒ#ãÆ'WGFöãå‡^ªWBW†6VÂ(i3Âö'WGFöããÂöF—cãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæ|:“Â÷FƒãÇFƒä6Â÷FƒãÇFƒå>¹IjãÂ÷FƒãÇFƒäFöæ‚F‡SÂ÷FƒãÇFƒä6†’Œ:ÓÂ÷FƒãÇFƒäÎº6’æ‡^ªÖãÂ÷FƒãÇFƒåG.ªærFŒ:“Â÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“ãÇG#ãÇFCãRó‚ó##cÂ÷FCãÇFCä6Â÷FCãÇFCãScÂ÷FCãÇFCã"ã3SãIÂ÷FCãÇFCã3#ãIÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Öw&VVâ#ã"ã3ãIÂ÷FCãÇFCãÇ7â6Æ74æÖSÒ'7FGW2×–ÆÂ#ìI:2¾«÷B6Â÷7ããÂ÷FCãÂ÷G#ãÇG#ãÇFCãBó‚ó##cÂ÷FCãÇFCä6#Â÷FCãÇFCãC“Â÷FCãÇFCã"ããIÂ÷FCãÇFCã3ãIÂ÷FCãÇFB6Æ74æÖSÒ&ÖöæW’Öw&VVâ#ããs“ãIÂ÷FCãÇFCãÇ7â6Æ74æÖSÒ'7FGW2×–ÆÂ#ìI:2¾«÷B6Â÷7ããÂ÷FCãÂ÷G#ãÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂóã²ĞĞ¦gVæ7F–öâV×Æ÷–VT†—7F÷'’‚’²&WGW&âÃãÆF—b6Æ74æÖSÒ&f–ÇFW"Ö6&B#ãÆÆ&VÃåNº²æ|:“Æ–çWBG—SÒ&FFR"FVfVÇEfÇVSÒ###bÓ‚Ó"óãÂöÆ&VÃãÆÆ&VÃìI«öâæ|:“Æ–çWBG—SÒ&FFR"FVfVÇEfÇVSÒ###bÓ‚Ó3"óãÂöÆ&VÃãÆÆ&VÃä6Ì:ÓÇ6VÆV7CãÆ÷F–öãåNªWB>ª3Âö÷F–öããÆ÷F–öãä6Âö÷F–öããÆ÷F–öãä6#Âö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃãÆ'WGFöâ6Æ74æÖSÒ'&–Ö'’Ö'WGFöâ#åL:ÆÒ¶«öÓÂö'WGFöããÂöF—cãÆF—b6Æ74æÖSÒ'F&ÆRÖ6&B#ãÆF—b6Æ74æÖSÒ'F&ÆRÖ†VB#ãÆƒ#äÎ¸¶6‚>ºÒ6Ì:ÓÂöƒ#ãÆ'WGFöãå‡^ªWBW†6VÂ(i3Âö'WGFöããÂöF—cãÇF&ÆR6Æ74æÖSÒ&FF×F&ÆR#ãÇF†VCãÇG#ãÇFƒäæ|:’Ì:ÓÂ÷FƒãÇFƒäÜ:2æŒ:&âfœ:¦ãÂ÷FƒãÇFƒä6Â÷FƒãÇFƒäv¹Òl:óÂ÷FƒãÇFƒäv¹Ò¾«÷CÂ÷FƒãÇFƒå>¹v¹ÓÂ÷FƒãÇFƒäÌkjærv¹ÓÂ÷FƒãÇFƒäÌkjærN»L:ÖæƒÂ÷FƒãÂ÷G#ãÂ÷F†VCãÇF&öG“çµµ²#Ró‚ó##b"Â$åc"Â$6"Â#s£""Â##£R"Â#RÃRv¹Ò"Â##ãI"Â#ãI%ÒÂ²#Bó‚ó##b"Â$åc"Â$6""Â##£"Â#s£2"Â#RÃ2v¹Ò"Â##ãI"Â#ãcI%ÒÂ²#2ó‚ó##b"Â$åc"Â$62"Â#s£"Â##3£2"Â#bÃRv¹Ò"Â##ãI"Â##ãI%ÒÂ²#"ó‚ó##b"Â$åc"Â$6"Â#s£"Â##£"Â#RÃv¹Ò"Â##ãI"Â#ãI%ÕÒæÖ‚‡"Â’’ÓâÇG"¶W“×¶—Óç·"æÖ‚‡‚Â¢’ÓâÇFB¶W“×¶§Ò6Æ74æÖS×¶¢ÓÓÒrò&ÖöæW’Öw&VVâ"¢"'Óç·‡ÓÂ÷FCâ—ÓÂ÷G#â—ÓÂ÷F&öG“ãÂ÷F&ÆSãÂöF—cãÂóã²ĞĞ Ğ¢òò¶WB2f—7VÂfÆÆ&6·2v†–ÆRF†RgVæ7F–öæÂÖöGVÆW2&÷fR†æFÆRÆÂ7F—fR&÷WFW2àĞ§fö–BµF6·5f–WrÂÖævW%—&öÆÂÂG&ç6fW%f–WrÂF—f–FVæEf–WrÂV×Æ÷–VU—&öÆÂÂV×Æ÷–VT†—7F÷'•Ó°Ğ 