import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, role = "htkd") {
  await page.goto("/");
  await page.getByLabel("Tên đăng nhập", { exact: true }).fill(`browser-${role}`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill("Fixture-Swap-Only-2026");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await expect(page).toHaveURL(role === "htkd" ? /\/scheduling$/ : /\/manager$/);
}
async function openDay(page: Page, day: number) {
  await login(page);
  await page.getByLabel("Ngày phân ca", { exact: true }).fill(`2099-08-${String(day).padStart(2, "0")}`);
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toBeEnabled();
}
async function choose(page: Page) {
  await page.getByLabel("Chọn nhân viên A", { exact: true }).selectOption("browser-a");
  await page.getByLabel("Chọn nhân viên B", { exact: true }).selectOption("browser-b");
  await expect(page.getByRole("button", { name: "Đổi ca", exact: true })).toBeDisabled();
  await page.getByRole("radio", { name: /Ca sáng/ }).check();
  await expect(page.getByRole("button", { name: "Đổi ca", exact: true })).toBeEnabled();
}
async function listing(page: Page, day: number) {
  const response = await page.request.get(`/api/shift-swaps?storeId=browser-store&date=2099-08-${String(day).padStart(2, "0")}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
test("HTKD login and exact multi-shift swap persist after reload without changing other slots", async ({ page }) => {
  await openDay(page, 1);
  const before = await listing(page, 1);
  await choose(page);
  await expect(page.getByText("Lịch sau khi đổi", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Đổi ca", exact: true }).click();
  await expect(page.getByText("Đổi ca thành công", { exact: true })).toBeVisible();
  const after = await listing(page, 1);
  for (const original of before.assignments) {
    const current = after.assignments.find((item: { id: string }) => item.id === original.id);
    expect(current.employeeId).toBe(original.shiftName === "Ca sáng" ? "browser-b" : original.shiftName === "Ca chiều" ? "browser-a" : original.employeeId);
  }
  await page.reload();
  await page.getByLabel("Ngày phân ca", { exact: true }).fill("2099-08-01");
  expect((await listing(page, 1)).assignments).toEqual(after.assignments);
});
test("lost response after real commit is retried with same operation across reload", async ({ page }) => {
  await openDay(page, 2);
  await choose(page);
  const requests: unknown[] = [];
  let dropped = false;
  await page.route("**/api/shift-swaps", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests.push(route.request().postDataJSON());
    if (!dropped) {
      dropped = true;
      const result = await route.fetch();
      expect(result.ok()).toBeTruthy(); // Commit the real SQLite transaction, lose only its response.
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Đổi ca", exact: true }).click();
  await expect(page.getByRole("button", { name: "Kiểm tra lại yêu cầu" })).toBeEnabled();
  const committed = await listing(page, 2);
  await page.reload();
  await page.getByLabel("Ngày phân ca", { exact: true }).fill("2099-08-02");
  await page.getByRole("button", { name: "Kiểm tra lại yêu cầu" }).click();
  await expect(page.getByText("Đổi ca thành công", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect((await listing(page, 2)).assignments).toEqual(committed.assignments);
});
test("stale browser version conflicts after a second operator commits", async ({ page }) => {
  await openDay(page, 3);
  await choose(page);
  const data = await listing(page, 3);
  const a = data.assignments.find((item: { shiftName: string }) => item.shiftName === "Ca sáng");
  const b = data.assignments.find((item: { shiftName: string }) => item.shiftName === "Ca chiều");
  const response = await page.request.post("/api/shift-swaps", { data: {
    storeId: "browser-store", date: "2099-08-03", assignmentAId: a.id, assignmentBId: b.id,
    expectedVersionA: a.version, expectedVersionB: b.version, idempotencyKey: crypto.randomUUID(), reason: "Đổi ca từ phiên kiểm thử khác",
  } });
  expect(response.ok()).toBeTruthy();
  const committed = await listing(page, 3);
  const conflict = page.waitForResponse((result) => result.url().endsWith("/api/shift-swaps") && result.request().method() === "POST");
  await page.getByRole("button", { name: "Đổi ca", exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByRole("alert").first()).toBeVisible();
  expect((await listing(page, 3)).assignments).toEqual(committed.assignments);
});
test("date reset, empty state and HTKD scope do not reveal outside data", async ({ page }) => {
  await openDay(page, 4);
  await choose(page);
  await page.getByLabel("Ngày phân ca", { exact: true }).fill("2099-09-01");
  await expect(page.getByText("Ngày này chưa có phân công.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Đổi ca", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Cửa hàng", exact: true }).locator("option")).toHaveText(["Cửa hàng kiểm thử đổi ca"]);
  for (const path of ["/api/shift-swaps?storeId=browser-outside&date=2099-08-04", "/api/payroll", "/api/stores", "/api/orders", "/api/records", "/api/shifts"]) {
    const denied = await page.request.get(path);
    expect([401, 403]).toContain(denied.status());
  }
});

async function openManagerDay(page: Page, day: number, role = "manager") {
  await login(page, role);
  await page.getByRole("button", { name: "Cửa hàng", exact: true }).click();
  await page.getByRole("button", { name: "Cửa hàng kiểm thử đổi ca", exact: true }).click();
  await page.getByRole("button", { name: "Lịch phân ca", exact: true }).click();
  await page.getByLabel("Ngày phân ca", { exact: true }).fill(`2099-08-${String(day).padStart(2, "0")}`);
  await expect(page.getByRole("button", { name: "Tạo lịch phân ca", exact: true })).toBeEnabled();
}

test("manager navigates actual store schedule, swaps once on double click, and sees refreshed day grid", async ({ page }) => {
  await openManagerDay(page, 6);
  await page.getByRole("tab", { name: "Lịch phân ca", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Đổi ca", exact: true })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Đổi ca", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toBeEnabled();
  await choose(page);
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/shift-swaps")) requests.push(request.postDataJSON());
  });
  await page.getByRole("button", { name: "Đổi ca", exact: true }).dblclick({ force: true });
  await expect(page.getByText("Đổi ca thành công", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByRole("tab", { name: "Lịch phân ca", exact: true }).click();
  const grid = page.getByRole("region", { name: "Lịch phân ca theo ngày, cuộn ngang để xem đầy đủ", exact: true });
  const rowA = grid.getByRole("row").filter({ hasText: "An" });
  const rowB = grid.getByRole("row").filter({ hasText: "Bình" });
  await expect(rowA.getByRole("button", { name: /Ca chiều/ })).toBeVisible();
  await expect(rowB.getByRole("button", { name: /Ca sáng/ })).toBeVisible();
  await expect(rowA.getByRole("button", { name: /Ca tối/ })).toBeVisible();
});

test("one assigned slot is selected automatically and choosing the same employee is excluded", async ({ page }) => {
  await openDay(page, 7);
  await page.getByLabel("Chọn nhân viên A", { exact: true }).selectOption("browser-b");
  await page.getByLabel("Chọn nhân viên B", { exact: true }).selectOption("browser-c");
  await expect(page.getByRole("radio", { name: /Ca chiều/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Ca tối/ })).toBeChecked();
  await expect(page.getByLabel("Chọn nhân viên B", { exact: true }).locator('option[value="browser-b"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đổi ca", exact: true })).toBeEnabled();
});

test("late previous-date response cannot restore old selection; load failure can be retried", async ({ page }) => {
  await openDay(page, 8);
  await choose(page);
  let releaseOld: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseOld = resolve; });
  let oldStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { oldStarted = resolve; });
  await page.route("**/api/shift-swaps?*", async (route) => {
    if (!route.request().url().includes("date=2099-08-09")) return route.continue();
    const result = await route.fetch();
    oldStarted();
    await gate;
    await route.fulfill({ response: result });
  });
  await page.getByLabel("Ngày phân ca", { exact: true }).fill("2099-08-09");
  await started;
  await expect(page.getByText("Đang tải nhân viên và lịch phân ca…", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toBeDisabled();
  await page.getByLabel("Ngày phân ca", { exact: true }).fill("2099-09-02");
  await expect(page.getByText("Ngày này chưa có phân công.", { exact: false })).toBeVisible();
  releaseOld();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toHaveValue("");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đổi ca", exact: true })).toBeDisabled();
  await page.route("**/api/shift-swaps?*", (route) => route.fulfill({ status: 503, json: { message: "Lỗi tải lịch kiểm thử" } }));
  await page.getByLabel("Ngày phân ca", { exact: true }).fill("2099-08-08");
  await expect(page.getByRole("alert").filter({ hasText: "Lỗi tải lịch kiểm thử" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Đổi ca", exact: true })).toBeDisabled();
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: "Tải lại lịch", exact: true }).click();
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toBeEnabled();
  await choose(page);
});

test("manager schedule and swap panels fit all required viewports with local table scrolling", async ({ page }) => {
  await openManagerDay(page, 10);
  const grid = page.getByRole("region", { name: "Lịch phân ca theo ngày, cuộn ngang để xem đầy đủ", exact: true });
  await expect(grid.getByRole("row")).toHaveCount(4);
  for (const width of [360, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("tab", { name: "Lịch phân ca", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const dimensions = await grid.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).overflowX, x: node.getBoundingClientRect().x, right: node.getBoundingClientRect().right }));
    expect(dimensions.x).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(width + 1);
    expect(dimensions.overflow).toBe("auto");
    if (width < 700) expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
    const name = grid.locator('b[title^="Chi Nguyễn"]');
    const textGeometry = await name.evaluate((node) => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight), width: node.getBoundingClientRect().width, parentWidth: node.parentElement!.getBoundingClientRect().width }));
    expect(textGeometry.height).toBeGreaterThan(textGeometry.lineHeight);
    expect(textGeometry.width).toBeLessThanOrEqual(textGeometry.parentWidth + 1);
    await page.screenshot({ path: `test-results/manager-schedule-${width}.png`, fullPage: true });
    await page.getByRole("tab", { name: "Đổi ca", exact: true }).click();
    await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toBeEnabled();
    await choose(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/manager-swap-${width}.png`, fullPage: true });
    await page.getByRole("tab", { name: "Lịch phân ca", exact: true }).click();
  }
});

test("changing actual manager store clears swap participants and old preview", async ({ page }) => {
  await openManagerDay(page, 12, "global");
  await page.getByRole("tab", { name: "Đổi ca", exact: true }).click();
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toBeEnabled();
  await choose(page);
  await page.getByRole("button", { name: "Quay về trang quản lý chính", exact: true }).click();
  await page.getByRole("button", { name: "Cửa hàng", exact: true }).click();
  await page.getByRole("button", { name: "Cửa hàng ngoài phạm vi", exact: true }).click();
  await page.getByRole("button", { name: "Lịch phân ca", exact: true }).click();
  await page.getByLabel("Ngày phân ca", { exact: true }).fill("2099-08-12");
  await page.getByRole("tab", { name: "Đổi ca", exact: true }).click();
  await expect(page.getByText("Ngày này chưa có phân công.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Chọn nhân viên B", { exact: true })).toHaveValue("");
  await expect(page.getByText("Lịch sau khi đổi", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đổi ca", exact: true })).toBeDisabled();
});

test("manager creates a real schedule in existing editor and swap reads the new assignment", async ({ page }) => {
  await openManagerDay(page, 11);
  await page.getByRole("button", { name: "Tạo lịch phân ca", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo lịch phân ca", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Ca sáng/ }).check();
  await dialog.getByRole("checkbox", { name: /Chi/ }).check();
  await dialog.getByLabel("Ghi chú", { exact: true }).fill("Lịch tạo từ giao diện quản lý");
  await dialog.getByRole("button", { name: "Lưu lịch phân ca", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("tab", { name: "Đổi ca", exact: true }).click();
  await expect(page.getByLabel("Chọn nhân viên A", { exact: true })).toBeEnabled();
  await page.getByLabel("Chọn nhân viên A", { exact: true }).selectOption("browser-c");
  await expect(page.getByRole("radio", { name: /Ca sáng/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Ca tối/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Ca sáng/ })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: /Ca tối/ })).not.toBeChecked();
  const data = await listing(page, 11);
  expect(data.assignments.filter((entry: { employeeId: string }) => entry.employeeId === "browser-c")).toHaveLength(2);
});
test("keyboard choices and responsive geometry at all required viewports", async ({ page }) => {
  await openDay(page, 5);
  await choose(page);
  for (const width of [360, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const panel = page.getByRole("region", { name: "Đổi ca giữa hai nhân viên" });
    const box = await panel.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `test-results/swap-${width}.png`, fullPage: true });
  }
  await page.getByLabel("Chọn nhân viên A", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: /Ca sáng/ })).toBeFocused();
});
