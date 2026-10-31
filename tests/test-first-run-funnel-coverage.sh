#!/usr/bin/env bash
# First-run funnel coverage.
#
# WHY THIS EXISTS. The funnel was built well and pointed away from users.
# `loki_emit_funnel_once` / `loki_emit_first_run_blocked` (autonomy/telemetry.sh)
# already sent a once-per-machine, bounded-enum, opt-out-respecting signal -- but
# `first_run_blocked` fired from exactly ONE call site, inside doctor's failure
# branch. Every other way a first run dies emitted nothing:
#
#   - the four provider_offer_gate exits (loki start / demo / quick / quickstart)
#   - the auth preflight in run.sh, reached only AFTER the user confirms the spend
#
# `first_start_attempted` still fired, so the data said a first run was ATTEMPTED
# and nothing about whether it survived. An attempt that died for want of a
# provider CLI was indistinguishable from one that shipped a working build. With
# ~19k npm downloads in 30 days and zero user-filed bugs, that blind spot IS the
# adoption question: we could not tell whether trials failed on capability,
# discoverability or trust.
#
# These assertions are about WIRING, not about network delivery. They prove the
# emit is reachable from each wall and that what it sends stays bounded. They
# deliberately never enable analytics or send anything.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: first-run funnel covers the walls users actually hit"

# --- 1. The provider gate reports, from ONE site covering all four callers ----
# Emitting from the gate rather than from each caller is the point: four copies
# drift, and a future caller of the gate would be silently uninstrumented.
if grep -q '_provider_gate_emit_blocked' "$REPO_ROOT/autonomy/provider-offer.sh"; then
    ok "provider_offer_gate reports a blocked first run"
else
    bad "provider_offer_gate does not report -- start/demo/quick/quickstart exit 2 silently"
fi

# Both failure paths must report: the declined-install path AND the
# installed-but-still-absent path. Missing either leaves a real wall dark.
_gate_body="$(sed -n '/^provider_offer_gate()/,/^}/p' "$REPO_ROOT/autonomy/provider-offer.sh")"
_gate_emits="$(printf '%s' "$_gate_body" | grep -c '_provider_gate_emit_blocked')"
if [ "$_gate_emits" -ge 2 ]; then
    ok "both gate failure paths report (declined install, and install-then-still-absent)"
else
    bad "only $_gate_emits of 2 gate failure paths report"
fi

# The gate's success path must stay silent -- a funnel that fires on success
# would make "blocked" meaningless.
if printf '%s' "$_gate_body" | grep -q 'detect_any_provider && return 0'; then
    ok "the success path returns without reporting"
else
    bad "the gate's success path changed shape; re-check that success stays silent"
fi

# --- 2. The post-consent auth wall reports -----------------------------------
# This is the worst-placed failure in the product: the user has already answered
# every prompt and confirmed the spend before seeing it.
_auth_emits="$(grep -c 'loki_emit_first_run_blocked "not_logged_in"' "$REPO_ROOT/autonomy/run.sh")"
if [ "$_auth_emits" -ge 2 ]; then
    ok "both auth-preflight refusals report (logged out, and expired)"
else
    bad "only $_auth_emits of 2 auth-preflight refusals report"
fi

# --- 3. The enum stays bounded ------------------------------------------------
# The privacy claim rests on this. A blocker key must resolve to a fixed enum,
# never to caller-supplied text that could carry a path or a hostname.
# shellcheck source=/dev/null
if source "$REPO_ROOT/autonomy/telemetry.sh" 2>/dev/null && declare -f _loki_known_blocker >/dev/null 2>&1; then
    if [ "$(_loki_known_blocker not_logged_in)" = "not_logged_in" ]; then
        ok "not_logged_in is a first-class enum value"
    else
        bad "not_logged_in collapses to 'other' -- the most common post-install failure is unactionable"
    fi

    if [ "$(_loki_known_blocker no_provider)" = "no_provider" ]; then
        ok "no_provider is preserved (install something)"
    else
        bad "no_provider does not survive the enum"
    fi

    # not_logged_in and no_provider are the two halves of the same wall and need
    # OPPOSITE fixes. Merging them would make the data useless for deciding
    # whether to improve install or improve auth.
    if [ "$(_loki_known_blocker not_logged_in)" != "$(_loki_known_blocker no_provider)" ]; then
        ok "install-vs-authenticate stay distinguishable"
    else
        bad "not_logged_in and no_provider collapse together"
    fi

    # The actual leak guard: anything unrecognized -- notably anything
    # path-shaped -- must become 'other', never pass through.
    _leaky="$(_loki_known_blocker "/Users/someone/.nvm/versions/node/v18.1.0")"
    if [ "$_leaky" = "other" ]; then
        ok "an unrecognized path-shaped key is reduced to 'other' (no environment leak)"
    else
        bad "a path-shaped blocker key survived as '$_leaky'"
    fi
else
    bad "could not source telemetry.sh to check the enum"
fi

# --- 4. Diagnostics must never break the command they describe ----------------
# Every emit is backgrounded, output-suppressed and </dev/null, so a hung or
# missing telemetry path cannot stall or fail a user's build.
if grep -q 'loki_emit_first_run_blocked "no_provider" >/dev/null 2>&1 </dev/null &' "$REPO_ROOT/autonomy/provider-offer.sh"; then
    ok "the gate emit is backgrounded and cannot block the exit path"
else
    bad "the gate emit is not backgrounded -- telemetry could stall a refusal"
fi

if grep -q 'loki_emit_first_run_blocked "not_logged_in" >/dev/null 2>&1 </dev/null &' "$REPO_ROOT/autonomy/run.sh"; then
    ok "the auth emit is backgrounded and cannot block the exit path"
else
    bad "the auth emit is not backgrounded -- telemetry could stall a refusal"
fi

# Guarded by declare -f, so a build with telemetry.sh absent still runs.
if grep -q 'declare -f loki_emit_first_run_blocked' "$REPO_ROOT/autonomy/provider-offer.sh"; then
    ok "the emit is guarded, so an absent telemetry.sh cannot break the gate"
else
    bad "the emit is unguarded -- an absent telemetry.sh would error"
fi

# --- 5. Default engine10 route (TEN-UX-03) -----------------------------------
# One TS helper owns the telemetry.sh spawn; doctor's private copy is gone.
_spawns="$(grep -rn '"telemetry.sh"' "$REPO_ROOT/loki-ts/src" | wc -l | tr -d ' ')"
if [ "$_spawns" = "1" ]; then
    ok "exactly one telemetry.sh spawn in loki-ts/src"
else
    bad "$_spawns telemetry.sh spawns in loki-ts/src (want exactly 1)"
fi

_cli="$REPO_ROOT/loki-ts/src/engine10/cli.ts"
_fun_ts="$REPO_ROOT/loki-ts/src/util/funnel.ts"
if grep -q 'funnelAfterRun' "$_cli" && grep -q 'emitFunnel("first_run_blocked"' "$_fun_ts" \
   && grep -q 'emitFunnel("build_verified"' "$_fun_ts"; then
    ok "engine10/cli.ts reaches emitFunnel on preflight exit 2 and on a VERIFIED exit"
else
    bad "engine10/cli.ts does not reach emitFunnel for both exits"
fi

if command -v bun >/dev/null 2>&1; then
    _W="$(mktemp -d)"
    trap 'rm -rf "$_W"' EXIT
    # curl stand-in: records the payload instead of sending it
    cat > "$_W/curl" <<'RECORDER'
#!/bin/sh
for a in "$@"; do
    case "$a" in '{"api_key"'*) printf '%s\n' "$a" >> "$LOKI_TEST_PAYLOAD" ;; esac
done
exit 0
RECORDER
    chmod +x "$_W/curl"
    _BRIEF="build me a secret-brief-xyzzy crm"
    _fun() {
        # $1 = exit code, $2.. = extra env; runs the real helper from a non-repo, non-empty folder
        env PATH="$_W:$PATH" HOME="$_W/home" LOKI_TEST_PAYLOAD="$_W/payload.log" LOKI_ANALYTICS=on LOKI_TELEMETRY=on "${@:2}" \
            bun -e "const f = await import('$REPO_ROOT/loki-ts/src/util/funnel.ts'); if (process.env.NOTE) f.noteRefusal(process.env.NOTE); await f.funnelAfterRun($1, process.cwd())" -- "$_BRIEF" >/dev/null 2>&1
        sleep 1.5
    }
    mkdir -p "$_W/home" "$_W/proj"; echo hi > "$_W/proj/notes.txt"
    cd "$_W/proj" || exit 1
    : > "$_W/payload.log"
    _fun 2 NOTE=not_a_repo
    if [ "$(grep -c 'first_run_blocked' "$_W/payload.log")" = "1" ] && grep -q '"blocker": *"not_a_repo"' "$_W/payload.log"; then
        ok "one first_run_blocked blocker=not_a_repo recorded"
    else
        bad "expected one first_run_blocked not_a_repo line, got: $(cat "$_W/payload.log")"
    fi
    _fun 2 NOTE=not_a_repo
    if [ "$(grep -c 'first_run_blocked' "$_W/payload.log")" = "1" ]; then
        ok "second identical run records nothing (once-per-install marker)"
    else
        bad "second run recorded again"
    fi
    if grep -qF "$_W" "$_W/payload.log" || grep -q 'secret-brief-xyzzy' "$_W/payload.log"; then
        bad "payload leaks a path or the brief"
    else
        ok "payload carries no path, home dir or brief text"
    fi
    # AN-08: the class is what the refusing check noted, for any nonzero exit; folder state never decides it
    for _c in dirty_tracked_tree no_provider not_logged_in prd_missing unsupported_flag; do
        rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
        _fun 1 "NOTE=$_c"
        if grep -q "\"blocker\": *\"$_c\"" "$_W/payload.log"; then ok "exit 1 with a noted $_c records blocker=$_c"; else bad "$_c not recorded: $(cat "$_W/payload.log")"; fi
    done
    rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    _fun 1
    if ! grep -q 'first_run_blocked\|build_verified' "$_W/payload.log"; then ok "exit 1 with no noted refusal (untracked-only tree, ordinary failed run) records no blocked or verified event"; else bad "unrefused exit 1 recorded: $(cat "$_W/payload.log")"; fi
    _fun 2
    if grep -q '"blocker": *"other"' "$_W/payload.log"; then ok "exit 2 with no noted refusal is the coarse other"; else bad "exit 2 without a note: $(cat "$_W/payload.log")"; fi
    rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    _fun 2 NOTE=/opt/x/secret-path
    if grep -q '"blocker": *"other"' "$_W/payload.log" && ! grep -q 'secret-path' "$_W/payload.log"; then ok "a path-shaped note is reduced to other and never leaves"; else bad "path-shaped note: $(cat "$_W/payload.log")"; fi
    for _o in DO_NOT_TRACK=1 LOKI_TELEMETRY_DISABLED=true; do
        rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
        _fun 2 "$_o"; _fun 0 "$_o"
        if [ ! -s "$_W/payload.log" ]; then ok "$_o records zero lines"; else bad "$_o still recorded"; fi
    done
    rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    _fun 0
    if grep -q '"headline": *"VERIFIED"' "$_W/payload.log" && grep -q '"route": *"engine10"' "$_W/payload.log"; then
        ok "VERIFIED exit records build_verified headline=VERIFIED route=engine10"
    else
        bad "build_verified not recorded: $(cat "$_W/payload.log")"
    fi
    # Exact key set: baseline props plus headline and route, nothing else
    _keys="$(python3 -c '
import json, sys
for line in open(sys.argv[1]):
    d = json.loads(line)
    if d.get("event") == "build_verified":
        print(",".join(sorted(d["properties"])))
' "$_W/payload.log" 2>/dev/null)"
    if [ "$_keys" = "\$geoip_disable,arch,channel,ephemeral_home,headline,id_age,introspective,os_family,route,traffic,version" ]; then
        ok "build_verified payload carries only headline and route beyond the baseline props"
    else
        bad "build_verified payload keys differ: $_keys"
    fi
    # --- AN-05: run_started and run_finished from the supervisor exit path ---
    _rf_count() { python3 -c '
import json, sys
n = 0
for line in open(sys.argv[1]):
    if json.loads(line).get("event") == sys.argv[2]:
        n += 1
print(n)' "$_W/payload.log" "$1" 2>/dev/null; }
    _rf_prop() { python3 -c '
import json, sys
for line in open(sys.argv[1]):
    d = json.loads(line)
    if d.get("event") == "run_finished":
        print(d["properties"].get(sys.argv[2], ""))' "$_W/payload.log" "$1" 2>/dev/null; }
    _receipt() { # $1 verdict; $2 optional extra json members
        rm -rf "${_W:?}/proj/.loki"; mkdir -p "$_W/proj/.loki/runs/e10-20260101T000000-aaaa"
        printf '{"verdict":"%s","time":{"wall_s":40,"total_s":61.4,"stages":{"wall":7,"implement":30.2,"fix":9}},"cost":{"fix_rounds":[{"round":1},{"round":2}]}%s}\n' "$1" "${2:-}" > "$_W/proj/.loki/runs/e10-20260101T000000-aaaa/receipt.json"
    }
    for _v in VERIFIED PARTIAL ALREADY_SATISFIED SPEC_CONFLICT FAILED; do
        rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
        _receipt "$_v"
        _fun 1
        if [ "$(_rf_count run_finished)" = "1" ] && [ "$(_rf_prop verdict)" = "$_v" ]; then ok "receipt verdict $_v yields exactly one run_finished with that verdict"; else bad "verdict $_v: $(cat "$_W/payload.log")"; fi
    done
    if [ "$(_rf_count run_started)" = "1" ] && [ "$(_rf_prop duration_s)" = "61" ] && [ "$(_rf_prop stage_s_implement)" = "30" ] && [ "$(_rf_prop fix_rounds)" = "2" ] && [ "$(_rf_prop exit_code)" = "1" ]; then
        ok "run_finished carries duration_s, stage_s_<stage>, fix_rounds and exit_code from the receipt allowlist"
    else
        bad "run_finished fields differ: $(cat "$_W/payload.log")"
    fi
    rm -rf "${_W:?}/home" "${_W:?}/proj/.loki"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    _fun 1
    if [ "$(_rf_count run_finished)" = "1" ] && [ "$(_rf_prop verdict)" = "INTERRUPTED" ]; then ok "no receipt yields INTERRUPTED"; else bad "no receipt: $(cat "$_W/payload.log")"; fi
    rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    _fun 4
    if [ "$(_rf_prop verdict)" = "BLOCKED" ]; then ok "no receipt with the engine's blocked exit code 4 yields BLOCKED"; else bad "blocked: $(cat "$_W/payload.log")"; fi
    rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    _receipt VERIFIED ',"repo":"/Users/someone/secret-repo-xyzzy","spec_conflict_reason":"secret-reason-xyzzy","time2":{"path":"/opt/leak-path"}'
    _fun 0
    if [ "$(_rf_count run_finished)" = "1" ] && ! grep -q 'xyzzy\|leak-path\|/Users/someone' "$_W/payload.log"; then ok "an injected extra receipt key (a path or text) never appears in the payload"; else bad "injected receipt key leaked: $(cat "$_W/payload.log")"; fi
    _rf_keys="$(python3 -c '
import json, sys
for line in open(sys.argv[1]):
    d = json.loads(line)
    if d.get("event") == "run_finished":
        print(",".join(sorted(d["properties"])))' "$_W/payload.log" 2>/dev/null)"
    if [ "$_rf_keys" = "\$geoip_disable,arch,channel,cost_bucket,duration_s,engine,ephemeral_home,exit_code,fix_rounds,id_age,introspective,lang_bucket,model_tier,os_family,provider,repo_size_bucket,retries,stage_s_fix,stage_s_implement,stage_s_wall,test_runner,token_bucket,traffic,verdict,version" ]; then ok "run_finished payload keys are exactly the allowlist"; else bad "run_finished keys: $_rf_keys"; fi
    if [ "$(_rf_prop cost_bucket)" = "unknown" ] && [ "$(_rf_prop token_bucket)" = "unknown" ] && [ "$(_rf_prop provider)" = "unknown" ] && [ "$(_rf_prop repo_size_bucket)" = "xs" ]; then ok "run_finished carries stratification buckets, and an absent cost reads unknown on the wire"; else bad "run_finished buckets: $(cat "$_W/payload.log")"; fi
    rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    _receipt "/Users/someone/secret-verdict-xyzzy"
    _fun 1
    if [ "$(_rf_count run_finished)" = "1" ] && [ "$(_rf_prop verdict)" = "INTERRUPTED" ] && ! grep -q 'xyzzy' "$_W/payload.log"; then ok "a receipt verdict outside the enum is reported as INTERRUPTED, never as the receipt text"; else bad "out-of-enum verdict: $(cat "$_W/payload.log")"; fi
    rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
    env PATH="$_W:$PATH" HOME="$_W/home" LOKI_TEST_PAYLOAD="$_W/payload.log" LOKI_ANALYTICS=on LOKI_TELEMETRY=on \
        bun -e "const f = await import('$REPO_ROOT/loki-ts/src/util/funnel.ts'); await f.funnelAfterRun(0, process.cwd(), undefined, ['--dry-run', 'task'])" >/dev/null 2>&1
    sleep 1.5
    if [ "$(_rf_count run_started)" = "0" ] && [ "$(_rf_count run_finished)" = "0" ]; then ok "--dry-run emits no run_started or run_finished"; else bad "--dry-run emitted: $(cat "$_W/payload.log")"; fi
    for _o in DO_NOT_TRACK=1 LOKI_TELEMETRY_DISABLED=true LOKI_ANALYTICS=off; do
        rm -rf "${_W:?}/home"; mkdir -p "$_W/home"; : > "$_W/payload.log"
        _receipt VERIFIED
        _fun 0 "$_o"
        if [ ! -s "$_W/payload.log" ]; then ok "$_o emits no run events"; else bad "$_o still emitted: $(cat "$_W/payload.log")"; fi
    done
    rm -rf "${_W:?}/proj/.loki"
    cd "$REPO_ROOT" || exit 1
else
    ok "bun absent; live funnel run skipped"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
