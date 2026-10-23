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
        printf '['; paste -sd, "$ST/versions" | sed 's/\([0-9.]*\)/"\1"/g'; printf ']\n' ;;
    "view $PKGN dist-tags."*)
        tag="${3#dist-tags.}"
        # STUB_FRESH=<ver>: the first read of each tag returns the state file, every
        # later read returns <ver> (another run moved the tag in between).
        if [ -n "${STUB_FRESH:-}" ]; then
            n=$(( $(cat "$ST/reads.$tag" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ST/reads.$tag"
            # STUB_FRESH=EMPTY: later reads succeed with an empty answer.
            if [ "$n" -gt 1 ] && [ "$STUB_FRESH" = EMPTY ]; then exit 0; fi
            [ "$n" -gt 1 ] && printf '%s\n' "$STUB_FRESH" > "$ST/$tag"
        fi
        cat "$ST/$tag" ;;
    "dist-tag add $PKGN@"*)
        spec="$3"; tag="$4"; ver="${spec#"$PKGN"@}"
        echo "add $ver $tag" >> "$ST/log"
        printf '%s\n' "$ver" > "$ST/$tag"
        if [ "$tag" = latest ] && [ -n "${STUB_OVERTAKE:-}" ] && [ ! -e "$ST/overtook" ]; then
            : > "$ST/overtook"; printf '%s\n' "$STUB_OVERTAKE" > "$ST/latest"
        fi ;;
    *) echo "stub npm: unexpected $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$WORK/bin/npm"

# case NAME "versions" LATEST NEXT RUNVER [overtake]
run_case() {
    ST="$WORK/$1"; mkdir -p "$ST"
    printf '%s\n' $2 > "$ST/versions"; echo "$3" > "$ST/latest"; echo "$4" > "$ST/next"; : > "$ST/log"
    CASE_OUT="$(env PATH="$WORK/bin:$PATH" STUB_STATE="$ST" STUB_FRESH="${STUB_FRESH:-}" STUB_OVERTAKE="${6:-}" STUB_OUTAGE="${STUB_OUTAGE:-}" STUB_PKG="${STUB_PKG:-}" LOKI_DISTTAG_PKG="${STUB_PKG:-}" LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_TRIES=4 bash "$SCRIPT" "$5" 2>&1)"
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
        && grep -q "refusing to move latest (fail closed)" <<<"$CASE_OUT"; } \
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

# RQ-102 structural cases on release.yml: a settle failure in the publish job must
# not skip the converge job, and the publish tag step must not be fatal.
WF="${RELEASE_YML:-$ROOT/.github/workflows/release.yml}"
job_block() { awk -v j="  $1:" '$0==j{f=1;print;next} f&&/^  [A-Za-z0-9_-]+:/{exit} f{print}' "$WF"; }
for pair in "publish-npm verify-npm-registry" "publish-ts-sdk verify-sdk-registry"; do
    pub="${pair%% *}"; ver="${pair##* }"
    vb="$(job_block "$ver")"; pb="$(job_block "$pub")"
    gate="$(printf '%s\n' "$vb" | grep -E '^    if:' || true)"
    { printf '%s' "$gate" | grep -q '!cancelled()' \
        && ! printf '%s' "$gate" | grep -q 'always()' \
        && printf '%s' "$gate" | grep -q "needs.$pub.result != 'skipped'"; } \
        && ok "$ver runs when $pub fails (!cancelled() and not skipped)" || bad "$ver gate: '$gate'"
    tries="$(printf '%s\n' "$vb" | sed -n "s/.*LOKI_DISTTAG_TRIES: '\([0-9]*\)'.*/\1/p")"
    nap="$(printf '%s\n' "$vb" | sed -n "s/.*LOKI_DISTTAG_SLEEP: '\([0-9]*\)'.*/\1/p")"
    tmo="$(printf '%s\n' "$vb" | sed -n 's/^    timeout-minutes: \([0-9]*\)$/\1/p')"
    { [ -n "$tries" ] && [ -n "$nap" ] && [ $((tries * nap)) -ge 720 ] && [ "${tmo:-0}" -ge 40 ]; } \
        && ok "$ver converge window ${tries}x${nap}s >= 720s within timeout ${tmo}m" || bad "$ver window tries='$tries' nap='$nap' timeout='$tmo'"
    tagline="$(printf '%s\n' "$pb" | grep -E 'bash .*npm-dist-tags\.sh' | grep -v '^ *#' | head -1)"
    { printf '%s' "$tagline" | grep -qE '^ *(if|elif) ' && printf '%s' "$tagline" | grep -q 'LOKI_DISTTAG_TRIES=2'; } \
        && ok "$pub tag step is non-fatal (guarded, LOKI_DISTTAG_TRIES=2)" || bad "$pub tag step: '$tagline'"
done

# RQ-103: a late lower dist-tag write after the verify job exits is healed by a
# scheduled converge of both packages that reuses npm-dist-tags.sh (no tag logic of its own).
CW="${CONVERGE_YML:-$ROOT/.github/workflows/converge-dist-tags.yml}"
if [ -f "$CW" ]; then
    grep -qE "^    - cron: '\*/15 \* \* \* \*'" "$CW" && grep -q '^  schedule:' "$CW" \
        && ok "converge workflow runs on a 15 minute schedule" || bad "converge workflow has no 15 minute schedule"
    grep -qE 'pkg: \[loki-mode, loki-mode-sdk\]' "$CW" \
        && ok "converge covers loki-mode and loki-mode-sdk" || bad "converge does not cover both packages"
    grep -q 'bash scripts/npm-dist-tags.sh' "$CW" && ! grep -qE 'npm dist-tag (add|rm)' "$CW" \
        && ok "converge calls npm-dist-tags.sh and writes no tags itself" || bad "converge does not reuse npm-dist-tags.sh alone"
    grep -q 'npm view "${LOKI_DISTTAG_PKG}@${VERSION}"' "$CW" \
        && ok "converge skips a VERSION the registry does not serve yet" || bad "converge lacks the on-registry guard"
else
    bad "converge workflow missing: $CW"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
