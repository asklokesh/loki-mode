#!/usr/bin/env bash
# autonomy/lib/claude-flags.sh -- Phase B (v7.5.19) helpers.
#
# Compute Claude Code CLI flag values automatically from existing Loki state.
# No new env vars introduced (per binding constraint: nothing user-facing changes).
# Every value derives from RARV tier, complexity score, and budget config.
#
# Public API (all functions are pure: they read env + filesystem, write stdout).
#   loki_effort_for_tier <tier> [complexity]    -- emit one of: low|medium|high|xhigh|max
#   loki_remaining_budget                        -- emit dollar amount remaining as plain int/float, OR empty when unlimited
#   loki_fallback_for_primary <model>           -- emit fallback model alias (opus->sonnet, sonnet->haiku if allowed), OR empty when no fallback applies
#   loki_claude_flag_supported <flag>           -- 0 if `claude --help` lists the flag, 1 otherwise
#
# All functions are side-effect free. The caller (providers/claude.sh, loki-ts) decides whether to pass the result.

# Guard against double-source.
if [ "${__LOKI_CLAUDE_FLAGS_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_CLAUDE_FLAGS_SH_LOADED=1

# ---------- Effort tier mapping ----------
# RARV tier names: planning (xhigh), development (high), fast (medium).
# Complexity shift: if the project is "complex", bump each tier one notch up.
# Honors LOKI_ALLOW_HAIKU=true semantics for the "fast" tier (medium stays medium; haiku is a separate model concept).
loki_effort_for_tier() {
    local tier="${1:-development}"
    local complexity="${2:-${LOKI_COMPLEXITY:-standard}}"
    local effort=""
    case "$tier" in
        planning)    effort="xhigh" ;;
        development) effort="high" ;;
        fast)        effort="medium" ;;
        # Capability aliases used elsewhere in the codebase.
        best)        effort="xhigh" ;;
        balanced)    effort="high" ;;
        cheap)       effort="low" ;;
        *)           effort="high" ;;
    esac
    # Complex projects get one bump up. "max" is the ceiling and only for explicit user override (not auto-bumped to from xhigh).
    if [ "$complexity" = "complex" ]; then
        case "$effort" in
            low)    effort="medium" ;;
            medium) effort="high" ;;
            high)   effort="xhigh" ;;
            # xhigh stays xhigh; max not auto-reached.
        esac
    fi
    printf '%s' "$effort"
}

# ---------- Remaining budget ----------
# Compute remaining budget = LOKI_BUDGET_LIMIT - cumulative spend so far.
# Spend lives in .loki/metrics/budget.json under "current_spend" (per autonomy/run.sh:8167+).
# Emit empty string when budget is unlimited (LOKI_BUDGET_LIMIT unset or 0).
# Emit empty when remaining <= 0 (caller decides what to do; we never emit 0).
loki_remaining_budget() {
    local limit="${LOKI_BUDGET_LIMIT:-}"
    # Empty or zero limit means no cap; emit nothing.
    if [ -z "$limit" ] || [ "$limit" = "0" ] || [ "$limit" = "0.0" ] || [ "$limit" = "0.00" ]; then
        return 0
    fi
    local budget_file="${TARGET_DIR:-.}/.loki/metrics/budget.json"
    local spend="0"
    if [ -f "$budget_file" ]; then
        spend=$(python3 -c "
import json, sys
try:
    with open('$budget_file') as f:
        d = json.load(f)
    v = d.get('current_spend', 0)
    print(float(v))
except Exception:
    print(0)
" 2>/dev/null)
    fi
    # Compute remaining via python3 (bash floats are unreliable across awk/bc variations).
    python3 -c "
import sys
try:
    limit = float('$limit')
    spend = float('$spend')
    rem = limit - spend
    # Strictly positive; otherwise emit nothing (caller decides whether to bail or warn).
    if rem > 0:
        # Round to 2 decimal places for the CLI.
        print(f'{rem:.2f}')
except Exception:
    pass
" 2>/dev/null
}

# ---------- Fallback model ----------
# Map primary model alias to a sensible fallback for `--fallback-model`.
# opus -> sonnet (always safe; sonnet is cheaper + similar capability)
# sonnet -> haiku ONLY when LOKI_ALLOW_HAIKU=true; else emit nothing
# haiku -> nothing (already at the bottom)
# Anything else (specific dated IDs, alt-provider names) -> nothing (no auto-fallback we can reason about)
loki_fallback_for_primary() {
    local primary="${1:-}"
    case "$primary" in
        opus)   printf '%s' "sonnet" ;;
        sonnet)
            if [ "${LOKI_ALLOW_HAIKU:-false}" = "true" ]; then
                printf '%s' "haiku"
            fi
            ;;
        # No fallback for haiku or other model names.
        *) ;;
    esac
}

# ---------- Flag-support detection ----------
# Returns 0 if `claude --help` lists the named flag, 1 otherwise.
# Cached per-process so we do not shell out N times per iteration.
loki_claude_flag_supported() {
    local flag="${1:-}"
    [ -z "$flag" ] && return 1
    # Per-process cache: __LOKI_CLAUDE_HELP_CACHE populated on first call.
    if [ -z "${__LOKI_CLAUDE_HELP_CACHE:-}" ]; then
        if command -v claude >/dev/null 2>&1; then
            __LOKI_CLAUDE_HELP_CACHE=$(claude --help 2>&1 || true)
        else
            __LOKI_CLAUDE_HELP_CACHE="__no_claude__"
        fi
        export __LOKI_CLAUDE_HELP_CACHE
    fi
    case "$__LOKI_CLAUDE_HELP_CACHE" in
        *"$flag"*) return 0 ;;
        *) return 1 ;;
    esac
}

# ---------- v7.33.0 cheap-subcall + reviewer-guard flag emitters ----------
# These centralize three Claude Code 2.1.170 embeds so every cheap NON-MAIN
# subcall site emits the same gated flags. Each emitter prints its flags to
# stdout (space-free per element via one-per-line is not needed; callers read
# them into an array with command substitution + word-splitting on the single
# token they emit, OR append the function output as additional argv elements).
# All are default-ON, opt-out via env, and gated on loki_claude_flag_supported
# so an older CLI degrades gracefully (emits nothing).

# EMBED 2 -- --bare (cheap NON-MAIN subcalls only). Minimal mode. Per
# `claude --help` it SKIPS hooks, LSP, plugin sync, attribution, auto-memory,
# background prefetches, keychain reads, and CLAUDE.md AUTO-discovery. It does
# NOT nullify explicit --mcp-config/--settings/--agents (the help lists those as
# the way to "explicitly provide context" UNDER --bare); what it drops is the
# IMPLICIT/auto-discovered context. Therefore --bare is ONLY safe on subcalls
# whose prompt is fully self-contained (the entire instruction set + context is
# passed via -p), and NEVER on the main RARV loop or on any call that relies on
# auto-discovered CLAUDE.md / hooks / auto-memory.
#
# AUTH GATE (critical): --bare sets CLAUDE_CODE_SIMPLE=1 and per `claude --help`
# reads Anthropic auth STRICTLY from ANTHROPIC_API_KEY or an apiKeyHelper via
# --settings -- "OAuth and keychain are never read". A subscription/OAuth user
# (no ANTHROPIC_API_KEY) gets "Not logged in" on every --bare subcall, which
# exits 0 with the error on stdout, so a council vote parses as the default
# REJECT and the loop silently corrupts. So --bare is enabled ONLY when an
# API-key auth path exists (ANTHROPIC_API_KEY set, or an apiKeyHelper configured
# in settings); otherwise it emits nothing and the subcall runs full-auth, the
# same as before this embed. Subscription users are thus unaffected by default.
# Default-ON (when auth-safe); opt out entirely with LOKI_BARE_SUBCALLS=0.
# Predicate so call sites can append "--bare" to their argv array uniformly:
#   loki_subcall_bare_enabled && argv+=("--bare")
loki_subcall_bare_enabled() {
    [ "${LOKI_BARE_SUBCALLS:-1}" = "0" ] && return 1
    # API-key auth required (see AUTH GATE above). ANTHROPIC_API_KEY is the
    # common case; apiKeyHelper covers the settings-configured helper. Anything
    # else (OAuth/keychain subscription) must NOT use --bare. Trim the key so a
    # whitespace-only value does not count as set (it would fail --bare auth).
    local _key
    _key="$(printf '%s' "${ANTHROPIC_API_KEY:-}" | tr -d '[:space:]')"
    if [ -z "$_key" ] && ! _loki_apikey_helper_configured; then
        return 1
    fi
    loki_claude_flag_supported "--bare"
}

# True when an apiKeyHelper is configured in any Claude settings source, which
# (unlike OAuth/keychain) IS honored under --bare. Best-effort, read-only.
_loki_apikey_helper_configured() {
    local f
    for f in "$HOME/.claude/settings.json" "$HOME/.config/claude/settings.json" \
             "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" \
             "$PWD/.claude/settings.json" "$PWD/.claude/settings.local.json"; do
        [ -f "$f" ] || continue
        # Require "apiKeyHelper" : "<non-empty value>" (a real key:value pair),
        # not the bare token in a comment/prose. Tolerates whitespace around the
        # colon. Not a full JSON parse, but rejects the obvious false-positives.
        grep -Eq '"apiKeyHelper"[[:space:]]*:[[:space:]]*"[^"]+"' "$f" 2>/dev/null && return 0
    done
    return 1
}

# EMBED 3 -- --disallowedTools (reviewer / adversarial subcalls). Motivation: a
# parallel agent once ran `git reset --hard` and wiped uncommitted work, so a
# reviewer/voter subcall should not casually mutate the tree. Per `claude --help`
# the value is a comma-or-space-separated list of tool names (e.g. "Bash(git *)
# Edit"); Bash(...) matching is command-PREFIX based (the `cmd:*` form).
#
# SCOPE / LIMITS (honest -- this is a denylist, NOT a sandbox):
#   - Denies the direct file-mutation tools (Edit, Write, NotebookEdit).
#   - Denies the common git MUTATION forms: the bare subcommand (`git reset:*`)
#     AND the global-flag-prefixed evasions (`git -C:*`, `git --git-dir:*`,
#     `git -c:*`) that slip a flag before the subcommand so the bare prefix
#     does not match. Read-only git (diff/log/show/status) stays allowed.
#   - It does NOT and cannot block every mutation path: a determined agent can
#     still write via `Bash(echo > f)`, `sed -i`, `cp/mv/tee`, `python -c`, etc.
#     This is a guardrail that raises the cost of the casual/common destructive
#     command, not a guarantee the tree is immutable. The real safety net is
#     that the integrator commits before any agent wave (see CLAUDE.md).
# The flag is variadic (<tools...>), so we emit ONE comma-separated token to
# avoid swallowing the following -p prompt as additional tool names.
# Default-ON; opt out with LOKI_REVIEW_TOOL_GUARD=0.
# Predicate + denylist so call sites append uniformly:
#   if loki_review_guard_enabled; then
#       argv+=("--disallowedTools" "$(loki_review_guard_denylist)")
#   fi
loki_review_guard_enabled() {
    [ "${LOKI_REVIEW_TOOL_GUARD:-1}" = "0" ] && return 1
    loki_claude_flag_supported "--disallowedTools"
}
loki_review_guard_denylist() {
    # Comma-separated single token. Bash(cmd:*) is command-prefix matching.
    # The `git -C:*` / `git --git-dir:*` / `git -c:*` entries close the
    # global-flag-before-subcommand evasion of the bare git-mutation rules.
    printf '%s' "Edit,Write,NotebookEdit,Bash(git commit:*),Bash(git reset:*),Bash(git push:*),Bash(git checkout:*),Bash(git clean:*),Bash(git rm:*),Bash(git stash:*),Bash(git -C:*),Bash(git --git-dir:*),Bash(git -c:*)"
}

# EMBED 3b (v7.35.0, GitHub #167) -- --allowedTools POSITIVE ALLOWLIST for the
# reviewer / adversarial / council subcalls. Complements the v7.33 denylist with
# a least-privilege grant: the value lists ONLY the read/inspect tools a voter
# needs (Read, Grep, Glob, read-only git, and a small set of read-only shell
# commands). Per `claude --help` and the official permission docs
# (https://code.claude.com/docs/en/cli-reference,
#  https://code.claude.com/docs/en/permissions) --allowedTools entries are
# permission ALLOW rules ("tools that execute without prompting"), using the same
# Tool / Tool(specifier) / Bash(cmd:*) prefix syntax as --disallowedTools.
#
# PRECEDENCE (proven empirically + documented): the docs state rules are
# "evaluated in order: deny, then ask, then allow ... the first match in that
# order determines the outcome", and "if a tool is denied at any level, no other
# level can allow it." Verified live against claude 2.1.177 on 2026-06-13 with a
# clean minimal env (temp git dir, --strict-mcp-config --mcp-config
# '{"mcpServers":{}}', --advisor opus to dodge the Fable-pinned default advisor
# tool, --tools "Bash,Read"):
#   - allow-only  Bash(git status:*)                -> PERMITTED  (control)
#   - deny-only   Bash(git status:*)                -> BLOCKED    (control)
#   - allow + deny BOTH on Bash(git status:*)       -> BLOCKED    (deny wins)
#   - allow + deny BOTH, under --dangerously-skip-permissions -> BLOCKED
# So DENY PRECEDENCE holds even in bypassPermissions mode (the mode every council
# subcall uses). This is the SAFE outcome: the allowlist and the denylist can be
# emitted TOGETHER. The denylist still blocks every mutation form even though the
# allowlist names read-only git; the allowlist additionally narrows the surface
# to least-privilege. They are NOT mutually exclusive; we ship both.
#
# This is a GUARDRAIL, not a sandbox (same caveat as the denylist): --allowedTools
# governs whether a tool runs WITHOUT A PROMPT, and these subcalls already run
# under --dangerously-skip-permissions, so the practical effect is to restrict the
# in-context tool surface to the allowlisted set while the denylist hard-blocks
# the dangerous forms. echo>/sed -i/python -c style writes are not enumerable and
# remain possible; the real net is commit-before-agent-wave (see CLAUDE.md).
#
# DEFAULT OFF (opt-in LOKI_REVIEW_ALLOWLIST=1) so the default argv on BOTH routes
# stays byte-identical to v7.34. Gated on CLI support so an older claude degrades
# gracefully (emits nothing). Predicate + token so call sites append uniformly:
#   if loki_review_allowlist_enabled; then
#       argv+=("--allowedTools" "$(loki_review_allowlist)")
#   fi
loki_review_allowlist_enabled() {
    [ "${LOKI_REVIEW_ALLOWLIST:-0}" = "1" ] || return 1
    loki_claude_flag_supported "--allowedTools"
}
loki_review_allowlist() {
    # Comma-separated single token (the flag is variadic; one token keeps the
    # following -p prompt from being swallowed as additional tool names). Grants
    # ONLY read/inspect tools: the file-read tools (Read/Grep/Glob), read-only
    # git (diff/log/show/status/ls-files/rev-parse/blame), and a small set of
    # read-only shell commands a reviewer uses to inspect the tree. No Edit,
    # Write, NotebookEdit, or any mutation form. Kept BYTE-IDENTICAL to
    # REVIEW_ALLOWLIST_TOKEN in loki-ts/src/providers/claude_flags.ts.
    printf '%s' "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*),Bash(git ls-files:*),Bash(git rev-parse:*),Bash(git blame:*),Bash(cat:*),Bash(ls:*),Bash(grep:*),Bash(rg:*),Bash(find:*),Bash(head:*),Bash(tail:*),Bash(wc:*)"
}

# ---------- v7.34.0 Claude session-id stamping (Phase 1, correlation-only) -----
# Derive a deterministic per-run UUID from the existing trust-run-id so the same
# run always maps to the same claude session UUID, and the bash + Bun routes
# produce BYTE-IDENTICAL uuids for the same run id. We use RFC-4122 UUIDv5
# (SHA-1 over a stable namespace + the name). The namespace below is a fixed,
# Loki-specific constant; never change it (changing it re-keys every run's uuid).
# The TS mirror is loki-ts/src/providers/claude_flags.ts claudeSessionUuid().
#
# Phase 1 is correlation-only: the uuid is written to a metadata file and (only
# when LOKI_SESSION_STAMP=1) emitted as a PER-ITERATION --session-id on the main
# loop. It NEVER pins one id across the run (that is Phase 2 continuity, which
# would accumulate transcript and compete with Loki's own injected memory).
LOKI_CLAUDE_SESSION_NS="b6f3c7a2-9d41-5e8b-9c2a-3f7d6e1a4b50"

# UUIDv5 over the Loki session namespace + an arbitrary name string. Pure
# (stdout only), deterministic, no side effects. Uses python3 (always present on
# the bash route; every other helper here already depends on it). Emits empty on
# any failure so the caller degrades to metadata-only without breaking the run.
_loki_uuid5() {
    local name="${1:-}"
    [ -z "$name" ] && return 0
    command -v python3 >/dev/null 2>&1 || return 0
    LOKI_CLAUDE_SESSION_NS="$LOKI_CLAUDE_SESSION_NS" _LOKI_UUID5_NAME="$name" \
    python3 - <<'UUID5_PY' 2>/dev/null || true
import os, uuid
ns = uuid.UUID(os.environ["LOKI_CLAUDE_SESSION_NS"])
print(uuid.uuid5(ns, os.environ["_LOKI_UUID5_NAME"]))
UUID5_PY
}

# The stable per-run claude session UUID: UUIDv5 of the trust-run-id. Same run
# id -> same uuid, on every route. Emits empty when no run id is resolvable.
_loki_claude_session_uuid() {
    local run_id="${1:-${LOKI_TRUST_RUN_ID:-}}"
    [ -z "$run_id" ] && return 0
    _loki_uuid5 "$run_id"
}

# The PER-ITERATION session UUID emitted on the main loop when LOKI_SESSION_STAMP=1.
# UUIDv5 of "<run-id>:<iteration>", so every iteration gets a DISTINCT, deterministic
# id. This is deliberately NOT the stable per-run uuid: a single pinned id reused
# across iterations would make claude RESUME (accumulate transcript), which is
# Phase 2 continuity, explicitly out of scope here. Distinct-per-iteration keeps
# each iteration a fresh stateless session (byte-identical default behavior to
# v7.33 except for the added correlation flag).
_loki_claude_iteration_session_uuid() {
    local run_id="${1:-${LOKI_TRUST_RUN_ID:-}}"
    local iteration="${2:-${ITERATION_COUNT:-0}}"
    [ -z "$run_id" ] && return 0
    _loki_uuid5 "${run_id}:${iteration}"
}

# Predicate: emit the per-iteration --session-id ARGV flag? CONSERVATIVE DEFAULT
# is OFF (metadata-file-only) so the default claude argv stays byte-identical to
# v7.33 (the UX-monotonicity requirement). Opt IN with LOKI_SESSION_STAMP=1.
# Gated on CLI support so an older claude degrades gracefully (no flag emitted).
loki_session_stamp_enabled() {
    [ "${LOKI_SESSION_STAMP:-0}" = "1" ] || return 1
    loki_claude_flag_supported "--session-id"
}

# ---------- v7.36.0 ultrareview (cloud multi-agent review) gates ----------
# `claude ultrareview [options] [target]` (Claude Code 2.1.x) runs a
# cloud-hosted multi-agent code review of the current branch / a PR number / a
# base branch and prints the findings. It is a PAID CLOUD operation billed by
# Anthropic, SEPARATE from local model spend, and can take up to 30 minutes.
#
# These two predicates are the ONLY policy surface for the optional `loki review
# --ultra` tier (issue #168). Both are read-only and side-effect-free.
#
# DESIGN (issue #168, architected):
#   - This is an EXPLICIT, on-demand user action (`loki review --ultra`), NEVER
#     an automatic completion-council voice. The council runs many times per
#     build; auto-running a paid cloud call there would be a silent-billing
#     footgun. The user typing "ultra" IS the consent signal; a confirmation
#     prompt (or --yes / LOKI_ULTRAREVIEW=1) is still required before any spend.
#   - There is NO price API, so we CANNOT show a dollar figure. We disclose the
#     cost-CLASS (paid cloud op) and require confirmation. Never claim to show
#     an estimated dollar amount here (that would be a lie).

# Capability gate: does the installed `claude` CLI ship the `ultrareview`
# subcommand? loki_claude_flag_supported greps `claude --help`, whose top-level
# command list includes "ultrareview", so it matches subcommands too. Returns 0
# when supported, 1 otherwise (so callers can emit an honest upgrade message).
loki_ultrareview_supported() {
    loki_claude_flag_supported "ultrareview"
}

# Non-interactive opt-in: is LOKI_ULTRAREVIEW=1 set? This is the env equivalent
# of passing --yes to THIS command only. It is deliberately NOT wired into the
# completion council or any auto path -- it only suppresses the interactive
# confirmation prompt for an explicit `loki review --ultra` invocation. Any
# other value (unset, 0, "true", etc.) returns 1 so only the exact "1" opts in.
loki_ultrareview_enabled() {
    [ "${LOKI_ULTRAREVIEW:-0}" = "1" ]
}
