import { initDb, writeAudit } from "../../../db/runtime";
import { isVnd, sumVnd } from "../../lib/finance";
import { isOvernightShift, shiftDurationMinutes, shiftsOverlap, shiftUtcRange, validClock } from "../../lib/scheduling";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";

const allowedCategories = new Set([
  "TASKS", "MANAGER_PAYROLL", "TRANSFER", "DIVIDEND", "PROFILE",
  "CA_LAM_VIEC", "LICH_PHAN_CA", "NHAP_HANG", "CHAM_CONG",
  "LUONG_THUONG", "DONG_TIEN", "BAO_CAO", "CAI_DAT",
  "CHI_PHI_CO_DINH", "PAYROLL_CLOSING",
]);

type RecordBody = {
  id?: string;
  category?: string;
  storeId?: string | null;
  title?: string;
  data?: Record<string, unknown>;
  status?: string;
  completedIndex?: number;
};

const fixedCostKeys = ["setup", "rent", "electricity", "water", "wifi", "marketing", "other"] as const;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const datePattern = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function validDate(value: string) {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

type ValidationResult = { data?: Record<string, unknown>; message?: string };

async function validateStoreRecord(
  db: Awaited<ReturnType<typeof initDb>>,
  category: string,
  storeId: string | null,
  source: Record<string, unknown>,
  excludeId?: string,
): Promise<ValidationResult> {
  if (!["CA_LAM_VIEC", "LICH_PHAN_CA", "CHI_PHI_CO_DINH", "LUONG_THUONG"].includes(category)) return { data: source };
  if (!storeId) return { message: "Danh mục này bắt buộc phải thuộc một cửa hàng." };

  if (category === "CHI_PHI_CO_DINH") {
    const period = String(source.period ?? "");
    if (!monthPattern.test(period)) return { message: "Kỳ chi phí cố định không hợp lệ." };
    const values = Object.fromEntries(fixedCostKeys.map((key) => [key, Number(source[key] ?? 0)]));
    if (!Object.values(values).every((value) => isVnd(value) && value >= 0)) return { message: "Chi phí phải là số nguyên VND không âm." };
    const duplicate = await db.prepare("SELECT id FROM business_records WHERE category = 'CHI_PHI_CO_DINH' AND store_id = ? AND status != 'DELETED' AND json_extract(data_json, '$.period') = ? AND id != ? LIMIT 1")
      .bind(storeId, period, excludeId ?? "").first<{ id: string }>();
    if (duplicate) return { message: "Kỳ chi phí này đã tồn tại. Vui lòng mở kỳ hiện có để cập nhật." };
    return { data: { ...values, period, note: String(source.note ?? "").trim(), total: sumVnd(Object.values(values)) } };
  }

  if (category === "LUONG_THUONG") {
    const employeeId = String(source.employeeId ?? "");
    const amount = Number(source.amount);
    const kind = String(source.kind ?? "");
    const date = String(source.date ?? "");
    const note = String(source.note ?? "").trim();
    if (!employeeId || !["ALLOWANCE", "BONUS"].includes(kind) || !isVnd(amount) || amount <= 0 || !validDate(date) || !note) {
      return { message: "Khoản lương thưởng phải có nhân viên, loại, ngày, nội dung và số tiền nguyên VND dương." };
    }
    const locked = await db.prepare("SELECT id FROM business_records WHERE category = 'KPI_SUMMARY' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(storeId, date.slice(0, 7)).first<{ id: string }>();
    if (locked) return { message: "Kỳ lương đã chốt, không thể thêm hoặc sửa phụ cấp/thưởng." };
    const employee = await db.prepare("SELECT id, name FROM employees WHERE id = ? AND store_id = ? AND status != 'ARCHIVED' LIMIT 1")
      .bind(employeeId, storeId).first<{ id: string; name: string }>();
    if (!employee) return { message: "Nhân viên không thuộc cửa hàng đang thao tác." };
    return { data: { kind, employeeId, employeeName: employee.name, amount, date, note } };
  }

  const start = String(source.start ?? "");
  const end = String(source.end ?? "");
  const duration = shiftDurationMinutes(start, end);
  if (!validClock(start) || !validClock(end) || duration <= 0) return { message: "Khung giờ ca làm việc không hợp lệ." };
  if (category === "CA_LAM_VIEC") return { data: { start, end, durationMinutes: duration, overnight: isOvernightShift(start, end) } };

  const date = String(source.date ?? "");
  const shiftId = String(source.shiftId ?? "");
  const shiftName = String(source.shiftName ?? "").trim();
  const employeeIds = Array.isArray(source.employeeIds) ? [...new Set(source.employeeIds.map(String).filter(Boolean))] : [];
  const range = shiftUtcRange(date, start, end);
  if (!validDate(date) || !shiftName || !range || employeeIds.length === 0) return { message: "Lịch phân ca phải có ngày, ca và ít nhất một nhân viên." };
  const placeholders = employeeIds.map(() => "?").join(",");
  const employeeCount = await db.prepare(`SELECT COUNT(*) AS count FROM employees WHERE store_id = ? AND status != 'ARCHIVED' AND id IN (${placeholders})`)
    .bind(storeId, ...employeeIds).first<{ count: number }>();
  if (Number(employeeCount?.count ?? 0) !== employeeIds.length) return { message: "Danh sách phân ca có nhân viên không thuộc cửa hàng." };

  const existingRows = await db.prepare("SELECT id, data_json AS dataJson FROM business_records WHERE category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' AND id != ?")
    .bind(storeId, excludeId ?? "").all<{ id: string; dataJson: string }>();
  for (const row of existingRows.results) {
    try {
      const existing = JSON.parse(row.dataJson) as { date?: string; start?: string; end?: string; employeeIds?: string[] };
      const sharedEmployee = employeeIds.some((id) => existing.employeeIds?.includes(id));
      if (sharedEmployee && existing.date && existing.start && existing.end && shiftsOverlap(date, start, end, existing.date, existing.start, existing.end)) {
        return { message: "Một hoặc nhiều nhân viên đã có ca trùng thời gian." };
      }
    } catch { /* Ignore a legacy malformed row; it remains visible for manual cleanup. */ }
  }
  const employeeNames = await Promise.all(employeeIds.map(async (id) => (await db.prepare("SELECT name FROM employees WHERE id = ? LIMIT 1").bind(id).first<{ name: string }>())?.name ?? id));
  return { data: { date, shiftId, shiftName, start, end, ...range, overnight: isOvernightShift(start, end), employeeIds, employeeNames, note: String(source.note ?? "").trim() } };
}

function parseRow(row: Record<string, unknown>) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(String(row.data_json ?? "{}")); } catch { data = {}; }
  return { ...row, data };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const params = new URL(request.url).searchParams;
  const category = params.get("category") ?? "";
  if (!allowedCategories.has(category)) return json({ message: "Danh mục không hợp lệ" }, 400);
  if (user.role === "EMPLOYEE" && category !== "TASKS") return json({ message: "Không có quyền" }, 403);
  const db = await initDb();
  const requestedStore = params.get("storeId");
  const storeId = user.role === "EMPLOYEE" ? user.storeId : requestedStore;
  const result = storeId
    ? await db.prepare("SELECT * FROM business_records WHERE category = ? AND store_id = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 200").bind(category, storeId).all()
    : category === "PROFILE"
      ? await db.prepare("SELECT * FROM business_records WHERE category = ? AND store_id IS NULL AND status != 'DELETED' ORDER BY created_at DESC LIMIT 200").bind(category).all()
    : await db.prepare("SELECT * FROM business_records WHERE category = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 200").bind(category).all();
  return json({ records: result.results.map((row) => parseRow(row as Record<string, unknown>)) });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const body = await request.json().catch(() => ({})) as RecordBody;
  if (!body.category || !allowedCategories.has(body.category) || !body.title?.trim()) return json({ message: "Dữ liệu chưa đầy đủ" }, 400);
  if (user.role !== "MANAGER") return json({ message: "Chỉ quản lý được tạo dữ liệu" }, 403);
  if (body.storeId && !await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = await initDb();
  const validated = await validateStoreRecord(db, body.category, body.storeId ?? null, body.data ?? {});
  if (!validated.data) return json({ message: validated.message ?? "Dữ liệu nghiệp vụ không hợp lệ." }, 400);
  await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, body.category, body.storeId ?? null, user.id, body.title.trim(), JSON.stringify(validated.data), body.status ?? "ACTIVE", now, now).run();
  await writeAudit(user.id, "CREATE", body.category, id, body.title);
  return json({ id, message: "Đã lưu dữ liệu" }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const body = await request.json().catch(() => ({})) as RecordBody;
  if (!body.id) return json({ message: "Thiếu mã dữ liệu" }, 400);
  const db = await initDb();
  const existing = await db.prepare("SELECT * FROM business_records WHERE id = ? AND status != 'DELETED'").bind(body.id).first<Record<string, unknown>>();
  if (!existing) return json({ message: "Không tìm thấy dữ liệu" }, 404);
  const existingStoreId = existing.store_id ? String(existing.store_id) : null;
  if (existingStoreId && !await isStoreActive(existingStoreId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (user.role === "EMPLOYEE") {
    if (existing.category !== "TASKS" || existing.store_id !== user.storeId || !Number.isInteger(body.completedIndex)) return json({ message: "Không có quyền" }, 403);
    const record = parseRow(existing);
    const items = Array.isArray(record.data.items) ? record.data.items as Array<Record<string, unknown>> : [];
    const index = Number(body.completedIndex);
    if (index < 0 || index >= items.length) return json({ message: "Công việc không hợp lệ" }, 400);
    const completedBy = Array.isArray(items[index].completedBy) ? items[index].completedBy as string[] : [];
    items[index] = { ...items[index], completedBy: completedBy.includes(user.id) ? completedBy.filter((id) => id !== user.id) : [...completedBy, user.id] };
    const data = { ...record.data, items };
    await db.prepare("UPDATE business_records SET data_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(data), new Date().toISOString(), body.id).run();
    await writeAudit(user.id, "TOGGLE_TASK", "TASKS", body.id, String(index));
    return json({ ok: true, data });
  }
  const title = body.title?.trim() || String(existing.title);
  const incomingData = body.data ?? parseRow(existing).data;
  const validated = await validateStoreRecord(db, String(existing.category), existingStoreId, incomingData, body.id);
  if (!validated.data) return json({ message: validated.message ?? "Dữ liệu nghiệp vụ không hợp lệ." }, 400);
  const data = validated.data;
  await db.prepare("UPDATE business_records SET title = ?, data_json = ?, status = ?, updated_at = ? WHERE id = ?")
    .bind(title, JSON.stringify(data), body.status ?? String(existing.status), new Date().toISOString(), body.id).run();
  await writeAudit(user.id, "UPDATE", String(existing.category), body.id, title);
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ message: "Thiếu mã dữ liệu" }, 400);
  const db = await initDb();
  const existing = await db.prepare("SELECT store_id AS storeId, category, data_json AS dataJson FROM business_records WHERE id = ? AND status != 'DELETED' LIMIT 1")
    .bind(id).first<{ storeId: string | null; category: string; dataJson: string }>();
  if (!existing) return json({ message: "Không tìm thấy dữ liệu" }, 404);
  if (existing.storeId && !await isStoreActive(existing.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (existing.category === "LUONG_THUONG" && existing.storeId) {
    let period = "";
    try { period = String((JSON.parse(existing.dataJson) as { date?: string }).date ?? "").slice(0, 7); } catch { period = ""; }
    const locked = period ? await db.prepare("SELECT id FROM business_records WHERE category = 'KPI_SUMMARY' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
      .bind(existing.storeId, period).first<{ id: string }>() : null;
    if (locked) return json({ message: "Kỳ lương đã chốt, không thể xóa phụ cấp/thưởng." }, 409);
  }
  await db.prepare("UPDATE business_records SET status = 'DELETED', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
  await writeAudit(user.id, "DELETE", "BUSINESS_RECORD", id);
  return json({ ok: true });
}
