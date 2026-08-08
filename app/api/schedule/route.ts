import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

type ScheduleRow = { id: string; storeId: string; dataJson: string; updatedAt: string; storeName: string };

function validDate(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "EMPLOYEE" || !user.employeeId) return json({ message: "Không có quyền xem lịch làm." }, 403);
  const params = new URL(request.url).searchParams;
  const requestedFrom = params.get("from");
  const requestedTo = params.get("to");
  if ((requestedFrom && !validDate(requestedFrom)) || (requestedTo && !validDate(requestedTo))) return json({ message: "Khoảng ngày không hợp lệ." }, 400);
  const from = requestedFrom ?? "0000-00-00";
  const to = requestedTo ?? "9999-12-31";
  if (from > to) return json({ message: "Khoảng ngày không hợp lệ." }, 400);
  const db = await initDb();
  const rows = await db.prepare(`
    SELECT r.id, r.store_id AS storeId, r.data_json AS dataJson, r.updated_at AS updatedAt, s.name AS storeName
    FROM business_records r
    JOIN stores s ON s.id = r.store_id
    WHERE r.category = 'LICH_PHAN_CA' AND r.status != 'DELETED'
      AND json_extract(r.data_json, '$.date') >= ? AND json_extract(r.data_json, '$.date') <= ?
    ORDER BY json_extract(r.data_json, '$.date'), json_extract(r.data_json, '$.start')
    LIMIT 500
  `).bind(from, to).all<ScheduleRow>();
  const schedules = rows.results.flatMap((row) => {
    try {
      const data = JSON.parse(row.dataJson) as Record<string, unknown>;
      const employeeIds = Array.isArray(data.employeeIds) ? data.employeeIds.map(String) : [];
      return employeeIds.includes(user.employeeId!) ? [{ id: row.id, storeId: row.storeId, storeName: row.storeName, isSupport: Boolean(user.homeStoreId && row.storeId !== user.homeStoreId), updatedAt: row.updatedAt, ...data }] : [];
    } catch {
      return [];
    }
  });
  return json({ schedules });
}
