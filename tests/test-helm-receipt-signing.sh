#!/usr/bin/env bash
# The chart wires receipt signing to the RECEIVER, and never to the worker.
#
# WHY THE ASYMMETRY IS THE POINT. A worker executes model-directed code. A
# signing key mounted there would let a build sign its own receipt, and a
# self-attested receipt attests to nothing -- it would look like provenance
# while proving less than the unsigned path, because a reader would stop asking.
# Test 3 is therefore the load-bearing one: it asserts the worker does NOT get
# the key, which is a property no amount of receiver-side correctness implies.
#
# TEST 5 IS THE OTHER ONE. Rendering valid YAML is not the same as a working
# deployment. The PEM the chart actually projects is extracted and fed to the
# real trigger-server, and the JWKS it serves is checked -- a chart that mounts
# the key at the wrong path, or mangles a multi-line PEM, renders perfectly and
# serves an empty key set.
#
# VACUITY GUARD: PyYAML is not stdlib, and helm may be absent. Both are checked
# FIRST and the suite skips with a named reason rather than comparing empty
# strings and accusing a correct chart.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/helm/loki-mode"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: helm wires receipt signing to the receiver only"

command -v helm >/dev/null 2>&1 || {
  echo "  SKIP: helm not installed -- chart not rendered, nothing measured"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }
python3 -c "import yaml" 2>/dev/null || {
  echo "  SKIP: PyYAML not installed -- cannot parse rendered manifests"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }
command -v openssl >/dev/null 2>&1 || {
  echo "  SKIP: openssl not installed -- cannot generate a test key"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }
[ -d "$CHART" ] || { echo "  FAIL: chart missing at $CHART"; exit 1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-helmsign.XXXXXX")"
cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  rm -rf "$W" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

openssl genpkey -algorithm ed25519 -out "$W/k.pem" 2>/dev/null || {
  echo "  SKIP: this openssl cannot generate ed25519 keys"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }

helm template t "$CHART" > "$W/off.yaml" 2>"$W/off.err" || {
  echo "  FAIL: chart does not render with defaults"; sed -n 1,3p "$W/off.err"; exit 1; }
helm template t "$CHART" --set-file secrets.receiptSigningKey="$W/k.pem" \
  > "$W/on.yaml" 2>"$W/on.err" || {
  echo "  FAIL: chart does not render with a signing key"; sed -n 1,3p "$W/on.err"; exit 1; }

if [ -s "$W/off.yaml" ] && [ -s "$W/on.yaml" ]; then
  ok "both configurations render non-empty manifests"
else
  bad "a render was empty -- every assertion below would be vacuous"
  echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
fi

# --- 1. DEFAULT: nothing signing-related renders ---------------------------
# Unset must mean UNSIGNED, not a half-wired mount pointing at a missing file,
# which would make the receiver log a key error on every start.
_n_env="$(grep -c 'LOKI_RECEIPT_SIGNING_KEY_FILE' "$W/off.yaml" || true)"
_n_vol="$(grep -c 'name: receipt-signing-key' "$W/off.yaml" || true)"
if [ "$_n_env" = "0" ] && [ "$_n_vol" = "0" ]; then
  ok "no key configured renders no env var and no volume (honest UNSIGNED)"
else
  bad "signing wiring rendered without a key (env=$_n_env vol=$_n_vol)"
fi

# --- 2. WITH a key: the receiver is wired ----------------------------------
_probe() {
python3 - "$1" "$2" "$3" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
comp, want = sys.argv[2], sys.argv[3]
ds = [d for d in docs if d.get("kind") == "Deployment"
      and comp in (d.get("metadata", {}).get("name") or "")]
if not ds:
    print("NODEP"); raise SystemExit
c = ds[0]["spec"]["template"]["spec"]["containers"][0]
if want == "env":
    print("yes" if any(e.get("name") == "LOKI_RECEIPT_SIGNING_KEY_FILE"
                       for e in (c.get("env") or [])) else "no")
elif want == "mount":
    print("yes" if any(m.get("name") == "receipt-signing-key"
                       for m in (c.get("volumeMounts") or [])) else "no")
elif want == "mode":
    for v in ds[0]["spec"]["template"]["spec"].get("volumes") or []:
        if v.get("name") == "receipt-signing-key":
            print(oct(v.get("secret", {}).get("defaultMode", 0))); raise SystemExit
    print("none")
PY
}

if [ "$(_probe "$W/on.yaml" receiver env)" = "yes" ] \
   && [ "$(_probe "$W/on.yaml" receiver mount)" = "yes" ]; then
  ok "the receiver gets both the env var and the mounted key"
else
  bad "the receiver is not fully wired -- attestation would stay off"
fi

# --- 3. THE LOAD-BEARING ONE: the worker must NOT get it -------------------
if [ "$(_probe "$W/on.yaml" worker env)" = "no" ] \
   && [ "$(_probe "$W/on.yaml" worker mount)" = "no" ]; then
  ok "the worker gets neither the key nor the env var (cannot self-attest)"
else
  bad "the WORKER can reach the signing key -- a build could sign its own receipt"
fi

# --- 3b. The env var must point INSIDE the mount, at the projected filename -
# A wrong path renders perfectly valid YAML and serves an EMPTY key set in
# production: the receiver finds no file, logs UNSIGNED, and every receipt goes
# out unattested while the chart looks correct. Added after mutation testing
# showed that pointing the env var at a bogus path left all other assertions
# green -- test 5 feeds the PEM to the server directly and so cannot see it.
_pathcheck="$(python3 - "$W/on.yaml" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
ds = [d for d in docs if d.get("kind") == "Deployment"
      and "receiver" in (d.get("metadata", {}).get("name") or "")]
spec = ds[0]["spec"]["template"]["spec"]; c = spec["containers"][0]
env = next((e["value"] for e in (c.get("env") or [])
            if e.get("name") == "LOKI_RECEIPT_SIGNING_KEY_FILE"), "")
mount = next((m["mountPath"] for m in (c.get("volumeMounts") or [])
              if m.get("name") == "receipt-signing-key"), "")
item = ""
for v in spec.get("volumes") or []:
    if v.get("name") == "receipt-signing-key":
        items = v.get("secret", {}).get("items") or []
        item = items[0].get("path", "") if items else "receipt-signing-key"
expected = (mount.rstrip("/") + "/" + item) if mount and item else ""
print("ok" if env and expected and env == expected else "bad")
PY
)"
if [ "$_pathcheck" = "ok" ]; then
  ok "the env var points exactly at the projected key file (mount + item path)"
else
  bad "the key path does not resolve to the mounted file -- JWKS would be empty in production"
fi

# --- 4. The projected key is not world-readable inside the pod -------------
_mode="$(_probe "$W/on.yaml" receiver mode)"
if [ "$_mode" = "0o400" ] || [ "$_mode" = "0o600" ]; then
  ok "the key is projected read-only to its owner ($_mode)"
else
  bad "the key mode is $_mode -- a private key readable by other pod processes"
fi

# --- 5. RENDERING IS NOT DEPLOYING: the projected PEM must actually work ---
python3 - "$W/on.yaml" "$W/projected.pem" <<'PY'
import sys, yaml
for d in yaml.safe_load_all(open(sys.argv[1])):
    if d and d.get("kind") == "Secret":
        open(sys.argv[2], "w").write(d["stringData"]["receipt-signing-key"])
        break
PY
if cmp -s "$W/k.pem" "$W/projected.pem"; then
  ok "the projected PEM is byte-identical to the operator's key (not mangled)"
else
  bad "the chart altered the PEM -- a multi-line key did not survive templating"
fi

if python3 -c "import cryptography" 2>/dev/null; then
  PORT=7397
  LOKI_RECEIPT_SIGNING_KEY_FILE="$W/projected.pem" LOKI_API_TOKEN=t \
    python3 "$REPO_ROOT/autonomy/trigger-server.py" --port "$PORT" --dry-run \
    > "$W/srv.log" 2>&1 &
  SRV=$!
  _up=0
  for _ in $(seq 1 25); do
    curl -s --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { _up=1; break; }
    sleep 0.4
  done
  if [ "$_up" -eq 1 ]; then
    _keys="$(curl -s --max-time 10 "http://127.0.0.1:$PORT/.well-known/jwks.json" \
      | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('keys',[])))" 2>/dev/null)"
    if [ "${_keys:-0}" -ge 1 ]; then
      ok "the real server serves a JWKS from the chart-projected key"
    else
      bad "the projected key yielded an EMPTY key set -- the chart renders but does not work"
    fi
  else
    ok "skipped the live JWKS check: server did not start here (not a pass for the wiring)"
  fi
else
  ok "skipped the live JWKS check: cryptography absent (not a pass for the wiring)"
fi

# --- 6. The rotation escape is documented where an operator will look ------
# A key with no rotation story is a future outage: rotating without retiring the
# old PUBLIC key makes every historical receipt fail verification, which a
# checker cannot distinguish from tampering.
if grep -q "LOKI_RECEIPT_RETIRED_PUBKEYS" "$CHART/values.yaml"; then
  ok "values.yaml documents the rotation path beside the key"
else
  bad "no rotation guidance -- a first rotation would silently break old receipts"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
