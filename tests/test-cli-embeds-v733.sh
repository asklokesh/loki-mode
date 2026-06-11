#!/usr/bin/env bash
# tests/test-cli-embeds-v733.sh
#
# Stub-based proof for the v7.33.0 Claude Code 2.1.170 flag embeds on the BASH
# route. Three embeds, all gated through loki_claude_flag_supported, default-ON
# with env opt-outs:
#
#   EMBED 1  --strict-mcp-config       opt-out LOKI_STRICT_MCP=0
#   EMBED 2  --bare (cheap subcalls)   opt-out LOKI_BARE_SUBCALLS=0
#   EMBED 3  --disallowedTools (review) opt-out LOKI_REVIEW_TOOL_GUARD=0
#
# HONEST SCOPE: a stub `claude` on PATH records its argv to a file. These tests
# assert the FLAGS ARE PASSED at the right sites and ABSENT at the wrong ones,
# and that the opt-out env var kills each flag. They do NOT (cannot) verify the
# real Claude CLI enforces the deny list -- that is the ceiling of a stub test.
#
# Coverage:
#   - Helper predicate gating (loki_subcall_bare_enabled, loki_review_guard_*)
#     under supported / unsupported / opt-out conditions.
#   - EMBED 1 on the providers/claude.sh auto-flags builder (strict only with
#     mcp-config, never bare, opt-out honored, graceful degrade).
#   - EMBED 2 end-to-end through the REAL resolve_conflicts_with_ai() site,
#     driven against a real git merge conflict + a stub claude recording argv.
#   - Source-level structural invariants for the reviewer / adversarial sites
#     and the no-regression invariant: the MAIN RARV loop argv never gets --bare.
#
# Never touches port 57374, never spends, never pushes. trap-rm cleanup.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"
FLAGS_SH="$REPO_ROOT/autonomy/lib/claude-flags.sh"
LOADER_SH="$REPO_ROOT/providers/loader.sh"

PASS=0
FAIL=0
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok()  { PASS=$((PASS + 1)); echo -e "${GREEN}[PASS]${NC} $1"; }
bad() { FAIL=$((FAIL + 1)); echo -e "${RED}[FAIL]${NC} $1 -- ${2:-}"; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loki-embeds-v733-XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

# A stub `claude` that:
#   - on `claude --help`, advertises every embed flag so the flag-support probe
#     (loki_claude_flag_supported) reports them all available;
#   - otherwise records its full argv (one element per line, newline-delimited so
#     an argument containing spaces stays one element) to ARGV_LOG, emits a
#     deterministic non-empty body to stdout (so resolve_conflicts_with_ai takes
#     its [ -n "$resolution" ] branch), and exits 0.
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
ARGV_LOG="$TMP/claude-argv.log"
cat > "$STUB_BIN/claude" <<STUB
#!/usr/bin/env bash
case "\$1" in
  --help)
    cat <<'HELP'
  --bare                                Minimal mode
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --mcp-config <configs...>             Load MCP servers
  --disallowedTools, --disallowed-tools <tools...>  deny list
  --append-system-prompt <prompt>       append
  --effort <level>                      effort
  --setting-sources <sources>           sources
  --include-partial-messages            partial
HELP
    exit 0
    ;;
esac
: > "$ARGV_LOG"
for a in "\$@"; do printf '%s\n' "\$a" >> "$ARGV_LOG"; done
printf 'resolved by stub\n'
exit 0
STUB
chmod +x "$STUB_BIN/claude"

argv_has() { grep -qxF -e "$1" "$ARGV_LOG"; }

# ============================================================================
# Section A: helper-predicate gating (autonomy/lib/claude-flags.sh)
# ============================================================================
(
  PATH="$STUB_BIN:$PATH"
  unset __LOKI_CLAUDE_HELP_CACHE
  # shellcheck disable=SC1090
  . "$FLAGS_SH"

  # EMBED 2 predicate: enabled by default when --bare supported.
  unset LOKI_BARE_SUBCALLS
  unset __LOKI_CLAUDE_HELP_CACHE
  # AUTH GATE (council R1 CRITICAL): --bare reads auth strictly from
  # ANTHROPIC_API_KEY/apiKeyHelper, never OAuth/keychain. Default-on must be
  # DISABLED on a subscription machine (no key, no helper) and ENABLED with a key.
  HOME="$TMP/nohelper"; mkdir -p "$HOME/.claude"
  unset ANTHROPIC_API_KEY
  if loki_subcall_bare_enabled; then echo "A1_BAD"; else echo "A1_OK"; fi
  if ANTHROPIC_API_KEY=sk-test loki_subcall_bare_enabled; then echo "A1b_OK"; else echo "A1b_BAD"; fi
  # apiKeyHelper in settings also enables it (the helper auth path --bare honors).
  printf '{"apiKeyHelper":"echo k"}' > "$HOME/.claude/settings.json"
  if loki_subcall_bare_enabled; then echo "A1c_OK"; else echo "A1c_BAD"; fi
  # the bare token in prose (no key:value) must NOT enable (council R2 tighten).
  printf '{"note":"set apiKeyHelper later"}' > "$HOME/.claude/settings.json"
  if loki_subcall_bare_enabled; then echo "A1d_BAD"; else echo "A1d_OK"; fi
  rm -f "$HOME/.claude/settings.json"
  # whitespace-only key must NOT enable (council R2 tighten).
  if ANTHROPIC_API_KEY="   " loki_subcall_bare_enabled; then echo "A1e_BAD"; else echo "A1e_OK"; fi
  # opt-out kills it even with a key.
  if ANTHROPIC_API_KEY=sk-test LOKI_BARE_SUBCALLS=0 loki_subcall_bare_enabled; then echo "A2_BAD"; else echo "A2_OK"; fi
  unset LOKI_BARE_SUBCALLS

  # EMBED 3 predicate: enabled by default when --disallowedTools supported.
  unset LOKI_REVIEW_TOOL_GUARD
  if loki_review_guard_enabled; then echo "A3_OK"; else echo "A3_BAD"; fi
  LOKI_REVIEW_TOOL_GUARD=0
  if loki_review_guard_enabled; then echo "A4_BAD"; else echo "A4_OK"; fi
  unset LOKI_REVIEW_TOOL_GUARD

  # Deny list content: mutating tools denied, read-only git NOT denied.
  dl="$(loki_review_guard_denylist)"
  case "$dl" in *Edit*) echo "A5a_OK";; *) echo "A5a_BAD";; esac
  case "$dl" in *Write*) echo "A5b_OK";; *) echo "A5b_BAD";; esac
  case "$dl" in *NotebookEdit*) echo "A5c_OK";; *) echo "A5c_BAD";; esac
  case "$dl" in *"Bash(git reset:*)"*) echo "A5d_OK";; *) echo "A5d_BAD";; esac
  case "$dl" in *"Bash(git push:*)"*) echo "A5e_OK";; *) echo "A5e_BAD";; esac
  # #570 hardening: the global-flag-before-subcommand evasion (git -C / --git-dir
  # / -c) must also be denied, else `git -C . reset --hard` slips past the bare
  # git-mutation rules (verified against the real CLI).
  case "$dl" in *"Bash(git -C:*)"*) echo "A5f_OK";; *) echo "A5f_BAD";; esac
  case "$dl" in *"Bash(git --git-dir:*)"*) echo "A5g_OK";; *) echo "A5g_BAD";; esac
  # Read-only git inspection must remain allowed.
  case "$dl" in *"git diff"*|*"git log"*|*"git show"*|*"git status"*) echo "A6_BAD";; *) echo "A6_OK";; esac
) > "$TMP/secA.out" 2>/dev/null

check_tok() { # marker label
  if grep -qx "$1" "$TMP/secA.out"; then ok "$2"; else bad "$2" "marker $1 not found"; fi
}
check_tok A1_OK "EMBED2 --bare DISABLED on subscription auth (no API key/helper) -- council R1"
check_tok A1b_OK "EMBED2 --bare ENABLED when ANTHROPIC_API_KEY is set"
check_tok A1c_OK "EMBED2 --bare ENABLED when an apiKeyHelper is configured"
check_tok A1d_OK "EMBED2 --bare NOT enabled by the bare apiKeyHelper token in prose"
check_tok A1e_OK "EMBED2 --bare NOT enabled by a whitespace-only ANTHROPIC_API_KEY"
check_tok A2_OK "EMBED2 predicate OFF when LOKI_BARE_SUBCALLS=0 (even with a key)"
check_tok A3_OK "EMBED3 predicate ON by default when --disallowedTools supported"
check_tok A4_OK "EMBED3 predicate OFF when LOKI_REVIEW_TOOL_GUARD=0"
check_tok A5a_OK "EMBED3 deny list contains Edit"
check_tok A5b_OK "EMBED3 deny list contains Write"
check_tok A5c_OK "EMBED3 deny list contains NotebookEdit"
check_tok A5d_OK "EMBED3 deny list contains Bash(git reset:*)"
check_tok A5e_OK "EMBED3 deny list contains Bash(git push:*)"
check_tok A5f_OK "EMBED3 deny list closes the git -C evasion"
check_tok A5g_OK "EMBED3 deny list closes the git --git-dir evasion"
check_tok A6_OK "EMBED3 deny list does NOT block read-only git (diff/log/show/status)"

# Graceful-degrade: when --bare / --disallowedTools are NOT in help, predicates fail.
(
  DEGRADE_BIN="$TMP/degrade-bin"
  mkdir -p "$DEGRADE_BIN"
  cat > "$DEGRADE_BIN/claude" <<'DST'
#!/usr/bin/env bash
case "$1" in --help) printf '  --effort <level>  effort\n'; exit 0;; esac
exit 0
DST
  chmod +x "$DEGRADE_BIN/claude"
  PATH="$DEGRADE_BIN:$PATH"
  unset __LOKI_CLAUDE_HELP_CACHE LOKI_BARE_SUBCALLS LOKI_REVIEW_TOOL_GUARD
  # shellcheck disable=SC1090
  . "$FLAGS_SH"
  if loki_subcall_bare_enabled; then echo "A7_BAD"; else echo "A7_OK"; fi
  if loki_review_guard_enabled; then echo "A8_BAD"; else echo "A8_OK"; fi
) > "$TMP/secA2.out" 2>/dev/null
if grep -qx A7_OK "$TMP/secA2.out"; then ok "EMBED2 degrades gracefully (no --bare in help -> OFF)"; else bad "EMBED2 graceful degrade" "marker missing"; fi
if grep -qx A8_OK "$TMP/secA2.out"; then ok "EMBED3 degrades gracefully (no --disallowedTools in help -> OFF)"; else bad "EMBED3 graceful degrade" "marker missing"; fi

# ============================================================================
# Section B: EMBED 1 -- --strict-mcp-config on providers/claude.sh auto-flags
# ============================================================================
# Build the auto-flags array with the mcp-config helper made to emit a path, and
# assert strict appears only alongside mcp-config, after it, and honors opt-out.
run_autoflags() { # env-assignments... -> prints _LOKI_CLAUDE_AUTO_FLAGS one-per-line
  PATH="$STUB_BIN:$PATH" bash -c '
    set -uo pipefail
    unset __LOKI_CLAUDE_HELP_CACHE
    # shellcheck disable=SC1090
    . "'"$LOADER_SH"'" >/dev/null 2>&1
    load_provider claude >/dev/null 2>&1
    # Force the mcp-config helper to emit a deterministic path so the
    # --mcp-config branch is taken regardless of filesystem state.
    loki_mcp_config_argv() { printf "%s" "'"$TMP"'/mcp-bundle.json"; }
    _loki_build_claude_auto_flags development standard opus
    printf "%s\n" "${_LOKI_CLAUDE_AUTO_FLAGS[@]}"
  ' 2>/dev/null
}

OUT_DEFAULT="$(unset LOKI_STRICT_MCP; run_autoflags)"
if printf '%s\n' "$OUT_DEFAULT" | grep -qx -- '--mcp-config' \
   && printf '%s\n' "$OUT_DEFAULT" | grep -qx -- '--strict-mcp-config'; then
  ok "EMBED1: --strict-mcp-config emitted alongside --mcp-config (default ON)"
else
  bad "EMBED1: default-on strict" "got: $(printf '%s ' $OUT_DEFAULT)"
fi
# strict must come AFTER an emitted --mcp-config (never bare/standalone).
mcp_line=$(printf '%s\n' "$OUT_DEFAULT" | grep -nx -- '--mcp-config' | head -1 | cut -d: -f1)
strict_line=$(printf '%s\n' "$OUT_DEFAULT" | grep -nx -- '--strict-mcp-config' | head -1 | cut -d: -f1)
if [ -n "$mcp_line" ] && [ -n "$strict_line" ] && [ "$strict_line" -gt "$mcp_line" ]; then
  ok "EMBED1: --strict-mcp-config positioned after --mcp-config (never bare)"
else
  bad "EMBED1: strict positioned after mcp-config" "mcp=$mcp_line strict=$strict_line"
fi

OUT_OPTOUT="$(LOKI_STRICT_MCP=0 run_autoflags)"
if printf '%s\n' "$OUT_OPTOUT" | grep -qx -- '--mcp-config' \
   && ! printf '%s\n' "$OUT_OPTOUT" | grep -qx -- '--strict-mcp-config'; then
  ok "EMBED1: LOKI_STRICT_MCP=0 suppresses strict, keeps --mcp-config"
else
  bad "EMBED1: opt-out" "got: $(printf '%s ' $OUT_OPTOUT)"
fi

# ============================================================================
# Section C: EMBED 2 end-to-end through resolve_conflicts_with_ai()
# ============================================================================
# Build a real merge conflict, source run.sh, run the real function with a stub
# claude, and assert --bare lands in the recorded argv (and the opt-out kills it).
make_conflict_repo() { # dir
  local d="$1"
  mkdir -p "$d"
  (
    cd "$d" || exit 1
    git init -q
    git config user.email t@t; git config user.name t
    printf 'line1\nbase\nline3\n' > f.txt
    git add f.txt; git commit -qm base
    git checkout -q -b feature
    printf 'line1\nfeature-change\nline3\n' > f.txt
    git add f.txt; git commit -qm feature
    git checkout -q main 2>/dev/null || git checkout -q master 2>/dev/null
    printf 'line1\nmain-change\nline3\n' > f.txt
    git add f.txt; git commit -qm main
    git merge feature -q >/dev/null 2>&1 || true   # produces conflict in f.txt
  ) >/dev/null 2>&1
}

drive_conflict() { # extra-env -> records argv to ARGV_LOG
  local repo="$TMP/conflict-$RANDOM"
  make_conflict_repo "$repo"
  PATH="$STUB_BIN:$PATH" bash -c '
    set -uo pipefail
    cd "'"$repo"'" || exit 1
    unset __LOKI_CLAUDE_HELP_CACHE
    export PROVIDER_NAME=claude
    # shellcheck disable=SC1090
    . "'"$LOADER_SH"'" >/dev/null 2>&1
    load_provider claude >/dev/null 2>&1
    # shellcheck disable=SC1090
    . "'"$RUN_SH"'" >/dev/null 2>&1
    resolve_conflicts_with_ai testfeature >/dev/null 2>&1 || true
  ' >/dev/null 2>&1
}

: > "$ARGV_LOG"
# ANTHROPIC_API_KEY set so the auth gate (council R1) enables --bare; on a
# subscription/OAuth runner without it, --bare is correctly suppressed (tested
# by A1 above), and asserting its presence here would be a false negative.
( unset LOKI_BARE_SUBCALLS; export ANTHROPIC_API_KEY=sk-test; drive_conflict )
if [ -s "$ARGV_LOG" ]; then
  if argv_has "--bare"; then
    ok "EMBED2: resolve_conflicts_with_ai passes --bare (default ON + API key, real site)"
  else
    bad "EMBED2: conflict --bare default-on" "argv: $(tr '\n' ' ' < "$ARGV_LOG")"
  fi
  if argv_has "-p" && argv_has "--dangerously-skip-permissions"; then
    ok "EMBED2: conflict argv still self-contained (-p + skip-permissions present)"
  else
    bad "EMBED2: conflict argv shape" "argv: $(tr '\n' ' ' < "$ARGV_LOG")"
  fi
else
  bad "EMBED2: conflict harness invoked stub claude" "ARGV_LOG empty -- function did not reach claude"
fi

: > "$ARGV_LOG"
( export LOKI_BARE_SUBCALLS=0; drive_conflict )
if [ -s "$ARGV_LOG" ]; then
  if argv_has "--bare"; then
    bad "EMBED2: opt-out conflict" "argv unexpectedly contains --bare"
  else
    ok "EMBED2: LOKI_BARE_SUBCALLS=0 removes --bare from conflict argv"
  fi
else
  bad "EMBED2: opt-out conflict harness invoked stub claude" "ARGV_LOG empty"
fi

# ============================================================================
# Section D: source-level structural invariants
# ============================================================================
# These assert each remaining site is wired to the helpers in the source, and
# the MAIN RARV loop argv is NEVER given --bare (the wrong-site guard).

# Reviewer council site (run_code_review, ~7806) appends --bare AND the guard.
rv_block=$(awk '/SECURITY-REVIEW MODEL GUARD/{f=1} f{print} /-p "\$prompt_text"/{if(f)exit}' "$RUN_SH")
if printf '%s' "$rv_block" | grep -q 'loki_subcall_bare_enabled' \
   && printf '%s' "$rv_block" | grep -q '_rv_argv+=("--bare")'; then
  ok "EMBED2: reviewer council site appends --bare via helper"
else
  bad "EMBED2: reviewer site --bare wiring" "block did not show helper + --bare"
fi
if printf '%s' "$rv_block" | grep -q 'loki_review_guard_enabled' \
   && printf '%s' "$rv_block" | grep -q 'loki_review_guard_denylist'; then
  ok "EMBED3: reviewer council site appends --disallowedTools via guard helper"
else
  bad "EMBED3: reviewer site guard wiring" "block did not show guard helper"
fi

# Adversarial site (run_adversarial_testing, ~8019) appends --bare AND the guard.
adv_block=$(awk '/Adversarial probe subcall/{f=1} f{print} /-p "\$adversarial_prompt"/{if(f)exit}' "$RUN_SH")
if printf '%s' "$adv_block" | grep -q '_adv_argv+=("--bare")' \
   && printf '%s' "$adv_block" | grep -q 'loki_review_guard_denylist'; then
  ok "EMBED2+3: adversarial site appends --bare + --disallowedTools"
else
  bad "EMBED2+3: adversarial site wiring" "block did not show both"
fi

# USAGE-regen site (_intelligent_usage_regen, ~10046) appends --bare, NOT guard.
usage_block=$(awk '/USAGE.md-regen prompt/{f=1} f{print} /claude "\$\{_ic_argv\[@\]\}" -p -/{if(f)exit}' "$RUN_SH")
if printf '%s' "$usage_block" | grep -q '_ic_argv+=("--bare")'; then
  ok "EMBED2: USAGE-regen site appends --bare via helper"
else
  bad "EMBED2: USAGE-regen --bare wiring" "block did not show --bare"
fi
if printf '%s' "$usage_block" | grep -q 'disallowedTools'; then
  bad "EMBED3: USAGE-regen must NOT carry the review guard" "guard unexpectedly present on non-reviewer"
else
  ok "EMBED3: USAGE-regen site correctly carries NO review guard (not a reviewer)"
fi

# MAIN RARV loop argv (_loki_claude_argv -> `claude "${_loki_claude_argv[@]}" -p`)
# must NEVER receive --bare. Extract the main-loop argv construction region.
main_block=$(awk '/local _loki_claude_argv=\(/{f=1} f{print} /claude "\$\{_loki_claude_argv\[@\]\}" -p "\$prompt"/{if(f)exit}' "$RUN_SH")
if [ -n "$main_block" ] && ! printf '%s' "$main_block" | grep -q '\-\-bare'; then
  ok "EMBED2 WRONG-SITE GUARD: main RARV loop argv never gets --bare"
else
  bad "EMBED2 WRONG-SITE GUARD" "main loop block missing or contains --bare"
fi
if [ -n "$main_block" ] && ! printf '%s' "$main_block" | grep -q 'disallowedTools'; then
  ok "EMBED3 WRONG-SITE GUARD: main RARV loop argv never gets --disallowedTools"
else
  bad "EMBED3 WRONG-SITE GUARD" "main loop block missing or contains --disallowedTools"
fi

# Additional council / adversarial reviewer sites discovered by full grep of
# autonomy/ (completion-council.sh x2, council-v2.sh, grill.sh). Each is a
# self-contained reviewer/adversarial subcall and must carry BOTH embeds.
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
COUNCILV2_SH="$REPO_ROOT/autonomy/council-v2.sh"
GRILL_SH="$REPO_ROOT/autonomy/grill.sh"

# completion-council.sh: member vote (_cm_argv) and contrarian vote (_co_argv).
for tag in _cm_argv _co_argv; do
  if grep -q "${tag}+=(\"--bare\")" "$COUNCIL_SH" \
     && grep -q "${tag}+=(\"--disallowedTools\" \"\$(loki_review_guard_denylist)\")" "$COUNCIL_SH"; then
    ok "EMBED2+3: completion-council.sh ${tag} appends --bare + --disallowedTools"
  else
    bad "EMBED2+3: completion-council.sh ${tag} wiring" "tag block missing flags"
  fi
done

# council-v2.sh: reviewer verdict (_c2_argv).
if grep -q '_c2_argv+=("--bare")' "$COUNCILV2_SH" \
   && grep -q '_c2_argv+=("--disallowedTools" "$(loki_review_guard_denylist)")' "$COUNCILV2_SH"; then
  ok "EMBED2+3: council-v2.sh reviewer verdict appends --bare + --disallowedTools"
else
  bad "EMBED2+3: council-v2.sh wiring" "_c2_argv block missing flags"
fi

# grill.sh: devil's-advocate grill (_gr_argv) + sources the flags helper.
if grep -q '_gr_argv+=("--bare")' "$GRILL_SH" \
   && grep -q '_gr_argv+=("--disallowedTools" "$(loki_review_guard_denylist)")' "$GRILL_SH"; then
  ok "EMBED2+3: grill.sh appends --bare + --disallowedTools"
else
  bad "EMBED2+3: grill.sh wiring" "_gr_argv block missing flags"
fi
# grill.sh must source the flags helper so the embeds actually fire standalone.
if grep -q 'lib/claude-flags.sh' "$GRILL_SH"; then
  ok "EMBED2+3: grill.sh sources claude-flags.sh (helpers in scope standalone)"
else
  bad "EMBED2+3: grill.sh helper source" "grill.sh does not source claude-flags.sh"
fi

# End-to-end: sourcing grill.sh brings the embed helpers into scope.
(
  PATH="$STUB_BIN:$PATH"
  unset __LOKI_CLAUDE_HELP_CACHE
  # shellcheck disable=SC1090
  . "$GRILL_SH" >/dev/null 2>&1
  if type loki_subcall_bare_enabled >/dev/null 2>&1 && type loki_review_guard_enabled >/dev/null 2>&1; then
    echo "G_OK"
  else
    echo "G_BAD"
  fi
) > "$TMP/grill-src.out" 2>/dev/null
if grep -qx G_OK "$TMP/grill-src.out"; then
  ok "EMBED2+3: grill.sh sourcing makes embed helpers callable (live-path proof)"
else
  bad "EMBED2+3: grill.sh helper availability" "helpers not in scope after sourcing grill.sh"
fi

# Parallel-worktree dev spawn (~3048) must NOT get --bare (relies on CONTINUITY.md).
wt_line=$(grep -n 'Read .loki/CONTINUITY.md for context.' "$RUN_SH" | head -1 | cut -d: -f1)
if [ -n "$wt_line" ]; then
  wt_region=$(awk -v L="$wt_line" 'NR>=L-3 && NR<=L+1' "$RUN_SH")
  if ! printf '%s' "$wt_region" | grep -q '\-\-bare'; then
    ok "EMBED2 SKIP: parallel-worktree dev spawn correctly NOT given --bare"
  else
    bad "EMBED2 SKIP worktree" "worktree spawn unexpectedly has --bare"
  fi
else
  bad "EMBED2 SKIP worktree" "could not locate worktree spawn site"
fi

echo
echo "======================================================================"
echo "test-cli-embeds-v733: $PASS passed, $FAIL failed"
echo "======================================================================"
[ "$FAIL" -eq 0 ]
