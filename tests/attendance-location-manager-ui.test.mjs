import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("precise manager attendance location is never cached", async () => {
  const route = await source("app/api/shifts/route.ts");
  assert.match(route, /"Cache-Control": "private, no-store"/u);
  assert.match(route, /Vary: "Cookie"/u);
});

test("manager attendance accepts current camel fields and legacy snake fields", async () => {
  const component = await source("app/components/ReferenceStoreModules.tsx");
  for (const field of [
    "clockInLatitude", "clockInLongitude", "clockInAccuracyMeters", "clockInLocationCapturedAt",
    "clock_in_latitude", "clock_in_longitude", "clock_in_accuracy_meters", "clock_in_location_captured_at",
  ]) assert.match(component, new RegExp(`\\b${field}\\b`, "u"));
  assert.match(component, /latitude < -90 \|\| latitude > 90 \|\| longitude < -180 \|\| longitude > 180/u);
  assert.match(component, /rawAccuracy !== null && rawAccuracy >= 0/u);
});

test("manager attendance renders a safe map link and an explicit legacy fallback", async () => {
  const component = await source("app/components/ReferenceStoreModules.tsx");
  assert.match(component, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/u);
  assert.match(component, /target="_blank"/u);
  assert.match(component, /rel="noopener noreferrer"/u);
  assert.match(component, /aria-label=\{`Mở vị trí điểm danh của \$\{employeeName\} trên Google Maps`\}/u);
  assert.match(component, /Không có dữ liệu vị trí/u);
  assert.match(component, /Độ chính xác ±\$\{Math\.round\(location\.accuracyMeters\)\} m/u);
  assert.match(component, /Lấy lúc \{locationTimeLabel\(location\.capturedAt\)\}/u);
  assert.doesNotMatch(component, /window\.open\(/u);
});

test("attendance location is visible by shift, grouped for summaries and included in CSV", async () => {
  const component = await source("app/components/ReferenceStoreModules.tsx");
  assert.match(component, /locations: AttendanceLocation\[\]/u);
  assert.match(component, /if \(location\) current\.locations\.push\(location\)/u);
  assert.match(component, /<th>Vị trí điểm danh<\/th>/u);
  assert.match(component, /<AttendanceLocationView locations=\{row\.locations\} employeeName=\{row\.employeeName\}/u);
  assert.match(component, /<summary>\{locations\.length\} vị trí điểm danh<\/summary>/u);
  assert.match(component, /locationExportLabel\(row\.locations\)/u);
});

test("attendance switches from an accessible desktop scroller to touch-friendly mobile cards", async () => {
  const [component, css] = await Promise.all([
    source("app/components/ReferenceStoreModules.tsx"),
    source("app/globals.css"),
  ]);
  assert.match(css, /\.attendance-page\{min-width:0;max-width:100%\}/u);
  assert.match(css, /\.attendance-page \.table-card\{[^}]*overflow:hidden/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.attendance-page\{width:100%;overflow-x:clip\}[\s\S]*\.attendance-desktop-table\{display:none\}[\s\S]*\.attendance-mobile-list\{display:grid/u);
  assert.match(css, /\.attendance-history-filters\{display:grid;grid-template-columns:/u);
  assert.match(css, /\.attendance-mode-tabs button\{[^}]*min-height:40px/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.attendance-mode-tabs button\{[^}]*min-height:48px/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.attendance-table-head>\.attendance-history-filters\{display:grid;grid-template-columns:minmax\(0,1fr\);width:100%/u);
  assert.match(css, /\.attendance-location-item>a\{[^}]*min-height:34px/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.attendance-location-item>a\{min-height:44px/u);
  assert.match(component, /className="data-table-wrap attendance-desktop-table" role="region" tabIndex=\{0\}/u);
  assert.match(component, /className="ref-tabs compact attendance-mode-tabs" role="group" aria-label="Cách tổng hợp lịch sử chấm công"/u);
  assert.match(component, /aria-pressed=\{mode === "shift"\}/u);
  assert.match(component, /<ol className="attendance-mobile-list" aria-label="Danh sách chấm công">/u);
  assert.match(component, /<li className="attendance-mobile-card"/u);
});
