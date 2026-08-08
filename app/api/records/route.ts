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

const protectedCategories = new Set(["KPI_SUMMARY", "PAYROLL_CLOSING", "DIVIDEND"]);
const immutableHistoryCategories = new Set(["NHAP_HANG"]);
const payrollSensitiveCategories = new Set(["LUONG_THUONG", "CHI_PHI_CO_DINH", "DONG_TIEN", "NHAP_HANG"]);

const existingPeriodLockGuardSql = `NOT EXISTS (
  SELECT 1 FROM business_records AS period_lock
  WHERE period_lock.category = 'KPI_SUMMARY'
    AND period_lock.store_id = business_records.store_id
    AND period_lock.status IN ('CLOSING', 'LOCKED')
    AND json_extract(period_lock.data_json, '$.period') = CASE
      WHEN business_records.category = 'CHI_PHI_CO_DINH' THEN json_extract(business_records.data_json, '$.period')
      ELSE COALESCE(json_extract(business_records.data_json, '$.period'), substr(json_extract(business_records.data_json, '$.date'), 1, 7))
    END
)`;
const incomingPeriodLockGuardSql = `NOT EXISTS (
  SELECT 1 FROM business_records AS period_lock
  WHERE period_lock.category = 'KPI_SUMMARY'
    AND period_lock.store_id = ?
    AND period_lock.status IN ('CLOSING', 'LOCKED')
    AND json_extract(period_lock.data_json, '$.period') = ?
)`;
const existingEmployeeLockGuardSql = `NOT EXISTS (
  SELECT 1 FROM employee_payroll_closings AS employee_lock
  WHERE employee_lock.store_id = business_records.store_id
    AND employee_lock.employee_id = json_extract(business_records.data_json, '$.employeeId')
    AND employee_lock.period = COALESCE(json_extract(business_records.data_json, '$.period'), substr(json_extract(business_records.data_json, '$.date'), 1, 7))
    AND employee_lock.status IN ('CLOSING', 'BASE_LOCKED', 'LOCKED')
)`;
const incomingEmployeeLockGuardSql = `NOT EXISTS (
  SELECT 1 FROM employee_payroll_closings AS employee_lock
  WHERE employee_lock.store_id = ?
    AND employee_lock.employee_id = ?
    AND employee_lock.period = ?
    AND employee_lock.status IN ('CLOSING', 'BASE_LOCKED', 'LOCKED')
)`;

type RecordBody = {
  id?: string;
  category?: string;
  storeId?: string | null;
  title?: string;
  data?: Record<string, unknown>;
  status?: string;
  completedIndex?: number;
};

const fixedCostDefinitions = [
  ["setup", "Set up"],
  ["rent", "Mặt bằng"],
  ["electricity", "Điện"],
  ["water", "Nước"],
  ["wifi", "Wifi"],
  ["marketing", "Marketing"],
  ["garbage", "Rác"],
  ["other", "Khác"],
] as const;
const fixedCostKeys = fixedCostDefinitions.map(([key]) => key);
type FixedCostKey = (typeof fixedCostDefinitions)[number][0];
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const datePattern = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

function financialWriteScope(category: string, storeId: string | null, data: Record<string, unknown>) {
  if (!payrollSensitiveCategories.has(category) || !storeId) return null;
  const period = category === "CHI_PHI_CO_DINH"
    ? String(data.period ?? "")
    : String(data.period ?? String(data.date ?? "").slice(0, 7));
  if (!monthPattern.test(period)) return null;
  return {
    storeId,
    period,
    employeeId: category === "LUONG_THUONG" ? String(data.employeeId ?? "") : "",
  };
}

function periodLockMessage() {
  return json({ message: "K\u1ef3 d\u1eef li\u1ec7u \u0111ang \u0111\u01b0\u1ee3c ch\u1ed1t ho\u1eb7c \u0111\u00e3 kh\u00f3a s\u1ed5, kh\u00f4ng th\u1ec3 thay \u0111\u1ed5i." }, 423);
}

function validDate(value: string) {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

async function isPayrollPeriodLocked(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  period: string,
) {
  const locked = await db.prepare("SELECT id FROM business_records WHERE category = 'KPI_SUMMARY' AND store_id = ? AND status = 'LOCKED' AND json_extract(data_json, '$.period') = ? LIMIT 1")
    .bind(storeId, period).first<{ id: string }>();
  return Boolean(locked);
}

async function isEmployeePayrollLocked(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  period: string,
  employeeId: string,
) {
  const locked = await db.prepare("SELECT id FROM employee_payroll_closings WHERE store_id = ? AND employee_id = ? AND period = ? AND status IN ('BASE_LOCKED', 'LOCKED') LIMIT 1")
    .bind(storeId, employeeId, period).first<{ id: string }>();
  return Boolean(locked);
}

type ValidationResult = { data?: Record<string, unknown>; message?: string };

async function validateStoreRecord(
  db: Awaited<ReturnType<typeof initDb>>,
  category: string,
  storeId: string | null,
  source: Record<string, unknown>,
  excludeId?: string,
): Promise<ValidationResult> {
  if (!["CA_LAM_VIEC", "LICH_PHAN_CA", "CHI_PHI_CO_DINH", "LUONG_THUONG", "NHAP_HANG", "DONG_TIEN"].includes(category)) return { data: source };
  if (!storeId) return { message: "Danh mục này bắt buộc phải thuộc một cửa hàng." };

  if (category === "CHI_PHI_CO_DINH") {
    const period = String(source.period ?? "");
    if (!monthPattern.test(period)) return { message: "Kỳ chi phí cố định không hợp lệ." };
    if (await isPayrollPeriodLocked(db, storeId, period)) return { message: "Kỳ đã chốt lương và KPI, không thể thay đổi chi phí cố định." };
    const rawItems = source.items;
    let values: Record<FixedCostKey, number>;
    let items: Array<{ key: FixedCostKey | null; name: string; amount: number }>;

    if (rawItems !== undefined) {
      if (!Array.isArray(rawItems) || rawItems.length < fixedCostKeys.length || rawItems.length > 100) {
        return { message: "Danh sách chi phí phải có đủ 8 khoản mặc định và tối đa 100 khoản." };
      }
      const standardValues = Object.fromEntries(fixedCostKeys.map((key) => [key, 0])) as Record<FixedCostKey, number>;
      const seenKeys = new Set<FixedCostKey>();
      items = [];
      for (let index = 0; index < rawItems.length; index += 1) {
        const rawItem = rawItems[index];
        if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return { message: `Dòng chi phí ${index + 1} không hợp lệ.` };
        const item = rawItem as Record<string, unknown>;
        const rawKey = String(item.key ?? "");
        const definition = fixedCostDefinitions.find(([key]) => key === rawKey);
        const key = definition?.[0] ?? null;
        const name = key ? definition?.[1] ?? "" : String(item.name ?? "").trim();
        const amount = Number(item.amount);
        if (!name || !isVnd(amount) || amount < 0) return { message: `Dòng chi phí ${index + 1} phải có tên và số tiền nguyên VND không âm.` };
        if (key) {
          if (seenKeys.has(key)) return { message: `Khoản chi phí mặc định “${name}” bị trùng.` };
          seenKeys.add(key);
          standardValues[key] = amount;
        }
        items.push({ key, name, amount });
      }
      if (seenKeys.size !== fixedCostKeys.length) return { message: "Danh sách chi phí phải có đủ 8 khoản mặc định." };
      values = standardValues;
    } else {
      values = Object.fromEntries(fixedCostKeys.map((key) => [key, Number(source[key] ?? 0)])) as Record<FixedCostKey, number>;
      if (!Object.values(values).every((value) => isVnd(value) && value >= 0)) return { message: "Chi phí phải là số nguyên VND không âm." };
      items = fixedCostDefinitions.map(([key, name]) => ({ key, name, amount: values[key] }));
    }
    const duplicate = await db.prepare("SELECT id FROM business_records WHERE category = 'CHI_PHI_CO_DINH' AND store_id = ? AND status != 'DELETED' AND json_extract(data_json, '$.period') = ? AND id != ? LIMIT 1")
      .bind(storeId, period, excludeId ?? "").first<{ id: string }>();
    if (duplicate) return { message: "Kỳ chi phí này đã tồn tại. Vui lòng mở kỳ hiện có để cập nhật." };
    return { data: { ...values, period, note: String(source.note ?? "").trim(), items, total: sumVnd(items.map((item) => item.amount)) } };
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
    if (await isPayrollPeriodLocked(db, storeId, date.slice(0, 7))) return { message: "Kỳ lương đã chốt, không thể thêm hoặc sửa phụ cấp/thưởng." };
    if (await isEmployeePayrollLocked(db, storeId, date.slice(0, 7), employeeId)) return { message: "Lương của nhân viên trong kỳ này đã khóa sổ riêng, không thể thêm hoặc sửa phụ cấp/thưởng." };
    const employee = await db.prepare(`SELECT e.id, e.name FROM employees e
      WHERE e.id = ? AND e.status != 'ARCHIVED' AND (
        e.store_id = ? OR EXISTS (
          SELECT 1 FROM employee_transfers t WHERE t.employee_id = e.id AND t.target_store_id = ?
            AND t.status IN ('SCHEDULED', 'ACTIVE', 'COMPLETED') AND t.start_date <= ? AND t.end_date >= ?
        ) OR EXISTS (
          SELECT 1 FROM shift_sessions s WHERE s.employee_id = e.id AND s.store_id = ?
            AND substr(COALESCE(NULLIF(s.work_date, ''), date(s.started_at, '+7 hours')), 1, 7) = ?
        )
      ) LIMIT 1`)
      .bind(employeeId, storeId, storeId, date, date, storeId, date.slice(0, 7)).first<{ id: string; name: string }>();
    if (!employee) return { message: "Nhân viên không làm tại cửa hàng trong kỳ đang thao tác." };
    return { data: { kind, employeeId, employeeName: employee.name, amount, date, note } };
  }

  if (category === "NHAP_HANG") {
    const date = String(source.date ?? "");
    const note = String(source.note ?? "").trim();
    const rawItems = Array.isArray(source.items) ? source.items : [];
    if (!validDate(date) || rawItems.length === 0 || rawItems.length > 100) return { message: "Phiếu nhập phải có ngày và từ 1 đến 100 mặt hàng." };
    if (await isPayrollPeriodLocked(db, storeId, date.slice(0, 7))) return { message: "Kỳ đã chốt lương và KPI, không thể thêm hoặc sửa phiếu nhập hàng." };
    const units = new Set(["Bao", "Kiện", "Thùng", "Cái", "Kg"]);
    const items: Array<Record<string, unknown>> = [];
    for (let index = 0; index < rawItems.length; index += 1) {
      const raw = rawItems[index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { message: `Dòng hàng ${index + 1} không hợp lệ.` };
      const item = raw as Record<string, unknown>;
      const name = String(item.name ?? "").trim();
      const quantity = Number(item.quantity);
      const unit = String(item.unit ?? "Bao");
      const weight = Number(item.weight);
      const unitPrice = Number(item.unitPrice);
      const shipping = Number(item.shipping ?? 0);
      if (!name || !Number.isInteger(quantity) || quantity <= 0 || !units.has(unit) || !Number.isFinite(weight) || weight <= 0 || !isVnd(unitPrice) || unitPrice <= 0 || !isVnd(shipping) || shipping < 0) {
        return { message: `Dòng hàng ${index + 1} phải có tên, số lượng, đơn vị, cân nặng, đơn giá và phí vận chuyển hợp lệ.` };
      }
      const goodsAmount = Math.round(weight * unitPrice);
      if (!isVnd(goodsAmount) || goodsAmount < 0) return { message: `Thành tiền dòng hàng ${index + 1} vượt giới hạn.` };
      items.push({ name, quantity, unit, weight, unitPrice, shipping, goodsAmount, amount: sumVnd([goodsAmount, shipping]) });
    }
    const goodsTotal = sumVnd(items.map((item) => Number(item.goodsAmount)));
    const shippingTotal = sumVnd(items.map((item) => Number(item.shipping)));
    return { data: { date, period: date.slice(0, 7), note, items, goodsTotal, shippingTotal, total: sumVnd([goodsTotal, shippingTotal]) } };
  }

  if (category === "DONG_TIEN") {
    const date = String(source.date ?? "");
    const amount = Number(source.amount);
    const note = String(source.note ?? "").trim();
    if (!validDate(date) || !isVnd(amount) || amount <= 0 || !note) return { message: "Chi phí phát sinh phải có ngày, nội dung và số tiền nguyên VND dương." };
    if (await isPayrollPeriodLocked(db, storeId, date.slice(0, 7))) return { message: "Kỳ đã chốt lương và KPI, không thể thay đổi chi phí phát sinh." };
    return { data: { date, period: date.slice(0, 7), amount, note } };
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
  if (!validDate(date) || !shiftId || !shiftName || !range || employeeIds.length === 0 || employeeIds.length > 100) return { message: "Lịch phân ca phải có ngày, ca và từ 1 đến 100 nhân viên." };
  const shiftDefinition = await db.prepare("SELECT title, data_json AS dataJson FROM business_records WHERE id = ? AND category = 'CA_LAM_VIEC' AND store_id = ? AND status != 'DELETED' LIMIT 1")
    .bind(shiftId, storeId).first<{ title: string; dataJson: string }>();
  if (!shiftDefinition) return { message: "Ca làm việc đã chọn không còn tồn tại." };
  try {
    const definition = JSON.parse(shiftDefinition.dataJson) as { start?: string; end?: string };
    if (shiftDefinition.title !== shiftName || definition.start !== start || definition.end !== end) {
      return { message: "Thông tin ca làm việc đã thay đổi. Vui lòng chọn lại ca trước khi lưu." };
    }
  } catch {
    return { message: "Dữ liệu ca làm việc đã chọn không hợp lệ." };
  }
  const placeholders = employeeIds.map(() => "?").join(",");
  const employeeCount = await db.prepare(`SELECT COUNT(*) AS count FROM employees e WHERE e.status = 'ACTIVE' AND e.id IN (${placeholders}) AND (
      e.store_id = ? OR EXISTS (
        SELECT 1 FROM employee_transfers t WHERE t.employee_id = e.id AND t.target_store_id = ?
          AND t.status IN ('SCHEDULED', 'ACTIVE') AND t.start_date <= ? AND t.end_date >= ?
      )
    )`)
    .bind(...employeeIds, storeId, storeId, date, date).first<{ count: number }>();
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
  if (protectedCategories.has(body.category)) return json({ message: "Dữ liệu chốt kỳ chỉ được tạo qua quy trình xác nhận chuyên biệt." }, 403);
  if (body.storeId && !await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = await initDb();
  const validated = await validateStoreRecord(db, body.category, body.storeId ?? null, body.data ?? {});
  if (!validated.data) return json({ message: validated.message ?? "Dữ liệu nghiệp vụ không hợp lệ." }, 400);
  let data = validated.data;
  if (body.category === "CHI_PHI_CO_DINH") data = { ...data, changeHistory: [{ action: "CREATE", at: now, by: user.id, total: data.total, items: data.items }] };
  if (body.category === "NHAP_HANG") data = { ...data, receiptNo: `PN-${String(data.date).replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`, savedAt: now, savedBy: user.id };
  const scope = financialWriteScope(body.category, body.storeId ?? null, data);
  if (payrollSensitiveCategories.has(body.category) && !scope) return json({ message: "D\u1eef li\u1ec7u k\u1ef3 l\u01b0\u01a1ng kh\u00f4ng h\u1ee3p l\u1ec7." }, 400);
  if (scope) {
    const employeeGuard = body.category === "LUONG_THUONG" ? ` AND ${incomingEmployeeLockGuardSql}` : "";
    const result = await db.prepare(`INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${incomingPeriodLockGuardSql}${employeeGuard}`)
      .bind(
        id, body.category, body.storeId ?? null, user.id, body.title.trim(), JSON.stringify(data), body.status ?? "ACTIVE", now, now,
        scope.storeId, scope.period,
        ...(body.category === "LUONG_THUONG" ? [scope.storeId, scope.employeeId, scope.period] : []),
      ).run();
    if (affectedRows(result) === 0) return periodLockMessage();
  } else {
    await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, body.category, body.storeId ?? null, user.id, body.title.trim(), JSON.stringify(data), body.status ?? "ACTIVE", now, now).run();
  }
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
  if (String(existing.status) === "LOCKED" || protectedCategories.has(String(existing.category))) return json({ message: "Dữ liệu đã chốt hoặc thuộc sổ khóa, không thể chỉnh sửa." }, 423);
  if (immutableHistoryCategories.has(String(existing.category))) return json({ message: "Phiếu nhập hàng đã lưu là lịch sử bất biến, không thể ghi đè." }, 423);
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
  const existingCategory = String(existing.category);
  if (existingStoreId && ["LUONG_THUONG", "CHI_PHI_CO_DINH", "DONG_TIEN"].includes(existingCategory)) {
    const previous = parseRow(existing).data;
    const previousPeriod = existingCategory === "CHI_PHI_CO_DINH"
      ? String(previous.period ?? "")
      : String(previous.date ?? "").slice(0, 7);
    if (previousPeriod && await isPayrollPeriodLocked(db, existingStoreId, previousPeriod)) {
      return json({ message: "Dữ liệu thuộc kỳ đã chốt lương và KPI, không thể chỉnh sửa hoặc chuyển sang kỳ khác." }, 423);
    }
    if (existingCategory === "LUONG_THUONG" && previousPeriod) {
      const previousEmployeeId = String(previous.employeeId ?? "");
      if (previousEmployeeId && await isEmployeePayrollLocked(db, existingStoreId, previousPeriod, previousEmployeeId)) {
        return json({ message: "Lương của nhân viên trong kỳ này đã khóa sổ riêng, không thể chỉnh sửa khoản thưởng/phụ cấp." }, 423);
      }
    }
  }
  const title = body.title?.trim() || String(existing.title);
  const incomingData = body.data ?? parseRow(existing).data;
  const validated = await validateStoreRecord(db, String(existing.category), existingStoreId, incomingData, body.id);
  if (!validated.data) return json({ message: validated.message ?? "Dữ liệu nghiệp vụ không hợp lệ." }, 400);
  let data = validated.data;
  const updatedAt = new Date().toISOString();
  if (String(existing.category) === "CHI_PHI_CO_DINH") {
    const previous = parseRow(existing).data;
    const history = Array.isArray(previous.changeHistory) ? previous.changeHistory : [];
    data = { ...data, changeHistory: [...history, { action: "UPDATE", at: updatedAt, by: user.id, total: data.total, items: data.items }] };
  }
  const scope = financialWriteScope(existingCategory, existingStoreId, data);
  if (payrollSensitiveCategories.has(existingCategory) && !scope) return json({ message: "D\u1eef li\u1ec7u k\u1ef3 l\u01b0\u01a1ng kh\u00f4ng h\u1ee3p l\u1ec7." }, 400);
  if (scope) {
    const employeeGuards = existingCategory === "LUONG_THUONG"
      ? ` AND ${existingEmployeeLockGuardSql} AND ${incomingEmployeeLockGuardSql}`
      : "";
    const result = await db.prepare(`UPDATE business_records
      SET title = ?, data_json = ?, status = ?, updated_at = ?
      WHERE id = ? AND status != 'DELETED'
        AND ${existingPeriodLockGuardSql}
        AND ${incomingPeriodLockGuardSql}${employeeGuards}`)
      .bind(
        title, JSON.stringify(data), body.status ?? String(existing.status), updatedAt, body.id,
        scope.storeId, scope.period,
        ...(existingCategory === "LUONG_THUONG" ? [scope.storeId, scope.employeeId, scope.period] : []),
      ).run();
    if (affectedRows(result) === 0) return periodLockMessage();
  } else {
    await db.prepare("UPDATE business_records SET title = ?, data_json = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(title, JSON.stringify(data), body.status ?? String(existing.status), updatedAt, body.id).run();
  }
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
  if (existing.category === "KPI_SUMMARY" || existing.category === "PAYROLL_CLOSING" || existing.category === "DIVIDEND") return json({ message: "Sổ đã chốt không thể xóa." }, 423);
  if (immutableHistoryCategories.has(existing.category)) return json({ message: "Phiếu nhập hàng đã lưu là lịch sử bất biến, không thể xóa." }, 423);
  if (existing.storeId && !await isStoreActive(existing.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (["LUONG_THUONG", "CHI_PHI_CO_DINH", "DONG_TIEN"].includes(existing.category) && existing.storeId) {
    let period = "";
    try {
      const data = JSON.parse(existing.dataJson) as { date?: string; period?: string };
      period = existing.category === "CHI_PHI_CO_DINH" ? String(data.period ?? "") : String(data.date ?? "").slice(0, 7);
    } catch { period = ""; }
    if (period && await isPayrollPeriodLocked(db, existing.storeId, period)) return json({ message: "Kỳ đã chốt lương và KPI, không thể xóa dữ liệu chi phí." }, 409);
    if (existing.category === "LUONG_THUONG" && period) {
      try {
        const data = JSON.parse(existing.dataJson) as { employeeId?: string };
        if (data.employeeId && await isEmployeePayrollLocked(db, existing.storeId, period, data.employeeId)) {
          return json({ message: "Lương của nhân viên trong kỳ này đã khóa sổ riêng, không thể xóa khoản thưởng/phụ cấp." }, 423);
        }
      } catch { /* Invalid legacy rows remain protected by the normal validation path. */ }
    }
  }
  const deletedAt = new Date().toISOString();
  if (payrollSensitiveCategories.has(existing.category)) {
    const employeeGuard = existing.category === "LUONG_THUONG" ? ` AND ${existingEmployeeLockGuardSql}` : "";
    const result = await db.prepare(`UPDATE business_records
      SET status = 'DELETED', updated_at = ?
      WHERE id = ? AND status != 'DELETED'
        AND ${existingPeriodLockGuardSql}${employeeGuard}`)
      .bind(deletedAt, id).run();
    if (affectedRows(result) === 0) return periodLockMessage();
  } else {
    await db.prepare("UPDATE business_records SET status = 'DELETED', updated_at = ? WHERE id = ?").bind(deletedAt, id).run();
  }
  await writeAudit(user.id, "DELETE", "BUSINESS_RECORD", id);
  return json({ ok: true });
}
