#!/usr/bin/env bash
#
# run-dashboard-fresh-repo-harness.sh
#
# Boots the dashboard server against a FRESH repo (no .loki state), runs the
# integrated cold-repo Playwright harness (tests/e2e/dashboard-fresh-repo.mjs),
# then tears the server down. Exit 0 only if the harness passes. v7.18.0.
#
# This is the meta-fix for the v7.17.x verification gap: the dashboard must be
# exercised the way a first-time user hits it (fresh repo, real browser, panels
# adjacent, iframe theme checked in light + dark), not with seeded data in
# isolation.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

PORT="${LOKI_DASH_HARNESS_PORT:-57376}"   # avoid clashing with a dev server on 57374
PY="${LOKI_DASH_PY:-python3.12}"
FRESH=""
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
  [ -n "$FRESH" ] && [ -d "$FRESH" ] && /bin/rm -rf "$FRESH" 2>/dev/null
}
trap cleanup EXIT

# 1. Fresh repo, guaranteed no .loki.
FRESH="$(mktemp -d "${TMPDIR:-/tmp}/loki-harness-XXXXXX")" || { echo "mktemp failed"; exit 2; }
( cd "$FRESH" && git init -q 2>/dev/null; printf '# fresh harness repo\n' > README.md )

# 2. Boot the server pointed at the fresh repo's .loki.
lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
LOKI_DIR="$FRESH/.loki" "$PY" -m uvicorn dashboard.server:app \
  --host 127.0.0.1 --port "$PORT" --log-level warning >/dev/null 2>&1 &
SERVER_PID=$!

# 3. Wait for readiness (max ~20s).
up=0
for _ in $(seq 1 20); do
  if curl -s "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ "$up" -ne 1 ]; then echo "dashboard server did not come up on :${PORT}"; exit 1; fi

# 4. Drive the browser.
LOKI_DASH_URL="http://127.0.0.1:${PORT}" node tests/e2e/dashboard-fresh-repo.mjs
rc=$?
exit $rc
