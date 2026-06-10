#!/usr/bin/env bash
# tests/test-model-override.sh
#
# Covers the Fable model integration + mid-flight model switching runtime
# (internal/FABLE-MODEL-SWITCH-RESEARCH.md):
#   - .loki/state/model-override read semantics: allowlist, invalid-ignored,
#     clear-reverts (the inline case logic from run_autonomous()).
#   - LOKI_FABLE_ARCHITECT default-off proof (get_provider_tier_param planning).
#   - Pricing-table presence: fable rows at $10/$50 (2x Opus) in run.sh's two
#     per-model tables, dashboard _DEFAULT_PRICING, and the loki estimator.
#   - Catalog: claude-fable-5 model + fable alias.
#   - Security-review guard comment present at the reviewer dispatch.
#
# NEVER invokes a real model. The override case logic is exercised by replaying
# the exact branch extracted from run.sh; the routing is exercised by sourcing
# get_provider_tier_param. All fixtures are mktemp dirs, cleaned on exit.

set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
LOKI="$REPO_ROOT/autonomy/loki"
SERVER_PY="$REPO_ROOT/dashboard/server.py"
CATALOG="$REPO_ROOT/providers/model_catalog.json"

WORK="$(mktemp -d 2>/dev/null || mktemp -d -t loki-model-override)"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 0. Syntax sanity
# ---------------------------------------------------------------------------
bash -n "$RUN_SH" && ok "run.sh passes bash -n" || bad "run.sh syntax error"
bash -n "$LOKI"   && ok "loki passes bash -n"   || bad "loki syntax error"
python3 -c "import ast; ast.parse(open('$SERVER_PY').read())" \
  && ok "server.py compiles" || bad "server.py syntax error"
python3 -c "import json; json.load(open('$CATALOG'))" \
  && ok "model_catalog.json is valid JSON" || bad "catalog JSON error"

# ---------------------------------------------------------------------------
# 1. Override read semantics (replay the exact run.sh case branch).
#    The reader lives inline in run_autonomous(); we reproduce its allowlist
#    case here and assert the same outcomes the runtime produces, then verify
#    run.sh actually contains that branch (so this replica stays faithful).
# ---------------------------------------------------------------------------
# Drive via a tmp file using the same tr-strip the runtime uses.
override_outcome() {
    local content="$1" fallback="$2"
    local f="$WORK/model-override"
    printf '%s' "$content" > "$f"
    local raw tier_param="$fallback"
    raw="$(tr -d '[:space:]' < "$f" 2>/dev/null)"
    case "$raw" in
        haiku|sonnet|opus|fable) tier_param="$raw" ;;
        "") : ;;
        *) : ;;
    esac
    echo "$tier_param"
}

[ "$(override_outcome 'fable' 'sonnet')" = "fable" ] \
  && ok "override 'fable' applied" || bad "override fable not applied"
[ "$(override_outcome 'opus' 'sonnet')" = "opus" ] \
  && ok "override 'opus' applied" || bad "override opus not applied"
[ "$(override_outcome 'haiku' 'sonnet')" = "haiku" ] \
  && ok "override 'haiku' applied" || bad "override haiku not applied"
[ "$(override_outcome '  fable  ' 'sonnet')" = "fable" ] \
  && ok "override whitespace-trimmed" || bad "override not trimmed"
[ "$(override_outcome 'gpt-4' 'sonnet')" = "sonnet" ] \
  && ok "invalid override ignored (falls back to tier)" || bad "invalid override not ignored"
[ "$(override_outcome 'rm -rf /' 'sonnet')" = "sonnet" ] \
  && ok "injection-shaped override ignored" || bad "injection override not ignored"
[ "$(override_outcome '' 'sonnet')" = "sonnet" ] \
  && ok "empty override reverts to tier mapping" || bad "empty override not reverted"

# The runtime branch must actually exist in run.sh (keeps the replica honest).
grep -q '\.loki/state/model-override' "$RUN_SH" \
  && ok "run.sh reads .loki/state/model-override" || bad "run.sh override read missing"
grep -q 'haiku|sonnet|opus|fable)' "$RUN_SH" \
  && ok "run.sh enforces the override allowlist" || bad "run.sh allowlist missing"
grep -q 'model override: .*applies this iteration' "$RUN_SH" \
  && ok "run.sh logs the override switch honestly" || bad "run.sh override log missing"
grep -q "Ignoring invalid model override" "$RUN_SH" \
  && ok "run.sh warns once on invalid override" || bad "run.sh invalid-override warn missing"

# ---------------------------------------------------------------------------
# 2. LOKI_FABLE_ARCHITECT default-off proof.
#
# IMPORTANT: the REAL `start` path resolves the claude planning model via
# providers/claude.sh's resolve_model_for_tier (get_provider_tier_param early-
# returns to it when the provider is loaded, run.sh:1801). So the routing is
# tested by sourcing claude.sh and calling resolve_model_for_tier in a
# subshell (the way run.sh actually resolves it), NOT by extracting the bare
# get_provider_tier_param fallback. Each case runs in its own subshell so env
# vars are seen at source time (claude.sh resolves PROVIDER_MODEL_* on source).
# ---------------------------------------------------------------------------
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"
rmt() {
    # $@ : "VAR=val" exports, last arg is the tier
    local tier="${!#}"
    bash -c '
      for kv in "${@:1:$#-1}"; do export "$kv"; done
      source "'"$CLAUDE_SH"'" 2>/dev/null
      resolve_model_for_tier "'"$tier"'"
    ' _ "$@"
}

out_default="$(rmt planning)"
[ "$out_default" = "opus" ] \
  && ok "planning tier defaults to opus (LOKI_FABLE_ARCHITECT off, REAL claude.sh path)" \
  || bad "planning default not opus: '$out_default'"
out_fable="$(rmt LOKI_FABLE_ARCHITECT=1 planning)"
[ "$out_fable" = "fable" ] \
  && ok "LOKI_FABLE_ARCHITECT=1 routes planning to fable (REAL claude.sh path)" \
  || bad "LOKI_FABLE_ARCHITECT=1 did not route to fable: '$out_fable'"
out_override="$(rmt LOKI_FABLE_ARCHITECT=1 LOKI_MODEL_PLANNING=opus planning)"
[ "$out_override" = "opus" ] \
  && ok "explicit LOKI_MODEL_PLANNING wins over fable opt-in" \
  || bad "explicit planning override failed: '$out_override'"
out_max="$(rmt LOKI_FABLE_ARCHITECT=1 LOKI_MAX_TIER=opus planning)"
[ "$out_max" = "opus" ] \
  && ok "LOKI_MAX_TIER=opus caps the fable opt-in back to opus" \
  || bad "maxTier ceiling did not cap fable: '$out_max'"
out_dev="$(rmt LOKI_FABLE_ARCHITECT=1 development)"
[ "$out_dev" = "opus" ] \
  && ok "dev tier stays opus even with fable architect on" \
  || bad "dev tier leaked to fable: '$out_dev'"

# Also confirm the run.sh legacy fallback branch (used when no provider is
# sourced) carries the same opt-in, so the two paths agree.
eval "$(awk '/^get_provider_tier_param\(\)/,/^}/' "$RUN_SH")"
if type get_provider_tier_param >/dev/null 2>&1; then
    PROVIDER_NAME=claude
    out_fb_default="$(unset LOKI_FABLE_ARCHITECT PROVIDER_MODEL_PLANNING; get_provider_tier_param planning)"
    out_fb_fable="$(unset PROVIDER_MODEL_PLANNING; LOKI_FABLE_ARCHITECT=1 get_provider_tier_param planning)"
    [ "$out_fb_default" = "opus" ] && [ "$out_fb_fable" = "fable" ] \
      && ok "run.sh legacy fallback agrees (opus default, fable on opt-in)" \
      || bad "run.sh fallback disagrees: default='$out_fb_default' opt-in='$out_fb_fable'"
else
    bad "get_provider_tier_param fallback could not be sourced"
fi

# ---------------------------------------------------------------------------
# 3. Pricing-table presence: fable rows at $10/$50 (2x Opus).
# ---------------------------------------------------------------------------
# run.sh pricing.json template
grep -q '"fable":.*"input": 10.00,.*"output": 50.00' "$RUN_SH" \
  && ok "run.sh pricing.json template has fable 10/50" || bad "run.sh pricing.json fable row missing"
# run.sh check_budget_limit inline dict
grep -q "'fable': {'input': 10.00, 'output': 50.00}" "$RUN_SH" \
  && ok "run.sh check_budget_limit dict has fable 10/50" || bad "run.sh budget dict fable row missing"
# dashboard _DEFAULT_PRICING
grep -q '"fable":  {"input": 10.00, "output": 50.00}' "$SERVER_PY" \
  && ok "server.py _DEFAULT_PRICING has fable 10/50" || bad "server.py fable pricing missing"
# estimator
grep -q "'Fable':  {'input': 10.00, 'output': 50.00}" "$LOKI" \
  && ok "loki estimator has Fable 10/50" || bad "loki estimator fable pricing missing"
# estimator corrected stale opus to 5/25
grep -q "'Opus':   {'input': 5.00, 'output': 25.00}" "$LOKI" \
  && ok "loki estimator Opus corrected to 5/25 (was stale 15/75)" || bad "loki estimator opus not corrected"

# The cost arithmetic itself: fable must be exactly 2x opus per token.
python3 - "$SERVER_PY" <<'PYEOF'
import sys, ast
src = open(sys.argv[1]).read()
# Extract _DEFAULT_PRICING dict literal.
import re
m = re.search(r'_DEFAULT_PRICING\s*=\s*(\{.*?\n\})', src, re.S)
ns = {}
exec("_DEFAULT_PRICING = " + m.group(1), ns)
p = ns["_DEFAULT_PRICING"]
f, o = p["fable"], p["opus"]
assert f["input"] == 2 * o["input"], f"input not 2x: {f} {o}"
assert f["output"] == 2 * o["output"], f"output not 2x: {f} {o}"
print("PRICING_2X_OK")
PYEOF
[ $? -eq 0 ] && ok "fable priced at exactly 2x opus in server.py" || bad "fable not 2x opus"

# ---------------------------------------------------------------------------
# 4. Catalog: claude-fable-5 model + fable alias.
# ---------------------------------------------------------------------------
python3 - "$CATALOG" <<'PYEOF'
import sys, json
c = json.load(open(sys.argv[1]))
cl = c["providers"]["claude"]
assert cl["cli_aliases"].get("fable") == "claude-fable-5", "fable alias missing"
ids = [m["id"] for m in cl["models"]]
assert "claude-fable-5" in ids, "claude-fable-5 model missing"
print("CATALOG_OK")
PYEOF
[ $? -eq 0 ] && ok "catalog has claude-fable-5 model + fable alias" || bad "catalog fable entry missing"

# ---------------------------------------------------------------------------
# 5. Security-review model guard comment present at reviewer dispatch.
# ---------------------------------------------------------------------------
grep -q "SECURITY-REVIEW MODEL GUARD" "$RUN_SH" \
  && ok "security-review model guard comment present" || bad "security-review guard comment missing"

# ---------------------------------------------------------------------------
# 6. End-to-end estimator quotes fable when forced (no real model invoked).
# ---------------------------------------------------------------------------
EST_DIR="$WORK/est"
mkdir -p "$EST_DIR/.loki/state"
cat > "$EST_DIR/prd.md" <<'EOF'
# PRD
Build a small todo API with one endpoint.
EOF
fable_total="$(cd "$EST_DIR" && LOKI_MODEL=fable "$LOKI" plan ./prd.md --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cost']['by_model'].get('Fable',0))" 2>/dev/null)"
case "$fable_total" in
    0|0.0|"") bad "estimator did not quote fable cost (got '$fable_total')" ;;
    *) ok "LOKI_MODEL=fable estimator quotes fable cost ($fable_total)" ;;
esac
# Override file also forces fable in the estimate.
printf 'fable\n' > "$EST_DIR/.loki/state/model-override"
ov_total="$(cd "$EST_DIR" && "$LOKI" plan ./prd.md --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cost']['by_model'].get('Fable',0))" 2>/dev/null)"
case "$ov_total" in
    0|0.0|"") bad "override file did not force fable in estimate (got '$ov_total')" ;;
    *) ok "override file forces fable in estimate ($ov_total)" ;;
esac

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (of $((PASS+FAIL)))"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
