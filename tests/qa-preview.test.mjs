import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const runSeed = (directory, env = {}) => spawnSync(process.execPath, [
  "--require", "./tests/tsx-windows-userinfo.cjs", "--import", "tsx", "scripts/qa/seed-preview.mjs", directory,
], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, ...env } });

test("preview seeding isolates inherited live paths and reproduces the locked-store scenario", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dore-preview-"));
  const sentinelDirectory = await mkdtemp(join(tmpdir(), "dore-live-sentinel-"));
  const sentinel = join(sentinelDirectory, "live.sqlite");
  await writeFile(sentinel, "must remain unchanged");
  try {
    const result = runSeed(directory, { DORE_DATABASE_PATH: sentinel, DORE_UPLOAD_DIR: sentinelDirectory });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Preview fixtures verified/);
    assert.doesNotMatch(result.stdout, /Mật khẩu|pbkdf2/);
    assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged");
    const db = new DatabaseSync(join(directory, "dore.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT final_profit FROM financial_periods WHERE store_id='qa-locked' AND status='LOCKED'").get().final_profit, 5_000_000);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE username IN ('qa-admin','qa-manager','qa-employee')").get().count, 3);
    } finally { db.close(); }
    if (process.platform !== "win32") assert.equal((await stat(join(directory, "credentials.txt"))).mode & 0o777, 0o600);
    assert.notEqual(runSeed(directory).status, 0, "Existing previews must not be reset by seeding again");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(sentinelDirectory, { recursive: true, force: true });
  }
});

test("preview rejects paths outside its temporary namespace and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dore-unrelated-"));
  const alias = `${directory}-link`;
  try {
    assert.notEqual(runSeed(directory).status, 0);
    if (process.platform !== "win32") {
      await symlink(directory, alias, "dir");
      assert.notEqual(runSeed(alias).status, 0);
    }
  } finally {
    await rm(alias, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
