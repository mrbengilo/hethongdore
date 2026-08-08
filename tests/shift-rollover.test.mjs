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
  assert.equal(shouldRollOverShift(scheduledEndAt, "2026-08-06T06:00:00.000Z"), true);
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

test("the shift API persists exact schedule bounds and performs an idempotent rollover", async () => {
  const source = await readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8");

  assert.match(source, /const reconciled = await reconcileActiveShift\(db, user\)/u);
  assert.match(source, /scheduled_start_at, scheduled_end_at/u);
  assert.match(source, /close_reason = 'AUTO_ROLLOVER'/u);
  assert.match(source, /close_status = 'PENDING'/u);
  assert.match(source, /status = 'COMPLETED'/u);
  assert.match(source, /durationSeconds\(active\.startedAt, scheduledEndAt\)/u);
  assert.match(source, /active\.appliedHourlyRate, scheduledEndAt/u);
  assert.match(source, /UPDATE orders SET shift_code = \?.*created_at >= \?/u);
  assert.match(source, /created_at < \?/u);
  assert.match(source, /CA-AUTO-\$\{active\.id\}/u);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM shift_sessions WHERE previous_session_id = \?\)/u);
  assert.match(source, /EXISTS \(SELECT 1 FROM shift_sessions WHERE id = \? AND status = 'ACTIVE'\)/u);
  assert.match(source, /SHIFT_AUTO_ROLLOVER/u);
  assert.match(source, /rolledOver/u);

  // Preserve the existing manual-close aggregation contract.
  assert.match(source, /UPDATE stores SET revenue = revenue \+ \?, expense = expense \+ \? WHERE id = \?/u);
});
