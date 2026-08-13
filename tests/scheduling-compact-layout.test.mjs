import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesUrl = new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url);
const sourceUrl = new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url);

test("schedule grids keep the employee column compact and scroll inside their panel", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.match(styles, /\.tableWrap\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;[^}]*padding:\s*0 10px 12px;/su);
  assert.match(styles, /\.scheduleTable\s*\{[^}]*min-width:\s*640px;[^}]*table-layout:\s*fixed;[^}]*width:\s*min\(100%, 640px\);/su);
  assert.match(styles, /\.scheduleTable:not\(\.weekTable\)\s*\{[^}]*border:\s*3px solid #91c7a2;/su);
  assert.match(styles, /\.scheduleTable:not\(\.weekTable\) th:not\(:first-child\),[\s\S]*?\.scheduleTable:not\(\.weekTable\) td:not\(:first-child\)\s*\{[^}]*width:\s*128px;/u);
  assert.match(styles, /\.weekTable th:not\(:first-child\),[\s\S]*?\.weekTable td:not\(:first-child\)\s*\{[^}]*min-width:\s*116px;/u);
  assert.match(styles, /\.scheduleTable:not\(\.weekTable\) th:first-child,[\s\S]*?\.scheduleTable:not\(\.weekTable\) td:first-child\s*\{[^}]*min-width:\s*256px;[^}]*width:\s*256px;/u);
  assert.match(styles, /\.weekTable th:first-child,[\s\S]*?\.weekTable td:first-child\s*\{[^}]*min-width:\s*184px;[^}]*width:\s*184px;/u);
  assert.match(styles, /\.employeeName\s*\{[^}]*gap:\s*8px;[^}]*min-width:\s*0;/su);
  assert.match(styles, /\.employeeName > span:last-child\s*\{[^}]*min-width:\s*0;/su);
  assert.match(styles, /\.employeeName b\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su);
  assert.doesNotMatch(styles, /\.employeeName b\s*\{[^}]*overflow-wrap:\s*anywhere;/su);
  assert.match(styles, /\.employeeName small\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su);
  assert.match(styles, /\.scheduleTable:not\(\.weekTable\) \.employeeName b,[\s\S]*?\.scheduleTable:not\(\.weekTable\) \.employeeName small\s*\{[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;/u);
  assert.match(await readFile(sourceUrl, "utf8"), /<b title=\{employee\.name\}>\{employee\.name\}<\/b>/u);
});

test("shift cards and day-grid cells use stronger visual boundaries", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.match(styles, /\.shiftCard\s*\{[^}]*border:\s*2px solid #cbded1;[^}]*box-shadow:[^;}]+;[^}]*min-height:\s*96px;/su);
  assert.match(styles, /\.tone1\s*\{[^}]*border-color:\s*#add9ba;/su);
  assert.match(styles, /\.tone2\s*\{[^}]*border-color:\s*#f3c6a8;/su);
  assert.match(styles, /\.tone3\s*\{[^}]*border-color:\s*#cbbdf3;/su);
  assert.match(styles, /\.scheduleTable:not\(\.weekTable\) th,[\s\S]*?\.scheduleTable:not\(\.weekTable\) td\s*\{[^}]*border-bottom:\s*2px solid #c6d9cb;[^}]*border-right:\s*2px solid #c6d9cb;/u);
  assert.match(styles, /\.scheduleTable th,[\s\S]*?\.scheduleTable td\s*\{[^}]*border-bottom:\s*1px solid #e8ece9;[^}]*border-right:\s*1px solid #eef1ef;/u);
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
  assert.match(mobile, /\.scheduleTable:not\(\.weekTable\) th:first-child,[\s\S]*?\.scheduleTable:not\(\.weekTable\) td:first-child\s*\{[^}]*min-width:\s*244px;[^}]*width:\s*244px;/u);
  assert.match(mobile, /\.weekTable th:first-child,[\s\S]*?\.weekTable td:first-child\s*\{[^}]*min-width:\s*166px;[^}]*width:\s*166px;/u);
  assert.match(mobile, /\.cardActions button\s*\{[^}]*height:\s*44px;[^}]*width:\s*44px;/su);
});
