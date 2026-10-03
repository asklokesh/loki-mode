#!/usr/bin/env bash
# Test: scripts/metrics-usage-append.py (PO-TEST-1)
# Covers arg parsing, appended block format, and repeat-append behavior
# (the script is NOT idempotent: each run inserts a new block, newest first).
# Only fixture copies in a run-owned temp dir are ever written.

# shellcheck disable=SC2015
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../scripts/metrics-usage-append.py"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || { echo "cannot resolve temp root"; exit 1; }
T="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || { echo "cannot create temp dir"; exit 1; }
chmod 700 "$T"
cleanup() {
    case "$T" in
        "${temp_root}"/loki-run.*) [ -d "$T" ] && [ ! -L "$T" ] && rm -rf -- "$T" ;;
    esac
}
trap cleanup EXIT

cat > "$T/METRICS.md" <<'MD'
# Metrics

## Other section
keep me

## Usage (hourly, from scripts/usage-governor.py)

### 2026-01-01T00:00Z
- old block

## Tail
tail text
MD
cp "$T/METRICS.md" "$T/METRICS.orig"

cat > "$T/usage.json" <<'JSON'
{
  "generated_at": "2026-10-03T12:34:56Z",
  "governor": {"hours_to_weekly_reset": 50.25, "last_hour_output_tokens": 12345,
    "active_engineers_last_hour": 4, "burn_per_engineer_output_last_hour": 3086,
    "chief_of_staff_burn_output_last_hour": 500, "max_engineers_next_hour": null},
  "window": {"current_pct": 42.55, "current_tokens_output": 1000000, "start": "2026-10-03T08:00:00Z", "source": "reading"},
  "weekly": {"current_pct": null, "current_tokens_output": 9999999, "source": "estimate"},
  "totals": {"by_model": {"opus": {"output_tokens": 300}, "sonnet": {"output_tokens": 700}, "haiku": {"output_tokens": 0}},
    "by_role": {"engineer": {"output_tokens": 800}, "cos": {"output_tokens": 200}}}
}
JSON

run() { timeout -k 5 60 python3 "$SCRIPT" "$@"; }

echo "T1 -- argument parsing"
run --bogus >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "unknown flag exits 2" || bad "unknown flag rc=$rc"
run --json >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "--json without value exits 2" || bad "--json no value rc=$rc"
run --metrics "$T/METRICS.md" --json "$T/missing.json" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "missing --json file fails" || bad "missing json file rc=0"
cmp -s "$T/METRICS.md" "$T/METRICS.orig" && ok "metrics untouched after bad args" || bad "metrics modified after bad args"
run --metrics "$T/absent.md" --json "$T/usage.json" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && [ ! -e "$T/absent.md" ] && ok "missing --metrics file fails, not created" || bad "missing metrics rc=$rc"
printf '# no usage header\n' > "$T/nohdr.md"
run --metrics "$T/nohdr.md" --json "$T/usage.json" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && [ "$(cat "$T/nohdr.md")" = "# no usage header" ] && ok "metrics without header fails and is untouched" || bad "no-header rc=$rc"
echo '{"generated_at": "2026-10-03T12:34:56Z"}' > "$T/partial.json"
run --metrics "$T/METRICS.md" --json "$T/partial.json" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && cmp -s "$T/METRICS.md" "$T/METRICS.orig" && ok "incomplete json fails and metrics untouched" || bad "partial json rc=$rc"

echo "T2 -- appended block format"
out="$(run --metrics "$T/METRICS.md" --json "$T/usage.json")"; rc=$?
[ "$rc" -eq 0 ] && ok "append exits 0" || bad "append rc=$rc"
expected='### 2026-10-03T12:34Z
- 5h window: 42.5%, 1,000,000 output tokens since 2026-10-03T08:00Z (reading)
- Weekly: uncalibrated, 9,999,999 output tokens, 50.2h to reset (estimate)
- Last hour: 12,345 output tokens; 4 active engineers; 3,086 per engineer; Chief of Staff 500
- Max engineers next hour: uncalibrated (no plan reading on file)
- Output tokens by model (all scanned transcripts): sonnet 700 (70.0%), opus 300 (30.0%)
- Output tokens by role (all scanned transcripts): engineer 800, cos 200'
if [ "$out" = "$expected" ]; then ok "stdout block matches expected format"; else bad "block format differs"; diff <(echo "$expected") <(echo "$out") | head -10; fi
if grep -qF -- "$expected" "$T/METRICS.md"; then ok "block written to file"; else bad "block not in file"; fi
hdr=$(grep -n '^## Usage' "$T/METRICS.md" | cut -d: -f1)
got="$(sed -n "$((hdr+1)),$((hdr+2))p" "$T/METRICS.md" | tr '\n' '|')"
[ "$got" = "|### 2026-10-03T12:34Z|" ] && ok "block sits under header after one blank line" || bad "block not under header: $got"
if grep -q '^keep me$' "$T/METRICS.md" && grep -q '^tail text$' "$T/METRICS.md" && grep -q '^- old block$' "$T/METRICS.md"; then
    ok "other content preserved"
else
    bad "other content lost"
fi

echo "T3 -- repeat append (not idempotent, newest first)"
sed 's/12:34:56/13:00:00/' "$T/usage.json" > "$T/usage2.json"
run --metrics "$T/METRICS.md" --json "$T/usage2.json" >/dev/null
[ "$(grep -c '^## Usage (hourly' "$T/METRICS.md")" -eq 1 ] && ok "header still appears once" || bad "header duplicated"
l1=$(grep -n '^### 2026-10-03T13:00Z' "$T/METRICS.md" | cut -d: -f1)
l2=$(grep -n '^### 2026-10-03T12:34Z' "$T/METRICS.md" | cut -d: -f1)
l3=$(grep -n '^### 2026-01-01T00:00Z' "$T/METRICS.md" | cut -d: -f1)
if [ -n "$l1" ] && [ -n "$l2" ] && [ -n "$l3" ] && [ "$l1" -lt "$l2" ] && [ "$l2" -lt "$l3" ]; then
    ok "newest block first"
else
    bad "block order wrong ($l1 $l2 $l3)"
fi
run --metrics "$T/METRICS.md" --json "$T/usage2.json" >/dev/null
[ "$(grep -c '^### 2026-10-03T13:00Z' "$T/METRICS.md")" -eq 2 ] && ok "same snapshot appended twice yields two blocks (no dedupe)" || bad "dedupe behavior changed"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
