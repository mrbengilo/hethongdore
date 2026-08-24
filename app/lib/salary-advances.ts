import { sumVnd } from "./finance";
import {
  buildCashflowEntry,
  prepareCashflowEntryInsertWhere,
} from "../api/_lib/cashflow-ledger";

export type SalaryAdvanceStatus = "DRAFT" | "PAID";

export type SalaryAdvance = {
  id: string;
  storeId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  period: string;
  advanceDate: string;
  amount: number;
  grossEntitlementSnapshot: number;
  availableBeforeSnapshot: number;
  remainingAfterSnapshot: number;
  note: string;
  status: SalaryAdvanceStatus;
  version: number;
  clientRequestId: string;
  payloadHash: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
  paidBy: string | null;
  paidByName: string | null;
  paidAt: string | null;
};

export type SalaryAdvanceTotals = {
  employeeId: string;
  pendingAmount: number;
  paidAmount: number;
  reservedAmount: number;
};

export type SalaryAdvanceCoverageSource = {
  employeeId: string;
  employeeName?: string;
  totalPay: number;
  salaryAdvancePending?: number;
  salaryAdvancePaid?: number;
  salaryAdvanceReserved?: number;
};

export type SalaryAdvanceCoverage = {
  covered: boolean;
  totalCoverageGap: number;
  totalOverpaymentDebt: number;
  employees: Array<{
    employeeId: string;
    employeeName: string;
    grossEntitlement: number;
    pendingAmount: number;
    paidAmount: number;
    reservedAmount: number;
    availableAmount: number;
    coverageGap: number;
    overpaymentDebt: number;
  }>;
};

function safeCoverageAmount(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

/**
 * Central, deterministic payroll/advance reconciliation. A positive
 * coverageGap means the current payroll can no longer cover all DRAFT+PAID
 * reservations; overpaymentDebt is the already-paid portion above gross pay.
 * Payroll close/finalize must fail closed whenever covered is false.
 */
export function salaryAdvanceCoverage(items: SalaryAdvanceCoverageSource[]): SalaryAdvanceCoverage {
  const employees = items.map((item) => {
    const grossEntitlement = safeCoverageAmount(item.totalPay);
    const pendingAmount = safeCoverageAmount(item.salaryAdvancePending);
    const paidAmount = safeCoverageAmount(item.salaryAdvancePaid);
    const reservedAmount = item.salaryAdvanceReserved === undefined
      ? pendingAmount + paidAmount
      : safeCoverageAmount(item.salaryAdvanceReserved);
    return {
      employeeId: item.employeeId,
      employeeName: String(item.employeeName ?? "").trim(),
      grossEntitlement,
      pendingAmount,
      paidAmount,
      reservedAmount,
      availableAmount: Math.max(0, grossEntitlement - reservedAmount),
      coverageGap: Math.max(0, reservedAmount - grossEntitlement),
      overpaymentDebt: Math.max(0, paidAmount - grossEntitlement),
    };
  });
  const totalCoverageGap = employees.reduce((sum, item) => sum + item.coverageGap, 0);
  const totalOverpaymentDebt = employees.reduce((sum, item) => sum + item.overpaymentDebt, 0);
  return {
    covered: totalCoverageGap === 0,
    totalCoverageGap,
    totalOverpaymentDebt,
    employees,
  };
}

export function salaryAdvanceSettlementSplit(input: {
  employeeBaseSalary: number;
  employeeTotalPay: number;
  managerSalary: number;
  managerBonus: number;
  advanceAmount: number;
}) {
  const employeeBaseSalary = safeCoverageAmount(input.employeeBaseSalary);
  const employeeTotalPay = safeCoverageAmount(input.employeeTotalPay);
  const managerSalary = safeCoverageAmount(input.managerSalary);
  const managerBonus = safeCoverageAmount(input.managerBonus);
  const advanceAmount = safeCoverageAmount(input.advanceAmount);
  const employeeRewards = Math.max(0, employeeTotalPay - employeeBaseSalary);
  const advanceAgainstSalary = Math.min(employeeBaseSalary, advanceAmount);
  const advanceAgainstRewards = Math.min(
    employeeRewards,
    Math.max(0, advanceAmount - advanceAgainstSalary),
  );
  const salaryTotal = sumVnd([employeeBaseSalary - advanceAgainstSalary, managerSalary]);
  const rewardAllowanceTotal = sumVnd([employeeRewards - advanceAgainstRewards, managerBonus]);
  return {
    advanceAgainstSalary,
    advanceAgainstRewards,
    employeeRemaining: sumVnd([
      employeeBaseSalary - advanceAgainstSalary,
      employeeRewards - advanceAgainstRewards,
    ]),
    salaryTotal,
    rewardAllowanceTotal,
    grandTotal: sumVnd([salaryTotal, rewardAllowanceTotal]),
  };
}

type SalaryAdvanceMutationReason =
  | "FORBIDDEN"
  | "INACTIVE"
  | "LOCKED"
  | "LIMIT"
  | "NOT_FOUND"
  | "PAID"
  | "STALE"
  | "IDEMPOTENCY";

export class SalaryAdvanceConflictError extends Error {
  constructor(public readonly reason: SalaryAdvanceMutationReason) {
    super(reason);
    this.name = "SalaryAdvanceConflictError";
  }
}

type CreateSalaryAdvanceInput = {
  id: string;
  storeId: string;
  employeeId: string;
  period: string;
  advanceDate: string;
  amount: number;
  note: string;
  actorId: string;
  clientRequestId: string;
  payloadHash: string;
  payrollRevision: string;
  grossEntitlement: number;
  now: string;
};

type UpdateSalaryAdvanceInput = {
  id: string;
  storeId: string;
  expectedVersion: number;
  advanceDate: string;
  amount: number;
  note: string;
  actorId: string;
  payrollRevision: string;
  grossEntitlement: number;
  now: string;
};

type ConfirmSalaryAdvanceInput = {
  id: string;
  storeId: string;
  expectedVersion: number;
  actorId: string;
  payrollRevision: string;
  grossEntitlement: number;
  now: string;
};

const salaryAdvanceSelect = `SELECT
  advance.id,
  advance.store_id AS storeId,
  advance.employee_id AS employeeId,
  COALESCE(employee.code, 'ĐÃ XÓA') AS employeeCode,
  COALESCE(employee.name, 'Nhân viên đã xóa') AS employeeName,
  advance.period,
  advance.advance_date AS advanceDate,
  advance.amount,
  advance.gross_entitlement_snapshot AS grossEntitlementSnapshot,
  advance.available_before_snapshot AS availableBeforeSnapshot,
  advance.remaining_after_snapshot AS remainingAfterSnapshot,
  advance.note,
  advance.status,
  advance.version,
  advance.client_request_id AS clientRequestId,
  advance.payload_hash AS payloadHash,
  advance.created_by AS createdBy,
  COALESCE(creator.name, 'Quản lý cửa hàng') AS createdByName,
  advance.created_at AS createdAt,
  advance.updated_by AS updatedBy,
  COALESCE(updater.name, 'Quản lý cửa hàng') AS updatedByName,
  advance.updated_at AS updatedAt,
  advance.paid_by AS paidBy,
  payer.name AS paidByName,
  advance.paid_at AS paidAt
FROM salary_advances advance
LEFT JOIN employees employee ON employee.id = advance.employee_id
LEFT JOIN users creator ON creator.id = advance.created_by
LEFT JOIN users updater ON updater.id = advance.updated_by
LEFT JOIN users payer ON payer.id = advance.paid_by`;

function employeePayrollAttributionExpression(
  employeeExpression: string,
  storeExpression: string,
  periodExpression: string,
) {
  return `EXISTS (
    SELECT 1 FROM employees eligible_employee
    WHERE eligible_employee.id = ${employeeExpression}
      AND eligible_employee.deleted_at IS NULL
      AND (
        eligible_employee.store_id = ${storeExpression}
        OR EXISTS (
          SELECT 1 FROM shift_sessions eligible_shift
          WHERE eligible_shift.employee_id = eligible_employee.id
            AND eligible_shift.store_id = ${storeExpression}
            AND eligible_shift.status = 'COMPLETED'
            AND eligible_shift.ended_at IS NOT NULL
            AND COALESCE(eligible_shift.reconciliation_status, 'CLEAR') IN ('CLEAR', 'CONFIRMED')
            AND COALESCE(
              CASE WHEN NULLIF(eligible_shift.work_date, '') IS NOT NULL
                THEN substr(eligible_shift.work_date, 1, 7) END,
              strftime('%Y-%m', eligible_shift.started_at, '+7 hours')
            ) = ${periodExpression}
        )
        OR EXISTS (
          SELECT 1 FROM employee_transfers eligible_transfer
          WHERE eligible_transfer.employee_id = eligible_employee.id
            AND eligible_transfer.target_store_id = ${storeExpression}
            AND eligible_transfer.status != 'CANCELLED'
            AND eligible_transfer.start_date < date(${periodExpression} || '-01', '+1 month')
            AND eligible_transfer.end_date >= ${periodExpression} || '-01'
        )
        OR EXISTS (
          SELECT 1 FROM business_records eligible_adjustment
          WHERE eligible_adjustment.category = 'LUONG_THUONG'
            AND eligible_adjustment.store_id = ${storeExpression}
            AND COALESCE(eligible_adjustment.status, '') != 'DELETED'
            AND json_extract(eligible_adjustment.data_json, '$.employeeId') = eligible_employee.id
            AND COALESCE(
              json_extract(eligible_adjustment.data_json, '$.period'),
              substr(json_extract(eligible_adjustment.data_json, '$.date'), 1, 7)
            ) = ${periodExpression}
        )
        OR EXISTS (
          SELECT 1 FROM employee_payroll_closings eligible_closing
          WHERE eligible_closing.employee_id = eligible_employee.id
            AND eligible_closing.store_id = ${storeExpression}
            AND eligible_closing.period = ${periodExpression}
            AND eligible_closing.status IN ('BASE_LOCKED', 'LOCKED')
        )
      )
  )`;
}

function financialPeriodMutationLockedExpression(storeExpression: string, periodExpression: string) {
  return `(EXISTS (
      SELECT 1 FROM financial_periods canonical_period
      WHERE canonical_period.store_id = ${storeExpression}
        AND canonical_period.period = ${periodExpression}
        AND canonical_period.status IN ('CONFIRMED', 'PAID', 'LOCKED')
    ) OR (
      NOT EXISTS (
        SELECT 1 FROM financial_periods canonical_period
        WHERE canonical_period.store_id = ${storeExpression}
          AND canonical_period.period = ${periodExpression}
      ) AND (
        EXISTS (
          SELECT 1 FROM business_records legacy_lock
          WHERE legacy_lock.category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING')
            AND legacy_lock.store_id = ${storeExpression}
            AND COALESCE(legacy_lock.status, '') != 'DELETED'
            AND json_extract(legacy_lock.data_json, '$.period') = ${periodExpression}
        ) OR EXISTS (
          SELECT 1 FROM employee_payroll_closings legacy_employee_lock
          WHERE legacy_employee_lock.store_id = ${storeExpression}
            AND legacy_employee_lock.period = ${periodExpression}
            AND COALESCE(legacy_employee_lock.status, '') != 'DELETED'
        )
      )
    ))`;
}

function payrollRevisionExpression(storeExpression: string) {
  return `(SELECT json_object(
    'store', COALESCE((SELECT json_group_array(json_array(id, status, revenue, expense, created_at))
      FROM (SELECT id, status, revenue, expense, created_at FROM stores
        WHERE id = ${storeExpression} ORDER BY id)), '[]'),
    'employees', COALESCE((SELECT json_group_array(json_array(id, store_id, status, hourly_rate,
        tiktok_allowance, inactive_at, status_updated_at, lifecycle_version, deleted_at))
      FROM (SELECT id, store_id, status, hourly_rate, tiktok_allowance, inactive_at,
          status_updated_at, lifecycle_version, deleted_at
        FROM employees employee_revision
        WHERE employee_revision.store_id = ${storeExpression}
          OR EXISTS(SELECT 1 FROM shift_sessions shift_revision
            WHERE shift_revision.store_id = ${storeExpression}
              AND shift_revision.employee_id = employee_revision.id)
          OR EXISTS(SELECT 1 FROM employee_transfers transfer_revision
            WHERE transfer_revision.target_store_id = ${storeExpression}
              AND transfer_revision.employee_id = employee_revision.id)
        ORDER BY id)), '[]'),
    'employeeHistory', COALESCE((SELECT json_group_array(json_array(id, employee_id, store_id,
        from_status, to_status, effective_at, created_at))
      FROM (SELECT history_revision.id, history_revision.employee_id, history_revision.store_id,
          history_revision.from_status, history_revision.to_status, history_revision.effective_at,
          history_revision.created_at
        FROM employee_status_history history_revision
        WHERE history_revision.store_id = ${storeExpression}
          OR EXISTS(SELECT 1 FROM employees history_employee
            WHERE history_employee.id = history_revision.employee_id
              AND history_employee.store_id = ${storeExpression})
        ORDER BY history_revision.id)), '[]'),
    'shifts', COALESCE((SELECT json_group_array(json_array(id, employee_id, work_date, started_at,
        ended_at, scheduled_start_at, scheduled_end_at, duration_seconds,
        admin_adjusted_duration_seconds, applied_hourly_rate, applied_tiktok_allowance,
        tiktok_allowance, cash_revenue, transfer_revenue, expense_amount, transfer_id, status,
        close_status, reconciliation_status, reconciliation_reason, reconciled_at, reconciled_by,
        source_schedule_record_id, source_schedule_updated_at))
      FROM (SELECT id, employee_id, work_date, started_at, ended_at, scheduled_start_at,
          scheduled_end_at, duration_seconds, admin_adjusted_duration_seconds, applied_hourly_rate,
          applied_tiktok_allowance, tiktok_allowance, cash_revenue, transfer_revenue, expense_amount,
          transfer_id, status, close_status, reconciliation_status, reconciliation_reason,
          reconciled_at, reconciled_by, source_schedule_record_id, source_schedule_updated_at
        FROM shift_sessions WHERE store_id = ${storeExpression} ORDER BY id)), '[]'),
    'transfers', COALESCE((SELECT json_group_array(json_array(id, employee_id, source_store_id,
        target_store_id, start_date, end_date, support_hourly_rate, support_allowance, status, updated_at))
      FROM (SELECT id, employee_id, source_store_id, target_store_id, start_date, end_date,
          support_hourly_rate, support_allowance, status, updated_at
        FROM employee_transfers
        WHERE source_store_id = ${storeExpression} OR target_store_id = ${storeExpression}
        ORDER BY id)), '[]'),
    'records', COALESCE((SELECT json_group_array(json_array(id, category, owner_id, data_json,
        status, created_at, updated_at))
      FROM (SELECT id, category, owner_id, data_json, status, created_at, updated_at
        FROM business_records WHERE store_id = ${storeExpression} ORDER BY id)), '[]'),
    'employeeClosings', COALESCE((SELECT json_group_array(json_array(id, employee_id, period,
        snapshot_json, employee_status_at_lock, status, locked_at))
      FROM (SELECT id, employee_id, period, snapshot_json, employee_status_at_lock, status, locked_at
        FROM employee_payroll_closings WHERE store_id = ${storeExpression} ORDER BY id)), '[]'),
    'financialPeriods', COALESCE((SELECT json_group_array(json_array(id, period, status,
        policy_version_id, config_version, revision, gross_revenue, fixed_expense,
        variable_expense, inventory_cost, inventory_shipping_cost, employee_salary,
        manager_salary, manual_bonus, allowance, total_hours_seconds, employee_kpi_total,
        manager_kpi, operating_profit, profit_after_kpi, month_end_expense, final_profit,
        distributable_profit, salary_advance, employee_payroll_rows_json, manager_payroll_json,
        config_snapshot_json, snapshot_json, calculated_at, confirmed_at, paid_at, locked_at,
        updated_at))
      FROM (SELECT id, period, status, policy_version_id, config_version, revision, gross_revenue,
          fixed_expense, variable_expense, inventory_cost, inventory_shipping_cost,
          employee_salary, manager_salary, manual_bonus, allowance, total_hours_seconds,
          employee_kpi_total, manager_kpi, operating_profit, profit_after_kpi,
          month_end_expense, final_profit, distributable_profit, salary_advance,
          employee_payroll_rows_json, manager_payroll_json, config_snapshot_json, snapshot_json,
          calculated_at, confirmed_at, paid_at, locked_at, updated_at
        FROM financial_periods WHERE store_id = ${storeExpression} ORDER BY period, id)), '[]'),
    'policyVersions', COALESCE((SELECT json_group_array(json_array(id, version,
        effective_from_period, policy_json, created_at, superseded_at))
      FROM (SELECT id, version, effective_from_period, policy_json, created_at, superseded_at
        FROM financial_policy_versions ORDER BY version, id)), '[]')
  ))`;
}

export async function salaryAdvancePayrollRevision(db: D1Database, storeId: string) {
  const row = await db.prepare(`WITH revision_scope AS (SELECT ? AS storeId)
    SELECT ${payrollRevisionExpression("revision_scope.storeId")} AS revision
    FROM revision_scope`).bind(storeId).first<{ revision: string }>();
  return String(row?.revision ?? "");
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

export async function listSalaryAdvances(db: D1Database, storeId: string, period: string) {
  const rows = await db.prepare(`${salaryAdvanceSelect}
    WHERE advance.store_id = ? AND advance.period = ?
    ORDER BY advance.advance_date DESC, advance.created_at DESC, advance.id DESC`)
    .bind(storeId, period).all<SalaryAdvance>();
  return rows.results;
}

export async function getSalaryAdvance(db: D1Database, id: string, storeId: string) {
  return db.prepare(`${salaryAdvanceSelect}
    WHERE advance.id = ? AND advance.store_id = ? LIMIT 1`)
    .bind(id, storeId).first<SalaryAdvance>();
}

export async function salaryAdvanceTotals(db: D1Database, storeId: string, period: string) {
  const rows = await db.prepare(`SELECT employee_id AS employeeId,
      COALESCE(SUM(CASE WHEN status = 'DRAFT' THEN amount ELSE 0 END), 0) AS pendingAmount,
      COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END), 0) AS paidAmount,
      COALESCE(SUM(amount), 0) AS reservedAmount
    FROM salary_advances
    WHERE store_id = ? AND period = ? AND status IN ('DRAFT', 'PAID')
    GROUP BY employee_id`)
    .bind(storeId, period).all<SalaryAdvanceTotals>();
  return rows.results.map((row) => ({
    employeeId: row.employeeId,
    pendingAmount: Number(row.pendingAmount ?? 0),
    paidAmount: Number(row.paidAmount ?? 0),
    reservedAmount: Number(row.reservedAmount ?? 0),
  }));
}

async function mutationState(
  db: D1Database,
  storeId: string,
  period: string,
  employeeId: string,
  actorId: string,
  excludeId: string | null = null,
) {
  return db.prepare(`WITH mutation_scope AS (
      SELECT ? AS storeId, ? AS period, ? AS employeeId, ? AS actorId, ? AS excludeId
    ) SELECT
      EXISTS(SELECT 1 FROM stores store
        WHERE store.id = mutation_scope.storeId AND store.status = 'ACTIVE') AS active,
      EXISTS(SELECT 1 FROM users actor WHERE actor.id = mutation_scope.actorId AND actor.role = 'MANAGER'
        AND (COALESCE(actor.is_super_admin, 0) = 1 OR actor.store_id IS NULL
          OR actor.store_id = mutation_scope.storeId)) AS allowed,
      ${employeePayrollAttributionExpression("mutation_scope.employeeId", "mutation_scope.storeId", "mutation_scope.period")} AS employeeExists,
      CASE WHEN ${financialPeriodMutationLockedExpression("mutation_scope.storeId", "mutation_scope.period")}
        THEN 1 ELSE 0 END AS locked,
      COALESCE((SELECT SUM(amount) FROM salary_advances current
        WHERE current.store_id = mutation_scope.storeId AND current.period = mutation_scope.period
          AND current.employee_id = mutation_scope.employeeId AND current.status IN ('DRAFT', 'PAID')
          AND (mutation_scope.excludeId IS NULL OR current.id != mutation_scope.excludeId)), 0) AS reserved
    FROM mutation_scope`).bind(storeId, period, employeeId, actorId, excludeId)
    .first<{ active: number; allowed: number; employeeExists: number; locked: number; reserved: number }>();
}

async function diagnoseMutation(
  db: D1Database,
  input: { storeId: string; period: string; employeeId: string; actorId: string; amount: number; grossEntitlement: number; payrollRevision: string; excludeId?: string | null; availableSnapshot?: number },
): Promise<never> {
  const state = await mutationState(
    db,
    input.storeId,
    input.period,
    input.employeeId,
    input.actorId,
    input.excludeId ?? null,
  );
  if (!state?.allowed) throw new SalaryAdvanceConflictError("FORBIDDEN");
  if (!state.active) throw new SalaryAdvanceConflictError("INACTIVE");
  if (!state.employeeExists) throw new SalaryAdvanceConflictError("NOT_FOUND");
  if (state.locked) throw new SalaryAdvanceConflictError("LOCKED");
  if (await salaryAdvancePayrollRevision(db, input.storeId) !== input.payrollRevision) {
    throw new SalaryAdvanceConflictError("STALE");
  }
  const currentAvailable = Math.max(0, input.grossEntitlement - Number(state.reserved ?? 0));
  const allowedBelow = input.availableSnapshot === undefined
    ? currentAvailable
    : Math.min(currentAvailable, input.availableSnapshot);
  if (input.amount > allowedBelow) {
    throw new SalaryAdvanceConflictError("LIMIT");
  }
  throw new SalaryAdvanceConflictError("STALE");
}

export async function createSalaryAdvance(db: D1Database, input: CreateSalaryAdvanceInput) {
  const existing = await db.prepare("SELECT id, payload_hash AS payloadHash FROM salary_advances WHERE store_id = ? AND created_by = ? AND client_request_id = ? LIMIT 1")
    .bind(input.storeId, input.actorId, input.clientRequestId).first<{ id: string; payloadHash: string }>();
  if (existing) {
    if (existing.payloadHash !== input.payloadHash) throw new SalaryAdvanceConflictError("IDEMPOTENCY");
    return { status: "IDEMPOTENT" as const, advance: await getSalaryAdvance(db, existing.id, input.storeId) };
  }

  const mutationToken = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const detail = JSON.stringify({
    storeId: input.storeId,
    employeeId: input.employeeId,
    period: input.period,
    advanceDate: input.advanceDate,
    amount: input.amount,
    grossEntitlementSnapshot: input.grossEntitlement,
    note: input.note,
    status: "DRAFT",
  });
  const results = await db.batch([
    db.prepare(`WITH scope AS (
        SELECT ? AS storeId, ? AS period, ? AS employeeId, ? AS actorId,
          ? AS grossEntitlement, ? AS expectedRevision
      ), reservation AS (
        SELECT scope.*, COALESCE((SELECT SUM(current.amount) FROM salary_advances current
          WHERE current.store_id = scope.storeId AND current.period = scope.period
            AND current.employee_id = scope.employeeId AND current.status IN ('DRAFT', 'PAID')), 0) AS reserved
        FROM scope
      )
      INSERT OR IGNORE INTO salary_advances
        (id, store_id, employee_id, period, advance_date, amount,
         gross_entitlement_snapshot, available_before_snapshot, remaining_after_snapshot,
         note, status, version,
         client_request_id, payload_hash, mutation_token, created_by, created_at, updated_by, updated_at, paid_by, paid_at)
      SELECT ?, reservation.storeId, reservation.employeeId, reservation.period, ?, ?,
        reservation.grossEntitlement, reservation.grossEntitlement - reservation.reserved,
        reservation.grossEntitlement - reservation.reserved - ?,
        ?, 'DRAFT', 1, ?, ?, ?, reservation.actorId, ?, reservation.actorId, ?, NULL, NULL
      FROM reservation
      JOIN stores store ON store.id = reservation.storeId AND store.status = 'ACTIVE'
      JOIN users actor ON actor.id = reservation.actorId AND actor.role = 'MANAGER'
        AND (COALESCE(actor.is_super_admin, 0) = 1 OR actor.store_id IS NULL OR actor.store_id = reservation.storeId)
      WHERE ${employeePayrollAttributionExpression("reservation.employeeId", "reservation.storeId", "reservation.period")}
        AND NOT ${financialPeriodMutationLockedExpression("reservation.storeId", "reservation.period")}
        AND ? <= reservation.grossEntitlement - reservation.reserved
        AND reservation.expectedRevision = ${payrollRevisionExpression("reservation.storeId")}`).bind(
        input.storeId, input.period, input.employeeId, input.actorId, input.grossEntitlement, input.payrollRevision,
        input.id, input.advanceDate, input.amount, input.amount, input.note,
        input.clientRequestId, input.payloadHash, mutationToken, input.now, input.now,
        input.amount,
      ),
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, store_id, action, entity_type, entity_id, detail,
         before_json, after_json, reason, created_at)
      SELECT ?, ?, store_id, 'SALARY_ADVANCE_CREATE', 'SALARY_ADVANCE', id, ?,
        'null', ?, 'Tạo khoản ứng lương', ?
      FROM salary_advances WHERE id = ? AND mutation_token = ?`)
      .bind(auditId, input.actorId, detail, detail, input.now, input.id, mutationToken),
  ]);

  if (affectedRows(results[0]) === 1) {
    return { status: "CREATED" as const, advance: await getSalaryAdvance(db, input.id, input.storeId) };
  }
  const concurrent = await db.prepare("SELECT id, payload_hash AS payloadHash FROM salary_advances WHERE store_id = ? AND created_by = ? AND client_request_id = ? LIMIT 1")
    .bind(input.storeId, input.actorId, input.clientRequestId).first<{ id: string; payloadHash: string }>();
  if (concurrent) {
    if (concurrent.payloadHash !== input.payloadHash) throw new SalaryAdvanceConflictError("IDEMPOTENCY");
    return { status: "IDEMPOTENT" as const, advance: await getSalaryAdvance(db, concurrent.id, input.storeId) };
  }
  return diagnoseMutation(db, input);
}

export async function updateSalaryAdvance(db: D1Database, input: UpdateSalaryAdvanceInput) {
  const current = await getSalaryAdvance(db, input.id, input.storeId);
  if (!current) throw new SalaryAdvanceConflictError("NOT_FOUND");
  if (current.status === "PAID") throw new SalaryAdvanceConflictError("PAID");
  if (current.version !== input.expectedVersion) throw new SalaryAdvanceConflictError("STALE");

  const mutationToken = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const beforeState = {
    advanceDate: current.advanceDate,
    amount: current.amount,
    remainingAfterSnapshot: current.remainingAfterSnapshot,
    note: current.note,
    status: current.status,
    version: current.version,
  };
  const afterState = {
    advanceDate: input.advanceDate,
    amount: input.amount,
    remainingAfterSnapshot: current.availableBeforeSnapshot - input.amount,
    note: input.note,
    status: current.status,
    version: input.expectedVersion + 1,
  };
  const detail = JSON.stringify({
    storeId: input.storeId,
    employeeId: current.employeeId,
    period: current.period,
    before: beforeState,
    after: afterState,
  });
  const results = await db.batch([
    db.prepare(`UPDATE salary_advances AS advance SET
        advance_date = ?, amount = ?, remaining_after_snapshot = available_before_snapshot - ?,
        note = ?, version = version + 1,
        mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE advance.id = ? AND advance.store_id = ? AND advance.status = 'DRAFT' AND advance.version = ?
        AND EXISTS(SELECT 1 FROM stores store WHERE store.id = advance.store_id AND store.status = 'ACTIVE')
        AND EXISTS(SELECT 1 FROM users actor WHERE actor.id = ? AND actor.role = 'MANAGER'
          AND (COALESCE(actor.is_super_admin, 0) = 1 OR actor.store_id IS NULL OR actor.store_id = advance.store_id))
        AND ${employeePayrollAttributionExpression("advance.employee_id", "advance.store_id", "advance.period")}
        AND NOT ${financialPeriodMutationLockedExpression("advance.store_id", "advance.period")}
        AND ? <= ? - COALESCE((SELECT SUM(current.amount) FROM salary_advances current
          WHERE current.store_id = advance.store_id AND current.period = advance.period
            AND current.employee_id = advance.employee_id AND current.status IN ('DRAFT', 'PAID')
            AND current.id != advance.id), 0)
        AND ? <= advance.available_before_snapshot
        AND ? = ${payrollRevisionExpression("advance.store_id")}`)
      .bind(
        input.advanceDate, input.amount, input.amount, input.note, mutationToken, input.actorId, input.now,
        input.id, input.storeId, input.expectedVersion, input.actorId,
        input.amount, input.grossEntitlement,
        input.amount, input.payrollRevision,
      ),
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, store_id, action, entity_type, entity_id, detail,
         before_json, after_json, reason, created_at)
      SELECT ?, ?, store_id, 'SALARY_ADVANCE_UPDATE', 'SALARY_ADVANCE', id, ?, ?, ?,
        'Chỉnh sửa khoản ứng lương', ?
      FROM salary_advances WHERE id = ? AND mutation_token = ? AND version = ?`)
      .bind(
        auditId,
        input.actorId,
        detail,
        JSON.stringify(beforeState),
        JSON.stringify(afterState),
        input.now,
        input.id,
        mutationToken,
        input.expectedVersion + 1,
      ),
  ]);
  if (affectedRows(results[0]) === 1) return getSalaryAdvance(db, input.id, input.storeId);

  const after = await getSalaryAdvance(db, input.id, input.storeId);
  if (!after) throw new SalaryAdvanceConflictError("NOT_FOUND");
  if (after.status === "PAID") throw new SalaryAdvanceConflictError("PAID");
  if (after.version !== input.expectedVersion) throw new SalaryAdvanceConflictError("STALE");
  return diagnoseMutation(db, {
    storeId: input.storeId,
    period: current.period,
    employeeId: current.employeeId,
    actorId: input.actorId,
    amount: input.amount,
    grossEntitlement: input.grossEntitlement,
    payrollRevision: input.payrollRevision,
    excludeId: input.id,
    availableSnapshot: current.availableBeforeSnapshot,
  });
}

export async function confirmSalaryAdvance(db: D1Database, input: ConfirmSalaryAdvanceInput) {
  const current = await getSalaryAdvance(db, input.id, input.storeId);
  if (!current) throw new SalaryAdvanceConflictError("NOT_FOUND");
  if (current.status === "PAID") return { status: "IDEMPOTENT" as const, advance: current };
  if (current.version !== input.expectedVersion) throw new SalaryAdvanceConflictError("STALE");

  const mutationToken = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const detail = JSON.stringify({
    storeId: input.storeId,
    employeeId: current.employeeId,
    period: current.period,
    advanceDate: current.advanceDate,
    amount: current.amount,
    version: input.expectedVersion + 1,
    expenseTreatment: "PAYROLL_LIABILITY_SETTLEMENT_NO_DOUBLE_COUNT",
  });
  const paidEntry = await buildCashflowEntry({
    storeId: input.storeId,
    direction: "OUT",
    amount: current.amount,
    category: "PAYROLL",
    sourceType: "SALARY_ADVANCE",
    sourceId: current.id,
    occurredAt: input.now,
    createdBy: input.actorId,
    clientRequestId: `salary-advance-paid:${current.id}`,
    note: `${current.employeeName} (${current.employeeCode}) · ${current.note}`,
    createdAt: input.now,
  });
  const results = await db.batch([
    db.prepare(`UPDATE salary_advances AS advance SET
        status = 'PAID', version = version + 1, mutation_token = ?,
        updated_by = ?, updated_at = ?, paid_by = ?, paid_at = ?
      WHERE advance.id = ? AND advance.store_id = ? AND advance.status = 'DRAFT' AND advance.version = ?
        AND EXISTS(SELECT 1 FROM stores store WHERE store.id = advance.store_id AND store.status = 'ACTIVE')
        AND EXISTS(SELECT 1 FROM users actor WHERE actor.id = ? AND actor.role = 'MANAGER'
          AND (COALESCE(actor.is_super_admin, 0) = 1 OR actor.store_id IS NULL OR actor.store_id = advance.store_id))
        AND ${employeePayrollAttributionExpression("advance.employee_id", "advance.store_id", "advance.period")}
        AND NOT ${financialPeriodMutationLockedExpression("advance.store_id", "advance.period")}
        AND advance.amount <= ? - COALESCE((SELECT SUM(other.amount) FROM salary_advances other
          WHERE other.store_id = advance.store_id AND other.period = advance.period
            AND other.employee_id = advance.employee_id AND other.status IN ('DRAFT', 'PAID')
            AND other.id != advance.id), 0)
        AND advance.amount <= advance.available_before_snapshot
        AND ? = ${payrollRevisionExpression("advance.store_id")}`)
      .bind(
        mutationToken, input.actorId, input.now, input.actorId, input.now,
        input.id, input.storeId, input.expectedVersion, input.actorId,
        input.grossEntitlement, input.payrollRevision,
      ),
    prepareCashflowEntryInsertWhere(
      db,
      paidEntry,
      "EXISTS (SELECT 1 FROM salary_advances paid WHERE paid.id = ? AND paid.mutation_token = ? AND paid.status = 'PAID')",
      [input.id, mutationToken],
    ),
    db.prepare(`INSERT INTO audit_logs
        (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
      SELECT ?, ?, store_id, 'SALARY_ADVANCE_PAYMENT_CONFIRM', 'SALARY_ADVANCE', id, ?, ?, ?, ?, ?
      FROM salary_advances WHERE id = ? AND mutation_token = ? AND version = ? AND status = 'PAID'`)
      .bind(
        auditId,
        input.actorId,
        detail,
        JSON.stringify({ status: current.status, version: current.version, paidAt: current.paidAt }),
        JSON.stringify({ status: "PAID", version: input.expectedVersion + 1, paidAt: input.now, amount: current.amount }),
        "Xác nhận đã chi ứng lương",
        input.now,
        input.id,
        mutationToken,
        input.expectedVersion + 1,
      ),
  ]);
  if (affectedRows(results[0]) === 1) {
    return { status: "CONFIRMED" as const, advance: await getSalaryAdvance(db, input.id, input.storeId) };
  }

  const after = await getSalaryAdvance(db, input.id, input.storeId);
  if (!after) throw new SalaryAdvanceConflictError("NOT_FOUND");
  if (after.status === "PAID") return { status: "IDEMPOTENT" as const, advance: after };
  if (after.version !== input.expectedVersion) throw new SalaryAdvanceConflictError("STALE");
  const state = await mutationState(db, input.storeId, current.period, current.employeeId, input.actorId, input.id);
  if (!state?.allowed) throw new SalaryAdvanceConflictError("FORBIDDEN");
  if (!state.active) throw new SalaryAdvanceConflictError("INACTIVE");
  if (state.locked) throw new SalaryAdvanceConflictError("LOCKED");
  return diagnoseMutation(db, {
    storeId: input.storeId,
    period: current.period,
    employeeId: current.employeeId,
    actorId: input.actorId,
    amount: current.amount,
    grossEntitlement: input.grossEntitlement,
    payrollRevision: input.payrollRevision,
    excludeId: input.id,
    availableSnapshot: current.availableBeforeSnapshot,
  });
}
