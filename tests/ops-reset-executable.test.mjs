import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceUrl = new URL("../ops/scripts/reset-operational-data.sh", import.meta.url);
const libraryUrl = new URL("../ops/scripts/lib.sh", import.meta.url);
const bash = process.platform === "win32"
  ? "C:/Program Files/Git/bin/bash.exe"
  : "bash";

const slash = (value) => {
  const normalized = value.replaceAll("\\", "/");
  if (process.platform !== "win32" || !/^[A-Za-z]:\//u.test(normalized)) return normalized;
  return `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
};

async function executable(file, body) {
  await writeFile(file, `#!/usr/bin/env bash\n${body}`, "utf8");
  await chmod(file, 0o755);
}

async function runReset({ failPostcheck = false, failHealth = false, residualUploadRegistry = false }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dore-reset-test-"));
  const state = path.join(root, "state");
  const tools = path.join(root, "tools");
  const mocks = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  await Promise.all([
    mkdir(path.join(state, "uploads", "cccd"), { recursive: true }),
    mkdir(tools, { recursive: true }),
    mkdir(mocks, { recursive: true }),
  ]);
  await writeFile(path.join(state, "dore.sqlite"), "test database", "utf8");
  await writeFile(log, "", "utf8");

  await executable(path.join(tools, "backup.sh"), `
archive=${JSON.stringify(slash(path.join(root, "pre-reset.tar.gz")))}
: > "$archive"
printf '%s\\n' "$archive"
`);
  await executable(path.join(tools, "restore.sh"), `
printf 'restore:%s:%s\\n' "$1" "$2" >> ${JSON.stringify(slash(log))}
exit 0
`);
  await executable(path.join(mocks, "systemctl"), `
printf 'systemctl:%s:%s\\n' "$1" "$2" >> ${JSON.stringify(slash(log))}
exit 0
`);
  await executable(path.join(mocks, "sqlite3"), `
query="\${2-}"
case "$query" in
  *PRAGMA\\ quick_check*)
    ${failPostcheck ? "printf '%s\\n' broken" : "printf '%s\\n' ok"}
    ;;
  *"role = 'MANAGER'"*) printf '%s\\n' 1 ;;
  *"FROM cccd_upload_registry"*) printf '%s\\n' ${residualUploadRegistry ? 1 : 0} ;;
  *"SELECT COUNT("*) printf '%s\\n' 0 ;;
  *) cat >/dev/null || true ;;
esac
`);
  for (const command of ["chown", "chmod"]) {
    await executable(path.join(mocks, command), "exit 0\n");
  }
  await executable(path.join(mocks, "curl"), failHealth ? "exit 1\n" : "exit 0\n");
  await executable(path.join(mocks, "sleep"), "exit 0\n");

  let reset = await readFile(sourceUrl, "utf8");
  reset = reset
    .replace(
      '. "$SCRIPT_DIR/lib.sh"',
      `. "$SCRIPT_DIR/lib.sh"\n${failHealth
        ? `health_calls=0\ndore_wait_for_health() { health_calls=$((health_calls + 1)); [ "$health_calls" -gt 1 ]; }`
        : "dore_wait_for_health() { return 0; }"}`,
    )
    .replace("dore_require_root", ": # root check disabled by executable test")
    .replace('chown -R dore:dore "$UPLOAD_ROOT"', ': # ownership disabled by executable test')
    .replace('chmod 0750 "$UPLOAD_ROOT" "$CCCD_ROOT"', ': # permissions disabled by executable test')
    .replaceAll("/var/lib/dore", slash(state))
    .replaceAll("/usr/local/lib/dore", slash(tools));
  const script = path.join(root, "reset.sh");
  await Promise.all([
    writeFile(script, reset, "utf8"),
    writeFile(path.join(root, "lib.sh"), await readFile(libraryUrl, "utf8"), "utf8"),
  ]);

  const result = spawnSync(bash, [slash(script), "--confirm-reset-all-data"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${slash(mocks)}:/usr/bin:/bin` },
    // The complete suite runs several SQLite and build-heavy workers in parallel.
    // Give Git Bash enough headroom so a loaded Windows host is not mistaken for
    // a failed rollback implementation.
    timeout: 30_000,
  });
  const calls = await readFile(log, "utf8");
  await rm(root, { recursive: true, force: true });
  return { ...result, calls };
}

test("reset restores its backup when a postcondition exits through dore_die", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const result = await runReset({ failPostcheck: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reset failed; restoring the pre-reset backup/u);
  assert.match(result.calls, /restore:--confirm-restore:/u);
  assert.match(result.calls, /systemctl:start:dore\.service/u);
});

test("reset restores its backup when post-reset application health fails", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const result = await runReset({ failHealth: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /application failed readiness after reset/u);
  assert.match(result.calls, /restore:--confirm-restore:/u);
  assert.match(result.calls, /systemctl:start:dore\.service/u);
});

test("reset postconditions reject a surviving CCCD upload registry row and restore the backup", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const result = await runReset({ residualUploadRegistry: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CCCD upload registry rows remain after reset/u);
  assert.match(result.stderr, /Reset failed; restoring the pre-reset backup/u);
  assert.match(result.calls, /restore:--confirm-restore:/u);
});
