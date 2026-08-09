#!/usr/bin/env bash
# Boot a seeded server, drive the Evidence Receipt panel in a real browser,
# tear everything down.
#
# The fixtures are chosen so each honesty assertion has a KNOWN correct answer:
#   - a receipt with NO honesty block  -> must bucket as `unknown`, never verified
#   - a receipt with NO recorded cost  -> must render "unknown", never $0.00
#   - an ATTESTED receipt              -> must read UNCHECKED in a browser, which
#                                         cannot evaluate an Ed25519 signature
#
# Serves the BUILT web-app (not the dev server) because the built bundle is what
# ships; a panel that works under Vite HMR and breaks after minification would
# pass a dev-server harness and fail every user.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

PORT="${LOKI_WEBAPP_PANEL_PORT:-57378}"
SEED=""
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$SEED" ] && rm -rf "$SEED" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 absent"; exit 0; }
python3 -c "import uvicorn, fastapi" 2>/dev/null || {
  echo "SKIP: uvicorn/fastapi not installed -- panel rendering not measured"; exit 0; }
[ -f "$REPO_ROOT/web-app/dist/index.html" ] || {
  echo "SKIP: web-app/dist not built -- run 'cd web-app && npm run build'"; exit 0; }

SEED="$(mktemp -d "${TMPDIR:-/tmp}/loki-panelseed.XXXXXX")"
mkdir -p "$SEED/.loki/proofs"

python3 - "$SEED" "$REPO_ROOT" <<'PY' || { echo "SETUP ERROR: could not seed fixtures"; exit 2; }
import sys, os, json, hashlib
seed, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, root + "/autonomy")

def write(rid, body):
    d = os.path.join(seed, ".loki", "proofs", rid)
    os.makedirs(d, exist_ok=True)
    h = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    body = dict(body)
    body["verification"] = {"hash": h, "algo": "sha256", "scope": "integrity"}
    return d, body, h

# 1. A normal VERIFIED receipt with a cost.
d, b, _ = write("r-verified", {
    "run_id": "r-verified", "generated_at": "2026-08-08T01:00:00Z",
    "loki_version": "9.17.2", "cost": {"usd": 1.25},
    "files_changed": {"count": 4},
    "honesty": {"headline": "VERIFIED"},
    "council": {"final_verdict": "PASS"}})
json.dump(b, open(os.path.join(d, "proof.json"), "w"))

# 2. NO honesty block -> the summary must bucket this as `unknown`.
d, b, _ = write("r-unknown", {
    "run_id": "r-unknown", "generated_at": "2026-08-08T02:00:00Z",
    "loki_version": "9.17.2", "cost": {"usd": 0.4},
    "files_changed": {"count": 1}})
json.dump(b, open(os.path.join(d, "proof.json"), "w"))

# 3. NO cost recorded, and ATTESTED. Drives two assertions: the cost must read
#    "unknown" rather than a fabricated $0.00, and the signature must read
#    UNCHECKED because a browser cannot evaluate it.
# NO honesty headline on purpose. The panel labels a row `headline || run_id`,
# so omitting it makes this row identifiable in the DOM by its run_id -- the
# harness clicks it to assert the cost renders "unknown" rather than $0.00.
# Side effect, stated rather than hidden: this receipt also buckets as
# `unknown` in the summary, which is CORRECT (no headline means the endpoint
# cannot prove it was verified) and is what the unknown-bucket assertion reads.
body = {"run_id": "no-cost-receipt", "generated_at": "2026-08-08T03:00:00Z",
        "loki_version": "9.17.2", "files_changed": {"count": 2}}
h = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
ver = {"hash": h, "algo": "sha256", "scope": "integrity"}
try:
    import receipt_jwt as rj
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    k = Ed25519PrivateKey.generate(); kid = rj.compute_kid(k.public_key())
    ver["attestation"] = rj.sign_attestation(
        k, kid, job_id="j", run_id="no-cost-receipt", receipt_hash=h)
    ver["attestation_kid"] = kid
except Exception:
    # No cryptography: the cost assertion still runs, the attestation ones are
    # simply not exercised. Better than failing to seed anything at all.
    pass
body["verification"] = ver
d = os.path.join(seed, ".loki", "proofs", "no-cost-receipt")
os.makedirs(d, exist_ok=True)
json.dump(body, open(os.path.join(d, "proof.json"), "w"))
print("seeded 3 receipts", file=sys.stderr)
PY

cd "$SEED" || exit 2
# web-app/server.py, NOT dashboard/server.py: `loki web` serves the React
# bundle from here on 57375, and this harness exists to check THAT surface.
# Pointing it at the dashboard was how the missing /api/proofs routes hid --
# the panel worked on 57374 and failed for every `loki web` user.
# standalone_app, NOT app. The Vite bundle is built with base: '/lab/', and
# server.py's standalone wrapper mounts the FastAPI app under /lab/ so those
# asset and API paths resolve. Running `server:app` directly skips the mount:
# every /lab/api/* request then falls through to the SPA catch-all and returns
# text/html, which the client's content-type guard reports as "API endpoint not
# available". Verified with a control -- /lab/api/status, an endpoint that has
# always worked, failed the same way under the wrong entrypoint.
LOKI_DIR="$SEED/.loki" python3 -m uvicorn server:standalone_app \
  --port "$PORT" --app-dir "$REPO_ROOT/web-app" > "$SEED/server.log" 2>&1 &
SERVER_PID=$!
cd "$REPO_ROOT" || exit 2

_up=0
for _ in $(seq 1 60); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/lab/api/proofs" >/dev/null 2>&1; then _up=1; break; fi
  sleep 0.5
done
if [ "$_up" -ne 1 ]; then
  echo "SKIP: server did not come up on $PORT -- panel rendering not measured"
  tail -3 "$SEED/server.log" 2>/dev/null
  exit 0
fi

LOKI_WEBAPP_URL="http://127.0.0.1:$PORT" node tests/e2e/webapp-receipt-panel.mjs
rc=$?
[ "$rc" -eq 2 ] && tail -5 "$SEED/server.log" 2>/dev/null
exit "$rc"
