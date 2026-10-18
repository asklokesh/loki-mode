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

dump="$(env -u LOKI_COST_PROFILE -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_E10_TRIM -u LOKI_TRIM_DEFAULTED -u LOKI_E10_SMALL_NO_RUNNER -u LOKI_E10_SMALL_MAX_CHARS -u LOKI_COST_FIRST -u LOKI_COST_DEFAULTED -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL -u LOKI_MUTATION_STRICT -u LOKI_F2P_DEFAULTED LOKI_CONFIG_DUMP=1 "$LOKI" start ./ignored.md 2>/dev/null || true)"
check "start keeps the provider model" "$(printf '%s' "$dump" | grep -q '^LOKI_IMPLEMENT_HAIKU_FIRST=1$' && echo 0 || echo 1)"
hai="$(env -u LOKI_COST_PROFILE -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_E10_TRIM -u LOKI_E10_SMALL_NO_RUNNER -u LOKI_E10_SMALL_MAX_CHARS -u LOKI_COST_FIRST -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL LOKI_CONFIG_DUMP=1 "$LOKI" start --haiku ./ignored.md 2>/dev/null || true)"
check "--haiku opts into haiku-first" "$(printf '%s' "$hai" | grep -q '^LOKI_IMPLEMENT_HAIKU_FIRST=1$' && echo 1 || echo 0)"
check "--haiku opts into trim" "$(printf '%s' "$hai" | grep -q '^LOKI_E10_TRIM=1$' && echo 1 || echo 0)"
check "--haiku opts into cost-first" "$(printf '%s' "$hai" | grep -q '^LOKI_COST_FIRST=1$' && echo 1 || echo 0)"
check "start turns on fail-to-pass" "$(printf '%s' "$dump" | grep -q '^LOKI_MUTATION_STRICT=1$' && echo 1 || echo 0)"
check "start trims tool logs" "$(printf '%s' "$dump" | grep -q '^LOKI_E10_TRIM=1$' && echo 1 || echo 0)"
offf2p="$(env -u LOKI_MUTATION_STRICT -u LOKI_F2P_DEFAULTED -u LOKI_E10_TRIM -u LOKI_TRIM_DEFAULTED LOKI_MUTATION_STRICT=0 LOKI_E10_TRIM=0 LOKI_CONFIG_DUMP=1 "$LOKI" start ./ignored.md 2>/dev/null || true)"
check "explicit 0 keeps fail-to-pass off" "$(printf '%s' "$offf2p" | grep -q '^LOKI_MUTATION_STRICT=0$' && echo 1 || echo 0)"
check "explicit 0 keeps trim off" "$(printf '%s' "$offf2p" | grep -q '^LOKI_E10_TRIM=0$' && echo 1 || echo 0)"
helpstrict="$(env -u LOKI_MUTATION_STRICT -u LOKI_F2P_DEFAULTED LOKI_CONFIG_DUMP=1 "$LOKI" start --help 2>/dev/null || true)"
check "help does not turn fail-to-pass on" "$(printf '%s' "$helpstrict" | grep -q '^LOKI_MUTATION_STRICT=1$' && echo 0 || echo 1)"

exit "$fail"
