#!/usr/bin/env bash
# FC-DUP: `loki doctor` has ONE implementation (loki-ts/src/commands/doctor.ts).
# autonomy/loki cmd_doctor is a delegator (_loki_bun_delegate) with a minimal
# "bun route unavailable" fallback. This suite pins that, so the old pattern of
# two doctors kept equal by parity tests cannot come back.
#
# (i)   LOKI_LEGACY_BASH=1 and the default route print byte-identical output.
# (ii)  the old bash doctor body is gone.
# (iii) with an unusable bun entry, doctor exits 1 with a short diagnostic whose
#       LAST line names the single cause (A-123 contract).
# (iv)  the same through --json: valid JSON, summary.ok == false.
# (v)   a dist that throws gets the same minimal diagnostic.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=/dev/null
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

T="$LOKI_RUN_TMP"
HOME_DIR="$T/home"
SHIM="$T/bin"
mkdir -p "$HOME_DIR" "$SHIM"

# Core tools and bun, but no provider CLI, so the host has no provider.
for b in bash sh env python3 sed awk grep cat tr head tail sort uniq wc date \
         mkdir rm ls printf dirname basename cut find xargs stat node jq git \
         curl df uname bun timeout gtimeout sleep kill id ps; do
    _src="$(command -v "$b" 2>/dev/null || true)"
    [ -n "$_src" ] && ln -sf "$_src" "$SHIM/$b" 2>/dev/null
done

run() { env -i HOME="$HOME_DIR" PATH="$SHIM" TERM=dumb LOKI_NO_BROWSER=1 "$@"; }

# (i) route-independent output
run "$REPO_ROOT/bin/loki" doctor >"$T/default.out" 2>"$T/default.err"; rc_default=$?
run LOKI_LEGACY_BASH=1 "$REPO_ROOT/bin/loki" doctor >"$T/legacy.out" 2>"$T/legacy.err"; rc_legacy=$?
# Free disk space moves between the two runs on a busy host; mask the number.
sed -E -i.bak 's/Disk space: [0-9]+GB/Disk space: NGB/' "$T/default.out" "$T/legacy.out"
if [ -s "$T/default.out" ] && cmp -s "$T/default.out" "$T/legacy.out" && [ "$rc_default" = "$rc_legacy" ]; then
    ok "(i) LOKI_LEGACY_BASH=1 doctor is byte-identical to the default route (rc $rc_default)"
else
    bad "(i) routes differ (rc $rc_default vs $rc_legacy)"
    diff "$T/default.out" "$T/legacy.out" | head -10
fi

# (ii) no second doctor body
n="$(grep -c "Checking system prerequisites" "$REPO_ROOT/autonomy/loki" || true)"
if [ "$n" = "0" ]; then ok "(ii) bash doctor body is gone"; else bad "(ii) found $n copies of the bash doctor banner"; fi

# (iii) unusable entry: text
run LOKI_TS_ENTRY=/nonexistent "$REPO_ROOT/bin/loki" doctor >"$T/iii.out" 2>&1; rc=$?
lines="$(wc -l <"$T/iii.out" | tr -d ' ')"
last="$(tail -n 1 "$T/iii.out")"
if [ "$rc" = "1" ] && [ "$lines" -lt 15 ] && [ "$lines" -ge 1 ]; then
    ok "(iii) exit 1, $lines lines"
else
    bad "(iii) rc=$rc lines=$lines"
    head -20 "$T/iii.out"
fi
case "$last" in
    *LOKI_TS_ENTRY*) ok "(iii) last line names the cause: $last" ;;
    *) bad "(iii) last line does not name the cause: $last" ;;
esac

# (iv) unusable entry: --json
run LOKI_TS_ENTRY=/nonexistent "$REPO_ROOT/bin/loki" doctor --json >"$T/iv.out" 2>/dev/null; rc=$?
if [ "$rc" = "1" ] && jq -e '.summary.ok == false and .summary.failed == 1 and .route == "unavailable"' "$T/iv.out" >/dev/null 2>&1; then
    ok "(iv) --json parses, summary.ok=false, route=unavailable"
else
    bad "(iv) --json rc=$rc or not parseable"
    head -c 400 "$T/iv.out"
fi

# (v) a dist that throws
printf 'throw new Error("synthetic dist crash");\n' >"$T/crash.js"
run LOKI_TS_ENTRY="$T/crash.js" "$REPO_ROOT/bin/loki" doctor >"$T/v.out" 2>&1; rc=$?
lines="$(wc -l <"$T/v.out" | tr -d ' ')"
last="$(tail -n 1 "$T/v.out")"
case "$last" in
    *"bun failed"*)
        if [ "$rc" = "1" ] && [ "$lines" -lt 15 ]; then
            ok "(v) crashing dist gives the minimal diagnostic: $last"
        else
            bad "(v) rc=$rc lines=$lines"
        fi
        ;;
    *) bad "(v) last line is not a bun-failed diagnostic: $last"; head -20 "$T/v.out" ;;
esac

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
