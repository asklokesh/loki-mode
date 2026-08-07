#!/usr/bin/env bash
# Decision records are actually WRITTEN by the runtime, not merely writable.
#
# THE GAP THIS CLOSES. tests/test-decision-record.sh proves the module behaves --
# it refuses a record with no model_id, it drops non-allowlisted fields, it
# reports a model swap. None of that mattered while nothing in autonomy/run.sh
# ever called it: a capability nothing invokes is not a capability, and a module
# test stays green forever after the call site is deleted.
#
# So this test extracts the call site from autonomy/run.sh VERBATIM and executes
# it. It fails if the block is removed, stops writing a record, loses model_id
# (the field that makes a silent model swap detectable), or starts fabricating
# tokens the runtime does not actually know. Reading the block out of run.sh
# rather than copying it is deliberate: a copied fixture drifts silently, and
# then this test proves something about a block that no longer ships.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull lines from the "# LLM DECISION RECORD" comment through its closing fi.
START=$(grep -n "# LLM DECISION RECORD" "$REPO/autonomy/run.sh" | cut -d: -f1)
# End at the line after the backgrounded spawn: that is the block's closing fi.
SPAWN=$(awk -v s="$START" 'NR>=s && /decision_record\.py" record/ {print NR; exit}' "$REPO/autonomy/run.sh")
END=$(awk -v s="$SPAWN" 'NR>s && /^        fi$/ {print NR; exit}' "$REPO/autonomy/run.sh")
sed -n "${START},${END}p" "$REPO/autonomy/run.sh" > "$WORK/block.sh"
grep -q 'decision_record\.py" record' "$WORK/block.sh" || { echo "FAIL: block extract"; exit 1; }

DR_LINES() {
  local f="$1/.loki/decisions/decisions.jsonl"
  [ -f "$f" ] || { echo 0; return 0; }
  wc -l < "$f" 2>/dev/null || echo 0
}

run_block() {
  # Snapshot BEFORE the call: the wait below needs the pre-call count.
  local want=$(( $(DR_LINES "$1") + 1 ))
  # Wrap in a function so the block's `local` declarations are legal.
  { echo '_t() {'; cat "$WORK/block.sh"; echo '}'; echo '_t'; } > "$WORK/run.sh"
  ( cd "$1" && SCRIPT_DIR="$REPO/autonomy" TARGET_DIR="$1" \
      tier_param="$2" PROVIDER_NAME="$3" ITERATION_COUNT=7 rarv_phase=act \
      exit_code="$4" duration=12 LOKI_TRUST_RUN_ID="${5:-}" LOKI_SESSION_ID="" \
      bash "$WORK/run.sh" )
  # Backgrounded by design. Wait for the LINE COUNT to grow, not for the file to
  # exist: on a second call the file is already there, so an existence check
  # returns before the detached writer appends and the harness races itself.
  local i=0
  while [ $i -lt 50 ]; do
    [ "$(DR_LINES "$1")" -ge "$want" ] && return 0
    sleep 0.1; i=$((i+1))
  done
}

fail=0
chk() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }

# 1. No cost file: record written, model_id present, tokens OMITTED not zeroed.
P="$WORK/p1"; mkdir -p "$P"
run_block "$P" "opus" "claude" 0 "run-abc"
J=$(cat "$P/.loki/decisions/decisions.jsonl")
chk "model_id is dispatched model" "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["model_id"])')" "opus"
chk "provider"   "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["provider"])')" "claude"
chk "outcome ok" "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["outcome"])')" "ok"
chk "stage"      "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["stage"])')" "iteration_7_act"
chk "run_id"     "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["run_id"])')" "run-abc"
chk "no tokens without a cost file" "$(echo "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("tokens_in" in d or "tokens_out" in d)')" "False"
chk "no invented temperature" "$(echo "$J" | python3 -c 'import json,sys;print("temperature" in json.load(sys.stdin))')" "False"

# 2. Real cost file: tokens sourced honestly.
P="$WORK/p2"; mkdir -p "$P/.loki/metrics"
echo '{"input_tokens":1234,"output_tokens":56,"total_cost_usd":1.5}' > "$P/.loki/metrics/result-cost-7.json"
run_block "$P" "sonnet" "codex" 1 "run-xyz"
J=$(cat "$P/.loki/decisions/decisions.jsonl")
chk "tokens_in"  "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tokens_in"])')" "1234"
chk "tokens_out" "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tokens_out"])')" "56"
chk "outcome error on nonzero exit" "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["outcome"])')" "error"

# 3. Corrupt cost file must not fabricate tokens and must not break the record.
P="$WORK/p3"; mkdir -p "$P/.loki/metrics"
echo 'not json at all' > "$P/.loki/metrics/result-cost-7.json"
run_block "$P" "haiku" "aider" 0 ""
J=$(cat "$P/.loki/decisions/decisions.jsonl")
chk "record still written on corrupt cost" "$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["model_id"])')" "haiku"
chk "no fabricated tokens" "$(echo "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("tokens_in" in d)')" "False"
chk "no empty run_id key" "$(echo "$J" | python3 -c 'import json,sys;print("run_id" in json.load(sys.stdin))')" "False"

# 4. Model swap across two iterations is DETECTABLE - the whole point.
P="$WORK/p4"; mkdir -p "$P"
run_block "$P" "sonnet" "claude" 0 "run-1"
rm -f "$P/.loki/decisions/decisions.jsonl.seen"; sleep 0.2
run_block "$P" "opus" "claude" 0 "run-1"
S=$(cd "$P" && LOKI_DIR="$P/.loki" python3 "$REPO/autonomy/lib/decision_record.py" summary)
chk "model_changed detected" "$(echo "$S" | python3 -c 'import json,sys;print(json.load(sys.stdin)["model_changed"])')" "True"
chk "two records appended"   "$(echo "$S" | python3 -c 'import json,sys;print(json.load(sys.stdin)["records"])')" "2"

# 5. Missing module must be a clean no-op, never a failure.
P="$WORK/p5"; mkdir -p "$P"
( cd "$P" && SCRIPT_DIR="$WORK/nonexistent" TARGET_DIR="$P" tier_param="opus" \
    PROVIDER_NAME="claude" ITERATION_COUNT=1 rarv_phase=act exit_code=0 duration=1 \
    LOKI_TRUST_RUN_ID="" LOKI_SESSION_ID="" bash "$WORK/run.sh" ) ; rc=$?
chk "absent module exits clean" "$rc" "0"
chk "absent module writes nothing" "$([ -e "$P/.loki/decisions" ] && echo yes || echo no)" "no"

[ "$fail" = "0" ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
