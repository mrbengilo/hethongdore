import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function navigationModule() {
  const source = await readFile(new URL("../app/lib/navigation-state.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const menus = {
  manager: ["Tổng quan", "Cửa hàng", "Báo cáo"],
  store: ["Tổng quan", "Ca làm việc", "Nhập hàng"],
  employee: ["Trang chủ", "Bảng lương"],
};

test("restores only a versioned manager navigation state for the same account", async () => {
  const { parseNavigationSnapshot } = await navigationModule();
  const identity = { userId: "manager-1", role: "MANAGER" };
  const raw = JSON.stringify({
    version: 1,
    userId: identity.userId,
    role: identity.role,
    managerView: "Cửa hàng",
    storeId: "store-can-tho",
    storeView: "Nhập hàng",
    employeeView: "Trang chủ",
    managerPeriod: "2026-08",
  });

  assert.deepEqual(parseNavigationSnapshot(raw, identity, menus), {
    managerView: "Cửa hàng",
    storeId: "store-can-tho",
    storeView: "Nhập hàng",
    employeeView: "Trang chủ",
    managerPeriod: "2026-08",
  });
  assert.equal(parseNavigationSnapshot(raw, { userId: "manager-2", role: "MANAGER" }, menus).storeId, null);
  assert.equal(parseNavigationSnapshot(raw, { userId: "manager-1", role: "EMPLOYEE" }, menus).employeeView, "Trang chủ");
});

test("rejects malformed, stale and unauthorized menu values", async () => {
  const { parseNavigationSnapshot } = await navigationModule();
  const identity = { userId: "manager-1", role: "MANAGER" };
  const stale = JSON.stringify({
    version: 0,
    userId: identity.userId,
    role: identity.role,
    managerView: "Cửa hàng",
    storeId: "store-can-tho",
    storeView: "Màn hình không tồn tại",
    employeeView: "Trang chủ",
    managerPeriod: "2026-08",
  });
  const invalidMenu = JSON.stringify({
    version: 1,
    userId: identity.userId,
    role: identity.role,
    managerView: "Không hợp lệ",
    storeId: "store-can-tho",
    storeView: "Không hợp lệ",
    employeeView: "Không hợp lệ",
    managerPeriod: "2099-13",
  });

  assert.deepEqual(parseNavigationSnapshot("{not-json", identity, menus), {
    managerView: "Tổng quan",
    storeId: null,
    storeView: "Tổng quan",
    employeeView: "Trang chủ",
    managerPeriod: null,
  });
  assert.equal(parseNavigationSnapshot(stale, identity, menus).storeId, null);
  assert.deepEqual(parseNavigationSnapshot(invalidMenu, identity, menus), {
    managerView: "Tổng quan",
    storeId: "store-can-tho",
    storeView: "Tổng quan",
    employeeView: "Trang chủ",
    managerPeriod: null,
  });
});

test("persists UI navigation only and separates manager accounts", async () => {
  const { navigationStorageKey, readNavigationSnapshot, writeNavigationSnapshot } = await navigationModule();
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  const identity = { userId: "manager-1", role: "MANAGER" };
  const snapshot = {
    managerView: "Cửa hàng",
    storeId: "store-can-tho",
    storeView: "Ca làm việc",
    employeeView: "Trang chủ",
    managerPeriod: "2026-08",
  };

  writeNavigationSnapshot(identity, menus, snapshot);
  assert.deepEqual(readNavigationSnapshot(identity, menus), snapshot);
  assert.equal(readNavigationSnapshot({ userId: "manager-2", role: "MANAGER" }, menus).storeId, null);
  assert.deepEqual(Object.keys(JSON.parse(values.get(navigationStorageKey(identity)))).sort(), [
    "employeeView", "managerPeriod", "managerView", "role", "storeId", "storeView", "userId", "version",
  ]);
  delete globalThis.window;
});

test("portal restores store/menu state and clears it only through the system overview action", async () => {
  const source = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  const managerPortal = source.slice(source.indexOf("function ManagerPortal"), source.indexOf("function ManagerHeader"));
  const employeePortal = source.slice(source.indexOf("function EmployeePortal"), source.indexOf("function EmployeeView"));

  assert.match(managerPortal, /const \[navigationReady, setNavigationReady\] = useState\(false\)/u);
  assert.match(managerPortal, /const restored = readNavigationSnapshot\(navigationIdentity, managerNavigationMenus\)/u);
  assert.match(managerPortal, /setSelectedStoreId\(restored\.storeId\)/u);
  assert.match(managerPortal, /if \(restored\.managerPeriod\) setPeriod\(restored\.managerPeriod\)/u);
  assert.match(managerPortal, /if \(!navigationReady\) return;/u);
  assert.doesNotMatch(managerPortal, /useState\(\(\) => readNavigationSnapshot/u);
  assert.match(managerPortal, /function returnToSystemOverview\(\)[\s\S]*storeId: null[\s\S]*writeNavigationSnapshot/u);
  assert.match(managerPortal, /onBack=\{returnToSystemOverview\}/u);
  assert.match(managerPortal, /managerPeriod: period/u);
  assert.match(managerPortal, /if \(navigationReady\) void loadStores\(\)/u);
  assert.match(managerPortal, /stores\.find\(\(store\) => store\.id === selectedStoreId\)/u);
  assert.match(managerPortal, /!response\.ok \|\| !Array\.isArray\(data\.stores\)/u);
  assert.match(managerPortal, /setStoreListResolved\(true\)/u);
  assert.match(managerPortal, /storeListResolved && !loading && !storeLoadError && selectedStoreId && !selectedStore/u);
  assert.match(managerPortal, /selectedStoreId && !selectedStore && storeLoadError[\s\S]*Thử tải lại/u);
  assert.match(employeePortal, /setView\(restored\.employeeView\)/u);
  assert.match(employeePortal, /if \(!navigationReady\)[\s\S]*Đang mở lại màn hình gần nhất/u);
  assert.doesNotMatch(employeePortal, /useState\(\(\) => readNavigationSnapshot/u);
  assert.match(employeePortal, /employeeView: view/u);
});
