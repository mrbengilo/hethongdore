"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { money, Notice, Panel, StoreFinance } from "./shared";

type Employee = {
  id: string; code: string; name: string; position: string; phone: string; age: number | null; hourly_rate: number;
  address_province: string | null; address_ward: string | null; address_detail: string | null; cccd_image: string | null; username?: string;
};

type FormState = {
  code: string; name: string; phone: string; age: string; addressProvince: string; addressWard: string; addressDetail: string;
  cccdImage: string; position: string; hourlyRate: string; username: string; password: string;
};

const empty: FormState = { code: "", name: "", phone: "", age: "", addressProvince: "", addressWard: "", addressDetail: "", cccdImage: "", position: "Nhân viên bán hàng", hourlyRate: "20000", username: "", password: "" };

export default function EmployeesPanel({ store }: { store: StoreFinance }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [form, setForm] = useState<FormState>(empty);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const reload = useCallback(async () => {
    const response = await fetch(`/api/employees?storeId=${encodeURIComponent(store.id)}`);
    const result = await response.json();
    setEmployees(result.employees ?? []);
  }, [store.id]);
  useEffect(() => { void reload(); }, [reload]);

  function chooseCccd(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setMessage("CCCD phải là file hình ảnh.");
    if (file.size > 1_500_000) return setMessage("Ảnh CCCD tối đa 1.5MB.");
    const reader = new FileReader();
    reader.onload = () => setForm((current) => ({ ...current, cccdImage: String(reader.result ?? "") }));
    reader.readAsDataURL(file);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/employees", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, storeId: store.id }),
    });
    const result = await response.json();
    if (!response.ok) return setMessage(result.message ?? "Không thể thêm nhân viên");
    setForm(empty); setOpen(false); setMessage("Đã lưu nhân viên mới."); await reload();
  }

  async function archive(id: string) {
    if (!confirm("Lưu trữ nhân viên này? Lịch sử ca, lương và đơn hàng vẫn được giữ lại.")) return;
    await fetch(`/api/employees?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await reload();
  }

  return <div className="op-stack">
    <Panel title={`Nhân viên · ${store.name}`} action={<button className="op-primary" onClick={() => { setForm(empty); setMessage(""); setOpen(true); }}>＋ THÊM NHÂN VIÊN</button>}>
      <div className="op-table-wrap"><table><thead><tr><th>Mã NV</th><th>Tên nhân viên</th><th>SĐT</th><th>Tuổi</th><th>Địa chỉ</th><th>CCCD</th><th>Lương/giờ</th><th>Tài khoản</th><th></th></tr></thead><tbody>{employees.length === 0 ? <tr><td colSpan={9}>Chưa có nhân viên.</td></tr> : employees.map((employee) => <tr key={employee.id}><td><b>{employee.code}</b></td><td>{employee.name}<small className="op-subline">{employee.position}</small></td><td>{employee.phone}</td><td>{employee.age ?? "—"}</td><td>{[employee.address_detail, employee.address_ward, employee.address_province].filter(Boolean).join(", ") || "—"}</td><td>{employee.cccd_image ? <img className="op-cccd-thumb" src={employee.cccd_image} alt={`CCCD ${employee.name}`} /> : "—"}</td><td>{money(employee.hourly_rate)}</td><td>{employee.username ?? "—"}</td><td><button className="op-danger-link" onClick={() => archive(employee.id)}>Lưu trữ</button></td></tr>)}</tbody></table></div>
    </Panel>
    {message && <Notice kind={message.startsWith("Đã") ? "success" : "warning"}>{message}</Notice>}

    {open && <div className="op-modal-backdrop"><form className="op-modal" onSubmit={save}>
      <div className="op-modal-head"><div><h2>Thêm nhân viên</h2><p>{store.name}</p></div><button type="button" onClick={() => setOpen(false)}>×</button></div>
      <div className="op-form-grid three">
        <label>Mã nhân viên<input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
        <label>Tên nhân viên<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>SĐT<input required inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
        <label>Tuổi<input required type="number" min="16" max="100" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} /></label>
        <label>Tỉnh / Thành phố<input required value={form.addressProvince} onChange={(e) => setForm({ ...form, addressProvince: e.target.value })} placeholder="Cần Thơ" /></label>
        <label>Phường / Xã<input required value={form.addressWard} onChange={(e) => setForm({ ...form, addressWard: e.target.value })} placeholder="Phường/Xã" /></label>
        <label>Đường / Ấp<input required value={form.addressDetail} onChange={(e) => setForm({ ...form, addressDetail: e.target.value })} placeholder="Số nhà, đường hoặc ấp" /></label>
        <label>Chức vụ<input required value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} /></label>
        <label>Lương theo giờ<input required type="number" min="1" value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })} /></label>
        <label>Tên đăng nhập<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>Mật khẩu<input required type="password" minLength={6} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>CCCD (hình ảnh)<input required type="file" accept="image/*" onChange={(e) => chooseCccd(e.target.files?.[0])} /></label>
      </div>
      {form.cccdImage && <div className="op-cccd-preview"><img src={form.cccdImage} alt="Xem trước CCCD" /><span>Ảnh CCCD đã sẵn sàng lưu.</span></div>}
      {message && <Notice kind="warning">{message}</Notice>}
      <div className="op-modal-actions"><button type="button" onClick={() => setOpen(false)}>Hủy</button><button className="op-primary" type="submit">LƯU</button></div>
    </form></div>}
  </div>;
}
