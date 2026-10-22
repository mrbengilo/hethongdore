import { initDb, writeAudit } from "../../../db/runtime";
import { localPeriod, periodBoundsUtc } from "../../lib/finance";
import { normalizeEmployeeCccdNumber } from "../../lib/employee-cccd";
import { employeeTikTokAllowanceForCreate, employeeTikTokAllowanceForPatch } from "../../lib/employee-tiktok";
import { getSessionUser, hashPassword, INACTIVE_STORE_MESSAGE, isStoreActive, json } from "../_lib/auth";
import {
  employeeStatusLabel,
  isEmployeeStatus,
  normalizedEmployeeStatus,
  transitionEmployeeStatus,
  type EmployeeStatus,
} from "../_lib/employee-lifecycle";
import {
  incomingStorePeriodUnlockedSql,
  isStorePeriodLocked,
} from "../_lib/store-period-lock";
import {
  enqueueCccdDeletionStatement,
  processCccdDeletionOutbox,
} from "../_lib/cccd-deletion";
import {
  actorCanClaimPendingCccd,
  claimPendingCccdUploadStatement,
  pendingCccdAttachmentGuardBindings,
  pendingCccdAttachmentGuardSql,
  retireCccdUploadStatements,
} from "../_lib/cccd-upload-registry";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  managerHasGlobalStoreAccess,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";

type EmployeeBody = {
  action?: "SET_STATUS";
  id?: string;
  storeId?: string;
  code?: string;
  name?: string;
  position?: string;
  phone?: string;
  province?: string;
  ward?: string;
  addressLine?: string;
  age?: number | string;
  cccdNumber?: string;
  cccdImageKey?: string;
  cccdImageName?: string;
  hourlyRate?: number | string;
  tiktokAllowance?: number | string;
  username?: string;
  password?: string;
  status?: EmployeeStatus | "INACTIVE";
  expectedVersion?: number | string;
  reason?: string;
};

const cccdKeyPattern = /^cccd\/[a-f0-9-]+\.(jpg|png|webp)$/;

function profileValues(body: EmployeeBody) {
  return {
    province: body.province?.trim() ?? "",
    ward: body.ward?.trim() ?? "",
    addressLine: body.addressLine?.trim() ?? "",
    age: Number(body.age),
    cccdNumber: normalizeEmployeeCccdNumber(body.cccdNumber),
    cccdImageKey: body.cccdImageKey?.trim() ?? "",
    cccdImageName: body.cccdImageName?.trim() ?? "",
  };
}

function validProfile(profile: ReturnType<typeof profileValues>) {
  return Boolean(profile.province && profile.ward && profile.addressLine
    && Number.isInteger(profile.age) && profile.age >= 15 && profile.age <= 100
    && profile.cccdNumber
    && cccdKeyPattern.test(profile.cccdImageKey));
}

function affectedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  if (user.role === "EMPLOYEE") {
    if (!user.employeeId) return json({ message: "Tài khoản chưa được gắn với nhân viên." }, 409);
    const own = await db.prepare("SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.id = ? AND e.status != 'ARCHIVED' AND e.deleted_at IS NULL LIMIT 1")
      .bind(user.employeeId).all();
    return json({ employees: own.results });
  }
  const params = new URL(request.url).searchParams;
  const managerScope = resolveManagerStoreScope(user, params.get("storeId"));
  if (!managerScope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = managerScope.storeId;
  const includeSupport = params.get("includeSupport") === "1";
  const payrollPeriod = params.get("payrollPeriod");
  if (payrollPeriod && !/^\d{4}-(0[1-9]|1[0-2])$/.test(payrollPeriod)) {
    return json({ message: "Kỳ lương không hợp lệ." }, 400);
  }
  const payrollBounds = payrollPeriod ? periodBoundsUtc(payrollPeriod) : null;
  const result = storeId && includeSupport && payrollPeriod && payrollBounds
    ? await db.prepare(`SELECT e.*, u.username, e.store_id AS homeStoreId, hs.name AS homeStoreName,
        CASE WHEN e.store_id = ? THEN 0 ELSE 1 END AS isSupport
      FROM employees e
      LEFT JOIN users u ON u.employee_id = e.id
      LEFT JOIN stores hs ON hs.id = e.store_id
      WHERE e.status != 'ARCHIVED' AND e.deleted_at IS NULL AND (
        (e.status IN ('ACTIVE', 'SUSPENDED') AND (
          e.store_id = ? OR EXISTS (
            SELECT 1 FROM employee_transfers t
            WHERE t.employee_id = e.id AND t.target_store_id = ? AND t.status != 'CANCELLED'
              AND t.start_date < ? AND t.end_date >= ?
          )
        ))
        OR (e.status IN ('TERMINATED', 'INACTIVE') AND (
          EXISTS (
            SELECT 1 FROM shift_sessions s
            WHERE s.employee_id = e.id AND s.store_id = ? AND s.status = 'COMPLETED'
              AND s.ended_at IS NOT NULL AND (
                (NULLIF(s.work_date, '') IS NOT NULL AND s.work_date >= ? AND s.work_date < ?)
                OR (NULLIF(s.work_date, '') IS NULL AND s.started_at >= ? AND s.started_at < ?)
              )
          )
          OR EXISTS (
            SELECT 1 FROM employee_payroll_closings c
            WHERE c.employee_id = e.id AND c.store_id = ? AND c.period = ?
              AND c.status IN ('BASE_LOCKED', 'LOCKED')
          )
          OR EXISTS (
            SELECT 1 FROM business_records r
            WHERE r.category = 'LUONG_THUONG' AND r.store_id = ? AND r.status != 'DELETED'
              AND json_extract(r.data_json, '$.employeeId') = e.id
              AND substr(json_extract(r.data_json, '$.date'), 1, 7) = ?
          )
        ))
      )
      ORDER BY isSupport, e.code`)
      .bind(
        storeId,
        storeId, storeId, payrollBounds.localEnd, payrollBounds.localStart,
        storeId, payrollBounds.localStart, payrollBounds.localEnd, payrollBounds.startUtc, payrollBounds.endUtc,
        storeId, payrollPeriod,
        storeId, payrollPeriod,
      ).all()
    : storeId && includeSupport
    ? await db.prepare(`SELECT e.*, u.username, e.store_id AS homeStoreId, hs.name AS homeStoreName,
        CASE WHEN e.store_id = ? THEN 0 ELSE 1 END AS isSupport
      FROM employees e
      LEFT JOIN users u ON u.employee_id = e.id
      LEFT JOIN stores hs ON hs.id = e.store_id
      WHERE e.status = 'ACTIVE' AND e.deleted_at IS NULL AND (
        e.store_id = ? OR EXISTS (
          SELECT 1 FROM employee_transfers t
          WHERE t.employee_id = e.id AND t.target_store_id = ? AND t.status != 'CANCELLED'
        )
      )
      ORDER BY isSupport, e.code`).bind(storeId, storeId, storeId).all()
    : storeId
      ? await db.prepare("SELECT e.*, u.username, e.store_id AS homeStoreId, 0 AS isSupport FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.store_id = ? AND e.status != 'ARCHIVED' AND e.deleted_at IS NULL ORDER BY e.code").bind(storeId).all()
      : await db.prepare("SELECT e.*, u.username, e.store_id AS homeStoreId, 0 AS isSupport FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.status != 'ARCHIVED' AND e.deleted_at IS NULL ORDER BY e.store_id, e.code").all();
  return json({ employees: result.results });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as EmployeeBody;
  if (body.storeId && !managerCanAccessStore(user, body.storeId)) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  const hourlyRate = Number(body.hourlyRate);
  const db = await initDb();
  const tiktokAllowance = employeeTikTokAllowanceForCreate(body.tiktokAllowance);
  const profile = profileValues(body);
  if (!body.storeId || !body.code?.trim() || !body.name?.trim() || !body.position?.trim() || !body.phone?.trim() || !body.username?.trim() || !body.password || body.password.length < 6 || !Number.isSafeInteger(hourlyRate) || hourlyRate <= 0 || tiktokAllowance === null || !validProfile(profile)) return json({ message: "Vui lòng nhập đủ mã, tên, SĐT, địa chỉ, tuổi, ảnh CCCD; lương và phụ cấp TikTok phải là số nguyên VND an toàn; mật khẩu tối thiểu 6 ký tự." }, 400);
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const employeeId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  if (!await actorCanClaimPendingCccd(db, {
    key: profile.cccdImageKey,
    currentKey: null,
    actorUserId: user.id,
    targetStoreId: body.storeId,
    employeeId,
  })) return json({ message: "Ảnh CCCD chưa được tải bởi tài khoản này hoặc đang thuộc hồ sơ nhân viên khác." }, 403);
  const createdAt = new Date().toISOString();
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO employees
          (id, store_id, code, name, position, phone, province, ward, address_line, age,
            cccd_number, cccd_image_key, cccd_image_name, hourly_rate, tiktok_allowance, status)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE'
        WHERE EXISTS (SELECT 1 FROM stores WHERE id = ? AND status = 'ACTIVE')
          AND ${pendingCccdAttachmentGuardSql}`)
        .bind(
          employeeId, body.storeId, body.code.trim().toUpperCase(), body.name.trim(), body.position.trim(), body.phone.trim(),
          profile.province, profile.ward, profile.addressLine, profile.age, profile.cccdNumber, profile.cccdImageKey,
          profile.cccdImageName || null, hourlyRate, tiktokAllowance, body.storeId,
          ...pendingCccdAttachmentGuardBindings({
            key: profile.cccdImageKey,
            currentKey: null,
            actorUserId: user.id,
            targetStoreId: body.storeId,
            employeeId,
          }),
        ),
      claimPendingCccdUploadStatement(db, {
        key: profile.cccdImageKey,
        currentKey: null,
        actorUserId: user.id,
        targetStoreId: body.storeId,
        employeeId,
        claimedAt: createdAt,
      }),
      db.prepare(`INSERT INTO users
          (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, shift_active)
        SELECT ?, ?, ?, 'EMPLOYEE', ?, ?, ?, 0, 0
        WHERE EXISTS (SELECT 1 FROM employees WHERE id = ? AND store_id = ? AND status = 'ACTIVE')`)
        .bind(userId, body.username.trim().toLowerCase(), await hashPassword(body.password), body.name.trim(), employeeId, body.storeId, employeeId, body.storeId),
    ]);
    if (affectedRows(results[0]) === 0 || affectedRows(results[1]) === 0 || affectedRows(results[2]) === 0) {
      return json({ message: INACTIVE_STORE_MESSAGE }, 409);
    }
  } catch { return json({ message: "Mã nhân viên, số CCCD hoặc tên đăng nhập đã tồn tại." }, 409); }
  await writeAudit(user.id, "CREATE", "EMPLOYEE", employeeId, JSON.stringify({ code: body.code, tiktokAllowance, hasCccdNumber: true }));
  return json({ id: employeeId, storeId: body.storeId }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as EmployeeBody;
  if (body.storeId && !managerCanAccessStore(user, body.storeId)) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  if (body.action === "SET_STATUS") {
    if (!body.id || !body.storeId || !isEmployeeStatus(body.status)) {
      return json({ message: "Trạng thái nhân viên không hợp lệ." }, 400);
    }
    const db = await initDb();
    const existing = await db.prepare(`SELECT id, store_id AS storeId, code, name, status,
        COALESCE(lifecycle_version, 0) AS lifecycleVersion
      FROM employees WHERE id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL LIMIT 1`)
      .bind(body.id).first<{ id: string; storeId: string; code: string; name: string; status: string; lifecycleVersion: number }>();
    if (!existing || existing.storeId !== body.storeId) return json({ message: "Không tìm thấy nhân viên trong cửa hàng." }, 404);
    const currentStatus = normalizedEmployeeStatus(existing.status);
    if (currentStatus === body.status) {
      return json({
        ok: true,
        changed: false,
        status: body.status,
        lifecycleVersion: existing.lifecycleVersion,
        message: `Nhân viên hiện đã ở trạng thái ${employeeStatusLabel(body.status)}.`,
      });
    }
    const expectedVersion = body.expectedVersion == null ? existing.lifecycleVersion : Number(body.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return json({ message: "Phiên bản hồ sơ nhân viên không hợp lệ." }, 400);
    }
    const reason = body.reason?.trim() || "Quản lý cập nhật trạng thái làm việc";
    if (reason.length > 500) return json({ message: "Lý do thay đổi trạng thái không được vượt quá 500 ký tự." }, 400);
    try {
      const result = await transitionEmployeeStatus({
        db,
        actorUserId: user.id,
        employeeId: body.id,
        storeId: body.storeId,
        status: body.status,
        expectedVersion,
        reason,
      });
      return json({
        ok: true,
        ...result,
        payrollClosingRequired: body.status === "TERMINATED",
        message: body.status === "ACTIVE"
          ? "Đã chuyển nhân viên sang đang làm việc và mở lại quyền đăng nhập."
          : `Đã chuyển nhân viên sang ${employeeStatusLabel(body.status).toLocaleLowerCase("vi-VN")} và thu hồi toàn bộ phiên đăng nhập. Ca, đơn hàng và lịch sử lương trước đó được giữ nguyên.`,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "EMPLOYEE_SHIFT_PERIOD_LOCKED") {
        return json({ message: "Kỳ lương/KPI hoặc kỳ chia lợi nhuận của ca đang làm đã khóa. Không thể đổi trạng thái nhân viên." }, 423);
      }
      if (error instanceof Error && ["EMPLOYEE_SHIFT_UNKNOWN_TENDER", "EMPLOYEE_SHIFT_FINANCE_INVARIANT"].includes(error.message)) {
        return json({ message: "Không thể đổi trạng thái vì số liệu doanh thu ca đang làm chưa hợp lệ. Vui lòng đối soát đơn hàng." }, 409);
      }
      if (error instanceof Error && error.message === "EMPLOYEE_ACTIVE_SHIFT") {
        return json({ message: "Nhân viên đang có ca làm việc chưa kết. Hãy kết ca trước khi đổi sang tạm ngưng hoặc đã nghỉ việc." }, 409);
      }
      if (error instanceof Error && error.message === "EMPLOYEE_VERSION_CONFLICT") {
        return json({ message: "Trạng thái nhân viên vừa thay đổi. Vui lòng tải lại danh sách." }, 409);
      }
      if (error instanceof Error && error.message === "EMPLOYEE_NOT_FOUND") {
        return json({ message: "Không tìm thấy nhân viên trong cửa hàng." }, 404);
      }
      throw error;
    }
  }
  const hourlyRateWasProvided = body.hourlyRate !== undefined;
  const requestedHourlyRate = hourlyRateWasProvided ? Number(body.hourlyRate) : null;
  const profile = profileValues(body);
  if (!body.id || !body.storeId || !body.code?.trim() || !body.name?.trim() || !body.position?.trim() || !body.phone?.trim() || (hourlyRateWasProvided && (!Number.isSafeInteger(requestedHourlyRate) || Number(requestedHourlyRate) <= 0)) || !validProfile(profile) || (body.password !== undefined && body.password !== "" && body.password.length < 6)) return json({ message: "Dữ liệu nhân viên, địa chỉ, tuổi, ảnh CCCD, lương, phụ cấp TikTok hoặc mật khẩu không hợp lệ." }, 400);
  if (!await isStoreActive(body.storeId)) return json({ message: INACTIVE_STORE_MESSAGE }, 409);
  const db = await initDb();
  const existing = await db.prepare(`SELECT store_id AS storeId, status,
      hourly_rate AS hourlyRate, tiktok_allowance AS tiktokAllowance,
      cccd_number AS cccdNumber,
      cccd_image_key AS cccdImageKey,
      COALESCE(lifecycle_version, 0) AS lifecycleVersion, deleted_at AS deletedAt
    FROM employees
    WHERE id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
    LIMIT 1`)
    .bind(body.id).first<{
      storeId: string;
      status: string;
      hourlyRate: number;
      tiktokAllowance: number;
      cccdNumber: string | null;
      cccdImageKey: string | null;
      lifecycleVersion: number;
      deletedAt: string | null;
    }>();
  if (!existing) return json({ message: "Không tìm thấy nhân viên." }, 404);
  if (!managerHasGlobalStoreAccess(user) && existing.storeId !== user.homeStoreId) {
    return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  }
  if (!await actorCanClaimPendingCccd(db, {
    key: profile.cccdImageKey,
    currentKey: existing.cccdImageKey,
    actorUserId: user.id,
    targetStoreId: body.storeId,
    employeeId: body.id,
  })) return json({ message: "Ảnh CCCD chưa được tải bởi tài khoản này hoặc đang thuộc hồ sơ nhân viên khác." }, 403);
  if (body.status !== undefined && body.status !== existing.status) {
    return json({ message: "Vui lòng dùng nút trạng thái riêng để đổi trạng thái làm việc của nhân viên." }, 409);
  }
  const expectedVersion = body.expectedVersion == null ? Number(existing.lifecycleVersion) : Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return json({ message: "Phiên bản hồ sơ nhân viên không hợp lệ." }, 400);
  }
  if (expectedVersion !== Number(existing.lifecycleVersion)) {
    return json({ message: "Trạng thái nhân viên vừa thay đổi. Vui lòng tải lại danh sách." }, 409);
  }
  const hourlyRate = hourlyRateWasProvided ? Number(requestedHourlyRate) : Number(existing.hourlyRate);
  const tiktokAllowanceWasProvided = body.tiktokAllowance !== undefined;
  const tiktokAllowance = employeeTikTokAllowanceForPatch(body.tiktokAllowance, existing.tiktokAllowance);
  if (tiktokAllowance === null) return json({ message: "Phụ cấp TikTok phải là số nguyên VND từ 0 đồng trở lên." }, 400);
  const payrollConfigurationChanged = existing.storeId !== body.storeId
    || (hourlyRateWasProvided && hourlyRate !== Number(existing.hourlyRate))
    || (tiktokAllowanceWasProvided && tiktokAllowance !== Number(existing.tiktokAllowance));
  if (existing.storeId !== body.storeId) {
    const activeShift = await db.prepare("SELECT id FROM shift_sessions WHERE employee_id = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(body.id).first<{ id: string }>();
    if (activeShift) return json({ message: "Nhân viên đang làm ca, không thể đổi cửa hàng hoặc ngừng hoạt động." }, 409);
  }
  if (existing.storeId !== body.storeId) {
    const activeTransfer = await db.prepare("SELECT id FROM employee_transfers WHERE employee_id = ? AND status IN ('SCHEDULED', 'ACTIVE') LIMIT 1")
      .bind(body.id).first<{ id: string }>();
    if (activeTransfer) return json({ message: "Nhân viên còn lịch hỗ trợ cửa hàng khác, không thể đổi cửa hàng chính hoặc ngừng hoạt động." }, 409);
  }
  const effectiveAt = new Date().toISOString();
  const effectivePeriod = localPeriod(new Date(effectiveAt));
  const payrollGateId = payrollConfigurationChanged ? `employee-payroll-config:${crypto.randomUUID()}` : null;
  const profileGateId = `employee-profile-update:${crypto.randomUUID()}`;
  const payrollGateDetail = JSON.stringify({
    storeId: existing.storeId,
    targetStoreId: body.storeId,
    period: effectivePeriod,
    before: { hourlyRate: existing.hourlyRate, tiktokAllowance: existing.tiktokAllowance },
    after: { hourlyRate, tiktokAllowance },
  });
  try {
    const statements: D1PreparedStatement[] = [];
    let payrollGateResultIndex: number | null = null;
    if (payrollGateId) {
      // This durable audit row is also the transaction gate. All subsequent
      // employee/user/active-shift updates require it, so a concurrent period
      // closing leaves the entire request inert rather than partially updating
      // profile or login fields.
      statements.push(db.prepare(`INSERT INTO audit_logs
          (id, user_id, action, entity_type, entity_id, detail, created_at)
        SELECT ?, ?, 'EMPLOYEE_PAYROLL_CONFIG_UPDATE', 'EMPLOYEE', employee.id, ?, ?
        FROM employees employee
        WHERE employee.id = ? AND employee.store_id = ? AND employee.status = ?
          AND COALESCE(employee.lifecycle_version, 0) = ? AND employee.deleted_at IS NULL
          AND employee.hourly_rate = ? AND employee.tiktok_allowance = ?
          AND EXISTS (SELECT 1 FROM stores target_store WHERE target_store.id = ? AND target_store.status = 'ACTIVE')
          AND ${incomingStorePeriodUnlockedSql}
          AND ${incomingStorePeriodUnlockedSql}
          AND (? = ? OR (
            NOT EXISTS (
              SELECT 1 FROM shift_sessions active_shift
              WHERE active_shift.employee_id = employee.id
                AND (active_shift.status = 'ACTIVE' OR active_shift.ended_at IS NULL)
            )
            AND NOT EXISTS (
              SELECT 1 FROM employee_transfers active_transfer
              WHERE active_transfer.employee_id = employee.id
                AND active_transfer.status IN ('SCHEDULED', 'ACTIVE')
            )
          ))`)
        .bind(
          payrollGateId, user.id, payrollGateDetail, effectiveAt,
          body.id, existing.storeId, existing.status, expectedVersion,
          existing.hourlyRate, existing.tiktokAllowance,
          body.storeId,
          existing.storeId, effectivePeriod,
          body.storeId, effectivePeriod,
          existing.storeId, body.storeId,
        ));
      payrollGateResultIndex = statements.length - 1;
    }
    const profilePayrollGuard = payrollGateId
      ? " AND EXISTS (SELECT 1 FROM audit_logs payroll_gate WHERE payroll_gate.id = ? AND payroll_gate.entity_id = employee.id)"
      : "";
    statements.push(db.prepare(`INSERT INTO audit_logs
        (id, user_id, action, entity_type, entity_id, detail, created_at)
      SELECT ?, ?, 'EMPLOYEE_PROFILE_UPDATE_GATE', 'EMPLOYEE', employee.id, ?, ?
      FROM employees employee
      WHERE employee.id = ? AND employee.store_id = ? AND employee.status = ?
        AND COALESCE(employee.lifecycle_version, 0) = ? AND employee.deleted_at IS NULL
        AND employee.cccd_image_key IS ?
        AND employee.cccd_number IS ?
        AND EXISTS (SELECT 1 FROM stores target_store WHERE target_store.id = ? AND target_store.status = 'ACTIVE')
        AND ${pendingCccdAttachmentGuardSql}${profilePayrollGuard}`)
      .bind(
        profileGateId, user.id,
        JSON.stringify({ storeId: existing.storeId, targetStoreId: body.storeId, effectiveAt }),
        effectiveAt,
        body.id, existing.storeId, existing.status, expectedVersion,
        existing.cccdImageKey, existing.cccdNumber, body.storeId,
        ...pendingCccdAttachmentGuardBindings({
          key: profile.cccdImageKey,
          currentKey: existing.cccdImageKey,
          actorUserId: user.id,
          targetStoreId: body.storeId,
          employeeId: body.id,
        }),
        ...(payrollGateId ? [payrollGateId] : []),
      ));
    const profileGateResultIndex = statements.length - 1;
    const gateGuard = ` AND EXISTS (SELECT 1 FROM audit_logs profile_gate
        WHERE profile_gate.id = ? AND profile_gate.entity_id = employees.id)`
      + (payrollGateId
        ? " AND EXISTS (SELECT 1 FROM audit_logs payroll_gate WHERE payroll_gate.id = ? AND payroll_gate.entity_id = employees.id)"
        : "");
    const employeeUpdate = db.prepare(`UPDATE employees SET
        store_id = ?, code = ?, name = ?, position = ?, phone = ?, province = ?, ward = ?,
        address_line = ?, age = ?, cccd_number = ?, cccd_image_key = ?, cccd_image_name = ?, hourly_rate = ?,
        tiktok_allowance = CASE WHEN ? = 1 THEN ? ELSE tiktok_allowance END
      WHERE id = ? AND store_id = ? AND status = ?
        AND COALESCE(lifecycle_version, 0) = ? AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM stores target_store WHERE target_store.id = ? AND target_store.status = 'ACTIVE')
        AND employees.cccd_image_key IS ?
        AND employees.cccd_number IS ?
        AND ${pendingCccdAttachmentGuardSql}${gateGuard}`)
      .bind(
        body.storeId, body.code.trim().toUpperCase(), body.name.trim(), body.position.trim(), body.phone.trim(),
        profile.province, profile.ward, profile.addressLine, profile.age, profile.cccdNumber, profile.cccdImageKey,
        profile.cccdImageName || null, hourlyRate, tiktokAllowanceWasProvided ? 1 : 0,
        tiktokAllowance, body.id, existing.storeId, existing.status, expectedVersion, body.storeId,
        existing.cccdImageKey, existing.cccdNumber,
        ...pendingCccdAttachmentGuardBindings({
          key: profile.cccdImageKey,
          currentKey: existing.cccdImageKey,
          actorUserId: user.id,
          targetStoreId: body.storeId,
          employeeId: body.id,
        }),
        profileGateId,
        ...(payrollGateId ? [payrollGateId] : []),
      );
    statements.push(employeeUpdate);
    const employeeResultIndex = statements.length - 1;
    statements.push(claimPendingCccdUploadStatement(db, {
      key: profile.cccdImageKey,
      currentKey: existing.cccdImageKey,
      actorUserId: user.id,
      targetStoreId: body.storeId,
      employeeId: body.id,
      claimedAt: effectiveAt,
    }));
    if (existing.cccdImageKey && existing.cccdImageKey !== profile.cccdImageKey) {
      // Queue the detached object in the same transaction as the employee
      // update. Physical storage is cleaned only after commit, so a storage
      // outage can never roll back or partially apply the profile change.
      statements.push(enqueueCccdDeletionStatement(db, {
        key: existing.cccdImageKey,
        replacementKey: profile.cccdImageKey,
        employeeId: body.id,
        requestedBy: user.id,
        reason: "EMPLOYEE_CCCD_REPLACED",
        requestedAt: effectiveAt,
      }));
      statements.push(...retireCccdUploadStatements(db, {
        key: existing.cccdImageKey,
        replacementKey: profile.cccdImageKey,
        requestedAt: effectiveAt,
      }));
    }
    const userGateGuard = ` AND EXISTS (SELECT 1 FROM audit_logs profile_gate
        WHERE profile_gate.id = ? AND profile_gate.entity_id = users.employee_id)`
      + (payrollGateId
        ? " AND EXISTS (SELECT 1 FROM audit_logs payroll_gate WHERE payroll_gate.id = ? AND payroll_gate.entity_id = users.employee_id)"
        : "");
    const userLifecycleGuard = ` AND EXISTS (
        SELECT 1 FROM employees profile_employee
        WHERE profile_employee.id = users.employee_id AND profile_employee.store_id = ?
          AND profile_employee.status = ? AND COALESCE(profile_employee.lifecycle_version, 0) = ?
          AND profile_employee.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM stores active_store
            WHERE active_store.id = profile_employee.store_id AND active_store.status = 'ACTIVE')
      )`;
    statements.push(body.username?.trim()
      ? db.prepare(`UPDATE users SET name = ?, store_id = ?, username = ?
          WHERE employee_id = ?${userLifecycleGuard}${userGateGuard}`)
        .bind(
          body.name.trim(), body.storeId, body.username.trim().toLowerCase(), body.id,
          body.storeId, existing.status, expectedVersion,
          profileGateId,
          ...(payrollGateId ? [payrollGateId] : []),
        )
      : db.prepare(`UPDATE users SET name = ?, store_id = ?
          WHERE employee_id = ?${userLifecycleGuard}${userGateGuard}`)
        .bind(
          body.name.trim(), body.storeId, body.id,
          body.storeId, existing.status, expectedVersion,
          profileGateId,
          ...(payrollGateId ? [payrollGateId] : []),
        ));
    if (body.password) {
      statements.push(db.prepare(`UPDATE users SET password_hash = ?
          WHERE employee_id = ?${userLifecycleGuard}${userGateGuard}`)
        .bind(
          await hashPassword(body.password), body.id,
          body.storeId, existing.status, expectedVersion,
          profileGateId,
          ...(payrollGateId ? [payrollGateId] : []),
        ));
    }
    if (existing.status !== "ACTIVE") {
      statements.push(db.prepare(`DELETE FROM sessions
          WHERE user_id IN (
            SELECT profile_user.id FROM users profile_user
            JOIN employees profile_employee ON profile_employee.id = profile_user.employee_id
            WHERE profile_employee.id = ? AND profile_employee.store_id = ?
              AND profile_employee.status = ? AND COALESCE(profile_employee.lifecycle_version, 0) = ?
              AND profile_employee.deleted_at IS NULL
          ) AND EXISTS (SELECT 1 FROM audit_logs profile_gate
            WHERE profile_gate.id = ? AND profile_gate.entity_id = ?)`)
        .bind(body.id, body.storeId, existing.status, expectedVersion, profileGateId, body.id));
    }
    const results = await db.batch(statements);
    if (payrollGateResultIndex !== null && affectedRows(results[payrollGateResultIndex]) === 0) {
      const locked = await isStorePeriodLocked(db, existing.storeId, effectivePeriod)
        || await isStorePeriodLocked(db, body.storeId, effectivePeriod);
      return json({ message: locked
        ? "Kỳ lương hiện tại của cửa hàng đã bắt đầu chốt hoặc khóa sổ, không thể đổi lương hoặc phụ cấp TikTok."
        : "Cấu hình lương của nhân viên vừa được thay đổi bởi yêu cầu khác. Vui lòng tải lại và thử lại." }, locked ? 423 : 409);
    }
    if (affectedRows(results[profileGateResultIndex]) === 0) {
      const current = await db.prepare(`SELECT status, COALESCE(lifecycle_version, 0) AS lifecycleVersion,
          deleted_at AS deletedAt
        FROM employees WHERE id = ? LIMIT 1`)
        .bind(body.id).first<{ status: string; lifecycleVersion: number; deletedAt: string | null }>();
      if (!current || current.status === "ARCHIVED" || current.deletedAt !== null) {
        return json({ message: "Không tìm thấy nhân viên." }, 404);
      }
      if (current.status !== existing.status || Number(current.lifecycleVersion) !== expectedVersion) {
        return json({ message: "Trạng thái nhân viên vừa thay đổi. Vui lòng tải lại danh sách." }, 409);
      }
      return json({ message: "Hồ sơ hoặc ảnh CCCD của nhân viên vừa thay đổi. Vui lòng tải lại và thử lại." }, 409);
    }
    if (affectedRows(results[employeeResultIndex]) === 0) {
      const current = await db.prepare(`SELECT status, COALESCE(lifecycle_version, 0) AS lifecycleVersion,
          deleted_at AS deletedAt
        FROM employees WHERE id = ? LIMIT 1`)
        .bind(body.id).first<{ status: string; lifecycleVersion: number; deletedAt: string | null }>();
      if (!current || current.status === "ARCHIVED" || current.deletedAt !== null) {
        return json({ message: "Không tìm thấy nhân viên." }, 404);
      }
      if (current.status !== existing.status || Number(current.lifecycleVersion) !== expectedVersion) {
        return json({ message: "Trạng thái nhân viên vừa thay đổi. Vui lòng tải lại danh sách." }, 409);
      }
    }
    if (affectedRows(results[employeeResultIndex]) === 0) {
      return json({ message: "Hồ sơ nhân viên vừa thay đổi. Vui lòng tải lại và thử lại." }, 409);
    }
  } catch {
    return json({ message: "Mã nhân viên, số CCCD hoặc tên đăng nhập đã tồn tại." }, 409);
  }
  const cccdCleanup = existing.cccdImageKey && existing.cccdImageKey !== profile.cccdImageKey
    ? await processCccdDeletionOutbox({ key: existing.cccdImageKey, limit: 1 })
      .catch(() => ({ deleted: 0, pending: 1 }))
    : { deleted: 0, pending: 0 };
  const persistedAllowance = await db.prepare("SELECT tiktok_allowance AS tiktokAllowance FROM employees WHERE id = ? AND status = ? AND COALESCE(lifecycle_version, 0) = ? AND deleted_at IS NULL LIMIT 1")
    .bind(body.id, existing.status, expectedVersion).first<{ tiktokAllowance: number }>();
  const auditDetail = JSON.stringify({
    code: body.code,
    tiktokAllowance: {
      provided: tiktokAllowanceWasProvided,
      from: existing.tiktokAllowance,
      requested: tiktokAllowanceWasProvided ? tiktokAllowance : undefined,
      to: tiktokAllowanceWasProvided
        ? tiktokAllowance
        : persistedAllowance?.tiktokAllowance ?? tiktokAllowance,
      activeShiftSnapshotsPreserved: true,
      effectiveAt,
    },
    cccdImage: {
      replaced: Boolean(existing.cccdImageKey && existing.cccdImageKey !== profile.cccdImageKey),
      cleanupPending: cccdCleanup.pending > 0,
    },
    cccdNumber: { changed: existing.cccdNumber !== profile.cccdNumber },
  });
  await db.prepare(`INSERT INTO audit_logs
      (id, user_id, action, entity_type, entity_id, detail, created_at)
    SELECT ?, ?, 'UPDATE', 'EMPLOYEE', employee.id, ?, ?
    FROM employees employee
    WHERE employee.id = ? AND employee.status = ?
      AND COALESCE(employee.lifecycle_version, 0) = ? AND employee.deleted_at IS NULL`)
    .bind(
      crypto.randomUUID(), user.id, auditDetail, new Date().toISOString(),
      body.id, existing.status, expectedVersion,
    ).run();
  return json({ ok: true, cccdCleanupPending: cccdCleanup.pending > 0 });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  return json({ message: "Không hỗ trợ xóa nhân viên. Hãy sửa trạng thái thành nghỉ làm." }, 405, { Allow: "GET, POST, PATCH" });
}
