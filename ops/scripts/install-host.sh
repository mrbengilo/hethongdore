#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

dore_require_root

getent passwd deploy >/dev/null || dore_die "the deploy operating-system account does not exist"
[ -x /usr/local/bin/node ] || dore_die "Node.js 22 must be installed at /usr/local/bin/node"
command -v caddy >/dev/null || dore_die "Caddy must be installed first"
command -v sqlite3 >/dev/null || dore_die "sqlite3 must be installed first"
command -v curl >/dev/null || dore_die "curl must be installed first"

node_version="$(/usr/local/bin/node -p 'process.versions.node')"
/usr/local/bin/node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 13) process.exit(1);
' || dore_die "Node.js >=22.13.0 and <23 is required; found v$node_version"

OPS_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"

getent group dore >/dev/null || groupadd --system dore
if ! getent passwd dore >/dev/null; then
  useradd --system --gid dore --home-dir /var/lib/dore --shell /usr/sbin/nologin --no-create-home dore
fi
[ "$(id -gn dore)" = "dore" ] || dore_die "existing dore account must use the dore primary group"

install -d -o root -g dore -m 0750 /opt/dore /opt/dore/releases
install -d -o dore -g dore -m 0750 /var/lib/dore /var/lib/dore/uploads
install -d -o root -g root -m 0700 /var/backups/dore /etc/dore
install -d -o root -g root -m 0755 /usr/local/lib/dore
install -d -o caddy -g caddy -m 0750 /var/log/caddy
if [ ! -e /var/log/caddy/dore-access.log ]; then
  install -o caddy -g caddy -m 0640 /dev/null /var/log/caddy/dore-access.log
else
  chown caddy:caddy /var/log/caddy/dore-access.log
  chmod 0640 /var/log/caddy/dore-access.log
fi

install -o root -g root -m 0755 "$SCRIPT_DIR/lib.sh" /usr/local/lib/dore/lib.sh
install -o root -g root -m 0755 "$SCRIPT_DIR/backup.sh" /usr/local/lib/dore/backup.sh
install -o root -g root -m 0755 "$SCRIPT_DIR/restore.sh" /usr/local/lib/dore/restore.sh
install -o root -g root -m 0755 "$SCRIPT_DIR/rollback.sh" /usr/local/lib/dore/rollback.sh
install -o root -g root -m 0755 "$SCRIPT_DIR/set-manager-password.mjs" /usr/local/lib/dore/set-manager-password.mjs
install -o root -g root -m 0755 "$SCRIPT_DIR/set-super-admin.mjs" /usr/local/lib/dore/set-super-admin.mjs
install -o root -g root -m 0755 "$SCRIPT_DIR/reset-operational-data.sh" /usr/local/lib/dore/reset-operational-data.sh

if [ ! -e /etc/dore/dore.env ]; then
  install -o root -g root -m 0600 "$OPS_DIR/env/dore.env.example" /etc/dore/dore.env
else
  chown root:root /etc/dore/dore.env
  chmod 0600 /etc/dore/dore.env
fi

install -o root -g root -m 0644 "$OPS_DIR/systemd/dore.service" /etc/systemd/system/dore.service
install -o root -g root -m 0644 "$OPS_DIR/systemd/dore-backup.service" /etc/systemd/system/dore-backup.service
install -o root -g root -m 0644 "$OPS_DIR/systemd/dore-backup.timer" /etc/systemd/system/dore-backup.timer
install -o root -g root -m 0644 "$OPS_DIR/caddy/Caddyfile" /etc/caddy/Caddyfile

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/dore.service /etc/systemd/system/dore-backup.service /etc/systemd/system/dore-backup.timer
systemctl unmask caddy.service
systemctl enable dore.service dore-backup.timer caddy.service
systemctl start dore-backup.timer

printf '%s\n' "Host files installed. Set the manager password before the first deployment:"
printf '%s\n' "  sudo /usr/local/lib/dore/set-manager-password.mjs"
printf '%s\n' "After the application is deployed, create a separate super-admin account with:"
printf '%s\n' "  sudo -u dore /usr/local/lib/dore/set-super-admin.mjs --username YOUR_USERNAME"
