import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the branded DORE login", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>DORE/iu);
  assert.match(html, /DORE/iu);
  assert.match(html, /20K/iu);
  assert.match(html, /autoComplete="username"/u);
  assert.match(html, /autoComplete="current-password"/u);
  assert.match(html, /type="checkbox"/u);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/u);
});

test("contains core role and finance rules", async () => {
  const [portal, login, orders, shift, packageJson, runtime] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /2%/u);
  assert.match(portal, />= 7000/u);
  assert.match(portal, />= 15000/u);
  assert.match(portal, />= 30000/u);
  assert.match(portal, /0\.03/u);
  assert.match(portal, /0\.05/u);
  assert.match(portal, /0\.07/u);
  assert.match(runtime, /DORE SÓC TRĂNG/u);
  assert.match(login, /attempts >= 10/u);
  assert.match(login, /15 \* 60 \* 1000/u);
  assert.match(orders, /currentShift/u);
  assert.match(orders, /user\.employeeId/u);
  assert.match(portal, /Quản lý danh sách đơn hàng/u);
  assert.match(portal, /Tìm kiếm mã đơn hàng, tên khách hàng, SĐT/u);
  assert.match(portal, /THÊM ĐƠN HÀNG MỚI/u);
  assert.match(portal, /Xuất Excel/u);
  assert.match(orders, /export async function PATCH/u);
  assert.match(orders, /store_id = \? AND employee_id = \? AND shift_code = \?/u);
  assert.match(shift, /tasksCompleted/u);
  assert.match(shift, /cashRevenue/u);
  assert.match(shift, /transferRevenue/u);
  assert.match(shift, /expenseNote/u);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/u);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("implements the redesigned employee closing and store workflows", async () => {
  const [employeeHome, storeModules, shift, runtime] = await Promise.all([
    readFile(new URL("../app/components/ReferenceEmployeeHome.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReferenceStoreModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
  ]);
  assert.match(employeeHome, /CÔNG VIỆC CẦN LÀM/u);
  assert.match(employeeHome, /THÔNG TIN KẾT CA/u);
  assert.match(employeeHome, /allTasksDone/u);
  assert.match(employeeHome, /Tiền mặt/u);
  assert.match(employeeHome, /Chuyển khoản/u);
  assert.match(storeModules, /Tạo ca làm việc/u);
  assert.match(storeModules, /Lịch theo tuần/u);
  assert.match(storeModules, /Tạo lịch phân ca/u);
  assert.match(storeModules, /Tạo phụ cấp/u);
  assert.match(storeModules, /Tạo thưởng/u);
  assert.match(storeModules, /Lịch sử tạo phụ cấp và thưởng/u);
  assert.match(shift, /tasks_completed = 1/u);
  assert.match(runtime, /cash_revenue/u);
});

test("wires persistent functional modules", async () => {
  const [records, employees, shifts, runtime, functionalUi] = await Promise.all([
    readFile(new URL("../app/api/records/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shifts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FunctionalModules.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(records, /business_records/u);
  assert.match(records, /TOGGLE_TASK/u);
  assert.match(employees, /hashPassword/u);
  assert.match(shifts, /shift_sessions/u);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS business_records/u);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS shift_sessions/u);
  assert.match(functionalUi, /FunctionalTaskManager/u);
  assert.match(functionalUi, /FunctionalEmployees/u);
  assert.match(functionalUi, /FunctionalDividend/u);
  assert.match(functionalUi, /FunctionalEmployeeHistory/u);
});
