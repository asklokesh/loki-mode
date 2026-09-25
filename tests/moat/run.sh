#!/usr/bin/env bash
#
# tests/moat/run.sh -- the moat suite runner. A release that fails it does not ship.
#
# Runs every property script tests/moat/p<N>-<slug>.sh (exactly one for each of
# P1..P9), parses their "CASE <ID> PASS|FAIL <description>" lines, and fails
# the suite on anything that could let a skipped or regressed check read as a
# pass: a crash, a script with zero cases, a malformed or duplicate case, a case
# filed under the wrong property, a FAIL that is not pending, a PASS that still
# is, or a pending ID nobody emits.
#
# tests/moat/pending.txt lists the cases allowed to FAIL today. THE RATCHET: it
# may only shrink relative to the last release tag, so nothing can be parked
# there to buy a green run.
#
# Exit: 0 no rule failed, 1 a rule failed, 2 could not check (no release tag
# reachable). A definite failure (1) wins over could-not-check (2).
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

MOAT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PENDING="$MOAT_DIR/pending.txt"
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
    bash "$MOAT_DIR/$(cat "$W/p$n.file")" > "$W/p$n.out" 2> "$W/p$n.err" < /dev/null
    rc=$?
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

  [ "$rc" = 0 ] || fail "$n" "CRASH $base: exited $rc (a property script exits 0 whatever its cases say)"
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
# pending_ids FILE: the IDs of a pending file (comments and blank lines skipped).
pending_ids() { awk '/^[ \t]*#/ || NF == 0 {next} {print $1}' "$1" | sort -u; }

if [ -f "$PENDING" ]; then
  awk -v re="^$ID_RE\$" '
    /^[ \t]*#/ || NF == 0 {next}
    !($1 ~ re && $2 ~ /^(M[0-9]+|v[0-9]+\.[0-9]+\.[0-9]+)$/ && NF >= 3) {print NR ": " $0}
  ' "$PENDING" > "$W/pending.bad"
  while IFS= read -r line; do
    fail 0 "MALFORMED PENDING line $line (want: <ID> <milestone> <reason...>)"
  done < "$W/pending.bad"
  pending_ids "$PENDING" > "$W/pending.ids"
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

# --- 4. the ratchet: the pending list may only shrink --------------------------
# git runs against the repo holding THIS file, so a copy of run.sh in another
# repo (the self-test) ratchets against that repo's tags.
COULD_NOT_CHECK=0
if ! tag="$(git -C "$MOAT_DIR" describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2> "$W/git.err")"; then
  COULD_NOT_CHECK=1
  echo "could not check: no release tag reachable; fetch tags"
  sed 's/^/[git] /' "$W/git.err" >&2
# ls-tree, not cat-file -e: an empty listing means the file is absent at the
# tag (bootstrap), while a failed command means the tree could not be read,
# which must never be mistaken for a bootstrap.
elif ! at_tag="$(git -C "$MOAT_DIR" ls-tree --name-only "$tag" -- pending.txt 2> "$W/git.err")"; then
  COULD_NOT_CHECK=1
  echo "could not check: cannot read the tree at $tag"
  sed 's/^/[git] /' "$W/git.err" >&2
elif [ -z "$at_tag" ]; then
  echo "ratchet: bootstrap, no baseline at $tag"
elif ! git -C "$MOAT_DIR" show "$tag:./pending.txt" > "$W/baseline.txt" 2> "$W/git.err"; then
  COULD_NOT_CHECK=1
  echo "could not check: cannot read tests/moat/pending.txt at $tag"
  sed 's/^/[git] /' "$W/git.err" >&2
else
  pending_ids "$W/baseline.txt" > "$W/baseline.ids"
  while read -r id; do
    fail "$(prop_of "$id")" "pending list may only shrink: $id was not pending at $tag"
  done < <(comm -23 "$W/pending.ids" "$W/baseline.ids")
  echo "ratchet: checked against $tag ($(wc -l < "$W/pending.ids" | tr -d ' ') pending now, $(wc -l < "$W/baseline.ids" | tr -d ' ') at $tag)"
fi

# --- 5. summary -----------------------------------------------------------------
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
  echo "moat suite: COULD NOT CHECK (the ratchet did not run; this is not a pass)"
  exit 2
fi
echo "moat suite: OK"
exit 0
