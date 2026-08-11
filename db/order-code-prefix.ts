import {
  nextAvailableStoreOrderCodePrefix,
  storeOrderCodePrefix,
} from "../app/lib/order-code";

type PrefixRow = { codePrefix: string };

export async function occupiedStoreOrderCodePrefixes(db: D1Database) {
  const rows = await db.prepare("SELECT code_prefix AS codePrefix FROM store_order_code_sequences").all<PrefixRow>();
  return new Set(rows.results.map((row) => row.codePrefix));
}

export async function nextPrefixForStoreName(db: D1Database, storeName: string) {
  return nextAvailableStoreOrderCodePrefix(
    storeOrderCodePrefix(storeName),
    await occupiedStoreOrderCodePrefixes(db),
  );
}

export function isStoreOrderCodePrefixConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /store_order_code_sequences(?:\.code_prefix|.*idx_store_order_code_sequences_prefix)/iu.test(message)
    && /unique|constraint/iu.test(message);
}

export async function reserveStoreOrderCodePrefix(
  db: D1Database,
  storeId: string,
  storeName: string,
  updatedAt = new Date().toISOString(),
) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const existing = await db.prepare("SELECT code_prefix AS codePrefix FROM store_order_code_sequences WHERE store_id = ? LIMIT 1")
      .bind(storeId).first<PrefixRow>();
    if (existing) return existing.codePrefix;
    const candidate = await nextPrefixForStoreName(db, storeName);
    try {
      await db.prepare(`INSERT INTO store_order_code_sequences (store_id, code_prefix, last_value, updated_at)
        VALUES (?, ?, 0, ?) ON CONFLICT(store_id) DO NOTHING`)
        .bind(storeId, candidate, updatedAt).run();
    } catch (error) {
      if (!isStoreOrderCodePrefixConflict(error)) throw error;
      continue;
    }
    const persisted = await db.prepare("SELECT code_prefix AS codePrefix FROM store_order_code_sequences WHERE store_id = ? LIMIT 1")
      .bind(storeId).first<PrefixRow>();
    if (persisted) return persisted.codePrefix;
  }
  throw new Error(`Unable to persist an order-code prefix for store ${storeId}`);
}
