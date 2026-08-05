#!/usr/bin/env bash
# The machine-readable surface must know what the printed one knows.
#
# v8.14.1 taught `loki why` to distinguish a converging run from a thrashing one.
# It taught only the HUMAN output. `loki why --json` -- the surface CI, scripts
# and dashboards consume -- is a separate code path that returns before the
# human report is built, so it still emitted a bare status.
#
# That is the third time in this chain the same shape appeared: a fix landing on
# one surface while a sibling surface keeps the old behaviour, which looks solved
# and is not. An automated caller deciding whether to retry a capped build had
# strictly less information than a human reading the terminal.
#
# THE PROPERTY: no records means rework is null, never a zeroed object. A
# 0-of-0 split reads as "no rework happened", which the data does not support,
# and a caller branching on it would retry a run that should not be retried.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: loki why --json carries the rework split"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-whyjson-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Writer only ever emits completed|failed (run.sh: exit 0 -> completed).
mk() {
    local d="$SCRATCH/$1"; shift
    rm -rf "$d"; mkdir -p "$d/.loki/metrics/efficiency"
    printf '{"status":"max_iterations_reached","iteration":3,"exit_code":20}\n' \
        > "$d/.loki/autonomy-state.json"
    local n=1 st
    for st in "$@"; do
        printf '{"iteration":%d,"model":"sonnet","cost_usd":1.2,"status":"%s"}\n' \
            "$n" "$st" > "$d/.loki/metrics/efficiency/iteration-$n.json"
        n=$((n + 1))
    done
    printf '%s' "$d"
}

jq_field() {
    (cd "$1" && bash "$LOKI" why --json 2>/dev/null) | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); raise SystemExit
cur = d
for k in sys.argv[1].split('.'):
    if cur is None:
        print('NULL'); raise SystemExit
    cur = cur.get(k) if isinstance(cur, dict) else None
print('NULL' if cur is None else cur)" "$2"
}

# --- 1. the output is still valid JSON --------------------------------------
# Adding a field must not break every existing consumer.
d="$(mk valid completed failed)"
[[ "$(jq_field "$d" state.status)" == "max_iterations_reached" ]] \
    && ok "the JSON still parses and keeps its existing fields" \
    || ko "the JSON still parses and keeps its existing fields"

# --- 2. thrashing is reported, with a verdict a caller can branch on ---------
d="$(mk thrash failed failed failed)"
[[ "$(jq_field "$d" rework.verdict)" == "thrashing" ]] \
    && ok "an all-failed run reports verdict=thrashing" \
    || ko "an all-failed run reports verdict=thrashing" \
          "got: $(jq_field "$d" rework.verdict)"
[[ "$(jq_field "$d" rework.rework_iterations)" == "3" ]] \
    && ok "the rework iteration count is exposed" \
    || ko "the rework iteration count is exposed"
[[ "$(jq_field "$d" rework.rework_cost_usd)" == "3.6" ]] \
    && ok "the rework COST is exposed (what the retry would cost again)" \
    || ko "the rework COST is exposed" "got: $(jq_field "$d" rework.rework_cost_usd)"

# --- 3. converging is reported distinctly -----------------------------------
d="$(mk converge completed completed completed failed)"
[[ "$(jq_field "$d" rework.verdict)" == "converging" ]] \
    && ok "a mostly-progress run reports verdict=converging" \
    || ko "a mostly-progress run reports verdict=converging" \
          "got: $(jq_field "$d" rework.verdict)"
[[ "$(jq_field "$d" rework.progress_iterations)" == "3" ]] \
    && ok "the progress count is exposed" \
    || ko "the progress count is exposed"

# --- 4. THE PROPERTY. No records -> null, never a zeroed object. ------------
d="$SCRATCH/nodata"; rm -rf "$d"; mkdir -p "$d/.loki"
printf '{"status":"max_iterations_reached","iteration":3}\n' > "$d/.loki/autonomy-state.json"
if [[ "$(jq_field "$d" rework)" == "NULL" ]]; then
    ok "with no records rework is null, not a fabricated 0-of-0"
else
    ko "with no records rework is null, not a fabricated 0-of-0" \
       "got: $(jq_field "$d" rework) -- a caller would read this as 'no rework'"
fi

# --- 5. a corrupt record must not break the JSON ----------------------------
d="$(mk corrupt completed failed)"
printf 'not json\n' > "$d/.loki/metrics/efficiency/iteration-9.json"
[[ "$(jq_field "$d" state.status)" != "PARSE_ERROR" ]] \
    && ok "a corrupt efficiency record does not break the JSON output" \
    || ko "a corrupt efficiency record does not break the JSON output"

# --- 6. human and JSON surfaces agree ---------------------------------------
# The whole point: they must not disagree about one run.
d="$(mk agree failed failed failed)"
human="$( (cd "$d" && bash "$LOKI" why 2>/dev/null) || true)"
if [[ "$human" == *"buys more of the same"* && "$(jq_field "$d" rework.verdict)" == "thrashing" ]]; then
    ok "human and JSON surfaces agree on the same run"
else
    ko "human and JSON surfaces agree on the same run" \
       "json=$(jq_field "$d" rework.verdict); human advice missing the thrashing warning"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
