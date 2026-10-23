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
        # STUB_TAG_LAG=<n>: an accepted write applies only after <n> further dist-tag ls reads.
        for tag in latest next; do
            if [ -f "$ST/pend.$tag" ]; then
                read -r pv pn < "$ST/pend.$tag"
                if [ "$pn" -le 1 ]; then printf '%s\n' "$pv" > "$ST/$tag"; rm -f "$ST/pend.$tag"; else echo "$pv $((pn - 1))" > "$ST/pend.$tag"; fi
            fi
        done
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
        # STUB_DROP_FIRST=1: the first accepted write of each tag is lost (never applies).
        if [ -n "${STUB_REJECT_ADD:-}" ]; then echo "npm error E403" >&2; exit 1; fi
        if [ -n "${STUB_DROP_FIRST:-}" ] && [ ! -e "$ST/dropped.$tag" ]; then : > "$ST/dropped.$tag"; exit 0; fi
        if [ -n "${STUB_TAG_LAG:-}" ]; then echo "$ver $STUB_TAG_LAG" > "$ST/pend.$tag"; exit 0; fi
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
# Uncached read only: without the no-cache header the registry answers from a CDN cache.
case "$*" in *"Cache-Control: no-cache"*) ;; *) echo 404; exit 0 ;; esac
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
    CASE_OUT="$(env PATH="$WORK/bin:$PATH" STUB_STATE="$ST" STUB_FRESH="${STUB_FRESH:-}" STUB_OVERTAKE="${6:-}" STUB_OUTAGE="${STUB_OUTAGE:-}" STUB_PKG="${STUB_PKG:-}" STUB_HIDE_VER="${STUB_HIDE_VER:-}" STUB_MATERIALIZE_AFTER="${STUB_MATERIALIZE_AFTER:-}" STUB_TAG_LAG="${STUB_TAG_LAG:-}" STUB_DROP_FIRST="${STUB_DROP_FIRST:-}" STUB_REJECT_ADD="${STUB_REJECT_ADD:-}" LOKI_DISTTAG_LAG_FATAL="${LAG_FATAL_T:-1}" LOKI_DISTTAG_PKG="${STUB_PKG:-}" LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_TRIES="${TRIES_T:-4}" LOKI_DISTTAG_MATERIALIZE_S="${STUB_MAT_S:-1}" bash "$SCRIPT" "$5" 2>&1)"
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
# Live evidence 2026-10-23 (runs 11.60.5 to 11.60.7): next stayed behind latest. A run that
# stops between the two writes must have written next first.
{ [ "$(grep -m1 '^add ' "$CASE_ST/log" | awk '{print $3}')" = next ]; } \
    && ok "next is written before latest" || bad "order: $(cat "$CASE_ST/log")"

# Measured 2026-10-23 (07:17Z): each accepted tag write applies on its own, minutes later
# (next read 11.60.8 while latest still read 11.60.7). A lagging tag is waited on, never
# rewritten: exactly one write per tag, and both end at the published version.
TRIES_T=40 STUB_TAG_LAG=9 run_case lag "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.56.1 ] && [ "$(cat "$CASE_ST/next")" = 11.56.1 ] \
    && [ "$(grep -c '^add .* latest' "$CASE_ST/log")" = 1 ] && [ "$(grep -c '^add .* next' "$CASE_ST/log")" = 1 ]; } \
    && ok "a tag that applies late is waited on with one write per tag" || bad "lag: rc=$CASE_RC log=$(cat "$CASE_ST/log") $CASE_OUT"

# A write that is accepted but never applies fails loud once the window is spent.
STUB_TAG_LAG=999 run_case nolag "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
{ [ $CASE_RC -ne 0 ] && grep -q "did not settle" <<<"$CASE_OUT" && [ "$(grep -c '^add .* latest' "$CASE_ST/log")" = 2 ]; } \
    && ok "a tag that never applies fails the job after exactly one rewrite" || bad "nolag: rc=$CASE_RC $CASE_OUT"

# 11.60.8 evidence: an accepted latest write never applied. Late in the window it is
# rewritten once with a named warning, and the run then settles.
STUB_DROP_FIRST=1 run_case drop "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
{ [ $CASE_RC -eq 0 ] && [ "$(cat "$CASE_ST/latest")" = 11.56.1 ] && [ "$(cat "$CASE_ST/next")" = 11.56.1 ] \
    && grep -q "DISTTAG-WRITE-NOT-APPLIED" <<<"$CASE_OUT" \
    && [ "$(grep -c '^add .* latest' "$CASE_ST/log")" = 2 ]; } \
    && ok "a lost tag write is rewritten once with a named warning" || bad "drop: rc=$CASE_RC log=$(cat "$CASE_ST/log") $CASE_OUT"

# N2: the lost-write rewrite fires at half the read window, not on the last read, so the
# rewritten write still has the second half of the window to apply. Window 40 reads:
# the warning must name read 20, and a rewrite moved back to the last read (39) must fail.
TRIES_T=40 STUB_DROP_FIRST=1 run_case half "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
{ [ $CASE_RC -eq 0 ] && grep -q "after 20 reads; re-writing" <<<"$CASE_OUT"; } \
    && ok "a lost write is rewritten at half the window (read 20 of 40)" || bad "half: rc=$CASE_RC $CASE_OUT"
cp "$SCRIPT" "$WORK/late.sh"; sed -i.bak 's|\$((TRIES / 2))|$((TRIES - 1))|' "$WORK/late.sh"
TRIES_T=40 STUB_DROP_FIRST=1 SCRIPT="$WORK/late.sh" run_case halfmut "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
grep -q "after 20 reads; re-writing" <<<"$CASE_OUT" && bad "mutant: rewrite at the last read not caught" || ok "mutant: rewrite at the last read is caught"

# Lock-holding mode (publish-npm): lag is a named warning with exit 0 and one write
# per tag; a rejected write still fails; an unmaterialized version writes nothing.
LAG_FATAL_T=0 STUB_TAG_LAG=999 run_case plag "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
{ [ $CASE_RC -eq 0 ] && grep -q "DISTTAG-NOT-SETTLED-YET" <<<"$CASE_OUT" \
    && [ "$(grep -c '^add ' "$CASE_ST/log")" = 2 ]; } \
    && ok "publish mode: lag warns by name, exits 0, one write per tag" || bad "plag: rc=$CASE_RC log=$(cat "$CASE_ST/log") $CASE_OUT"

LAG_FATAL_T=0 STUB_DROP_FIRST=1 run_case pdrop "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
{ [ $CASE_RC -eq 0 ] && ! grep -q "DISTTAG-WRITE-NOT-APPLIED" <<<"$CASE_OUT" \
    && [ "$(grep -c '^add .* latest' "$CASE_ST/log")" = 1 ]; } \
    && ok "publish mode: a lost write is not rewritten (verify does that)" || bad "pdrop: rc=$CASE_RC log=$(cat "$CASE_ST/log") $CASE_OUT"

LAG_FATAL_T=0 STUB_REJECT_ADD=1 run_case prej "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
{ [ $CASE_RC -ne 0 ] && grep -q "was rejected" <<<"$CASE_OUT"; } \
    && ok "publish mode: a rejected write fails the job" || bad "prej: rc=$CASE_RC $CASE_OUT"

STUB_REJECT_ADD=1 run_case frej "11.56.0 11.56.1" 11.56.0 11.56.0 11.56.1
[ $CASE_RC -ne 0 ] && ok "verify mode: a rejected write never settles and fails" || bad "frej: rc=$CASE_RC"

ST="$WORK/pnever"; mkdir -p "$ST"; printf '%s\n' 11.55.0 11.55.1 > "$ST/versions"; echo 11.55.0 > "$ST/latest"; echo 11.55.0 > "$ST/next"; : > "$ST/log"
pn_out="$(env PATH="$WORK/bin:$PATH" STUB_STATE="$ST" STUB_HIDE_VER=11.55.1 STUB_MATERIALIZE_AFTER=999999 LOKI_DISTTAG_LAG_FATAL=0 LOKI_DISTTAG_SLEEP=0 LOKI_DISTTAG_MATERIALIZE_S=1 bash "$SCRIPT" 11.55.1 2>&1)"; pn_rc=$?
{ [ $pn_rc -eq 0 ] && [ ! -s "$ST/log" ] && grep -q "DISTTAG-VERSION-NOT-MATERIALIZED" <<<"$pn_out"; } \
    && ok "publish mode: an unmaterialized version warns, writes nothing, exits 0" || bad "pnever: rc=$pn_rc $pn_out"

# Workflow shape: the lock-holding jobs poll at most 120 s in the non-fatal mode and
# keep a 10 minute budget; the off-lock verify jobs keep the fatal long poll.
# check_workflow <file> prints a reason and returns 1 on a violation.
check_workflow() {
    python3 - "$1" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
def job(name):
    m = re.search(r'\n  %s:\n(.*?)(?=\n  [a-z0-9-]+:\n|\Z)' % re.escape(name), s, re.S)
    return m.group(1) if m else ''
bad = []
for name in ('publish-npm', 'publish-ts-sdk'):
    b = job(name)
    calls = [l for l in b.splitlines() if 'npm-dist-tags.sh' in l and not l.lstrip().startswith('#')]
    if not calls: bad.append(name + ': no dist-tags call')
    blob = b
    if 'LOKI_DISTTAG_LAG_FATAL=0' not in blob: bad.append(name + ': not warn-only')
    m = re.search(r'LOKI_DISTTAG_SETTLE_S=(\d+)', blob)
    if not m or int(m.group(1)) > 120: bad.append(name + ': publish poll bound over 120 s')
    t = re.search(r'timeout-minutes: (\d+)', b)
    if not t or int(t.group(1)) > 10: bad.append(name + ': timeout over 10')
for name in ('verify-npm-registry', 'verify-sdk-registry'):
    b = job(name)
    if 'LAG_FATAL=0' in b or 'SETTLE_S=' in b: bad.append(name + ': verify must keep the default long fatal poll')
    t = re.search(r'timeout-minutes: (\d+)', b)
    if not t or int(t.group(1)) < 45: bad.append(name + ': timeout under the poll + materialize + settle budget (45)')
    code = '\n'.join(l for l in b.splitlines() if not l.lstrip().startswith('#'))
    # B2: proof is an uncached version document + tarball read; a cached packument read (npm view) is not.
    if 'npm view' in code: bad.append(name + ': npm view (cached packument) used as proof')
    if code.count('Cache-Control: no-cache') < 2: bad.append(name + ': version document and tarball must both be read uncached')
    if not re.search(r'\"\$vcode\" = 200 \] && \[ \"\$tcode\" = 200', code): bad.append(name + ': poll must require the version document AND the tarball')
    if 'rc=0' not in code or '|| rc=$?' not in code: bad.append(name + ': converge exit status must survive bash -e')
    # B4/N1: poll and converge are one step, and nothing between the poll and the script call can exit.
    steps = re.split(r'\n      - name:', code)
    conv = [x for x in steps if 'npm-dist-tags.sh' in x and 'bash scripts' in x]
    if len(conv) != 1: bad.append(name + ': converge call not in exactly one step')
    else:
        x = conv[0]
        if 'seq 1' not in x or 'Cache-Control' not in x: bad.append(name + ': poll and converge are separate steps')
        else:
            between = x[x.index('done'):x.index('bash scripts')]
            if re.search(r'\bexit\b', between): bad.append(name + ': converge is skipped when the poll fails')
print('; '.join(bad)); sys.exit(1 if bad else 0)
PY
}
WF="$(cd "$(dirname "$SCRIPT")/.." && pwd)/.github/workflows/release.yml"
wf_out="$(check_workflow "$WF")" && ok "release.yml: publish jobs poll <= 120 s warn-only, verify jobs keep the long fatal poll" || bad "workflow shape: $wf_out"
sed 's/LOKI_DISTTAG_SETTLE_S=120/LOKI_DISTTAG_SETTLE_S=840/' "$WF" > "$WORK/mut.yml"
check_workflow "$WORK/mut.yml" >/dev/null && bad "mutant: long poll back in publish-npm not caught" || ok "mutant: the long poll back in publish-npm is caught"
python3 - "$WF" "$WORK" <<'PY2'
import sys, re
s = open(sys.argv[1]).read(); w = sys.argv[2]
open(w + '/mut_npmview.yml', 'w').write(s.replace('served=0\n', 'served=0\n          npm view loki-mode version --prefer-online\n', 1))
# converge skipped when the poll fails
open(w + '/mut_exit.yml', 'w').write(s.replace('          # Converge always runs', '          [ "$served" = 1 ] || exit 1\n          # Converge always runs', 1))
# prove and converge split into two steps
open(w + '/mut_split.yml', 'w').write(s.replace('          # Converge always runs', '      - name: Converge\n        run: |\n          # Converge always runs', 1))
# timeout back to 25
open(w + '/mut_to.yml', 'w').write(s.replace('timeout-minutes: 45', 'timeout-minutes: 25'))
PY2
python3 - "$WF" "$WORK" <<'PY3'
import sys
s = open(sys.argv[1]).read(); w = sys.argv[2]
open(w + '/mut_vonly.yml', 'w').write(s.replace('[ "$vcode" = 200 ] && [ "$tcode" = 200 ]', '[ "$vcode" = 200 ]'))
open(w + '/mut_rc.yml', 'w').write(s.replace('"$VERSION" || rc=$?', '"$VERSION"; rc=$?'))
PY3
for m in npmview exit split to vonly rc; do
    check_workflow "$WORK/mut_$m.yml" >/dev/null && bad "mutant $m: workflow shape not caught" || ok "mutant: workflow $m is caught"
done

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
