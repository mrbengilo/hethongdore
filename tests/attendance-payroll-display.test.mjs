import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("attendance history exposes requested filters and TikTok allowance everywhere", async () => {
  const component = await source("app/components/ReferenceStoreModules.tsx");

  assert.match(component, /LỊCH SỬ CHẤM CÔNG/u);
  assert.match(component, /hint="Thời gian"/u);
  for (const label of ["Theo ca", "Theo ngày", "Theo nhân viên"]) {
    assert.match(component, new RegExp(`>${label}<`, "u"));
  }
  assert.match(component, /current\.tiktokAllowance \+=/u);
  assert.match(component, /<th>Phụ cấp TikTok<\/th>/u);
  assert.match(component, /<dt>Phụ cấp TikTok<\/dt>/u);
  assert.match(component, /"Phụ cấp TikTok"/u);
  assert.match(component, /useShiftSessions\(store\.id, month\)/u);
  assert.match(component, /query\.set\("period", period\)/u);
  assert.match(component, /pages !== 1/u);
  assert.match(component, /pagination\?\.total[^\n]+complete\.length/u);
  assert.match(component, /requestController\.current\?\.abort\(\)/u);
});

test("attendance shift state uses exact red-ended and green-active labels", async () => {
  const [component, css] = await Promise.all([
    source("app/components/ReferenceStoreModules.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(component, /label: "ĐANG LÀM", className: "attendance-shift-state attendance-shift-active"/u);
  assert.match(component, /label: "ĐÃ KẾT CA", className: "attendance-shift-state attendance-shift-ended"/u);
  assert.match(css, /\.attendance-shift-active\{[^}]*color:#087d36/u);
  assert.match(css, /\.attendance-shift-ended\{[^}]*color:#c7322b/u);
});

test("payroll allowance amount explains each non-zero source", async () => {
  const component = await source("app/components/ReferenceStoreModules.tsx");

  assert.match(component, /item\.tiktokAllowance > 0 \? `TikTok:/u);
  assert.match(component, /item\.supportAllowance > 0 \? `Hỗ trợ:/u);
  assert.match(component, /item\.manualAllowance > 0 \? `Khác:/u);
  assert.match(component, /className="money-green payroll-allowance-cell"/u);
  assert.match(component, /<small>\{itemAllowanceNote\(item\)\}<\/small>/u);
});
