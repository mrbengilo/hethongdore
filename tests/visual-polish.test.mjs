import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("date and month controls expose one full keyboard and touch target", async () => {
  const [picker, format, styles, inventory, attendance, payroll, cashflow] = await Promise.all([
    source("../app/components/DatePickerControl.tsx"),
    source("../app/lib/format.ts"),
    source("../app/globals.css"),
    source("../app/components/InventoryManagement.tsx"),
    source("../app/components/ReferenceStoreModules.tsx"),
    source("../app/components/StorePayrollClosing.tsx"),
    source("../app/components/StoreCashflow.tsx"),
  ]);

  assert.match(picker, /className="app-date-picker-native"/u);
  assert.match(picker, /typeof input\.showPicker !== "function"/u);
  assert.match(picker, /event\.key !== "Enter" && event\.key !== " "/u);
  assert.match(format, /day: "2-digit",[\s\S]*month: "2-digit",[\s\S]*year: "numeric"/u);
  assert.match(styles, /\.app-date-picker-native\{[^}]*position:absolute!important;[^}]*inset:0!important;[^}]*width:100%!important;[^}]*height:100%!important;[^}]*opacity:0/u);
  for (const component of [inventory, attendance, payroll, cashflow]) {
    assert.match(component, /<DatePickerControl/u);
  }
});

test("financial and order summaries use strong semantic cards and separated groups", async () => {
  const [globalStyles, orders, orderStyles] = await Promise.all([
    source("../app/globals.css"),
    source("../app/components/StoreOrdersManagement.tsx"),
    source("../app/components/StoreOrdersManagement.module.css"),
  ]);

  assert.match(globalStyles, /\.stat-card,\.manager-metric,\.ref-metric,\.store-cashflow-metric\{[^}]*--metric-accent/u);
  assert.match(globalStyles, /\.stat-card strong,\.manager-metric strong,\.ref-metric strong,\.store-cashflow-metric strong\{[^}]*font-size:clamp\(23px,1\.8vw,30px\);[^}]*font-weight:850/u);
  for (const icon of ["ShoppingBag", "Banknote", "Landmark", "ReceiptText"]) assert.match(orders, new RegExp(`<${icon} size=\\{23\\}`, "u"));
  assert.match(orderStyles, /\.group\s*\{[^}]*margin: 14px;[^}]*border: 1px solid #cfe2d5;[^}]*border-radius: 14px;[^}]*box-shadow:/su);
});

test("attendance statuses retain distinct early, on-time and late colors", async () => {
  const [attendance, globalStyles, cashflow, cashflowStyles] = await Promise.all([
    source("../app/components/ReferenceStoreModules.tsx"),
    source("../app/globals.css"),
    source("../app/components/StoreCashflow.tsx"),
    source("../app/components/StoreCashflow.module.css"),
  ]);

  assert.match(attendance, /return "attendance-status attendance-late"/u);
  assert.match(attendance, /return "attendance-status attendance-early"/u);
  assert.match(attendance, /return "attendance-status attendance-on-time"/u);
  assert.match(globalStyles, /\.attendance-early\{[^}]*color:#087333/u);
  assert.match(globalStyles, /\.attendance-on-time\{[^}]*color:#1769d7/u);
  assert.match(globalStyles, /\.attendance-late\{[^}]*color:#c43b2d/u);
  assert.match(cashflow, /styles\.shiftAttendanceOnTime/u);
  assert.match(cashflowStyles, /\.shiftAttendanceOnTime\s*\{[^}]*color: #1769d7;/su);
});
