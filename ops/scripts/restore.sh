#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

dore_require_root

if [ "$#" -ne 2 ] || [ "$1" != "--confirm-restore" ]; then
  printf 'Usage: sudo %s --confirm-restore /absolute/path/dore-backup-*.tar.gz\n' "$0" >&2
  exit 2
fi

command -v python3 >/dev/null || dore_die "python3 is required for safe archive extraction"
command -v sqlite3 >/dev/null || dore_die "sqlite3 is required"

ARCHIVE="$(realpath -e -- "$2")"
[ -f "$ARCHIVE" ] || dore_die "backup archive does not exist"
[ ! -L "$ARCHIVE" ] || dore_die "backup archive must not be a symbolic link"

STATE=/var/lib/dore
DATABASE="$STATE/dore.sqlite"
UPLOADS="$STATE/uploads"
STAGING="$(mktemp -d "$STATE/.restore-stage-XXXXXX")"
ROLLBACK="$STATE/.restore-rollback-$$"
WAS_ACTIVE=0
SWAPPED=0
systemctl is-active --quiet dore.service && WAS_ACTIVE=1

cleanup() {
  local status="$?"
  trap - EXIT
  set +e
  if [ "$SWAPPED" -eq 1 ] && [ -d "$ROLLBACK" ]; then
    systemctl stop dore.service
    install -d -o root -g root -m 0700 "$STAGING/uncommitted"
    if [ -f "$DATABASE" ]; then mv -- "$DATABASE" "$STAGING/uncommitted/dore.sqlite"; fi
    if [ -f "$DATABASE-wal" ]; then mv -- "$DATABASE-wal" "$STAGING/uncommitted/dore.sqlite-wal"; fi
    if [ -f "$DATABASE-shm" ]; then mv -- "$DATABASE-shm" "$STAGING/uncommitted/dore.sqlite-shm"; fi
    if [ -d "$UPLOADS" ]; then mv -- "$UPLOADS" "$STAGING/uncommitted/uploads"; fi
    if [ -f "$ROLLBACK/dore.sqlite" ]; then mv -- "$ROLLBACK/dore.sqlite" "$DATABASE"; fi
    if [ -f "$ROLLBACK/dore.sqlite-wal" ]; then mv -- "$ROLLBACK/dore.sqlite-wal" "$DATABASE-wal"; fi
    if [ -f "$ROLLBACK/dore.sqlite-shm" ]; then mv -- "$ROLLBACK/dore.sqlite-shm" "$DATABASE-shm"; fi
    if [ -d "$ROLLBACK/uploads" ]; then mv -- "$ROLLBACK/uploads" "$UPLOADS"; fi
    chown -R dore:dore "$DATABASE" "$UPLOADS" 2>/dev/null || true
    [ "$WAS_ACTIVE" -eq 0 ] || systemctl start dore.service
    dore_safe_remove_tree "$ROLLBACK" "$STATE" ".restore-rollback-"
  fi
  if [ -n "${STAGING:-}" ] && [ -d "$STAGING" ]; then
    dore_safe_remove_tree "$STAGING" "$STATE" ".restore-stage-"
  fi
  exit "$status"
}
trap cleanup EXIT

python3 - "$ARCHIVE" "$STAGING" <<'PY'
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
allowed_roots = {"dore.sqlite", "metadata.txt", "manifest.sha256", "uploads"}

with tarfile.open(archive, "r:gz") as bundle:
    seen = set()
    for member in bundle.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or "\\" in member.name:
            raise SystemExit(f"unsafe archive path: {member.name!r}")
        if not path.parts or path.parts[0] not in allowed_roots:
            raise SystemExit(f"unexpected archive path: {member.name!r}")
        if member.name in seen:
            raise SystemExit(f"duplicate archive path: {member.name!r}")
        seen.add(member.name)
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"links and special files are not allowed: {member.name!r}")
    bundle.extractall(destination, filter="data")
PY

[ -f "$STAGING/dore.sqlite" ] || dore_die "archive does not contain dore.sqlite"
[ -f "$STAGING/manifest.sha256" ] || dore_die "archive does not contain manifest.sha256"
(
  cd "$STAGING"
  sha256sum --check --strict manifest.sha256 >/dev/null
)
[ "$(sqlite3 "$STAGING/dore.sqlite" 'PRAGMA quick_check;')" = "ok" ] || \
  dore_die "restored database failed SQLite quick_check"

systemctl stop dore.service
if ! PRE_RESTORE_BACKUP="$(/usr/local/lib/dore/backup.sh)"; then
  [ "$WAS_ACTIVE" -eq 0 ] || systemctl start dore.service
  dore_die "pre-restore backup failed; existing data was not changed"
fi
printf 'Pre-restore backup: %s\n' "$PRE_RESTORE_BACKUP"

install -d -o root -g root -m 0700 "$ROLLBACK"
SWAPPED=1
if [ -f "$DATABASE" ]; then mv -- "$DATABASE" "$ROLLBACK/dore.sqlite"; fi
if [ -f "$DATABASE-wal" ]; then mv -- "$DATABASE-wal" "$ROLLBACK/dore.sqlite-wal"; fi
if [ -f "$DATABASE-shm" ]; then mv -- "$DATABASE-shm" "$ROLLBACK/dore.sqlite-shm"; fi
if [ -d "$UPLOADS" ]; then mv -- "$UPLOADS" "$ROLLBACK/uploads"; fi

install -o dore -g dore -m 0640 "$STAGING/dore.sqlite" "$DATABASE"
install -d -o dore -g dore -m 0750 "$UPLOADS"
if [ -d "$STAGING/uploads" ]; then
  cp -a "$STAGING/uploads/." "$UPLOADS/"
fi
chown -R dore:dore "$UPLOADS"
chmod -R go-w "$UPLOADS"

if systemctl start dore.service && dore_wait_for_health 45 1; then
  if [ "$WAS_ACTIVE" -eq 0 ]; then systemctl stop dore.service; fi
  dore_safe_remove_tree "$ROLLBACK" "$STATE" ".restore-rollback-"
  SWAPPED=0
  dore_safe_remove_tree "$STAGING" "$STATE" ".restore-stage-"
  STAGING=""
  trap - EXIT
  printf '%s\n' "Restore completed and passed the application health check."
  exit 0
fi

printf '%s\n' "Restored data failed the health check; returning to the pre-restore state." >&2
systemctl stop dore.service
install -d -o root -g root -m 0700 "$STAGING/failed"
if [ -f "$DATABASE" ]; then mv -- "$DATABASE" "$STAGING/failed/dore.sqlite"; fi
if [ -f "$DATABASE-wal" ]; then mv -- "$DATABASE-wal" "$STAGING/failed/dore.sqlite-wal"; fi
if [ -f "$DATABASE-shm" ]; then mv -- "$DATABASE-shm" "$STAGING/failed/dore.sqlite-shm"; fi
if [ -d "$UPLOADS" ]; then mv -- "$UPLOADS" "$STAGING/failed/uploads"; fi
if [ -f "$ROLLBACK/dore.sqlite" ]; then mv -- "$ROLLBACK/dore.sqlite" "$DATABASE"; fi
if [ -f "$ROLLBACK/dore.sqlite-wal" ]; then mv -- "$ROLLBACK/dore.sqlite-wal" "$DATABASE-wal"; fi
if [ -f "$ROLLBACK/dore.sqlite-shm" ]; then mv -- "$ROLLBACK/dore.sqlite-shm" "$DATABASE-shm"; fi
if [ -d "$ROLLBACK/uploads" ]; then mv -- "$ROLLBACK/uploads" "$UPLOADS"; fi
chown -R dore:dore "$DATABASE" "$UPLOADS" 2>/dev/null || true
dore_safe_remove_tree "$ROLLBACK" "$STATE" ".restore-rollback-"
SWAPPED=0

if [ "$WAS_ACTIVE" -eq 1 ]; then
  systemctl start dore.service && dore_wait_for_health 30 1 || \
    dore_die "pre-restore state was returned, but the application is unhealthy"
fi
dore_die "restore failed; the pre-restore state has been returned"
