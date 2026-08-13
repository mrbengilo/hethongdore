import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesUrl = new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url);

test("schedule grids keep the employee column compact and scroll inside their panel", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.match(styles, /\.tableWrap\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;[^}]*padding:\s*0 10px 12px;/su);
  assert.match(styles, /\.scheduleTable\s*\{[^}]*min-width:\s*680px;[^}]*width:\s*100%;/su);
  assert.match(styles, /\.scheduleTable th:first-child,[\s\S]*?\.scheduleTable td:first-child\s*\{[^}]*min-width:\s*184px;[^}]*width:\s*184px;/u);
  assert.match(styles, /\.employeeName\s*\{[^}]*gap:\s*8px;[^}]*min-width:\s*0;/su);
  assert.match(styles, /\.employeeName > span:last-child\s*\{[^}]*min-width:\s*0;/su);
});

test("created schedule rows are denser without shrinking interactive targets", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.match(styles, /\.scheduleHistory article\s*\{[^}]*gap:\s*9px;[^}]*padding:\s*9px 14px;/su);
  assert.match(styles, /\.employeeScheduleList article\s*\{[^}]*gap:\s*10px;[^}]*grid-template-columns:\s*184px minmax\(0, 1fr\);[^}]*padding:\s*9px 2px;/su);
  assert.match(styles, /\.employeeScheduleList article > div:last-child > button\s*\{[^}]*min-height:\s*44px;/su);
  assert.match(styles, /\.cardActions button,[\s\S]*?\.modalHeader > button\s*\{[^}]*height:\s*44px;[^}]*width:\s*44px;/u);
});

test("small screens keep compact schedule rows and locally scrollable tables", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  const mobile = styles.slice(styles.indexOf("@media (max-width: 600px)"));

  assert.match(mobile, /\.scheduleHistory article\s*\{[^}]*gap:\s*7px;[^}]*padding:\s*8px 9px;/su);
  assert.match(mobile, /\.scheduleHistory article > div\s*\{[^}]*flex-direction:\s*column;/su);
  assert.match(mobile, /\.scheduleTable th:first-child,[\s\S]*?\.scheduleTable td:first-child\s*\{[^}]*min-width:\s*166px;[^}]*width:\s*166px;/u);
  assert.match(mobile, /\.cardActions button\s*\{[^}]*height:\s*44px;[^}]*width:\s*44px;/su);
});
