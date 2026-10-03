# shellcheck shell=bash
# Source this as the FIRST command of any test that runs `git config --global`
# or touches ~/.gitconfig, exactly as (tests/moat files use ../lib):
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1
#
# It points HOME and GIT_CONFIG_GLOBAL at a fresh mktemp dir so no write can
# reach the real user config. tests/test-no-ambient-gitconfig-writes.sh fails
# any such test that does not source this in its prelude.
#
# No trap here: the caller's own `trap ... EXIT` would replace it. Callers add
# "$ISOLATED_GIT_HOME" to their existing cleanup.

# FC-07: keep the pre-isolation HOME readable (read-only use) for guards.
: "${LOKI_REAL_HOME:=$HOME}"
export LOKI_REAL_HOME
ISOLATED_GIT_HOME="$(mktemp -d "${TMPDIR:-/tmp}/loki-git-home.XXXXXX")" || return 1
export ISOLATED_GIT_HOME
export HOME="$ISOLATED_GIT_HOME"
export GIT_CONFIG_GLOBAL="$ISOLATED_GIT_HOME/.gitconfig"
: > "$GIT_CONFIG_GLOBAL" || return 1
