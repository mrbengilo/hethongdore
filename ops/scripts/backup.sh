#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

dore_require_root
command -v sqlite3 >/dev/null || dore_die "sqlite3 is required"
command -v sha256sum >/dev/null || dore_die "sha256sum is required"
command -v tar >/dev/null || dore_die "tar is required"

DATABASE=/var/lib/dore/dore.sqlite
UPLOADS=/var/lib/dore/uploads
BACKUP_ROOT=/var/backups/dore

[ -f "$DATABASE" ] || dore_die "database does not exist: $DATABASE"
[ ! -L "$DATABASE" ] || dore_die "database must not be a symbolic link"

# SQLite and the private uploads form one logical snapshot.  Briefly quiesce
# the application so a concurrent CCCD replacement/purge cannot leave the
# database copy referring to a file that was copied from a different moment.
SERVICE_WAS_ACTIVE=0
SERVICE_STOPPED=0
if systemctl is-active --quiet dore.service; then
  SERVICE_WAS_ACTIVE=1
fi

resume_dore_service() {
  if [ "$SERVICE_WAS_ACTIVE" -eq 1 ] && [ "$SERVICE_STOPPED" -eq 1 ]; then
    systemctl start dore.service || return 1
    SERVICE_STOPPED=0
  fi
}

install -d -o root -g root -m 0700 "$BACKUP_ROOT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="$(mktemp -d "$BACKUP_ROOT/.partial-$STAMP-XXXXXX")"
TEMP_ARCHIVE="$(mktemp "$BACKUP_ROOT/.partial-archive-$STAMP-XXXXXX.tar.gz")"
ARCHIVE="$BACKUP_ROOT/dore-backup-$STAMP-${TEMP_ARCHIVE##*-}"

cleanup() {
  if [ -n "${STAGING:-}" ] && [ -d "$STAGING" ]; then
    dore_safe_remove_tree "$STAGING" "$BACKUP_ROOT" ".partial-"
  fi
  if [ -n "${TEMP_ARCHIVE:-}" ] && [ -f "$TEMP_ARCHIVE" ]; then
    rm -f -- "$TEMP_ARCHIVE"
  fi
  if ! resume_dore_service; then
    printf '%s\n' "ERROR: backup cleanup could not restart dore.service" >&2
  fi
}
trap cleanup EXIT

if [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
  systemctl stop dore.service || dore_die "could not stop dore.service for a consistent backup"
  SERVICE_STOPPED=1
fi

sqlite3 "$DATABASE" <<SQL
.timeout 10000
.backup '$STAGING/dore.sqlite'
SQL

[ "$(sqlite3 "$STAGING/dore.sqlite" 'PRAGMA quick_check;')" = "ok" ] || \
  dore_die "SQLite quick_check failed; backup was not published"

install -d -m 0700 "$STAGING/uploads"
if [ -d "$UPLOADS" ]; then
  cp -a "$UPLOADS/." "$STAGING/uploads/"
fi

# The coherent database/uploads copy is complete. Restore availability before
# checksumming and compressing the private staging directory.
resume_dore_service || dore_die "backup was captured, but dore.service could not be restarted"

release="$(readlink -f /opt/dore/current 2>/dev/null || true)"
{
  printf 'format=dore-backup-v1\n'
  printf 'created_utc=%s\n' "$STAMP"
  printf 'hostname=%s\n' "$(hostname)"
  printf 'release=%s\n' "${release:-none}"
  printf 'application_quiesced=%s\n' "$SERVICE_WAS_ACTIVE"
} >"$STAGING/metadata.txt"

(
  cd "$STAGING"
  sha256sum dore.sqlite metadata.txt >manifest.sha256
  while IFS= read -r -d '' upload; do
    sha256sum "$upload" >>manifest.sha256
  done < <(find uploads -type f -print0 | sort -z)
)

tar -C "$STAGING" -czf "$TEMP_ARCHIVE" dore.sqlite uploads metadata.txt manifest.sha256
chmod 0600 "$TEMP_ARCHIVE"
mv -- "$TEMP_ARCHIVE" "$ARCHIVE"
TEMP_ARCHIVE=""
dore_safe_remove_tree "$STAGING" "$BACKUP_ROOT" ".partial-"
STAGING=""
trap - EXIT

printf '%s\n' "$ARCHIVE"
