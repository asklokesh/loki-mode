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
[ "$out_default" = "opus" ] \
  && ok "planning tier defaults to opus (REAL claude.sh path)" \
  || bad "planning default not opus: '$out_default'"
# Explicit fable tier arm: a fable-pinned session / override resolves to fable
# (the model-honesty lever runs fable instead of falling through to opus).
out_fable="$(rmt fable)"
[ "$out_fable" = "fable" ] \
  && ok "explicit fable tier resolves to fable (lever genuinely runs fable)" \
  || bad "fable tier did not resolve to fable: '$out_fable'"
# The planning-time architect gate is REMOVED: LOKI_FABLE_ARCHITECT alone must
# NOT convert the planning tier to fable (that scoping is now run.sh iter-0).
out_planning_arch="$(rmt LOKI_FABLE_ARCHITECT=1 planning)"
[ "$out_planning_arch" = "opus" ] \
  && ok "LOKI_FABLE_ARCHITECT no longer converts planning tier in the resolver (scoping moved to run.sh iter-0)" \
  || bad "planning tier wrongly converted to fable in resolver: '$out_planning_arch'"
# maxTier clamp on the fable tier (the cost ceiling the override path also uses).
out_max_sonnet="$(rmt LOKI_MAX_TIER=sonnet fable)"
[ "$out_max_sonnet" = "opus" ] \
  && ok "LOKI_MAX_TIER=sonnet clamps fable down to development (opus)" \
  || bad "maxTier=sonnet did not clamp fable: '$out_max_sonnet'"
out_max_opus="$(rmt LOKI_MAX_TIER=opus fable)"
[ "$out_max_opus" = "opus" ] \
  && ok "LOKI_MAX_TIER=opus caps fable back to opus" \
  || bad "maxTier=opus did not cap fable: '$out_max_opus'"
out_dev="$(rmt development)"
[ "$out_dev" = "opus" ] \
  && ok "dev tier resolves to opus (unchanged)" \
  || bad "dev tier wrong: '$out_dev'"

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
      case "$sm" in
        opus) CURRENT_TIER="planning";; sonnet) CURRENT_TIER="development";;
        haiku) CURRENT_TIER="fast";; fable) CURRENT_TIER="fable";;
        planning|development|fast) CURRENT_TIER="$sm";; *) CURRENT_TIER="$sm";;
      esac
      if [ "$iter" -eq 1 ] && [ "${LOKI_FABLE_ARCHITECT:-0}" = "1" ] \
         && [ -z "${LOKI_CLAUDE_MODEL_PLANNING:-}" ] && [ -z "${LOKI_MODEL_PLANNING:-}" ]; then
        CURRENT_TIER="fable"
      fi
      resolve_model_for_tier "$CURRENT_TIER"
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
arch0="$(resolve_session_iter opus 1 LOKI_FABLE_ARCHITECT=1)"
arch1="$(resolve_session_iter opus 2 LOKI_FABLE_ARCHITECT=1)"
[ "$arch0" = "fable" ] && [ "$arch1" = "opus" ] \
  && ok "architect routes ONLY the first iteration to fable; opus-pinned session NOT converted wholesale" \
  || bad "architect scope wrong: iter1='$arch0' iter2='$arch1' (expected fable/opus)"
arch_def0="$(resolve_session_iter sonnet 1 LOKI_FABLE_ARCHITECT=1)"
[ "$arch_def0" = "fable" ] \
  && ok "architect fires on the default session pin (no longer a silent no-op)" \
  || bad "architect did not fire on default pin: '$arch_def0'"
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
# the file -> apply loki_apply_max_tier_clamp. A sonnet-capped run must NOT
# dispatch fable.
# ---------------------------------------------------------------------------
override_effective() {
    # $1=file content ; remaining "VAR=val" exports
    local content="$1"; shift
    bash -c '
      for kv in "$@"; do export "$kv"; done
      source "'"$CLAUDE_SH"'" 2>/dev/null
      alias="$(loki_normalize_model_alias "$1")"
      [ -z "$alias" ] && { echo REJECTED; exit 0; }
      loki_apply_max_tier_clamp "$alias" "$alias"
    ' _ "$content" "$@"
}
[ "$(override_effective fable)" = "fable" ] \
  && ok "override fable dispatches fable when uncapped" || bad "override fable not honored uncapped"
[ "$(override_effective fable LOKI_MAX_TIER=sonnet)" = "opus" ] \
  && ok "override fable clamped to opus under LOKI_MAX_TIER=sonnet (ceiling not bypassed)" \
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
# 6. End-to-end estimator quotes fable when forced (no real model invoked).
# ---------------------------------------------------------------------------
EST_DIR="$WORK/est"
mkdir -p "$EST_DIR/.loki/state"
cat > "$EST_DIR/prd.md" <<'EOF'
# PRD
Build a small todo API with one endpoint.
EOF
fable_total="$(cd "$EST_DIR" && LOKI_SESSION_MODEL=fable "$LOKI" plan ./prd.md --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cost']['by_model'].get('Fable',0))" 2>/dev/null)"
case "$fable_total" in
    0|0.0|"") bad "estimator did not quote fable cost (got '$fable_total')" ;;
    *) ok "LOKI_SESSION_MODEL=fable estimator quotes fable cost ($fable_total)" ;;
esac
# LOKI_SESSION_MODEL=fable under LOKI_MAX_TIER=sonnet must NOT quote fable
# (estimator honors the ceiling, agreeing with the run).
capped_fable="$(cd "$EST_DIR" && LOKI_SESSION_MODEL=fable LOKI_MAX_TIER=sonnet "$LOKI" plan ./prd.md --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cost']['by_model'].get('Fable',0))" 2>/dev/null)"
case "$capped_fable" in
    0|0.0) ok "estimator clamps fable to the LOKI_MAX_TIER ceiling (no over-quote)" ;;
    *) bad "estimator quoted fable above LOKI_MAX_TIER ceiling (got '$capped_fable')" ;;
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
for cap in "" haiku sonnet opus; do
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

# --- Control: fable override under sonnet cap WITHOUT ALLOW_HAIKU -> opus on all ---
printf 'fable\n' > "$XR_DIR/.loki/state/model-override"
eD="$(est_quoted LOKI_MAX_TIER=sonnet)"
rD="$(bash_clamp fable LOKI_MAX_TIER=sonnet)"
dD="$(dash_effective fable LOKI_MAX_TIER=sonnet)"
[ "$eD" = "$rD" ] && [ "$dD" = "$rD" ] && [ "$rD" = "opus" ] \
  && ok "cross-route sonnet-cap+fable (no ALLOW_HAIKU): estimator=$eD dashboard=$dD runner=$rD (all opus)" \
  || bad "cross-route sonnet-cap+fable (default) mismatch: est='$eD' dash='$dD' runner='$rD'"
rm -f "$XR_DIR/.loki/state/model-override"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (of $((PASS+FAIL)))"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
