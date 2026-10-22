import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { MANAGER_STORE_SCOPE_MESSAGE } from "../_lib/manager-scope";
import {
  attendanceAdjustmentVersionToken,
  loadAttendanceAdjustment,
  parseAttendanceTimestampEdit,
  updateAttendanceTimestamps,
} from "../_lib/attendance-adjustment";

function optional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function response(data: unknown, status = 200) {
  return json(data, status, {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie",
  });
}

async function managerScope(request: Request, requestedStoreId: string | null) {
  const user = await getSessionUser(request);
  if (!user) return { error: response({ message: "Chưa đăng nhập." }, 401) } as const;
  if (user.role !== "MANAGER") return { error: response({ message: "Chỉ quản lý được chỉnh sửa chấm công." }, 403) } as const;
  const isSuperAdmin = Number(user.isSuperAdmin) === 1;
  const storeId = isSuperAdmin ? requestedStoreId : user.homeStoreId;
  if (!storeId || (!isSuperAdmin && requestedStoreId !== null && requestedStoreId !== user.homeStoreId)) {
    return { error: response({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403) } as const;
  }
  return { user, storeId } as const;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = optional(params.get("id"));
  const requestedStoreId = optional(params.get("storeId"));
  if (!id) return response({ message: "Thiếu chấm công cần xem." }, 400);
  const scope = await managerScope(request, requestedStoreId);
  if ("error" in scope) return scope.error;
  const db = await initDb();
  const attendance = await loadAttendanceAdjustment(db, scope.storeId, id);
  if (!attendance) return response({ message: "Không tìm thấy chấm công trong cửa hàng này." }, 404);
  return response({ attendance, versionToken: await attendanceAdjustmentVersionToken(attendance) });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = optional(body.id);
  const requestedStoreId = optional(body.storeId);
  const versionToken = optional(body.versionToken);
  const reason = optional(body.reason);
  if (!id || !versionToken) return response({ message: "Thiếu dữ liệu xác nhận chấm công cần sửa." }, 400);
  if (!reason || reason.length < 3 || reason.length > 500) {
    return response({ message: "Vui lòng nhập lý do thay đổi từ 3 đến 500 ký tự." }, 400);
  }
  const scope = await managerScope(request, requestedStoreId);
  if ("error" in scope) return scope.error;
  try {
    const db = await initDb();
    const previous = await loadAttendanceAdjustment(db, scope.storeId, id);
    if (!previous) return response({ message: "Không tìm thấy chấm công trong cửa hàng này." }, 404);
    if (await attendanceAdjustmentVersionToken(previous) !== versionToken) {
      return response({ message: "Chấm công đã thay đổi. Vui lòng tải lại trước khi thao tác." }, 409);
    }
    const result = await updateAttendanceTimestamps(
      db,
      scope.user.id,
      previous,
      parseAttendanceTimestampEdit(body, previous),
      reason,
      Number(scope.user.isSuperAdmin) === 1 ? "SUPER_ADMIN_ATTENDANCE_UPDATE" : "MANAGER_ATTENDANCE_UPDATE",
    );
    return response({
      message: "Đã cập nhật giờ chấm công và lưu lịch sử đối soát.",
      auditId: result.auditId,
      attendance: result.after,
      versionToken: await attendanceAdjustmentVersionToken(result.after),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể cập nhật chấm công.";
    const status = /khóa/iu.test(message) ? 423 : /thay đổi|đang làm|mở lại/iu.test(message) ? 409 : 400;
    return response({ message }, status);
  }
}
