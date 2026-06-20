#!/usr/bin/env bash
# tests/test-secure-scan.sh -- regression guard for the secure-by-default gate
# (Loop 4). Locks the three runtime surfaces of the gate:
#
#   1. ENGINE PRECISION (autonomy/lib/secure-scan.py): the whole value of the
#      scanner is precision. For EACH of the 5 rules a BAD fixture must FIRE the
#      rule and the SAFE equivalent must NOT. The false-positive guards are
#      asserted explicitly (placeholder key, DEBUG in a dev/test file, bare
#      ACAO * without credentials, a server-only secret outside a web root, an
#      auth-gated firebase rule). A gate that cries wolf is worse than none.
#
#   3. WIRING (run_secure_scan in autonomy/run.sh): advisory by DEFAULT (never
#      blocks), LOKI_SECURE_GATE=block blocks on an un-waived HIGH, and a waiver
#      in .loki/quality/security-waivers.json suppresses the block. (Receipt
#      honesty -- step 2 -- is covered in tests/test_proof_generator.py, which
#      drives the proof-generator directly.)
#
#   4. WAIVER CLI (cmd_secure in autonomy/loki): `loki secure waive` writes the
#      {waivers:[{rule,file,reason}]} shape, `unwaive` removes it, `list` shows
#      findings.
#
# All fixtures are throwaway temp dirs; nothing here mutates the repo.
#
# STRATEGY
#   Engine: invoke the CLI as a subprocess (its filename has a hyphen so it is
#   not importable) and inspect the JSON, mirroring how run.sh calls it.
#   Wiring: extract run_secure_scan() from run.sh and eval it (no run.sh
#   top-level execution), mirroring tests/test-semantic-gate-bash-route.sh.
#   Waiver CLI: invoke `autonomy/loki secure ...` against a temp LOKI_DIR.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"
LOKI_BIN="${LOKI_BIN_OVERRIDE:-$REPO_ROOT/autonomy/loki}"
SCANNER="$REPO_ROOT/autonomy/lib/secure-scan.py"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not available. (Not a fail.)"; exit 0
fi
if [ ! -f "$SCANNER" ]; then
    echo "SKIP: $SCANNER not found. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-secscan-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# scan <dir> -> writes $WORK/last.json, returns scanner exit code.
scan() {
    python3 "$SCANNER" "$1" --json > "$WORK/last.json" 2>/dev/null
}

# fires <rule> -> exit 0 if the last scan produced >=1 finding for <rule>.
fires() {
    LOKI_RULE="$1" python3 - "$WORK/last.json" <<'PY'
import json, os, sys
rule = os.environ["LOKI_RULE"]
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(2)
sys.exit(0 if any(f.get("rule") == rule for f in d.get("findings", [])) else 1)
PY
}

# total_findings -> prints the finding count of the last scan.
total_findings() {
    python3 - "$WORK/last.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get("summary", {}).get("total", -1))
except Exception:
    print(-1)
PY
}

# assert_fires <rule> <dir-label> -- last scan must contain <rule>.
assert_fires() {
    if fires "$1"; then ok "$2: $1 fires on bad fixture"
    else bad "$2: $1 did NOT fire on bad fixture" "findings=$(cat "$WORK/last.json")"; fi
}

# assert_silent <rule> <dir-label> -- last scan must NOT contain <rule>.
assert_silent() {
    if fires "$1"; then bad "$2: $1 FALSE-POSITIVE on safe fixture" "findings=$(cat "$WORK/last.json")"
    else ok "$2: $1 stays silent on safe fixture"; fi
}

# ===========================================================================
# 1. ENGINE PRECISION -- bad/safe matrix for all 5 rules + FP guards.
# ===========================================================================

# --- rule 1: private-key-committed -----------------------------------------
BAD="$WORK/r1-bad"; mkdir -p "$BAD"
cat > "$BAD/server.js" <<'EOF'
// loads the signing key
const KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAx0example
-----END RSA PRIVATE KEY-----`;
EOF
scan "$BAD"; assert_fires "private-key-committed" "r1"

SAFE="$WORK/r1-safe"; mkdir -p "$SAFE"
cat > "$SAFE/server.js" <<'EOF'
// loads the signing key from the environment (no key material in source)
const KEY = process.env.SIGNING_KEY;
const note = "set SIGNING_KEY to your PEM private key at runtime";
EOF
scan "$SAFE"; assert_silent "private-key-committed" "r1"

# --- rule 2: secret-in-client-file -----------------------------------------
# A real-shaped secret literal in a browser-served file fires; the SAME literal
# in a server-only file (not under a web root) does NOT (that is rule 1/other
# surfaces' concern, not the leak-to-browser surface rule 2 detects).
BAD="$WORK/r2-bad"; mkdir -p "$BAD/public"
cat > "$BAD/public/app.js" <<'EOF'
const apiKey = "AKIAIOSFODNN7EXAMPLG";
fetch("/data", { headers: { "x-api-key": apiKey } });
EOF
scan "$BAD"; assert_fires "secret-in-client-file" "r2"

# FP guard A: a placeholder key in a browser file must NOT fire.
SAFE="$WORK/r2-safe-placeholder"; mkdir -p "$SAFE/public"
cat > "$SAFE/public/app.js" <<'EOF'
const apiKey = "AKIAXXXXXXXXXXXXXXXX"; // replace with your key
EOF
scan "$SAFE"; assert_silent "secret-in-client-file" "r2-placeholder"

# FP guard B: a real-shaped secret in a SERVER-ONLY file (no web-root path
# component) must NOT trip rule 2.
SAFE="$WORK/r2-safe-server"; mkdir -p "$SAFE/api"
cat > "$SAFE/api/handler.js" <<'EOF'
const apiKey = "AKIAIOSFODNN7EXAMPLG";
module.exports = { apiKey };
EOF
scan "$SAFE"; assert_silent "secret-in-client-file" "r2-server-only"

# --- rule 3: world-open-datastore ------------------------------------------
# Firebase ".write": true is unconditional public access -> fires.
BAD="$WORK/r3-bad"; mkdir -p "$BAD"
cat > "$BAD/database.rules.json" <<'EOF'
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
EOF
scan "$BAD"; assert_fires "world-open-datastore" "r3"

# FP guard: an auth-gated firebase rule (value is an expression, not literal
# true) must NOT fire.
SAFE="$WORK/r3-safe"; mkdir -p "$SAFE"
cat > "$SAFE/database.rules.json" <<'EOF'
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null && auth.uid === $uid"
  }
}
EOF
scan "$SAFE"; assert_silent "world-open-datastore" "r3-auth-gated"

# --- rule 4: debug-in-prod -------------------------------------------------
# DEBUG = True in a production settings file fires.
BAD="$WORK/r4-bad"; mkdir -p "$BAD"
cat > "$BAD/settings.py" <<'EOF'
DEBUG = True
ALLOWED_HOSTS = ["*"]
EOF
scan "$BAD"; assert_fires "debug-in-prod" "r4"

# FP guard: DEBUG = True in a dev/test settings file must NOT fire.
SAFE="$WORK/r4-safe"; mkdir -p "$SAFE"
cat > "$SAFE/settings_dev.py" <<'EOF'
DEBUG = True
ALLOWED_HOSTS = ["localhost"]
EOF
scan "$SAFE"; assert_silent "debug-in-prod" "r4-dev-file"

# --- rule 5: cors-wildcard-credentials -------------------------------------
# ACAO * AND ACAC true in the same file -> fires.
BAD="$WORK/r5-bad"; mkdir -p "$BAD"
cat > "$BAD/cors.js" <<'EOF'
app.use(cors({
  origin: "*",
  credentials: true,
}));
EOF
scan "$BAD"; assert_fires "cors-wildcard-credentials" "r5"

# FP guard: a bare ACAO * WITHOUT credentials is a common public-API setting and
# must NOT fire.
SAFE="$WORK/r5-safe"; mkdir -p "$SAFE"
cat > "$SAFE/cors.js" <<'EOF'
app.use(cors({
  origin: "*",
}));
EOF
scan "$SAFE"; assert_silent "cors-wildcard-credentials" "r5-bare-wildcard"

# --- whole-tree sanity: a clean project produces ZERO findings + exit 0 -----
CLEAN="$WORK/clean-tree"; mkdir -p "$CLEAN/src"
cat > "$CLEAN/src/index.js" <<'EOF'
export function add(a, b) { return a + b; }
const key = process.env.API_KEY;
EOF
rc_clean=0; scan "$CLEAN" || rc_clean=$?
n="$(total_findings)"
[ "$n" = "0" ] && ok "clean tree -> 0 findings" || bad "clean tree had findings" "n=$n"
[ "$rc_clean" -eq 0 ] && ok "clean tree -> exit 0" || bad "clean tree non-zero exit" "rc=$rc_clean"

# --- exit-code contract: a finding -> exit 1; bad input -> exit 2 -----------
rc_find=0; scan "$WORK/r1-bad" || rc_find=$?
[ "$rc_find" -eq 1 ] && ok "findings present -> exit 1" || bad "findings exit code wrong" "rc=$rc_find"
rc_bad=0; python3 "$SCANNER" "$WORK/does-not-exist" --json >/dev/null 2>&1 || rc_bad=$?
[ "$rc_bad" -eq 2 ] && ok "missing dir -> exit 2" || bad "bad-input exit code wrong" "rc=$rc_bad"

# ===========================================================================
# 3. WIRING -- run_secure_scan advisory default vs LOKI_SECURE_GATE=block vs waiver.
# ===========================================================================
wiring_supported=1
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP(wiring): $RUN_SH not found."
    wiring_supported=0
fi

if [ "$wiring_supported" -eq 1 ]; then
    _fn="$(awk '/^run_secure_scan\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
    if [ -z "$_fn" ]; then
        echo "SKIP(wiring): run_secure_scan not found in run.sh."
        wiring_supported=0
    fi
fi

if [ "$wiring_supported" -eq 1 ]; then
    log_info() { :; }
    log_warn() { :; }
    # run_secure_scan resolves the scanner via "$SCRIPT_DIR/lib/secure-scan.py".
    # shellcheck disable=SC2034  # consumed inside the eval'd run_secure_scan
    SCRIPT_DIR="$REPO_ROOT/autonomy"
    # shellcheck disable=SC1090
    eval "$_fn"
    if ! type run_secure_scan >/dev/null 2>&1; then
        echo "SKIP(wiring): run_secure_scan did not eval cleanly."
        wiring_supported=0
    fi
fi

if [ "$wiring_supported" -eq 1 ]; then
    # A target with an un-waived HIGH finding (committed private key).
    HIGH="$WORK/wire-high"; mkdir -p "$HIGH"
    cat > "$HIGH/leak.pem" <<'EOF'
-----BEGIN PRIVATE KEY-----
MIIEvexample
-----END PRIVATE KEY-----
EOF

    # Default (advisory): un-waived HIGH must NOT block (returns 0).
    rc=0; ( TARGET_DIR="$HIGH"; export TARGET_DIR; unset LOKI_SECURE_GATE 2>/dev/null; run_secure_scan ) || rc=$?
    [ "$rc" -eq 0 ] && ok "wiring: advisory default does NOT block on HIGH" \
                    || bad "wiring: advisory default blocked" "rc=$rc"
    # ...and it wrote the receipt with the active HIGH recorded.
    if [ -f "$HIGH/.loki/quality/security-findings.json" ]; then
        ah="$(LOKI_SEC_F="$HIGH/.loki/quality/security-findings.json" python3 -c 'import json,os;d=json.load(open(os.environ["LOKI_SEC_F"]));print(sum(1 for f in d.get("findings",[]) if str(f.get("severity","")).upper()=="HIGH" and not f.get("waived")))')"
        [ "$ah" -ge 1 ] && ok "wiring: receipt records active HIGH (count=$ah)" \
                        || bad "wiring: receipt missing active HIGH" "count=$ah"
    else
        bad "wiring: security-findings.json not written" "advisory run"
    fi

    # LOKI_SECURE_GATE=block + un-waived HIGH -> BLOCK (returns 1).
    HIGH2="$WORK/wire-high2"; mkdir -p "$HIGH2"
    cp "$HIGH/leak.pem" "$HIGH2/leak.pem"
    rc=0; ( TARGET_DIR="$HIGH2"; export TARGET_DIR; LOKI_SECURE_GATE=block; export LOKI_SECURE_GATE; run_secure_scan ) || rc=$?
    [ "$rc" -eq 1 ] && ok "wiring: LOKI_SECURE_GATE=block blocks un-waived HIGH" \
                    || bad "wiring: block mode did NOT block HIGH" "rc=$rc"

    # LOKI_SECURE_GATE=block + the SAME HIGH waived -> does NOT block (returns 0).
    HIGH3="$WORK/wire-high3"; mkdir -p "$HIGH3/.loki/quality"
    cp "$HIGH/leak.pem" "$HIGH3/leak.pem"
    cat > "$HIGH3/.loki/quality/security-waivers.json" <<'EOF'
{"waivers":[{"rule":"private-key-committed","file":"leak.pem","reason":"test fixture, accepted with intent"}]}
EOF
    rc=0; ( TARGET_DIR="$HIGH3"; export TARGET_DIR; LOKI_SECURE_GATE=block; export LOKI_SECURE_GATE; run_secure_scan ) || rc=$?
    [ "$rc" -eq 0 ] && ok "wiring: a waiver suppresses the block under LOKI_SECURE_GATE=block" \
                    || bad "wiring: waiver did NOT suppress block" "rc=$rc"
    # ...and the receipt marks that finding waived (not active).
    if [ -f "$HIGH3/.loki/quality/security-findings.json" ]; then
        wv="$(LOKI_SEC_F="$HIGH3/.loki/quality/security-findings.json" python3 -c 'import json,os;d=json.load(open(os.environ["LOKI_SEC_F"]));print(sum(1 for f in d.get("findings",[]) if f.get("rule")=="private-key-committed" and f.get("waived")))')"
        [ "$wv" -ge 1 ] && ok "wiring: receipt marks the waived finding waived" \
                        || bad "wiring: receipt did not mark finding waived" "count=$wv"
    else
        bad "wiring: security-findings.json not written" "waiver run"
    fi

    # Clean target under block mode -> exit 0 (never surprise-blocks a clean app).
    CLEAN2="$WORK/wire-clean"; mkdir -p "$CLEAN2/src"
    echo 'export const x = 1;' > "$CLEAN2/src/a.js"
    rc=0; ( TARGET_DIR="$CLEAN2"; export TARGET_DIR; LOKI_SECURE_GATE=block; export LOKI_SECURE_GATE; run_secure_scan ) || rc=$?
    [ "$rc" -eq 0 ] && ok "wiring: clean target passes even under block mode" \
                    || bad "wiring: clean target blocked under block mode" "rc=$rc"
fi

# ===========================================================================
# 4. WAIVER CLI -- loki secure waive | unwaive | list.
# ===========================================================================
cli_supported=1
if [ ! -f "$LOKI_BIN" ]; then
    echo "SKIP(cli): $LOKI_BIN not found."
    cli_supported=0
fi

if [ "$cli_supported" -eq 1 ]; then
    CLIP="$WORK/cli-proj"; mkdir -p "$CLIP/.loki/quality"
    # Seed a findings file so `list` has something to show.
    cat > "$CLIP/.loki/quality/security-findings.json" <<'EOF'
{"rules_version":"1.0","findings":[{"rule":"private-key-committed","file":"leak.pem","line":1,"severity":"HIGH","message":"PEM private key present","fix":"remove + rotate"}],"summary":{"total":1,"by_severity":{"HIGH":1}}}
EOF

    run_secure_cli() {
        ( cd "$CLIP" && LOKI_DIR=".loki" bash "$LOKI_BIN" secure "$@" )
    }

    # waive writes the {waivers:[{rule,file,reason}]} shape.
    out="$(run_secure_cli waive private-key-committed leak.pem "accepted by SDET" 2>&1)"; rc=$?
    wf="$CLIP/.loki/quality/security-waivers.json"
    if [ "$rc" -eq 0 ] && [ -f "$wf" ]; then
        shape="$(LOKI_WF="$wf" python3 -c 'import json,os
d=json.load(open(os.environ["LOKI_WF"]))
ws=d.get("waivers")
assert isinstance(ws,list) and len(ws)==1, "waivers not a 1-element list"
w=ws[0]
assert w.get("rule")=="private-key-committed", "rule wrong"
assert w.get("file")=="leak.pem", "file wrong"
assert w.get("reason")=="accepted by SDET", "reason wrong"
print("ok")' 2>&1)"
        [ "$shape" = "ok" ] && ok "cli: waive writes {waivers:[{rule,file,reason}]}" \
                            || bad "cli: waive shape wrong" "$shape"
    else
        bad "cli: waive failed" "rc=$rc out=$out"
    fi

    # list shows the finding.
    out="$(run_secure_cli list 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "private-key-committed"; then
        ok "cli: list shows the finding"
    else
        bad "cli: list did not show the finding" "rc=$rc out=$out"
    fi

    # unwaive removes it (waivers list becomes empty).
    out="$(run_secure_cli unwaive private-key-committed leak.pem 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ] && [ -f "$wf" ]; then
        left="$(LOKI_WF="$wf" python3 -c 'import json,os;print(len(json.load(open(os.environ["LOKI_WF"])).get("waivers",[])))' 2>&1)"
        [ "$left" = "0" ] && ok "cli: unwaive removes the waiver" \
                          || bad "cli: unwaive left a waiver" "remaining=$left"
    else
        bad "cli: unwaive failed" "rc=$rc out=$out"
    fi
fi

# --- cJ_r1 regression: green-wash + false-positive fixes (v7.87.0) ----------
# (a) GREEN-WASH closed: a real secret baked into an HTML line that also contains
# an unrelated tag (the common <script>/<meta> inline-secret leak) MUST fire.
# The old whole-line placeholder guard suppressed it.
BAD="$WORK/r2-html-leak"; mkdir -p "$BAD/public"
cat > "$BAD/public/index.html" <<'EOF'
<script>var awsKey = "AKIAIOSFODNN7EXAMPLG";</script>
EOF
scan "$BAD"; assert_fires "secret-in-client-file" "r2-html-inline"
# but a TEMPLATED value wrapped in markup is still safe.
SAFE="$WORK/r2-html-tmpl"; mkdir -p "$SAFE/public"
cat > "$SAFE/public/t.html" <<'EOF'
<input data-key="<YOUR_API_KEY>">
EOF
scan "$SAFE"; assert_silent "secret-in-client-file" "r2-html-templated"

# (b) FALSE-POSITIVE fixed: a bare PUBLIC_READ app-domain identifier / enum / doc
# must NOT fire rule 3; only a QUALIFIED AWS/S3 form does.
SAFE="$WORK/r3-fp"; mkdir -p "$SAFE"
cat > "$SAFE/permissions.ts" <<'EOF'
export const ACCESS_LEVELS = { PUBLIC_READ: "public_read", PRIVATE: "private" };
export enum Visibility { PUBLIC_READ, PRIVATE }
EOF
cat > "$SAFE/SECURITY.md" <<'EOF'
# Do not use PUBLIC_READ; we block public bucket access.
EOF
scan "$SAFE"; assert_silent "world-open-datastore" "r3-public-read-identifier"
# the qualified AWS form still fires.
BAD="$WORK/r3-aws"; mkdir -p "$BAD"
cat > "$BAD/infra.ts" <<'EOF'
new s3.Bucket(this, "b", { accessControl: s3.BucketAccessControl.PUBLIC_READ });
EOF
scan "$BAD"; assert_fires "world-open-datastore" "r3-aws-qualified"

# (c) cJ_r2: rule 5 (CORS) prose/doc awareness -- a README or comment WARNING
# about ACAO * + credentials must NOT fire; a real config combo still does.
SAFE="$WORK/r5-doc"; mkdir -p "$SAFE"
cat > "$SAFE/README.md" <<'EOF'
Never set Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true.
EOF
scan "$SAFE"; assert_silent "cors-wildcard-credentials" "r5-doc-prose"
BAD="$WORK/r5-real"; mkdir -p "$BAD"
cat > "$BAD/nginx.conf" <<'EOF'
add_header Access-Control-Allow-Origin *;
add_header Access-Control-Allow-Credentials true;
EOF
scan "$BAD"; assert_fires "cors-wildcard-credentials" "r5-real-config"

# (d) cJb_r2: multi-line comment / docstring bodies must not false-fire the
# literal rules (3, 5). A continuation line inside a docstring/block-comment has
# no leading marker, so a per-line check missed it.
SAFE="$WORK/r3-docstring"; mkdir -p "$SAFE"
cat > "$SAFE/doc.py" <<'EOF'
def f():
    """Example firebase rule to AVOID:
    { "rules": { ".write": true } }
    """
    return 1
EOF
scan "$SAFE"; assert_silent "world-open-datastore" "r3-python-docstring"
SAFE="$WORK/r5-block"; mkdir -p "$SAFE"
cat > "$SAFE/block.js" <<'EOF'
/*
 never use Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true
*/
const ok = 1;
EOF
scan "$SAFE"; assert_silent "cors-wildcard-credentials" "r5-block-comment"
# real config in a real config file still fires (the mask only relaxes prose).
BAD="$WORK/r3-real-after-mask"; mkdir -p "$BAD"
cat > "$BAD/db.rules.json" <<'EOF'
{ "rules": { ".write": true } }
EOF
scan "$BAD"; assert_fires "world-open-datastore" "r3-real-config-after-mask"

SAFE="$WORK/r3-oneline-doc"; mkdir -p "$SAFE"
cat > "$SAFE/oneline.py" <<'EOF'
x = """example to avoid: { ".write": true }"""
EOF
scan "$SAFE"; assert_silent "world-open-datastore" "r3-oneline-docstring"

# (e) cJc_r2 EVASION closed: a real cors() config call must FIRE even if an
# earlier line opens a fake comment token (// ... /* ...). The config-context
# scoping keys off the config-call form, so there is no block-mask to weaponize.
BAD="$WORK/r5-evasion"; mkdir -p "$BAD"
cat > "$BAD/server.js" <<'EOF'
// TODO: handle /* nested blocks later
app.use(cors({ origin: "*", credentials: true }));
EOF
scan "$BAD"; assert_fires "cors-wildcard-credentials" "r5-comment-evasion-still-fires"

# (f) cJd_r2: config-call detection covers express res.setHeader + flask CORS(,
# does not false-fire on a comment mentioning cors(), and bare header names in
# prose/comments are not config-context (only real setter/call/config-file forms).
BAD="$WORK/r5-express"; mkdir -p "$BAD"
cat > "$BAD/express.js" <<'EOF'
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Credentials", "true");
EOF
scan "$BAD"; assert_fires "cors-wildcard-credentials" "r5-express-setheader"
BAD="$WORK/r5-flask"; mkdir -p "$BAD"
cat > "$BAD/app.py" <<'EOF'
CORS(app, origins="*", supports_credentials=True)
EOF
scan "$BAD"; assert_fires "cors-wildcard-credentials" "r5-flask-cors"
SAFE="$WORK/r5-comment-call"; mkdir -p "$SAFE"
cat > "$SAFE/note.js" <<'EOF'
// remember to call cors() with origin "*" and credentials true carefully
const x = 1;
EOF
scan "$SAFE"; assert_silent "cors-wildcard-credentials" "r5-comment-mentioning-cors"

# (g) RLS in a .sql migration is config (DISABLE RLS + GRANT TO anon = world-open);
# an inline-comment mention of the same is not.
BAD="$WORK/r3-rls-sql"; mkdir -p "$BAD"
cat > "$BAD/migration.sql" <<'EOF'
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
GRANT SELECT ON users TO anon;
EOF
scan "$BAD"; assert_fires "world-open-datastore" "r3-rls-sql-migration"

# ===========================================================================
echo
echo "secure-scan: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
