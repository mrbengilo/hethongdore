import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

async function locationModule() {
  const text = await source("../app/lib/attendance-location.ts");
  const output = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

async function serverTimeModule() {
  const text = await source("../app/lib/server-time.ts");
  const output = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("clock-in captures one fresh high-accuracy location without background tracking", async () => {
  const { captureClockInLocation } = await locationModule();
  const calls = [];
  const geolocation = {
    getCurrentPosition(success, _failure, options) {
      calls.push(options);
      success({ coords: { latitude: 10.0342, longitude: 105.7839, accuracy: 8.4 } });
    },
  };

  const location = await captureClockInLocation(geolocation, () => Date.parse("2026-08-10T03:20:00.000Z"));
  assert.deepEqual(location, {
    latitude: 10.0342,
    longitude: 105.7839,
    accuracyMeters: 8.4,
    capturedAt: "2026-08-10T03:20:00.000Z",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });

  const implementation = await source("../app/lib/attendance-location.ts");
  assert.doesNotMatch(implementation, /watchPosition|clearWatch/u);
});

test("mobile GPS retries once with a fresh network-assisted sample after timeout", async () => {
  const { captureClockInLocation } = await locationModule();
  const calls = [];
  const geolocation = {
    getCurrentPosition(success, failure, options) {
      calls.push(options);
      if (calls.length === 1) {
        failure({ code: 3 });
        return;
      }
      success({ coords: { latitude: 10.045162, longitude: 105.746857, accuracy: 36 } });
    },
  };

  const location = await captureClockInLocation(geolocation, () => Date.parse("2026-08-10T03:20:00.000Z"), true);
  assert.equal(location.accuracyMeters, 36);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
  assert.deepEqual(calls[1], { enableHighAccuracy: false, maximumAge: 0, timeout: 20_000 });
});

test("clock-in rejects an insecure page and production allows first-party geolocation", async () => {
  const { captureClockInLocation } = await locationModule();
  await assert.rejects(
    captureClockInLocation({ getCurrentPosition() {} }, Date.now, false),
    /HTTPS an toàn/u,
  );

  const caddy = await source("../ops/caddy/Caddyfile");
  assert.match(caddy, /Permissions-Policy "camera=\(\), geolocation=\(self\), microphone=\(\)"/u);
  assert.doesNotMatch(caddy, /geolocation=\(\)/u);
});

test("clock-in location failures are actionable and prevent an invalid snapshot", async () => {
  const { captureClockInLocation } = await locationModule();
  for (const [code, expected] of [
    [1, "Quyền của trang doregroup.io.vn"],
    [2, "bật GPS hoặc Wi-Fi"],
    [3, "Quá thời gian lấy vị trí"],
  ]) {
    const geolocation = { getCurrentPosition(_success, failure) { failure({ code }); } };
    await assert.rejects(captureClockInLocation(geolocation), new RegExp(expected, "u"));
  }
  await assert.rejects(captureClockInLocation(null), /không hỗ trợ định vị/u);
  await assert.rejects(captureClockInLocation({
    getCurrentPosition(success) {
      success({ coords: { latitude: 999, longitude: 105, accuracy: 1 } });
    },
  }), /không hợp lệ/u);
});

test("employee confirmation carries the captured snapshot only after CÓ", async () => {
  const ui = await source("../app/components/ReferenceEmployeeHome.tsx");
  const captureIndex = ui.indexOf("clockInLocation = await captureClockInLocation()");
  const previewIndex = ui.indexOf('fetch("/api/shift?preview=start"');
  assert.ok(captureIndex > 0 && captureIndex < previewIndex, "location permission must be requested before shift preview");
  assert.match(ui, /await onShift\("start", \{ expectedStart: selected, clockInLocation \}\)/u);
  assert.match(ui, /Đã lấy vị trí hiện tại/u);
  assert.match(ui, /Chỉ lưu khi bạn xác nhận ca làm/u);
  assert.match(ui, /aria-busy=\{previewingStart \|\| startingShift\}/u);
  assert.match(ui, /Khi điện thoại hỏi quyền Vị trí, hãy chọn Cho phép/u);

  const decline = ui.slice(ui.indexOf("function declineStartShift"), ui.indexOf("async function confirmStartShift"));
  assert.match(decline, /setStartConfirmation\(null\)/u);
  assert.doesNotMatch(decline, /fetch\(|onShift\(|captureClockInLocation/u);
});

test("capturedAt is anchored to serverNow and ignores a skewed device wall clock", async () => {
  const { serverAnchoredClockInCapturedAt } = await serverTimeModule();
  assert.equal(
    serverAnchoredClockInCapturedAt("2026-08-10T03:20:00.000Z", 1_500),
    "2026-08-10T03:19:58.500Z",
  );
  assert.equal(
    serverAnchoredClockInCapturedAt("2026-08-10T03:20:00.000Z", -250),
    "2026-08-10T03:20:00.000Z",
  );
  assert.equal(serverAnchoredClockInCapturedAt("invalid", 1), null);
  assert.equal(serverAnchoredClockInCapturedAt("2026-08-10T03:20:00.000Z", Number.POSITIVE_INFINITY), null);

  const helper = await source("../app/lib/server-time.ts");
  const ui = await source("../app/components/ReferenceEmployeeHome.tsx");
  assert.doesNotMatch(helper, /Date\.now\(\)/u);
  assert.match(ui, /serverAnchoredClockInCapturedAt\(data\.serverNow, performance\.now\(\) - locationCapturedAtMonotonic\)/u);
  assert.match(ui, /clockInLocation = \{ \.\.\.clockInLocation, capturedAt: serverCapturedAt \}/u);
});

test("GPS confirmation traps focus at both Tab boundaries and restores inert content", async () => {
  const ui = await source("../app/components/ReferenceEmployeeHome.tsx");
  assert.match(ui, /event\.shiftKey && \(active === first \|\| !dialog\.contains\(active\)\)[\s\S]*last\.focus\(\)/u);
  assert.match(ui, /!event\.shiftKey && \(active === last \|\| !dialog\.contains\(active\)\)[\s\S]*first\.focus\(\)/u);
  assert.match(ui, /target\.setAttribute\("inert", ""\)/u);
  assert.match(ui, /if \(!hadInert\) target\.removeAttribute\("inert"\)/u);
  assert.match(ui, /document\.body\.style\.overflow = "hidden"[\s\S]*document\.body\.style\.overflow = previousBodyOverflow/u);
  assert.match(ui, /ref=\{startDialogRef\}[\s\S]*tabIndex=\{-1\}/u);
});
