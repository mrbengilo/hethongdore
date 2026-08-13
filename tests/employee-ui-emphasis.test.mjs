import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("employee workspace has isolated high-contrast navigation, cards and responsive metrics", async () => {
  const [styles, attendanceStyles] = await Promise.all([
    source("../app/globals.css"),
    source("../app/components/EmployeeAttendanceSummary.module.css"),
  ]);

  assert.match(styles, /\.app-shell\.employee \.sidebar nav button\.active\{[\s\S]*?min-height:44px;[\s\S]*?border:2px solid #64c982;[\s\S]*?font-weight:900;/u);
  assert.match(styles, /\.app-shell\.employee \.page-content :is\([\s\S]*?\.employee-metric,[\s\S]*?\.employee-detail-strip,[\s\S]*?\.employee-home-reference \.attendance-card,[\s\S]*?\.employee-closing-reference[\s\S]*?\)\{[\s\S]*?border:2px solid #94d3a6;/u);
  assert.match(styles, /\.app-shell\.employee \.employee-metric span\{[\s\S]*?font-size:12px;[\s\S]*?font-weight:900;/u);
  assert.match(styles, /\.app-shell\.employee \.employee-metric strong\{[\s\S]*?font-size:clamp\(23px,1\.8vw,30px\);[\s\S]*?font-weight:900;/u);
  assert.match(styles, /@media\(max-width:720px\)\{[\s\S]*?\.app-shell\.employee \.employee-metrics\.four\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);/u);
  assert.match(attendanceStyles, /\.panel \{[\s\S]*?border: 2px solid #8fcea1;[\s\S]*?box-shadow: 0 10px 27px rgba\(8, 125, 54, \.09\);/u);
  assert.match(attendanceStyles, /\.title h2 \{[^}]*font-size: 18px;[^}]*font-weight: 900;/u);
});

test("employee late feedback stays tied to the persisted LATE status and is entirely red", async () => {
  const [home, styles] = await Promise.all([
    source("../app/components/ReferenceEmployeeHome.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(home, /shift\.attendanceStatus \? \{[\s\S]*?status: shift\.attendanceStatus/u);
  assert.match(home, /if \(shift\.attendanceStatus\) \{[\s\S]*?status: shift\.attendanceStatus/u);
  assert.match(home, /attendanceFeedback\.status === "LATE" \? "attendance-late" : "attendance-on-time"/u);
  assert.match(home, /attendanceFeedback\.status === "LATE" \? `Đi trễ/u);
  assert.match(styles, /\.app-shell\.employee \.attendance-status\.attendance-late\{[\s\S]*?border:2px solid #ee756b;[\s\S]*?background:#ffe5e2;[\s\S]*?color:#b42318;/u);
  assert.doesNotMatch(styles, /\.app-shell\.employee \.attendance-status:not\(\.attendance-late\)/u);
});
