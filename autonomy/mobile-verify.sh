#!/usr/bin/env bash
# Mobile emulator tests: run a mobile project's tests on an available emulator
# or simulator. Never reports PASS without a run.
# Usage: mobile-verify.sh [project_dir]
# Env:   LOKI_MOBILE_TEST_CMD  override the test command
#        LOKI_MOBILE_TIMEOUT   seconds (default 600)
# Exit:  0 = ran and passed, or not a mobile project (stated)
#        1 = ran and failed
#        3 = NOT VERIFIED (no emulator/simulator, or no runnable test command)
set -u
dir="${1:-.}"
cd "$dir" || { echo "mobile tests: NOT VERIFIED (cannot enter $dir)"; exit 3; }

kind=""
if [ -f pubspec.yaml ] && grep -q "flutter" pubspec.yaml 2>/dev/null; then
    kind="flutter"
elif [ -f package.json ] && grep -qE '"(expo|react-native)"[[:space:]]*:' package.json 2>/dev/null; then
    kind="react-native"
fi
if [ -z "$kind" ]; then
    echo "mobile tests: not applicable (no React Native, Expo or Flutter project)"
    exit 0
fi

device=""
if command -v adb >/dev/null 2>&1; then
    d="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1; exit}')"
    [ -n "$d" ] && device="android:$d"
fi
if [ -z "$device" ] && command -v xcrun >/dev/null 2>&1; then
    d="$(xcrun simctl list devices booted 2>/dev/null | awk '/\(Booted\)/ {print "ios-simulator"; exit}')"
    [ -n "$d" ] && device="$d"
fi
if [ -z "$device" ]; then
    echo "mobile tests: NOT VERIFIED ($kind project, no booted Android emulator or iOS simulator found; tests were not run)"
    exit 3
fi

cmd="${LOKI_MOBILE_TEST_CMD:-}"
if [ -z "$cmd" ]; then
    if [ "$kind" = "flutter" ]; then
        if [ -d integration_test ]; then cmd="flutter test integration_test"; else cmd="flutter test"; fi
    elif grep -q '"test:e2e"' package.json 2>/dev/null; then
        cmd="npm run test:e2e"
    elif grep -q '"e2e"' package.json 2>/dev/null; then
        cmd="npm run e2e"
    fi
fi
if [ -z "$cmd" ]; then
    echo "mobile tests: NOT VERIFIED ($kind project on $device, but no e2e test script (test:e2e or e2e) to run)"
    exit 3
fi

timeout_s="${LOKI_MOBILE_TIMEOUT:-600}"
if command -v timeout >/dev/null 2>&1; then
    timeout -k 10 "$timeout_s" bash -c "$cmd"
else
    bash -c "$cmd"
fi
rc=$?
if [ "$rc" -eq 0 ]; then
    echo "mobile tests: PASS ($kind on $device, ran: $cmd)"
    exit 0
fi
echo "mobile tests: FAIL ($kind on $device, ran: $cmd, exit $rc)"
exit 1
