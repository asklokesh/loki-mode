#!/usr/bin/env bash
# Engine end to end on the stub provider: the real bin/loki -> committed Bun
# bundle -> engine10 pipeline on a throwaway repo, with a stub `claude` that adds
# multiply() to calc.ts. No network, no model, no real key (a throwaway signing
# key lives in the temp dir). Asserts:
#   done run:   exit 0, "Receipt: VERIFIED", `loki verify` says VERIFIED, and the
#               stub session never saw the canary GH_TOKEN (Rule of Two).
#   tamper run: the stub forges an event mid-run; the run must end TAMPERED and
#               exit non-zero, never VERIFIED.
#   after the fact: one appended line in events.jsonl turns VERIFIED into TAMPERED.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. tests/min/fixtures/e2e/bin/claude: in the done branch print LOKI_DONE
#      without appending multiply() (the run must stop reading VERIFIED).
#   2. this script: pass LOKI_ALLOW_AGENT_GITHUB_TOKEN=1 to the engine (the
#      opt-out that hands the token to the agent); the canary assertion must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
cd "$ROOT" || exit 2

echo "TEST: engine10 end to end on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
CANARY="ghp_E2ECANARYnotarealtoken0000000000000"
TASK="add a multiply(a, b) function to calc.ts"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# run_engine <mode> -> sets REPO, RC, OUT, RUNDIR, STUBENV, KEY
run_engine() {
    local mode="$1" d
    d="$(mktemp -d "$T/run.XXXXXX")"
    REPO="$d/repo"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    KEY="$d/k.pem"
    STUBENV="$d/stub-env.log"
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" \
        E2E_STUB_MODE="$mode" E2E_STUB_LOG="$d/stub.log" E2E_STUB_ENV_LOG="$STUBENV" \
        LOKI_E10_PLAN=1 GH_TOKEN="$CANARY" LOKI_RECEIPT_SIGNING_KEY_FILE="$KEY" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr 2>&1)"
    RC=$?
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        local rid
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
        # the run ends with the checkout back on main and its work on loki/<rid>; look at that work there
        [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
    fi
}

verify_run() { # verify_run -> "<rc> <verdict>"
    local out rc
    out="$(LOKI_RECEIPT_SIGNING_KEY_FILE="$KEY" bash "$ROOT/bin/loki" verify "$RUNDIR/receipt.json" 2>&1)"; rc=$?
    printf '%s %s\n' "$rc" "$(printf '%s\n' "$out" | sed -n 's/^verdict: //p' | head -1)"
}

run_engine done
[ "$RC" -eq 0 ] && ok "done run exits 0" || { bad "done run exited $RC"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "done run prints Outcome: VERIFIED" || bad "done run did not print Outcome: VERIFIED"
grep -q 'export function multiply' "$REPO/calc.ts" && ok "stub's change landed in calc.ts" || bad "calc.ts has no multiply()"
if [ -n "$RUNDIR" ] && [ -f "$RUNDIR/receipt.json" ]; then
    r="$(verify_run)"
    [ "$r" = "0 VERIFIED" ] && ok "loki verify on the run receipt: VERIFIED rc 0" || bad "loki verify gave: $r"
    cp "$RUNDIR/events.jsonl" "$T/events.orig"
    echo '{"v":1,"type":"forged"}' >> "$RUNDIR/events.jsonl"
    r="$(verify_run)"
    [ "$r" = "1 TAMPERED" ] && ok "event appended after the run: TAMPERED rc 1" || bad "edited log gave: $r"
else
    bad "done run left no receipt.json (run dir: '${RUNDIR}')"
fi
if [ -s "$STUBENV" ]; then
    grep -q "$CANARY" "$STUBENV" && bad "the agent session received the GitHub token (Rule of Two broken)" || ok "agent session never saw the GitHub token"
else
    bad "stub env log is empty (the stub never ran)"
fi

run_engine tamper
[ "$RC" -ne 0 ] && ok "tampered run exits non-zero" || bad "tampered run exited 0"
printf '%s\n' "$OUT" | grep -Eq '^Receipt:[[:space:]]+TAMPERED' && ok "tampered run prints Receipt: TAMPERED" || bad "tampered run did not print Receipt: TAMPERED"
printf '%s\n' "$OUT" | grep -q 'Outcome:    VERIFIED' && bad "tampered run claimed Outcome: VERIFIED" || ok "tampered run never claims Outcome: VERIFIED"

finish
