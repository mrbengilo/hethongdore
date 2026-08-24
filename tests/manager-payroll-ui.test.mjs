import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("manager payroll ignores stale periods and renders the configured policy", async () => {
  const portal = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  assert.match(portal, /managerKpiRate: number \| null/u);
  assert.match(portal, /const payrollRequest = useRef\(0\)/u);
  assert.match(portal, /payrollController\.current\?\.abort\(\)/u);
  assert.match(portal, /signal: controller\.signal/u);
  assert.match(portal, /payload\.managerPayroll\.period !== requestedPeriod/u);
  assert.match(portal, /requestId !== payrollRequest\.current \|\| controller\.signal\.aborted/u);
  assert.match(portal, /return \(\) => payrollController\.current\?\.abort\(\)/u);
  assert.match(portal, /policy\?\.managerKpiRate == null/u);
  assert.match(portal, /Mức KPI nhân viên: \{employeeTierText/u);
  assert.doesNotMatch(portal, /cùng chia quỹ KPI 3%\/5%\/7%/u);
});
