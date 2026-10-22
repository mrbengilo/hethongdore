import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("employee CCCD number is validated end-to-end and protected by a live-row unique index", async () => {
  const [runtime, schema, migration, api, adminApi, managerUi, adminUi, validator] = await Promise.all([
    source("../db/runtime.ts"),
    source("../db/schema.ts"),
    source("../drizzle/0025_employee_cccd_number.sql"),
    source("../app/api/employees/route.ts"),
    source("../app/api/admin/employees/route.ts"),
    source("../app/components/EmployeeManagement.tsx"),
    source("../app/components/SuperAdminEmployeeDirectory.tsx"),
    source("../app/lib/employee-cccd.ts"),
  ]);

  assert.match(validator, /\^\\d\{12\}\$/u);
  assert.match(`${runtime}\n${migration}`, /cccd_number TEXT CHECK[\s\S]*length\(cccd_number\) = 12[\s\S]*NOT GLOB '\*\[\^0-9\]\*'/u);
  assert.match(`${runtime}\n${schema}\n${migration}`, /idx_employees_live_cccd_number/u);
  assert.match(`${runtime}\n${migration}`, /WHERE cccd_number IS NOT NULL AND status != 'ARCHIVED' AND deleted_at IS NULL/u);
  assert.match(api, /normalizeEmployeeCccdNumber\(body\.cccdNumber\)/u);
  assert.match(api, /cccd_number, cccd_image_key/u);
  assert.match(api, /cccd_number = \?, cccd_image_key = \?/u);
  assert.match(adminApi, /cccd_number AS cccdNumber/u);
  assert.match(adminApi, /cccd_number = \?/u);
  assert.match(adminApi, /cccd_number = NULL/u);
  assert.match(adminApi, /cccdNumberMasked/u);
  assert.doesNotMatch(adminApi, /after:\s*\{[^}]*cccdNumber,/u);

  for (const ui of [managerUi, adminUi]) {
    assert.match(ui, /Số CCCD/u);
    assert.match(ui, /pattern="\[0-9\]\{12\}"/u);
    assert.match(ui, /maxLength=\{12\}/u);
    assert.match(ui, /replace\(\/\\D\/g, ""\)\.slice\(0, 12\)/u);
  }
});

test("CCCD normalizer rejects missing, malformed and non-string values without coercion", async () => {
  const { normalizeEmployeeCccdNumber, maskEmployeeCccdNumber } = await import("../app/lib/employee-cccd.ts");
  assert.equal(normalizeEmployeeCccdNumber("092123456789"), "092123456789");
  assert.equal(normalizeEmployeeCccdNumber(" 092123456789 "), "092123456789");
  for (const value of [undefined, null, 92123456789, "09212345678", "0921234567890", "09212345A789", "092 12345678"]) {
    assert.equal(normalizeEmployeeCccdNumber(value), null);
  }
  assert.equal(maskEmployeeCccdNumber("092123456789"), "092******789");
  assert.equal(maskEmployeeCccdNumber("invalid"), null);
});
