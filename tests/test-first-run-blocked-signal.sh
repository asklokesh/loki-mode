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
if grep -q "loki_emit_first_run_blocked" "$REPO_ROOT/autonomy/loki"; then
    ok "the doctor blocking path calls the emitter"
else
    bad "nothing calls loki_emit_first_run_blocked -- the signal would never fire"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
