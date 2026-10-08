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

# (i) LOKI_LEGACY_BASH=1 and the default route print identical output except the
# Runtime route lines, which must report the route the user selected.
run "$REPO_ROOT/bin/loki" doctor >"$T/default.out" 2>"$T/default.err"; rc_default=$?
run LOKI_LEGACY_BASH=1 "$REPO_ROOT/bin/loki" doctor >"$T/legacy.out" 2>"$T/legacy.err"; rc_legacy=$?
# Free disk space moves between runs on a busy host; mask the number. Then drop
# the two route-reporting lines before comparing.
for f in default legacy; do
    sed -E 's/Disk space: [0-9]+GB/Disk space: NGB/' "$T/$f.out" \
        | grep -v -e 'Active runtime:' -e 'LOKI_LEGACY_BASH set:' >"$T/$f.cmp"
done
if [ -s "$T/default.cmp" ] && cmp -s "$T/default.cmp" "$T/legacy.cmp" && [ "$rc_default" = "$rc_legacy" ]; then
    ok "(i) LOKI_LEGACY_BASH=1 doctor is identical to the default route except the Runtime route lines (rc $rc_default)"
else
    bad "(i) routes differ beyond the Runtime route lines (rc $rc_default vs $rc_legacy)"
    diff "$T/default.cmp" "$T/legacy.cmp" | head -10
fi
if grep -q 'Active runtime: Bash (autonomy/loki)' "$T/legacy.out" \
   && grep -q 'WARN.*LOKI_LEGACY_BASH set: shim routes every command to autonomy/loki (bash)' "$T/legacy.out" \
   && ! grep -q 'LOKI_LEGACY_BASH set:' "$T/default.out" \
   && ! grep -q 'Active runtime: Bash' "$T/default.out"; then
    ok "(i) LOKI_LEGACY_BASH=1 reports the Bash runtime and prints the WARN; the default route does neither"
else
    bad "(i) runtime route lines wrong under LOKI_LEGACY_BASH"
    grep -A2 'Runtime route' "$T/legacy.out" | sed 's/\x1b\[[0-9;]*m//g' | head -5
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

# (vi) bun absent from PATH and from the install: minimal fallback, never a crash.
# Run a COPY of the CLI with no node_modules so the @oven fallback cannot find bun.
NB="$T/nobun"
mkdir -p "$NB/bin"
cp -R "$REPO_ROOT/autonomy" "$NB/autonomy" 2>/dev/null
cp "$REPO_ROOT/bin/loki" "$NB/bin/loki"
cp "$REPO_ROOT/VERSION" "$REPO_ROOT/package.json" "$NB/" 2>/dev/null || true
NBSHIM="$T/nbshim"
mkdir -p "$NBSHIM"
for b in "$SHIM"/*; do
    [ "$(basename "$b")" = "bun" ] || ln -sf "$(readlink "$b")" "$NBSHIM/$(basename "$b")"
done
env -i HOME="$HOME_DIR" PATH="$NBSHIM" TERM=dumb LOKI_NO_BROWSER=1 "$NB/bin/loki" doctor >"$T/vi.out" 2>&1; rc=$?
last="$(tail -n 1 "$T/vi.out")"
case "$last" in
    *"bun missing"*)
        if [ "$rc" = "1" ]; then ok "(vi) no bun: rc 1, last line: $last"; else bad "(vi) no bun: rc=$rc"; fi ;;
    *) bad "(vi) no bun: last line is not 'bun missing': $last"; head -10 "$T/vi.out" ;;
esac
env -i HOME="$HOME_DIR" PATH="$NBSHIM" TERM=dumb LOKI_NO_BROWSER=1 "$NB/bin/loki" doctor --json >"$T/vi.json" 2>/dev/null; rc=$?
if [ "$rc" = "1" ] && jq -e '.route == "unavailable" and .summary.ok == false' "$T/vi.json" >/dev/null 2>&1; then
    ok "(vi) no bun: --json parses with route unavailable"
else
    bad "(vi) no bun: --json rc=$rc or not parseable"; head -c 300 "$T/vi.json"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
