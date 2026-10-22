export type InventoryHistorySummary = {
  receiptCount: number;
  itemLines: number;
  quantity: number;
  weight: number;
  goods: number;
  shipping: number;
  amount: number;
};

export const EMPTY_INVENTORY_HISTORY_SUMMARY: InventoryHistorySummary = {
  receiptCount: 0,
  itemLines: 0,
  quantity: 0,
  weight: 0,
  goods: 0,
  shipping: 0,
  amount: 0,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeNumber(value: unknown) {
  const parsed = Number(typeof value === "string" ? value.replaceAll(",", "") : value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nonNegativeVnd(value: unknown) {
  const parsed = nonNegativeNumber(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function addVnd(left: number, right: number) {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Tổng tiền nhập hàng vượt giới hạn an toàn.");
  return total;
}

function addFinite(left: number, right: number) {
  const total = left + right;
  return Number.isFinite(total) && total >= 0 ? total : left;
}

/**
 * Build all-time inventory totals from persisted receipt payloads. Empty modern
 * `items` arrays deliberately fall back to the legacy single-item fields so old
 * receipts and the visible history table always produce the same totals.
 */
export function summarizeInventoryHistory(payloads: unknown[]): InventoryHistorySummary {
  return payloads.reduce<InventoryHistorySummary>((summary, value) => {
    const data = record(value) ?? {};
    const modernItems = Array.isArray(data.items) ? data.items.flatMap((item) => {
      const normalized = record(item);
      return normalized ? [normalized] : [];
    }) : [];
    const hasLegacyItem = data.weight != null || data.quantity != null || data.unitPrice != null || data.amount != null;
    const items = modernItems.length > 0 ? modernItems : hasLegacyItem ? [data] : [];

    let goods = 0;
    let shipping = 0;
    let amount = 0;
    let quantity = 0;
    let weight = 0;

    for (const item of items) {
      const itemWeight = nonNegativeNumber(item.weight);
      const itemShipping = nonNegativeVnd(item.shipping);
      const calculatedGoods = Math.round(itemWeight * nonNegativeVnd(item.unitPrice));
      const safeCalculatedGoods = Number.isSafeInteger(calculatedGoods) && calculatedGoods >= 0 ? calculatedGoods : 0;
      const calculatedAmount = addVnd(safeCalculatedGoods, itemShipping);
      const storedAmount = Number(typeof item.amount === "string" ? item.amount.replaceAll(",", "") : item.amount);
      const hasStoredAmount = item.amount != null && Number.isSafeInteger(storedAmount) && storedAmount >= 0;
      const itemAmount = hasStoredAmount ? storedAmount : calculatedAmount;

      quantity = addFinite(quantity, nonNegativeNumber(item.quantity));
      weight = addFinite(weight, itemWeight);
      shipping = addVnd(shipping, itemShipping);
      amount = addVnd(amount, itemAmount);
      goods = addVnd(goods, Math.max(0, itemAmount - itemShipping));
    }

    return {
      receiptCount: summary.receiptCount + 1,
      itemLines: summary.itemLines + items.length,
      quantity: addFinite(summary.quantity, quantity),
      weight: addFinite(summary.weight, weight),
      goods: addVnd(summary.goods, goods),
      shipping: addVnd(summary.shipping, shipping),
      amount: addVnd(summary.amount, amount),
    };
  }, { ...EMPTY_INVENTORY_HISTORY_SUMMARY });
}
