import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatVndDisplay, formatVndInput, parseVndInput } from "../app/lib/format.ts";

const source = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

test("VND input helper groups digits while preserving numeric API values", () => {
  assert.equal(formatVndDisplay(5000), "5,000 đồng");
  assert.equal(formatVndDisplay(-20000), "-20,000 đồng");
  assert.equal(formatVndInput("20000"), "20,000");
  assert.equal(parseVndInput("20,000"), 20000);
  assert.ok(Number.isNaN(parseVndInput("9,007,199,254,740,992")));
  assert.equal(formatVndInput("3000000"), "3,000,000");
  assert.equal(formatVndInput("3,000,000"), "3,000,000");
  assert.equal(formatVndInput("00025000"), "25,000");
  assert.equal(formatVndInput(""), "");
  assert.equal(parseVndInput("3,000,000"), 3_000_000);
  assert.equal(parseVndInput(""), 0);
});

test("money editors format on input and parse before sending data", async () => {
  const [functional, referenceStore, payrollPolicy, dataRecords, directory] = await Promise.all([
    source("../app/components/FunctionalModules.tsx"),
    source("../app/components/ReferenceStoreModules.tsx"),
    source("../app/components/PayrollPolicySettings.tsx"),
    source("../app/components/SuperAdminDataRecords.tsx"),
    source("../app/components/SuperAdminEmployeeDirectory.tsx"),
  ]);

  for (const component of [functional, referenceStore, payrollPolicy, dataRecords, directory]) {
    assert.match(component, /formatVndInput/u);
    assert.match(component, /parseVndInput/u);
  }

  assert.match(functional, /allowance: parseVndInput\(allowance\)/u);
  assert.match(functional, /hourlyRate: parseVndInput\(form\.hourlyRate\)/u);
  assert.match(referenceStore, /unitPrice=parseVndInput\(form\.unitPrice\)/u);
  assert.match(referenceStore, /shipping=parseVndInput\(form\.shipping\)/u);
  assert.match(referenceStore, /amount:parseVndInput\(amount\)/u);
  assert.match(payrollPolicy, /const managerMonthlySalaryVnd = parseVndInput\(salary\)/u);
  assert.match(dataRecords, /amount: parseVndInput\(orderForm\.amount\)/u);
  assert.match(directory, /hourlyRate: parseVndInput\(draft\.hourlyRate\)/u);
  assert.match(directory, /tiktokAllowance: parseVndInput\(draft\.tiktokAllowance\)/u);
});


test("payroll review, manager salary and setup repayment editors use grouped VND without changing hours or percentages", async () => {
  const [review, manager, reports] = await Promise.all([
    source("../app/components/PayrollReviewEditor.tsx"), source("../app/components/StoreManagerPayroll.tsx"),
    source("../app/components/FinancialReports.tsx"),
  ]);
  assert.match(review, /parseVndInput\(fields\[key\]\)/);
  assert.match(review, /parseVndInput\(fields\.kpiBonus\)/);
  assert.match(review, /Giờ tính lương<input type="number"/);
  assert.match(manager, /managerSalary: parseVndInput\(amount\)/);
  assert.match(reports, /amount: selectedAmount/);
  assert.match(reports, /parseVndInput\(selectedDraft\.value\)/);
  for (const component of [review, manager, reports]) {
    assert.match(component, /type="text" inputMode="numeric" pattern="\[0-9,\]\*"/);
    assert.match(component, /formatVndInput\(event\.target\.value\)/);
  }
});
