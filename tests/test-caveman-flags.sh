#!/usr/bin/env bash
# tests/test-caveman-flags.sh -- caveman output-token compressor gates.
#
# Bash-route coverage for the loki_caveman_* predicates that ACTIVATE caveman
# compression on free-form generation and HARD-SUPPRESS it on every parsed
# trust-gate subcall. caveman is a Claude Code skill that compresses OUTPUT
# tokens only; its disable lever is the env CAVEMAN_DEFAULT_MODE=off (verified
# against the upstream caveman-activate.js SessionStart hook: an "off" mode makes
# the hook emit nothing and delete its flag file).
#
# Asserts:
#   - version pin default (1.9.0) + level default (full).
#   - loki_caveman_supported: Claude provider + claude on PATH + installed-or-
#     bootstrappable + LOKI_CAVEMAN!=0. Non-claude / opt-out -> unsupported.
#   - loki_caveman_enabled: default ON, opt-out LOKI_CAVEMAN=0, and the
#     cross-coupling guard (LOKI_LEGACY_COMPLETION_MATCH=true disables it).
#   - loki_caveman_activate_env: level when warranted, EMPTY otherwise.
#   - DETERMINISM / MOAT carve-out: loki_caveman_suppress_env is ALWAYS "off",
#     UNCONDITIONALLY, across every knob combination (the mutation forces
#     activation on; suppression must NOT change). Non-vacuity: activate_env DOES
#     change under the same mutation.
#   - NO-RAISE level fix (v7.41.0 R2): activate_env never raises a user's lower
#     global level (LOKI_CAVEMAN_USER_MODE) up to full; a user's global "off"
#     opts out of activation entirely; malformed user modes are ignored.
#   - THE MOAT GUARANTEE (v7.41.0 council fix): claude-flags.sh exports
#     CAVEMAN_DEFAULT_MODE=off at source time, so EVERY tree that sources it
#     (run.sh via providers/claude.sh, grill.sh, voter-agents.sh, loki standalone)
#     inherits suppression by construction. A TREE-WIDE COMPLETENESS AUDIT
#     enumerates every `claude` invocation across the autonomy/ shell surface and
#     fails if any parsed subcall is neither inline-suppressed nor a named
#     free-form activation site -- so a NEW unsuppressed parsed subcall goes RED.
#   - cross-route parity: the suppression token "off" and the default level/
#     version match the TS mirror in loki-ts/src/providers/claude_flags.ts.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FLAGS_SH="$REPO_ROOT/autonomy/lib/claude-flags.sh"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
TS_FLAGS="$REPO_ROOT/loki-ts/src/providers/claude_flags.ts"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "${GREEN}[PASS]${NC} $1"; }
bad() { FAIL=$((FAIL + 1)); echo "${RED}[FAIL]${NC} $1 -- ${2:-}"; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loki-caveman-XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

# Stub claude / node / npx on PATH so the capability probe + bootstrap detection
# behave deterministically without the real binaries.
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/claude" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "2.1.177 (Claude Code)"; exit 0 ;;
  --help)    echo "--effort --bare --disallowedTools"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$STUB_BIN/claude"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_BIN/node"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_BIN/npx"
chmod +x "$STUB_BIN/node" "$STUB_BIN/npx"

# Isolated CLAUDE_CONFIG_DIR so install detection is controlled.
CLAUDE_DIR="$TMP/claude"
mkdir -p "$CLAUDE_DIR/hooks"

export PATH="$STUB_BIN:$PATH"
export CLAUDE_CONFIG_DIR="$CLAUDE_DIR"

# shellcheck source=/dev/null
source "$FLAGS_SH"

# ---------------------------------------------------------------------------
# 1. Defaults (version pin + level)
# ---------------------------------------------------------------------------
[ "$LOKI_CAVEMAN_VERSION" = "1.9.0" ] \
  && ok "version pin defaults to 1.9.0" \
  || bad "version pin default" "got $LOKI_CAVEMAN_VERSION"
[ "$LOKI_CAVEMAN_LEVEL" = "full" ] \
  && ok "level defaults to full" \
  || bad "level default" "got $LOKI_CAVEMAN_LEVEL"

# ---------------------------------------------------------------------------
# 2. supported (capability gate)
# ---------------------------------------------------------------------------
# Not installed, but node+npx present -> bootstrappable -> supported.
if loki_caveman_supported; then ok "supported when bootstrappable (node+npx present)"
else bad "supported (bootstrappable)" "expected supported"; fi

# Installed (hook file present) -> supported.
: > "$CLAUDE_DIR/hooks/caveman-activate.js"
if loki_caveman_supported; then ok "supported when installed (hook file present)"
else bad "supported (installed)" "expected supported"; fi

# Opt-out knob -> unsupported.
if LOKI_CAVEMAN=0 loki_caveman_supported; then bad "opt-out unsupported" "LOKI_CAVEMAN=0 still supported"
else ok "LOKI_CAVEMAN=0 -> unsupported"; fi

# Non-claude provider -> unsupported.
if LOKI_PROVIDER=codex loki_caveman_supported; then bad "non-claude unsupported" "codex still supported"
else ok "non-claude provider -> unsupported"; fi

# ---------------------------------------------------------------------------
# 3. enabled (activation knob) + cross-coupling guard
# ---------------------------------------------------------------------------
if loki_caveman_enabled; then ok "enabled by default"
else bad "enabled default" "expected enabled"; fi

if LOKI_CAVEMAN=0 loki_caveman_enabled; then bad "opt-out disabled" "LOKI_CAVEMAN=0 still enabled"
else ok "LOKI_CAVEMAN=0 -> disabled"; fi

if LOKI_LEGACY_COMPLETION_MATCH=true loki_caveman_enabled; then
  bad "legacy guard" "legacy completion match did not disable activation"
else ok "LOKI_LEGACY_COMPLETION_MATCH=true -> activation disabled (moat guard)"; fi

# ---------------------------------------------------------------------------
# 4. activate_env value
# ---------------------------------------------------------------------------
av="$(loki_caveman_activate_env)"
[ "$av" = "full" ] && ok "activate_env = full when warranted" || bad "activate_env warranted" "got [$av]"

av="$(LOKI_CAVEMAN_LEVEL=ultra loki_caveman_activate_env)"
[ "$av" = "ultra" ] && ok "activate_env honors LOKI_CAVEMAN_LEVEL=ultra" || bad "activate_env level" "got [$av]"

av="$(LOKI_CAVEMAN=0 loki_caveman_activate_env)"
[ -z "$av" ] && ok "activate_env empty when opted out" || bad "activate_env opt-out" "got [$av]"

av="$(LOKI_PROVIDER=codex loki_caveman_activate_env)"
[ -z "$av" ] && ok "activate_env empty for non-claude" || bad "activate_env non-claude" "got [$av]"

av="$(LOKI_LEGACY_COMPLETION_MATCH=true loki_caveman_activate_env)"
[ -z "$av" ] && ok "activate_env empty under legacy completion match" || bad "activate_env legacy" "got [$av]"

# ---------------------------------------------------------------------------
# 5. DETERMINISM / MOAT carve-out: suppress_env is ALWAYS "off"
# ---------------------------------------------------------------------------
sup="$(loki_caveman_suppress_env)"
[ "$sup" = "off" ] && ok "suppress_env = off (baseline)" || bad "suppress baseline" "got [$sup]"

# Mutation: force activation fully ON at every lever. Suppression must NOT move.
sup="$(LOKI_CAVEMAN=1 LOKI_CAVEMAN_LEVEL=ultra LOKI_PROVIDER=claude loki_caveman_suppress_env)"
[ "$sup" = "off" ] \
  && ok "suppress_env stays off when activation forced ON (determinism)" \
  || bad "suppress under forced-on" "got [$sup]"
# Non-vacuity: under the SAME mutation, activation DID change.
av="$(LOKI_CAVEMAN=1 LOKI_CAVEMAN_LEVEL=ultra LOKI_PROVIDER=claude loki_caveman_activate_env)"
[ "$av" = "ultra" ] \
  && ok "non-vacuity: activate_env = ultra under the same mutation" \
  || bad "non-vacuity" "activate_env did not change, got [$av]"

# Suppression off even when Loki caveman opted out (protects against a user's
# own global caveman install).
sup="$(LOKI_CAVEMAN=0 loki_caveman_suppress_env)"
[ "$sup" = "off" ] && ok "suppress_env off even when LOKI_CAVEMAN=0 (UNGATED)" || bad "suppress ungated" "got [$sup]"

# Suppression off on non-claude provider too.
sup="$(LOKI_PROVIDER=codex loki_caveman_suppress_env)"
[ "$sup" = "off" ] && ok "suppress_env off for non-claude provider" || bad "suppress non-claude" "got [$sup]"

# ---------------------------------------------------------------------------
# 5b. NO-RAISE level fix (R2 finding 4): never silently RAISE a user's lower
#     global caveman level up to full. activate_env honors LOKI_CAVEMAN_USER_MODE.
# ---------------------------------------------------------------------------
# User globally set a LOWER level (lite) -> activation must NOT raise it to full.
av="$(LOKI_CAVEMAN_USER_MODE=lite LOKI_CAVEMAN_LEVEL=full loki_caveman_activate_env)"
[ "$av" = "lite" ] \
  && ok "no-raise: user lite + Loki full -> activate at lite (respect user)" \
  || bad "no-raise lower" "expected lite, got [$av]"

# User globally set a HIGHER level (ultra) -> we do NOT exceed our own ceiling
# (full); a higher user level cannot push us above the configured Loki level.
av="$(LOKI_CAVEMAN_USER_MODE=ultra LOKI_CAVEMAN_LEVEL=full loki_caveman_activate_env)"
[ "$av" = "full" ] \
  && ok "no-raise: user ultra + Loki full -> stays at full (ceiling honored)" \
  || bad "no-raise ceiling" "expected full, got [$av]"

# User globally set off -> opted out entirely; activation produces nothing.
av="$(LOKI_CAVEMAN_USER_MODE=off LOKI_CAVEMAN_LEVEL=full loki_caveman_activate_env)"
[ -z "$av" ] \
  && ok "no-raise: user off -> activation empty (opt-out respected)" \
  || bad "no-raise user-off" "expected empty, got [$av]"

# Unknown / malformed user mode -> ignored (rank -1); falls back to Loki level.
av="$(LOKI_CAVEMAN_USER_MODE=bogus LOKI_CAVEMAN_LEVEL=full loki_caveman_activate_env)"
[ "$av" = "full" ] \
  && ok "no-raise: malformed user mode ignored -> Loki level (full)" \
  || bad "no-raise malformed" "expected full, got [$av]"

# ---------------------------------------------------------------------------
# 6. THE MOAT GUARANTEE: tree-wide default-suppress + completeness audit
# ---------------------------------------------------------------------------
# 6a. The single guarantee: claude-flags.sh exports CAVEMAN_DEFAULT_MODE=off at
#     source time. Every tree that can spawn a parsed claude subcall sources this
#     module (run.sh via providers/claude.sh; grill.sh directly; voter-agents.sh;
#     loki standalone review/workflows on-demand). This is the by-construction
#     close for council-v2.sh, voter-agents.sh, grill.sh, and any FUTURE subcall.
grep -qE '^[[:space:]]*export CAVEMAN_DEFAULT_MODE=off' "$FLAGS_SH" \
  && ok "claude-flags.sh exports CAVEMAN_DEFAULT_MODE=off at source time (tree-wide guarantee)" \
  || bad "global default-off" "claude-flags.sh missing the tree-wide 'export CAVEMAN_DEFAULT_MODE=off'"

# 6b. The user mode must be captured BEFORE the off export clobbers it, guarded
#     against re-source recapture (grill.sh/loki source this file repeatedly).
grep -qE '\[ -z "\$\{LOKI_CAVEMAN_USER_MODE\+x\}" \]' "$FLAGS_SH" \
  && grep -qE 'LOKI_CAVEMAN_USER_MODE="\$\{CAVEMAN_DEFAULT_MODE:-\}"' "$FLAGS_SH" \
  && ok "claude-flags.sh captures LOKI_CAVEMAN_USER_MODE before clobber (unset-guarded, no cross-process recapture)" \
  || bad "user-mode capture" "claude-flags.sh missing unset-guarded LOKI_CAVEMAN_USER_MODE capture"

# 6c. TREE-WIDE COMPLETENESS AUDIT. Enumerate EVERY `claude` invocation across the
#     autonomy/ shell surface and assert each parsed-output subcall is either
#     inline-suppressed (CAVEMAN_DEFAULT_MODE=off) OR a NAMED free-form activation
#     site. A NEW unsuppressed parsed subcall makes this go RED.
#
# A "claude invocation" is a line that runs the claude binary as a generation
# subcall. We exclude non-invocation matches: comments, `command -v`/`which`,
# `claude auth status` (auth probe, output not parsed for a verdict), help/usage
# text, process-name lists, and identifier hits (claude-flags, claude.sh,
# claude-session, .claude path checks).
SHELL_SURFACE=("$RUN_SH" "$COUNCIL_SH" "$REPO_ROOT/autonomy/council-v2.sh" \
               "$REPO_ROOT/autonomy/grill.sh" "$REPO_ROOT/autonomy/lib/voter-agents.sh")

# The ONLY sanctioned free-form ACTIVATION invocations (compression intended).
# These carry CAVEMAN_DEFAULT_MODE="$<var>" (a level), never =off, OR are the
# explicit bare-branch fallback paired with such an activation (which inherits
# the tree-wide off and is byte-identical to pre-caveman behavior).
audit_fail=0
audit_total=0
while IFS= read -r line; do
  file="${line%%:*}"; rest="${line#*:}"; lineno="${rest%%:*}"; code="${rest#*:}"
  audit_total=$((audit_total + 1))
  # Inline-suppressed (parsed subcall): carries CAVEMAN_DEFAULT_MODE=off on this
  # line OR continued from the immediately-preceding line (\-continuation).
  if printf '%s' "$code" | grep -qE 'CAVEMAN_DEFAULT_MODE=off'; then
    continue
  fi
  # Line-continuation case: the env prefix is on the preceding line(s). Look back
  # up to 2 lines for a CAVEMAN_DEFAULT_MODE=off that ends with a backslash.
  prev=$(awk -v n="$lineno" 'NR>=n-2 && NR<n' "$file" 2>/dev/null)
  if printf '%s' "$prev" | grep -qE 'CAVEMAN_DEFAULT_MODE=off[[:space:]]*\\'; then
    continue
  fi
  # Named free-form ACTIVATION site: carries CAVEMAN_DEFAULT_MODE="$...level...".
  if printf '%s' "$code" | grep -qE 'CAVEMAN_DEFAULT_MODE="\$'; then
    continue
  fi
  # Activation bare-branch fallback: a plain `claude ...` that is the else of an
  # activation branch (inherits tree-wide off; documented at the two activation
  # sites in run.sh: worktree stream ~3067 and main RARV loop ~13121).
  if [ "$file" = "$RUN_SH" ] && printf '%s' "$code" | grep -qE 'claude "\$\{_loki_claude_argv\[@\]\}"|claude --dangerously-skip-permissions \\'; then
    continue
  fi
  # Anything left is an UNSUPPRESSED, UNNAMED parsed claude subcall -> moat leak.
  bad "tree-wide audit" "unsuppressed parsed claude subcall at $file:$lineno -> $code"
  audit_fail=$((audit_fail + 1))
done < <(
  for f in "${SHELL_SURFACE[@]}"; do
    grep -nE '(^|[^[:alnum:]_-])claude([[:space:]]|$)' "$f" 2>/dev/null \
      | grep -vE '#|command -v claude|which claude|claude auth status|claude CLI|Claude Code|claude-flags|claude\.sh|claude-session|claude_session|claude_flags|\.claude|--provider|Provider:|provider \(claude|\(claude default|supports the claude|for proc in' \
      | sed "s#^#$f:#"
  done
)
[ "$audit_fail" -eq 0 ] \
  && ok "tree-wide audit: all $audit_total claude invocations suppressed-or-named-activation (no moat leak)" \
  || bad "tree-wide audit" "$audit_fail unsuppressed parsed claude subcall(s) found"

# 6d. Non-vacuity for the audit: the audit must actually inspect invocations
#     (catch a silently-empty enumeration that would pass vacuously).
[ "$audit_total" -ge 8 ] \
  && ok "tree-wide audit non-vacuity: enumerated $audit_total claude invocations (>=8)" \
  || bad "audit non-vacuity" "expected >=8 enumerated invocations, got $audit_total"

# 6e. The three v7.41.0 missed sites are now explicitly covered (belt-and-suspenders
#     inline suppress, on top of the tree-wide export).
grep -qE 'CAVEMAN_DEFAULT_MODE=off claude' "$REPO_ROOT/autonomy/council-v2.sh" \
  && ok "council-v2.sh reviewer verdict suppresses caveman" \
  || bad "council-v2 suppress" "council-v2.sh subcall not suppressed"
grep -qE 'CAVEMAN_DEFAULT_MODE=off claude' "$REPO_ROOT/autonomy/lib/voter-agents.sh" \
  && ok "voter-agents.sh dispatch voter suppresses caveman" \
  || bad "voter-agents suppress" "voter-agents.sh subcall not suppressed"
grep -qE 'env CAVEMAN_DEFAULT_MODE=off claude' "$REPO_ROOT/autonomy/grill.sh" \
  && ok "grill.sh devil's-advocate suppresses caveman (env prefix via timeout)" \
  || bad "grill suppress" "grill.sh subcall not suppressed"

# 6f. The MAIN RARV loop activates conditionally via the helper (not unconditional).
grep -q 'loki_caveman_activate_env' "$RUN_SH" \
  && ok "run.sh: main loop uses loki_caveman_activate_env for free-form activation" \
  || bad "run.sh activate wiring" "main loop does not call loki_caveman_activate_env"

# 6g. No accidental EMPTY CAVEMAN_DEFAULT_MODE="" prefix (empty is NOT inert -- it
# would fall back to the user default). The activation path must branch instead.
if grep -qE 'CAVEMAN_DEFAULT_MODE="?"? *claude' "$RUN_SH"; then
  bad "no empty-mode footgun" "found a CAVEMAN_DEFAULT_MODE=\"\" claude prefix"
else
  ok "no empty CAVEMAN_DEFAULT_MODE prefix (empty-is-not-inert footgun avoided)"
fi

# ---------------------------------------------------------------------------
# 7. Cross-route parity with the TS mirror
# ---------------------------------------------------------------------------
grep -q 'return "off";' "$TS_FLAGS" \
  && ok "TS cavemanSuppressEnv returns \"off\" (parity)" \
  || bad "TS suppress parity" "TS mirror missing the off suppression value"
grep -q '"1.9.0"' "$TS_FLAGS" \
  && ok "TS version pin default 1.9.0 (parity)" \
  || bad "TS version parity" "TS mirror missing 1.9.0 default"
grep -q '"full"' "$TS_FLAGS" \
  && ok "TS level default full (parity)" \
  || bad "TS level parity" "TS mirror missing full default"

# ---------------------------------------------------------------------------
echo
echo "Caveman flag tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
[ "$FAIL" -eq 0 ]
