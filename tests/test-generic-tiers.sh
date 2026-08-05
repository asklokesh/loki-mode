#!/usr/bin/env bash
# Generic capability tiers: small | medium | high.
#
# WHY THIS EXISTS. A user should be able to ask for a class of model without
# knowing any vendor's model names. The vocabulary is only worth anything if
# EVERY provider can actually answer for all three tiers -- a tier that resolves
# to nothing for one provider turns a documented promise into a dead end the
# moment someone switches providers.
#
# The vocabulary is a TRANSLATION onto the canonical tier names
# (fast|development|planning) rather than a fourth spelling. That choice is what
# these tests pin down: the entry points must translate, and everything
# downstream must keep seeing only the canonical names. LOKI_MAX_TIER (a cost
# CEILING) and LOKI_TIER (the OSS licensing seam) are different concepts and are
# deliberately not involved.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG="$REPO_ROOT/providers/model_catalog.json"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

[ -f "$CATALOG" ] || { echo "FAIL: $CATALOG missing"; exit 1; }

# shellcheck source=../providers/models.sh
source "$REPO_ROOT/providers/models.sh"

# ---------------------------------------------------------------------------
# 1. All three tiers resolve for EVERY provider in the catalog.
# ---------------------------------------------------------------------------
# The provider list is read FROM THE CATALOG, never hardcoded. A hardcoded list
# silently stops covering any provider added later -- which is exactly how a new
# provider would ship with a tier that resolves to nothing.
mapfile -t PROVIDERS < <(python3 -c "
import json
with open('$CATALOG') as fh:
    print('\n'.join(json.load(fh)['providers'].keys()))
")

if [ "${#PROVIDERS[@]}" -lt 2 ]; then
    bad "only ${#PROVIDERS[@]} providers parsed from the catalog; the schema changed"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi
ok "parsed ${#PROVIDERS[@]} providers from the catalog"

for provider in "${PROVIDERS[@]}"; do
    for tier in small medium high; do
        resolved="$(loki_latest_model "$provider" "$tier" 2>/dev/null)"
        rc=$?
        if [ "$rc" -eq 0 ] && [ -n "$resolved" ]; then
            ok "$provider / $tier -> $resolved"
        else
            bad "$provider / $tier did not resolve (rc=$rc, value='${resolved}')"
        fi
    done
done

# An UNKNOWN provider must still resolve all three tiers via the catalog's
# generic fallback. Bring-your-own-endpoint is a supported case, and a user who
# picks a tier there deserves an answer rather than an empty string.
for tier in small medium high; do
    resolved="$(loki_latest_model "some-unlisted-vendor" "$tier" 2>/dev/null)"
    if [ -n "$resolved" ]; then
        ok "unknown provider / $tier falls back to $resolved"
    else
        bad "unknown provider / $tier resolved to nothing"
    fi
done

# ---------------------------------------------------------------------------
# 2. The generic words are ALIASES, not new models.
# ---------------------------------------------------------------------------
# This is the regression that matters most: `medium` must resolve to exactly
# what `development` already resolved to, for every provider. If these ever
# diverge, every existing build silently changes which model it pays for.
for provider in "${PROVIDERS[@]}"; do
    for pair in "small:fast" "medium:development" "high:planning"; do
        generic="${pair%%:*}"
        canonical="${pair##*:}"
        a="$(loki_latest_model "$provider" "$generic" 2>/dev/null)"
        b="$(loki_latest_model "$provider" "$canonical" 2>/dev/null)"
        if [ "$a" = "$b" ]; then
            ok "$provider: $generic == $canonical ($a)"
        else
            bad "$provider: $generic ('$a') != $canonical ('$b')"
        fi
    done
done

# medium is THE DEFAULT. An omitted tier must behave as medium, or "medium is
# the default" is a documentation claim with nothing behind it.
for provider in "${PROVIDERS[@]}"; do
    omitted="$(loki_tier_alias "" 2>/dev/null)"
    if [ "$omitted" = "development" ]; then
        ok "omitted tier defaults to development (medium)"
        break
    else
        bad "omitted tier resolved to '$omitted', expected development"
        break
    fi
done

# ---------------------------------------------------------------------------
# 3. run.sh translates the vocabulary at its entry point.
# ---------------------------------------------------------------------------
# The session-pin case block is byte-mirrored in the estimator and the
# dashboard. Translating at the entry point is what lets those mirrors stay
# untouched, so this asserts the translation happens BEFORE anything routes on
# the value -- and, just as importantly, that nothing else is rewritten.
run_sh_pin() {
    # Extract the value LOKI_SESSION_MODEL holds after run.sh's normalization,
    # without executing the whole runner: replay the same case block. Sourcing
    # run.sh would start a build, so the block is exercised in isolation and
    # kept honest by the literal-presence assertions below.
    local input="$1"
    LOKI_SESSION_MODEL="$input" bash -c '
        _t="${LOKI_SESSION_MODEL:-}"
        _t="${_t#"${_t%%[![:space:]]*}"}"
        _t="${_t%"${_t##*[![:space:]]}"}"
        case "$(printf "%s" "$_t" | tr "[:upper:]" "[:lower:]")" in
            small)  LOKI_SESSION_MODEL="fast" ;;
            medium) LOKI_SESSION_MODEL="development" ;;
            high)   LOKI_SESSION_MODEL="planning" ;;
        esac
        printf "%s" "${LOKI_SESSION_MODEL:-<unset>}"
    '
}

for pair in "small:fast" "medium:development" "high:planning" \
            "SMALL:fast" " high :planning"; do
    input="${pair%%:*}"
    want="${pair##*:}"
    got="$(run_sh_pin "$input")"
    if [ "$got" = "$want" ]; then
        ok "run.sh pin: '$input' -> $want"
    else
        bad "run.sh pin: '$input' -> '$got', expected '$want'"
    fi
done

# NOTHING ELSE MAY BE REWRITTEN. An unset pin must stay unset so the downstream
# ':-sonnet' default still applies, and the existing spellings must pass through
# untouched -- otherwise adding this vocabulary would change which model
# existing builds dispatch, which is the one outcome that is not allowed.
for passthrough in sonnet haiku opus fable planning development fast "med ium"; do
    got="$(run_sh_pin "$passthrough")"
    if [ "$got" = "$passthrough" ]; then
        ok "run.sh pin: '$passthrough' passes through unchanged"
    else
        bad "run.sh pin: '$passthrough' was rewritten to '$got'"
    fi
done

got="$(run_sh_pin "")"
if [ "$got" = "<unset>" ] || [ -z "$got" ]; then
    ok "run.sh pin: unset stays unset (downstream sonnet default still applies)"
else
    bad "run.sh pin: unset became '$got'"
fi

# The replayed block above is only meaningful if run.sh really contains it.
for literal in 'small)  LOKI_SESSION_MODEL="fast"' \
               'medium) LOKI_SESSION_MODEL="development"' \
               'high)   LOKI_SESSION_MODEL="planning"'; do
    if grep -qF "$literal" "$REPO_ROOT/autonomy/run.sh"; then
        ok "run.sh contains the translation arm: ${literal%%)*}"
    else
        bad "run.sh is MISSING the translation arm: ${literal%%)*}"
    fi
done

# ---------------------------------------------------------------------------
# 4. The other readers of LOKI_SESSION_MODEL translate it too.
# ---------------------------------------------------------------------------
# The `loki plan` estimator and the dashboard each read LOKI_SESSION_MODEL in
# their OWN process, so run.sh's normalization does not reach them. If either
# misses the translation, a 'medium' pin falls through to their default and the
# quoted or displayed model stops matching the dispatched one.
if grep -q "_LOKI_GENERIC_TIERS" "$REPO_ROOT/autonomy/loki"; then
    ok "the loki plan estimator translates the generic vocabulary"
else
    bad "autonomy/loki estimator does NOT translate small|medium|high"
fi

if grep -q "_GENERIC_TIERS" "$REPO_ROOT/dashboard/server.py"; then
    ok "the dashboard translates the generic vocabulary"
else
    bad "dashboard/server.py does NOT translate small|medium|high"
fi

# The estimator's normalizer must translate BEFORE its allowlist check, or the
# new words are filtered out as junk before the mapping is ever consulted.
if python3 - "$REPO_ROOT/autonomy/loki" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r"def _loki_norm_session_pin\(raw\):(.*?)\n\n", src, re.S)
body = m.group(1) if m else ""
sys.exit(0 if "_LOKI_GENERIC_TIERS.get(raw, raw)" in body else 1)
PY
then
    ok "estimator translates inside _loki_norm_session_pin (before the allowlist)"
else
    bad "estimator translation is not inside _loki_norm_session_pin"
fi

# ---------------------------------------------------------------------------
# 5. The user-facing surface reports what each tier resolves to.
# ---------------------------------------------------------------------------
# Documenting a vocabulary without a way to check it leaves the user trusting a
# table. `loki provider models` must name the generic tiers.
models_out="$("$REPO_ROOT/autonomy/loki" provider models 2>/dev/null)"
for tier in small medium high; do
    if printf '%s' "$models_out" | grep -q "$tier"; then
        ok "loki provider models reports the '$tier' tier"
    else
        bad "loki provider models does not mention '$tier'"
    fi
done

# The canonical name must stay visible alongside it: every env var, log line and
# state file still uses it, so hiding it would strand anyone reading those.
if printf '%s' "$models_out" | grep -q "(development)"; then
    ok "loki provider models keeps the canonical tier name alongside the generic one"
else
    bad "loki provider models dropped the canonical tier names"
fi

# An empty model for codex is a SUPPORTED state (no --model flag is sent so
# Codex picks an account-appropriate model). It must read as a deliberate
# default, not as a blank cell that looks like a broken lookup.
if printf '%s' "$models_out" | grep -q "provider default"; then
    ok "an unset provider model is labelled rather than shown blank"
else
    bad "an unset provider model shows as a blank column"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
