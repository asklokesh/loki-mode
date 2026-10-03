#!/usr/bin/env bash
# Guards autonomy/mobile-verify.sh: no PASS without a run, clear NOT VERIFIED when no device.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/autonomy/mobile-verify.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/mobile-verify-test.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$T"' EXIT
fail=0
check() { [ "$2" = "$3" ] || { echo "FAIL: $1 (want '$3' got '$2')"; fail=1; }; }

mkdir -p "$T/rn" "$T/plain" "$T/bin" "$T/nodev"
echo '{"dependencies":{"expo":"1"},"scripts":{"test:e2e":"echo ok"}}' > "$T/rn/package.json"
echo '{}' > "$T/plain/package.json"
printf '#!/bin/sh\necho "List of devices attached"\necho "emu-1\tdevice"\n' > "$T/bin/adb"
printf '#!/bin/sh\necho "List of devices attached"\n' > "$T/nodev/adb"
printf '#!/bin/sh\nexit 0\n' > "$T/nodev/xcrun"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/npm"
chmod +x "$T/bin/npm" "$T/bin/adb" "$T/nodev/adb" "$T/nodev/xcrun"
BASE="/usr/bin:/bin"

out="$(PATH="$T/nodev:$BASE" bash "$S" "$T/rn")"; rc=$?
check "no device rc" "$rc" 3
case "$out" in *"NOT VERIFIED"*) ;; *) echo "FAIL: no NOT VERIFIED line"; fail=1 ;; esac
case "$out" in *PASS*) echo "FAIL: PASS without run"; fail=1 ;; esac

out="$(PATH="$T/bin:$BASE" bash "$S" "$T/rn")"; rc=$?
check "device pass rc" "$rc" 0
case "$out" in *"mobile tests: PASS"*) ;; *) echo "FAIL: no PASS line"; fail=1 ;; esac

out="$(PATH="$T/bin:$BASE" LOKI_MOBILE_TEST_CMD=false bash "$S" "$T/rn")"; rc=$?
check "failing tests rc" "$rc" 1

out="$(PATH="$T/bin:$BASE" bash "$S" "$T/plain")"; rc=$?
check "non-mobile rc" "$rc" 0
case "$out" in *"not applicable"*) ;; *) echo "FAIL: non-mobile line"; fail=1 ;; esac

[ "$fail" -eq 0 ] && echo "test-mobile-verify: all passed"
exit "$fail"
