const LEGACY_SITES_MANAGER_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const PBKDF2_HASH_PATTERN = /^pbkdf2\$([1-9]\d*)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/u;

const sqliteStoreBaseline = [
  ["st-thot-not", "DORE THỐT NỐT", "Thốt Nốt, Cần Thơ"],
  ["st-can-tho", "DORE CẦN THƠ", "Ninh Kiều, Cần Thơ"],
  ["st-long-xuyen", "DORE LONG XUYÊN", "Long Xuyên, An Giang"],
  ["st-vinh-long", "DORE VĨNH LONG", "TP. Vĩnh Long, Vĩnh Long"],
  ["st-soc-trang", "DORE SÓC TRĂNG", "TP. Sóc Trăng, Sóc Trăng"],
] as const;

export function managerPasswordHash(platformKind: "cloudflare" | "sqlite") {
  const configured = typeof process === "undefined"
    ? undefined
    : process.env.DORE_MANAGER_PASSWORD_HASH?.trim();
  if (configured) {
    const match = PBKDF2_HASH_PATTERN.exec(configured);
    let saltLength = 0;
    let digestLength = 0;
    if (match) {
      try {
        saltLength = atob(match[2]).length;
        digestLength = atob(match[3]).length;
      } catch {
        // Invalid base64 is rejected by the shape check below.
      }
    }
    if (!match || Number(match[1]) < 100_000 || saltLength < 16 || digestLength !== 32) {
      throw new Error("DORE_MANAGER_PASSWORD_HASH must be a PBKDF2-SHA256 hash with at least 100000 iterations");
    }
    return configured;
  }
  if (platformKind === "sqlite") {
    throw new Error("DORE_MANAGER_PASSWORD_HASH is required when bootstrapping the self-hosted SQLite database");
  }
  return LEGACY_SITES_MANAGER_HASH;
}

export async function ensureSqliteStoreBaseline(db: D1Database) {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM stores").first<{ count: number }>();
  if (Number(existing?.count ?? 0) !== 0) return;
  const now = new Date().toISOString();
  await db.batch(sqliteStoreBaseline.map(([id, name, address]) => db.prepare(
    "INSERT INTO stores (id, name, address, revenue, expense, status, created_at) VALUES (?, ?, ?, 0, 0, 'ACTIVE', ?)",
  ).bind(id, name, address, now)));
}
