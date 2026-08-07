"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ReceiptText } from "lucide-react";

type EmployeeUser = {
  id: string; name: string; storeId: string | null;
  employeeCode?: string | null; employeePosition?: string | null; employeePhone?: string | null;
  storeName?: string | null; homeStoreName?: string | null; isSupporting?: boolean;
};
type EmployeeOrder = {
  id: string; amount: number; payment_method: "CASH" | "BANK_TRANSFER"; status: string;
};
type ShiftState = {
  active: boolean; shiftCode: string | null; startedAt: string | null;
  shiftName?: string | null; scheduledStart?: string | null; scheduledEnd?: string | null;
};
type ShiftClosePayload = {
  tasksCompleted: boolean; expenseAmount: number; expenseNote: string;
  cashRevenue: number; transferRevenue: number;
};
type TaskRecord = {
  id: string; title: string;
  data: { date?: string; items?: Array<{ content?: string; completedBy?: string[] }> };
};

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value)) + " đ";
const time = (value: string | null) => value
  ? new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value))
  : "--:--";

function legacyShiftName(shiftCode: string | null) {
  const match = shiftCode?.trim().match(/^CA[\s_-]*([1-3])$/i);
  return match ? `CA ${match[1]}` : shiftCode || "CHƯA XẾP CA";
}

const DEFAULT_SHIFT_TASKS = [
  ["Mở cửa hàng, kiểm tra vệ sinh", "Mở cửa đúng giờ, bật đèn, kiểm tra khu vực trưng bày"],
  ["Sắp xếp, trưng bày sản phẩm", "Sắp xếp quần áo, phụ kiện gọn gàng, đẹp mắt"],
  ["Tư vấn & hỗ trợ khách hàng", "Tư vấn sản phẩm, hỗ trợ khách thử đồ"],
  ["Báo cáo doanh thu đầu ca", "Báo cáo doanh thu đầu ca cho quản lý"],
  ["Kiểm tra & báo cáo tồn kho", "Kiểm tra hàng hóa, báo cáo sản phẩm sắp hết"],
  ["Vệ sinh & dọn dẹp cuối ca", "Dọn dẹp khu vực làm việc, sản phẩm gọn gàng"],
] as const;

export function ReferenceEmployeeHome({ user, shift, orders, onShift, tiktok, setTiktok }: {
  user: EmployeeUser;
  shift: ShiftState;
  orders: EmployeeOrder[];
  onShift: (action: "start" | "end", closing?: ShiftClosePayload) => void;
  tiktok: boolean;
  setTiktok: (value: boolean) => void;
}) {
  const activeOrders = orders.filter((order) => order.status === "COMPLETED");
  const orderCash = activeOrders.filter((order) => order.payment_method === "CASH").reduce((sum, order) => sum + order.amount, 0);
  const orderTransfer = activeOrders.filter((order) => order.payment_method === "BANK_TRANSFER").reduce((sum, order) => sum + order.amount, 0);
  const [taskProgress, setTaskProgress] = useState({ done: 0, total: 0 });
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseNote, setExpenseNote] = useState("");
  const [cashRevenue, setCashRevenue] = useState("");
  const [transferRevenue, setTransferRevenue] = useState("");
  const [closingMessage, setClosingMessage] = useState("");
  const [now, setNow] = useState<Date | null>(null);
  const [lastEndedAt, setLastEndedAt] = useState<string | null>(null);
  const previousActive = useRef(shift.active);
  const allTasksDone = taskProgress.total > 0 && taskProgress.done === taskProgress.total;
  const revenueEntered = cashRevenue !== "" && transferRevenue !== "";
  const expenseEntered = expenseAmount !== "";
  const expenseValid = Number(expenseAmount || 0) === 0 || expenseNote.trim().length > 0;
  const canEnd = shift.active && allTasksDone && expenseEntered && revenueEntered && expenseValid;
  const revenueTotal = Number(cashRevenue || 0) + Number(transferRevenue || 0);
  const shiftName = shift.shiftName?.trim() || legacyShiftName(shift.shiftCode);
  const scheduledTime = shift.scheduledStart && shift.scheduledEnd
    ? `${shift.scheduledStart} - ${shift.scheduledEnd}`
    : "Theo lịch phân ca";

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (previousActive.current && !shift.active) {
      setLastEndedAt(new Date().toISOString());
      setClosingMessage("✓ Đã kết ca và ghi nhận vào lịch sử ca làm.");
      setExpenseAmount("");
      setExpenseNote("");
      setCashRevenue("");
      setTransferRevenue("");
    } else if (!previousActive.current && shift.active) {
      setLastEndedAt(null);
      setClosingMessage("");
    }
    previousActive.current = shift.active;
  }, [shift.active]);

  function finishShift() {
    if (!canEnd) {
      setClosingMessage("Hãy hoàn thành toàn bộ công việc, nhập chi phí (nhập 0 nếu không có), tiền mặt, chuyển khoản và nội dung chi nếu có chi phí.");
      return;
    }
    if (revenueTotal > 0 && activeOrders.length === 0) {
      setClosingMessage("Doanh thu lớn hơn 0. Vui lòng nhập ít nhất một đơn hàng trước khi kết ca.");
      return;
    }
    setClosingMessage("");
    onShift("end", {
      tasksCompleted: true,
      expenseAmount: Number(expenseAmount || 0),
      expenseNote: expenseNote.trim(),
      cashRevenue: Number(cashRevenue || 0),
      transferRevenue: Number(transferRevenue || 0),
    });
  }

  return <div className="employee-home-reference">
    <div className="employee-hero-grid">
      <section className="attendance-card">
        <span>ĐIỂM DANH</span>
        <small>{now ? now.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }) : "Đang đồng bộ thời gian..."}</small>
        <strong suppressHydrationWarning>{now ? now.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "--:--:--"}</strong>
        <button className="primary-button" disabled={shift.active} onClick={() => onShift("start")}><CheckCircle2 size={20}/> {shift.active ? "ĐÃ ĐIỂM DANH" : "ĐIỂM DANH"}</button>
        <small>{shift.active ? "Đang làm · " + shiftName : "Chưa điểm danh vào ca làm"}</small>
      </section>
      <section className="info-card">
        <span>THÔNG TIN NHÂN VIÊN</span>
        <p>Mã nhân viên <b>{user.employeeCode ?? "NV"}</b></p>
        <p>Họ và tên <b>{user.name}</b></p>
        <p>Chức vụ <b>{user.employeePosition ?? "Nhân viên"}</b></p>
        <p>Số điện thoại <b>{user.employeePhone ?? "Chưa cập nhật"}</b></p>
        {user.isSupporting && <p>Cửa hàng hỗ trợ <b>{user.storeName ?? "DORE"}</b></p>}
      </section>
      <section className="shift-card">
        <span>CA LÀM VIỆC HÔM NAY</span>
        <div><b>{shiftName.toLocaleUpperCase("vi-VN")}</b><strong>{scheduledTime}</strong></div>
        <p>Giờ vào <b>{time(shift.startedAt)}</b><span>Giờ kết ca <b>{time(lastEndedAt)}</b></span></p>
        <small className={shift.active ? "active-text" : "warning-text"}>{shift.active ? "● Đang trong ca" : "Chưa điểm danh"}</small>
      </section>
    </div>

    <EmployeeTaskChecklist user={user} shiftKey={shift.shiftCode} onProgress={setTaskProgress}/>

    <section className="employee-closing-reference">
      <div className="closing-title"><ReceiptText size={24}/><h2>THÔNG TIN KẾT CA</h2></div>
      <div className="closing-grid">
        <div className="closing-expense">
          <h3>Chi phí trong ca <em>(bắt buộc nhập)</em></h3>
          <label>Số tiền<input type="number" min="0" required placeholder="Nhập 0 nếu không có chi phí" value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)}/></label>
          <label>Nội dung chi<textarea placeholder="Nhập nội dung chi..." value={expenseNote} onChange={(event) => setExpenseNote(event.target.value)}/></label>
          <div className="wage-note">Số giờ làm dự kiến: <b>5 giờ</b><br/>Lương dự kiến: <b>100.000 đ</b> (20.000 đ/giờ)</div>
        </div>
        <div className="closing-revenue">
          <h3>Doanh thu ca <em>(bắt buộc)</em></h3>
          <div className="revenue-inputs">
            <label>Tiền mặt<input type="number" min="0" required placeholder="Nhập số tiền" value={cashRevenue} onChange={(event) => setCashRevenue(event.target.value)}/><small>Theo đơn: {money(orderCash)}</small></label>
            <label>Chuyển khoản<input type="number" min="0" required placeholder="Nhập số tiền" value={transferRevenue} onChange={(event) => setTransferRevenue(event.target.value)}/><small>Theo đơn: {money(orderTransfer)}</small></label>
            <div><span>Tổng tiền</span><b>{money(revenueTotal)}</b><small>{activeOrders.length} đơn trong ca</small></div>
          </div>
          <button className="end-shift-button" disabled={!canEnd} onClick={finishShift}><CheckCircle2 size={19}/> KẾT CA</button>
          {closingMessage && <p className={closingMessage.startsWith("✓") ? "success-banner" : "closing-error"}>{closingMessage}</p>}
          <small className="closing-hint">{!shift.active ? "Bạn chưa bắt đầu ca làm việc" : !allTasksDone ? "Vui lòng hoàn thành tất cả công việc trước khi kết ca" : !expenseEntered ? "Vui lòng nhập chi phí trong ca, nhập 0 nếu không có" : !revenueEntered ? "Vui lòng nhập doanh thu tiền mặt và chuyển khoản" : !expenseValid ? "Vui lòng nhập nội dung chi phí phát sinh" : revenueTotal > 0 && activeOrders.length === 0 ? "Doanh thu lớn hơn 0 cần có ít nhất một đơn hàng" : "Đã đủ điều kiện kết ca"}</small>
        </div>
        <label className="tiktok-box">
          <b>♪ CLIP TIKTOK</b>
          <span>Nếu ca này có làm clip TikTok, vui lòng tick vào ô bên dưới.</span>
          <span><input type="checkbox" checked={tiktok} onChange={(event) => setTiktok(event.target.checked)}/> Ca này có làm clip TikTok</span>
          <small>Phụ cấp TikTok: +25.000 đ</small>
        </label>
      </div>
    </section>
  </div>;
}

function EmployeeTaskChecklist({ user, shiftKey, onProgress }: {
  user: EmployeeUser;
  shiftKey: string | null;
  onProgress: (progress: { done: number; total: number }) => void;
}) {
  const [records, setRecords] = useState<TaskRecord[]>([]);
  const [fallbackDone, setFallbackDone] = useState<boolean[]>(DEFAULT_SHIFT_TASKS.map(() => false));
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const reload = useCallback(async () => {
    const query = new URLSearchParams({ category: "TASKS" });
    if (user.storeId) query.set("storeId", user.storeId);
    const result = await (await fetch("/api/records?" + query)).json();
    setRecords((result.records ?? []).filter((record: TaskRecord) => String(record.data.date ?? "") === day));
  }, [day, user.storeId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!shiftKey) {
      setFallbackDone(DEFAULT_SHIFT_TASKS.map(() => false));
      return;
    }
    try {
      const saved = JSON.parse(window.localStorage.getItem(`dore-shift-tasks:${shiftKey}`) ?? "[]") as boolean[];
      setFallbackDone(DEFAULT_SHIFT_TASKS.map((_, index) => Boolean(saved[index])));
    } catch {
      setFallbackDone(DEFAULT_SHIFT_TASKS.map(() => false));
    }
  }, [shiftKey]);
  const items = records.flatMap((record) => (record.data.items ?? []).map((item, index) => ({ record, item, index })));
  const done = items.length ? items.filter(({ item }) => item.completedBy?.includes(user.id)).length : fallbackDone.filter(Boolean).length;
  const total = items.length || DEFAULT_SHIFT_TASKS.length;
  useEffect(() => { onProgress({ done, total }); }, [done, total, onProgress]);
  async function toggle(recordId: string, index: number) {
    await fetch("/api/records", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: recordId, completedIndex: index }) });
    await reload();
  }
  function toggleFallback(index: number) {
    const next = fallbackDone.map((value, itemIndex) => itemIndex === index ? !value : value);
    setFallbackDone(next);
    if (shiftKey) window.localStorage.setItem(`dore-shift-tasks:${shiftKey}`, JSON.stringify(next));
  }
  return <section className="employee-task-reference">
    <div className="table-head"><h2>✓ CÔNG VIỆC CẦN LÀM</h2><span>{done}/{total} hoàn thành</span></div>
    <div className="employee-task-table">
      <div className="employee-task-head"><b>STT</b><b>Công việc</b><b>Mô tả</b><b>Trạng thái</b></div>
      {items.length ? items.map(({ record, item, index }, row) => <label className="employee-task-item" key={record.id + "-" + index}><span>{row + 1}</span><b>{item.content}</b><small>{record.title}</small><input type="checkbox" checked={Boolean(item.completedBy?.includes(user.id))} onChange={() => toggle(record.id, index)}/></label>) : DEFAULT_SHIFT_TASKS.map((task, index) => <label className="employee-task-item" key={task[0]}><span>{index + 1}</span><b>{task[0]}</b><small>{task[1]}</small><input type="checkbox" checked={fallbackDone[index]} onChange={() => toggleFallback(index)}/></label>)}
    </div>
    <p className="task-completion-note">ⓘ Vui lòng tick hoàn thành tất cả công việc trước khi kết ca.</p>
  </section>;
}
