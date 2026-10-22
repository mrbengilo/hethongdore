import { readFile } from "node:fs/promises";
import { createHash, pbkdf2Sync } from "node:crypto";
import { Miniflare } from "miniflare";

export const TEST_PASSWORD = "isolated-test-password";
export const DATABASE_ID = "00000000-0000-4000-8000-000000000000";

// These are the deployed legacy tables which were initialized by runtime.ts,
// but never included in the original 0000 migration. Keep upgrade fixtures
// independent from the new migration so preservation tests exercise upgrades.
export const legacyTables = [
  `CREATE TABLE IF NOT EXISTS business_records (id TEXT PRIMARY KEY, category TEXT NOT NULL, store_id TEXT, owner_id TEXT, title TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shift_sessions (id TEXT PRIMARY KEY, shift_code TEXT NOT NULL UNIQUE, shift_name TEXT, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, scheduled_start_at TEXT, scheduled_end_at TEXT, rollover_from TEXT, work_session_id TEXT, auto_rolled INTEGER NOT NULL DEFAULT 0, tiktok INTEGER NOT NULL DEFAULT 0, tiktok_allowance INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE')`,
];

export async function executeMigration(db, filename) {
  const sql = await readFile(new URL(`../../drizzle/${filename}`, import.meta.url), "utf8");
  const statements = sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

export async function createD1(options = {}) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('isolated-test'); } };",
    compatibilityDate: "2026-05-15",
    d1Databases: { DB: DATABASE_ID },
    ...options,
  });
  const db = await mf.getD1Database("DB");
  return { mf, db };
}

export async function initializeLegacy(db) {
  await executeMigration(db, "0000_dore_initial.sql");
  await db.batch(legacyTables.map((sql) => db.prepare(sql)));
}

export async function seedIdentities(db) {
  const now = new Date().toISOString();
  const salt = "isolated-tests-only";
  const hash = `pbkdf2$100000$${Buffer.from(salt).toString("base64")}$${pbkdf2Sync(TEST_PASSWORD, salt, 100000, 32, "sha256").toString("base64")}`;
  for (const id of ["s1", "s2"]) {
    await db.prepare("INSERT INTO stores (id,name,address,created_at) VALUES (?,?,?,?)")
      .bind(id, `Test store ${id}`, "Isolated fixture", now).run();
  }
  for (const [id, store] of [["a", "s1"], ["b", "s1"], ["c", "s1"], ["outside", "s2"]]) {
    await db.prepare("INSERT INTO employees (id,store_id,code,name,position,phone) VALUES (?,?,?,?,?,?)")
      .bind(id, store, id.toUpperCase(), `Employee ${id.toUpperCase()}`, "Test", "").run();
  }
  const identities = [
    ["admin", "MANAGER", null, null],
    ["manager", "STORE_MANAGER", null, "s1"],
    ["htkd", "HTKD", null, null],
    ["employee", "EMPLOYEE", "a", "s1"],
    ["unknown", "UNKNOWN", null, null],
    ["revoked", "STORE_MANAGER", null, "s1"],
  ];
  for (const [id, role, employeeId, storeId] of identities) {
    await db.prepare("INSERT INTO users(id,username,password_hash,role,name,employee_id,store_id) VALUES (?,?,?,?,?,?,?)")
      .bind(id, id, hash, role, `Test ${id}`, employeeId, storeId).run();
    await db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)")
      .bind(`session-${id}`, id, createHash("sha256").update(`test-token-${id}`).digest("base64"), Date.now() + 86_400_000, now).run();
  }
  for (const id of ["manager", "htkd"]) {
    await db.prepare("INSERT INTO user_store_scopes (user_id,store_id) VALUES (?,?)").bind(id, "s1").run();
  }
}

export const cookie = (role) => `dore_session=test-token-${role}`;

export function businessDate(days = 3) {
  return new Date(Date.now() + 7 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
}
