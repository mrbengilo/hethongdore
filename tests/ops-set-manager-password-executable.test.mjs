import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const sourceUrl = new URL("../ops/scripts/set-manager-password.mjs", import.meta.url);

async function runnableTool(root) {
  let source = await readFile(sourceUrl, "utf8");
  source = source
    .replace(
      `  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("run this command with sudo so the protected environment file can be updated");
  }

`,
      "",
    )
    .replace('  let password = await promptHidden("New manager password: ");', '  let password = "StrongManagerPassword-2026";')
    .replace('  let confirmation = await promptHidden("Confirm manager password: ");', '  let confirmation = "StrongManagerPassword-2026";')
    .replace("        chownSync(path, databaseOwner.uid, databaseOwner.gid);", "        // owner preservation is unavailable in the Windows test fixture");
  const tool = path.join(root, "set-manager-password.mjs");
  await writeFile(tool, source, "utf8");
  return tool;
}

function createDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER,
      is_super_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO users VALUES
      ('manager-admin', 'admin', 'hash-admin-old', 'MANAGER', 4, 999, 0),
      ('manager-store', 'storemanager', 'hash-store-old', 'MANAGER', 3, 888, 0),
      ('manager-super', 'adminsystem', 'hash-super-old', 'MANAGER', 2, 777, 1),
      ('employee-user', 'employee', 'hash-employee-old', 'EMPLOYEE', 1, 666, 0);
    INSERT INTO sessions VALUES
      ('session-admin', 'manager-admin'),
      ('session-store', 'manager-store'),
      ('session-super', 'manager-super'),
      ('session-employee', 'employee-user');
  `);
  db.close();
}

function rows(databasePath, sql) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test("password tool changes exactly one selected manager in a multi-manager database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dore-manager-password-"));
  try {
    const database = path.join(root, "dore.sqlite");
    const environment = path.join(root, "dore.env");
    const originalEnvironment = "NODE_ENV=production\nDORE_MANAGER_PASSWORD_HASH=bootstrap-admin-old\n";
    createDatabase(database);
    await writeFile(environment, originalEnvironment, "utf8");
    const tool = await runnableTool(root);

    const selected = spawnSync(process.execPath, [tool, "--db", database, "--env", environment, "--username", "storemanager"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(selected.status, 0, selected.stderr);

    const usersAfterSelected = rows(database, "SELECT id, username, password_hash AS passwordHash, failed_attempts AS attempts, locked_until AS lockedUntil FROM users ORDER BY id");
    assert.match(usersAfterSelected.find((user) => user.username === "storemanager").passwordHash, /^pbkdf2\$210000\$/u);
    assert.deepEqual(
      usersAfterSelected.filter((user) => user.username !== "storemanager"),
      [
        { id: "employee-user", username: "employee", passwordHash: "hash-employee-old", attempts: 1, lockedUntil: 666 },
        { id: "manager-admin", username: "admin", passwordHash: "hash-admin-old", attempts: 4, lockedUntil: 999 },
        { id: "manager-super", username: "adminsystem", passwordHash: "hash-super-old", attempts: 2, lockedUntil: 777 },
      ],
    );
    assert.deepEqual(rows(database, "SELECT id, user_id AS userId FROM sessions ORDER BY id"), [
      { id: "session-admin", userId: "manager-admin" },
      { id: "session-employee", userId: "employee-user" },
      { id: "session-super", userId: "manager-super" },
    ]);
    assert.equal(await readFile(environment, "utf8"), originalEnvironment, "a non-admin rotation must not rewrite the bootstrap hash");
    assert.deepEqual(rows(database, "SELECT user_id AS userId, entity_id AS entityId FROM audit_logs"), [
      { userId: "manager-store", entityId: "manager-store" },
    ]);

    // Omitting --username is intentionally safe: it can only target 'admin'.
    const defaultAdmin = spawnSync(process.execPath, [tool, "--db", database, "--env", environment], {
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(defaultAdmin.status, 0, defaultAdmin.stderr);
    const usersAfterDefault = rows(database, "SELECT username, password_hash AS passwordHash FROM users ORDER BY username");
    assert.match(usersAfterDefault.find((user) => user.username === "admin").passwordHash, /^pbkdf2\$210000\$/u);
    assert.equal(usersAfterDefault.find((user) => user.username === "adminsystem").passwordHash, "hash-super-old");
    assert.equal(
      usersAfterDefault.find((user) => user.username === "storemanager").passwordHash,
      usersAfterSelected.find((user) => user.username === "storemanager").passwordHash,
    );
    assert.match(await readFile(environment, "utf8"), /^DORE_MANAGER_PASSWORD_HASH=pbkdf2\$210000\$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
