#!/usr/bin/env bash
# loki wow and loki factory help and the offline fallback. No model call.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$ROOT/autonomy/loki"
fail=0
check() {
  local name="$1" ok="$2"
  if [ "$ok" = "1" ]; then echo "PASS $name"; else echo "FAIL $name"; fail=1; fi
}

help_out="$("$LOKI" wow --help 2>&1)"
check "wow help names the offline fallback" "$(printf '%s' "$help_out" | grep -q 'offline sample' && echo 1 || echo 0)"
check "wow help names loki start" "$(printf '%s' "$help_out" | grep -q 'loki start' && echo 1 || echo 0)"

off="$("$LOKI" wow --offline 2>&1)"
check "wow offline shows a verdict word" "$(printf '%s' "$off" | grep -Eq 'VERIFIED|TAMPERED|UNCHECKED|No verdict' && echo 1 || echo 0)"
check "wow offline ends with the next step" "$(printf '%s' "$off" | grep -q 'Ready for your repo? loki start' && echo 1 || echo 0)"

dry="$("$LOKI" wow --dry-run 2>&1)"
check "wow dry-run does not claim a spend" "$(printf '%s' "$dry" | grep -Eq 'dry-run|offline sample' && echo 1 || echo 0)"

fac="$("$LOKI" factory --help 2>&1)"
check "factory names propose execute operate" "$(printf '%s' "$fac" | grep -q 'propose' && printf '%s' "$fac" | grep -q 'execute' && printf '%s' "$fac" | grep -q 'operate' && echo 1 || echo 0)"
check "factory says it wraps start" "$(printf '%s' "$fac" | grep -q 'loki start' && echo 1 || echo 0)"

tour="$("$LOKI" tour --help 2>&1)"
check "tour help still documents the sample" "$(printf '%s' "$tour" | grep -q 'offline' && echo 1 || echo 0)"
check "tour help points at live" "$(printf '%s' "$tour" | grep -q 'tour --live' && echo 1 || echo 0)"

norepo="$(mktemp -d)"
empty="$(cd "$norepo" && "$LOKI" start 2>&1)"
rm -rf "$norepo"
check "start outside a repo shows a receipt" "$(printf '%s' "$empty" | grep -Eq 'VERIFIED|TAMPERED' && echo 1 || echo 0)"
check "start outside a repo points at start" "$(printf '%s' "$empty" | grep -q 'Ready for your repo? loki start' && echo 1 || echo 0)"
check "start outside a repo does not ask for a provider" "$(printf '%s' "$empty" | grep -Eq 'npm install -g @anthropic-ai|provider CLI is not installed' && echo 0 || echo 1)"

dump="$(env -u LOKI_COST_PROFILE -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_E10_TRIM -u LOKI_E10_SMALL_NO_RUNNER -u LOKI_E10_SMALL_MAX_CHARS -u LOKI_COST_FIRST -u LOKI_COST_DEFAULTED -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL LOKI_CONFIG_DUMP=1 "$LOKI" start ./ignored.md 2>/dev/null || true)"
check "start defaults haiku-first" "$(printf '%s' "$dump" | grep -q '^LOKI_IMPLEMENT_HAIKU_FIRST=1$' && echo 1 || echo 0)"
check "start defaults trim" "$(printf '%s' "$dump" | grep -q '^LOKI_E10_TRIM=1$' && echo 1 || echo 0)"
check "start defaults cost-first" "$(printf '%s' "$dump" | grep -q '^LOKI_COST_FIRST=1$' && echo 1 || echo 0)"
offdump="$(env -u LOKI_COST_PROFILE -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_E10_TRIM -u LOKI_COST_FIRST -u LOKI_COST_DEFAULTED -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL LOKI_CONFIG_DUMP=1 "$LOKI" start --cost off ./ignored.md 2>/dev/null || true)"
check "cost off does not force haiku" "$(printf '%s' "$offdump" | grep -q '^LOKI_IMPLEMENT_HAIKU_FIRST=1$' && echo 0 || echo 1)"
pindump="$(env -u LOKI_COST_PROFILE -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_E10_TRIM -u LOKI_COST_FIRST -u LOKI_COST_DEFAULTED LOKI_SESSION_MODEL=opus LOKI_CONFIG_DUMP=1 "$LOKI" start ./ignored.md 2>/dev/null || true)"
check "a model pin does not force haiku" "$(printf '%s' "$pindump" | grep -q '^LOKI_IMPLEMENT_HAIKU_FIRST=1$' && echo 0 || echo 1)"

exit "$fail"
