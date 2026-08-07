import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("stores use ACTIVE/INACTIVE lifecycle and cannot be deleted", async () => {
  const [storesApi, portal] = await Promise.all([
    source("../app/api/stores/route.ts"),
    source("../app/components/Portal.tsx"),
  ]);
  assert.match(storesApi, /status IN \('ACTIVE', 'INACTIVE'\)/u);
  assert.match(storesApi, /STORE_STATUS_CHANGE/u);
  assert.match(storesApi, /activeShifts/u);
  assert.match(storesApi, /Không hỗ trợ xóa cửa hàng/u);
  assert.match(storesApi, /405/u);
  assert.match(portal, /Ngưng hoạt động/u);
  assert.match(portal, /Kích hoạt lại/u);
  assert.doesNotMatch(portal, /onClick=\{\(\) => archive\(store\)\}/u);
});

test("inactive stores reject operational writes while reads remain available", async () => {
  const [auth, employees, shift, orders, records, payroll, transfers] = await Promise.all([
    source("../app/api/_lib/auth.ts"),
    source("../app/api/employees/route.ts"),
    source("../app/api/shift/route.ts"),
    source("../app/api/orders/route.ts"),
    source("../app/api/records/route.ts"),
    source("../app/api/payroll/route.ts"),
    source("../app/api/transfers/route.ts"),
  ]);
  assert.match(auth, /export async function isStoreActive/u);
  assert.match(auth, /status === "ACTIVE"/u);
  for (const route of [employees, shift, orders, records, payroll, transfers]) {
    assert.match(route, /isStoreActive/u);
    assert.match(route, /INACTIVE_STORE_MESSAGE/u);
  }
  assert.match(orders, /export async function GET/u);
  assert.match(shift, /export async function GET/u);
  assert.match(records, /export async function GET/u);
});

test("new employee remains bound to the selected store and save action is visible", async () => {
  const [employees, runtime, employeeUi, stylesheet] = await Promise.all([
    source("../app/api/employees/route.ts"),
    source("../db/runtime.ts"),
    source("../app/components/ReferenceStoreModules.tsx"),
    source("../app/globals.css"),
  ]);
  assert.match(employees, /employee_id, store_id/u);
  assert.match(employees, /employeeId, body\.storeId/u);
  assert.match(employees, /storeId: body\.storeId/u);
  assert.doesNotMatch(runtime, /UPDATE employees SET store_id = \? WHERE code IN/u);
  assert.match(employeeUi, /storeId: store\.id/u);
  assert.match(employeeUi, /type="submit" className="primary-button"/u);
  assert.match(employeeUi, /Đang lưu\.\.\./u);
  assert.match(stylesheet, /\.drawer-actions\{position:sticky/u);
});

test("system documentation locks store, money, cost and timezone contracts", async () => {
  const [functionalSpec, architecture, operations] = await Promise.all([
    source("../docs/02-DAC-TA-CHUC-NANG.md"),
    source("../docs/03-KIEN-TRUC-DU-LIEU-BAO-MAT.md"),
    source("../docs/04-CAI-DAT-TRIEN-KHAI-KIEM-THU.md"),
  ]);

  for (const document of [functionalSpec, architecture, operations]) {
    assert.match(document, /ACTIVE/u);
    assert.match(document, /INACTIVE/u);
    assert.match(document, /không xóa/iu);
    assert.match(document, /chi phí cố định/iu);
    assert.match(document, /Asia\/Ho_Chi_Minh/u);
    assert.match(document, /UTC/u);
    assert.match(document, /INTEGER.*64-bit/u);
  }

  assert.match(functionalSpec, /employees\.store_id/u);
  assert.match(functionalSpec, /users\.store_id/u);
  assert.match(functionalSpec, /marketing/u);
  assert.match(architecture, /DELETE.*405/u);
  assert.match(architecture, /stores\.status = 'ACTIVE'/u);
  assert.match(operations, /tests\/store-lifecycle\.test\.mjs/u);
  assert.match(operations, /employees\.store_id = users\.store_id/u);
});
