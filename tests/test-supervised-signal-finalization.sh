#!/usr/bin/env bash
# Regression: supervisor TERM must settle state, emit an honest proof, release
# the session lock, and exit 143 instead of being overwritten by a later trap.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/loki-signal-finalize-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/project/.loki/state"

DRIVER="$TMP_ROOT/driver.sh"
cat > "$DRIVER" <<'DRIVER'
#!/usr/bin/env bash
set -uo pipefail
export TARGET_DIR="$LOKI_TEST_TARGET"
export LOKI_SUPERVISED_BUILD=1
export LOKI_PROOF=1
export LOKI_PROVEN_PR=0
export LOKI_SESSION_ID=""
cd "$TARGET_DIR"
# shellcheck source=/dev/null
source "$LOKI_TEST_RUN_SH"

log_warn() { :; }
log_info() { :; }
kill_provider_child() { :; }
app_runner_cleanup() { :; }
stop_status_monitor() { :; }
stop_dashboard() { :; }
loki_mark_project_stopped_and_maybe_kill_shared_dashboard() { :; }
kill_all_registered() { :; }
emit_event_json() { printf '%s\n' "$*" > "$TARGET_DIR/event-called"; }
_loki_terminal_record() { printf 'called\n' > "$TARGET_DIR/terminal-called"; }
safe_release_lock() { printf '%s\n' "$1" > "$TARGET_DIR/lock-released"; }

_loki_arm_session_exit_cleanup "$TARGET_DIR/session.lock"
_loki_install_signal_traps
kill -TERM "$$"
exit 99
DRIVER
chmod +x "$DRIVER"

set +e
LOKI_TEST_TARGET="$TMP_ROOT/project" \
LOKI_TEST_RUN_SH="$REPO_ROOT/autonomy/run.sh" \
bash "$DRIVER" >/dev/null 2>&1
rc=$?
set -e

[ "$rc" -eq 143 ] || {
    echo "FAIL: supervised TERM exited $rc, expected 143"
    exit 1
}

python3 - "$TMP_ROOT/project" <<'PY'
import glob
import json
import os
import sys

root = sys.argv[1]
with open(os.path.join(root, ".loki", "autonomy-state.json")) as handle:
    state = json.load(handle)
assert state["status"] == "interrupted", state
assert state["lastExitCode"] == 143, state

with open(os.path.join(root, ".loki", "state", "termination.json")) as handle:
    termination = json.load(handle)
assert termination["terminated"] is True, termination
assert termination["signal"] == "TERM", termination
assert termination["exit_code"] == 143, termination

proofs = glob.glob(os.path.join(root, ".loki", "proofs", "*", "proof.json"))
assert len(proofs) == 1, proofs
with open(proofs[0]) as handle:
    proof = json.load(handle)
assert proof["facts"]["execution"]["terminated"] is True, proof["facts"]
assert proof["honesty"]["headline"] == "NOT VERIFIED", proof["honesty"]
degraded = {item["item"] for item in proof["honesty"]["degraded"]}
assert "execution" in degraded, degraded
PY

[ -f "$TMP_ROOT/project/terminal-called" ] || {
    echo "FAIL: EXIT finalizer did not record terminal state"
    exit 1
}
grep -qx "$TMP_ROOT/project/session.lock" "$TMP_ROOT/project/lock-released" || {
    echo "FAIL: EXIT finalizer did not release the session lock"
    exit 1
}

echo "PASS: supervised TERM exited 143 and persisted interrupted state"
echo "PASS: termination proof is NOT VERIFIED and EXIT cleanup released lock"
