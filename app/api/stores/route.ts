import { initDb, writeAudit } from "../../../db/runtime";
import {
  isStoreOrderCodePrefixConflict,
  nextPrefixForStoreName,
} from "../../../db/order-code-prefix";
import { localDate, localMonthRange, localPeriod, previousComparableDateRange } from "../../lib/finance";
import { getSessionUser, json } from "../_lib/auth";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  managerHasGlobalStoreAccess,
} from "../_lib/manager-scope";
import {
  recognizeFullPeriodFinancialPreviewForOverview,
  storeDateRangeFinance,
  storePeriodFinance,
} from "../_lib/store-finance";
import { loadPayrollPolicy } from "../_lib/payroll-policy";

const defaultShifts = [
  { name: "Ca 1", start: "07:00", end: "12:00", durationMinutes: 300 },
  { name: "Ca 2", start: "12:00", end: "17:00", durationMinutes: 300 },
  { name: "Ca 3", start: "17:00", end: "23:00", durationMinutes: 360 },
] as const;

function affectedRows(result: unknown) {
  if (!result || typeof result !== "object") return 0;
  const candidate = result as { meta?: { changes?: number }; changes?: number };
  return Number(candidate.meta?.changes ?? candidate.changes ?? 0);
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const requestedPeriod = new URL(request.url).searchParams.get("period") ?? localPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedPeriod)) return json({ message: "Kỳ báo cáo không hợp lệ." }, 400);
  const today = localDate();
  const fullCurrentRange = localMonthRange(requestedPeriod);
  if (fullCurrentRange.from > today) return json({ message: "Không thể xem tổng quan cho kỳ trong tương lai." }, 400);
  const currentRange = {
    ...fullCurrentRange,
    to: fullCurrentRange.to > today ? today : fullCurrentRange.to,
  };
  const result = user.role === "MANAGER"
    ? managerHasGlobalStoreAccess(user)
      ? await db.prepare("SELECT id FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at").all<{ id: string }>()
      : user.homeStoreId
        ? await db.prepare("SELECT id FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE')").bind(user.homeStoreId).all<{ id: string }>()
        : { results: [] as Array<{ id: string }> }
    : await db.prepare("SELECT id FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE')").bind(user.storeId).all<{ id: string }>();
  const priorRange = previousComparableDateRange(currentRange, "month");
  const priorPeriod = priorRange.to.slice(0, 7);
  const payrollPolicy = await loadPayrollPolicy(db);
  const stores = (await Promise.all(result.results.map(async ({ id }) => {
    const [currentRangeFinance, currentPeriodFinance, previousRangeFinance, previousPeriodFinance, employeeCount, lifetimeOrderCount, salaryAdvanceCount] = await Promise.all([
      storeDateRangeFinance(db, id, currentRange, { payrollRecognition: "PREVIEW", payrollPolicy }),
      storePeriodFinance(db, id, requestedPeriod, payrollPolicy),
      storeDateRangeFinance(db, id, priorRange, { payrollRecognition: "PREVIEW", payrollPolicy }),
      storePeriodFinance(db, id, priorPeriod, payrollPolicy),
      db.prepare("SELECT COUNT(*) AS count FROM employees WHERE store_id = ? AND status != 'ARCHIVED'").bind(id).first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM orders WHERE store_id = ?").bind(id).first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM salary_advances WHERE store_id = ? AND status IN ('DRAFT', 'PAID')").bind(id).first<{ count: number }>(),
    ]);
    const current = currentRangeFinance && currentPeriodFinance
      ? recognizeFullPeriodFinancialPreviewForOverview(currentRangeFinance, currentPeriodFinance)
      : currentRangeFinance;
    const previous = previousRangeFinance && previousPeriodFinance
      ? recognizeFullPeriodFinancialPreviewForOverview(previousRangeFinance, previousPeriodFinance)
      : previousRangeFinance;
    const orderCount = Number(lifetimeOrderCount?.count ?? 0);
    const advanceCount = Number(salaryAdvanceCount?.count ?? 0);
    return current ? {
      ...current,
      period: requestedPeriod,
      employeeCount: Number(employeeCount?.count ?? 0),
      lifetimeOrderCount: orderCount,
      salaryAdvanceCount: advanceCount,
      canDelete: orderCount === 0 && advanceCount === 0,
      previous: previous ? { period: priorPeriod, range: previous.range, revenue: previous.revenue, expense: previous.expense, profit: previous.profit } : null,
    } : null;
  }))).filter(Boolean);
  const financeStatus = stores.length > 0 && stores.every((store) => store?.calculationStatus === "LOCKED")
    ? "LOCKED"
    : "PROVISIONAL";
  return json({
    period: requestedPeriod,
    range: currentRange,
    previousRange: priorRange,
    financeStatus,
    recognitionModel: "ACCRUAL",
    stores,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  if (!managerHasGlobalStoreAccess(user)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const body = await request.json().catch(() => ({})) as { name?: string; address?: string };
  const name = body.name?.trim().toUpperCase();
  const address = body.address?.trim();
  if (!name || !address) return json({ message: "Tên và địa chỉ cửa hàng là bắt buộc." }, 400);
  const db = await initDb();
  const id = `st-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const liveDuplicate = await db.prepare("SELECT 1 AS present FROM stores WHERE name = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(name).first<{ present: number }>();
  if (liveDuplicate) return json({ message: "Tên cửa hàng đã tồn tại." }, 409);
  let created = false;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const codePrefix = await nextPrefixForStoreName(db, name);
    try {
      await db.batch([
        // The legacy schema has a global UNIQUE(name) constraint. Release the
        // display name only from a tombstoned row in the same transaction as
        // the new insert. The immutable store id and DELETE audit retain the
        // old store's identity/history, while concurrent creators still race
        // on the database constraint and can never create two live names.
        db.prepare(`UPDATE stores
          SET name = name || ' · ĐÃ XÓA · ' || id
          WHERE name = ? AND status = 'DELETED'`)
          .bind(name),
        db.prepare("INSERT INTO stores (id, name, address, revenue, expense, status, created_at) VALUES (?, ?, ?, 0, 0, 'ACTIVE', ?)").bind(id, name, address, now),
        db.prepare(`INSERT INTO store_order_code_sequences
          (store_id, code_prefix, last_value, updated_at) VALUES (?, ?, 0, ?)`)
          .bind(id, codePrefix, now),
        ...defaultShifts.map((shift, index) => db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'CA_LAM_VIEC', ?, ?, ?, ?, 'ACTIVE', ?, ?)")
          .bind(`default-shift:${id}:${index + 1}`, id, user.id, shift.name, JSON.stringify({ start: shift.start, end: shift.end, durationMinutes: shift.durationMinutes, overnight: false }), now, now)),
      ]);
      created = true;
      break;
    } catch (error) {
      const duplicateName = await db.prepare("SELECT 1 AS present FROM stores WHERE name = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
        .bind(name).first<{ present: number }>();
      if (duplicateName) return json({ message: "Tên cửa hàng đã tồn tại." }, 409);
      if (isStoreOrderCodePrefixConflict(error)) continue;
      console.error("Unable to create store with an immutable order-code prefix", error);
      return json({ message: "Không thể tạo cửa hàng. Dữ liệu chưa được ghi, vui lòng thử lại." }, 500);
    }
  }
  if (!created) return json({ message: "Không thể cấp tiền tố mã đơn duy nhất cho cửa hàng." }, 409);
  await writeAudit(user.id, "CREATE", "STORE", id, name);
  return json({ id, message: "Đã tạo cửa hàng và toàn bộ danh mục mặc định." }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as { id?: string; name?: string; address?: string; status?: string };
  if (!body.id || !body.name?.trim() || !body.address?.trim() || !["ACTIVE", "INACTIVE"].includes(body.status ?? "ACTIVE")) return json({ message: "Dữ liệu không hợp lệ." }, 400);
  if (!managerCanAccessStore(user, body.id)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const db = await initDb();
  const existing = await db.prepare("SELECT name, status FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(body.id).first<{ name: string; status: string }>();
  if (!existing) return json({ message: "Không tìm thấy cửa hàng." }, 404);
  const nextStatus = body.status ?? existing.status;
  if (existing.status === "ACTIVE" && nextStatus === "INACTIVE") {
    const activeShifts = await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE store_id = ? AND status = 'ACTIVE'")
      .bind(body.id).first<{ count: number }>();
    if (Number(activeShifts?.count ?? 0) > 0) {
      return json({ message: "Cửa hàng còn ca làm đang hoạt động. Hãy kết thúc các ca trước khi ngưng hoạt động." }, 409);
    }
  }
  const updated = await db.prepare(`UPDATE stores SET name = ?, address = ?, status = ?
      WHERE id = ? AND status = ?
        AND (? != 'INACTIVE' OR NOT EXISTS (
          SELECT 1 FROM shift_sessions active_shift
          WHERE (
              active_shift.store_id = stores.id
              OR EXISTS (
                SELECT 1 FROM employees home_employee
                WHERE home_employee.id = active_shift.employee_id
                  AND home_employee.store_id = stores.id
              )
            )
            AND (active_shift.status = 'ACTIVE' OR active_shift.ended_at IS NULL)
        ))`)
    .bind(body.name.trim().toUpperCase(), body.address.trim(), nextStatus, body.id, existing.status, nextStatus).run();
  if (affectedRows(updated) === 0) {
    const current = await db.prepare("SELECT status FROM stores WHERE id = ? LIMIT 1")
      .bind(body.id).first<{ status: string }>();
    if (current?.status === "ACTIVE" && nextStatus === "INACTIVE") {
      return json({ message: "Cửa hàng còn ca làm đang hoạt động. Hãy kết thúc các ca trước khi ngưng hoạt động." }, 409);
    }
    return json({ message: "Trạng thái cửa hàng vừa thay đổi. Vui lòng tải lại và thử lại." }, 409);
  }
  await writeAudit(user.id, existing.status === nextStatus ? "UPDATE" : "STORE_STATUS_CHANGE", "STORE", body.id, JSON.stringify({ from: existing.status, to: nextStatus }));
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  if (Number(user.isSuperAdmin) !== 1) {
    return json({ message: "Chỉ quản trị cấp cao mới có quyền xóa cửa hàng." }, 403);
  }

  const body = await request.json().catch(() => ({})) as { id?: string };
  const storeId = body.id?.trim();
  if (!storeId) return json({ message: "Mã cửa hàng không hợp lệ." }, 400);

  const db = await initDb();
  const store = await db.prepare(`SELECT id, name, address, status
      FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1`)
    .bind(storeId).first<{ id: string; name: string; address: string; status: string }>();
  if (!store) return json({ message: "Không tìm thấy cửa hàng hoặc cửa hàng đã được xóa." }, 404);

  const deletionAuditId = crypto.randomUUID();
  const deletedAt = new Date().toISOString();
  const detail = JSON.stringify({
    name: store.name,
    address: store.address,
    previousStatus: store.status,
    deletionMode: "TOMBSTONE",
  });
  const gate = `EXISTS (
    SELECT 1 FROM audit_logs store_delete_gate
    WHERE store_delete_gate.id = ?
      AND store_delete_gate.action = 'DELETE'
      AND store_delete_gate.entity_type = 'STORE'
      AND store_delete_gate.entity_id = ?
  )`;

  const results = await db.batch([
    // This audit row is also the transaction-local mutation gate. If an order
    // wins the race before this batch starts, no gate is created and every
    // following statement is inert. If deletion wins, later order writes see a
    // non-ACTIVE store and are rejected by their own atomic insert guard.
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, 'DELETE', 'STORE', target.id, ?, ?
      FROM stores target
      WHERE target.id = ? AND target.status IN ('ACTIVE', 'INACTIVE')
        AND NOT EXISTS (SELECT 1 FROM orders existing_order WHERE existing_order.store_id = target.id)
        AND NOT EXISTS (SELECT 1 FROM salary_advances existing_advance
          WHERE existing_advance.store_id = target.id AND existing_advance.status IN ('DRAFT', 'PAID'))`)
      .bind(deletionAuditId, user.id, detail, deletedAt, storeId),
    db.prepare(`UPDATE stores SET status = 'DELETED'
      WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') AND ${gate}
        AND NOT EXISTS (SELECT 1 FROM orders existing_order WHERE existing_order.store_id = stores.id)
        AND NOT EXISTS (SELECT 1 FROM salary_advances existing_advance
          WHERE existing_advance.store_id = stores.id AND existing_advance.status IN ('DRAFT', 'PAID'))`)
      .bind(storeId, deletionAuditId, storeId),
    // Closing a home-store employee's support shift must recognize its orders
    // and expense at the receiving store exactly once, just like the normal
    // END flow. The audit gate keeps this reconciliation in the same atomic
    // batch as the tombstone and makes a repeated DELETE inert.
    db.prepare(`UPDATE stores
      SET revenue = revenue + COALESCE((
            SELECT SUM(linked_order.amount)
            FROM shift_sessions linked_shift
            JOIN orders linked_order
              ON linked_order.store_id = linked_shift.store_id
             AND linked_order.employee_id = linked_shift.employee_id
             AND linked_order.shift_code = linked_shift.shift_code
            WHERE linked_shift.store_id = stores.id
              AND (linked_shift.status = 'ACTIVE' OR linked_shift.ended_at IS NULL)
              AND (
                linked_shift.store_id = ?
                OR linked_shift.employee_id IN (
                  SELECT home_employee.id FROM employees home_employee WHERE home_employee.store_id = ?
                )
              )
              AND linked_order.status = 'COMPLETED'
              AND linked_order.payment_method IN ('CASH', 'BANK_TRANSFER')
          ), 0),
          expense = expense + COALESCE((
            SELECT SUM(linked_shift.expense_amount)
            FROM shift_sessions linked_shift
            WHERE linked_shift.store_id = stores.id
              AND (linked_shift.status = 'ACTIVE' OR linked_shift.ended_at IS NULL)
              AND (
                linked_shift.store_id = ?
                OR linked_shift.employee_id IN (
                  SELECT home_employee.id FROM employees home_employee WHERE home_employee.store_id = ?
                )
              )
          ), 0)
      WHERE EXISTS (
          SELECT 1 FROM shift_sessions linked_shift
          WHERE linked_shift.store_id = stores.id
            AND (linked_shift.status = 'ACTIVE' OR linked_shift.ended_at IS NULL)
            AND (
              linked_shift.store_id = ?
              OR linked_shift.employee_id IN (
                SELECT home_employee.id FROM employees home_employee WHERE home_employee.store_id = ?
              )
            )
        ) AND ${gate}`)
      .bind(
        storeId, storeId,
        storeId, storeId,
        storeId, storeId,
        deletionAuditId, storeId,
      ),
    db.prepare(`UPDATE shift_sessions
      SET ended_at = COALESCE(ended_at, ?),
          duration_seconds = CASE WHEN ended_at IS NULL
            THEN MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400 AS INTEGER))
            ELSE duration_seconds END,
          cash_revenue = COALESCE((
            SELECT SUM(cash_order.amount) FROM orders cash_order
            WHERE cash_order.store_id = shift_sessions.store_id
              AND cash_order.employee_id = shift_sessions.employee_id
              AND cash_order.shift_code = shift_sessions.shift_code
              AND cash_order.status = 'COMPLETED' AND cash_order.payment_method = 'CASH'
          ), 0),
          transfer_revenue = COALESCE((
            SELECT SUM(transfer_order.amount) FROM orders transfer_order
            WHERE transfer_order.store_id = shift_sessions.store_id
              AND transfer_order.employee_id = shift_sessions.employee_id
              AND transfer_order.shift_code = shift_sessions.shift_code
              AND transfer_order.status = 'COMPLETED' AND transfer_order.payment_method = 'BANK_TRANSFER'
          ), 0),
          close_reason = 'STORE_DELETED', close_status = 'ADMIN_CLOSED', status = 'COMPLETED'
      WHERE (status = 'ACTIVE' OR ended_at IS NULL)
        AND (
          store_id = ?
          OR employee_id IN (SELECT employee.id FROM employees employee WHERE employee.store_id = ?)
        ) AND ${gate}`)
      .bind(deletedAt, deletedAt, storeId, storeId, deletionAuditId, storeId),
    db.prepare(`UPDATE employee_transfers
      SET status = 'COMPLETED', ended_at = COALESCE(ended_at, ?), updated_at = ?
      WHERE status IN ('SCHEDULED', 'ACTIVE')
        AND id IN (
          SELECT closed_shift.transfer_id FROM shift_sessions closed_shift
          WHERE closed_shift.transfer_id IS NOT NULL
            AND closed_shift.close_reason = 'STORE_DELETED'
            AND closed_shift.close_status = 'ADMIN_CLOSED'
            AND closed_shift.status = 'COMPLETED'
            AND (
              closed_shift.store_id = ?
              OR closed_shift.employee_id IN (
                SELECT home_employee.id FROM employees home_employee WHERE home_employee.store_id = ?
              )
            )
        ) AND ${gate}`)
      .bind(deletedAt, deletedAt, storeId, storeId, deletionAuditId, storeId),
    db.prepare(`DELETE FROM sessions
      WHERE user_id IN (
        SELECT linked_user.id FROM users linked_user
        WHERE COALESCE(linked_user.is_super_admin, 0) != 1
          AND (
            linked_user.store_id = ?
            OR linked_user.employee_id IN (SELECT employee.id FROM employees employee WHERE employee.store_id = ?)
            OR linked_user.current_shift IN (SELECT shift.shift_code FROM shift_sessions shift WHERE shift.store_id = ?)
          )
      ) AND ${gate}`)
      .bind(storeId, storeId, storeId, deletionAuditId, storeId),
    db.prepare(`UPDATE users
      SET shift_active = 0, current_shift = NULL, shift_started_at = NULL
      WHERE COALESCE(is_super_admin, 0) != 1
        AND (
          store_id = ?
          OR employee_id IN (SELECT employee.id FROM employees employee WHERE employee.store_id = ?)
          OR current_shift IN (SELECT shift.shift_code FROM shift_sessions shift WHERE shift.store_id = ?)
        ) AND ${gate}`)
      .bind(storeId, storeId, storeId, deletionAuditId, storeId),
  ]);

  if (affectedRows(results[1]) !== 1) {
    const order = await db.prepare("SELECT 1 AS present FROM orders WHERE store_id = ? LIMIT 1")
      .bind(storeId).first<{ present: number }>();
    if (order) {
      return json({ message: "Không thể xóa cửa hàng vì cửa hàng đã phát sinh đơn hàng." }, 409);
    }
    const salaryAdvance = await db.prepare("SELECT 1 AS present FROM salary_advances WHERE store_id = ? AND status IN ('DRAFT', 'PAID') LIMIT 1")
      .bind(storeId).first<{ present: number }>();
    if (salaryAdvance) {
      return json({ message: "Không thể xóa cửa hàng vì cửa hàng còn lịch sử ứng lương cần đối soát." }, 409);
    }
    return json({ message: "Cửa hàng vừa thay đổi hoặc đã được xóa. Vui lòng tải lại danh sách." }, 409);
  }

  return json({ ok: true, id: storeId, message: `Đã xóa ${store.name} khỏi hệ thống.` });
}
