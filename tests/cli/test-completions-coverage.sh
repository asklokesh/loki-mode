#!/usr/bin/env bash
# Test: shell-completion coverage vs the real command surface.
#
# The first-argument completion candidates in completions/loki.bash and
# completions/_loki are hand-maintained copies of the top-level dispatch case
# in autonomy/loki. That is verified drift: every new canonical command (e.g.
# why, ultracode, deploy) silently fails to tab-complete until someone also
# hand-edits both completion files.
#
# This test makes that drift a caught failure instead of a silent papercut: it
# extracts the leading-token arms from the dispatch case ("case \"$command\" in")
# and asserts each one appears in the bash main_commands string AND the zsh
# _loki_commands list. Intentional internal/hidden/alias arms are listed in
# IGNORE so they do not force a completion entry.
#
# Adding a new user-facing command = adding it to both completion lists (the
# fix this test prints), or adding it to IGNORE if it is intentionally hidden.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI_SRC="$REPO_ROOT/autonomy/loki"
BASH_COMP="$REPO_ROOT/completions/loki.bash"
ZSH_COMP="$REPO_ROOT/completions/_loki"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }

for f in "$LOKI_SRC" "$BASH_COMP" "$ZSH_COMP"; do
    if [ ! -f "$f" ]; then
        echo -e "${RED}[FAIL]${NC} missing required file: $f"
        exit 1
    fi
done

# Intentionally NOT completed (internal, deprecated aliases, hidden plumbing,
# or arms that are not first-class user commands). Keep this list explicit so a
# real new command cannot hide behind it.
IGNORE=(
    run        # deprecated alias of start
    stats      # deprecated alias of report session
    welcome    # auto-shown first-run screen, not typed
    cleanup    # internal maintenance
    "")

is_ignored() {
    local cmd="$1" ig
    for ig in "${IGNORE[@]}"; do
        [ "$cmd" = "$ig" ] && return 0
    done
    return 1
}

# Locate the canonical dispatch block: the SECOND `case "$command" in` (the
# first is the config pre-pass gated to start|run|quick). We take the last one
# to be robust to ordering, then read until its matching `esac`.
dispatch_start="$(grep -n 'case "\$command" in' "$LOKI_SRC" | tail -1 | cut -d: -f1)"
if [ -z "$dispatch_start" ]; then
    echo -e "${RED}[FAIL]${NC} could not locate dispatch case in $LOKI_SRC"
    exit 1
fi

# Find the matching esac line that closes the dispatch block.
dispatch_end="$(awk -v start="$dispatch_start" 'NR>start && /^[[:space:]]*esac[[:space:]]*$/ {print NR; exit}' "$LOKI_SRC")"
if [ -z "$dispatch_end" ]; then
    echo -e "${RED}[FAIL]${NC} could not find esac closing the dispatch case"
    exit 1
fi

# Extract leading-token command arms from the dispatch block. An arm looks like
#   start)            or   context|ctx)
# Portable parse (no gawk): grep the arm lines, drop the trailing ')', split on
# '|' to capture every alias token. Uses only sed/tr/grep available on macOS.
arm_lines="$(sed -n "${dispatch_start},${dispatch_end}p" "$LOKI_SRC" \
    | grep -E '^[[:space:]]*[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)*\)[[:space:]]*$')"
arms=()
while IFS= read -r tok; do
    [ -n "$tok" ] && arms+=("$tok")
done < <(
    printf '%s\n' "$arm_lines" \
        | sed -E 's/[[:space:]]*\)[[:space:]]*$//; s/^[[:space:]]*//' \
        | tr '|' '\n' \
        | sort -u
)

if [ "${#arms[@]}" -eq 0 ]; then
    echo -e "${RED}[FAIL]${NC} parsed zero command arms (parser or dispatch format changed)"
    exit 1
fi

bash_words="$(cat "$BASH_COMP")"
zsh_words="$(cat "$ZSH_COMP")"

missing_bash=()
missing_zsh=()

for cmd in "${arms[@]}"; do
    is_ignored "$cmd" && continue
    # bash: present as a whole word inside the main_commands string
    if ! grep -Eq "(^|[\" ])${cmd}([\" ]|\$)" <<<"$bash_words"; then
        missing_bash+=("$cmd")
    fi
    # zsh: present either in the _loki_commands describe list ('cmd:desc') or
    # as a dispatch arm token in the args case.
    if ! grep -Eq "('${cmd}:| ${cmd}\)|\|${cmd}\)|^[[:space:]]*${cmd}\))" <<<"$zsh_words"; then
        missing_zsh+=("$cmd")
    fi
done

if [ "${#missing_bash[@]}" -eq 0 ]; then
    log_pass "bash completion covers every dispatch command"
else
    log_fail "bash completion (completions/loki.bash) is missing: ${missing_bash[*]}"
    echo "       add them to the main_commands string in completions/loki.bash"
fi

if [ "${#missing_zsh[@]}" -eq 0 ]; then
    log_pass "zsh completion covers every dispatch command"
else
    log_fail "zsh completion (completions/_loki) is missing: ${missing_zsh[*]}"
    echo "       add a 'cmd:description' line to _loki_commands in completions/_loki"
fi

echo ""
echo "Checked ${#arms[@]} dispatch command tokens. PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
