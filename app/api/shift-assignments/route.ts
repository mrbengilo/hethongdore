import { scheduleApi, scheduleBody } from "../_lib/schedule-api";
import { cancelAssignment, createAssignment, requireScope, scopedStores, validDate } from "../_lib/scheduling";

export async function GET(request: Request) {
  return scheduleApi(request, async (db, user) => {
    const query = new URL(request.url).searchParams;
    const date = validDate(query.get("date"));
    const stores = await scopedStores(db, user);
    const storeId = query.get("storeId");
    if (!storeId) return { stores, date, employees: [], definitions: [], assignments: [] };
    await requireScope(db, user, storeId);
    const [employees, definitions, assignments] = await db.batch([
      db.prepare("SELECT id,code,name FROM employees WHERE store_id=? AND status='ACTIVE' ORDER BY name").bind(storeId),
      db.prepare("SELECT id,name,start_time,end_time FROM shift_definitions WHERE store_id=? ORDER BY start_time,name").bind(storeId),
      db.prepare("SELECT * FROM shift_assignments WHERE store_id=? AND business_date=? ORDER BY scheduled_start_at,id").bind(storeId,date),
    ]);
    return { stores, date, employees: employees.results, definitions: definitions.results, assignments: assignments.results };
  });
}
export async function POST(request: Request) {
  return scheduleApi(request, async (db, user) => ({ assignment: await createAssignment(db, user, await scheduleBody(request)) }));
}
export async function DELETE(request: Request) {
  return scheduleApi(request, async (db, user) => cancelAssignment(db, user, await scheduleBody(request)));
}
