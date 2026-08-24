import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dore-cashflow-ledger-read-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "dore.sqlite");
process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";

const [runtime, auth, cashflowRoute] = await Promise.all([
  import("../db/runtime.ts"),
  import("../app/api/_lib/auth.ts"),
  import("../app/api/cashflow/route.ts"),
]);

const db = await runtime.initDb();
const storeId = "cashflow-ledger-store";
const token = "cashflow-ledger-manager-token";

function request(path) {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: `dore_session=${encodeURIComponent(token)}` },
  });
}

async function responseOf(result) {
  return { status: result.status, body: await result.json() };
}

before(async () => {
  const now = "2026-08-05T03:00:00.000Z";
  await db.batch([
    db.prepare(`INSERT INTO stores (id, name, address, revenue, expense, status, created_at)
      VALUES (?, 'DORE CASHFLOW TEST', 'Test', 0, 0, 'ACTIVE', '2026-01-01T00:00:00.000Z')`).bind(storeId),
    db.prepare(`INSERT INTO users
      (id, username, password_hash, role, name, employee_id, store_id, is_super_admin)
      VALUES ('cashflow-ledger-manager', 'cashflow-ledger-manager', 'unused', 'MANAGER', 'Quản lý', NULL, ?, 0)`)
      .bind(storeId),
    db.prepare(`INSERT INTO employees
      (id, store_id, code, name, position, phone, hourly_rate, tiktok_allowance, status)
      VALUES ('cashflow-ledger-employee', ?, 'CF001', 'Nhân viên cashflow', 'Nhân viên bán hàng',
       '0900000000', 20000, 0, 'ACTIVE')`).bind(storeId),
    db.prepare(`INSERT INTO shift_sessions
      (id, shift_code, store_id, employee_id, shift_name, work_date, started_at, ended_at,
       duration_seconds, cash_revenue, transfer_revenue, expense_amount, expense_note,
       close_status, status)
      VALUES
      ('cashflow-shift-split', 'CASHFLOW-SHIFT-SPLIT', ?, 'cashflow-ledger-employee', 'Ca split', '2026-08-05',
       '2026-08-05T01:00:00.000Z', '2026-08-05T02:00:00.000Z', 3600,
       100000, 60000, 50000, 'Chi ca legacy', 'CLOSED', 'COMPLETED'),
      ('cashflow-shift-aggregate', 'CASHFLOW-SHIFT-AGGREGATE', ?, 'cashflow-ledger-employee', 'Ca aggregate', '2026-08-05',
       '2026-08-05T03:00:00.000Z', '2026-08-05T04:00:00.000Z', 3600,
       30000, 20000, 0, NULL, 'CLOSED', 'COMPLETED'),
      ('cashflow-shift-partial', 'CASHFLOW-SHIFT-PARTIAL', ?, 'cashflow-ledger-employee', 'Ca partial', '2026-08-05',
       '2026-08-05T05:00:00.000Z', '2026-08-05T06:00:00.000Z', 3600,
       25000, 15000, 0, NULL, 'CLOSED', 'COMPLETED')`).bind(storeId, storeId, storeId),
    db.prepare(`INSERT INTO business_records
      (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      VALUES
      ('cashflow-variable-legacy', 'DONG_TIEN', ?, NULL, 'Chi phí legacy', ?, 'ACTIVE', ?, ?),
      ('cashflow-variable-normalized', 'DONG_TIEN', ?, NULL, 'Chi phí normalized', ?, 'ACTIVE', ?, ?),
      ('cashflow-variable-moved', 'DONG_TIEN', ?, NULL, 'Chi phí chuyển ngày chi', ?, 'ACTIVE', ?, ?),
      ('cashflow-fixed-unpaid', 'CHI_PHI_CO_DINH', ?, NULL, 'Cố định chưa chi', ?, 'ACTIVE', ?, ?),
      ('cashflow-inventory-unpaid', 'NHAP_HANG', ?, NULL, 'Nhập hàng chưa chi', ?, 'ACTIVE', ?, ?),
      ('cashflow-inventory-paid-later', 'NHAP_HANG', ?, NULL, 'Nhập hàng trả tiền kỳ sau', ?, 'ACTIVE', ?, ?)`)
      .bind(
        storeId, JSON.stringify({ date: "2026-08-05", period: "2026-08", amount: 20000, note: "Legacy only" }), now, now,
        storeId, JSON.stringify({ date: "2026-08-05", period: "2026-08", amount: 30000, note: "Has ledger" }), now, now,
        storeId, JSON.stringify({ date: "2026-08-05", period: "2026-08", amount: 12000, note: "Paid next month" }), now, now,
        storeId, JSON.stringify({ period: "2026-08", total: 40000, note: "No paid timestamp" }), now, now,
        storeId, JSON.stringify({ date: "2026-08-05", period: "2026-08", total: 30000, note: "Receipt date is not payment" }), now, now,
        storeId, JSON.stringify({ date: "2026-07-31", period: "2026-07", total: 30000, paidAt: "2026-08-06T01:00:00.000Z", note: "Paid in selected cash period" }), now, now,
      ),
    db.prepare(`INSERT INTO cashflow_entries
      (id, store_id, direction, amount, category, source_type, source_id,
       occurred_at, created_by, note, created_at, client_request_id, payload_hash, reverses_entry_id)
      VALUES
      ('ledger-shift-cash', ?, 'IN', 90000, 'SHIFT_REVENUE', 'SHIFT_REVENUE_CASH', 'cashflow-shift-split', '2026-08-05T02:00:00.000Z', 'cashflow-ledger-manager', 'Ledger cash wins', ?, 'cashflow-request-shift-cash', ?, NULL),
      ('ledger-shift-bank', ?, 'IN', 55000, 'SHIFT_REVENUE', 'SHIFT_REVENUE_BANK', 'cashflow-shift-split', '2026-08-05T02:00:00.000Z', 'cashflow-ledger-manager', 'Ledger bank wins', ?, 'cashflow-request-shift-bank', ?, NULL),
      ('ledger-shift-expense', ?, 'OUT', 45000, 'SHIFT_EXPENSE', 'SHIFT_EXPENSE', 'cashflow-shift-split', '2026-08-05T02:00:00.000Z', 'cashflow-ledger-manager', 'Ledger expense wins', ?, 'cashflow-request-shift-expense', ?, NULL),
      ('ledger-shift-aggregate', ?, 'IN', 45000, 'SHIFT_REVENUE', 'SHIFT_REVENUE', 'cashflow-shift-aggregate', '2026-08-05T04:00:00.000Z', 'cashflow-ledger-manager', 'Old aggregate suppresses both tenders', ?, 'cashflow-request-shift-aggregate', ?, NULL),
      ('ledger-shift-partial-cash', ?, 'IN', 25000, 'SHIFT_REVENUE', 'SHIFT_REVENUE_CASH', 'cashflow-shift-partial', '2026-08-05T06:00:00.000Z', 'cashflow-ledger-manager', 'Only cash normalized', ?, 'cashflow-request-shift-partial-cash', ?, NULL),
      ('ledger-variable', ?, 'OUT', 25000, 'VARIABLE_EXPENSE', 'VARIABLE_EXPENSE', 'cashflow-variable-normalized', '2026-08-05T02:30:00.000Z', 'cashflow-ledger-manager', 'Normalized variable', ?, 'cashflow-request-variable', ?, NULL),
      ('ledger-variable-reversal', ?, 'IN', 25000, 'VARIABLE_EXPENSE', 'REVERSAL', 'ledger-variable', '2026-08-05T02:45:00.000Z', 'cashflow-ledger-manager', 'Full reversal', ?, 'cashflow-request-reversal', ?, 'ledger-variable'),
      ('ledger-variable-next-month', ?, 'OUT', 12000, 'VARIABLE_EXPENSE', 'VARIABLE_EXPENSE', 'cashflow-variable-moved', '2026-09-01T01:00:00.000Z', 'cashflow-ledger-manager', 'Actual payment next month', ?, 'cashflow-request-next-month', ?, NULL)`)
      .bind(
        storeId, now, "1".repeat(64),
        storeId, now, "2".repeat(64),
        storeId, now, "3".repeat(64),
        storeId, now, "4".repeat(64),
        storeId, now, "5".repeat(64),
        storeId, now, "6".repeat(64),
        storeId, now, "7".repeat(64),
        storeId, now, "8".repeat(64),
      ),
  ]);
  await db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('cashflow-ledger-session', 'cashflow-ledger-manager', ?, ?, ?)`)
    .bind(await auth.sha256(token), Date.now() + 600_000, now).run();
});

after(async () => {
  db.close?.();
  await rm(directory, { recursive: true, force: true });
});

test("cashflow read model is ledger-first and suppresses matching legacy sources exactly once", async () => {
  const response = await responseOf(await cashflowRoute.GET(request(
    `/api/cashflow?storeId=${storeId}&period=2026-08&granularity=day&from=2026-08-01&to=2026-08-24`,
  )));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.totals, { inflow: 255000, outflow: 120000, net: 135000 });
  assert.equal(response.body.entries.length, 10);
  assert.equal(response.body.entries.filter((entry) => entry.sourceId === "cashflow-shift-split").length, 3);
  assert.equal(response.body.entries.filter((entry) => entry.sourceId === "cashflow-shift-aggregate").length, 1);
  const partialTenderEntries = response.body.entries.filter((entry) => entry.sourceId === "cashflow-shift-partial");
  assert.deepEqual(partialTenderEntries.map((entry) => entry.sourceType).sort(), [
    "SHIFT_REVENUE_BANK",
    "SHIFT_REVENUE_CASH",
  ]);
  assert.equal(partialTenderEntries.filter((entry) => entry.origin === "LEGACY_VIRTUAL").length, 1);
  assert.equal(response.body.entries.filter((entry) => entry.sourceId === "cashflow-variable-normalized").length, 1);
  assert.equal(response.body.entries.some((entry) => entry.sourceId === "cashflow-variable-moved"), false,
    "a normalized source paid outside the selected range must suppress its in-range legacy projection");
  const paidLaterInventory = response.body.entries.find((entry) => entry.sourceId === "cashflow-inventory-paid-later");
  assert.equal(paidLaterInventory.date, "2026-08-06",
    "inventory cash must follow the real paid timestamp, not its receipt/accounting date");

  const reversal = response.body.entries.find((entry) => entry.id === "ledger-variable-reversal");
  assert.equal(reversal.origin, "LEDGER");
  assert.equal(reversal.isReversal, true);
  assert.equal(reversal.reversesEntryId, "ledger-variable");
  assert.equal(reversal.occurredAt, "2026-08-05T02:45:00.000Z");

  assert.deepEqual(response.body.cashflowReadModel.diagnostics, {
    ledgerEntryCount: 7,
    legacyEntryCount: 3,
    suppressedLegacyCount: 8,
    skippedUnpaidLegacyCount: 2,
    reversalCount: 1,
  });
  assert.equal(response.body.cashflowReadModel.sourceOfTruth, "cashflow_entries");
  assert.ok(response.body.reconciliation.warnings.some((warning) => warning.code === "UNPAID_LEGACY_EXCLUDED"));
  assert.ok(response.body.reconciliation.warnings.some((warning) => warning.code === "NORMALIZED_SOURCE_WON"));
  assert.ok(response.body.reconciliation.warnings.some((warning) => warning.code === "CASHFLOW_REVERSALS_PRESENT"));
});

test("accounting totals remain Finance Engine results and never sum the cash ledger", async () => {
  const response = await responseOf(await cashflowRoute.GET(request(
    `/api/cashflow?storeId=${storeId}&period=2026-08&granularity=day&from=2026-08-01&to=2026-08-24`,
  )));

  assert.equal(response.status, 200);
  assert.notEqual(response.body.accountingTotals.expense, response.body.totals.outflow);
  assert.equal(
    response.body.reconciliation.timingDifference,
    response.body.accountingTotals.expense - response.body.totals.outflow,
  );
});
