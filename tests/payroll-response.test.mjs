import assert from "node:assert/strict";
import { test } from "node:test";
import { readFinancialResponse } from "../app/lib/financial-response.ts";

test("payroll accepts JSON success and surfaces actionable API errors", async () => {
  assert.deepEqual(await readFinancialResponse(Response.json({ closing: { status: "PAYMENT_CONFIRMED" } })), { closing: { status: "PAYMENT_CONFIRMED" } });
  await assert.rejects(readFinancialResponse(Response.json({ message: "Kỳ đã khóa.", requestId: "test-request" }, { status: 409 })), /Kỳ đã khóa.*test-request/u);
});

test("empty, HTML, truncated and invalid-shape replies never report a successful payment", async () => {
  for (const [body, status] of [["", 200], ["", 500], ["<html>Bad Gateway</html>", 502], ['{"closing":', 200], ["null", 200], ["[]", 200]]) {
    await assert.rejects(readFinancialResponse(new Response(body, { status })), /trạng thái kỳ/u);
  }
});
