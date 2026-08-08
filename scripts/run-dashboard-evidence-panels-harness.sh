#!/usr/bin/env bash
#
# run-dashboard-evidence-panels-harness.sh
#
# Boots the dashboard against a SEEDED .loki (receipts + learnings + no spend
# cap), runs tests/e2e/dashboard-evidence-panels.mjs, tears the server down.
#
# This is the inverse fixture of run-dashboard-fresh-repo-harness.sh. That one
# proves a COLD repo degrades cleanly; this one proves a POPULATED repo renders
# its evidence, and renders it honestly. Neither substitutes for the other: the
# cold harness would pass against panels that never render anything at all.
#
# The seed is deliberately hand-written rather than copied from the live repo,
# so the assertions are pinned to KNOWN values:
#   - one receipt with cost_usd null  -> must render "-", never "$0.00"
#   - that receipt is NOT VERIFIED    -> must survive to the pixel unsoftened
#   - budget_limit absent             -> must say "no spend cap", never imply one
# A fixture that drifted with the repo could silently stop exercising any of
# those three, which is how the unit tests underneath this passed while the
# real page rendered nothing.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

PORT="${LOKI_DASH_PANELS_PORT:-57377}"   # distinct from the dev server and the fresh-repo harness
PY="${LOKI_DASH_PY:-python3.12}"
SEED=""
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
  [ -n "$SEED" ] && [ -d "$SEED" ] && /bin/rm -rf "$SEED" 2>/dev/null
}
trap cleanup EXIT

command -v node >/dev/null 2>&1 || { echo "SKIPPED: node not installed (not a pass)"; exit 0; }
[ -d "$REPO_ROOT/dashboard-ui/node_modules/playwright" ] || {
  echo "SKIPPED: playwright not installed in dashboard-ui (not a pass)"; exit 0; }

# 1. Seeded project.
SEED="$(mktemp -d "${TMPDIR:-/tmp}/loki-panels-XXXXXX")" || { echo "mktemp failed"; exit 2; }
( cd "$SEED" && git init -q 2>/dev/null; printf '# panels harness\n' > README.md )
mkdir -p "$SEED/.loki/proofs/harness-run-0001" "$SEED/.loki/state" || exit 2

# A receipt with an UNMEASURED cost and an unverified verdict. Both values are
# the ones the honesty assertions key on.
# The nested shape is the REAL one /api/proofs reads (cost.usd,
# files_changed.count, council.final_verdict, honesty.headline). A flat seed
# produced an empty list on the first run, which the harness's own vacuity
# guard caught before any assertion could pass on nothing.
cat > "$SEED/.loki/proofs/harness-run-0001/proof.json" <<'JSON'
{
  "run_id": "harness-run-0001",
  "generated_at": "2026-01-01T00:00:00Z",
  "loki_version": "harness",
  "cost": { "usd": null, "available": false },
  "files_changed": { "count": 3, "insertions": 10, "deletions": 2, "files": [] },
  "council": { "final_verdict": "NOT VERIFIED" },
  "honesty": { "headline": "NOT VERIFIED" }
}
JSON
printf '<html><body>harness receipt</body></html>\n' \
  > "$SEED/.loki/proofs/harness-run-0001/index.html"

cat > "$SEED/.loki/state/relevant-learnings.json" <<'JSON'
{
  "version": 1,
  "learnings": [
    {
      "id": "harness0001",
      "timestamp": "2026-01-01T00:00:00Z",
      "iteration": 1,
      "trigger": "gate_failure",
      "rootCause": "harness seed: a gate failed for a stable reason",
      "fix": "harness seed: the fix recorded for that failure"
    }
  ]
}
JSON

# No budget file at all -> budget_limit null -> the UI must SAY there is no cap.

# 2. Boot against the seed.
lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
LOKI_DIR="$SEED/.loki" "$PY" -m uvicorn dashboard.server:app \
  --host 127.0.0.1 --port "$PORT" --log-level warning >/dev/null 2>&1 &
SERVER_PID=$!

up=0
for _ in $(seq 1 20); do
  if curl -s "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ "$up" -ne 1 ]; then echo "dashboard server did not come up on :${PORT}"; exit 1; fi

# 3. Drive the browser.
LOKI_DASH_URL="http://127.0.0.1:${PORT}" node tests/e2e/dashboard-evidence-panels.mjs
exit $?
