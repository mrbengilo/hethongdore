#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PROJECT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$PROJECT_DIR"
[ "$(id -u)" -ne 0 ] || { echo 'Run the preview as deploy, not root.' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Preview requires a clean checkout.' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==22 || minor<13) throw Error("Node 22.13+ (below 23) is required")'
command -v corepack >/dev/null

# All runtime paths are explicit. The production service, database, uploads,
# secrets, Caddy configuration and release symlink are never read or modified.
QA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dore-preview-XXXXXXXX")"
export DORE_DB_PLATFORM=sqlite
export DORE_DATABASE_PATH="$QA_ROOT/dore.sqlite"
export DORE_UPLOAD_DIR="$QA_ROOT/uploads"
export NEXT_TELEMETRY_DISABLED=1
export HOSTNAME=127.0.0.1
export PORT=13001

corepack pnpm install --frozen-lockfile
node --require ./tests/tsx-windows-userinfo.cjs --import tsx scripts/qa/seed-preview.mjs "$QA_ROOT"
DORE_MANAGER_PASSWORD_HASH="$(cat "$QA_ROOT/manager.hash")"
export DORE_MANAGER_PASSWORD_HASH
corepack pnpm run build:selfhost

printf '\nRelease đang kiểm thử: %s\n' "$(git rev-parse HEAD)"
cat "$QA_ROOT/credentials.txt"
printf '\nMở http://localhost:13001 qua SSH tunnel. Ctrl+C để dừng bản kiểm thử.\nDữ liệu thử: %s\n\n' "$QA_ROOT"
exec node .next/standalone/server.js
