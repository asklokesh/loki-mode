#!/usr/bin/env bash
# The brownfield entry point must change NOTHING. This is a trust claim.
#
# WHY THIS IS THE HIGHEST-STAKES ASSERTION IN THE REPO. The README tells someone
# with a ten-year-old revenue-critical codebase to run:
#
#     loki modernize heal ./your-repo --assess     # read-only. no writes, no commits.
#
# That is the enterprise on-ramp: brownfield is where the money is, and the only
# reason a risk-averse team runs an autonomous agent against their crown jewels
# on the first try is the promise that it cannot touch anything. A single
# stray write -- a scratch file, an auto-created .loki/ directory, an
# accidental `git add` -- turns the safest thing we offer into the scariest, and
# no second chance follows.
#
# Documentation cannot enforce this. A test can, on every gate run, forever.
#
# The check is deliberately BLUNT and content-addressed: hash every file in the
# tree before and after, compare HEAD before and after, and require the working
# tree to be clean. It does not care HOW a write happened, only that none did,
# so it stays valid as the assess path evolves.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-brownfield.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Build a small but realistic legacy repo: source, docs, and a committed history
# so HEAD movement is detectable.
(
    cd "$WORK" || exit 1
    git init -q
    git config user.email "test@example.invalid"
    git config user.name "loki test fixture"
    git config commit.gpgsign false
    mkdir -p src
    printf 'def legacy(a, b):\n    return a + b\n' > src/old.py
    printf '# Legacy\n\nOld system that pays the bills.\n' > README.md
    git add -A
    git commit -q -m "init"
) >/dev/null 2>&1

# Fixture must exist, or every assertion below passes vacuously.
if ! (cd "$WORK" && git rev-parse HEAD >/dev/null 2>&1); then
    echo "  [FAIL] fixture repo did not build -- test would pass vacuously"
    echo "Results: 0 passed, 1 failed, 1 total"
    exit 1
fi

_tree_hash() {
    ( cd "$1" && find . -type f -not -path './.git/*' -print0 2>/dev/null \
        | sort -z | xargs -0 shasum 2>/dev/null | shasum | awk '{print $1}' )
}

before_hash="$(_tree_hash "$WORK")"
before_head="$(cd "$WORK" && git rev-parse HEAD)"

echo "T1 -- assess produces real output"

out=$(bash "$LOKI" modernize heal "$WORK" --assess 2>&1)
rc=$?

# Non-vacuity: a command that silently no-ops would trivially satisfy every
# read-only assertion below. It has to actually do the work.
if printf '%s' "$out" | grep -qi "Modernization Readiness Assessment"; then
    ok "assess emitted its report (not a silent no-op)"
else
    bad "assess produced no report -- read-only assertions would pass vacuously"
    printf '%s\n' "$out" | head -5 | sed 's/^/    /'
fi

if printf '%s' "$out" | grep -qiE "maturity|technical-debt|Language mix"; then
    ok "report contains substantive analysis sections"
else
    bad "report is missing its analysis sections"
fi

if [ "$rc" -eq 0 ]; then
    ok "assess exits 0 on a healthy repo"
else
    bad "assess exited $rc"
fi

echo
echo "T2 -- it changed NOTHING"

after_hash="$(_tree_hash "$WORK")"
if [ "$before_hash" = "$after_hash" ]; then
    ok "no tracked or untracked file content changed"
else
    bad "FILE CONTENT CHANGED -- the read-only promise is broken"
fi

after_head="$(cd "$WORK" && git rev-parse HEAD)"
if [ "$before_head" = "$after_head" ]; then
    ok "no commit was created"
else
    bad "HEAD moved ($before_head -> $after_head) -- assess committed to a user repo"
fi

# Even an untracked scratch file is a violation here. Someone evaluating this on
# a regulated codebase runs `git status` immediately afterwards, and anything
# unexpected there ends the evaluation.
dirty=$(cd "$WORK" && git status --porcelain | wc -l | tr -d ' ')
if [ "$dirty" = "0" ]; then
    ok "working tree is clean (no scratch files, no .loki/ left behind)"
else
    bad "$dirty unexpected path(s) in the working tree after a read-only run"
    (cd "$WORK" && git status --porcelain | head -5 | sed 's/^/    /')
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
