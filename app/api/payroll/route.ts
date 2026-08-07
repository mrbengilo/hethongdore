import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { calculateStoreFinance, normalizeMonth } from "../_lib/finance";

type PayrollAction = "CONFIRM_SALARY" | "CONFIRM_BONUS_ALLOWANCE" | "MARK_PAID" | "LOCK";
type Row = Record<string, unknown>;

function parseRow(row?: Row | null) {
  if (!row) return null;
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(String(row.data_json ?? "{}")); } catch { data = {}; }
  return { ...row, data };
}

async function findPeriod(db: Awaited<ReturnType<typeof initDb>>, storeId: string, month: string) {
  const result = await db.prepare("SELECT * FROM business_records WHERE category = 'PAYROLL_PERIOD' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC LIMIT 100").bind(storeId).all();
  return (result.results as Row[]).map(parseRow).find((record) => String(record?.data.month ?? "") === month) ?? null;
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const params = new URL(request.url).searchParams;
  const storeId = params.get("storeId");
  const month = normalizeMonth(params.get("month"));
  if (!storeId) return json({ message: "Thiếu cửa hàng" }, 400);
  const db = await initDb();
  const summary = await calculateStoreFinance(storeId, month, db);
  const current = await findPeriod(db, storeId, month);
  const historyRows = await db.prepare("SELECT * FROM business_records WHERE category = 'PAYROLL_PERIOD' AND store_id = ? AND status != 'DELETED' ORDER BY updated_at DESC LIMIT 24").bind(storeId).all();
  const history = (historyRows.results as Row[]).map(parseRow);
  return json({ month, summary, period: current, history });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as { storeId?: string; month?: string; action?: PayrollAction };
  const storeId = body.storeId;
  const month = normalizeMonth(body.month);
  const action = body.action;
  if (!storeId || !action || !["CONFIRM_SALARY", "CONFIRM_BONUS_ALLOWANCE", "MARK_PAID", "LOCK"].includes(action)) return json({ message: "Dữ liệu không hợp lệ" }, 400);

  const db = await initDb();
  const store = await db.prepare("SELECT id, name FROM stores WHERE id = ? AND status != 'ARCHIVED'").bind(storeId).first<{ id: string; name: string }>();
  if (!store) return json({ message: "Không tìm thấy cửa hàng" }, 404);
  const summary = await calculateStoreFinance(storeId, month, db);
  const existing = await findPeriod(db, storeId, month);
  const now = new Date().toISOString();

  if (existing && String(existing.status) === "LOCKED") return json({ message: "Kỳ này đã khóa sổ và không thể thay đổi." }, 409);

  const data: Record<string, unknown> = existing ? { ...(existing.data as Record<string, unknown>) } : { month, createdAt: now };
  data.month = month;

  if (action === "CONFIRM_SALARY") data.salaryConfirmedAt = now;
  if (action === "CONFIRM_BONUS_ALLOWANCE") data.bonusAllowanceConfirmedAt = now;
  if (action === "MARK_PAID") {
    if (!data.salaryConfirmedAt || !data.bonusAllowanceConfirmedAt) return json({ message: "Phải xác nhận chi lương và xác nhận thưởng/phụ cấp trước khi ghi nhận đã chi." }, 409);
    data.paidAt = now;
    data.paidSnapshot = summary;
  }
  if (action === "LOCK") {
    if (!data.paidAt) return json({ message: "Phải ghi nhận đã chi trước khi khóa kỳ." }, 409);
    data.lockedAt = now;
    data.snapshot = summary;
  }

  const status = action === "LOCK" ? "LOCKED" : action === "MARK_PAID" ? "PAID" : "IN_PROGRESS";
  const id = existing ? String(existing.id) : crypto.randomUUID();
  if (existing) {
    await db.prepare("UPDATE business_records SET title = ?, data_json = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(`${store.name} · Kỳ lương ${month}`, JSON.stringify(data), status, now, id).run();
  } else {
    await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'PAYROLL_PERIOD', ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, storeId, user.id, `${store.name} · Kỳ lương ${month}`, JSON.stringify(data), status, now, now).run();
  }

  await writeAudit(user.id, action, "PAYROLL_PERIOD", id, `${store.name} ${month}`);
  const period = await findPeriod(db, storeId, month);
  return json({ ok: true, period, summary });
}
