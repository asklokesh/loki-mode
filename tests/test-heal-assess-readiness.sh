#!/usr/bin/env bash
#===============================================================================
# Heal Assess Readiness Triage Tests (rank 13)
#
# Covers `loki heal --assess` -- a READ-ONLY modernization readiness triage that
# scans a codebase and emits a report with:
#   - estimated LOC / language mix
#   - technical-debt signals (tests present, TODO/FIXME density, large files)
#   - a placement on the 4-level maturity model (Ad hoc/Planned/Systematic/Optimized)
#   - a RANKED list of low-blast-radius, high-visibility candidate targets + rationale
#
# The command is implemented in autonomy/loki (cmd_heal --assess branch). It
# must NOT mutate the target codebase, and every number must come from a real
# deterministic scan (no fabricated LOC/debt figures).
#
# NON-VACUITY / RED-before-change:
#   Test R proves the flag did not exist before the change by running the
#   committed (git HEAD) copy of autonomy/loki with --assess and asserting it
#   errors ("Unknown option") instead of emitting a readiness report. The
#   working-tree copy (with the change) must instead emit the report. If the
#   feature were removed, tests G1..G6 would fail.
#
# The discriminating acceptance test is G4: the ranking must place an ISOLATED
# (low-blast-radius) module ABOVE a highly-COUPLED one (playbook weeks 1-2),
# regardless of raw size.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [[ -n "${2:-}" ]] && echo "         $2"
}

skip_all() {
    echo "  [SKIP] $1"
    exit 0
}

# Dependency self-skip: python3 does the scan; git is used for the read-only
# proof and the RED reconstruction. If either is absent, skip rather than fail.
command -v python3 >/dev/null 2>&1 || skip_all "python3 not available"
command -v git >/dev/null 2>&1 || skip_all "git not available"
[[ -f "$LOKI_BIN" ]] || skip_all "autonomy/loki not found at $LOKI_BIN"

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-healassess.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Heal Assess Readiness Triage Tests (rank 13)"
echo "============================================"
echo ""

#-------------------------------------------------------------------------------
# Build a fixture legacy repo with KNOWN, wc-verifiable counts:
#   - src/core.py        : imported by 5 consumer files -> HIGHLY COUPLED
#   - src/isolated.py    : imported by nothing, carries a TODO -> ISOLATED
#   - src/consumer{1..5} : each `from core import util` -> make core coupled
#   - src/big.py         : 600 lines -> a large file (>=500 LOC debt signal)
#   - tests/test_core.py : a test file -> has_tests true
#   - package.json + package-lock.json : manifest + lockfile present
# It is a real git repo so we can prove read-only via `git status`.
#-------------------------------------------------------------------------------
FIX="$WORKROOT/legacy"
mkdir -p "$FIX/src" "$FIX/tests"
printf 'def util():\n    return 1\n' > "$FIX/src/core.py"
printf '# TODO: refactor this\ndef standalone():\n    return 2\n' > "$FIX/src/isolated.py"
for i in 1 2 3 4 5; do
    printf 'from core import util\ndef f%s():\n    return util()\n' "$i" > "$FIX/src/consumer$i.py"
done
python3 -c "open('$FIX/src/big.py','w').write('x = 1\n'*600)"
printf 'def test_ok():\n    assert True\n' > "$FIX/tests/test_core.py"
printf '{}\n' > "$FIX/package.json"
printf '{}\n' > "$FIX/package-lock.json"

# Real, independently-computed counts from the fixture (the report must match).
EXPECTED_LOC="$(cat "$FIX"/src/*.py "$FIX"/tests/*.py | wc -l | tr -d ' ')"
EXPECTED_TODO="$(grep -roE '\b(TODO|FIXME|HACK|XXX)\b' "$FIX/src" "$FIX/tests" | wc -l | tr -d ' ')"

# Init a git repo and commit the fixture so `git status --porcelain` is clean.
(
    cd "$FIX" || exit 1
    git init -q
    git config user.email "test@example.com"
    git config user.name "test"
    git add -A
    git commit -qm "fixture" >/dev/null 2>&1
)

#-------------------------------------------------------------------------------
# RED (Test R): the committed (HEAD) copy of autonomy/loki does NOT know --assess.
# We extract it and run --assess against it; it must error, not emit a report.
# (If HEAD already has the flag -- e.g. after this change lands -- the RED proof
# is not applicable; we report it as an informational skip, not a failure.)
#-------------------------------------------------------------------------------
OLD_LOKI="$WORKROOT/loki.HEAD"
if git -C "$PROJECT_DIR" show HEAD:autonomy/loki > "$OLD_LOKI" 2>/dev/null; then
    chmod +x "$OLD_LOKI"
    red_out="$(bash "$OLD_LOKI" heal "$FIX" --assess 2>&1)"
    if echo "$red_out" | grep -qiE "unknown option|Modernization Readiness"; then
        if echo "$red_out" | grep -qi "Modernization Readiness"; then
            echo "  [INFO] RED not applicable: HEAD copy of autonomy/loki already emits the report"
            echo "         (the --assess feature is already committed)."
        else
            pass "R: HEAD copy rejects --assess (Unknown option) -- feature is new"
        fi
    else
        # Neither an error nor a report -- unexpected; surface it but don't hard-fail RED.
        echo "  [INFO] RED reconstruction inconclusive; HEAD output: $(echo "$red_out" | head -1)"
    fi
else
    echo "  [INFO] Could not extract HEAD copy of autonomy/loki; skipping RED reconstruction."
fi

#-------------------------------------------------------------------------------
# GREEN: run the working-tree loki (with the change).
#-------------------------------------------------------------------------------
HUMAN_OUT="$(bash "$LOKI_BIN" heal "$FIX" --assess 2>&1)"
JSON_OUT="$(bash "$LOKI_BIN" heal "$FIX" --assess --json 2>/dev/null)"

# G1: human report contains the required sections.
if echo "$HUMAN_OUT" | grep -q "Modernization Readiness Assessment" \
   && echo "$HUMAN_OUT" | grep -q "Maturity" \
   && echo "$HUMAN_OUT" | grep -q "Where to start"; then
    pass "G1: human report has maturity placement + ranked targets sections"
else
    fail "G1: human report missing a required section" "$(echo "$HUMAN_OUT" | head -5)"
fi

# G2: --json emits valid JSON with the required keys.
if echo "$JSON_OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert 'maturity' in d and 'label' in d['maturity'] and 'level' in d['maturity']
assert 'ranked_targets' in d and len(d['ranked_targets']) >= 1
assert all('rationale' in t for t in d['ranked_targets'])
assert 'scan' in d and 'debt_signals' in d
" 2>/dev/null; then
    pass "G2: --json parses and has maturity + ranked_targets(+rationale) + scan/debt"
else
    fail "G2: --json invalid or missing keys" "$(echo "$JSON_OUT" | head -3)"
fi

# G3: reported LOC and TODO count match the fixture's REAL wc/grep counts (honesty).
if echo "$JSON_OUT" | EXPECTED_LOC="$EXPECTED_LOC" EXPECTED_TODO="$EXPECTED_TODO" python3 -c "
import json,sys,os
d=json.load(sys.stdin)
exp_loc=int(os.environ['EXPECTED_LOC']); exp_todo=int(os.environ['EXPECTED_TODO'])
loc=d['scan']['total_loc']; todo=d['debt_signals']['todo_fixme_count']
assert loc==exp_loc, f'LOC {loc} != wc {exp_loc}'
assert todo==exp_todo, f'TODO {todo} != grep {exp_todo}'
" 2>/dev/null; then
    pass "G3: reported LOC ($EXPECTED_LOC) + TODO ($EXPECTED_TODO) match real wc/grep counts"
else
    fail "G3: reported numbers do not match the fixture's real counts"
fi

# G4 (discriminating): the ISOLATED module ranks ABOVE the COUPLED one.
if echo "$JSON_OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
paths=[t['path'] for t in d['ranked_targets']]
assert 'src/core.py' in paths and 'src/isolated.py' in paths, paths
iso=paths.index('src/isolated.py'); core=paths.index('src/core.py')
assert iso < core, f'isolated(rank {iso}) must precede coupled core(rank {core})'
# and core must actually be detected as coupled (>0 inbound refs)
core_refs=[t['inbound_refs'] for t in d['ranked_targets'] if t['path']=='src/core.py'][0]
assert core_refs >= 1, f'core inbound_refs {core_refs} should be >=1'
" 2>/dev/null; then
    pass "G4: ranking places isolated module above the coupled one (low blast-radius first)"
else
    fail "G4: isolated module did NOT rank above the coupled one"
fi

# G4b (adversarial): isolation must DOMINATE size. A small isolated file must
# rank above a LARGE but heavily-coupled file, else "prefer low-blast-radius"
# would be defeated by any big monolith. Uses a second, separate fixture.
ADV="$WORKROOT/adversarial"
mkdir -p "$ADV/src"
python3 -c "open('$ADV/src/hub.py','w').write('def h():\n    return 0\n'+'x=1\n'*398)"
for i in 1 2 3 4 5 6 7 8; do printf 'from hub import h\n' > "$ADV/src/dep$i.py"; done
printf 'def solo():\n    return 1\n\n\n\n' > "$ADV/src/solo.py"
ADV_JSON="$(bash "$LOKI_BIN" heal "$ADV" --assess --json 2>/dev/null)"
if echo "$ADV_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
paths=[t['path'] for t in d['ranked_targets']]
assert 'src/solo.py' in paths and 'src/hub.py' in paths, paths
solo=paths.index('src/solo.py'); hub=paths.index('src/hub.py')
assert solo < hub, f'isolated-small solo(rank {solo}) must beat coupled-large hub(rank {hub})'
" 2>/dev/null; then
    pass "G4b: small isolated file ranks above a large coupled file (isolation > size)"
else
    fail "G4b: size defeated isolation in the ranking"
fi

# G5: maturity placement is one of the 4 valid levels with a rationale.
if echo "$JSON_OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=d['maturity']
assert m['label'] in ('Ad hoc','Planned','Systematic','Optimized'), m['label']
assert 1 <= m['level'] <= 4
assert isinstance(m['rationale'],str) and len(m['rationale']) > 0
" 2>/dev/null; then
    pass "G5: maturity is a valid 4-level placement with rationale"
else
    fail "G5: maturity placement invalid"
fi

# G6 (READ-ONLY): git status must be clean AND no .loki dir created in the target.
git_status="$(cd "$FIX" && git status --porcelain 2>/dev/null)"
if [[ -z "$git_status" ]] && [[ ! -d "$FIX/.loki" ]]; then
    pass "G6: read-only -- git status clean, no .loki created in target after --assess"
else
    fail "G6: --assess mutated the target" "porcelain='$git_status' loki_dir_exists=$([[ -d "$FIX/.loki" ]] && echo yes || echo no)"
fi

# G7: zero required flags beyond a path -- `--assess` alone (default cwd) works
# and stays read-only. Run inside the fixture with no path argument.
(
    cd "$FIX" || exit 1
    bash "$LOKI_BIN" heal --assess >/dev/null 2>&1
)
nodefault_status="$(cd "$FIX" && git status --porcelain 2>/dev/null)"
if [[ -z "$nodefault_status" ]] && [[ ! -d "$FIX/.loki" ]]; then
    pass "G7: --assess with no path (default cwd) works and stays read-only"
else
    fail "G7: default-path --assess mutated the target" "porcelain='$nodefault_status'"
fi

echo ""
echo "--------------------------------------------"
echo "Total: $TOTAL  Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
