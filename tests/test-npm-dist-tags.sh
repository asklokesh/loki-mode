#!/usr/bin/env bash
# Guards scripts/npm-dist-tags.sh (FC-DIST-TAG-MOVED-BACKWARDS) with a stub npm
# that keeps registry state in files. Real npm is never called.
# shellcheck disable=SC2086,SC2015 # $2 is a word list; A && B || C is the suite idiom
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${NPM_DIST_TAGS_SH:-$ROOT/scripts/npm-dist-tags.sh}"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-npm-dist-tags.XXXXXX")" || exit 2
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/bin"
# State: $ST/versions (one per line), $ST/latest, $ST/next, $ST/log.
# STUB_OVERTAKE="<ver>" makes the first `dist-tag add ... latest` be followed by
# a late write that sets latest to <ver> (the registry applying an older run's write late).
cat > "$WORK/bin/npm" <<'STUB'
#!/usr/bin/env bash
ST="$STUB_STATE"; PKGN="${STUB_PKG:-loki-mode}"
if [ "$1" = view ] && [ -n "${STUB_OUTAGE:-}" ]; then
    [ "$STUB_OUTAGE" = empty ] && exit 0
    echo "npm error code E503" >&2; exit 1
fi
case "$1 $2 $3" in
    "view $PKGN versions")
        # STUB_HIDE_VER=<ver> STUB_MATERIALIZE_AFTER=<n>: the version is absent from
        # the first <n> versions reads (the registry has not materialized it yet).
        c=$(( $(cat "$ST/vcalls" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$ST/vcalls"
        if [ -n "${STUB_HIDE_VER:-}" ] && [ "$c" -le "${STUB_MATERIALIZE_AFTER:-0}" ]; then grep -vx "$STUB_HIDE_VER" "$ST/versions" > "$ST/visible"; else cp "$ST/versions" "$ST/visible"; fi
        printf '['; paste -sd, "$ST/visible" | sed 's/\([0-9.]*\)/"\1"/g'; printf ']\n' ;;
    "view $PKGN dist-tags."*)
        # The cached packument: frozen at its first snapshot, never current after a write.
        tag="${3#dist-tags.}"
        [ -f "$ST/stale.$tag" ] || cp "$ST/$tag" "$ST/stale.$tag"
        cat "$ST/stale.$tag" ;;
    "dist-tag ls "*)
        for tag in latest next; do
            # STUB_FRESH=<ver>: the first read of each tag returns the state file, every
            # later read returns <ver> (another run moved the tag in between).
            if [ -n "${STUB_FRESH:-}" ]; then
                n=$(( $(cat "$ST/reads.$tag" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ST/reads.$tag"
                # STUB_FRESH=EMPTY: later reads succeed with an empty answer.
                if [ "$n" -gt 1 ] && [ "$STUB_FRESH" = EMPTY ]; then exit 0; fi
                [ "$n" -gt 1 ] && printf '%s\n' "$STUB_FRESH" > "$ST/$tag"
            fi
            echo "$tag: $(cat "$ST/$tag")"
        done ;;
    "dist-tag add $PKGN@"*)
        spec="$3"; tag="$4"; ver="${spec#"$PKGN"@}"
        echo "add $ver $tag" >> "$ST/log"
        # A write for a version the registry has not materialized is accepted and dropped.
        if [ -n "${STUB_HIDE_VER:-}" ] && [ "$ver" = "$STUB_HIDE_VER" ] && [ "$(cat "$ST/dcalls" 2>/dev/null || echo 0)" -le "${STUB_MATERIALIZE_AFTER:-0}" ]; then echo "dropped $ver $tag" >> "$ST/log"; exit 0; fi
        printf '%s\n' "$ver" > "$ST/$tag"
        if [ "$tag" = latest ] && [ -n "${STUB_OVERTAKE:-}" ] && [ ! -e "$ST/overtook" ]; then
            : > "$ST/overtook"; printf '%s\n' "$STUB_OVERTAKE" > "$ST/latest"
        fi ;;
    *) echo "stub npm: unexpected $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$WORK/bin/npm"
# The version document is fetched with curl (uncached GET), not `npm view pkg@version`
# (which reads the cached packument). The stub answers 200 or 404 from the state files.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
ST="$STUB_STATE"; PKGN="${STUB_PKG:-loki-mode}"
url="${*: -1}"; v="${url##*/}"; rest="${url%/*}"
[ "${rest##*/}" = "$PKGN" ] || { echo 404; exit 0; }
[ -z "${STUB_OUTAGE:-}" ] || { echo 503; exit 0; }
c=$(( $(cat "$ST/dcalls" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$ST/dcalls"
if [ -n "${STUB_HIDE_VER:-}" ] && [ "$v" = "$STUB_HIDE_VER" ] && [ "$c" -le "${STUB_MATERIALIZE_AFTER:-0}" ]; then echo 404; exit 0; fi
grep -qx "$v" "$ST/versions" && echo 200 || echo 404
STUB
chmod +x "$WORK/bin/curl"

# case NAME "versions" LATEST NEXT RUNVER [overtake]
run_case() {
    ST="$WORK/$1"; mkdir -p "$ST"
    printf '%s\n' $2 > "$ST/versions"; echo "$3" > "$ST/latest"; echo "$4" > "$ST/next"; : > "$ST/log"
    CASE_OUT="$(env PATH="$WORK/bin:$PATH" STUB_STATE="$ST" STUB_FRESH="${STUB_FRESH:-}" STUB_OVERTAKE="${6:-}" STUB_OUTAGE="${STUB_OUTAGE:-}" STUB_PKG="${STUB_PKG:-}" STUB_HIDE_VER="${STUB_HIDE_VER:-}" STUB_MATERIALIZE_AFTER="${STUB_MATERIALIZE_AFTER:-}" LOKI_DISTTAG_PKG="${STUB_PKG:-}" LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_TRIES=4 LOKI_DISTTAG_MATERIALIZE_S="${STUB_MAT_S:-1}" bash "$SCRIPT" "$5" 2>&1)"
    CASE_RC=$?
    CASE_ST="$ST"
}

run_case up "11.53.0 11.53.1" 11.53.0 11.53.0 11.53.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.53.1 ] && [ "$(cat "$CASE_ST/next")" = 11.53.1 ]; } \
    && ok "highest version moves latest and next" || bad "up: rc=$CASE_RC $CASE_OUT"

run_case low "11.53.1 11.54.0" 11.54.0 11.54.0 11.53.1
{ [ $CASE_RC -eq 0 ] && ! grep -q 'add 11.53.1' "$CASE_ST/log"; } \
    && ok "a lower version never moves a tag backwards" || bad "low: rc=$CASE_RC log=$(cat "$CASE_ST/log")"

# The lagging-tag case: the tags still read the old version and the versions list
# lags too, but the OTHER direction (tags ahead of the run) must still win.
run_case lag "11.53.1" 11.54.0 11.54.0 11.53.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.54.0 ]; } \
    && ok "tags ahead of a lagging versions list still win" || bad "lag: rc=$CASE_RC $CASE_OUT"

run_case over "11.53.0 11.53.1 11.54.0" 11.53.0 11.53.0 11.54.0 11.53.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.54.0 ] && [ "$(cat "$CASE_ST/next")" = 11.54.0 ]; } \
    && ok "a late lower write that overtook latest is restored" || bad "over: rc=$CASE_RC latest=$(cat "$CASE_ST/latest") $CASE_OUT"

run_case pre "11.54.0 11.55.0-rc.1" 11.54.0 11.54.0 11.54.0
{ [ $CASE_RC -eq 0 ] && [ ! -s "$CASE_ST/log" ]; } \
    && ok "prereleases are ignored; settled tags are not rewritten" || bad "pre: rc=$CASE_RC log=$(cat "$CASE_ST/log")"

# The SDK package goes through the same script (LOKI_DISTTAG_PKG); the stub knows only that package.
# The per-tag read inside the loop comes back empty while the first reads succeed:
# nothing may be written (guards the empty-cur clause).
STUB_FRESH=EMPTY run_case emptycur "11.54.1 11.54.2" 11.54.1 11.54.1 11.54.2
{ [ ! -s "$CASE_ST/log" ] && [ "$(cat "$CASE_ST/latest")" = 11.54.1 ]; } \
    && ok "an empty in-loop tag read writes nothing" || bad "emptycur: rc=$CASE_RC log=$(cat "$CASE_ST/log")"

STUB_PKG=loki-mode-sdk run_case sdk-up "1.0.0 1.0.1" 1.0.0 1.0.0 1.0.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 1.0.1 ] && [ "$(cat "$CASE_ST/next")" = 1.0.1 ]; } \
    && ok "sdk: highest version moves latest and next" || bad "sdk-up: rc=$CASE_RC $CASE_OUT"
STUB_PKG=loki-mode-sdk run_case sdk-low "1.0.0 1.0.1" 1.0.1 1.0.1 1.0.0
{ [ $CASE_RC -eq 0 ] && ! grep -q 'add 1.0.0' "$CASE_ST/log"; } \
    && ok "sdk: a lower version never moves a tag backwards" || bad "sdk-low: rc=$CASE_RC log=$(cat "$CASE_ST/log")"
STUB_PKG=loki-mode-sdk run_case sdk-over "1.0.0 1.0.1 1.0.2" 1.0.0 1.0.0 1.0.2 1.0.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 1.0.2 ]; } \
    && ok "sdk: an overtaken latest is restored" || bad "sdk-over: rc=$CASE_RC $CASE_OUT"
STUB_PKG=loki-mode-sdk STUB_OUTAGE=error run_case sdk-out "1.0.1" 1.0.1 1.0.1 1.0.0
{ [ $CASE_RC -ne 0 ] && [ ! -s "$CASE_ST/log" ]; } \
    && ok "sdk: view outage refuses with zero writes" || bad "sdk-out: rc=$CASE_RC log=$(cat "$CASE_ST/log")"

# FC-DIST-TAG-MOVED-BACKWARDS review: a registry view outage must fail closed, zero writes.
for mode in error empty; do
    STUB_OUTAGE=$mode run_case "out-$mode" "11.54.0" 11.54.0 11.54.0 11.53.1
    { [ $CASE_RC -ne 0 ] && [ ! -s "$CASE_ST/log" ] && [ "$(cat "$CASE_ST/latest")" = 11.54.0 ] \
        && grep -q "(fail closed)" <<<"$CASE_OUT"; } \
        && ok "view outage ($mode) refuses with zero writes" || bad "outage $mode: rc=$CASE_RC log=$(cat "$CASE_ST/log") $CASE_OUT"
done

# FC-DIST-TAG-MOVED-BACKWARDS late materialization: the first run settles, THEN the
# registry applies an older publish and drags latest down. The converge run in
# verify-npm-registry (a second invocation) must restore it.
run_case late "11.53.1 11.54.0 11.54.1" 11.54.0 11.54.0 11.54.1
first_rc=$CASE_RC
printf '%s\n' 11.54.0 > "$CASE_ST/latest"
printf '%s\n' 11.54.1 > "$CASE_ST/next"
second_out="$(PATH="$WORK/bin:$PATH" STUB_STATE="$CASE_ST" LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_TRIES=4 bash "$SCRIPT" 11.54.1 2>&1)"; second_rc=$?
{ [ $first_rc -eq 0 ] && [ $second_rc -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.54.1 ] && [ "$(cat "$CASE_ST/next")" = 11.54.1 ]; } \
    && ok "latest dragged down after the first settle is restored by a second run" || bad "late: rc=$first_rc/$second_rc latest=$(cat "$CASE_ST/latest") $second_out"

STUB_PKG=loki-mode-sdk run_case sdk-late "1.0.0 1.0.1 1.0.2" 1.0.1 1.0.1 1.0.2
printf '%s\n' 1.0.1 > "$CASE_ST/latest"; printf '%s\n' 1.0.2 > "$CASE_ST/next"
sdk_out="$(PATH="$WORK/bin:$PATH" STUB_STATE="$CASE_ST" STUB_PKG=loki-mode-sdk LOKI_DISTTAG_PKG=loki-mode-sdk LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_TRIES=4 bash "$SCRIPT" 1.0.2 2>&1)"; sdk_rc=$?
{ [ $sdk_rc -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 1.0.2 ]; } \
    && ok "sdk: latest dragged down after the first settle is restored by a second run" || bad "sdk-late: rc=$sdk_rc $sdk_out"

run_case idem "11.54.0 11.54.1" 11.54.1 11.54.1 11.54.1
{ [ $CASE_RC -eq 0 ] && [ ! -s "$CASE_ST/log" ]; } \
    && ok "a converge run on settled tags writes nothing" || bad "idem: rc=$CASE_RC log=$(cat "$CASE_ST/log")"

# rev-a repro: the first read of each tag says 11.54.2, later reads say 11.54.3
# (another run moved the tags). The script must write nothing and leave 11.54.3.
STUB_FRESH=11.54.3 run_case fresh "11.54.1 11.54.2" 11.54.2 11.54.2 11.54.2
{ [ ! -s "$CASE_ST/log" ] && [ "$(cat "$CASE_ST/latest")" = 11.54.3 ] && [ "$(cat "$CASE_ST/next")" = 11.54.3 ]; } \
    && ok "a tag read fresh-higher than the target is never written backwards" || bad "fresh: rc=$CASE_RC log=$(cat "$CASE_ST/log") latest=$(cat "$CASE_ST/latest")"


# FC-DIST-TAG-SETTLE-WINDOW-SHORTER-THAN-REGISTRY-DELAY: the registry lists the new
# version only after several reads (measured 192s to 312s after publish) and drops a
# tag write for a version it has not materialized. No tag may be written before the
# version is listed with a time entry; the old script wrote at once and ran out of tries.
STUB_MAT_S=60 STUB_HIDE_VER=11.55.1 STUB_MATERIALIZE_AFTER=6 run_case mat "11.55.0 11.55.1" 11.55.0 11.55.0 11.55.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.55.1 ] && [ "$(cat "$CASE_ST/next")" = 11.55.1 ] && ! grep -q '^dropped' "$CASE_ST/log"; } \
    && ok "no tag is written until the registry lists the version; then both tags settle" || bad "mat: rc=$CASE_RC log=$(cat "$CASE_ST/log") $CASE_OUT"

# A version that never materializes: bounded wait, zero writes, non-zero exit.
ST="$WORK/never"; mkdir -p "$ST"; printf '%s\n' 11.55.0 11.55.1 > "$ST/versions"; echo 11.55.0 > "$ST/latest"; echo 11.55.0 > "$ST/next"; : > "$ST/log"
never_out="$(env PATH="$WORK/bin:$PATH" STUB_STATE="$ST" STUB_HIDE_VER=11.55.1 STUB_MATERIALIZE_AFTER=999999 LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_MATERIALIZE_S=1 bash "$SCRIPT" 11.55.1 2>&1)"; never_rc=$?
{ [ $never_rc -ne 0 ] && [ ! -s "$ST/log" ] && [ "$(cat "$ST/latest")" = 11.55.0 ] && grep -q "refusing to write any tag" <<<"$never_out"; } \
    && ok "a version the registry never lists fails closed with zero tag writes" || bad "never: rc=$never_rc log=$(cat "$ST/log") $never_out"

# FC-DISTTAG-SETTLE-READS-CACHED-PACKUMENT: the cached packument (npm view dist-tags.*)
# keeps the old tags after the writes land; only `npm dist-tag ls` is current. The settle
# check must read the uncached endpoint, so a stale view never fails a converged run.
run_case stale "11.55.0 11.55.1" 11.55.0 11.55.0 11.55.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.55.1 ] && [ "$(cat "$CASE_ST/next")" = 11.55.1 ]; } \
    && ok "settle reads dist-tag ls, not the stale cached packument" || bad "stale: rc=$CASE_RC $CASE_OUT"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
