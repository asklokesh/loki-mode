# Loki Mode - Claude Code Skill
@docs/v10/OPERATING-MODEL.md
Autonomous spec-to-product system: takes a PRD, GitHub issue, OpenAPI/JSON/YAML doc, or one-line brief to a deployed product via the RARV-C closure loop. Provider-agnostic: Claude Code, OpenAI Codex CLI, Cline, Aider, opencode. Flagship product of [Autonomi](https://www.autonomi.dev/).

## Quick Start

```bash
claude --dangerously-skip-permissions   # then invoke "Loki Mode"
loki start ./prd.md              # PRD-mode
loki start owner/repo#123        # issue-mode
```

## Core concepts
- RARV cycle: **R**eason -> **A**ct -> **R**eflect -> **V**erify, every iteration.
- Models: Opus for planning/architecture only; Sonnet for development and functional testing; Haiku for unit tests, monitoring, and parallelizable work.
- Providers: Claude Code full (Tier 1); Cline reduced (Tier 2); Codex CLI/Aider degraded, sequential (Tier 3); opencode model-agnostic. Gemini CLI is DEPRECATED; `LOKI_PROVIDER=gemini` exits with a migration message. See `providers/*.sh`.
- Version: see `VERSION` (semver: MAJOR = architecture change, MINOR = feature, PATCH = fix). Full release steps: `docs/dev/release-checklist.md`.

## Git and release invariants (binding, no exceptions)
- Repo-local commit identity: `asklokesh` / `lokeshmure@live.com`, never set globally. Stage files by name; never bulk-stage the whole tree; never add a co-author line.
- Commit/push authority: the standing authorization in `docs/LOKI-10-BUILD-PROMPT.md` section 1 governs sessions operating under that program (no waiting for approval there). Ask before committing otherwise.
- Release model: trains, not push-per-merge (`docs/v10/DECISIONS.md` D25). Batch approved merges locally, push once per train, wait for CI green on that exact SHA, then release.
- Pre-push/release gate: `bash scripts/local-ci.sh` (fast tier). The FULL tier is diagnostic only, never a release blocker. Never force-push, kill processes by name/pattern, or bypass branch protection.
- No emojis, no em dashes, no en dashes, anywhere (code, docs, commits, UI); remove any found on sight. SKILL.md stays under 500 lines with header AND footer version bumped together.
- Harness code invariants (see `docs/dev/architecture-reference.md`): new always-on prompt text goes in the cache-stable prefix; `goal_score.ts` and `run.sh` change together, byte-mirrored; never invert smart-retry's fail-safe default.

## Cleanup (mandatory before reporting any task done)
Every temp file and background process goes under one run-owned directory
created with `loki_run_tmp_create`; stop only PIDs you recorded; remove only
that validated directory with `loki_run_tmp_cleanup`. Never sweep `/tmp`,
`$TMPDIR`, or process names/patterns. Verify-before-documenting rule and full
source commentary: `docs/dev/tmp-cleanup.md`.

<!-- BEGIN LOKI_RUN_TMP_HELPERS -->
```bash
loki_run_tmp_create() {
    local temp_root marker

    if [ -n "${LOKI_RUN_TMP:-}" ]; then
        printf '%s\n' "LOKI_RUN_TMP is already set; refusing to replace it" >&2
        return 64
    fi

    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || {
        printf '%s\n' "Cannot resolve the temp root" >&2
        return 64
    }
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    marker="${LOKI_RUN_TMP}/.loki-run-owned"

    chmod 700 "$LOKI_RUN_TMP" || {
        rmdir "$LOKI_RUN_TMP" 2>/dev/null || true
        unset LOKI_RUN_TMP
        return 1
    }
    if ! printf '%s\n' "$LOKI_RUN_TMP" >"$marker" || ! chmod 600 "$marker"; then
        rm -f -- "$marker"
        rmdir "$LOKI_RUN_TMP" 2>/dev/null || true
        unset LOKI_RUN_TMP
        return 1
    fi
    export LOKI_RUN_TMP
}

# Read one numeric stat field portably. GNU uses -c, BSD uses -f, and each
# MISPARSES the other's flag: GNU -f means --file-system and still prints a
# filesystem block on stdout while exiting non-zero, so a bare `a || b`
# fallback captures that block and concatenates the real value onto it.
# Validate the captured value instead of trusting exit status or stream, so a
# usage string, a filesystem block, an empty result, or a concatenation of any
# of those is rejected on every platform.
loki_run_tmp_stat_field() {
    local gnu_fmt="$1" bsd_fmt="$2" target_path="$3" value

    value="$(stat -c "$gnu_fmt" -- "$target_path" 2>/dev/null)" || value=''
    case "$value" in
        '' | *[!0-9]*) value="$(stat -f "$bsd_fmt" -- "$target_path" 2>/dev/null)" || value='' ;;
    esac
    case "$value" in
        '' | *[!0-9]*) return 1 ;;
    esac
    printf '%s\n' "$value"
}

loki_run_tmp_cleanup() {
    local target temp_root marker marker_value target_real
    local target_uid marker_uid target_mode marker_mode current_uid

    target="${LOKI_RUN_TMP:-}"
    [ -n "$target" ] || return 0
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64

    case "$target" in
        "${temp_root}"/loki-run.*) ;;
        *)
            printf '%s\n' "Refusing cleanup outside the run-owned temp namespace: $target" >&2
            return 64
            ;;
    esac
    [ "$(dirname -- "$target")" = "$temp_root" ] || return 64
    [ -d "$target" ] && [ ! -L "$target" ] || return 64

    marker="${target}/.loki-run-owned"
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 64
    IFS= read -r marker_value <"$marker" || return 64
    [ "$marker_value" = "$target" ] || return 64

    current_uid="$(id -u)" || return 64
    target_uid="$(loki_run_tmp_stat_field '%u' '%u' "$target")" || return 64
    marker_uid="$(loki_run_tmp_stat_field '%u' '%u' "$marker")" || return 64
    [ "$target_uid" = "$current_uid" ] && [ "$marker_uid" = "$current_uid" ] || return 64

    # Refuse anything readable, writable, or executable by group or other. Only
    # the low three permission digits are compared: GNU '%a' includes the
    # setuid/setgid/sticky digit and BSD '%Lp' does not, and `mktemp -d` under a
    # setgid temp root inherits g+s that a three-digit `chmod 700` preserves.
    # Comparing the raw value against "700" would therefore read 2700 on Linux,
    # refuse, and leak the very directory this helper exists to remove.
    target_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$target")" || return 64
    marker_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$marker")" || return 64
    # Keep the last three digits, zero-padded, then require exactly 700/600.
    target_mode="00${target_mode}"
    marker_mode="00${marker_mode}"
    [ "${target_mode#"${target_mode%???}"}" = "700" ] || return 64
    [ "${marker_mode#"${marker_mode%???}"}" = "600" ] || return 64

    target_real="$(cd "$target" 2>/dev/null && pwd -P)" || return 64
    [ "$target_real" = "$target" ] || return 64
    [ "$(dirname -- "$target_real")" = "$temp_root" ] || return 64

    # A linked worktree has a .git file; a primary worktree has a .git
    # directory. Refuse both, including a broken .git symlink.
    if [ -e "${target}/.git" ] || [ -L "${target}/.git" ]; then
        printf '%s\n' "Refusing to remove a Git worktree: $target" >&2
        return 64
    fi

    rm -rf -- "$target"
    [ ! -e "$target" ] || return 1
    unset LOKI_RUN_TMP
}
```
<!-- END LOKI_RUN_TMP_HELPERS -->

## Read when needed
- `docs/dev/project-structure.md` - directory map, codebase knowledge graph, key functions, critical data flow, the MCP server (`mcp/server.py`, 36 tools); and `docs/dev/research-foundation.md` - the labs and papers this system is built on.
- `docs/dev/architecture-reference.md` - the 8 quality gates, legacy healing, memory system, metrics, v8 harness knobs, RARV-C closure env vars.
- `docs/dev/release-checklist.md` - full version-bump file list, dashboard build, pre-publish validation, distribution channels, local CI details.
- `skills/sdlc-fleet.md` - six-role standing fleet pattern for non-trivial changes; its roles are superseded by `docs/v10/OPERATING-MODEL.md`, its review rules by D12/D13, and its "ask the founder" step by the standing autonomous mandate in `docs/LOKI-10-BUILD-PROMPT.md`.
- `docs/v10/DECISIONS.md` - the standing decision log (D1-D26 and later); check before assuming an older process rule still holds.
