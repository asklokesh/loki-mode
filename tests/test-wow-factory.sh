#!/usr/bin/env bash
# loki wow, loki factory and the no-repo start receipt: help, offline fallback, the live-run
# outcome paths (with a stubbed engine, no model call), and the start levers they rely on.
# New file: no existing suite owns the wow/factory onboarding commands (test-demo-* covers
# the offline tour only). Here-strings, not pipe-to-grep-q (FC-64).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$ROOT/autonomy/loki"
fail=0
check() {
  local name="$1" ok="$2" # ok is one or more 0/1 digits; every digit must be 1
  case "$ok" in "" | *[!1]*) echo "FAIL $name"; fail=1 ;; *) echo "PASS $name" ;; esac
}
has() { grep -q -- "$2" <<<"$1" && echo 1 || echo 0; }
hasE() { grep -Eq -- "$2" <<<"$1" && echo 1 || echo 0; }
lacksE() { grep -Eq -- "$2" <<<"$1" && echo 0 || echo 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-wow-test.XXXXXXXX")"
WORK="$(cd "$WORK" && pwd -P)" # cmd_wow prints the physical path (macOS /var -> /private/var)
trap 'rm -rf -- "$WORK"' EXIT

help_out="$("$LOKI" wow --help 2>&1)"
check "wow help names the offline fallback" "$(has "$help_out" 'offline sample')"
check "wow help names loki start" "$(has "$help_out" 'loki start')"
check "wow help documents --keep" "$(has "$help_out" '--keep')"

off="$("$LOKI" wow --offline 2>&1)"
check "wow offline shows a verdict word" "$(hasE "$off" 'VERIFIED|TAMPERED|UNCHECKED|No verdict')"
check "wow offline ends with the next step" "$(has "$off" 'Ready for your repo? loki start')"

dry="$("$LOKI" wow --dry-run 2>&1)"
check "wow dry-run does not claim a spend" "$(hasE "$dry" 'dry-run|offline sample')"

bad_cost_rc=0
bad_cost="$("$LOKI" wow --dry-run --max-cost abc 2>&1)" || bad_cost_rc=$?
check "wow rejects a non-numeric --max-cost" "$([ "$bad_cost_rc" = "2" ] && has "$bad_cost" 'positive number' || echo 0)"
zero_rc=0
"$LOKI" wow --dry-run --max-cost 0 >/dev/null 2>&1 || zero_rc=$?
check "wow rejects a zero --max-cost" "$([ "$zero_rc" = "2" ] && echo 1 || echo 0)"

typo_rc=0
typo="$("$LOKI" wow --provider claud 2>&1)" || typo_rc=$?
check "wow rejects an unknown provider instead of showing the sample" "$([ "$typo_rc" = "2" ] && has "$typo" "unknown provider 'claud'" || echo 0)$(lacksE "$typo" 'Sample Receipt')"

fac="$("$LOKI" factory --help 2>&1)"
check "factory names propose execute operate" "$(has "$fac" 'propose')$(has "$fac" 'execute')$(has "$fac" 'operate')"
check "factory says it wraps start" "$(has "$fac" 'loki start')"
check "factory help says the provider model is the default" "$(has "$fac" 'keeps the provider model')"
check "factory help does not claim haiku by default" "$(lacksE "$fac" 'start uses haiku for the first')"

tour="$("$LOKI" tour --help 2>&1)"
check "tour help still documents the sample" "$(has "$tour" 'offline')"
check "tour help points at live" "$(has "$tour" 'tour --live')"

# Live-run outcomes with a stubbed engine. SKILL_DIR is the documented override; the stub
# dir mirrors the repo except bin/loki, and a fake claude on PATH makes the provider "ready".
stub="$WORK/skill"
mkdir -p "$stub/bin" "$WORK/path"
for e in "$ROOT"/*; do
  [ "$(basename "$e")" = "bin" ] || ln -s "$e" "$stub/$(basename "$e")"
done
cat > "$stub/bin/loki" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  start)
    if [ "${WOW_STUB_RECEIPT:-0}" = "1" ]; then
      mkdir -p .loki/runs/e10-stub
      printf '%s\n' '{"verdict":"STALLED","cost":{"usd":0.01,"input_tokens":5},"not_proven":["fix repeated"]}' > .loki/runs/e10-stub/receipt.json
    fi
    exit "${WOW_STUB_RC:-0}" ;;
  verify) exit "${WOW_STUB_VERIFY_RC:-0}" ;;
esac
exit 0
STUB
chmod +x "$stub/bin/loki"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/path/claude"
chmod +x "$WORK/path/claude"
wow_live() {
  env SKILL_DIR="$stub" PATH="$WORK/path:$PATH" ANTHROPIC_API_KEY=stub TMPDIR="$WORK" "$LOKI" wow --provider claude "$@" 2>&1
}

rc=0
out="$(WOW_STUB_RECEIPT=1 WOW_STUB_RC=5 WOW_STUB_VERIFY_RC=1 wow_live)" || rc=$?
check "a STALLED live run returns its own exit code" "$([ "$rc" = "5" ] && echo 1 || echo 0)"
check "a STALLED live run shows its own receipt" "$(has "$out" 'Outcome: STALLED')"
check "a STALLED live run makes no verified claim" "$(has "$out" 'PROVEN: no verified claim (verdict STALLED)')"
check "a STALLED live run does not show the offline sample" "$(lacksE "$out" 'Sample Receipt|offline sample')"
check "a failing loki verify is reported, not hidden" "$(has "$out" 'loki verify exited 1')"
check "the temp repo is removed by default" "$(compgen -G "$WORK/loki-wow.*" >/dev/null && echo 0 || echo 1)"

rc=0
out="$(WOW_STUB_RC=1 wow_live)" || rc=$?
check "a live run with no receipt returns its exit code" "$([ "$rc" = "1" ] && echo 1 || echo 0)"
check "a live run with no receipt says the sample is not its result" "$(has "$out" 'Nothing below is the result of this run')"

rc=0
out="$(WOW_STUB_RECEIPT=1 wow_live --keep)" || rc=$?
kept="$(compgen -G "$WORK/loki-wow.*" | head -n 1)"
check "a clean live run exits 0" "$([ "$rc" = "0" ] && echo 1 || echo 0)"
check "--keep keeps the temp repo and says where" "$([ -n "$kept" ] && [ -d "$kept" ] && has "$out" "Kept: $kept" || echo 0)"

norepo="$WORK/norepo"
mkdir -p "$norepo"
empty="$(cd "$norepo" && env -u LOKI_PROVIDER "$LOKI" start 2>&1)"
check "start outside a repo shows a receipt" "$(hasE "$empty" 'VERIFIED|TAMPERED')"
check "start outside a repo points at start" "$(has "$empty" 'Ready for your repo? loki start')"
check "start outside a repo does not ask for a provider" "$(lacksE "$empty" 'npm install -g @anthropic-ai|provider CLI is not installed')"

dump="$(env -u LOKI_COST_PROFILE -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_E10_TRIM -u LOKI_TRIM_DEFAULTED -u LOKI_E10_SMALL_NO_RUNNER -u LOKI_E10_SMALL_MAX_CHARS -u LOKI_COST_FIRST -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL -u LOKI_MUTATION_STRICT -u LOKI_F2P_DEFAULTED LOKI_CONFIG_DUMP=1 "$LOKI" start ./ignored.md 2>/dev/null || true)"
check "start keeps the provider model" "$(lacksE "$dump" '^LOKI_IMPLEMENT_HAIKU_FIRST=1$')"
hai="$(env -u LOKI_COST_PROFILE -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_E10_TRIM -u LOKI_E10_SMALL_NO_RUNNER -u LOKI_E10_SMALL_MAX_CHARS -u LOKI_COST_FIRST -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL LOKI_CONFIG_DUMP=1 "$LOKI" start --haiku ./ignored.md 2>/dev/null || true)"
check "--haiku opts into haiku-first" "$(hasE "$hai" '^LOKI_IMPLEMENT_HAIKU_FIRST=1$')"
check "--haiku opts into trim" "$(hasE "$hai" '^LOKI_E10_TRIM=1$')"
check "--haiku opts into cost-first" "$(hasE "$hai" '^LOKI_COST_FIRST=1$')"
check "start turns on fail-to-pass" "$(hasE "$dump" '^LOKI_MUTATION_STRICT=1$')"
check "start trims tool logs" "$(hasE "$dump" '^LOKI_E10_TRIM=1$')"
offf2p="$(env -u LOKI_MUTATION_STRICT -u LOKI_F2P_DEFAULTED -u LOKI_E10_TRIM -u LOKI_TRIM_DEFAULTED LOKI_MUTATION_STRICT=0 LOKI_E10_TRIM=0 LOKI_CONFIG_DUMP=1 "$LOKI" start ./ignored.md 2>/dev/null || true)"
check "explicit 0 keeps fail-to-pass off" "$(hasE "$offf2p" '^LOKI_MUTATION_STRICT=0$')"
check "explicit 0 keeps trim off" "$(hasE "$offf2p" '^LOKI_E10_TRIM=0$')"
helpstrict="$(env -u LOKI_MUTATION_STRICT -u LOKI_F2P_DEFAULTED LOKI_CONFIG_DUMP=1 "$LOKI" start --help 2>/dev/null || true)"
check "help does not turn fail-to-pass on" "$(lacksE "$helpstrict" '^LOKI_MUTATION_STRICT=1$')"

# The banner names only the defaults that are on (an explicit 0 is the user's choice).
banner() { bash -c '. /dev/stdin; loki_f2p_banner' 2>&1 <<<"$(sed -n '/^loki_f2p_banner() {/,/^}/p' "$LOKI")"; }
both="$(LOKI_F2P_DEFAULTED=1 LOKI_TRIM_DEFAULTED=1 banner)"
only_trim="$(LOKI_TRIM_DEFAULTED=1 banner)"
only_f2p="$(LOKI_F2P_DEFAULTED=1 banner)"
none="$(banner)"
check "banner names both defaults when both are on" "$(has "$both" 'Wall test fails')$(has "$both" 'trimmed')"
check "banner with only trim on does not claim fail-to-pass" "$(has "$only_trim" 'trimmed')$(lacksE "$only_trim" 'Wall test')"
check "banner with only fail-to-pass on does not claim trim" "$(has "$only_f2p" 'Wall test')$(lacksE "$only_f2p" 'trimmed')"
check "banner is silent when nothing was defaulted" "$([ -z "$none" ] && echo 1 || echo 0)"

exit "$fail"
