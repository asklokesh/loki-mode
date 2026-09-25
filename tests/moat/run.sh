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
# THE RATCHETS, both against the newest release tag reachable from HEAD that
# does not point at HEAD itself: pending.txt may only shrink and cases.txt may
# only grow, so nothing can be parked as pending, and no case can be deleted,
# to buy a green run. Baselines are always read from tests/moat/pending.txt and
# tests/moat/cases.txt at the tag, so moving this directory cannot reset them.
#
# Exit: 0 no rule failed, 1 a rule failed, 2 could not check (no release tag
# reachable). A definite failure (1) wins over could-not-check (2). Exit 0 is
# not "the moat is proven": only 9 of 9 properties proven is.
# Self-test: tests/test-moat-runner.sh.
#
# Written for bash 3.2 (macOS /bin/bash): no associative arrays, no mapfile,
# no wait -n. Sets of IDs are sorted flat files compared with comm.

set -uo pipefail
export LC_ALL=C
# Each property script exports these itself; set here too so one that forgets
# still cannot phone home or wait on an update check under the gate.
export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
  LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false
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
# The baseline tag excludes tags that point at HEAD: a tagged release commit is
# checked against the release before it, never against its own lists (which
# would always pass). Excluding HEAD's tags, rather than describing HEAD^, keeps
# the same ancestor walk (every parent of a merge), and a lone tagged root
# commit lands in could-not-check with no special case.
# ponytail: a dirty tree on a tagged HEAD is also checked against the previous
# release, so an uncommitted re-park there is caught once it is committed.
# git runs against the repo holding THIS file, so a copy of run.sh in another
# repo (the self-test) ratchets against that repo's tags.
COULD_NOT_CHECK=0
could_not_check() {
  COULD_NOT_CHECK=1
  echo "could not check: $1"
  sed 's/^/[git] /' "$W/git.err" >&2
}

# baseline_ids NAME: the IDs of tests/moat/NAME at $tag, into $W/NAME.base.
# Returns 0 read, 1 bootstrap (absent at the tag), 2 could not check.
baseline_ids() {
  local at
  # ls-tree, not cat-file -e: an empty listing means the file is absent at the
  # tag (bootstrap), while a failed command means the tree could not be read,
  # which must never be mistaken for a bootstrap.
  if ! at="$(git -C "$top" ls-tree --name-only "$tag" -- "tests/moat/$1" 2> "$W/git.err")"; then
    could_not_check "cannot read the tree at $tag for tests/moat/$1"
    return 2
  fi
  [ -n "$at" ] || return 1
  if ! git -C "$top" show "$tag:tests/moat/$1" > "$W/$1.base.txt" 2> "$W/git.err"; then
    could_not_check "cannot read tests/moat/$1 at $tag"
    return 2
  fi
  list_ids "$W/$1.base.txt" > "$W/$1.base"
  return 0
}

tag=""
BOOTSTRAP=""
if top="$(git -C "$MOAT_DIR" rev-parse --show-toplevel 2> "$W/git.err")" \
  && prefix="$(git -C "$MOAT_DIR" rev-parse --show-prefix 2> "$W/git.err")"; then
  [ "$prefix" = "tests/moat/" ] || fail 0 "MISPLACED RUNNER: run.sh is at ${prefix}run.sh in its repo; it must live at tests/moat/run.sh (the ratchets read their baselines from tests/moat/ at the release tag)"
  if ! head_tags="$(git -C "$top" tag --points-at HEAD --list 'v[0-9]*.[0-9]*.[0-9]*' 2> "$W/git.err")"; then
    could_not_check "cannot list the tags at HEAD"
  else
    excl=()
    for t in $head_tags; do excl+=(--exclude "$t"); done
    head_list="$(printf '%s' "$head_tags" | tr '\n' ' ')"
    # ${excl[@]+...}: an empty array is "unbound" under set -u before bash 4.4.
    if ! tag="$(git -C "$top" describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' ${excl[@]+"${excl[@]}"} HEAD 2> "$W/git.err")"; then
      tag=""
      could_not_check "no release tag reachable; fetch tags${head_list:+ (tags at HEAD are not a baseline: $head_list)}"
    fi
  fi
else
  could_not_check "no release tag reachable; fetch tags"
fi

if [ -n "$tag" ]; then
  baseline_ids pending.txt
  case $? in
    0)
      while read -r id; do
        fail "$(prop_of "$id")" "pending list may only shrink: $id was not pending at $tag"
      done < <(comm -23 "$W/pending.ids" "$W/pending.txt.base")
      echo "ratchet: checked against $tag ($(wc -l < "$W/pending.ids" | tr -d ' ') pending now, $(wc -l < "$W/pending.txt.base" | tr -d ' ') at $tag)"
      ;;
    1) echo "ratchet: bootstrap, no baseline at $tag"; BOOTSTRAP=1 ;;
  esac
  baseline_ids cases.txt
  case $? in
    0)
      while read -r id; do
        fail "$(prop_of "$id")" "case registry may only grow: $id was registered at $tag (case IDs are permanent)"
      done < <(comm -13 "$W/registry.ids" "$W/cases.txt.base")
      echo "registry: checked against $tag ($(wc -l < "$W/registry.ids" | tr -d ' ') registered now, $(wc -l < "$W/cases.txt.base" | tr -d ' ') at $tag)"
      ;;
    1) echo "registry: bootstrap, no baseline at $tag"; BOOTSTRAP=1 ;;
  esac
fi

# --- 6. summary -----------------------------------------------------------------
proven=0
for n in 1 2 3 4 5 6 7 8 9; do
  grep "^P$n\." "$W/pending.ids" > "$W/p$n.pending"
  k=$(wc -l < "$W/p$n.pending" | tr -d ' ')
  bad=0
  [ -s "$W/p$n.bad" ] && bad=$(wc -l < "$W/p$n.bad" | tr -d ' ')
  if [ "$k" = 0 ] && [ "$bad" = 0 ]; then
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
