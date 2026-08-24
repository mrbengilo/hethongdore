import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const attendanceCss = await readFile(new URL("../app/components/AttendancePolicySettings.module.css", import.meta.url), "utf8");
const payrollCss = await readFile(new URL("../app/components/PayrollPolicySettings.module.css", import.meta.url), "utf8");

test("attendance policy controls stay compact and touch accessible", () => {
  assert.match(attendanceCss, /\.card\{[^}]*max-width:760px/u);
  assert.match(attendanceCss, /\.numberField input\{[^}]*min-height:44px/u);
  assert.match(attendanceCss, /@media\(max-width:720px\)[\s\S]*\.policyGrid\{grid-template-columns:1fr\}/u);
  assert.match(attendanceCss, /@media\(max-width:720px\)[\s\S]*\.actionRow button\{width:100%/u);
});

test("payroll policy fields use bounded desktop widths and expand on mobile", () => {
  assert.match(payrollCss, /\.moneyInput,\s*\.percentInput\s*\{[^}]*width:\s*min\(100%,\s*360px\)/u);
  assert.match(payrollCss, /\.tiers \.percentInput\s*\{[^}]*width:\s*min\(100%,\s*220px\)/u);
  assert.match(payrollCss, /\.moneyInput input,\s*\.percentInput input\s*\{[^}]*min-height:\s*44px/u);
  assert.match(payrollCss, /@media \(max-width: 800px\)[\s\S]*\.moneyInput,\s*\.percentInput,\s*\.tiers \.percentInput\s*\{[^}]*width:\s*100%/u);
});
