#!/usr/bin/env node

import { existsSync, lstatSync } from "node:fs";
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ITERATIONS = 210_000;
const DEFAULT_DATABASE = "/var/lib/dore/dore.sqlite";

function parseArguments(argv) {
  const options = { database: DEFAULT_DATABASE, username: "", name: "Quản trị cấp cao" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--db" && argv[index + 1]) options.database = argv[++index];
    else if (argument === "--username" && argv[index + 1]) options.username = argv[++index].trim().toLowerCase();
    else if (argument === "--name" && argv[index + 1]) options.name = argv[++index].trim();
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: sudo -u dore set-super-admin.mjs --username USERNAME [--name DISPLAY_NAME] [--db PATH]\n");
      process.exit(0);
    } else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  if (!/^[a-z0-9._-]{4,50}$/u.test(options.username)) {
    throw new Error("username must contain 4-50 lowercase letters, digits, dot, underscore or dash");
  }
  if (!options.name || options.name.length > 100) throw new Error("display name must contain 1-100 characters");
  return options;
}

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error("an interactive terminal is required; passwords are never accepted through arguments or pipes"));
      return;
    }
    const input = process.stdin;
    const output = process.stderr;
    const previousRawMode = Boolean(input.isRaw);
    let value = "";
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    output.write(label);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function encodePassword(password) {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  return `pbkdf2$${ITERATIONS}$${salt.toString("base64")}$${digest.toString("base64")}`;
}

async function main() {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    throw new Error("run this command as the restricted dore service account (sudo -u dore ...), never as root");
  }
  const { database: databasePath, username, name } = parseArguments(process.argv.slice(2));
  if (!existsSync(databasePath)) throw new Error("database is missing; deploy and start the application first");
  const databaseStat = lstatSync(databasePath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error("database must be a regular file, not a symbolic link");
  if (databaseStat.uid !== process.getuid()) throw new Error("database must be owned by the current restricted service account");

  let password = await promptHidden("New super-admin password: ");
  let confirmation = await promptHidden("Confirm super-admin password: ");
  if (password !== confirmation) throw new Error("passwords do not match");
  confirmation = "";
  if (password.length < 12) throw new Error("password must contain at least 12 characters");
  if (password.length > 1024) throw new Error("password is too long");
  const passwordHash = encodePassword(password);
  password = "";

  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE");
    const column = database.prepare("SELECT 1 AS found FROM pragma_table_info('users') WHERE name = 'is_super_admin'").get();
    if (!column) throw new Error("application schema is not ready; deploy the super-admin release first");
    const existing = database.prepare("SELECT id, is_super_admin AS isSuperAdmin FROM users WHERE username = ?").get(username);
    if (existing && Number(existing.isSuperAdmin) !== 1) {
      throw new Error("username already belongs to a normal account; choose another username");
    }
    const id = existing?.id ?? `user-super-admin-${randomUUID()}`;
    if (existing) {
      database.prepare(`UPDATE users SET password_hash = ?, role = 'MANAGER', name = ?, is_super_admin = 1,
        employee_id = NULL, store_id = NULL, failed_attempts = 0, locked_until = NULL,
        shift_active = 0, current_shift = NULL, shift_started_at = NULL WHERE id = ?`)
        .run(passwordHash, name, id);
    } else {
      database.prepare(`INSERT INTO users
        (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, locked_until,
          shift_active, current_shift, shift_started_at, is_super_admin)
        VALUES (?, ?, ?, 'MANAGER', ?, NULL, NULL, 0, NULL, 0, NULL, NULL, 1)`)
        .run(id, username, passwordHash, name);
    }
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    database.prepare(`INSERT INTO audit_logs
      (id, user_id, action, entity_type, entity_id, detail, created_at)
      VALUES (?, ?, 'SUPER_ADMIN_ACCOUNT_SET_OFFLINE', 'USER', ?, ?, ?)`)
      .run(`audit-${randomUUID()}`, id, id, JSON.stringify({ username, sessionsRevoked: true }), new Date().toISOString());
    database.exec("COMMIT");
    process.stderr.write(`Super-admin account '${username}' is ready; existing sessions for this account were revoked.\n`);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
