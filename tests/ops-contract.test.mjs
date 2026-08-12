import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const text = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

test("self-host builds do not require Sites hosting metadata in the source package", async () => {
  const vite = await text("../vite.config.ts");

  assert.doesNotMatch(vite, /import\s+hostingConfig\s+from\s+["']\.\/\.openai\/hosting\.json["']/u);
  assert.doesNotMatch(vite, /new URL\("\.\/\.openai\/hosting\.json", import\.meta\.url\)/u);
  assert.match(vite, /resolve\(process\.cwd\(\), "\.openai", "hosting\.json"\)/u);
  assert.match(vite, /if \(!existsSync\(configPath\)\) return \{\};/u);
  assert.match(vite, /JSON\.parse\(readFileSync\(configPath, "utf8"\)\)/u);
  assert.match(vite, /const \{ d1, r2 \} = loadHostingBindings\(\);/u);
});

test("self-host environment and systemd keep the Node process private and state outside releases", async () => {
  const [environment, service] = await Promise.all([
    text("../ops/env/dore.env.example"),
    text("../ops/systemd/dore.service"),
  ]);

  for (const setting of [
    "NODE_ENV=production",
    "HOSTNAME=127.0.0.1",
    "PORT=3000",
    "DORE_DB_PLATFORM=sqlite",
    "DORE_DATABASE_PATH=/var/lib/dore/dore.sqlite",
    "DORE_UPLOAD_DIR=/var/lib/dore/uploads",
  ]) assert.match(environment, new RegExp(setting.replaceAll("/", "\\/"), "u"));
  assert.match(environment, /DORE_MANAGER_PASSWORD_HASH=SET_WITH_PASSWORD_TOOL/u);
  assert.doesNotMatch(environment, /DORE_MANAGER_PASSWORD_HASH=pbkdf2\$/u);

  assert.match(service, /User=dore/u);
  assert.match(service, /Group=dore/u);
  assert.match(service, /EnvironmentFile=\/etc\/dore\/dore\.env/u);
  assert.match(service, /ExecStart=\/usr\/local\/bin\/node \/opt\/dore\/current\/server\.js/u);
  assert.match(service, /ReadWritePaths=\/var\/lib\/dore/u);
  assert.match(service, /ProtectSystem=strict/u);
  assert.match(service, /NoNewPrivileges=true/u);
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/u);
});

test("readiness initializes the real schema and validates the manager baseline", async () => {
  const health = await text("../app/api/health/route.ts");
  assert.match(health, /import \{ initDb \} from "\.\.\/\.\.\/\.\.\/db\/runtime"/u);
  assert.match(health, /const database = await initDb\(\)/u);
  assert.match(health, /FROM users WHERE role = 'MANAGER'/u);
  assert.match(health, /FROM stores/u);
  assert.doesNotMatch(health, /SELECT 1 AS healthy/u);
});

test("Caddy serves only the canonical HTTPS domain and probes application health", async () => {
  const [caddy, installHost] = await Promise.all([
    text("../ops/caddy/Caddyfile"),
    text("../ops/scripts/install-host.sh"),
  ]);
  assert.match(caddy, /www\.doregroup\.io\.vn \{[\s\S]*redir https:\/\/doregroup\.io\.vn\{uri\} permanent/u);
  assert.match(caddy, /doregroup\.io\.vn \{/u);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000/u);
  assert.match(caddy, /health_uri \/api\/health/u);
  assert.match(caddy, /Strict-Transport-Security/u);
  assert.doesNotMatch(caddy, /tls internal/u);
  assert.match(installHost, /install -d -o caddy -g caddy -m 0750 \/var\/log\/caddy/u);
  assert.match(installHost, /chown caddy:caddy \/var\/log\/caddy\/dore-access\.log/u);
});

test("release deployment is immutable, health-gated and automatically reversible", async () => {
  const [deploy, rollback, installHost] = await Promise.all([
    text("../ops/scripts/deploy.sh"),
    text("../ops/scripts/rollback.sh"),
    text("../ops/scripts/install-host.sh"),
  ]);
  assert.match(deploy, /corepack pnpm run build:selfhost/u);
  assert.match(deploy, /set -Eeuo pipefail[\s\S]*umask 022/u);
  assert.match(deploy, /required build\/sites-vite-plugin\.ts was not found/u);
  assert.match(deploy, /\.next\/standalone/u);
  assert.match(deploy, /\$STANDALONE\/server\.js/u);
  assert.match(deploy, /\/opt\/dore\/releases/u);
  assert.match(deploy, /release already exists and is immutable/u);
  assert.match(deploy, /chown -R root:dore "\$STAGING"[\s\S]*chmod -R u=rwX,g=rX,o= "\$STAGING"[\s\S]*sudo -u dore test -x "\$STAGING"[\s\S]*sudo -u dore test -r "\$STAGING\/server\.js"[\s\S]*mv -- "\$STAGING" "\$RELEASE_DIR"/u);
  assert.match(deploy, /dore_atomic_symlink/u);
  assert.match(deploy, /caddy validate --config "\$CADDY_STAGE" --adapter caddyfile/u);
  assert.match(deploy, /mv -Tf -- "\$CADDY_STAGE" "\$CADDY_LIVE"/u);
  assert.match(deploy, /restore_caddy_config/u);
  assert.match(deploy, /dore_wait_for_health/u);
  assert.match(deploy, /dore_wait_for_public_health 90 1/u);
  assert.match(deploy, /systemctl start caddy\.service/u);
  assert.match(deploy, /restoring the previous release/u);
  const promoteStart = deploy.indexOf("promote_release() {");
  const promoteEnd = deploy.indexOf("\n}\n\nif ! prepare_caddy_config", promoteStart);
  const promote = deploy.slice(promoteStart, promoteEnd);
  assert.ok(promoteStart >= 0 && promoteEnd > promoteStart, "promotion function must be inspectable");
  assert.ok(
    promote.indexOf("dore_wait_for_health 45 1")
      < promote.indexOf("publish_caddy_config")
      && promote.indexOf("publish_caddy_config") < promote.indexOf("systemctl reload caddy.service")
      && promote.indexOf("systemctl reload caddy.service") < promote.indexOf("dore_wait_for_public_health 90 1")
      && promote.indexOf("dore_wait_for_public_health 90 1") < promote.lastIndexOf("publish_toolset"),
    "Caddy must be published before reload while global rescue tooling waits for both health gates",
  );
  assert.doesNotMatch(promote, /dore_die/u);
  for (const failure of [
    "application service restart failed",
    "internal application health check failed",
    "Caddy reload failed",
    "Caddy start failed",
    "public HTTPS health check failed",
  ]) {
    assert.match(promote, new RegExp(`${failure.replaceAll(" ", "\\s+")}[\\s\\S]*?return 1`, "u"));
  }
  assert.ok(deploy.indexOf("if ! prepare_caddy_config") < deploy.indexOf('switch_current "$RELEASE_DIR"'));
  assert.ok(deploy.indexOf("if ! prepare_toolset") < deploy.indexOf('switch_current "$RELEASE_DIR"'));
  const recovery = deploy.slice(deploy.indexOf("Release promotion failed"));
  assert.ok(recovery.indexOf("restore_caddy_config") < recovery.indexOf('switch_current "$PREVIOUS"'));
  assert.ok(recovery.indexOf("restore_toolset") < recovery.indexOf('switch_current "$PREVIOUS"'));
  assert.match(recovery, /PRESERVE_CADDY_BACKUP=1/u);
  assert.match(recovery, /PRESERVE_TOOL_BACKUPS=1/u);
  assert.match(deploy, /could not publish rescue tool:[\s\S]*return 1/u);
  assert.match(deploy, /PRE_DEPLOY_BACKUP="\$\(sudo bash "\$RELEASE_DIR\/ops\/scripts\/backup\.sh"\)"/u);
  assert.match(deploy, /pre-deploy backup failed; the active release was not changed/u);
  assert.match(deploy, /Pre-deploy backup: %s/u);
  assert.ok(
    deploy.indexOf('if ! prepare_toolset')
      < deploy.indexOf('PRE_DEPLOY_BACKUP="$(sudo bash "$RELEASE_DIR/ops/scripts/backup.sh")"')
      && deploy.indexOf('PRE_DEPLOY_BACKUP="$(sudo bash "$RELEASE_DIR/ops/scripts/backup.sh")"')
        < deploy.indexOf('switch_current "$RELEASE_DIR"'),
    "the coherent backup must run after release preflight and immediately before promotion",
  );
  assert.match(rollback, /dore_wait_for_health/u);
  assert.match(rollback, /restoring the original release/u);
  assert.match(rollback, /CADDY_TARGET="\$TARGET\/ops\/caddy\/Caddyfile"/u);
  assert.match(rollback, /caddy validate --config "\$CADDY_STAGE" --adapter caddyfile/u);
  assert.match(rollback, /caddy validate --config "\$CADDY_LIVE" --adapter caddyfile/u);
  assert.match(rollback, /restore_original_caddy/u);
  assert.match(rollback, /dore_wait_for_public_health 90 1/u);
  assert.match(rollback, /original release and Caddyfile were restored/u);
  assert.match(installHost, /systemctl unmask caddy\.service/u);
  assert.match(installHost, /systemd-analyze verify/u);
  assert.doesNotMatch(installHost, /systemctl start dore-backup\.timer caddy\.service/u);
});

test("host installation enforces the exact supported Node.js runtime range", async () => {
  const installHost = await text("../ops/scripts/install-host.sh");
  assert.match(installHost, /major !== 22 \|\| minor < 13/u);
  assert.match(installHost, /Node\.js >=22\.13\.0 and <23 is required/u);
});

test("production SSH policy disables root and password authentication", async () => {
  const ssh = await text("../ops/ssh/00-dore-hardening.conf");
  assert.match(ssh, /^PermitRootLogin no$/mu);
  assert.match(ssh, /^PasswordAuthentication no$/mu);
  assert.match(ssh, /^AuthenticationMethods publickey$/mu);
  assert.match(ssh, /^AllowTcpForwarding no$/mu);
  assert.match(ssh, /^MaxAuthTries 3$/mu);
});

test("backups quiesce writes and snapshot SQLite with uploads before restoring service", async () => {
  const [backup, backupService, backupTimer] = await Promise.all([
    text("../ops/scripts/backup.sh"),
    text("../ops/systemd/dore-backup.service"),
    text("../ops/systemd/dore-backup.timer"),
  ]);
  assert.match(backup, /\.backup '\$STAGING\/dore\.sqlite'/u);
  assert.match(backup, /PRAGMA quick_check/u);
  assert.match(backup, /cp -a "\$UPLOADS\/\."/u);
  assert.match(backup, /SERVICE_WAS_ACTIVE=0/u);
  assert.match(backup, /systemctl is-active --quiet dore\.service/u);
  const flow = backup.slice(backup.indexOf("trap cleanup EXIT"));
  const stop = flow.indexOf("systemctl stop dore.service");
  const databaseSnapshot = flow.indexOf('sqlite3 "$DATABASE"');
  const uploadSnapshot = flow.indexOf('cp -a "$UPLOADS/."');
  const resume = flow.indexOf("resume_dore_service || dore_die");
  assert.ok(stop >= 0 && stop < databaseSnapshot, "writes must stop before the database snapshot");
  assert.ok(databaseSnapshot < uploadSnapshot, "database and uploads must be copied in one quiesced window");
  assert.ok(uploadSnapshot < resume, "the app may restart only after both snapshot parts are complete");
  assert.match(backup, /sha256sum dore\.sqlite metadata\.txt/u);
  assert.match(backup, /mv -- "\$TEMP_ARCHIVE" "\$ARCHIVE"/u);
  assert.match(backupService, /ReadOnlyPaths=\/var\/lib\/dore/u);
  assert.match(backupService, /ReadWritePaths=\/var\/backups\/dore/u);
  assert.match(backupTimer, /OnCalendar=.*Asia\/Ho_Chi_Minh/u);
  assert.match(backupTimer, /Persistent=true/u);
});

test("restore requires explicit confirmation, rejects unsafe archives and rolls data back on failed health", async () => {
  const restore = await text("../ops/scripts/restore.sh");
  assert.match(restore, /--confirm-restore/u);
  assert.match(restore, /links and special files are not allowed/u);
  assert.match(restore, /unsafe archive path/u);
  assert.match(restore, /sha256sum --check --strict/u);
  assert.match(restore, /PRAGMA quick_check/u);
  assert.match(restore, /PRE_RESTORE_BACKUP/u);
  assert.match(restore, /systemctl stop dore\.service/u);
  assert.match(restore, /returning to the pre-restore state/u);
  assert.match(restore, /dore_wait_for_health/u);
});

test("offline manager password reset accepts only hidden TTY input and stores PBKDF2 hashes", async () => {
  const passwordTool = await text("../ops/scripts/set-manager-password.mjs");
  assert.match(passwordTool, /process\.stdin\.isTTY/u);
  assert.match(passwordTool, /setRawMode\(true\)/u);
  assert.match(passwordTool, /passwords are never accepted through arguments or pipes/u);
  assert.match(passwordTool, /const ITERATIONS = 210_000/u);
  assert.match(passwordTool, /pbkdf2Sync\(password, salt, ITERATIONS, 32, "sha256"\)/u);
  assert.match(passwordTool, /randomBytes\(16\)/u);
  assert.match(passwordTool, /atomicWrite\(envFile, newEnvironment\)/u);
  assert.match(passwordTool, /--username USERNAME/u);
  assert.match(passwordTool, /DEFAULT_USERNAME = "admin"/u);
  assert.match(passwordTool, /WHERE id = \? AND username = \? AND role = 'MANAGER'/u);
  assert.match(passwordTool, /DELETE FROM sessions WHERE user_id = \?/u);
  assert.doesNotMatch(passwordTool, /UPDATE users SET password_hash[^\n]+WHERE role = 'MANAGER'/u);
  assert.doesNotMatch(passwordTool, /DELETE FROM sessions WHERE user_id IN \(SELECT id FROM users WHERE role = 'MANAGER'\)/u);
  assert.match(passwordTool, /MANAGER_PASSWORD_RESET_OFFLINE/u);
  assert.doesNotMatch(passwordTool, /console\.log\(password/u);
  assert.doesNotMatch(passwordTool, /process\.argv.*password/u);
});

test("offline super-admin provisioning is explicit, hidden-input only and never promotes a normal account", async () => {
  const [tool, deploy, installHost] = await Promise.all([
    text("../ops/scripts/set-super-admin.mjs"),
    text("../ops/scripts/deploy.sh"),
    text("../ops/scripts/install-host.sh"),
  ]);
  assert.match(tool, /process\.stdin\.isTTY/u);
  assert.match(tool, /setRawMode\(true\)/u);
  assert.match(tool, /passwords are never accepted through arguments or pipes/u);
  assert.match(tool, /is_super_admin/u);
  assert.match(tool, /username already belongs to a normal account; choose another username/u);
  assert.match(tool, /DELETE FROM sessions WHERE user_id = \?/u);
  assert.match(tool, /SUPER_ADMIN_ACCOUNT_SET_OFFLINE/u);
  assert.match(tool, /process\.getuid\(\) === 0/u);
  assert.match(tool, /databaseStat\.uid !== process\.getuid\(\)/u);
  assert.doesNotMatch(tool, /chownSync|chmodSync/u);
  assert.match(installHost, /sudo -u dore \/usr\/local\/lib\/dore\/set-super-admin\.mjs/u);
  assert.doesNotMatch(tool, /console\.log\(password/u);
  assert.doesNotMatch(tool, /process\.argv.*password/u);
  assert.match(deploy, /set-super-admin\.mjs/u);
  assert.match(installHost, /set-super-admin\.mjs/u);
});

test("operational scripts never replay schema migrations or destructive reset migrations", async () => {
  const scriptsUrl = new URL("../ops/scripts/", import.meta.url);
  const names = await readdir(scriptsUrl);
  const sources = await Promise.all(names
    .filter((name) => name !== "reset-operational-data.sh")
    .filter((name) => name.endsWith(".sh") || name.endsWith(".mjs"))
    .map((name) => text(`../ops/scripts/${name}`)));
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /drizzle(?:-kit)?\s+(?:migrate|push)/iu);
  assert.doesNotMatch(combined, /wrangler\s+d1\s+migrations\s+apply/iu);
  assert.doesNotMatch(combined, /000[78]_reset_operational_data/iu);
  assert.doesNotMatch(combined, /DELETE\s+FROM\s+employees/iu);
  assert.doesNotMatch(combined, /DROP\s+TABLE/iu);
});

test("explicit operational reset is backup-first, confirmation-gated and preserves stores and managers", async () => {
  const [reset, deploy, installHost] = await Promise.all([
    text("../ops/scripts/reset-operational-data.sh"),
    text("../ops/scripts/deploy.sh"),
    text("../ops/scripts/install-host.sh"),
  ]);
  assert.match(reset, /--confirm-reset-all-data/u);
  assert.ok(reset.indexOf("backup.sh") < reset.indexOf("systemctl stop dore.service"));
  assert.match(reset, /BEGIN IMMEDIATE/u);
  assert.match(reset, /DELETE FROM employees/u);
  assert.match(reset, /DELETE FROM users WHERE role != 'MANAGER'/u);
  for (const table of [
    "employee_status_history",
    "admin_reset_archives",
    "cccd_deletion_outbox",
    "cccd_upload_registry",
  ]) {
    assert.match(reset, new RegExp(`DELETE FROM ${table}`, "u"));
    assert.match(reset, new RegExp(`SELECT COUNT\\(\\*\\) FROM ${table}`, "u"));
  }
  assert.match(reset, /UPDATE stores SET revenue = 0, expense = 0/u);
  assert.doesNotMatch(reset, /DELETE FROM stores/u);
  assert.doesNotMatch(reset, /UPDATE users\s+SET password_hash/iu);
  assert.match(reset, /restore.sh --confirm-restore "\$BACKUP_ARCHIVE"/u);
  assert.match(reset, /systemctl start dore\.service[\s\S]*dore_wait_for_health 45 1/u);
  assert.match(reset, /dore_wait_for_health/u);
  assert.match(deploy, /reset-operational-data\.sh/u);
  assert.match(installHost, /reset-operational-data\.sh/u);
});

test("Windows release packaging is allowlisted and rejects local data or browser profiles", async () => {
  const pack = await text("../ops/scripts/package-source.ps1");
  assert.match(pack, /\$entries\s*=\s*@\(/u);
  assert.match(pack, /tar\.exe -C \$project -czf \$pending @entries/u);
  assert.match(pack, /'\.openai\/hosting\.json'/u);
  assert.match(pack, /\.openai\/\(\?!hosting\\\.json\$\)/u);
  assert.match(pack, /\.vps-access/u);
  assert.match(pack, /\.qa-/u);
  assert.match(pack, /\.codex-dev/u);
  assert.match(pack, /\.env/u);
  assert.match(pack, /\.sqlite/u);
  assert.match(pack, /Cookies\|History\|Login Data/u);
  assert.match(pack, /Get-FileHash[^\n]+SHA256/u);
  assert.match(pack, /ops\/scripts\/deploy\.sh/u);
  assert.match(pack, /build\/sites-vite-plugin\.ts/u);
  assert.doesNotMatch(pack, /Get-ChildItem[^\n]+-Recurse/u);
});
