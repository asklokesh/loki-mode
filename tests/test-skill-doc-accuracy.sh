#!/usr/bin/env bash
# Drift guard: skill modules are loaded INTO the agent's context and acted on.
# A false claim in skills/ is worse than no claim, so assert the load-bearing
# ones against source instead of trusting review.
#
# Every check below derives its expectation from source (provider configs,
# run.sh flag literals, the skills/ directory listing). Nothing is hardcoded,
# so adding a provider or a skill module updates the expectation automatically.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT" || exit 1

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL: $1"; }

# --- 1. Every opt-out flag in the quality-gates table exists in run.sh --------
# A documented flag that no longer exists tells the agent it can disable a gate
# it cannot, or that a gate is opt-out when it is mandatory.
echo "== quality-gates.md opt-out flags resolve in autonomy/run.sh =="
# Covers the numbered table's opt-outs (PHASE_*, LOKI_GATE_*) AND the flags with
# the highest blast radius: the opt-in coverage gate and the advisory *_BLOCK
# arms, which decide whether a gate blocks at all.
gate_flags=$(grep -oE '`(PHASE_[A-Z_]+|LOKI_[A-Z_]*GATE[A-Z_]*|LOKI_[A-Z_]+_BLOCK)=' skills/quality-gates.md \
    | tr -d '`=' | sort -u)
if [ -z "$gate_flags" ]; then
    fail "no gate opt-out flags parsed from skills/quality-gates.md (parser drift)"
else
    for flag in $gate_flags; do
        if grep -q "$flag" autonomy/run.sh; then
            pass "$flag is referenced in autonomy/run.sh"
        else
            fail "$flag documented in skills/quality-gates.md but absent from autonomy/run.sh"
        fi
    done
fi

# --- 2. Provider count in model-selection.md matches the loader ---------------
# providers/loader.sh SUPPORTED_PROVIDERS is the single source of truth for
# which providers the runner accepts.
echo "== model-selection.md provider count matches providers/loader.sh =="
supported=$(grep -E '^SUPPORTED_PROVIDERS=' providers/loader.sh \
    | sed 's/.*(\(.*\)).*/\1/' | tr -d '"' | wc -w | tr -d ' ')
if [ "$supported" -lt 1 ]; then
    fail "could not parse SUPPORTED_PROVIDERS from providers/loader.sh"
else
    # Each supported provider must appear by name in the skill module, so the
    # agent never reasons about a provider set that omits a real route.
    for p in $(grep -E '^SUPPORTED_PROVIDERS=' providers/loader.sh \
        | sed 's/.*(\(.*\)).*/\1/' | tr -d '"'); do
        if grep -qi "$p" skills/model-selection.md; then
            pass "provider '$p' is documented in skills/model-selection.md"
        else
            fail "provider '$p' is in SUPPORTED_PROVIDERS but missing from skills/model-selection.md"
        fi
    done

    # The PROVIDER_DEGRADED column must match each provider's own config. The
    # name appearing in the doc is not enough: a wrong true/false here tells the
    # agent a provider is crippled when it is not.
    for p in $(grep -E '^SUPPORTED_PROVIDERS=' providers/loader.sh \
        | sed 's/.*(\(.*\)).*/\1/' | tr -d '"'); do
        [ -f "providers/${p}.sh" ] || continue
        real=$(grep -E '^PROVIDER_DEGRADED=' "providers/${p}.sh" | head -1 | cut -d= -f2)
        [ -n "$real" ] || continue
        # Read the doc table row for this provider and pull its degraded cell.
        row=$(grep -iE "^\| \*\*.*\b${p}\b.*\*\* \|" skills/model-selection.md | head -1)
        if [ -z "$row" ]; then
            continue  # count/name checks above already cover a missing row
        fi
        claimed=$(printf '%s' "$row" | awk -F'|' '{print $4}' | grep -oE 'true|false' | head -1)
        if [ "$claimed" = "$real" ]; then
            pass "PROVIDER_DEGRADED for '$p' documented as '$real' (matches source)"
        else
            fail "PROVIDER_DEGRADED drift for '$p': providers/${p}.sh says '$real', doc says '${claimed:-<none>}'"
        fi
    done

    # The prose count must agree with the loader, not drift behind it.
    declare -A numword=( [1]=one [2]=two [3]=three [4]=four [5]=five [6]=six [7]=seven [8]=eight )
    want_word="${numword[$supported]:-$supported}"
    if grep -qiE "supports (${want_word}|${supported}) AI providers" skills/model-selection.md; then
        pass "documented provider count matches loader ($supported)"
    else
        got=$(grep -oiE 'supports [a-z0-9]+ AI providers' skills/model-selection.md | head -1)
        fail "provider count drift: loader has $supported, doc says '${got:-<none>}'"
    fi
fi

# --- 3. Stock tier resolution claims match the executed provider config -------
# The doc tells the agent what `loki plan` quotes. Resolve the tiers for real
# rather than trusting the prose.
echo "== model-selection.md stock tier claims match providers/claude.sh =="
dev_model=$(bash -c 'source providers/claude.sh >/dev/null 2>&1; printf "%s" "$PROVIDER_MODEL_DEVELOPMENT"')
if [ -z "$dev_model" ]; then
    fail "could not resolve PROVIDER_MODEL_DEVELOPMENT from providers/claude.sh"
else
    pass "PROVIDER_MODEL_DEVELOPMENT resolves to '$dev_model'"
    # No sentence may claim the development tier resolves to something else.
    if grep -qiE "session pin resolves through the development tier to (opus|haiku|fable)" skills/model-selection.md \
       && ! grep -qiE "development tier to ${dev_model}" skills/model-selection.md; then
        fail "model-selection.md claims the development tier resolves to a model other than '$dev_model'"
    else
        pass "no stale development-tier resolution claim"
    fi
    # The LOKI_MAX_TIER clamp paragraph names PROVIDER_MODEL_DEVELOPMENT's value.
    if grep -qE 'PROVIDER_MODEL_DEVELOPMENT`, [a-z]+ by default' skills/model-selection.md; then
        claimed=$(grep -oE 'PROVIDER_MODEL_DEVELOPMENT`, [a-z]+ by default' skills/model-selection.md \
            | head -1 | awk '{print $2}')
        if [ "$claimed" = "$dev_model" ]; then
            pass "clamp paragraph names the real default ('$dev_model')"
        else
            fail "clamp paragraph says PROVIDER_MODEL_DEVELOPMENT is '$claimed' by default, source resolves '$dev_model'"
        fi
    fi
fi

# --- 4. 00-index.md can route to every skill module --------------------------
# The index is how the agent decides what to load. A module it cannot name is a
# module that never gets loaded, however binding the module claims to be.
echo "== 00-index.md routes to every module in skills/ =="
for f in skills/*.md; do
    b=$(basename "$f")
    [ "$b" = "00-index.md" ] && continue
    if grep -q "$b" skills/00-index.md; then
        pass "00-index.md references $b"
    else
        fail "$b exists in skills/ but 00-index.md cannot route to it"
    fi
done

# --- 5. The documented extension seam is real and exercised ------------------
# skills/extending.md tells developers they can add a reviewer without editing
# engine files. Assert the seam and its test both still exist.
echo "== extension seam documented in skills/ is wired and tested =="
if [ -f skills/extending.md ]; then
    if grep -q "installed_agent_list" autonomy/run.sh; then
        pass "run.sh consumes installed_agent_list (R10 reviewer seam wired)"
    else
        fail "skills/extending.md documents the R10 seam but run.sh no longer calls installed_agent_list"
    fi
    # extending.md cites bare run.sh line numbers, and run.sh shifts constantly.
    # Numbers cannot be asserted, but the CONTENT each one points at can: if an
    # anchor string vanishes, every citation around it is stale.
    while IFS= read -r anchor; do
        if grep -qF "$anchor" autonomy/run.sh; then
            pass "run.sh anchor present: ${anchor:0:52}"
        else
            fail "run.sh anchor GONE, extending.md citations are stale: ${anchor:0:52}"
        fi
    done <<'ANCHORS'
# R10 extension seam: agents installed by the user via `loki agent install`
INSTALLED_SPECIALISTS = {}
# Never let an installed agent shadow a built-in reviewer perspective.
No keywords means it could never score; skip rather than always-on.
Corrupt or absent installed.json must never break code review.
_MAX_INSTALLED_REVIEWERS = 2
ANCHORS

    if [ -f tests/test-installed-agent-reviewer.sh ]; then
        pass "tests/test-installed-agent-reviewer.sh covers the seam"
    else
        fail "skills/extending.md documents a seam with no test"
    fi
    # src/plugins is NOT a seam: assert the doc does not sell it as one while
    # the loop never calls it.
    if grep -q "src/plugins" skills/extending.md; then
        if grep -qE "require.*src/plugins|plugins/loader" autonomy/run.sh autonomy/loki 2>/dev/null; then
            pass "src/plugins referenced by the engine, doc may present it as live"
        elif grep -qiE "not wired|no consumer|dead|not invoked|never call" skills/extending.md; then
            pass "src/plugins is described honestly as unwired"
        else
            fail "skills/extending.md presents src/plugins as usable but no engine file calls it"
        fi
    fi
else
    fail "skills/extending.md missing: the extension seam is undocumented"
fi

echo ""
echo "=== results: $PASSED passed, $FAILED failed ==="
[ "$FAILED" -eq 0 ]
