#!/usr/bin/env bash
# tests/test-caveman-loki-coverage.sh -- caveman moat coverage for the loki CLI.
#
# Companion to tests/test-caveman-flags.sh (which audits the autonomy/ shell
# surface: run.sh, completion-council.sh, council-v2.sh, grill.sh, voter-agents.sh).
# That audit deliberately does NOT include autonomy/loki, the CLI dispatcher.
# This file closes that gap so the moat also covers every `claude` invocation in
# autonomy/loki.
#
# THE MOAT INVARIANT (issue #594, finding 1):
#   A "trust-gate verdict subcall" is a claude invocation whose OUTPUT is CAPTURED
#   and consumed downstream (parsed for a verdict/sentinel, or written verbatim as
#   a deliverable). caveman compresses claude's OUTPUT tokens, so an active caveman
#   on such a subcall would corrupt the captured text. Today autonomy/loki has ZERO
#   parsed-verdict subcalls, but a FUTURE captured subcall added here would be
#   caught by NEITHER the tree-wide export (loki does not source claude-flags.sh
#   globally) NOR the test-caveman-flags.sh audit (which omits loki). This test
#   makes such a future subcall go RED unless it is suppressed (CAVEMAN_DEFAULT_MODE
#   =off) or explicitly an activation level (="$...").
#
# THE DISCRIMINATOR is OUTPUT CAPTURE, not the mere presence of a prefix:
#   - CAPTURED  (=$(...claude...))  -> output consumed downstream -> MUST be off
#                                       (or carry an explicit ="$..." level, none today).
#   - NARRATION (piped to a display/log, never captured) -> free-form -> may ACTIVATE
#     compression. Today the three narration sites (migration phase exec, migration
#     docs-gen, heal execution) carry a conditional CAVEMAN_DEFAULT_MODE="$<level>"
#     activation prefix, consistent with the run.sh free-form sites.
#
# This is non-vacuous: it asserts the enumeration is non-empty (>= a floor), that
# the captured set is non-empty (>= 1), and it carries positive checks for the
# specific v7.41.0 sites (#594 finding 2).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_CLI="$REPO_ROOT/autonomy/loki"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "${GREEN}[PASS]${NC} $1"; }
bad() { FAIL=$((FAIL + 1)); echo "${RED}[FAIL]${NC} $1 -- ${2:-}"; }

[ -f "$LOKI_CLI" ] || { echo "${RED}FATAL${NC}: $LOKI_CLI not found"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Enumerate every `claude` BINARY invocation in autonomy/loki.
# ---------------------------------------------------------------------------
# A "claude invocation" is a line that runs the claude binary. We exclude the
# non-invocation matches specific to the loki CLI surface:
#   - comments / help / usage text                (#, "  4. claude", echo "...claude...")
#   - capability probes                           (command -v claude, claude --version)
#   - doctor registration                         (doctor_check "Claude CLI" claude ...)
#   - provider/identifier hits                    (--provider, claude-flags, claude.sh,
#                                                   claude-session, .claude, claude.ai,
#                                                   "claude (default)", for _pcli in claude)
#   - the install hint string                     ("claude --dangerously-skip-permissions"
#                                                   printed for the user to copy/paste)
#   - subcommand forms with no captured output    (claude ultrareview, claude remote-control)
#     -- these print to the terminal; their output is not parsed for a verdict.
mapfile -t INVOCATIONS < <(
  grep -nE '(^|[^[:alnum:]_.-])claude([[:space:]]|$)' "$LOKI_CLI" 2>/dev/null \
    | grep -vE '#|command -v claude|which claude|claude --version|doctor_check|claude CLI|Claude Code|claude-flags|claude\.sh|claude-session|claude_session|claude_flags|\.claude|claude\.ai|--provider|for _pcli in claude|claude \(default\)|claude  *- |Running: claude|^[0-9]+:[[:space:]]*echo|^[0-9]+:[[:space:]]*claude --dangerously-skip-permissions$'
)

INVOCATION_COUNT="${#INVOCATIONS[@]}"
# Floor chosen below the real count (>= 5 concrete invocation lines today) so the
# test catches a silently-empty enumeration but does not flap on small refactors.
[ "$INVOCATION_COUNT" -ge 5 ] \
  && ok "enumerated $INVOCATION_COUNT claude invocation lines in autonomy/loki (non-vacuous, >= 5)" \
  || bad "enumeration non-vacuity" "expected >= 5 claude invocation lines, got $INVOCATION_COUNT"

# ---------------------------------------------------------------------------
# 2. THE MOAT ASSERTION: every CAPTURED-output claude subcall is suppressed.
# ---------------------------------------------------------------------------
# Captured == the claude invocation feeds a command substitution `=$(...claude...)`,
# i.e. its stdout is consumed downstream (parsed for a verdict OR written verbatim
# as a deliverable). Each such subcall MUST carry CAVEMAN_DEFAULT_MODE=off OR an
# explicit activation level ="$...". A bare captured claude subcall is a moat leak.
mapfile -t CAPTURED < <(
  grep -nE '=\$\([^)]*claude' "$LOKI_CLI" 2>/dev/null \
    | grep -vE 'claude --version|command -v claude|echo "claude"|\|\| echo "claude"'
)

CAPTURED_COUNT="${#CAPTURED[@]}"
# Non-vacuity guard #2: the captured set must be non-empty, otherwise the
# suppression assertion below passes vacuously.
[ "$CAPTURED_COUNT" -ge 1 ] \
  && ok "found $CAPTURED_COUNT captured-output claude subcall(s) to audit (non-vacuous, >= 1)" \
  || bad "captured non-vacuity" "expected >= 1 captured claude subcall, got $CAPTURED_COUNT"

leak=0
for entry in "${CAPTURED[@]}"; do
  lineno="${entry%%:*}"; code="${entry#*:}"
  # Suppressed (off) OR explicit activation level (="$...) -> sanctioned.
  if printf '%s' "$code" | grep -qE 'CAVEMAN_DEFAULT_MODE=off'; then
    continue
  fi
  if printf '%s' "$code" | grep -qE 'CAVEMAN_DEFAULT_MODE="\$'; then
    continue
  fi
  bad "moat leak" "captured claude subcall NOT suppressed at autonomy/loki:$lineno -> $code"
  leak=$((leak + 1))
done
[ "$leak" -eq 0 ] \
  && ok "moat invariant: every captured claude subcall in loki is suppressed-or-leveled (no parsed-verdict leak)" \
  || bad "moat invariant" "$leak unsuppressed captured claude subcall(s) found"

# ---------------------------------------------------------------------------
# 3. POSITIVE checks for the v7.41.0 / #594 sites (belt-and-suspenders).
# ---------------------------------------------------------------------------
# 3a. The docs helper captures claude stdout and writes it verbatim to a markdown
#     file (loki:23869, loki:24239) -- it MUST hard-suppress so the generated docs
#     are not emitted in caveman-speak. (#594 finding 2, advisor correction.)
grep -qE 'result=\$\([^)]*CAVEMAN_DEFAULT_MODE=off claude -p "\$prompt"' "$LOKI_CLI" \
  && ok "_docs_invoke_provider captured deliverable HARD-SUPPRESSES caveman (off)" \
  || bad "docs-helper suppress" "_docs_invoke_provider captured subcall not suppressed with CAVEMAN_DEFAULT_MODE=off"

# 3b. The three free-form NARRATION sites ACTIVATE caveman conditionally via the
#     shared lazy-source helper (#594 finding 2, option a -- consistency with run.sh).
grep -q '_loki_caveman_narration_level' "$LOKI_CLI" \
  && ok "loki defines/uses _loki_caveman_narration_level (lazy-source activation helper)" \
  || bad "narration helper" "loki missing _loki_caveman_narration_level wiring"

# Each narration site carries a conditional CAVEMAN_DEFAULT_MODE="$<level>" claude
# prefix (the activation branch). Count them: expect exactly the 3 named sites.
narr_sites=$(grep -cE 'CAVEMAN_DEFAULT_MODE="\$_loki_(mig|doc|heal)_cm" claude' "$LOKI_CLI")
[ "$narr_sites" -eq 3 ] \
  && ok "all 3 narration sites (migration exec, docs-gen, heal) carry the activation prefix" \
  || bad "narration activation count" "expected 3 activation-prefixed narration sites, got $narr_sites"

# 3c. EMPTY-mode footgun guard: an EMPTY CAVEMAN_DEFAULT_MODE is NOT inert (caveman
#     falls back to the user global default). The narration sites must branch
#     (if level non-empty set the var, else bare invocation) rather than set an
#     empty prefix. Assert no `CAVEMAN_DEFAULT_MODE="" claude` / `=  claude` exists.
if grep -qE 'CAVEMAN_DEFAULT_MODE=""? +claude' "$LOKI_CLI"; then
  bad "empty-mode footgun" "found an empty CAVEMAN_DEFAULT_MODE claude prefix in loki"
else
  ok "no empty CAVEMAN_DEFAULT_MODE prefix in loki (empty-is-not-inert footgun avoided)"
fi

# 3d. The narration activation is GATED on the real predicate (loki_caveman_activate_env
#     via the helper), not unconditional -- so opt-out / non-claude / legacy-completion
#     -match all degrade to a bare invocation. Verify the helper delegates to it.
grep -q 'loki_caveman_activate_env' "$LOKI_CLI" \
  && ok "narration helper delegates the gate to loki_caveman_activate_env (opt-out/legacy honored)" \
  || bad "narration gate" "loki narration helper does not delegate to loki_caveman_activate_env"

# ---------------------------------------------------------------------------
echo
echo "Caveman loki-coverage tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
[ "$FAIL" -eq 0 ]
