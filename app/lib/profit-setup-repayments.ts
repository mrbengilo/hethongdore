export type SavedSetupRepayment = Readonly<{
  storeId: string;
  period: string;
  amount: number;
  version: number;
  updatedBy: string;
  updatedAt: string;
}>;

export class SetupRepaymentError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function readSetupRepayments(db: D1Database, period: string): Promise<SavedSetupRepayment[]> {
  const result = await db.prepare(`SELECT store_id AS storeId, period, amount, version,
    updated_by AS updatedBy, updated_at AS updatedAt FROM profit_setup_repayments
    WHERE period = ? ORDER BY store_id`).bind(period).all<SavedSetupRepayment>();
  return result.results;
}

export async function saveSetupRepayment(db: D1Database, input: {
  storeId: unknown; period: string; amount: unknown; expectedVersion: unknown; actorId: string;
}): Promise<SavedSetupRepayment> {
  const { storeId, period, amount, expectedVersion, actorId } = input;
  if (typeof storeId !== "string" || !storeId.trim() || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)
    || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0
    || typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion)
    || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) {
    throw new SetupRepaymentError("Cửa hàng, kỳ hoặc số tiền hoàn trả setup không hợp lệ. Số tiền phải là số đồng nguyên, không âm.", 400);
  }
  const before = (await readSetupRepayments(db, period)).find((row) => row.storeId === storeId) ?? null;
  if ((before?.version ?? 0) !== expectedVersion) {
    throw new SetupRepaymentError("Hoàn trả setup vừa được thay đổi. Vui lòng tải số đã lưu trước khi sửa tiếp.", 409);
  }
  const after: SavedSetupRepayment = {
    storeId, period, amount, version: expectedVersion + 1, updatedBy: actorId, updatedAt: new Date().toISOString(),
  };
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO profit_setup_repayments (store_id, period, amount, version, updated_by, updated_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT version FROM profit_setup_repayments
          WHERE store_id = ? AND period = ?), 0) = ?
        ON CONFLICT(period, store_id) DO UPDATE SET amount = excluded.amount, version = excluded.version,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at
        WHERE profit_setup_repayments.version = ?`)
        .bind(storeId, period, amount, after.version, actorId, after.updatedAt, storeId, period, expectedVersion, expectedVersion),
      db.prepare(`INSERT INTO audit_logs
        (id, user_id, store_id, action, entity_type, entity_id, before_json, after_json, reason, created_at)
        SELECT ?, ?, ?, 'PROFIT_SETUP_REPAYMENT_SAVE', 'PROFIT_SETUP_REPAYMENT', ?, ?, ?, ?, ? WHERE changes() = 1`)
        .bind(crypto.randomUUID(), actorId, storeId, `${period}:${storeId}`, JSON.stringify(before), JSON.stringify(after),
          "Lưu hoàn trả setup riêng theo cửa hàng và kỳ", after.updatedAt),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1) {
      throw new SetupRepaymentError("Hoàn trả setup vừa được thay đổi. Vui lòng tải số đã lưu trước khi sửa tiếp.", 409);
    }
  } catch (error) {
    if (error instanceof SetupRepaymentError) throw error;
    if (String(error).includes("setup repayment period is closed")) {
      throw new SetupRepaymentError("Kỳ chia lợi nhuận đã khóa; không thể sửa hoàn trả setup.", 409);
    }
    if (String(error).includes("setup repayment store is not locked")) {
      throw new SetupRepaymentError("Cửa hàng đã chọn chưa khóa kỳ tài chính.", 409);
    }
    if (String(error).includes("setup repayment exceeds safe money range")) {
      throw new SetupRepaymentError("Số tiền hoàn trả setup vượt giới hạn tính toán của kỳ.", 400);
    }
    throw error;
  }
  return after;
}
