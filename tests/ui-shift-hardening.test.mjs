import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { runInNewContext } from "node:vm";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function executableFunction(sourceText, name) {
  const match = sourceText.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`, "u"));
  assert.ok(match, `${name} must remain independently executable`);
  const output = ts.transpileModule(match[0].replace(/^export /u, ""), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(`(() => { ${output}; return ${name}; })()`, { Date, JSON, Number });
}

test("close-out draft stays controlled until explicit END succeeds", async () => {
  const [portal, home] = await Promise.all([
    source("../app/components/Portal.tsx"),
    source("../app/components/ReferenceEmployeeHome.tsx"),
  ]);
  assert.match(portal, /const \[closingDraft, setClosingDraft\] = useState<EmployeeClosingDraft>/u);
  assert.match(portal, /closingDraft=\{closingDraft\} onClosingDraftChange=\{setClosingDraft\}/u);
  assert.match(home, /value=\{expenseAmount\}[\s\S]*onClosingDraftChange\(\{ \.\.\.closingDraft, expenseAmount:/u);
  assert.match(home, /value=\{cashRevenue\}[\s\S]*onClosingDraftChange\(\{ \.\.\.closingDraft, cashRevenue:/u);
  assert.match(home, /value=\{transferRevenue\}[\s\S]*onClosingDraftChange\(\{ \.\.\.closingDraft, transferRevenue:/u);
  const actionStart = portal.indexOf("async function shiftAction");
  const action = portal.slice(actionStart, portal.indexOf("if (!navigationReady)", actionStart));
  const failure = action.slice(action.indexOf("if (!response.ok)"), action.indexOf("const next ="));
  assert.doesNotMatch(failure, /setClosingDraft/u, "a failed END must preserve every entered field");
  assert.match(action, /if \(action === "end"\)[\s\S]*setClosingDraft\(EMPTY_EMPLOYEE_CLOSING_DRAFT\)/u);
  assert.doesNotMatch(portal, /action: "rollover"|confirmRollover/u);
});

test("fallback shift tasks are isolated by employee, store, work date and session", async () => {
  const home = await source("../app/components/ReferenceEmployeeHome.tsx");
  const storageKey = executableFunction(home, "employeeTaskFallbackStorageKey");
  const base = storageKey("employee-a", "store-a", "2026-08-10", "shift-a");

  assert.equal(base, "dore-shift-tasks:v2:employee-a:store-a:2026-08-10:shift-a");
  assert.notEqual(storageKey("employee-b", "store-a", "2026-08-10", "shift-a"), base);
  assert.notEqual(storageKey("employee-a", "store-b", "2026-08-10", "shift-a"), base);
  assert.notEqual(storageKey("employee-a", "store-a", "2026-08-11", "shift-a"), base);
  assert.notEqual(storageKey("employee-a", "store-a", "2026-08-10", "shift-b"), base);
  assert.equal(storageKey("employee:a", null, "2026-08-10", "shift/a"), "dore-shift-tasks:v2:employee%3Aa:unassigned-store:2026-08-10:shift%2Fa");

  assert.match(home, /resolveShiftWorkDate\(shift\.shiftCode, shift\.startedAt, todayValue\)/u);
  assert.match(home, /<EmployeeTaskChecklist user=\{user\} workDate=\{taskWorkDate\} shiftKey=\{shift\.shiftCode\}/u);
  assert.match(home, /employeeTaskFallbackStorageKey\(user\.employeeId \?\? user\.id, user\.storeId, workDate, shiftKey\)/u);
  assert.match(home, /window\.localStorage\.getItem\(fallbackStorageKey\)/u);
  assert.match(home, /window\.localStorage\.setItem\(fallbackStorageKey, JSON\.stringify\(next\)\)/u);
  assert.doesNotMatch(home, /dore-shift-tasks:\$\{shiftKey\}/u);
  assert.match(home, /const done = items\.length \? items\.filter/u, "server task completion must remain authoritative when task records exist");
  assert.match(home, /\{items\.length \? items\.map/u, "server task rows must render ahead of the local fallback checklist");
});

test("early close uses fresh server time and retries only after the real confirmation dialog", async () => {
  const [portal, home] = await Promise.all([
    source("../app/components/Portal.tsx"),
    source("../app/components/ReferenceEmployeeHome.tsx"),
  ]);
  const isEarly = executableFunction(home, "serverTimeIsBeforeShiftEnd");
  assert.equal(isEarly("2026-08-09T09:59:59.999Z", "2026-08-09T10:00:00.000Z"), true);
  assert.equal(isEarly("2026-08-09T10:00:00.000Z", "2026-08-09T10:00:00.000Z"), false);
  assert.equal(isEarly("not-a-date", "2026-08-09T10:00:00.000Z"), false);

  assert.match(home, /typeof data\.scheduledEndAt === "string" && typeof data\.serverNow === "string"/u);
  assert.match(home, /serverTimeIsBeforeShiftEnd\(timing\.serverNow, timing\.scheduledEndAt\)/u);
  assert.doesNotMatch(home, /window\.confirm\(/u);
  assert.match(home, /requiresEarlyEndConfirmation[\s\S]*setPendingEarlyEnd\(payload\)/u);
  assert.match(home, /id="shift-early-end-confirm-title">Chưa hết giờ kết ca, bạn có muốn kết ca không\?/u);
  assert.match(home, /submitShiftEnd\(pendingEarlyEnd, true\)/u);
  assert.match(portal, /requiresEarlyEndConfirmation: data\.requiresEarlyEndConfirmation === true/u);
});

test("transfer session activation is limited to the configured current support shift", async () => {
  const auth = await source("../app/api/_lib/auth.ts");
  const allows = executableFunction(auth, "transferShiftAllows");

  assert.equal(allows('["Ca sáng"]', "Ca 1", "07:00"), true);
  assert.equal(allows('["Ca chiều"]', "Ca 2", "12:00"), true);
  assert.equal(allows('["Ca tối"]', "Ca 3", "17:00"), true);
  assert.equal(allows('["Ca sáng"]', "Ca 2", "12:00"), false);
  assert.equal(allows('["Ca đặc biệt"]', "Ca đặc biệt", "15:30"), true);
  assert.equal(allows('["Cả ngày"]', "Ca 3", "17:00"), true);
  assert.equal(allows("invalid", "Ca 1", "07:00"), false);

  assert.match(auth, /const currentShift = await currentTransferShift\(db, transfer\.targetStoreId, row\.employeeId, now\)/u);
  assert.match(auth, /!currentShift \|\| !transferShiftAllows\(transfer\.shiftsJson, currentShift\.name, currentShift\.start\)/u);
  assert.match(auth, /JOIN stores target ON target\.id = t\.target_store_id AND target\.status = 'ACTIVE'/u);
  assert.ok(auth.indexOf("activeTransferId = transfer.id") > auth.indexOf("transferShiftAllows"));
});
