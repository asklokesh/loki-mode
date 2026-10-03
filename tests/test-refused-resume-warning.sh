#!/usr/bin/env bash
# S-233: when setup_agent_branch refuses a resume (checkout --no-overwrite-ignore
# would replace a gitignored user file), the warning must name the conflicting
# file and the recorded branch where the earlier commits live.
set -uo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$(dirname "$SCRIPT_DIR")/autonomy/run.sh"

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-refused-resume.XXXXXX")"
trap 'rm -rf "$WORKROOT" "$ISOLATED_GIT_HOME" 2>/dev/null || true' EXIT INT TERM

# Extract the branch block by name anchor, as test-branch-lifecycle.sh does.
LIB="$WORKROOT/branch-lib.sh"
awk '
    /^setup_agent_branch\(\) \{/ { p=1 }
    p { print }
    p && /^create_session_pr\(\) \{/ { f=1 }
    f && /^}/ { exit }
' "$RUN_SH" > "$LIB"
grep -q '^setup_agent_branch() {' "$LIB" || { echo "[FAIL] could not extract setup_agent_branch"; exit 1; }

cat > "$WORKROOT/preamble.sh" <<EOT
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { return 0; }
audit_agent_action() { return 0; }
# shellcheck disable=SC1090
source "$LIB"
EOT

REPO="$WORKROOT/repo"
mkdir -p "$REPO"
out="$(
    cd "$REPO" || exit 1
    git init -q
    git config user.email t@loki.local
    git config user.name "Loki Test"
    git config commit.gpgsign false
    git checkout -q -b develop
    printf 'config.local.json\n' > .gitignore
    echo seed > seed.txt
    git add .gitignore seed.txt
    git commit -qm seed
    # shellcheck disable=SC1091
    . "$WORKROOT/preamble.sh"
    export ITERATION_COUNT=1
    setup_agent_branch >/dev/null 2>&1
    s1="$(git rev-parse --abbrev-ref HEAD)"
    printf 'build/\n' > .gitignore
    printf '{"agent":1}\n' > config.local.json
    git add -f .gitignore config.local.json
    git commit -qm "session work"
    git checkout -q develop
    printf '{"user":1}\n' > config.local.json
    echo "S1=$s1"
    setup_agent_branch 2>&1
)"
s1="$(printf '%s\n' "$out" | sed -n 's/^S1=//p')"
warn="$(printf '%s\n' "$out" | grep '^WARN: Recorded agent branch' || true)"

fails=0
case "$warn" in *config.local.json*) ;; *) echo "[FAIL] warning does not name config.local.json: $warn"; fails=1 ;; esac
case "$warn" in *"$s1"*) ;; *) echo "[FAIL] warning does not name the recorded branch: $warn"; fails=1 ;; esac
case "$warn" in *"earlier commits"*) ;; *) echo "[FAIL] warning does not say where earlier commits live: $warn"; fails=1 ;; esac
if [ "$fails" = 0 ]; then
    echo "[PASS] refused-resume warning names config.local.json and branch $s1"
    exit 0
fi
exit 1
