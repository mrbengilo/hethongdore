import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("manager report and cash-flow menu items open separate views", async () => {
  const portal = await source("app/components/Portal.tsx");
  assert.match(portal, /view === "Dòng tiền"[\s\S]*?<ManagerCashflow\/>/u);
  assert.match(portal, /view === "Báo cáo"[\s\S]*?<ManagerBusinessReport\/>/u);
  assert.doesNotMatch(portal, /view === "Dòng tiền"[\s\S]{0,100}<ManagerBusinessReport\/>/u);
  assert.match(portal, /financeOwnsHeader = view === "Báo cáo" \|\| view === "Dòng tiền"/u);
});

test("cash-flow API derives totals from persisted operational records", async () => {
  const route = await source("app/api/cashflow/route.ts");
  assert.match(route, /shift_sessions/u);
  assert.match(route, /'DONG_TIEN', 'NHAP_HANG', 'CHI_PHI_CO_DINH', 'PAYROLL_CLOSING'/u);
  assert.match(route, /paymentConfirmedAt/u);
  assert.match(route, /aggregateTimeline/u);
  assert.match(route, /sumVnd\(byStore\.map\(\(store\) => store\.outflow\)\)/u);
  assert.doesNotMatch(route, /mock|fallback|sample/iu);
});

test("report growth keeps a loss negative when the previous period was zero", async () => {
  const route = await source("app/api/reports/route.ts");
  assert.match(route, /previous === 0\) return current > 0 \? 100 : current < 0 \? -100 : 0/u);
});

test("manager finance views expose report growth and daily-monthly cash-flow controls", async () => {
  const component = await source("app/components/ManagerFinanceViews.tsx");
  assert.match(component, /Chi tiết hiệu quả từng cửa hàng/u);
  assert.match(component, /Biểu đồ doanh thu – chi phí – lợi nhuận/u);
  assert.match(component, /current\.profit < 0/u);
  assert.match(component, /direction: current\.profit < 0/u);
  assert.match(component, /Theo ngày/u);
  assert.match(component, /Theo tháng/u);
  assert.match(component, /Chi tiết dòng tiền theo/u);
  assert.match(component, /aria-pressed/u);
});

test("store report selection stays on the store tab and all-store cash outflows reconcile", async () => {
  const [component, portal] = await Promise.all([
    source("app/components/ManagerFinanceViews.tsx"),
    source("app/components/Portal.tsx"),
  ]);

  assert.match(component, /options\.some\(\(store\) => store\.id === storeId\)/u);
  assert.doesNotMatch(component, /!data\.stores\.some\([\s\S]{0,120}setScope\("ALL"\)/u);
  assert.match(component, /data\.byStore\.reduce<CashTotals>/u);
  assert.match(component, /Tổng tiền đã chi thực tế tất cả cửa hàng/u);
  assert.match(component, /Tổng chi phí.*Tổng quan và Báo cáo là chi phí kế toán/u);
  assert.match(component, /Chi phí kế toán cùng kỳ/u);
  assert.match(component, /Chênh lệch thời điểm ghi nhận/u);
  assert.doesNotMatch(component, /label=\{storeId === "ALL" \? "Tổng chi phí tất cả cửa hàng"/u);
  assert.match(component, /TỔNG TẤT CẢ CỬA HÀNG/u);
  assert.match(portal, /label="TỔNG DOANH THU" value=\{money\(totals\.revenue\)\}/u);
  assert.match(portal, /label="TỔNG CHI PHÍ" value=\{money\(totals\.expense\)\}/u);
  assert.match(portal, /\/api\/stores\?period=\$\{encodeURIComponent\(period\)\}/u);
  assert.match(portal, /type="month" value=\{period\} onChange=/u);
  assert.match(portal, /so với kỳ trước/u);
});
