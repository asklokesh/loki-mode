#!/usr/bin/env bash
# test-evidence-secret-axis.sh -- RUN-25 iter 21 (Wave D #2): the completion
# evidence gate now BLOCKS when a credential-shaped secret is present in the
# changed files. The two-tier matcher previously ran ONLY on the auto-commit path,
# so a completion via the promise / dirty-tree route could ship a leaked secret in
# a "done" deliverable -- a hole in the exact trust moat. Uses the SAME matcher
# (shared autonomy/lib/secret-scan.sh) as the commit gate.
#
# Drives the REAL council_evidence_gate (sourced) with the diff+test axes made to
# PASS so ONLY the secret axis can block. No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="$SCRIPT_DIR/../autonomy/completion-council.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$CC" ] || { echo "FATAL: completion-council.sh not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }

log_info() { :; }
log_warn() { :; }
log_error() { :; }
log_success() { :; }
log_header() { :; }
record_trust_event_bash() { :; }
# shellcheck disable=SC1090
source "$CC" 2>/dev/null || true
type council_evidence_gate >/dev/null 2>&1 || { echo "FATAL: council_evidence_gate not defined"; exit 2; }
# The whole point: the shared matcher must be in scope after sourcing the council.
type _commit_scan_secret_file >/dev/null 2>&1 \
  || { echo "FAIL: secret matcher not sourced into the council (the axis would be inert)"; exit 1; }

# gate <leak-file-or-empty> <leak-content-or-default> : diff+test axes PASS; only
# the secret axis can block. echo PASS/BLOCK.
gate() {
    local leakfile="$1" content="${2:-const k = \"sk-ABCDEFGHIJ1234567890abcdef\";}"
    (
        d="$(mktemp -d)"; cd "$d" || exit 3
        git init -q; git config user.email t@t; git config user.name t; git config commit.gpgsign false
        echo base > f.txt; git add -A; git commit -qm init
        _LOKI_RUN_START_SHA="$(git rev-parse HEAD)"; echo changed >> f.txt
        mkdir -p .loki/quality .loki/council
        printf '%s\n' '{"runner":"vitest","pass":true,"status":"passed","passed_count":1,"failed_count":0}' > .loki/quality/test-results.json
        [ -n "$leakfile" ] && printf '%s\n' "$content" > "$leakfile"
        git add -A
        COUNCIL_STATE_DIR="$d/.loki/council"
        if council_evidence_gate; then echo PASS; else echo BLOCK; fi
        rm -rf "$d"
    )
}

# 1. an OpenAI-style key in a changed file -> BLOCK
[ "$(gate leaked.ts)" = "BLOCK" ] && ok || fail "sk- key in a changed file should BLOCK"

# 2. a secret-looking FILENAME (.env.production) -> BLOCK (path heuristic)
[ "$(gate .env.production "DB_PASSWORD=hunter2hunter2hunter2")" = "BLOCK" ] && ok || fail ".env.production should BLOCK (path heuristic)"

# 3. a URI-embedded credential -> BLOCK
[ "$(gate config.json '{"db":"postgres://user:s3cr3tpassword@host/db"}')" = "BLOCK" ] && ok || fail "URI-cred should BLOCK"

# 4. no secret -> PASS (control: not over-blocking)
[ "$(gate clean.ts "const x = 1 + 2;")" = "PASS" ] && ok || fail "clean changed file should PASS"

# 5. an env-VAR REFERENCE (not a literal) -> PASS (deny filter)
[ "$(gate cfg.ts "const k = process.env.API_KEY;")" = "PASS" ] && ok || fail "env-ref should PASS (deny filter)"

# 6. opt-out LOKI_EVIDENCE_SECRET_GATE=0 -> even a real leak does NOT block
[ "$(LOKI_EVIDENCE_SECRET_GATE=0 gate leaked.ts)" = "PASS" ] && ok || fail "LOKI_EVIDENCE_SECRET_GATE=0 should disable the secret block"

echo ""
echo "test-evidence-secret-axis: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
