/**
 * A canonical financial period is the sole lock authority whenever it exists.
 * DRAFT, CALCULATED and RECONCILING remain editable; CONFIRMED, PAID and
 * LOCKED are immutable. For stores that predate canonical periods, only a
 * fully LOCKED PAYROLL_CLOSING is treated as the compatibility lock.
 *
 * The expressions passed to storePeriodUnlockedSql are internal SQL snippets,
 * never request values. Request values still use bound parameters.
 */
export function storePeriodUnlockedSql(storeExpression: string, periodExpression: string) {
  return `NOT EXISTS (
    SELECT 1 FROM financial_periods AS canonical_period_lock
    WHERE canonical_period_lock.store_id = ${storeExpression}
      AND canonical_period_lock.period = ${periodExpression}
      AND canonical_period_lock.status IN ('CONFIRMED', 'PAID', 'LOCKED')
  ) AND (
    EXISTS (
      SELECT 1 FROM financial_periods AS canonical_period_authority
      WHERE canonical_period_authority.store_id = ${storeExpression}
        AND canonical_period_authority.period = ${periodExpression}
    ) OR NOT EXISTS (
      SELECT 1 FROM business_records AS legacy_period_lock
      WHERE legacy_period_lock.category = 'PAYROLL_CLOSING'
        AND legacy_period_lock.store_id = ${storeExpression}
        AND legacy_period_lock.status = 'LOCKED'
        AND json_extract(legacy_period_lock.data_json, '$.period') = ${periodExpression}
    )
  )`;
}

// Bind exactly two values: storeId, period. The one-row scope lets both lock
// authority checks reuse those values without duplicating positional parameters.
export const incomingStorePeriodUnlockedSql = `EXISTS (
  SELECT 1 FROM (SELECT ? AS store_id, ? AS period) AS incoming_scope
  WHERE ${storePeriodUnlockedSql("incoming_scope.store_id", "incoming_scope.period")}
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
