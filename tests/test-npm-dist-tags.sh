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
ST="$STUB_STATE"
case "$1 $2 $3" in
    "view loki-mode versions")
        printf '['; paste -sd, "$ST/versions" | sed 's/\([0-9.]*\)/"\1"/g'; printf ']\n' ;;
    "view loki-mode dist-tags.latest") cat "$ST/latest" ;;
    "view loki-mode dist-tags.next") cat "$ST/next" ;;
    "dist-tag add loki-mode@"*)
        spec="$3"; tag="$4"; ver="${spec#loki-mode@}"
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
    CASE_OUT="$(PATH="$WORK/bin:$PATH" STUB_STATE="$ST" STUB_OVERTAKE="${6:-}" LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_TRIES=4 bash "$SCRIPT" "$5" 2>&1)"
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

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
