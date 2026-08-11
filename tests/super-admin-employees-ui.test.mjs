import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("employee lifecycle panel is wired only through the super-admin reset workspace", async () => {
  const [portal, reset, route] = await Promise.all([
    source("../app/components/Portal.tsx"),
    source("../app/components/SuperAdminReset.tsx"),
    source("../app/api/admin/employees/route.ts"),
  ]);

  assert.match(portal, /Number\(user\.isSuperAdmin\) === 1 \? superAdminStoreMenu : storeMenu/u);
  assert.match(portal, /view === "Reset Dữ Liệu" && isSuperAdmin \? <SuperAdminReset/u);
  assert.match(reset, /import \{ SuperAdminEmployees \} from "\.\/SuperAdminEmployees"/u);
  assert.match(reset, /<SuperAdminEmployees store=\{store\} onChanged=\{onReset\}\/>/u);
  assert.match(route, /async function requireSuperAdmin\(request: Request\)[\s\S]*user\?\.role === "MANAGER" && Number\(user\.isSuperAdmin\) === 1/u);
  for (const handler of ["GET", "PATCH", "DELETE"]) {
    assert.match(route, new RegExp(`export async function ${handler}\\(request: Request\\) \\{\\n  const user = await requireSuperAdmin\\(request\\);`, "u"));
  }
  assert.match(route, /"Cache-Control": "private, no-store, max-age=0"/u);
  assert.match(route, /Vary: "Cookie"/u);
});

test("panel exposes exactly the three requested statuses and explains their login effect", async () => {
  const component = await source("../app/components/SuperAdminEmployees.tsx");

  assert.match(component, /type EmployeeStatus = "ACTIVE" \| "SUSPENDED" \| "TERMINATED"/u);
  const optionBlock = component.slice(
    component.indexOf("const STATUS_OPTIONS"),
    component.indexOf("const money"),
  );
  assert.deepEqual(optionBlock.match(/value: "[A-Z]+"/gu), [
    'value: "ACTIVE"',
    'value: "SUSPENDED"',
    'value: "TERMINATED"',
  ]);
  for (const label of ["Đang làm việc", "Tạm ngưng", "Đã nghỉ việc"]) {
    assert.match(optionBlock, new RegExp(label, "u"));
  }
  assert.match(component, /Tạm ngưng và Đã nghỉ việc sẽ bị đăng xuất và không thể đăng nhập\./u);
});

test("delete confirmation is explicit, reasoned and bound to the employee code", async () => {
  const component = await source("../app/components/SuperAdminEmployees.tsx");

  assert.match(component, /reason\.trim\(\)\.length < 3/u);
  assert.match(component, /confirmation\.trim\(\)\.toLocaleUpperCase\("vi-VN"\) !== pending\.row\.code\.toLocaleUpperCase\("vi-VN"\)/u);
  assert.match(component, /Nhập mã <b>\{pending\.row\.code\}<\/b> để xác nhận/u);
  assert.match(component, /Nhập ít nhất 3 ký tự/u);
  assert.match(component, /Tài khoản, phiên đăng nhập, hồ sơ nhận dạng và ảnh CCCD sẽ bị xóa\./u);
  assert.match(component, /pending\.kind === "DELETE" \? "Xóa khỏi hệ thống" : "Xác nhận trạng thái"/u);
  assert.match(component, /disabled=\{saving \|\| !canSubmit\}/u);
});

test("employee endpoint query and mutation contracts stay aligned with the panel", async () => {
  const [component, route] = await Promise.all([
    source("../app/components/SuperAdminEmployees.tsx"),
    source("../app/api/admin/employees/route.ts"),
  ]);

  assert.match(component, /new URLSearchParams\(\{ storeId: store\.id, page: String\(page\), pageSize: "20" \}\)/u);
  assert.match(component, /params\.set\("search", search\.trim\(\)\)/u);
  assert.match(component, /fetch\(`\/api\/admin\/employees\?\$\{params\.toString\(\)\}`,[\s\S]*cache: "no-store"/u);
  assert.match(component, /method: pending\.kind === "DELETE" \? "DELETE" : "PATCH"/u);
  for (const field of ["storeId", "id", "versionToken", "reason", "status", "confirmation"]) {
    assert.match(component, new RegExp(`\\b${field}\\b`, "u"));
    assert.match(route, new RegExp(`\\b${field}\\b`, "u"));
  }
  for (const responseField of ["rows", "pagination", "statusLabel", "hasLogin", "versionToken", "warning", "attendanceReview"]) {
    assert.match(route, new RegExp(`\\b${responseField}\\b`, "u"));
  }
  assert.match(component, /setWarning\(data\.warning \?\? ""\)/u);
});

test("mobile employee list is card-based, bounded and does not force page overflow", async () => {
  const css = await source("../app/components/SuperAdminEmployees.module.css");

  assert.match(css, /\.panel \{[^}]*overflow: hidden;/su);
  assert.match(css, /\.tableWrap \{[^}]*overflow-x: auto;/su);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.tableWrap \{[^}]*overflow: visible;/su);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.table \{[^}]*display: block;[^}]*min-width: 0;/su);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.table tr \{[^}]*display: grid;[^}]*overflow: hidden;/su);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.table td \{[^}]*minmax\(0, 1fr\)[^}]*overflow-wrap: anywhere;/su);
  assert.match(css, /\.dialog \{[^}]*width: min\(560px, 100%\);[^}]*max-height: calc\(100dvh - 36px\);[^}]*overflow-y: auto;/su);
  assert.match(css, /\.refresh, \.actions button, \.pagination button, \.dialogActions button, \.close \{[^}]*min-height: 44px;/su);
});

test("confirmation dialog traps focus, closes safely and restores its trigger", async () => {
  const component = await source("../app/components/SuperAdminEmployees.tsx");

  assert.match(component, /role="dialog" aria-modal="true" aria-labelledby="employee-action-title" aria-busy=\{saving\}/u);
  assert.match(component, /ref=\{dialogTitleRef\} tabIndex=\{-1\}/u);
  assert.match(component, /dialogTitleRef\.current\?\.focus\(\)/u);
  assert.match(component, /event\.key === "Escape" && !saving/u);
  assert.match(component, /event\.key !== "Tab"/u);
  assert.match(component, /const activeIndex = active instanceof HTMLElement \? focusable\.indexOf\(active\) : -1/u);
  assert.match(component, /event\.shiftKey && activeIndex <= 0[\s\S]*last\.focus\(\)/u);
  assert.match(component, /!event\.shiftKey && \(activeIndex === -1 \|\| active === last\)[\s\S]*first\.focus\(\)/u);
  assert.match(component, /document\.body\.style\.overflow = "hidden"/u);
  assert.match(component, /document\.body\.style\.overflow = previousOverflow/u);
  assert.match(component, /triggerRef\.current\?\.isConnected[\s\S]*triggerRef\.current\?\.focus\(\)/u);
  assert.match(component, /if \(event\.target === event\.currentTarget\) closeDialog\(\)/u);
  assert.match(component, /aria-label="Đóng"/u);
});
