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

# Every git call is one second later than the last, like real history: with
# same-second commits, date-ordered walks (git describe) pick arbitrarily, and
# the merged-side-branch scenarios below would not model what they claim.
TICK=1700000000
g() {
  TICK=$((TICK + 1))
  GIT_AUTHOR_DATE="$TICK +0000" GIT_COMMITTER_DATE="$TICK +0000" \
    git -c user.name=moat -c user.email=moat@example.invalid -c commit.gpgsign=false \
    -c tag.gpgSign=false -c init.defaultBranch=main -c core.hooksPath=/dev/null "$@"
}

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

# cases DIR ID...: write tests/moat/cases.txt with a comment header.
REGISTERED="P1.works P2.works P2.later P3.works P4.works P5.works P6.works P7.works P8.works P9.works P9.later"
cases() {
  local d="$1" line
  shift
  { echo '# fixture case registry'; for line in "$@"; do echo "$line"; done; } > "$d/tests/moat/cases.txt"
}

# known_good DIR: write the known-good tests/moat tree (no git).
#   P1, P3..P8: one PASS case each.
#   P2: P2.works PASS, P2.later FAIL (pending).  P9: P9.works PASS, P9.later FAIL (pending).
known_good() {
  local d="$1" n
  mkdir -p "$d/tests/moat"
  cp "$RUNNER" "$d/tests/moat/run.sh"
  for n in 1 3 4 5 6 7 8; do prop "$d" "$n" "CASE P$n.works PASS property $n holds"; done
  prop "$d" 2 "CASE P2.works PASS holds" "CASE P2.later FAIL not built yet"
  prop "$d" 9 "CASE P9.works PASS holds" "CASE P9.later FAIL not built yet"
  pending "$d" "P2.later M2 not built yet" "P9.later M9 not built yet"
  # shellcheck disable=SC2086
  cases "$d" $REGISTERED
}

# seed DIR: the known-good tree, committed as the ROOT commit and tagged v1.0.0.
seed() {
  mkdir -p "$1"
  g -C "$1" init -q
  known_good "$1"
  g -C "$1" add tests
  g -C "$1" commit -qm baseline
  g -C "$1" tag v1.0.0
}

# baseline DIR: seed plus one commit after the release, so HEAD is not the
# tagged commit (the runner never uses a tag at HEAD as the baseline).
baseline() {
  seed "$1"
  g -C "$1" commit -q --allow-empty -m after-release
}

# run_in DIR [RUNNER_PATH]: run the copied runner from OUTSIDE the repo, so it
# must find its repo from its own location. Sets RC; output goes to $T/out.
run_in() {
  (cd "$T" && bash "$1/${2:-tests/moat/run.sh}") > "$T/out" 2>&1
  RC=$?
}

# expect ID WANT_RC MESSAGE...: assert the exit code and each literal message.
# A message starting with ! must NOT appear.
expect() {
  local id="$1" want="$2" msg missing="" present=""
  shift 2
  for msg in "$@"; do
    case "$msg" in
      '!'*) ! grep -qF -- "${msg#!}" "$T/out" || present="$present [${msg#!}]" ;;
      *) grep -qF -- "$msg" "$T/out" || missing="$missing [$msg]" ;;
    esac
  done
  if [ "$RC" = "$want" ] && [ -z "$missing" ] && [ -z "$present" ]; then
    ok "$id"
  else
    bad "$id (exit $RC, want $want; missing:${missing:- none}; unexpected:${present:- none})"
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
  "ratchet: checked against 1 release tag(s), newest v1.0.0 (2 pending now)" \
  "registry: checked against 1 release tag(s), newest v1.0.0 (11 registered now, 11 in their union)" \
  "moat suite: no rule failed (7 of 9 proven; the moat is NOT proven)" \
  "!moat suite: OK" "!all 9 properties proven"

# Shrinking is allowed: P2.later now passes and its line is gone; P9.later stays.
fresh
prop "$D" 2 "CASE P2.works PASS holds" "CASE P2.later PASS built now"
pending "$D" "P9.later M9 not built yet"
run_in "$D"
expect RUNNER.shrink-allowed 0 "P2 honest verdict: PROVEN" "moat: 8 of 9 properties proven" \
  "moat suite: no rule failed (8 of 9 proven; the moat is NOT proven)"

# Only 9 of 9 may be called proven (decision D2).
fresh
prop "$D" 2 "CASE P2.works PASS holds" "CASE P2.later PASS built now"
prop "$D" 9 "CASE P9.works PASS holds" "CASE P9.later PASS built now"
pending "$D"
run_in "$D"
expect RUNNER.all-nine-proven 0 "moat: 9 of 9 properties proven" "moat suite: all 9 properties proven" \
  "!the moat is NOT proven"

# The registry may grow: a new case that is registered and passes is accepted.
fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.extra PASS a new case"
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.extra
run_in "$D"
expect RUNNER.registry-growth-allowed 0 "registry: checked against 1 release tag(s), newest v1.0.0 (12 registered now, 11 in their union)"

# Route selectors from the caller's shell never reach a property script. The
# fake reports FAIL if it sees any of them; first prove the fake can see them.
fresh
# shellcheck disable=SC2016  # the fake expands these, not this script
{
  echo '#!/usr/bin/env bash'
  echo 'if [ -n "${LOKI_LEGACY_BASH+x}${LOKI_SDK_MODE+x}${LOKI_SDK_LOOP+x}${P1_FORCE_EGRESS_FALLBACK+x}" ]; then'
  echo '  echo "CASE P1.works FAIL a route selector leaked into the property script"'
  echo 'else'
  echo '  echo "CASE P1.works PASS holds"'
  echo 'fi'
} > "$D/tests/moat/p1-fake.sh"
if LOKI_SDK_LOOP=1 bash "$D/tests/moat/p1-fake.sh" | grep -q 'P1.works FAIL'; then
  (export LOKI_LEGACY_BASH=1 LOKI_SDK_MODE=full LOKI_SDK_LOOP=1 P1_FORCE_EGRESS_FALLBACK=1; run_in "$D"; exit "$RC")
  RC=$?
  expect RUNNER.route-env-scrubbed 0 "P1 portable proof: PROVEN"
else
  bad "RUNNER.route-env-scrubbed control: the fake did not detect LOKI_SDK_LOOP=1"
fi

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

# A property script that hangs is killed and fails as TIMEOUT, together with
# everything it spawned. The copy's constant is lowered so the scenario takes
# seconds; if that substitution ever stops matching, the scenario says so
# instead of silently waiting the real 300s.
fresh
sed 's/^MOAT_SCRIPT_TIMEOUT=300$/MOAT_SCRIPT_TIMEOUT=2/' "$RUNNER" > "$D/tests/moat/run.sh"
if ! grep -qx 'MOAT_SCRIPT_TIMEOUT=2' "$D/tests/moat/run.sh"; then
  bad "RUNNER.timeout harness: MOAT_SCRIPT_TIMEOUT=300 not found in run.sh, cannot shorten the timeout"
else
  {
    echo '#!/usr/bin/env bash'
    echo 'echo "CASE P5.works PASS holds"'
    printf 'sh -c %q\n' "echo \$\$ > '$D/grandchild.pid'; exec sleep 60"
  } > "$D/tests/moat/p5-fake.sh"
  t0=$(date +%s)
  run_in "$D"
  took=$(( $(date +%s) - t0 ))
  expect RUNNER.timeout 1 "TIMEOUT p5-fake.sh: still running after 2s, killed" \
    "!UNEMITTED" "!CRASH p5-fake.sh"
  gc="$(cat "$D/grandchild.pid" 2> /dev/null)"
  case "$gc" in
    '' | *[!0-9]*) bad "RUNNER.timeout-kills-tree control: the hanging fake never recorded its child PID" ;;
    *)
      if kill -0 "$gc" 2> /dev/null; then
        bad "RUNNER.timeout-kills-tree: the hung script's child $gc is still running"
        kill -9 "$gc" 2> /dev/null
      else
        ok "RUNNER.timeout-kills-tree"
      fi
      ;;
  esac
  if [ "$took" -lt 20 ]; then ok "RUNNER.timeout-bounded (${took}s)"; else bad "RUNNER.timeout-bounded: took ${took}s"; fi
fi

# --- the case registry ------------------------------------------------------------
# A case deleted from its script (the registry still lists it).
fresh
prop "$D" 2 "CASE P2.later FAIL not built yet"
run_in "$D"
expect RUNNER.unemitted-deleted-case 1 \
  "UNEMITTED P2.works: registered in tests/moat/cases.txt but no script printed a valid CASE line for it on stdout" \
  "!VANISHED" "!VACUOUS"

# An indented FAIL line is not a CASE line: without the registry it would be
# ignored and the suite would pass.
fresh
prop "$D" 9 "CASE P9.later FAIL not built yet" "  CASE P9.works FAIL broke"
run_in "$D"
expect RUNNER.unemitted-indented-fail 1 "UNEMITTED P9.works" "P9 Rule of Two: NOT PROVEN" "!REGRESSION"

# A CASE line on stderr is not a verdict either.
fresh
{
  echo '#!/usr/bin/env bash'
  echo 'echo "CASE P9.later FAIL not built yet"'
  echo 'echo "CASE P9.works FAIL broke" >&2'
} > "$D/tests/moat/p9-fake.sh"
run_in "$D"
expect RUNNER.unemitted-stderr-case 1 "UNEMITTED P9.works" "!REGRESSION"

fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.extra PASS a new case"
run_in "$D"
expect RUNNER.unregistered 1 "UNREGISTERED P3.extra: emitted but not in tests/moat/cases.txt (register it)" \
  "P3 the Wall: NOT PROVEN"

fresh
rm "$D/tests/moat/cases.txt"
run_in "$D"
expect RUNNER.missing-registry 1 "MISSING tests/moat/cases.txt"

fresh
# shellcheck disable=SC2086
cases "$D" $REGISTERED "P3.works extra words"
run_in "$D"
expect RUNNER.malformed-registry 1 "MALFORMED REGISTRY line 13: P3.works extra words"

fresh
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.works
run_in "$D"
expect RUNNER.duplicate-registry 1 "DUPLICATE REGISTRY P3.works: listed more than once in tests/moat/cases.txt"

# --- the ratchets ---------------------------------------------------------------
# Without the ratchet this tree would PASS: the new FAIL is registered and
# listed as pending.
fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.new FAIL not built yet"
pending "$D" "P2.later M2 not built yet" "P9.later M9 not built yet" "P3.new M3 parked after the release"
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.new
run_in "$D"
expect RUNNER.ratchet-new-pending 1 "pending list may only shrink: P3.new was not pending at v1.0.0" \
  "!UNREGISTERED"

# Deleting a case together with its registration is the attack the registry
# ratchet exists for: nothing else notices.
fresh
prop "$D" 2 "CASE P2.later FAIL not built yet"
cases "$D" P1.works P2.later P3.works P4.works P5.works P6.works P7.works P8.works P9.works P9.later
run_in "$D"
expect RUNNER.registry-shrink 1 "case registry may only grow: P2.works was registered at v1.0.0" \
  "!UNEMITTED"

# A tagged HEAD is checked against the release before it, never against itself:
# here the tagged commit itself parked P3.new, so comparing with its own tag
# would pass.
fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.new FAIL not built yet"
pending "$D" "P2.later M2 not built yet" "P9.later M9 not built yet" "P3.new M3 parked in the release commit"
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.new
g -C "$D" add tests
g -C "$D" commit -qm "release 1.1.0"
g -C "$D" tag v1.1.0
run_in "$D"
expect RUNNER.tagged-head-not-own-baseline 1 "pending list may only shrink: P3.new was not pending at v1.0.0" \
  "ratchet: checked against 1 release tag(s), newest v1.0.0" "!newest v1.1.0"

fresh
echo notes > "$D/README"
g -C "$D" add README
g -C "$D" commit -qm "release 1.1.0"
g -C "$D" tag v1.1.0
run_in "$D"
expect RUNNER.tagged-head-uses-previous-release 0 "ratchet: checked against 1 release tag(s), newest v1.0.0" \
  "registry: checked against 1 release tag(s), newest v1.0.0" "!newest v1.1.0"

# The baselines are every reachable release tag, not the one nearest by commit
# count. In the next three scenarios the side branch has more commits than the
# main line past the fork, so git describe would pick the side branch's older
# tag; the release tags are annotated, like the real repo's.

# (a) A hotfix cut from a release that predates the moat, merged after the
# moat's first release, must not turn the ratchet into a bootstrap.
N=$((N + 1)); D="$T/r$N"
mkdir -p "$D"
g -C "$D" init -q
echo seed > "$D/README"
g -C "$D" add README
g -C "$D" commit -qm seed
g -C "$D" tag -a -m v0.9.0 v0.9.0
g -C "$D" checkout -qb hotfix
echo fix1 >> "$D/README"; g -C "$D" commit -qam fix1
echo fix2 >> "$D/README"; g -C "$D" commit -qam fix2
g -C "$D" tag -a -m v0.9.1 v0.9.1
g -C "$D" checkout -q main
known_good "$D"
g -C "$D" add tests
g -C "$D" commit -qm "moat arrives"
g -C "$D" tag -a -m v1.0.0 v1.0.0
g -C "$D" merge -q --no-ff --no-edit hotfix
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.new FAIL not built yet"
pending "$D" "P2.later M2 not built yet" "P9.later M9 not built yet" "P3.new M3 parked after the merge"
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.new
run_in "$D"
expect RUNNER.merged-premoat-tag-not-bootstrap 1 \
  "pending list may only shrink: P3.new was not pending at v1.0.0" \
  "ratchet: checked against 1 release tag(s), newest v1.0.0 (3 pending now)" \
  "!bootstrap"

# (b) A hotfix cut from v1.0.0, merged after v1.1.0 promoted P9.later, must
# not let P9.later be parked again: it was not pending at v1.1.0.
fresh
g -C "$D" checkout -qb hotfix v1.0.0
echo fix1 > "$D/README"; g -C "$D" add README; g -C "$D" commit -qm fix1
echo fix2 >> "$D/README"; g -C "$D" commit -qam fix2
echo fix3 >> "$D/README"; g -C "$D" commit -qam fix3
g -C "$D" tag -a -m v1.0.1 v1.0.1
g -C "$D" checkout -q main
prop "$D" 9 "CASE P9.works PASS holds" "CASE P9.later PASS built now"
pending "$D" "P2.later M2 not built yet"
g -C "$D" add tests
g -C "$D" commit -qm "promote P9.later"
g -C "$D" tag -a -m v1.1.0 v1.1.0
g -C "$D" merge -q --no-ff --no-edit hotfix
prop "$D" 9 "CASE P9.works PASS holds" "CASE P9.later FAIL broke again"
pending "$D" "P2.later M2 not built yet" "P9.later M9 parked again"
run_in "$D"
expect RUNNER.merged-older-release-cannot-repark 1 \
  "pending list may only shrink: P9.later was not pending at v1.1.0" \
  "ratchet: checked against 3 release tag(s), newest v1.1.0 (2 pending now)" \
  "!newest v1.0.1"

# Pending is checked against the intersection: a park that slipped into one
# release (v1.1.0) is still not pending at v1.0.0, so it cannot stay parked.
fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.new FAIL not built yet"
pending "$D" "P2.later M2 not built yet" "P9.later M9 not built yet" "P3.new M3 slipped into v1.1.0"
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.new
g -C "$D" add tests
g -C "$D" commit -qm "release 1.1.0"
g -C "$D" tag -a -m v1.1.0 v1.1.0
g -C "$D" commit -q --allow-empty -m after-release
run_in "$D"
expect RUNNER.pending-intersection-of-releases 1 \
  "pending list may only shrink: P3.new was not pending at v1.0.0" \
  "ratchet: checked against 2 release tag(s), newest v1.1.0 (3 pending now)"

# (c) Only an exact vX.Y.Z tag is a release: a v1.1.1-scratch tag on HEAD^ that
# carried a parked entry must not grandfather it in.
fresh
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.new FAIL not built yet"
pending "$D" "P2.later M2 not built yet" "P9.later M9 not built yet" "P3.new M3 parked on a scratch tag"
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.new
g -C "$D" add tests
g -C "$D" commit -qm "park P3.new"
g -C "$D" tag -a -m scratch v1.1.1-scratch
g -C "$D" commit -q --allow-empty -m after-scratch
run_in "$D"
expect RUNNER.suffixed-tag-not-baseline 1 \
  "pending list may only shrink: P3.new was not pending at v1.0.0" \
  "ratchet: checked against 1 release tag(s), newest v1.0.0" \
  "!v1.1.1-scratch"

# (d) The registry is checked against the union: an ID registered only at an
# older merged release tag, then deleted, still fails. Here the main line has
# more commits past the fork, so git describe would pick v1.1.0, which never
# registered it.
fresh
g -C "$D" checkout -qb hotfix v1.0.0
prop "$D" 3 "CASE P3.works PASS holds" "CASE P3.hot PASS added in the hotfix"
# shellcheck disable=SC2086
cases "$D" $REGISTERED P3.hot
g -C "$D" add tests
g -C "$D" commit -qm "hotfix registers P3.hot"
g -C "$D" tag -a -m v1.0.1 v1.0.1
g -C "$D" checkout -q main
echo notes > "$D/README"; g -C "$D" add README; g -C "$D" commit -qm notes
g -C "$D" tag -a -m v1.1.0 v1.1.0
g -C "$D" merge -q --no-ff --no-edit hotfix
prop "$D" 3 "CASE P3.works PASS property 3 holds"
# shellcheck disable=SC2086
cases "$D" $REGISTERED
run_in "$D"
expect RUNNER.registry-union-of-releases 1 \
  "case registry may only grow: P3.hot was registered at v1.0.1 (case IDs are permanent)" \
  "registry: checked against 3 release tag(s), newest v1.1.0 (11 registered now, 12 in their union)" \
  "!UNEMITTED"

# A git hook (local-ci runs from pre-push) exports GIT_DIR. Inherited, it moved
# git's idea of the work tree top: an absolute one reset the ratchets to a
# bootstrap, a relative one made them could-not-check.
fresh
(export GIT_DIR="$D/.git"; run_in "$D"; exit "$RC")
RC=$?
expect RUNNER.inherited-git-dir-absolute 0 "ratchet: checked against 1 release tag(s), newest v1.0.0" \
  "registry: checked against 1 release tag(s), newest v1.0.0" "!bootstrap" "!MISPLACED"
(cd "$D" && GIT_DIR=.git bash tests/moat/run.sh) > "$T/out" 2>&1
RC=$?
expect RUNNER.inherited-git-dir-relative 0 "ratchet: checked against 1 release tag(s), newest v1.0.0" \
  "registry: checked against 1 release tag(s), newest v1.0.0" "!could not check"

# A tagged root commit has no earlier release: could-not-check, never a pass.
N=$((N + 1)); D="$T/r$N"
seed "$D"
run_in "$D"
expect RUNNER.tagged-root-exit-2 2 \
  "could not check: no release tag reachable; fetch tags (tags at HEAD are not a baseline: v1.0.0)" \
  "moat suite: COULD NOT CHECK"

# Moving the directory must not reset the ratchets to a bootstrap: the
# baseline is still read from tests/moat/ at the tag, and the move itself fails.
fresh
mv "$D/tests/moat" "$D/tests/gate"
{
  echo '#!/usr/bin/env bash'
  echo 'echo "CASE P3.works PASS holds"'
  echo 'echo "CASE P3.new FAIL not built yet"'
} > "$D/tests/gate/p3-fake.sh"
{
  echo '# fixture pending list'
  echo 'P2.later M2 not built yet'
  echo 'P9.later M9 not built yet'
  echo 'P3.new M3 parked after the move'
} > "$D/tests/gate/pending.txt"
echo P3.new >> "$D/tests/gate/cases.txt"
run_in "$D" tests/gate/run.sh
expect RUNNER.moved-directory 1 \
  "MISPLACED RUNNER: run.sh is at tests/gate/run.sh in its repo; it must live at tests/moat/run.sh" \
  "pending list may only shrink: P3.new was not pending at v1.0.0" \
  "registry: checked against 1 release tag(s), newest v1.0.0" "!bootstrap"

# Bootstrap: the tag predates pending.txt and cases.txt, so the current lists
# are accepted.
N=$((N + 1)); D="$T/r$N"
mkdir -p "$D"
g -C "$D" init -q
echo seed > "$D/README"
g -C "$D" add README
g -C "$D" commit -qm seed
g -C "$D" tag v1.0.0
g -C "$D" commit -q --allow-empty -m after-release
mkdir -p "$D/tests/moat"
cp "$RUNNER" "$D/tests/moat/run.sh"
for n in 1 2 3 4 5 6 7 8; do prop "$D" "$n" "CASE P$n.works PASS holds"; done
prop "$D" 9 "CASE P9.works PASS holds" "CASE P9.later FAIL not built yet"
pending "$D" "P9.later M9 not built yet"
cases "$D" P1.works P2.works P3.works P4.works P5.works P6.works P7.works P8.works P9.works P9.later
run_in "$D"
expect RUNNER.bootstrap-allowed 0 "ratchet: bootstrap, no baseline at any of 1 release tag(s), newest v1.0.0" \
  "registry: bootstrap, no baseline at any of 1 release tag(s), newest v1.0.0" \
  "moat suite: no rule failed (8 of 9 proven; the moat is NOT proven) [ratchet in bootstrap: no baseline yet]"

# A tag that is not an exact release (^v[0-9]+.[0-9]+.[0-9]+$) is not a
# baseline.
fresh
g -C "$D" tag -d v1.0.0 > /dev/null
g -C "$D" tag nightly
run_in "$D"
expect RUNNER.no-tag-exit-2 2 "could not check: no release tag reachable; fetch tags" \
  "moat suite: COULD NOT CHECK"

# A v-prefixed ad-hoc tag (v1-scratch) is not a release either: were it read as
# the baseline, a pending entry it carried would be grandfathered in.
fresh
g -C "$D" tag -d v1.0.0 > /dev/null
g -C "$D" tag v1-scratch HEAD~1
run_in "$D"
expect RUNNER.adhoc-v-tag-not-baseline 2 "could not check: no release tag reachable; fetch tags" \
  "!newest v1-scratch" "!tags at HEAD"

# Not a git checkout at all (an unpacked tarball): still could-not-check.
fresh
rm -rf "$D/.git"
run_in "$D"
expect RUNNER.not-a-repo-exit-2 2 "could not check: no release tag reachable; fetch tags"

# The tag is reachable but its tree cannot be read (a partial or damaged clone).
# That is could-not-check, never a bootstrap: a bootstrap would accept any list.
fresh
sub="$(g -C "$D" rev-parse 'v1.0.0:tests/moat')"
rm -f "$D/.git/objects/${sub:0:2}/${sub:2}"
run_in "$D"
expect RUNNER.unreadable-baseline-exit-2 2 "could not check: cannot read tests/moat at the 1 reachable release tag(s) (newest v1.0.0)" \
  "moat suite: COULD NOT CHECK" "!bootstrap"

# The tree is readable but the pending.txt blob is not. git grep only prints an
# error for that and does not fail, so the runner must still refuse.
fresh
blob="$(g -C "$D" rev-parse 'v1.0.0:tests/moat/pending.txt')"
rm -f "$D/.git/objects/${blob:0:2}/${blob:2}"
run_in "$D"
expect RUNNER.unreadable-baseline-blob-exit-2 2 "could not check: cannot read tests/moat at the 1 reachable release tag(s)" \
  "moat suite: COULD NOT CHECK" "!bootstrap"

# An unreadable tree at an older release that predates the moat is still
# could-not-check: nothing shows that tag lacks the files, so it is not a pass.
N=$((N + 1)); D="$T/r$N"
mkdir -p "$D/tests/other"
g -C "$D" init -q
echo other > "$D/tests/other/f"
g -C "$D" add tests
g -C "$D" commit -qm "before the moat"
g -C "$D" tag -a -m v0.9.0 v0.9.0
known_good "$D"
g -C "$D" add tests
g -C "$D" commit -qm "moat arrives"
g -C "$D" tag -a -m v1.0.0 v1.0.0
g -C "$D" commit -q --allow-empty -m after-release
sub="$(g -C "$D" rev-parse 'v0.9.0:tests')"
rm -f "$D/.git/objects/${sub:0:2}/${sub:2}"
run_in "$D"
expect RUNNER.unreadable-premoat-tree-exit-2 2 \
  "could not check: cannot read tests/moat at the 2 reachable release tag(s) (newest v1.0.0)" \
  "moat suite: COULD NOT CHECK" "!bootstrap" "!checked against"

# A definite failure outranks could-not-check.
fresh
g -C "$D" tag -d v1.0.0 > /dev/null
prop "$D" 3 "CASE P3.works FAIL broke"
run_in "$D"
expect RUNNER.failure-beats-no-tag 1 "REGRESSION P3.works" "could not check: no release tag reachable"

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
