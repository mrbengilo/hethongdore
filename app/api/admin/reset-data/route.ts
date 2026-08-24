import { initDb } from "../../../../db/runtime";
import { getSessionUser, json as responseJson, sha256 } from "../../_lib/auth";
import { incomingStorePeriodUnlockedSql } from "../../_lib/store-period-lock";
import {
  buildAdminResetWhere,
  parseAdminResetFilter,
  resetFilterLabel,
  resetFilterPeriod,
  type AdminResetFilter,
} from "../../../lib/admin-reset";

type Database = Awaited<ReturnType<typeof initDb>>;

function json(data: unknown, status = 200) {
  return responseJson(data, status, {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie",
  });
}
type ResetOrderSnapshot = {
  id: string;
  code: string;
  storeId: string;
  shiftCode: string;
  shiftName: string | null;
  employeeId: string;
  customerName: string | null;
  phone: string | null;
  age: number | null;
  amount: number;
  paymentMethod: string;
  status: string;
  clientRequestId: string | null;
  clientRequestFingerprint: string | null;
  createdAt: string;
  shiftId: string | null;
  shiftStatus: string | null;
  shiftWorkDate: string | null;
  shiftCashRevenue: number | null;
  shiftTransferRevenue: number | null;
  notifications: Array<Record<string, unknown>>;
};
type ResetShiftSnapshot = {
  id: string;
  shiftCode: string;
  shiftName: string | null;
  storeId: string;
  employeeId: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  status: string;
  workDate: string | null;
  previousSessionId: string | null;
  transferId: string | null;
  appliedHourlyRate: number | null;
  appliedTiktokAllowance: number | null;
  appliedSupportAllowance: number | null;
  startedAt: string;
  attendanceStatus: string | null;
  attendanceDeltaMinutes: number | null;
  clockInLatitude: number | null;
  clockInLongitude: number | null;
  clockInAccuracyMeters: number | null;
  clockInLocationCapturedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  adminAdjustedDurationSeconds: number | null;
  tiktok: number;
  tiktokAllowance: number;
  tasksCompleted: number;
  cashRevenue: number;
  transferRevenue: number;
  expenseAmount: number;
  expenseNote: string | null;
  closeReason: string | null;
  closeStatus: string;
};
type ResetSummary = {
  count: number;
  amount?: number;
  hours?: number;
  revenue?: number;
  expense?: number;
};
type ResetStoreSnapshot = { id: string; revenue: number; expense: number };

const MAX_SNAPSHOT_BYTES = 900_000;

function affectedRows(result: unknown) {
  const row = result as { meta?: { changes?: number }; changes?: number } | undefined;
  return Number(row?.meta?.changes ?? row?.changes ?? 0);
}

function canonicalQuery(filter: AdminResetFilter) {
  const where = buildAdminResetWhere(filter);
  if (filter.kind === "ORDERS") {
    return {
      ...where,
      sql: `SELECT COALESCE(json_group_array(json(payload)), '[]') AS snapshotJson FROM (
        SELECT json_object(
          'schemaVersion', 1, 'id', o.id, 'code', o.code, 'storeId', o.store_id,
          'shiftCode', o.shift_code, 'shiftName', s.shift_name, 'employeeId', o.employee_id,
          'customerName', o.customer_name, 'phone', o.phone, 'age', o.age,
          'amount', o.amount, 'paymentMethod', o.payment_method,
          'status', o.status, 'clientRequestId', o.client_request_id,
          'clientRequestFingerprint', o.client_request_fingerprint, 'createdAt', o.created_at,
          'shiftId', s.id, 'shiftStatus', s.status, 'shiftWorkDate', s.work_date,
          'shiftCashRevenue', s.cash_revenue, 'shiftTransferRevenue', s.transfer_revenue,
          'shiftStoreId', s.store_id, 'shiftEmployeeId', s.employee_id,
          'shiftScheduledStart', s.scheduled_start, 'shiftScheduledEnd', s.scheduled_end,
          'shiftScheduledStartAt', s.scheduled_start_at, 'shiftScheduledEndAt', s.scheduled_end_at,
          'shiftPreviousSessionId', s.previous_session_id, 'shiftTransferId', s.transfer_id,
          'shiftAppliedHourlyRate', s.applied_hourly_rate,
          'shiftAppliedTiktokAllowance', s.applied_tiktok_allowance,
          'shiftAppliedSupportAllowance', s.applied_support_allowance,
          'shiftStartedAt', s.started_at, 'shiftAttendanceStatus', s.attendance_status,
          'shiftAttendanceDeltaMinutes', s.attendance_delta_minutes,
          'shiftClockInLatitude', s.clock_in_latitude, 'shiftClockInLongitude', s.clock_in_longitude,
          'shiftClockInAccuracyMeters', s.clock_in_accuracy_meters,
          'shiftClockInLocationCapturedAt', s.clock_in_location_captured_at,
          'shiftEndedAt', s.ended_at,
          'shiftDurationSeconds', s.duration_seconds, 'shiftTiktok', s.tiktok,
          'shiftAdminAdjustedDurationSeconds', s.admin_adjusted_duration_seconds,
          'shiftTiktokAllowance', s.tiktok_allowance, 'shiftTasksCompleted', s.tasks_completed,
          'shiftExpenseAmount', s.expense_amount, 'shiftExpenseNote', s.expense_note,
          'shiftCloseReason', s.close_reason, 'shiftCloseStatus', s.close_status,
          'storeRevenue', (SELECT st.revenue FROM stores st WHERE st.id = o.store_id),
          'storeExpense', (SELECT st.expense FROM stores st WHERE st.id = o.store_id),
          'notifications', json(COALESCE((
            SELECT json_group_array(json(notificationPayload)) FROM (
              SELECT json_object(
              'id', n.id, 'recipientUserId', n.recipient_user_id, 'storeId', n.store_id,
              'type', n.type, 'entityType', n.entity_type, 'entityId', n.entity_id,
              'title', n.title, 'message', n.message, 'dataJson', n.data_json,
              'readAt', n.read_at, 'createdAt', n.created_at
              ) AS notificationPayload
              FROM notifications n
              WHERE n.store_id = o.store_id AND n.entity_type = 'ORDER' AND n.entity_id = o.id
              ORDER BY n.id
            )
          ), '[]'))
        ) AS payload
        FROM orders o
        LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
        WHERE ${where.sql}
        ORDER BY o.id
      )`,
    };
  }
  return {
    ...where,
    sql: `SELECT COALESCE(json_group_array(json(payload)), '[]') AS snapshotJson FROM (
      SELECT json_object(
        'schemaVersion', 1, 'id', s.id, 'shiftCode', s.shift_code, 'shiftName', s.shift_name,
        'storeId', s.store_id, 'employeeId', s.employee_id,
        'scheduledStart', s.scheduled_start, 'scheduledEnd', s.scheduled_end,
        'scheduledStartAt', s.scheduled_start_at, 'scheduledEndAt', s.scheduled_end_at,
        'status', s.status, 'workDate', s.work_date, 'previousSessionId', s.previous_session_id,
        'transferId', s.transfer_id, 'appliedHourlyRate', s.applied_hourly_rate,
        'appliedTiktokAllowance', s.applied_tiktok_allowance,
        'appliedSupportAllowance', s.applied_support_allowance,
        'startedAt', s.started_at, 'endedAt', s.ended_at,
        'attendanceStatus', s.attendance_status, 'attendanceDeltaMinutes', s.attendance_delta_minutes,
        'clockInLatitude', s.clock_in_latitude, 'clockInLongitude', s.clock_in_longitude,
        'clockInAccuracyMeters', s.clock_in_accuracy_meters,
        'clockInLocationCapturedAt', s.clock_in_location_captured_at,
        'durationSeconds', s.duration_seconds,
        'adminAdjustedDurationSeconds', s.admin_adjusted_duration_seconds, 'tiktok', s.tiktok,
        'tiktokAllowance', s.tiktok_allowance, 'tasksCompleted', s.tasks_completed,
        'cashRevenue', s.cash_revenue, 'transferRevenue', s.transfer_revenue,
        'expenseAmount', s.expense_amount, 'expenseNote', s.expense_note,
        'closeReason', s.close_reason, 'closeStatus', s.close_status,
        'storeRevenue', (SELECT st.revenue FROM stores st WHERE st.id = s.store_id),
        'storeExpense', (SELECT st.expense FROM stores st WHERE st.id = s.store_id)
      ) AS payload
      FROM shift_sessions s
      WHERE ${where.sql}
      ORDER BY s.id
    )`,
  };
}

async function requireSuperAdmin(request: Request) {
  const user = await getSessionUser(request);
  return user?.role === "MANAGER" && Number(user.isSuperAdmin) === 1 ? user : null;
}

async function storeInfo(db: Database, storeId: string) {
  return db.prepare("SELECT id, name, status FROM stores WHERE id = ? LIMIT 1")
    .bind(storeId).first<{ id: string; name: string; status: string }>();
}

async function assertPeriodUnlocked(db: Database, storeId: string, period: string) {
  const locks = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM employee_payroll_closings
        WHERE store_id = ? AND period = ?) AS employeeLocked,
      EXISTS(SELECT 1 FROM business_records
        WHERE store_id = ? AND category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING')
          AND COALESCE(status, '') != 'DELETED' AND json_extract(data_json, '$.period') = ?) AS storeLocked,
      EXISTS(SELECT 1 FROM business_records
        WHERE category = 'DIVIDEND' AND status = 'LOCKED'
          AND json_extract(data_json, '$.period') = ?) AS sharingLocked`)
    .bind(storeId, period, storeId, period, period)
    .first<{ employeeLocked: number; storeLocked: number; sharingLocked: number }>();
  if (locks?.employeeLocked) throw new Error("Kỳ lương đã bắt đầu khóa theo nhân viên; không thể reset dữ liệu kỳ này.");
  if (locks?.storeLocked) throw new Error("Kỳ lương cửa hàng đã chốt hoặc đang khóa; không thể reset dữ liệu kỳ này.");
  if (locks?.sharingLocked) throw new Error("Kỳ chia lợi nhuận đã khóa; không thể reset dữ liệu kỳ này.");
}

function periodUnlockGuard(storeId: string, period: string) {
  return {
    sql: `${incomingStorePeriodUnlockedSql} AND NOT EXISTS (
        SELECT 1 FROM employee_payroll_closings
        WHERE store_id = ? AND period = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM business_records
        WHERE category = 'DIVIDEND' AND status = 'LOCKED'
          AND json_extract(data_json, '$.period') = ?
      )`,
    bindings: [storeId, period, storeId, period, period],
  };
}

function auditResetStatement(
  db: Database,
  userId: string,
  filter: AdminResetFilter,
  archiveId: string,
  summary: ResetSummary,
  createdAt: string,
) {
  return db.prepare(`INSERT INTO audit_logs
      (id, user_id, action, entity_type, entity_id, detail, created_at)
    SELECT ?, ?, 'SUPER_ADMIN_STORE_DATA_RESET', ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM admin_reset_archives WHERE id = ?)`)
    .bind(
      crypto.randomUUID(),
      userId,
      filter.kind,
      archiveId,
      JSON.stringify({ filter, summary }),
      createdAt,
      archiveId,
    );
}

async function loadSnapshot(db: Database, filter: AdminResetFilter) {
  const canonical = canonicalQuery(filter);
  const canonicalRow = await db.prepare(canonical.sql).bind(...canonical.bindings)
    .first<{ snapshotJson: string }>();
  const canonicalRowsJson = canonicalRow?.snapshotJson ?? "[]";
  const storeSnapshot = await db.prepare("SELECT id, revenue, expense FROM stores WHERE id = ? LIMIT 1")
    .bind(filter.storeId).first<ResetStoreSnapshot>();
  if (!storeSnapshot) throw new Error("Không tìm thấy cửa hàng.");
  const rows = JSON.parse(canonicalRowsJson) as Array<ResetOrderSnapshot | ResetShiftSnapshot>;
  const snapshotJson = JSON.stringify({
    schemaVersion: 1,
    kind: filter.kind,
    filter,
    store: storeSnapshot,
    rows,
  });
  if (new TextEncoder().encode(snapshotJson).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("Phạm vi có quá nhiều dữ liệu. Hãy chọn thêm nhân viên hoặc ca để reset an toàn.");
  }
  return { canonical, canonicalRowsJson, snapshotJson, rows, storeSnapshot };
}

function summarizeResetRows(
  filter: AdminResetFilter,
  rows: Array<ResetOrderSnapshot | ResetShiftSnapshot>,
): ResetSummary {
  if (filter.kind === "ORDERS") {
    return {
      count: rows.length,
      amount: (rows as ResetOrderSnapshot[]).filter((row) => row.status === "COMPLETED")
        .reduce((total, row) => total + Number(row.amount || 0), 0),
    };
  }
  return {
    count: rows.length,
    hours: (rows as ResetShiftSnapshot[]).reduce((total, row) => {
      if (row.adminAdjustedDurationSeconds != null) {
        return total + Math.max(0, Number(row.adminAdjustedDurationSeconds)) / 3_600;
      }
      if (Number(row.durationSeconds) > 0) return total + Number(row.durationSeconds) / 3_600;
      const end = row.endedAt ? new Date(row.endedAt).getTime() : Date.now();
      return total + Math.max(0, end - new Date(row.startedAt).getTime()) / 3_600_000;
    }, 0),
    revenue: (rows as ResetShiftSnapshot[]).reduce((total, row) => total + Number(row.cashRevenue || 0) + Number(row.transferRevenue || 0), 0),
    expense: (rows as ResetShiftSnapshot[]).reduce((total, row) => total + Number(row.expenseAmount || 0), 0),
  };
}

async function loadFilterOptions(db: Database, filter: AdminResetFilter) {
  const employees = await db.prepare(`SELECT e.id, e.code, e.name, e.status FROM employees e
    WHERE e.store_id = ?
      OR EXISTS (SELECT 1 FROM orders o WHERE o.store_id = ? AND o.employee_id = e.id)
      OR EXISTS (SELECT 1 FROM shift_sessions s WHERE s.store_id = ? AND s.employee_id = e.id)
    ORDER BY e.status = 'ACTIVE' DESC, e.name, e.code`).bind(filter.storeId, filter.storeId, filter.storeId)
    .all<{ id: string; code: string; name: string; status: string }>();
  const shiftFilter = buildAdminResetWhere({ ...filter, shiftCode: null });
  const shifts = filter.kind === "ORDERS"
    ? await db.prepare(`SELECT o.shift_code AS code, COALESCE(NULLIF(s.shift_name, ''), o.shift_code) AS name
        FROM orders o LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
        WHERE ${shiftFilter.sql} GROUP BY o.shift_code, COALESCE(NULLIF(s.shift_name, ''), o.shift_code)
        ORDER BY MAX(COALESCE(NULLIF(s.work_date, ''), date(datetime(o.created_at, '+7 hours')))) DESC, name, code`)
      .bind(...shiftFilter.bindings).all<{ code: string; name: string }>()
    : await db.prepare(`SELECT s.shift_code AS code, COALESCE(NULLIF(s.shift_name, ''), s.shift_code) AS name
        FROM shift_sessions s WHERE ${shiftFilter.sql}
        GROUP BY s.shift_code, COALESCE(NULLIF(s.shift_name, ''), s.shift_code)
        ORDER BY MAX(COALESCE(NULLIF(s.work_date, ''), date(datetime(s.started_at, '+7 hours')))) DESC, name, code`)
      .bind(...shiftFilter.bindings).all<{ code: string; name: string }>();
  return { employees: employees.results, shifts: shifts.results };
}

async function previewData(db: Database, filter: AdminResetFilter) {
  const { snapshotJson, rows } = await loadSnapshot(db, filter);
  const options = await loadFilterOptions(db, filter);
  const previewToken = await sha256(`${JSON.stringify(filter)}\n${snapshotJson}`);
  const summary = summarizeResetRows(filter, rows);
  return { snapshotJson, rows, ...options, previewToken, summary };
}

export async function GET(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được xem chức năng Reset Dữ Liệu." }, 403);
  try {
    const url = new URL(request.url);
    const filter = parseAdminResetFilter(Object.fromEntries(url.searchParams.entries()));
    const db = await initDb();
    const store = await storeInfo(db, filter.storeId);
    if (!store) return json({ message: "Không tìm thấy cửa hàng." }, 404);
    if (url.searchParams.get("mode") === "options") {
      const options = await loadFilterOptions(db, { ...filter, employeeId: null, shiftCode: null });
      return json({ store, ...options });
    }
    const preview = await previewData(db, filter);
    return json({
      store,
      filter,
      label: resetFilterLabel(filter),
      employees: preview.employees,
      shifts: preview.shifts,
      summary: preview.summary,
      previewToken: preview.previewToken,
      rows: preview.rows.slice(0, 100),
      truncated: preview.rows.length > 100,
    });
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "Không thể xem trước dữ liệu reset." }, 400);
  }
}

async function resetOrders(
  db: Database,
  userId: string,
  filter: AdminResetFilter,
  snapshotJson: string,
  canonicalRowsJson: string,
  storeSnapshot: ResetStoreSnapshot,
  summary: ResetSummary,
) {
  const archiveId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const canonical = canonicalQuery(filter);
  const filterJson = JSON.stringify(filter);
  const summaryJson = JSON.stringify(summary);
  const periodGuard = periodUnlockGuard(filter.storeId, resetFilterPeriod(filter));
  const where = buildAdminResetWhere(filter);
  const targetOrderIdsSql = `SELECT o.id FROM orders o
    LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
    WHERE ${where.sql}`;
  const targetShiftCodesSql = `SELECT DISTINCT o.shift_code FROM orders o
    LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
    WHERE ${where.sql}`;
  const revenueDeltaSql = `COALESCE((
    SELECT SUM(
      COALESCE((SELECT SUM(ro.amount) FROM orders ro
        WHERE ro.store_id = ss.store_id AND ro.shift_code = ss.shift_code
          AND ro.status = 'COMPLETED' AND ro.id NOT IN (${targetOrderIdsSql})
      ), 0) - COALESCE(ss.cash_revenue, 0) - COALESCE(ss.transfer_revenue, 0)
    )
    FROM shift_sessions ss
    WHERE ss.store_id = ? AND ss.status = 'COMPLETED'
      AND ss.shift_code IN (${targetShiftCodesSql})
  ), 0)`;
  const revenueDeltaBindings = [...where.bindings, filter.storeId, ...where.bindings];
  const archiveGuard = db.prepare(`INSERT INTO admin_reset_archives
      (id, store_id, actor_user_id, kind, filter_json, summary_json, snapshot_json, created_at)
    SELECT ?, ?, ?, 'ORDERS', ?, ?, ?, ?
    WHERE (${canonical.sql}) = ?
      AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND revenue = ? AND expense = ?)
      AND ${periodGuard.sql}
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
        WHERE ${where.sql} AND o.status = 'COMPLETED' AND s.id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
        WHERE ${where.sql} AND (s.status = 'ACTIVE' OR s.ended_at IS NULL)
      )
      AND COALESCE((SELECT revenue FROM stores WHERE id = ?), 0) + ${revenueDeltaSql} >= 0`)
    .bind(
      archiveId,
      filter.storeId,
      userId,
      filterJson,
      summaryJson,
      snapshotJson,
      createdAt,
      ...canonical.bindings,
      canonicalRowsJson,
      storeSnapshot.id,
      storeSnapshot.revenue,
      storeSnapshot.expense,
      ...periodGuard.bindings,
      ...where.bindings,
      ...where.bindings,
      filter.storeId,
      ...revenueDeltaBindings,
    );
  const existsGuard = "EXISTS (SELECT 1 FROM admin_reset_archives WHERE id = ?)";
  const statements = [
    archiveGuard,
    auditResetStatement(db, userId, filter, archiveId, summary, createdAt),
    db.prepare(`DELETE FROM notifications WHERE store_id = ? AND entity_type = 'ORDER'
      AND entity_id IN (${targetOrderIdsSql}) AND ${existsGuard}`)
      .bind(filter.storeId, ...where.bindings, archiveId),
    db.prepare(`UPDATE stores SET revenue = revenue + ${revenueDeltaSql}
      WHERE id = ? AND ${existsGuard}`)
      .bind(...revenueDeltaBindings, filter.storeId, archiveId),
    db.prepare(`UPDATE shift_sessions AS ss SET
        cash_revenue = COALESCE((SELECT SUM(ro.amount) FROM orders ro
          WHERE ro.store_id = ss.store_id AND ro.shift_code = ss.shift_code
            AND ro.status = 'COMPLETED' AND ro.payment_method = 'CASH'
            AND ro.id NOT IN (${targetOrderIdsSql})
        ), 0),
        transfer_revenue = COALESCE((SELECT SUM(ro.amount) FROM orders ro
          WHERE ro.store_id = ss.store_id AND ro.shift_code = ss.shift_code
            AND ro.status = 'COMPLETED' AND ro.payment_method = 'BANK_TRANSFER'
            AND ro.id NOT IN (${targetOrderIdsSql})
        ), 0)
      WHERE ss.store_id = ? AND ss.shift_code IN (${targetShiftCodesSql})
        AND ${existsGuard}`)
      .bind(
        ...where.bindings,
        ...where.bindings,
        filter.storeId,
        ...where.bindings,
        archiveId,
      ),
    db.prepare(`DELETE FROM orders WHERE id IN (${targetOrderIdsSql})
      AND ${existsGuard}`).bind(...where.bindings, archiveId),
  ];
  const results = await db.batch(statements);
  if (affectedRows(results[0]) !== 1) {
    await assertPeriodUnlocked(db, filter.storeId, resetFilterPeriod(filter));
    const diagnostics = await db.prepare(`SELECT
        EXISTS(SELECT 1 FROM orders o
          LEFT JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
          WHERE ${where.sql} AND o.status = 'COMPLETED' AND s.id IS NULL) AS orphan,
        EXISTS(SELECT 1 FROM orders o
          JOIN shift_sessions s ON s.shift_code = o.shift_code AND s.store_id = o.store_id
          WHERE ${where.sql} AND (s.status = 'ACTIVE' OR s.ended_at IS NULL)) AS active,
        (SELECT revenue + ${revenueDeltaSql} FROM stores WHERE id = ?) AS nextRevenue`)
      .bind(...where.bindings, ...where.bindings, ...revenueDeltaBindings, filter.storeId)
      .first<{ orphan: number; active: number; nextRevenue: number }>();
    if (diagnostics?.orphan) throw new Error("Có đơn hàng cũ chưa liên kết được với ca; cần đối soát trước khi reset.");
    if (diagnostics?.active) throw new Error("Không thể reset đơn hàng của ca đang làm. Hãy kết ca trước.");
    if (Number(diagnostics?.nextRevenue ?? -1) < 0) {
      throw new Error("Doanh thu cửa hàng cần được đối soát trước khi reset dữ liệu.");
    }
    throw new Error("Dữ liệu đã thay đổi sau khi xem trước. Vui lòng tải lại trước khi reset.");
  }
  return archiveId;
}

async function resetAttendance(
  db: Database,
  userId: string,
  filter: AdminResetFilter,
  snapshotJson: string,
  canonicalRowsJson: string,
  storeSnapshot: ResetStoreSnapshot,
  rows: ResetShiftSnapshot[],
  summary: ResetSummary,
) {
  if (rows.some((row) => row.status === "ACTIVE" || !row.endedAt)) {
    throw new Error("Không thể reset ca đang làm. Hãy kết ca trước.");
  }
  const archiveId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const canonical = canonicalQuery(filter);
  const filterJson = JSON.stringify(filter);
  const summaryJson = JSON.stringify(summary);
  const periodGuard = periodUnlockGuard(filter.storeId, resetFilterPeriod(filter));
  const where = buildAdminResetWhere(filter);
  const selectedRevenueSql = `COALESCE((SELECT SUM(COALESCE(s.cash_revenue, 0) + COALESCE(s.transfer_revenue, 0))
    FROM shift_sessions s WHERE ${where.sql}), 0)`;
  const selectedExpenseSql = `COALESCE((SELECT SUM(COALESCE(s.expense_amount, 0))
    FROM shift_sessions s WHERE ${where.sql}), 0)`;
  const archiveGuard = db.prepare(`INSERT INTO admin_reset_archives
      (id, store_id, actor_user_id, kind, filter_json, summary_json, snapshot_json, created_at)
    SELECT ?, ?, ?, 'ATTENDANCE', ?, ?, ?, ?
    WHERE (${canonical.sql}) = ?
      AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND revenue = ? AND expense = ?)
      AND ${periodGuard.sql}
      AND NOT EXISTS (
        SELECT 1 FROM shift_sessions s WHERE ${where.sql}
          AND (s.status = 'ACTIVE' OR s.ended_at IS NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.store_id = ? AND o.shift_code IN (
          SELECT s.shift_code FROM shift_sessions s WHERE ${where.sql}
        )
      )
      AND COALESCE((SELECT revenue FROM stores WHERE id = ?), 0) >= ${selectedRevenueSql}
      AND COALESCE((SELECT expense FROM stores WHERE id = ?), 0) >= ${selectedExpenseSql}`)
    .bind(
      archiveId,
      filter.storeId,
      userId,
      filterJson,
      summaryJson,
      snapshotJson,
      createdAt,
      ...canonical.bindings,
      canonicalRowsJson,
      storeSnapshot.id,
      storeSnapshot.revenue,
      storeSnapshot.expense,
      ...periodGuard.bindings,
      ...where.bindings,
      filter.storeId,
      ...where.bindings,
      filter.storeId,
      ...where.bindings,
      filter.storeId,
      ...where.bindings,
    );
  const existsGuard = "EXISTS (SELECT 1 FROM admin_reset_archives WHERE id = ?)";
  const results = await db.batch([
    archiveGuard,
    auditResetStatement(db, userId, filter, archiveId, summary, createdAt),
    db.prepare(`UPDATE stores SET revenue = revenue - ${selectedRevenueSql}, expense = expense - ${selectedExpenseSql}
      WHERE id = ? AND ${existsGuard}`)
      .bind(...where.bindings, ...where.bindings, filter.storeId, archiveId),
    db.prepare(`DELETE FROM shift_sessions WHERE id IN (SELECT s.id FROM shift_sessions s WHERE ${where.sql})
      AND ${existsGuard}`).bind(...where.bindings, archiveId),
  ]);
  if (affectedRows(results[0]) !== 1) {
    await assertPeriodUnlocked(db, filter.storeId, resetFilterPeriod(filter));
    const diagnostics = await db.prepare(`SELECT
        EXISTS(SELECT 1 FROM shift_sessions s WHERE ${where.sql}
          AND (s.status = 'ACTIVE' OR s.ended_at IS NULL)) AS active,
        EXISTS(SELECT 1 FROM orders o WHERE o.store_id = ? AND o.shift_code IN (
          SELECT s.shift_code FROM shift_sessions s WHERE ${where.sql}
        )) AS linked,
        (SELECT revenue - ${selectedRevenueSql} FROM stores WHERE id = ?) AS nextRevenue,
        (SELECT expense - ${selectedExpenseSql} FROM stores WHERE id = ?) AS nextExpense`)
      .bind(
        ...where.bindings,
        filter.storeId,
        ...where.bindings,
        ...where.bindings,
        filter.storeId,
        ...where.bindings,
        filter.storeId,
      )
      .first<{ active: number; linked: number; nextRevenue: number; nextExpense: number }>();
    if (diagnostics?.active) throw new Error("Không thể reset ca đang làm. Hãy kết ca trước.");
    if (diagnostics?.linked) throw new Error("Ca còn đơn hàng. Hãy reset đơn hàng của ca trước rồi mới reset chấm công.");
    if (Number(diagnostics?.nextRevenue ?? -1) < 0 || Number(diagnostics?.nextExpense ?? -1) < 0) {
      throw new Error("Doanh thu hoặc chi phí cửa hàng cần được đối soát trước khi reset dữ liệu.");
    }
    throw new Error("Dữ liệu đã thay đổi sau khi xem trước. Vui lòng tải lại trước khi reset.");
  }
  return archiveId;
}

export async function POST(request: Request) {
  const user = await requireSuperAdmin(request);
  if (!user) return json({ message: "Chỉ quản trị cấp cao được Reset Dữ Liệu." }, 403);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const filter = parseAdminResetFilter(body);
    const previewToken = typeof body.previewToken === "string" ? body.previewToken : "";
    const db = await initDb();
    const store = await storeInfo(db, filter.storeId);
    if (!store) return json({ message: "Không tìm thấy cửa hàng." }, 404);
    if (body.confirmation !== store.name) {
      return json({ message: `Hãy nhập chính xác tên cửa hàng “${store.name}” để xác nhận.` }, 400);
    }
    const preview = await loadSnapshot(db, filter);
    if (!preview.rows.length) return json({ message: "Không có dữ liệu phù hợp để reset." }, 409);
    const currentPreviewToken = await sha256(`${JSON.stringify(filter)}\n${preview.snapshotJson}`);
    if (!previewToken || previewToken !== currentPreviewToken) {
      return json({ message: "Dữ liệu xem trước đã thay đổi. Vui lòng tải lại trước khi reset." }, 409);
    }
    const summary = summarizeResetRows(filter, preview.rows);
    const archiveId = filter.kind === "ORDERS"
      ? await resetOrders(
        db, user.id, filter, preview.snapshotJson, preview.canonicalRowsJson, preview.storeSnapshot, summary,
      )
      : await resetAttendance(
        db, user.id, filter, preview.snapshotJson, preview.canonicalRowsJson, preview.storeSnapshot,
        preview.rows as ResetShiftSnapshot[], summary,
      );
    return json({ message: "Đã reset dữ liệu theo phạm vi đã chọn.", archiveId, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể reset dữ liệu.";
    const status = /khóa/u.test(message) ? 423 : /đã thay đổi|đang làm|còn đơn hàng|chưa liên kết|đối soát/u.test(message) ? 409 : 400;
    return json({ message }, status);
  }
}
