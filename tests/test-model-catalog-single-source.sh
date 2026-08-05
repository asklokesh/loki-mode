#!/usr/bin/env bash
# Test: the model catalog has ONE source of truth for the latest model per tier.
#
# THE BUG (measured 2026-07-31)
#   providers/model_catalog.json carried per-provider top-level keys
#     latest_fast / latest_development / latest_planning
#   AND a models[] array where every entry declares its own `tier`. Two places
#   said the same thing, so they drifted:
#
#     claude: latest_fast=claude-sonnet-5   but models[tier=fast]=claude-haiku-4-5
#     codex:  latest_fast=gpt-5.3-codex     but models[tier=fast]=o4-mini
#
#   Consequence: asking for the cheap tier silently billed the mid tier.
#
#   models[] is authoritative because it is the richer structure -- it carries
#   context_window, max_output, open_weights, alias and notes per model. The
#   top-level keys carry nothing models[] does not. They are kept only because
#   six readers consume them (dashboard/server.py serves the raw file to the web
#   app, tests/test-provider-model-scoping.sh, tests/test-model-and-port.sh,
#   tools/probe-model-catalog.py, skills/providers.md) -- so instead of deleting
#   them, DRIFT is what this test makes impossible.
#
# Proven directions:
#   AGREES   : every tier resolves to a model whose OWN tier field says that
#              tier. This is the check that would have caught the bug -- it is
#              red on claude-fast and codex-fast before the fix.
#   EXPLICIT : a tier with no models[] entry resolves only via a DECLARED
#              tier_fallback, never by accidentally walking to another tier.
#   MIRRORS  : every top-level latest_<tier> equals what the resolver returns,
#              so the kept keys are validated rather than hand-maintained.
#   EXISTS   : every id named in a top-level key or cli_aliases is a real entry
#              in models[]. Catches the next drift at its source.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG="$SCRIPT_DIR/../providers/model_catalog.json"
MODELS_SH="$SCRIPT_DIR/../providers/models.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== model catalog: single source of truth per tier ==="

[ -f "$CATALOG" ]   || { echo "  FAIL: catalog not found at $CATALOG"; exit 1; }
[ -f "$MODELS_SH" ] || { echo "  FAIL: models.sh not found at $MODELS_SH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "  SKIP: python3 unavailable"; exit 0; }

# models.sh uses bash indirect expansion (${!var}) for its env-override chain,
# which is a BASH feature -- under zsh it dies with "bad substitution". Always
# invoke the resolver through `bash -c`, never by sourcing into whatever shell
# happens to be running this suite.
resolve() {
    bash -c '. "$1" >/dev/null 2>&1; loki_latest_model "$2" "$3" 2>/dev/null' _ \
        "$MODELS_SH" "$1" "$2"
}

providers="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print(" ".join(sorted(d.get("providers", {}))))' "$CATALOG")"

# ---- AGREES + EXPLICIT ---------------------------------------------------
# For each provider/tier: resolve through the REAL resolver, then ask the
# catalog what that id claims its own tier is. A disagreement is the drift.
for p in $providers; do
    for tier in planning development fast; do
        got="$(resolve "$p" "$tier")"
        if [ -z "$got" ]; then
            bad "$p/$tier resolved to nothing"
            continue
        fi
        verdict="$(python3 - "$CATALOG" "$p" "$tier" "$got" <<'PY'
import json, sys
catalog, provider, tier, got = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = json.load(open(catalog))
cfg = d.get("providers", {}).get(provider, {})
models = [m for m in cfg.get("models", []) if isinstance(m, dict)]

# Does models[] declare an entry for this tier at all?
tier_entries = [m for m in models if m.get("tier") == tier]
# What tier does the RESOLVED id claim for itself?
own = [m.get("tier") for m in models if m.get("id") == got]

if tier_entries:
    # A tier with entries must resolve to one of them. Anything else is drift.
    if got in [m.get("id") for m in tier_entries]:
        print("OK direct")
    else:
        print("DRIFT resolved=%s claims_tier=%s but models[tier=%s]=%s"
              % (got, own[0] if own else "<absent>", tier,
                 ",".join(m.get("id", "") for m in tier_entries)))
elif not own:
    print("MISSING resolved=%s is not in models[] at all" % got)
else:
    # No entry for this tier -- allowed ONLY via a declared fallback.
    fb = cfg.get("tier_fallback", {})
    target = fb.get(tier) if isinstance(fb, dict) else None
    if not target:
        print("IMPLICIT resolved=%s but no models[tier=%s] and no declared "
              "tier_fallback.%s" % (got, tier, tier))
    elif own[0] != target:
        print("BADFALLBACK tier_fallback.%s=%s but resolved id claims tier=%s"
              % (tier, target, own[0]))
    else:
        print("OK fallback->%s" % target)
PY
)"
        case "$verdict" in
            OK*) ok "$p/$tier -> $got ($verdict)" ;;
            *)   bad "$p/$tier: $verdict" ;;
        esac
    done
done

# ---- MIRRORS -------------------------------------------------------------
# The kept top-level keys must equal what the resolver produces. Any hand-edit
# that disagrees with models[] fails here.
for p in $providers; do
    for tier in planning development fast; do
        declared="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print(d["providers"][sys.argv[2]].get("latest_" + sys.argv[3], ""))' \
            "$CATALOG" "$p" "$tier")"
        got="$(resolve "$p" "$tier")"
        if [ -z "$declared" ]; then
            ok "$p: no latest_$tier key (derived-only is fine)"
        elif [ "$declared" = "$got" ]; then
            ok "$p: latest_$tier mirrors the resolver ($got)"
        else
            bad "$p: latest_$tier='$declared' but resolver says '$got'"
        fi
    done
done

# ---- EXISTS --------------------------------------------------------------
orphans="$(python3 - "$CATALOG" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
out = []
for name, cfg in d.get("providers", {}).items():
    ids = {m.get("id") for m in cfg.get("models", []) if isinstance(m, dict)}
    for key in ("latest_planning", "latest_development", "latest_fast"):
        v = cfg.get(key)
        if v and v not in ids:
            out.append("%s.%s=%s" % (name, key, v))
    aliases = cfg.get("cli_aliases", {})
    if isinstance(aliases, dict):
        for a, v in aliases.items():
            if v not in ids:
                out.append("%s.cli_aliases.%s=%s" % (name, a, v))
print("\n".join(out))
PY
)"
if [ -z "$orphans" ]; then
    ok "every id named outside models[] exists inside models[]"
else
    bad "ids named outside models[] with no models[] entry:"
    printf '%s\n' "$orphans" | sed 's/^/        /'
fi

echo
echo "  passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
