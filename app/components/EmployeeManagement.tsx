"use client";

/* eslint-disable @next/next/no-img-element -- Ảnh CCCD dùng URL xem trước cục bộ hoặc API riêng tư, không phù hợp bộ tối ưu ảnh công khai. */

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Edit3, IdCard, Plus, Save, Search, Upload, UserRound, X } from "lucide-react";

type EmployeeStore = {
  id: string;
  name: string;
  status?: string;
};

type Employee = {
  id: string;
  storeId: string;
  code: string;
  name: string;
  phone: string;
  province: string;
  ward: string;
  addressLine: string;
  age: number;
  position: string;
  hourlyRate: number;
  username: string;
  status: "ACTIVE" | "INACTIVE";
  cccdImageKey: string;
  cccdImageName: string;
};

type EmployeeForm = {
  code: string;
  name: string;
  phone: string;
  province: string;
  ward: string;
  addressLine: string;
  age: string;
  position: string;
  hourlyRate: string;
  username: string;
  password: string;
  status: "ACTIVE" | "INACTIVE";
  cccdImageKey: string;
  cccdImageName: string;
};

const MAX_CCCD_BYTES = 5 * 1024 * 1024;
const ALLOWED_CCCD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function emptyEmployeeForm(): EmployeeForm {
  return {
    code: "",
    name: "",
    phone: "",
    province: "",
    ward: "",
    addressLine: "",
    age: "",
    position: "Nhân viên bán hàng",
    hourlyRate: "20000",
    username: "",
    password: "",
    status: "ACTIVE",
    cccdImageKey: "",
    cccdImageName: "",
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeEmployee(value: unknown): Employee | null {
  const row = asObject(value);
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    storeId: String(row.store_id ?? row.storeId ?? ""),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    phone: String(row.phone ?? ""),
    province: String(row.province ?? ""),
    ward: String(row.ward ?? ""),
    addressLine: String(row.address_line ?? row.addressLine ?? ""),
    age: Number(row.age ?? 0),
    position: String(row.position ?? ""),
    hourlyRate: Number(row.hourly_rate ?? row.hourlyRate ?? 0),
    username: String(row.username ?? ""),
    status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    cccdImageKey: String(row.cccd_image_key ?? row.cccdImageKey ?? ""),
    cccdImageName: String(row.cccd_image_name ?? row.cccdImageName ?? ""),
  };
}

function formatMoney(value: number) {
  const safeValue = Number.isFinite(value) ? Math.round(value) : 0;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(safeValue)} đồng`;
}

function imageUrl(key: string) {
  return key ? `/api/uploads?key=${encodeURIComponent(key)}` : "";
}

function fullAddress(employee: Pick<Employee, "province" | "ward" | "addressLine">) {
  return [employee.addressLine, employee.ward, employee.province].filter(Boolean).join(", ") || "—";
}

function EmployeePhoto({ employee, size = 46 }: { employee: Employee; size?: number }) {
  if (!employee.cccdImageKey) return <span>Chưa có</span>;
  return <a href={imageUrl(employee.cccdImageKey)} target="_blank" rel="noreferrer" title={employee.cccdImageName || "Xem ảnh CCCD"}>
    <img
      src={imageUrl(employee.cccdImageKey)}
      alt={`CCCD của ${employee.name}`}
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "cover", borderRadius: 7, border: "1px solid #dce5df" }}
    />
  </a>;
}

export function StoreEmployeeManagement({ store }: { store: EmployeeStore }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form, setForm] = useState<EmployeeForm>(emptyEmployeeForm);
  const [cccdFile, setCccdFile] = useState<File | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState("");
  const [fileInputVersion, setFileInputVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingLabel, setSavingLabel] = useState("");
  const [listError, setListError] = useState("");
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const inactive = store.status === "INACTIVE";

  const reload = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      const response = await fetch(`/api/employees?storeId=${encodeURIComponent(store.id)}`);
      const result = await response.json().catch(() => ({})) as { employees?: unknown[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể tải danh sách nhân viên.");
      setEmployees((result.employees ?? []).map(normalizeEmployee).filter((employee): employee is Employee => employee !== null));
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Không thể tải danh sách nhân viên.");
    } finally {
      setLoading(false);
    }
  }, [store.id]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!cccdFile) {
      setLocalPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(cccdFile);
    setLocalPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cccdFile]);

  const filteredEmployees = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("vi-VN");
    return employees.filter((employee) => {
      const matchesStatus = statusFilter === "ALL" || employee.status === statusFilter;
      const searchValue = [employee.code, employee.name, employee.phone, employee.username, fullAddress(employee)].join(" ").toLocaleLowerCase("vi-VN");
      return matchesStatus && (!needle || searchValue.includes(needle));
    });
  }, [employees, query, statusFilter]);

  function begin(employee?: Employee) {
    setEditing(employee ?? null);
    setForm(employee ? {
      code: employee.code,
      name: employee.name,
      phone: employee.phone,
      province: employee.province,
      ward: employee.ward,
      addressLine: employee.addressLine,
      age: employee.age ? String(employee.age) : "",
      position: employee.position,
      hourlyRate: String(employee.hourlyRate),
      username: employee.username,
      password: "",
      status: employee.status,
      cccdImageKey: employee.cccdImageKey,
      cccdImageName: employee.cccdImageName,
    } : emptyEmployeeForm());
    setCccdFile(null);
    setFileInputVersion((current) => current + 1);
    setFormError("");
    setSuccess("");
    setSavingLabel("");
    setOpen(true);
  }

  function updateForm<K extends keyof EmployeeForm>(field: K, value: EmployeeForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError("");
  }

  function chooseCccd(file: File | null) {
    setFormError("");
    if (!file) {
      setCccdFile(null);
      return;
    }
    if (!ALLOWED_CCCD_TYPES.has(file.type)) {
      setCccdFile(null);
      setFileInputVersion((current) => current + 1);
      return setFormError("Ảnh CCCD chỉ hỗ trợ JPG, PNG hoặc WebP.");
    }
    if (file.size <= 0 || file.size > MAX_CCCD_BYTES) {
      setCccdFile(null);
      setFileInputVersion((current) => current + 1);
      return setFormError("Ảnh CCCD phải có dung lượng lớn hơn 0 và không quá 5 MB.");
    }
    setCccdFile(file);
  }

  function validateForm() {
    if (!form.code.trim() || !form.name.trim() || !form.phone.trim()) return "Vui lòng nhập mã, tên và số điện thoại nhân viên.";
    if (!form.province.trim() || !form.ward.trim() || !form.addressLine.trim()) return "Vui lòng nhập đủ tỉnh, phường và đường/ấp.";
    const age = Number(form.age);
    if (!Number.isInteger(age) || age < 15 || age > 100) return "Tuổi nhân viên phải là số nguyên từ 15 đến 100.";
    const hourlyRate = Number(form.hourlyRate);
    if (!Number.isSafeInteger(hourlyRate) || hourlyRate <= 0) return "Lương theo giờ phải là số nguyên dương.";
    if (!form.position.trim()) return "Vui lòng chọn chức vụ.";
    if (!form.username.trim()) return "Vui lòng nhập tên đăng nhập.";
    if (!editing && form.password.length < 6) return "Mật khẩu phải có ít nhất 6 ký tự.";
    if (editing && form.password && form.password.length < 6) return "Mật khẩu mới phải có ít nhất 6 ký tự.";
    if (!form.cccdImageKey && !cccdFile) return "Ảnh CCCD là bắt buộc.";
    return "";
  }

  async function uploadCccd() {
    if (!cccdFile) return { key: form.cccdImageKey, name: form.cccdImageName };
    setSavingLabel("Đang tải ảnh CCCD...");
    const upload = new FormData();
    upload.append("file", cccdFile);
    const response = await fetch("/api/uploads", { method: "POST", body: upload });
    const result = await response.json().catch(() => ({})) as { key?: string; name?: string; message?: string };
    if (!response.ok || !result.key) throw new Error(result.message ?? "Không thể tải ảnh CCCD.");
    const uploaded = { key: result.key, name: result.name ?? cccdFile.name };
    setForm((current) => ({ ...current, cccdImageKey: uploaded.key, cccdImageName: uploaded.name }));
    setCccdFile(null);
    setFileInputVersion((current) => current + 1);
    return uploaded;
  }

  async function saveEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setSuccess("");
    if (inactive) return setFormError("Cửa hàng đang ngưng hoạt động, không thể lưu nhân viên.");
    const validationMessage = validateForm();
    if (validationMessage) return setFormError(validationMessage);

    setSaving(true);
    try {
      const image = await uploadCccd();
      setSavingLabel(editing ? "Đang cập nhật nhân viên..." : "Đang tạo nhân viên...");
      const response = await fetch("/api/employees", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editing?.id,
          storeId: store.id,
          code: form.code.trim(),
          name: form.name.trim(),
          phone: form.phone.trim(),
          province: form.province.trim(),
          ward: form.ward.trim(),
          addressLine: form.addressLine.trim(),
          age: Number(form.age),
          position: form.position.trim(),
          hourlyRate: Number(form.hourlyRate),
          username: form.username.trim(),
          password: form.password,
          status: form.status,
          cccdImageKey: image.key,
          cccdImageName: image.name,
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string; storeId?: string };
      if (!response.ok) throw new Error(result.message ?? "Không thể lưu nhân viên.");
      if (!editing && result.storeId !== store.id) throw new Error("Nhân viên chưa được gắn đúng cửa hàng.");

      setOpen(false);
      setSuccess(editing ? "Đã cập nhật nhân viên." : "Đã thêm nhân viên và tạo tài khoản đăng nhập.");
      await reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Không thể lưu nhân viên.");
    } finally {
      setSaving(false);
      setSavingLabel("");
    }
  }

  const previewUrl = localPreviewUrl || imageUrl(form.cccdImageKey);

  return <div className="reference-module employee-management">
    <div className="ref-toolbar">
      <div>
        <h2>Quản lý nhân viên</h2>
        <p>Hồ sơ, địa chỉ, ảnh CCCD và tài khoản của nhân viên tại {store.name}</p>
      </div>
      <div className="ref-toolbar-actions">
        <label className="ref-search"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm mã, tên, SĐT, địa chỉ..."/></label>
        <select aria-label="Lọc trạng thái" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
          <option value="ALL">Tất cả trạng thái</option>
          <option value="ACTIVE">Đang làm việc</option>
          <option value="INACTIVE">Nghỉ làm</option>
        </select>
        <button type="button" className="primary-button" disabled={inactive} onClick={() => begin()}><Plus size={17}/> Thêm nhân viên</button>
      </div>
    </div>

    {inactive && <div className="form-message">Cửa hàng đang ngưng hoạt động. Bạn vẫn xem hồ sơ nhưng không thể thêm hoặc sửa nhân viên.</div>}
    {listError && <div className="form-message">{listError}</div>}
    {success && !open && <div className="success-banner">{success}</div>}

    <div className={`employee-ref-layout ${open ? "with-drawer" : ""}`}>
      <section className="table-card">
        <div className="table-head"><div><h2>Danh sách nhân viên</h2><p>{filteredEmployees.length} / {employees.length} nhân viên</p></div></div>
        <div className="data-table-wrap">
          <table className="data-table employee-management-table" style={{ minWidth: 1510 }}>
            <thead><tr>
              <th>Mã NV</th><th>Nhân viên</th><th>SĐT</th><th>Địa chỉ</th><th>Tuổi</th>
              <th>Chức vụ</th><th>Lương/giờ</th><th>Username</th><th>Ảnh CCCD</th>
              <th>Trạng thái</th><th>Thao tác</th>
            </tr></thead>
            <tbody>{loading ? <tr><td colSpan={11} className="empty-cell">Đang tải danh sách nhân viên...</td></tr> : filteredEmployees.length === 0 ? <tr><td colSpan={11} className="empty-cell">Không có nhân viên phù hợp.</td></tr> : filteredEmployees.map((employee) => <tr key={employee.id}>
              <td><b>{employee.code}</b></td>
              <td><div style={{ display: "flex", alignItems: "center", gap: 9 }}><i style={{ width: 35, height: 35, display: "grid", placeItems: "center", borderRadius: "50%", background: "#e7f5ea", color: "#087d36" }}><UserRound size={18}/></i><b>{employee.name}</b></div></td>
              <td>{employee.phone}</td>
              <td title={fullAddress(employee)} style={{ maxWidth: 260, whiteSpace: "normal" }}>{fullAddress(employee)}</td>
              <td>{employee.age || "—"}</td>
              <td>{employee.position}</td>
              <td><b>{formatMoney(employee.hourlyRate)}</b></td>
              <td>{employee.username || "—"}</td>
              <td><EmployeePhoto employee={employee}/></td>
              <td><span className={`status-pill ${employee.status === "INACTIVE" ? "inactive" : ""}`}>● {employee.status === "ACTIVE" ? "Đang làm việc" : "Nghỉ làm"}</span></td>
              <td><button type="button" disabled={inactive} onClick={() => begin(employee)} aria-label={`Sửa ${employee.name}`}><Edit3 size={16}/></button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      {open && <aside className="employee-drawer">
        <form onSubmit={saveEmployee}>
          <div className="drawer-title">
            <div><h2>{editing ? "Cập nhật nhân viên" : "Thêm nhân viên"}</h2><span>{store.name}</span></div>
            <button type="button" disabled={saving} onClick={() => setOpen(false)}><X size={19}/></button>
          </div>

          <fieldset disabled={saving || inactive} style={{ border: 0, margin: 0, padding: 0 }}>
            <h3>Thông tin nhân viên</h3>
            <div className="form-grid two">
              <label>Mã nhân viên *<input required value={form.code} onChange={(event) => updateForm("code", event.target.value)} placeholder="NV001"/></label>
              <label>Tên nhân viên *<input required value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="Họ và tên"/></label>
              <label>Số điện thoại *<input required inputMode="tel" value={form.phone} onChange={(event) => updateForm("phone", event.target.value)} placeholder="Số điện thoại"/></label>
              <label>Tuổi *<input type="number" min="15" max="100" step="1" required value={form.age} onChange={(event) => updateForm("age", event.target.value)}/></label>
              <label>Chức vụ *<select value={form.position} onChange={(event) => updateForm("position", event.target.value)}><option>Nhân viên bán hàng</option><option>Thu ngân</option><option>Kho</option><option>Quản lý ca</option></select></label>
              <label>Lương theo giờ *<input type="number" min="1" step="1" required value={form.hourlyRate} onChange={(event) => updateForm("hourlyRate", event.target.value)}/><small>{formatMoney(Number(form.hourlyRate || 0))}/giờ</small></label>
            </div>

            <h3>Địa chỉ</h3>
            <div className="form-grid two">
              <label>Tỉnh/Thành phố *<input required value={form.province} onChange={(event) => updateForm("province", event.target.value)} placeholder="Ví dụ: Cần Thơ"/></label>
              <label>Phường/Xã *<input required value={form.ward} onChange={(event) => updateForm("ward", event.target.value)} placeholder="Ví dụ: Phường Thốt Nốt"/></label>
            </div>
            <label>Đường/Ấp *<input required value={form.addressLine} onChange={(event) => updateForm("addressLine", event.target.value)} placeholder="Số nhà, tên đường hoặc ấp"/></label>

            <h3>Ảnh CCCD *</h3>
            <div style={{ display: "grid", gap: 12, padding: 14, border: "1px solid #dce5df", borderRadius: 10, background: "#f8fbf9" }}>
              {previewUrl ? <a href={previewUrl} target="_blank" rel="noreferrer"><img src={previewUrl} alt="Xem trước ảnh CCCD" style={{ width: "100%", maxHeight: 230, objectFit: "contain", borderRadius: 8, background: "#fff" }}/></a> : <div style={{ minHeight: 110, display: "grid", placeItems: "center", color: "#667085" }}><IdCard size={38}/><span>Chưa chọn ảnh CCCD</span></div>}
              <label><Upload size={16}/> {form.cccdImageKey ? "Chọn ảnh CCCD mới" : "Chọn ảnh CCCD"}<input key={fileInputVersion} type="file" accept="image/jpeg,image/png,image/webp" required={!form.cccdImageKey} onChange={(event) => chooseCccd(event.target.files?.[0] ?? null)}/></label>
              <small>JPG, PNG hoặc WebP · tối đa 5 MB{cccdFile ? ` · Đã chọn: ${cccdFile.name}` : form.cccdImageName ? ` · Hiện tại: ${form.cccdImageName}` : ""}</small>
            </div>

            <h3>Tài khoản đăng nhập</h3>
            <label>Tên đăng nhập *<input required autoComplete="off" value={form.username} onChange={(event) => updateForm("username", event.target.value)} placeholder="Tên đăng nhập"/></label>
            <label>{editing ? "Mật khẩu mới (để trống nếu giữ nguyên)" : "Mật khẩu *"}<input type="password" minLength={6} required={!editing} autoComplete="new-password" value={form.password} onChange={(event) => updateForm("password", event.target.value)}/></label>
            {editing && <label>Trạng thái<select value={form.status} onChange={(event) => updateForm("status", event.target.value as EmployeeForm["status"])}><option value="ACTIVE">Đang làm việc</option><option value="INACTIVE">Nghỉ làm</option></select></label>}
          </fieldset>

          {formError && <div className="form-message">{formError}</div>}
          {savingLabel && <div className="success-banner">{savingLabel}</div>}
          <div className="drawer-actions">
            <button type="button" disabled={saving} onClick={() => setOpen(false)}>Hủy bỏ</button>
            <button type="submit" className="primary-button" disabled={saving || inactive}><Save size={17}/> {saving ? "ĐANG LƯU..." : "LƯU NHÂN VIÊN"}</button>
          </div>
        </form>
      </aside>}
    </div>
  </div>;
}
