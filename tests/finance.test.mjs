import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function financeModule() {
  const source = await readFile(new URL("../app/lib/finance.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("VND values are safe integers and use explicit rounding", async () => {
  const { formatVnd, isVnd, multiplyDecimalVnd, multiplyRatioVnd, requireVnd } = await financeModule();
  assert.equal(isVnd(25_000), true);
  assert.equal(isVnd(25_000.5), false);
  assert.throws(() => requireVnd(-1), /không âm/);
  assert.equal(multiplyDecimalVnd(101, "0.03"), 3);
  assert.equal(multiplyDecimalVnd(150, "0.01"), 2);
  assert.equal(multiplyDecimalVnd(150, "0.01", "DOWN"), 1);
  assert.equal(multiplyRatioVnd(20_000, 18_180, 3_600), 101_000);
  assert.equal(formatVnd(15_000), "15,000 đồng");
  assert.equal(formatVnd(12_890), "12,890 đồng");
});

test("manager profit bonus is exactly two percent of positive profit", async () => {
  const { managerProfitBonus } = await financeModule();
  assert.equal(managerProfitBonus(1_200_000_000), 24_000_000);
  assert.equal(managerProfitBonus(101), 2);
  assert.equal(managerProfitBonus(-10_000), 0);
});

test("tender reconciliation reports entered minus expected per payment method", async () => {
  const { tenderDifferences } = await financeModule();
  assert.deepEqual(tenderDifferences(
    { cash: 1_000_000, bankTransfer: 500_000 },
    { cash: 950_000, bankTransfer: 550_000 },
  ), { cash: -50_000, bankTransfer: 50_000 });
});

test("Vietnam payroll periods have exact UTC boundaries", async () => {
  const { localDate, localPeriod, periodBoundsUtc } = await financeModule();
  assert.deepEqual(periodBoundsUtc("2026-08"), {
    localStart: "2026-08-01",
    localEnd: "2026-09-01",
    startUtc: "2026-07-31T17:00:00.000Z",
    endUtc: "2026-08-31T17:00:00.000Z",
  });
  const instant = new Date("2026-07-31T18:30:00.000Z");
  assert.equal(localDate(instant), "2026-08-01");
  assert.equal(localPeriod(instant), "2026-08");
});

test("shift duration keeps actual seconds and derives exact minutes", async () => {
  const { durationMinutes, durationSeconds } = await financeModule();
  const seconds = durationSeconds("2026-08-01T00:00:00.000Z", "2026-08-01T05:03:00.000Z");
  assert.equal(seconds, 18_180);
  assert.equal(durationMinutes(seconds), 303);
  assert.equal(durationMinutes(90), 1.5);
  assert.throws(() => durationSeconds("invalid", "2026-08-01T00:00:00.000Z"), /không hợp lệ/);
});

test("D1 persists integer seconds while minutes and hours stay derived", async () => {
  const [schema, runtime, migration, shiftApi] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_finance_duration.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [schema, runtime, migration, shiftApi]) assert.match(source, /duration_seconds/u);
  assert.doesNotMatch(migration, /duration_minutes/u);
  assert.match(shiftApi, /durationMinutes\(workedSeconds\)/u);
});
