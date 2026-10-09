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
if [ -z "${LOKI_HELP_DRIFT_CHANGELOG:-}" ]; then
    mkdir -p "$WORK/fx"
    printf '## v9.0.3\n- Security fix, no commands.\n## v9.0.2\n- Docs only.\n## v9.0.1\n- Adds `loki start --spec`.\n' > "$WORK/fx/late.md"
    printf '## v9.0.3\n- a\n## v9.0.2\n- b\n## v9.0.1\n- c\n## v9.0.0\n- d\n## v8.9.9\n- e\n## v8.9.8\n- f `loki start --spec`\n' > "$WORK/fx/none.md"
    if LOKI_HELP_DRIFT_CHANGELOG="$WORK/fx/late.md" bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
        ok "fixture: two command-free newest sections, invocation in the third, passes"
    else
        bad "fixture: two command-free newest sections must widen the window and pass"
    fi
    out="$(LOKI_HELP_DRIFT_CHANGELOG="$WORK/fx/none.md" bash "${BASH_SOURCE[0]}" 2>&1)"
    if [ $? -ne 0 ] && printf '%s' "$out" | grep -q "extraction is broken"; then
        ok "fixture: no invocation inside the 5-section window still reports broken extraction"
    else
        bad "fixture: an empty 5-section window must report broken extraction"
    fi
fi

extract_invocations() {
    awk -v n="$1" '/^## v/{c++} c>=1 && c<=n' "$CHANGELOG" \
        | grep -o '`loki [^`]*`' | tr -d '`' | sort -u
}
while :; do
    extract_invocations "$SECTIONS" > "$WORK/inv.txt"
    [ "$(wc -l < "$WORK/inv.txt" | tr -d ' ')" -ge 1 ] && break
    [ "$SECTIONS" -ge "$WINDOW" ] && break
    SECTIONS=$((SECTIONS + 1))
done
if [ "$(wc -l < "$WORK/inv.txt" | tr -d ' ')" -lt 1 ]; then
    bad "no backticked 'loki ...' invocations in the newest ${SECTIONS} CHANGELOG sections; extraction is broken"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi

cd "$WORK/cwd" || exit 1
HELP_ALL="$(bash "$LOKI" help </dev/null 2>&1 || true)"
if [ "$(printf '%s\n' "$HELP_ALL" | wc -l | tr -d ' ')" -lt 20 ]; then
    bad "'loki help' produced almost no output"
    exit 1
fi

help_for() {
    local cmd="$1" f="$WORK/help-$1.txt"
    if [ ! -f "$f" ]; then
        { bash "$LOKI" "$cmd" --help </dev/null 2>&1 || true
          bash "$LOKI" "$cmd" help </dev/null 2>&1 || true; } > "$f"
    fi
    printf '%s\n%s\n' "$HELP_ALL" "$(cat "$f")"
}

while IFS= read -r line; do
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    shift
    cmd="${1:-}"
    case "$cmd" in ''|help|-*|'<'*|*'|'*) continue ;; esac
    sub=""
    if [ -n "${2:-}" ]; then
        case "$2" in *[!a-z-]*|-*) ;; *) sub="$2" ;; esac
    fi
    hay="$(help_for "$cmd")"
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
                if grep -qF -- "$flag" "$BASH_COMP"; then
                    ok "'$flag' is in bash completion"
                else
                    bad "'$flag' (CHANGELOG, loki $cmd) is absent from completions/loki.bash"
                fi
                ;;
        esac
    done
done < "$WORK/inv.txt"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
