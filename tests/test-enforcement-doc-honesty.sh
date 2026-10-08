#!/usr/bin/env bash
# Buyer-facing docs must not claim enforcement the source disclaims.
#
# THE DEFECT THIS GUARDS. autonomy/run.sh:515 states LOKI_ALLOWED_PATHS "Does
# NOT restrict provider-driven agent writes (run.sh never sees them)", and
# check_command_allowed carries "intentionally NOT called by run.sh" with zero
# callers. That honesty never reached the docs: the wiki listed both as
# production security controls and a certification ANSWER KEY marked
# "restricts which directories agents can modify" as the correct exam answer.
#
# WHY MARKER-PRESENCE, NOT PHRASE-ABSENCE. A grep hunting for "restrict" near
# "LOKI_ALLOWED_PATHS" fires on the corrected caveat itself, since every
# correction contains both tokens. This repo has been burned by text guards
# matching their own explanatory text. Asserting a required marker is PRESENT
# is structurally incapable of self-firing.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-enforcement-doc-honesty"

# Tier 1: every buyer-facing file that names either variable must carry the
# scope marker. Losing a caveat loses the marker and fails here.
# Files that name the ENV VARS. wiki/Configuration.md is marked too but is not
# in this set: it documents the YAML keys (allowed_paths / blocked_commands),
# so the Tier-2 env-var grep correctly does not find it. Listing it here would
# make Tier 2 fail forever.
GUARDED=(
    "wiki/Enterprise-Features.md"
    "wiki/Environment-Variables.md"
    "wiki/Use-Cases.md"
    "docs/DOCKER.md"
    "docs/certification/answer-key.md"
    "docs/certification/02-enterprise-features/lesson.md"
    "docs/certification/04-production-deployment/lesson.md"
    "docs/certification/04-production-deployment/quiz.md"
    "docs/certification/certification-exam.md"
)
missing=""
for f in "${GUARDED[@]}"; do
    if [ ! -f "$f" ]; then missing="$missing $f(absent)"; continue; fi
    grep -q 'SANDBOX-SCOPED' "$f" || missing="$missing $f"
done
if [ -z "$missing" ]; then
    pass "all ${#GUARDED[@]} buyer-facing files carry the scope marker"
else
    fail "missing SANDBOX-SCOPED marker in:$missing"
fi

# Tier 2: drift catch. A NEW doc mentioning either variable must be added to
# GUARDED (and carry the marker) or this fails. Set membership on filenames,
# never a prose pattern, so it cannot false-positive on caveat wording.
FOUND="$(grep -rl -E 'LOKI_ALLOWED_PATHS|LOKI_BLOCKED_COMMANDS' \
    --include='*.md' wiki docs README.md SKILL.md 2>/dev/null \
    | grep -vE '^docs/(competitive|research-2026-07|test-scenarios)/' \
    | grep -vE '^(CHANGELOG\.md|docs/COMPETITIVE-NEXT-10\.md)$' \
    | LC_ALL=C sort || true)"
EXPECTED="$(printf '%s\n' "${GUARDED[@]}" | LC_ALL=C sort)"
if [ "$FOUND" = "$EXPECTED" ]; then
    pass "no undocumented file mentions the enforcement variables"
else
    fail "buyer-facing file set drifted. Add the marker and update GUARDED.
      only-in-tree: $(comm -23 <(printf '%s\n' "$FOUND") <(printf '%s\n' "$EXPECTED") | tr '\n' ' ')
      only-in-list: $(comm -13 <(printf '%s\n' "$FOUND") <(printf '%s\n' "$EXPECTED") | tr '\n' ' ')"
fi

# Tier 3: the caveats are only TRUE while the source says so. This makes the
# guard bidirectional: it fails if docs re-inflate, and also if the code gains
# real enforcement (at which point the docs are under-claiming).
if grep -qi 'does NOT restrict provider-driven agent writes' autonomy/run.sh; then
    pass "run.sh still disclaims provider-driven write enforcement"
else
    fail "run.sh no longer disclaims it: docs may now be under-claiming, revisit"
fi

CCA="$(grep -c 'check_command_allowed' autonomy/run.sh || echo 0)"
if [ "$CCA" -le 2 ]; then
    pass "check_command_allowed still has no live callers ($CCA reference(s))"
else
    fail "check_command_allowed gained callers ($CCA refs): re-check the doc caveats"
fi

# The two real path-enforcement call sites, excluding definition and comment.
SITES="$(grep -cE '^[[:space:]]*if ! _sandbox_path_within_allowed' autonomy/sandbox.sh || echo 0)"
if [ "$SITES" -eq 2 ]; then
    pass "sandbox path enforcement is still 2 call sites (docs cite :1222 and :1315)"
else
    fail "sandbox path enforcement changed to $SITES call sites: update the docs"
fi

# The certification answer key must not teach the false claim again.
if grep -q 'restricts which directories agents can modify' docs/certification/answer-key.md 2>/dev/null; then
    fail "answer key still teaches unqualified enforcement"
else
    pass "answer key no longer teaches unqualified enforcement"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
