import { durationSeconds } from "../../lib/finance";
import { attendanceDeltaMinutes, attendanceStatusAt, shiftUtcRange } from "../../lib/scheduling";
import { storePeriodUnlockedSql } from "./store-period-lock";

export const EMPLOYEE_STATUSES = ["ACTIVE", "SUSPENDED", "TERMINATED"] as const;

export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

type Database = D1Database;

type EmployeeLifecycleRow = {
  id: string;
  storeId: string;
  code: string;
  name: string;
  status: string;
  inactiveAt: string | null;
  lifecycleVersion: number;
};

type LifecycleActiveShift = {
  id: string;
  shiftCode: string;
  storeId: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  workDate: string | null;
  startedAt: string;
  attendanceGraceMinutes: number;
  cashRevenue: number;
  transferRevenue: number;
  expenseAmount: number;
  closeStatus: string;
  orderCashRevenue: number;
  orderTransferRevenue: number;
  unknownTenderCount: number;
  storeRevenue: number;
  storeExpense: number;
  period: string;
  locked: number;
};

type LifecycleShiftClosure = LifecycleActiveShift & {
  durationSeconds: number;
  attendanceDeltaMinutes: number | null;
  attendanceStatus: "EARLY" | "ON_TIME" | "LATE" | null;
  resolvedScheduledStartAt: string | null;
  resolvedScheduledEndAt: string | null;
  closeToken: string;
};

const lifecycleAccountingDate = "COALESCE(NULLIF(s.work_date, ''), date(datetime(s.started_at, '+7 hours')))";
const lifecyclePeriod = `substr(${lifecycleAccountingDate}, 1, 7)`;

function lifecyclePeriodUnlockedSql() {
  return `${storePeriodUnlockedSql("s.store_id", lifecyclePeriod)} AND NOT EXISTS (
    SELECT 1 FROM business_records sharing_lock
    WHERE sharing_lock.category = 'DIVIDEND' AND sharing_lock.status = 'LOCKED'
      AND json_extract(sharing_lock.data_json, '$.period') = ${lifecyclePeriod}
  )`;
}

async function loadLifecycleActiveShifts(db: Database, employeeId: string) {
  return (await db.prepare(`SELECT s.id, s.shift_code AS shiftCode, s.store_id AS storeId,
      s.shift_name AS shiftName, s.scheduled_start AS scheduledStart,
      s.scheduled_end AS scheduledEnd, s.scheduled_start_at AS scheduledStartAt,
      s.scheduled_end_at AS scheduledEndAt, s.work_date AS workDate,
      s.started_at AS startedAt, s.attendance_grace_minutes AS attendanceGraceMinutes,
      s.cash_revenue AS cashRevenue,
      s.transfer_revenue AS transferRevenue, s.expense_amount AS expenseAmount,
      s.close_status AS closeStatus,
      COALESCE((SELECT SUM(o.amount) FROM orders o
        WHERE o.store_id = s.store_id AND o.employee_id = s.employee_id
          AND o.shift_code = s.shift_code AND o.status = 'COMPLETED'
          AND o.payment_method = 'CASH'), 0) AS orderCashRevenue,
      COALESCE((SELECT SUM(o.amount) FROM orders o
        WHERE o.store_id = s.store_id AND o.employee_id = s.employee_id
          AND o.shift_code = s.shift_code AND o.status = 'COMPLETED'
          AND o.payment_method = 'BANK_TRANSFER'), 0) AS orderTransferRevenue,
      (SELECT COUNT(*) FROM orders o
        WHERE o.store_id = s.store_id AND o.employee_id = s.employee_id
          AND o.shift_code = s.shift_code AND o.status = 'COMPLETED'
          AND COALESCE(o.payment_method, '') NOT IN ('CASH', 'BANK_TRANSFER')) AS unknownTenderCount,
      st.revenue AS storeRevenue, st.expense AS storeExpense,
      ${lifecyclePeriod} AS period,
      CASE WHEN ${lifecyclePeriodUnlockedSql()} THEN 0 ELSE 1 END AS locked
    FROM shift_sessions s JOIN stores st ON st.id = s.store_id
    WHERE s.employee_id = ? AND s.status = 'ACTIVE' AND s.ended_at IS NULL
    ORDER BY s.started_at, s.id`)
    .bind(employeeId).all<LifecycleActiveShift>()).results;
}

function safeLifecycleMoney(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

export type EmployeeStatusTransitionResult = {
  changed: boolean;
  status: EmployeeStatus;
  lifecycleVersion: number;
  statusUpdatedAt: string | null;
};

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number }; changes?: number } | null)?.meta?.changes ?? 0);
}

export function isEmployeeStatus(value: unknown): value is EmployeeStatus {
  return typeof value === "string" && (EMPLOYEE_STATUSES as readonly string[]).includes(value);
}

export function normalizedEmployeeStatus(value: unknown): EmployeeStatus | "ARCHIVED" {
  if (value === "ARCHIVED") return "ARCHIVED";
  if (value === "INACTIVE" || value === "TERMINATED") return "TERMINATED";
  if (value === "SUSPENDED") return "SUSPENDED";
  return "ACTIVE";
}

export function employeeStatusLabel(status: EmployeeStatus) {
  if (status === "SUSPENDED") return "Tạm ngưng";
  if (status === "TERMINATED") return "Đã nghỉ việc";
  return "Đang làm việc";
}

/**
 * Resolve an employee's lifecycle state at an exclusive UTC cutoff. The first
 * subquery handles normal history. The earliest `from_status` reconstructs the
 * state before lifecycle history was introduced (or before the first recorded
 * transition), and the live row is only the final legacy fallback.
 *
 * The returned fragment contains one `?` binding for the cutoff timestamp.
 */
export function employeeStatusAtInstantSql(employeeAlias = "e") {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(employeeAlias)) {
    throw new Error("Invalid employee SQL alias");
  }
  return `COALESCE(
    (SELECT lifecycle_last.to_status
      FROM employee_status_history lifecycle_last
      WHERE lifecycle_last.employee_id = ${employeeAlias}.id
        AND lifecycle_last.effective_at < ?
      ORDER BY lifecycle_last.effective_at DESC, lifecycle_last.id DESC
      LIMIT 1),
    (SELECT lifecycle_first.from_status
      FROM employee_status_history lifecycle_first
      WHERE lifecycle_first.employee_id = ${employeeAlias}.id
      ORDER BY lifecycle_first.effective_at ASC, lifecycle_first.id ASC
      LIMIT 1),
    ${employeeAlias}.status
  )`;
}

/** Convert the point-in-time lifecycle state to the two-state payroll policy. */
export function employeeFinancialStatusForPeriod(
  statusAtPeriodEnd: unknown,
  hasLifecycleHistory: boolean | number,
  legacyInactivePeriod: string | null,
  period: string,
) {
  const status = normalizedEmployeeStatus(statusAtPeriodEnd);
  if (status === "ARCHIVED") return "INACTIVE" as const;
  if (status !== "TERMINATED") return "ACTIVE" as const;
  // A history-derived TERMINATED state is already known to be effective at the
  // requested cutoff. Only legacy rows need the old inactive_at comparison.
  if (hasLifecycleHistory) return "INACTIVE" as const;
  return !legacyInactivePeriod || legacyInactivePeriod <= period
    ? "INACTIVE" as const
    : "ACTIVE" as const;
}

export async function loadEmployeeLifecycle(
  db: Database,
  employeeId: string,
  storeId: string,
) {
  return db.prepare(`SELECT id, store_id AS storeId, code, name, status,
      inactive_at AS inactiveAt, COALESCE(lifecycle_version, 0) AS lifecycleVersion
    FROM employees
    WHERE id = ? AND store_id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
    LIMIT 1`)
    .bind(employeeId, storeId)
    .first<EmployeeLifecycleRow>();
}

async function transitionInactiveEmployeeStatus(
  input: {
    db: Database;
    actorUserId: string;
    employeeId: string;
    storeId: string;
    status: Exclude<EmployeeStatus, "ACTIVE">;
    expectedVersion?: number | null;
    reason: string;
  },
  existing: EmployeeLifecycleRow,
  currentStatus: EmployeeStatus,
  currentVersion: number,
): Promise<EmployeeStatusTransitionResult> {
  const transitionAt = new Date().toISOString();
  const rows = await loadLifecycleActiveShifts(input.db, input.employeeId);
  if (rows.some((row) => Number(row.locked) === 1)) throw new Error("EMPLOYEE_SHIFT_PERIOD_LOCKED");
  if (rows.some((row) => Number(row.unknownTenderCount) > 0)) throw new Error("EMPLOYEE_SHIFT_UNKNOWN_TENDER");

  const closures = rows.map<LifecycleShiftClosure>((row) => {
    const amounts = [row.cashRevenue, row.transferRevenue, row.expenseAmount, row.orderCashRevenue, row.orderTransferRevenue].map(Number);
    if (!amounts.every(safeLifecycleMoney)) throw new Error("EMPLOYEE_SHIFT_FINANCE_INVARIANT");
    const legacyRange = !row.scheduledStartAt && row.workDate && row.scheduledStart && row.scheduledEnd
      ? shiftUtcRange(row.workDate, row.scheduledStart, row.scheduledEnd)
      : null;
    const resolvedScheduledStartAt = row.scheduledStartAt ?? legacyRange?.startAt ?? null;
    const resolvedScheduledEndAt = row.scheduledEndAt ?? legacyRange?.endAt ?? null;
    const delta = resolvedScheduledStartAt ? attendanceDeltaMinutes(row.startedAt, resolvedScheduledStartAt) : null;
    return {
      ...row,
      durationSeconds: durationSeconds(row.startedAt, transitionAt),
      attendanceDeltaMinutes: delta,
      attendanceStatus: resolvedScheduledStartAt
        ? attendanceStatusAt(row.startedAt, resolvedScheduledStartAt, row.attendanceGraceMinutes)
        : null,
      resolvedScheduledStartAt,
      resolvedScheduledEndAt,
      closeToken: `EMPLOYEE_STATUS_CHANGE:${crypto.randomUUID()}`,
    };
  });
  const stores = new Map<string, { storeId: string; revenue: number; expense: number; revenueDelta: number }>();
  for (const row of closures) {
    const current = stores.get(row.storeId) ?? {
      storeId: row.storeId,
      revenue: Number(row.storeRevenue),
      expense: Number(row.storeExpense),
      revenueDelta: 0,
    };
    if (current.revenue !== Number(row.storeRevenue) || current.expense !== Number(row.storeExpense)
      || !safeLifecycleMoney(current.revenue) || !safeLifecycleMoney(current.expense)) {
      throw new Error("EMPLOYEE_SHIFT_FINANCE_INVARIANT");
    }
    current.revenueDelta += Number(row.orderCashRevenue) + Number(row.orderTransferRevenue)
      - Number(row.cashRevenue) - Number(row.transferRevenue);
    if (!Number.isSafeInteger(current.revenueDelta)
      || !Number.isSafeInteger(current.revenue + current.revenueDelta)
      || current.revenue + current.revenueDelta < 0) {
      throw new Error("EMPLOYEE_SHIFT_FINANCE_INVARIANT");
    }
    stores.set(row.storeId, current);
  }

  const preconditions = [
    `(SELECT COUNT(*) FROM shift_sessions active_shift
      WHERE active_shift.employee_id = e.id AND active_shift.status = 'ACTIVE'
        AND active_shift.ended_at IS NULL) = ?`,
  ];
  const preconditionBindings: unknown[] = [closures.length];
  for (const row of closures) {
    preconditions.push(`EXISTS (SELECT 1 FROM shift_sessions s
      WHERE s.id = ? AND s.employee_id = e.id AND s.store_id = ? AND s.shift_code = ?
        AND s.status = 'ACTIVE' AND s.ended_at IS NULL AND s.started_at = ?
        AND s.scheduled_start IS ? AND s.scheduled_end IS ?
        AND s.scheduled_start_at IS ? AND s.scheduled_end_at IS ? AND s.work_date IS ?
        AND s.attendance_grace_minutes = ?
        AND s.cash_revenue = ? AND s.transfer_revenue = ? AND s.expense_amount = ?
        AND s.close_status = ?
        AND COALESCE((SELECT SUM(cash_order.amount) FROM orders cash_order
          WHERE cash_order.store_id = s.store_id AND cash_order.employee_id = s.employee_id
            AND cash_order.shift_code = s.shift_code AND cash_order.status = 'COMPLETED'
            AND cash_order.payment_method = 'CASH'), 0) = ?
        AND COALESCE((SELECT SUM(transfer_order.amount) FROM orders transfer_order
          WHERE transfer_order.store_id = s.store_id AND transfer_order.employee_id = s.employee_id
            AND transfer_order.shift_code = s.shift_code AND transfer_order.status = 'COMPLETED'
            AND transfer_order.payment_method = 'BANK_TRANSFER'), 0) = ?
        AND NOT EXISTS (SELECT 1 FROM orders unknown_tender
          WHERE unknown_tender.store_id = s.store_id AND unknown_tender.employee_id = s.employee_id
            AND unknown_tender.shift_code = s.shift_code AND unknown_tender.status = 'COMPLETED'
            AND COALESCE(unknown_tender.payment_method, '') NOT IN ('CASH', 'BANK_TRANSFER'))
        AND ${lifecyclePeriodUnlockedSql()})`);
    preconditionBindings.push(
      row.id, row.storeId, row.shiftCode, row.startedAt,
      row.scheduledStart, row.scheduledEnd, row.scheduledStartAt, row.scheduledEndAt, row.workDate,
      row.attendanceGraceMinutes,
      row.cashRevenue, row.transferRevenue, row.expenseAmount, row.closeStatus,
      row.orderCashRevenue, row.orderTransferRevenue,
    );
  }
  for (const store of stores.values()) {
    preconditions.push(`EXISTS (SELECT 1 FROM stores transition_store
      WHERE transition_store.id = ? AND transition_store.revenue = ?
        AND transition_store.expense = ? AND transition_store.revenue + ? >= 0)`);
    preconditionBindings.push(store.storeId, store.revenue, store.expense, store.revenueDelta);
  }

  const transitionId = crypto.randomUUID();
  const historyId = crypto.randomUUID();
  const nextVersion = currentVersion + 1;
  const transitionGate = `EXISTS (SELECT 1 FROM audit_logs transition_gate WHERE transition_gate.id = '${transitionId.replaceAll("'", "''")}')`;
  const closeReason = `EMPLOYEE_STATUS_CHANGE:${input.status}`;
  const finalDetail = JSON.stringify({
    storeId: input.storeId,
    employeeCode: existing.code,
    from: currentStatus,
    to: input.status,
    reason: input.reason,
    at: transitionAt,
    historyId,
    autoClosedShifts: closures.map((row) => ({
      id: row.id,
      shiftCode: row.shiftCode,
      storeId: row.storeId,
      startedAt: row.startedAt,
      endedAt: transitionAt,
      durationSeconds: row.durationSeconds,
      cashRevenueBefore: Number(row.cashRevenue),
      transferRevenueBefore: Number(row.transferRevenue),
      cashRevenueAfter: Number(row.orderCashRevenue),
      transferRevenueAfter: Number(row.orderTransferRevenue),
      expenseAmount: Number(row.expenseAmount),
      closeReason,
    })),
  });
  const statements: D1PreparedStatement[] = [
    input.db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, 'EMPLOYEE_STATUS_CHANGE_PREPARED', 'EMPLOYEE', e.id, ?, ?
      FROM employees e
      WHERE e.id = ? AND e.store_id = ? AND e.status != 'ARCHIVED' AND e.deleted_at IS NULL
        AND COALESCE(e.lifecycle_version, 0) = ? AND ${preconditions.join(" AND ")}`)
      .bind(
        transitionId, input.actorUserId,
        JSON.stringify({ storeId: input.storeId, from: currentStatus, to: input.status, reason: input.reason }),
        transitionAt, input.employeeId, input.storeId, currentVersion,
        ...preconditionBindings,
      ),
  ];
  const closeIndexes: number[] = [];
  for (const row of closures) {
    closeIndexes.push(statements.length);
    statements.push(input.db.prepare(`UPDATE shift_sessions SET
        scheduled_start_at = COALESCE(scheduled_start_at, ?),
        scheduled_end_at = COALESCE(scheduled_end_at, ?),
        ended_at = ?, duration_seconds = ?, admin_adjusted_duration_seconds = NULL,
        attendance_status = ?, attendance_delta_minutes = ?,
        cash_revenue = ?, transfer_revenue = ?, close_reason = ?, close_status = ?,
        status = 'COMPLETED'
      WHERE id = ? AND employee_id = ? AND status = 'ACTIVE' AND ended_at IS NULL
        AND ${transitionGate}`)
      .bind(
        row.resolvedScheduledStartAt, row.resolvedScheduledEndAt,
        transitionAt, row.durationSeconds, row.attendanceStatus, row.attendanceDeltaMinutes,
        row.orderCashRevenue, row.orderTransferRevenue, closeReason, row.closeToken,
        row.id, input.employeeId,
      ));
  }
  const storeIndexes: number[] = [];
  for (const store of stores.values()) {
    storeIndexes.push(statements.length);
    statements.push(input.db.prepare(`UPDATE stores SET revenue = revenue + ?
      WHERE id = ? AND revenue = ? AND expense = ? AND revenue + ? >= 0 AND ${transitionGate}`)
      .bind(store.revenueDelta, store.storeId, store.revenue, store.expense, store.revenueDelta));
  }
  for (const row of closures) {
    statements.push(
      input.db.prepare(`INSERT INTO audit_logs
          (id, user_id, action, entity_type, entity_id, detail, created_at)
        SELECT ?, ?, 'EMPLOYEE_STATUS_CHANGE_SHIFT_CLOSE', 'SHIFT_SESSION', id, ?, ?
        FROM shift_sessions WHERE id = ? AND status = 'COMPLETED' AND close_status = ?
          AND ${transitionGate}`)
        .bind(crypto.randomUUID(), input.actorUserId, JSON.stringify({
          employeeId: input.employeeId,
          status: input.status,
          reason: input.reason,
          before: {
            startedAt: row.startedAt,
            cashRevenue: Number(row.cashRevenue),
            transferRevenue: Number(row.transferRevenue),
            expenseAmount: Number(row.expenseAmount),
            closeStatus: row.closeStatus,
          },
          after: {
            endedAt: transitionAt,
            durationSeconds: row.durationSeconds,
            cashRevenue: Number(row.orderCashRevenue),
            transferRevenue: Number(row.orderTransferRevenue),
            closeReason,
          },
        }), transitionAt, row.id, row.closeToken),
      input.db.prepare(`UPDATE shift_sessions SET close_status = 'CONFIRMED'
        WHERE id = ? AND status = 'COMPLETED' AND close_status = ? AND ${transitionGate}`)
        .bind(row.id, row.closeToken),
    );
  }
  const employeeIndex = statements.length;
  statements.push(
    input.db.prepare(`UPDATE employees SET status = ?,
        inactive_at = CASE WHEN ? = 'TERMINATED' THEN ? ELSE inactive_at END,
        status_updated_at = ?, lifecycle_version = lifecycle_version + 1
      WHERE id = ? AND store_id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
        AND lifecycle_version = ? AND ${transitionGate}
        AND NOT EXISTS (SELECT 1 FROM shift_sessions active_shift
          WHERE active_shift.employee_id = employees.id
            AND active_shift.status = 'ACTIVE' AND active_shift.ended_at IS NULL)`)
      .bind(input.status, input.status, transitionAt, transitionAt, input.employeeId, input.storeId, currentVersion),
    input.db.prepare(`UPDATE users SET shift_active = 0, current_shift = NULL, shift_started_at = NULL
      WHERE employee_id = ? AND ${transitionGate}`).bind(input.employeeId),
    input.db.prepare(`INSERT INTO employee_status_history
        (id, employee_id, store_id, from_status, to_status, effective_at, actor_user_id, reason, created_at)
      SELECT ?, id, store_id, ?, ?, ?, ?, ?, ? FROM employees
      WHERE id = ? AND store_id = ? AND lifecycle_version = ? AND status = ? AND ${transitionGate}`)
      .bind(
        historyId, currentStatus, input.status, transitionAt, input.actorUserId, input.reason,
        transitionAt, input.employeeId, input.storeId, nextVersion, input.status,
      ),
    input.db.prepare(`UPDATE employee_transfers SET status = 'CANCELLED',
        updated_at = ?, ended_at = COALESCE(ended_at, ?)
      WHERE employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE') AND ${transitionGate}`)
      .bind(transitionAt, transitionAt, input.employeeId),
    input.db.prepare(`DELETE FROM sessions
      WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?) AND ${transitionGate}`)
      .bind(input.employeeId),
    input.db.prepare(`UPDATE audit_logs SET action = 'EMPLOYEE_STATUS_CHANGE', detail = ?
      WHERE id = ? AND action = 'EMPLOYEE_STATUS_CHANGE_PREPARED'
        AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND store_id = ?
          AND lifecycle_version = ? AND status = ?)`)
      .bind(finalDetail, transitionId, input.employeeId, input.storeId, nextVersion, input.status),
  );
  const results = await input.db.batch(statements);
  if (affectedRows(results[0]) !== 1 || affectedRows(results[employeeIndex]) !== 1
    || closeIndexes.some((index) => affectedRows(results[index]) !== 1)
    || storeIndexes.some((index) => affectedRows(results[index]) !== 1)) {
    const current = await loadLifecycleActiveShifts(input.db, input.employeeId);
    if (current.some((row) => Number(row.locked) === 1)) throw new Error("EMPLOYEE_SHIFT_PERIOD_LOCKED");
    throw new Error("EMPLOYEE_VERSION_CONFLICT");
  }
  return {
    changed: true,
    status: input.status,
    lifecycleVersion: nextVersion,
    statusUpdatedAt: transitionAt,
  };
}

/**
 * Change the account lifecycle state. Moving away from ACTIVE atomically
 * closes any active attendance session from server order truth, reconciles the
 * store revenue delta, preserves the recorded expense, and then revokes the
 * login session. Period locks, unknown tenders, negative finance and every
 * concurrent order/END race are guarded inside the same D1/SQLite batch.
 */
export async function transitionEmployeeStatus(input: {
  db: Database;
  actorUserId: string;
  employeeId: string;
  storeId: string;
  status: EmployeeStatus;
  expectedVersion?: number | null;
  reason: string;
}): Promise<EmployeeStatusTransitionResult> {
  const existing = await loadEmployeeLifecycle(input.db, input.employeeId, input.storeId);
  if (!existing) throw new Error("EMPLOYEE_NOT_FOUND");

  const currentStatus = normalizedEmployeeStatus(existing.status);
  if (currentStatus === "ARCHIVED") throw new Error("EMPLOYEE_NOT_FOUND");
  if (currentStatus === input.status) {
    return {
      changed: false,
      status: input.status,
      lifecycleVersion: Number(existing.lifecycleVersion ?? 0),
      statusUpdatedAt: null,
    };
  }

  const currentVersion = Number(existing.lifecycleVersion ?? 0);
  if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
    throw new Error("EMPLOYEE_VERSION_CONFLICT");
  }
  const requestedStatus = input.status;
  if (requestedStatus !== "ACTIVE") {
    return transitionInactiveEmployeeStatus({ ...input, status: requestedStatus }, existing, currentStatus, currentVersion);
  }

  const transitionAt = new Date().toISOString();
  const historyId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const nextVersion = currentVersion + 1;
  const detail = JSON.stringify({
    storeId: input.storeId,
    employeeCode: existing.code,
    from: currentStatus,
    to: input.status,
    reason: input.reason,
    at: transitionAt,
    historyId,
  });

  const results = await input.db.batch([
    input.db.prepare(`UPDATE employees SET
        status = ?,
        inactive_at = CASE WHEN ? = 'TERMINATED' THEN ? ELSE inactive_at END,
        status_updated_at = ?,
        lifecycle_version = lifecycle_version + 1
      WHERE id = ? AND store_id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
        AND lifecycle_version = ?
        AND (? = 'ACTIVE' OR NOT EXISTS (
          SELECT 1 FROM shift_sessions active_shift
          WHERE active_shift.employee_id = employees.id
            AND active_shift.status = 'ACTIVE' AND active_shift.ended_at IS NULL
        ))`)
      .bind(
        input.status,
        input.status,
        transitionAt,
        transitionAt,
        input.employeeId,
        input.storeId,
        currentVersion,
        input.status,
      ),
    input.db.prepare(`INSERT INTO employee_status_history
        (id, employee_id, store_id, from_status, to_status, effective_at, actor_user_id, reason, created_at)
      SELECT ?, id, store_id, ?, ?, ?, ?, ?, ?
      FROM employees
      WHERE id = ? AND store_id = ? AND lifecycle_version = ? AND status = ?`)
      .bind(
        historyId,
        currentStatus,
        input.status,
        transitionAt,
        input.actorUserId,
        input.reason,
        transitionAt,
        input.employeeId,
        input.storeId,
        nextVersion,
        input.status,
      ),
    input.db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, 'EMPLOYEE_STATUS_CHANGE', 'EMPLOYEE', id, ?, ?
      FROM employees
      WHERE id = ? AND store_id = ? AND lifecycle_version = ? AND status = ?`)
      .bind(
        auditId,
        input.actorUserId,
        detail,
        transitionAt,
        input.employeeId,
        input.storeId,
        nextVersion,
        input.status,
      ),
    input.db.prepare(`DELETE FROM sessions
      WHERE ? != 'ACTIVE'
        AND user_id IN (SELECT id FROM users WHERE employee_id = ?)
        AND EXISTS (
          SELECT 1 FROM employees
          WHERE id = ? AND store_id = ? AND lifecycle_version = ? AND status = ?
        )`)
      .bind(
        input.status,
        input.employeeId,
        input.employeeId,
        input.storeId,
        nextVersion,
        input.status,
      ),
  ]);

  if (affectedRows(results[0]) !== 1) {
    if (input.status !== "ACTIVE") {
      const activeShift = await input.db.prepare(`SELECT id FROM shift_sessions
        WHERE employee_id = ? AND status = 'ACTIVE' AND ended_at IS NULL LIMIT 1`)
        .bind(input.employeeId).first<{ id: string }>();
      if (activeShift) throw new Error("EMPLOYEE_ACTIVE_SHIFT");
    }
    throw new Error("EMPLOYEE_VERSION_CONFLICT");
  }
  if (affectedRows(results[1]) !== 1 || affectedRows(results[2]) !== 1) {
    throw new Error("EMPLOYEE_TRANSITION_INCOMPLETE");
  }

  return {
    changed: true,
    status: input.status,
    lifecycleVersion: nextVersion,
    statusUpdatedAt: transitionAt,
  };
}
