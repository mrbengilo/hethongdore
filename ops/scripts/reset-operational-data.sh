#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

dore_require_root

CONFIRMATION="${1:-}"
[ "$CONFIRMATION" = "--confirm-reset-all-data" ] || \
  dore_die "refusing destructive reset without --confirm-reset-all-data"

DATABASE=/var/lib/dore/dore.sqlite
UPLOAD_ROOT=/var/lib/dore/uploads
CCCD_ROOT=$UPLOAD_ROOT/cccd

command -v sqlite3 >/dev/null || dore_die "sqlite3 is required"
[ -x /usr/local/lib/dore/backup.sh ] || dore_die "backup tool is missing"
[ -x /usr/local/lib/dore/restore.sh ] || dore_die "restore tool is missing"
[ -f "$DATABASE" ] || dore_die "database does not exist: $DATABASE"
[ ! -L "$DATABASE" ] || dore_die "database must not be a symbolic link"

resolved_upload_root="$(readlink -f "$UPLOAD_ROOT")"
[ "$resolved_upload_root" = "$UPLOAD_ROOT" ] || dore_die "upload root is not the expected directory"
if [ -e "$CCCD_ROOT" ]; then
  [ -d "$CCCD_ROOT" ] && [ ! -L "$CCCD_ROOT" ] || dore_die "CCCD path must be a real directory"
  [ "$(readlink -f "$CCCD_ROOT")" = "$CCCD_ROOT" ] || dore_die "CCCD path escaped the upload root"
fi

BACKUP_ARCHIVE="$(/usr/local/lib/dore/backup.sh)"
[ -f "$BACKUP_ARCHIVE" ] || dore_die "pre-reset backup was not created"
printf 'Pre-reset backup: %s\n' "$BACKUP_ARCHIVE"

ROLLBACK_REQUIRED=0

restore_on_exit() {
  local exit_code=$?
  trap - EXIT
  if [ "$ROLLBACK_REQUIRED" -ne 1 ]; then
    exit "$exit_code"
  fi

  # A successful exit before the completion marker is still an incomplete reset.
  if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
  set +e
  printf '%s\n' "Reset failed; restoring the pre-reset backup." >&2
  if /usr/local/lib/dore/restore.sh --confirm-restore "$BACKUP_ARCHIVE"; then
    if systemctl start dore.service && dore_wait_for_health 45 1; then
      printf '%s\n' "Pre-reset backup restored and application health verified." >&2
    else
      printf '%s\n' "ERROR: backup was restored, but the application did not become healthy." >&2
    fi
  else
    printf '%s\n' "ERROR: automatic restore also failed; use the printed backup archive manually." >&2
  fi
  exit "$exit_code"
}
trap restore_on_exit EXIT

# From this point onward, every premature exit must restore the backup. An EXIT
# trap is intentional: unlike ERR, it also covers dore_die (which calls exit),
# failed postconditions and failed readiness checks in an `||` list.
ROLLBACK_REQUIRED=1
systemctl stop dore.service

sqlite3 "$DATABASE" <<'SQL'
.bail on
.timeout 10000
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DELETE FROM employee_payroll_closings;
DELETE FROM employee_status_history;
DELETE FROM admin_reset_archives;
DELETE FROM notifications;
DELETE FROM cccd_deletion_outbox;
DELETE FROM cccd_upload_registry;
DELETE FROM orders;
DELETE FROM order_code_sequence;
DELETE FROM shift_sessions;
DELETE FROM employee_transfers;
DELETE FROM business_records;
DELETE FROM audit_logs;
DELETE FROM sessions
WHERE NOT EXISTS (
  SELECT 1 FROM users AS manager_user
  WHERE manager_user.id = sessions.user_id
    AND manager_user.role = 'MANAGER'
);
DELETE FROM users WHERE role != 'MANAGER';
UPDATE users
SET employee_id = NULL,
    store_id = NULL,
    failed_attempts = 0,
    locked_until = NULL,
    shift_active = 0,
    current_shift = NULL,
    shift_started_at = NULL
WHERE role = 'MANAGER';
DELETE FROM employees;
UPDATE stores SET revenue = 0, expense = 0;
COMMIT;
PRAGMA optimize;
SQL

[ "$(sqlite3 "$DATABASE" 'PRAGMA quick_check;')" = "ok" ] || dore_die "SQLite quick_check failed after reset"
[ "$(sqlite3 "$DATABASE" "SELECT COUNT(*) FROM users WHERE role != 'MANAGER';")" = "0" ] || dore_die "employee accounts remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM employees;')" = "0" ] || dore_die "employees remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM employee_status_history;')" = "0" ] || dore_die "employee status history remains after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM admin_reset_archives;')" = "0" ] || dore_die "admin reset archives remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM cccd_deletion_outbox;')" = "0" ] || dore_die "CCCD deletion requests remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM cccd_upload_registry;')" = "0" ] || dore_die "CCCD upload registry rows remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM order_code_sequence;')" = "0" ] || dore_die "order code sequence remains after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM orders;')" = "0" ] || dore_die "orders remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM shift_sessions;')" = "0" ] || dore_die "shift sessions remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM employee_transfers;')" = "0" ] || dore_die "employee transfers remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM employee_payroll_closings;')" = "0" ] || dore_die "payroll closings remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM notifications;')" = "0" ] || dore_die "notifications remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM business_records;')" = "0" ] || dore_die "business records remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM audit_logs;')" = "0" ] || dore_die "audit logs remain after reset"
[ "$(sqlite3 "$DATABASE" 'SELECT COUNT(*) FROM stores WHERE revenue != 0 OR expense != 0;')" = "0" ] || dore_die "store counters are not zero"
[ "$(sqlite3 "$DATABASE" "SELECT COUNT(*) FROM users WHERE role = 'MANAGER';")" -ge 1 ] || dore_die "manager account was not preserved"

if [ -d "$CCCD_ROOT" ]; then
  find "$CCCD_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
else
  install -d -o dore -g dore -m 0750 "$CCCD_ROOT"
fi
chown -R dore:dore "$UPLOAD_ROOT"
chmod 0750 "$UPLOAD_ROOT" "$CCCD_ROOT"

systemctl start dore.service
dore_wait_for_health 45 1 || dore_die "application failed readiness after reset"

ROLLBACK_REQUIRED=0
trap - EXIT
printf '%s\n' "Operational data and employee accounts were reset successfully. Stores and manager access were preserved."
