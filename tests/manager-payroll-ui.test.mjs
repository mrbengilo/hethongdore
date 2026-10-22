import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("manager payroll belongs to the store and validates period, scope and concurrent saves", async () => {
  const portal = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/components/StoreManagerPayroll.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(portal.match(/const managerMenu = \[[^\n]+/u)[0], /Lương thưởng quản lý/u);
  assert.match(portal.match(/const storeMenu = \[[^\n]+/u)[0], /Lương thưởng quản lý/u);
  assert.match(page, /payload\.period !== period/u);
  assert.match(page, /payload\.summary\.storeId !== store\.id/u);
  assert.match(page, /controller\.current\?\.abort\(\)/u);
  assert.match(page, /request\.current !== id \|\| abort\.signal\.aborted/u);
  assert.match(page, /expectedSalaryVersion: summary\.managerSalaryVersion/u);
  assert.match(page, /data\.financialPeriod\.status === "DRAFT"/u);
  assert.match(page, /Lương và thưởng quản lý đã được tính vào chi phí cửa hàng/u);
});
