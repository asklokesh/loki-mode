#!/usr/bin/env bash
# first_run_blocked: emit WHICH CLASS of dependency stopped a first run, and
# never anything else.
#
# WHY THIS EXISTS. `first_start_attempted` already fired, so we knew a first run
# was ATTEMPTED and nothing about whether it succeeded. An attempt that dies at
# `doctor` looked identical to one that built something. That left the question
# deciding an entire adoption strategy -- does a trial fail on capability,
# discoverability, or trust -- with no data behind it.
#
# The motivation is measured, not hypothetical: on a host with no provider CLI
# the Bun route printed "Some required prerequisites are missing" and stopped
# while bash pointed at `loki tour`. A first-time evaluator hit a dead end and
# nobody could see it happening.
#
# THE ASSERTIONS THAT MATTER MOST ARE THE PRIVACY ONES. An adoption tool that
# exfiltrates a user's environment costs exactly the trust this product sells,
# so "off means silent" and "no paths or free text ever leave" are tested ahead
# of the feature working at all. If a future change has to break one of these,
# it should break the build first.
#
# No network: curl is replaced with a recorder on PATH, so the payload is
# inspected rather than sent.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TELEM="$REPO_ROOT/autonomy/telemetry.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

[ -f "$TELEM" ] || { echo "FAIL: telemetry.sh missing"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A curl stand-in that records the payload instead of sending it.
cat > "$WORK/curl" <<'RECORDER'
#!/bin/sh
for a in "$@"; do
    case "$a" in '{"api_key"'*) printf '%s' "$a" > "$LOKI_TEST_PAYLOAD" ;; esac
done
exit 0
RECORDER
chmod +x "$WORK/curl"

emit() {
    # $1 = blocker key, $2.. = extra env assignments
    rm -f "$WORK/payload.json"
    local home="$WORK/h$$RANDOM"
    mkdir -p "$home"
    env PATH="$WORK:$PATH" HOME="$home" LOKI_TEST_PAYLOAD="$WORK/payload.json" \
        "${@:2}" bash -c "
            cd '$REPO_ROOT'
            source autonomy/telemetry.sh 2>/dev/null
            loki_emit_first_run_blocked '$1'
            sleep 0.4
        " >/dev/null 2>&1
    rm -rf "$home"
}

# ---------------------------------------------------------------------------
# PRIVACY FIRST.
# ---------------------------------------------------------------------------

# 1. Every opt-out must produce silence. Tested individually: a single shared
#    gate that regressed would otherwise be caught by only one of these.
for optout in "DO_NOT_TRACK=1" "LOKI_TELEMETRY=off" "LOKI_TELEMETRY_DISABLED=true"; do
    emit no_provider "LOKI_ANALYTICS=on" "LOKI_TELEMETRY=on" "$optout"
    if [ -s "$WORK/payload.json" ]; then
        bad "${optout} did NOT stop the event -- an opt-out that leaks is a trust defect"
    else
        ok "${optout} produces zero emission"
    fi
done

# 2. Analytics must be OFF by default, even with telemetry on. Adoption
#    instrumentation is a second, stricter opt-in on purpose.
emit no_provider "LOKI_TELEMETRY=on"
if [ -s "$WORK/payload.json" ]; then
    bad "the event fired without LOKI_ANALYTICS -- analytics must be its own opt-in"
else
    ok "analytics is off by default even when telemetry is on"
fi

# 3. The blocker is clamped to an ENUM. This is the assertion that stops a
#    path, a version string, or spec text from ever reaching the wire: an
#    unrecognized value becomes "other" rather than being forwarded.
clamp="$(bash -c "cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
for v in 'no_provider' '/Users/someone/.nvm/versions/node/v18' 'build me a CRM' 'bogus'; do
    printf '%s|' \"\$(_loki_known_blocker \"\$v\")\"
done" 2>/dev/null)"

case "$clamp" in
    "no_provider|other|other|other|")
        ok "the clamp helper maps unknown values to 'other'" ;;
    *)
        bad "blocker clamping is wrong: got '${clamp}'" ;;
esac

# 3b. ...and the EMITTER must actually route through that helper. Testing the
# helper alone is not enough: a mutation replacing the emitter's
# `_blocker="$(_loki_known_blocker "$1")"` with a raw `_blocker="$1"` left the
# helper perfectly correct and every other assertion green, while a filesystem
# path sailed onto the wire. So this feeds a PATH through the real emitter and
# inspects what would have been SENT.
emit "/Users/someone/.nvm/versions/node/v18.0.0" "LOKI_ANALYTICS=on" "LOKI_TELEMETRY=on"
if [ ! -s "$WORK/payload.json" ]; then
    bad "no payload captured while testing the clamp path"
else
    sent="$(python3 -c '
import json, sys
p = json.load(open(sys.argv[1])).get("properties", {})
print(p.get("blocker", "MISSING"))
' "$WORK/payload.json" 2>/dev/null)"
    if [ "$sent" = "other" ]; then
        ok "a filesystem path sent through the emitter arrives as 'other'"
    else
        bad "the emitter BYPASSED the clamp: a path was sent as '${sent}'"
    fi
fi

# ---------------------------------------------------------------------------
# THEN: does it actually work?
# ---------------------------------------------------------------------------

emit no_provider "LOKI_ANALYTICS=on" "LOKI_TELEMETRY=on"
if [ ! -s "$WORK/payload.json" ]; then
    bad "no event when explicitly opted in -- the signal is dead code"
else
    ok "emits first_run_blocked when explicitly opted in"

    verdict="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
p = d.get("properties", {})
if d.get("event") != "first_run_blocked":
    print("WRONG_EVENT:" + str(d.get("event"))); raise SystemExit
if p.get("blocker") != "no_provider":
    print("WRONG_BLOCKER:" + str(p.get("blocker"))); raise SystemExit
# Nothing resembling a path, a home directory, or prose may appear in ANY value.
for k, v in p.items():
    s = str(v)
    if "/" in s or "\\\\" in s or len(s) > 40:
        print("LEAK:" + k + "=" + s[:60]); raise SystemExit
print("CLEAN")
' "$WORK/payload.json" 2>/dev/null)"

    case "$verdict" in
        CLEAN) ok "payload carries the enum only -- no path, no free text, no long values" ;;
        LEAK:*) bad "payload leaked a value: ${verdict#LEAK:}" ;;
        WRONG_EVENT:*) bad "wrong event name: ${verdict#WRONG_EVENT:}" ;;
        WRONG_BLOCKER:*) bad "wrong blocker value: ${verdict#WRONG_BLOCKER:}" ;;
        *) bad "could not evaluate the payload" ;;
    esac
fi

# 4. Once per install. A signal that re-fires every run would drown the real
#    first-run rate in repeat noise from the same machine.
home2="$WORK/once"
mkdir -p "$home2"
rm -f "$WORK/payload.json"
env PATH="$WORK:$PATH" HOME="$home2" LOKI_TEST_PAYLOAD="$WORK/payload.json" \
    LOKI_ANALYTICS=on LOKI_TELEMETRY=on bash -c "
        cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
        loki_emit_first_run_blocked no_provider; sleep 0.4" >/dev/null 2>&1
rm -f "$WORK/payload.json"
env PATH="$WORK:$PATH" HOME="$home2" LOKI_TEST_PAYLOAD="$WORK/payload.json" \
    LOKI_ANALYTICS=on LOKI_TELEMETRY=on bash -c "
        cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
        loki_emit_first_run_blocked no_provider; sleep 0.4" >/dev/null 2>&1

if [ -s "$WORK/payload.json" ]; then
    bad "the event re-fired on a second run -- repeat noise would swamp the signal"
else
    ok "fires once per install, not once per run"
fi

# 5. The doctor path must actually reach the emitter. Wiring that exists but is
#    never called is the built-and-unused pattern this session kept finding --
#    loki_emit_funnel_once itself sat with a single call site for exactly that
#    reason.
if grep -q "emitFunnel(\"first_run_blocked\"" "$REPO_ROOT/loki-ts/src/commands/doctor.ts" && grep -q "loki_emit_first_run_blocked" "$REPO_ROOT/loki-ts/src/util/funnel.ts"; then
    ok "the doctor blocking path calls the emitter"
else
    bad "nothing calls loki_emit_first_run_blocked -- the signal would never fire"
fi

# 6. Activation funnel: install, first_start, first_run_finished, first_verified,
#    second_run_within_7d. Appending recorder so emitted events are observable.
mkdir -p "$WORK/bin2"
cat > "$WORK/bin2/curl" <<'RECORDER'
#!/bin/sh
for a in "$@"; do
    case "$a" in '{"api_key"'*) printf '%s\n' "$a" >> "$LOKI_TEST_LOG" ;; esac
done
exit 0
RECORDER
chmod +x "$WORK/bin2/curl"

act_run() {
    # $1 = home, $2 = shell snippet; analytics on
    env PATH="$WORK/bin2:$PATH" HOME="$1" LOKI_TEST_LOG="$1/events.log" \
        LOKI_ANALYTICS=on LOKI_TELEMETRY=on bash -c "
            cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
            $2; sleep 0.6" >/dev/null 2>&1
}
act_events() {
    python3 -c '
import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); print(d["event"]+":"+str(d["properties"].get("since_install")))
' "$1" 2>/dev/null
}

ah="$WORK/act"; mkdir -p "$ah"
act_run "$ah" 'loki_emit_run_started; loki_emit_run_finished VERIFIED duration_s=5 exit_code=0'
# Backgrounded curls do not guarantee arrival order, so check the set.
got="$(act_events "$ah/events.log" | grep '^activation_' | sort | tr '\n' ' ')"
want="activation_first_run_finished:lt_1h activation_first_start:lt_1h activation_first_verified:lt_1h activation_install:lt_1h "
if [ "$got" = "$want" ]; then
    ok "activation: install, first_start, first_run_finished, first_verified fire with a since_install bucket"
else
    bad "activation events wrong: [$got]"
fi

# Order: each marker holds its emit epoch; install is written first.
if [ -f "$ah/.loki/funnel-install-ts" ] && [ -f "$ah/.loki/funnel-activation-install" ] \
   && [ "$(cat "$ah/.loki/funnel-activation-install")" -le "$(cat "$ah/.loki/funnel-activation-first_start")" ]; then
    ok "install precedes first_start; markers written after the gate passed"
else
    bad "activation markers missing or out of order"
fi

# second run: a later run start inside 7 days of the first fires exactly once
act_run "$ah" 'sleep 1; loki_emit_run_started; loki_emit_run_started'
n2="$(act_events "$ah/events.log" | grep -c '^activation_second_run_within_7d:')"
if [ "$n2" = "1" ]; then ok "second_run_within_7d fires once inside the 7 day window"; else bad "second_run_within_7d fired $n2 times"; fi

# replay: nothing activation-shaped fires again (5 events total)
act_run "$ah" 'loki_emit_run_started; loki_emit_run_finished VERIFIED exit_code=0; loki_emit_build_verified_enum VERIFIED engine10'
total="$(grep -c '"event": *"activation_' "$ah/events.log")"
if [ "$total" = "5" ]; then ok "replay fires no activation event twice (5 total)"; else bad "activation events after replay: $total"; fi

# outside the window: second run does not fire
wh="$WORK/act-late"; mkdir -p "$wh/.loki"
echo 1000 > "$wh/.loki/funnel-activation-first_start"
act_run "$wh" 'loki_emit_run_started'
if [ -f "$wh/.loki/funnel-activation-second_run_within_7d" ]; then bad "second run fired beyond 7 days"; else ok "no second_run_within_7d beyond 7 days"; fi

# analytics off (telemetry on): no event, no marker, no install clock
oh="$WORK/act-off"; mkdir -p "$oh"
env PATH="$WORK/bin2:$PATH" HOME="$oh" LOKI_TEST_LOG="$oh/events.log" LOKI_TELEMETRY=on bash -c "
    cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
    loki_emit_run_started; loki_emit_run_finished VERIFIED exit_code=0; loki_emit_build_verified_enum VERIFIED engine10; sleep 0.5" >/dev/null 2>&1
if { [ -d "$oh/.loki" ] && [ -n "$(ls -A "$oh/.loki" 2>/dev/null)" ]; } || [ -s "$oh/events.log" ]; then
    bad "analytics disabled but a marker or event was written"
else
    ok "analytics disabled: no activation marker, no install clock, no event"
fi

# concurrent emitters (run_started, run_finished, build_verified start as
# detached processes at once): each activation step is sent exactly once
ch="$WORK/act-conc"
cn=0; cbad=0
while [ "$cn" -lt 10 ]; do
    cn=$((cn + 1))
    rm -rf "$ch"; mkdir -p "$ch"
    act_run "$ch" 'loki_emit_run_started & loki_emit_run_finished VERIFIED exit_code=0 & loki_emit_build_verified_enum VERIFIED engine10 & wait'
    for ev in install first_start first_run_finished first_verified; do
        c="$(grep -c "\"event\": *\"activation_${ev}\"" "$ch/events.log" 2>/dev/null)"
        [ "$c" = "1" ] || { cbad=$((cbad + 1)); printf '  trial %d: activation_%s sent %s times\n' "$cn" "$ev" "$c"; }
    done
done
if [ "$cbad" = "0" ]; then ok "concurrent emits send each activation step exactly once (10 trials)"; else bad "concurrent activation emits duplicated or dropped $cbad times"; fi

# direct call with analytics off: no marker, no claim, no send
dh="$WORK/act-direct-off"; mkdir -p "$dh"
env PATH="$WORK/bin2:$PATH" HOME="$dh" LOKI_TEST_LOG="$dh/events.log" LOKI_TELEMETRY=on bash -c "
    cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
    loki_emit_activation install; sleep 0.5" >/dev/null 2>&1
if { [ -d "$dh/.loki" ] && [ -n "$(ls -A "$dh/.loki" 2>/dev/null)" ]; } || [ -s "$dh/events.log" ]; then
    bad "loki_emit_activation install with analytics off wrote a marker or sent"
else
    ok "loki_emit_activation install with analytics off: no marker, no send"
fi

# ---------------------------------------------------------------------------
# Legacy route (autonomy/run.sh): the same funnel, driven the way run.sh calls it
# ---------------------------------------------------------------------------
mkdir -p "$WORK/lp/proofs/r1" "$WORK/lp/proofs/r2"
printf '%s' '{"iterations":3,"honesty":{"headline":"VERIFIED"}}' > "$WORK/lp/proofs/r1/proof.json"
printf '%s' '{"iterations":3,"honesty":{"headline":"NOT VERIFIED"}}' > "$WORK/lp/proofs/r2/proof.json"
legacy_run() {
    # $1 = home, $2 = proof path; the run.sh sequence: start, build_verified, end
    env PATH="$WORK/bin2:$PATH" HOME="$1" LOKI_TEST_LOG="$1/events.log" SCRIPT_DIR="$REPO_ROOT/autonomy" \
        LOKI_ANALYTICS=on LOKI_TELEMETRY=on bash -c "
            cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
            ( _loki_activation_run_started & ) ; loki_emit_build_verified '$2'
            ( loki_emit_activation first_run_finished & ) ; sleep 0.8" >/dev/null 2>&1
}
lh="$WORK/act-legacy"; mkdir -p "$lh"
legacy_run "$lh" "$WORK/lp/proofs/r1/proof.json"
got="$(act_events "$lh/events.log" | grep '^activation_' | sort | tr '\n' ' ')"
if [ "$got" = "$want" ]; then
    ok "legacy route: all four first-run activation steps sent once"
else
    bad "legacy route activation events wrong: [$got]"
fi
legacy_run "$lh" "$WORK/lp/proofs/r1/proof.json"
nl="$(grep -c '"event": *"activation_' "$lh/events.log")"
# a replay may add only second_run_within_7d, never a first-run step again
case "$nl" in 4|5) ok "legacy route: replay re-sends no first-run step ($nl total)" ;; *) bad "legacy replay sent $nl activation events" ;; esac

lu="$WORK/act-legacy-unverified"; mkdir -p "$lu"
legacy_run "$lu" "$WORK/lp/proofs/r2/proof.json"
if act_events "$lu/events.log" | grep -q '^activation_first_verified'; then
    bad "legacy route: a NOT VERIFIED proof sent first_verified"
else
    ok "legacy route: first_verified only on a VERIFIED proof"
fi

lo="$WORK/act-legacy-off"; mkdir -p "$lo"
env PATH="$WORK/bin2:$PATH" HOME="$lo" LOKI_TEST_LOG="$lo/events.log" SCRIPT_DIR="$REPO_ROOT/autonomy" LOKI_TELEMETRY=on bash -c "
    cd '$REPO_ROOT'; source autonomy/telemetry.sh 2>/dev/null
    _loki_activation_run_started; loki_emit_build_verified '$WORK/lp/proofs/r1/proof.json'; loki_emit_activation first_run_finished; sleep 0.5" >/dev/null 2>&1
if { [ -d "$lo/.loki" ] && [ -n "$(ls -A "$lo/.loki" 2>/dev/null)" ]; } || [ -s "$lo/events.log" ]; then
    bad "legacy route with analytics off wrote a marker or sent"
else
    ok "legacy route with analytics off: nothing written, nothing sent"
fi

# Drive the real main() of run.sh (only the provider loop is stubbed) in an isolated HOME and project,
# with the curl recorder on PATH, so the activation calls are proven by what is sent, not by grepping the source.
# $1 = home/project root, $2 = run_autonomous stub body, $3 = analytics mode (on|off), $4.. = extra env assignments
main_run() {
    local root="$1" stub="$2" mode="$3"; shift 3
    mkdir -p "$root/h" "$root/proj"; printf '# prd\n' > "$root/proj/prd.md"
    ( cd "$root/proj" && env -i PATH="$WORK/bin2:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin" HOME="$root/h" \
        LOKI_TEST_LOG="$root/events.log" LOKI_ANALYTICS="$mode" LOKI_TELEMETRY=on LOKI_SKIP_PREREQS=true LOKI_DASHBOARD=false \
        TARGET_DIR="$root/proj" "$@" timeout 120 bash -c "
            source '$REPO_ROOT/autonomy/run.sh' >/dev/null 2>&1
            run_autonomous() { $stub; }
            main prd.md" >"$root/out.log" 2>&1; echo $? >"$root/rc"; sleep 0.8 )
}
mh="$WORK/main-ok"; main_run "$mh" 'return 0' on
got="$(act_events "$mh/events.log" | grep '^activation_' | sed 's/:.*//' | sort | tr '\n' ' ')"
case "$got" in
    *activation_first_run_finished*activation_first_start*|*activation_first_start*activation_first_run_finished*) ok "main(): a finished run sends first_start and first_run_finished through run.sh" ;;
    *) bad "main(): activation events wrong: [$got]" ;;
esac
[ "$(grep -c '"event": *"activation_first_run_finished"' "$mh/events.log" 2>/dev/null)" = "1" ] && ok "main(): first_run_finished sent exactly once" || bad "main(): first_run_finished not sent exactly once"

ms="$WORK/main-term"; main_run "$ms" 'kill -TERM $$; sleep 5' on LOKI_SUPERVISED_BUILD=1
if [ "$(cat "$ms/rc" 2>/dev/null)" = "143" ] && [ "$(grep -c '"event": *"activation_first_run_finished"' "$ms/events.log" 2>/dev/null)" = "1" ]; then
    ok "main(): a TERM-ended run still sends first_run_finished once (exit 143)"
else
    bad "main(): TERM-ended run rc=$(cat "$ms/rc" 2>/dev/null) first_run_finished=$(grep -c 'activation_first_run_finished' "$ms/events.log" 2>/dev/null)"
fi
mi="$WORK/main-int"; main_run "$mi" 'kill -INT $$; sleep 5' on LOKI_SUPERVISED_BUILD=1
if [ "$(cat "$mi/rc" 2>/dev/null)" = "130" ] && [ "$(grep -c '"event": *"activation_first_run_finished"' "$mi/events.log" 2>/dev/null)" = "1" ]; then
    ok "main(): an INT-ended run still sends first_run_finished once (exit 130)"
else
    bad "main(): INT-ended run rc=$(cat "$mi/rc" 2>/dev/null) first_run_finished=$(grep -c 'activation_first_run_finished' "$mi/events.log" 2>/dev/null)"
fi

md="$WORK/main-dbl"; main_run "$md" 'kill -INT $$; kill -INT $$; sleep 5' on
if [ "$(cat "$md/rc" 2>/dev/null)" = "130" ] && [ "$(grep -c '"event": *"activation_first_run_finished"' "$md/events.log" 2>/dev/null)" = "1" ]; then
    ok "main(): a double Ctrl+C exit still sends first_run_finished once (exit 130)"
else
    bad "main(): double INT rc=$(cat "$md/rc" 2>/dev/null) first_run_finished=$(grep -c 'activation_first_run_finished' "$md/events.log" 2>/dev/null)"
fi

mo="$WORK/main-off"; main_run "$mo" 'kill -TERM $$; sleep 5' off LOKI_SUPERVISED_BUILD=1
mo_markers="$(find "$mo/h/.loki" -maxdepth 1 -name 'funnel*' 2>/dev/null | head -1)"
if grep -q "\"event\": *\"activation_" "$mo/events.log" 2>/dev/null || [ -n "$mo_markers" ]; then
    bad "main(): analytics off still wrote a funnel marker or sent an activation event"
else
    ok "main(): analytics off sends no activation event and writes no funnel marker, even on a signal exit"
fi

# F3: a subshell that inherits the EXIT trap must not release the live parent's session lock
# BASHPID exists from bash 4; on 3.2 the guard falls back to $$ (same as _loki_remove_pgid_file), so this needs a newer bash.
lk="$WORK/lock"; mkdir -p "$lk"; B4=""
for cand in "$(command -v bash)" /opt/homebrew/bin/bash /usr/local/bin/bash; do
    [ -x "$cand" ] && [ "$("$cand" -c 'echo "${BASHPID:-}"' 2>/dev/null)" != "" ] && { B4="$cand"; break; }
done
if [ -z "$B4" ]; then ok "session exit cleanup: subshell guard needs bash 4+ (BASHPID); none on this host, skipped"; else
out="$(env -i PATH="/usr/bin:/bin" HOME="$lk" "$B4" -c "
    source '$REPO_ROOT/autonomy/run.sh' >/dev/null 2>&1
    safe_release_lock() { echo RELEASED:\$1; }
    _loki_arm_session_exit_cleanup '$lk/session.lock'
    ( _loki_session_exit_cleanup )
    echo parent-alive
    " 2>/dev/null)"
case "$out" in
    *RELEASED*parent-alive*) bad "session exit cleanup: a subshell released the parent's lock" ;;
    *parent-alive*RELEASED:$lk/session.lock) ok "session exit cleanup: only the arming process releases the lock (subshell exit skipped, parent exit released)" ;;
    *) bad "session exit cleanup: unexpected output [$out]" ;;
esac
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
