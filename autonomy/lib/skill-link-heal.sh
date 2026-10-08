#!/usr/bin/env bash
# FC-30: keep the provider skill links Loki created pointing at the running
# install. One shared mechanism, called from npm postinstall and from the bin/loki
# shim (first invocation after an install or upgrade). Cost: a few lstat/readlink
# calls, no network, no subprocess beyond readlink/ln/mv on the repair path.
#
# Opt out with LOKI_NO_SKILL_LINK_HEAL=1.
#
# A link is repointed only when ALL hold:
#   - it is a symlink (a real directory or file is never touched)
#   - its target is a Loki install path (…/node_modules/loki-mode, or a Homebrew
#     Cellar/opt loki-mode dir), so a foreign link is never touched
#   - its target is missing, or resolves to a different install than the running one
#   - the running root is itself an install path with a SKILL.md, so a dev checkout
#     or worktree never hijacks the user's global link
#   - the running install is durable (npm global root, bun global dir, Homebrew
#     prefix); an npx cache, temp dir or arbitrary prefix is refused with one
#     stderr line and the link is left untouched

_loki_skill_is_install_path() {
    case "${1%/}" in
        */node_modules/loki-mode | */Cellar/loki-mode/* | */opt/loki-mode | */opt/loki-mode/libexec) return 0 ;;
    esac
    return 1
}

# Durable-install rule (FC-30 amendment). A repoint writes a user-owned path, so
# the running install must outlive this process: a one-off `npx loki-mode` run or
# a scratch prefix would turn the link into a new dangling link. Durable means
# the running root sits under the npm global root (`npm root -g`), the bun global
# dir, or a Homebrew prefix. Prints a reason and returns 1 when it is not.
_loki_skill_dir_p() { (cd "$1" 2>/dev/null && pwd -P); }

# `npm root -g` bounded to 3s so a hung npm can never hang bin/loki. Output goes
# to a file (not a pipe) so an orphaned grandchild cannot hold the caller open.
# Returns 124 on timeout (callers fail closed), otherwise npm's own status.
_loki_skill_npm_root() {
    local out pid i=0 rc
    out="$(mktemp "${TMPDIR:-/tmp}/loki-npmroot.XXXXXX")" || return 1
    npm root -g >"$out" 2>/dev/null </dev/null &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        if [ "$i" -ge 30 ]; then
            kill "$pid" 2>/dev/null
            rm -f "$out"
            return 124
        fi
        sleep 0.1
        i=$((i + 1))
    done
    wait "$pid"; rc=$?
    [ "$rc" -eq 0 ] && head -n 1 "$out"
    rm -f "$out"
    return "$rc"
}

_loki_skill_root_durable() {
    local root_p="$1" cand cands="" npmroot prefix rc
    case "$root_p" in
        */_npx/*) printf 'running from an npx cache (%s)' "$root_p"; return 1 ;;
    esac
    npmroot="$(_loki_skill_npm_root)"; rc=$?
    if [ "$rc" -eq 124 ]; then
        printf 'npm root -g timed out (running install %s not verified durable)' "$root_p"
        return 1
    fi
    [ "$rc" -eq 0 ] || npmroot=""
    [ -n "$npmroot" ] && cands="$cands
$npmroot"
    [ -n "${NPM_CONFIG_PREFIX:-}" ] && cands="$cands
${NPM_CONFIG_PREFIX}/lib/node_modules"
    cands="$cands
${BUN_INSTALL:-${HOME:-}/.bun}/install/global/node_modules"
    for prefix in "${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
        [ -n "$prefix" ] || continue
        cands="$cands
$prefix/Cellar/loki-mode
$prefix/opt/loki-mode
$prefix/lib/node_modules"
    done
    while IFS= read -r cand; do
        [ -n "$cand" ] || continue
        cand="$(_loki_skill_dir_p "$cand")" || continue
        [ "$root_p" = "$cand" ] && return 0
        case "$root_p" in "$cand"/*) return 0 ;; esac
    done <<EOT
$cands
EOT
    printf 'running install %s is not a durable global install (npm global, bun global or Homebrew)' "$root_p"
    return 1
}

loki_skill_link_heal() {
    [ "${LOKI_NO_SKILL_LINK_HEAL:-}" = "1" ] && return 0
    local root="${1:-}" home="${HOME:-}" root_p rel link tgt live_p tmp durable="" why
    [ -n "$root" ] && [ -n "$home" ] || return 0
    [ -f "$root/SKILL.md" ] || return 0
    root_p="$(cd "$root" 2>/dev/null && pwd -P)" || return 0
    _loki_skill_is_install_path "$root_p" || _loki_skill_is_install_path "$root" || return 0

    for rel in .claude .codex .cline .aider; do
        link="$home/$rel/skills/loki-mode"
        [ -L "$link" ] || continue
        tgt="$(readlink "$link" 2>/dev/null)" || continue
        case "$tgt" in /*) ;; *) tgt="$(dirname "$link")/$tgt" ;; esac
        _loki_skill_is_install_path "$tgt" || continue
        if [ -e "$link" ]; then
            live_p="$(cd "$link" 2>/dev/null && pwd -P)" || live_p=""
            [ "$live_p" = "$root_p" ] && continue
        fi
        if [ -z "$durable" ]; then
            if why="$(_loki_skill_root_durable "$root_p")"; then
                durable=yes
            else
                printf 'loki: not repointing skill links: %s\n' "$why" >&2
                return 0
            fi
        fi
        tmp="${link}.heal.$$"
        rm -f "$tmp" 2>/dev/null
        ln -s "$root_p" "$tmp" 2>/dev/null || continue
        # Atomic replace. -T (GNU) / -h (BSD) stop mv from descending into a
        # link that points at a directory.
        if mv -fT "$tmp" "$link" 2>/dev/null || mv -fh "$tmp" "$link" 2>/dev/null; then
            printf 'loki: repointed skill link %s -> %s (was %s)\n' "$link" "$root_p" "$tgt" >&2
        else
            rm -f "$tmp" 2>/dev/null
        fi
    done
    return 0
}
