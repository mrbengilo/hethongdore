import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createD1, executeMigration, initializeLegacy, seedIdentities } from "./d1-fixture.mjs";

// A fresh state directory per run prevents tests from touching a developer's
// default local D1, and no remote database option is accepted by this harness.
const state = resolve(".wrangler", "shift-e2e", crypto.randomUUID());
await mkdir(state, { recursive: true });
const { mf, db } = await createD1({ d1Persist: resolve(state, "v3", "d1") });
try {
  await initializeLegacy(db);
  await executeMigration(db, "0001_shift_scheduling.sql");
  await seedIdentities(db);
} finally {
  await mf.dispose();
}

const child = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "dev", "--hostname", "127.0.0.1", "--port", "8788"], {
  stdio: "inherit",
  env: { ...process.env, DORE_TEST_STATE: state, BROWSER: "none", WRANGLER_SEND_METRICS: "false" },
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
