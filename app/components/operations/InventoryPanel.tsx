"use client";

import { useMemo, useState } from "react";
import { createRecord, dateTime24, money, Notice, Panel, StoreFinance, useRecords } from "./shared";

type Item = { id: string; name: string; quantity: string; unit: string; weight: string; unitPrice: string; shipping: string };
const blankItem = (): Item => ({ id: crypto.randomUUID(), name: "", quantity: "", unit: "bao", weight: "", unitPrice: "", shipping: "" });
const rowAmount = (item: Item) => Number(item.weight || 0) * Number(item.unitPrice || 0) + Number(item.shipping || 0);

export default function InventoryPanel({ store, month, onChanged }: { store: StoreFinance; month: string; onChanged: () => Promise<void> | void }) {
  const [items, setItems] = useState<Item[]>([blankItem()]);
  const [message, setMessage] = useState("");
  const history = useRecords("NHAP_HANG", store.id);
  const monthHistory = history.records.filter((record) => String(record.data.period ?? "") === month);
  const goodsCost = useMemo(() => items.reduce((sum, item) => sum + Number(item.weight || 0) * Number(item.unitPrice || 0), 0), [items]);
  const shippingCost = useMemo(() => items.reduce((sum, item) => sum + Number(item.shipping || 0), 0), [items]);
  const total = goodsCost + shippingCost;

  function update(id: string, field: keyof Item, value: string) {
    setItems(items.map((item) => item.id === id ? { ...item, [field]: value } : item));
  }

  async function save() {
    setMessage("");
    const validItems = items.filter((item) => item.name.trim() && Number(item.quantity) > 0 && Number(item.weight) > 0 && Number(item.unitPrice) > 0);
    if (validItems.length === 0) return setMessage("Vui lòng nhập ít nhất một hàng hóa đầy đủ tên, số lượng, cân nặng và đơn giá.");
    const normalized = validItems.map((item) => ({
      name: item.name.trim(), quantity: Number(item.quantity), unit: item.unit || "bao", weight: Number(item.weight),
      unitPrice: Number(item.unitPrice), shipping: Number(item.shipping || 0), amount: rowAmount(item),
    }));
    const receiptGoods = normalized.reduce((sum, item) => sum + item.weight * item.unitPrice, 0);
    const receiptShipping = normalized.reduce((sum, item) => sum + item.shipping, 0);
    try {
      await createRecord("NHAP_HANG", store.id, `Phiếu nhập ${store.name} · ${month}`, {
        period: month, items: normalized, goodsCost: receiptGoods, shippingCost: receiptShipping,
        total: receiptGoods + receiptShipping, savedAt: new Date().toISOString(),
      });
      setItems([blankItem()]);
      setMessage("Đã lưu phiếu nhập. Danh sách đã được đặt lại để nhập đợt tiếp theo.");
      await history.reload();
      await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Không thể lưu phiếu nhập"); }
  }

  return <div className="op-stack">
    <Panel title="Nhập hàng" action={<button className="op-primary" onClick={() => setItems([...items, blankItem()])}>＋ THÊM HÀNG HÓA</button>}>
      <Notice>Danh sách hàng hóa luôn hiển thị. Mỗi đợt nhập phải bấm <b>LƯU PHIẾU NHẬP</b>; sau khi lưu hệ thống ghi lịch sử và tự đặt danh sách về trạng thái ban đầu.</Notice>
      <div className="op-table-wrap op-entry-table"><table><thead><tr><th>Tên hàng hóa</th><th>Số lượng</th><th>Đơn vị</th><th>Cân nặng (kg)</th><th>Đơn giá nhập/kg</th><th>Phí vận chuyển</th><th>Thành tiền</th><th></th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><input value={item.name} onChange={(e) => update(item.id, "name", e.target.value)} placeholder="Tên hàng" /></td><td><input type="number" min="0" value={item.quantity} onChange={(e) => update(item.id, "quantity", e.target.value)} /></td><td><input value={item.unit} onChange={(e) => update(item.id, "unit", e.target.value)} /></td><td><input type="number" min="0" step="0.01" value={item.weight} onChange={(e) => update(item.id, "weight", e.target.value)} /></td><td><input type="number" min="0" value={item.unitPrice} onChange={(e) => update(item.id, "unitPrice", e.target.value)} /></td><td><input type="number" min="0" value={item.shipping} onChange={(e) => update(item.id, "shipping", e.target.value)} /></td><td><b>{money(rowAmount(item))}</b></td><td><button className="op-danger-link" onClick={() => setItems(items.length === 1 ? [blankItem()] : items.filter((row) => row.id !== item.id))}>Xóa</button></td></tr>)}</tbody></table></div>
      <div className="op-total-grid"><span>Tiền hàng <b>{money(goodsCost)}</b></span><span>Vận chuyển <b>{money(shippingCost)}</b></span><span>Tổng phiếu <strong>{money(total)}</strong></span><button className="op-primary" onClick={save}>LƯU PHIẾU NHẬP</button></div>
      {message && <Notice kind={message.startsWith("Đã") ? "success" : "warning"}>{message}</Notice>}
    </Panel>

    <Panel title={`Lịch sử nhập hàng · ${month}`}>
      <div className="op-table-wrap"><table><thead><tr><th>Thời gian lưu</th><th>Số mặt hàng</th><th>Tiền hàng</th><th>Vận chuyển</th><th>Tổng cộng</th></tr></thead><tbody>{monthHistory.length === 0 ? <tr><td colSpan={5}>Chưa có phiếu nhập trong kỳ.</td></tr> : monthHistory.map((record) => <tr key={record.id}><td>{dateTime24(record.created_at)}</td><td>{Array.isArray(record.data.items) ? record.data.items.length : 0}</td><td>{money(Number(record.data.goodsCost ?? 0))}</td><td>{money(Number(record.data.shippingCost ?? 0))}</td><td><b>{money(Number(record.data.total ?? 0))}</b></td></tr>)}</tbody></table></div>
    </Panel>
  </div>;
}
