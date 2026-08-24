import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [{ createSqliteDatabase }, monthEndExpenses] = await Promise.all([
  import("../db/sqlite.ts"),
  import("../app/lib/month-end-expenses.ts"),
]);

async function database() {
  const db = await createSqliteDatabase();
  await db.exec(`
    CREATE TABLE stores (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      store_id TEXT,
      is_super_admin INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL
    );
    CREATE TABLE business_records (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      store_id TEXT,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE TABLE financial_periods (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE month_end_expenses (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      period TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      note TEXT,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'VOID')),
      version INTEGER NOT NULL CHECK (version > 0),
      client_request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      voided_by TEXT,
      voided_at TEXT,
      CHECK (
        (status = 'ACTIVE' AND voided_by IS NULL AND voided_at IS NULL)
        OR (status = 'VOID' AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX idx_month_end_expenses_actor_request
      ON month_end_expenses(store_id, created_by, client_request_id);
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      store_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT,
      before_json TEXT,
      after_json TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO stores VALUES ('store-1', 'ACTIVE'), ('store-2', 'ACTIVE');
    INSERT INTO users VALUES
      ('manager-1', 'MANAGER', 'store-1', 0, 'Quản lý một'),
      ('manager-2', 'MANAGER', 'store-2', 0, 'Quản lý hai'),
      ('super-admin', 'MANAGER', NULL, 1, 'Quản trị cấp cao');
  `);
  return db;
}

function values(overrides = {}) {
  return {
    period: "2026-08",
    title: "Dự phòng hao hụt",
    category: "DỰ PHÒNG",
    amount: 100_000,
    note: "Đối soát cuối tháng",
    ...overrides,
  };
}

function createInput(overrides = {}) {
  return {
    storeId: "store-1",
    actorId: "manager-1",
    clientRequestId: "month-end-request-0001",
    values: values(),
    now: "2026-08-31T16:00:00.000Z",
    reason: "Tạo khoản dự phòng cuối tháng",
    ...overrides,
  };
}

function conflict(reason) {
  return (error) => error instanceof monthEndExpenses.MonthEndExpenseConflictError
    && error.reason === reason;
}

test("month-end expense input is normalized and hashes are canonical", async () => {
  assert.equal(monthEndExpenses.normalizeMonthEndExpensePeriod("2026-08"), "2026-08");
  assert.equal(monthEndExpenses.normalizeMonthEndExpensePeriod("2026-13"), null);
  assert.equal(monthEndExpenses.normalizeMonthEndExpenseRequestId("short"), null);
  assert.equal(monthEndExpenses.monthEndExpenseVersion(1), 1);
  assert.equal(monthEndExpenses.monthEndExpenseVersion(0), null);
  assert.deepEqual(monthEndExpenses.monthEndExpenseValues({
    period: "2026-08",
    title: "  Điều   chỉnh tồn kho ",
    category: " HAO HỤT ",
    amount: "3000000",
    note: "  Kết quả   kiểm kê ",
  }), {
    period: "2026-08",
    title: "Điều chỉnh tồn kho",
    category: "HAO HỤT",
    amount: 3_000_000,
    note: "Kết quả kiểm kê",
  });
  assert.equal(monthEndExpenses.monthEndExpenseValues(values({ amount: 0 })), null);
  assert.equal(monthEndExpenses.monthEndExpenseValues(values({ amount: 1.5 })), null);
  assert.equal(monthEndExpenses.monthEndExpenseValues(values({ note: "" })), null);

  const normalized = monthEndExpenses.monthEndExpenseValues(values());
  assert.ok(normalized);
  const first = await monthEndExpenses.monthEndExpensePayloadHash({ storeId: "store-1", values: normalized });
  const second = await monthEndExpenses.monthEndExpensePayloadHash({ storeId: "store-1", values: normalized });
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, second);
});

test("month-end expenses are idempotent, CAS-updated, soft-voided and summed once", async () => {
  const db = await database();
  try {
    const firstInput = createInput();
    const first = await monthEndExpenses.createMonthEndExpense(db, firstInput);
    assert.equal(first.status, "CREATED");
    assert.equal(first.expense.status, "ACTIVE");
    assert.equal(first.expense.version, 1);

    const replay = await monthEndExpenses.createMonthEndExpense(db, firstInput);
    assert.equal(replay.status, "IDEMPOTENT");
    assert.equal(replay.expense.id, first.expense.id);
    await assert.rejects(
      monthEndExpenses.createMonthEndExpense(db, {
        ...firstInput,
        values: values({ amount: 100_001 }),
      }),
      conflict("IDEMPOTENCY"),
    );

    const second = await monthEndExpenses.createMonthEndExpense(db, createInput({
      clientRequestId: "month-end-request-0002",
      values: values({ title: "Điều chỉnh tồn kho", amount: 200_000 }),
      now: "2026-08-31T16:01:00.000Z",
    }));
    let listed = await monthEndExpenses.listMonthEndExpenses(db, "store-1", "2026-08");
    assert.equal(listed.expenses.length, 2);
    assert.equal(listed.total, 300_000);

    const updated = await monthEndExpenses.updateMonthEndExpense(db, {
      id: first.expense.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: 1,
      values: { title: "Dự phòng đã đối soát", category: "DỰ PHÒNG", amount: 150_000, note: "Đã kiểm tra chứng từ" },
      now: "2026-08-31T16:02:00.000Z",
      reason: "Cập nhật theo biên bản kiểm kê",
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.amount, 150_000);
    await assert.rejects(monthEndExpenses.updateMonthEndExpense(db, {
      id: first.expense.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: 1,
      values: { title: "Bản sửa cũ", category: "DỰ PHÒNG", amount: 1, note: "Không được ghi" },
      now: "2026-08-31T16:03:00.000Z",
      reason: "Thử lưu từ phiên bản cũ",
    }), conflict("STALE"));

    const voided = await monthEndExpenses.voidMonthEndExpense(db, {
      id: second.expense.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: 1,
      now: "2026-08-31T16:04:00.000Z",
      reason: "Hủy khoản nhập nhầm chứng từ",
    });
    assert.equal(voided.status, "VOID");
    assert.equal(voided.version, 2);
    listed = await monthEndExpenses.listMonthEndExpenses(db, "store-1", "2026-08");
    assert.equal(listed.expenses.length, 2, "VOID is retained as history");
    assert.equal(listed.total, 150_000, "only ACTIVE rows contribute to the total");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM month_end_expenses").first()).count, 2);

    const audits = await db.prepare(`SELECT action, user_id AS userId, store_id AS storeId,
      before_json AS beforeJson, after_json AS afterJson, reason
      FROM audit_logs ORDER BY created_at, action`).all();
    assert.deepEqual(audits.results.map((row) => row.action), [
      "CREATE_MONTH_END_EXPENSE",
      "CREATE_MONTH_END_EXPENSE",
      "UPDATE_MONTH_END_EXPENSE",
      "VOID_MONTH_END_EXPENSE",
    ]);
    assert.ok(audits.results.every((row) => row.userId === "manager-1" && row.storeId === "store-1"));
    assert.equal(audits.results[0].beforeJson, null);
    assert.equal(JSON.parse(audits.results[2].beforeJson).version, 1);
    assert.equal(JSON.parse(audits.results[2].afterJson).version, 2);
    assert.equal(JSON.parse(audits.results[3].afterJson).status, "VOID");
    assert.match(audits.results[3].reason, /nhập nhầm/u);
  } finally {
    db.close();
  }
});

test("month-end expense mutations honor store scope, store state and canonical period lifecycle", async () => {
  const db = await database();
  try {
    await db.prepare("INSERT INTO financial_periods VALUES ('period-1', 'store-1', '2026-08', 'DRAFT')").run();
    const created = await monthEndExpenses.createMonthEndExpense(db, createInput());
    let version = 1;
    for (const status of ["DRAFT", "CALCULATED", "RECONCILING"]) {
      await db.prepare("UPDATE financial_periods SET status = ? WHERE id = 'period-1'").bind(status).run();
      const updated = await monthEndExpenses.updateMonthEndExpense(db, {
        id: created.expense.id,
        storeId: "store-1",
        actorId: "manager-1",
        expectedVersion: version,
        values: { title: `Chi phí ${status}`, category: "KHÁC", amount: 100_000 + version, note: `Đối soát tại ${status}` },
        now: `2026-08-31T16:0${version}:00.000Z`,
        reason: `Cập nhật khi kỳ ở trạng thái ${status}`,
      });
      version = updated.version;
    }

    await db.prepare("UPDATE financial_periods SET status = 'CONFIRMED' WHERE id = 'period-1'").run();
    const finalizedReplay = await monthEndExpenses.createMonthEndExpense(db, createInput());
    assert.equal(finalizedReplay.status, "IDEMPOTENT",
      "an exact retry is read-only and remains safe after the period is finalized");
    await assert.rejects(monthEndExpenses.updateMonthEndExpense(db, {
      id: created.expense.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: version,
      values: { title: "Không được sửa", category: "KHÁC", amount: 1, note: "Kỳ đã xác nhận" },
      now: "2026-08-31T16:10:00.000Z",
      reason: "Thử sửa kỳ đã xác nhận",
    }), conflict("LOCKED"));
    await assert.rejects(monthEndExpenses.createMonthEndExpense(db, createInput({
      clientRequestId: "month-end-request-locked",
      values: values({ title: "Không được tạo" }),
    })), conflict("LOCKED"));
    assert.equal((await monthEndExpenses.getMonthEndExpense(db, created.expense.id, "store-1")).version, version);

    await db.prepare("UPDATE financial_periods SET status = 'DRAFT' WHERE id = 'period-1'").run();
    await db.prepare("UPDATE stores SET status = 'INACTIVE' WHERE id = 'store-1'").run();
    assert.equal((await monthEndExpenses.listMonthEndExpenses(db, "store-1", "2026-08")).expenses.length, 1,
      "inactive stores remain readable");
    await assert.rejects(monthEndExpenses.voidMonthEndExpense(db, {
      id: created.expense.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: version,
      now: "2026-08-31T16:11:00.000Z",
      reason: "Thử hủy ở cửa hàng ngưng hoạt động",
    }), conflict("INACTIVE"));

    await db.prepare("UPDATE stores SET status = 'ACTIVE' WHERE id = 'store-1'").run();
    await db.prepare("UPDATE users SET store_id = 'store-2' WHERE id = 'manager-1'").run();
    await assert.rejects(monthEndExpenses.voidMonthEndExpense(db, {
      id: created.expense.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: version,
      now: "2026-08-31T16:12:00.000Z",
      reason: "Thử hủy ngoài phạm vi cửa hàng",
    }), conflict("FORBIDDEN"));

    const global = await monthEndExpenses.createMonthEndExpense(db, createInput({
      actorId: "super-admin",
      clientRequestId: "month-end-super-request",
      values: values({ title: "Chi phí bởi quản trị" }),
      now: "2026-08-31T16:13:00.000Z",
    }));
    assert.equal(global.status, "CREATED");
  } finally {
    db.close();
  }
});

test("audit failures roll month-end expense source mutations back atomically", async () => {
  const db = await database();
  try {
    await db.exec(`CREATE TRIGGER reject_month_end_audit BEFORE INSERT ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'month-end audit failure'); END`);
    await assert.rejects(monthEndExpenses.createMonthEndExpense(db, createInput()), /month-end audit failure/u);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM month_end_expenses").first()).count, 0);

    await db.exec("DROP TRIGGER reject_month_end_audit");
    const created = await monthEndExpenses.createMonthEndExpense(db, createInput());
    await db.exec(`CREATE TRIGGER reject_month_end_update_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'UPDATE_MONTH_END_EXPENSE'
      BEGIN SELECT RAISE(ABORT, 'month-end update audit failure'); END`);
    await assert.rejects(monthEndExpenses.updateMonthEndExpense(db, {
      id: created.expense.id,
      storeId: "store-1",
      actorId: "manager-1",
      expectedVersion: 1,
      values: { title: "Không được lưu", category: "KHÁC", amount: 999_999, note: "Audit sẽ thất bại" },
      now: "2026-08-31T16:05:00.000Z",
      reason: "Kiểm tra rollback khi audit lỗi",
    }), /month-end update audit failure/u);
    const after = await monthEndExpenses.getMonthEndExpense(db, created.expense.id, "store-1");
    assert.equal(after.version, 1);
    assert.equal(after.amount, 100_000);
  } finally {
    db.close();
  }
});

test("month-end expense API contract is scoped, read-only for inactive stores and never writes cashflow", async () => {
  const source = await readFile(new URL("../app/api/month-end-expenses/route.ts", import.meta.url), "utf8");
  const domain = await readFile(new URL("../app/lib/month-end-expenses.ts", import.meta.url), "utf8");
  assert.match(source, /user\.role !== "MANAGER"/u);
  assert.match(source, /resolveManagerStoreScope/u);
  assert.match(source, /managerCanAccessStore/u);
  assert.match(source, /if \(!await isStoreActive\(storeId\)\)/u);
  assert.match(source, /storeId: scope\.storeId,[\s\S]*period,[\s\S]*locked:[\s\S]*expenses,[\s\S]*total/u);
  assert.match(source, /voidMonthEndExpense/u);
  assert.doesNotMatch(source, /cashflow|Cashflow/u);
  assert.doesNotMatch(domain, /DELETE\s+FROM\s+month_end_expenses/iu);
  assert.match(domain, /status = 'VOID'/u);
  assert.match(domain, /CREATE_MONTH_END_EXPENSE/u);
  assert.match(domain, /UPDATE_MONTH_END_EXPENSE/u);
  assert.match(domain, /VOID_MONTH_END_EXPENSE/u);
  assert.match(domain, /storePeriodUnlockedSql/u);
});
