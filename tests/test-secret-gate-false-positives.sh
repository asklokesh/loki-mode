#!/usr/bin/env bash
# tests/test-secret-gate-false-positives.sh
#
# The completion evidence gate must not call a finished, correct app a security
# leak. v8 added LOKI_EVIDENCE_SECRET_GATE (default ON) to the completion
# council; v7.129.5 had NO secret logic there at all. So every false positive
# here is a build that COMPLETED on v7 and BLOCKS on v8 -- a straight regression
# for the user, on exactly the kind of app this engine is asked to build.
#
# TWO FALSE-POSITIVE CLASSES WERE FOUND AND FIXED:
#
#   1. FILENAME ALONE. The council called _commit_path_looks_secret, a
#      name-only heuristic, and blocked on a match. `src/auth/token.ts` is a
#      routine file in any auth-enabled app. Naming a file well is not a leak.
#      That heuristic is CORRECT for the auto-commit path (refusing to stage a
#      file called `.env` is cheap and right) and WRONG as a completion gate,
#      so it was removed from the council only.
#
#   2. TEMPLATE FILES. The tier1 content matcher deliberately has no deny
#      filter, so `.env.example` shipping `OPENAI_API_KEY=sk-...` -- the correct
#      way to document the expected shape -- tripped it. Paths that ANNOUNCE
#      themselves as templates or fixtures are now skipped.
#
# THE OTHER HALF MATTERS AS MUCH: a real secret in a real path must still
# block. A gate loosened into uselessness is worse than the false positives it
# fixed, so every relaxation here is paired with a positive case proving the
# gate still fires.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# shellcheck source=../autonomy/lib/secret-scan.sh
. "$REPO_ROOT/autonomy/lib/secret-scan.sh" 2>/dev/null || {
  echo "FAIL: could not source autonomy/lib/secret-scan.sh"; exit 1; }

type _commit_scan_secret_file >/dev/null 2>&1 || {
  echo "FAIL: _commit_scan_secret_file not defined after sourcing"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-secretgate.XXXXXX")"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT INT TERM

echo "Secret gate: false positives vs real leaks"
echo "=========================================="
echo ""

# ---------------------------------------------------------------------------
# A. Templates and fixtures must NOT block. These are things a generated app
#    correctly ships.
# ---------------------------------------------------------------------------
mkdir -p "$WORK/tests/fixtures" "$WORK/src/config"
printf 'OPENAI_API_KEY=sk-abcdefghij0123456789abcdefghij\n' > "$WORK/.env.example"
printf 'DATABASE_URL=postgres://user:pass@localhost:5432/db\n'  > "$WORK/.env.sample"
printf 'API_KEY=sk-abcdefghij0123456789abcdefghij\n'            > "$WORK/config.template"
printf '{"key":"sk-abcdefghij0123456789abcdefghij"}\n'          > "$WORK/tests/fixtures/keys.json"

for f in ".env.example" ".env.sample" "config.template" "tests/fixtures/keys.json"; do
    if _commit_scan_secret_file "$WORK/$f" 2>/dev/null; then
        bad "template/fixture wrongly blocks completion: $f"
    else
        ok "template/fixture does not block: $f"
    fi
done

# ---------------------------------------------------------------------------
# B. A real secret in a real path must STILL block. This is the half that keeps
#    the relaxation above honest.
# ---------------------------------------------------------------------------
printf 'const k = "sk-live9876543210zyxwvutsrqponml";\n' > "$WORK/src/config/live.ts"
printf 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'        > "$WORK/creds.env"
printf -- '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n'  > "$WORK/id_rsa"

for f in "src/config/live.ts" "creds.env" "id_rsa"; do
    if _commit_scan_secret_file "$WORK/$f" 2>/dev/null; then
        ok "real secret still blocks: $f"
    else
        bad "REAL SECRET NOT CAUGHT (gate too loose): $f"
    fi
done

# ---------------------------------------------------------------------------
# C. Ordinary source files with security-flavored NAMES must not block. This is
#    the filename-heuristic regression: these files contain nothing secret.
# ---------------------------------------------------------------------------
mkdir -p "$WORK/src/auth"
printf 'export function verifyToken(t: string) { return t.length > 0; }\n' > "$WORK/src/auth/token.ts"
printf 'export const SECRET_HEADER = "x-request-id";\n'                    > "$WORK/src/config/secrets.ts"
printf '# Credentials\n\nUsers sign in with email and password.\n'         > "$WORK/CREDENTIALS.md"

for f in "src/auth/token.ts" "src/config/secrets.ts" "CREDENTIALS.md"; do
    if _commit_scan_secret_file "$WORK/$f" 2>/dev/null; then
        bad "ordinary source file wrongly blocks: $f"
    else
        ok "ordinary source file does not block: $f"
    fi
done

# ---------------------------------------------------------------------------
# D. The council must judge CONTENT, not filenames. Asserted against the source
#    so the fix cannot silently regress: the name-only heuristic must not appear
#    in the council's gate loop, while the content scanner must.
# ---------------------------------------------------------------------------
CC="$REPO_ROOT/autonomy/completion-council.sh"
# Take the window around the gate's log line. Anchor on the log_warn itself
# (not the phrase, which also appears in the explanatory comment above it) and
# look back far enough to include the `if` that decides to block.
_gate_ln="$(grep -n 'log_warn .*Evidence gate: secret-leak match' "$CC" 2>/dev/null | head -1 | cut -d: -f1)"
gate_block=""
if [ -n "$_gate_ln" ]; then
    _from=$(( _gate_ln - 20 )); [ "$_from" -lt 1 ] && _from=1
    gate_block="$(sed -n "${_from},$((_gate_ln + 2))p" "$CC" 2>/dev/null)"
fi

if printf '%s' "$gate_block" | grep -q '_commit_scan_secret_file'; then
    ok "council gate uses the CONTENT scanner"
else
    bad "council gate no longer calls _commit_scan_secret_file"
fi

if printf '%s' "$gate_block" | grep -qE '^\s*if.*_commit_path_looks_secret'; then
    bad "council gate blocks on the FILENAME heuristic again (regression)"
else
    ok "council gate does not block on filenames alone"
fi

# The auto-commit path SHOULD keep the filename heuristic -- refusing to stage a
# file named .env is correct there. Confirm the fix was scoped, not blanket.
if grep -q '_commit_path_looks_secret' "$REPO_ROOT/autonomy/run.sh" 2>/dev/null; then
    ok "auto-commit path still uses the filename heuristic (correctly scoped)"
else
    bad "filename heuristic removed from the commit path too (over-broad fix)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
