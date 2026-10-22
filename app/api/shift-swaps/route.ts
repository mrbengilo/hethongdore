import { initDb } from "../../../db/runtime";
import { commitShiftSwap, listShiftSwapAssignments, listShiftSwapStores, ShiftSwapError, type ShiftSwapInput } from "../../lib/shift-swap";
import { getSessionUser, json } from "../_lib/auth";

function failure(error: unknown) {
  if (error instanceof ShiftSwapError) return json({ code: error.code, message: error.message }, error.status);
  console.error("Shift swap request failed", error instanceof Error ? error.message : "Unknown error");
  return json({ code: "INTERNAL_ERROR", message: "Không thể xử lý đổi ca. Vui lòng thử lại." }, 500);
}
export async function GET(request: Request) {
  const actor = await getSessionUser(request, { allowSchedulingRole: true });
  if (!actor) return json({ code: "UNAUTHENTICATED", message: "Chưa đăng nhập." }, 401);
  try {
    const db = await initDb();
    const params = new URL(request.url).searchParams;
    if (params.get("stores") === "1") return json({ actorId: actor.id, stores: await listShiftSwapStores(db, actor) });
    return json(await listShiftSwapAssignments(db, actor, params.get("storeId") ?? "", params.get("date") ?? ""));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const actor = await getSessionUser(request, { allowSchedulingRole: true });
  if (!actor) return json({ code: "UNAUTHENTICATED", message: "Chưa đăng nhập." }, 401);
  try {
    const body = await request.json().catch(() => null) as ShiftSwapInput;
    return json(await commitShiftSwap(await initDb(), actor, body));
  } catch (error) { return failure(error); }
}
