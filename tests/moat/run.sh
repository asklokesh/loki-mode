#!/usr/bin/env bash
#
# tests/moat/run.sh -- the moat suite runner. A release that fails it does not ship.
#
# Runs every property script tests/moat/p<N>-<slug>.sh (exactly one for each of
# P1..P9), parses their "CASE <ID> PASS|FAIL <description>" lines, and fails
# the suite on anything that could let a skipped or regressed check read as a
# pass: a crash, a hang, a script with zero cases, a malformed or duplicate
# case, a case filed under the wrong property, a FAIL that is not pending, a
# PASS that still is, a pending ID nobody emits, a registered ID nobody emits,
# or an emitted ID nobody registered.
#
# tests/moat/cases.txt registers every case ID the suite must emit. A case that
# stops being emitted as a valid stdout CASE line (deleted, renamed, indented,
# sent to stderr) fails as UNEMITTED, and a new case must be registered.
# tests/moat/pending.txt lists the cases allowed to FAIL today.
#
# THE RATCHETS, against EVERY release tag (vX.Y.Z, nothing else) reachable
# from HEAD that does not point at HEAD itself: a pending ID must be pending at
# every such tag that has a pending.txt, and every ID registered at any such
# tag must still be registered, so nothing can be parked as pending, and no
# case can be deleted, to buy a green run, not even through a merged side
# branch's older release tag. Baselines are always read from
# tests/moat/pending.txt and tests/moat/cases.txt at the tags, so moving this
# directory cannot reset them.
#
# Exit: 0 no rule failed, 1 a rule failed, 2 could not check (no release tag
# reachable, or a baseline unreadable). A definite failure (1) wins over
# could-not-check (2). Exit 0 is not "the moat is proven": only 9 of 9
# properties proven is.
# Self-test: tests/test-moat-runner.sh.
#
# Written for bash 3.2 (macOS /bin/bash): no associative arrays, no mapfile,
# no wait -n. Sets of IDs are sorted flat files compared with comm.

set -uo pipefail
export LC_ALL=C
# Each property script exports these itself; set here too so one that forgets
# still cannot phone home or wait on an update check under the gate.
export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
  LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false LOKI_NO_BROWSER=1 LOKI_CONTROL=0
# Route and fallback selectors inherited from the caller's shell would silently
# move every unmarked call onto one route. A script that needs a route sets it
# per call.
unset LOKI_LEGACY_BASH LOKI_SDK_MODE LOKI_SDK_LOOP P1_FORCE_EGRESS_FALLBACK
# A git hook exports GIT_DIR (local-ci runs from pre-push). Inherited, it makes
# git take the current directory as the work tree top, so the ratchets would
# look for their baselines in the wrong place, and property scripts' git calls
# would land in the caller's repo. git finds the repo from this file instead.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR \
  GIT_ALTERNATE_OBJECT_DIRECTORIES

# Seconds one property script may run before it is killed and fails as TIMEOUT.
# Measured 2026-09-25: each script takes 1-13s. No env override on purpose.
MOAT_SCRIPT_TIMEOUT=300

# pwd -P: git reports physical paths, and macOS $TMPDIR sits behind a symlink.
MOAT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PENDING="$MOAT_DIR/pending.txt"
CASES="$MOAT_DIR/cases.txt"
W="$(mktemp -d "${TMPDIR:-/tmp}/moat-run.XXXXXX")" || { echo "moat: cannot create a temp dir" >&2; exit 2; }
trap 'rm -rf "$W"' EXIT

NAMES=("" "portable proof" "honest verdict" "the Wall" "model freedom" "sovereignty" \
  "in-place brownfield" "no fabricated data" "load-bearing proof" "Rule of Two")
ID_RE='P[1-9][.][a-z0-9]+(-[a-z0-9]+)*'

ERRORS=0
# fail N MESSAGE: count a suite failure and charge it to property N (0 = none).
fail() {
  ERRORS=$((ERRORS + 1))
  echo "FAIL: $2"
  [ "$1" = 0 ] || echo "$2" >> "$W/p$1.bad"
}
# prop_of ID: the property number an ID belongs to (P3.foo -> 3), 0 if none.
prop_of() { case "$1" in P[1-9].*) echo "${1:1:1}" ;; *) echo 0 ;; esac; }
# list_ids FILE: the IDs of a pending or registry file (comments and blank
# lines skipped), sorted and unique.
list_ids() { awk '/^[ \t]*#/ || NF == 0 {next} {print $1}' "$1" | sort -u; }

# kill_tree PID SIG: freeze PID so it cannot fork, signal its descendants
# depth-first, then PID, then thaw it so a pending TERM is delivered (a killed
# property script still runs its EXIT trap and removes its temp dir).
# ponytail: follows live parent links, so a child that already re-parented
# (daemonized) escapes; without pgrep only PID itself is signalled.
kill_tree() {
  local kid
  kill -STOP "$1" 2> /dev/null || return 0
  for kid in $(pgrep -P "$1" 2> /dev/null); do kill_tree "$kid" "$2"; done
  kill "-$2" "$1" 2> /dev/null
  kill -CONT "$1" 2> /dev/null
}

# --- 1. discover: exactly one script per property -----------------------------
for f in "$MOAT_DIR"/p[0-9]*-*.sh; do
  [ -e "$f" ] || continue
  base="${f##*/}"
  n="${base#p}"; n="${n%%-*}"
  case "$n" in
    [1-9]) ;;
    *) fail 0 "UNEXPECTED SCRIPT $base: property files are p1..p9 only"; continue ;;
  esac
  if [ -e "$W/p$n.file" ]; then
    fail "$n" "DUPLICATE SCRIPT P$n: both $(cat "$W/p$n.file") and $base"
    continue
  fi
  echo "$base" > "$W/p$n.file"
done

for n in 1 2 3 4 5 6 7 8 9; do
  if [ ! -e "$W/p$n.file" ]; then
    fail "$n" "MISSING P$n ${NAMES[$n]}: no tests/moat/p$n-*.sh script"
    continue
  fi
  # Each script gets its own output files; parallel is safe because every
  # property script owns its own temp dir by contract.
  (
    s=$(date +%s)
    bash "$MOAT_DIR/$(cat "$W/p$n.file")" > "$W/p$n.out" 2> "$W/p$n.err" < /dev/null &
    pid=$!
    # Watchdog: a hung script must not hang the suite. It polls in 1s steps
    # and is killed as soon as the script ends, and it writes to /dev/null, so
    # it never outlives the script holding the caller's output pipe open.
    (
      while [ $(( $(date +%s) - s )) -lt "$MOAT_SCRIPT_TIMEOUT" ]; do sleep 1; done
      : > "$W/p$n.timeout"
      kill_tree "$pid" TERM
      sleep 5
      kill_tree "$pid" KILL
    ) > /dev/null 2>&1 < /dev/null &
    wd=$!
    wait "$pid" 2> /dev/null
    rc=$?
    kill "$wd" 2> /dev/null
    wait "$wd" 2> /dev/null
    echo "$rc $(( $(date +%s) - s ))" > "$W/p$n.rc"
  ) &
done
wait

# --- 2. parse CASE lines ------------------------------------------------------
: > "$W/cases"
for n in 1 2 3 4 5 6 7 8 9; do
  [ -e "$W/p$n.file" ] || continue
  base="$(cat "$W/p$n.file")"
  rc=killed secs='?'
  [ -s "$W/p$n.rc" ] && read -r rc secs < "$W/p$n.rc"
  echo "--- P$n ${NAMES[$n]}: $base (exit $rc, ${secs}s)"

  grep '^CASE ' "$W/p$n.out" > "$W/p$n.caselines"
  grep -vxE "CASE $ID_RE (PASS|FAIL) .+" "$W/p$n.caselines" > "$W/p$n.malformed"
  grep -xE "CASE $ID_RE (PASS|FAIL) .+" "$W/p$n.caselines" > "$W/p$n.valid"

  count=0 had_fail=0
  while IFS= read -r line; do
    fail "$n" "MALFORMED $base: '$line' (want: CASE P$n.<kebab-id> PASS|FAIL <description>)"
  done < "$W/p$n.malformed"
  while read -r _ id status desc; do
    count=$((count + 1))
    echo "  CASE $id $status $desc"
    [ "$status" = FAIL ] && had_fail=1
    if [ "$(prop_of "$id")" != "$n" ]; then
      fail "$n" "WRONG PREFIX $id in $base: a p$n script may only emit P$n.* cases"
      continue
    fi
    echo "$id $status" >> "$W/cases"
  done < "$W/p$n.valid"

  # The lines a hung script printed before it was killed still count above;
  # the cases it never reached fail as UNEMITTED below.
  if [ -e "$W/p$n.timeout" ]; then
    fail "$n" "TIMEOUT $base: still running after ${MOAT_SCRIPT_TIMEOUT}s, killed (a hung check is not a pass)"
  elif [ "$rc" != 0 ]; then
    fail "$n" "CRASH $base: exited $rc (a property script exits 0 whatever its cases say)"
  fi
  [ "$count" -gt 0 ] || fail "$n" "VACUOUS $base: emitted zero CASE lines"

  # Diagnostics only where there is something to diagnose, and never on stdout.
  if [ "$had_fail" = 1 ] || [ -s "$W/p$n.bad" ]; then
    { grep -v '^CASE ' "$W/p$n.out"; cat "$W/p$n.err"; } | tail -n 40 | sed "s/^/[p$n] /" >&2
  fi
done

awk '{print $1}' "$W/cases" | sort | uniq -d > "$W/dups"
while read -r id; do
  fail "$(prop_of "$id")" "DUPLICATE $id: case ID emitted more than once"
done < "$W/dups"

awk '$2 == "FAIL" {print $1}' "$W/cases" | sort -u > "$W/fail.ids"
awk '$2 == "PASS" {print $1}' "$W/cases" | sort -u > "$W/pass.ids"
awk '{print $1}' "$W/cases" | sort -u > "$W/all.ids"

# --- 3. pending list ----------------------------------------------------------
if [ -f "$PENDING" ]; then
  awk -v re="^$ID_RE\$" '
    /^[ \t]*#/ || NF == 0 {next}
    !($1 ~ re && $2 ~ /^(M[0-9]+|v[0-9]+\.[0-9]+\.[0-9]+)$/ && NF >= 3) {print NR ": " $0}
  ' "$PENDING" > "$W/pending.bad"
  while IFS= read -r line; do
    fail 0 "MALFORMED PENDING line $line (want: <ID> <milestone> <reason...>)"
  done < "$W/pending.bad"
  list_ids "$PENDING" > "$W/pending.ids"
  awk '/^[ \t]*#/ || NF == 0 {next} {print $1}' "$PENDING" | sort | uniq -d > "$W/pending.dups"
  while read -r id; do
    fail "$(prop_of "$id")" "DUPLICATE PENDING $id: listed more than once in tests/moat/pending.txt"
  done < "$W/pending.dups"
else
  fail 0 "MISSING tests/moat/pending.txt (an absent list would make every FAIL a regression; create it)"
  : > "$W/pending.ids"
fi

while read -r id; do
  fail "$(prop_of "$id")" "REGRESSION $id: FAIL but not listed in tests/moat/pending.txt"
done < <(comm -23 "$W/fail.ids" "$W/pending.ids")
while read -r id; do
  fail "$(prop_of "$id")" "PROMOTE $id: remove it from tests/moat/pending.txt"
done < <(comm -12 "$W/pass.ids" "$W/pending.ids")
while read -r id; do
  fail "$(prop_of "$id")" "VANISHED $id: listed in tests/moat/pending.txt but no script emitted it"
done < <(comm -23 "$W/pending.ids" "$W/all.ids")

# --- 4. the case registry -------------------------------------------------------
if [ -f "$CASES" ]; then
  awk -v re="^$ID_RE\$" '/^[ \t]*#/ || NF == 0 {next} !($1 ~ re && NF == 1) {print NR ": " $0}' \
    "$CASES" > "$W/registry.bad"
  while IFS= read -r line; do
    fail 0 "MALFORMED REGISTRY line $line (want: one case ID per line)"
  done < "$W/registry.bad"
  list_ids "$CASES" > "$W/registry.ids"
  awk '/^[ \t]*#/ || NF == 0 {next} {print $1}' "$CASES" | sort | uniq -d > "$W/registry.dups"
  while read -r id; do
    fail "$(prop_of "$id")" "DUPLICATE REGISTRY $id: listed more than once in tests/moat/cases.txt"
  done < "$W/registry.dups"
else
  fail 0 "MISSING tests/moat/cases.txt (the registry of case IDs the suite must emit; create it)"
  : > "$W/registry.ids"
fi

while read -r id; do
  fail "$(prop_of "$id")" "UNEMITTED $id: registered in tests/moat/cases.txt but no script printed a valid CASE line for it on stdout"
done < <(comm -23 "$W/registry.ids" "$W/all.ids")
while read -r id; do
  fail "$(prop_of "$id")" "UNREGISTERED $id: emitted but not in tests/moat/cases.txt (register it)"
done < <(comm -13 "$W/registry.ids" "$W/all.ids")

# --- 5. the ratchets: pending may only shrink, the registry may only grow --------
# The baselines are EVERY release tag reachable from HEAD, not the nearest one:
# git describe picks the tag nearest by commit count, so a side branch's older
# release tag merged into main (a hotfix cut before the moat existed, or one
# cut before a case was promoted) became the baseline and reset the ratchet.
# Only exact vX.Y.Z tags count: a v1.1.1-scratch tag would grandfather in
# whatever it parked. Tags that point at HEAD are excluded: a tagged release
# commit is checked against the releases before it, never against its own
# lists (which would always pass), and a lone tagged root commit lands in
# could-not-check with no special case.
# ponytail: a dirty tree on a tagged HEAD is also checked against the previous
# releases, so an uncommitted re-park there is caught once it is committed.
# git runs against the repo holding THIS file, so a copy of run.sh in another
# repo (the self-test) ratchets against that repo's tags.
COULD_NOT_CHECK=0
could_not_check() {
  COULD_NOT_CHECK=1
  echo "could not check: $1"
  sed 's/^/[git] /' "$W/git.err" >&2
}
RELEASE_RE='^v[0-9]+[.][0-9]+[.][0-9]+$'
BOOTSTRAP=""

# symlinked_at REFS_FILE OUT NAME...: appends one "ref:path" line (the same
# shape git grep -l prints) to OUT per tag in REFS_FILE (bare tag names, one
# per line) x NAME whose tests/moat/NAME blob is a symlink (mode 120000).
# git grep -l and -L both silently SKIP a symlink blob: neither lists it as a
# match nor as an empty file, so it is indistinguishable from a tag that never
# had the file at all, and a real baseline parked behind a symlink drops out
# of the ratchet with no warning. git cat-file --batch-check reports every
# blob's mode regardless of what it points to, in one call over every
# candidate tag x name pair (same per-tag-call cost concern as the grep
# calls above). Never truncates OUT: read_baselines wants a fresh file,
# unreached_release wants to add to its existing grep hits.
symlinked_at() {
  local refs_file="$1" out="$2" name
  shift 2
  [ -s "$refs_file" ] || return 0
  { for name in "$@"; do
      awk -v n="$name" '{ r = "refs/tags/" $1 ":tests/moat/" n; print r, r }' "$refs_file"
    done
  } | git -C "$top" cat-file --batch-check='%(objectmode) %(rest)' 2>> "$W/git.err" \
    | awk '$1 == "120000" { print $2 }' >> "$out"
}

# read_baselines: tests/moat/pending.txt and cases.txt at every tag in
# $W/cands (newest first), in two git calls. Per-tag git calls took 6.5s over
# the repo's 842 tags. Writes $W/NAME.tags (the tags carrying NAME, newest
# first), $W/NAME.pairs ("<tag> <id>" for each ID NAME lists at that tag) and
# $W/NAME.viol ("<id> <tag>" per ratchet violation, naming the newest tag).
# Returns 1 when any tree or file could not be read, or a step failed: that
# must never be taken for an absent file or a check that found nothing (a
# bootstrap, or an empty violation list, would accept any list).
read_baselines() {
  local refs rc_lines rc_empty ref path
  refs="$(sed 's|^|refs/tags/|' "$W/cands")"
  # -F -e '' matches every line whatever grep.patternType says; -L lists the
  # empty (0-byte) files the first call cannot see. The explicit --no-* flags
  # keep a user's grep config from reshaping the "ref:path:line" output.
  # shellcheck disable=SC2086  # one ref per word; release tags have no spaces
  git -C "$top" grep --no-color --no-line-number --no-column -a -F -e '' $refs \
    -- tests/moat/pending.txt tests/moat/cases.txt > "$W/base.lines" 2> "$W/git.err"
  rc_lines=$?
  # shellcheck disable=SC2086
  git -C "$top" grep -L --no-color -a -F -e '' $refs \
    -- tests/moat/pending.txt tests/moat/cases.txt > "$W/base.empty" 2>> "$W/git.err"
  rc_empty=$?
  # A symlinked pending.txt/cases.txt (mode 120000) is invisible to both calls
  # above (see symlinked_at): refuse it by name instead of letting it silently
  # read as a tag that never carried the file.
  : > "$W/base.symlink"
  symlinked_at "$W/cands" "$W/base.symlink" pending.txt cases.txt
  if [ -s "$W/base.symlink" ]; then
    while IFS=: read -r ref path; do
      echo "refusing to read a symlinked $path at ${ref#refs/tags/} (git grep silently treats a symlink blob as absent, never as a baseline)" >> "$W/git.err"
    done < "$W/base.symlink"
  fi
  # Exit 1 is "no match". An unreadable tree is fatal (128), but an unreadable
  # blob only prints an error and still exits 0 or 1, so any stderr counts too.
  [ "$rc_lines" -le 1 ] && [ "$rc_empty" -le 1 ] && [ ! -s "$W/git.err" ] || return 1
  : > "$W/pending.txt.pairs"
  : > "$W/cases.txt.pairs"
  awk -v W="$W" '
    FILENAME == ARGV[1] { order[++n] = $1; next }
    {
      i = index($0, ":"); ref = substr($0, 1, i - 1); rest = substr($0, i + 1)
      j = index(rest, ":"); if (j == 0) j = length(rest) + 1
      path = substr(rest, 1, j - 1); line = substr(rest, j + 1)
      sub(/^refs\/tags\//, "", ref); sub(/^tests\/moat\//, "", path)
      carry[path, ref] = 1
      if (FILENAME == ARGV[3] || line ~ /^[ \t]*#/ || split(line, f) == 0) next
      print ref, f[1] > (W "/" path ".pairs")
    }
    END {
      for (k = 1; k <= n; k++) {
        if (("pending.txt", order[k]) in carry) print order[k] > (W "/pending.txt.tags")
        if (("cases.txt", order[k]) in carry) print order[k] > (W "/cases.txt.tags")
      }
      printf "" > (W "/pending.txt.tags"); printf "" > (W "/cases.txt.tags")
    }' "$W/cands" "$W/base.lines" "$W/base.empty" 2>> "$W/git.err" || return 1
  # pending: each current ID against the newest carrying tag it was not
  # pending at (the baseline is the intersection of every carrying tag).
  awk 'FILENAME == ARGV[1] { order[++n] = $1; next }
    FILENAME == ARGV[2] { was[$1 " " $2] = 1; next }
    { for (k = 1; k <= n; k++) if (!((order[k] " " $1) in was)) { print $1, order[k]; next } }' \
    "$W/pending.txt.tags" "$W/pending.txt.pairs" "$W/pending.ids" \
    > "$W/pending.txt.viol" 2>> "$W/git.err" || return 1
  # registry: each ID registered at any carrying tag (the union) and missing
  # now, named with the newest tag that registered it.
  awk 'FILENAME == ARGV[1] { rank[$1] = FNR; next }
    FILENAME == ARGV[2] { now[$1] = 1; next }
    !($2 in now) && (!($2 in at) || rank[$1] < rank[at[$2]]) { at[$2] = $1 }
    END { for (id in at) print id, at[id] }' \
    "$W/cases.txt.tags" "$W/registry.ids" "$W/cases.txt.pairs" 2>> "$W/git.err" \
    | sort > "$W/cases.txt.viol"
}

# unreached_release NAME: is it safe to call NAME (pending.txt or cases.txt) a
# bootstrap, with no release tag reachable from HEAD carrying it? Only if NO
# release tag anywhere is UNREACHED from HEAD (--no-merged: exists, but HEAD's
# history does not include it) while carrying a real NAME baseline. Otherwise
# a stale branch cut before that unreached release would silently accept its
# own regression as "nothing to ratchet against", when a real baseline exists
# on a tag this branch just has not merged yet.
#
# "Carries a real baseline" means git grep -l (non-empty match) OR git grep -L
# (present but 0-byte) hits the tag: the union of -l and -L over -F -e '' is
# exactly every tag whose tree has the file at all, matching read_baselines'
# own "carry" definition. A 0-byte pending.txt/cases.txt is the STRICTEST
# baseline there is (nothing pending, nothing registered), never an absent
# one; read_baselines' -L pass exists for the same reason.
#
# Returns 0: no unreached tag carries NAME, bootstrap is safe.
# Returns 1 after calling could_not_check: an unreached carrying tag exists,
# or a git step failed. Fails closed: never treat an error as "safe".
unreached_release() {
  local name="$1" refs rc_l rc_L
  if ! git -C "$top" tag --no-column --no-merged HEAD --sort=-v:refname \
    > "$W/tags.unreached" 2> "$W/git.err"; then
    could_not_check "cannot list the release tags unreached by HEAD (checking $name)"
    return 1
  fi
  grep -E "$RELEASE_RE" "$W/tags.unreached" > "$W/cands.unreached"
  case $? in
    1) return 0 ;;  # no unreached release tag at all: nothing to miss
    0) ;;           # unreached release tag(s) found, keep checking
    *) could_not_check "cannot scan the unreached release tags for $name"; return 1 ;;
  esac
  # Empty refs would make git grep search the WORKING TREE instead of no tags
  # at all, turning a real first-ever bootstrap into a false refusal on the
  # branch's own committed file. $W/cands.unreached is non-empty here (the
  # case 1 return above already handled empty), so this is unreachable, but
  # the guard stays because a future refactor must never remove it silently.
  refs="$(sed 's|^|refs/tags/|' "$W/cands.unreached")"
  [ -n "$refs" ] || return 0
  # shellcheck disable=SC2086  # one ref per word; release tags have no spaces
  git -C "$top" grep -l --no-color -a -F -e '' $refs -- "tests/moat/$name" \
    > "$W/unreached.$name.hits" 2> "$W/git.err"
  rc_l=$?
  # shellcheck disable=SC2086
  git -C "$top" grep -L --no-color -a -F -e '' $refs -- "tests/moat/$name" \
    >> "$W/unreached.$name.hits" 2>> "$W/git.err"
  rc_L=$?
  # A symlinked tests/moat/$name at an unreached tag is invisible to both
  # calls above (see symlinked_at): treat it exactly like a grep -l hit, so
  # the carrying-tag naming below fires instead of a silent bootstrap.
  symlinked_at "$W/cands.unreached" "$W/unreached.$name.hits" "$name"
  [ "$rc_l" -le 1 ] && [ "$rc_L" -le 1 ] && [ ! -s "$W/git.err" ] || {
    could_not_check "cannot read tests/moat/$name at an unreached release tag"
    return 1
  }
  if [ -s "$W/unreached.$name.hits" ]; then
    # Name the NEWEST unreached carrying tag. $W/cands.unreached is already
    # newest-first (--sort=-v:refname); picking the first line of it that also
    # hit is correct however many tags carried the file. A naive `sort -u` on
    # the hit lines keys on text before the first dot ("v1"), so v1.0.0 and
    # v1.1.0 collapse to one arbitrary line -- this walks cands.unreached
    # instead, which is already in the right order.
    could_not_check "$(awk 'NR == FNR { sub(/^refs\/tags\//, ""); sub(/:.*/, ""); hit[$0] = 1; next }
      ($0 in hit) { print; exit }' "$W/unreached.$name.hits" "$W/cands.unreached") carries tests/moat/$name but is not reachable from HEAD (bootstrap would silently accept a regression parked on a stale branch)"
    return 1
  fi
  return 0
}

# ratchet_summary NAME: "N release tag(s), newest vX" for the tags carrying NAME.
ratchet_summary() {
  echo "$(wc -l < "$W/$1.tags" | tr -d ' ') release tag(s), newest $(head -n 1 "$W/$1.tags")"
}

if top="$(git -C "$MOAT_DIR" rev-parse --show-toplevel 2> "$W/git.err")" \
  && prefix="$(git -C "$MOAT_DIR" rev-parse --show-prefix 2> "$W/git.err")"; then
  [ "$prefix" = "tests/moat/" ] || fail 0 "MISPLACED RUNNER: run.sh is at ${prefix}run.sh in its repo; it must live at tests/moat/run.sh (the ratchets read their baselines from tests/moat/ at the release tags)"
  # --no-contains HEAD: of the tags reachable from HEAD, only those pointing
  # at HEAD contain it. -v:refname sorts vX.Y.Z numerically, newest first.
  if ! git -C "$top" tag --no-column --merged HEAD --no-contains HEAD --sort=-v:refname \
    > "$W/tags.all" 2> "$W/git.err"; then
    could_not_check "cannot list the release tags reachable from HEAD"
  elif ! grep -E "$RELEASE_RE" "$W/tags.all" > "$W/cands"; then
    head_list="$(git -C "$top" tag --no-column --points-at HEAD 2> /dev/null | grep -E "$RELEASE_RE" | tr '\n' ' ')"
    head_list="${head_list% }"
    could_not_check "no release tag reachable; fetch tags${head_list:+ (tags at HEAD are not a baseline: $head_list)}"
  elif ! read_baselines; then
    could_not_check "cannot read tests/moat at the $(wc -l < "$W/cands" | tr -d ' ') reachable release tag(s) (newest $(head -n 1 "$W/cands"))"
  else
    ncands="$(wc -l < "$W/cands" | tr -d ' ') release tag(s), newest $(head -n 1 "$W/cands")"
    if [ -s "$W/pending.txt.tags" ]; then
      while read -r id at; do
        fail "$(prop_of "$id")" "pending list may only shrink: $id was not pending at $at"
      done < "$W/pending.txt.viol"
      echo "ratchet: checked against $(ratchet_summary pending.txt) ($(wc -l < "$W/pending.ids" | tr -d ' ') pending now)"
    elif unreached_release pending.txt; then
      echo "ratchet: bootstrap, no baseline at any of $ncands"
      BOOTSTRAP=1
    fi
    if [ -s "$W/cases.txt.tags" ]; then
      while read -r id at; do
        fail "$(prop_of "$id")" "case registry may only grow: $id was registered at $at (case IDs are permanent)"
      done < "$W/cases.txt.viol"
      echo "registry: checked against $(ratchet_summary cases.txt) ($(wc -l < "$W/registry.ids" | tr -d ' ') registered now, $(awk '{print $2}' "$W/cases.txt.pairs" | sort -u | wc -l | tr -d ' ') in their union)"
    elif unreached_release cases.txt; then
      echo "registry: bootstrap, no baseline at any of $ncands"
      BOOTSTRAP=1
    fi
  fi
else
  could_not_check "no release tag reachable; fetch tags"
fi

# --- 6. summary -----------------------------------------------------------------
proven=0
for n in 1 2 3 4 5 6 7 8 9; do
  grep "^P$n\." "$W/pending.ids" > "$W/p$n.pending"
  k=$(wc -l < "$W/p$n.pending" | tr -d ' ')
  bad=0
  [ -s "$W/p$n.bad" ] && bad=$(wc -l < "$W/p$n.bad" | tr -d ' ')
  if [ "$k" = 0 ] && [ "$bad" = 0 ]; then
    # Without the ratchets (could not check) a case could have been deleted
    # or parked unnoticed, so nothing reads PROVEN.
    if [ "$COULD_NOT_CHECK" = 1 ]; then
      echo "P$n ${NAMES[$n]}: NOT PROVEN (ratchet did not run)"
      continue
    fi
    proven=$((proven + 1))
    echo "P$n ${NAMES[$n]}: PROVEN"
    continue
  fi
  why=""
  [ "$k" = 0 ] || why="$k pending: $(tr '\n' ' ' < "$W/p$n.pending" | sed 's/ $//')"
  if [ "$bad" != 0 ]; then
    [ -z "$why" ] || why="$why; "
    why="${why}$bad suite failure(s), see FAIL lines above"
  fi
  echo "P$n ${NAMES[$n]}: NOT PROVEN ($why)"
done
echo "moat: $proven of 9 properties proven"

if [ "$ERRORS" -gt 0 ]; then
  echo "moat suite: FAIL ($ERRORS rule failure(s))"
  exit 1
fi
if [ "$COULD_NOT_CHECK" = 1 ]; then
  echo "moat suite: COULD NOT CHECK (the ratchets did not run; this is not a pass)"
  exit 2
fi
# Decision D2: nothing may call the moat green below 9 of 9.
if [ "$proven" = 9 ]; then
  echo "moat suite: all 9 properties proven${BOOTSTRAP:+ [ratchet in bootstrap: no baseline yet]}"
else
  echo "moat suite: no rule failed ($proven of 9 proven; the moat is NOT proven)${BOOTSTRAP:+ [ratchet in bootstrap: no baseline yet]}"
fi
exit 0
