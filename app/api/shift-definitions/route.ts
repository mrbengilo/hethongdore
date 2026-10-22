import { scheduleApi, scheduleBody } from "../_lib/schedule-api";
import { createDefinition } from "../_lib/scheduling";
export async function POST(request: Request) {
  return scheduleApi(request, async (db, user) => ({ definition: await createDefinition(db, user, await scheduleBody(request)) }));
}
