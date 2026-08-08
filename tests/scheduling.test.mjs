import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function schedulingModule() {
  const source = await readFile(new URL("../app/lib/scheduling.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("calculates regular and overnight shift durations", async () => {
  const { formatShiftDuration, isOvernightShift, shiftDurationMinutes } = await schedulingModule();
  assert.equal(shiftDurationMinutes("07:00", "15:00"), 480);
  assert.equal(shiftDurationMinutes("22:00", "07:00"), 540);
  assert.equal(shiftDurationMinutes("07:00", "07:00"), 0);
  assert.equal(shiftDurationMinutes("not-a-clock", "07:00"), 0);
  assert.equal(isOvernightShift("22:00", "07:00"), true);
  assert.equal(isOvernightShift("07:00", "15:00"), false);
  assert.equal(formatShiftDuration(540), "9 giờ");
});

test("builds a Monday-to-Sunday week around the selected date", async () => {
  const { addDays, weekDates } = await schedulingModule();
  assert.equal(addDays("2026-08-06", 1), "2026-08-07");
  assert.equal(addDays("2026-08-01", -1), "2026-07-31");
  assert.deepEqual(weekDates("2026-08-06"), [
    "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
    "2026-08-07", "2026-08-08", "2026-08-09",
  ]);
});

test("detects conflicts including an overnight shift crossing into the next day", async () => {
  const { shiftsOverlap } = await schedulingModule();
  assert.equal(shiftsOverlap("2026-08-06", "07:00", "15:00", "2026-08-06", "14:00", "22:00"), true);
  assert.equal(shiftsOverlap("2026-08-06", "07:00", "15:00", "2026-08-06", "15:00", "22:00"), false);
  assert.equal(shiftsOverlap("2026-08-06", "22:00", "07:00", "2026-08-07", "06:00", "10:00"), true);
  assert.equal(shiftsOverlap("2026-08-06", "22:00", "07:00", "2026-08-07", "07:00", "15:00"), false);
});

test("serializes Vietnam-local shifts as complete UTC ranges", async () => {
  const { shiftUtcRange } = await schedulingModule();
  assert.deepEqual(shiftUtcRange("2026-08-06", "07:00", "15:00"), {
    startAt: "2026-08-06T00:00:00.000Z",
    endAt: "2026-08-06T08:00:00.000Z",
  });
  assert.deepEqual(shiftUtcRange("2026-08-06", "22:00", "07:00"), {
    startAt: "2026-08-06T15:00:00.000Z",
    endAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(shiftUtcRange("2026-08-06", "07:00", "07:00"), null);
});

test("schedule interface exposes the requested day, week, employee and save flow", async () => {
  const source = await readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8");
  assert.match(source, />Theo ngày</u);
  assert.match(source, />Theo tuần</u);
  assert.match(source, />Theo nhân viên</u);
  assert.match(source, /Chọn ca làm việc/u);
  assert.match(source, /Chọn nhân viên/u);
  assert.match(source, /Lưu lịch ca/u);
});

test("schedule editor keeps shifts, employees, note and save on one continuous screen", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url), "utf8"),
  ]);
  const editor = source.slice(source.lastIndexOf("{open &&"));
  const shiftPosition = editor.indexOf("scheduleShiftPicker");
  const employeePosition = editor.indexOf("employeePicker");
  const notePosition = editor.indexOf("Ghi chú");
  const savePosition = editor.indexOf("Lưu lịch ca");
  assert.ok(shiftPosition >= 0 && shiftPosition < employeePosition);
  assert.ok(employeePosition < notePosition && notePosition < savePosition);
  assert.doesNotMatch(source, /setStep\(/u);
  assert.match(source, /Chọn ngày, ca, nhân viên và ghi chú trên cùng một màn hình/u);
  assert.match(css, /\.scheduleShiftPicker\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/su);
});

test("shift cards never wrap and persisted shifts and schedules show a 24-hour update timestamp", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StoreSchedulingModules.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.shiftCards\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/su);
  assert.match(css, /\.compactShiftCards/u);
  assert.match(source, /hourCycle:\s*"h23"/u);
  assert.match(source, /timeZone:\s*"Asia\/Ho_Chi_Minh"/u);
  assert.match(source, /shift\.record\.updated_at \?\? shift\.record\.created_at/u);
  assert.match(source, /entry\.record\.updated_at \?\? entry\.record\.created_at/u);
  assert.match(css, /\.scheduleTable thead th b,[\s\S]*display:\s*block;/u);
});
