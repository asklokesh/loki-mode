#!/usr/bin/env bash
# DOC-02: repo-wide version of the M-30 check (tests/test-modernize-docs.sh).
# Fails when a user doc names a `loki <command>` or a `--flag` the CLI does not
# accept, or presents a version older than VERSION's major.minor as current.
# Rules and limits: tests/lib/scan-doc-cli-drift.py. Intentional historical
# mentions go in tests/docs-drift-allowlist.tsv as path<TAB>token<TAB>reason;
# CHANGELOG.md is excluded (scan-doc-cli-drift.py EXCLUDE).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-doc-cli-drift.py"
ALLOW="$SCRIPT_DIR/docs-drift-allowlist.tsv"
FIXTURE="tests/fixtures/docs-drift/stale.md"

PASS=0
FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo "T1 -- positive control: the scanner reports a planted stale doc"
CTRL="$(DOCS_DRIFT_FILES="$FIXTURE" python3 "$SCAN" "$REPO_ROOT" 2>/dev/null)"
CTRL_RC=$?
if [ "$CTRL_RC" -eq 1 ]; then
    ok "scanner exits 1 on the fixture"
else
    bad "scanner exit $CTRL_RC on the fixture, want 1"
fi
for want in "command	loki doc02-bogus-cmd" "flag	--doc02-not-a-real-flag" "version	v1.0" "version	v2.3"; do
    if printf '%s\n' "$CTRL" | grep -qF -- "$want"; then
        ok "fixture finding reported: ${want//	/ }"
    else
        bad "fixture finding missing: ${want//	/ }"
    fi
done
for unwanted in "loki start" "loki owner" "--help"; do
    if printf '%s\n' "$CTRL" | cut -f4 | grep -qxF -- "$unwanted"; then
        bad "real surface reported as stale: $unwanted"
    else
        ok "real surface not reported: $unwanted"
    fi
done

echo
echo "T2 -- docs name only commands, flags and versions that exist on main"
OUT="$(python3 "$SCAN" "$REPO_ROOT")"
RC=$?
if [ "$RC" -eq 2 ]; then
    bad "scanner could not read its ground truth; check is inert"
elif [ "$RC" -ne 0 ] && ! printf '%s\n' "$OUT" | grep -q "	"; then
    bad "scanner exited $RC with no findings; treating as a crash, not clean"
    RC=2
fi
# Allowlist: path<TAB>token<TAB>reason. A finding is allowed when its path and
# token match an entry, so the entry survives edits to other lines.
ALLOW_KEYS="$(grep -vE '^(#|$)' "$ALLOW" 2>/dev/null | cut -f1,2 | sort -u)"
UNALLOWED=0
USED=""
while IFS=$'\t' read -r path line rule token; do
    [ -z "${path:-}" ] && continue
    key="$path	$token"
    if printf '%s\n' "$ALLOW_KEYS" | grep -qxF -- "$key" ||
        { [ "$rule" = "claim" ] && printf '%s\n' "$ALLOW_KEYS" | grep -qxF -- "$path	claim:*"; }; then
        USED="$USED$key"$'\n'"$path	claim:*"$'\n'
    else
        bad "$path:$line $rule '$token' is not on main (fix the doc, or allowlist a historical mention)"
        UNALLOWED=$((UNALLOWED + 1))
    fi
done <<< "$OUT"
[ "$RC" -ne 2 ] && [ "$UNALLOWED" -eq 0 ] && ok "no unallowlisted doc drift"

echo
echo "T3 -- allowlist hygiene"
if [ -f "$ALLOW" ]; then
    ok "allowlist exists"
else
    bad "missing $ALLOW"
fi
if awk -F'\t' '!/^(#|$)/ && (NF != 3 || $3 == "") {exit 1}' "$ALLOW"; then
    ok "every entry is path<TAB>token<TAB>reason"
else
    bad "allowlist has a malformed entry (want path<TAB>token<TAB>reason)"
fi
# Unused entries warn, never fail: a doc rewrite that removes the mention
# (for example README.md under DOC-01) must not break this check.
STALE_ENTRIES="$(comm -23 <(printf '%s\n' "$ALLOW_KEYS") <(printf '%s' "$USED" | sort -u))"
[ -n "$STALE_ENTRIES" ] && echo "  [WARN] $(printf '%s\n' "$STALE_ENTRIES" | wc -l | tr -d ' ') allowlist entr(ies) no longer needed"

echo
echo "T3b -- R4 claim rule: positive control and receipt exemption"
CLAIM_OUT="$(DOCS_DRIFT_FILES="tests/fixtures/docs-drift/claim.md" python3 "$SCAN" "$REPO_ROOT" 2>/dev/null)"
CLAIM_RC=$?
[ "$CLAIM_RC" -eq 1 ] && ok "claim fixture exits 1" || bad "claim fixture exit $CLAIM_RC, want 1"
printf '%s\n' "$CLAIM_OUT" | grep -qF "claim:3x faster" && ok "'3x faster' reported" || bad "'3x faster' not reported"
printf '%s\n' "$CLAIM_OUT" | grep -qF "claim:99 specialized agents" && ok "'99 specialized agents' reported" || bad "'99 specialized agents' not reported"
printf '%s\n' "$CLAIM_OUT" | grep -qF "claim:40% cheaper" && bad "line with a receipt link was reported" || ok "line with a receipt link passes"
if grep -rnE '41 (Specialized )?Agent' "$REPO_ROOT/docs/COMPARISON.md" | grep -qiE 'vs generic|more (organized|rigorous)|better|exceeds|Loki Mode \*\*'; then
    bad "COMPARISON.md frames the 41 roles as an advantage"
else
    ok "COMPARISON.md states the 41 roles without advantage framing"
fi

echo
echo "T4 -- S6: docs generate honors tier and lean flags"
T4DIR="$(mktemp -d "${TMPDIR:-/tmp}/loki-docs-s6.XXXXXX")"
trap 'rm -rf "$T4DIR"' EXIT
mkdir -p "$T4DIR/bin" "$T4DIR/proj"
cat > "$T4DIR/bin/claude" <<'FAKE'
#!/bin/bash
echo "CALL $*" >> "$T4_LOG"
echo '{"result":"DOC-BODY","usage":{"input_tokens":1,"output_tokens":2}}'
FAKE
chmod +x "$T4DIR/bin/claude"
awk '/^_docs_invoke_provider\(\) \{/{p=1} /^_docs_generate\(\) \{/{p=1} p{print} p&&/^}/{p=0}' \
    "$REPO_ROOT/autonomy/loki" > "$T4DIR/fns.sh"
(
    export T4_LOG="$T4DIR/calls.log"
    export PATH="$T4DIR/bin:$PATH"
    export LOKI_PROVIDER=claude
    export CYAN='' NC='' GREEN=''
    log_info() { :; }; log_warn() { :; }; log_error() { :; }
    _docs_scan_project() { :; }; _docs_build_context() { echo ctx; }
    _docs_generate_template() { echo TEMPLATE; }
    _docs_write_manifest() { :; }
    _loki_perm_argv_for() { _LOKI_CLAUDE_SHELL=/bin/bash; _LOKI_PERM_ARGV=(); }
    # shellcheck disable=SC1090
    . "$T4DIR/fns.sh"
    cd "$T4DIR/proj" || exit 1
    LOKI_DOCS_TIER=small _docs_generate "$T4DIR/proj" >/dev/null 2>&1
    echo "skip_rc=$?" > "$T4DIR/out"
    echo "skip_files=$(ls "$T4DIR/proj/.loki/docs" 2>/dev/null | wc -l | tr -d ' ')" >> "$T4DIR/out"
    LOKI_DOCS_TIER=small _docs_generate --docs "$T4DIR/proj" >/dev/null 2>&1
    echo "req_files=$(ls "$T4DIR/proj/.loki/docs" 2>/dev/null | wc -l | tr -d ' ')" >> "$T4DIR/out"
    : > "$T4DIR/calls.log"
    loki_lean_child_flags() { printf '%s\n' --strict-mcp-config --tools ""; }
    loki_child_ledger_append() { echo "LEDGER $1 $2" >> "$T4DIR/ledger.log"; }
    _docs_invoke_provider "hello" > "$T4DIR/invoke.out" 2>/dev/null
)
# shellcheck disable=SC1091,SC2154
skip_rc=""; skip_files=""; req_files=""
. "$T4DIR/out"
if [ "$skip_rc" = "0" ] && [ "$skip_files" = "0" ]; then ok "small tier without --docs skips and writes nothing"; else bad "small tier did not skip (rc=$skip_rc files=$skip_files)"; fi
if [ "${req_files:-0}" -ge 8 ]; then ok "small tier with --docs still generates the suite"; else bad "--docs produced ${req_files:-0} files"; fi
if grep -q -- "--strict-mcp-config --tools" "$T4DIR/calls.log" 2>/dev/null; then ok "claude doc call carries lean flags"; else bad "lean flags missing: $(cat "$T4DIR/calls.log" 2>/dev/null)"; fi
if grep -q "^DOC-BODY" "$T4DIR/invoke.out" 2>/dev/null; then ok "json result unwrapped to the doc body"; else bad "result not unwrapped: $(cat "$T4DIR/invoke.out" 2>/dev/null)"; fi
if grep -q "^LEDGER docs " "$T4DIR/ledger.log" 2>/dev/null; then ok "ledger line appended for the docs phase"; else bad "no ledger line"; fi

echo
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
