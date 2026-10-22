#!/usr/bin/env bash

set -Eeuo pipefail

dore_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

dore_require_root() {
  [ "$(id -u)" -eq 0 ] || dore_die "run this command with sudo"
}

dore_validate_release_id() {
  case "${1:-}" in
    ""|*[!0-9a-f]*) dore_die "release id must be a 7-64 character lowercase hexadecimal SHA" ;;
  esac
  [ "${#1}" -ge 7 ] && [ "${#1}" -le 64 ] || dore_die "release id must be a 7-64 character lowercase hexadecimal SHA"
}

dore_atomic_symlink() {
  local target="$1"
  local link="$2"
  local temporary="${link}.next.$$"
  [ -d "$target" ] || dore_die "release directory does not exist: $target"
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$link"
}

dore_wait_for_health() {
  local attempts="${1:-30}"
  local delay="${2:-1}"
  local counter=1
  while [ "$counter" -le "$attempts" ]; do
    if curl --fail --silent --show-error --max-time 3 \
      http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
    counter=$((counter + 1))
  done
  return 1
}

dore_wait_for_public_health() {
  local attempts="${1:-90}"
  local delay="${2:-1}"
  local counter=1
  while [ "$counter" -le "$attempts" ]; do
    if curl --fail --silent --show-error --max-time 5 \
      https://doregroup.io.vn/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
    counter=$((counter + 1))
  done
  return 1
}

dore_safe_remove_tree() {
  local target="$1"
  local allowed_parent="$2"
  local allowed_prefix="$3"
  case "$target" in
    "$allowed_parent"/"$allowed_prefix"*) rm -rf -- "$target" ;;
    *) dore_die "refusing to remove an unexpected path: $target" ;;
  esac
}
