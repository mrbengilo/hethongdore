import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const attendanceCss = await readFile(new URL("../app/components/AttendancePolicySettings.module.css", import.meta.url), "utf8");
const payrollCss = await readFile(new URL("../app/components/PayrollPolicySettings.module.css", import.meta.url), "utf8");

test("attendance policy controls stay compact and touch accessible", () => {
  assert.match(attendanceCss, /\.card\{[^}]*max-width:760px/u);
  assert.match(attendanceCss, /\.inputRow\{[^}]*minmax\(120px,180px\)/u);
  assert.match(attendanceCss, /\.inputRow input\{[^}]*min-height:44px/u);
  assert.match(attendanceCss, /@media\(max-width:720px\)[\s\S]*\.inputRow button\{[^}]*width:100%/u);
});

test("payroll policy fields use bounded desktop widths and expand on mobile", () => {
  assert.match(payrollCss, /\.moneyInput,\.percentInput\{[^}]*width:min\(100%,360px\)/u);
  assert.match(payrollCss, /\.tiers \.percentInput\{width:min\(100%,220px\)/u);
  assert.match(payrollCss, /\.moneyInput input,\.percentInput input\{[^}]*min-height:44px/u);
  assert.match(payrollCss, /@media\(max-width:800px\)[\s\S]*\.moneyInput,\.percentInput,\.tiers \.percentInput\{width:100%/u);
});
