import { initDb } from "../../../db/runtime";
import { getSessionUser, json, type SessionUser } from "./auth";
import { ScheduleError } from "./scheduling";

export async function scheduleApi(request: Request, action: (db: D1Database, user: SessionUser) => Promise<unknown>) {
  try {
    const user = await getSessionUser(request);
    if (!user) return json({ code: "UNAUTHENTICATED", message: "Chưa đăng nhập." }, 401);
    if (!["MANAGER", "HTKD", "STORE_MANAGER"].includes(user.role)) return json({ code: "FORBIDDEN", message: "Không có quyền quản lý lịch phân ca." }, 403);
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin) return json({ code: "FORBIDDEN", message: "Nguồn yêu cầu không hợp lệ." }, 403);
    }
    return json(await action(await initDb(), user));
  } catch (error) {
    if (error instanceof ScheduleError) return json({ code: error.code, message: error.message }, error.status);
    console.error("Scheduling request failed", error instanceof Error ? error.message : "Unknown error");
    return json({ code: "UNAVAILABLE", message: "Chưa xác định kết quả. Vui lòng thử lại cùng yêu cầu." }, 503);
  }
}
export async function scheduleBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScheduleError("INVALID_INPUT", "Nội dung yêu cầu không hợp lệ.", 400);
  return body as Record<string, unknown>;
}
