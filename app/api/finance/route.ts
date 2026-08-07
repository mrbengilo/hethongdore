import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { calculateStoreFinance, normalizeMonth, previousMonth } from "../_lib/finance";
import { reconcileActiveShifts } from "../_lib/shift-rollover";

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / Math.abs(previous)) * 10_000) / 100;
}

function totalsOf(items: Array<{ revenue: number; expense: number; profit: number; distributableProfit: number; employeeKpiTotal: number; managerKpi: number }>) {
  return items.reduce((sum, item) => ({
    revenue: sum.revenue + item.revenue,
    expense: sum.expense + item.expense,
    profit: sum.profit + item.profit,
    distributableProfit: sum.distributableProfit + item.distributableProfit,
    employeeKpiTotal: sum.employeeKpiTotal + item.employeeKpiTotal,
    managerKpi: sum.managerKpi + item.managerKpi,
  }), { revenue: 0, expense: 0, profit: 0, distributableProfit: 0, employeeKpiTotal: 0, managerKpi: 0 });
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const params = new URL(request.url).searchParams;
  const month = normalizeMonth(params.get("month"));
  const previous = previousMonth(month);
  const requestedStoreId = params.get("storeId");
  const storeId = user.role === "EMPLOYEE" ? user.storeId : requestedStoreId;
  const db = await initDb();
  await reconcileActiveShifts(db, storeId);

  if (storeId) {
    if (user.role === "EMPLOYEE" && user.storeId !== storeId) return json({ message: "Không có quyền" }, 403);
    const store = await db.prepare("SELECT id, name, address, status FROM stores WHERE id = ? AND status != 'ARCHIVED'").bind(storeId).first<Record<string, unknown>>();
    if (!store) return json({ message: "Không tìm thấy cửa hàng" }, 404);
    const [current, prior] = await Promise.all([
      calculateStoreFinance(storeId, month, db),
      calculateStoreFinance(storeId, previous, db),
    ]);
    return json({
      month,
      previousMonth: previous,
      store: { ...store, ...current },
      previous: prior,
      comparison: {
        revenue: percentChange(current.revenue, prior.revenue),
        expense: percentChange(current.expense, prior.expense),
        profit: percentChange(current.profit, prior.profit),
      },
    });
  }

  if (user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const storeResult = await db.prepare("SELECT id, name, address, status FROM stores WHERE status != 'ARCHIVED' ORDER BY created_at").all();
  const stores = storeResult.results as Array<Record<string, unknown>>;
  const currentStores = await Promise.all(stores.map(async (store) => ({
    ...store,
    ...(await calculateStoreFinance(String(store.id), month, db)),
  })));
  const priorStores = await Promise.all(stores.map(async (store) => ({
    id: String(store.id),
    ...(await calculateStoreFinance(String(store.id), previous, db)),
  })));
  const totals = totalsOf(currentStores);
  const priorTotals = totalsOf(priorStores);

  return json({
    month,
    previousMonth: previous,
    stores: currentStores,
    totals,
    previous: priorTotals,
    comparison: {
      revenue: percentChange(totals.revenue, priorTotals.revenue),
      expense: percentChange(totals.expense, priorTotals.expense),
      profit: percentChange(totals.profit, priorTotals.profit),
    },
  });
}
