#!/usr/bin/env bash
#
# test-local-ci-tiers.sh
#
# Guards the local-ci FAST/FULL tiering. The tier exists to make the inner loop
# fast; the risk it introduces is that a FAST pass gets mistaken for a FULL one,
# or that the fast tier quietly stops covering the trust core. Both are
# false-greens of exactly the kind this product exists to prevent, so both are
# asserted here rather than left to a comment.
#
# Every case is static (parses scripts/local-ci.sh or runs it with a stubbed
# body). Nothing here runs the real gate.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI="$REPO_ROOT/scripts/local-ci.sh"
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "[PASS] $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

echo "=== local-ci tier tests ==="

# ---------------------------------------------------------------------------
# 1. Tier resolution
# ---------------------------------------------------------------------------
# Default must be fast: the whole point is that the cheap tier is what you get
# by accident, and the expensive one is what you ask for.
grep -q 'TIER="${LOCAL_CI_TIER:-fast}"' "$CI" \
  && ok "default tier is fast" || bad "default tier is not fast"

grep -q -- '--full)    TIER=full' "$CI" \
  && ok "--full selects the full tier" || bad "--full flag missing"

# An unknown tier must be rejected, not silently treated as one of them.
out=$(LOCAL_CI_TIER=bogus bash "$CI" 2>&1); rc=$?
check "unknown LOCAL_CI_TIER exits 2" "$rc" "2"
case "$out" in
  *"unknown LOCAL_CI_TIER"*) ok "unknown tier names the bad value" ;;
  *) bad "unknown tier message missing" ;;
esac

# --fast is a PRE-EXISTING unrelated flag (SBOM skip). It must NOT be wired to
# the tier: two different things called "fast" is how a full run gets mistaken
# for a fast one.
grep -q -- '--fast)    FAST=1 ;;' "$CI" \
  && ok "--fast still means the old SBOM-skip flag" || bad "--fast semantics changed"
grep -q -- '--fast).*TIER=' "$CI" \
  && bad "--fast must not set TIER" || ok "--fast does not set TIER"

# ---------------------------------------------------------------------------
# 2. The verdict must name the tier, and must never authorize a push on FAST
# ---------------------------------------------------------------------------
grep -q 'local-ci summary  \[tier: ' "$CI" \
  && ok "summary line names the tier" || bad "summary line does not name the tier"

grep -q 'NOT push authorization' "$CI" \
  && ok "fast verdict refuses push authorization" || bad "fast verdict missing the not-a-gate warning"

# "Safe to commit + push" may appear ONLY in the full branch. If a fast pass
# ever prints it, the tiering has become the false-green it was meant to avoid.
safe_ctx=$(grep -n 'Safe to commit' "$CI" | head -1 | cut -d: -f1)
full_ctx=$(grep -n 'All FULL-tier local-ci checks passed' "$CI" | head -1 | cut -d: -f1)
if [ -n "$safe_ctx" ] && [ -n "$full_ctx" ] && [ "$safe_ctx" -gt "$full_ctx" ]; then
  ok "'Safe to commit + push' only in the FULL branch"
else
  bad "'Safe to commit + push' is not confined to the FULL branch"
fi

# ---------------------------------------------------------------------------
# 3. Trust core is never deferred (the moat)
# ---------------------------------------------------------------------------
# Every trust-core suite local-ci invokes must be matched by _FAST_KEEP. This is
# the inverted guard: the dangerous edit is ADDING a trust-core suite and
# forgetting to keep it, which a "don't defer these words" check cannot see.
missing=""
while read -r p; do
  [ -n "$p" ] || continue
  # Re-implement the keep match the same way local-ci does: substring of a label.
  hit=0
  while read -r pat; do
    [ -n "$pat" ] || continue
    case "$p" in *"$pat"*) hit=1; break ;; esac
  done < <(sed -n '/^declare -a _FAST_KEEP=(/,/^)/p' "$CI" | grep -oE '^  "[^"]+"' | tr -d ' "')
  [ "$hit" = "1" ] || missing="$missing $p"
done < <(grep -oE 'tests/[a-z0-9/_-]*(proof|receipt|council|verify|evidence|redaction)[a-z0-9/_-]*\.(sh|py)' "$CI" | sort -u)
if [ -z "$missing" ]; then
  ok "every trust-core suite is on the FAST keep list"
else
  bad "trust-core suite(s) not kept in fast tier:$missing"
fi

# And the guard that enforces it must actually be present and fatal.
grep -q 'trust-core suite(s) not covered by _FAST_KEEP' "$CI" \
  && ok "runtime trust-core guard present" || bad "runtime trust-core guard missing"

# The guard must abort (exit 2), not warn.
awk '/trust-core suite\(s\) not covered by _FAST_KEEP/,/^fi/' "$CI" | grep -q 'exit 2' \
  && ok "trust-core guard is fatal" || bad "trust-core guard does not exit"

# ---------------------------------------------------------------------------
# 4. Deferred checks are PRINTED, never silently dropped
# ---------------------------------------------------------------------------
# Deferral routes through skip_check, which feeds the SKIPPED array that the
# summary prints. If a future edit made deferral a bare `return`, the fast tier
# would hide what it gave up.
deferrals=$(grep -c 'skip_check "$label" "DEFERRED by fast tier' "$CI")
check "both run_check and run_check_bg defer via skip_check" "$deferrals" "2"

grep -q 'check(s) deferred' "$CI" \
  && ok "summary states the deferred COUNT" || bad "summary omits the deferred count"

# The scale of the biggest deferral must be named. The blanket pytest run is
# where a pre-existing red can hide, so its size is stated explicitly.
grep -q '1793 tests' "$CI" \
  && ok "summary names the blanket pytest scale" || bad "summary does not name pytest scale"

# ---------------------------------------------------------------------------
# 5. FULL tier is unchanged by the tiering
# ---------------------------------------------------------------------------
# Both tier-gated code paths must short-circuit when the tier is full, so a full
# run behaves exactly as it did before tiering existed.
grep -q '\[ "$TIER" = "fast" \] || return 1' "$CI" \
  && ok "_should_defer is inert in the full tier" || bad "_should_defer not gated on fast"

# The per-file pytest gates parallelize ONLY in fast (where the blanket run,
# which collects the same files, is absent). Full keeps them serial.
awk '/^run_check_pyfile\(\)/,/^}/' "$CI" | grep -q 'if \[ "$TIER" = "fast" \]' \
  && ok "per-file pytest gates parallelize only in the fast tier" \
  || bad "run_check_pyfile is not tier-gated"

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
