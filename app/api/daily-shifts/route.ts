import { initDb } from "../../../db/runtime";
import {
  createDailyShift,
  dailyShiftValues,
  DailyShiftConflictError,
  deleteDailyShift,
  getDailyShift,
  listDailyShifts,
  normalizeDailyShiftMutationReason,
  normalizeDailyShiftRequestId,
  updateDailyShift,
  validDailyShiftDate,
} from "../../lib/daily-shifts";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import { MANAGER_STORE_SCOPE_MESSAGE, managerCanAccessStore } from "../_lib/manager-scope";

type DailyShiftBody = {
  id?: string;
  storeId?: string;
  workDate?: string;
  name?: string;
  start?: string;
  end?: string;
  version?: number;
  clientRequestId?: string;
  reason?: string;
};

function conflictResponse(error: unknown) {
  if (!(error instanceof DailyShiftConflictError)) {
    return json({ message: "Không thể lưu ca làm việc. Vui lòng thử lại." }, 500);
  }
  if (error.reason === "INACTIVE") return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (error.reason === "FORBIDDEN") return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (error.reason === "LOCKED") return json({ message: "Kỳ tài chính đã khóa, không thể thay đổi ca làm việc của ngày này." }, 423);
  if (error.reason === "DUPLICATE") {
    return json({ message: "Ca cùng tên và khung giờ đã tồn tại trong ngày này." }, 409);
  }
  if (error.reason === "REQUEST_MISMATCH") {
    return json({ message: "Mã lưu ca đã được dùng với nội dung khác. Vui lòng mở lại biểu mẫu." }, 409);
  }
  return json({ message: "Ca làm việc đã được sửa hoặc xóa ở nơi khác. Vui lòng tải lại dữ liệu." }, 409);
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const params = new URL(request.url).searchParams;
  const storeId = params.get("storeId") ?? "";
  const workDate = params.get("date") ?? "";
  if (!storeId || !managerCanAccessStore(user, storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!validDailyShiftDate(workDate)) return json({ message: "Ngày làm việc không hợp lệ." }, 400);
  const result = await listDailyShifts(await initDb(), storeId, workDate);
  return json(result);
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return json({ message: "Chỉ quản lý được tạo ca làm việc" }, 403);
  const body = await request.json().catch(() => ({})) as DailyShiftBody;
  const storeId = String(body.storeId ?? "");
  if (!storeId || !managerCanAccessStore(user, storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const clientRequestId = normalizeDailyShiftRequestId(body.clientRequestId);
  if (!clientRequestId) return json({ message: "Mã chống lưu trùng của ca làm việc không hợp lệ." }, 400);
  const values = dailyShiftValues(body as Record<string, unknown>);
  if (!values) return json({ message: "Tên ca, ngày và khung giờ làm việc không hợp lệ." }, 400);

  try {
    const result = await createDailyShift(await initDb(), {
      storeId,
      actorId: user.id,
      clientRequestId,
      values,
      now: new Date().toISOString(),
      reason: normalizeDailyShiftMutationReason(body.reason) ?? `Tạo ca làm việc ${values.name} ngày ${values.workDate}`,
    });
    return json({
      id: result.id,
      version: result.version,
      idempotent: result.status === "IDEMPOTENT",
      message: result.status === "IDEMPOTENT" ? "Ca làm việc này đã được lưu trước đó." : "Đã tạo ca làm việc.",
    }, result.status === "CREATED" ? 201 : 200);
  } catch (error) {
    return conflictResponse(error);
  }
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as DailyShiftBody;
  const id = String(body.id ?? "");
  const version = Number(body.version);
  if (!id || !Number.isInteger(version) || version < 1) return json({ message: "Phiên bản ca làm việc không hợp lệ." }, 400);
  const db = await initDb();
  const existing = await getDailyShift(db, id);
  if (!existing || existing.status !== "ACTIVE") return json({ message: "Không tìm thấy ca làm việc." }, 404);
  if (!managerCanAccessStore(user, existing.storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(existing.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const values = dailyShiftValues(body as Record<string, unknown>);
  if (!values || values.workDate !== existing.workDate) return json({ message: "Tên ca, ngày và khung giờ làm việc không hợp lệ." }, 400);
  const reason = normalizeDailyShiftMutationReason(body.reason);
  if (!reason) return json({ message: "Vui lòng nhập lý do chỉnh sửa ca làm việc (từ 5 đến 500 ký tự)." }, 400);

  try {
    const result = await updateDailyShift(db, {
      id,
      storeId: existing.storeId,
      actorId: user.id,
      expectedVersion: version,
      values,
      now: new Date().toISOString(),
      reason,
    });
    return json({ ...result, message: "Đã cập nhật ca làm việc. Lịch đã phân trước đó vẫn giữ nguyên." });
  } catch (error) {
    return conflictResponse(error);
  }
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  const version = Number(params.get("version"));
  const reason = normalizeDailyShiftMutationReason(params.get("reason"));
  if (!id || !Number.isInteger(version) || version < 1) return json({ message: "Phiên bản ca làm việc không hợp lệ." }, 400);
  if (!reason) return json({ message: "Vui lòng nhập lý do xóa ca làm việc (từ 5 đến 500 ký tự)." }, 400);
  const db = await initDb();
  const existing = await getDailyShift(db, id);
  if (!existing || existing.status !== "ACTIVE") return json({ message: "Không tìm thấy ca làm việc." }, 404);
  if (!managerCanAccessStore(user, existing.storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(existing.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);

  try {
    const result = await deleteDailyShift(db, {
      id,
      storeId: existing.storeId,
      actorId: user.id,
      expectedVersion: version,
      now: new Date().toISOString(),
      reason,
    });
    return json({ ...result, message: "Đã xóa ca làm việc. Lịch và ca đã phát sinh vẫn được giữ nguyên." });
  } catch (error) {
    return conflictResponse(error);
  }
}
