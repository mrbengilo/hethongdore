export type NavigationRole = "MANAGER" | "EMPLOYEE";

export type NavigationIdentity = {
  userId: string;
  role: NavigationRole;
};

export type NavigationMenus = {
  manager: readonly string[];
  store: readonly string[];
  employee: readonly string[];
};

export type NavigationSnapshot = {
  managerView: string;
  storeId: string | null;
  storeView: string;
  employeeView: string;
  managerPeriod: string | null;
};

type PersistedNavigation = NavigationSnapshot & {
  version: 1;
  userId: string;
  role: NavigationRole;
};

type NavigationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_NAMESPACE = "dore:ui-navigation:v1";
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function firstMenuItem(items: readonly string[], fallback: string) {
  return items[0] ?? fallback;
}

export function defaultNavigationSnapshot(menus: NavigationMenus): NavigationSnapshot {
  return {
    managerView: firstMenuItem(menus.manager, "Tổng quan"),
    storeId: null,
    storeView: firstMenuItem(menus.store, "Tổng quan"),
    employeeView: firstMenuItem(menus.employee, "Trang chủ"),
    managerPeriod: null,
  };
}

export function navigationStorageKey(identity: NavigationIdentity) {
  return `${STORAGE_NAMESPACE}:${identity.role.toLocaleLowerCase("en-US")}:${encodeURIComponent(identity.userId)}`;
}

function validMenuItem(value: unknown, items: readonly string[], fallback: string) {
  return typeof value === "string" && items.includes(value) ? value : fallback;
}

export function parseNavigationSnapshot(
  raw: string | null,
  identity: NavigationIdentity,
  menus: NavigationMenus,
): NavigationSnapshot {
  const defaults = defaultNavigationSnapshot(menus);
  if (!raw) return defaults;

  try {
    const candidate = JSON.parse(raw) as Partial<PersistedNavigation> | null;
    if (!candidate || candidate.version !== 1 || candidate.userId !== identity.userId || candidate.role !== identity.role) {
      return defaults;
    }

    return {
      managerView: validMenuItem(candidate.managerView, menus.manager, defaults.managerView),
      storeId: identity.role === "MANAGER" && typeof candidate.storeId === "string" && candidate.storeId.trim()
        ? candidate.storeId
        : null,
      storeView: validMenuItem(candidate.storeView, menus.store, defaults.storeView),
      employeeView: validMenuItem(candidate.employeeView, menus.employee, defaults.employeeView),
      managerPeriod: identity.role === "MANAGER" && typeof candidate.managerPeriod === "string" && PERIOD_PATTERN.test(candidate.managerPeriod)
        ? candidate.managerPeriod
        : null,
    };
  } catch {
    return defaults;
  }
}

function browserStorage(): NavigationStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readNavigationSnapshot(identity: NavigationIdentity, menus: NavigationMenus) {
  const storage = browserStorage();
  if (!storage) return defaultNavigationSnapshot(menus);
  const key = navigationStorageKey(identity);
  try {
    const raw = storage.getItem(key);
    const snapshot = parseNavigationSnapshot(raw, identity, menus);
    if (raw && JSON.stringify(snapshot) === JSON.stringify(defaultNavigationSnapshot(menus))) {
      const parsed = JSON.parse(raw) as Partial<PersistedNavigation> | null;
      if (!parsed || parsed.version !== 1 || parsed.userId !== identity.userId || parsed.role !== identity.role) {
        storage.removeItem(key);
      }
    }
    return snapshot;
  } catch {
    return defaultNavigationSnapshot(menus);
  }
}

export function writeNavigationSnapshot(
  identity: NavigationIdentity,
  menus: NavigationMenus,
  snapshot: NavigationSnapshot,
) {
  const storage = browserStorage();
  if (!storage) return;
  const defaults = defaultNavigationSnapshot(menus);
  const persisted: PersistedNavigation = {
    version: 1,
    userId: identity.userId,
    role: identity.role,
    managerView: validMenuItem(snapshot.managerView, menus.manager, defaults.managerView),
    storeId: identity.role === "MANAGER" && typeof snapshot.storeId === "string" && snapshot.storeId.trim()
      ? snapshot.storeId
      : null,
    storeView: validMenuItem(snapshot.storeView, menus.store, defaults.storeView),
    employeeView: validMenuItem(snapshot.employeeView, menus.employee, defaults.employeeView),
    managerPeriod: identity.role === "MANAGER" && typeof snapshot.managerPeriod === "string" && PERIOD_PATTERN.test(snapshot.managerPeriod)
      ? snapshot.managerPeriod
      : null,
  };

  try {
    storage.setItem(navigationStorageKey(identity), JSON.stringify(persisted));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts. Navigation still works in memory.
  }
}
