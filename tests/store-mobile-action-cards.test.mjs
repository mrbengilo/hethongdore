import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("store employee management keeps the desktop table and exposes bounded mobile action cards", async () => {
  const [component, styles] = await Promise.all([
    source("../app/components/EmployeeManagement.tsx"),
    source("../app/components/EmployeeManagement.module.css"),
  ]);

  assert.match(component, /className=\{`data-table-wrap \$\{styles\.desktopTableWrap\}`\}[\s\S]*role="region"[\s\S]*aria-label="Bảng danh sách nhân viên, cuộn ngang để xem đầy đủ"/u);
  assert.match(component, /<ol className=\{styles\.mobileEmployeeList\} aria-label=\{`Danh sách nhân viên của \$\{store\.name\}`\}>/u);
  assert.match(component, /className=\{styles\.mobileEmployeeCard\}/u);
  assert.match(component, /aria-label=\{`Trạng thái làm việc của \$\{employee\.name\}`\}/u);
  assert.match(component, /className=\{styles\.mobileEditButton\}[\s\S]*aria-label=\{`Sửa hồ sơ \$\{employee\.name\}`\}/u);
  assert.match(styles, /\.mobileEmployeeList\s*\{\s*display:\s*none;/u);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.desktopTableWrap\s*\{\s*display:\s*none;/u);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.mobileEmployeeList\s*\{[\s\S]*display:\s*grid;[\s\S]*min-width:\s*0;/u);
  assert.match(styles, /\.mobileEmployeeCard\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*border:\s*2px solid/u);
  assert.match(styles, /\.statusControl\s*\{[\s\S]*min-height:\s*44px;/u);
  assert.match(styles, /\.mobileEditButton\s*\{[\s\S]*min-height:\s*44px;/u);
});

test("payroll closing keeps its desktop reconciliation table and makes individual close actions reachable on mobile", async () => {
  const [component, styles] = await Promise.all([
    source("../app/components/StorePayrollClosing.tsx"),
    source("../app/components/StorePayrollClosing.module.css"),
  ]);

  assert.match(component, /className=\{`data-table-wrap \$\{styles\.desktopTableWrap\}`\} role="region" aria-label="Bảng chi tiết lương thưởng nhân viên, cuộn ngang để xem đầy đủ"/u);
  assert.match(component, /className="data-table employee-closing-table"/u);
  assert.match(component, /<ol className=\{styles\.mobilePayrollList\} aria-label=\{`Chi tiết lương thưởng nhân viên kỳ \$\{period\}`\}>/u);
  assert.match(component, /className=\{`\$\{styles\.mobilePayrollCard\} \$\{isInactive \? styles\.mobilePayrollCardInactive : ""\}`\}/u);
  assert.match(component, /<details className=\{styles\.mobilePayrollDetails\}>/u);
  assert.match(component, /aria-label=\{`\$\{actionLabel\} cho \$\{item\.employeeName\}`\}/u);
  assert.match(component, /onClick=\{\(\) => void runAction\("FINALIZE_SINGLE_EMPLOYEE", item\)\}/u);
  assert.match(styles, /\.mobilePayrollList\s*\{\s*display:\s*none;/u);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.desktopTableWrap\s*\{\s*display:\s*none;/u);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.mobilePayrollList\s*\{[\s\S]*display:\s*grid;[\s\S]*min-width:\s*0;/u);
  assert.match(styles, /\.mobilePayrollCard\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*border:\s*2px solid/u);
  assert.match(styles, /\.mobilePayrollAction > button\s*\{[\s\S]*min-height:\s*44px;/u);
  assert.match(styles, /\.mobilePayrollDetails summary\s*\{[\s\S]*min-height:\s*44px;/u);
});
