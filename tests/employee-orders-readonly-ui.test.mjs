import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("manager order summary cards use four distinct, responsive visual treatments", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("app/components/StoreOrdersManagement.tsx", root), "utf8"),
    readFile(new URL("app/components/StoreOrdersManagement.module.css", root), "utf8"),
  ]);

  for (const modifier of ["metricOrders", "metricCash", "metricTransfer", "metricRevenue"]) {
    assert.match(component, new RegExp(`styles\\.${modifier}`, "u"));
    assert.match(css, new RegExp(`\\.${modifier}\\s*\\{`, "u"));
  }

  const accents = [...css.matchAll(/\.metric(?:Orders|Cash|Transfer|Revenue)\s*\{[\s\S]*?--metric-accent:\s*(#[\da-f]{6})/giu)]
    .map((match) => match[1].toLowerCase());
  assert.equal(new Set(accents).size, 4, "each order metric must remain visually distinguishable");
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.metric \{ padding:/u);
  assert.match(css, /@media \(max-width: 1450px\)[\s\S]*\.metrics \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/u);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.metrics \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u);
});

test("employee order history exposes detail only and never sends edit or delete mutations", async () => {
  const portal = await readFile(new URL("app/components/Portal.tsx", root), "utf8");
  const start = portal.indexOf("function EmployeeOrders");
  const end = portal.indexOf("function EmployeePayroll", start);
  assert.ok(start >= 0 && end > start, "EmployeeOrders source section must be discoverable");

  const employeeOrders = portal.slice(start, end);
  assert.match(employeeOrders, /method: "POST"/u, "employees must still be able to create a new order");
  assert.doesNotMatch(employeeOrders, /method: "PATCH"|method: "DELETE"/u);
  assert.doesNotMatch(employeeOrders, /beginEdit|async function cancel|title="Sửa đơn"|title="Hủy đơn"/u);
  assert.match(employeeOrders, /aria-label=\{`Xem chi tiết đơn \$\{order\.code\}`\}/u);
  assert.match(employeeOrders, /Đơn đã lưu chỉ được xem/u);
  assert.match(employeeOrders, /<th>Chi tiết<\/th>/u);
});
