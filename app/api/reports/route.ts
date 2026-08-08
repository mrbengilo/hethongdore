import { initDb, writeAudit } from "../../../db/runtime";
import { localPeriod, multiplyRatioVnd, sumVnd } from "../../lib/finance";
import { getSessionUser, json } from "../_lib/auth";
import { previousPeriod, storePeriodFinance, type StorePeriodFinance } from "../_lib/store-finance";

type DividendHistory = {
  period: string;
  revenue: number;
  expense: number;
  profit: number;
  firstShare: number;
  secondShare: number;
  status: "LOCKED";
  closedAt: string;
  closedBy: string;
};

function validPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function parseDividend(value: string) {
  try { return JSON.parse(value) as DividendHistory; } catch { return null; }
}

function totals(stores: StorePeriodFinance[]) {
  const revenue = sumVnd(stores.map((store) => store.revenue));
  const expense = sumVnd(stores.map((store) => store.expense));
  return { revenue, expense, profit: revenue - expense };
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return (current - previous) / Math.abs(previous) * 100;
}

function effectiveness(current: StorePeriodFinance, previous: StorePeriodFinance | null) {
  const margin = current.revenue ? current.profit / current.revenue * 100 : 0;
  const revenueChange = percentChange(current.revenue, previous?.revenue ?? 0);
  const profitChange = percentChange(current.profit, previous?.profit ?? 0);
  const expenseChange = percentChange(current.expense, previous?.expense ?? 0);
  const score = (margin >= 15 ? 2 : margin >= 5 ? 1 : 0)
    + (revenueChange > 0 ? 1 : 0)
    + (profitChange > 0 ? 1 : 0)
    + (expenseChange <= revenueChange ? 1 : 0);
  const rating = score >= 4 ? "TỐT" : score >= 2 ? "CẦN THEO DÕI" : "CẦN CẢI THIỆN";
  const direction = profitChange > 0 && revenueChange > 0 ? "TĂNG TRƯỞNG" : profitChange < 0 ? "SUY GIẢM" : "ỔN ĐỊNH";
  return { margin, revenueChange, expenseChange, profitChange, rating, direction };
}

async function reportData(db: Awaited<ReturnType<typeof initDb>>, period: string, onlyStoreId?: string | null) {
  const ids = onlyStoreId
    ? [{ id: onlyStoreId }]
    : (await db.prepare("SELECT id FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at").all<{ id: string }>()).results;
  const priorPeriod = previousPeriod(period);
  const rows = await Promise.all(ids.map(async ({ id }) => {
    const [current, previous] = await Promise.all([
      storePeriodFinance(db, id, period),
      storePeriodFinance(db, id, priorPeriod),
    ]);
    return current ? { current, previous, evaluation: effectiveness(current, previous) } : null;
  }));
  const stores = rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
  const currentTotals = totals(stores.map((row) => row.current));
  const previousTotals = totals(stores.flatMap((row) => row.previous ? [row.previous] : []));
  return {
    period,
    previousPeriod: priorPeriod,
    stores,
    totals: currentTotals,
    previousTotals,
    comparison: {
      revenueChange: percentChange(currentTotals.revenue, previousTotals.revenue),
      expenseChange: percentChange(currentTotals.expense, previousTotals.expense),
      profitChange: percentChange(currentTotals.profit, previousTotals.profit),
    },
  };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền xem báo cáo." }, 403);
  const params = new URL(request.url).searchParams;
  const period = params.get("period") ?? localPeriod();
  if (!validPeriod(period)) return json({ message: "Kỳ báo cáo không hợp lệ." }, 400);
  const db = await initDb();
  const data = await reportData(db, period, params.get("storeId"));
  const historyRows = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE category = 'DIVIDEND' AND status = 'LOCKED' ORDER BY created_at DESC LIMIT 36")
    .all<{ dataJson: string }>();
  const dividendHistory = historyRows.results.flatMap((row) => {
    const item = parseDividend(row.dataJson);
    return item ? [item] : [];
  });
  return json({ ...data, dividendHistory });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền chốt chia cổ tức." }, 403);
  const body = await request.json().catch(() => ({})) as { action?: string; period?: string };
  const period = body.period ?? "";
  if (body.action !== "CLOSE_DIVIDEND" || !validPeriod(period)) return json({ message: "Thao tác hoặc kỳ chia cổ tức không hợp lệ." }, 400);
  const db = await initDb();
  const activeStores = await db.prepare("SELECT id FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at").all<{ id: string }>();
  const unlocked: string[] = [];
  for (const store of activeStores.results) {
    const closing = await db.prepare("SELECT id FROM business_records WHERE category = 'PAYROLL_CLOSING' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(store.id, period).first<{ id: string }>();
    if (!closing) unlocked.push(store.id);
  }
  if (unlocked.length) return json({ message: `Còn ${unlocked.length} cửa hàng chưa khóa kỳ lương. Hãy hoàn tất trước khi chia cổ tức.` }, 409);

  const id = `dividend:${period}`;
  const existing = await db.prepare("SELECT id FROM business_records WHERE id = ? AND category = 'DIVIDEND' AND status = 'LOCKED' LIMIT 1")
    .bind(id).first<{ id: string }>();
  if (existing) return json({ message: "Kỳ chia cổ tức này đã được chốt và khóa." }, 409);

  const report = await reportData(db, period);
  const profit = Math.max(0, report.totals.profit);
  const firstShare = multiplyRatioVnd(profit, 60, 100);
  const secondShare = profit - firstShare;
  const closedAt = new Date().toISOString();
  const record: DividendHistory = {
    period,
    revenue: report.totals.revenue,
    expense: report.totals.expense,
    profit,
    firstShare,
    secondShare,
    status: "LOCKED",
    closedAt,
    closedBy: user.id,
  };
  try {
    await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, 'DIVIDEND', NULL, ?, ?, ?, 'LOCKED', ?, ?)")
      .bind(id, user.id, `Chia cổ tức ${period}`, JSON.stringify(record), closedAt, closedAt).run();
  } catch (error) {
    const current = await db.prepare("SELECT id FROM business_records WHERE id = ? AND category = 'DIVIDEND' AND status = 'LOCKED' LIMIT 1")
      .bind(id).first<{ id: string }>();
    if (current) return json({ message: "Kỳ chia cổ tức này đã được chốt và khóa." }, 409);
    throw error;
  }
  await writeAudit(user.id, "DIVIDEND_PERIOD_CLOSE", "DIVIDEND", id, JSON.stringify(record));
  return json({ record, message: "Đã xác nhận chia cổ tức, ghi lịch sử và khóa kỳ." }, 201);
}
