import { test, expect } from "@playwright/test";
import { businessDate, cookie, TEST_PASSWORD } from "../helpers/d1-fixture.mjs";

const headers = (role = "manager") => ({ Cookie: cookie(role) });
async function call(request, method, path, data, role = "manager") {
  return request.fetch(path, { method, headers: headers(role), data });
}
async function createSchedule(request, multiple = false) {
  const date = businessDate(test.info().line * 10 + Number(test.info().title.match(/(\d+)px/)?.[1] ?? 0));
  const suffix = crypto.randomUUID().slice(0, 8);
  const definitions = [];
  for (const [name, startTime, endTime] of [["Morning", "08:00", "12:00"], ["Afternoon", "12:00", "16:00"], ["Evening", "17:00", "20:00"], ["Late", "20:00", "23:00"]]) {
    const response = await call(request, "POST", "/api/shift-definitions", { storeId: "s1", name: `${name} ${suffix}`, startTime, endTime });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.json();
    definitions.push(body.definition ?? body);
  }
  const pairs = multiple ? [["a", 0], ["b", 1], ["a", 2], ["b", 3]] : [["a", 0], ["b", 1]];
  for (const [employeeId, index] of pairs) {
    const response = await call(request, "POST", "/api/shift-assignments", { storeId: "s1", date, employeeId, definitionId: definitions[index].id });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  const list = await (await call(request, "GET", `/api/shift-assignments?storeId=s1&date=${date}`)).json();
  return { date, definitions, assignments: list.assignments };
}
function swapBody(fixture) {
  const a = fixture.assignments.find((assignment) => assignment.employee_id === "a");
  const b = fixture.assignments.find((assignment) => assignment.employee_id === "b");
  return { storeId: "s1", date: fixture.date, assignmentAId: a.id, assignmentBId: b.id, expectedVersionA: a.version, expectedVersionB: b.version, idempotencyKey: crypto.randomUUID() };
}

test("API authentication and least-privilege scope matrix", async ({ request }) => {
  const path = `/api/shift-assignments?storeId=s1&date=${businessDate()}`;
  expect((await request.get(path)).status()).toBe(401);
  expect((await call(request, "GET", path, undefined, "employee")).status()).toBe(403);
  for (const role of ["manager", "htkd", "admin"]) {
    expect((await call(request, "GET", path, undefined, role)).status()).toBe(200);
  }
  for (const role of ["manager", "htkd", "revoked"]) {
    const response = await call(request, "GET", `/api/shift-assignments?storeId=s2&date=${businessDate()}`, undefined, role);
    expect([403, 404]).toContain(response.status());
    expect(await response.text()).not.toContain("Employee OUTSIDE");
  }
  expect([401, 403]).toContain((await call(request, "GET", path, undefined, "unknown")).status());
  const listed = await (await call(request, "GET", `/api/shift-assignments?date=${businessDate()}`, undefined, "htkd")).json();
  expect(listed.stores.map((store) => store.id)).toEqual(["s1"]);
  for (const role of ["manager", "htkd"]) {
    for (const endpoint of ["finance?storeId=s1", "employees?storeId=s1", "shifts?storeId=s1", "orders?storeId=s1", "records?category=PAYROLL_PERIOD&storeId=s1", "payroll?storeId=s1", "dividends", "stores"]) {
      expect((await call(request, "GET", `/api/${endpoint}`, undefined, role)).status(), `${role} ${endpoint}`).toBe(403);
    }
    expect((await call(request, "PATCH", "/api/records", { id: "absent", status: "LOCKED" }, role)).status()).toBe(403);
  }
});

test("real API swaps exactly two assignments, durable replay, stale and forged payload rejection", async ({ request }) => {
  const fixture = await createSchedule(request, true);
  const payload = swapBody(fixture);
  const before = structuredClone(fixture.assignments);
  const first = await call(request, "POST", "/api/shift-swaps", payload);
  expect(first.ok(), await first.text()).toBeTruthy();
  const result = await first.json();
  expect(result.assignments).toHaveLength(2);
  const replay = await call(request, "POST", "/api/shift-swaps", payload);
  expect(replay.status()).toBe(200);
  expect((await replay.json()).operationId).toBe(result.operationId);
  expect((await call(request, "POST", "/api/shift-swaps", { ...payload, reason: "different payload" })).status()).toBe(409);
  expect((await call(request, "POST", "/api/shift-swaps", { ...payload, idempotencyKey: crypto.randomUUID() })).status()).toBe(409);
  const after = (await (await call(request, "GET", `/api/shift-assignments?storeId=s1&date=${fixture.date}`)).json()).assignments;
  for (const old of before) {
    const current = after.find((row) => row.id === old.id);
    if ([payload.assignmentAId, payload.assignmentBId].includes(old.id)) {
      expect(current.employee_id).toBe(old.employee_id === "a" ? "b" : "a");
      expect(current.version).toBe(old.version + 1);
      expect(current.scheduled_start_at).toBe(old.scheduled_start_at);
    } else expect(current).toEqual(old);
  }
  expect((await call(request, "POST", "/api/shift-swaps", { ...payload, storeId: "s2", role: "MANAGER", actorId: "admin" })).status()).toBeGreaterThanOrEqual(400);
  expect((await call(request, "POST", "/api/shift-swaps", payload, "employee")).status()).toBe(403);
  for (const data of [{}, { ...payload, date: "2026-02-30" }, { ...payload, assignmentBId: undefined }, { ...payload, assignmentBId: payload.assignmentAId }]) {
    expect((await call(request, "POST", "/api/shift-swaps", data)).status()).toBeGreaterThanOrEqual(400);
  }
});

test("real API concurrent requests share one assignment: exactly one winner", async ({ request }) => {
  const fixture = await createSchedule(request);
  const payload = swapBody(fixture);
  const results = await Promise.all([
    call(request, "POST", "/api/shift-swaps", payload),
    call(request, "POST", "/api/shift-swaps", { ...payload, idempotencyKey: crypto.randomUUID() }),
  ]);
  expect(results.map((response) => response.status()).sort()).toEqual([200, 409]);
});

test("actual login directs a scoped manager into the scheduling workspace", async ({ page }) => {
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/auth/me")), page.goto("/")]);
  await page.locator('[autocomplete="username"]').fill("manager");
  await page.locator('[autocomplete="current-password"]').fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page).toHaveURL(/\/manager$/);
  await expect(page.getByRole("heading", { name: /Lịch phân ca/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cổ tức", exact: true })).toHaveCount(0);
});

async function openSwap(page, fixture, role = "manager") {
  await page.context().addCookies([{ name: "dore_session", value: `test-token-${role}`, domain: "127.0.0.1", path: "/" }]);
  await page.goto("/manager");
  await page.getByLabel("Ngày phân ca", { exact: true }).fill(fixture.date);
  await page.getByRole("group", { name: "Chế độ lịch phân ca" }).getByRole("button", { name: "Đổi ca", exact: true }).click();
  await page.locator("#swap-employee-a").selectOption("a");
  await page.locator("#swap-employee-b").selectOption("b");
}

test("browser multiple shifts require exact choices; success persists after reload and keeps other assignments", async ({ page, request }) => {
  const fixture = await createSchedule(request, true);
  const payload = swapBody(fixture);
  await openSwap(page, fixture);
  await expect(page.locator("#swap-assignment-a")).toHaveValue("");
  await expect(page.locator("#swap-assignment-b")).toHaveValue("");
  const form = page.getByRole("form", { name: "Đổi ca", exact: true });
  await expect(form.getByRole("button", { name: "Đổi ca", exact: true })).toBeDisabled();
  await page.locator("#swap-assignment-a").selectOption(payload.assignmentAId);
  await page.locator("#swap-assignment-b").selectOption(payload.assignmentBId);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/shift-swaps") && response.request().method() === "POST");
  await form.getByRole("button", { name: "Đổi ca", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("status")).toContainText(/thành công/i);
  await page.reload();
  await page.getByLabel("Ngày phân ca", { exact: true }).fill(fixture.date);
  const list = (await (await call(request, "GET", `/api/shift-assignments?storeId=s1&date=${fixture.date}`)).json()).assignments;
  for (const before of fixture.assignments) {
    const after = list.find((row) => row.id === before.id);
    if ([payload.assignmentAId, payload.assignmentBId].includes(before.id)) expect(after.employee_id).not.toBe(before.employee_id);
    else expect(after).toEqual(before);
  }
  await expect(page.getByRole("region", { name: "Bảng lịch phân ca" })).toContainText(fixture.definitions[0].name);
});

test("browser changing employee/day clears invalid choices and empty state is explicit", async ({ page, request }) => {
  const fixture = await createSchedule(request, true);
  await openSwap(page, fixture);
  await page.locator("#swap-assignment-a").selectOption(fixture.assignments.find((row) => row.employee_id === "a").id);
  await page.locator("#swap-employee-a").selectOption("c");
  await expect(page.locator("#swap-assignment-a")).toHaveValue("");
  await expect(page.getByText(/không có ca/i).first()).toBeVisible();
  await page.getByLabel("Ngày phân ca", { exact: true }).fill(businessDate(120));
  await expect(page.locator("#swap-employee-a")).toHaveValue("");
  await expect(page.locator("#swap-employee-b")).toHaveValue("");
  await expect(page.getByText(/chưa có phân công/i).first()).toBeVisible();
});

test("browser response loss after real commit retries the same operation without reversing", async ({ page, request }) => {
  const fixture = await createSchedule(request);
  await openSwap(page, fixture);
  const seen = [];
  let loseResponse = true;
  await page.route("**/api/shift-swaps", async (route) => {
    seen.push(route.request().postDataJSON());
    if (loseResponse) {
      loseResponse = false;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("form", { name: "Đổi ca", exact: true }).getByRole("button", { name: "Đổi ca", exact: true }).click();
  await expect(page.getByRole("button", { name: "Thử lại yêu cầu đổi ca" })).toBeVisible();
  await page.getByRole("button", { name: "Thử lại yêu cầu đổi ca" }).click();
  await expect(page.getByRole("status")).toContainText(/thành công/i);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toEqual(seen[0]);
  const after = (await (await call(request, "GET", `/api/shift-assignments?storeId=s1&date=${fixture.date}`)).json()).assignments;
  expect(after.every((row) => row.version === 2)).toBeTruthy();
});

test("browser stale versions show conflict and reload schedule", async ({ page, request }) => {
  const fixture = await createSchedule(request);
  await openSwap(page, fixture);
  expect((await call(request, "POST", "/api/shift-swaps", swapBody(fixture))).status()).toBe(200);
  await page.getByRole("form", { name: "Đổi ca", exact: true }).getByRole("button", { name: "Đổi ca", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/thay đổi|tải lại/i);
});

for (const width of [360, 390, 430, 768, 1440]) test(`browser ${width}px has labels, keyboard focus and reachable action without page overflow`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await createSchedule(request);
  await openSwap(page, fixture);
  const button = page.getByRole("form", { name: "Đổi ca", exact: true }).getByRole("button", { name: "Đổi ca", exact: true });
  await expect(page.locator("#swap-employee-a")).toHaveAccessibleName("Nhân viên A");
  await expect(page.locator("#swap-assignment-a")).toHaveAccessibleName("Ca cần đổi của A");
  await expect(page.locator("#swap-selected-b")).toContainText("12:00–16:00");
  const selectedLabel = await page.locator("#swap-selected-b").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(selectedLabel.scroll).toBeLessThanOrEqual(selectedLabel.width);
  await expect(button).toBeEnabled();
  await button.focus();
  await expect(button).toBeFocused();
  const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  // Capture from the document top after geometry assertions so a sticky header
  // does not appear midway through a stitched full-page screenshot.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`swap-${width}.png`), fullPage: true });
  if (width === 360) {
    await page.locator("#swap-reason").focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText(/thành công/i);
  }
});

test("browser creates a real definition and assignment through management forms", async ({ page, request }) => {
  const date = businessDate(7000);
  await page.context().addCookies([{ name: "dore_session", value: "test-token-manager", domain: "127.0.0.1", path: "/" }]);
  await page.goto("/manager");
  await page.locator("#schedule-date").fill(date);
  await page.locator("summary").filter({ hasText: "Quản lý định nghĩa ca" }).click();
  const name = `UI definition ${crypto.randomUUID().slice(0, 8)}`;
  await page.locator("#definition-name").fill(name);
  await page.locator("#definition-start").fill("08:00");
  await page.locator("#definition-end").fill("12:00");
  await page.getByRole("button", { name: "Tạo ca làm việc", exact: true }).click();
  await expect(page.locator("#schedule-definition option").filter({ hasText: name })).toHaveCount(1);
  const definitionId = await page.locator("#schedule-definition option").filter({ hasText: name }).getAttribute("value");
  await page.locator("#schedule-employee").selectOption("c");
  await page.locator("#schedule-definition").selectOption(definitionId);
  await page.getByRole("button", { name: "Thêm phân công", exact: true }).click();
  await expect(page.getByRole("region", { name: "Bảng lịch phân ca" })).toContainText(name);
  await page.reload();
  await page.locator("#schedule-date").fill(date);
  await expect(page.getByRole("region", { name: "Bảng lịch phân ca" })).toContainText(name);
  const list = await (await call(request, "GET", `/api/shift-assignments?storeId=s1&date=${date}`)).json();
  expect(list.assignments).toHaveLength(1);
  expect(list.assignments[0].employee_id).toBe("c");
});

test("browser one multiple and one single shift chooses only requested pair and double click commits once", async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  const fixture = await createSchedule(request);
  expect((await call(request, "POST", "/api/shift-assignments", { storeId: "s1", date: fixture.date, employeeId: "a", definitionId: fixture.definitions[2].id })).ok()).toBeTruthy();
  await openSwap(page, fixture);
  await expect(page.locator("#swap-assignment-a")).toHaveValue("");
  await expect(page.locator("#swap-assignment-b")).toHaveValue(fixture.assignments.find((r) => r.employee_id === "b").id);
  await expect(page.locator("#swap-selected-b")).toBeVisible();
  await expect(page.locator("#swap-selected-b")).toContainText("12:00–16:00");
  await page.locator("#swap-assignment-a").selectOption(fixture.assignments.find((r) => r.employee_id === "a").id);
  let submitted = 0;
  page.on("request", (req) => { if (req.url().endsWith("/api/shift-swaps") && req.method() === "POST") submitted += 1; });
  const button = page.getByRole("form", { name: "Đổi ca", exact: true }).getByRole("button", { name: "Đổi ca", exact: true });
  await button.evaluate((element) => { element.click(); element.click(); });
  await expect(page.getByRole("status")).toContainText(/thành công/i);
  expect(submitted).toBe(1);
  const list = await (await call(request, "GET", `/api/shift-assignments?storeId=s1&date=${fixture.date}`)).json();
  expect(list.assignments.find((r) => r.definition_id === fixture.definitions[2].id)).toMatchObject({ employee_id: "a", version: 1 });
});

test("browser stale real GET cannot overwrite a newer date; network errors recover with reload", async ({ page, request }) => {
  const fixture = await createSchedule(request);
  await openSwap(page, fixture);
  let release;
  let signal;
  const held = new Promise((resolve) => { release = resolve; });
  const observed = new Promise((resolve) => { signal = resolve; });
  const delayedDate = businessDate(7100);
  const finalDate = businessDate(7101);
  await page.route("**/api/shift-assignments?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("date") === delayedDate) {
      const response = await route.fetch();
      signal();
      await held;
      await route.fulfill({ response }).catch(() => undefined);
    } else await route.continue();
  });
  await page.locator("#schedule-date").fill(delayedDate);
  await observed;
  await expect(page.getByText("Đang tải lịch phân ca…", { exact: true })).toBeVisible();
  await page.locator("#schedule-date").fill(finalDate);
  await expect(page.getByText(/Ngày này chưa có phân công dự kiến/)).toBeVisible();
  release();
  await expect(page.locator("#schedule-date")).toHaveValue(finalDate);
  await expect(page.locator("#swap-employee-a")).toHaveValue("");
  await page.unroute("**/api/shift-assignments?**");
  await page.route("**/api/shift-assignments?**", (route) => route.abort("failed"), { times: 1 });
  await page.getByRole("button", { name: "Tải lại lịch", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Tải lại lịch", exact: true }).click();
  await expect(page.getByText(/Ngày này chưa có phân công dự kiến/)).toBeVisible();
});

test("browser global manager navigates schedule and store changes clear employee selections", async ({ page, request }) => {
  const fixture = await createSchedule(request);
  await page.context().addCookies([{ name: "dore_session", value: "test-token-admin", domain: "127.0.0.1", path: "/" }]);
  await page.goto("/manager");
  await page.locator("aside nav").getByRole("button", { name: "Lịch phân ca", exact: true }).click();
  await page.locator("#schedule-date").fill(fixture.date);
  await page.getByRole("group", { name: "Chế độ lịch phân ca" }).getByRole("button", { name: "Đổi ca", exact: true }).click();
  await page.locator("#swap-employee-a").selectOption("a");
  await page.locator("#swap-employee-b").selectOption("b");
  await page.locator("#schedule-store").selectOption("s2");
  await expect(page.locator("#swap-employee-a")).toHaveValue("");
  await expect(page.locator("#swap-employee-b")).toHaveValue("");
  await expect(page.locator("#swap-employee-a option[value='a']")).toHaveCount(0);
  await expect(page.locator("#swap-employee-a option[value='outside']")).toHaveCount(1);
});

test("browser HTKD login reaches schedule only; revoked grant has explicit no-permission state", async ({ page }) => {
  await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/auth/me")), page.goto("/")]);
  await page.locator('[autocomplete="username"]').fill("htkd");
  await page.locator('[autocomplete="current-password"]').fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page).toHaveURL(/\/manager$/);
  await expect(page.locator("#schedule-store option[value='s1']")).toHaveCount(1);
  await expect(page.locator("aside nav").getByRole("button")).toHaveCount(1);
  await page.context().clearCookies();
  await page.context().addCookies([{ name: "dore_session", value: "test-token-revoked", domain: "127.0.0.1", path: "/" }]);
  await page.reload();
  await expect(page.getByText("Bạn chưa được cấp cửa hàng để quản lý lịch phân ca.", { exact: true })).toBeVisible();
});

test("real employee start endpoint uses received assignment after swap at its actual start time", async ({ request }) => {
  test.setTimeout(120_000);
  const startsAt = Math.ceil((Date.now() + 15_000) / 60_000) * 60_000;
  const local = (instant) => new Date(instant + 7 * 3_600_000).toISOString();
  const date = local(startsAt).slice(0, 10);
  const startTime = local(startsAt).slice(11, 16);
  const definitions = [];
  const assignments = [];
  for (const [employeeId, duration] of [["a", 30], ["b", 60]]) {
    const definitionResponse = await call(request, "POST", "/api/shift-definitions", { storeId: "s1", name: `Start ${employeeId} ${crypto.randomUUID().slice(0, 6)}`, startTime, endTime: local(startsAt + duration * 60_000).slice(11, 16) });
    expect(definitionResponse.ok(), await definitionResponse.text()).toBeTruthy();
    const definition = (await definitionResponse.json()).definition;
    definitions.push(definition);
    const assignmentResponse = await call(request, "POST", "/api/shift-assignments", { storeId: "s1", date, employeeId, definitionId: definition.id });
    expect(assignmentResponse.ok(), await assignmentResponse.text()).toBeTruthy();
    assignments.push((await assignmentResponse.json()).assignment);
  }
  expect((await call(request, "POST", "/api/shift-swaps", swapBody({ date, assignments }))).status()).toBe(200);
  while (Date.now() < startsAt + 200) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, startsAt + 200 - Date.now())));
  const started = await call(request, "POST", "/api/shift", { action: "start" }, "employee");
  expect(started.ok(), await started.text()).toBeTruthy();
  const state = await started.json();
  expect(state.shiftName).toBe(definitions[1].name);
  expect(state.scheduledStartAt).toBe(assignments[1].scheduled_start_at);
  expect(state.scheduledEndAt).toBe(assignments[1].scheduled_end_at);
  expect(state.shiftCode).toMatch(/^ASG-/);
  const me = await (await call(request, "GET", "/api/auth/me", undefined, "employee")).json();
  expect(me.user.employeeId).toBe("a");
  expect(me.user.currentShift).toBe(state.shiftCode);
  expect((await call(request, "POST", "/api/shift", { action: "end" }, "employee")).status()).toBe(200);
});
