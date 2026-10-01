#!/usr/bin/env bash
# DOC-02: repo-wide version of the M-30 check (tests/test-modernize-docs.sh).
# Fails when a user doc names a `loki <command>` or a `--flag` the CLI does not
# accept, or presents a version older than VERSION's major.minor as current.
# Rules and limits: tests/lib/scan-doc-cli-drift.py. Intentional historical
# mentions go in tests/docs-drift-allowlist.tsv as path<TAB>token<TAB>reason;
# CHANGELOG.md, docs/v10/DECISIONS.md, PROGRESS.md, BOARD.md and BACKLOG.md
# are excluded (scan-doc-cli-drift.py EXCLUDE).

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
fi
# Allowlist: path<TAB>token<TAB>reason. A finding is allowed when its path and
# token match an entry, so the entry survives edits to other lines.
ALLOW_KEYS="$(grep -vE '^(#|$)' "$ALLOW" 2>/dev/null | cut -f1,2 | sort -u)"
UNALLOWED=0
USED=""
while IFS=$'\t' read -r path line rule token; do
    [ -z "${path:-}" ] && continue
    key="$path	$token"
    if printf '%s\n' "$ALLOW_KEYS" | grep -qxF -- "$key"; then
        USED="$USED$key"$'\n'
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
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
