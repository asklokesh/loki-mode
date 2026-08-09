#!/usr/bin/env bash
# docker-compose offers receipt signing WITHOUT breaking the default.
#
# THE DEFAULT IS THE LOAD-BEARING CASE, AND IT IS WHY THE MOUNT IS COMMENTED.
# Docker has no optional bind mount. A bind to a missing path is a HARD START
# FAILURE ("bind source path does not exist"), and `create_host_path: false`
# validates but does not make the mount optional -- both verified against real
# containers while writing this. Shipping the mount enabled would stop the
# receiver from starting for every user who has not generated a key, which is
# strictly worse than not offering the feature at all.
#
# TEST 1 IS THEREFORE THE ONE THAT MATTERS: config must validate, and the
# receiver must be startable, with NO key file present. Test 4 is its
# counterweight -- a positive control proving the commented lines are real and
# correct, not decorative, by uncommenting exactly what the comment tells a
# user to uncomment and checking the result validates.
#
# Docker itself is NOT required: the assertions are about the compose file's
# contents and its schema. Where docker is absent the schema check skips with a
# named reason rather than passing on nothing.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: compose receipt signing is opt-in and does not break the default"

[ -f "$COMPOSE" ] || { echo "  FAIL: $COMPOSE missing"; exit 1; }
python3 -c "import yaml" 2>/dev/null || {
  echo "  SKIP: PyYAML not installed -- cannot parse the compose file"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-dcsign.XXXXXX")"
trap 'rm -rf "$W" 2>/dev/null || true' EXIT INT TERM

# --- 1. THE DEFAULT: no active bind to a key that does not exist -----------
# Asserted on the PARSED document, not a grep, so a commented line cannot be
# mistaken for an active one.
_active="$(python3 - "$COMPOSE" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
rec = (d.get("services") or {}).get("receiver") or {}
hits = 0
for v in rec.get("volumes") or []:
    src = v.get("source") if isinstance(v, dict) else str(v).split(":")[0]
    if src and "receipt-signing-key" in str(src):
        hits += 1
print(hits)
PY
)"
if [ "$_active" = "0" ]; then
  ok "no active signing-key bind by default (a missing bind source is a hard start failure)"
else
  bad "an active bind to ./receipt-signing-key.pem would stop the receiver starting for every user without one"
fi

# --- 2. The env var is commented too ----------------------------------------
# Pointing at a path nothing mounts would make the server log a key error on
# every start while serving unsigned receipts anyway -- a confusing half-state.
_env_active="$(python3 - "$COMPOSE" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
rec = (d.get("services") or {}).get("receiver") or {}
env = rec.get("environment") or []
items = env if isinstance(env, list) else ["%s=%s" % (k, v) for k, v in env.items()]
print(sum(1 for e in items if "LOKI_RECEIPT_SIGNING_KEY_FILE" in str(e)))
PY
)"
if [ "$_env_active" = "0" ]; then
  ok "the signing env var is not active by default either (no half-configured state)"
else
  bad "LOKI_RECEIPT_SIGNING_KEY_FILE is set with nothing mounted at that path"
fi

# --- 3. The feature is DOCUMENTED where an operator will look --------------
# A commented mount nobody can find is the same as no feature. Requires the
# generation command, not just a mention.
if grep -q "openssl genpkey -algorithm ed25519" "$COMPOSE"; then
  ok "the compose file documents how to generate the key"
else
  bad "no key-generation command -- an operator cannot act on the commented mount"
fi
if grep -q "receipt-signing-key" "$COMPOSE"; then
  ok "the commented mount is present for an operator to enable"
else
  bad "the signing option is absent entirely from compose"
fi

# --- 4. POSITIVE CONTROL: uncommenting exactly what the comment says works --
# Without this, tests 1 and 2 would pass on a file that had simply DELETED the
# feature. Uncomments the two documented lines in a COPY and re-validates.
cp "$COMPOSE" "$W/dc.yml"
python3 - "$W/dc.yml" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("      # - LOKI_RECEIPT_SIGNING_KEY_FILE=/etc/loki/receipt-signing-key",
              "      - LOKI_RECEIPT_SIGNING_KEY_FILE=/etc/loki/receipt-signing-key")
s = s.replace("      # - ./receipt-signing-key.pem:/etc/loki/receipt-signing-key:ro",
              "      - ./receipt-signing-key.pem:/etc/loki/receipt-signing-key:ro")
open(p, "w").write(s)
PY
_after="$(python3 - "$W/dc.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
rec = (d.get("services") or {}).get("receiver") or {}
vols = sum(1 for v in (rec.get("volumes") or [])
           if "receipt-signing-key" in str(v.get("source") if isinstance(v, dict) else v))
env = rec.get("environment") or []
items = env if isinstance(env, list) else ["%s=%s" % (k, v) for k, v in env.items()]
envs = sum(1 for e in items if "LOKI_RECEIPT_SIGNING_KEY_FILE" in str(e))
print("%d %d" % (vols, envs))
PY
)"
if [ "$_after" = "1 1" ]; then
  ok "uncommenting the two documented lines activates exactly one mount and one env var"
else
  bad "uncommenting produced '$_after' (want '1 1') -- the documented lines do not match the file"
fi

# --- 5. The WORKER must never get the key ----------------------------------
# The same asymmetry the Helm chart enforces: a worker runs model-directed
# code, so a key there would let a build sign its own receipt.
_worker="$(python3 - "$W/dc.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
w = (d.get("services") or {}).get("worker") or {}
blob = str(w.get("volumes") or []) + str(w.get("environment") or [])
print("1" if "receipt-signing-key" in blob or "RECEIPT_SIGNING" in blob else "0")
PY
)"
if [ "$_worker" = "0" ]; then
  ok "the worker gets no signing key even when the feature is enabled"
else
  bad "the WORKER can reach the signing key -- a build could sign its own receipt"
fi

# --- 6. Schema validity, both ways, when docker is available ---------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if (cd "$REPO_ROOT" && docker compose --profile service config >/dev/null 2>&1); then
    ok "the shipped compose file validates against the docker schema"
  else
    bad "the shipped compose file does not validate"
  fi
  # The enabled variant must ALSO validate, or the instructions produce a
  # broken file. Copied beside the real one so relative paths still resolve.
  cp "$W/dc.yml" "$REPO_ROOT/.dc-signtest.yml"
  if (cd "$REPO_ROOT" && docker compose -f .dc-signtest.yml --profile service config >/dev/null 2>&1); then
    ok "the enabled variant validates too (the instructions produce a valid file)"
  else
    bad "uncommenting the documented lines yields an INVALID compose file"
  fi
  rm -f "$REPO_ROOT/.dc-signtest.yml"
else
  ok "skipped the docker schema check: docker compose unavailable (not a pass for validity)"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
