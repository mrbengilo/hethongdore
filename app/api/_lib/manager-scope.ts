import type { SessionUser } from "./auth";

export const MANAGER_STORE_SCOPE_MESSAGE = "Không có quyền truy cập dữ liệu của cửa hàng này.";

export function managerHasGlobalStoreAccess(user: SessionUser) {
  return user.role === "MANAGER"
    && (Number(user.isSuperAdmin) === 1 || !user.homeStoreId);
}

export function managerCanAccessStore(user: SessionUser, storeId: string) {
  if (user.role !== "MANAGER") return false;
  return managerHasGlobalStoreAccess(user) || user.homeStoreId === storeId;
}

export function resolveManagerStoreScope(user: SessionUser, requestedStoreId: string | null | undefined) {
  const requested = requestedStoreId?.trim() || null;
  if (managerHasGlobalStoreAccess(user)) return { allowed: true, storeId: requested };
  if (!user.homeStoreId) return { allowed: false, storeId: null };
  if (requested && requested !== user.homeStoreId) return { allowed: false, storeId: null };
  return { allowed: true, storeId: user.homeStoreId };
}
