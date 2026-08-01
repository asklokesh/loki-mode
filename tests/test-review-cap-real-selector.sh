#!/usr/bin/env bash
# The council cap must work on run.sh's REAL selector, not a copy of it.
#
# WHY A SECOND CAP TEST. tests/test-review-council-cap.sh drives a faithful
# re-implementation of the trimming rule. That is useful and it is not enough:
# three mutations across v8.28.0, v8.34.0 and v8.35.0 SURVIVED precisely because
# a test exercised its own copy of the logic while the original was broken.
#
#   A re-implementation tests the RULE. Only the source tests the CODE.
#
# So this extracts the actual `python3 << 'SPECIALIST_SELECT'` heredoc out of
# run.sh and runs it, end to end, through the same environment variables the
# runner sets. If the cap ever stops reaching the real selector -- a renamed
# var, an env that is not inherited, a reordered block -- this goes red.
#
# THE SAFETY PROPERTY, checked against production code: the mandatory reviewers
# (architecture-strategist, maintainer-mergeability) survive at EVERY cap level.
# A cap may shrink a council; it may never remove a mandate, because that is how
# a smaller council could manufacture an approval.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: council cap against the real selector"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-realsel-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

SEL="$SCRATCH/selector.py"
python3 - "$RUN_SH" "$SEL" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
m = re.search(r"python3 << 'SPECIALIST_SELECT'\n(.*?)\nSPECIALIST_SELECT", src, re.S)
if not m:
    sys.exit(3)
pathlib.Path(sys.argv[2]).write_text(m.group(1))
PY
if [ ! -s "$SEL" ]; then
    echo "  FAIL: could not extract the selector from run.sh -- this test is inert"
    exit 1
fi
ok "extracted the real selector from run.sh"

printf 'diff --git a/x.py b/x.py\n+auth token\n' > "$SCRATCH/diff"
printf 'x.py\n' > "$SCRATCH/files"

# Run the real selector at a given cap; echo "count|name,name,..."
select_at() {
    local cap="$1"
    LOKI_REVIEW_MAX_REVIEWERS="$cap" \
    LOKI_REVIEW_DIFF_FILE="$SCRATCH/diff" \
    LOKI_REVIEW_FILES_FILE="$SCRATCH/files" \
    LOKI_AGENTS_TYPES_FILE="$REPO_ROOT/agents/types.json" \
    LOKI_REVIEW_COMPLEXITY=complex \
        python3 "$SEL" 2>/dev/null \
        | python3 -c "
import json,sys
try:
    r=json.load(sys.stdin)['reviewers']
except Exception:
    print('|'); raise SystemExit
print('%d|%s' % (len(r), ','.join(x['name'] for x in r)))" 2>/dev/null
}

base="$(select_at 0)"
base_n="${base%%|*}"
if [ -n "$base_n" ] && [ "$base_n" -ge 4 ] 2>/dev/null; then
    ok "uncapped complex tier selects $base_n reviewers"
else
    bad "uncapped selection failed or is implausibly small: '$base'"
fi

# --- the cap actually binds --------------------------------------------------
for cap in 4 3; do
    out="$(select_at "$cap")"
    n="${out%%|*}"
    if [ -n "$n" ] && [ "$n" -le "$cap" ] 2>/dev/null && [ "$n" -gt 0 ] 2>/dev/null; then
        ok "cap=$cap yields $n reviewers (bound honoured on the real selector)"
    else
        bad "cap=$cap did not bind: got '$out'"
    fi
done

# --- THE SAFETY PROPERTY, on production code --------------------------------
for cap in 0 4 3; do
    out="$(select_at "$cap")"
    names="${out#*|}"
    _missing=""
    for m in architecture-strategist maintainer-mergeability; do
        case ",$names," in *",$m,"*) ;; *) _missing="$_missing $m" ;; esac
    done
    if [ -z "$_missing" ]; then
        ok "cap=$cap keeps every mandatory reviewer"
    else
        bad "cap=$cap dropped mandatory reviewer(s):$_missing"
    fi
done

# --- no DUPLICATES ------------------------------------------------------------
# Presence is not enough, and this is not hypothetical. Breaking the trim loop's
# mandatory-exclusion produces:
#
#   cap=3 -> architecture-strategist, maintainer-mergeability, architecture-strategist
#
# Every mandatory reviewer is still "present", so a presence-only assertion
# stays green while a capped slot is wasted on a duplicate -- the council pays
# full latency for one fewer perspective. That mutation SURVIVED until this
# check existed.
for cap in 0 4 3; do
    out="$(select_at "$cap")"
    names="${out#*|}"
    total="$(printf '%s' "$names" | tr ',' '\n' | grep -c . )"
    uniq_n="$(printf '%s' "$names" | tr ',' '\n' | sort -u | grep -c . )"
    if [ "${total:-0}" -eq "${uniq_n:-0}" ]; then
        ok "cap=$cap produces no duplicate reviewers"
    else
        bad "cap=$cap duplicated a reviewer ($total entries, $uniq_n distinct): $names"
    fi
done

# --- capping must never ADD a reviewer --------------------------------------
# A trim that grew the council would mean the cap is being applied to the wrong
# list entirely.
capped="$(select_at 4)"; capped_n="${capped%%|*}"
if [ -n "$capped_n" ] && [ -n "$base_n" ] && [ "$capped_n" -le "$base_n" ] 2>/dev/null; then
    ok "a cap never increases the council size"
else
    bad "cap=4 produced MORE reviewers than uncapped ($capped_n vs $base_n)"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
