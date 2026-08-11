/**
 * Financial periods are store-wide. Once any employee payroll closing or
 * store KPI/payroll closing exists, later revenue/cost writes must stop for
 * every employee in that store and period.
 *
 * The expressions passed to storePeriodUnlockedSql are internal SQL snippets,
 * never request values. Request values still use bound parameters.
 */
export function storePeriodUnlockedSql(storeExpression: string, periodExpression: string) {
  return `NOT EXISTS (
    SELECT 1 FROM business_records AS store_period_lock
    WHERE store_period_lock.category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING')
      AND store_period_lock.store_id = ${storeExpression}
      AND COALESCE(store_period_lock.status, '') != 'DELETED'
      AND json_extract(store_period_lock.data_json, '$.period') = ${periodExpression}
  ) AND NOT EXISTS (
    SELECT 1 FROM employee_payroll_closings AS employee_period_lock
    WHERE employee_period_lock.store_id = ${storeExpression}
      AND employee_period_lock.period = ${periodExpression}
      AND COALESCE(employee_period_lock.status, '') != 'DELETED'
  )`;
}

// Bind exactly two values: storeId, period. The one-row scope lets both lock
// tables reuse those values without duplicating positional parameters.
export const incomingStorePeriodUnlockedSql = `NOT EXISTS (
  SELECT 1 FROM (SELECT ? AS store_id, ? AS period) AS incoming_scope
  WHERE EXISTS (
    SELECT 1 FROM business_records AS store_period_lock
    WHERE store_period_lock.category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING')
      AND store_period_lock.store_id = incoming_scope.store_id
      AND COALESCE(store_period_lock.status, '') != 'DELETED'
      AND json_extract(store_period_lock.data_json, '$.period') = incoming_scope.period
  ) OR EXISTS (
    SELECT 1 FROM employee_payroll_closings AS employee_period_lock
    WHERE employee_period_lock.store_id = incoming_scope.store_id
      AND employee_period_lock.period = incoming_scope.period
      AND COALESCE(employee_period_lock.status, '') != 'DELETED'
  )
)`;

export async function isStorePeriodLocked(
  db: D1Database,
  storeId: string,
  period: string,
) {
  const row = await db.prepare(`SELECT CASE WHEN ${incomingStorePeriodUnlockedSql} THEN 0 ELSE 1 END AS locked`)
    .bind(storeId, period)
    .first<{ locked: number }>();
  return row?.locked === 1;
}
