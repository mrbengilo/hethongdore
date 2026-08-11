import { initDb } from "../../../../db/runtime";
import { getSessionUser, json as responseJson } from "../../_lib/auth";

type AuditRow = {
  id: string;
  orderId: string;
  orderCode: string;
  action: "MANAGER_ORDER_UPDATE" | "MANAGER_ORDER_VOID";
  changedAt: string;
  actorName: string | null;
  actorUsername: string | null;
  employeeName: string | null;
  employeeCode: string | null;
  shiftName: string | null;
  shiftCode: string;
  workDate: string | null;
  currentStatus: string;
  detail: string | null;
};

type OrderSnapshot = {
  customerName: string | null;
  phone: string | null;
  age: number | null;
  amount: number | null;
  paymentMethod: string | null;
  status: string | null;
};

const MAX_PAGE_SIZE = 100;
const ORDER_ACTIONS = ["MANAGER_ORDER_UPDATE", "MANAGER_ORDER_VOID"] as const;

function json(data: unknown, status = 200) {
  return responseJson(data, status, {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "Cookie",
  });
}

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function escapedLike(value: string) {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function orderSnapshot(value: unknown): OrderSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    customerName: nullableString(record.customerName),
    phone: nullableString(record.phone),
    age: nullableNumber(record.age),
    amount: nullableNumber(record.amount),
    paymentMethod: nullableString(record.paymentMethod),
    status: nullableString(record.status),
  };
}

function changeDetail(detail: string | null) {
  if (!detail) return { before: null, after: null };
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    return { before: orderSnapshot(parsed.before), after: orderSnapshot(parsed.after) };
  } catch {
    // A malformed legacy audit must not break the complete history page.
    return { before: null, after: null };
  }
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER" || Number(user.isSuperAdmin) !== 1) {
    return json({ message: "Chỉ quản trị viên cấp cao mới được xem lịch sử đơn hàng." }, 403);
  }

  const params = new URL(request.url).searchParams;
  const storeId = params.get("storeId")?.trim() ?? "";
  const orderId = params.get("orderId")?.trim() ?? "";
  const search = params.get("search")?.trim().slice(0, 100) ?? "";
  const requestedAction = params.get("action")?.trim().toUpperCase() ?? "ALL";
  const action = requestedAction === "UPDATE" ? ORDER_ACTIONS[0]
    : requestedAction === "VOID" ? ORDER_ACTIONS[1]
      : requestedAction === "ALL" ? "" : null;
  const page = positiveInteger(params.get("page"), 1, 1_000_000);
  const pageSize = positiveInteger(params.get("pageSize"), 20, MAX_PAGE_SIZE);
  if (!storeId || storeId.length > 128) return json({ message: "Mã cửa hàng không hợp lệ." }, 400);
  if (orderId.length > 128) return json({ message: "Mã đơn hàng không hợp lệ." }, 400);
  if (action === null) return json({ message: "Loại lịch sử không hợp lệ." }, 400);

  const db = await initDb();
  const store = await db.prepare("SELECT id, name FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(storeId).first<{ id: string; name: string }>();
  if (!store) return json({ message: "Không tìm thấy cửa hàng." }, 404);

  const pattern = escapedLike(search);
  const where = `o.store_id = ?
    AND audit.entity_type = 'ORDER'
    AND audit.action IN ('MANAGER_ORDER_UPDATE', 'MANAGER_ORDER_VOID')
    AND (? = '' OR audit.action = ?)
    AND (? = '' OR audit.entity_id = ?)
    AND (? = '' OR o.code LIKE ? ESCAPE '\\'
      OR COALESCE(actor.name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(actor.username, '') LIKE ? ESCAPE '\\'
      OR COALESCE(employee.name, '') LIKE ? ESCAPE '\\')`;
  const bindings = [storeId, action, action, orderId, orderId, search, pattern, pattern, pattern, pattern] as const;
  const totalRow = await db.prepare(`SELECT COUNT(*) AS count
      FROM audit_logs audit
      JOIN orders o ON o.id = audit.entity_id
      LEFT JOIN users actor ON actor.id = audit.user_id
      LEFT JOIN employees employee ON employee.id = o.employee_id
      WHERE ${where}`)
    .bind(...bindings).first<{ count: number }>();
  const total = Number(totalRow?.count ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const boundedPage = Math.min(page, pages);
  const offset = (boundedPage - 1) * pageSize;
  const rows = await db.prepare(`SELECT
      audit.id, audit.entity_id AS orderId, o.code AS orderCode, audit.action,
      audit.created_at AS changedAt, actor.name AS actorName, actor.username AS actorUsername,
      employee.name AS employeeName, employee.code AS employeeCode,
      shift.shift_name AS shiftName, o.shift_code AS shiftCode, shift.work_date AS workDate,
      o.status AS currentStatus, audit.detail
    FROM audit_logs audit
    JOIN orders o ON o.id = audit.entity_id
    LEFT JOIN users actor ON actor.id = audit.user_id
    LEFT JOIN employees employee ON employee.id = o.employee_id
    LEFT JOIN shift_sessions shift ON shift.shift_code = o.shift_code
      AND shift.employee_id = o.employee_id AND shift.store_id = o.store_id
    WHERE ${where}
    ORDER BY audit.created_at DESC, audit.id DESC
    LIMIT ? OFFSET ?`)
    .bind(...bindings, pageSize, offset).all<AuditRow>();

  return json({
    store,
    rows: rows.results.map(({ detail, ...row }) => ({ ...row, change: changeDetail(detail) })),
    pagination: { page: boundedPage, pageSize, total, pages },
  });
}
