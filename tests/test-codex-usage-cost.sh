#!/usr/bin/env bash
# Codex runs must record real tokens and real cost -- or honest "unknown".
#
# W1 in docs/WANG-PRINCIPLES-PLAN.md. Wang states the thesis conditionally:
# "the right agentic loop AND the right eval or metric for the agents to
# optimize." We had the loop and not the metric.
#
# MEASURED on a real FireLater run: EVERY efficiency record showed
# input_tokens=0, output_tokens=0, cost_usd=0. Not just cost -- nothing at all.
# `_read_iteration_cost` looks for .loki/metrics/result-cost-<n>.json or
# .loki/context/tracking.json, and codex writes NEITHER, so everything silently
# resolved to zero. A zero is a claim the iteration was free.
#
# That made cost-per-resolved-issue unmeasurable, which is the axis with a
# measured 20x industry spread (~$14/pass on Sonnet 4.5; an open harness lands
# tasks at ~1/20th Devin's cost) and the number a buyer compares first.
#
# WHY THE ROLLOUT, NOT `--json`: codex emits usage on turn.completed but only
# under `codex exec --json`. The dispatch pipes stdout through tee into logs the
# runner parses for completion signals, so switching to JSONL would change the
# format every one of those readers depends on. codex also persists
# ~/.codex/sessions/**/rollout-*.jsonl carrying total_token_usage -- a side
# channel with zero risk to the pipeline.
#
# THE PROPERTY THIS DEFENDS: unknown != free. A model we cannot price must leave
# cost ABSENT, never 0.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/codex-usage.py"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: codex usage and cost recovery"

[ -f "$HELPER" ] || { bad "helper missing: $HELPER"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }
ok "the usage helper exists"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-cxcost-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# A synthetic rollout in codex's real shape (verified against codex-cli 0.146.0:
# `{"type":"turn.completed","usage":{...}}` and a cumulative total_token_usage).
SESS="$SCRATCH/sessions/2026/08/01"
mkdir -p "$SESS"
ROLL="$SESS/rollout-2026-08-01T00-00-00-test.jsonl"
cat > "$ROLL" <<'JSONL'
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed","total_token_usage":{"input_tokens":20420,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":23,"reasoning_output_tokens":16,"total_tokens":20443}}
JSONL
touch "$ROLL"

_since=$(( $(date +%s) - 60 ))
run() { env "$@" python3 "$HELPER" "$_since" "$SCRATCH/sessions" 2>/dev/null; }

# --- tokens are recovered -----------------------------------------------------
_out="$(run _=x)"
set -- $_out
# codex reports input_tokens INCLUSIVE of cached; billing splits them, so the
# helper must emit the UNCACHED remainder (20420 - 11008 = 9412).
[ "${1:-}" = "9412" ] \
    && ok "uncached input is the remainder, not the inclusive total" \
    || bad "expected 9412 uncached input, got '${1:-}' (inclusive total would be 20420)"
[ "${2:-}" = "23" ]    && ok "output tokens recovered" || bad "output tokens: '${2:-}'"
[ "${3:-}" = "11008" ] && ok "cached tokens recovered" || bad "cached tokens: '${3:-}'"

# --- UNKNOWN IS NOT ZERO ------------------------------------------------------
# The property this file exists for.
_nomodel="$(run _=x)"
_cost="$(printf '%s' "$_nomodel" | awk '{print $5}')"
[ -z "$_cost" ] \
    && ok "no model -> cost field EMPTY (unknown), not 0" \
    || bad "unpriced run emitted a cost of '$_cost' -- claims the run was free"

_unpriced="$(run LOKI_CODEX_RESOLVED_MODEL=totally-unpriced-model)"
_cost="$(printf '%s' "$_unpriced" | awk '{print $5}')"
[ -z "$_cost" ] \
    && ok "unpriced model -> cost EMPTY, not 0" \
    || bad "unpriced model emitted cost '$_cost'"

# --- a priced model produces real cost ---------------------------------------
_priced="$(run LOKI_CODEX_RESOLVED_MODEL=gpt-5.6-sol)"
_cost="$(printf '%s' "$_priced" | awk '{print $5}')"
if [ -n "$_cost" ] && [ "$_cost" != "0.000000" ]; then
    ok "a priced model produces non-zero cost ($_cost)"
else
    bad "priced model produced no usable cost: '$_cost'"
fi

# A suffixed tier name must still price via longest-prefix match.
_sfx="$(run LOKI_CODEX_RESOLVED_MODEL=gpt-5.6-sol-high | awk '{print $5}')"
[ "$_sfx" = "$_cost" ] \
    && ok "a suffixed model name prices via prefix match" \
    || bad "gpt-5.6-sol-high priced differently ('$_sfx' vs '$_cost')"

# --- fail-safe: nothing to read must exit non-zero ---------------------------
if run _=x >/dev/null 2>&1 && python3 "$HELPER" "$(( $(date +%s) + 3600 ))" "$SCRATCH/sessions" >/dev/null 2>&1; then
    bad "a future cutoff still returned usage -- stale sessions could be attributed"
else
    ok "no matching rollout -> non-zero exit (caller records unknown)"
fi

if python3 "$HELPER" "$_since" "$SCRATCH/does-not-exist" >/dev/null 2>&1; then
    bad "a missing sessions dir returned success"
else
    ok "a missing sessions dir exits non-zero"
fi

# --- WIRING -------------------------------------------------------------------
if grep -q 'lib/codex-usage.py' "$RUN_SH"; then
    ok "WIRING: run.sh calls the usage helper"
else
    bad "WIRING: nothing calls codex-usage.py -- codex cost stays zero"
fi

if grep -q '_loki_codex_usage_since="\$(date' "$RUN_SH"; then
    ok "WIRING: the mtime cutoff is stamped before the codex call"
else
    bad "WIRING: no cutoff stamp -- a stale session could be attributed to this iteration"
fi

# total_cost_usd must be written ONLY when priced. Writing it unconditionally
# would put a 0 in the file and re-create the exact defect.
_blk="$(grep -A22 'lib/codex-usage.py' "$RUN_SH")"
case "$_blk" in
    *'if [ -n "${5:-}" ]; then'*)
        ok "WIRING: total_cost_usd is written only when the model was priced" ;;
    *) bad "WIRING: cost is written unconditionally -- an unpriced run records 0" ;;
esac

# --- the pricing table must cover the shipped codex tiers --------------------
_missing=""
for m in gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna; do
    grep -q "\"$m\"" "$REPO_ROOT/loki-ts/data/model-pricing.json" || _missing="$_missing $m"
done
[ -z "$_missing" ] \
    && ok "every shipped codex tier is priced" \
    || bad "unpriced codex tiers:$_missing -- those runs record cost unknown"

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
