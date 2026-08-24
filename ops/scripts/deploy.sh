#!/usr/bin/env bash

set -Eeuo pipefail

# Deployment callers commonly use a restrictive umask for SSH keys and
# temporary archives. Builds and release directories must not inherit 0700,
# otherwise the systemd `dore` account cannot traverse the promoted release.
umask 022

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

PROJECT_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
RELEASE_ID=""

usage() {
  printf 'Usage: %s [--project PATH] [--release HEX_SHA]\n' "$0" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      PROJECT_DIR="$2"
      shift 2
      ;;
    --release)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      RELEASE_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[ "$(id -u)" -ne 0 ] || dore_die "run deploy.sh as the deploy account, not as root"
sudo -n true 2>/dev/null || dore_die "deploy requires non-interactive sudo access"
command -v corepack >/dev/null || dore_die "corepack is required"
command -v git >/dev/null || dore_die "git is required"

PROJECT_DIR="$(CDPATH='' cd -- "$PROJECT_DIR" && pwd)"
[ -f "$PROJECT_DIR/package.json" ] || dore_die "package.json was not found in $PROJECT_DIR"
[ -f "$PROJECT_DIR/build/sites-vite-plugin.ts" ] || \
  dore_die "required build/sites-vite-plugin.ts was not found in the source package"

if [ -z "$RELEASE_ID" ]; then
  RELEASE_ID="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
  [ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ] || \
    dore_die "the source tree is dirty; commit it or pass an explicit content SHA with --release"
fi
dore_validate_release_id "$RELEASE_ID"

printf 'Building release %s...\n' "$RELEASE_ID"
(
  cd "$PROJECT_DIR"
  corepack pnpm install --frozen-lockfile
  corepack pnpm run build:selfhost
)

STANDALONE="$PROJECT_DIR/.next/standalone"
[ -f "$STANDALONE/server.js" ] || dore_die "standalone server.js was not produced"
[ -d "$PROJECT_DIR/.next/static" ] || dore_die "Next.js static output was not produced"
[ -d "$PROJECT_DIR/public" ] || dore_die "public assets were not found"

RELEASES=/opt/dore/releases
RELEASE_DIR="$RELEASES/$RELEASE_ID"
STAGING="$RELEASES/.staging-$RELEASE_ID-$$"
CURRENT=/opt/dore/current

sudo install -d -o root -g dore -m 0750 "$RELEASES"
sudo test ! -e "$RELEASE_DIR" || dore_die "release already exists and is immutable: $RELEASE_DIR"
sudo test ! -e "$STAGING" || dore_die "staging path already exists: $STAGING"

cleanup_staging() {
  if sudo test -d "$STAGING"; then
    sudo bash -c '. /usr/local/lib/dore/lib.sh; dore_safe_remove_tree "$1" "$2" ".staging-"' _ "$STAGING" "$RELEASES"
  fi
}
trap cleanup_staging EXIT

sudo install -d -o root -g dore -m 0750 "$STAGING"
sudo cp -a "$STANDALONE/." "$STAGING/"
sudo install -d -o root -g dore -m 0750 "$STAGING/.next/static" "$STAGING/public" "$STAGING/ops"
sudo cp -a "$PROJECT_DIR/.next/static/." "$STAGING/.next/static/"
sudo cp -a "$PROJECT_DIR/public/." "$STAGING/public/"
sudo cp -a "$PROJECT_DIR/ops/." "$STAGING/ops/"
printf '%s\n' "$RELEASE_ID" | sudo tee "$STAGING/RELEASE" >/dev/null
sudo chown -R root:dore "$STAGING"
sudo chmod -R u=rwX,g=rX,o= "$STAGING"
sudo -u dore test -x "$STAGING" || dore_die "the application account cannot traverse the staged release"
sudo -u dore test -r "$STAGING/server.js" || dore_die "the application account cannot read staged server.js"
sudo mv -- "$STAGING" "$RELEASE_DIR"
trap - EXIT

sudo test -r /etc/dore/dore.env || dore_die "/etc/dore/dore.env is missing; run install-host.sh first"
sudo grep -Eq '^DORE_MANAGER_PASSWORD_HASH=pbkdf2\$[1-9][0-9]*\$' /etc/dore/dore.env || \
  dore_die "manager password hash is not configured; run set-manager-password.mjs"

PREVIOUS="$(sudo readlink -f "$CURRENT" 2>/dev/null || true)"
CADDY_ROOT=/etc/caddy
CADDY_LIVE="$CADDY_ROOT/Caddyfile"
CADDY_STAGE="$CADDY_ROOT/.next-$RELEASE_ID-$$-Caddyfile"
CADDY_RESTORE_STAGE="$CADDY_ROOT/.restore-$RELEASE_ID-$$-Caddyfile"
CADDY_BACKUP="$CADDY_ROOT/.previous-$RELEASE_ID-Caddyfile"
CADDY_ABSENT="$CADDY_ROOT/.absent-$RELEASE_ID-Caddyfile"
CADDY_PUBLISH_STARTED=0
CADDY_WAS_ACTIVE=0
PRESERVE_CADDY_BACKUP=0
TOOL_ROOT=/usr/local/lib/dore
TOOL_NAMES=(
  lib.sh
  backup.sh
  restore.sh
  rollback.sh
  set-manager-password.mjs
  set-super-admin.mjs
  reset-operational-data.sh
)
TOOLS_PUBLISH_STARTED=0
PRESERVE_TOOL_BACKUPS=0
POST_PROMOTION_ERROR=""

if sudo systemctl is-active --quiet caddy.service; then
  CADDY_WAS_ACTIVE=1
fi

cleanup_caddy_artifacts() {
  sudo rm -f -- "$CADDY_STAGE" "$CADDY_RESTORE_STAGE" || true
  if [ "$PRESERVE_CADDY_BACKUP" -eq 0 ]; then
    sudo rm -f -- "$CADDY_BACKUP" "$CADDY_ABSENT" || true
  fi
}

prepare_caddy_config() {
  local source_path="$RELEASE_DIR/ops/caddy/Caddyfile"
  if ! sudo test -f "$source_path"; then
    POST_PROMOTION_ERROR="required Caddyfile is missing from the release"
    return 1
  fi
  if ! sudo install -o root -g root -m 0644 "$source_path" "$CADDY_STAGE"; then
    POST_PROMOTION_ERROR="could not stage the new Caddyfile"
    return 1
  fi
  if sudo test -f "$CADDY_LIVE"; then
    if ! sudo install -o root -g root -m 0644 "$CADDY_LIVE" "$CADDY_BACKUP"; then
      POST_PROMOTION_ERROR="could not back up the live Caddyfile"
      return 1
    fi
  elif ! sudo touch "$CADDY_ABSENT"; then
    POST_PROMOTION_ERROR="could not record an absent live Caddyfile"
    return 1
  fi
  if ! sudo caddy validate --config "$CADDY_STAGE" --adapter caddyfile; then
    POST_PROMOTION_ERROR="staged Caddyfile validation failed"
    return 1
  fi
}

publish_caddy_config() {
  CADDY_PUBLISH_STARTED=1
  # CADDY_STAGE and CADDY_LIVE are on the same filesystem, so rename replaces
  # the live file atomically before Caddy is reloaded.
  if ! sudo mv -Tf -- "$CADDY_STAGE" "$CADDY_LIVE"; then
    POST_PROMOTION_ERROR="could not publish the staged Caddyfile"
    return 1
  fi
}

restore_caddy_config() {
  local failed=0
  [ "$CADDY_PUBLISH_STARTED" -eq 1 ] || return 0
  if sudo test -f "$CADDY_BACKUP"; then
    sudo install -o root -g root -m 0644 "$CADDY_BACKUP" "$CADDY_RESTORE_STAGE" || failed=1
    if [ "$failed" -eq 0 ]; then
      sudo mv -Tf -- "$CADDY_RESTORE_STAGE" "$CADDY_LIVE" || failed=1
    fi
  elif sudo test -f "$CADDY_ABSENT"; then
    sudo rm -f -- "$CADDY_LIVE" || failed=1
  else
    failed=1
  fi
  if [ "$failed" -eq 0 ] && sudo test -f "$CADDY_LIVE"; then
    sudo caddy validate --config "$CADDY_LIVE" --adapter caddyfile || failed=1
  fi
  if [ "$failed" -eq 0 ]; then
    if [ "$CADDY_WAS_ACTIVE" -eq 1 ]; then
      if sudo systemctl is-active --quiet caddy.service; then
        sudo systemctl reload caddy.service || failed=1
      else
        sudo systemctl start caddy.service || failed=1
      fi
    elif sudo systemctl is-active --quiet caddy.service; then
      sudo systemctl stop caddy.service || failed=1
    fi
  fi
  return "$failed"
}

tool_stage_path() {
  printf '%s/.next-%s-%s\n' "$TOOL_ROOT" "$RELEASE_ID" "$1"
}

tool_backup_path() {
  printf '%s/.previous-%s-%s\n' "$TOOL_ROOT" "$RELEASE_ID" "$1"
}

tool_absent_path() {
  printf '%s/.absent-%s-%s\n' "$TOOL_ROOT" "$RELEASE_ID" "$1"
}

cleanup_tool_artifacts() {
  local name
  for name in "${TOOL_NAMES[@]}"; do
    sudo rm -f -- "$(tool_stage_path "$name")" || true
    if [ "$PRESERVE_TOOL_BACKUPS" -eq 0 ]; then
      sudo rm -f -- "$(tool_backup_path "$name")" "$(tool_absent_path "$name")" || true
    fi
  done
}

prepare_toolset() {
  local name source_path live_path stage_path backup_path absent_path
  for name in "${TOOL_NAMES[@]}"; do
    source_path="$RELEASE_DIR/ops/scripts/$name"
    live_path="$TOOL_ROOT/$name"
    stage_path="$(tool_stage_path "$name")"
    backup_path="$(tool_backup_path "$name")"
    absent_path="$(tool_absent_path "$name")"
    if ! sudo test -f "$source_path"; then
      POST_PROMOTION_ERROR="required rescue tool is missing: $name"
      return 1
    fi
    if ! sudo install -o root -g root -m 0755 "$source_path" "$stage_path"; then
      POST_PROMOTION_ERROR="could not stage rescue tool: $name"
      return 1
    fi
    if sudo test -f "$live_path"; then
      if ! sudo install -o root -g root -m 0755 "$live_path" "$backup_path"; then
        POST_PROMOTION_ERROR="could not back up rescue tool: $name"
        return 1
      fi
    elif ! sudo touch "$absent_path"; then
      POST_PROMOTION_ERROR="could not record absent rescue tool: $name"
      return 1
    fi
  done
}

publish_toolset() {
  local name
  TOOLS_PUBLISH_STARTED=1
  for name in "${TOOL_NAMES[@]}"; do
    if ! sudo install -o root -g root -m 0755 "$(tool_stage_path "$name")" "$TOOL_ROOT/$name"; then
      POST_PROMOTION_ERROR="could not publish rescue tool: $name"
      return 1
    fi
  done
}

restore_toolset() {
  local name failed=0
  [ "$TOOLS_PUBLISH_STARTED" -eq 1 ] || return 0
  for name in "${TOOL_NAMES[@]}"; do
    if sudo test -f "$(tool_backup_path "$name")"; then
      sudo install -o root -g root -m 0755 "$(tool_backup_path "$name")" "$TOOL_ROOT/$name" || failed=1
    elif sudo test -f "$(tool_absent_path "$name")"; then
      sudo rm -f -- "$TOOL_ROOT/$name" || failed=1
    else
      failed=1
    fi
  done
  return "$failed"
}

switch_current() {
  sudo bash -c '
    set -eu
    dore_atomic_symlink() {
      target="$1"
      link="$2"
      temporary="${link}.next.$$"
      rm -f -- "$temporary"
      ln -s -- "$target" "$temporary"
      mv -Tf -- "$temporary" "$link"
    }
    dore_atomic_symlink "$1" "$2"
  ' _ "$1" "$CURRENT"
}

promote_release() {
  if ! sudo systemctl restart dore.service; then
    POST_PROMOTION_ERROR="application service restart failed"
    return 1
  fi
  if ! sudo bash -c '. /usr/local/lib/dore/lib.sh; dore_wait_for_health 45 1'; then
    POST_PROMOTION_ERROR="internal application health check failed"
    return 1
  fi
  if ! publish_caddy_config; then
    return 1
  fi
  if sudo systemctl is-active --quiet caddy.service; then
    if ! sudo systemctl reload caddy.service; then
      POST_PROMOTION_ERROR="Caddy reload failed"
      return 1
    fi
  elif ! sudo systemctl start caddy.service; then
    POST_PROMOTION_ERROR="Caddy start failed"
    return 1
  fi
  if ! sudo bash -c '. /usr/local/lib/dore/lib.sh; dore_wait_for_public_health 90 1'; then
    POST_PROMOTION_ERROR="the app is healthy internally, but the public HTTPS health check failed"
    return 1
  fi
  # The complete toolset was staged and backed up before the switch, but is
  # published only after both health gates pass. A partial publication is
  # restored from the per-file backups by the failure path below.
  publish_toolset
}

if ! prepare_caddy_config; then
  cleanup_caddy_artifacts
  dore_die "$POST_PROMOTION_ERROR"
fi

if ! prepare_toolset; then
  cleanup_tool_artifacts
  cleanup_caddy_artifacts
  dore_die "$POST_PROMOTION_ERROR"
fi

cleanup_deploy_artifacts() {
  cleanup_tool_artifacts
  cleanup_caddy_artifacts
}

trap cleanup_deploy_artifacts EXIT

# A release may add compatible tables/columns during its first readiness
# request. Capture one coherent database/uploads snapshot after every release
# and proxy preflight, immediately before the active symlink can change.
# Source archives created on Windows do not preserve POSIX executable bits.
# Invoke the release copy through bash so a readable 0640 backup script still
# protects the deployment before the active symlink can change.
if ! PRE_DEPLOY_BACKUP="$(sudo bash "$RELEASE_DIR/ops/scripts/backup.sh")"; then
  dore_die "pre-deploy backup failed; the active release was not changed"
fi
case "$PRE_DEPLOY_BACKUP" in
  /var/backups/dore/dore-backup-*.tar.gz) ;;
  *) dore_die "backup tool returned an unexpected archive path; the active release was not changed" ;;
esac
sudo test -f "$PRE_DEPLOY_BACKUP" || dore_die "pre-deploy backup archive was not created"
printf 'Pre-deploy backup: %s\n' "$PRE_DEPLOY_BACKUP"

switch_current "$RELEASE_DIR"
if promote_release; then
  cleanup_deploy_artifacts
  trap - EXIT
  printf 'Release %s is healthy.\n' "$RELEASE_ID"
  exit 0
fi

printf 'Release promotion failed (%s); restoring the previous release and toolset.\n' "$POST_PROMOTION_ERROR" >&2
if ! restore_caddy_config; then
  PRESERVE_CADDY_BACKUP=1
  printf '%s\n' "ERROR: the previous Caddyfile could not be restored and reloaded automatically." >&2
  printf 'Caddy backup was preserved as %s for manual recovery.\n' "$CADDY_BACKUP" >&2
fi
if ! restore_toolset; then
  PRESERVE_TOOL_BACKUPS=1
  printf '%s\n' "ERROR: one or more rescue tools could not be restored automatically." >&2
  printf 'Tool backups were preserved as %s/.previous-%s-* for manual recovery.\n' "$TOOL_ROOT" "$RELEASE_ID" >&2
fi
cleanup_deploy_artifacts
if [ -n "$PREVIOUS" ] && sudo test -f "$PREVIOUS/server.js"; then
  switch_current "$PREVIOUS"
  sudo systemctl restart dore.service && \
    sudo bash -c '. /usr/local/lib/dore/lib.sh; dore_wait_for_health 30 1' || \
    dore_die "both the new and previous release failed health checks"
else
  sudo systemctl stop dore.service
  if [ "$(sudo readlink -f "$CURRENT" 2>/dev/null || true)" = "$RELEASE_DIR" ]; then
    sudo rm -f -- "$CURRENT"
  fi
fi
dore_die "release failed and was rolled back"
