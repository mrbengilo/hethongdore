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
  assert.match(employeeHome, /expenseEntered/u);
  assert.match(employeeHome, /setInterval/u);
  assert.match(employeeHome, /activeOrders\.length === 0/u);
  assert.match(employeeHome, /Đã kết ca và ghi nhận vào lịch sử ca làm/u);
  assert.match(employeeHome, /Tiền mặt/u);
  assert.match(employeeHome, /Chuyển khoản/u);
  assert.match(storeModules, /Tạo ca làm việc/u);
  assert.match(storeModules, /Lịch theo tuần/u);
  assert.match(storeModules, /Tạo lịch phân ca/u);
  assert.match(storeModules, /Tạo phụ cấp/u);
  assert.match(storeModules, /Tạo thưởng/u);
  assert.match(storeModules, /Lịch sử tạo phụ cấp và thưởng/u);
  assert.match(shift, /tasks_completed = 1/u);
  assert.match(shift, /orderCount/u);
  assert.match(shift, /Doanh thu lớn hơn 0/u);
  assert.match(shift, /assignedItems/u);
  assert.match(runtime, /cash_revenue/u);
});

test("persists and exposes stable shift identity and Vietnamese work dates", async () => {
  const [schema, runtime, migration, shiftApi, shiftsApi, employeeModules] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_shift_identity_and_transfers.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shifts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReferenceEmployeeModules.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of [schema, runtime, migration]) {
    assert.match(source, /shift_name/u);
    assert.match(source, /work_date/u);
    assert.match(source, /applied_hourly_rate/u);
  }
  assert.match(shiftApi, /Asia\/Ho_Chi_Minh/u);
  assert.match(shiftApi, /resolveSchedule/u);
  assert.match(shiftApi, /shiftName/u);
  assert.match(shiftsApi, /workDate/u);
  assert.match(shiftsApi, /employeeCode/u);
  assert.match(shiftsApi, /appliedHourlyRate/u);
  assert.match(employeeModules, /displayShiftName/u);
  assert.match(employeeModules, /employeeName/u);
  assert.match(employeeModules, /workDay/u);
});

test("implements non-stacking monthly KPI snapshots", async () => {
  const [payrollRules, payrollApi, payrollTests] = await Promise.all([
    readFile(new URL("../app/lib/payroll.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payroll/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./payroll-formula.test.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(payrollRules, /employeeKpiRate/u);
  assert.match(payrollRules, /0\.03/u);
  assert.match(payrollRules, /0\.05/u);
  assert.match(payrollRules, /0\.07/u);
  assert.match(payrollRules, /employeeSeconds, totalSeconds/u);
  assert.match(payrollApi, /KPI_SUMMARY/u);
  assert.match(payrollApi, /LOCKED/u);
  assert.match(payrollApi, /distributeEmployeeKpiByPolicy/u);
  assert.match(payrollRules, /INACTIVE_EMPLOYEE_KPI_MIN_COMPLETED_SHIFTS = 15/u);
  assert.match(payrollApi, /user\.employeeId/u);
  assert.match(payrollTests, /6_999/u);
  assert.match(payrollTests, /7_000/u);
  assert.match(payrollTests, /15_000/u);
  assert.match(payrollTests, /30_000/u);
});

test("persists transfers and derives temporary store access server-side", async () => {
  const [schema, runtime, migration, transfersApi, auth] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_shift_identity_and_transfers.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/transfers/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_lib/auth.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [schema, runtime, migration, transfersApi]) assert.match(source, /employee_transfers/u);
  assert.match(transfersApi, /supportHourlyRate/u);
  assert.match(transfersApi, /supportAllowance/u);
  assert.match(transfersApi, /reconcileStatuses/u);
  assert.match(transfersApi, /CANCEL/u);
  assert.match(transfersApi, /END/u);
  assert.match(auth, /homeStoreId/u);
  assert.match(auth, /activeTransferId/u);
  assert.match(auth, /runningShift/u);
  assert.match(auth, /targetStoreId/u);
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

test("provides reference-style store shift and schedule modules", async () => {
  const [component, scheduling, stylesheet, schedulingTests] = await Promise.all([
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/scheduling.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url), "utf8"),
    readFile(new URL("./scheduling.test.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(component, /export function StoreShiftManagement/u);
  assert.match(component, /export function StoreScheduleManagement/u);
  assert.match(component, /CA_LAM_VIEC/u);
  assert.match(component, /LICH_PHAN_CA/u);
  assert.match(component, /Lịch theo tuần/u);
  assert.match(component, /Theo nhân viên/u);
  assert.match(component, /Chọn ca làm việc/u);
  assert.match(component, /Chọn ngày, ca, nhân viên và ghi chú trên cùng một màn hình/u);
  assert.match(component, /Chọn nhân viên/u);
  assert.match(component, /shiftsOverlap/u);
  assert.match(component, /startAt: utcRange\.startAt/u);
  assert.match(component, /endAt: utcRange\.endAt/u);
  assert.match(component, /store\.status === "INACTIVE"/u);
  assert.match(scheduling, /isOvernightShift/u);
  assert.match(scheduling, /shiftUtcRange/u);
  assert.match(scheduling, /first\.from < second\.to/u);
  assert.match(stylesheet, /\.shiftCards/u);
  assert.match(stylesheet, /\.weekTable/u);
  assert.match(stylesheet, /@media \(max-width: 600px\)/u);
  assert.match(schedulingTests, /overnight shift crossing/u);
});
