import { requireVnd, storeExistsInPeriod } from "./finance";

export const MANAGER_SALARY_CATEGORY = "STORE_MANAGER_SALARY";
const salaryId = (storeId: string, period: string) => `store-manager-salary:${storeId}:${period}`;

export class StoreManagerSalaryError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function readStoreManagerSalary(db: D1Database, storeId: string, period: string) {
  const row = await db.prepare(`SELECT data_json FROM business_records
    WHERE id = ? AND category = 'STORE_MANAGER_SALARY' AND status = 'ACTIVE'`)
    .bind(salaryId(storeId, period)).first<{ data_json: string }>();
  if (!row) return null;
  const data = JSON.parse(row.data_json) as { amount: number; version: number; period: string };
  requireVnd(data.amount, "Lương quản lý cửa hàng");
  if (data.period !== period || !Number.isSafeInteger(data.version) || data.version < 1) {
    throw new Error("Cấu hình lương quản lý không hợp lệ.");
  }
  return data;
}

export async function saveStoreManagerSalary(db: D1Database, input: {
  storeId: string; period: string; amount: unknown; expectedVersion: unknown; actorId: string;
}) {
  const { storeId, period, amount, expectedVersion, actorId } = input;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0
    || typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion)
    || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) {
    throw new StoreManagerSalaryError("Lương phải là số nguyên đồng không âm; phiên bản lưu phải hợp lệ.", 400);
  }
  const store = await db.prepare("SELECT created_at AS createdAt FROM stores WHERE id = ? AND status = 'ACTIVE'")
    .bind(storeId).first<{ createdAt: string }>();
  if (!store || !storeExistsInPeriod(store.createdAt, period)) {
    throw new StoreManagerSalaryError("Cửa hàng chưa hoạt động trong kỳ đã chọn.", 409);
  }
  const before = await readStoreManagerSalary(db, storeId, period);
  if ((before?.version ?? 0) !== expectedVersion) {
    throw new StoreManagerSalaryError("Mức lương vừa được thay đổi. Vui lòng tải lại trước khi lưu.", 409);
  }
  const id = salaryId(storeId, period);
  const now = new Date().toISOString();
  const after = JSON.stringify({ period, amount, version: expectedVersion + 1 });
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at)
        SELECT ?, 'STORE_MANAGER_SALARY', ?, ?, 'Lương quản lý cửa hàng', ?, 'ACTIVE', ?, ?
        WHERE COALESCE((SELECT json_extract(data_json, '$.version') FROM business_records WHERE id = ?), 0) = ?
        ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, owner_id = excluded.owner_id,
          updated_at = excluded.updated_at WHERE json_extract(business_records.data_json, '$.version') = ?`)
        .bind(id, storeId, actorId, after, now, now, id, expectedVersion, expectedVersion),
      db.prepare(`INSERT INTO audit_logs
        (id, user_id, store_id, action, entity_type, entity_id, before_json, after_json, reason, created_at)
        SELECT ?, ?, ?, 'STORE_MANAGER_SALARY_SET', 'STORE_MANAGER_SALARY', ?, ?, ?, ?, ? WHERE changes() = 1`)
        .bind(crypto.randomUUID(), actorId, storeId, id, JSON.stringify(before), after, "Cài đặt lương quản lý theo cửa hàng và kỳ", now),
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      throw new StoreManagerSalaryError("Mức lương vừa được thay đổi. Vui lòng tải lại trước khi lưu.", 409);
    }
  } catch (error) {
    if (error instanceof StoreManagerSalaryError) throw error;
    if (String(error).includes("manager salary is frozen")) {
      throw new StoreManagerSalaryError("Kỳ đã bắt đầu chốt lương. Mức lương quản lý của kỳ được giữ nguyên.", 409);
    }
    throw error;
  }
}
