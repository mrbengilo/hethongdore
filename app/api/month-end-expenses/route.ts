import { initDb } from "../../../db/runtime";
import {
  createMonthEndExpense,
  listMonthEndExpenses,
  monthEndExpenseDetails,
  MonthEndExpenseConflictError,
  monthEndExpenseValues,
  monthEndExpenseVersion,
  normalizeMonthEndExpensePeriod,
  normalizeMonthEndExpenseReason,
  normalizeMonthEndExpenseRequestId,
  updateMonthEndExpense,
  voidMonthEndExpense,
} from "../../lib/month-end-expenses";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";
import { isStorePeriodLocked } from "../_lib/store-period-lock";

type MonthEndExpenseBody = {
  id?: unknown;
  storeId?: unknown;
  period?: unknown;
  title?: unknown;
  category?: unknown;
  amount?: unknown;
  note?: unknown;
  expectedVersion?: unknown;
  version?: unknown;
  clientRequestId?: unknown;
  reason?: unknown;
};

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

function noStoreJson(data: unknown, status = 200) {
  return json(data, status, NO_STORE_HEADERS);
}

function conflictResponse(error: unknown) {
  if (!(error instanceof MonthEndExpenseConflictError)) {
    return noStoreJson({ message: "Không thể lưu chi phí cuối kỳ. Vui lòng thử lại." }, 500);
  }
  if (error.reason === "FORBIDDEN") return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (error.reason === "INACTIVE") return noStoreJson({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (error.reason === "LOCKED") {
    return noStoreJson({ message: "Kỳ tài chính đã xác nhận, đã chi hoặc đã khóa; không thể thay đổi chi phí cuối kỳ." }, 423);
  }
  if (error.reason === "NOT_FOUND") return noStoreJson({ message: "Không tìm thấy chi phí cuối kỳ trong cửa hàng này." }, 404);
  if (error.reason === "VOID") return noStoreJson({ message: "Chi phí cuối kỳ này đã bị hủy và không thể chỉnh sửa lại." }, 409);
  if (error.reason === "IDEMPOTENCY") {
    return noStoreJson({ message: "Mã chống lưu trùng đã được dùng cho một chi phí cuối kỳ có nội dung khác." }, 409);
  }
  if (error.reason === "STALE") {
    return noStoreJson({ message: "Chi phí cuối kỳ vừa được cập nhật ở nơi khác. Vui lòng tải lại dữ liệu." }, 409);
  }
  return noStoreJson({ message: "Chi phí cuối kỳ không thể được lưu do dữ liệu đã thay đổi. Vui lòng tải lại." }, 409);
}

function mutationRequestId(request: Request, body: MonthEndExpenseBody) {
  const headerRequestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  const bodyRequestId = String(body.clientRequestId ?? "").trim();
  if (headerRequestId && bodyRequestId && headerRequestId !== bodyRequestId) {
    return { requestId: null, mismatch: true };
  }
  return {
    requestId: normalizeMonthEndExpenseRequestId(headerRequestId || bodyRequestId),
    mismatch: false,
  };
}

async function storeStatus(db: D1Database, storeId: string) {
  return db.prepare("SELECT status FROM stores WHERE id = ? LIMIT 1")
    .bind(storeId).first<{ status: string }>();
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập." }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được xem chi phí cuối kỳ." }, 403);

  const params = new URL(request.url).searchParams;
  const period = normalizeMonthEndExpensePeriod(params.get("period"));
  if (!period) return noStoreJson({ message: "Kỳ chi phí cuối kỳ phải có định dạng YYYY-MM." }, 400);
  const scope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!scope.allowed) return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!scope.storeId) return noStoreJson({ message: "Vui lòng chọn cửa hàng." }, 400);

  const db = await initDb();
  const store = await storeStatus(db, scope.storeId);
  if (!store) return noStoreJson({ message: "Không tìm thấy cửa hàng." }, 404);
  const [{ expenses, total }, periodLocked] = await Promise.all([
    listMonthEndExpenses(db, scope.storeId, period),
    isStorePeriodLocked(db, scope.storeId, period),
  ]);
  return noStoreJson({
    storeId: scope.storeId,
    period,
    locked: store.status !== "ACTIVE" || periodLocked,
    expenses,
    total,
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập." }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được tạo chi phí cuối kỳ." }, 403);
  const body = await request.json().catch(() => ({})) as MonthEndExpenseBody;
  const storeId = String(body.storeId ?? "").trim();
  if (!storeId || !managerCanAccessStore(user, storeId)) {
    return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  if (!await isStoreActive(storeId)) return noStoreJson({ message: INACTIVE_STORE_MESSAGE }, 409);
  const values = monthEndExpenseValues(body as Record<string, unknown>);
  if (!values) {
    return noStoreJson({
      message: "Vui lòng nhập kỳ YYYY-MM, tiêu đề, loại chi phí, số tiền VND nguyên dương và ghi chú hợp lệ.",
    }, 400);
  }
  const { requestId, mismatch } = mutationRequestId(request, body);
  if (mismatch) return noStoreJson({ message: "Mã Idempotency-Key và clientRequestId không trùng nhau." }, 400);
  if (!requestId) return noStoreJson({ message: "Mã chống lưu trùng phải gồm 8 đến 128 ký tự hợp lệ." }, 400);

  try {
    const result = await createMonthEndExpense(await initDb(), {
      storeId,
      actorId: user.id,
      clientRequestId: requestId,
      values,
      now: new Date().toISOString(),
      reason: normalizeMonthEndExpenseReason(body.reason) ?? undefined,
    });
    return noStoreJson({
      expense: result.expense,
      message: result.status === "CREATED"
        ? "Đã tạo chi phí cuối kỳ."
        : "Yêu cầu này đã được ghi nhận trước đó.",
    }, result.status === "CREATED" ? 201 : 200);
  } catch (error) {
    return conflictResponse(error);
  }
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập." }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được sửa chi phí cuối kỳ." }, 403);
  const body = await request.json().catch(() => ({})) as MonthEndExpenseBody;
  const id = String(body.id ?? "").trim();
  const storeId = String(body.storeId ?? "").trim();
  const expectedVersion = monthEndExpenseVersion(body.expectedVersion ?? body.version);
  const values = monthEndExpenseDetails(body as Record<string, unknown>);
  const reason = normalizeMonthEndExpenseReason(body.reason);
  if (!id || !storeId || expectedVersion === null || !values) {
    return noStoreJson({ message: "Chi phí cuối kỳ, phiên bản hoặc nội dung chỉnh sửa không hợp lệ." }, 400);
  }
  if (!reason) return noStoreJson({ message: "Vui lòng nhập lý do chỉnh sửa từ 5 đến 500 ký tự." }, 400);
  if (!managerCanAccessStore(user, storeId)) return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(storeId)) return noStoreJson({ message: INACTIVE_STORE_MESSAGE }, 409);

  try {
    const expense = await updateMonthEndExpense(await initDb(), {
      id,
      storeId,
      actorId: user.id,
      expectedVersion,
      values,
      now: new Date().toISOString(),
      reason,
    });
    return noStoreJson({ expense, message: "Đã cập nhật chi phí cuối kỳ." });
  } catch (error) {
    return conflictResponse(error);
  }
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập." }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được hủy chi phí cuối kỳ." }, 403);
  const body = await request.json().catch(() => ({})) as MonthEndExpenseBody;
  const params = new URL(request.url).searchParams;
  const id = String(body.id ?? params.get("id") ?? "").trim();
  const storeId = String(body.storeId ?? params.get("storeId") ?? "").trim();
  const expectedVersion = monthEndExpenseVersion(
    body.expectedVersion ?? body.version ?? params.get("expectedVersion") ?? params.get("version"),
  );
  const reason = normalizeMonthEndExpenseReason(body.reason ?? params.get("reason"));
  if (!id || !storeId || expectedVersion === null) {
    return noStoreJson({ message: "Chi phí cuối kỳ hoặc phiên bản không hợp lệ." }, 400);
  }
  if (!reason) return noStoreJson({ message: "Vui lòng nhập lý do hủy từ 5 đến 500 ký tự." }, 400);
  if (!managerCanAccessStore(user, storeId)) return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(storeId)) return noStoreJson({ message: INACTIVE_STORE_MESSAGE }, 409);

  try {
    const expense = await voidMonthEndExpense(await initDb(), {
      id,
      storeId,
      actorId: user.id,
      expectedVersion,
      now: new Date().toISOString(),
      reason,
    });
    return noStoreJson({ expense, message: "Đã hủy chi phí cuối kỳ; lịch sử vẫn được giữ nguyên." });
  } catch (error) {
    return conflictResponse(error);
  }
}
