import { scheduleApi, scheduleBody } from "../_lib/schedule-api";
import { swapAssignments } from "../_lib/scheduling";
export async function POST(request: Request) {
  return scheduleApi(request, async (db, user) => swapAssignments(db, user, await scheduleBody(request)));
}
