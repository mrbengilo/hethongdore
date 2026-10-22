import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

async function storeCashflowModule() {
  const schedulingInput = await source("app/lib/scheduling.ts");
  const schedulingOutput = ts.transpileModule(schedulingInput, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const schedulingUrl = `data:text/javascript;base64,${Buffer.from(schedulingOutput).toString("base64")}`;
  const input = await source("app/lib/store-cashflow.ts");
  const output = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('from "./scheduling";', `from "${schedulingUrl}";`);
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("store completed-shift ranges use local calendar days for day, Monday week and month", async () => {
  const { completedShiftDateRange } = await storeCashflowModule();
  assert.deepEqual(completedShiftDateRange("day", "2026-08-09"), { from: "2026-08-09", to: "2026-08-09" });
  assert.deepEqual(completedShiftDateRange("week", "2026-08-09"), { from: "2026-08-03", to: "2026-08-09" });
  assert.deepEqual(completedShiftDateRange("week", "2026-08-03"), { from: "2026-08-03", to: "2026-08-09" });
  assert.deepEqual(completedShiftDateRange("month", "2028-02"), { from: "2028-02-01", to: "2028-02-29" });
  assert.throws(() => completedShiftDateRange("day", "2026-02-30"), /không hợp lệ/u);
});

test("completed shift expense is summed exactly once per persisted shift row", async () => {
  const { summarizeCompletedShiftMoney } = await storeCashflowModule();
  assert.deepEqual(summarizeCompletedShiftMoney([
    { cashRevenue: 1_000_000, transferRevenue: 500_000, expenseAmount: 108_000 },
    { cashRevenue: 250_000, transferRevenue: 750_000, expenseAmount: 216_000 },
  ]), {
    cashRevenue: 1_250_000,
    transferRevenue: 1_250_000,
    revenue: 2_500_000,
    expenseAmount: 324_000,
    net: 2_176_000,
  });
});

test("revenue breakdowns group persisted shifts by day, month, employee and scheduled shift", async () => {
  const { buildRevenueBreakdowns } = await storeCashflowModule();
  const rows = [
    { workDate: "2026-08-09", employeeId: "e1", employeeCode: "NV01", employeeName: "An", shiftName: "Ca 1", scheduledStart: "08:00", scheduledEnd: "12:00", cashRevenue: 100_000, transferRevenue: 25_000, expenseAmount: 0 },
    { workDate: "2026-08-10", employeeId: "e1", employeeCode: "NV01", employeeName: "An", shiftName: "Ca 2", scheduledStart: "12:00", scheduledEnd: "17:00", cashRevenue: 50_000, transferRevenue: 0, expenseAmount: 0 },
    { workDate: "2026-08-10", employeeId: "e2", employeeCode: "NV02", employeeName: "Bình", shiftName: "Ca 1", scheduledStart: "08:00", scheduledEnd: "12:00", cashRevenue: 0, transferRevenue: 75_000, expenseAmount: 0 },
  ];
  const yearRows = [...rows, { ...rows[0], workDate: "2026-07-31", cashRevenue: 20_000, transferRevenue: 0 }];
  const result = buildRevenueBreakdowns(rows, yearRows);
  assert.deepEqual(result.daily.map(({ date, revenue, completedShiftCount }) => ({ date, revenue, completedShiftCount })), [
    { date: "2026-08-09", revenue: 125_000, completedShiftCount: 1 },
    { date: "2026-08-10", revenue: 125_000, completedShiftCount: 2 },
  ]);
  assert.deepEqual(result.monthly.map(({ period, revenue }) => ({ period, revenue })), [
    { period: "2026-07", revenue: 20_000 },
    { period: "2026-08", revenue: 250_000 },
  ]);
  assert.deepEqual(result.employees.map(({ employeeId, revenue }) => ({ employeeId, revenue })), [
    { employeeId: "e1", revenue: 175_000 },
    { employeeId: "e2", revenue: 75_000 },
  ]);
  assert.deepEqual(result.shifts.map(({ shiftName, revenue }) => ({ shiftName, revenue })), [
    { shiftName: "Ca 1", revenue: 200_000 },
    { shiftName: "Ca 2", revenue: 50_000 },
  ]);
});

test("monthly attendance applies the inclusive 15-minute grace boundary and keeps legacy unknown rows explicit", async () => {
  const { buildMonthlyAttendanceStats, resolveAttendanceObservation } = await storeCashflowModule();
  const scheduled = "2026-08-10T01:00:00.000Z";
  assert.deepEqual(resolveAttendanceObservation({ employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: scheduled, startedAt: "2026-08-10T00:58:00.000Z" }), { status: "EARLY", deltaMinutes: -2 });
  assert.deepEqual(resolveAttendanceObservation({ employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: scheduled, startedAt: "2026-08-10T01:15:00.000Z" }), { status: "ON_TIME", deltaMinutes: 15 });
  assert.deepEqual(resolveAttendanceObservation({ employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: scheduled, startedAt: "2026-08-10T01:15:00.001Z" }), { status: "LATE", deltaMinutes: 16 });
  assert.deepEqual(resolveAttendanceObservation({ employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: null, startedAt: "2026-08-10T01:00:00.000Z" }), { status: "UNKNOWN", deltaMinutes: 0 });
  // Persisted snapshots remain authoritative even if later shift setup changes.
  assert.deepEqual(resolveAttendanceObservation({ employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: scheduled, startedAt: scheduled, attendanceStatus: "LATE", attendanceDeltaMinutes: 9 }), { status: "LATE", deltaMinutes: 9 });

  const stats = buildMonthlyAttendanceStats([
    { employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: scheduled, startedAt: "2026-08-10T00:58:00.000Z" },
    { employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: "2026-08-11T01:00:00.000Z", startedAt: "2026-08-11T01:15:00.000Z" },
    { employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: "2026-08-12T01:00:00.000Z", startedAt: "2026-08-12T01:15:00.001Z" },
    { employeeId: "e1", employeeCode: "NV01", employeeName: "An", scheduledStartAt: null, startedAt: "2026-08-13T01:00:00.000Z" },
  ]);
  assert.deepEqual(stats[0], { employeeId: "e1", employeeCode: "NV01", employeeName: "An", early: 1, onTime: 1, late: 1, unknown: 1, total: 4, averageDeltaMinutes: 9.7 });
});

test("store cash-flow API reads real completed shifts with Vietnam-local attribution", async () => {
  const route = await source("app/api/store-cashflow/route.ts");
  assert.match(route, /getSessionUser\(request\)[\s\S]*user\.role !== "MANAGER"/u);
  assert.match(route, /FROM shift_sessions s[\s\S]*LEFT JOIN employees e/u);
  assert.match(route, /s\.status = 'COMPLETED'[\s\S]*s\.ended_at IS NOT NULL/u);
  assert.match(route, /NULLIF\(s\.work_date, ''\)[\s\S]*s\.started_at >= \?/u);
  assert.match(route, /dateRangeBoundsUtc\(range\)/u);
  assert.match(route, /shiftAccountingDate\(row\.workDate, row\.startedAt\)/u);
  assert.match(route, /summarizeCompletedShiftMoney\(shifts\)/u);
  assert.match(route, /storeDateRangeFinance\(db, storeId, range\)/u);
  assert.match(route, /accountingTotals: accounting/u);
  assert.match(route, /timeZone: "Asia\/Ho_Chi_Minh"/u);
  assert.match(route, /buildRevenueBreakdowns\(shifts, yearShifts\)/u);
  assert.match(route, /buildMonthlyAttendanceStats\(attendanceResult\.results\)/u);
  assert.match(route, /loadAttendancePolicy\(db\)/u);
  assert.match(route, /attendancePolicyPayload\(currentPolicy\)/u);
  assert.match(route, /s\.attendance_status AS attendanceStatus/u);
  assert.match(route, /s\.attendance_delta_minutes AS attendanceDeltaMinutes/u);
  assert.match(route, /status IN \('ACTIVE', 'COMPLETED'\)/u);
  assert.doesNotMatch(route, /business_records|stores SET|UPDATE |INSERT /u);
});

test("manager attendance fallback uses the stored grace snapshot and dynamic guidance", async () => {
  const component = await source("app/components/ReferenceStoreModules.tsx");
  assert.match(component, /attendanceDeltaMinutes\(shift\.started_at, shift\.scheduled_start_at\)/u);
  assert.match(component, /attendanceGraceMinutes\?: number \| null; attendance_grace_minutes\?: number \| null/u);
  assert.match(component, /attendanceStatusAt\(shift\.started_at, shift\.scheduled_start_at, graceMinutes\)/u);
  assert.match(component, /dùng ngưỡng đã lưu tại thời điểm nhân viên điểm danh/u);
  assert.doesNotMatch(component, /ATTENDANCE_ON_TIME_GRACE_MINUTES/u);
  assert.doesNotMatch(component, /actual === scheduled \? "ON_TIME"/u);
});

test("store cash-flow UI exposes day-week-month controls and complete close details", async () => {
  const [component, portal, css] = await Promise.all([
    source("app/components/StoreCashflow.tsx"),
    source("app/components/Portal.tsx"),
    source("app/globals.css"),
  ]);
  assert.match(component, /Theo ngày/u);
  assert.match(component, /Theo tuần/u);
  assert.match(component, /Theo tháng/u);
  assert.match(component, /aria-pressed/u);
  assert.match(component, /Doanh thu kết ca/u);
  assert.match(component, /Chi phí trong ca/u);
  assert.match(component, /Nhân viên kết ca/u);
  assert.match(component, /Giờ kết ca/u);
  assert.match(component, /formatDateTime24\(shift\.endedAt, true\)/u);
  assert.match(component, /Doanh thu theo ngày/u);
  assert.match(component, /Doanh thu theo tháng/u);
  assert.match(component, /Doanh thu theo nhân viên/u);
  assert.match(component, /Doanh thu theo ca/u);
  assert.match(component, /Điểm danh đúng giờ, sớm và trễ theo nhân viên/u);
  assert.match(component, /attendance\.policy\.lateGraceMinutes/u);
  assert.match(component, /DEFAULT_ATTENDANCE_GRACE_MINUTES/u);
  assert.doesNotMatch(component, /phút thứ 5|phút thứ 6/u);
  assert.match(component, /Tổng chi phí kế toán cùng phạm vi/u);
  assert.match(component, /useState<FilterState>\(\(\) => defaultFilter\(period\)\)/u);
  assert.match(component, /if \(!filterReady\) return;[\s\S]*fetch\(`\/api\/store-cashflow/u);
  assert.match(component, /const requestSequence = useRef\(0\)/u);
  assert.match(component, /const requestId = \+\+requestSequence\.current/u);
  assert.match(component, /setData\(null\);[\s\S]*fetch\(`\/api\/store-cashflow/u);
  assert.match(component, /function chooseMode[\s\S]*setData\(null\);[\s\S]*setFilter/u);
  assert.match(component, /function updateDay[\s\S]*setData\(null\);[\s\S]*setFilter/u);
  assert.match(component, /function updateMonth[\s\S]*setData\(null\);[\s\S]*setFilter/u);
  assert.match(component, /signal: controller\.signal/u);
  assert.match(component, /payload\.store\.id !== requestedScope\.storeId/u);
  assert.match(component, /payload\.filter\.mode !== requestedScope\.mode/u);
  assert.match(component, /payload\.filter\.anchor !== requestedScope\.anchor/u);
  assert.match(component, /requestId !== requestSequence\.current \|\| controller\.signal\.aborted/u);
  assert.match(component, /\.catch\([\s\S]*setData\(null\);[\s\S]*setError\(/u);
  assert.match(component, /requestId === requestSequence\.current && !controller\.signal\.aborted/u);
  assert.match(portal, /<StoreOperatingExpense[\s\S]*<StoreShiftCashflow[\s\S]*<StoreFinancialReport/u);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.store-cashflow-table tbody td::before/u);
  assert.match(css, /\.store-cashflow-period-control>input\{[^}]*width:100%/u);
});
