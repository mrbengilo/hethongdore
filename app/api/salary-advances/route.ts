import { initDb } from "../../../db/runtime";
import {
  confirmSalaryAdvance,
  createSalaryAdvance,
  getSalaryAdvance,
  listSalaryAdvances,
  SalaryAdvanceConflictError,
  salaryAdvancePayrollRevision,
  salaryAdvanceTotals,
  updateSalaryAdvance,
} from "../../lib/salary-advances";
import { GET as getPayroll } from "../payroll/route";
import { getSessionUser, INACTIVE_STORE_MESSAGE, isStoreActive, json, sha256 } from "../_lib/auth";
import { MANAGER_STORE_SCOPE_MESSAGE, managerCanAccessStore, resolveManagerStoreScope } from "../_lib/manager-scope";
import { isStorePeriodLocked } from "../_lib/store-period-lock";

type SalaryAdvanceBody = {
  action?: "CONFIRM_PAYMENT";
  id?: string;
  storeId?: string;
  employeeId?: string;
  period?: string;
  advanceDate?: string;
  amount?: number | string;
  note?: string;
  version?: number | string;
  clientRequestId?: string;
};

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

type PayrollPreview = {
  items: Array<{ employeeId: string; employeeCode: string; employeeName: string; totalPay: number }>;
};

async function payrollPreview(request: Request, storeId: string, period: string) {
  const url = new URL("/api/payroll", request.url);
  url.searchParams.set("storeId", storeId);
  url.searchParams.set("period", period);
  const response = await getPayroll(new Request(url, { method: "GET", headers: request.headers }));
  const payload = await response.json() as { summary?: PayrollPreview; message?: string };
  if (!response.ok || !payload.summary) {
    throw new Error(payload.message || "Không thể tính lương khả dụng cho kỳ đã chọn.");
  }
  return payload.summary;
}

function noStoreJson(data: unknown, status = 200) {
  return json(data, status, NO_STORE_HEADERS);
}

function validDate(value: string, period: string) {
  if (!DATE_PATTERN.test(value) || value.slice(0, 7) !== period) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function amountValue(value: unknown) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function versionValue(value: unknown) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function noteValue(value: unknown) {
  const note = String(value ?? "").trim();
  return note.length >= 2 && note.length <= 500 ? note : null;
}

function conflictResponse(error: SalaryAdvanceConflictError) {
  if (error.reason === "FORBIDDEN") return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (error.reason === "INACTIVE") return noStoreJson({ message: INACTIVE_STORE_MESSAGE }, 409);
  if (error.reason === "LOCKED") return noStoreJson({ message: "Kỳ lương đã xác nhận, đã chi hoặc đã khóa; không thể thay đổi khoản ứng lương." }, 423);
  if (error.reason === "LIMIT") return noStoreJson({ message: "Số tiền ứng không được vượt quá số tiền khả dụng của nhân viên trong kỳ lương này." }, 409);
  if (error.reason === "NOT_FOUND") return noStoreJson({ message: "Không tìm thấy khoản ứng lương hoặc nhân viên trong cửa hàng này." }, 404);
  if (error.reason === "PAID") return noStoreJson({ message: "Khoản ứng lương đã xác nhận chi nên không thể chỉnh sửa." }, 409);
  if (error.reason === "IDEMPOTENCY") return noStoreJson({ message: "Mã yêu cầu đã được dùng cho một nội dung ứng lương khác." }, 409);
  return noStoreJson({ message: "Khoản ứng lương vừa được cập nhật bởi một yêu cầu khác. Vui lòng tải lại." }, 409);
}

async function responseData(db: D1Database, storeId: string, period: string, request: Request) {
  const [advances, totals, summary, locked] = await Promise.all([
    listSalaryAdvances(db, storeId, period),
    salaryAdvanceTotals(db, storeId, period),
    payrollPreview(request, storeId, period),
    isStorePeriodLocked(db, storeId, period),
  ]);
  const totalsByEmployee = new Map(totals.map((item) => [item.employeeId, item]));
  const employees = (summary?.items ?? []).map((item) => {
    const advance = totalsByEmployee.get(item.employeeId);
    const pendingAmount = Number(advance?.pendingAmount ?? 0);
    const paidAmount = Number(advance?.paidAmount ?? 0);
    const reservedAmount = pendingAmount + paidAmount;
    return {
      employeeId: item.employeeId,
      employeeCode: item.employeeCode,
      employeeName: item.employeeName,
      grossEntitlement: item.totalPay,
      pendingAmount,
      paidAmount,
      reservedAmount,
      availableAmount: Math.max(0, item.totalPay - reservedAmount),
      coverageGap: Math.max(0, reservedAmount - item.totalPay),
      overpaymentDebt: Math.max(0, paidAmount - item.totalPay),
    };
  });
  return {
    storeId,
    period,
    serverNow: new Date().toISOString(),
    locked,
    advances,
    employees,
    totals: {
      pendingAmount: employees.reduce((sum, item) => sum + item.pendingAmount, 0),
      paidAmount: employees.reduce((sum, item) => sum + item.paidAmount, 0),
      reservedAmount: employees.reduce((sum, item) => sum + item.reservedAmount, 0),
      availableAmount: employees.reduce((sum, item) => sum + item.availableAmount, 0),
      coverageGap: employees.reduce((sum, item) => sum + item.coverageGap, 0),
      overpaymentDebt: employees.reduce((sum, item) => sum + item.overpaymentDebt, 0),
    },
  };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được xem và thao tác ứng lương." }, 403);
  const params = new URL(request.url).searchParams;
  const period = params.get("period")?.trim() ?? "";
  if (!PERIOD_PATTERN.test(period)) return noStoreJson({ message: "Kỳ lương không hợp lệ." }, 400);
  const scope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!scope.allowed) return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!scope.storeId) return noStoreJson({ message: "Vui lòng chọn cửa hàng." }, 400);
  const db = await initDb();
  return noStoreJson(await responseData(db, scope.storeId, period, request));
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được tạo khoản ứng lương." }, 403);
  const body = await request.json().catch(() => ({})) as SalaryAdvanceBody;
  const storeId = String(body.storeId ?? "").trim();
  const employeeId = String(body.employeeId ?? "").trim();
  const period = String(body.period ?? "").trim();
  const advanceDate = String(body.advanceDate ?? "").trim();
  const amount = amountValue(body.amount);
  const note = noteValue(body.note);
  const clientRequestId = request.headers.get("Idempotency-Key")?.trim()
    || String(body.clientRequestId ?? "").trim();
  if (!storeId || !employeeId || !PERIOD_PATTERN.test(period) || !validDate(advanceDate, period) || amount === null || !note) {
    return noStoreJson({ message: "Vui lòng nhập đủ nhân viên, ngày ứng, số tiền dương và nội dung từ 2 đến 500 ký tự." }, 400);
  }
  if (!REQUEST_ID_PATTERN.test(clientRequestId)) return noStoreJson({ message: "Mã yêu cầu ứng lương không hợp lệ." }, 400);
  if (!managerCanAccessStore(user, storeId)) return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(storeId)) return noStoreJson({ message: INACTIVE_STORE_MESSAGE }, 409);

  const db = await initDb();
  const payrollRevision = await salaryAdvancePayrollRevision(db, storeId);
  const summary = await payrollPreview(request, storeId, period);
  const employee = summary?.items.find((item) => item.employeeId === employeeId);
  if (!employee) return noStoreJson({ message: "Nhân viên không có trong bảng lương của cửa hàng ở kỳ này." }, 404);
  const payloadHash = await sha256(JSON.stringify({ storeId, employeeId, period, advanceDate, amount, note }));
  try {
    const result = await createSalaryAdvance(db, {
      id: crypto.randomUUID(),
      storeId,
      employeeId,
      period,
      advanceDate,
      amount,
      note,
      actorId: user.id,
      clientRequestId,
      payloadHash,
      payrollRevision,
      grossEntitlement: employee.totalPay,
      now: new Date().toISOString(),
    });
    return noStoreJson({
      advance: result.advance,
      message: result.status === "CREATED" ? "Đã tạo khoản ứng lương chờ xác nhận chi." : "Yêu cầu này đã được ghi nhận trước đó.",
    }, result.status === "CREATED" ? 201 : 200);
  } catch (error) {
    if (error instanceof SalaryAdvanceConflictError) return conflictResponse(error);
    throw error;
  }
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return noStoreJson({ message: "Chưa đăng nhập" }, 401);
  if (user.role !== "MANAGER") return noStoreJson({ message: "Chỉ quản lý được thay đổi khoản ứng lương." }, 403);
  const body = await request.json().catch(() => ({})) as SalaryAdvanceBody;
  const id = String(body.id ?? "").trim();
  const storeId = String(body.storeId ?? "").trim();
  const expectedVersion = versionValue(body.version);
  if (!id || !storeId || expectedVersion === null) return noStoreJson({ message: "Khoản ứng lương hoặc phiên bản không hợp lệ." }, 400);
  if (!managerCanAccessStore(user, storeId)) return noStoreJson({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  if (!await isStoreActive(storeId)) return noStoreJson({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const current = await getSalaryAdvance(db, id, storeId);
  if (!current) return noStoreJson({ message: "Không tìm thấy khoản ứng lương trong cửa hàng này." }, 404);

  try {
    if (body.action === "CONFIRM_PAYMENT") {
      if (current.status === "PAID") {
        const result = await confirmSalaryAdvance(db, {
          id,
          storeId,
          expectedVersion,
          actorId: user.id,
          payrollRevision: "",
          grossEntitlement: current.grossEntitlementSnapshot,
          now: new Date().toISOString(),
        });
        return noStoreJson({
          advance: result.advance,
          message: "Khoản ứng lương đã được xác nhận chi trước đó.",
        });
      }
      const payrollRevision = await salaryAdvancePayrollRevision(db, storeId);
      const summary = await payrollPreview(request, storeId, current.period);
      const employee = summary?.items.find((item) => item.employeeId === current.employeeId);
      if (!employee) return noStoreJson({ message: "Nhân viên không có trong bảng lương của cửa hàng ở kỳ này." }, 404);
      const result = await confirmSalaryAdvance(db, {
        id,
        storeId,
        expectedVersion,
        actorId: user.id,
        payrollRevision,
        grossEntitlement: employee.totalPay,
        now: new Date().toISOString(),
      });
      return noStoreJson({
        advance: result.advance,
        message: result.status === "CONFIRMED" ? "Đã xác nhận chi khoản ứng lương." : "Khoản ứng lương đã được xác nhận chi trước đó.",
      });
    }

    const advanceDate = String(body.advanceDate ?? "").trim();
    const amount = amountValue(body.amount);
    const note = noteValue(body.note);
    if (!validDate(advanceDate, current.period) || amount === null || !note) {
      return noStoreJson({ message: "Ngày ứng, số tiền hoặc nội dung chỉnh sửa không hợp lệ." }, 400);
    }
    const payrollRevision = await salaryAdvancePayrollRevision(db, storeId);
    const summary = await payrollPreview(request, storeId, current.period);
    const employee = summary?.items.find((item) => item.employeeId === current.employeeId);
    if (!employee) return noStoreJson({ message: "Nhân viên không có trong bảng lương của cửa hàng ở kỳ này." }, 404);
    const advance = await updateSalaryAdvance(db, {
      id,
      storeId,
      expectedVersion,
      advanceDate,
      amount,
      note,
      actorId: user.id,
      payrollRevision,
      grossEntitlement: employee.totalPay,
      now: new Date().toISOString(),
    });
    return noStoreJson({ advance, message: "Đã cập nhật khoản ứng lương." });
  } catch (error) {
    if (error instanceof SalaryAdvanceConflictError) return conflictResponse(error);
    throw error;
  }
}
