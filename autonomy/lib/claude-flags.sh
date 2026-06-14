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
# DEFAULT ON (safety-additive least-privilege; opt OUT with LOKI_REVIEW_ALLOWLIST=0).
# Flipped default-on because deny precedence (verified live) means the denylist
# still hard-blocks every mutation form while this allowlist only narrows the
# reviewer surface to read/inspect tools -- pure safety win, no surprise spend, no
# egress. The escape hatch (LOKI_REVIEW_ALLOWLIST=0) restores the prior off state.
# Gated on CLI support so an older claude degrades gracefully (emits nothing).
# Predicate + token so call sites append uniformly:
#   if loki_review_allowlist_enabled; then
#       argv+=("--allowedTools" "$(loki_review_allowlist)")
#   fi
loki_review_allowlist_enabled() {
    [ "${LOKI_REVIEW_ALLOWLIST:-1}" = "0" ] && return 1
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

# ---------- v7.38.0 Dynamic Workflows (ultracode) gates ----------
# Claude Code "Dynamic Workflows" are JS orchestration scripts Claude writes that
# fan out into many background subagents. They are triggered by the `ultracode`
# keyword in a prompt and fire under `claude -p` (verified empirically: a headless
# workflow returned "The workflow finished"). They are:
#   - Claude-PROVIDER-ONLY (no Codex/Cline/Aider equivalent),
#   - require claude CLI >= 2.1.154,
#   - cost meaningfully MORE than a normal run (a trivial workflow observed at
#     ~$0.71 vs ~$0.01 for a plain read; there is NO price API so we never quote
#     a dollar figure -- we disclose the cost CLASS only),
#   - disablable via CLAUDE_CODE_DISABLE_WORKFLOWS=1 or the `disableWorkflows`
#     setting in any Claude settings.json.
#
# These predicates mirror loki_ultrareview_supported/enabled exactly: read-only,
# side-effect free, the ONLY policy surface for the optional `loki ultracode`
# passthrough and the Phase 2 opt-in analysis dispatch. The user typing
# `loki ultracode` (or setting LOKI_USE_CLAUDE_WORKFLOWS=1) IS the consent signal.

# Minimum claude CLI version that ships Dynamic Workflows.
LOKI_WORKFLOWS_MIN_VERSION="${LOKI_WORKFLOWS_MIN_VERSION:-2.1.154}"

# Parse the installed claude CLI semantic version (e.g. "2.1.177") to stdout, or
# empty on any failure. Mirrors the `claude --version | sed` pattern already used
# at autonomy/loki:7888. Cached per-process so we do not shell out repeatedly.
_loki_claude_version() {
    if [ -z "${__LOKI_CLAUDE_VERSION_CACHE:-}" ]; then
        if command -v claude >/dev/null 2>&1; then
            __LOKI_CLAUDE_VERSION_CACHE="$(claude --version 2>/dev/null | head -1 | sed 's/[^0-9.]//g' | head -1)"
        fi
        # Sentinel so an empty real result does not re-shell every call.
        __LOKI_CLAUDE_VERSION_CACHE="${__LOKI_CLAUDE_VERSION_CACHE:-__none__}"
        export __LOKI_CLAUDE_VERSION_CACHE
    fi
    [ "$__LOKI_CLAUDE_VERSION_CACHE" = "__none__" ] && return 0
    printf '%s' "$__LOKI_CLAUDE_VERSION_CACHE"
}

# Dotted-version >= compare: returns 0 when $1 >= $2, 1 otherwise. Pure, no
# external tools beyond awk (always present). Pads missing components with 0.
_loki_version_ge() {
    local have="${1:-}" want="${2:-}"
    [ -z "$have" ] && return 1
    [ -z "$want" ] && return 0
    awk -v a="$have" -v b="$want" '
    function cmp(x, y,   na, nb, i, n, xi, yi) {
        na = split(x, A, ".")
        nb = split(y, B, ".")
        n = (na > nb) ? na : nb
        for (i = 1; i <= n; i++) {
            xi = (i <= na) ? A[i] + 0 : 0
            yi = (i <= nb) ? B[i] + 0 : 0
            if (xi > yi) return 1
            if (xi < yi) return -1
        }
        return 0
    }
    BEGIN { exit (cmp(a, b) >= 0) ? 0 : 1 }
    '
}

# True when CLAUDE_CODE_DISABLE_WORKFLOWS=1 OR a `disableWorkflows` setting is
# active in any Claude settings source. Best-effort, read-only (not a full JSON
# parse, but rejects the obvious cases). Returns 0 (disabled) / 1 (not disabled).
_loki_workflows_disabled() {
    [ "${CLAUDE_CODE_DISABLE_WORKFLOWS:-0}" = "1" ] && return 0
    local f
    for f in "$HOME/.claude/settings.json" "$HOME/.config/claude/settings.json" \
             "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" \
             "$PWD/.claude/settings.json" "$PWD/.claude/settings.local.json"; do
        [ -f "$f" ] || continue
        # Match "disableWorkflows": true (tolerating whitespace around the colon).
        grep -Eq '"disableWorkflows"[[:space:]]*:[[:space:]]*true' "$f" 2>/dev/null && return 0
    done
    return 1
}

# Capability gate: is the active provider Claude AND the claude CLI present AND
# version >= the workflows minimum AND workflows not disabled? Returns 0 when
# workflows can run, 1 otherwise (so callers emit an honest message + clean exit).
loki_workflows_supported() {
    # Provider must be Claude (Tier 1). Workflows are Claude-only.
    [ "${LOKI_PROVIDER:-claude}" = "claude" ] || return 1
    command -v claude >/dev/null 2>&1 || return 1
    _loki_workflows_disabled && return 1
    local ver
    ver="$(_loki_claude_version)"
    _loki_version_ge "$ver" "$LOKI_WORKFLOWS_MIN_VERSION" || return 1
    return 0
}

# Non-interactive opt-in: is LOKI_USE_CLAUDE_WORKFLOWS=1 set? This is the env knob
# that turns ON the Phase 2 read-only-analysis workflow dispatch. Default OFF. Any
# value other than the exact "1" returns 1 so only an explicit opt-in counts. This
# is independent of the `loki ultracode` passthrough (which is itself an explicit
# user invocation and does not require this flag).
loki_workflows_enabled() {
    [ "${LOKI_USE_CLAUDE_WORKFLOWS:-0}" = "1" ]
}

# ---------- v7.x caveman output-token compressor gates ----------
# caveman (https://github.com/JuliusBrussee/caveman, MIT, vendor-less pin) is a
# Claude Code SKILL + SessionStart hook that instructs the model to compress its
# OUTPUT TOKENS only (prose style: lite / full / ultra / wenyan), keeping all
# technical substance. It wraps NO API, needs NO key, has NO network of its own.
# Once installed it activates GLOBALLY in Claude Code via a SessionStart hook
# that reads getDefaultMode() (env CAVEMAN_DEFAULT_MODE > repo .caveman config >
# user config > "full") and, unless the mode is "off", injects its ruleset.
#
# THE MOAT RISK (central, why this is wired the way it is): Loki's trust gates
# parse EXACT model prose -- council "VOTE: APPROVE|REJECT|CANNOT_VALIDATE", code
# review "^VERDICT:", the legacy completion-promise grep, the evidence-gate
# sentinels. A globally-active caveman would compress those subcall outputs and
# silently flip a verdict to the default (REJECT / not-complete), corrupting the
# loop. This is the same failure class as the --bare OAuth footgun documented at
# claude-flags.sh:152-161.
#
# THE DESIGN (off by construction, not by convention):
#   - ACTIVATE compression only on FREE-FORM generation (main RARV dev loop +
#     read-only codebase-analysis): inline `CAVEMAN_DEFAULT_MODE=<level> claude`.
#   - HARD-SUPPRESS on EVERY parsed-output subcall (council vote, ^VERDICT:
#     review, adversarial probe, conflict-merge, USAGE regen): inline
#     `CAVEMAN_DEFAULT_MODE=off claude`. The activate hook then deletes its flag
#     and emits nothing (verified: `CAVEMAN_DEFAULT_MODE=off node
#     caveman-activate.js` prints "OK" with no ruleset).
#
# Suppression is UNCONDITIONAL and UNGATED (see loki_caveman_suppress_env): it is
# a harmless no-op env value when caveman is absent and the essential carve-out
# when caveman is globally present (surface b, or a user's own install) even with
# LOKI_CAVEMAN=0. NEVER gate suppression on supported/enabled -- that would leave
# the trust gates unprotected exactly when a user has caveman on but Loki off.
#
# Disclosure (honest, no fabricated figures): caveman compresses OUTPUT tokens
# only, not input/thinking; savings are real but bounded. There is no price API,
# so we disclose the savings CLASS, never a dollar amount (same posture as the
# ultrareview/workflows gates).

# Version pin (vendor-less). Upgrade by bumping this. The upstream installer pins
# its hook downloads to PINNED_REF = CAVEMAN_REF || 'v1.9.0' (a git tag), and the
# curl|bash path delegates to `npx -y github:JuliusBrussee/caveman#<ref>`. We
# default to 1.9.0 and derive the `v`-prefixed tag in the bootstrap helper.
LOKI_CAVEMAN_VERSION="${LOKI_CAVEMAN_VERSION:-1.9.0}"

# The compression level for free-form activation. Maps directly to caveman's
# CAVEMAN_DEFAULT_MODE values: lite | full | ultra | wenyan | wenyan-lite |
# wenyan-full | wenyan-ultra. Never "off" here -- "off" is the suppression value,
# not an activation level.
#
# v7.x #593 -- INTELLIGENT AUTO-SELECTION (no new user knob): when the user does
# NOT set LOKI_CAVEMAN_LEVEL explicitly, the level is INFERRED per-invocation from
# the run's existing RARV-tier signal (see _loki_caveman_infer_level). When the
# user DOES set it, that value overrides the inference entirely (opt-out escape
# hatch). Capture set-ness BEFORE the ":-full" default clobbers it -- once the
# default fills the var, "user set full" and "defaulted to full" are
# indistinguishable, so the inference would silently never fire. ${var+set} is
# non-empty only when the var was genuinely set (even to empty). The "full"
# default is kept so the public var still reads "full" for external readers and
# so a child re-source re-derives USERSET correctly (unexported default).
if [ -z "${LOKI_CAVEMAN_LEVEL_USERSET+x}" ]; then
    LOKI_CAVEMAN_LEVEL_USERSET="${LOKI_CAVEMAN_LEVEL+set}"
fi
LOKI_CAVEMAN_LEVEL="${LOKI_CAVEMAN_LEVEL:-full}"

# ---------- DEFAULT-SUPPRESS: off by construction, tree-wide ----------
# THE MOAT GUARANTEE (v7.41.0 council fix): instead of hand-enumerating every
# parsed-output trust-gate subcall and remembering to prefix each with
# CAVEMAN_DEFAULT_MODE=off (a missed site silently corrupts a verdict -- caveman
# exits 0 with mangled prose and the `|| REJECT` fallback never fires), we flip
# the ENTIRE process tree to suppressed at the one module every tree sources.
#
# claude-flags.sh is sourced by EVERY tree that can spawn a parsed claude
# subcall: the run.sh orchestrator (via providers/claude.sh), grill.sh (standalone
# `loki grill`), lib/voter-agents.sh (Phase C agent-dispatch voters), and the
# loki standalone review/workflows commands (on-demand). council-v2.sh carries no
# source of its own but only ever runs inside completion-council.sh, which is in
# the run.sh tree, so it inherits this export too. Exporting off HERE makes the
# whole spawned subprocess tree inherit suppression -- caveman's SessionStart
# hook reads process.env CAVEMAN_DEFAULT_MODE -- closing council-v2.sh,
# voter-agents.sh, grill.sh, every existing parsed subcall, and any FUTURE one by
# construction. ACTIVATION on the handful of free-form generation sites overrides
# this per-invocation (CAVEMAN_DEFAULT_MODE=<level> claude ...).
#
# Capture the user's pre-existing global CAVEMAN_DEFAULT_MODE BEFORE we clobber
# it, so the activation path can respect (never RAISE) a user's lower level (see
# loki_caveman_activate_env). Guarded on UNSET (not empty): a child process that
# inherits our exported LOKI_CAVEMAN_USER_MODE="" (user had no global mode) and
# re-sources this file must NOT recapture the now-exported CAVEMAN_DEFAULT_MODE=off
# as the user mode. ${var+x} is empty only when var is genuinely unset, so the
# capture runs exactly once across the whole process tree, never recapturing "off".
if [ -z "${LOKI_CAVEMAN_USER_MODE+x}" ]; then
    LOKI_CAVEMAN_USER_MODE="${CAVEMAN_DEFAULT_MODE:-}"
fi
export LOKI_CAVEMAN_USER_MODE
export CAVEMAN_DEFAULT_MODE=off

# ---------- v7.x #593 intelligent compression-level inference ----------
# Infer the caveman compression level from the run's existing RARV-tier signal,
# so the level is DECIDED by inspecting the work rather than asked of the user.
# No new user input is introduced: the tier already drives effort/model selection
# (loki_effort_for_tier, get_rarv_tier). On the bash route the tier is read from
# LOKI_CURRENT_TIER (exported by run_autonomous each iteration); the TS mirror
# (cavemanActivateEnv) receives the same tier vocabulary (planning|development|
# fast) via call.tier, so both routes infer identically from the same signal.
#
# INFERENCE RULE (deterministic, conservative-for-accuracy):
#   planning    (Reason phase -- architecture / design / nuanced reasoning) -> lite
#   development (Act / Reflect -- implementation, the prior default)         -> full
#   fast        (Verify phase -- testing / validation, more routine)         -> full
#   unknown / empty tier                                                     -> full
# The auto ceiling is "full": inference NEVER selects ultra. ultra is reachable
# only via an explicit LOKI_CAVEMAN_LEVEL override (the opt-out escape hatch), so
# the autonomous path can never compress hard enough to lose technical nuance.
# "lite" on planning protects the highest-nuance output (architecture/design);
# everything else stays at the established "full" default. When the tier is
# unknown we pick the SAFER (established) "full", never something more aggressive.
# shellcheck disable=SC2120  # $1 is optional; callers rely on the global fallback
_loki_caveman_infer_level() {
    local tier="${1:-${LOKI_CURRENT_TIER:-}}"
    case "$tier" in
        planning) printf '%s' "lite" ;;
        *)        printf '%s' "full" ;;
    esac
}

# Rank a caveman mode by compression aggressiveness for the no-raise comparison.
# Higher number = more aggressive (drops more nuance). "off" is the floor; unknown
# or empty modes rank as -1 (treated as "no opinion", so they never win a min()).
# The wenyan-* variants mirror their plain counterparts' aggressiveness.
_loki_caveman_level_rank() {
    case "${1:-}" in
        off)                      printf '0' ;;
        lite|wenyan-lite)         printf '1' ;;
        full|wenyan|wenyan-full)  printf '2' ;;
        ultra|wenyan-ultra)       printf '3' ;;
        *)                        printf '%s' '-1' ;;
    esac
}

# Caveman config dir resolution mirrors caveman-config.js getConfigDir(): honors
# CLAUDE_CONFIG_DIR for the flag file location used to detect an existing install.
_loki_caveman_claude_dir() {
    printf '%s' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
}

# True (0) when caveman appears installed: its SessionStart hook file exists in
# the resolved Claude config dir. Best-effort, read-only. We check the hook the
# upstream installer writes to ~/.claude/hooks/caveman-activate.js (standalone)
# OR a plugin install marker. Either presence means activation will fire.
_loki_caveman_installed() {
    local dir
    dir="$(_loki_caveman_claude_dir)"
    [ -f "$dir/hooks/caveman-activate.js" ] && return 0
    # Plugin install: the activate hook lives under a plugin root; the flag file
    # path is stable. Treat a prior-session flag file as a weaker install signal.
    [ -f "$dir/.caveman-active" ] && return 0
    return 1
}

# Capability gate: can caveman compression be USED on this run? Provider is
# Claude AND the claude CLI is present AND caveman is installed-or-bootstrappable
# AND it is not disabled by the LOKI_CAVEMAN knob. Returns 0 when usable, 1
# otherwise (callers emit an honest message + degrade to an uncompressed run).
# Mirrors loki_workflows_supported's shape (provider + CLI + not-disabled).
loki_caveman_supported() {
    # Provider must be Claude (Tier 1). caveman is Claude-Code-only.
    [ "${LOKI_PROVIDER:-claude}" = "claude" ] || return 1
    command -v claude >/dev/null 2>&1 || return 1
    # Opt-out knob also suppresses the capability (no activation when off).
    [ "${LOKI_CAVEMAN:-1}" = "0" ] && return 1
    # Installed now, OR bootstrappable (node + npx present so the pin can install
    # on demand). Either way activation can take effect this run or the next.
    if _loki_caveman_installed; then
        return 0
    fi
    command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1 && return 0
    return 1
}

# Activation knob: is caveman compression ENABLED for free-form subcalls?
# DEFAULT ON (LOKI_CAVEMAN unset or 1). Opt out with LOKI_CAVEMAN=0.
#
# CROSS-COUPLING GUARD (moat safety): when LOKI_LEGACY_COMPLETION_MATCH=true the
# runner detects completion by grepping the MAIN-loop prose for the completion
# promise (run.sh:9641). Compressing the main loop would mangle that prose and
# break the legacy detector, so caveman activation is DISABLED whenever the
# legacy prose-match path is in use. The default completion path (the
# loki_complete_task MCP tool / COMPLETION_REQUESTED signal file) is immune to
# compression, so the default config keeps caveman on.
loki_caveman_enabled() {
    [ "${LOKI_CAVEMAN:-1}" = "0" ] && return 1
    [ "${LOKI_LEGACY_COMPLETION_MATCH:-false}" = "true" ] && return 1
    return 0
}

# The activation env VALUE for a free-form subcall: the configured level, or
# empty when activation is not warranted (caveman unsupported or disabled). The
# caller inlines it as a per-invocation env prefix (NEVER `export` -- a persisted
# export would bleed into later parsed subcalls and defeat the carve-out):
#   _cm_lvl="$(loki_caveman_activate_env)"
#   if [ -n "$_cm_lvl" ]; then
#       CAVEMAN_DEFAULT_MODE="$_cm_lvl" claude ...   # free-form only
#   else
#       claude ...
#   fi
#
# NO-RAISE (v7.41.0 R2 finding 4): the level returned is the configured Loki
# level, EXCEPT we never silently RAISE a user who set a LOWER global caveman
# level. If the user globally chose "lite" (less aggressive, preserves more
# nuance) we honor "lite" rather than forcing "full" on their free-form output.
# We only ever lower toward the user's preference, never above it; the activation
# level itself is the conservative-for-accuracy ceiling. The user's global mode is
# captured at source time into LOKI_CAVEMAN_USER_MODE before the default-off
# export clobbers CAVEMAN_DEFAULT_MODE. Unknown / empty user modes (rank -1) are
# ignored so a malformed value can never accidentally suppress activation.
loki_caveman_activate_env() {
    loki_caveman_supported || return 0
    loki_caveman_enabled   || return 0
    # #593: the level is the EXPLICIT user value when LOKI_CAVEMAN_LEVEL was set
    # (override / opt-out escape hatch), else the INFERRED level from the RARV
    # tier. The no-raise guard below then runs unchanged on this base, so an
    # explicit level is still lowered toward a user's lower global mode exactly
    # as before -- "override" means override the inference, not the no-raise.
    local level
    if [ -n "${LOKI_CAVEMAN_LEVEL_USERSET:-}" ]; then
        level="${LOKI_CAVEMAN_LEVEL:-full}"
    else
        level="$(_loki_caveman_infer_level)"
    fi
    # Respect (never exceed) a user's explicitly-lower global level. A user who
    # globally set CAVEMAN_DEFAULT_MODE=off opted OUT of compression entirely;
    # honor that by activating nothing (empty -> bare claude invocation).
    local user_mode="${LOKI_CAVEMAN_USER_MODE:-}"
    if [ "$user_mode" = "off" ]; then
        return 0
    fi
    if [ -n "$user_mode" ]; then
        local user_rank level_rank
        user_rank="$(_loki_caveman_level_rank "$user_mode")"
        level_rank="$(_loki_caveman_level_rank "$level")"
        # Only defer to the user when their mode is a recognized, lower level.
        if [ "$user_rank" -ge 0 ] && [ "$level_rank" -ge 0 ] && [ "$user_rank" -lt "$level_rank" ]; then
            level="$user_mode"
        fi
    fi
    printf '%s' "$level"
}

# The suppression env VALUE for a parsed-output subcall: ALWAYS "off",
# UNCONDITIONALLY. Not gated on supported/enabled (see the design note above):
# it must hard-disable caveman on a trust-gate subcall even when a user has
# caveman globally on but LOKI_CAVEMAN=0, and it is a harmless no-op env value
# when caveman is absent. Every parsed-output call site uses this ONE helper so
# the carve-out is uniform:
#   CAVEMAN_DEFAULT_MODE="$(loki_caveman_suppress_env)" claude ...
loki_caveman_suppress_env() {
    printf '%s' "off"
}

# Idempotent on-demand bootstrap of caveman at the pinned version. Best-effort:
# installs once per machine, caches a marker under .loki/ so repeat runs are a
# no-op, degrades cleanly (run proceeds UNCOMPRESSED) with an honest stderr line
# if anything is missing or the upstream installer is unreachable. NEVER blocks
# or fails the run. Returns 0 if caveman is (now) installed, 1 on clean degrade.
#
# Opt out with LOKI_CAVEMAN_AUTO_BOOTSTRAP=0. Only attempts when provider==claude
# and the LOKI_CAVEMAN knob is on.
#
# GLOBAL SIDE EFFECT (disclosed): caveman installs GLOBALLY -- the upstream
# installer adds a SessionStart hook to ~/.claude/settings.json (or
# $CLAUDE_CONFIG_DIR) that affects EVERY Claude Code session on this machine, not
# only Loki runs. This is caveman's only install mode. The bootstrap therefore
# runs the upstream installer exactly as a user's own `curl|bash` would; we do
# not author or vendor any caveman file. The one-time stderr line below names
# this so the operator is never surprised.
#
# HARDENING: the npx call is forced non-interactive (--non-interactive, plus
# </dev/null so no stdin read can ever block) and time-bounded (timeout when
# available) so a stalled network or an unexpected prompt can never hang a user's
# first `loki start`. caveman's installer is already auto-non-interactive without
# a TTY, but we belt-and-suspenders it.
loki_caveman_bootstrap() {
    [ "${LOKI_CAVEMAN:-1}" = "0" ] && return 1
    [ "${LOKI_CAVEMAN_AUTO_BOOTSTRAP:-1}" = "0" ] && return 1
    [ "${LOKI_PROVIDER:-claude}" = "claude" ] || return 1
    # Already installed -> nothing to do.
    if _loki_caveman_installed; then
        return 0
    fi
    local ver="${LOKI_CAVEMAN_VERSION:-1.9.0}"
    local marker_dir=".loki/state"
    local marker="$marker_dir/caveman-bootstrap-${ver}.done"
    # Cached attempt marker: do not re-attempt a failed install over and over
    # within the same project tree (idempotent one-shot per pinned version).
    if [ -f "$marker" ]; then
        _loki_caveman_installed && return 0 || return 1
    fi
    if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
        printf '%s\n' "[caveman] node>=18 + npx required to bootstrap; skipping (run proceeds uncompressed). Install Node or set LOKI_CAVEMAN=0 to silence." >&2
        mkdir -p "$marker_dir" 2>/dev/null && : > "$marker" 2>/dev/null || true
        return 1
    fi
    printf '%s\n' "[caveman] bootstrapping output-token compressor v${ver} (one-time, pinned). NOTE: caveman installs GLOBALLY (a Claude Code SessionStart hook in ~/.claude affecting every Claude Code session). Loki applies it only to free-form generation, NEVER to trust-gate subcalls. Opt out: LOKI_CAVEMAN=0." >&2
    # Pin via the git tag (v-prefixed) on the npx ref AND CAVEMAN_REF so the
    # downloaded hooks match the pinned release. Default install (no --all) wires
    # the Claude Code hook for the detected `claude` CLI. A timeout backstops a
    # network stall; </dev/null guarantees no interactive stdin read blocks.
    local _cm_runner="npx"
    if command -v timeout >/dev/null 2>&1; then
        _cm_runner="timeout 120 npx"
    fi
    if CAVEMAN_REF="v${ver}" $_cm_runner -y "github:JuliusBrussee/caveman#v${ver}" -- --non-interactive >/dev/null 2>&1 </dev/null; then
        mkdir -p "$marker_dir" 2>/dev/null && : > "$marker" 2>/dev/null || true
        if _loki_caveman_installed; then
            printf '%s\n' "[caveman] installed v${ver}." >&2
            return 0
        fi
    fi
    printf '%s\n' "[caveman] bootstrap unavailable (upstream unreachable, timed out, or install failed); run proceeds uncompressed." >&2
    mkdir -p "$marker_dir" 2>/dev/null && : > "$marker" 2>/dev/null || true
    return 1
}

# ---------------------------------------------------------------------------
# Session-continuity Phase 2 (GitHub #165) -- LOKI_RESUME_SESSION recovery resume
#
# NAMING COLLISION WARNING: Loki already has a user-facing `loki heal --resume`
# / `loki migrate --resume` CHECKPOINT flag (autonomy/loki). LOKI_RESUME_SESSION
# governs the CLAUDE-CLI session-resume layer (claude --resume <uuid>), NOT the
# Loki checkpoint resume. They are unrelated.
#
# SCOPE (minimum useful, design s2): on a RESTARTED run (the prior run was
# interrupted -- crash / rate limit / --max-budget cutoff -- so its non-terminal
# autonomy-state.json persisted iterationCount>0), the FIRST main-loop claude
# call of the restarted run emits `claude --resume <stored-uuid>` (the stable
# per-run uuid from .loki/state/claude-session.json) instead of a fresh
# stateless call, reattaching the prior Claude context. After that single
# resumed call the run reverts to normal per-iteration stateless behavior
# (injected memory carries forward as today). This is a RECOVERY feature, NOT a
# per-iteration resume chain -- so transcript growth cannot accumulate.
#
# CONSERVATIVE DEFAULT OFF: with the knob unset the default claude argv is
# byte-identical to v7.34 (no --resume ever emitted). Opt IN with
# LOKI_RESUME_SESSION=1. Gated on CLI support so an older claude degrades.
#
# MUTUAL EXCLUSION: --session-id and --resume are mutually exclusive on one
# claude invocation (claude rejects a session-id already in use, and resume
# replaces the fresh-session intent). The run.sh main-loop block emits the
# resume slice INSTEAD of the stamp slice on the one resumed call, never both.
# ---------------------------------------------------------------------------

# Predicate: is recovery resume enabled AND supported? CONSERVATIVE DEFAULT OFF.
# Opt IN with LOKI_RESUME_SESSION=1; gated on `claude --resume` support so an
# older CLI degrades to normal stateless behavior (no flag emitted).
loki_resume_session_enabled() {
    [ "${LOKI_RESUME_SESSION:-0}" = "1" ] || return 1
    loki_claude_flag_supported "--resume"
}

# Predicate: when resuming, also fork into a NEW session id (leaving the parent
# transcript untouched)? Only honored together with LOKI_RESUME_SESSION=1.
# DEFAULT OFF. Gated on `claude --fork-session` support.
loki_session_fork_enabled() {
    [ "${LOKI_SESSION_FORK:-0}" = "1" ] || return 1
    loki_resume_session_enabled || return 1
    loki_claude_flag_supported "--fork-session"
}

# The stable per-run claude session uuid to resume, read from the run-start
# metadata file .loki/state/claude-session.json (written on the FRESH run, so it
# survives into a restart). Emits the stored uuid on stdout, or nothing when the
# file is absent / unreadable / has no uuid (caller then skips resume and runs a
# normal fresh call -- safe degrade). Pure read, no side effects. Honors LOKI_DIR
# / TARGET_DIR exactly like the rest of run.sh.
_loki_resume_target_uuid() {
    local loki_dir="${LOKI_DIR:-${TARGET_DIR:-.}/.loki}"
    local cs_file="$loki_dir/state/claude-session.json"
    [ -s "$cs_file" ] || return 0
    command -v python3 >/dev/null 2>&1 || return 0
    _LOKI_CS_FILE="$cs_file" python3 - <<'RESUME_UUID_PY' 2>/dev/null || true
import json, os, re
try:
    with open(os.environ["_LOKI_CS_FILE"]) as f:
        d = json.load(f)
    if not isinstance(d, dict):
        raise ValueError
    u = d.get("claude_session_uuid", "")
    # RFC-4122 shape check: only print a well-formed uuid so a corrupt file
    # never injects a bogus --resume argument.
    if isinstance(u, str) and re.match(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", u
    ):
        print(u, end="")
except Exception:
    pass
RESUME_UUID_PY
}
