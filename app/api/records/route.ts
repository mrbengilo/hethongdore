import { initDb, writeAudit } from "../../../db/runtime";
import { isVnd, sumVnd } from "../../lib/finance";
import { fixedCostRecordId, normalizeFixedCostClientRequestId } from "../../lib/fixed-cost";
import { summarizeInventoryHistory } from "../../lib/inventory";
import {
  inventoryReceiptDateToken,
  inventoryReceiptPayloadHash,
  inventoryReceiptRecordId,
  inventoryReceiptServerDate,
  normalizeInventoryReceiptClientRequestId,
} from "../../lib/inventory-receipt-code";
import {
  commitScheduleBatch, inspectScheduleBatch, scheduleBatchEntryId, scheduleBatchMarkerId, scheduleBatchPayloadHash,
} from "../../lib/schedule-batch";
import {
  DEFAULT_SHIFT_DEFINITIONS, isOvernightShift, normalizeScheduleClientRequestId,
  shiftDurationMinutes, shiftsOverlap, shiftUtcRange, validClock,
} from "../../lib/scheduling";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json, sha256 } from "../_lib/auth";
import {
  buildCashflowEntry,
  prepareCashflowEntryInsertWhere,
  prepareCashflowReversalInsertWhere,
  type CashflowLedgerEntry,
} from "../_lib/cashflow-ledger";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  managerHasGlobalStoreAccess,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";
import {
  incomingStorePeriodUnlockedSql,
  isStorePeriodLocked,
  storePeriodUnlockedSql,
} from "../_lib/store-period-lock";

const allowedCategories = new Set([
  "TASKS", "MANAGER_PAYROLL", "TRANSFER", "DIVIDEND", "PROFILE",
  "CA_LAM_VIEC", "LICH_PHAN_CA", "NHAP_HANG", "CHAM_CONG",
  "LUONG_THUONG", "DONG_TIEN", "BAO_CAO", "CAI_DAT",
  "CHI_PHI_CO_DINH", "PAYROLL_CLOSING",
]);

const protectedCategories = new Set(["KPI_SUMMARY", "PAYROLL_CLOSING", "DIVIDEND"]);
const immutableHistoryCategories = new Set(["NHAP_HANG", "CHI_PHI_CO_DINH"]);
const payrollSensitiveCategories = new Set(["LUONG_THUONG", "CHI_PHI_CO_DINH", "DONG_TIEN", "NHAP_HANG"]);

const existingRecordPeriodSql = `CASE
  WHEN business_records.category = 'CHI_PHI_CO_DINH' THEN json_extract(business_records.data_json, '$.period')
  ELSE COALESCE(json_extract(business_records.data_json, '$.period'), substr(json_extract(business_records.data_json, '$.date'), 1, 7))
END`;
const existingPeriodLockGuardSql = storePeriodUnlockedSql("business_records.store_id", existingRecordPeriodSql);
const incomingPeriodLockGuardSql = incomingStorePeriodUnlockedSql;
const payrollAdjustmentIncomingGuardSql = `NOT EXISTS (
  SELECT 1 FROM financial_periods payroll_period
  WHERE payroll_period.store_id = ? AND payroll_period.period = ?
    AND payroll_period.status IN ('CONFIRMED', 'PAID', 'LOCKED')
) AND ${incomingPeriodLockGuardSql}`;
const payrollAdjustmentExistingGuardSql = `NOT EXISTS (
  SELECT 1 FROM financial_periods payroll_period
  WHERE payroll_period.store_id = business_records.store_id
    AND payroll_period.period = COALESCE(
      json_extract(business_records.data_json, '$.period'),
      substr(json_extract(business_records.data_json, '$.date'), 1, 7)
    )
    AND payroll_period.status IN ('CONFIRMED', 'PAID', 'LOCKED')
) AND ${existingPeriodLockGuardSql}`;
const inventoryReceiptWriteGuardSql = `EXISTS (
  SELECT 1 FROM stores receipt_store
  JOIN users receipt_actor ON receipt_actor.id = ?
  WHERE receipt_store.id = ? AND receipt_store.status = 'ACTIVE'
    AND receipt_actor.role = 'MANAGER'
    AND (COALESCE(receipt_actor.is_super_admin, 0) = 1 OR receipt_actor.store_id IS NULL OR receipt_actor.store_id = receipt_store.id)
)`;

const shiftDefinitionMutableGuardSql = `NOT EXISTS (
  SELECT 1 FROM business_records AS schedule
  WHERE schedule.category = 'LICH_PHAN_CA'
    AND schedule.store_id = business_records.store_id
    AND schedule.status != 'DELETED'
    AND json_extract(schedule.data_json, '$.shiftId') = business_records.id
) AND NOT EXISTS (
  SELECT 1 FROM shift_sessions AS active_shift
  WHERE active_shift.store_id = business_records.store_id
    AND active_shift.status = 'ACTIVE'
    AND active_shift.shift_name = business_records.title
    AND active_shift.scheduled_start = json_extract(business_records.data_json, '$.start')
    AND active_shift.scheduled_end = json_extract(business_records.data_json, '$.end')
)`;

type RecordBody = {
  id?: string;
  action?: string;
  reason?: string;
  clientRequestId?: string;
  expectedVersion?: number;
  category?: string;
  storeId?: string | null;
  title?: string;
  data?: Record<string, unknown>;
  status?: string;
  completedIndex?: number;
};

function meaningfulMutationReason(value: unknown) {
  const reason = String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  return reason.length >= 5 && reason.length <= 500 ? reason : null;
}

function normalizePayrollAdjustmentRequestId(value: unknown) {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return expenseRequestIdPattern.test(normalized) ? normalized : null;
}

function payrollAdjustmentVersion(value: unknown) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

async function payrollAdjustmentPayloadHash(input: {
  action: "CREATE" | "UPDATE" | "DELETE";
  storeId: string;
  title: string;
  status: string;
  data: Record<string, unknown>;
}) {
  return sha256(JSON.stringify({
    action: input.action,
    storeId: input.storeId,
    title: input.title,
    status: input.status,
    kind: String(input.data.kind ?? ""),
    employeeId: String(input.data.employeeId ?? ""),
    amount: Number(input.data.amount ?? 0),
    date: String(input.data.date ?? ""),
    note: String(input.data.note ?? ""),
  }));
}

async function isPayrollAdjustmentPeriodBlocked(
  db: Awaited<ReturnType<typeof initDb>>,
  storeId: string,
  period: string,
) {
  if (await isStorePeriodLocked(db, storeId, period)) return true;
  const canonical = await db.prepare(`SELECT 1 AS blocked FROM financial_periods
    WHERE store_id = ? AND period = ? AND status IN ('CONFIRMED', 'PAID', 'LOCKED') LIMIT 1`)
    .bind(storeId, period).first<{ blocked: number }>();
  return Boolean(canonical?.blocked);
}

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
const expenseRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

function canonicalIso(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === normalized ? normalized : "";
}

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

function immutableHistoryMessage(category: string, action: "update" | "delete") {
  if (category === "CHI_PHI_CO_DINH") {
    return action === "update"
      ? "Lần nhập chi phí cố định đã lưu là lịch sử bất biến, không thể ghi đè. Hãy tạo lần nhập mới."
      : "Lần nhập chi phí cố định đã lưu là lịch sử bất biến, không thể xóa.";
  }
  return action === "update"
    ? "Phiếu nhập hàng đã lưu là lịch sử bất biến, không thể ghi đè."
    : "Phiếu nhập hàng đã lưu là lịch sử bất biến, không thể xóa.";
}

async function shiftDefinitionConflictMessage(
  db: Awaited<ReturnType<typeof initDb>>,
  id: string,
) {
  const usage = await db.prepare(`SELECT
      EXISTS (
        SELECT 1 FROM business_records schedule
        WHERE schedule.category = 'LICH_PHAN_CA'
          AND schedule.status != 'DELETED'
          AND json_extract(schedule.data_json, '$.shiftId') = definition.id
      ) AS hasSchedules,
      EXISTS (
        SELECT 1 FROM shift_sessions active_shift
        WHERE active_shift.store_id = definition.store_id
          AND active_shift.status = 'ACTIVE'
          AND active_shift.shift_name = definition.title
          AND active_shift.scheduled_start = json_extract(definition.data_json, '$.start')
          AND active_shift.scheduled_end = json_extract(definition.data_json, '$.end')
      ) AS hasActiveSession
    FROM business_records definition
    WHERE definition.id = ? AND definition.category = 'CA_LAM_VIEC'
    LIMIT 1`).bind(id).first<{ hasSchedules: number; hasActiveSession: number }>();
  if (usage?.hasActiveSession) return "Ca đang có nhân viên làm việc, không thể sửa hoặc xóa cho đến khi nhân viên kết ca.";
  if (usage?.hasSchedules) return "Ca đã được dùng trong lịch phân ca. Hãy xóa hoặc đổi lịch liên quan trước khi sửa/xóa ca này.";
  return "Ca làm việc vừa thay đổi. Vui lòng tải lại dữ liệu và thử lại.";
}

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
  if (!["CA_LAM_VIEC", "LICH_PHAN_CA", "CHI_PHI_CO_DINH", "LUONG_THUONG", "NHAP_HANG", "DONG_TIEN"].includes(category)) return { data: source };
  if (!storeId) return { message: "Danh mục này bắt buộc phải thuộc một cửa hàng." };

  if (category === "CHI_PHI_CO_DINH") {
    const period = String(source.period ?? "");
    const clientRequestId = normalizeFixedCostClientRequestId(source.clientRequestId);
    if (!monthPattern.test(period)) return { message: "Kỳ chi phí cố định không hợp lệ." };
    if (!clientRequestId) return { message: "Mã chống lưu trùng của lần nhập chi phí không hợp lệ." };
    if (await isStorePeriodLocked(db, storeId, period)) return { message: "Kỳ đã chốt lương và KPI, không thể thay đổi chi phí cố định." };
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
    return { data: { ...values, period, clientRequestId, note: String(source.note ?? "").trim(), items, total: sumVnd(items.map((item) => item.amount)) } };
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
    if (await isPayrollAdjustmentPeriodBlocked(db, storeId, date.slice(0, 7))) return { message: "Kỳ lương đã xác nhận, đã chi hoặc đã khóa, không thể thêm hoặc sửa phụ cấp/thưởng." };
    const employee = await db.prepare(`SELECT e.id, e.name FROM employees e
      WHERE e.id = ? AND (
        (e.status != 'ARCHIVED' AND (e.store_id = ? OR EXISTS (
          SELECT 1 FROM employee_transfers t WHERE t.employee_id = e.id AND t.target_store_id = ?
            AND t.status IN ('SCHEDULED', 'ACTIVE', 'COMPLETED') AND t.start_date <= ? AND t.end_date >= ?
        ) OR EXISTS (
          SELECT 1 FROM shift_sessions s WHERE s.employee_id = e.id AND s.store_id = ?
            AND substr(COALESCE(NULLIF(s.work_date, ''), date(s.started_at, '+7 hours')), 1, 7) = ?
        ))) OR EXISTS (
          SELECT 1 FROM shift_sessions historical_work
          WHERE historical_work.employee_id = e.id AND historical_work.store_id = ?
            AND substr(COALESCE(NULLIF(historical_work.work_date, ''), date(historical_work.started_at, '+7 hours')), 1, 7) = ?
            AND historical_work.status != 'DELETED'
            AND (historical_work.ended_at IS NOT NULL
              OR COALESCE(historical_work.admin_adjusted_duration_seconds, historical_work.duration_seconds, 0) > 0)
        )
      ) LIMIT 1`)
      .bind(employeeId, storeId, storeId, date, date, storeId, date.slice(0, 7), storeId, date.slice(0, 7)).first<{ id: string; name: string }>();
    if (!employee) return { message: "Nhân viên không làm tại cửa hàng trong kỳ đang thao tác." };
    return { data: { kind, employeeId, employeeName: employee.name, amount, date, note } };
  }

  if (category === "NHAP_HANG") {
    const date = String(source.date ?? "");
    const clientRequestId = normalizeInventoryReceiptClientRequestId(source.clientRequestId);
    const note = String(source.note ?? "").trim();
    const rawItems = Array.isArray(source.items) ? source.items : [];
    if (!clientRequestId) return { message: "Mã chống lưu trùng của phiếu nhập không hợp lệ." };
    if (!validDate(date) || rawItems.length === 0 || rawItems.length > 100) return { message: "Phiếu nhập phải có ngày và từ 1 đến 100 mặt hàng." };
    if (await isStorePeriodLocked(db, storeId, date.slice(0, 7))) return { message: "Kỳ đã chốt lương và KPI, không thể thêm hoặc sửa phiếu nhập hàng." };
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
    return { data: { date, period: date.slice(0, 7), clientRequestId, note, items, goodsTotal, shippingTotal, total: sumVnd([goodsTotal, shippingTotal]) } };
  }

  if (category === "DONG_TIEN") {
    const date = String(source.date ?? "");
    const amount = Number(source.amount);
    const note = String(source.note ?? "").trim();
    if (!validDate(date) || !isVnd(amount) || amount <= 0 || !note) return { message: "Chi phí phát sinh phải có ngày, nội dung và số tiền nguyên VND dương." };
    if (await isStorePeriodLocked(db, storeId, date.slice(0, 7))) return { message: "Kỳ đã chốt lương và KPI, không thể thay đổi chi phí phát sinh." };
    const clientRequestId = String(source.clientRequestId ?? "").trim();
    const paidAt = canonicalIso(source.paidAt);
    if (!excludeId && (!expenseRequestIdPattern.test(clientRequestId) || !paidAt)) {
      return { message: "Chi phí phát sinh thiếu mã chống lưu trùng hoặc thời điểm chi thực tế hợp lệ." };
    }
    return { data: {
      date,
      period: date.slice(0, 7),
      amount,
      note,
      ...(clientRequestId ? { clientRequestId } : {}),
      ...(paidAt ? { paidAt } : {}),
    } };
  }

  const start = String(source.start ?? "");
  const end = String(source.end ?? "");
  const duration = shiftDurationMinutes(start, end);
  if (!validClock(start) || !validClock(end) || duration <= 0) return { message: "Khung giờ ca làm việc không hợp lệ." };
  if (category === "CA_LAM_VIEC") {
    const rawTemplateKey = String(source.templateKey ?? "");
    const templateKey = /^default-[1-9]\d*$/u.test(rawTemplateKey) ? rawTemplateKey : null;
    const rawSortOrder = Number(source.sortOrder);
    const sortOrder = Number.isInteger(rawSortOrder) && rawSortOrder > 0 && rawSortOrder <= 999 ? rawSortOrder : null;
    return { data: {
      start,
      end,
      durationMinutes: duration,
      overnight: isOvernightShift(start, end),
      ...(templateKey ? { templateKey } : {}),
      ...(sortOrder ? { sortOrder } : {}),
    } };
  }

  const date = String(source.date ?? "");
  const shiftId = String(source.shiftId ?? "");
  const shiftName = String(source.shiftName ?? "").trim();
  const employeeIds = Array.isArray(source.employeeIds) ? [...new Set(source.employeeIds.map(String).filter(Boolean))] : [];
  const range = shiftUtcRange(date, start, end);
  if (!validDate(date) || !shiftId || !shiftName || !range || employeeIds.length === 0 || employeeIds.length > 100) return { message: "Lịch phân ca phải có ngày, ca và từ 1 đến 100 nhân viên." };
  if (await isStorePeriodLocked(db, storeId, date.slice(0, 7))) return { message: "Kỳ đã chốt lương và KPI, không thể tạo hoặc sửa lịch phân ca." };
  let preservesExistingSnapshot = false;
  if (excludeId) {
    const existingSchedule = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE id = ? AND category = 'LICH_PHAN_CA' AND store_id = ? AND status != 'DELETED' LIMIT 1")
      .bind(excludeId, storeId).first<{ dataJson: string }>();
    try {
      const snapshot = JSON.parse(existingSchedule?.dataJson ?? "{}") as Record<string, unknown>;
      preservesExistingSnapshot = snapshot.date === date && snapshot.shiftId === shiftId
        && snapshot.shiftName === shiftName && snapshot.start === start && snapshot.end === end;
    } catch { preservesExistingSnapshot = false; }
  }

  let shiftDefinitionVersion: number | null = null;
  if (!preservesExistingSnapshot) {
    const dailyDefinition = await db.prepare(`SELECT name, start_time AS start, end_time AS end, version
      FROM daily_shift_definitions
      WHERE id = ? AND store_id = ? AND work_date = ? AND status = 'ACTIVE' LIMIT 1`)
      .bind(shiftId, storeId, date).first<{ name: string; start: string; end: string; version: number }>();
    if (dailyDefinition) {
      if (dailyDefinition.name !== shiftName || dailyDefinition.start !== start || dailyDefinition.end !== end) {
        return { message: "Thông tin ca làm việc đã thay đổi. Vui lòng chọn lại ca trước khi lưu." };
      }
      shiftDefinitionVersion = Number(dailyDefinition.version);
    } else {
      // Compatibility path for schedules created by versions that used global
      // CA_LAM_VIEC records or the three built-in defaults.
      const shiftDefinition = await db.prepare("SELECT title, data_json AS dataJson FROM business_records WHERE id = ? AND category = 'CA_LAM_VIEC' AND store_id = ? AND status != 'DELETED' LIMIT 1")
        .bind(shiftId, storeId).first<{ title: string; dataJson: string }>();
      if (shiftDefinition) {
        try {
          const definition = JSON.parse(shiftDefinition.dataJson) as { start?: string; end?: string };
          if (shiftDefinition.title !== shiftName || definition.start !== start || definition.end !== end) {
            return { message: "Thông tin ca làm việc đã thay đổi. Vui lòng chọn lại ca trước khi lưu." };
          }
        } catch {
          return { message: "Dữ liệu ca làm việc đã chọn không hợp lệ." };
        }
      } else {
        const defaultMatch = shiftId.match(/^default-([1-9]\d*)$/u);
        const defaultDefinition = defaultMatch ? DEFAULT_SHIFT_DEFINITIONS[Number(defaultMatch[1]) - 1] : undefined;
        if (!defaultDefinition || defaultDefinition.name !== shiftName || defaultDefinition.start !== start || defaultDefinition.end !== end) {
          return { message: "Ca làm việc đã chọn không còn tồn tại." };
        }
      }
    }
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
  return { data: {
    date,
    shiftId,
    shiftName,
    start,
    end,
    ...range,
    overnight: isOvernightShift(start, end),
    employeeIds,
    employeeNames,
    note: String(source.note ?? "").trim(),
    ...(shiftDefinitionVersion ? { shiftDefinitionVersion } : {}),
  } };
}

function parseRow(row: Record<string, unknown>) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(String(row.data_json ?? "{}")); } catch { data = {}; }
  return { ...row, data };
}

function fixedCostAmount(value: unknown) {
  const amount = Number(value ?? 0);
  return isVnd(amount) && amount >= 0 ? amount : 0;
}

function fixedCostPeriodSummaries(rows: Record<string, unknown>[]) {
  const summaries = new Map<string, {
    period: string;
    entryCount: number;
    total: number;
    items: Map<string, { key: FixedCostKey | null; name: string; amount: number }>;
  }>();
  for (const row of rows) {
    const data = parseRow(row).data;
    const period = String(data.period ?? "");
    if (!monthPattern.test(period)) continue;
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items = rawItems.length > 0 ? rawItems.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const item = raw as Record<string, unknown>;
      const rawKey = String(item.key ?? "");
      const definition = fixedCostDefinitions.find(([key]) => key === rawKey);
      const key = definition?.[0] ?? null;
      const name = key ? definition?.[1] ?? "" : String(item.name ?? "").trim();
      return name ? [{ key, name, amount: fixedCostAmount(item.amount) }] : [];
    }) : fixedCostDefinitions.map(([key, name]) => ({ key, name, amount: fixedCostAmount(data[key]) }));
    const summary = summaries.get(period) ?? { period, entryCount: 0, total: 0, items: new Map() };
    summary.entryCount += 1;
    const entryTotal = sumVnd(items.map((item) => item.amount));
    summary.total = sumVnd([summary.total, entryTotal]);
    for (const item of items) {
      const identity = item.key ? `key:${item.key}` : `custom:${item.name.toLocaleLowerCase("vi")}`;
      const previous = summary.items.get(identity);
      summary.items.set(identity, { ...item, amount: sumVnd([previous?.amount ?? 0, item.amount]) });
    }
    summaries.set(period, summary);
  }
  return [...summaries.values()].sort((a, b) => b.period.localeCompare(a.period)).map((summary) => ({
    period: summary.period,
    entryCount: summary.entryCount,
    total: summary.total,
    items: [
      ...fixedCostDefinitions.map(([key, name]) => summary.items.get(`key:${key}`) ?? { key, name, amount: 0 }),
      ...[...summary.items].filter(([identity]) => identity.startsWith("custom:")).map(([, item]) => item),
    ],
  }));
}

function parseFixedCostCursor(value: string | null) {
  if (!value) return null;
  const separator = value.lastIndexOf("|");
  if (separator <= 0 || separator === value.length - 1) return null;
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return !Number.isNaN(Date.parse(createdAt)) && id.length <= 160 ? { createdAt, id } : null;
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
  const managerScope = user.role === "MANAGER" ? resolveManagerStoreScope(user, requestedStore) : null;
  if (managerScope && !managerScope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = user.role === "EMPLOYEE" ? user.storeId : managerScope?.storeId ?? null;
  if (category === "CHI_PHI_CO_DINH" && storeId) {
    const requestedLimit = Number(params.get("limit") ?? 25);
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(10, requestedLimit)) : 25;
    const rawCursor = params.get("cursor");
    const cursor = parseFixedCostCursor(rawCursor);
    if (rawCursor && !cursor) return json({ message: "Mốc tải lịch sử chi phí không hợp lệ." }, 400);
    const cursorSql = cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
    const pageStatement = db.prepare(`SELECT * FROM business_records
      WHERE category = ? AND store_id = ? AND status != 'DELETED'${cursorSql}
      ORDER BY created_at DESC, id DESC LIMIT ?`);
    const pagePromise = cursor
      ? pageStatement.bind(category, storeId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1).all()
      : pageStatement.bind(category, storeId, limit + 1).all();
    const [pageResult, summaryResult, countRow] = await Promise.all([
      pagePromise,
      db.prepare("SELECT data_json FROM business_records WHERE category = ? AND store_id = ? AND status NOT IN ('DELETED', 'VOID') ORDER BY created_at DESC")
        .bind(category, storeId).all(),
      db.prepare("SELECT COUNT(*) AS count FROM business_records WHERE category = ? AND store_id = ? AND status != 'DELETED'")
        .bind(category, storeId).first<{ count: number }>(),
    ]);
    const pageRows = pageResult.results as Record<string, unknown>[];
    const hasMore = pageRows.length > limit;
    const visibleRows = hasMore ? pageRows.slice(0, limit) : pageRows;
    const last = visibleRows.at(-1);
    return json({
      records: visibleRows.map((row) => parseRow(row)),
      nextCursor: hasMore && last ? `${String(last.created_at)}|${String(last.id)}` : null,
      historyTotal: Number(countRow?.count ?? 0),
      periodSummaries: fixedCostPeriodSummaries(summaryResult.results as Record<string, unknown>[]),
    });
  }
  if (category === "NHAP_HANG" && storeId) {
    const includeAllHistory = params.get("all") === "1";
    const [historyResult, summaryResult] = await Promise.all([
      db.prepare(`SELECT * FROM business_records WHERE category = ? AND store_id = ? AND status != 'DELETED' ORDER BY created_at DESC${includeAllHistory ? "" : " LIMIT 200"}`)
        .bind(category, storeId).all(),
      db.prepare("SELECT data_json FROM business_records WHERE category = ? AND store_id = ? AND status != 'DELETED'")
        .bind(category, storeId).all(),
    ]);
    const summaryRows = summaryResult.results as Record<string, unknown>[];
    return json({
      records: historyResult.results.map((row) => parseRow(row as Record<string, unknown>)),
      historySummary: summarizeInventoryHistory(summaryRows.map((row) => parseRow(row).data)),
      historyLimited: !includeAllHistory && summaryRows.length > historyResult.results.length,
    });
  }
  if (category === "LUONG_THUONG" && storeId) {
    const result = await db.prepare(`SELECT record.*, COALESCE(owner.name, 'Tài khoản đã xóa') AS owner_name
      FROM business_records record
      LEFT JOIN users owner ON owner.id = record.owner_id
      WHERE record.category = ? AND record.store_id = ? AND record.status != 'DELETED'
      ORDER BY record.created_at DESC LIMIT 200`).bind(category, storeId).all();
    return json({
      records: result.results.map((row) => {
        const parsed = parseRow(row as Record<string, unknown>);
        return {
          ...parsed,
          data: {
            ...parsed.data,
            createdByName: String((row as Record<string, unknown>).owner_name ?? "Tài khoản đã xóa"),
          },
        };
      }),
    });
  }
  const result = storeId
    ? await db.prepare("SELECT * FROM business_records WHERE category = ? AND store_id = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 200").bind(category, storeId).all()
    : category === "PROFILE"
      ? await db.prepare("SELECT * FROM business_records WHERE category = ? AND store_id IS NULL AND status != 'DELETED' ORDER BY created_at DESC LIMIT 200").bind(category).all()
      : await db.prepare("SELECT * FROM business_records WHERE category = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 200").bind(category).all();
  return json({ records: result.results.map((row) => parseRow(row as Record<string, unknown>)) });
}

async function createScheduleBatch(
  db: Awaited<ReturnType<typeof initDb>>,
  userId: string,
  body: RecordBody,
) {
  if (body.category !== "LICH_PHAN_CA" || !body.storeId) return json({ message: "Lô lịch phân ca phải thuộc một cửa hàng." }, 400);
  const source = body.data ?? {};
  const clientRequestId = normalizeScheduleClientRequestId(source.clientRequestId);
  const date = String(source.date ?? "");
  const note = String(source.note ?? "").trim();
  const reason = meaningfulMutationReason(body.reason) ?? `Tạo lịch phân ca ngày ${date}`;
  const employeeIds = Array.isArray(source.employeeIds) ? source.employeeIds.map(String) : [];
  const rawEntries = Array.isArray(source.entries) ? source.entries : [];
  if (!clientRequestId) return json({ message: "Mã chống lưu trùng của lô lịch phân ca không hợp lệ." }, 400);
  if (rawEntries.length === 0 || rawEntries.length > 20) return json({ message: "Mỗi lần lưu phải có từ 1 đến 20 ca làm việc." }, 400);
  if (rawEntries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) return json({ message: "Danh sách ca làm việc không hợp lệ." }, 400);
  const requestedEntries = rawEntries as Record<string, unknown>[];
  const requestedShiftIds = requestedEntries.map((entry) => String(entry.shiftId ?? ""));
  if (requestedShiftIds.some((id) => !id)) return json({ message: "Danh sách ca làm việc có mã ca không hợp lệ." }, 400);
  if (new Set(requestedShiftIds).size !== requestedShiftIds.length) return json({ message: "Danh sách ca làm việc có ca bị trùng." }, 400);

  const canonicalEntries = requestedEntries.map((entry) => ({
    shiftId: String(entry.shiftId ?? ""),
    shiftName: String(entry.shiftName ?? "").trim(),
    start: String(entry.start ?? ""),
    end: String(entry.end ?? ""),
  })).sort((left, right) => left.shiftId.localeCompare(right.shiftId));
  const payloadHash = await scheduleBatchPayloadHash({
    storeId: body.storeId,
    date,
    employeeIds: [...new Set(employeeIds.filter(Boolean))].sort(),
    note,
    entries: canonicalEntries,
  });
  const markerId = await scheduleBatchMarkerId(body.storeId, clientRequestId);
  const entryIds = await Promise.all(requestedShiftIds.map((shiftId) => scheduleBatchEntryId(body.storeId!, clientRequestId, shiftId)));
  const commitBase = {
    markerId,
    storeId: body.storeId,
    ownerId: userId,
    clientRequestId,
    payloadHash,
    date,
    entries: entryIds.map((id) => ({ id, title: "", data: {} })),
    now: "",
    reason,
  };
  const previous = await inspectScheduleBatch(db, commitBase);
  if (previous?.status === "PAYLOAD_MISMATCH") return json({ message: "Mã lưu lô đã được dùng với nội dung khác. Vui lòng thử lưu lại." }, 409);
  if (previous?.status === "INCOMPLETE") return json({ message: "Lô lịch cũ đã được thay đổi sau khi lưu, không thể tự động ghi đè." }, 409);
  if (previous?.status === "IDEMPOTENT") return json({
    ids: previous.entryIds,
    count: previous.entryIds.length,
    idempotent: true,
    message: "Lô lịch phân ca này đã được lưu trước đó.",
  });
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);

  const validations = await Promise.all(requestedEntries.map((entry) => validateStoreRecord(db, "LICH_PHAN_CA", body.storeId!, {
    date,
    shiftId: entry.shiftId,
    shiftName: entry.shiftName,
    start: entry.start,
    end: entry.end,
    employeeIds,
    note,
  })));
  const invalid = validations.find((result) => !result.data);
  if (invalid) return json({ message: invalid.message ?? "Một hoặc nhiều ca trong lô lịch không hợp lệ." }, 400);
  const normalizedEntries = validations.map((result) => result.data as Record<string, unknown>);
  for (let first = 0; first < normalizedEntries.length; first += 1) {
    for (let second = first + 1; second < normalizedEntries.length; second += 1) {
      const left = normalizedEntries[first];
      const right = normalizedEntries[second];
      if (shiftsOverlap(
        String(left.date), String(left.start), String(left.end),
        String(right.date), String(right.start), String(right.end),
      )) return json({ message: `${String(left.shiftName)} và ${String(right.shiftName)} bị trùng thời gian.` }, 400);
    }
  }

  const entries = normalizedEntries.map((entry, index) => ({
    id: entryIds[index],
    title: `${String(entry.shiftName)} · ${date}`,
    data: { ...entry, batchRequestId: clientRequestId, batchPayloadHash: payloadHash },
  }));
  let committed: Awaited<ReturnType<typeof commitScheduleBatch>>;
  try {
    committed = await commitScheduleBatch(db, {
      markerId,
      storeId: body.storeId,
      ownerId: userId,
      clientRequestId,
      payloadHash,
      date,
      entries,
      now: new Date().toISOString(),
      reason,
    });
  } catch {
    if (await isStorePeriodLocked(db, body.storeId, date.slice(0, 7))) {
      return json({ message: "Kỳ tài chính đã khóa, không thể tạo lịch phân ca." }, 423);
    }
    return json({ message: "Không thể lưu trọn lô lịch phân ca; hệ thống chưa ghi nhận ca nào trong lần này." }, 409);
  }
  if (committed.status === "PAYLOAD_MISMATCH") return json({ message: "Mã lưu lô đã được dùng với nội dung khác. Vui lòng thử lưu lại." }, 409);
  if (committed.status === "INCOMPLETE") return json({ message: "Lô lịch cũ đã được thay đổi sau khi lưu, không thể tự động ghi đè." }, 409);
  return json({
    ids: committed.entryIds,
    count: committed.entryIds.length,
    idempotent: committed.status === "IDEMPOTENT",
    message: committed.status === "IDEMPOTENT" ? "Lô lịch phân ca này đã được lưu trước đó." : "Đã lưu toàn bộ lịch phân ca.",
  }, committed.status === "CREATED" ? 201 : 200);
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const body = await request.json().catch(() => ({})) as RecordBody;
  if (user.role !== "MANAGER") return json({ message: "Chỉ quản lý được tạo dữ liệu" }, 403);
  const db = await initDb();

  if (body.action) {
    if (body.action === "CREATE_SCHEDULE_BATCH") {
      if (!body.storeId || !managerCanAccessStore(user, body.storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
      return createScheduleBatch(db, user.id, body);
    }
    if (body.action !== "VOID_FIXED_COST" || !body.id) return json({ message: "Thao tác lịch sử chi phí không hợp lệ." }, 400);
    const existing = await db.prepare("SELECT id, category, store_id AS storeId, data_json AS dataJson, status FROM business_records WHERE id = ? AND category = 'CHI_PHI_CO_DINH' AND status != 'DELETED' LIMIT 1")
      .bind(body.id).first<{ id: string; category: string; storeId: string | null; dataJson: string; status: string }>();
    if (!existing) return json({ message: "Không tìm thấy lần nhập chi phí cố định." }, 404);
    if (!existing.storeId || !managerCanAccessStore(user, existing.storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
    if (existing.status === "VOID") return json({ id: existing.id, status: "VOID", idempotent: true, message: "Phiếu đã được hủy trước đó." });
    if (existing.status !== "ACTIVE" || !existing.storeId) return json({ message: "Trạng thái phiếu không cho phép hủy." }, 409);
    if (!await isStoreActive(existing.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
    let fixedCostData: Record<string, unknown> = {};
    try { fixedCostData = JSON.parse(existing.dataJson) as Record<string, unknown>; } catch { return json({ message: "Dữ liệu phiếu chi phí không hợp lệ." }, 409); }
    const period = String(fixedCostData.period ?? "");
    if (!monthPattern.test(period)) return json({ message: "Kỳ chi phí cố định không hợp lệ." }, 409);
    const voidedAt = new Date().toISOString();
    const result = await db.prepare(`UPDATE business_records SET status = 'VOID', updated_at = ?
      WHERE id = ? AND category = 'CHI_PHI_CO_DINH' AND status = 'ACTIVE'
        AND ${existingPeriodLockGuardSql}`)
      .bind(voidedAt, existing.id).run();
    if (affectedRows(result) === 0) {
      const current = await db.prepare("SELECT status FROM business_records WHERE id = ? LIMIT 1").bind(existing.id).first<{ status: string }>();
      if (current?.status === "VOID") return json({ id: existing.id, status: "VOID", idempotent: true, message: "Phiếu đã được hủy trước đó." });
      return periodLockMessage();
    }
    const reason = String(body.reason ?? "").trim() || "Quản lý hủy phiếu nhập sai";
    await writeAudit(user.id, "VOID_FIXED_COST", "CHI_PHI_CO_DINH", existing.id, JSON.stringify({
      period,
      entryNo: fixedCostData.entryNo,
      total: fixedCostData.total,
      reason,
      voidedAt,
    }));
    return json({ id: existing.id, status: "VOID", message: "Đã hủy phiếu. Lịch sử vẫn được giữ nguyên và số tiền đã loại khỏi tổng chi phí." });
  }

  if (!body.category || !allowedCategories.has(body.category) || !body.title?.trim()) return json({ message: "Dữ liệu chưa đầy đủ" }, 400);
  if (!body.storeId) {
    if (!managerHasGlobalStoreAccess(user)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  } else if (!managerCanAccessStore(user, body.storeId)) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  if (protectedCategories.has(body.category)) return json({ message: "Dữ liệu chốt kỳ chỉ được tạo qua quy trình xác nhận chuyên biệt." }, 403);
  if (body.category === "LICH_PHAN_CA") return json({ message: "Lịch phân ca mới phải được lưu bằng thao tác lô nguyên tử." }, 400);
  let id: string = crypto.randomUUID();
  let fixedCostClientRequestId: string | null = null;
  let inventoryClientRequestId: string | null = null;
  if (body.category === "CHI_PHI_CO_DINH") {
    if (!body.storeId) return json({ message: "Lần nhập chi phí phải thuộc một cửa hàng." }, 400);
    fixedCostClientRequestId = normalizeFixedCostClientRequestId(body.data?.clientRequestId);
    if (!fixedCostClientRequestId) return json({ message: "Mã chống lưu trùng của lần nhập chi phí không hợp lệ." }, 400);
    id = await fixedCostRecordId(body.storeId, fixedCostClientRequestId);
    const duplicate = await db.prepare("SELECT id, category, store_id AS storeId, data_json AS dataJson, status FROM business_records WHERE id = ? LIMIT 1")
      .bind(id).first<{ id: string; category: string; storeId: string | null; dataJson: string; status: string }>();
    if (duplicate) {
      let duplicateData: Record<string, unknown> = {};
      try { duplicateData = JSON.parse(duplicate.dataJson) as Record<string, unknown>; } catch { duplicateData = {}; }
      if (duplicate.category === body.category && duplicate.storeId === body.storeId && duplicateData.clientRequestId === fixedCostClientRequestId) {
        return json({ id: duplicate.id, status: duplicate.status, idempotent: true, message: "Lần nhập này đã được lưu trước đó." });
      }
      return json({ message: "Mã chống lưu trùng đã được sử dụng cho dữ liệu khác." }, 409);
    }
  }
  if (body.category === "NHAP_HANG") {
    if (!body.storeId) return json({ message: "Phiếu nhập phải thuộc một cửa hàng." }, 400);
    inventoryClientRequestId = normalizeInventoryReceiptClientRequestId(body.data?.clientRequestId);
    if (!inventoryClientRequestId) return json({ message: "Mã chống lưu trùng của phiếu nhập không hợp lệ." }, 400);
    id = await inventoryReceiptRecordId(body.storeId, user.id, inventoryClientRequestId);
    const payloadHash = await inventoryReceiptPayloadHash({ title: body.title.trim(), data: body.data ?? {} });
    const replay = await db.prepare(`SELECT request.record_id AS id, request.receipt_no AS receiptNo, request.payload_hash AS payloadHash
      FROM inventory_receipt_requests request JOIN business_records record ON record.id = request.record_id
      WHERE request.store_id = ? AND request.actor_user_id = ? AND request.client_request_id = ? LIMIT 1`)
      .bind(body.storeId, user.id, inventoryClientRequestId).first<{ id: string; receiptNo: string; payloadHash: string }>();
    if (replay) return replay.payloadHash === payloadHash
      ? json({ id: replay.id, receiptNo: replay.receiptNo, idempotent: true, message: "Phiếu nhập này đã được lưu trước đó." })
      : json({ message: "Mã chống lưu trùng đã được dùng cho phiếu nhập khác." }, 409);
  }
  if (body.storeId && !await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const now = new Date().toISOString();
  const validated = await validateStoreRecord(db, body.category, body.storeId ?? null, body.data ?? {});
  if (!validated.data) return json({ message: validated.message ?? "Dữ liệu nghiệp vụ không hợp lệ." }, 400);
  let data = validated.data;
  if (body.category === "CHI_PHI_CO_DINH") data = {
    ...data,
    entryNo: `CP-${String(data.period).replaceAll("-", "")}-${id.slice(-6).toUpperCase()}`,
    savedAt: now,
    savedBy: user.id,
    changeHistory: [{ action: "CREATE", at: now, by: user.id, total: data.total, items: data.items }],
  };
  if (body.category === "NHAP_HANG") {
    if (!body.storeId || !inventoryClientRequestId) return json({ message: "Phiếu nhập thiếu phạm vi lưu." }, 400);
    const receiptDate = inventoryReceiptServerDate(now);
    const payloadHash = await inventoryReceiptPayloadHash({ title: body.title.trim(), data: body.data ?? {} });
    const receiptScope = financialWriteScope(body.category, body.storeId, data);
    if (!receiptScope) return json({ message: "Dữ liệu kỳ lương không hợp lệ." }, 400);
    try {
      const [, requestInsert, recordInsert, created] = await db.batch([
        db.prepare(`INSERT INTO inventory_receipt_code_sequences (id, last_value, updated_at)
          SELECT 1, 1, ?
          WHERE NOT EXISTS (SELECT 1 FROM inventory_receipt_requests WHERE store_id = ? AND actor_user_id = ? AND client_request_id = ?)
            AND ${incomingPeriodLockGuardSql} AND ${inventoryReceiptWriteGuardSql}
            AND NOT EXISTS (SELECT 1 FROM inventory_receipt_code_sequences WHERE id = 1 AND last_value >= 99999)
          ON CONFLICT(id) DO UPDATE SET last_value = inventory_receipt_code_sequences.last_value + 1, updated_at = excluded.updated_at`)
          .bind(now, body.storeId, user.id, inventoryClientRequestId, receiptScope.storeId, receiptScope.period, user.id, body.storeId),
        db.prepare(`INSERT INTO inventory_receipt_requests
            (record_id, store_id, actor_user_id, client_request_id, payload_hash, receipt_date, sequence_value, receipt_no, created_at)
          SELECT ?, ?, ?, ?, ?, ?, sequence.last_value, printf('PN-%s-%05d', ?, sequence.last_value), ?
          FROM inventory_receipt_code_sequences sequence
          WHERE sequence.id = 1
            AND NOT EXISTS (SELECT 1 FROM inventory_receipt_requests WHERE store_id = ? AND actor_user_id = ? AND client_request_id = ?)
            AND ${incomingPeriodLockGuardSql} AND ${inventoryReceiptWriteGuardSql}`)
          .bind(id, body.storeId, user.id, inventoryClientRequestId, payloadHash, receiptDate, inventoryReceiptDateToken(receiptDate), now,
            body.storeId, user.id, inventoryClientRequestId, receiptScope.storeId, receiptScope.period, user.id, body.storeId),
        db.prepare(`INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
          SELECT request.record_id, 'NHAP_HANG', request.store_id, request.actor_user_id, ?,
            json_set(?, '$.receiptNo', request.receipt_no, '$.savedAt', ?, '$.savedBy', ?), ?, ?, ?
          FROM inventory_receipt_requests request
          WHERE request.record_id = ? AND request.payload_hash = ? AND ${incomingPeriodLockGuardSql}
            AND ${inventoryReceiptWriteGuardSql}
          ON CONFLICT(id) DO NOTHING`)
          .bind(body.title.trim(), JSON.stringify(data), now, user.id, body.status ?? "ACTIVE", now, now,
            id, payloadHash, receiptScope.storeId, receiptScope.period, user.id, body.storeId),
        db.prepare(`SELECT request.record_id AS id, request.receipt_no AS receiptNo, request.payload_hash AS payloadHash
          FROM inventory_receipt_requests request JOIN business_records record ON record.id = request.record_id
          WHERE request.store_id = ? AND request.actor_user_id = ? AND request.client_request_id = ? LIMIT 1`)
          .bind(body.storeId, user.id, inventoryClientRequestId),
      ]);
      const row = created.results[0] as { id: string; receiptNo: string; payloadHash: string } | undefined;
      if (!row) {
        const gate = await db.prepare(`SELECT store.status AS storeStatus, actor.role,
            actor.store_id AS actorStoreId, COALESCE(actor.is_super_admin, 0) AS isSuperAdmin
          FROM stores store LEFT JOIN users actor ON actor.id = ? WHERE store.id = ? LIMIT 1`)
          .bind(user.id, body.storeId).first<{ storeStatus: string; role: string | null; actorStoreId: string | null; isSuperAdmin: number | null }>();
        if (!gate || gate.storeStatus !== "ACTIVE") return json({ message: INACTIVE_STORE_MESSAGE }, 409);
        if (gate.role !== "MANAGER" || (!gate.isSuperAdmin && gate.actorStoreId !== null && gate.actorStoreId !== body.storeId)) {
          return json({ message: "Quyền quản lý cửa hàng đã thay đổi trong lúc lưu; phiếu và số phiếu chưa được ghi." }, 409);
        }
        const exhausted = await db.prepare("SELECT last_value AS lastValue FROM inventory_receipt_code_sequences WHERE id = 1")
          .first<{ lastValue: number }>();
        if (Number(exhausted?.lastValue ?? 0) >= 99999) return json({ message: "Kho số phiếu nhập 5 chữ số đã hết. Không có dữ liệu nào được ghi." }, 409);
        if (await isStorePeriodLocked(db, receiptScope.storeId, receiptScope.period)) return periodLockMessage();
        if (affectedRows(requestInsert) === 0 || affectedRows(recordInsert) === 0) {
          return json({ message: "Phiếu nhập không còn hợp lệ tại thời điểm lưu; dữ liệu và số phiếu chưa được ghi." }, 409);
        }
        throw new Error("Receipt transaction committed without a record");
      }
      if (row.payloadHash !== payloadHash) return json({ message: "Mã chống lưu trùng đã được dùng cho phiếu nhập khác." }, 409);
      if (affectedRows(recordInsert) === 1) await writeAudit(user.id, "CREATE", body.category, row.id, body.title);
      return json({ id: row.id, receiptNo: row.receiptNo, idempotent: affectedRows(recordInsert) === 0, message: "Đã lưu dữ liệu" }, affectedRows(recordInsert) === 1 ? 201 : 200);
    } catch (error) {
      const replay = await db.prepare(`SELECT request.record_id AS id, request.receipt_no AS receiptNo, request.payload_hash AS payloadHash
        FROM inventory_receipt_requests request JOIN business_records record ON record.id = request.record_id
        WHERE request.store_id = ? AND request.actor_user_id = ? AND request.client_request_id = ? LIMIT 1`)
        .bind(body.storeId, user.id, inventoryClientRequestId).first<{ id: string; receiptNo: string; payloadHash: string }>();
      if (replay) return replay.payloadHash === payloadHash
        ? json({ id: replay.id, receiptNo: replay.receiptNo, idempotent: true, message: "Phiếu nhập này đã được lưu trước đó." })
        : json({ message: "Mã chống lưu trùng đã được dùng cho phiếu nhập khác." }, 409);
      const exhausted = await db.prepare("SELECT last_value AS lastValue FROM inventory_receipt_code_sequences WHERE id = 1")
        .first<{ lastValue: number }>();
      if (Number(exhausted?.lastValue ?? 0) >= 99999) return json({ message: "Kho số phiếu nhập 5 chữ số đã hết. Không có dữ liệu nào được ghi." }, 409);
      console.error("Unable to atomically create inventory receipt", error);
      return json({ message: "Không thể lưu phiếu nhập. Dữ liệu và số phiếu chưa được ghi nhận." }, 500);
    }
  }
  if (body.category === "DONG_TIEN") {
    if (!body.storeId) return json({ message: "Chi phí phát sinh phải thuộc một cửa hàng." }, 400);
    const clientRequestId = String(data.clientRequestId ?? "");
    const paidAt = String(data.paidAt ?? "");
    id = `expense-${await sha256(`${body.storeId}\u0000${user.id}\u0000${clientRequestId}`)}`;
    const ledgerEntry = await buildCashflowEntry({
      storeId: body.storeId,
      direction: "OUT",
      amount: Number(data.amount),
      category: "VARIABLE_EXPENSE",
      sourceType: "VARIABLE_EXPENSE",
      sourceId: id,
      occurredAt: paidAt,
      createdBy: user.id,
      clientRequestId,
      note: `${body.title.trim()} · ${String(data.note)}`,
      createdAt: now,
    });
    data = {
      ...data,
      ledgerPayloadHash: ledgerEntry.payloadHash,
      savedAt: now,
      savedBy: user.id,
    };
    const replay = await db.prepare(`SELECT id, data_json AS dataJson, status
      FROM business_records WHERE id = ? AND category = 'DONG_TIEN' LIMIT 1`)
      .bind(id).first<{ id: string; dataJson: string; status: string }>();
    if (replay) {
      let replayHash = "";
      try { replayHash = String((JSON.parse(replay.dataJson) as Record<string, unknown>).ledgerPayloadHash ?? ""); } catch { replayHash = ""; }
      return replayHash === ledgerEntry.payloadHash
        ? json({ id: replay.id, status: replay.status, idempotent: true, message: "Khoản chi này đã được lưu trước đó." })
        : json({ message: "Mã chống lưu trùng đã được dùng cho khoản chi khác." }, 409);
    }
    const scope = financialWriteScope(body.category, body.storeId, data);
    if (!scope) return json({ message: "Dữ liệu kỳ chi phí không hợp lệ." }, 400);
    const sourceGuard = `EXISTS (
      SELECT 1 FROM business_records expense
      WHERE expense.id = ? AND expense.category = 'DONG_TIEN' AND expense.status = 'ACTIVE'
        AND json_extract(expense.data_json, '$.ledgerPayloadHash') = ?
    )`;
    try {
      const results = await db.batch([
        db.prepare(`INSERT INTO business_records
            (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
          SELECT ?, 'DONG_TIEN', ?, ?, ?, ?, 'ACTIVE', ?, ?
          WHERE ${incomingPeriodLockGuardSql}
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            id,
            body.storeId,
            user.id,
            body.title.trim(),
            JSON.stringify(data),
            now,
            now,
            scope.storeId,
            scope.period,
          ),
        prepareCashflowEntryInsertWhere(db, ledgerEntry, sourceGuard, [id, ledgerEntry.payloadHash]),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
          SELECT ?, ?, ?, 'CREATE', 'DONG_TIEN', expense.id, ?, NULL, ?, ?, ?
          FROM business_records expense
          WHERE expense.id = ? AND expense.category = 'DONG_TIEN' AND expense.status = 'ACTIVE'
            AND json_extract(expense.data_json, '$.ledgerPayloadHash') = ?`)
          .bind(
            crypto.randomUUID(),
            user.id,
            body.storeId,
            body.title.trim(),
            JSON.stringify(data),
            "Tạo và ghi nhận khoản chi phát sinh",
            now,
            id,
            ledgerEntry.payloadHash,
          ),
      ]);
      if (affectedRows(results[0]) === 1) {
        return json({ id, message: "Đã lưu chi phí và ghi nhận dòng tiền thực chi." }, 201);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/idempotency conflict|UNIQUE constraint failed/iu.test(message)) {
        return json({ message: "Mã chống lưu trùng đã được dùng cho khoản chi khác." }, 409);
      }
      if (/LOCKED financial period/iu.test(message)) return periodLockMessage();
      throw error;
    }
    const concurrent = await db.prepare(`SELECT id, data_json AS dataJson, status
      FROM business_records WHERE id = ? AND category = 'DONG_TIEN' LIMIT 1`)
      .bind(id).first<{ id: string; dataJson: string; status: string }>();
    if (concurrent) {
      let concurrentHash = "";
      try { concurrentHash = String((JSON.parse(concurrent.dataJson) as Record<string, unknown>).ledgerPayloadHash ?? ""); } catch { concurrentHash = ""; }
      return concurrentHash === ledgerEntry.payloadHash
        ? json({ id: concurrent.id, status: concurrent.status, idempotent: true, message: "Khoản chi này đã được lưu trước đó." })
        : json({ message: "Mã chống lưu trùng đã được dùng cho khoản chi khác." }, 409);
    }
    return periodLockMessage();
  }
  if (body.category === "LUONG_THUONG") {
    if (!body.storeId) return json({ message: "Khoản lương thưởng phải thuộc một cửa hàng." }, 400);
    const suppliedRequestId = body.clientRequestId ?? body.data?.clientRequestId ?? request.headers.get("Idempotency-Key");
    const clientRequestId = suppliedRequestId === undefined || suppliedRequestId === null || suppliedRequestId === ""
      ? null
      : normalizePayrollAdjustmentRequestId(suppliedRequestId);
    if (suppliedRequestId && !clientRequestId) return json({ message: "Mã chống lưu trùng của khoản lương thưởng không hợp lệ." }, 400);
    const status = body.status ?? "ACTIVE";
    const period = String(data.date ?? "").slice(0, 7);
    const payloadHash = await payrollAdjustmentPayloadHash({
      action: "CREATE",
      storeId: body.storeId,
      title: body.title.trim(),
      status,
      data,
    });
    if (clientRequestId) id = `payroll-adjustment-${await sha256(`${body.storeId}\u0000${user.id}\u0000${clientRequestId}`)}`;
    const mutationId = `payroll-adjustment-create:${crypto.randomUUID()}`;
    data = {
      ...data,
      period,
      version: 1,
      ...(clientRequestId ? { clientRequestId } : {}),
      createPayloadHash: payloadHash,
      payrollMutationId: mutationId,
      savedAt: now,
      savedBy: user.id,
    };
    const reason = meaningfulMutationReason(body.reason) ?? "Quản lý tạo khoản lương thưởng";
    try {
      const results = await db.batch([
        db.prepare(`INSERT INTO business_records
            (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
          SELECT ?, 'LUONG_THUONG', ?, ?, ?, ?, ?, ?, ?
          WHERE ${payrollAdjustmentIncomingGuardSql}
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            id, body.storeId, user.id, body.title.trim(), JSON.stringify(data), status, now, now,
            body.storeId, period, body.storeId, period,
          ),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail,
              before_json, after_json, reason, created_at)
          SELECT ?, ?, adjustment.store_id, 'CREATE', 'LUONG_THUONG', adjustment.id, ?,
            NULL, ?, ?, ?
          FROM business_records adjustment
          WHERE adjustment.id = ? AND adjustment.category = 'LUONG_THUONG'
            AND adjustment.created_at = ?
            AND json_extract(adjustment.data_json, '$.payrollMutationId') = ?`)
          .bind(
            crypto.randomUUID(), user.id, body.title.trim(),
            JSON.stringify({ title: body.title.trim(), data, status }), reason, now,
            id, now, mutationId,
          ),
      ]);
      if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) {
        return json({ id, version: 1, message: "Đã lưu khoản lương thưởng." }, 201);
      }
    } catch (error) {
      console.error("Unable to atomically create payroll adjustment", error);
      return json({ message: "Không thể lưu khoản lương thưởng; dữ liệu và nhật ký chưa được ghi." }, 500);
    }
    if (clientRequestId) {
      const replay = await db.prepare(`SELECT id, status, data_json AS dataJson FROM business_records
        WHERE id = ? AND category = 'LUONG_THUONG' LIMIT 1`)
        .bind(id).first<{ id: string; status: string; dataJson: string }>();
      if (replay) {
        let replayData: Record<string, unknown> = {};
        try { replayData = JSON.parse(replay.dataJson) as Record<string, unknown>; } catch { replayData = {}; }
        return replayData.clientRequestId === clientRequestId && replayData.createPayloadHash === payloadHash
          ? json({ id: replay.id, status: replay.status, version: payrollAdjustmentVersion(replayData.version), idempotent: true, message: "Khoản lương thưởng này đã được lưu trước đó." })
          : json({ message: "Mã chống lưu trùng đã được dùng cho khoản lương thưởng khác." }, 409);
      }
    }
    if (await isPayrollAdjustmentPeriodBlocked(db, body.storeId, period)) return periodLockMessage();
    return json({ message: "Khoản lương thưởng đã thay đổi trong lúc lưu. Vui lòng tải lại." }, 409);
  }
  const scope = financialWriteScope(body.category, body.storeId ?? null, data);
  if (payrollSensitiveCategories.has(body.category) && !scope) return json({ message: "D\u1eef li\u1ec7u k\u1ef3 l\u01b0\u01a1ng kh\u00f4ng h\u1ee3p l\u1ec7." }, 400);
  if (scope) {
    const conflictGuard = body.category === "CHI_PHI_CO_DINH" ? " ON CONFLICT(id) DO NOTHING" : "";
    const result = await db.prepare(`INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${incomingPeriodLockGuardSql}${conflictGuard}`)
      .bind(
        id, body.category, body.storeId ?? null, user.id, body.title.trim(), JSON.stringify(data), body.category === "CHI_PHI_CO_DINH" ? "ACTIVE" : body.status ?? "ACTIVE", now, now,
        scope.storeId, scope.period,
      ).run();
    if (affectedRows(result) === 0) {
      if (body.category === "CHI_PHI_CO_DINH" && fixedCostClientRequestId) {
        const duplicate = await db.prepare("SELECT id, store_id AS storeId, data_json AS dataJson, status FROM business_records WHERE id = ? AND category = 'CHI_PHI_CO_DINH' LIMIT 1")
          .bind(id).first<{ id: string; storeId: string | null; dataJson: string; status: string }>();
        if (duplicate) {
          let duplicateData: Record<string, unknown> = {};
          try { duplicateData = JSON.parse(duplicate.dataJson) as Record<string, unknown>; } catch { duplicateData = {}; }
          if (duplicate.storeId === body.storeId && duplicateData.clientRequestId === fixedCostClientRequestId) {
            return json({ id: duplicate.id, status: duplicate.status, idempotent: true, message: "Lần nhập này đã được lưu trước đó." });
          }
        }
      }
      return periodLockMessage();
    }
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
  if (immutableHistoryCategories.has(String(existing.category))) return json({ message: immutableHistoryMessage(String(existing.category), "update") }, 423);
  const existingStoreId = existing.store_id ? String(existing.store_id) : null;
  if (user.role === "MANAGER" && (existingStoreId
    ? !managerCanAccessStore(user, existingStoreId)
    : !managerHasGlobalStoreAccess(user))) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
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
  const existingData = parseRow(existing).data;
  const scheduleMutationReason = existingCategory === "LICH_PHAN_CA"
    ? meaningfulMutationReason(body.reason)
    : null;
  if (existingCategory === "LICH_PHAN_CA" && !scheduleMutationReason) {
    return json({ message: "Vui lòng nhập lý do chỉnh sửa lịch phân ca (từ 5 đến 500 ký tự)." }, 400);
  }
  if (existingStoreId && payrollSensitiveCategories.has(existingCategory)) {
    const previous = parseRow(existing).data;
    const previousPeriod = existingCategory === "CHI_PHI_CO_DINH"
      ? String(previous.period ?? "")
      : String(previous.date ?? "").slice(0, 7);
    const previousBlocked = previousPeriod && (existingCategory === "LUONG_THUONG"
      ? await isPayrollAdjustmentPeriodBlocked(db, existingStoreId, previousPeriod)
      : await isStorePeriodLocked(db, existingStoreId, previousPeriod));
    if (previousBlocked) {
      return json({ message: "Dữ liệu thuộc kỳ đã chốt lương và KPI, không thể chỉnh sửa hoặc chuyển sang kỳ khác." }, 423);
    }
  }
  const title = body.title?.trim() || String(existing.title);
  const incomingData = body.data
    ? existingCategory === "DONG_TIEN" ? { ...existingData, ...body.data } : body.data
    : existingData;
  const validated = await validateStoreRecord(db, String(existing.category), existingStoreId, incomingData, body.id);
  if (!validated.data) return json({ message: validated.message ?? "Dữ liệu nghiệp vụ không hợp lệ." }, 400);
  let data = validated.data;
  const updatedAt = new Date().toISOString();
  const scope = financialWriteScope(existingCategory, existingStoreId, data);
  if (payrollSensitiveCategories.has(existingCategory) && !scope) return json({ message: "D\u1eef li\u1ec7u k\u1ef3 l\u01b0\u01a1ng kh\u00f4ng h\u1ee3p l\u1ec7." }, 400);
  if (existingCategory === "DONG_TIEN" && existingStoreId && scope) {
    const status = body.status ?? String(existing.status);
    const unchanged = title === String(existing.title)
      && status === String(existing.status)
      && JSON.stringify(data) === JSON.stringify(existingData);
    if (unchanged) return json({ ok: true, idempotent: true });
    const mutationId = `expense-mutation:${crypto.randomUUID()}`;
    const originalLedger = await db.prepare(`SELECT id, amount, occurred_at AS occurredAt
      FROM cashflow_entries entry
      WHERE entry.store_id = ? AND entry.category = 'VARIABLE_EXPENSE' AND entry.direction = 'OUT'
        AND entry.source_type IN ('VARIABLE_EXPENSE', 'VARIABLE_EXPENSE_ADJUSTMENT')
        AND (entry.source_id = ? OR entry.source_id LIKE ?)
        AND NOT EXISTS (SELECT 1 FROM cashflow_entries reversal WHERE reversal.reverses_entry_id = entry.id)
      ORDER BY entry.occurred_at DESC, entry.created_at DESC, entry.id DESC LIMIT 1`)
      .bind(existingStoreId, body.id, `${body.id}:%`)
      .first<{ id: string; amount: number; occurredAt: string }>();
    let reversalEntry: CashflowLedgerEntry | null = null;
    let replacementEntry: CashflowLedgerEntry | null = null;
    if (originalLedger) {
      const originalTime = Date.parse(originalLedger.occurredAt);
      const correctionAt = new Date(Math.max(Date.parse(updatedAt), Number.isFinite(originalTime) ? originalTime : 0)).toISOString();
      reversalEntry = await buildCashflowEntry({
        storeId: existingStoreId,
        direction: "IN",
        amount: Number(originalLedger.amount),
        category: "VARIABLE_EXPENSE",
        sourceType: "REVERSAL",
        sourceId: originalLedger.id,
        occurredAt: correctionAt,
        createdBy: user.id,
        clientRequestId: `${mutationId}:reversal`,
        note: `Đảo khoản chi trước khi chỉnh sửa · ${String(existing.title)}`,
        reversesEntryId: originalLedger.id,
        createdAt: updatedAt,
      });
      replacementEntry = await buildCashflowEntry({
        storeId: existingStoreId,
        direction: "OUT",
        amount: Number(data.amount),
        category: "VARIABLE_EXPENSE",
        sourceType: "VARIABLE_EXPENSE_ADJUSTMENT",
        sourceId: `${body.id}:${mutationId}`,
        occurredAt: correctionAt,
        createdBy: user.id,
        clientRequestId: `${mutationId}:replacement`,
        note: `${title} · ${String(data.note)}`,
        createdAt: updatedAt,
      });
    }
    data = {
      ...data,
      cashflowMutationId: mutationId,
      cashflowAdjustedAt: updatedAt,
      ...(replacementEntry ? { ledgerPayloadHash: replacementEntry.payloadHash } : {}),
    };
    const mutationGuard = `EXISTS (
      SELECT 1 FROM business_records expense
      WHERE expense.id = ? AND expense.status != 'DELETED'
        AND json_extract(expense.data_json, '$.cashflowMutationId') = ?
    )`;
    const statements = [
      db.prepare(`UPDATE business_records
        SET title = ?, data_json = ?, status = ?, updated_at = ?
        WHERE id = ? AND status != 'DELETED' AND updated_at = ?
          AND ${existingPeriodLockGuardSql}
          AND ${incomingPeriodLockGuardSql}`)
        .bind(
          title,
          JSON.stringify(data),
          status,
          updatedAt,
          body.id,
          String(existing.updated_at),
          scope.storeId,
          scope.period,
        ),
      ...(reversalEntry ? [prepareCashflowReversalInsertWhere(
        db,
        reversalEntry,
        mutationGuard,
        [body.id, mutationId],
      )] : []),
      ...(replacementEntry ? [prepareCashflowEntryInsertWhere(
        db,
        replacementEntry,
        mutationGuard,
        [body.id, mutationId],
      )] : []),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
        SELECT ?, ?, ?, 'UPDATE', 'DONG_TIEN', expense.id, ?, ?, ?, ?, ?
        FROM business_records expense
        WHERE expense.id = ? AND expense.status != 'DELETED'
          AND json_extract(expense.data_json, '$.cashflowMutationId') = ?`)
        .bind(
          crypto.randomUUID(),
          user.id,
          existingStoreId,
          title,
          JSON.stringify({ title: existing.title, data: existingData, status: existing.status }),
          JSON.stringify({ title, data, status }),
          String(body.reason ?? "").trim() || "Quản lý chỉnh sửa chi phí phát sinh",
          updatedAt,
          body.id,
          mutationId,
        ),
    ];
    try {
      const results = await db.batch(statements);
      if (affectedRows(results[0]) === 1) return json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/LOCKED financial period/iu.test(message)) return periodLockMessage();
      if (/cashflow idempotency conflict|invalid cashflow reversal|UNIQUE constraint failed/iu.test(message)) {
        return json({ message: "Dòng tiền của khoản chi đã thay đổi bởi yêu cầu khác. Vui lòng tải lại." }, 409);
      }
      throw error;
    }
    if (await isStorePeriodLocked(db, existingStoreId, scope.period)) return periodLockMessage();
    return json({ message: "Khoản chi đã được cập nhật bởi yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  if (existingCategory === "LUONG_THUONG" && existingStoreId && scope) {
    const currentVersion = payrollAdjustmentVersion(existingData.version);
    const suppliedExpectedVersion = body.expectedVersion ?? body.data?.version;
    if (suppliedExpectedVersion !== undefined) {
      const expectedVersion = Number(suppliedExpectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
        return json({ message: "Phiên bản khoản lương thưởng không hợp lệ." }, 400);
      }
      if (expectedVersion !== currentVersion) {
        return json({ message: "Khoản lương thưởng đã được cập nhật. Vui lòng tải lại dữ liệu mới nhất." }, 409);
      }
    }
    const mutationRequestId = normalizePayrollAdjustmentRequestId(body.clientRequestId ?? request.headers.get("Idempotency-Key"));
    if ((body.clientRequestId || request.headers.get("Idempotency-Key")) && !mutationRequestId) {
      return json({ message: "Mã chống lưu trùng của lần chỉnh sửa không hợp lệ." }, 400);
    }
    const status = body.status ?? String(existing.status);
    const mutationPayloadHash = await payrollAdjustmentPayloadHash({
      action: "UPDATE",
      storeId: existingStoreId,
      title,
      status,
      data,
    });
    if (mutationRequestId
      && existingData.lastMutationRequestId === mutationRequestId
      && existingData.lastMutationPayloadHash === mutationPayloadHash) {
      return json({ ok: true, version: currentVersion, idempotent: true });
    }
    if (mutationRequestId && existingData.lastMutationRequestId === mutationRequestId) {
      return json({ message: "Mã chống lưu trùng đã được dùng cho nội dung chỉnh sửa khác." }, 409);
    }
    const mutationId = `payroll-adjustment-update:${crypto.randomUUID()}`;
    const nextVersion = currentVersion + 1;
    data = {
      ...data,
      period: scope.period,
      version: nextVersion,
      ...(existingData.clientRequestId ? { clientRequestId: existingData.clientRequestId } : {}),
      ...(existingData.createPayloadHash ? { createPayloadHash: existingData.createPayloadHash } : {}),
      ...(mutationRequestId ? {
        lastMutationRequestId: mutationRequestId,
        lastMutationPayloadHash: mutationPayloadHash,
      } : {}),
      payrollMutationId: mutationId,
      updatedBy: user.id,
    };
    const reason = meaningfulMutationReason(body.reason) ?? "Quản lý điều chỉnh khoản lương thưởng";
    const before = JSON.stringify({ title: existing.title, data: existingData, status: existing.status });
    const after = JSON.stringify({ title, data, status });
    try {
      const results = await db.batch([
        db.prepare(`UPDATE business_records
          SET title = ?, data_json = ?, status = ?, updated_at = ?
          WHERE id = ? AND category = 'LUONG_THUONG' AND status != 'DELETED'
            AND updated_at = ?
            AND CAST(COALESCE(json_extract(data_json, '$.version'), 1) AS INTEGER) = ?
            AND ${payrollAdjustmentExistingGuardSql}
            AND ${payrollAdjustmentIncomingGuardSql}`)
          .bind(
            title, JSON.stringify(data), status, updatedAt, body.id,
            String(existing.updated_at), currentVersion,
            scope.storeId, scope.period, scope.storeId, scope.period,
          ),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail,
              before_json, after_json, reason, created_at)
          SELECT ?, ?, adjustment.store_id, 'UPDATE', 'LUONG_THUONG', adjustment.id, ?,
            ?, ?, ?, ?
          FROM business_records adjustment
          WHERE adjustment.id = ? AND adjustment.category = 'LUONG_THUONG'
            AND adjustment.status = ? AND adjustment.updated_at = ?
            AND json_extract(adjustment.data_json, '$.payrollMutationId') = ?
            AND CAST(json_extract(adjustment.data_json, '$.version') AS INTEGER) = ?`)
          .bind(
            crypto.randomUUID(), user.id, title, before, after, reason, updatedAt,
            body.id, status, updatedAt, mutationId, nextVersion,
          ),
      ]);
      if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) {
        return json({ ok: true, version: nextVersion });
      }
    } catch (error) {
      console.error("Unable to atomically update payroll adjustment", error);
      return json({ message: "Không thể cập nhật khoản lương thưởng; dữ liệu và nhật ký chưa được ghi." }, 500);
    }
    const concurrent = await db.prepare("SELECT data_json AS dataJson FROM business_records WHERE id = ? AND category = 'LUONG_THUONG' LIMIT 1")
      .bind(body.id).first<{ dataJson: string }>();
    let concurrentData: Record<string, unknown> = {};
    try { concurrentData = JSON.parse(concurrent?.dataJson ?? "{}") as Record<string, unknown>; } catch { concurrentData = {}; }
    if (mutationRequestId
      && concurrentData.lastMutationRequestId === mutationRequestId
      && concurrentData.lastMutationPayloadHash === mutationPayloadHash) {
      return json({ ok: true, version: payrollAdjustmentVersion(concurrentData.version), idempotent: true });
    }
    const previousPeriod = String(existingData.period ?? String(existingData.date ?? "").slice(0, 7));
    if ((previousPeriod && await isPayrollAdjustmentPeriodBlocked(db, existingStoreId, previousPeriod))
      || await isPayrollAdjustmentPeriodBlocked(db, existingStoreId, scope.period)) return periodLockMessage();
    return json({ message: "Khoản lương thưởng đã được cập nhật bởi yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  if (scope) {
    const result = await db.prepare(`UPDATE business_records
      SET title = ?, data_json = ?, status = ?, updated_at = ?
      WHERE id = ? AND status != 'DELETED'
        AND ${existingPeriodLockGuardSql}
        AND ${incomingPeriodLockGuardSql}`)
      .bind(
        title, JSON.stringify(data), body.status ?? String(existing.status), updatedAt, body.id,
        scope.storeId, scope.period,
      ).run();
    if (affectedRows(result) === 0) return periodLockMessage();
  } else if (existingCategory === "CA_LAM_VIEC") {
    const result = await db.prepare(`UPDATE business_records
      SET title = ?, data_json = ?, status = ?, updated_at = ?
      WHERE id = ? AND status != 'DELETED' AND ${shiftDefinitionMutableGuardSql}`)
      .bind(title, JSON.stringify(data), body.status ?? String(existing.status), updatedAt, body.id).run();
    if (affectedRows(result) === 0) {
      return json({ message: await shiftDefinitionConflictMessage(db, body.id) }, 409);
    }
  } else if (existingCategory === "LICH_PHAN_CA") {
    if (!existingStoreId) return json({ message: "Lịch phân ca không thuộc cửa hàng hợp lệ." }, 400);
    const scheduleMutationId = `schedule-update:${crypto.randomUUID()}`;
    const scheduleData = { ...data, scheduleMutationId };
    const dataJson = JSON.stringify(scheduleData);
    const status = body.status ?? String(existing.status);
    const hasVersionedDefinition = Number.isInteger(Number(data.shiftDefinitionVersion));
    const definitionGuard = hasVersionedDefinition ? `AND EXISTS (
        SELECT 1 FROM daily_shift_definitions daily_shift
        WHERE daily_shift.id = json_extract(?, '$.shiftId')
          AND daily_shift.store_id = business_records.store_id
          AND daily_shift.work_date = json_extract(?, '$.date')
          AND daily_shift.name = json_extract(?, '$.shiftName')
          AND daily_shift.start_time = json_extract(?, '$.start')
          AND daily_shift.end_time = json_extract(?, '$.end')
          AND daily_shift.version = json_extract(?, '$.shiftDefinitionVersion')
          AND daily_shift.status = 'ACTIVE'
      )` : "";
    const oldPeriodGuard = storePeriodUnlockedSql(
      "business_records.store_id",
      "substr(json_extract(business_records.data_json, '$.date'), 1, 7)",
    );
    const results = await db.batch([
      db.prepare(`UPDATE business_records SET title = ?, data_json = ?, status = ?, updated_at = ?
        WHERE id = ? AND category = 'LICH_PHAN_CA' AND status != 'DELETED' AND updated_at = ?
          AND ${oldPeriodGuard}
          AND ${incomingPeriodLockGuardSql}
          ${definitionGuard}`)
        .bind(
          title, dataJson, status, updatedAt, body.id, String(existing.updated_at),
          existingStoreId, String(data.date ?? "").slice(0, 7),
          ...(hasVersionedDefinition ? Array.from({ length: 6 }, () => dataJson) : []),
        ),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
            before_json, after_json, reason, created_at)
        SELECT ?, ?, schedule.store_id, 'UPDATE_SCHEDULE', 'LICH_PHAN_CA', schedule.id, ?,
          ?, ?, ?, ?
        FROM business_records schedule
        WHERE schedule.id = ? AND schedule.category = 'LICH_PHAN_CA'
          AND schedule.status = ? AND schedule.updated_at = ? AND schedule.data_json = ?
          AND json_extract(schedule.data_json, '$.scheduleMutationId') = ?`)
        .bind(
          crypto.randomUUID(), user.id, title,
          JSON.stringify({ title: existing.title, data: existingData, status: existing.status }),
          JSON.stringify({ title, data: scheduleData, status }), scheduleMutationReason, updatedAt,
          body.id, status, updatedAt, dataJson, scheduleMutationId,
        ),
    ]);
    if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) return json({ ok: true });
    const previousPeriod = String(existingData.date ?? "").slice(0, 7);
    const nextPeriod = String(data.date ?? "").slice(0, 7);
    if ((previousPeriod && await isStorePeriodLocked(db, existingStoreId, previousPeriod))
      || (nextPeriod && await isStorePeriodLocked(db, existingStoreId, nextPeriod))) {
      return json({ message: "Kỳ tài chính đã khóa, không thể chỉnh sửa lịch phân ca." }, 423);
    }
    return json({ message: hasVersionedDefinition
      ? "Ca làm việc hoặc lịch phân ca đã thay đổi trong lúc lưu. Vui lòng tải lại."
      : "Lịch phân ca đã thay đổi trong lúc lưu. Vui lòng tải lại." }, 409);
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
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get("id");
  const requestedDeleteReason = meaningfulMutationReason(searchParams.get("reason"));
  const deleteReason = requestedDeleteReason ?? "Quản lý xóa chi phí phát sinh";
  const deleteRequestIdValue = searchParams.get("clientRequestId") ?? request.headers.get("Idempotency-Key");
  const deleteRequestId = normalizePayrollAdjustmentRequestId(deleteRequestIdValue);
  const requestedDeleteVersion = searchParams.get("expectedVersion") ?? request.headers.get("If-Match");
  if (!id) return json({ message: "Thiếu mã dữ liệu" }, 400);
  const db = await initDb();
  const existing = await db.prepare(`SELECT store_id AS storeId, category, title, data_json AS dataJson,
      status, updated_at AS updatedAt
    FROM business_records WHERE id = ? LIMIT 1`)
    .bind(id).first<{
      storeId: string | null;
      category: string;
      title: string;
      dataJson: string;
      status: string;
      updatedAt: string;
    }>();
  if (!existing) return json({ message: "Không tìm thấy dữ liệu" }, 404);
  if (existing.storeId
    ? !managerCanAccessStore(user, existing.storeId)
    : !managerHasGlobalStoreAccess(user)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  let payrollDeleteData: Record<string, unknown> = {};
  if (existing.category === "LUONG_THUONG") {
    try { payrollDeleteData = JSON.parse(existing.dataJson) as Record<string, unknown>; } catch { payrollDeleteData = {}; }
    if (deleteRequestIdValue && !deleteRequestId) return json({ message: "Mã chống lưu trùng của lần xóa không hợp lệ." }, 400);
    if (existing.status === "DELETED") {
      const deletePayloadHash = await payrollAdjustmentPayloadHash({
        action: "DELETE",
        storeId: String(existing.storeId ?? ""),
        title: existing.title,
        status: "DELETED",
        data: payrollDeleteData,
      });
      if (deleteRequestId
        && payrollDeleteData.lastMutationRequestId === deleteRequestId
        && payrollDeleteData.lastMutationPayloadHash === deletePayloadHash) {
        return json({ ok: true, version: payrollAdjustmentVersion(payrollDeleteData.version), idempotent: true });
      }
      return json({ message: "Không tìm thấy dữ liệu" }, 404);
    }
  } else if (existing.status === "DELETED") {
    return json({ message: "Không tìm thấy dữ liệu" }, 404);
  }
  if (existing.category === "KPI_SUMMARY" || existing.category === "PAYROLL_CLOSING" || existing.category === "DIVIDEND") return json({ message: "Sổ đã chốt không thể xóa." }, 423);
  if (immutableHistoryCategories.has(existing.category)) return json({ message: immutableHistoryMessage(existing.category, "delete") }, 423);
  if (existing.storeId && !await isStoreActive(existing.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (existing.category === "LICH_PHAN_CA" && !requestedDeleteReason) {
    return json({ message: "Vui lòng nhập lý do xóa lịch phân ca (từ 5 đến 500 ký tự)." }, 400);
  }
  if (payrollSensitiveCategories.has(existing.category) && existing.storeId) {
    let period = "";
    try {
      const data = JSON.parse(existing.dataJson) as { date?: string; period?: string };
      period = existing.category === "CHI_PHI_CO_DINH" ? String(data.period ?? "") : String(data.date ?? "").slice(0, 7);
    } catch { period = ""; }
    const blocked = period && (existing.category === "LUONG_THUONG"
      ? await isPayrollAdjustmentPeriodBlocked(db, existing.storeId, period)
      : await isStorePeriodLocked(db, existing.storeId, period));
    if (blocked) return json({ message: "Kỳ đã chốt lương và KPI, không thể xóa dữ liệu chi phí." }, 423);
  }
  const deletedAt = new Date().toISOString();
  if (existing.category === "LUONG_THUONG" && existing.storeId) {
    const currentVersion = payrollAdjustmentVersion(payrollDeleteData.version);
    if (requestedDeleteVersion !== null) {
      const expectedVersion = Number(requestedDeleteVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
        return json({ message: "Phiên bản khoản lương thưởng không hợp lệ." }, 400);
      }
      if (expectedVersion !== currentVersion) {
        return json({ message: "Khoản lương thưởng đã được cập nhật. Vui lòng tải lại dữ liệu mới nhất." }, 409);
      }
    }
    const mutationPayloadHash = await payrollAdjustmentPayloadHash({
      action: "DELETE",
      storeId: existing.storeId,
      title: existing.title,
      status: "DELETED",
      data: payrollDeleteData,
    });
    if (deleteRequestId && payrollDeleteData.lastMutationRequestId === deleteRequestId) {
      return payrollDeleteData.lastMutationPayloadHash === mutationPayloadHash
        ? json({ ok: true, version: currentVersion, idempotent: true })
        : json({ message: "Mã chống lưu trùng đã được dùng cho yêu cầu xóa khác." }, 409);
    }
    const mutationId = `payroll-adjustment-delete:${crypto.randomUUID()}`;
    const nextVersion = currentVersion + 1;
    const deletedData = {
      ...payrollDeleteData,
      version: nextVersion,
      ...(deleteRequestId ? {
        lastMutationRequestId: deleteRequestId,
        lastMutationPayloadHash: mutationPayloadHash,
      } : {}),
      payrollMutationId: mutationId,
      deletedAt,
      deletedBy: user.id,
    };
    const reason = requestedDeleteReason ?? "Quản lý xóa khoản lương thưởng";
    try {
      const results = await db.batch([
        db.prepare(`UPDATE business_records
          SET data_json = ?, status = 'DELETED', updated_at = ?
          WHERE id = ? AND category = 'LUONG_THUONG' AND status != 'DELETED'
            AND updated_at = ?
            AND CAST(COALESCE(json_extract(data_json, '$.version'), 1) AS INTEGER) = ?
            AND ${payrollAdjustmentExistingGuardSql}`)
          .bind(JSON.stringify(deletedData), deletedAt, id, existing.updatedAt, currentVersion),
        db.prepare(`INSERT INTO audit_logs
            (id, user_id, store_id, action, entity_type, entity_id, detail,
              before_json, after_json, reason, created_at)
          SELECT ?, ?, adjustment.store_id, 'DELETE', 'LUONG_THUONG', adjustment.id, ?,
            ?, ?, ?, ?
          FROM business_records adjustment
          WHERE adjustment.id = ? AND adjustment.category = 'LUONG_THUONG'
            AND adjustment.status = 'DELETED' AND adjustment.updated_at = ?
            AND json_extract(adjustment.data_json, '$.payrollMutationId') = ?
            AND CAST(json_extract(adjustment.data_json, '$.version') AS INTEGER) = ?`)
          .bind(
            crypto.randomUUID(), user.id, existing.title,
            JSON.stringify({ title: existing.title, data: payrollDeleteData, status: existing.status }),
            JSON.stringify({ title: existing.title, data: deletedData, status: "DELETED" }),
            reason, deletedAt, id, deletedAt, mutationId, nextVersion,
          ),
      ]);
      if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) {
        return json({ ok: true, version: nextVersion });
      }
    } catch (error) {
      console.error("Unable to atomically delete payroll adjustment", error);
      return json({ message: "Không thể xóa khoản lương thưởng; dữ liệu và nhật ký chưa được ghi." }, 500);
    }
    const current = await db.prepare("SELECT data_json AS dataJson, status FROM business_records WHERE id = ? AND category = 'LUONG_THUONG' LIMIT 1")
      .bind(id).first<{ dataJson: string; status: string }>();
    let currentData: Record<string, unknown> = {};
    try { currentData = JSON.parse(current?.dataJson ?? "{}") as Record<string, unknown>; } catch { currentData = {}; }
    if (current?.status === "DELETED" && deleteRequestId
      && currentData.lastMutationRequestId === deleteRequestId
      && currentData.lastMutationPayloadHash === mutationPayloadHash) {
      return json({ ok: true, version: payrollAdjustmentVersion(currentData.version), idempotent: true });
    }
    const period = String(payrollDeleteData.period ?? String(payrollDeleteData.date ?? "").slice(0, 7));
    if (period && await isPayrollAdjustmentPeriodBlocked(db, existing.storeId, period)) return periodLockMessage();
    return json({ message: "Khoản lương thưởng đã được cập nhật bởi yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  if (existing.category === "DONG_TIEN" && existing.storeId) {
    let existingData: Record<string, unknown> = {};
    try { existingData = JSON.parse(existing.dataJson) as Record<string, unknown>; } catch { existingData = {}; }
    const mutationId = `expense-delete:${crypto.randomUUID()}`;
    const originalLedger = await db.prepare(`SELECT id, amount, occurred_at AS occurredAt
      FROM cashflow_entries entry
      WHERE entry.store_id = ? AND entry.category = 'VARIABLE_EXPENSE' AND entry.direction = 'OUT'
        AND entry.source_type IN ('VARIABLE_EXPENSE', 'VARIABLE_EXPENSE_ADJUSTMENT')
        AND (entry.source_id = ? OR entry.source_id LIKE ?)
        AND NOT EXISTS (SELECT 1 FROM cashflow_entries reversal WHERE reversal.reverses_entry_id = entry.id)
      ORDER BY entry.occurred_at DESC, entry.created_at DESC, entry.id DESC LIMIT 1`)
      .bind(existing.storeId, id, `${id}:%`)
      .first<{ id: string; amount: number; occurredAt: string }>();
    let reversalEntry: CashflowLedgerEntry | null = null;
    if (originalLedger) {
      const originalTime = Date.parse(originalLedger.occurredAt);
      const correctionAt = new Date(Math.max(Date.parse(deletedAt), Number.isFinite(originalTime) ? originalTime : 0)).toISOString();
      reversalEntry = await buildCashflowEntry({
        storeId: existing.storeId,
        direction: "IN",
        amount: Number(originalLedger.amount),
        category: "VARIABLE_EXPENSE",
        sourceType: "REVERSAL",
        sourceId: originalLedger.id,
        occurredAt: correctionAt,
        createdBy: user.id,
        clientRequestId: `${mutationId}:reversal`,
        note: `Đảo khoản chi đã xóa · ${existing.title}`,
        reversesEntryId: originalLedger.id,
        createdAt: deletedAt,
      });
    }
    const deletedData = {
      ...existingData,
      cashflowMutationId: mutationId,
      cashflowReversedAt: deletedAt,
    };
    const deleteGuard = `EXISTS (
      SELECT 1 FROM business_records expense
      WHERE expense.id = ? AND expense.status = 'DELETED'
        AND json_extract(expense.data_json, '$.cashflowMutationId') = ?
    )`;
    const statements = [
      db.prepare(`UPDATE business_records
        SET data_json = ?, status = 'DELETED', updated_at = ?
        WHERE id = ? AND status != 'DELETED' AND updated_at = ?
          AND ${existingPeriodLockGuardSql}`)
        .bind(JSON.stringify(deletedData), deletedAt, id, existing.updatedAt),
      ...(reversalEntry ? [prepareCashflowReversalInsertWhere(
        db,
        reversalEntry,
        deleteGuard,
        [id, mutationId],
      )] : []),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail, before_json, after_json, reason, created_at)
        SELECT ?, ?, ?, 'DELETE', 'DONG_TIEN', expense.id, ?, ?, ?, ?, ?
        FROM business_records expense
        WHERE expense.id = ? AND expense.status = 'DELETED'
          AND json_extract(expense.data_json, '$.cashflowMutationId') = ?`)
        .bind(
          crypto.randomUUID(),
          user.id,
          existing.storeId,
          existing.title,
          JSON.stringify({ title: existing.title, data: existingData, status: existing.status }),
          JSON.stringify({ title: existing.title, data: deletedData, status: "DELETED" }),
          deleteReason,
          deletedAt,
          id,
          mutationId,
        ),
    ];
    try {
      const results = await db.batch(statements);
      if (affectedRows(results[0]) === 1) return json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/LOCKED financial period/iu.test(message)) return periodLockMessage();
      if (/cashflow idempotency conflict|invalid cashflow reversal|UNIQUE constraint failed/iu.test(message)) {
        return json({ message: "Dòng tiền của khoản chi đã thay đổi bởi yêu cầu khác. Vui lòng tải lại." }, 409);
      }
      throw error;
    }
    const period = String(existingData.period ?? String(existingData.date ?? "").slice(0, 7));
    if (period && await isStorePeriodLocked(db, existing.storeId, period)) return periodLockMessage();
    return json({ message: "Khoản chi đã được cập nhật bởi yêu cầu khác. Vui lòng tải lại." }, 409);
  }
  if (payrollSensitiveCategories.has(existing.category)) {
    const result = await db.prepare(`UPDATE business_records
      SET status = 'DELETED', updated_at = ?
      WHERE id = ? AND status != 'DELETED'
        AND ${existingPeriodLockGuardSql}`)
      .bind(deletedAt, id).run();
    if (affectedRows(result) === 0) return periodLockMessage();
  } else if (existing.category === "CA_LAM_VIEC") {
    const result = await db.prepare(`UPDATE business_records
      SET status = 'DELETED', updated_at = ?
      WHERE id = ? AND status != 'DELETED' AND ${shiftDefinitionMutableGuardSql}`)
      .bind(deletedAt, id).run();
    if (affectedRows(result) === 0) {
      return json({ message: await shiftDefinitionConflictMessage(db, id) }, 409);
    }
  } else if (existing.category === "LICH_PHAN_CA" && existing.storeId) {
    let existingData: Record<string, unknown> = {};
    try { existingData = JSON.parse(existing.dataJson) as Record<string, unknown>; } catch { existingData = {}; }
    const period = String(existingData.date ?? "").slice(0, 7);
    const scheduleMutationId = `schedule-delete:${crypto.randomUUID()}`;
    const deletedData = { ...existingData, scheduleMutationId };
    const deletedDataJson = JSON.stringify(deletedData);
    const schedulePeriodGuard = storePeriodUnlockedSql(
      "business_records.store_id",
      "substr(json_extract(business_records.data_json, '$.date'), 1, 7)",
    );
    const results = await db.batch([
      db.prepare(`UPDATE business_records SET data_json = ?, status = 'DELETED', updated_at = ?
        WHERE id = ? AND category = 'LICH_PHAN_CA' AND status != 'DELETED' AND updated_at = ?
          AND ${schedulePeriodGuard}`)
        .bind(deletedDataJson, deletedAt, id, existing.updatedAt),
      db.prepare(`INSERT INTO audit_logs
          (id, user_id, store_id, action, entity_type, entity_id, detail,
            before_json, after_json, reason, created_at)
        SELECT ?, ?, schedule.store_id, 'DELETE_SCHEDULE', 'LICH_PHAN_CA', schedule.id, ?,
          ?, ?, ?, ?
        FROM business_records schedule
        WHERE schedule.id = ? AND schedule.category = 'LICH_PHAN_CA'
          AND schedule.status = 'DELETED' AND schedule.updated_at = ?
          AND schedule.data_json = ?
          AND json_extract(schedule.data_json, '$.scheduleMutationId') = ?`)
        .bind(
          crypto.randomUUID(), user.id, existing.title,
          JSON.stringify({ title: existing.title, data: existingData, status: existing.status }),
          JSON.stringify({ title: existing.title, data: deletedData, status: "DELETED" }),
          requestedDeleteReason, deletedAt, id, deletedAt, deletedDataJson, scheduleMutationId,
        ),
    ]);
    if (affectedRows(results[0]) === 1 && affectedRows(results[1]) === 1) return json({ ok: true });
    if (period && await isStorePeriodLocked(db, existing.storeId, period)) {
      return json({ message: "Kỳ tài chính đã khóa, không thể xóa lịch phân ca." }, 423);
    }
    return json({ message: "Lịch phân ca đã thay đổi trong lúc xóa. Vui lòng tải lại." }, 409);
  } else {
    await db.prepare("UPDATE business_records SET status = 'DELETED', updated_at = ? WHERE id = ?").bind(deletedAt, id).run();
  }
  await writeAudit(user.id, "DELETE", "BUSINESS_RECORD", id);
  return json({ ok: true });
}
