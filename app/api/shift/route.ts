import { initDb, writeAudit } from "../../../db/runtime";
import { durationMinutes, durationSeconds, formatVnd, isVnd, tenderDifferences, utcTimestamp } from "../../lib/finance";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";

type ScheduleSnapshot = {
  name: string;
  start: string;
  end: string;
  workDate: string;
};

type ScheduleData = {
  date?: string;
  shiftName?: string;
  start?: string;
  end?: string;
  employeeIds?: string[];
};

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
}

function localMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function isInsideShift(start: string, end: string, minute: number) {
  const from = timeMinutes(start);
  const to = timeMinutes(end);
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

function supportShiftLabel(schedule: ScheduleSnapshot) {
  const numbered = schedule.name.match(/(?:^|\s)([1-3])(?:\s|$)/)?.[1];
  if (numbered === "1") return "Ca sáng";
  if (numbered === "2") return "Ca chiều";
  if (numbered === "3") return "Ca tối";
  const start = timeMinutes(schedule.start);
  return start < 12 * 60 ? "Ca sáng" : start < 18 * 60 ? "Ca chiều" : "Ca tối";
}

async function resolveSchedule(db: Awaited<ReturnType<typeof initDb>>, storeId: string, employeeId: string): Promise<ScheduleSnapshot> {
  const workDate = localDate();
  const minute = localMinutes();
  const scheduled = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
    .bind(storeId).all<{ dataJson: string }>();
  const candidates = scheduled.results.flatMap((row) => {
    try {
      const data = JSON.parse(row.dataJson) as ScheduleData;
      return data.date === workDate && data.employeeIds?.includes(employeeId) && data.shiftName && data.start && data.end ? [data] : [];
    } catch { return []; }
  });
  const matched = candidates.find((item) => isInsideShift(item.start!, item.end!, minute)) ?? candidates[0];
  if (matched) return { name: matched.shiftName!, start: matched.start!, end: matched.end!, workDate };

  // Safe fallback for stores that have not configured a schedule yet.
  const defaults = [
    { name: "Ca 1", start: "07:00", end: "12:00" },
    { name: "Ca 2", start: "12:00", end: "17:00" },
    { name: "Ca 3", start: "17:00", end: "23:59" },
  ];
  const fallback = defaults.find((item) => isInsideShift(item.start, item.end, minute)) ?? defaults[0];
  return { ...fallback, workDate };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  return json({
    active: Boolean(user.shiftActive),
    shiftCode: user.currentShift,
    startedAt: user.shiftStartedAt,
    shiftName: user.currentShiftName,
    scheduledStart: user.scheduledStart,
    scheduledEnd: user.scheduledEnd,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Không có quyền" }, 403);
  if (!await isStoreActive(user.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const body = await request.json().catch(() => ({})) as {
    action?: "start" | "end";
    tiktok?: boolean;
    tasksCompleted?: boolean;
    expenseAmount?: number;
    expenseNote?: string;
    cashRevenue?: number;
    transferRevenue?: number;
  };
  const db = await initDb();

  if (body.action === "start") {
    if (!user.storeId || !user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên và cửa hàng." }, 409);
    if (user.shiftActive) return json({ message: "Bạn đã có một ca đang hoạt động." }, 409);
    const schedule = await resolveSchedule(db, user.storeId, user.employeeId);
    const shiftCode = `CA-${schedule.workDate}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const startedAt = utcTimestamp();
    const transfer = user.activeTransferId
      ? await db.prepare("SELECT support_hourly_rate AS rate, shifts_json AS shiftsJson FROM employee_transfers WHERE id = ? AND status IN ('SCHEDULED', 'ACTIVE') LIMIT 1")
        .bind(user.activeTransferId).first<{ rate: number; shiftsJson: string }>()
      : null;
    if (transfer) {
      let allowedShifts: string[] = [];
      try { allowedShifts = JSON.parse(transfer.shiftsJson) as string[]; } catch { allowedShifts = []; }
      const currentLabel = supportShiftLabel(schedule);
      if (!allowedShifts.includes("Cả ngày") && !allowedShifts.includes(currentLabel)) {
        return json({ message: `Điều chuyển hỗ trợ không áp dụng cho ${currentLabel}. Vui lòng kiểm tra lịch đã được duyệt.` }, 403);
      }
    }
    const supportRate = transfer?.rate ?? null;
    const employeeRate = (await db.prepare("SELECT hourly_rate AS rate FROM employees WHERE id = ? LIMIT 1").bind(user.employeeId).first<{ rate: number }>())?.rate ?? 0;
    const appliedHourlyRate = Number(supportRate ?? employeeRate);
    await db.batch([
      db.prepare("UPDATE users SET shift_active = 1, current_shift = ?, shift_started_at = ? WHERE id = ? AND shift_active = 0").bind(shiftCode, startedAt, user.id),
      db.prepare("INSERT INTO shift_sessions (id, shift_code, store_id, employee_id, shift_name, scheduled_start, scheduled_end, work_date, transfer_id, applied_hourly_rate, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')")
        .bind(crypto.randomUUID(), shiftCode, user.storeId, user.employeeId, schedule.name, schedule.start, schedule.end, schedule.workDate, user.activeTransferId, appliedHourlyRate, startedAt),
    ]);
    await writeAudit(user.id, "SHIFT_START", "SHIFT", shiftCode, JSON.stringify({ storeId: user.storeId, transferId: user.activeTransferId, shiftName: schedule.name }));
    return json({ active: true, shiftCode, startedAt, shiftName: schedule.name, scheduledStart: schedule.start, scheduledEnd: schedule.end });
  }

  if (body.action === "end") {
    if (!user.shiftActive || !user.currentShift || !user.employeeId) return json({ message: "Bạn chưa bắt đầu ca làm việc." }, 409);
    const activeSession = await db.prepare("SELECT id, store_id AS storeId, work_date AS workDate, shift_name AS shiftName, started_at AS startedAt FROM shift_sessions WHERE shift_code = ? AND employee_id = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(user.currentShift, user.employeeId).first<{ id: string; storeId: string; workDate: string | null; shiftName: string | null; startedAt: string }>();
    if (!activeSession) return json({ message: "Không tìm thấy phiên ca đang hoạt động. Vui lòng tải lại trang hoặc liên hệ quản lý." }, 409);
    if (!body.tasksCompleted) return json({ message: "Bạn phải hoàn thành tất cả công việc trước khi kết ca." }, 400);
    if (body.expenseAmount === undefined || body.expenseAmount === null || body.cashRevenue === undefined || body.cashRevenue === null || body.transferRevenue === undefined || body.transferRevenue === null) {
      return json({ message: "Vui lòng nhập chi phí, tiền mặt và chuyển khoản trước khi kết ca (nhập 0 nếu không phát sinh)." }, 400);
    }
    const expenseAmount = Number(body.expenseAmount);
    const cashRevenue = Number(body.cashRevenue);
    const transferRevenue = Number(body.transferRevenue);
    if (![expenseAmount, cashRevenue, transferRevenue].every((value) => isVnd(value) && value >= 0)) return json({ message: "Doanh thu và chi phí phải là số nguyên VND không âm." }, 400);
    if (expenseAmount > 0 && !body.expenseNote?.trim()) return json({ message: "Vui lòng nhập nội dung chi phí phát sinh." }, 400);

    // Verify persisted manager-assigned tasks whenever they exist. The client flag
    // remains the fallback for stores still using the default checklist.
    const taskRows = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'TASKS' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC")
      .bind(activeSession.storeId).all<{ dataJson: string }>();
    const assignedItems = taskRows.results.flatMap((row) => {
      try {
        const data = JSON.parse(row.dataJson) as { date?: string; shift?: string; items?: Array<{ completedBy?: string[] }> };
        const dateMatches = !data.date || data.date === (activeSession.workDate ?? localDate());
        const shiftMatches = !data.shift || !activeSession.shiftName || data.shift.toLocaleLowerCase("vi-VN").includes(activeSession.shiftName.toLocaleLowerCase("vi-VN"));
        return dateMatches && shiftMatches ? (data.items ?? []) : [];
      } catch { return []; }
    });
    if (assignedItems.some((item) => !item.completedBy?.includes(user.id))) return json({ message: "Bạn phải hoàn thành tất cả công việc được giao trước khi kết ca." }, 400);

    const orderRows = await db.prepare(`
      SELECT payment_method AS paymentMethod, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
      FROM orders
      WHERE store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'
      GROUP BY payment_method
    `).bind(activeSession.storeId, user.employeeId, user.currentShift)
      .all<{ paymentMethod: string; count: number; amount: number }>();
    const orderCount = orderRows.results.reduce((total, row) => total + Number(row.count), 0);
    const expectedTender = orderRows.results.reduce((totals, row) => {
      if (row.paymentMethod === "CASH") totals.cash += Number(row.amount);
      if (row.paymentMethod === "BANK_TRANSFER") totals.bankTransfer += Number(row.amount);
      return totals;
    }, { cash: 0, bankTransfer: 0 });
    if (cashRevenue + transferRevenue > 0 && orderCount === 0) {
      return json({ message: "Doanh thu lớn hơn 0. Vui lòng nhập ít nhất một đơn hàng trước khi kết ca." }, 400);
    }
    const enteredTender = { cash: cashRevenue, bankTransfer: transferRevenue };
    const differences = tenderDifferences(expectedTender, enteredTender);
    if (differences.cash !== 0 || differences.bankTransfer !== 0) {
      return json({
        message: [
          "Đối soát doanh thu chưa khớp với đơn hàng trong ca.",
          `Tiền mặt: đơn hàng ${formatVnd(expectedTender.cash)}, đã nhập ${formatVnd(enteredTender.cash)}, chênh lệch ${formatVnd(differences.cash)}.`,
          `Chuyển khoản: đơn hàng ${formatVnd(expectedTender.bankTransfer)}, đã nhập ${formatVnd(enteredTender.bankTransfer)}, chênh lệch ${formatVnd(differences.bankTransfer)}.`,
        ].join(" "),
        reconciliation: { expected: expectedTender, entered: enteredTender, differences, orderCount },
      }, 409);
    }

    const allowance = body.tiktok ? 25000 : 0;
    const endedAt = utcTimestamp();
    const workedSeconds = durationSeconds(activeSession.startedAt, endedAt);
    const workedMinutes = durationMinutes(workedSeconds);
    await db.batch([
      db.prepare("UPDATE shift_sessions SET ended_at = ?, duration_seconds = ?, tiktok = ?, tiktok_allowance = ?, tasks_completed = 1, expense_amount = ?, expense_note = ?, cash_revenue = ?, transfer_revenue = ?, status = 'COMPLETED' WHERE id = ? AND status = 'ACTIVE'")
        .bind(endedAt, workedSeconds, body.tiktok ? 1 : 0, allowance, expenseAmount, body.expenseNote?.trim() || null, cashRevenue, transferRevenue, activeSession.id),
      db.prepare("UPDATE stores SET revenue = revenue + ?, expense = expense + ? WHERE id = ?")
        .bind(cashRevenue + transferRevenue, expenseAmount, activeSession.storeId),
      db.prepare("UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = ? AND current_shift = ?").bind(user.id, user.currentShift),
    ]);
    await writeAudit(user.id, "SHIFT_END", "SHIFT", user.currentShift, JSON.stringify({ tiktok: Boolean(body.tiktok), expenseAmount, cashRevenue, transferRevenue, orderCount, workedSeconds, workedMinutes }));
    return json({
      active: false,
      endedAt,
      message: "Đã kết ca và ghi nhận lịch sử ca làm.",
      tiktokAllowance: allowance,
      expenseAmount,
      cashRevenue,
      transferRevenue,
      totalRevenue: cashRevenue + transferRevenue,
      workedSeconds,
      workedMinutes,
    });
  }

  return json({ message: "Thao tác không hợp lệ." }, 400);
}
