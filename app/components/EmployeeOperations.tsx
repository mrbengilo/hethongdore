"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, Clock3, History, Home, LogOut, Menu, RefreshCw, ShoppingCart, Store, UserRound, WalletCards, X } from "lucide-react";

type User = {
  id: string;
  username: string;
  role: "MANAGER" | "EMPLOYEE";
  name: string;
  employeeId: string | null;
  storeId: string | null;
};

type ShiftRollover = { fromCode: string; fromName: string; toCode: string; toName: string; splitAt: string };
type ShiftState = {
  active: boolean;
  shiftCode: string | null;
  shiftName: string | null;
  startedAt: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  graceEndsAt: string | null;
  graceMinutes?: number;
  autoRolled?: boolean;
  rollovers?: ShiftRollover[];
};

type ShiftHistory = {
  id: string;
  shift_code: string;
  shift_name: string | null;
  employeeCode: string;
  employeeName: string;
  hourlyRate: number;
  started_at: string;
  ended_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  rollover_from: string | null;
  auto_rolled: number;
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

type View = "Trang chủ" | "Đơn hàng" | "Lịch sử ca làm";

const money = (value: number) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value))} đồng`;
const dateTime24 = (value: string) => new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false, timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date(value));
const time24 = (value: string) => new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));

function durationHours(start: string, end: string | null, nowIso: string) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end ?? nowIso).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.round(((endMs - startMs) / 3_600_000) * 100) / 100;
}

function shiftLabel(row: Pick<ShiftHistory, "shift_name" | "shift_code">) {
  if (row.shift_name) return row.shift_name;
  if (row.shift_code.startsWith("CA1")) return "Ca 1";
  if (row.shift_code.startsWith("CA2")) return "Ca 2";
  if (row.shift_code.startsWith("CA3")) return "Ca 3";
  return "Ca làm việc";
}

export default function EmployeeOperations() {
  const [user, setUser] = useState<User | null>(null);
  const [storeName, setStoreName] = useState("DORE");
  const [view, setView] = useState<View>("Trang chủ");
  const [menuOpen, setMenuOpen] = useState(false);
  const [shift, setShift] = useState<ShiftState>({ active: false, shiftCode: null, shiftName: null, startedAt: null, scheduledStartAt: null, scheduledEndAt: null, graceEndsAt: null });
  const [orders, setOrders] = useState<Order[]>([]);
  const [historyRows, setHistoryRows] = useState<ShiftHistory[]>([]);
  const [notice, setNotice] = useState("");
  const [clockIso, setClockIso] = useState(() => new Date().toISOString());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me").then(async (response) => response.ok ? response.json() : null).then((result) => {
      if (!result?.user) return window.location.replace("/");
      if (result.user.role !== "EMPLOYEE") return window.location.replace("/manager");
      setUser(result.user);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockIso(new Date().toISOString()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const loadStore = useCallback(async () => {
    const response = await fetch("/api/stores");
    const result = await response.json();
    if (response.ok && result.stores?.[0]?.name) setStoreName(String(result.stores[0].name));
  }, []);

  const applyShift = useCallback((next: ShiftState) => {
    setShift(next);
    if (next.autoRolled && next.rollovers?.length) {
      const last = next.rollovers[next.rollovers.length - 1];
      setNotice(`Hệ thống đã tự chốt ${last.fromName} lúc ${time24(last.splitAt)} và chuyển liên tục sang ${last.toName}. Lịch sử được lưu thành hai ca riêng.`);
    }
  }, []);

  const loadShift = useCallback(async () => {
    const response = await fetch("/api/shift", { cache: "no-store" });
    const result = await response.json();
    if (response.ok) applyShift(result);
  }, [applyShift]);

  const loadOrders = useCallback(async () => {
    const response = await fetch("/api/orders", { cache: "no-store" });
    const result = await response.json();
    setOrders(result.orders ?? []);
    if (result.shift) applyShift(result.shift);
  }, [applyShift]);

  const loadHistory = useCallback(async () => {
    const response = await fetch("/api/shifts", { cache: "no-store" });
    const result = await response.json();
    if (response.ok) setHistoryRows(result.shifts ?? []);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadShift(), loadOrders(), loadHistory(), loadStore()]);
  }, [loadHistory, loadOrders, loadShift, loadStore]);

  useEffect(() => {
    if (!user) return;
    void refreshAll();
    const timer = window.setInterval(() => { void refreshAll(); }, 20_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refreshAll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [user, refreshAll]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  async function shiftAction(action: "start" | "end", tiktok = false) {
    setNotice("");
    const response = await fetch("/api/shift", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, tiktok }),
    });
    const result = await response.json();
    if (!response.ok) return setNotice(result.message ?? "Không thể thực hiện thao tác ca làm việc.");
    if (action === "end") {
      setNotice(result.tiktokAllowance ? `Đã kết ca và ghi nhận phụ cấp TikTok ${money(result.tiktokAllowance)}.` : "Đã kết ca và lưu lịch sử thời gian làm việc.");
      setShift({ active: false, shiftCode: null, shiftName: null, startedAt: null, scheduledStartAt: null, scheduledEndAt: null, graceEndsAt: null });
    } else applyShift(result);
    await Promise.all([loadOrders(), loadHistory()]);
  }

  if (loading || !user) return <div className="employee-op-loading"><img src="/dore-manager-logo.svg" alt="DORE Quản Lý"/><p>Đang tải ca làm việc...</p></div>;

  const menu: Array<{ label: View; icon: typeof Home }> = [
    { label: "Trang chủ", icon: Home },
    { label: "Đơn hàng", icon: ShoppingCart },
    { label: "Lịch sử ca làm", icon: History },
  ];

  return <div className="employee-op-shell">
    <aside className={`employee-op-sidebar ${menuOpen ? "open" : ""}`}>
      <div className="employee-op-brand"><img src="/dore-manager-logo.svg" alt="DORE Quản Lý"/><div><strong>{storeName}</strong><span>Hệ thống làm việc nhân viên</span></div><button onClick={() => setMenuOpen(false)} aria-label="Đóng menu"><X size={20}/></button></div>
      <nav>{menu.map(({ label, icon: Icon }) => <button key={label} className={view === label ? "active" : ""} onClick={() => { setView(label); setMenuOpen(false); }}><Icon size={19}/>{label}</button>)}</nav>
      <div className="employee-op-user"><UserRound size={21}/><div><span>Nhân viên</span><b>{user.name}</b></div></div>
      <button className="employee-op-logout" onClick={logout}><LogOut size={18}/>Đăng xuất</button>
    </aside>

    <main className="employee-op-main">
      <header className="employee-op-header"><button className="employee-op-menu" onClick={() => setMenuOpen(true)} aria-label="Mở menu"><Menu size={22}/></button><div><span>{storeName}</span><h1>{view}</h1></div><div className="employee-op-clock"><Clock3 size={18}/>{dateTime24(clockIso)}</div></header>
      <section className="employee-op-content">
        {notice && <div className="employee-op-notice">{notice}</div>}
        {view === "Trang chủ" && <EmployeeHome user={user} storeName={storeName} shift={shift} orders={orders} clockIso={clockIso} onShift={shiftAction}/>} 
        {view === "Đơn hàng" && <EmployeeOrders shift={shift} orders={orders} onReload={async () => { await Promise.all([loadOrders(), loadHistory()]); }}/>} 
        {view === "Lịch sử ca làm" && <EmployeeShiftHistory rows={historyRows} nowIso={clockIso} onRefresh={loadHistory}/>} 
      </section>
    </main>
    {menuOpen && <button className="employee-op-overlay" onClick={() => setMenuOpen(false)} aria-label="Đóng menu"/>}
  </div>;
}

function EmployeeHome({ user, storeName, shift, orders, clockIso, onShift }: {
  user: User;
  storeName: string;
  shift: ShiftState;
  orders: Order[];
  clockIso: string;
  onShift: (action: "start" | "end", tiktok?: boolean) => Promise<void>;
}) {
  const [tiktok, setTiktok] = useState(false);
  const completed = orders.filter((order) => order.status === "COMPLETED");
  const revenue = completed.reduce((sum, order) => sum + order.amount, 0);
  const schedule = shift.scheduledStartAt && shift.scheduledEndAt ? `${time24(shift.scheduledStartAt)} - ${time24(shift.scheduledEndAt)}` : "Chưa xác định";
  const worked = shift.startedAt ? durationHours(shift.startedAt, null, clockIso) : 0;
  return <div className="employee-op-stack">
    <div className="employee-op-hero-grid">
      <article className="employee-op-attendance"><span>ĐIỂM DANH</span><strong>{time24(clockIso)}</strong><button className={shift.active ? "danger" : "primary"} onClick={() => onShift(shift.active ? "end" : "start", tiktok)}>{shift.active ? "KẾT CA" : "BẮT ĐẦU CA"}</button><small>{shift.active ? `Đang làm liên tục · ${worked.toFixed(2)} giờ` : "Bạn chưa bắt đầu ca làm việc"}</small></article>
      <article className="employee-op-profile"><span>THÔNG TIN NHÂN VIÊN</span><p>Họ và tên <b>{user.name}</b></p><p>Cửa hàng <b>{storeName}</b></p><p>Mã ca hiện tại <b>{shift.shiftCode ?? "—"}</b></p></article>
      <article className="employee-op-current-shift"><span>CA LÀM VIỆC HIỆN TẠI</span><div><b>{shift.shiftName ?? "Chưa vào ca"}</b><strong>{schedule}</strong></div><small className={shift.active ? "active" : ""}>{shift.active ? "● Đang ghi nhận thời gian liên tục" : "Chưa điểm danh"}</small></article>
    </div>

    {shift.active && <div className="employee-op-policy"><Clock3 size={22}/><div><b>Tự động chuyển ca sau 60 phút</b><p>Nếu quá {shift.graceMinutes ?? 60} phút sau giờ kết thúc mà chưa bấm KẾT CA, hệ thống tự chốt ca hiện tại tại đúng giờ kết thúc và mở ca kế tiếp ngay tại cùng mốc. Không mất phút làm việc; lịch sử vẫn là hai ca riêng.</p>{shift.graceEndsAt && <small>Mốc tự chuyển dự kiến: {dateTime24(shift.graceEndsAt)}</small>}</div></div>}

    <div className="employee-op-stats">
      <div><ShoppingCart size={24}/><span>Đơn trong ca<b>{completed.length}</b></span></div>
      <div><WalletCards size={24}/><span>Doanh thu ca<b>{money(revenue)}</b></span></div>
      <div><Clock3 size={24}/><span>Thời gian ca<b>{worked.toFixed(2)} giờ</b></span></div>
    </div>

    <label className="employee-op-tiktok"><input type="checkbox" checked={tiktok} disabled={!shift.active} onChange={(event) => setTiktok(event.target.checked)}/><span><b>Ca hiện tại có làm clip TikTok</b><small>Phụ cấp 25,000 đồng được ghi nhận khi kết ca.</small></span></label>
  </div>;
}

function EmployeeOrders({ shift, orders, onReload }: { shift: ShiftState; orders: Order[]; onReload: () => Promise<void> }) {
  const empty = { customerName: "", phone: "", age: "", amount: "", paymentMethod: "CASH" };
  const [form, setForm] = useState(empty);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const completed = orders.filter((order) => order.status === "COMPLETED");
  const cash = completed.filter((order) => order.payment_method === "CASH").reduce((sum, order) => sum + order.amount, 0);
  const bank = completed.filter((order) => order.payment_method === "BANK_TRANSFER").reduce((sum, order) => sum + order.amount, 0);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!shift.active) return setMessage("Bạn chưa bắt đầu ca làm việc.");
    setSaving(true); setMessage("");
    const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const result = await response.json();
    setSaving(false);
    if (!response.ok) return setMessage(result.message ?? "Không thể lưu đơn hàng.");
    setForm(empty); setMessage(`Đã lưu đơn ${result.code} vào ${result.shift?.shiftName ?? "ca hiện tại"}.`); await onReload();
  }

  return <div className="employee-op-stack">
    {!shift.active && <div className="employee-op-locked">Bạn chưa bắt đầu ca. Chức năng thêm đơn hàng đang khóa.</div>}
    <div className="employee-op-stats four"><div><ShoppingCart size={23}/><span>Tổng đơn<b>{completed.length}</b></span></div><div><Banknote size={23}/><span>Tiền mặt<b>{money(cash)}</b></span></div><div><WalletCards size={23}/><span>Chuyển khoản<b>{money(bank)}</b></span></div><div><Store size={23}/><span>Tổng doanh thu<b>{money(cash + bank)}</b></span></div></div>
    <section className="employee-op-panel"><div className="employee-op-panel-head"><div><h2>Thêm đơn hàng · {shift.shiftName ?? "Chưa vào ca"}</h2><p>Mọi đơn mới sẽ tự gắn đúng mã ca sau khi hệ thống chuyển ca.</p></div></div><form className="employee-op-order-form" onSubmit={save}><label>Tên khách hàng<input value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })}/></label><label>Số điện thoại<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })}/></label><label>Tuổi<input type="number" min="1" max="120" value={form.age} onChange={(event) => setForm({ ...form, age: event.target.value })}/></label><label>Giá trị đơn hàng<input required type="number" min="1" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })}/></label><label>Thanh toán<select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}><option value="CASH">Tiền mặt</option><option value="BANK_TRANSFER">Chuyển khoản</option></select></label><button disabled={!shift.active || saving}>{saving ? "ĐANG LƯU..." : "LƯU ĐƠN HÀNG"}</button></form>{message && <div className="employee-op-form-message">{message}</div>}</section>
    <section className="employee-op-panel"><div className="employee-op-panel-head"><h2>Đơn hàng của ca hiện tại</h2><button onClick={() => void onReload()}><RefreshCw size={16}/>Làm mới</button></div><div className="employee-op-table"><table><thead><tr><th>Thời gian</th><th>Mã đơn</th><th>Khách hàng</th><th>Thanh toán</th><th>Giá trị</th><th>Trạng thái</th></tr></thead><tbody>{orders.length === 0 ? <tr><td colSpan={6}>Chưa có đơn hàng trong ca hiện tại.</td></tr> : orders.map((order) => <tr key={order.id}><td>{dateTime24(order.created_at)}</td><td><b>{order.code}</b></td><td>{order.customer_name || "Khách lẻ"}</td><td>{order.payment_method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}</td><td>{money(order.amount)}</td><td>{order.status === "COMPLETED" ? "Hoàn tất" : "Đã hủy"}</td></tr>)}</tbody></table></div></section>
  </div>;
}

function EmployeeShiftHistory({ rows, nowIso, onRefresh }: { rows: ShiftHistory[]; nowIso: string; onRefresh: () => Promise<void> }) {
  const totalHours = useMemo(() => rows.reduce((sum, row) => sum + durationHours(row.started_at, row.ended_at, nowIso), 0), [rows, nowIso]);
  const totalSalary = useMemo(() => rows.reduce((sum, row) => sum + durationHours(row.started_at, row.ended_at, nowIso) * Number(row.hourlyRate ?? 0), 0), [rows, nowIso]);
  return <div className="employee-op-stack"><div className="employee-op-stats"><div><History size={24}/><span>Số ca đã ghi nhận<b>{rows.length}</b></span></div><div><Clock3 size={24}/><span>Tổng giờ<b>{totalHours.toFixed(2)} giờ</b></span></div><div><WalletCards size={24}/><span>Lương dự tính<b>{money(totalSalary)}</b></span></div></div><section className="employee-op-panel"><div className="employee-op-panel-head"><div><h2>Lịch sử ca làm thực tế</h2><p>Ca tự chuyển được tách thành từng dòng riêng nhưng thời gian nối liên tục tại cùng một mốc.</p></div><button onClick={() => void onRefresh()}><RefreshCw size={16}/>Làm mới</button></div><div className="employee-op-table"><table><thead><tr><th>Ca</th><th>Mã ca</th><th>Giờ vào</th><th>Giờ kết</th><th>Số giờ</th><th>Lương/giờ</th><th>Lương dự tính</th><th>Ghi nhận</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={8}>Chưa có lịch sử ca làm.</td></tr> : rows.map((row) => { const hours = durationHours(row.started_at, row.ended_at, nowIso); return <tr key={row.id}><td><b>{shiftLabel(row)}</b></td><td>{row.shift_code}</td><td>{dateTime24(row.started_at)}</td><td>{row.ended_at ? dateTime24(row.ended_at) : "Đang làm"}</td><td>{hours.toFixed(2)} giờ</td><td>{money(row.hourlyRate)}</td><td>{money(hours * row.hourlyRate)}</td><td>{row.auto_rolled ? <span className="employee-op-auto">Tự động chuyển ca</span> : row.rollover_from ? <span className="employee-op-continuous">Tiếp ca liên tục</span> : row.status}</td></tr>; })}</tbody></table></div></section></div>;
}
