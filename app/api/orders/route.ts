import { initDb, writeAudit } from "../../../db/runtime";
import { reserveStoreOrderCodePrefix } from "../../../db/order-code-prefix";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json, sha256 } from "../_lib/auth";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";
import { storePeriodUnlockedSql } from "../_lib/store-period-lock";

type OrderRow = {
  id: string;
  code: string;
  employeeName: string;
  clientRequestFingerprint?: string | null;
};

type ManagerOrderSnapshot = {
  id: string;
  code: string;
  storeId: string;
  employeeId: string;
  shiftCode: string;
  customerName: string | null;
  phone: string | null;
  age: number | null;
  amount: number;
  paymentMethod: string;
  status: string;
  shiftSessionId: string;
  shiftStatus: string;
  period: string;
};

type CreateOrderBody = {
  customerName?: string;
  phone?: string;
  age?: number | string;
  amount?: number | string;
  paymentMethod?: string;
  clientRequestId?: string;
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const orderPeriodSql = "COALESCE(NULLIF(substr(s.work_date, 1, 7), ''), strftime('%Y-%m', s.started_at, '+7 hours'))";
const unlockedOrderPeriodSql = storePeriodUnlockedSql("o.store_id", orderPeriodSql);
const activeShiftPeriodSql = "COALESCE(NULLIF(substr(active_shift.work_date, 1, 7), ''), strftime('%Y-%m', active_shift.started_at, '+7 hours'))";
const unlockedActiveShiftPeriodSql = storePeriodUnlockedSql("active_shift.store_id", activeShiftPeriodSql);

const managerOrderSelectSql = `SELECT
    o.*,
    e.name AS employeeName,
    e.code AS employeeCode,
    e.name AS createdByName,
    e.code AS createdByCode,
    s.id AS shiftSessionId,
    s.shift_name AS shiftName,
    s.scheduled_start AS scheduledStart,
    s.scheduled_end AS scheduledEnd,
    s.work_date AS workDate,
    s.started_at AS shiftStartedAt,
    s.ended_at AS shiftEndedAt,
    s.status AS shiftStatus,
    ${orderPeriodSql} AS period,
    CASE WHEN s.id IS NOT NULL AND ${unlockedOrderPeriodSql} THEN 0 ELSE 1 END AS locked,
    (SELECT audit.action FROM audit_logs audit
      WHERE audit.entity_type = 'ORDER' AND audit.entity_id = o.id
        AND audit.action IN ('MANAGER_ORDER_UPDATE', 'MANAGER_ORDER_VOID')
      ORDER BY audit.created_at DESC, audit.id DESC LIMIT 1) AS lastAction,
    (SELECT audit.created_at FROM audit_logs audit
      WHERE audit.entity_type = 'ORDER' AND audit.entity_id = o.id
        AND audit.action IN ('MANAGER_ORDER_UPDATE', 'MANAGER_ORDER_VOID')
      ORDER BY audit.created_at DESC, audit.id DESC LIMIT 1) AS lastUpdatedAt,
    (SELECT manager.name FROM audit_logs audit LEFT JOIN users manager ON manager.id = audit.user_id
      WHERE audit.entity_type = 'ORDER' AND audit.entity_id = o.id
        AND audit.action IN ('MANAGER_ORDER_UPDATE', 'MANAGER_ORDER_VOID')
      ORDER BY audit.created_at DESC, audit.id DESC LIMIT 1) AS lastUpdatedBy
  FROM orders o
  LEFT JOIN employees e ON e.id = o.employee_id
  LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.employee_id = o.employee_id AND s.store_id = o.store_id`;

const activeOrderCreationGuardSql = `EXISTS (
  SELECT 1
  FROM users actor
  JOIN shift_sessions active_shift
    ON active_shift.shift_code = actor.current_shift
    AND active_shift.employee_id = actor.employee_id
  JOIN stores active_store ON active_store.id = active_shift.store_id
  WHERE actor.id = ?
    AND actor.role = 'EMPLOYEE'
    AND actor.shift_active = 1
    AND actor.current_shift = ?
    AND actor.employee_id = ?
    AND active_shift.store_id = ?
    AND active_shift.status = 'ACTIVE'
    AND active_store.status = 'ACTIVE'
    AND active_store.name = ?
    AND ${unlockedActiveShiftPeriodSql}
    AND ? BETWEEN 1 AND 9007199254740991 - COALESCE((
      SELECT SUM(existing_order.amount) FROM orders existing_order
      WHERE existing_order.store_id = active_shift.store_id
        AND existing_order.employee_id = active_shift.employee_id
        AND existing_order.shift_code = active_shift.shift_code
        AND existing_order.status = 'COMPLETED'
    ), 0)
)`;

async function findRequestOrder(db: D1Database, employeeId: string, clientRequestId: string) {
  return db.prepare("SELECT id, code, client_request_fingerprint AS clientRequestFingerprint FROM orders WHERE employee_id = ? AND client_request_id = ? LIMIT 1")
    .bind(employeeId, clientRequestId).first<OrderRow>();
}

function replayResponse(existing: OrderRow, fingerprint: string) {
  if (existing.clientRequestFingerprint !== fingerprint) {
    return json({ message: "Khóa gửi đơn đã được dùng cho một nội dung khác. Vui lòng tạo lại đơn." }, 409);
  }
  return json({ id: existing.id, code: existing.code, replayed: true });
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  let result;
  if (user.role === "MANAGER") {
    const params = new URL(request.url).searchParams;
    const scope = resolveManagerStoreScope(user, params.get("storeId"));
    if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
    const storeId = scope.storeId ?? "";
    const orderId = params.get("orderId");
    const period = params.get("period")?.trim() ?? "";
    if (period && !PERIOD_PATTERN.test(period)) return json({ message: "Kỳ đơn hàng không hợp lệ." }, 400);
    if (storeId) {
      const store = await db.prepare("SELECT id FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
        .bind(storeId).first<{ id: string }>();
      if (!store) return json({ message: "Cửa hàng không tồn tại." }, 404);
    }
    result = storeId
      ? await db.prepare(`${managerOrderSelectSql}
          WHERE o.store_id = ? AND (? = '' OR ${orderPeriodSql} = ?)
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT CASE WHEN ? = '' THEN 500 ELSE -1 END`).bind(storeId, period, period, period).all<OrderRow>()
      : await db.prepare(`${managerOrderSelectSql}
          WHERE (? = '' OR ${orderPeriodSql} = ?)
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT CASE WHEN ? = '' THEN 500 ELSE -1 END`).bind(period, period, period).all<OrderRow>();
    // A notification can point to an order outside the selected period or
    // older than the unfiltered safety limit.
    // overview. Include that exact order without widening the whole query.
    if (orderId && !result.results.some((order) => order.id === orderId)) {
      const focused = storeId
        ? await db.prepare(`${managerOrderSelectSql} WHERE o.id = ? AND o.store_id = ? LIMIT 1`).bind(orderId, storeId).first<OrderRow>()
        : await db.prepare(`${managerOrderSelectSql} WHERE o.id = ? LIMIT 1`).bind(orderId).first<OrderRow>();
      if (focused) result.results.unshift(focused);
    }
  } else if (user.shiftActive && user.currentShift) {
    result = await db.prepare("SELECT o.*, e.name AS employeeName FROM orders o JOIN employees e ON e.id = o.employee_id WHERE o.store_id = ? AND o.employee_id = ? AND o.shift_code = ? ORDER BY o.created_at DESC")
      .bind(user.storeId, user.employeeId, user.currentShift).all();
  } else {
    return json({ orders: [], active: false, message: "Bạn chưa bắt đầu ca làm việc" });
  }
  return json({ orders: result.results, active: Boolean(user.shiftActive) });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE") return json({ message: "Chỉ nhân viên mới tạo đơn trong ca." }, 403);
  if (!user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên." }, 409);
  const body = await request.json().catch(() => ({})) as CreateOrderBody;
  const headerRequestId = request.headers.get("Idempotency-Key")?.trim() || null;
  const bodyRequestId = body.clientRequestId?.trim() || null;
  if (headerRequestId && bodyRequestId && headerRequestId !== bodyRequestId) {
    return json({ message: "Khóa gửi đơn trong tiêu đề và nội dung không khớp." }, 400);
  }
  const clientRequestId = headerRequestId ?? bodyRequestId;
  if (!clientRequestId || !REQUEST_ID_PATTERN.test(clientRequestId)) {
    return json({ message: "Thiếu khóa gửi đơn hợp lệ. Vui lòng tải lại trang và thử lại." }, 400);
  }
  const amount = Number(body.amount);
  const age = body.age === "" || body.age == null ? null : Number(body.age);
  if (!Number.isSafeInteger(amount) || amount <= 0) return json({ message: "Giá trị đơn hàng phải là số nguyên VND an toàn và lớn hơn 0." }, 400);
  if (age != null && (!Number.isInteger(age) || age < 1 || age > 120)) return json({ message: "Tuổi không hợp lệ." }, 400);
  if (!['CASH', 'BANK_TRANSFER'].includes(body.paymentMethod ?? "")) return json({ message: "Hình thức thanh toán không hợp lệ." }, 400);
  const customerName = body.customerName?.trim() || null;
  const phone = body.phone?.trim() || null;
  const fingerprint = await sha256(JSON.stringify({ customerName, phone, age, amount, paymentMethod: body.paymentMethod }));
  const db = await initDb();
  const existing = await findRequestOrder(db, user.employeeId, clientRequestId);
  if (existing) return replayResponse(existing, fingerprint);
  // Replay lookup intentionally precedes shift/store checks: a client retry
  // after the original transaction committed must remain idempotent even if
  // the employee has just closed the shift in another tab.
  if (!await isStoreActive(user.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (!user.shiftActive || !user.currentShift || !user.storeId) return json({ message: "Bạn chưa bắt đầu ca làm việc" }, 409);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const store = await db.prepare("SELECT name FROM stores WHERE id = ? AND status = 'ACTIVE' LIMIT 1")
    .bind(user.storeId).first<{ name: string }>();
  if (!store) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  let codePrefix: string;
  try {
    codePrefix = await reserveStoreOrderCodePrefix(db, user.storeId, store.name, createdAt);
  } catch (error) {
    console.error("Unable to reserve an immutable store order-code prefix", error);
    return json({ message: "Không thể cấp tiền tố mã đơn cho cửa hàng. Vui lòng thử lại." }, 500);
  }
  const amountLabel = new Intl.NumberFormat("en-US").format(amount);
  let createdOrder: OrderRow | null = null;
  try {
    const [, orderInsert, , createdOrderResult] = await db.batch([
      // Allocate within the store's own sequence while this exact request still
      // has an active employee/store/shift. The lazy seed only examines this
      // store's existing codes with the same prefix; every historical code is
      // left byte-for-byte unchanged. D1 batch and the SQLite adapter serialize
      // this upsert, so concurrent requests cannot receive the same suffix.
      db.prepare(`INSERT INTO store_order_code_sequences (store_id, code_prefix, last_value, updated_at)
        SELECT ?, ?, COALESCE((
          SELECT MAX(CAST(substr(existing_order.code, length(?) + 2) AS INTEGER))
          FROM orders existing_order
          WHERE existing_order.store_id = ?
            AND substr(existing_order.code, 1, length(?) + 1) = ? || '-'
            AND substr(existing_order.code, length(?) + 2) <> ''
            AND substr(existing_order.code, length(?) + 2) NOT GLOB '*[^0-9]*'
        ), 0) + 1, ?
        WHERE NOT EXISTS (SELECT 1 FROM orders duplicate_request WHERE duplicate_request.employee_id = ? AND duplicate_request.client_request_id = ?)
          AND ${activeOrderCreationGuardSql}
        ON CONFLICT(store_id) DO UPDATE SET
          last_value = MAX(store_order_code_sequences.last_value + 1, excluded.last_value),
          updated_at = excluded.updated_at`)
        .bind(
          user.storeId, codePrefix,
          codePrefix, user.storeId, codePrefix, codePrefix, codePrefix, codePrefix,
          createdAt,
          user.employeeId, clientRequestId,
          user.id, user.currentShift, user.employeeId, user.storeId, store.name, amount,
        ),
      // Read the freshly allocated store value in the same atomic batch. A
      // rejected order or any later statement failure rolls allocation back.
      db.prepare(`INSERT INTO orders (id, code, store_id, employee_id, shift_code, customer_name, phone, age, amount, payment_method, status, client_request_id, client_request_fingerprint, created_at)
        SELECT ?, printf('%s-%05d', sequence.code_prefix, sequence.last_value), ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?
        FROM store_order_code_sequences sequence
        WHERE sequence.store_id = ?
          AND sequence.code_prefix = ?
          AND NOT EXISTS (SELECT 1 FROM orders duplicate_request WHERE duplicate_request.employee_id = ? AND duplicate_request.client_request_id = ?)
          AND ${activeOrderCreationGuardSql}`)
        .bind(
          id, user.storeId, user.employeeId, user.currentShift, customerName, phone, age, amount,
          body.paymentMethod, clientRequestId, fingerprint, createdAt,
          user.storeId, codePrefix,
          user.employeeId, clientRequestId,
          user.id, user.currentShift, user.employeeId, user.storeId, store.name, amount,
        ),
      db.prepare(`INSERT INTO notifications (id, recipient_user_id, store_id, type, entity_type, entity_id, title, message, data_json, read_at, created_at)
        SELECT 'new-order:' || created_order.id || ':' || u.id, u.id, created_order.store_id,
          'NEW_ORDER', 'ORDER', created_order.id,
          'Đơn hàng mới ' || created_order.code,
          ? || ' vừa tạo đơn ' || created_order.code || ' trị giá ' || ? || ' đồng.',
          json_object('orderId', created_order.id, 'orderCode', created_order.code, 'storeId', created_order.store_id),
          NULL, ?
        FROM orders created_order
        JOIN users u ON u.role = 'MANAGER'
        WHERE created_order.id = ?
          AND (COALESCE(u.is_super_admin, 0) = 1 OR u.store_id IS NULL OR u.store_id = created_order.store_id)
        ON CONFLICT(recipient_user_id, type, entity_id) DO NOTHING`)
        .bind(user.name, amountLabel, createdAt, id),
      db.prepare("SELECT id, code, client_request_fingerprint AS clientRequestFingerprint FROM orders WHERE id = ? LIMIT 1")
        .bind(id),
    ]);
    if (Number(orderInsert.meta.changes ?? 0) !== 1) {
      const replayed = await findRequestOrder(db, user.employeeId, clientRequestId);
      if (replayed) return replayResponse(replayed, fingerprint);
      return json({ message: "Ca làm việc đã kết thúc hoặc không còn hiệu lực. Đơn hàng chưa được ghi nhận." }, 409);
    }
    createdOrder = (createdOrderResult.results[0] as OrderRow | undefined) ?? null;
    if (!createdOrder) throw new Error("Order transaction committed without returning its generated code");
  } catch (error) {
    // Concurrent retries race on the unique employee/request key. Return the
    // committed result only when its fingerprint proves it is the same order.
    const raced = await findRequestOrder(db, user.employeeId, clientRequestId);
    if (raced) return replayResponse(raced, fingerprint);
    console.error("Unable to atomically create order notification", error);
    return json({ message: "Không thể tạo đơn hàng. Dữ liệu chưa được ghi, vui lòng thử lại." }, 500);
  }
  await writeAudit(user.id, "CREATE", "ORDER", createdOrder.id, createdOrder.code);
  return json({ id: createdOrder.id, code: createdOrder.code }, 201);
}

async function managerOrderSnapshot(
  db: Awaited<ReturnType<typeof initDb>>,
  id: string,
  storeId: string,
) {
  return db.prepare(`SELECT
      o.id, o.code, o.store_id AS storeId, o.employee_id AS employeeId, o.shift_code AS shiftCode,
      o.customer_name AS customerName, o.phone, o.age, o.amount, o.payment_method AS paymentMethod, o.status,
      s.id AS shiftSessionId, s.status AS shiftStatus, ${orderPeriodSql} AS period
    FROM orders o
    JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.employee_id = o.employee_id AND s.store_id = o.store_id
    WHERE o.id = ? AND o.store_id = ? LIMIT 1`)
    .bind(id, storeId).first<ManagerOrderSnapshot>();
}

async function managerOrderIsLocked(
  db: Awaited<ReturnType<typeof initDb>>,
  id: string,
  storeId: string,
) {
  const row = await db.prepare(`SELECT CASE WHEN ${unlockedOrderPeriodSql} THEN 0 ELSE 1 END AS locked
    FROM orders o JOIN shift_sessions s
      ON s.shift_code = o.shift_code AND s.employee_id = o.employee_id AND s.store_id = o.store_id
    WHERE o.id = ? AND o.store_id = ? LIMIT 1`)
    .bind(id, storeId).first<{ locked: number }>();
  return row?.locked === 1;
}

async function managerMutateOrder(
  db: Awaited<ReturnType<typeof initDb>>,
  manager: { id: string },
  previous: ManagerOrderSnapshot,
  next: {
    customerName: string | null;
    phone: string | null;
    age: number | null;
    amount: number;
    paymentMethod: string;
    status: "COMPLETED" | "VOID";
  },
) {
  const action = next.status === "VOID" ? "MANAGER_ORDER_VOID" : "MANAGER_ORDER_UPDATE";
  const mutationId = `order-mutation:${crypto.randomUUID()}`;
  const changedAt = new Date().toISOString();
  const detail = JSON.stringify({
    storeId: previous.storeId,
    shiftSessionId: previous.shiftSessionId,
    shiftCode: previous.shiftCode,
    period: previous.period,
    before: {
      customerName: previous.customerName,
      phone: previous.phone,
      age: previous.age,
      amount: previous.amount,
      paymentMethod: previous.paymentMethod,
      status: previous.status,
    },
    after: next,
  });
  const results = await db.batch([
    // The audit row is also the transaction gate. Exact old values provide an
    // optimistic version without rewriting legacy order rows or adding a
    // mutable version column. If another order/shift mutation wins first, no
    // gate is inserted and every following statement is inert.
    db.prepare(`INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, ?, 'ORDER', o.id, ?, ?
      FROM orders o
      JOIN shift_sessions s ON s.id = ? AND s.shift_code = o.shift_code
        AND s.employee_id = o.employee_id AND s.store_id = o.store_id
      JOIN stores active_store ON active_store.id = o.store_id AND active_store.status = 'ACTIVE'
      WHERE o.id = ? AND o.store_id = ? AND o.employee_id = ? AND o.shift_code = ?
        AND o.status = 'COMPLETED'
        AND o.customer_name IS ? AND o.phone IS ? AND o.age IS ?
        AND o.amount = ? AND o.payment_method = ?
        AND ${unlockedOrderPeriodSql}
        AND COALESCE((SELECT SUM(invariant_order.amount) FROM orders invariant_order
              WHERE invariant_order.store_id = o.store_id
                AND invariant_order.employee_id = o.employee_id
                AND invariant_order.shift_code = o.shift_code
                AND invariant_order.id != o.id
                AND invariant_order.status = 'COMPLETED'), 0)
            + CASE WHEN ? = 'COMPLETED' THEN ? ELSE 0 END
          BETWEEN 0 AND 9007199254740991
        AND (
          s.status != 'COMPLETED'
          OR active_store.revenue
            + COALESCE((SELECT SUM(invariant_order.amount) FROM orders invariant_order
              WHERE invariant_order.store_id = o.store_id
                AND invariant_order.employee_id = o.employee_id
                AND invariant_order.shift_code = o.shift_code
                AND invariant_order.id != o.id
                AND invariant_order.status = 'COMPLETED'), 0)
            + CASE WHEN ? = 'COMPLETED' THEN ? ELSE 0 END
            - COALESCE(s.cash_revenue, 0) - COALESCE(s.transfer_revenue, 0)
          BETWEEN 0 AND 9007199254740991
        )`)
      .bind(
        mutationId, manager.id, action, detail, changedAt,
        previous.shiftSessionId, previous.id, previous.storeId, previous.employeeId, previous.shiftCode,
        previous.customerName, previous.phone, previous.age, previous.amount, previous.paymentMethod,
        next.status, next.amount,
        next.status, next.amount,
      ),
    db.prepare(`UPDATE orders SET
        customer_name = ?, phone = ?, age = ?, amount = ?, payment_method = ?, status = ?
      WHERE id = ? AND store_id = ? AND employee_id = ? AND shift_code = ? AND status = 'COMPLETED'
        AND EXISTS (SELECT 1 FROM audit_logs gate WHERE gate.id = ? AND gate.entity_id = orders.id)`)
      .bind(
        next.customerName, next.phone, next.age, next.amount, next.paymentMethod, next.status,
        previous.id, previous.storeId, previous.employeeId, previous.shiftCode, mutationId,
      ),
    // If END/rollover won before this transaction, the shift is already
    // completed. Apply only the exact delta between current order truth and
    // its prior persisted snapshot, before refreshing that snapshot below.
    db.prepare(`UPDATE stores SET revenue = revenue + COALESCE((
        SELECT COALESCE(SUM(CASE WHEN current_order.status = 'COMPLETED' THEN current_order.amount ELSE 0 END), 0)
          - (COALESCE(closed.cash_revenue, 0) + COALESCE(closed.transfer_revenue, 0))
        FROM shift_sessions closed
        LEFT JOIN orders current_order ON current_order.store_id = closed.store_id
          AND current_order.employee_id = closed.employee_id AND current_order.shift_code = closed.shift_code
        WHERE closed.id = ? AND closed.status = 'COMPLETED'
        GROUP BY closed.id
      ), 0)
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM audit_logs gate WHERE gate.id = ? AND gate.entity_id = ?)
        AND EXISTS (SELECT 1 FROM shift_sessions closed WHERE closed.id = ? AND closed.status = 'COMPLETED')`)
      .bind(previous.shiftSessionId, previous.storeId, mutationId, previous.id, previous.shiftSessionId),
    db.prepare(`UPDATE shift_sessions SET
        cash_revenue = COALESCE((SELECT SUM(current_order.amount) FROM orders current_order
          WHERE current_order.store_id = shift_sessions.store_id
            AND current_order.employee_id = shift_sessions.employee_id
            AND current_order.shift_code = shift_sessions.shift_code
            AND current_order.status = 'COMPLETED' AND current_order.payment_method = 'CASH'), 0),
        transfer_revenue = COALESCE((SELECT SUM(current_order.amount) FROM orders current_order
          WHERE current_order.store_id = shift_sessions.store_id
            AND current_order.employee_id = shift_sessions.employee_id
            AND current_order.shift_code = shift_sessions.shift_code
            AND current_order.status = 'COMPLETED' AND current_order.payment_method = 'BANK_TRANSFER'), 0)
      WHERE id = ? AND status = 'COMPLETED'
        AND EXISTS (SELECT 1 FROM audit_logs gate WHERE gate.id = ? AND gate.entity_id = ?)`)
      .bind(previous.shiftSessionId, mutationId, previous.id),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1;
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return json({ message: "Nhân viên chỉ được xem đơn hàng đã tạo; chỉ quản lý mới có quyền chỉnh sửa." }, 403);
  const body = await request.json().catch(() => ({})) as { id?: string; storeId?: string; customerName?: string; phone?: string; age?: number | string; amount?: number | string; paymentMethod?: string };
  const requestedStoreId = body.storeId?.trim() ?? "";
  if (requestedStoreId && !managerCanAccessStore(user, requestedStoreId)) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  const amount = Number(body.amount);
  const age = body.age === "" || body.age == null ? null : Number(body.age);
  if (!body.id) return json({ message: "Thiếu mã đơn hàng cần cập nhật." }, 400);
  if (!Number.isSafeInteger(amount) || amount <= 0) return json({ message: "Giá trị đơn hàng phải là số nguyên VND an toàn và lớn hơn 0." }, 400);
  if (age != null && (!Number.isInteger(age) || age < 1 || age > 120)) return json({ message: "Tuổi không hợp lệ." }, 400);
  if (!["CASH", "BANK_TRANSFER"].includes(body.paymentMethod ?? "")) return json({ message: "Hình thức thanh toán không hợp lệ." }, 400);
  const db = await initDb();
  const storeId = requestedStoreId;
  if (!storeId) return json({ message: "Thiếu cửa hàng của đơn hàng." }, 400);
  const previous = await managerOrderSnapshot(db, body.id, storeId);
  if (!previous) return json({ message: "Không tìm thấy đơn hàng hoặc ca gốc của đơn." }, 404);
  if (previous.status !== "COMPLETED") return json({ message: "Đơn hàng đã hủy nên không thể sửa." }, 409);
  const changed = await managerMutateOrder(db, user, previous, {
    customerName: body.customerName?.trim() || null,
    phone: body.phone?.trim() || null,
    age,
    amount,
    paymentMethod: String(body.paymentMethod),
    status: "COMPLETED",
  });
  if (!changed) {
    if (await managerOrderIsLocked(db, body.id, storeId)) return json({ message: "Kỳ của đơn hàng đã chốt hoặc khóa sổ nên không thể thay đổi." }, 409);
    return json({ message: "Đơn hàng hoặc ca làm đã được cập nhật bởi một yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  return json({ ok: true, code: previous.code, message: "Đã cập nhật đơn hàng và đồng bộ doanh thu ca/cửa hàng." });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return json({ message: "Nhân viên chỉ được xem đơn hàng đã tạo; chỉ quản lý mới có quyền xóa." }, 403);
  const params = new URL(request.url).searchParams;
  const id = params.get("id")?.trim() ?? "";
  const db = await initDb();
  if (!id) return json({ message: "Thiếu mã đơn hàng cần hủy." }, 400);
  const storeId = params.get("storeId")?.trim() ?? "";
  if (storeId && !managerCanAccessStore(user, storeId)) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  if (!storeId) return json({ message: "Thiếu cửa hàng của đơn hàng." }, 400);
  const previous = await managerOrderSnapshot(db, id, storeId);
  if (!previous) return json({ message: "Không tìm thấy đơn hàng hoặc ca gốc của đơn." }, 404);
  if (previous.status !== "COMPLETED") return json({ message: "Đơn hàng đã được hủy trước đó." }, 409);
  const changed = await managerMutateOrder(db, user, previous, {
    customerName: previous.customerName,
    phone: previous.phone,
    age: previous.age,
    amount: previous.amount,
    paymentMethod: previous.paymentMethod,
    status: "VOID",
  });
  if (!changed) {
    if (await managerOrderIsLocked(db, id, storeId)) return json({ message: "Kỳ của đơn hàng đã chốt hoặc khóa sổ nên không thể hủy." }, 409);
    return json({ message: "Đơn hàng hoặc ca làm đã được cập nhật bởi một yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  return json({ ok: true, code: previous.code, message: "Đã hủy đơn và đồng bộ doanh thu ca/cửa hàng; lịch sử vẫn được lưu." });
}
