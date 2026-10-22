import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function inventoryModule() {
  const source = await readFile(new URL("../app/lib/inventory.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("inventory history summary includes legacy receipts with an empty items array", async () => {
  const { summarizeInventoryHistory } = await inventoryModule();
  const summary = summarizeInventoryHistory([{
    items: [], quantity: 2, weight: 50, unitPrice: 20_000, shipping: 108_000, amount: 1_108_000,
  }]);

  assert.deepEqual(summary, {
    receiptCount: 1, itemLines: 1, quantity: 2, weight: 50,
    goods: 1_000_000, shipping: 108_000, amount: 1_108_000,
  });
});

test("inventory history summary ignores malformed items and totals every saved receipt", async () => {
  const { summarizeInventoryHistory } = await inventoryModule();
  const receipts = Array.from({ length: 201 }, () => ({
    items: [null, "invalid", { quantity: 1, weight: 2, unitPrice: 5_000, shipping: 1_000, amount: 11_000 }],
  }));
  const summary = summarizeInventoryHistory(receipts);

  assert.equal(summary.receiptCount, 201);
  assert.equal(summary.itemLines, 201);
  assert.equal(summary.goods, 2_010_000);
  assert.equal(summary.shipping, 201_000);
  assert.equal(summary.amount, 2_211_000);
});
