#!/usr/bin/env bash
# `loki next` and `loki resume` must not contradict each other.
#
# THE DEFECT, reproduced before the fix: cmd_next maps max_iterations_reached
# and budget_exceeded to "Will run: loki resume", but the resume hint helper
# accepted ONLY status "interrupted". So `loki next` told the user to run
# `loki resume`, and `loki resume` answered "No session to resume. Start a
# session with: loki start" -- and exited 0, so nothing anywhere went red.
# The two commands whose entire job is "do the right next thing" disagreed on
# every run that stopped at a limit.
#
# WHAT IS LOAD-BEARING, and why this suite drives BOTH commands rather than
# asserting on either one: a test that only checked `loki resume` prints
# something useful would stay green if cmd_next later drifted to a different
# verb. The agreement is the property under test, so the announced command is
# READ OUT of `loki next` and that exact command is then run.
#
# THE OVER-CORRECTION THIS ALSO GUARDS: widening the helper to accept a
# VERDICT status (council_approved) would send an approved, shipped build back
# into the iteration loop. That is worse than the silence it replaces, so the
# refusal is asserted as explicitly as the acceptance.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-next-resume-agree"

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 unavailable: agreement was NOT measured (unmeasured, not clean)"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# Build a project dir whose only state is a finished-run status.
mk_state() {
    local dir="$WORK/$1" status="$2" prd="${3:-}"
    mkdir -p "$dir/.loki"
    _S="$status" _P="$prd" python3 -c "
import json, os
json.dump({'status': os.environ['_S'], 'iteration': 9,
           'lastRun': '2026-09-12T10:00:00Z',
           'prdPath': os.environ['_P']},
          open(os.path.join(os.environ['_D'], '.loki', 'autonomy-state.json'), 'w'))
" _D="$dir" 2>/dev/null || _D="$dir" _S="$status" _P="$prd" python3 -c "
import json, os
json.dump({'status': os.environ['_S'], 'iteration': 9,
           'lastRun': '2026-09-12T10:00:00Z',
           'prdPath': os.environ['_P']},
          open(os.path.join(os.environ['_D'], '.loki', 'autonomy-state.json'), 'w'))
"
    printf '%s\n' "$dir"
}

# The literal dead-end string the defect produced. Kept in one place so a
# reworded message updates every assertion at once.
DEAD_END="No session to resume"

# --- The resumable-limit statuses: next and resume must AGREE -----------------
for status in max_iterations_reached budget_exceeded interrupted; do
    dir="$(mk_state "ok_$status" "$status")"

    next_out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" next --dry-run 2>&1)"
    # Read the verb cmd_next actually announces rather than hardcoding it here.
    announced="$(printf '%s' "$next_out" | sed -n 's/.*Will run *: *//p' | tr -d '\r' | head -1)"

    if [ "$announced" = "loki resume" ]; then
        pass "$status: loki next announces 'loki resume'"
    else
        fail "$status: loki next announced '$announced', not 'loki resume' (map drifted)"
        continue
    fi

    # Run the command it announced. It must not dead-end.
    resume_out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
    case "$resume_out" in
        *"$DEAD_END"*)
            fail "$status: next said 'loki resume' but resume printed '$DEAD_END'" ;;
        *)
            pass "$status: the announced command does not dead-end" ;;
    esac

    # Vacuity guard: an empty output would pass the case above while telling the
    # user nothing at all.
    if [ -n "${resume_out//[[:space:]]/}" ]; then
        pass "$status: resume produced actual guidance"
    else
        fail "$status: resume printed nothing; the assertion above was vacuous"
    fi
done

# --- A capped run must be told to RAISE THE LIMIT, not just re-run ------------
# Resuming a capped run unchanged hits the same wall on the next iteration, so
# advice that omits the cap has moved the contradiction rather than closed it.
dir="$(mk_state "cap_advice" "max_iterations_reached")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if grep -q 'LOKI_MAX_ITERATIONS' <<<"$out"; then
    pass "an iteration-capped run is told to raise LOKI_MAX_ITERATIONS"
else
    fail "capped run advice omits the cap; resuming as-is hits the same limit"
fi

dir="$(mk_state "budget_advice" "budget_exceeded")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if grep -q 'LOKI_BUDGET_LIMIT' <<<"$out"; then
    pass "a budget-capped run is told to raise LOKI_BUDGET_LIMIT"
else
    fail "budget run advice omits the budget; resuming as-is hits the same limit"
fi

# --- A CAPPED RUN MUST NOT PROMISE A RESUMED ITERATION ------------------------
# My first version of this fix printed "Stopped at iteration N ... It picks up
# from iteration N" for capped runs. That is FALSE: load_state resets
# ITERATION_COUNT=0 for max_iterations_reached and budget_exceeded (the
# failure-terminals case arm in autonomy/run.sh), so a fresh `loki start` is a
# NEW session from 0. The number promised a continuation the runtime does not
# honour. tests/test-resume-discoverability.sh caught it in CI, not here --
# this suite passed the wrong implementation, so the assertion is added now.
#
# Only `interrupted` genuinely resumes its count.
for status in max_iterations_reached budget_exceeded; do
    dir="$(mk_state "noiter_$status" "$status")"
    out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
    # mk_state writes iteration 9; it must not appear as a promised pick-up.
    if grep -q 'picks up from iteration' <<<"$out"; then
        fail "$status: promises to pick up from an iteration that load_state resets to 0"
    else
        pass "$status: does not promise a resumed iteration count"
    fi
done

# Positive control: `interrupted` MUST still promise the pick-up, or the
# assertion above would pass on an implementation that dropped it everywhere.
dir="$(mk_state "iter_interrupted" "interrupted")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if grep -q 'picks up from iteration' <<<"$out"; then
    pass "interrupted: still promises the pick-up (it genuinely resumes)"
else
    fail "interrupted lost its pick-up line; the assertion above was vacuous"
fi

# --- THE OVER-CORRECTION: a VERDICT status must still refuse ------------------
# council_approved routes to `loki ship`. If the hint helper ever accepts it,
# an approved build gets invited back into the iteration loop.
for status in council_approved council_force_approved completion_promise_fulfilled; do
    dir="$(mk_state "verdict_$status" "$status")"
    out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
    if grep -q "$DEAD_END" <<<"$out"; then
        pass "$status: resume correctly refuses (it routes to loki ship)"
    else
        fail "$status: resume offered to continue an APPROVED build -- worse than silence"
    fi
done

# --- A stale spec path must not produce a command that fails on paste ---------
dir="$(mk_state "stale_prd" "max_iterations_reached" "/nonexistent/definitely-gone.md")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if grep -q 'definitely-gone.md' <<<"$out"; then
    fail "a stale prdPath was interpolated; the printed command fails on paste"
else
    pass "a stale prdPath degrades to bare 'loki start'"
fi

# A LIVE spec path must still be interpolated, or the command resumes a
# different run than the one being reported. This is the positive control for
# the assertion above: without it, a helper that never interpolates would pass.
mkdir -p "$WORK/live_prd"
printf 'spec\n' > "$WORK/live_prd/spec.md"
dir="$(mk_state "live_prd" "max_iterations_reached" "$WORK/live_prd/spec.md")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if grep -q 'spec.md' <<<"$out"; then
    pass "a live prdPath is interpolated into the resume command"
else
    fail "a live prdPath was dropped; the command would resume a different run"
fi

# --- P12-07b: a bare `loki start --resume` reaches the engine10 resume path ----
# Before the fix cmd_start ignored --resume and began a new build. A stub entry
# records the argv the delegate receives, so the route is read out, not assumed.
if command -v bun >/dev/null 2>&1; then
    stub="$WORK/stub-entry.js"
    printf 'console.log("STUB-ARGV:" + process.argv.slice(2).join(" ")); process.exit(process.argv[2] === "engine10" ? Number(process.env.STUB_RC || 0) : 0);\n' > "$stub"
    dir="$WORK/start_resume"; mkdir -p "$dir"
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume 2>&1)"; rc=$?
    case "$out" in
        *"STUB-ARGV:engine10 --resume"*) pass "start --resume delegates to engine10 resume" ;;
        *) fail "start --resume did not reach engine10 resume: $out" ;;
    esac
    [ "$rc" -eq 0 ] && pass "start --resume exit 0 when resume succeeds" || fail "start --resume rc=$rc, expected 0"
    out="$(cd "$dir" && STUB_RC=4 LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume e10-abc 2>&1)"; rc=$?
    case "$out" in
        *"STUB-ARGV:engine10 --resume e10-abc"*) pass "start --resume passes the run id through" ;;
        *) fail "start --resume dropped the run id: $out" ;;
    esac
    [ "$rc" -eq 4 ] && pass "an engine exit 4 (cannot resume, or a resumed run that ended BLOCKED; EXIT.BLOCKED is also 4) is returned unchanged, never 0" || fail "rc=$rc, expected 4: the resume was reported as success but resumed nothing"
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start "fix the login bug" --resume 2>&1)"; rc=$?
    [ "$rc" -eq 2 ] && pass "start <task> --resume is refused with exit 2" || fail "start <task> --resume rc=$rc, expected 2"
    case "$out" in
        *"takes an optional run id, not a task"*) pass "refusal names the run-id-only rule" ;;
        *) fail "refusal message missing: $out" ;;
    esac
    case "$out" in *STUB-ARGV*) fail "task text reached the delegate" ;; *) pass "task text never reaches the delegate" ;; esac
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --provider claude --budget 5 --resume 2>&1)"; rc=$?
    case "$out" in
        *"STUB-ARGV:engine10 --resume"*) pass "start --provider claude --budget 5 --resume reaches engine10 resume" ;;
        *) fail "value flags around --resume were refused: $out" ;;
    esac
    case "$out" in *"STUB-ARGV:engine10 --resume claude"*|*"--resume 5"*) fail "a flag value leaked as a run id: $out" ;; *) pass "flag values are not passed as run ids" ;; esac
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume --provider claude e10-abc --budget 5 2>&1)"
    case "$out" in
        *"STUB-ARGV:engine10 --resume e10-abc"*) pass "run id kept when value flags surround it" ;;
        *) fail "run id lost around value flags: $out" ;;
    esac
    # P12-07e: --brief consumes the next token, so its text is never a run id.
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume --brief "build a todo app" 2>&1)"; rc=$?
    case "$out" in
        *"STUB-ARGV:engine10 --resume"*) pass "start --resume --brief TEXT reaches engine10 resume" ;;
        *) fail "--brief text was misparsed as a run id: $out" ;;
    esac
    case "$out" in *"build a todo app"*"STUB-ARGV"*|*"STUB-ARGV"*"build a todo app"*) fail "--brief text leaked to the delegate: $out" ;; *) pass "--brief text never reaches the delegate" ;; esac
    # P12-07f: --mirofish takes an optional URL, --mirofish-docker a required image.
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume --mirofish http://x 2>&1)"; rc=$?
    case "$out" in
        *"STUB-ARGV:engine10 --resume"*) pass "start --resume --mirofish URL reaches engine10 resume" ;;
        *) fail "--mirofish URL was misparsed as a run id: $out" ;;
    esac
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume --mirofish --provider claude 2>&1)"; rc=$?
    case "$out" in
        *"STUB-ARGV:engine10 --resume"*) pass "start --resume --mirofish before another flag reaches engine10 resume" ;;
        *) fail "bare --mirofish broke the scan: $out" ;;
    esac
    out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume --mirofish-docker img 2>&1)"; rc=$?
    case "$out" in
        *"STUB-ARGV:engine10 --resume"*) pass "start --resume --mirofish-docker IMG reaches engine10 resume" ;;
        *) fail "--mirofish-docker image was misparsed as a run id: $out" ;;
    esac
    # P12-07k: the scan consumes only the value of an allowlisted valued flag, and an unknown flag (even a Bun-route-only one) exits 64 so its value is never read as a run id.
    # Tolerance: a pair here only has to be skipped by the scan; the legacy bash route need not honor the flag.
    for pair in "--provider claude" "--budget 4" "--max-duration 30m" "--log-level debug" "--isolation none"; do
        # shellcheck disable=SC2086 # intentional split: "$pair" is flag plus value
        out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume $pair 2>&1)"
        case "$out" in
            *"STUB-ARGV:engine10 --resume"*) pass "start --resume $pair reaches engine10 resume" ;;
            *) fail "'$pair' value was misparsed as a run id: $out" ;;
        esac
    done
    for pair in "--model sonnet" "--max-wait 30" "--foo bar"; do
        # shellcheck disable=SC2086 # intentional split: "$pair" is flag plus value
        out="$(cd "$dir" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume $pair 2>&1)"; rc=$?
        if [ "$rc" -eq 64 ] && [[ "$out" == *"Unknown option: ${pair%% *}"* ]]; then pass "start --resume $pair exits 64"; else fail "start --resume $pair rc=$rc: $out"; fi
    done
    # The --workspace brief scan reads the same allowlist as the --resume scan.
    out="$(cd "$dir" && bash -c 'source <(sed -n "/^_loki_start_flag_kind()/,/^}/p" "$1"); for f in --provider --mirofish --resume --fast; do _loki_start_flag_kind "$f" || echo "MISSING $f"; done; for f in --model --max-cost --max-wait; do ! _loki_start_flag_kind "$f" || echo "UNEXPECTED $f"; done' _ "$LOKI_BIN" 2>&1)"
    [ -z "$out" ] && pass "shared allowlist knows start flags and rejects Bun-only ones" || fail "shared list gaps: $out"
    # start --resume passes the stage-resume code through; the reporter command `loki resume` still maps 5 to 1.
    out="$(cd "$dir" && STUB_RC=5 LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume 2>&1)"; rc_start=$?
    mkdir -p "$dir/.loki/runs/e10-parity"; : > "$dir/.loki/runs/e10-parity/events.jsonl"
    out="$(cd "$dir" && STUB_RC=5 LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"; rc_resume=$?
    if [ "$rc_start" -eq 5 ] && [ "$rc_resume" -eq 1 ]; then pass "exit 5 passes through start --resume and maps to 1 in resume"; else fail "exit 5: start=$rc_start resume=$rc_resume, expected 5 and 1"; fi
    out="$(cd "$dir" && STUB_RC=3 LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume 2>&1)"; rc=$?
    [ "$rc" -eq 3 ] && pass "nothing to resume (3) is not turned into a new build" || fail "rc=$rc, expected 3"

    # #352: the REAL entry, not a stub. A seeded interrupted run (settled intake, plan and wall; the cap already hit so no model is spawned) must
    # reach the stage resume (resumeFlag), whose first line is "engine10: resume from stage", and exit 2 (refused: cap hit), never the reporter's 0.
    real="$WORK/real_resume"; mkdir -p "$real/.loki/runs/e10-seeded"
    git -C "$real" init -q . 2>/dev/null; git -C "$real" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base 2>/dev/null
    git -C "$real" branch loki/e10-seeded 2>/dev/null
    python3 - "$real/.loki/runs/e10-seeded/events.jsonl" "$(git -C "$real" rev-parse HEAD)" <<'PY'
import json, sys
rows = [("run.started", None, {"provider": "claude", "model": ""}),
        ("stage.completed", "intake", {"base_sha": sys.argv[2], "source": "text", "task": "t"}),
        ("stage.completed", "plan", {}), ("stage.completed", "wall", {}), ("cap.hit", None, {})]
with open(sys.argv[1], "w") as f:
    for i, (t, st, d) in enumerate(rows):
        f.write(json.dumps({"v": 1, "seq": i, "ts": "2026-01-01T00:00:%02dZ" % i, "run": "e10-seeded", "type": t, "stage": st, "data": d}) + "\n")
PY
    out="$(cd "$real" && env -u LOKI_ENGINE -u LOKI_TS_ENTRY BUN_FROM_SOURCE=1 LOKI_LEGACY_BASH=1 LOKI_TELEMETRY_DISABLED=1 timeout -k 5 120 bash "$LOKI_BIN" start --resume 2>&1)"; rc=$?
    case "$out" in
        *"engine10: resume from stage implement"*) pass "start --resume on a seeded interrupted run reaches the stage resume (resumeFlag)" ;;
        *) fail "start --resume did not reach resumeFlag on a seeded interrupted run: $out" ;;
    esac
    [ "$rc" -eq 2 ] && pass "a refused stage resume exits non-zero (2), not 0" || fail "real route rc=$rc, expected 2: $out"
    # cw17b: a run whose base commit is gone cannot resume; the real route exits 4 with the new-run action, not 2.
    sed -i.bak "s/$(git -C "$real" rev-parse HEAD)/$(printf 'b%.0s' $(seq 40))/" "$real/.loki/runs/e10-seeded/events.jsonl" && rm -f "$real/.loki/runs/e10-seeded/events.jsonl.bak"
    out="$(cd "$real" && env -u LOKI_ENGINE -u LOKI_TS_ENTRY BUN_FROM_SOURCE=1 LOKI_LEGACY_BASH=1 LOKI_TELEMETRY_DISABLED=1 timeout -k 5 120 bash "$LOKI_BIN" start --resume 2>&1)"; rc=$?
    if [ "$rc" -eq 4 ] && [[ "$out" == *"cannot be resumed (its base commit bbbbbbbbbbbb is gone from this repo); its work is on branch loki/e10-seeded. Start a new run: loki start <task>"* ]]; then pass "a run whose base commit is gone exits 4 with the new-run action"; else fail "gone base commit rc=$rc, expected 4: $out"; fi
else
    fail "bun unavailable: start --resume route was NOT measured (unmeasured, not clean)"
fi

# PG-25: `loki next --suggest` with no run proposes up to 3 small tasks; est_usd comes from `loki estimate` only (L0).
sg="$WORK/suggest"; mkdir -p "$sg/bin"; git -C "$sg" init -q . 2>/dev/null
printf '%s\n' '#!/bin/sh' 'case "$1" in auth) exit 0 ;; issue) echo "[{\"number\":1,\"title\":\"first bug\"},{\"number\":2,\"title\":\"second bug\"}]" ;; esac' > "$sg/bin/gh"; chmod +x "$sg/bin/gh"
for i in 1 2 3 4 5; do printf '// TODO item %s\n' "$i" > "$sg/f$i.txt"; done
git -C "$sg" add . 2>/dev/null
out="$(cd "$sg" && PATH="$sg/bin:$PATH" LOKI_TELEMETRY_DISABLED=1 bash "$LOKI_BIN" next --suggest 2>&1)"; rc=$?
n="$(printf '%s\n' "$out" | grep -c 'est_usd')"
if [ "$rc" -eq 0 ] && [ "$n" -eq 3 ] && [[ "$out" == *"est_usd NOT AVAILABLE ("* ]] && ! printf '%s' "$out" | grep -Eq 'est_usd [0-9$]' && [[ "$out" == *"[issue] #1 first bug"* ]]; then pass "next --suggest prints 3 suggestions with source; no history means NOT AVAILABLE and no fabricated number"; else fail "next --suggest rc=$rc n=$n: $out"; fi
out="$(cd "$sg" && PATH="$sg/bin:$PATH" LOKI_TELEMETRY_DISABLED=1 bash "$LOKI_BIN" next --suggest --json 2>&1)"
if printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin)["suggestions"]; assert len(d)==3 and all("source" in x and x["est_usd"] is None for x in d)' 2>/dev/null; then pass "next --suggest --json is valid JSON with 3 suggestions and est_usd null without history"; else fail "next --suggest --json invalid: $out"; fi
printf '%s\n' '#!/bin/sh' 'exit 1' > "$sg/bin/gh"
out="$(cd "$sg" && PATH="$sg/bin:$PATH" LOKI_TELEMETRY_DISABLED=1 bash "$LOKI_BIN" next --suggest 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [[ "$out" == *"issues skipped"* ]] && [ "$(printf '%s\n' "$out" | grep -c 'est_usd')" -eq 3 ]; then pass "gh failure skips issues with a note and still yields 3"; else fail "gh failure rc=$rc: $out"; fi
# est_usd is passed through from the estimator when it has a number (stub entry stands in for loki-ts).
printf '%s\n' 'console.log(JSON.stringify({ok:true,est:{shape:"s",runs:3,usd:[0.5,1.5],wall_s:null}}))' > "$sg/est.js"
out="$(cd "$sg" && LOKI_TS_ENTRY="$sg/est.js" PATH="$sg/bin:$PATH" LOKI_TELEMETRY_DISABLED=1 bash "$LOKI_BIN" next --suggest --json 2>&1)"
if printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin)["suggestions"]; assert d and all(x["est_usd"]==[0.5,1.5] for x in d)' 2>/dev/null; then pass "est_usd is the estimator's range when it has history"; else fail "est_usd passthrough: $out"; fi
out="$(cd "$WORK" && mkdir -p empty && cd empty && git init -q . 2>/dev/null; PATH="$sg/bin:$PATH" LOKI_TELEMETRY_DISABLED=1 bash "$LOKI_BIN" next --suggest 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [[ "$out" == *"No suggestions"* ]]; then pass "an empty repo yields no suggestions (up to 3, not exactly 3)"; else fail "empty repo rc=$rc: $out"; fi
# A hung estimator must not hang `loki next --suggest`: bounded, est_usd null, with a note.
printf '%s\n' 'await new Promise(r => setTimeout(r, 60000))' > "$sg/hang.js"
t0=$SECONDS
out="$(cd "$sg" && LOKI_NEXT_ESTIMATE_TIMEOUT=2 LOKI_TS_ENTRY="$sg/hang.js" PATH="$sg/bin:$PATH" LOKI_TELEMETRY_DISABLED=1 timeout -k 5 30 bash "$LOKI_BIN" next --suggest --json 2>&1)"; rc=$?
el=$((SECONDS - t0))
if [ "$rc" -eq 0 ] && [ "$el" -lt 25 ] && printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["suggestions"] and all(x["est_usd"] is None for x in d["suggestions"]); assert any("estimate unavailable" in n for n in d["notes"])' 2>/dev/null; then pass "a hung estimator is bounded: returns in ${el}s with est_usd null and an estimate-unavailable note"; else fail "hung estimator rc=$rc elapsed=${el}s: $out"; fi

# A hung gh must not hang the command: each of the two gh calls has its own timeout (shortened here by env).
mkdir -p "$sg/.loki/quality"
printf '%s' '{"pass":false,"runner":"stubrunner","summary":"1 failed"}' > "$sg/.loki/quality/test-results.json"
for mode in auth list; do
    mkdir -p "$sg/hang/$mode"
    if [ "$mode" = auth ]; then
        printf '%s\n' '#!/bin/sh' 'exec sleep 600' > "$sg/hang/$mode/gh"
    else
        printf '%s\n' '#!/bin/sh' 'case "$1" in auth) exit 0 ;; *) exec sleep 600 ;; esac' > "$sg/hang/$mode/gh"
    fi
    chmod +x "$sg/hang/$mode/gh"
    out="$(cd "$sg" && PATH="$sg/hang/$mode:$PATH" LOKI_NEXT_GH_AUTH_TIMEOUT=1 LOKI_NEXT_GH_LIST_TIMEOUT=1 LOKI_TELEMETRY_DISABLED=1 timeout -k 5 60 bash "$LOKI_BIN" next --suggest 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ] && [[ "$out" == *"issues skipped"* ]] && [[ "$out" == *"[todo]"* ]] && [[ "$out" == *"[failing_test]"* ]]; then pass "a hung gh ($mode call) times out, notes issues skipped, still returns todo and test suggestions"; else fail "hung gh ($mode) rc=$rc: $out"; fi
done

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
