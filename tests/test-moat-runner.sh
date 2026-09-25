#!/usr/bin/env bash
#
# test-moat-runner.sh -- proves every rule of tests/moat/run.sh fires.
#
# The moat runner is the release gate for the nine product properties, so a
# rule that silently stopped firing would turn the gate green while it checks
# nothing. Each scenario builds a throwaway git repo, copies the REAL run.sh in
# at tests/moat/run.sh, writes fake p1..p9 property scripts, and applies exactly
# ONE mutation to a known-good baseline, so a red result can only come from the
# rule under test. The baseline itself is the positive control (exit 0).
#
# Lives outside tests/moat/ on purpose: the runner must never discover it. It
# needs no tags in the real repo (it tags its own), so it is safe in a depth-1
# CI shard.

set -uo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_ROOT/tests/moat/run.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "[PASS] $1"; }
bad() { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }

T="$(mktemp -d "${TMPDIR:-/tmp}/moat-selftest.XXXXXX")" || { echo "[FAIL] RUNNER.setup cannot create a temp dir"; exit 1; }
trap 'rm -rf "$T"' EXIT

# Keep the real repo and the user's git config out of the throwaway repos: an
# inherited GIT_DIR (a pre-push hook sets it) would make the copied run.sh
# ratchet against the REAL repo's tags, and a global hooksPath or gpgsign would
# break the fixture commits.
# GIT_CEILING_DIRECTORIES stops discovery at $T, so "not a git checkout" holds
# even if the temp root happens to sit inside some other repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR \
  GIT_ALTERNATE_OBJECT_DIRECTORIES
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" GIT_CONFIG_NOSYSTEM=1 \
  GIT_CEILING_DIRECTORIES="$T"
mkdir -p "$HOME"

echo "=== moat runner self-test ==="

command -v git > /dev/null 2>&1 || { bad "RUNNER.prerequisites prerequisite missing: git"; exit 1; }
[ -f "$RUNNER" ] || { bad "RUNNER.prerequisites tests/moat/run.sh is missing"; exit 1; }

g() { git -c user.name=moat -c user.email=moat@example.invalid -c commit.gpgsign=false \
  -c tag.gpgSign=false -c init.defaultBranch=main -c core.hooksPath=/dev/null "$@"; }

# prop DIR N LINE...: write tests/moat/p<N>-fake.sh printing each LINE, exit 0.
prop() {
  local d="$1" n="$2" line
  shift 2
  {
    echo '#!/usr/bin/env bash'
    for line in "$@"; do printf 'echo %q\n' "$line"; done
  } > "$d/tests/moat/p$n-fake.sh"
}

# pending DIR LINE...: write tests/moat/pending.txt with a comment header.
pending() {
  local d="$1" line
  shift
  { echo '# fixture pending list'; for line in "$@"; do echo "$line"; done; } > "$d/tests/moat/pending.txt"
}

# baseline DIR: the known-good tree, committed and tagged v1.0.0.
#   P1, P3..P8: one PASS case each.
#   P2: P2.works PASS, P2.later FAIL (pending).  P9: P9.works PASS, P9.later FAIL (pending).
baseline() {
  local d="$1" n
  mkdir -p "$d/tests/moat"
  g -C "$d" init -q
  cp "$RUNNER" "$d/tests/moat/run.sh"
  for n in 1 3 4 5 6 7 8; do prop "$d" "$n" "CASE P$n.works PASS property $n holds"; done
  prop "$d" 2 "CASE P2.works PASS holds" "CASE P2.later FAIL not built yet"
  prop "$d" 9 "CASE P9.works PASS holds" "CASE P9.later FAIL not built yet"
  pending "$d" "P2.later M2 not built yet" "P9.later M9 not built yet"
  g -C "$d" add tests
  g -C "$d" commit -qm baseline
  g -C "$d" tag v1.0.0
}

# run_in DIR: run the copied runner from OUTSIDE the repo, so it must find its
# repo from its own location. Sets RC; output goes to $T/out.
run_in() {
  (cd "$T" && bash "$1/tests/moat/run.sh") > "$T/out" 2>&1
  RC=$?
}

# expect ID WANT_RC MESSAGE...: assert the exit code and each literal message.
expect() {
  local id="$1" want="$2" msg missing=""
  shift 2
  for msg in "$@"; do
    grep -qF -- "$msg" "$T/out" || missing="$missing [$msg]"
  done
  if [ "$RC" = "$want" ] && [ -z "$missing" ]; then
    ok "$id"
  else
    bad "$id (exit $RC, want $want; missing:${missing:- none})"
    sed 's/^/    | /' "$T/out" | tail -n 25
  fi
}

N=0
fresh() { N=$((N + 1)); D="$T/r$N"; baseline "$D"; }

# --- positive controls ----------------------------------------------------------
fresh
run_in "$D"
expect RUNNER.clean-tree-passes 0 \
  "P1 portable proof: PROVEN" \
  "P2 honest verdict: NOT PROVEN (1 pending: P2.later)" \
  "P3 the Wall: PROVEN" "P4 model freedom: PROVEN" "P5 sovereignty: PROVEN" \
  "P6 in-place brownfield: PROVEN" "P7 no fabricated data: PROVEN" \
  "P8 load-bearing proof: PROVEN" \
  "P9 Rule of Two: NOT PROVEN (1 pending: P9.later)" \
  "moat: 7 of 9 properties proven" \
  "ratchet: checked against v1.0.0" "moat suite: OK"

# Shrinking is allowed: P2.later now passes and its line is gone; P9.later stays.
fresh
prop "$D" 2 "CASE P2.works PASS holds" "CASE P2.later PASS built now"
pending "$D" "P9.later M9 not built yet"
run_in "$D"
expect RUNNER.shrink-allowed 0 "P2 honest verdict: PROVEN" "moat: 8 of 9 properties proven" "moat suite: OK"

# --- step 2 rules ---------------------------------------------------------------
fresh
prop "$D" 3 "CASE P3.works FAIL broke"
run_in "$D"
expect RUNNER.regression 1 "REGRESSION P3.works: FAIL but not listed in tests/moat/pending.txt" \
  "P3 the Wall: NOT PROVEN"

fresh
prop "$D" 2 "CASE P2.works PASS holds" "CASE P2.later PASS built now"
run_in "$D"
expect RUNNER.promote 1 "PROMOTE P2.later: remove it from tests/moat/pending.txt"

fresh
prop "$D" 2 "CASE P2.works PASS holds"
run_in "$D"
expect RUNNER.vanished-pending 1 "VANISHED P2.later: listed in tests/moat/pending.txt but no script emitted it"

fresh
prop "$D" 4 "running property 4 checks" "all good"
run_in "$D"
expect RUNNER.vacuous 1 "VACUOUS p4-fake.sh: emitted zero CASE lines"

fresh
prop "$D" 5 "CASE P5.works PASS holds"
echo 'exit 3' >> "$D/tests/moat/p5-fake.sh"
run_in "$D"
expect RUNNER.crash 1 "CRASH p5-fake.sh: exited 3"

fresh
prop "$D" 6 "CASE P6.works PASS holds" "CASE P6.works PASS holds again"
run_in "$D"
expect RUNNER.duplicate-id 1 "DUPLICATE P6.works: case ID emitted more than once"

fresh
rm "$D/tests/moat/p7-fake.sh"
run_in "$D"
expect RUNNER.missing-property 1 "MISSING P7 no fabricated data: no tests/moat/p7-*.sh script"

fresh
prop "$D" 1 "CASE P1.works PASS holds"
cp "$D/tests/moat/p1-fake.sh" "$D/tests/moat/p1-other.sh"
run_in "$D"
expect RUNNER.extra-property-script 1 "DUPLICATE SCRIPT P1: both p1-fake.sh and p1-other.sh"

fresh
prop "$D" 8 "CASE P8.works PASS holds" "CASE P1.stray PASS filed under the wrong property"
run_in "$D"
expect RUNNER.prefix-mismatch 1 "WRONG PREFIX P1.stray in p8-fake.sh: a p8 script may only emit P8.* cases"

# A SKIP is not a verdict. If it were ignored, a skipped check would vanish
# silently whenever the script also emitted real cases.
fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.tool SKIP prerequisite missing"
run_in "$D"
expect RUNNER.malformed-case 1 "MALFORMED p3-fake.sh: 'CASE P3.tool SKIP prerequisite missing'"

fresh
pending "$D" "P2.later M2 not built yet" "P9.later"
run_in "$D"
expect RUNNER.malformed-pending 1 "MALFORMED PENDING line 3: P9.later"

fresh
rm "$D/tests/moat/pending.txt"
run_in "$D"
expect RUNNER.missing-pending-file 1 "MISSING tests/moat/pending.txt"

# --- step 4: the ratchet --------------------------------------------------------
# Without the ratchet this tree would PASS: the new FAIL is listed as pending.
fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.new FAIL not built yet"
pending "$D" "P2.later M2 not built yet" "P9.later M9 not built yet" "P3.new M3 parked after the release"
run_in "$D"
expect RUNNER.ratchet-new-pending 1 "pending list may only shrink: P3.new was not pending at v1.0.0"

# Bootstrap: the tag predates pending.txt, so the current list is accepted.
N=$((N + 1)); D="$T/r$N"
mkdir -p "$D"
g -C "$D" init -q
echo seed > "$D/README"
g -C "$D" add README
g -C "$D" commit -qm seed
g -C "$D" tag v1.0.0
mkdir -p "$D/tests/moat"
cp "$RUNNER" "$D/tests/moat/run.sh"
for n in 1 2 3 4 5 6 7 8; do prop "$D" "$n" "CASE P$n.works PASS holds"; done
prop "$D" 9 "CASE P9.works PASS holds" "CASE P9.later FAIL not built yet"
pending "$D" "P9.later M9 not built yet"
run_in "$D"
expect RUNNER.bootstrap-allowed 0 "ratchet: bootstrap, no baseline at v1.0.0" "moat suite: OK"

# A tag that does not look like a release (--match 'v[0-9]*') is not a baseline.
N=$((N + 1)); D="$T/r$N"
baseline "$D"
g -C "$D" tag -d v1.0.0 > /dev/null
g -C "$D" tag nightly
run_in "$D"
expect RUNNER.no-tag-exit-2 2 "could not check: no release tag reachable; fetch tags" \
  "moat suite: COULD NOT CHECK"

# Not a git checkout at all (an unpacked tarball): still could-not-check.
N=$((N + 1)); D="$T/r$N"
baseline "$D"
rm -rf "$D/.git"
run_in "$D"
expect RUNNER.not-a-repo-exit-2 2 "could not check: no release tag reachable; fetch tags"

# The tag is reachable but its tree cannot be read (a partial or damaged clone).
# That is could-not-check, never a bootstrap: a bootstrap would accept any list.
N=$((N + 1)); D="$T/r$N"
baseline "$D"
sub="$(g -C "$D" rev-parse 'v1.0.0:tests/moat')"
rm -f "$D/.git/objects/${sub:0:2}/${sub:2}"
run_in "$D"
expect RUNNER.unreadable-baseline-exit-2 2 "could not check: cannot read the tree at v1.0.0" \
  "moat suite: COULD NOT CHECK"

# A definite failure outranks could-not-check.
N=$((N + 1)); D="$T/r$N"
baseline "$D"
g -C "$D" tag -d v1.0.0 > /dev/null
prop "$D" 3 "CASE P3.works FAIL broke"
run_in "$D"
expect RUNNER.failure-beats-no-tag 1 "REGRESSION P3.works" "could not check: no release tag reachable"

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
