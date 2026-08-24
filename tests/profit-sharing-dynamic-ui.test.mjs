import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../app/components/FinancialReports.tsx", import.meta.url);

test("profit-sharing UI derives every member column and amount from API data", async () => {
  const source = await readFile(componentUrl, "utf8");

  for (const hardCodedValue of [
    "pham-thi-diem-thuy",
    "truong-viet-vi",
    "Phạm Thị Diễm Thúy",
    "Trương Việt Vi",
    "40%",
    "60%",
    "percentage: 40",
    "percentage: 60",
    "hai thành viên cố định",
  ]) assert.doesNotMatch(source, new RegExp(hardCodedValue, "u"));

  assert.match(source, /profitSharingMemberCatalog/u);
  assert.match(source, /data\?\.profitSharingMembers \?\? \[\]/u);
  assert.match(source, /currentMembers\.map/u);
  assert.match(source, /historyMembers\.map/u);
  assert.match(source, /memberAllocation\(store\.memberAllocations, member\)/u);
  assert.match(source, /memberAllocation\(item\.memberAllocations, member\)/u);
});

test("profit-sharing CSV and lifecycle provenance are dynamic and legacy-safe", async () => {
  const source = await readFile(componentUrl, "utf8");

  assert.match(source, /const memberHeaders = historyMembers\.flatMap/u);
  assert.match(source, /\.\.\.historyMembers\.flatMap/u);
  assert.match(source, /Tỷ lệ snapshot/u);
  assert.match(source, /ĐÃ KHÓA \(LOCKED\)/u);
  assert.match(source, /LỊCH SỬ CŨ · LOCKED · CHỈ ĐỌC/u);
  assert.match(source, /finiteNumber\(currentHistory\?\.accountingProfit\)[\s\S]*finiteNumber\(currentHistory\?\.profit\)/u);
  assert.match(source, /currentMembers\.length === 0/u);
  assert.match(source, /exportDisabled=\{!data \|\| history\.length === 0\}/u);
  assert.match(source, /colSpan=\{6 \+ currentMembers\.length\}/u);
  assert.match(source, /colSpan=\{9 \+ historyMembers\.length\}/u);
});
