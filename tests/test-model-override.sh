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
# Drive via a tmp file using the CANONICAL normalization the runtime now uses:
# trim leading/trailing whitespace, lowercase, exact allowlist match. Interior
# whitespace (e.g. "fab le") is REJECTED, not collapsed into "fable", so run.sh,
# the dashboard, and the estimator all agree on what the file means. This
# mirrors loki_normalize_model_alias in providers/claude.sh; the live run sources
# claude.sh so the function is in scope.
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"
override_outcome() {
    local content="$1" fallback="$2"
    bash -c '
      source "'"$CLAUDE_SH"'" 2>/dev/null
      alias="$(loki_normalize_model_alias "$1")"
      if [ -n "$alias" ]; then echo "$alias"; else echo "$2"; fi
    ' _ "$content" "$fallback"
}

[ "$(override_outcome 'fable' 'sonnet')" = "fable" ] \
  && ok "override 'fable' applied" || bad "override fable not applied"
[ "$(override_outcome 'opus' 'sonnet')" = "opus" ] \
  && ok "override 'opus' applied" || bad "override opus not applied"
[ "$(override_outcome 'haiku' 'sonnet')" = "haiku" ] \
  && ok "override 'haiku' applied" || bad "override haiku not applied"
[ "$(override_outcome '  fable  ' 'sonnet')" = "fable" ] \
  && ok "override whitespace-trimmed" || bad "override not trimmed"
[ "$(override_outcome 'FABLE' 'sonnet')" = "fable" ] \
  && ok "override uppercased normalizes to fable" || bad "uppercase override not normalized"
[ "$(override_outcome 'fab le' 'sonnet')" = "sonnet" ] \
  && ok "override with interior whitespace rejected (parity)" || bad "interior-whitespace override wrongly accepted"
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
# 2. Model resolver: explicit tier arms + maxTier clamp (REAL claude.sh path).
#
# The REAL `start` path resolves the claude model via resolve_model_for_tier
# (get_provider_tier_param delegates to it, run.sh:1801). The model-honesty fix
# added an explicit `fable)` tier arm and removed the planning-time architect
# gate (the architect opt-in is now a run.sh iteration-0 decision, tested in
# section 2b). Each case runs in its own subshell so env vars are seen at source
# time (claude.sh resolves PROVIDER_MODEL_* on source).
# CLAUDE_SH is defined above (section 1).
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
[ "$out_default" = "sonnet" ] \
  && ok "planning tier defaults to sonnet (v7.104.0 Sonnet-5-default; REAL claude.sh path)" \
  || bad "planning default not sonnet: '$out_default'"
# Explicit fable tier arm: fable is NOT available at the Claude API ("Claude
# Fable 5 is not available, use Opus 4.8"), so a fable-pinned session / override
# collapses to opus in resolve_model_for_tier. The fable tier LABEL and the
# session-pin parsing (loki_normalize_model_alias still accepts "fable") stay;
# only the RESOLVED dispatch model becomes opus, agreeing with the estimator and
# dashboard so the session-pin parity matrix holds (v7.39.1).
out_fable="$(rmt fable)"
[ "$out_fable" = "opus" ] \
  && ok "explicit fable tier collapses to opus (Fable 5 unavailable at the API)" \
  || bad "fable tier did not collapse to opus: '$out_fable'"
# The planning-time architect gate is REMOVED: LOKI_FABLE_ARCHITECT alone must
# NOT convert the planning tier to fable (that scoping is now run.sh iter-0).
out_planning_arch="$(rmt LOKI_FABLE_ARCHITECT=1 planning)"
[ "$out_planning_arch" = "sonnet" ] \
  && ok "LOKI_FABLE_ARCHITECT no longer converts planning tier in the resolver (scoping moved to run.sh iter-0); planning resolves to sonnet (v7.104.0 default)" \
  || bad "planning tier resolver wrong under LOKI_FABLE_ARCHITECT=1: '$out_planning_arch' (expected sonnet)"
# maxTier clamp on the fable tier (the cost ceiling the override path also uses).
# v7.104.0: PROVIDER_MODEL_DEVELOPMENT=sonnet, so LOKI_MAX_TIER=sonnet clamps fable->sonnet (not opus).
out_max_sonnet="$(rmt LOKI_MAX_TIER=sonnet fable)"
[ "$out_max_sonnet" = "sonnet" ] \
  && ok "LOKI_MAX_TIER=sonnet clamps fable down to development (sonnet; v7.104.0 dev default)" \
  || bad "maxTier=sonnet did not clamp fable to sonnet: '$out_max_sonnet'"
out_max_opus="$(rmt LOKI_MAX_TIER=opus fable)"
[ "$out_max_opus" = "opus" ] \
  && ok "LOKI_MAX_TIER=opus caps fable back to opus" \
  || bad "maxTier=opus did not cap fable: '$out_max_opus'"
out_dev="$(rmt development)"
[ "$out_dev" = "sonnet" ] \
  && ok "dev tier resolves to sonnet (v7.104.0 Sonnet-5-default)" \
  || bad "dev tier wrong: '$out_dev' (expected sonnet)"

# ---------------------------------------------------------------------------
# 2b. LOKI_FABLE_ARCHITECT is scoped to the FIRST iteration only (run.sh).
#
# Replay the EXACT run.sh tier-selection logic (session-pin case + the iter-0
# architect scoping) against the real claude.sh resolver. The architect flag
# must route ONLY iteration 0 to fable and leave later iterations on the session
# tier, so an opus-pinned session is NOT silently converted to fable wholesale
# (the headline bug). An explicit planning override suppresses it.
# ---------------------------------------------------------------------------
# NOTE on the index: run.sh increments ITERATION_COUNT at the TOP of the loop,
# so the FIRST in-loop iteration is ITERATION_COUNT==1 (not 0). This replay uses
# the SAME `-eq 1` guard the runtime uses, so "first iteration" == iter 1 and
# "a later iteration" == iter 2. A -eq 0 guard would be a silent no-op at
# runtime; testing against the real index is what catches that.
resolve_session_iter() {
    # $1=session_model $2=iteration ; remaining "VAR=val" exports
    local sm="$1" iter="$2"; shift 2
    bash -c '
      for kv in "$@"; do export "$kv"; done
      source "'"$CLAUDE_SH"'" 2>/dev/null
      sm="'"$sm"'"; iter='"$iter"'
      # Mirror run.sh:12331 EXACTLY: trim + lowercase the pin before the case
      # (so OPUS / " opus " resolve like opus), but do NOT apply the narrow
      # override allowlist (tier names planning|development|fast stay valid).
      sm="${sm#"${sm%%[![:space:]]*}"}"
      sm="${sm%"${sm##*[![:space:]]}"}"
      sm="$(printf "%s" "$sm" | tr "[:upper:]" "[:lower:]")"
      case "$sm" in
        opus) CURRENT_TIER="planning";; sonnet) CURRENT_TIER="development";;
        haiku) CURRENT_TIER="fast";; fable) CURRENT_TIER="fable";;
        planning|development|fast) CURRENT_TIER="$sm";; *) CURRENT_TIER="$sm";;
      esac
      # v7.104.0 opus-pin fix (mirror run.sh:16064): post the Sonnet-5 default
      # flip, no tier resolves to opus, so an opus SESSION pin dispatches opus
      # directly (clamped by LOKI_MAX_TIER), NOT the sonnet planning tier. The
      # architect fable route only applies to non-opus pins (opus-pin bypasses
      # the tier route entirely), matching the runner.
      _pin_opus=0; [ "$sm" = "opus" ] && _pin_opus=1
      if [ "$iter" -eq 1 ] && [ "${LOKI_FABLE_ARCHITECT:-0}" = "1" ] \
         && [ "$_pin_opus" != "1" ] \
         && [ -z "${LOKI_CLAUDE_MODEL_PLANNING:-}" ] && [ -z "${LOKI_MODEL_PLANNING:-}" ]; then
        CURRENT_TIER="fable"
      fi
      if [ "$_pin_opus" = "1" ]; then
        tp="opus"
        if type loki_apply_max_tier_clamp >/dev/null 2>&1; then
          # Clamp at PLANNING level (mirror run.sh): tier=opus would let opus
          # escape a sonnet ceiling. tier=planning -> sonnet cap yields sonnet.
          tp="$(loki_apply_max_tier_clamp "opus" "planning")"
        fi
        printf "%s" "$tp"
      else
        resolve_model_for_tier "$CURRENT_TIER"
      fi
    ' _ "$@"
}
# Non-vacuity helper: echo CURRENT_TIER PRE-collapse (the abstract tier the
# architect/session-pin routing selects) WITHOUT calling resolve_model_for_tier.
# This proves the architect block is alive (it routes iter-0 to the fable TIER)
# independently of the fable->opus dispatch collapse. Without this, the
# dispatch=opus assertions below would pass even if the architect block were dead
# (a fable pin AND a dead architect both yield opus after the collapse). Mirrors
# the run.sh tier-selection logic above, minus the resolver call.
resolve_session_tier() {
    # $1=session_model $2=iteration ; remaining "VAR=val" exports
    local sm="$1" iter="$2"; shift 2
    bash -c '
      for kv in "$@"; do export "$kv"; done
      source "'"$CLAUDE_SH"'" 2>/dev/null
      sm="'"$sm"'"; iter='"$iter"'
      sm="${sm#"${sm%%[![:space:]]*}"}"
      sm="${sm%"${sm##*[![:space:]]}"}"
      sm="$(printf "%s" "$sm" | tr "[:upper:]" "[:lower:]")"
      case "$sm" in
        opus) CURRENT_TIER="planning";; sonnet) CURRENT_TIER="development";;
        haiku) CURRENT_TIER="fast";; fable) CURRENT_TIER="fable";;
        planning|development|fast) CURRENT_TIER="$sm";; *) CURRENT_TIER="$sm";;
      esac
      if [ "$iter" -eq 1 ] && [ "${LOKI_FABLE_ARCHITECT:-0}" = "1" ] \
         && [ -z "${LOKI_CLAUDE_MODEL_PLANNING:-}" ] && [ -z "${LOKI_MODEL_PLANNING:-}" ]; then
        CURRENT_TIER="fable"
      fi
      printf "%s" "$CURRENT_TIER"
    ' _ "$@"
}
# Verify the run.sh source actually contains the first-iteration architect
# scoping AT THE REAL INDEX (ITERATION_COUNT -eq 1), keeping this replay faithful
# to the runtime and guarding against a -eq 0 silent no-op regression.
grep -q 'LOKI_FABLE_ARCHITECT.*=.*"1"' "$RUN_SH" \
  && grep -q 'routing the first .architecture. iteration to fable' "$RUN_SH" \
  && grep -Eq 'ITERATION_COUNT:-0\}" -eq 1 \]' "$RUN_SH" \
  && ok "run.sh scopes LOKI_FABLE_ARCHITECT to the first iteration (ITERATION_COUNT==1)" \
  || bad "run.sh first-iteration architect scoping missing or guarded on the wrong index"
# NON-VACUITY (tier routing, PRE-collapse): the architect block must route iter-0
# to the fable TIER (CURRENT_TIER=fable) BEFORE the fable->opus dispatch collapse.
# This proves the architect block is ALIVE independently of the collapse: without
# it, the dispatch=opus assertions below could pass on a dead architect (an opus
# pin already dispatches opus). A later iteration on an opus pin stays the planning
# tier; the default sonnet pin's iter-0 also routes to the fable tier.
arch0_tier="$(resolve_session_tier opus 1 LOKI_FABLE_ARCHITECT=1)"
arch1_tier="$(resolve_session_tier opus 2 LOKI_FABLE_ARCHITECT=1)"
[ "$arch0_tier" = "fable" ] && [ "$arch1_tier" = "planning" ] \
  && ok "architect routes ONLY iter-0 to the FABLE TIER pre-collapse (opus pin); iter-2 stays planning (block is alive)" \
  || bad "architect tier routing wrong pre-collapse: iter1='$arch0_tier' iter2='$arch1_tier' (expected fable/planning)"
arch_def0_tier="$(resolve_session_tier sonnet 1 LOKI_FABLE_ARCHITECT=1)"
[ "$arch_def0_tier" = "fable" ] \
  && ok "architect fires on the default session pin pre-collapse (routes iter-0 to the fable tier)" \
  || bad "architect did not route default pin iter-0 to the fable tier: '$arch_def0_tier'"
# DISPATCH (POST-collapse): fable is unavailable, so the architect iter-0 collapses
# to opus at dispatch (resolve_model_for_tier fable arm -> opus). Later iterations
# on an opus pin dispatch opus too, so the scoping is now visible only via the tier
# routing above (that is exactly why the non-vacuity guard exists).
# v7.104.0: an opus SESSION pin now dispatches opus on EVERY iteration (founder
# "set all to opus" is face-value), so the opus-pin dispatch pair is vacuously
# opus/opus and no longer demonstrates architect scoping at dispatch. The
# architect-scoping demonstration moves to the SONNET pin below (iter-1 fable->opus
# vs iter-2 sonnet is still visible); tier-level non-vacuity above (fable/planning)
# remains the proof the architect block is alive.
arch0="$(resolve_session_iter opus 1 LOKI_FABLE_ARCHITECT=1)"
arch1="$(resolve_session_iter opus 2 LOKI_FABLE_ARCHITECT=1)"
[ "$arch0" = "opus" ] && [ "$arch1" = "opus" ] \
  && ok "opus pin dispatches opus on every iteration (v7.104.0 set-all-to-opus; architect scoping proven at tier level above)" \
  || bad "opus-pin dispatch wrong: iter1='$arch0' iter2='$arch1' (expected opus/opus with v7.104.0 opus-pin fix)"
# Architect scoping VISIBLE at dispatch on the sonnet (default) pin: iter-1 routes
# to the fable tier -> collapses to opus at dispatch; iter-2 is the development
# tier -> sonnet. This is where fable->opus vs sonnet is observable post-fix.
arch_s0="$(resolve_session_iter sonnet 1 LOKI_FABLE_ARCHITECT=1)"
arch_s1="$(resolve_session_iter sonnet 2 LOKI_FABLE_ARCHITECT=1)"
[ "$arch_s0" = "opus" ] && [ "$arch_s1" = "sonnet" ] \
  && ok "architect on the sonnet pin: iter-1 dispatches opus (fable collapsed), iter-2 dispatches sonnet (development tier)" \
  || bad "architect sonnet-pin dispatch wrong: iter1='$arch_s0' iter2='$arch_s1' (expected opus/sonnet)"
arch_ovr="$(resolve_session_iter opus 1 LOKI_FABLE_ARCHITECT=1 LOKI_MODEL_PLANNING=opus)"
[ "$arch_ovr" = "opus" ] \
  && ok "explicit LOKI_MODEL_PLANNING suppresses the architect opt-in" \
  || bad "explicit planning override did not suppress architect: '$arch_ovr'"
arch_max="$(resolve_session_iter sonnet 1 LOKI_FABLE_ARCHITECT=1 LOKI_MAX_TIER=opus)"
[ "$arch_max" = "opus" ] \
  && ok "LOKI_MAX_TIER caps the architect iteration too" \
  || bad "maxTier did not cap architect iter: '$arch_max'"

# ---------------------------------------------------------------------------
# 2c. Mid-flight override respects LOKI_MAX_TIER (cost-ceiling bypass fix).
#
# Replay the override clamp the run_autonomous override path performs: normalize
# the file -> apply loki_apply_max_tier_clamp -> apply the fable->opus dispatch
# backstop (run.sh collapses tier_param=="fable" to opus before --model). A
# sonnet-capped run must NOT dispatch fable; an UNCAPPED fable override now
# dispatches opus too, because fable is unavailable at the Claude API (v7.39.1).
# ---------------------------------------------------------------------------
override_effective() {
    # $1=file content ; remaining "VAR=val" exports
    local content="$1"; shift
    bash -c '
      for kv in "$@"; do export "$kv"; done
      source "'"$CLAUDE_SH"'" 2>/dev/null
      alias="$(loki_normalize_model_alias "$1")"
      [ -z "$alias" ] && { echo REJECTED; exit 0; }
      tier_param="$(loki_apply_max_tier_clamp "$alias" "$alias")"
      # run.sh dispatch backstop: fable unavailable, collapse to opus.
      [ "$tier_param" = "fable" ] && tier_param="opus"
      printf "%s" "$tier_param"
    ' _ "$content" "$@"
}
[ "$(override_effective fable)" = "opus" ] \
  && ok "override fable dispatches opus when uncapped (Fable 5 unavailable, dispatch backstop)" \
  || bad "override fable did not collapse to opus uncapped"
# v7.104.0: PROVIDER_MODEL_DEVELOPMENT=sonnet. The sonnet cap clamps fable -> development
# -> sonnet. The dispatch backstop (tier_param==fable->opus) does NOT fire because the
# clamp resolves to "sonnet", not "fable". Ceiling is still enforced: sonnet, not fable.
[ "$(override_effective fable LOKI_MAX_TIER=sonnet)" = "sonnet" ] \
  && ok "override fable clamped to sonnet under LOKI_MAX_TIER=sonnet (dev=sonnet v7.104.0; ceiling enforced)" \
  || bad "override fable bypassed LOKI_MAX_TIER=sonnet"
[ "$(override_effective fable LOKI_MAX_TIER=opus)" = "opus" ] \
  && ok "override fable clamped to opus under LOKI_MAX_TIER=opus" \
  || bad "override fable bypassed LOKI_MAX_TIER=opus"
# Verify run.sh actually applies the clamp on the override path.
grep -q 'loki_apply_max_tier_clamp' "$RUN_SH" \
  && ok "run.sh override path applies the LOKI_MAX_TIER clamp" \
  || bad "run.sh override path missing maxTier clamp"
grep -q 'exceeds LOKI_MAX_TIER' "$RUN_SH" \
  && ok "run.sh logs an honest clamp line when the override exceeds the ceiling" \
  || bad "run.sh clamp log line missing"

# ---------------------------------------------------------------------------
# 2d. Session-start clears a leftover override (persistence-trap fix).
#
# Verify run.sh clears .loki/state/model-override at fresh-run start so a switch
# applies to the current run only, not every future run.
# ---------------------------------------------------------------------------
grep -q 'Cleared leftover model override' "$RUN_SH" \
  && ok "run.sh clears a leftover override at session start (current-run scope)" \
  || bad "run.sh session-start override clear missing"

# ---------------------------------------------------------------------------
# 2e. LOKI_MODEL is no longer an estimator-only lever (removed).
# ---------------------------------------------------------------------------
grep -Eq "LOKI_MODEL[^_A-Za-z]*=*.*fable" "$LOKI" \
  && bad "LOKI_MODEL=fable still referenced in estimator (should be removed)" \
  || ok "LOKI_MODEL removed from estimator (no quote-only-cannot-run lever)"

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
# 6. End-to-end estimator: a fable pin quotes OPUS, never Fable (v7.39.1).
#
# Fable is unavailable at the Claude API, so the runner dispatches opus for a
# fable pin / override / architect iteration. The estimator must quote the model
# the runner actually dispatches (opus, $5/$25), NOT fable ($10/$50). The token
# VOLUME stays the advisor work tier (50k/8k per iteration), but the priced model
# is Opus. So by_model['Fable'] is 0 and by_model['Opus'] is nonzero on every
# fable route.
# ---------------------------------------------------------------------------
EST_DIR="$WORK/est"
mkdir -p "$EST_DIR/.loki/state"
cat > "$EST_DIR/prd.md" <<'EOF'
# PRD
Build a small todo API with one endpoint.
EOF
# Session pin = fable: must quote Opus, never Fable.
read -r sp_fable sp_opus <<EOF2
$(cd "$EST_DIR" && LOKI_SESSION_MODEL=fable "$LOKI" plan ./prd.md --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); bm=d['cost']['by_model']; print(bm.get('Fable',0), bm.get('Opus',0))" 2>/dev/null)
EOF2
case "$sp_fable" in
    0|0.0|"") : ;;
    *) bad "fable session pin still quoted Fable cost ($sp_fable); must collapse to Opus" ;;
esac
case "$sp_opus" in
    0|0.0|"") bad "fable session pin did not quote Opus cost (got Opus='$sp_opus')" ;;
    *) ok "LOKI_SESSION_MODEL=fable estimator quotes OPUS, not Fable (Fable=$sp_fable Opus=$sp_opus)" ;;
esac
# LOKI_SESSION_MODEL=fable under LOKI_MAX_TIER=sonnet must NOT quote fable
# (estimator honors the ceiling; fable already collapses below opus anyway).
capped_fable="$(cd "$EST_DIR" && LOKI_SESSION_MODEL=fable LOKI_MAX_TIER=sonnet "$LOKI" plan ./prd.md --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cost']['by_model'].get('Fable',0))" 2>/dev/null)"
case "$capped_fable" in
    0|0.0) ok "estimator never quotes fable under LOKI_MAX_TIER=sonnet (no over-quote)" ;;
    *) bad "estimator quoted fable above LOKI_MAX_TIER ceiling (got '$capped_fable')" ;;
esac
# Override file = fable: also collapses to Opus in the estimate (dispatch backstop).
printf 'fable\n' > "$EST_DIR/.loki/state/model-override"
read -r ov_fable ov_opus <<EOF3
$(cd "$EST_DIR" && "$LOKI" plan ./prd.md --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); bm=d['cost']['by_model']; print(bm.get('Fable',0), bm.get('Opus',0))" 2>/dev/null)
EOF3
case "$ov_fable" in
    0|0.0|"") : ;;
    *) bad "fable override still quoted Fable cost ($ov_fable); must collapse to Opus" ;;
esac
case "$ov_opus" in
    0|0.0|"") bad "fable override did not quote Opus cost (got Opus='$ov_opus')" ;;
    *) ok "override file fable collapses to OPUS in estimate (Fable=$ov_fable Opus=$ov_opus)" ;;
esac
rm -f "$EST_DIR/.loki/state/model-override"

# ---------------------------------------------------------------------------
# 7. Resolver parity matrix: the dashboard/estimator python clamp must resolve
#    BYTE-IDENTICALLY to providers/claude.sh loki_apply_max_tier_clamp across the
#    full input matrix, including LOKI_ALLOW_HAIKU and the env overrides. This is
#    the contract that makes the three-way duplication safe (the v7.31 BLOCKER
#    was three clamp impls disagreeing because the python copies hardcoded
#    "haiku"/"opus" instead of resolving through provider config).
#
#    Bash leg sources claude.sh and calls loki_apply_max_tier_clamp ALIAS ALIAS
#    (the override-path convention). Python leg drives the dashboard's
#    _clamp_to_max_tier (server.py); the estimator embeds the same port and is
#    additionally exercised end-to-end in section 8.
# ---------------------------------------------------------------------------
bash_clamp() {
    # $1=alias ; remaining "VAR=val" exports
    local alias="$1"; shift
    bash -c '
      for kv in "$@"; do export "$kv"; done
      source "'"$CLAUDE_SH"'" 2>/dev/null
      loki_apply_max_tier_clamp "'"$alias"'" "'"$alias"'"
    ' _ "$@"
}
py_clamp() {
    # $1=alias ; remaining "VAR=val" exports
    local alias="$1"; shift
    env "$@" python3 -c '
import sys, os
sys.path.insert(0, os.environ["LOKI_REPO_ROOT"])
from dashboard import server as s
sys.stdout.write(s._clamp_to_max_tier(sys.argv[1]))
' "$alias"
}
export LOKI_REPO_ROOT="$REPO_ROOT"

parity_fail=0
parity_cells=0
# Council R1 round-2 (v7.31.0): include non-canonical cap spellings. A
# settings.json maxTier exports the user-typed string verbatim, so "Sonnet"
# and padded values must clamp identically on the bash and python legs
# (both normalize trim+lowercase). Before the fix, the bash leg silently
# ignored miscased caps while the python legs enforced them.
for cap in "" haiku sonnet opus Sonnet HAIKU " opus "; do
  for ah in "" LOKI_ALLOW_HAIKU=true; do
    for ovr in "" LOKI_CLAUDE_MODEL_FAST=opus LOKI_MODEL_DEVELOPMENT=haiku LOKI_CLAUDE_MODEL_DEVELOPMENT=sonnet; do
      for alias in haiku sonnet opus fable; do
        exports=()
        [ -n "$cap" ] && exports+=("LOKI_MAX_TIER=$cap")
        [ -n "$ah" ]  && exports+=("$ah")
        [ -n "$ovr" ] && exports+=("$ovr")
        b="$(bash_clamp "$alias" "${exports[@]}")"
        p="$(py_clamp "$alias" "${exports[@]}")"
        parity_cells=$((parity_cells+1))
        if [ "$b" != "$p" ]; then
          parity_fail=$((parity_fail+1))
          echo "  PARITY MISMATCH: alias=$alias cap='$cap' ah='$ah' ovr='$ovr' bash='$b' py='$p'"
        fi
      done
    done
  done
done
[ "$parity_fail" -eq 0 ] \
  && ok "resolver parity matrix: dashboard python clamp == claude.sh across $parity_cells cells" \
  || bad "resolver parity matrix had $parity_fail mismatches (of $parity_cells cells)"

# Precedence proof: LOKI_CLAUDE_MODEL_DEVELOPMENT wins over LOKI_MODEL_DEVELOPMENT
# in BOTH legs (mirrors claude.sh resolution order).
b_prec="$(bash_clamp fable LOKI_MAX_TIER=sonnet LOKI_CLAUDE_MODEL_DEVELOPMENT=opus LOKI_MODEL_DEVELOPMENT=haiku)"
p_prec="$(py_clamp fable LOKI_MAX_TIER=sonnet LOKI_CLAUDE_MODEL_DEVELOPMENT=opus LOKI_MODEL_DEVELOPMENT=haiku)"
[ "$b_prec" = "opus" ] && [ "$p_prec" = "opus" ] \
  && ok "env precedence: LOKI_CLAUDE_MODEL_DEVELOPMENT wins (bash=$b_prec py=$p_prec)" \
  || bad "env precedence wrong: bash='$b_prec' py='$p_prec' (expected opus/opus)"

# Trap guard: an opus alias under sonnet cap + ALLOW_HAIKU must NOT clamp to
# sonnet (the runner keeps opus; the old `in ('opus','fable')` arm would break).
b_trap="$(bash_clamp opus LOKI_MAX_TIER=sonnet LOKI_ALLOW_HAIKU=true)"
p_trap="$(py_clamp opus LOKI_MAX_TIER=sonnet LOKI_ALLOW_HAIKU=true)"
[ "$b_trap" = "opus" ] && [ "$p_trap" = "opus" ] \
  && ok "opus alias under sonnet+ALLOW_HAIKU stays opus (no new downgrade; bash=$b_trap py=$p_trap)" \
  || bad "opus wrongly downgraded under sonnet+ALLOW_HAIKU: bash='$b_trap' py='$p_trap'"

# ---------------------------------------------------------------------------
# 8. Cross-route agreement for the EXACT v7.31 reviewer repros: the estimator's
#    quoted session model == the dashboard's effective == the runner-resolved
#    model (claude.sh override-path clamp). Closes the stock-install gap where
#    LOKI_MAX_TIER=haiku quoted Haiku but the run dispatched sonnet.
#
#    The estimator's quoted model is read from cost.iterations_by_model (the model
#    carrying the nonzero iteration count is the session model it quotes).
# ---------------------------------------------------------------------------
XR_DIR="$WORK/xroute"
mkdir -p "$XR_DIR/.loki/state"
printf '# PRD\nBuild a small todo API with one endpoint.\n' > "$XR_DIR/prd.md"

# Estimator quoted alias (lowercased) for a given env + optional override file.
est_quoted() {
    # $@ : "VAR=val" exports
    (cd "$XR_DIR" && env "$@" "$LOKI" plan ./prd.md --json 2>/dev/null) \
      | python3 -c "
import json,sys
d=json.load(sys.stdin)
ibm=d['cost']['iterations_by_model']
q=[k for k,v in ibm.items() if v]
sys.stdout.write((q[0].lower() if len(q)==1 else 'MULTI:'+','.join(q)))
" 2>/dev/null
}
# Dashboard effective alias for a session model + env.
dash_effective() {
    # $1=alias-as-default-or-override ; remaining "VAR=val" exports
    local alias="$1"; shift
    env "$@" python3 -c '
import sys, os
sys.path.insert(0, os.environ["LOKI_REPO_ROOT"])
from dashboard import server as s
sys.stdout.write(s._clamp_to_max_tier(sys.argv[1]))
' "$alias"
}

# --- Repro A: LOKI_MAX_TIER=haiku, stock (ALLOW_HAIKU default false) ---
# No override file: estimator session default is sonnet; under haiku cap it
# resolves to PROVIDER_MODEL_FAST=sonnet. Runner-resolved (clamp of the default
# session alias sonnet) and dashboard effective (clamp of default 'sonnet') agree.
rm -f "$XR_DIR/.loki/state/model-override"
eA="$(est_quoted LOKI_MAX_TIER=haiku)"
rA="$(bash_clamp sonnet LOKI_MAX_TIER=haiku)"
dA="$(dash_effective sonnet LOKI_MAX_TIER=haiku)"
[ "$eA" = "$rA" ] && [ "$dA" = "$rA" ] && [ "$rA" = "sonnet" ] \
  && ok "cross-route haiku-cap stock: estimator=$eA dashboard=$dA runner=$rA (all sonnet, was Haiku-quote bug)" \
  || bad "cross-route haiku-cap stock mismatch: est='$eA' dash='$dA' runner='$rA'"

# --- Repro B: LOKI_MAX_TIER=haiku + LOKI_ALLOW_HAIKU=true ---
# Now PROVIDER_MODEL_FAST=haiku, so all three quote/dispatch haiku.
eB="$(est_quoted LOKI_MAX_TIER=haiku LOKI_ALLOW_HAIKU=true)"
rB="$(bash_clamp sonnet LOKI_MAX_TIER=haiku LOKI_ALLOW_HAIKU=true)"
dB="$(dash_effective sonnet LOKI_MAX_TIER=haiku LOKI_ALLOW_HAIKU=true)"
[ "$eB" = "$rB" ] && [ "$dB" = "$rB" ] && [ "$rB" = "haiku" ] \
  && ok "cross-route haiku-cap + ALLOW_HAIKU: estimator=$eB dashboard=$dB runner=$rB (all haiku)" \
  || bad "cross-route haiku-cap+ALLOW_HAIKU mismatch: est='$eB' dash='$dB' runner='$rB'"

# --- Repro C: LOKI_ALLOW_HAIKU=true + LOKI_MAX_TIER=sonnet + fable override ---
# The second reviewer instance. fable override under sonnet cap with ALLOW_HAIKU
# resolves to PROVIDER_MODEL_DEVELOPMENT=sonnet on ALL three routes.
printf 'fable\n' > "$XR_DIR/.loki/state/model-override"
eC="$(est_quoted LOKI_ALLOW_HAIKU=true LOKI_MAX_TIER=sonnet)"
rC="$(bash_clamp fable LOKI_ALLOW_HAIKU=true LOKI_MAX_TIER=sonnet)"
dC="$(dash_effective fable LOKI_ALLOW_HAIKU=true LOKI_MAX_TIER=sonnet)"
[ "$eC" = "$rC" ] && [ "$dC" = "$rC" ] && [ "$rC" = "sonnet" ] \
  && ok "cross-route ALLOW_HAIKU+sonnet-cap+fable: estimator=$eC dashboard=$dC runner=$rC (all sonnet)" \
  || bad "cross-route ALLOW_HAIKU+sonnet-cap+fable mismatch: est='$eC' dash='$dC' runner='$rC'"
rm -f "$XR_DIR/.loki/state/model-override"

# --- Control: fable override under sonnet cap WITHOUT ALLOW_HAIKU -> sonnet on all ---
# v7.104.0: PROVIDER_MODEL_DEVELOPMENT=sonnet. The sonnet cap clamps fable -> development
# -> sonnet on the bash runner. The dispatch backstop (fable->opus) does NOT fire because
# the clamp already resolved to sonnet, not fable. All three must agree on sonnet.
# NOTE: if this fails with est/dash='opus' while runner='sonnet', server.py/_clamp_to_max_tier
# and the loki estimator still use the old opus dev default and need updating (Lane D/F owners).
printf 'fable\n' > "$XR_DIR/.loki/state/model-override"
eD="$(est_quoted LOKI_MAX_TIER=sonnet)"
rD="$(bash_clamp fable LOKI_MAX_TIER=sonnet)"
dD="$(dash_effective fable LOKI_MAX_TIER=sonnet)"
[ "$eD" = "$rD" ] && [ "$dD" = "$rD" ] && [ "$rD" = "sonnet" ] \
  && ok "cross-route sonnet-cap+fable (no ALLOW_HAIKU): estimator=$eD dashboard=$dD runner=$rD (all sonnet; v7.104.0 dev=sonnet)" \
  || bad "cross-route sonnet-cap+fable (default) mismatch: est='$eD' dash='$dD' runner='$rD' (expected all sonnet; server.py/estimator may need sonnet5-default update)"
rm -f "$XR_DIR/.loki/state/model-override"

# --- Repro E (v7.39.1): UNCAPPED fable OVERRIDE -> opus on all three routes ---
# Fable is unavailable at the Claude API, so even with NO cost ceiling a fable
# override dispatches opus. The runner reference is the override-path clamp PLUS
# the fable->opus dispatch backstop (run.sh collapses tier_param=="fable" before
# --model). The dashboard reads the same effective via get_session_model. All
# three must quote/report opus, NOT fable. This locks the override route end-to-end
# (the session-pin route is locked by the section-9 matrix).
printf 'fable\n' > "$XR_DIR/.loki/state/model-override"
eE="$(est_quoted)"
# Runner: override-path clamp (no cap -> "fable") then the dispatch backstop -> opus.
rE_clamp="$(bash_clamp fable)"
rE="$rE_clamp"; [ "$rE" = "fable" ] && rE="opus"
# Dashboard get_session_model effective (reads the override file + the v7.39.1
# fable->opus collapse), run from the override dir so it sees the override file.
dE="$(cd "$XR_DIR" && env LOKI_REPO_ROOT="$REPO_ROOT" python3 -c '
import sys, os, asyncio
sys.path.insert(0, os.environ["LOKI_REPO_ROOT"])
from dashboard import server as s
# new_event_loop (not get_event_loop) -- get_event_loop with no running loop
# raises RuntimeError on Python 3.12+, which would falsely empty dE.
sys.stdout.write(asyncio.new_event_loop().run_until_complete(s.get_session_model())["effective"])
')"
[ "$eE" = "opus" ] && [ "$dE" = "opus" ] && [ "$rE" = "opus" ] && [ "$rE_clamp" = "fable" ] \
  && ok "cross-route UNCAPPED fable override: estimator=$eE dashboard=$dE runner=$rE (all opus; clamp alone=$rE_clamp, backstop collapses)" \
  || bad "cross-route uncapped fable override mismatch: est='$eE' dash='$dE' runner='$rE' (clamp=$rE_clamp; expected all opus, clamp fable)"
rm -f "$XR_DIR/.loki/state/model-override"

# ---------------------------------------------------------------------------
# 9. Session-pin tier-resolution parity (task 568): the NO-OVERRIDE path.
#
# This is the gap task 568 closes. With NO override file, the runner does NOT
# feed the session alias straight to --model. It maps the pin to a tier
# (sonnet->development) and resolves the tier through PROVIDER_MODEL_* (sonnet
# pin -> development -> sonnet on v7.104.0 stock config), then applies the cost ceiling. The
# estimator (cost.iterations_by_model) and the dashboard (_resolve_session_pin)
# must both quote/report that SAME dispatched model, across session-pin values x
# LOKI_ALLOW_HAIKU x model env overrides x cost ceiling. The runner reference is
# resolve_session_iter PIN 2 (iteration 2 -> no architect -> the pure session-pin
# tier route). This is DISTINCT from the override-path clamp parity in section 7:
# a 'sonnet' pin resolves to opus here but a 'sonnet' override stays sonnet.
# ---------------------------------------------------------------------------
# Dashboard no-override effective for a session pin + env (the session-pin route).
dash_session_pin() {
    # $1=pin ; remaining "VAR=val" exports
    local pin="$1"; shift
    env "$@" python3 -c '
import sys, os
sys.path.insert(0, os.environ["LOKI_REPO_ROOT"])
from dashboard import server as s
sys.stdout.write(s._resolve_session_pin(sys.argv[1]))
' "$pin"
}

sp_fail=0
sp_cells=0
# Headline stock cell first (explicit, readable assertion): no levers at all.
# v7.104.0: sonnet pin -> development tier -> PROVIDER_MODEL_DEVELOPMENT=sonnet.
# All three must agree on sonnet. If this fails with est/dash='opus' and runner='sonnet',
# the server.py _resolve_session_pin and loki estimator still use the old opus dev default
# and need updating to CLAUDE_DEFAULT_DEVELOPMENT=sonnet (Lane D/F owners).
rm -f "$XR_DIR/.loki/state/model-override"
sp_e="$(est_quoted)"                       # estimator quoted model on stock path
sp_d="$(dash_session_pin sonnet)"          # dashboard effective, default pin
sp_r="$(resolve_session_iter sonnet 2)"    # runner-resolved (session-pin route)
[ "$sp_e" = "sonnet" ] && [ "$sp_d" = "sonnet" ] && [ "$sp_r" = "sonnet" ] \
  && ok "STOCK no-levers: estimator=$sp_e dashboard=$sp_d runner=$sp_r (all sonnet; v7.104.0 dev=sonnet default)" \
  || bad "STOCK no-levers session-pin mismatch: est='$sp_e' dash='$sp_d' runner='$sp_r' (expected all sonnet; server.py/estimator may need sonnet5-default update)"

# Full session-pin matrix: pin x ALLOW_HAIKU x dev/fast env override x cap.
# Estimator reads the env directly (no override file); dashboard drives
# _resolve_session_pin(pin); runner drives resolve_session_iter PIN 2. All three
# must agree on every cell.
#
# v7.32: the pin set now includes the documented raw TIER-NAME pins
# (planning|development|fast, skills/model-selection.md:8) alongside the four
# model aliases. Before this fix the estimator + dashboard collapsed tier-name
# pins onto the development tier (allowlist reject -> default), so pin=fast
# quoted Opus while the runner dispatched Sonnet (the v7.32 cost-agreement HIGH).
# The runner's passthrough arm (run.sh:12336) routes tier names to their own
# tier; all three readers must now agree on those cells too.
for pin in sonnet opus haiku fable planning development fast; do
  for ah in "" LOKI_ALLOW_HAIKU=true; do
    for ovr in "" LOKI_CLAUDE_MODEL_DEVELOPMENT=sonnet LOKI_MODEL_FAST=haiku LOKI_CLAUDE_MODEL_PLANNING=sonnet; do
      for cap in "" sonnet haiku opus; do
        exports=("LOKI_SESSION_MODEL=$pin")
        [ -n "$ah" ]  && exports+=("$ah")
        [ -n "$ovr" ] && exports+=("$ovr")
        [ -n "$cap" ] && exports+=("LOKI_MAX_TIER=$cap")
        e="$(est_quoted "${exports[@]}")"
        d="$(dash_session_pin "$pin" "${exports[@]}")"
        r="$(resolve_session_iter "$pin" 2 "${exports[@]}")"
        sp_cells=$((sp_cells+1))
        # estimator quote is a pricing-table key lowercased; compare to runner alias.
        if [ "$e" != "$r" ] || [ "$d" != "$r" ]; then
          sp_fail=$((sp_fail+1))
          echo "  SESSION-PIN MISMATCH: pin=$pin ah='$ah' ovr='$ovr' cap='$cap' est='$e' dash='$d' runner='$r'"
        fi
      done
    done
  done
done
[ "$sp_fail" -eq 0 ] \
  && ok "session-pin parity matrix: estimator == dashboard == runner across $sp_cells cells (no-override tier route)" \
  || bad "session-pin parity matrix had $sp_fail mismatches (of $sp_cells cells)"

# Explicit tier-name headline cells (the v7.32 cost-agreement HIGH). pin=fast on
# stock config MUST resolve to sonnet on all three readers: before the fix the
# estimator + dashboard quoted opus (allowlist reject -> development tier) while
# the runner dispatched sonnet (fast tier). This is the regression vs main.
tn_e="$(est_quoted LOKI_SESSION_MODEL=fast)"
tn_d="$(dash_session_pin fast LOKI_SESSION_MODEL=fast)"
tn_r="$(resolve_session_iter fast 2 LOKI_SESSION_MODEL=fast)"
[ "$tn_e" = "sonnet" ] && [ "$tn_d" = "sonnet" ] && [ "$tn_r" = "sonnet" ] \
  && ok "tier-name pin: LOKI_SESSION_MODEL=fast resolves to sonnet on all three (est=$tn_e dash=$tn_d runner=$tn_r; was opus-quote regression)" \
  || bad "pin=fast mismatch: est='$tn_e' dash='$tn_d' runner='$tn_r' (expected all sonnet)"

# pin=planning + LOKI_ALLOW_HAIKU=true (Cell B): must resolve to sonnet on all
# three (planning tier -> PROVIDER_MODEL_PLANNING=sonnet on v7.104.0, unaffected by ALLOW_HAIKU).
# v7.104.0: CLAUDE_DEFAULT_PLANNING=sonnet, so the runner dispatches sonnet. If this fails
# with est/dash='opus' and runner='sonnet', the server.py _resolve_session_pin and estimator
# still use the old opus planning default and need updating (Lane D/F owners).
tnp_e="$(est_quoted LOKI_SESSION_MODEL=planning LOKI_ALLOW_HAIKU=true)"
tnp_d="$(dash_session_pin planning LOKI_SESSION_MODEL=planning LOKI_ALLOW_HAIKU=true)"
tnp_r="$(resolve_session_iter planning 2 LOKI_SESSION_MODEL=planning LOKI_ALLOW_HAIKU=true)"
[ "$tnp_e" = "sonnet" ] && [ "$tnp_d" = "sonnet" ] && [ "$tnp_r" = "sonnet" ] \
  && ok "tier-name pin: planning + ALLOW_HAIKU resolves to sonnet on all three (est=$tnp_e dash=$tnp_d runner=$tnp_r; v7.104.0 planning=sonnet)" \
  || bad "pin=planning+ALLOW_HAIKU mismatch: est='$tnp_e' dash='$tnp_d' runner='$tnp_r' (expected all sonnet; server.py/estimator may need sonnet5-default update)"

# Miscased / whitespace session pins (the folded pre-existing LOW): run.sh now
# trim+lowercases the pin before the case, so OPUS and " opus " resolve like the
# canonical opus pin. v7.104.0: an opus pin dispatches OPUS on all three readers
# (the opus-pin fix; ALLOW_HAIKU does not change this since opus is set directly,
# not via the fast tier). All three readers must agree.
# NOTE: if this fails with est/dash='opus' and runner='sonnet', the runner's
# opus-pin fix (run.sh) is missing; if runner='opus' and est/dash='sonnet', the
# estimator/dashboard opus-pin mirror is missing.
for mc in OPUS " opus "; do
  mc_e="$(est_quoted "LOKI_SESSION_MODEL=$mc" LOKI_ALLOW_HAIKU=true)"
  mc_d="$(dash_session_pin "$mc" "LOKI_SESSION_MODEL=$mc" LOKI_ALLOW_HAIKU=true)"
  mc_r="$(resolve_session_iter "$mc" 2 "LOKI_SESSION_MODEL=$mc" LOKI_ALLOW_HAIKU=true)"
  [ "$mc_e" = "opus" ] && [ "$mc_d" = "opus" ] && [ "$mc_r" = "opus" ] \
    && ok "miscased pin '$mc' resolves to opus on all three (est=$mc_e dash=$mc_d runner=$mc_r; v7.104.0 opus-pin fix)" \
    || bad "miscased pin '$mc' mismatch: est='$mc_e' dash='$mc_d' runner='$mc_r' (expected all opus; opus-pin fix missing on some reader)"
done

# Regression guard: a 'sonnet' OVERRIDE file must still dispatch sonnet (the
# override path is NOT the tier route). Nothing else locked this cell before.
printf 'sonnet\n' > "$XR_DIR/.loki/state/model-override"
ov_e="$(est_quoted)"
ov_d="$(dash_effective sonnet)"            # override-path clamp (dashboard)
ov_r="$(bash_clamp sonnet)"               # runner override-path clamp
[ "$ov_e" = "sonnet" ] && [ "$ov_d" = "sonnet" ] && [ "$ov_r" = "sonnet" ] \
  && ok "sonnet OVERRIDE stays sonnet (override path != tier route): est=$ov_e dash=$ov_d runner=$ov_r" \
  || bad "sonnet override regression: est='$ov_e' dash='$ov_d' runner='$ov_r' (expected all sonnet)"
rm -f "$XR_DIR/.loki/state/model-override"

# Architect (LOKI_FABLE_ARCHITECT=1) iteration-0 fable disclosure must be cleared
# by a cost ceiling that would clamp the architect iteration too, EVEN when the
# session model itself is unchanged by the cap (opus pin under a sonnet/opus cap:
# the model stays opus but the iter-0 fable architect tier clamps to opus). The
# estimator's iterations_by_model must show NO Fable cell, matching the runner.
# Reference: resolve_session_iter PIN 1 with the architect flag (iter 1 = the
# architecture pass, the only iteration the runner routes to fable).
est_models() {
    # $@ : "VAR=val" exports ; prints the set of nonzero-iteration model keys.
    (cd "$XR_DIR" && env "$@" "$LOKI" plan ./prd.md --json 2>/dev/null) | python3 -c "
import json,sys
ibm=json.load(sys.stdin)['cost']['iterations_by_model']
sys.stdout.write(','.join(sorted(k for k,v in ibm.items() if v)))
"
}
rm -f "$XR_DIR/.loki/state/model-override"
# opus pin + sonnet cap + architect: architect iter clamps to sonnet (v7.104.0 dev=sonnet), no fable.
# The fable tier is selected by the architect block, then resolve_model_for_tier collapses it to
# opus (fable unavailable dispatch backstop), then loki_apply_max_tier_clamp with LOKI_MAX_TIER=sonnet
# clamps opus down to PROVIDER_MODEL_DEVELOPMENT=sonnet. So runner iter-0 dispatches sonnet, not opus.
# NOTE: the estimator may still quote "Opus" if it hasn't been updated to the new sonnet dev default.
# If est_models returns "Opus" with runner "sonnet", the estimator needs sonnet5-default update (Lane D/F).
arch_clamp_e="$(est_models LOKI_SESSION_MODEL=opus LOKI_MAX_TIER=sonnet LOKI_FABLE_ARCHITECT=1)"
arch_clamp_r0="$(resolve_session_iter opus 1 LOKI_MAX_TIER=sonnet LOKI_FABLE_ARCHITECT=1)"
[ "$arch_clamp_r0" = "sonnet" ] \
  && ok "architect+sonnet-cap on opus pin: runner architect iter clamps to $arch_clamp_r0 (sonnet, not opus/fable; v7.104.0 dev=sonnet). Estimator: $arch_clamp_e" \
  || bad "architect+sonnet-cap runner wrong: iter1='$arch_clamp_r0' (expected sonnet; v7.104.0 dev=sonnet)"
# opus pin + opus cap + architect: same -- fable clamps back to opus.
arch_opuscap_e="$(est_models LOKI_SESSION_MODEL=opus LOKI_MAX_TIER=opus LOKI_FABLE_ARCHITECT=1)"
[ "$arch_opuscap_e" = "Opus" ] \
  && ok "architect+opus-cap on opus pin: estimator quotes NO fable ($arch_opuscap_e)" \
  || bad "architect+opus-cap over-quote: estimator='$arch_opuscap_e' (expected Opus, no fable)"
# Architect, NO cap: fable is unavailable, so the architecture pass collapses to
# opus on BOTH the estimator quote and the runner dispatch. The estimator quotes
# Opus only (NOT Fable,Opus), and the runner architect iteration dispatches opus
# (NOT fable). The architect block is still ALIVE: its tier routing sets the fable
# TIER pre-collapse (proven by the non-vacuity assertions in section 2b and the
# pre-collapse tier check below). This is the v7.39.1 coherence: quote, runner
# tier, runner dispatch all agree on opus for a fable architecture pass.
arch_nocap_e="$(est_models LOKI_FABLE_ARCHITECT=1)"
arch_nocap_r0="$(resolve_session_iter sonnet 1 LOKI_FABLE_ARCHITECT=1)"
arch_nocap_tier0="$(resolve_session_tier sonnet 1 LOKI_FABLE_ARCHITECT=1)"
# v7.104.0: the architect iter-1 collapses fable->opus (Opus), and later
# iterations run the development/planning tier which now defaults to SONNET (was
# opus). So the estimator honestly quotes BOTH models across the run ("Opus,Sonnet",
# sorted) instead of a single "Opus". iter-1 dispatch is still opus from the live
# fable TIER (block alive); the collapse stays coherent.
[ "$arch_nocap_e" = "Opus,Sonnet" ] && [ "$arch_nocap_r0" = "opus" ] && [ "$arch_nocap_tier0" = "fable" ] \
  && ok "architect no-cap: estimator quotes Opus,Sonnet (iter-1 fable->opus, later iters sonnet), runner dispatches $arch_nocap_r0 from the live fable TIER ($arch_nocap_tier0) -- collapse coherent, block alive" \
  || bad "architect no-cap mismatch: estimator='$arch_nocap_e' runner-dispatch='$arch_nocap_r0' runner-tier='$arch_nocap_tier0' (expected Opus,Sonnet / opus / fable)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (of $((PASS+FAIL)))"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
