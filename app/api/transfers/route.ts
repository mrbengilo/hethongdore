import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  managerHasGlobalStoreAccess,
} from "../_lib/manager-scope";

const validShifts = new Set(["Ca sáng", "Ca chiều", "Ca tối", "Cả ngày"]);

type TransferBody = {
  id?: string;
  action?: "CANCEL" | "END";
  employeeId?: string;
  targetStoreId?: string;
  startDate?: string;
  endDate?: string;
  shifts?: string[];
  supportHourlyRate?: number | string;
  supportAllowance?: number | string;
  reason?: string;
};

type TransferRow = Record<string, unknown> & {
  id: string;
  status: string;
  shifts_json: string;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string) {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

function parseTransfer(row: TransferRow) {
  let shifts: string[] = [];
  try {
    const parsed = JSON.parse(row.shifts_json);
    shifts = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    shifts = [];
  }
  return { ...row, shifts };
}

async function reconcileStatuses() {
  const db = await initDb();
  const day = localDate();
  const now = new Date().toISOString();
  const expiring = await db.prepare("SELECT id FROM employee_transfers WHERE status IN ('SCHEDULED', 'ACTIVE') AND end_date < ?").bind(day).all<{ id: string }>();
  const activating = await db.prepare(`SELECT t.id FROM employee_transfers t
    JOIN employees e ON e.id = t.employee_id AND e.status = 'ACTIVE'
    WHERE t.status = 'SCHEDULED' AND t.start_date <= ? AND t.end_date >= ?`).bind(day, day).all<{ id: string }>();
  if (expiring.results.length) {
    await db.prepare("UPDATE employee_transfers SET status = 'COMPLETED', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE status IN ('SCHEDULED', 'ACTIVE') AND end_date < ?").bind(now, now, day).run();
  }
  if (activating.results.length) {
    await db.prepare(`UPDATE employee_transfers SET status = 'ACTIVE', updated_at = ?
      WHERE status = 'SCHEDULED' AND start_date <= ? AND end_date >= ?
        AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_transfers.employee_id AND e.status = 'ACTIVE')`).bind(now, day, day).run();
  }
  for (const item of expiring.results) await writeAudit(null, "TRANSFER_AUTO_COMPLETE", "EMPLOYEE_TRANSFER", item.id, `date=${day}`);
  for (const item of activating.results) await writeAudit(null, "TRANSFER_AUTO_ACTIVATE", "EMPLOYEE_TRANSFER", item.id, `date=${day}`);
  return db;
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const db = await reconcileStatuses();
  const statement = db.prepare(`
    SELECT t.*,
      e.code AS employee_code, e.name AS employee_name, e.position AS employee_position,
      source.name AS source_store_name, target.name AS target_store_name,
      creator.name AS created_by_name
    FROM employee_transfers t
    JOIN employees e ON e.id = t.employee_id
    JOIN stores source ON source.id = t.source_store_id
    JOIN stores target ON target.id = t.target_store_id
    LEFT JOIN users creator ON creator.id = t.created_by
    ${managerHasGlobalStoreAccess(user) ? "" : "WHERE t.source_store_id = ?"}
    ORDER BY t.created_at DESC
    LIMIT 300
  `);
  const result = managerHasGlobalStoreAccess(user)
    ? await statement.all<TransferRow>()
    : user.homeStoreId
      ? await statement.bind(user.homeStoreId).all<TransferRow>()
      : { results: [] as TransferRow[] };
  return json({ transfers: result.results.map(parseTransfer) });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as TransferBody;
  const startDate = body.startDate?.trim() ?? "";
  const endDate = body.endDate?.trim() ?? "";
  const shifts = Array.isArray(body.shifts) ? [...new Set(body.shifts.map((item) => item.trim()).filter(Boolean))] : [];
  const supportHourlyRate = Number(body.supportHourlyRate);
  const supportAllowance = Number(body.supportAllowance ?? 0);
  const reason = body.reason?.trim() ?? "";

  if (!body.employeeId || !body.targetStoreId || !validDate(startDate) || !validDate(endDate)) {
    return json({ message: "Vui lòng nhập đầy đủ nhân viên, cửa hàng và thời gian điều chuyển." }, 400);
  }
  if (endDate < startDate) return json({ message: "Ngày kết thúc không được trước ngày bắt đầu." }, 400);
  if (endDate < localDate()) return json({ message: "Không thể tạo một đợt điều chuyển đã hết hạn." }, 400);
  if (shifts.length === 0 || shifts.some((item) => !validShifts.has(item)) || (shifts.includes("Cả ngày") && shifts.length > 1)) {
    return json({ message: "Vui lòng chọn ca làm việc hợp lệ." }, 400);
  }
  if (!Number.isSafeInteger(supportHourlyRate) || supportHourlyRate <= 0) return json({ message: "Lương hỗ trợ theo giờ phải là số nguyên an toàn lớn hơn 0." }, 400);
  if (!Number.isSafeInteger(supportAllowance) || supportAllowance < 0) return json({ message: "Phụ cấp hỗ trợ phải là số nguyên an toàn không âm." }, 400);
  if (!reason) return json({ message: "Vui lòng nhập lý do điều chuyển." }, 400);

  const db = await initDb();
  const employee = await db.prepare("SELECT id, store_id, status FROM employees WHERE id = ? AND status = 'ACTIVE'").bind(body.employeeId).first<{ id: string; store_id: string; status: string }>();
  if (!employee) return json({ message: "Không tìm thấy nhân viên đang hoạt động." }, 404);
  if (!managerCanAccessStore(user, employee.store_id) || !managerCanAccessStore(user, body.targetStoreId)) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  if (!await isStoreActive(employee.store_id)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (employee.store_id === body.targetStoreId) return json({ message: "Cửa hàng nhận hỗ trợ phải khác cửa hàng chính của nhân viên." }, 400);
  const target = await db.prepare("SELECT id FROM stores WHERE id = ? AND status = 'ACTIVE'").bind(body.targetStoreId).first<{ id: string }>();
  if (!target) return json({ message: "Cửa hàng nhận hỗ trợ không tồn tại hoặc đã ngừng hoạt động." }, 404);
  const overlap = await db.prepare(`
    SELECT id FROM employee_transfers
    WHERE employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE')
      AND start_date <= ? AND end_date >= ?
    LIMIT 1
  `).bind(employee.id, endDate, startDate).first<{ id: string }>();
  if (overlap) return json({ message: "Nhân viên đã có lịch điều chuyển trùng với khoảng thời gian này." }, 409);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const day = localDate();
  const status = startDate <= day && endDate >= day ? "ACTIVE" : "SCHEDULED";
  const insert = await db.prepare(`
    INSERT INTO employee_transfers (
      id, employee_id, source_store_id, target_store_id, start_date, end_date,
      shifts_json, support_hourly_rate, support_allowance, reason, status,
      created_by, created_at, updated_at, ended_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
    WHERE EXISTS (SELECT 1 FROM employees e WHERE e.id = ? AND e.store_id = ? AND e.status = 'ACTIVE')
      AND NOT EXISTS (
        SELECT 1 FROM employee_transfers t
        WHERE t.employee_id = ? AND t.status IN ('SCHEDULED', 'ACTIVE')
          AND t.start_date <= ? AND t.end_date >= ?
      )
  `).bind(
    id, employee.id, employee.store_id, body.targetStoreId, startDate, endDate,
    JSON.stringify(shifts), supportHourlyRate, supportAllowance, reason, status,
    user.id, now, now,
    employee.id, employee.store_id, employee.id, endDate, startDate,
  ).run();
  if (affectedRows(insert) === 0) {
    const current = await db.prepare("SELECT status FROM employees WHERE id = ? LIMIT 1")
      .bind(employee.id).first<{ status: string }>();
    return json({ message: current?.status !== "ACTIVE"
      ? "Nhân viên vừa chuyển sang ngưng làm việc, không thể tạo lịch hỗ trợ."
      : "Nhân viên vừa có lịch điều chuyển trùng thời gian. Vui lòng tải lại và kiểm tra." }, 409);
  }
  await writeAudit(user.id, "TRANSFER_CREATE", "EMPLOYEE_TRANSFER", id, JSON.stringify({
    employeeId: employee.id,
    sourceStoreId: employee.store_id,
    targetStoreId: body.targetStoreId,
    startDate,
    endDate,
    shifts,
    supportHourlyRate,
    supportAllowance,
    status,
  }));
  return json({ id, status, message: status === "ACTIVE" ? "Đã điều chuyển và kích hoạt quyền hỗ trợ." : "Đã lên lịch điều chuyển." }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as TransferBody;
  if (!body.id || !body.action || !["CANCEL", "END"].includes(body.action)) return json({ message: "Thao tác không hợp lệ." }, 400);
  const db = await initDb();
  const transfer = await db.prepare("SELECT id, status, source_store_id AS sourceStoreId, target_store_id AS targetStoreId FROM employee_transfers WHERE id = ?")
    .bind(body.id).first<{ id: string; status: string; sourceStoreId: string; targetStoreId: string }>();
  if (!transfer) return json({ message: "Không tìm thấy lịch điều chuyển." }, 404);
  if (!managerCanAccessStore(user, transfer.sourceStoreId) || !managerCanAccessStore(user, transfer.targetStoreId)) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  if (["COMPLETED", "CANCELLED"].includes(transfer.status)) return json({ message: "Lịch điều chuyển đã kết thúc và không thể thay đổi." }, 409);
  const nextStatus = body.action === "CANCEL" ? "CANCELLED" : "COMPLETED";
  const now = new Date().toISOString();
  await db.prepare("UPDATE employee_transfers SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? AND source_store_id = ? AND target_store_id = ? AND status IN ('SCHEDULED', 'ACTIVE')")
    .bind(nextStatus, now, now, body.id, transfer.sourceStoreId, transfer.targetStoreId).run();
  await writeAudit(user.id, body.action === "CANCEL" ? "TRANSFER_CANCEL" : "TRANSFER_END", "EMPLOYEE_TRANSFER", body.id, `from=${transfer.status};to=${nextStatus}`);
  return json({ ok: true, status: nextStatus });
}
