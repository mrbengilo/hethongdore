import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { actionFetch, runExclusiveAction, subscribeActionFeedback } from "../app/lib/action-feedback.ts";
import { ActionButton } from "../app/components/ActionFeedback.tsx";

test("writes notify success only after a successful response and preserve the readable response body", async (t) => {
  const notices = [];
  const unsubscribe = subscribeActionFeedback((notice) => notices.push(notice));
  t.after(unsubscribe);
  let resolveResponse;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { resolveResponse = resolve; }));
  const saving = actionFetch("/api/payroll", { method: "POST" });
  assert.deepEqual(notices, []);
  resolveResponse(Response.json({ message: "Đã cập nhật số liệu.", amount: 20000 }));
  const response = await saving;
  assert.deepEqual(await response.json(), { message: "Đã cập nhật số liệu.", amount: 20000 });
  assert.deepEqual(notices, [{ kind: "success", message: "Đã cập nhật số liệu." }]);
});

test("HTTP conflicts, explicit failures, malformed responses and network loss never emit success", async (t) => {
  const notices = [];
  t.after(subscribeActionFeedback((notice) => notices.push(notice)));
  const cases = [Response.json({ message: "Dữ liệu đã thay đổi." }, { status: 409 }),
    Response.json({ success: false, message: "Chưa lưu." }), new Response("", { status: 200 }),
    new Response("Bad gateway", { status: 502 })];
  const mock = t.mock.method(globalThis, "fetch", async () => cases.shift());
  for (let i = 0; i < 4; i += 1) await actionFetch("/api/reports", { method: "POST" });
  mock.mock.mockImplementation(async () => { throw new TypeError("network lost"); });
  await assert.rejects(actionFetch("/api/reports", { method: "PATCH" }));
  assert.equal(notices.some((notice) => notice.kind === "success"), false);
  assert.equal(notices.length, 4);
});

test("background reads stay silent and DELETE 204 receives a visible success message", async (t) => {
  const notices = [];
  const unsubscribe = subscribeActionFeedback((notice) => notices.push(notice));
  t.after(unsubscribe);
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ rows: [] }));
  await actionFetch("/api/shift"); assert.deepEqual(notices, []);
  mock.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  await actionFetch("/api/records?id=1", { method: "DELETE" });
  assert.equal(notices[0].kind, "success");
  unsubscribe();
  await actionFetch("/api/records?id=2", { method: "DELETE" });
  assert.equal(notices.length, 1);
});

test("busy action renders a disabled accessible button while retaining its visible label", () => {
  const html = renderToStaticMarkup(createElement(ActionButton, { busy: true, type: "submit" }, "Lưu số liệu"));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /action-spinner/);
  assert.match(html, /Lưu số liệu/);
  const idle = renderToStaticMarkup(createElement(ActionButton, { type: "button", disabled: true }, "Chờ khóa kỳ"));
  assert.doesNotMatch(idle, /action-spinner/);
});




test("a pending click or form submit runs once, clears its spinner on failure and allows an explicit retry", async () => {
  const gate = { current: false }, states = [], errors = [];
  let rejectWrite, writes = 0;
  const first = runExclusiveAction(gate, () => { writes += 1; return new Promise((_, reject) => { rejectWrite = reject; }); }, (state) => states.push(state), (error) => errors.push(error));
  runExclusiveAction(gate, () => { writes += 1; }, (state) => states.push(state), (error) => errors.push(error));
  assert.equal(writes, 1); assert.deepEqual(states, [true]);
  rejectWrite(new Error("Không lưu được")); await first;
  assert.equal(gate.current, false); assert.deepEqual(states, [true, false]); assert.equal(errors.length, 1);
  await runExclusiveAction(gate, async () => { writes += 1; }, (state) => states.push(state), (error) => errors.push(error));
  assert.equal(writes, 2); assert.deepEqual(states, [true, false, true, false]);
});
