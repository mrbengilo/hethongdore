import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("employee mobile order filters keep the current date visible after reset", async () => {
  const portal = await readFile(new URL("app/components/Portal.tsx", root), "utf8");
  const start = portal.indexOf("function EmployeeOrders");
  const end = portal.indexOf("// End of the employee order module.", start);
  const employeeOrders = portal.slice(start, end);

  assert.match(employeeOrders, /useState\(todayLocalDate\)/u);
  assert.match(employeeOrders, /const today = todayLocalDate\(\);[\s\S]*setFromDate\(today\);[\s\S]*setToDate\(today\);/u);
  assert.match(employeeOrders, /className="order-filter-label">Từ ngày/u);
  assert.match(employeeOrders, /className="order-filter-label">Đến ngày/u);
});

test("employee mobile order metrics and order cards retain strong visual separation", async () => {
  const [portal, css] = await Promise.all([
    readFile(new URL("app/components/Portal.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  for (const tone of ["orders", "bank", "cash", "total"]) {
    assert.match(portal, new RegExp(`order-stat-card order-stat-${tone}`, "u"));
    assert.match(css, new RegExp(`\\.order-stat-${tone}\\{--order-stat-accent:`, "u"));
  }
  assert.match(css, /\.order-stat-card\{[^}]*border:2px solid var\(--order-stat-border\)[^}]*box-shadow:/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.order-stat-card span\{[^}]*font-size:11px;[^}]*font-weight:850/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.order-table tr\{[^}]*border:2px solid #9bcdaa;[^}]*box-shadow:/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.order-filters input,\.order-filters select,\.order-filters \.refresh-button\{[^}]*color:#17281e;[^}]*font-weight:750/u);
});
