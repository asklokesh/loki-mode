#!/usr/bin/env bash
# G-01: the optional statusLine logger (scripts/usage-statusline-logger.sh)
# for the D39 usage governor. Feeds it statusLine-shaped JSON on stdin per
# https://code.claude.com/docs/en/statusline and checks: it logs
# {"ts", "rate_limits"} only when rate_limits is present, it prints a plain
# one-line status, it never crashes on malformed input, and (per the
# coordinator's instruction) it never touches settings.json.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="$REPO_ROOT/scripts/usage-statusline-logger.sh"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "TEST: usage-statusline-logger.sh (G-01, D39)"

[ -f "$TOOL" ] || { echo "  FAIL: $TOOL missing"; exit 1; }

FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

_q() { printf '%s' "$1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
$2" 2>/dev/null; }

echo "T1 -- never edits settings.json"
# The script's own header comment explains that wiring it up as the
# statusLine command is a manual, operator-owned edit to settings.json this
# script never makes itself -- so a bare mention is fine. What must be
# absent is any NON-COMMENT line that references settings.json at all
# (this script only ever opens LOG_FILE for writing).
if grep -v '^[[:space:]]*#' "$TOOL" | grep -q "settings.json"; then
  bad "a non-comment line references settings.json -- it must never write there"
  grep -v '^[[:space:]]*#' "$TOOL" | grep "settings.json" | sed 's/^/        /'
else
  ok "no non-comment settings.json reference (only the explanatory header comment)"
fi

echo "T2 -- rate_limits present: logs one line and prints a one-line status"
LOGDIR1="$FIXTURE_ROOT/t1"
INPUT1='{"model":{"id":"claude-opus-5-5","display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41.2,"resets_at":1738857600}}}'
OUT1="$(printf '%s' "$INPUT1" | LOKI_STATUSLINE_LOG_DIR="$LOGDIR1" bash "$TOOL")"
_rc=$?
LOGFILE1="$LOGDIR1/statusline.jsonl"
if [ -f "$LOGFILE1" ] && [ "$(wc -l < "$LOGFILE1" | tr -d ' ')" = "1" ]; then
  ok "one line appended to statusline.jsonl"
else
  bad "expected exactly one log line, found: $(cat "$LOGFILE1" 2>&1)"
fi
_rl="$(_q "$(cat "$LOGFILE1")" "print(d['rate_limits']['five_hour']['used_percentage'])")"
if [ "$_rl" = "23.5" ]; then
  ok "logged rate_limits.five_hour.used_percentage matches the input (23.5)"
else
  bad "expected 23.5, got '$_rl'"
fi
_ts="$(_q "$(cat "$LOGFILE1")" "print(isinstance(d.get('ts'), (int,float)))")"
[ "$_ts" = "True" ] && ok "logged entry has a numeric ts" || bad "ts missing or non-numeric"
case "$OUT1" in
  *Opus*"5h 24%"*"wk 41%"*) ok "one-line status includes model and both percentages: $OUT1" ;;
  *) bad "unexpected status line: '$OUT1'" ;;
esac

echo "T3 -- no rate_limits: prints a status, does not crash, logs nothing"
LOGDIR2="$FIXTURE_ROOT/t2"
INPUT2='{"model":{"id":"x","display_name":"Sonnet"}}'
OUT2="$(printf '%s' "$INPUT2" | LOKI_STATUSLINE_LOG_DIR="$LOGDIR2" bash "$TOOL")"
_rc2=$?
if [ "$_rc2" -eq 0 ]; then
  ok "exits 0 when rate_limits is absent"
else
  bad "exited $_rc2 with no rate_limits"
fi
if [ ! -f "$LOGDIR2/statusline.jsonl" ]; then
  ok "no log file written when rate_limits is absent"
else
  bad "a log file was written with no rate_limits to log"
fi
[ "$OUT2" = "Sonnet" ] && ok "status line falls back to just the model name" || bad "expected 'Sonnet', got '$OUT2'"

echo "T4 -- malformed stdin does not crash"
LOGDIR3="$FIXTURE_ROOT/t3"
_rc3=0
printf 'not json at all' | LOKI_STATUSLINE_LOG_DIR="$LOGDIR3" bash "$TOOL" >/dev/null 2>"$FIXTURE_ROOT/t3.err" || _rc3=$?
if [ "$_rc3" -eq 0 ]; then
  ok "malformed stdin does not crash the logger"
else
  bad "logger exited $_rc3 on malformed stdin"
  sed 's/^/        /' "$FIXTURE_ROOT/t3.err"
fi

echo "T5 -- five_hour: null does not crash (rate_limits key present, value null)"
LOGDIR4="$FIXTURE_ROOT/t4"
INPUT4='{"model":{"id":"x","display_name":"Haiku"},"rate_limits":{"five_hour":null,"seven_day":{"used_percentage":12}}}'
_rc4=0
OUT4="$(printf '%s' "$INPUT4" | LOKI_STATUSLINE_LOG_DIR="$LOGDIR4" bash "$TOOL" 2>"$FIXTURE_ROOT/t4.err")" || _rc4=$?
if [ "$_rc4" -eq 0 ]; then
  ok "five_hour: null does not crash the logger"
else
  bad "logger exited $_rc4 on five_hour: null"
  sed 's/^/        /' "$FIXTURE_ROOT/t4.err"
fi
case "$OUT4" in
  *Haiku*"wk 12%"*) ok "five_hour: null treated as no reading; seven_day still reported: $OUT4" ;;
  *) bad "unexpected status line: '$OUT4'" ;;
esac

echo "T6 -- non-dict rate_limits does not crash"
LOGDIR5="$FIXTURE_ROOT/t5"
INPUT5='{"model":{"id":"x","display_name":"Sonnet"},"rate_limits":"not-a-dict"}'
_rc5=0
OUT5="$(printf '%s' "$INPUT5" | LOKI_STATUSLINE_LOG_DIR="$LOGDIR5" bash "$TOOL" 2>"$FIXTURE_ROOT/t5.err")" || _rc5=$?
if [ "$_rc5" -eq 0 ]; then
  ok "non-dict rate_limits does not crash the logger"
else
  bad "logger exited $_rc5 on non-dict rate_limits"
  sed 's/^/        /' "$FIXTURE_ROOT/t5.err"
fi
[ "$OUT5" = "Sonnet" ] && ok "non-dict rate_limits treated as no reading" || bad "expected 'Sonnet', got '$OUT5'"
[ ! -f "$LOGDIR5/statusline.jsonl" ] && ok "non-dict rate_limits logs nothing" || bad "a log file was written for non-dict rate_limits"

echo "T7 -- non-numeric used_percentage does not crash"
LOGDIR6="$FIXTURE_ROOT/t6"
INPUT6='{"model":{"id":"x","display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":"high"},"seven_day":{"used_percentage":30}}}'
_rc6=0
OUT6="$(printf '%s' "$INPUT6" | LOKI_STATUSLINE_LOG_DIR="$LOGDIR6" bash "$TOOL" 2>"$FIXTURE_ROOT/t6.err")" || _rc6=$?
if [ "$_rc6" -eq 0 ]; then
  ok "non-numeric used_percentage does not crash the logger"
else
  bad "logger exited $_rc6 on non-numeric used_percentage"
  sed 's/^/        /' "$FIXTURE_ROOT/t6.err"
fi
case "$OUT6" in
  *"5h"*) bad "non-numeric five_hour used_percentage should have been omitted: '$OUT6'" ;;
  *Opus*"wk 30%"*) ok "non-numeric used_percentage omitted; numeric seven_day still reported: $OUT6" ;;
  *) bad "unexpected status line: '$OUT6'" ;;
esac

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
