import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { calculateStoreFinance, normalizeMonth, previousMonth } from "../_lib/finance";

type Row = Record<string, unknown>;

function parseRow(row: Row) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(String(row.data_json ?? "{}")); } catch { data = {}; }
  return { ...row, data };
}

async function calculateSystem(db: Awaited<ReturnType<typeof initDb>>, month: string) {
  const storesResult = await db.prepare("SELECT id, name FROM stores WHERE status != 'ARCHIVED' ORDER BY created_at").all();
  const stores = await Promise.all((storesResult.results as Row[]).map(async (store) => ({
    id: String(store.id), name: String(store.name), ...(await calculateStoreFinance(String(store.id), month, db)),
  })));
  const totals = stores.reduce((sum, store) => ({
    revenue: sum.revenue + store.revenue,
    expense: sum.expense + store.expense,
    profit: sum.profit + store.profit,
    employeeKpiTotal: sum.employeeKpiTotal + store.employeeKpiTotal,
    managerKpi: sum.managerKpi + store.managerKpi,
    distributableProfit: sum.distributableProfit + store.distributableProfit,
  }), { revenue: 0, expense: 0, profit: 0, employeeKpiTotal: 0, managerKpi: 0, distributableProfit: 0 });
  return { stores, totals };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const month = normalizeMonth(new URL(request.url).searchParams.get("month"));
  const db = await initDb();
  const [current, previous] = await Promise.all([
    calculateSystem(db, month),
    calculateSystem(db, previousMonth(month)),
  ]);
  const historyRows = await db.prepare("SELECT * FROM business_records WHERE category = 'DIVIDEND' AND status != 'DELETED' ORDER BY created_at DESC LIMIT 36").all();
  const history = (historyRows.results as Row[]).map(parseRow);
  const currentRecord = history.find((record) => String(record.data.month ?? "") === month) ?? null;
  return json({ month, current, previous, record: currentRecord, history });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as { month?: string };
  const month = normalizeMonth(body.month);
  const db = await initDb();

  const existingRows = await db.prepare("SELECT * FROM business_records WHERE category = 'DIVIDEND' AND status != 'DELETED' ORDER BY created_at DESC LIMIT 100").all();
  const existing = (existingRows.results as Row[]).map(parseRow).find((record) => String(record.data.month ?? "") === month);
  if (existing?.status === "LOCKED") return json({ message: "Kỳ cổ tức này đã được chia và khóa sổ." }, 409);

  const storesResult = await db.prepare("SELECT id, name FROM stores WHERE status != 'ARCHIVED' ORDER BY created_at").all();
  const stores = storesResult.results as Row[];
  const unlocked: string[] = [];
  for (const store of stores) {
    const periodRows = await db.prepare("SELECT * FROM business_records WHERE category = 'PAYROLL_PERIOD' AND store_id = ? AND status = 'LOCKED' ORDER BY updated_at DESC LIMIT 100").bind(String(store.id)).all();
    const hasLockedMonth = (periodRows.results as Row[]).map(parseRow).some((record) => String(record.data.month ?? "") === month);
    if (!hasLockedMonth) unlocked.push(String(store.name));
  }
  if (unlocked.length > 0) return json({ message: `Chưa thể chia cổ tức. Hãy khóa kỳ lương ${month} của: ${unlocked.join(", ")}.` }, 409);

  const current = await calculateSystem(db, month);
  const distributable = Math.max(0, current.totals.distributableProfit);
  const vietVi = Math.round(distributable * 0.6);
  const diemThuy = distributable - vietVi;
  const now = new Date().toISOString();
  const id = existing ? String(existing.id) : crypto.randomUUID();
  const data = {
    month,
    confirmedAt: now,
    lockedAt: now,
    totals: current.totals,
    stores: current.stores,
    shareholders: [
      { name: "TRƯƠNG VIỆT VI", rate: 0.6, amount: vietVi },
      { name: "PHẠM THỊ DIỄM THÚY", rate: 0.4, amount: diemThuy },
    ],
  };

  if (existing) {
    await db.prepare("UPDATE business_records SET title = ?, data_json = ?, status = 'LOCKED', updated_at = ? WHERE id = ?")
      .bind(`Chia cổ tức ${month}`, JSON.stringify(data), now, id).run();
  } else {
    await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'DIVIDEND', NULL, ?, ?, ?, 'LOCKED', ?, ?)")
      .bind(id, user.id, `Chia cổ tức ${month}`, JSON.stringify(data), now, now).run();
  }
  await writeAudit(user.id, "LOCK", "DIVIDEND", id, month);
  return json({ ok: true, id, data });
}
