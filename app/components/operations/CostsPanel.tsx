"use client";

import { FormEvent, useMemo, useState } from "react";
import { createRecord, dateTime24, money, Notice, Panel, StoreFinance, useRecords } from "./shared";

const fixedNames = ["Set up", "Điện", "Nước", "Wifi", "Rác", "Marketing", "Khác"];

export default function CostsPanel({ store, month, onChanged }: { store: StoreFinance; month: string; onChanged: () => Promise<void> | void }) {
  const [showFixed, setShowFixed] = useState(true);
  const [fixed, setFixed] = useState<Record<string, string>>(() => Object.fromEntries(fixedNames.map((name) => [name, ""])));
  const [variableName, setVariableName] = useState("");
  const [variableAmount, setVariableAmount] = useState("");
  const [variableNote, setVariableNote] = useState("");
  const [message, setMessage] = useState("");
  const fixedRecords = useRecords("CHI_PHI_CO_DINH", store.id);
  const variableRecords = useRecords("CHI_PHI_PHAT_SINH", store.id);
  const fixedTotal = useMemo(() => fixedNames.reduce((sum, name) => sum + Number(fixed[name] || 0), 0), [fixed]);
  const monthFixed = fixedRecords.records.filter((record) => String(record.data.period ?? "") === month);
  const monthVariable = variableRecords.records.filter((record) => String(record.data.period ?? "") === month);

  async function saveFixed(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    const items = fixedNames.map((name) => ({ name, amount: Number(fixed[name] || 0) }));
    try {
      await createRecord("CHI_PHI_CO_DINH", store.id, `Chi phí cố định ${store.name} · ${month}`, { period: month, items, total: fixedTotal, savedAt: new Date().toISOString() });
      setMessage("Đã lưu chi phí cố định và ghi nhận đầy đủ thời gian cập nhật.");
      await fixedRecords.reload();
      await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Không thể lưu chi phí cố định"); }
  }

  async function saveVariable(event: FormEvent) {
    event.preventDefault();
    const amount = Number(variableAmount || 0);
    if (!variableName.trim() || amount <= 0) return setMessage("Vui lòng nhập tên khoản chi và số tiền lớn hơn 0.");
    try {
      await createRecord("CHI_PHI_PHAT_SINH", store.id, variableName.trim(), { period: month, amount, note: variableNote.trim(), savedAt: new Date().toISOString() });
      setVariableName(""); setVariableAmount(""); setVariableNote(""); setMessage("Đã lưu chi phí phát sinh.");
      await variableRecords.reload();
      await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Không thể lưu chi phí"); }
  }

  return <div className="op-stack">
    <div className="op-stats four">
      <div className="op-mini"><span>Chi phí cố định</span><b>{money(store.expenseBreakdown.fixed)}</b></div>
      <div className="op-mini"><span>Chi phí phát sinh</span><b>{money(store.expenseBreakdown.variable)}</b></div>
      <div className="op-mini"><span>Nhập hàng + vận chuyển</span><b>{money(store.expenseBreakdown.inventory + store.expenseBreakdown.shipping)}</b></div>
      <div className="op-mini"><span>Tổng tất cả chi phí</span><b>{money(store.expense)}</b></div>
    </div>

    <Panel title="Chi phí cố định" action={<button className="op-primary" onClick={() => setShowFixed((value) => !value)}>＋ TẠO CHI PHÍ CỐ ĐỊNH</button>}>
      {showFixed && <form className="op-form" onSubmit={saveFixed}>
        <div className="op-form-grid four">{fixedNames.map((name) => <label key={name}>{name}<input type="number" min="0" step="1000" value={fixed[name]} onChange={(event) => setFixed({ ...fixed, [name]: event.target.value })} placeholder="0" /></label>)}</div>
        <div className="op-total-row"><span>Tổng chi phí cố định kỳ {month}</span><strong>{money(fixedTotal)}</strong><button className="op-primary" type="submit">LƯU</button></div>
      </form>}
      <div className="op-history"><h3>Lịch sử cập nhật chi phí cố định</h3>{monthFixed.length === 0 ? <p>Chưa có lịch sử trong kỳ này.</p> : <div className="op-table-wrap"><table><thead><tr><th>Thời gian cập nhật</th><th>Tổng tiền</th><th>Người thao tác</th></tr></thead><tbody>{monthFixed.map((record) => <tr key={record.id}><td>{dateTime24(record.created_at)}</td><td>{money(Number(record.data.total ?? 0))}</td><td>Quản lý</td></tr>)}</tbody></table></div>}</div>
    </Panel>

    <Panel title="Chi phí phát sinh">
      <form className="op-form-inline" onSubmit={saveVariable}><label>Khoản chi<input value={variableName} onChange={(event) => setVariableName(event.target.value)} placeholder="Ví dụ: sửa chữa, vật tư..." /></label><label>Số tiền<input type="number" min="1" value={variableAmount} onChange={(event) => setVariableAmount(event.target.value)} placeholder="0" /></label><label>Ghi chú<input value={variableNote} onChange={(event) => setVariableNote(event.target.value)} placeholder="Nội dung chi" /></label><button className="op-primary">LƯU CHI PHÍ</button></form>
      <div className="op-table-wrap"><table><thead><tr><th>Thời gian</th><th>Khoản chi</th><th>Số tiền</th><th>Ghi chú</th></tr></thead><tbody>{monthVariable.map((record) => <tr key={record.id}><td>{dateTime24(record.created_at)}</td><td>{record.title}</td><td>{money(Number(record.data.amount ?? 0))}</td><td>{String(record.data.note ?? "—")}</td></tr>)}</tbody></table></div>
    </Panel>
    {message && <Notice kind={message.startsWith("Đã") ? "success" : "warning"}>{message}</Notice>}
  </div>;
}
