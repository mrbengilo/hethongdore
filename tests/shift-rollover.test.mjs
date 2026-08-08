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

test("rolls over only after the scheduled end plus the 60-minute grace period", async () => {
  const { shouldRollOverShift } = await schedulingModule();
  const scheduledEndAt = "2026-08-06T05:00:00.000Z";
  assert.equal(shouldRollOverShift(scheduledEndAt, "2026-08-06T05:59:59.999Z"), false);
  assert.equal(shouldRollOverShift(scheduledEndAt, "2026-08-06T06:00:00.000Z"), false);
  assert.equal(shouldRollOverShift(scheduledEndAt, "2026-08-06T06:00:00.001Z"), true);
  assert.equal(shouldRollOverShift("not-a-date", "2026-08-06T06:00:00.000Z"), false);
});

test("selects the next configured shift occurrence in Vietnam time", async () => {
  const { DEFAULT_SHIFT_DEFINITIONS, nextShiftOccurrence } = await schedulingModule();
  assert.deepEqual(nextShiftOccurrence("2026-08-06T05:00:00.000Z", DEFAULT_SHIFT_DEFINITIONS), {
    name: "Ca 2",
    start: "12:00",
    end: "17:00",
    workDate: "2026-08-06",
    startAt: "2026-08-06T05:00:00.000Z",
    endAt: "2026-08-06T10:00:00.000Z",
  });
});

test("cycles to the next day while keeping the configured schedule occurrence", async () => {
  const { DEFAULT_SHIFT_DEFINITIONS, nextShiftOccurrence } = await schedulingModule();
  assert.deepEqual(nextShiftOccurrence("2026-08-06T16:00:00.000Z", DEFAULT_SHIFT_DEFINITIONS), {
    name: "Ca 1",
    start: "07:00",
    end: "12:00",
    workDate: "2026-08-07",
    startAt: "2026-08-07T00:00:00.000Z",
    endAt: "2026-08-07T05:00:00.000Z",
  });
});

test("the shift API asks first, then performs one idempotent confirmed rollover", async () => {
  const source = await readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8");

  assert.match(source, /const reconciled = await reconcileActiveShift\(db, user\)/u);
  assert.match(source, /confirmRollover = false/u);
  assert.match(source, /if \(!confirmRollover\) \{/u);
  assert.match(source, /rolloverPending: Boolean\(pending\)/u);
  assert.match(source, /action\?: "start" \| "end" \| "rollover"/u);
  assert.match(source, /reconcileActiveShift\(db, user, utcTimestamp\(\), true, Boolean\(body\.tiktok\)\)/u);
  assert.match(source, /scheduled_start_at, scheduled_end_at/u);
  assert.match(source, /close_reason = 'CONTINUE_NEXT_SHIFT'/u);
  assert.match(source, /close_status = 'PENDING'/u);
  assert.match(source, /status = 'COMPLETED'/u);
  assert.match(source, /durationSeconds\(active\.startedAt, scheduledEndAt\)/u);
  assert.match(source, /active\.appliedHourlyRate, scheduledEndAt/u);
  assert.match(source, /UPDATE orders SET shift_code = \?.*created_at >= \?/u);
  assert.match(source, /created_at < \?/u);
  assert.match(source, /CA-TIEP-\$\{active\.id\}/u);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM shift_sessions WHERE previous_session_id = \?\)/u);
  assert.match(source, /EXISTS \(SELECT 1 FROM shift_sessions WHERE id = \? AND status = 'ACTIVE'\)/u);
  assert.match(source, /SHIFT_CONFIRMED_ROLLOVER/u);
  assert.match(source, /rolledOver/u);
  assert.match(source, /tiktok = \?, tiktok_allowance = \?, tasks_completed = 1/u);
  assert.match(source, /Boolean\(body\.tiktok\)/u);
  assert.match(source, /configured\.length > 0 \? configured : DEFAULT_SHIFT_DEFINITIONS/u);
  assert.match(source, /const definitions = await loadShiftDefinitions\(db, storeId\)/u);
  assert.match(source, /shiftOccurrenceAt\(now, definitions\)/u);

  // Preserve the existing manual-close aggregation contract.
  assert.match(source, /UPDATE stores SET revenue = revenue \+ \?, expense = expense \+ \? WHERE id = \?/u);
});

test("configured store shifts replace defaults in both API and scheduling UI", async () => {
  const ui = await readFile(new URL("../app/components/StoreSchedulingModules.tsx", import.meta.url), "utf8");
  assert.match(ui, /persisted\.length > 0 \? persisted : defaultShifts/u);
  assert.doesNotMatch(ui, /return \[\.\.\.defaults, \.\.\.persisted/u);
});

test("employee rollover prompt offers Không/Có and remembers Không only for the current UI session", async () => {
  const source = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  const decline = source.slice(source.indexOf("function declineRollover"), source.indexOf("async function confirmRollover"));

  assert.match(source, /Bạn làm ca tiếp theo phải không\?/u);
  assert.match(source, />Không<\/button>/u);
  assert.match(source, /\{rolloverSubmitting \? "ĐANG CHUYỂN\.\.\." : "Có"\}/u);
  assert.match(source, /action: "rollover", expectedShiftCode: rolloverPrompt\.shiftCode, tiktok/u);
  assert.match(source, /dismissedRolloverShift !== nextShiftCode/u);
  assert.match(decline, /setDismissedRolloverShift\(rolloverPrompt\.shiftCode\)/u);
  assert.doesNotMatch(decline, /fetch\(/u, "Không must only close the prompt and keep the current shift active");
  assert.doesNotMatch(source.slice(source.indexOf("function EmployeePortal"), source.indexOf("function EmployeeView")), /localStorage/u);
});

test("manual early close requires explicit confirmation using the persisted schedule end", async () => {
  const [api, ui] = await Promise.all([
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReferenceEmployeeHome.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(api, /scheduled_end_at AS scheduledEndAt/u);
  assert.match(api, /earlyEndConfirmed\?: boolean/u);
  assert.match(api, /earlyEnd && body\.earlyEndConfirmed !== true/u);
  assert.match(api, /requiresEarlyEndConfirmation: true/u);
  assert.match(api, /MANUAL_EARLY/u);
  assert.match(ui, /fetch\("\/api\/shift", \{ cache: "no-store" \}\)/u);
  assert.match(ui, /window\.confirm\("Chưa hết giờ kết ca, bạn có muốn kết ca không\?"\)/u);
  assert.match(ui, /earlyEndConfirmed: earlyEnd/u);
});

test("server blocks re-entry into a completed occurrence and only opens a configured current shift", async () => {
  const api = await readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8");
  assert.match(api, /const matched = candidates\.find\(\(item\) => nowTime >= new Date\(item\.startAt\)\.getTime\(\) && nowTime < new Date\(item\.endAt\)\.getTime\(\)\)/u);
  assert.doesNotMatch(api, /candidates\.find\([^\n]+\) \?\? candidates\[0\]/u);
  assert.doesNotMatch(api, /definitions\.find\([^\n]+\) \?\? definitions\[0\]/u);
  assert.match(api, /closed\.employee_id = \? AND closed\.work_date = \?[\s\S]*closed\.scheduled_start = \? AND closed\.scheduled_end = \?[\s\S]*closed\.status = 'COMPLETED'/u);
  assert.match(api, /early_closed\.close_reason = 'MANUAL_EARLY'[\s\S]*early_closed\.scheduled_end_at > \?/u);
  assert.match(api, /Bạn đã kết ca này và không thể điểm danh lại/u);
  assert.match(api, /Chưa đến thời gian bắt đầu ca làm việc/u);
});

test("ending a support shift completes only that transfer and restores the home-store session context", async () => {
  const [api, auth, portal] = await Promise.all([
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(api, /transfer_id AS transferId/u);
  assert.match(api, /UPDATE employee_transfers SET[\s\S]*status = 'COMPLETED'[\s\S]*closed\.transfer_id = employee_transfers\.id/u);
  assert.match(api, /TRANSFER_COMPLETE_AFTER_SHIFT/u);
  assert.match(api, /returnedToHomeStore/u);
  assert.match(api, /storeId: returnedToHomeStore \? user\.homeStoreId : user\.storeId/u);
  assert.match(api, /transfer\.status IN \('SCHEDULED', 'ACTIVE'\)/u);
  assert.match(auth, /status IN \('SCHEDULED', 'ACTIVE'\)/u);
  assert.match(portal, /activeTransferId: data\.returnedToHomeStore \? null : user\.activeTransferId/u);
  assert.match(portal, /storeContextChanged/u);
});

test("support rollover revalidates the exact transfer and keeps the predecessor when access changes", async () => {
  const [api, portal] = await Promise.all([
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
  ]);
  const batch = api.slice(api.indexOf("const results = await db.batch(["), api.indexOf("const successor = await findSuccessor", api.indexOf("const results = await db.batch([")));

  assert.match(api, /approved_transfer\.employee_id = \?/u);
  assert.match(api, /approved_transfer\.target_store_id = \?/u);
  assert.match(api, /approved_transfer\.status IN \('SCHEDULED', 'ACTIVE'\)/u);
  assert.match(api, /approved_transfer\.start_date <= \? AND approved_transfer\.end_date >= \?/u);
  assert.match(api, /json_each\(approved_transfer\.shifts_json\)/u);
  assert.match(api, /IN \('Cả ngày', \?\)/u);
  assert.match(api, /hasRolloverAccess\(db, active, next\)/u);
  assert.match(api, /hasAtomicRolloverAccess\(db, active, next\)/u);
  assert.match(api, /reconciled\?\.rolloverBlocked/u);

  const insert = batch.indexOf("INSERT INTO shift_sessions");
  const close = batch.indexOf("UPDATE shift_sessions SET");
  assert.ok(insert >= 0 && close > insert, "the guarded successor must exist before the predecessor can close");
  assert.match(batch, /predecessor\.id = \? AND predecessor\.status = 'ACTIVE'[\s\S]*NOT EXISTS \(SELECT 1 FROM shift_sessions WHERE previous_session_id = \?\)[\s\S]*rolloverAccessSql/u);
  assert.match(batch, /UPDATE shift_sessions SET[\s\S]*EXISTS \(SELECT 1 FROM shift_sessions successor WHERE successor\.previous_session_id = \? AND successor\.status = 'ACTIVE'\)[\s\S]*rolloverAccessSql/u);
  assert.match(api, /const successorCreated = affectedRows\(results\[0\]\) > 0/u);
  assert.match(api, /const closedByThisRequest = affectedRows\(results\[2\]\) > 0/u);
  assert.match(api, /SUPPORT_ROLLOVER_BLOCKED_MESSAGE/u);
  assert.match(portal, /data\.rolloverBlocked/u);
  assert.match(portal, /blockedRolloverNoticeShift/u);
});

test("employee close-out money inputs group thousands while preserving integer payloads", async () => {
  const ui = await readFile(new URL("../app/components/ReferenceEmployeeHome.tsx", import.meta.url), "utf8");
  assert.match(ui, /const formatMoneyInput/u);
  assert.match(ui, /const parseMoneyInput/u);
  assert.match(ui, /inputMode="numeric"/u);
  assert.match(ui, /expenseAmount: enteredExpense/u);
  assert.match(ui, /cashRevenue: enteredCash/u);
  assert.match(ui, /transferRevenue: enteredTransfer/u);
});
