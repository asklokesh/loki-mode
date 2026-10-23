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
#   - (FC-SKILL-LINK-HIJACK) the running root is not under a temp root ($TMPDIR, /tmp,
#     /var/folders ...), even when a scratch npm prefix makes it look durable
#   - (FC-SKILL-LINK-HIJACK) a live link is never repointed to an older VERSION
#   - (FC-SKILL-LINK-HIJACK) a plain run (the bin/loki shim) repairs only a dangling
#     link; repointing a still-valid link is for the postinstall mode alone

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

# FC-SKILL-LINK-HIJACK: a throwaway copy (a packed tarball extracted under $TMPDIR, a run-owned
# temp dir) is never a link target, whatever npm prefix it was installed with. The root list is
# overridable (LOKI_SKILL_LINK_TEMP_ROOTS, newline separated) so tests can model a non-temp host.
_loki_skill_under_temp() {
    local root_p="$1" t tp roots="${LOKI_SKILL_LINK_TEMP_ROOTS:-}"
    [ -n "$roots" ] || roots="${TMPDIR:-}
/tmp
/private/tmp
/var/tmp
/var/folders
/private/var/folders"
    while IFS= read -r t; do
        [ -n "$t" ] || continue
        tp="$(_loki_skill_dir_p "$t")" || tp="$t"
        tp="${tp%/}"
        [ -n "$tp" ] || continue
        case "$root_p" in "$tp"/*) return 0 ;; esac
    done <<EOT
$roots
EOT
    return 1
}

# Dotted-numeric compare of two VERSION strings; returns 0 when $1 < $2. Unreadable input is "not older".
_loki_skill_version_lt() {
    local a="${1%%[-+]*}" b="${2%%[-+]*}" i x y
    [ -n "$a" ] && [ -n "$b" ] || return 1
    local IFS=.
    # shellcheck disable=SC2086
    set -- $a; local -a av=("$@")
    # shellcheck disable=SC2086
    set -- $b; local -a bv=("$@")
    for i in 0 1 2; do
        x="${av[$i]:-0}"; y="${bv[$i]:-0}"
        case "$x$y" in *[!0-9]*) return 1 ;; esac
        [ "$x" -lt "$y" ] && return 0
        [ "$x" -gt "$y" ] && return 1
    done
    return 1
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
    local root="${1:-}" mode="${2:-run}" home="${HOME:-}" root_p rel link tgt live_p tmp durable="" why cur_v run_v
    [ -n "$root" ] && [ -n "$home" ] || return 0
    [ -f "$root/SKILL.md" ] || return 0
    root_p="$(cd "$root" 2>/dev/null && pwd -P)" || return 0
    _loki_skill_is_install_path "$root_p" || _loki_skill_is_install_path "$root" || return 0

    if _loki_skill_under_temp "$root_p"; then
        printf 'loki: not repointing skill links: running install %s is under a temp directory\n' "$root_p" >&2
        return 0
    fi
    run_v="$(head -n 1 "$root_p/VERSION" 2>/dev/null | tr -d '[:space:]')"

    for rel in .claude .codex .cline .aider; do
        link="$home/$rel/skills/loki-mode"
        [ -L "$link" ] || continue
        tgt="$(readlink "$link" 2>/dev/null)" || continue
        case "$tgt" in /*) ;; *) tgt="$(dirname "$link")/$tgt" ;; esac
        _loki_skill_is_install_path "$tgt" || continue
        if [ -e "$link" ]; then
            live_p="$(cd "$link" 2>/dev/null && pwd -P)" || live_p=""
            [ "$live_p" = "$root_p" ] && continue
            [ "$mode" = "postinstall" ] || continue # a valid link is repointed only by an install, never by a plain run
            cur_v="$(head -n 1 "$link/VERSION" 2>/dev/null | tr -d '[:space:]')"
            if _loki_skill_version_lt "$run_v" "$cur_v"; then
                printf 'loki: not repointing skill link %s: running %s is older than %s\n' "$link" "$run_v" "$cur_v" >&2
                continue
            fi
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
