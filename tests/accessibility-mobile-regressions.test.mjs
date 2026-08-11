import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("shared modal guard traps focus, isolates the background and restores state", async () => {
  const hook = await source("../app/components/useAccessibleModal.ts");

  assert.match(hook, /sibling\.inert = true/u);
  assert.match(hook, /sibling\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(hook, /element\.inert = inert/u);
  assert.match(hook, /if \(ariaHidden === null\) element\.removeAttribute\("aria-hidden"\)/u);
  assert.match(hook, /event\.shiftKey && \(activeIndex <= 0 \|\| !dialog\.contains\(active\)\)/u);
  assert.match(hook, /document\.addEventListener\("focusin", onFocusIn, true\)/u);
  assert.match(hook, /document\.body\.style\.overflow = "hidden"/u);
  assert.match(hook, /window\.requestAnimationFrame\(\(\) => focusTarget\.focus/u);
});

test("every in-tree editor and drawer uses the shared modal guard", async () => {
  const [orders, employeeHome, payroll, employees, scheduling] = await Promise.all([
    source("../app/components/StoreOrdersManagement.tsx"),
    source("../app/components/ReferenceEmployeeHome.tsx"),
    source("../app/components/ReferenceStoreModules.tsx"),
    source("../app/components/EmployeeManagement.tsx"),
    source("../app/components/StoreSchedulingModules.tsx"),
  ]);

  assert.match(orders, /useAccessibleModal\(\{[\s\S]*open: Boolean\(editing\),[\s\S]*rootRef: editBackdropRef,[\s\S]*dialogRef: editDialogRef,[\s\S]*returnFocusRef: editTriggerRef/u);
  assert.match(orders, /ref=\{editDialogRef\}[^>]*role="dialog" aria-modal="true"/u);

  assert.match(employeeHome, /useAccessibleModal\(\{[\s\S]*open: Boolean\(pendingEarlyEnd\),[\s\S]*initialFocusRef: declineEarlyEndRef,[\s\S]*returnFocusRef: endButtonRef/u);
  assert.match(employeeHome, /ref=\{earlyEndDialogRef\}[^>]*role="dialog" aria-modal="true"/u);

  assert.match(payroll, /useAccessibleModal\(\{[\s\S]*rootRef: payrollBackdropRef,[\s\S]*initialFocusRef: payrollEmployeeSelectRef,[\s\S]*returnFocusRef: payrollTriggerRef/u);
  assert.match(payroll, /ref=\{payrollDialogRef\}[^>]*role="dialog" aria-modal="true"/u);

  assert.match(employees, /useAccessibleModal\(\{[\s\S]*rootRef: drawerRef,[\s\S]*initialFocusRef: drawerInitialFocusRef,[\s\S]*returnFocusRef: drawerTriggerRef/u);
  assert.match(employees, /ref=\{drawerRef\}[^>]*role="dialog" aria-modal="true"/u);
  assert.match(employees, /aria-label="Đóng biểu mẫu nhân viên"/u);

  assert.match(scheduling, /useAccessibleModal\(\{[\s\S]*open: shiftOpen,[\s\S]*rootRef: shiftBackdropRef,[\s\S]*dialogRef: shiftDialogRef,[\s\S]*initialFocusRef: shiftInitialFocusRef,[\s\S]*returnFocusRef: shiftReturnFocusRef/u);
  assert.match(scheduling, /ref=\{shiftDialogRef\} role="dialog" aria-modal="true" aria-labelledby="daily-shift-dialog-title" tabIndex=\{-1\}/u);
  assert.match(scheduling, /useAccessibleModal\(\{[\s\S]*open,[\s\S]*rootRef: scheduleBackdropRef,[\s\S]*dialogRef: scheduleDialogRef,[\s\S]*initialFocusRef: scheduleInitialFocusRef,[\s\S]*returnFocusRef: scheduleReturnFocusRef/u);
  assert.match(scheduling, /ref=\{scheduleDialogRef\} role="dialog" aria-modal="true" aria-labelledby="schedule-editor-dialog-title" tabIndex=\{-1\}/u);
});

test("mobile navigation and expanded inventory regions remain keyboard-safe", async () => {
  const [portal, inventory, styles] = await Promise.all([
    source("../app/components/Portal.tsx"),
    source("../app/components/InventoryManagement.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(portal, /<aside id="app-navigation-sidebar"/u);
  assert.match(portal, /aria-controls="app-navigation-sidebar" aria-expanded=\{open\}/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.sidebar:not\(\.open\)\{visibility:hidden;pointer-events:none\}/u);
  assert.match(inventory, /role="region" tabIndex=\{0\} aria-label=\{`Chi tiết phiếu nhập \$\{receipt\.receiptNo\}`\}/u);
  assert.match(styles, /\.inventory-table-scroll:focus-visible\{outline:/u);
});

test("store order grids shrink to the page while wide tables scroll locally", async () => {
  const styles = await source("../app/components/StoreOrdersManagement.module.css");

  assert.match(styles, /\.module\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*min-width:\s*0;/su);
  assert.match(styles, /\.metric,\s*\.panel\s*\{[^}]*min-width:\s*0;/su);
  assert.match(styles, /\.group\s*\{[^}]*min-width:\s*0;/su);
  assert.match(styles, /\.tableWrap\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/su);
  assert.match(styles, /\.metric strong\s*\{[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/su);
  assert.match(styles, /@media \(max-width:\s*1450px\)\s*\{\s*\.metrics\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*?\.metrics\s*\{\s*grid-template-columns:\s*1fr;/u);
});

test("attendance mobile controls and cards expose keyboard and screen-reader semantics", async () => {
  const [attendance, styles] = await Promise.all([
    source("../app/components/ReferenceStoreModules.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(attendance, /className="ref-tabs compact attendance-mode-tabs" role="group" aria-label="Cách tổng hợp chấm công"/u);
  assert.match(attendance, /aria-pressed=\{mode === "shift"\}/u);
  assert.match(attendance, /role="region" tabIndex=\{0\} aria-label="Bảng chấm công, cuộn ngang để xem đầy đủ"/u);
  assert.match(attendance, /<ol className="attendance-mobile-list" aria-label="Danh sách chấm công">/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.attendance-mode-tabs button\{[^}]*min-height:48px/u);
  assert.match(styles, /\.attendance-table-head>\.attendance-table-controls\{display:block;width:100%;max-width:none\}/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.attendance-location-item>a\{min-height:44px/u);
});
