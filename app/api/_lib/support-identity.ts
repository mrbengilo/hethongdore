import type { initDb } from "../../../db/runtime";

export type SupportIdentity = { isSupport: boolean; sourceStoreName: string | null };

// Display metadata only: attribution and pay always use the shift's store/rate
// snapshots. Historical transfer sources take precedence over today's home store.
export async function readStoreSupportIdentities(
  db: Awaited<ReturnType<typeof initDb>>, storeId: string, from: string, through: string,
) {
  const rows = await db.prepare(`SELECT e.id AS employeeId,
      CASE WHEN e.store_id != ? OR MAX(s.transfer_id IS NOT NULL) = 1 THEN 1 ELSE 0 END AS isSupport,
      COALESCE(GROUP_CONCAT(DISTINCT source.name), home.name) AS sourceStoreName
    FROM employees e
    LEFT JOIN stores home ON home.id = e.store_id
    LEFT JOIN shift_sessions s ON s.employee_id = e.id AND s.store_id = ?
      AND COALESCE(NULLIF(s.work_date, ''), date(s.started_at, '+7 hours')) BETWEEN ? AND ?
    LEFT JOIN employee_transfers t ON t.id = s.transfer_id
    LEFT JOIN stores source ON source.id = t.source_store_id
    GROUP BY e.id, e.store_id, home.name`)
    .bind(storeId, storeId, from, through)
    .all<{ employeeId: string; isSupport: number; sourceStoreName: string | null }>();
  return new Map(rows.results.map((row) => [row.employeeId, {
    isSupport: Boolean(row.isSupport), sourceStoreName: row.isSupport ? row.sourceStoreName : null,
  }]));
}
