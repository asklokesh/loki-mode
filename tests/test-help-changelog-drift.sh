#!/usr/bin/env bash
# Help drift guard (HELP-DRIFT, FC-72): a subcommand or flag the newest CHANGELOG
# sections name inside a backticked `loki ...` invocation must appear in the
# help output for that command, and a flag must also tab-complete in bash.
#
# History: 11.3.2 shipped `loki plan --spec`, `loki start --spec` and
# `loki memory forget` with none of them in `loki help` or Tab completion.
#
# CONSERVATIVE EXTRACTION: only backticked spans that start with "loki ". The
# subcommand is the second token only when it is a plain lowercase word (so
# "a|b|c" alternations and "<arg>" placeholders are skipped). Flags are --long
# tokens. Prose outside backticks is never read.
#
# Help for a command = `loki help` + `loki <cmd> --help` + `loki <cmd> help`.
# Scope: the newest LOKI_HELP_DRIFT_SECTIONS (default 2) CHANGELOG sections. When those name no
# invocation at all (a Security-only or docs-only release), the window widens one section at a
# time up to LOKI_HELP_DRIFT_WINDOW (default 5). Extraction is "broken" only if the whole window is empty.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
CHANGELOG="${LOKI_HELP_DRIFT_CHANGELOG:-$REPO_ROOT/CHANGELOG.md}"
SECTIONS="${LOKI_HELP_DRIFT_SECTIONS:-2}"
WINDOW="${LOKI_HELP_DRIFT_WINDOW:-5}"
BASH_COMP="$REPO_ROOT/completions/loki.bash"
ZSH_COMP="$REPO_ROOT/completions/_loki"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/cwd"
export HOME="$WORK/home"

# Self-test of the window logic against fixture CHANGELOGs (skipped when this run is itself a fixture run).
if [ -z "${LOKI_HELP_DRIFT_CHANGELOG:-}" ] && [ -z "${LOKI_HELP_DRIFT_NESTED:-}" ]; then
    mkdir -p "$WORK/fx"
    printf '## v9.0.3\n- Security fix, no commands.\n## v9.0.2\n- Docs only.\n## v9.0.1\n- Adds `loki start --spec`.\n' > "$WORK/fx/late.md"
    printf '## v9.0.3\n- a\n## v9.0.2\n- b\n## v9.0.1\n- c\n## v9.0.0\n- d\n## v8.9.9\n- e\n## v8.9.8\n- f `loki start --spec`\n' > "$WORK/fx/none.md"
    if LOKI_HELP_DRIFT_CHANGELOG="$WORK/fx/late.md" bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
        ok "fixture: two command-free newest sections, invocation in the third, passes"
    else
        bad "fixture: two command-free newest sections must widen the window and pass"
    fi
    printf '## v9.0.3\n- Plain notes: loki start --spec now works.\n## v9.0.2\n- loki is faster.\n' > "$WORK/fx/plain-ok.md"
    printf '## v9.0.3\n- Plain notes: loki start --nosuchflagzz now works.\n## v9.0.2\n- b\n' > "$WORK/fx/plain-bad.md"
    printf '## v9.0.3\n- loki is faster and loki mode is great.\n## v9.0.2\n- b\n' > "$WORK/fx/plain-none.md"
    if LOKI_HELP_DRIFT_CHANGELOG="$WORK/fx/plain-ok.md" bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
        ok "fixture: unbackticked 'loki start --spec' is extracted and passes; bare prose 'loki is' is not a command"
    else
        bad "fixture: a plain-prose invocation of a real flag must pass and prose must not fail"
    fi
    out="$(LOKI_HELP_DRIFT_CHANGELOG="$WORK/fx/plain-bad.md" bash "${BASH_SOURCE[0]}" 2>&1)"
    if [ $? -ne 0 ] && grep -q "nosuchflagzz" <<< "$out"; then
        ok "fixture: an unbackticked unknown flag is reported by name"
    else
        bad "fixture: an unbackticked unknown flag must be reported by name (plain prose is read)"
    fi
    out="$(LOKI_HELP_DRIFT_CHANGELOG="$WORK/fx/plain-none.md" bash "${BASH_SOURCE[0]}" 2>&1)"
    if [ $? -eq 0 ] && ! grep -q "extraction is broken" <<< "$out"; then
        ok "fixture: bare prose naming no command passes without a false drift report"
    else
        bad "fixture: bare prose must not become a command"
    fi
    # The real CHANGELOG over a 30-section window: older notes name flags too (loki start --resume
    # was missing from completions/_loki there, FC-ZSH-START-RESUME-COMPLETION).
    if [ -z "${LOKI_HELP_DRIFT_NESTED:-}" ]; then
        if LOKI_HELP_DRIFT_NESTED=1 LOKI_HELP_DRIFT_SECTIONS=30 bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
            ok "the real CHANGELOG is drift-free over a 30-section window"
        else
            bad "the real CHANGELOG has help or completion drift inside its newest 30 sections"
        fi
    fi
    out="$(LOKI_HELP_DRIFT_CHANGELOG="$WORK/fx/none.md" bash "${BASH_SOURCE[0]}" 2>&1)"
    if [ $? -ne 0 ] && grep -q "extraction is broken" <<< "$out"; then
        ok "fixture: no invocation inside the 5-section window still reports broken extraction"
    else
        bad "fixture: an empty 5-section window must report broken extraction"
    fi
fi

# Exact-token completion checks (TEN-QUALITY-23): a flag or subcommand must appear as a whole
# literal token, so "--spec" is not satisfied by "--spec-first" and a typo like "--sinse" fails.
has_token() {
    # $1 = file, $2 = token (flags and words only); token must not be flanked by [A-Za-z0-9_-]
    grep -qE -- "(^|[^A-Za-z0-9_-])${2}([^A-Za-z0-9_-]|\$)" "$1"
}
bash_arm() {
    # print the body of the case arm for subcommand $2 in bash completion file $1
    awk -v c="$2" '
        /^        [a-z|-]+\)/ { arm=$0; sub(/\).*/,"",arm); gsub(/^ +/,"",arm); n=split(arm,a,"|"); inarm=0; for(i=1;i<=n;i++) if(a[i]==c) inarm=1 }
        inarm { print }' "$1"
}

# Backticked spans are read whole. Release notes since 11.53 are plain prose with no backticks, so
# an unbackticked `loki <word> [--flag ...]` is read too, from the text left after the backticked
# spans are removed. A plain-prose hit with a --flag is checked like a backticked one. A bare
# `loki <word>` could be ordinary prose, so it is emitted as `loki.maybe` and checked only when the
# word is already a command in `loki help` (FC-HELP-DRIFT-PLAIN-PROSE-CHANGELOG).
extract_invocations() {
    local sect
    sect="$(awk -v n="$1" '/^## v/{c++} c>=1 && c<=n' "$CHANGELOG")"
    {
        printf '%s\n' "$sect" | grep -o '`loki [^`]*`' | tr -d '`'
        printf '%s\n' "$sect" | sed 's/`[^`]*`//g' \
            | grep -oE '(^|[^A-Za-z0-9_./`-])loki [a-z][a-z-]*( +--[a-z][a-z-]*)*' | sed -E 's/^[^l]*//' \
            | awk '/ --/ { print; next } { sub(/^loki /, "loki.maybe "); print }'
    } | sort -u
}
while :; do
    extract_invocations "$SECTIONS" > "$WORK/inv.txt"
    [ "$(wc -l < "$WORK/inv.txt" | tr -d ' ')" -ge 1 ] && break
    [ "$SECTIONS" -ge "$WINDOW" ] && break
    SECTIONS=$((SECTIONS + 1))
done
if [ "$(wc -l < "$WORK/inv.txt" | tr -d ' ')" -lt 1 ]; then
    bad "no 'loki ...' invocations (backticked or plain) in the newest ${SECTIONS} CHANGELOG sections; extraction is broken"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi

cd "$WORK/cwd" || exit 1
HELP_ALL="$(bash "$LOKI" help all </dev/null 2>&1 || true)"
if [ "$(printf '%s\n' "$HELP_ALL" | wc -l | tr -d ' ')" -lt 20 ]; then
    bad "'loki help' produced almost no output"
    exit 1
fi

help_for() {
    local cmd="$1" f="$WORK/help-$1.txt"
    if [ ! -f "$f" ]; then
        { bash "$LOKI" "$cmd" --help </dev/null 2>&1 || true
          bash "$LOKI" "$cmd" help </dev/null 2>&1 || true
          # bin/loki is the real entry path: Bun-routed commands (queue, ...) print help only there.
          bash "$REPO_ROOT/bin/loki" "$cmd" help </dev/null 2>&1 || true
          bash "$REPO_ROOT/bin/loki" "$cmd" --help </dev/null 2>&1 || true; } > "$f"
    fi
    printf '%s\n%s\n' "$HELP_ALL" "$(cat "$f")"
}

while IFS= read -r line; do
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    maybe=0; [ "${1:-}" = "loki.maybe" ] && maybe=1
    shift
    cmd="${1:-}"
    case "$cmd" in ''|help|-*|'<'*|*'|'*) continue ;; esac
    if [ "$maybe" = 1 ] && ! { grep -E '^    local main_commands=' "$BASH_COMP" | grep -qE "[ \"]${cmd}[ \"]"; }; then continue; fi # plain prose, not a command
    sub=""
    if [ -n "${2:-}" ]; then
        case "$2" in *[!a-z-]*|-*) ;; *) sub="$2" ;; esac
    fi
    hay="$(help_for "$cmd")"
    if grep -E '^    local main_commands=' "$BASH_COMP" | grep -qE "[ \"]${cmd}[ \"]"; then
        ok "'$cmd' is a literal command in loki.bash main_commands"
    else
        bad "'$cmd' (CHANGELOG) is not a literal command in loki.bash main_commands"
    fi
    if grep -qE "^[[:space:]]*'$cmd:" "$ZSH_COMP"; then
        ok "'$cmd' is a literal command in completions/_loki"
    else
        bad "'$cmd' (CHANGELOG) is not a literal command in completions/_loki"
    fi
    if [ -n "$sub" ]; then
        if printf '%s\n' "$hay" | grep -qw -- "$sub"; then
            ok "'loki $cmd $sub' appears in help"
        else
            bad "'loki $cmd $sub' (CHANGELOG) is absent from help"
        fi
    fi
    for tok in "$@"; do
        case "$tok" in
            --[a-z]*)
                flag="${tok%%[=<\[]*}"
                if printf '%s\n' "$hay" | grep -qF -- "$flag"; then
                    ok "'loki $cmd $flag' appears in help"
                else
                    bad "'loki $cmd $flag' (CHANGELOG) is absent from help"
                fi
                if has_token "$BASH_COMP" "$flag"; then
                    ok "'$flag' is in bash completion"
                else
                    bad "'$flag' (CHANGELOG, loki $cmd) is absent from completions/loki.bash"
                fi
                if has_token "$ZSH_COMP" "$flag"; then
                    ok "'$flag' is in zsh completion"
                else
                    bad "'$flag' (CHANGELOG, loki $cmd) is absent from completions/_loki"
                fi
                arm="$(bash_arm "$BASH_COMP" "$cmd")"
                if [ -n "$arm" ]; then
                    printf '%s\n' "$arm" > "$WORK/arm.txt"
                    if has_token "$WORK/arm.txt" "$flag"; then
                        ok "'$flag' is in the loki.bash case arm for '$cmd'"
                    else
                        bad "'$flag' (CHANGELOG) is absent from the loki.bash case arm for '$cmd'"
                    fi
                fi
                ;;
        esac
    done
done < "$WORK/inv.txt"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
