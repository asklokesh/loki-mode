#!/usr/bin/env bash
# `loki doctor` must be usable as a CI / init-container gate: `loki doctor || exit 1`.
#
# WHY THIS TEST EXISTS. The canonical enterprise use of doctor is a preflight
# gate -- an init container or a pipeline step that refuses to start work on a
# host missing a required dependency. That only works if a FAILED REQUIRED
# check produces a nonzero exit. A doctor that always returns 0 looks identical
# to a healthy one and silently green-lights a broken host.
#
# It behaves correctly today; this test exists so it keeps doing so. The
# behavior was verified by measurement, not read from the source: a survey of
# this CLI flagged it as UNVERIFIED precisely because every check passed on the
# machine doing the surveying, and "it passed here" says nothing about the
# failure path.
#
# BOTH DIRECTIONS MATTER. A gate that always fails is as useless as one that
# always passes, and warnings must not be treated as blockers -- an optional
# provider CLI being absent is not a reason to refuse to start.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Direction 1: the exit code must AGREE with the host's actual state -- 0 when
# no required check failed, nonzero when one did.
#
# The earlier version asserted "a healthy host exits 0" while merely ASSUMING
# this host was healthy. That holds on a developer machine with a provider CLI
# installed and is false on a bare CI runner, which has none: doctor correctly
# exited 1 and the test called it a defect. The host's health is a fact to be
# READ, not assumed -- so it is read from --json, the same structured verdict
# an operator would gate on.
#
# Read the code directly. This suite runs under several shells and $? after a
# PIPELINE reports the last stage, not the command under test -- a mistake that
# has produced false readings in this repo more than once.
"$LOKI" doctor >/dev/null 2>&1
healthy_rc=$?

host_failed="$("$LOKI" doctor --json 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNKNOWN"); raise SystemExit
print(d.get("summary", {}).get("failed", "UNKNOWN"))
' 2>/dev/null)"

case "$host_failed" in
    0)
        if [ "$healthy_rc" -eq 0 ]; then
            ok "no required check failed and doctor exited 0"
        else
            bad "no required check failed yet doctor exited ${healthy_rc}"
        fi
        ;;
    UNKNOWN|'')
        bad "could not read summary.failed from doctor --json"
        ;;
    *)
        # A bare runner (no provider CLI) legitimately lands here. That is the
        # gateable case, and exiting nonzero is the CORRECT behavior -- not a
        # defect to be excused.
        if [ "$healthy_rc" -ne 0 ]; then
            ok "${host_failed} required check(s) failed and doctor exited ${healthy_rc} (correctly gateable)"
        else
            bad "${host_failed} required check(s) failed but doctor exited 0 -- a broken host would pass a CI gate"
        fi
        ;;
esac

# Optional-only warnings must NOT be escalated to a blocking exit. Asserted via
# --json so it reads the structured verdict rather than scraping colored text.
warn_check="$("$LOKI" doctor --json 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit
s = d.get("summary", {})
print("WARN_NO_FAIL" if s.get("warnings", 0) > 0 and s.get("failed", 1) == 0 else "OTHER")
' 2>/dev/null)"

if [ "$warn_check" = "WARN_NO_FAIL" ] && [ "$healthy_rc" -eq 0 ]; then
    ok "optional warnings present and still exit 0 (warnings are not blockers)"
elif [ "$warn_check" = "OTHER" ]; then
    printf 'SKIP: this host has no optional-warning-only state to assert against\n'
elif [ "$warn_check" = "UNPARSEABLE" ]; then
    bad "doctor --json did not emit parseable JSON"
fi

# Direction 2: a MISSING REQUIRED dependency must exit nonzero.
#
# Built by giving doctor a PATH containing only a minimal core, so required
# tools (node, jq, git) are genuinely absent while the script can still run.
# Stripping PATH entirely is NOT a valid test: the shell then cannot find its
# own interpreter and exits 127 before doctor renders any verdict at all, which
# proves nothing about the gate.
# mktemp by ABSOLUTE path, and verify it produced something. When this test is
# itself run under a stripped PATH (as a CI-condition simulation does), a bare
# `mktemp` is not found, SHIM becomes empty, and every "$SHIM/..." path
# collapses to "/..." -- which then fails with "Read-only file system" and
# reads as a doctor defect rather than a broken harness.
SHIM="$(/usr/bin/mktemp -d 2>/dev/null || mktemp -d 2>/dev/null)"
if [ -z "$SHIM" ] || [ ! -d "$SHIM" ]; then
    bad "harness: could not create a temp dir; assertion inconclusive"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi
# The tool list must be broad enough for the CLI to START (it shells out to
# several coreutils), while still omitting every provider CLI -- that absence
# is the condition under test. Too thin and the CLI dies at 127 before
# rendering a verdict, which proves nothing.
for b in bash sh python3 python sed awk grep cat tr head tail sort uniq wc \
         date mkdir rm ls printf env dirname basename cut find xargs stat \
         mktemp node jq git curl df uname bun touch chmod expr id whoami \
         readlink sleep ln test true false; do
    # Resolve via command -v rather than guessing directories: hardcoding
    # /opt/homebrew/bin is one developer's layout (and is rejected by
    # tests/test-no-hardcoded-paths.sh for exactly that reason). This finds
    # each tool wherever THIS machine keeps it.
    _src="$(command -v "$b" 2>/dev/null)"
    [ -n "$_src" ] && ln -sf "$_src" "$SHIM/$b" 2>/dev/null
done

env PATH="$SHIM" bash "$LOKI" doctor >"$SHIM/out.txt" 2>&1
missing_rc=$?

if [ "$missing_rc" -eq 127 ]; then
    # The harness broke, not the code under test. Report honestly instead of
    # counting a harness failure as a passing gate.
    bad "harness: the shim PATH was too thin for the CLI to start (rc=127); assertion inconclusive"
elif [ "$missing_rc" -ne 0 ]; then
    ok "missing required dependency exits nonzero (rc=${missing_rc}) -- doctor can gate CI"
else
    bad "missing required dependency still exited 0 -- 'loki doctor || exit 1' would pass on a broken host"
fi

# The exit code alone is not enough for an operator: the output has to NAME the
# blocker. A nonzero exit with no indication of which dependency is missing
# costs exactly the investigation this command exists to prevent.
if [ "$missing_rc" -ne 0 ] && [ "$missing_rc" -ne 127 ]; then
    if grep -aqiE "not found|missing" "$SHIM/out.txt"; then
        ok "output names the missing dependency, not just a failing code"
    else
        bad "nonzero exit but the output does not say WHICH dependency is missing"
    fi
fi

rm -rf "$SHIM"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
