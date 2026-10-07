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

_loki_skill_is_install_path() {
    case "${1%/}" in
        */node_modules/loki-mode | */Cellar/loki-mode/* | */opt/loki-mode | */opt/loki-mode/libexec) return 0 ;;
    esac
    return 1
}

loki_skill_link_heal() {
    [ "${LOKI_NO_SKILL_LINK_HEAL:-}" = "1" ] && return 0
    local root="${1:-}" home="${HOME:-}" root_p rel link tgt live_p tmp
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
