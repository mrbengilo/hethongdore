import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createSqliteDatabase } = await import("../db/sqlite.ts");
const { ensureSqliteStoreBaseline, managerPasswordHash } = await import("../db/bootstrap.ts");

test("SQLite adapter implements D1 prepare, bind, first, all, raw and run metadata", async () => {
  const db = await createSqliteDatabase();
  try {
    await db.prepare("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL)").run();
    const insert = await db.prepare("INSERT INTO items (name, enabled) VALUES (?, ?)").bind("Mango", true).run();
    assert.equal(insert.success, true);
    assert.equal(insert.meta.changes, 1);
    assert.equal(insert.meta.last_row_id, 1);

    assert.deepEqual(
      { ...await db.prepare("SELECT id, name, enabled FROM items WHERE name = ?").bind("Mango").first() },
      { id: 1, name: "Mango", enabled: 1 },
    );
    assert.equal(await db.prepare("SELECT name FROM items WHERE id = ?").bind(1).first("name"), "Mango");

    const all = await db.prepare("SELECT name, enabled FROM items ORDER BY id").all();
    assert.deepEqual(all.results.map((row) => ({ ...row })), [{ name: "Mango", enabled: 1 }]);
    assert.deepEqual(await db.prepare("SELECT id, name FROM items ORDER BY id").raw(), [[1, "Mango"]]);
  } finally {
    db.close();
  }
});

test("SQLite D1 batch uses BEGIN IMMEDIATE and rolls back every statement on failure", async () => {
  const db = await createSqliteDatabase();
  try {
    await db.prepare("CREATE TABLE ledger (id TEXT PRIMARY KEY, amount INTEGER NOT NULL CHECK (amount >= 0))").run();

    const committed = await db.batch([
      db.prepare("INSERT INTO ledger (id, amount) VALUES (?, ?)").bind("one", 100),
      db.prepare("UPDATE ledger SET amount = amount + ? WHERE id = ?").bind(25, "one"),
    ]);
    assert.deepEqual(committed.map((entry) => entry.meta.changes), [1, 1]);

    await assert.rejects(db.batch([
      db.prepare("INSERT INTO ledger (id, amount) VALUES (?, ?)").bind("two", 200),
      db.prepare("INSERT INTO ledger (id, amount) VALUES (?, ?)").bind("three", -1),
    ]));

    const rows = await db.prepare("SELECT id, amount FROM ledger ORDER BY id").all();
    assert.deepEqual(rows.results.map((row) => ({ ...row })), [{ id: "one", amount: 125 }]);
  } finally {
    db.close();
  }
});

test("file SQLite enables WAL, busy timeout and foreign keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dore-sqlite-"));
  const db = await createSqliteDatabase(join(directory, "data", "dore.sqlite"));
  try {
    assert.equal(await db.prepare("PRAGMA journal_mode").first("journal_mode"), "wal");
    assert.equal(await db.prepare("PRAGMA busy_timeout").first("timeout"), 5_000);
    assert.equal(await db.prepare("PRAGMA foreign_keys").first("foreign_keys"), 1);

    await db.prepare("CREATE TABLE parents (id INTEGER PRIMARY KEY)").run();
    await db.prepare("CREATE TABLE children (parent_id INTEGER NOT NULL REFERENCES parents(id))").run();
    await assert.rejects(db.prepare("INSERT INTO children (parent_id) VALUES (999)").run());
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh SQLite bootstrap creates exactly the five zeroed store identities and requires an injected manager hash", async () => {
  const db = await createSqliteDatabase();
  const previousHash = process.env.DORE_MANAGER_PASSWORD_HASH;
  try {
    await db.prepare("CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL, revenue INTEGER NOT NULL, expense INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)").run();
    await ensureSqliteStoreBaseline(db);
    await ensureSqliteStoreBaseline(db);
    const stores = await db.prepare("SELECT id, name, revenue, expense, status FROM stores ORDER BY id").all();
    assert.deepEqual(stores.results.map((row) => ({ ...row })), [
      { id: "st-can-tho", name: "DORE CẦN THƠ", revenue: 0, expense: 0, status: "ACTIVE" },
      { id: "st-long-xuyen", name: "DORE LONG XUYÊN", revenue: 0, expense: 0, status: "ACTIVE" },
      { id: "st-soc-trang", name: "DORE SÓC TRĂNG", revenue: 0, expense: 0, status: "ACTIVE" },
      { id: "st-thot-not", name: "DORE THỐT NỐT", revenue: 0, expense: 0, status: "ACTIVE" },
      { id: "st-vinh-long", name: "DORE VĨNH LONG", revenue: 0, expense: 0, status: "ACTIVE" },
    ]);

    delete process.env.DORE_MANAGER_PASSWORD_HASH;
    assert.throws(() => managerPasswordHash("sqlite"), /DORE_MANAGER_PASSWORD_HASH is required/u);
    process.env.DORE_MANAGER_PASSWORD_HASH = "pbkdf2$99999$c2FsdA==$ZGlnZXN0";
    assert.throws(() => managerPasswordHash("sqlite"), /at least 100000 iterations/u);
    const encoded = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
    process.env.DORE_MANAGER_PASSWORD_HASH = encoded;
    assert.equal(managerPasswordHash("sqlite"), encoded);
  } finally {
    if (previousHash === undefined) delete process.env.DORE_MANAGER_PASSWORD_HASH;
    else process.env.DORE_MANAGER_PASSWORD_HASH = previousHash;
    db.close();
  }
});

test("every runtime permanently skips the legacy destructive reset", async () => {
  const [runtime, bootstrap] = await Promise.all([
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(runtime, /DATA_RESET_KEY|ensureOneTimeDataReset|verifyLegacyResetMarkerWithoutMutation/u);
  assert.match(bootstrap, /process\.env\.DORE_MANAGER_PASSWORD_HASH/u);
  assert.match(bootstrap, /DORE_MANAGER_PASSWORD_HASH is required when bootstrapping the self-hosted SQLite database/u);
  for (const store of ["DORE THỐT NỐT", "DORE CẦN THƠ", "DORE LONG XUYÊN", "DORE VĨNH LONG", "DORE SÓC TRĂNG"]) {
    assert.match(bootstrap, new RegExp(store, "u"));
  }
  assert.match(bootstrap, /VALUES \(\?, \?, \?, 0, 0, 'ACTIVE', \?\)/u);
  assert.match(runtime, /if \(platform\.kind === "sqlite"\) await ensureSqliteStoreBaseline\(db\)/u);
});
