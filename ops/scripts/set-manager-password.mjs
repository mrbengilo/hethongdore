#!/usr/bin/env node

import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ITERATIONS = 210_000;
const DEFAULT_ENV_FILE = "/etc/dore/dore.env";
const DEFAULT_DATABASE = "/var/lib/dore/dore.sqlite";
const DEFAULT_USERNAME = "admin";

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const options = { envFile: DEFAULT_ENV_FILE, database: DEFAULT_DATABASE, username: DEFAULT_USERNAME };
  let usernameWasSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env" && argv[index + 1]) {
      options.envFile = argv[index + 1];
      index += 1;
    } else if (argument === "--db" && argv[index + 1]) {
      options.database = argv[index + 1];
      index += 1;
    } else if (argument === "--username" && argv[index + 1] && !usernameWasSet) {
      options.username = argv[index + 1].trim().toLowerCase();
      usernameWasSet = true;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: sudo set-manager-password.mjs [--username USERNAME] [--env PATH] [--db PATH]\n");
      process.stdout.write("If --username is omitted, only the bootstrap account 'admin' is targeted.\n");
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(options.username)) {
    throw new Error("username must contain only lowercase letters, numbers, dot, underscore or hyphen");
  }
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
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new Error("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
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

function ensureRegularFile(path, label) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symbolic link`);
}

function renderEnvironment(original, passwordHash) {
  const replacement = `DORE_MANAGER_PASSWORD_HASH=${passwordHash}`;
  const lines = original.split(/\r?\n/u);
  let replaced = false;
  const updated = [];
  for (const line of lines) {
    if (line.startsWith("DORE_MANAGER_PASSWORD_HASH=")) {
      if (!replaced) updated.push(replacement);
      replaced = true;
    } else {
      updated.push(line);
    }
  }
  if (!replaced) updated.push(replacement);
  return `${updated.join("\n").replace(/\n+$/u, "")}\n`;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {
      // Best-effort cleanup; preserve the original write failure.
    }
    throw error;
  }
}

function updateExistingDatabase(databasePath, username, passwordHash, envFile, oldEnvironment, newEnvironment) {
  const databaseOwner = lstatSync(databasePath);
  const database = new DatabaseSync(databasePath);
  let environmentChanged = false;
  try {
    database.exec("PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE");
    const managers = database.prepare(
      "SELECT id FROM users WHERE username = ? AND role = 'MANAGER' ORDER BY id LIMIT 2",
    ).all(username);
    if (managers.length !== 1) {
      throw new Error(`manager account '${username}' was not found; no files were changed`);
    }
    const target = managers[0];

    const result = database.prepare(
      "UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ? AND username = ? AND role = 'MANAGER'",
    ).run(passwordHash, target.id, username);
    if (Number(result.changes) !== 1) throw new Error("the selected manager account changed concurrently; no files were changed");

    const revoked = database.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    const hasAuditLog = database.prepare(
      "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'audit_logs'",
    ).get();
    if (hasAuditLog) {
      database.prepare(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        `audit-${randomUUID()}`,
        target.id,
        "MANAGER_PASSWORD_RESET_OFFLINE",
        "USER",
        target.id,
        `username=${username};sessions_revoked=${Number(revoked.changes)}`,
        new Date().toISOString(),
      );
    }

    // The environment hash is used only when bootstrapping the default admin
    // account. Rotating any other manager (including a super-admin) must not
    // rewrite that independent bootstrap credential.
    if (username === DEFAULT_USERNAME) {
      atomicWrite(envFile, newEnvironment);
      environmentChanged = true;
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {
      // Preserve the original failure when SQLite has already rolled back.
    }
    if (environmentChanged) {
      try { atomicWrite(envFile, oldEnvironment); } catch (restoreError) {
        throw new AggregateError([error, restoreError], "password update failed and the environment file could not be returned");
      }
    }
    throw error;
  } finally {
    database.close();
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(path)) {
        chownSync(path, databaseOwner.uid, databaseOwner.gid);
        chmodSync(path, path === databasePath ? 0o640 : 0o660);
      }
    }
  }
}

async function main() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("run this command with sudo so the protected environment file can be updated");
  }

  const { envFile, database, username } = parseArguments(process.argv.slice(2));
  if (!existsSync(envFile)) throw new Error("environment file is missing; run install-host.sh first");
  ensureRegularFile(envFile, "environment file");
  ensureRegularFile(database, "database");

  let password = await promptHidden("New manager password: ");
  let confirmation = await promptHidden("Confirm manager password: ");
  if (password !== confirmation) throw new Error("passwords do not match");
  confirmation = "";
  if (password.length < 12) throw new Error("manager password must contain at least 12 characters");
  if (password.length > 1024) throw new Error("manager password is too long");

  const passwordHash = encodePassword(password);
  password = "";
  const oldEnvironment = readFileSync(envFile, "utf8");
  const newEnvironment = renderEnvironment(oldEnvironment, passwordHash);

  if (existsSync(database)) {
    updateExistingDatabase(database, username, passwordHash, envFile, oldEnvironment, newEnvironment);
    process.stderr.write(`Password updated for manager '${username}'; only that account's sessions were revoked.\n`);
  } else {
    if (username !== DEFAULT_USERNAME) {
      throw new Error("without an existing database, only the default 'admin' bootstrap password can be set");
    }
    atomicWrite(envFile, newEnvironment);
    process.stderr.write("Password hash stored for the default 'admin' database bootstrap.\n");
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
