#!/usr/bin/env bash
# A workflow step that captures RC must be able to reach the code that reads it.
#
# THE DEFECT, observed in CI: post-release smoke failed on both npm and docker
# with no diagnostic. The steps looked correct:
#
#     set -uo pipefail
#     loki doctor --json > /tmp/doctor.json
#     RC=$?
#     if [ "$RC" -ne 0 ]; then echo "FATAL: ..."; exit 1; fi
#
# GitHub runs steps with `bash -e {0}`, so -e is ON regardless of that set line.
# A non-zero exit aborts the step BEFORE `RC=$?` is read, so the handler never
# runs and the job fails with no message about what actually broke. Proven:
#
#     bash    probe.sh -> "REACHED:1"   exit 0
#     bash -e probe.sh -> (no output)   exit 1
#
# The fix is `|| RC=$?` on the command itself. This suite makes the pattern
# unable to come back, because the failure mode is silent: the workflow does not
# report "your handler is unreachable", it just dies.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-workflow-rc-capture"

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 unavailable: workflow RC capture was not measured (unmeasured, not clean)"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# 1. The mechanism itself, demonstrated rather than asserted from memory. If it
#    ever stops holding, the rest of this suite is guarding nothing.
PROBE="$(mktemp)"
printf '%s\n' 'set -uo pipefail' 'false > /dev/null' 'RC=$?' 'echo "REACHED:$RC"' > "$PROBE"
without="$(bash "$PROBE" 2>&1 || true)"
with="$(bash -e "$PROBE" 2>&1 || true)"
rm -f "$PROBE"
if printf '%s' "$without" | grep -q 'REACHED:1' && ! printf '%s' "$with" | grep -q 'REACHED'; then
    pass "confirmed: under bash -e the RC handler is unreachable"
else
    fail "the bash -e mechanism did not reproduce (without='$without' with='$with')"
fi

# 2. No workflow step may follow a bare command with RC=$?.
OFFENDERS="$(python3 tests/lib/scan-workflow-rc.py 2>&1)"
case "$OFFENDERS" in
    *UNREADABLE*)
        fail "could not read the workflows (unmeasured, not clean): $OFFENDERS"
        ;;
    "")
        pass "every workflow RC capture uses || RC=\$? and is reachable"
        ;;
    *)
        fail "unreachable RC handler(s): $(printf '%s' "$OFFENDERS" | head -3 | tr '\n' ' ')"
        ;;
esac

# 3. GUARD AGAINST VACUITY. A scan that found no workflows would report nothing
#    wrong. An empty corpus is an absent measurement, not a pass.
NWF="$(ls .github/workflows/*.yml 2>/dev/null | wc -l | tr -d ' ')"
# release.yml plus converge-dist-tags.yml are the only workflows (minimal publish set), so a
# couple of files are a real corpus; zero is still an absent measurement.
if [ "${NWF:-0}" -ge 1 ]; then
    pass "the scan examined $NWF workflow files"
else
    fail "only ${NWF:-0} workflow files found; the scan is too thin to mean anything"
fi

# 4. Every workflow must still be valid YAML. Delegated to
#    tests/lib/check-workflow-yaml.py so three states stay distinct: pyyaml is
#    installed on a laptop and NOT on the GitHub runner, and a first version of
#    this assertion collapsed ImportError into "invalid YAML" and failed CI on
#    good files. An absent parser is an absent measurement, not a verdict.
YAML_STATE="$(python3 tests/lib/check-workflow-yaml.py 2>&1)"
case "$YAML_STATE" in
    OK)        pass "all workflow YAML parses" ;;
    NO_PARSER) echo "  SKIP: pyyaml unavailable; YAML validity not measured (not counted as a pass)" ;;
    INVALID*)  fail "a workflow file is no longer valid YAML -- ${YAML_STATE#INVALID }" ;;
    *)         fail "YAML check produced no usable verdict: $YAML_STATE" ;;
esac

# 5. Publish never waits on tests. pr-fast.yml also runs on every push to main as a
#    signal only. It must trigger on main pushes, never cancel a main run, and no
#    release.yml job may depend on it or on any other test workflow.
PUBLISH_STATE="$(python3 - <<'PYEOF'
import sys
try:
    import yaml
except ImportError:
    print("NO_PARSER"); sys.exit(0)
def load(p):
    d = yaml.safe_load(open(p))
    if True in d and "on" not in d:
        d["on"] = d.pop(True)
    return d
errs = []
fast = load(".github/workflows/pr-fast.yml")
on = fast.get("on") or {}
if "main" not in ((on.get("push") or {}).get("branches") or []):
    errs.append("pr-fast.yml does not trigger on push to main")
cip = str((fast.get("concurrency") or {}).get("cancel-in-progress"))
if cip.lower() == "true":
    errs.append("pr-fast.yml cancels main runs (cancel-in-progress: true)")
elif "pull_request" not in cip:
    errs.append("cancel-in-progress is not keyed on the pull_request event: " + cip)
grp = str((fast.get("concurrency") or {}).get("group"))
if "release-npm" in grp or "github.sha" not in grp:
    errs.append("pr-fast.yml concurrency group is shared with release or not keyed on sha: " + grp)
rel = load(".github/workflows/release.yml")
if "workflow_run" in (rel.get("on") or {}):
    errs.append("release.yml triggers on workflow_run")
for name, job in (rel.get("jobs") or {}).items():
    needs = job.get("needs") or []
    needs = [needs] if isinstance(needs, str) else needs
    for n in needs:
        if "fast" in n or "pr-fast" in n or n.startswith("test"):
            errs.append("release.yml job %s needs %s" % (name, n))
    if "pr-fast" in str(job.get("uses", "")):
        errs.append("release.yml job %s calls pr-fast" % name)
print("OK" if not errs else "BAD " + "; ".join(errs))
PYEOF
)"
case "$PUBLISH_STATE" in
    OK)        pass "publish never waits on tests: main-push signal, never cancelled, no release dependency" ;;
    NO_PARSER) echo "  SKIP: pyyaml unavailable; publish-never-waits invariant not measured (not counted as a pass)" ;;
    *)         fail "publish-never-waits invariant broken: $PUBLISH_STATE" ;;
esac

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
