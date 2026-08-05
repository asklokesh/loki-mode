#!/usr/bin/env bash
# Test: a non-Claude provider must not default to a Claude model.
#
# THE BUG (found 2026-07-29 auditing provider coupling)
#   providers/model_catalog.json configured BOTH aider and cline with
#     latest_planning:    claude-opus-4-8
#     latest_development: claude-sonnet-5
#     latest_fast:        claude-sonnet-5
#   and contained ZERO open-weight models -- no DeepSeek, GLM, Qwen, Kimi,
#   MiniMax. Three of the four providers defaulted to Claude.
#
#   So a user who switched provider specifically to stop paying frontier prices
#   kept paying them, silently, unless they happened to know to set
#   LOKI_MODEL_OVERRIDE. The one-file data default actively defeated the reason
#   to switch.
#
#   It is also backwards on the merits: aider and cline are the providers that
#   natively reach cheap models (verified on this machine --
#   `aider --list-models openrouter/` returns deepseek v3.2/r1, minimax-m2.1 and
#   :free variants), while we ranked them "degraded" for being un-Claude-like.
#
#   Context for why cheap defaults are defensible: on SWE-bench's uniform
#   scaffold batch (mini-swe-agent v2.0.0, 2026-02-17) MiniMax M2.5 resolved
#   75.8 at $36.64 total while Claude Opus 4.6 resolved 75.6 at $275.76 --
#   an open model matching frontier accuracy at ~7.5x lower cost.
#
# Proven directions:
#   NOCLAUDE : no non-claude provider has a claude-* model as a tier default.
#   OPEN     : the catalog actually contains open-weight models.
#   RESOLVES : loki_latest_model returns the non-Claude default for those
#              providers (the data change reaches the resolver).
#   OVERRIDE : the env override chain still wins (we changed data, not policy).
#   CLAUDE_OK: the claude provider still defaults to Claude (no over-correction).
#   VALID    : the catalog is still valid JSON with the expected schema.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG="$SCRIPT_DIR/../providers/model_catalog.json"
MODELS_SH="$SCRIPT_DIR/../providers/models.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== model catalog: no Claude defaults on non-Claude providers ==="

[ -f "$CATALOG" ] || { echo "  FAIL: catalog not found at $CATALOG"; exit 1; }

# ---- VALID ---------------------------------------------------------------
if python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert 'providers' in d; assert d.get('schema_version')" "$CATALOG" 2>/dev/null; then
    ok "catalog is valid JSON with the expected schema"
else
    bad "catalog is invalid JSON or lost its schema keys"
fi

# ---- NOCLAUDE ------------------------------------------------------------
offenders="$(python3 - "$CATALOG" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
bad = []
for name, cfg in d.get("providers", {}).items():
    if name == "claude":
        continue
    for tier in ("latest_planning", "latest_development", "latest_fast"):
        v = str(cfg.get(tier, ""))
        if "claude" in v.lower():
            bad.append(f"{name}.{tier}={v}")
print("\n".join(bad))
PY
)"
if [ -z "$offenders" ]; then
    ok "no non-Claude provider defaults to a Claude model"
else
    bad "non-Claude providers still default to Claude:"
    printf '%s\n' "$offenders" | sed 's/^/        /'
fi

# ---- OPEN ----------------------------------------------------------------
openct="$(python3 - "$CATALOG" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
names = ("deepseek", "glm", "qwen", "kimi", "minimax", "llama", "mimo")
seen = set()
for cfg in d.get("providers", {}).values():
    for m in cfg.get("models", []):
        mid = str(m.get("id", "")).lower()
        if any(n in mid for n in names):
            seen.add(mid)
print(len(seen))
PY
)"
if [ "${openct:-0}" -ge 3 ]; then
    ok "catalog lists open-weight models ($openct distinct)"
else
    bad "catalog lists only $openct open-weight model(s) -- cheap routing has no targets"
fi

# ---- RESOLVES: the data change must reach the resolver -------------------
# models.sh uses bash indirect expansion (${!var}) for its env-override chain,
# which is a BASH feature -- under zsh it dies with "bad substitution". Always
# invoke the resolver through `bash -c`, never by sourcing into whatever shell
# happens to be running this suite, or every lookup fails identically and the
# result looks like a catalog problem rather than a shell mismatch.
resolve() {
    bash -c '. "$1" >/dev/null 2>&1; loki_latest_model "$2" "$3" 2>/dev/null' _ \
        "$MODELS_SH" "$1" "$2"
}
for p in aider cline; do
    got="$(resolve "$p" development)"
    case "$(printf '%s' "$got" | tr '[:upper:]' '[:lower:]')" in
        *claude*) bad "loki_latest_model $p development resolved to '$got'" ;;
        "")       bad "loki_latest_model $p development resolved to nothing" ;;
        *)        ok  "loki_latest_model $p development -> $got (not Claude)" ;;
    esac
done

# ---- CLAUDE_OK: no over-correction ---------------------------------------
cgot="$(resolve claude development)"
case "$(printf '%s' "$cgot" | tr '[:upper:]' '[:lower:]')" in
    *claude*) ok "the claude provider still defaults to a Claude model ($cgot)" ;;
    *)        bad "claude provider now resolves to '$cgot' -- over-corrected" ;;
esac

# ---- OVERRIDE: policy unchanged ------------------------------------------
ogot="$(LOKI_AIDER_MODEL_DEVELOPMENT="my/custom-model" \
    bash -c '. "$1" >/dev/null 2>&1; loki_latest_model aider development 2>/dev/null' _ "$MODELS_SH")"
if [ "$ogot" = "my/custom-model" ]; then
    ok "the env override chain still wins over the catalog"
else
    bad "env override ignored: got '$ogot' instead of my/custom-model"
fi

# ---- REGISTRY FALLBACK (v8.2.0) ------------------------------------------
# A fixed table of provider keys makes every unknown provider a fallthrough that
# resolves to NOTHING. Measured before the fix: `loki_latest_model notaprovider
# development` returned empty with rc=1, so "bring your own endpoint" was a dead
# end -- the opposite of model-agnostic. A "generic" key turns the unknown case
# into a first-class one, reusing the shape codex already has (all tiers on one
# model) rather than inventing a mechanism.
for unknown in notaprovider some-new-vendor my.vendor.ai; do
    got="$(resolve "$unknown" development)"
    case "$(printf '%s' "$got" | tr '[:upper:]' '[:lower:]')" in
        "")       bad "unknown provider '$unknown' resolved to NOTHING (registry fallback missing)" ;;
        *claude*) bad "unknown provider '$unknown' resolved to a Claude model ($got)" ;;
        *)        ok  "unknown provider '$unknown' falls back to the registry -> $got" ;;
    esac
done

# A hyphen or dot in the provider name must not break the env-override chain.
# LOKI_SOME-NEW-VENDOR_MODEL_DEVELOPMENT is not a legal shell identifier, so the
# indirect expansion failed and took the WHOLE lookup down -- the provider then
# silently resolved to nothing. Names are normalized to [A-Z0-9_] now.
hy="$(LOKI_SOME_NEW_VENDOR_MODEL_DEVELOPMENT=x/y bash -c '. "$1" >/dev/null 2>&1; loki_latest_model some-new-vendor development 2>/dev/null' _ "$MODELS_SH")"
if [ "$hy" = "x/y" ]; then
    ok "a hyphenated provider name still honors its env override"
else
    bad "hyphenated provider override returned '$hy' -- identifier normalization broken"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
