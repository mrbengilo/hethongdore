#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

dore_require_root

if [ "$#" -ne 2 ] || [ "$1" != "--release" ]; then
  printf 'Usage: sudo %s --release HEX_SHA\n' "$0" >&2
  exit 2
fi

RELEASE_ID="$2"
dore_validate_release_id "$RELEASE_ID"

CURRENT=/opt/dore/current
TARGET="/opt/dore/releases/$RELEASE_ID"
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
CADDY_ROOT=/etc/caddy
CADDY_LIVE="$CADDY_ROOT/Caddyfile"
CADDY_TARGET="$TARGET/ops/caddy/Caddyfile"
CADDY_STAGE="$CADDY_ROOT/.rollback-next-$RELEASE_ID-$$-Caddyfile"
CADDY_RESTORE_STAGE="$CADDY_ROOT/.rollback-restore-$RELEASE_ID-$$-Caddyfile"
CADDY_BACKUP="$CADDY_ROOT/.rollback-previous-$RELEASE_ID-$$-Caddyfile"
CADDY_ABSENT="$CADDY_ROOT/.rollback-absent-$RELEASE_ID-$$-Caddyfile"
CADDY_PUBLISHED=0
CADDY_WAS_ACTIVE=0
PRESERVE_CADDY_BACKUP=0

[ -f "$TARGET/server.js" ] || dore_die "release is incomplete: $TARGET"
[ -f "$CADDY_TARGET" ] || dore_die "release Caddyfile is missing: $CADDY_TARGET"
[ "$PREVIOUS" != "$TARGET" ] || dore_die "release $RELEASE_ID is already active"
command -v caddy >/dev/null || dore_die "caddy is required"

if systemctl is-active --quiet caddy.service; then
  CADDY_WAS_ACTIVE=1
fi

cleanup_caddy_artifacts() {
  rm -f -- "$CADDY_STAGE" "$CADDY_RESTORE_STAGE" || true
  if [ "$PRESERVE_CADDY_BACKUP" -eq 0 ]; then
    rm -f -- "$CADDY_BACKUP" "$CADDY_ABSENT" || true
  fi
}
trap cleanup_caddy_artifacts EXIT

prepare_target_caddy() {
  install -o root -g root -m 0644 "$CADDY_TARGET" "$CADDY_STAGE" || return 1
  if [ -f "$CADDY_LIVE" ]; then
    install -o root -g root -m 0644 "$CADDY_LIVE" "$CADDY_BACKUP" || return 1
  else
    : > "$CADDY_ABSENT" || return 1
    chmod 0600 "$CADDY_ABSENT" || return 1
  fi
  caddy validate --config "$CADDY_STAGE" --adapter caddyfile || return 1
}

publish_target_caddy() {
  mv -Tf -- "$CADDY_STAGE" "$CADDY_LIVE" || return 1
  CADDY_PUBLISHED=1
  caddy validate --config "$CADDY_LIVE" --adapter caddyfile || return 1
  if systemctl is-active --quiet caddy.service; then
    systemctl reload caddy.service || return 1
  else
    systemctl start caddy.service || return 1
  fi
}

restore_original_caddy() {
  local failed=0
  [ "$CADDY_PUBLISHED" -eq 1 ] || return 0

  if [ -f "$CADDY_BACKUP" ]; then
    install -o root -g root -m 0644 "$CADDY_BACKUP" "$CADDY_RESTORE_STAGE" || failed=1
    if [ "$failed" -eq 0 ]; then
      caddy validate --config "$CADDY_RESTORE_STAGE" --adapter caddyfile || failed=1
    fi
    if [ "$failed" -eq 0 ]; then
      mv -Tf -- "$CADDY_RESTORE_STAGE" "$CADDY_LIVE" || failed=1
    fi
  elif [ -f "$CADDY_ABSENT" ]; then
    rm -f -- "$CADDY_LIVE" || failed=1
  else
    failed=1
  fi

  if [ "$failed" -eq 0 ]; then
    if [ "$CADDY_WAS_ACTIVE" -eq 1 ]; then
      if systemctl is-active --quiet caddy.service; then
        systemctl reload caddy.service || failed=1
      else
        systemctl start caddy.service || failed=1
      fi
    elif systemctl is-active --quiet caddy.service; then
      systemctl stop caddy.service || failed=1
    fi
  fi
  return "$failed"
}

prepare_target_caddy || dore_die "target release Caddyfile failed validation; no release was changed"

dore_atomic_symlink "$TARGET" "$CURRENT"
TARGET_ERROR=""
if ! systemctl restart dore.service; then
  TARGET_ERROR="application service restart failed"
elif ! dore_wait_for_health 45 1; then
  TARGET_ERROR="internal application health check failed"
elif ! publish_target_caddy; then
  TARGET_ERROR="target Caddyfile could not be published or reloaded"
elif ! dore_wait_for_public_health 90 1; then
  TARGET_ERROR="public HTTPS health check failed"
fi

if [ -z "$TARGET_ERROR" ]; then
  cleanup_caddy_artifacts
  trap - EXIT
  printf 'Rolled back to release %s; internal and public health checks passed.\n' "$RELEASE_ID"
  exit 0
fi

printf 'Rollback target failed (%s); restoring the original release and Caddyfile.\n' "$TARGET_ERROR" >&2
ORIGINAL_APP_HEALTHY=0
if [ -n "$PREVIOUS" ] && [ -f "$PREVIOUS/server.js" ]; then
  if dore_atomic_symlink "$PREVIOUS" "$CURRENT" \
    && systemctl restart dore.service \
    && dore_wait_for_health 30 1; then
    ORIGINAL_APP_HEALTHY=1
  fi
else
  systemctl stop dore.service || true
  if [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" = "$TARGET" ]; then
    rm -f -- "$CURRENT"
  fi
fi

if ! restore_original_caddy; then
  PRESERVE_CADDY_BACKUP=1
  printf 'ERROR: the original Caddyfile could not be restored; recovery files remain at %s and %s.\n' \
    "$CADDY_BACKUP" "$CADDY_ABSENT" >&2
  dore_die "rollback target was unhealthy and proxy configuration recovery needs manual attention"
fi

if [ "$ORIGINAL_APP_HEALTHY" -eq 1 ]; then
  if [ "$CADDY_WAS_ACTIVE" -eq 1 ]; then
    dore_wait_for_public_health 60 1 || dore_die "the original release is healthy internally but failed public HTTPS health"
  fi
  dore_die "rollback was cancelled because the target was unhealthy; the original release and Caddyfile were restored"
fi

dore_die "rollback target was unhealthy and the original release also failed its health check"
