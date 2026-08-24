import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("store overview header is centered and the light sidebar name stays on one line", () => {
  assert.match(styles, /\.app-shell\.light \.sidebar-brand strong\{[^}]*white-space:nowrap/u);
  assert.match(styles, /\.shop-sign\{[^}]*grid-template-columns:44px minmax\(0,1fr\) 44px/u);
  assert.match(styles, /\.shop-sign span\{[^}]*font-weight:900;[^}]*text-align:center;[^}]*white-space:nowrap/u);
  assert.match(styles, /\.store-card \.store-card-title\{[^}]*color:#1769d7;[^}]*font-size:19px;[^}]*font-weight:900/u);
  assert.match(styles, /\.store-header-overview\{[^}]*grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/u);
  assert.match(styles, /\.store-header-overview \.store-workspace-title\{[^}]*justify-self:center;[^}]*text-align:center/u);
});

test("common mobile widths use compact two-up metric cards without horizontal overflow", () => {
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.main-area\{overflow-x:clip\}/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.stats-grid\.three,\.stats-grid\.four,\.ref-metrics\.four,\.ref-metrics\.five,\.ref-metrics\.six\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.stat-icon,\.ref-metric>i\{width:38px;height:38px/u);
  assert.match(styles, /@media\(max-width:350px\)[\s\S]*\.ref-metrics\.six\{grid-template-columns:minmax\(0,1fr\)/u);
  assert.match(styles, /\.mobile-header>button,\.manager-notification-button\{width:44px;height:44px/u);
});
