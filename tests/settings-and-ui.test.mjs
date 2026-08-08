import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("schedule employee chooser is a compact accessible vertical list", async () => {
  const [component, styles] = await Promise.all([
    source("../app/components/StoreSchedulingModules.tsx"),
    source("../app/components/StoreSchedulingModules.module.css"),
  ]);

  assert.match(component, /aria-label="Danh sách nhân viên theo chiều dọc"/u);
  assert.match(component, /aria-label="Tìm nhân viên"/u);
  assert.match(component, /Không tìm thấy nhân viên phù hợp/u);
  assert.match(styles, /\.employeePicker\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*gap:\s*5px;[^}]*max-height:\s*240px;[^}]*overflow-y:\s*auto;/su);
  assert.match(styles, /\.employeePicker label\s*\{[^}]*min-height:\s*46px;[^}]*padding:\s*6px 9px;/su);
});

test("fixed-cost primary buttons expose readable action labels", async () => {
  const [component, styles] = await Promise.all([
    source("../app/components/FixedCostManagement.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(component, /> Thêm chi phí<\/button>/u);
  assert.equal(component.match(/"Lưu chi phí"/gu)?.length, 2);
  assert.match(styles, /\.fixed-cost-toolbar \.primary-button,[\s\S]*?background:\s*linear-gradient\([^)]+\);[\s\S]*?color:\s*#fff;/u);
  assert.match(styles, /\.fixed-cost-save-actions \.primary-button/u);
});

test("manager password change verifies the current secret and revokes other sessions", async () => {
  const [settings, route] = await Promise.all([
    source("../app/components/FunctionalModules.tsx"),
    source("../app/api/auth/password/route.ts"),
  ]);

  for (const icon of ["UserRoundCog", "KeyRound", "BellRing", "Languages", "ShieldCheck"]) assert.match(settings, new RegExp(icon, "u"));
  assert.match(settings, /fetch\("\/api\/auth\/password"/u);
  assert.match(settings, /current-password/u);
  assert.match(settings, /new-password/u);
  assert.match(settings, /Xác nhận mật khẩu mới/u);
  assert.match(route, /user\.role !== "MANAGER"/u);
  assert.match(route, /verifyPassword\(currentPassword, account\.passwordHash\)/u);
  assert.match(route, /hashPassword\(newPassword\)/u);
  assert.match(route, /DELETE FROM sessions WHERE user_id = \? AND token_hash != \?/u);
  assert.match(route, /PASSWORD_CHANGED/u);
  assert.doesNotMatch(route, /writeAudit\([^\n]*(currentPassword|newPassword|confirmPassword)/u);
});

test("declining rollover warns the employee without ending the active shift", async () => {
  const portal = await source("../app/components/Portal.tsx");
  assert.match(portal, /setRolloverWarning\("Bạn cần phải Kết Ca làm việc vì đã quá thời gian kết ca hơn 60 phút"\)/u);
  assert.match(portal, /className="rollover-warning-banner" role="alert"/u);
  const decline = portal.slice(portal.indexOf("function declineRollover"), portal.indexOf("async function confirmRollover"));
  assert.doesNotMatch(decline, /fetch\(|shiftAction\(|setShift\(/u);
});
