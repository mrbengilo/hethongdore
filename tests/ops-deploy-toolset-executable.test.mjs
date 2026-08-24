import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const deployUrl = new URL("../ops/scripts/deploy.sh", import.meta.url);
const rollbackUrl = new URL("../ops/scripts/rollback.sh", import.meta.url);
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const toolNames = [
  "lib.sh",
  "backup.sh",
  "restore.sh",
  "rollback.sh",
  "set-manager-password.mjs",
  "set-super-admin.mjs",
  "reset-operational-data.sh",
];

function slash(value) {
  const normalized = value.replaceAll("\\", "/");
  if (process.platform !== "win32" || !/^[A-Za-z]:\//u.test(normalized)) return normalized;
  return `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

async function toolsetFunctions(toolRoot) {
  const deploy = await readFile(deployUrl, "utf8");
  const start = deploy.indexOf("TOOL_ROOT=/usr/local/lib/dore");
  const end = deploy.indexOf("\nswitch_current() {", start);
  assert.ok(start >= 0 && end > start, "deploy tool transaction must remain extractable");
  return deploy.slice(start, end)
    .replace("TOOL_ROOT=/usr/local/lib/dore", `TOOL_ROOT=${JSON.stringify(slash(toolRoot))}`)
    .replaceAll("sudo install -o root -g root -m 0755", "install -m 0755")
    .replaceAll("sudo test", "test")
    .replaceAll("sudo touch", "touch")
    .replaceAll("sudo mv", "mv")
    .replaceAll("sudo rm", "rm");
}

async function caddyTransactionFunctions(caddyRoot) {
  const deploy = await readFile(deployUrl, "utf8");
  const start = deploy.indexOf("CADDY_ROOT=/etc/caddy");
  const end = deploy.indexOf("\ntool_stage_path() {", start);
  assert.ok(start >= 0 && end > start, "deploy Caddy transaction must remain extractable");
  return deploy.slice(start, end)
    .replace("CADDY_ROOT=/etc/caddy", `CADDY_ROOT=${JSON.stringify(slash(caddyRoot))}`)
    .replaceAll("sudo install -o root -g root -m 0644", "install -m 0644")
    .replaceAll("sudo ", "");
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dore-deploy-tools-"));
  const release = path.join(root, "release");
  const scripts = path.join(release, "ops", "scripts");
  const live = path.join(root, "live");
  await Promise.all([mkdir(scripts, { recursive: true }), mkdir(live, { recursive: true })]);
  await Promise.all(toolNames.map((name) => writeFile(path.join(scripts, name), `new:${name}\n`, "utf8")));
  // Simulate an older production host: lib.sh exists, newly introduced rescue
  // tools (including reset-operational-data.sh) do not exist yet.
  await writeFile(path.join(live, "lib.sh"), "old:lib.sh\n", "utf8");
  return { root, release, live };
}

async function runToolTransaction({ failAfterFirstInstall }) {
  const state = await fixture();
  const functions = await toolsetFunctions(state.live);
  const script = path.join(state.root, "transaction.sh");
  const failureSetup = failAfterFirstInstall
    ? 'rm -f -- "$(tool_stage_path restore.sh)"\n'
    : "";
  const action = failAfterFirstInstall
    ? `
${failureSetup}if publish_toolset; then
  printf '%s\n' "publication unexpectedly succeeded" >&2
  exit 91
fi
restore_toolset
cleanup_tool_artifacts
`
    : `
publish_toolset
cleanup_tool_artifacts
`;
  await writeFile(script, `#!/usr/bin/env bash
set -Eeuo pipefail
RELEASE_ID=abcdef1
RELEASE_DIR=${JSON.stringify(slash(state.release))}
${functions}
prepare_toolset
${action}
`, "utf8");
  // Git Bash startup and antivirus scanning are noticeably slower while the
  // full test suite runs in parallel on Windows. Keep this above the observed
  // cold-start time so a healthy tool transaction is not reported as killed.
  const result = spawnSync(bash, [slash(script)], { encoding: "utf8", timeout: 30_000 });
  const names = await readdir(state.live);
  const contents = Object.fromEntries(await Promise.all(names
    .filter((name) => !name.startsWith("."))
    .map(async (name) => [name, await readFile(path.join(state.live, name), "utf8")])));
  await rm(state.root, { recursive: true, force: true });
  return { result, names, contents };
}

async function runCaddyTransaction({ nextConfig, action }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dore-deploy-caddy-"));
  const release = path.join(root, "release");
  const releaseCaddy = path.join(release, "ops", "caddy");
  const live = path.join(root, "live");
  await Promise.all([mkdir(releaseCaddy, { recursive: true }), mkdir(live, { recursive: true })]);
  await writeFile(path.join(releaseCaddy, "Caddyfile"), nextConfig, "utf8");
  await writeFile(path.join(live, "Caddyfile"), "VALID old\n", "utf8");

  const functions = await caddyTransactionFunctions(live);
  const script = path.join(root, "transaction.sh");
  const transaction = action === "publish"
    ? "prepare_caddy_config\npublish_caddy_config\ncleanup_caddy_artifacts\n"
    : action === "rollback"
      ? "prepare_caddy_config\npublish_caddy_config\nrestore_caddy_config\ncleanup_caddy_artifacts\n"
      : `if prepare_caddy_config; then
  printf '%s\n' "invalid Caddyfile unexpectedly passed validation" >&2
  exit 91
fi
cleanup_caddy_artifacts
`;
  await writeFile(script, `#!/usr/bin/env bash
set -Eeuo pipefail
RELEASE_ID=abcdef1
RELEASE_DIR=${JSON.stringify(slash(release))}
systemctl() { return 0; }
caddy() {
  local config=""
  [ "\${1:-}" = validate ] || return 90
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --config ]; then config="$2"; shift 2; else shift; fi
  done
  [ -n "$config" ] && grep -q '^VALID ' "$config"
}
${functions}
${transaction}
`, "utf8");

  const result = spawnSync(bash, [slash(script)], { encoding: "utf8", timeout: 30_000 });
  const liveConfig = await readFile(path.join(live, "Caddyfile"), "utf8");
  const names = await readdir(live);
  await rm(root, { recursive: true, force: true });
  return { result, liveConfig, names };
}

async function runPreDeployGate({ backupFails }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dore-predeploy-backup-"));
  const log = path.join(root, "calls.log");
  const backupRoot = path.join(root, "backups");
  const archive = path.join(backupRoot, "dore-backup-test.tar.gz");
  const backupTool = path.join(root, "backup.sh");
  await mkdir(backupRoot, { recursive: true });
  await writeFile(log, "", "utf8");
  const backupOutcome = backupFails
    ? "exit 7\n"
    : `: > ${JSON.stringify(slash(archive))}\nprintf '%s\\n' ${JSON.stringify(slash(archive))}\n`;
  await writeFile(
    backupTool,
    `#!/usr/bin/env bash\nprintf '%s\\n' backup >> ${JSON.stringify(slash(log))}\n${backupOutcome}`,
    "utf8",
  );
  // Windows-created release archives commonly restore shell scripts as 0640.
  // The deployment gate must invoke this readable, non-executable file through
  // bash instead of attempting to execute it directly.
  await chmod(backupTool, 0o640);

  const deploy = await readFile(deployUrl, "utf8");
  const start = deploy.indexOf("trap cleanup_deploy_artifacts EXIT");
  const switchLine = 'switch_current "$RELEASE_DIR"';
  const end = deploy.indexOf(switchLine, start) + switchLine.length;
  assert.ok(start >= 0 && end > start, "pre-deploy backup gate must remain extractable");
  const sequence = deploy.slice(start, end)
    .replaceAll('"$RELEASE_DIR/ops/scripts/backup.sh"', JSON.stringify(slash(backupTool)))
    .replaceAll("/var/backups/dore", slash(backupRoot));
  const script = path.join(root, "gate.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -Eeuo pipefail
RELEASE_DIR=/tmp/release
sudo() { "$@"; }
dore_die() { printf 'die:%s\\n' "$*" >> ${JSON.stringify(slash(log))}; exit 1; }
cleanup_deploy_artifacts() { :; }
switch_current() { printf '%s\\n' switch >> ${JSON.stringify(slash(log))}; }
${sequence}
`, "utf8");
  const result = spawnSync(bash, [slash(script)], { encoding: "utf8", timeout: 15_000 });
  const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/u).filter(Boolean);
  await rm(root, { recursive: true, force: true });
  return { result, calls };
}

async function runRollbackCaddyRecovery() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dore-rollback-caddy-"));
  const target = path.join(root, "release");
  const caddyRoot = path.join(root, "caddy");
  await Promise.all([
    mkdir(path.join(target, "ops", "caddy"), { recursive: true }),
    mkdir(caddyRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(target, "server.js"), "// complete\n", "utf8"),
    writeFile(path.join(target, "ops", "caddy", "Caddyfile"), "VALID target\n", "utf8"),
    writeFile(path.join(caddyRoot, "Caddyfile"), "VALID original\n", "utf8"),
  ]);

  const rollback = await readFile(rollbackUrl, "utf8");
  const start = rollback.indexOf("CADDY_ROOT=/etc/caddy");
  const end = rollback.indexOf("\nprepare_target_caddy ||", start);
  assert.ok(start >= 0 && end > start, "rollback Caddy transaction must remain extractable");
  const transaction = rollback.slice(start, end)
    .replace("CADDY_ROOT=/etc/caddy", `CADDY_ROOT=${JSON.stringify(slash(caddyRoot))}`)
    .replaceAll("install -o root -g root -m 0644", "install -m 0644");
  const script = path.join(root, "rollback-caddy.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -Eeuo pipefail
RELEASE_ID=abcdef1
TARGET=${JSON.stringify(slash(target))}
PREVIOUS=/tmp/previous
CURRENT=/tmp/current
dore_die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
systemctl() {
  if [ "\${1:-}" = is-active ]; then return 0; fi
  return 0
}
caddy() {
  local config=""
  [ "\${1:-}" = validate ] || return 90
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --config ]; then config="$2"; shift 2; else shift; fi
  done
  [ -n "$config" ] && grep -q '^VALID ' "$config"
}
${transaction}
prepare_target_caddy
publish_target_caddy
restore_original_caddy
cleanup_caddy_artifacts
trap - EXIT
`, "utf8");
  const result = spawnSync(bash, [slash(script)], { encoding: "utf8", timeout: 15_000 });
  const liveConfig = await readFile(path.join(caddyRoot, "Caddyfile"), "utf8");
  const names = await readdir(caddyRoot);
  await rm(root, { recursive: true, force: true });
  return { result, liveConfig, names };
}

test("deploy can publish a complete toolset when a new tool was absent on the old host", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const { result, names, contents } = await runToolTransaction({ failAfterFirstInstall: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(names.sort(), [...toolNames].sort());
  for (const name of toolNames) assert.equal(contents[name], `new:${name}\n`);
});

test("partial tool publication restores old files and removes tools that were originally absent", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const { result, names, contents } = await runToolTransaction({ failAfterFirstInstall: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(names, ["lib.sh"]);
  assert.equal(contents["lib.sh"], "old:lib.sh\n");
});

test("deploy atomically publishes a validated Caddyfile and removes transaction artifacts", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const { result, liveConfig, names } = await runCaddyTransaction({ nextConfig: "VALID new\n", action: "publish" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(liveConfig, "VALID new\n");
  assert.deepEqual(names, ["Caddyfile"]);
});

test("failed promotion restores and validates the previous Caddyfile", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const { result, liveConfig, names } = await runCaddyTransaction({ nextConfig: "VALID new\n", action: "rollback" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(liveConfig, "VALID old\n");
  assert.deepEqual(names, ["Caddyfile"]);
});

test("invalid staged Caddyfile never replaces the live configuration", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const { result, liveConfig, names } = await runCaddyTransaction({ nextConfig: "INVALID new\n", action: "invalid" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(liveConfig, "VALID old\n");
  assert.deepEqual(names, ["Caddyfile"]);
});

test("release permissions remain traversable by the application group under caller umask 077", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX group permission bits are not enforceable on Windows");
    return;
  }

  const deploy = await readFile(deployUrl, "utf8");
  const releaseMode = deploy.match(/^sudo chmod -R u=rwX,g=rX,o= "\$STAGING"$/mu)?.[0];
  assert.ok(releaseMode, "deploy must normalize the staged release permissions deterministically");

  const root = await mkdtemp(path.join(os.tmpdir(), "dore-release-mode-"));
  try {
    const standalone = path.join(root, "standalone");
    const nested = path.join(standalone, ".next", "server");
    const staging = path.join(root, "staging");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await writeFile(path.join(standalone, "server.js"), "console.log('ready');\n", { mode: 0o600 });
    await writeFile(path.join(nested, "runtime.js"), "export {};\n", { mode: 0o600 });
    await chmod(standalone, 0o700);
    await chmod(path.join(standalone, ".next"), 0o700);
    await chmod(nested, 0o700);

    const normalizedMode = releaseMode.replace("sudo ", "");
    const script = `set -Eeuo pipefail
umask 077
STANDALONE=${JSON.stringify(slash(standalone))}
STAGING=${JSON.stringify(slash(staging))}
install -d -m 0750 "$STAGING"
cp -a "$STANDALONE/." "$STAGING/"
${normalizedMode}
`;
    const result = spawnSync(bash, ["-c", script], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);

    const directoryModes = await Promise.all([
      stat(staging),
      stat(path.join(staging, ".next")),
      stat(path.join(staging, ".next", "server")),
    ]);
    for (const entry of directoryModes) {
      assert.equal(entry.mode & 0o050, 0o050, "the application group must be able to read and traverse every release directory");
      assert.equal(entry.mode & 0o007, 0, "release directories must remain private from unrelated users");
    }

    for (const file of [path.join(staging, "server.js"), path.join(staging, ".next", "server", "runtime.js")]) {
      const mode = (await stat(file)).mode;
      assert.equal(mode & 0o040, 0o040, "the application group must be able to read runtime files");
      assert.equal(mode & 0o007, 0, "runtime files must remain private from unrelated users");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-deploy backup gate accepts a non-executable backup script and aborts promotion on backup failure", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }

  const success = await runPreDeployGate({ backupFails: false });
  assert.equal(success.result.status, 0, success.result.stderr);
  assert.deepEqual(success.calls, ["backup", "switch"]);

  const failure = await runPreDeployGate({ backupFails: true });
  assert.notEqual(failure.result.status, 0);
  assert.equal(failure.calls[0], "backup");
  assert.ok(failure.calls.some((call) => call.startsWith("die:pre-deploy backup failed")));
  assert.ok(!failure.calls.includes("switch"), "the active release must not change after a failed backup");
});

test("rollback publishes a validated target Caddyfile and can restore the original config", async (t) => {
  if (process.platform === "win32" && spawnSync(bash, ["--version"]).error) {
    t.skip("Git Bash is not installed");
    return;
  }
  const { result, liveConfig, names } = await runRollbackCaddyRecovery();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(liveConfig, "VALID original\n");
  assert.deepEqual(names, ["Caddyfile"]);
});
