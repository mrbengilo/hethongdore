import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

async function schedulingModule() {
  const text = await source("../app/lib/scheduling.ts");
  const output = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("attendance occurrence opens exactly 120 minutes early", async () => {
  const { attendanceOccurrenceAt } = await schedulingModule();
  const shifts = [{ name: "Ca 1", start: "08:00", end: "12:00" }];
  assert.equal(attendanceOccurrenceAt("2026-08-05T23:00:00.000Z", shifts)?.name, "Ca 1");
  assert.equal(attendanceOccurrenceAt("2026-08-05T22:59:59.999Z", shifts), null);
});

test("ACTIVE attendance never auto-rolls and rollover POST is disabled", async () => {
  const [api, portal] = await Promise.all([
    source("../app/api/shift/route.ts"),
    source("../app/components/Portal.tsx"),
  ]);
  assert.match(api, /An ACTIVE attendance session is never split[\s\S]*return rolloverState\(hydratedActive, false\)/u);
  assert.match(api, /if \(body\.action === "rollover"\)[\s\S]*rolloverDisabled: true,[\s\S]*\}, 410\)/u);
  assert.doesNotMatch(portal, /Bạn làm ca tiếp theo phải không|confirmRollover|rolloverPrompt/u);
  assert.doesNotMatch(portal, /action: "rollover"/u);
});

test("attendance uses request arrival time and persists signed classification", async () => {
  const api = await source("../app/api/shift/route.ts");
  const post = api.slice(api.indexOf("export async function POST"));
  assert.ok(post.indexOf("const requestReceivedAt = utcTimestamp()") < post.indexOf("await getSessionUser(request)"));
  assert.match(post, /resolveScheduleCandidates\(db, user\.storeId, user\.employeeId, new Date\(requestReceivedAt\), policy\)/u);
  assert.match(post, /const startedAt = requestReceivedAt/u);
  assert.match(post, /const attendanceStatus = schedule\.attendanceStatus/u);
  assert.match(post, /const attendanceDelta = schedule\.attendanceDeltaMinutes/u);
  assert.match(post, /started_at, attendance_status, attendance_delta_minutes/u);
  assert.match(post, /attendanceStatus,[\s\S]*attendanceDeltaMinutes: attendanceDelta,[\s\S]*earlyMinutes:/u);
});

test("start preview and confirmation expose current/next choices and bind the selected candidate", async () => {
  const [api, ui] = await Promise.all([
    source("../app/api/shift/route.ts"),
    source("../app/components/ReferenceEmployeeHome.tsx"),
  ]);
  assert.match(api, /searchParams\.get\("preview"\) === "start"/u);
  assert.match(api, /startMode: mode,[\s\S]*startCandidates,[\s\S]*startPreview: startCandidates\[0\]/u);
  assert.match(api, /body\.expectedStart\?\.candidateId === candidate\.candidateId[\s\S]*body\.expectedStart\.selectionKind === candidate\.selectionKind/u);
  assert.match(api, /body\.expectedStart\?\.shiftName !== schedule\.name[\s\S]*body\.expectedStart\.workDate !== schedule\.workDate/u);
  assert.match(ui, /fetch\("\/api\/shift\?preview=start", \{ cache: "no-store" \}\)/u);
  assert.match(ui, /startConfirmation\.mode === "CURRENT_OR_NEXT"[\s\S]*Bạn điểm danh làm/u);
  assert.match(ui, /Bạn vào làm sớm hơn thời gian bắt đầu/u);
  assert.match(ui, /async function confirmStartShift\(selected: StartShiftPreview\)[\s\S]*await onShift\("start", \{ expectedStart: selected, clockInLocation \}\)/u);
  const decline = ui.slice(ui.indexOf("function declineStartShift"), ui.indexOf("async function confirmStartShift"));
  assert.doesNotMatch(decline, /fetch\(|onShift\(/u);
});

test("manual early close uses fresh server time and retries only after confirmation", async () => {
  const [api, ui, portal] = await Promise.all([
    source("../app/api/shift/route.ts"),
    source("../app/components/ReferenceEmployeeHome.tsx"),
    source("../app/components/Portal.tsx"),
  ]);
  assert.match(api, /earlyEnd && body\.earlyEndConfirmed !== true/u);
  assert.match(api, /requiresEarlyEndConfirmation: true/u);
  assert.match(ui, /latestShiftTiming\(\)[\s\S]*scheduledEndAt[\s\S]*serverNow/u);
  assert.match(ui, /serverTimeIsBeforeShiftEnd\(timing\.serverNow, timing\.scheduledEndAt\)/u);
  assert.match(ui, /id="shift-early-end-confirm-title">Chưa hết giờ kết ca, bạn có muốn kết ca không\?/u);
  assert.match(ui, /submitShiftEnd\(pendingEarlyEnd, true\)/u);
  assert.match(portal, /requiresEarlyEndConfirmation: data\.requiresEarlyEndConfirmation === true/u);
});

test("a completed occurrence is skipped while the next occurrence may open early", async () => {
  const api = await source("../app/api/shift/route.ts");
  assert.match(api, /completedOccurrences = new Set/u);
  assert.match(api, /availableCandidates = candidates\.filter/u);
  assert.match(api, /const assignedChoices = classifyScheduleCandidates\(now, availableCandidates, policy\)/u);
  assert.match(api, /untilStart > 0 && untilStart <= policy\.earlyClockInWindowMinutes \* 60_000/u);
  assert.match(api, /completed\.results\.map\(\(row\) =>[\s\S]*row\.workDate[\s\S]*row\.scheduledStart[\s\S]*row\.scheduledEnd/u);
  assert.doesNotMatch(api, /early_closed\.close_reason = 'MANUAL_EARLY'/u);
});

test("support activation honors shifts_json for the current or early-open occurrence", async () => {
  const auth = await source("../app/api/_lib/auth.ts");
  assert.match(auth, /currentTransferShift\(db, transfer\.targetStoreId, row\.employeeId, now\)/u);
  assert.match(auth, /untilStart >= 0 && untilStart <= ATTENDANCE_EARLY_WINDOW_MINUTES \* 60_000/u);
  assert.match(auth, /transferShiftAllows\(transfer\.shiftsJson, currentShift\.name, currentShift\.start\)/u);
  assert.match(auth, /JOIN stores target ON target\.id = t\.target_store_id AND target\.status = 'ACTIVE'/u);
});

test("ending a support shift completes only its transfer and returns home", async () => {
  const [api, portal] = await Promise.all([
    source("../app/api/shift/route.ts"),
    source("../app/components/Portal.tsx"),
  ]);
  assert.match(api, /UPDATE employee_transfers SET[\s\S]*status = 'COMPLETED'[\s\S]*closed\.transfer_id = employee_transfers\.id/u);
  assert.match(api, /TRANSFER_COMPLETE_AFTER_SHIFT/u);
  assert.match(api, /returnedToHomeStore/u);
  assert.match(portal, /activeTransferId: data\.returnedToHomeStore \? null : user\.activeTransferId/u);
});

test("employee close-out inputs stay controlled until explicit END succeeds", async () => {
  const [home, portal] = await Promise.all([
    source("../app/components/ReferenceEmployeeHome.tsx"),
    source("../app/components/Portal.tsx"),
  ]);
  assert.match(home, /value=\{expenseAmount\}[\s\S]*onClosingDraftChange/u);
  assert.match(home, /value=\{cashRevenue\}[\s\S]*onClosingDraftChange/u);
  assert.match(home, /value=\{transferRevenue\}[\s\S]*onClosingDraftChange/u);
  assert.match(portal, /const \[closingDraft, setClosingDraft\] = useState<EmployeeClosingDraft>/u);
  const actionStart = portal.indexOf("async function shiftAction");
  const action = portal.slice(actionStart, portal.indexOf("if (!navigationReady)", actionStart));
  const failure = action.slice(action.indexOf("if (!response.ok)"), action.indexOf("const next ="));
  assert.doesNotMatch(failure, /setClosingDraft/u);
  assert.match(action, /if \(action === "end"\)[\s\S]*setClosingDraft\(EMPTY_EMPLOYEE_CLOSING_DRAFT\)/u);
});
