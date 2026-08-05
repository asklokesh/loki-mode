#!/usr/bin/env bash
# tests/test-start-handoff.sh -- verifies the S1 detach-default handoff on
# `loki start` (autonomy/loki):
#
#   1. _loki_start_should_handoff GATE: fires only on an interactive TTY with
#      no --bg, no --yes/LOKI_AUTO_CONFIRM, no CI. Any of those -> no handoff
#      (byte-identical to the pre-existing foreground path).
#   2. _loki_start_handoff prints the detail block (spec/path/tier/provider/
#      iteration/budget/log/dashboard), the 5 actions, and the dashboard URL.
#   3. Choice mapping: empty/"both" -> launch-bg (+ reattach hints); "detach"
#      -> launch-bg (no foreground block); "stop" -> cancel (no launch);
#      "dashboard"/"watch" -> their decisions; remembered choice skips prompt.
#
# Extract-function harness: the two helpers are awk-extracted from autonomy/loki
# and sourced into a scratch shell with color vars stubbed. No real `loki start`
# is invoked, so run.sh is never exec'd.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract the two helper functions by name into a sourceable file.
extract_fn() {
    awk -v fn="$1" '
        $0 ~ "^"fn"\\(\\) \\{" { grab=1 }
        grab { print }
        grab && /^\}/ { exit }
    ' "$LOKI"
}
{
    # Color/format vars the helpers reference.
    printf 'RED=""; GREEN=""; YELLOW=""; CYAN=""; BOLD=""; DIM=""; NC=""\n'
    extract_fn _loki_start_should_handoff
    extract_fn _loki_plan_preview
    extract_fn _loki_start_handoff
} > "$WORK/helpers.sh"

# Sanity: helper functions extracted.
grep -q '_loki_start_should_handoff()' "$WORK/helpers.sh" || { bad "extract should_handoff"; }
grep -q '_loki_plan_preview()' "$WORK/helpers.sh" || { bad "extract plan_preview"; }
grep -q '_loki_start_handoff()' "$WORK/helpers.sh" || { bad "extract handoff"; }

# --- 1. GATE ---------------------------------------------------------------
# The gate keys off `[ -t 0 ]`/`[ -t 1 ]`, which are false when this test runs
# under a pipe/non-TTY -- exactly the "non-interactive" case. So a plain call
# MUST return non-zero (no handoff). We assert the negative cases directly and
# assert the source contains each guard for the positive-TTY case.
run_gate() { ( set +u; source "$WORK/helpers.sh"; _loki_start_should_handoff "$1" ); }

# Under the test's non-TTY stdin/stdout the gate must decline regardless of args.
if run_gate ""; then bad "gate fires without a TTY (should decline)"; else ok "gate declines when not a TTY (byte-identical path)"; fi
# --bg present: decline even before the TTY check.
if run_gate "1"; then bad "gate fires with --bg"; else ok "gate declines with --bg"; fi
# --yes / CI env: decline.
if ( set +u; source "$WORK/helpers.sh"; LOKI_AUTO_CONFIRM=true _loki_start_should_handoff "" ); then bad "gate fires with --yes"; else ok "gate declines with LOKI_AUTO_CONFIRM=true"; fi
if ( set +u; source "$WORK/helpers.sh"; CI=true _loki_start_should_handoff "" ); then bad "gate fires in CI"; else ok "gate declines with CI=true"; fi
# Source-level guards present (positive-TTY behavior can't be simulated w/o a pty).
for g in '\[ -t 1 \]' '\[ -t 0 \]' 'LOKI_AUTO_CONFIRM' 'CI'; do
    grep -qE "$g" "$WORK/helpers.sh" || bad "gate missing guard: $g"
done
ok "gate source contains TTY + --yes + CI guards"

# --- 2. Card content -------------------------------------------------------
# Force the interactive branch by feeding a choice on stdin. We call the
# handoff with a controlled cwd (LOKI_DIR under WORK) and capture BOTH streams.
run_handoff() {
    # $1 = stdin reply ; env: LOKI_DIR, LOKI_DASHBOARD_PORT, LOKI_BUDGET_LIMIT
    local reply="$1"; shift
    ( set +u
      source "$WORK/helpers.sh"
      cd "$WORK"
      printf '%s\n' "$reply" | _loki_start_handoff "prd.md" "auto" "claude"
    ) 2>"$WORK/err.txt"
}

# "both" (empty reply also maps to both; use explicit "both" to avoid read -t race).
rm -rf "$WORK/.loki"
DEC=$(LOKI_DIR="$WORK/.loki" LOKI_DASHBOARD_PORT=57374 LOKI_BUDGET_LIMIT=5 run_handoff "both")
CARD="$(cat "$WORK/err.txt")"

for field in "spec" "path" "tier" "provider" "iteration" "budget" "log" "dashboard"; do
    printf '%s' "$CARD" | grep -q "$field" || bad "card missing detail field: $field"
done
ok "card prints all 8 detail fields"

for action in "Both" "Dashboard" "Watch" "Detach" "Stop"; do
    printf '%s' "$CARD" | grep -q "$action" || bad "card missing action: $action"
done
ok "card prints all 5 actions"

printf '%s' "$CARD" | grep -q "http://127.0.0.1:57374" || bad "card missing dashboard URL"
ok "card prints dashboard URL http://127.0.0.1:57374"

printf '%s' "$CARD" | grep -q "prd.md" || bad "card missing spec label"
printf '%s' "$CARD" | grep -q "auto" || bad "card missing tier"
printf '%s' "$CARD" | grep -q "\$0 / 5" || bad "card missing budget ledger"
ok "card injects spec, tier, and budget values"

# --- 3. Choice mapping -----------------------------------------------------
rm -rf "$WORK/.loki"
D=$(LOKI_DIR="$WORK/.loki" run_handoff "both");  [ "$D" = "launch-bg" ]            || bad "both -> $D (want launch-bg)"
[ "$D" = "launch-bg" ] && ok "'both' -> launch-bg"
# reattach hints on Both.
grep -q "loki cockpit" "$WORK/err.txt" || bad "Both missing cockpit reattach hint"
grep -q "127.0.0.1" "$WORK/err.txt" || bad "Both missing dashboard reattach hint"
ok "'both' prints reattach hints (dashboard + cockpit)"

rm -rf "$WORK/.loki"
D=$(LOKI_DIR="$WORK/.loki" run_handoff "detach"); [ "$D" = "launch-bg" ]           || bad "detach -> $D (want launch-bg)"
[ "$D" = "launch-bg" ] && ok "'detach' -> launch-bg (detaches, no foreground block)"

rm -rf "$WORK/.loki"
D=$(LOKI_DIR="$WORK/.loki" run_handoff "stop");   [ "$D" = "cancel" ]              || bad "stop -> $D (want cancel)"
[ "$D" = "cancel" ] && ok "'stop' -> cancel (no launch)"
grep -q "run cancelled" "$WORK/err.txt" || bad "stop missing 'run cancelled'"
ok "'stop' prints 'run cancelled'"

rm -rf "$WORK/.loki"
D=$(LOKI_DIR="$WORK/.loki" run_handoff "dashboard"); [ "$D" = "launch-bg-dashboard" ] || bad "dashboard -> $D"
[ "$D" = "launch-bg-dashboard" ] && ok "'dashboard' -> launch-bg-dashboard"

rm -rf "$WORK/.loki"
D=$(LOKI_DIR="$WORK/.loki" run_handoff "watch");  [ "$D" = "launch-bg-watch" ]     || bad "watch -> $D"
[ "$D" = "launch-bg-watch" ] && ok "'watch' -> launch-bg-watch"

# Remembered choice: a saved start-view.json skips the prompt. Write "dashboard"
# and call with a reply that WOULD map to stop -- the saved value must win and
# no prompt is shown (decision derives from the file, not stdin).
rm -rf "$WORK/.loki"; mkdir -p "$WORK/.loki/config"
printf '{"view":"dashboard"}\n' > "$WORK/.loki/config/start-view.json"
D=$(LOKI_DIR="$WORK/.loki" run_handoff "stop")
[ "$D" = "launch-bg-dashboard" ] || bad "remembered choice ignored (got $D, want launch-bg-dashboard)"
[ "$D" = "launch-bg-dashboard" ] && ok "remembered 'dashboard' skips prompt and reuses decision"
grep -q "remembered view" "$WORK/err.txt" || bad "remembered path missing one-line summary"
ok "remembered path prints one-line summary"

# Persistence: a fresh interactive choice writes start-view.json.
rm -rf "$WORK/.loki"
LOKI_DIR="$WORK/.loki" run_handoff "watch" >/dev/null
grep -q '"view":"watch"' "$WORK/.loki/config/start-view.json" 2>/dev/null || bad "choice not persisted"
ok "interactive choice persisted to start-view.json"

# --- 3b. E4 plan preview + first-run delight -------------------------------
# The plan preview shows exactly 3 lines tied to tier + spec. Line 1 maps the
# tier to its phase count; line 2 names the spec (or admits no spec); line 3 is
# the fixed RARV-C loop promise. Test the helper directly for each tier.
plan_preview() { ( set +u; source "$WORK/helpers.sh"; _loki_plan_preview "$1" "$2" ); }

P=$(plan_preview "prd.md" "simple")
[ "$(printf '%s\n' "$P" | grep -c .)" -eq 3 ] || bad "plan preview not 3 lines (simple): got $(printf '%s' "$P" | grep -c .)"
printf '%s' "$P" | grep -q "3 phases" || bad "simple tier missing '3 phases'"
printf '%s' "$P" | grep -q "prd.md"   || bad "plan preview missing spec label"
printf '%s' "$P" | grep -qi "Reason - Act - Reflect - Verify" || bad "plan preview missing RARV loop line"
ok "plan preview shows 3 lines tied to tier (simple=3 phases) + spec"

P=$(plan_preview "prd.md" "standard"); printf '%s' "$P" | grep -q "6 phases" || bad "standard tier missing '6 phases'"
P=$(plan_preview "prd.md" "complex");  printf '%s' "$P" | grep -q "8 phases" || bad "complex tier missing '8 phases'"
P=$(plan_preview "prd.md" "auto");     printf '%s' "$P" | grep -qi "auto-detecting" || bad "auto tier not honest ('auto-detecting')"
ok "plan preview maps standard/complex/auto tiers honestly (6/8/auto-detecting)"

# No spec -> honest "exploring the codebase", never a fabricated file.
P=$(plan_preview "codebase (no PRD)" "auto")
printf '%s' "$P" | grep -qi "exploring the codebase" || bad "no-spec preview not honest"
printf '%s' "$P" | grep -q "codebase (no PRD)" && bad "no-spec preview leaked raw label instead of honest text"
ok "no-spec preview is honest ('exploring the codebase')"

# Preview appears inside the real card.
rm -rf "$WORK/.loki"
LOKI_DIR="$WORK/.loki" run_handoff "both" >/dev/null
grep -q "3 phases\|phase count auto-detecting" "$WORK/err.txt" || bad "card missing plan preview line"
ok "handoff card embeds the plan preview"

# First-run delight: no start-view.json yet -> teach line present.
rm -rf "$WORK/.loki"
LOKI_DIR="$WORK/.loki" run_handoff "both" >/dev/null
grep -q "loki cockpit' reopens" "$WORK/err.txt" || bad "first-run teach line missing"
ok "first run shows the 'loki cockpit' teach line"

# Remembered/subsequent run: config file exists -> NO teach line (stays lean).
# The saved-view path returns before the card, so also verify a non-first run
# where the file exists but with an unknown view still skips the teach line.
rm -rf "$WORK/.loki"; mkdir -p "$WORK/.loki/config"
printf '{"view":"unknown-xyz"}\n' > "$WORK/.loki/config/start-view.json"
LOKI_DIR="$WORK/.loki" run_handoff "both" >/dev/null
grep -q "loki cockpit' reopens" "$WORK/err.txt" && bad "teach line shown on a non-first run (config exists)"
ok "non-first run (config exists) does not show the teach line"

# --- 4. set -e safety of the --bg pre-scan loop ----------------------------
# autonomy/loki runs under `set -euo pipefail`. The bg-detection loop in
# cmd_start must NOT abort the script when --bg is absent (its last `[ ]` would
# be false). Regression guard: run the exact loop shape under set -e and assert
# it reaches the end for both the no-bg and bg cases.
if ( set -euo pipefail
     a=("prd.md" "--provider" "claude"); b=""
     for x in ${a[@]+"${a[@]}"}; do if [ "$x" = "--bg" ]; then b=1; break; fi; done
     [ -z "$b" ] ); then ok "bg pre-scan survives set -e when --bg absent"; else bad "bg pre-scan aborts under set -e (no --bg)"; fi
if ( set -euo pipefail
     a=("--bg"); b=""
     for x in ${a[@]+"${a[@]}"}; do if [ "$x" = "--bg" ]; then b=1; break; fi; done
     [ "$b" = "1" ] ); then ok "bg pre-scan detects --bg under set -e"; else bad "bg pre-scan wrong under set -e (--bg present)"; fi
# Guard against the &&-tail regression re-entering the source.
if grep -qE '\[ "\$_a" = "--bg" \] && \{' "$LOKI"; then bad "cmd_start bg-scan uses set -e-unsafe && tail"; else ok "cmd_start bg-scan uses if/fi (set -e safe)"; fi

# --- 5. S6 stare-worthy brand banner ---------------------------------------
# _loki_brand_banner renders the Autonomi logo (purple squircle #553DE9 + white
# A + teal #1FC5A8 dot) + LOKI wordmark, truecolor when COLORTERM says so, and a
# clean 256/mono badge otherwise. Pure ANSI, zero new tooling.
BANNER_SRC="$WORK/banner.sh"
extract_fn _loki_brand_banner > "$BANNER_SRC"
if [ -s "$BANNER_SRC" ]; then
    # Truecolor path: must emit 24-bit purple squircle + teal + white + LOKI.
    tc_out="$( COLORTERM=truecolor bash -c "BOLD=''; DIM=''; source '$BANNER_SRC'; _loki_brand_banner autonomi-saas" 2>&1 )"
    if printf '%s' "$tc_out" | grep -q '48;2;85;61;233'; then ok "banner emits truecolor purple squircle (#553DE9)"; else bad "banner missing truecolor squircle"; fi
    if printf '%s' "$tc_out" | grep -q '38;2;31;197;168'; then ok "banner emits teal dot (#1FC5A8)"; else bad "banner missing teal dot"; fi
    if printf '%s' "$tc_out" | grep -q 'LOKI'; then ok "banner shows LOKI wordmark"; else bad "banner missing wordmark"; fi
    if printf '%s' "$tc_out" | grep -qi 'Autonomi cockpit'; then ok "banner shows Autonomi cockpit tagline"; else bad "banner missing tagline"; fi
    # Degraded path: no truecolor -> still branded, NO 24-bit escape.
    lo_out="$( COLORTERM='' TERM=xterm-256color bash -c "BOLD=''; DIM=''; source '$BANNER_SRC'; _loki_brand_banner autonomi-saas" 2>&1 )"
    if printf '%s' "$lo_out" | grep -q 'LOKI' && ! printf '%s' "$lo_out" | grep -q '48;2;'; then ok "banner degrades cleanly without truecolor (branded, no 24-bit)"; else bad "banner degrade path wrong"; fi
else
    bad "could not extract _loki_brand_banner"
fi

# --- WIRING: the extracted helpers must still be CALLED ----------------------
# Everything above awk-extracts the helpers and tests them in isolation. That
# proves the helpers work and says nothing about whether `loki start` uses them.
#
# Found by mutation probe: replacing the call site with `if false` -- which
# silently removes the interactive handoff from every `loki start` -- left this
# entire file green. An isolation test cannot see a disconnected wire.
_LOKI_SRC="$REPO_ROOT/autonomy/loki"

if grep -qE 'if _loki_start_should_handoff .*; then' "$_LOKI_SRC"; then
    ok "WIRING: loki start calls _loki_start_should_handoff"
else
    bad "WIRING: the handoff decision is no longer called -- loki start silently changed"
fi

if grep -qF '_loki_start_handoff "$_spec_label"' "$_LOKI_SRC"; then
    ok "WIRING: the handoff renderer is invoked when the decision says yes"
else
    bad "WIRING: the handoff renderer is unreachable from loki start"
fi

# Both helpers must still be DEFINED under the names the call sites use: a
# rename that updates one side leaves start invoking a command that is gone.
for _fn in _loki_start_should_handoff _loki_start_handoff; do
    if grep -qF "${_fn}()" "$_LOKI_SRC"; then
        ok "WIRING: $_fn is defined under the name its caller uses"
    else
        bad "WIRING: $_fn definition and call site have diverged"
    fi
done


echo ""
echo "----------------------------------------"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
