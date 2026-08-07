import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the branded DORE login", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>DORE/iu);
  assert.match(html, /DORE/iu);
  assert.match(html, /20K/iu);
  assert.match(html, /autoComplete="username"/u);
  assert.match(html, /autoComplete="current-password"/u);
  assert.match(html, /type="checkbox"/u);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/u);
});

test("contains core role and finance rules", async () => {
  const [portal, login, orders, shift, rollover, employeeWorkspace, packageJson, runtime] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shift/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_lib/shift-rollover.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/EmployeeOperations.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /2%/u);
  assert.match(portal, />= 7000/u);
  assert.match(portal, />= 15000/u);
  assert.match(portal, />= 30000/u);
  assert.match(portal, /0\.03/u);
  assert.match(portal, /0\.05/u);
  assert.match(portal, /0\.07/u);
  assert.match(runtime, /DORE SÓC TRĂNG/u);
  assert.match(login, /attempts >= 10/u);
  assert.match(login, /15 \* 60 \* 1000/u);
  assert.match(orders, /ensureActiveShiftRollover/u);
  assert.match(orders, /shift\.shiftCode/u);
  assert.match(orders, /export async function PATCH/u);
  assert.match(orders, /store_id = \? AND employee_id = \? AND shift_code = \?/u);
  assert.match(shift, /SHIFT_GRACE_MINUTES/u);
  assert.match(rollover, /SHIFT_GRACE_MINUTES = 60/u);
  assert.match(rollover, /AUTO_COMPLETED/u);
  assert.match(rollover, /const splitAt = schedule\.scheduledEndAt/u);
  assert.match(rollover, /started_at, scheduled_start_at, scheduled_end_at, rollover_from, work_session_id/u);
  assert.match(rollover, /SHIFT_AUTO_ROLLOVER/u);
  assert.match(rollover, /TikTok=1/u);
  assert.match(employeeWorkspace, /20_000/u);
  assert.match(employeeWorkspace, /tự chốt ca hiện tại tại đúng giờ kết thúc/iu);
  assert.match(employeeWorkspace, /Lịch sử ca làm thực tế/u);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/u);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("full demo chunks reconstruct valid browser JavaScript", async () => {
  const parts = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      readFile(new URL(`../public/full-demo-assets/chunk0${index + 1}.js`, import.meta.url), "utf8"),
    ),
  );
  const encoded = parts.map((part) => {
    const match = part.match(/\+"([A-Za-z0-9+/=]+)";/u);
    assert.ok(match, "Each demo chunk must contain one Base64 payload");
    return match[1];
  }).join("");
  const source = Buffer.from(encoded, "base64").toString("utf8");
  assert.match(source, /dore_full_working_v1/u);
  assert.match(source, /GRACE=60\*60000/u);
  assert.match(source, /Tự động chuyển/u);
  assert.match(source, /window\.D=/u);
  assert.doesNotThrow(() => new Function(source));

  const loader = await readFile(new URL("../public/full-demo-assets/loader.js", import.meta.url), "utf8");
  assert.match(loader, /TextDecoder/u);
  assert.match(loader, /Không thể tải hệ thống DORE/u);
});
