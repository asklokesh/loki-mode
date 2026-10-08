#!/usr/bin/env bash
# shellcheck disable=SC2016  # workflow expressions are literal text, never expanded
# FC-57: a CI job or step must not hide a real failure from the workflow
# conclusion. Nightly run 37780519439 concluded SUCCESS while the pinned
# "Bun tests on macos-latest bun=1.3.13" leg failed, because the job carried a
# job-level `continue-on-error: true`. D90 and release.yml required-ci read the
# workflow conclusion, so they saw green.
#
# Rules, applied to every .github/workflows/*.yml (override dir: WORKFLOW_DIR):
#   R1 no unconditional `continue-on-error: true` on a job or step, except the
#      justified allowlist below (an expression such as
#      `${{ matrix.experimental == true }}` is allowed and is evaluated per
#      matrix leg, see R2).
#   R2 a matrix leg that is allowed to fail must be an `experimental` leg of an
#      unpinned toolchain (bun-version latest); a pinned leg may never be
#      experimental.
#   R3 a step that runs a test command must not mask it with `|| true`.
#   R4 a step that pipes a test command into tee/head/grep must set pipefail
#      (in the script, or via `shell: bash`), else the pipe hides the rc.
#   R5 a job gated by `if: always()` (`!cancelled()` run-gates are fine) is a result aggregator
#      and must be on the reviewed allowlist.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
WFDIR="${1:-${WORKFLOW_DIR:-.github/workflows}}"

echo "test-workflow-no-masked-failures ($WFDIR)"

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import yaml' 2>/dev/null; then
    echo "  FAIL: python3 + PyYAML unavailable: workflows were not measured (unmeasured, not clean)"
    exit 1
fi

python3 -I - "$WFDIR" <<'PY'
import glob, itertools, os, re, sys, yaml

wfdir = sys.argv[1]

# (file, job, step name or None for the job itself) -> justification.
COE_ALLOW = {
    ("test.yml", "version-bump-gate", "Reuse a train run's verdict for this exact SHA"):
        "reuse lookup; a failure means reuse=false and the full suite runs",
    ("security-audit.yml", "train-reuse", "Reuse a train run's verdict for this exact SHA"):
        "reuse lookup; a failure means no reuse and the audit runs in full",
    ("security-audit.yml", "python-audit", "pip-audit every requirements file"):
        "findings reported; the next step asserts a parseable report for every manifest",
    ("release.yml", "publish-docker", "Update Docker Hub description"):
        "cosmetic; the image publish already succeeded and PAT scope can 403",
}
ALWAYS_ALLOW = {
    ("post-release-smoke.yml", "notify"):
        "notifier only; the smoke jobs it reports on fail the run themselves",
}
TEST_CMD = re.compile(
    r"(bun test|npm test|npm run test|pytest|node --test|bash tests/|run-all-tests|"
    r"bun run typecheck|tsc --noEmit|first-run-gate|select-tests)")

fails = []
def fail(msg): fails.append(msg)

def truthy_literal(v):
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")

def legs(matrix):
    """Expand a matrix the way Actions does: cross product, minus excludes, with
    include entries merged into legs whose original keys all match."""
    if not isinstance(matrix, dict):
        return [{}]
    axes = {k: v for k, v in matrix.items() if k not in ("include", "exclude") and isinstance(v, list)}
    base = [dict(zip(axes, c)) for c in itertools.product(*axes.values())] if axes else [{}]
    for ex in matrix.get("exclude") or []:
        base = [l for l in base if not all(l.get(k) == v for k, v in ex.items())]
    out = [dict(l) for l in base]
    for inc in matrix.get("include") or []:
        matched = False
        for l in out:
            if all(l.get(k) == v for k, v in inc.items() if k in axes):
                l.update(inc)
                matched = True
        if not matched:
            out.append(dict(inc))
    return out

COE_EXPR = re.compile(r"\$\{\{\s*matrix\.(\w+)\s*==\s*true\s*\}\}")

def check_coe(where, value, matrix, allow_key):
    """ONE rule for job and step level. absent/false is fine; literal true needs
    the allowlist; any other string must be exactly `matrix.<key> == true` and
    then no pinned leg may have that key true (R2). `${{ true }}`, event-name
    conditions and every other expression are rejected (R1)."""
    if value is None or value is False:
        return
    if truthy_literal(value):
        if allow_key not in COE_ALLOW:
            fail(f"{where}: unconditional continue-on-error: true hides a failure from the run conclusion (R1)")
        return
    if isinstance(value, str) and value.strip().lower() == "false":
        return
    m = COE_EXPR.fullmatch(value.strip()) if isinstance(value, str) else None
    if not m:
        fail(f"{where}: unsupported continue-on-error {value!r}; only matrix.<key> == true is allowed (R1)")
        return
    for leg in legs(matrix):
        if leg.get(m.group(1)) is True and str(leg.get("bun-version")) != "latest":
            fail(f"{where}: pinned leg {leg} is experimental, so its failure would not fail the run (R2)")

# A test command followed by `||` is masked unless the handler fails: it must
# contain `exit <nonzero or $var>` or `false`. Covers || true, || :, || exit 0,
# || echo ..., `|| true; next`, and trailing comments, with one rule.
HANDLER_FAILS = re.compile(r"\bexit\s+([1-9]|\$|\"\$)|\bfalse\b")

def masked(line, run):
    line = re.sub(r"\s+#.*$", "", line)
    parts = line.split("||")
    if len(parts) < 2 or not TEST_CMD.search(parts[0]):
        return False
    for h in parts[1:]:
        if HANDLER_FAILS.search(h):
            return False
        cap = re.match(r"\s*(\w+)=\$\?\s*$", h)  # `|| rc=$?` is fine iff the step exits on it
        if cap and re.search(r"\bexit\s+\"?\$\{?" + cap.group(1) + r"\b", run):
            return False
    return True

ALWAYS_COND = re.compile(r"\b(always|failure)\(\)")

for path in sorted(glob.glob(os.path.join(wfdir, "*.yml"))):
    fn = os.path.basename(path)
    doc = yaml.safe_load(open(path))
    jobs = (doc or {}).get("jobs") or {}
    for jname, job in jobs.items():
        matrix = (job.get("strategy") or {}).get("matrix")
        check_coe(f"{fn}:{jname}", job.get("continue-on-error"), matrix, (fn, jname, None))
        if ALWAYS_COND.search(str(job.get("if", ""))) and (fn, jname) not in ALWAYS_ALLOW:
            fail(f"{fn}:{jname}: if: always()/failure() aggregator not on the reviewed allowlist (R5)")
        for st in job.get("steps") or []:
            sname = st.get("name") or st.get("id") or "?"
            check_coe(f"{fn}:{jname}: step {sname!r}", st.get("continue-on-error"), matrix, (fn, jname, sname))
            run = st.get("run")
            if not isinstance(run, str) or not TEST_CMD.search(run):
                continue
            pipefail = "pipefail" in run or st.get("shell") == "bash"
            for line in run.replace("\\\n", " ").splitlines():
                s = line.strip()
                if s.startswith("#") or not TEST_CMD.search(s):
                    continue
                if masked(s, run):
                    fail(f"{fn}:{jname}: step {sname!r}: test command masked by '||': {s[:90]} (R3)")
                if re.search(r"\|\s*(tee|head|grep|sed|awk|cat)\b", s) and not pipefail:
                    fail(f"{fn}:{jname}: step {sname!r}: test command piped without pipefail: {s[:90]} (R4)")

# Positive control: the files this guard exists for were actually parsed.
want = ["nightly.yml", "test.yml", "release.yml", "full-suite.yml", "post-release-smoke.yml"]
if os.path.basename(wfdir.rstrip("/")) == "workflows" and wfdir == ".github/workflows":
    for w in want:
        if not os.path.exists(os.path.join(wfdir, w)):
            fail(f"expected workflow {w} missing: sweep would be vacuous")

for f in fails:
    print("  FAIL: " + f)
if not fails:
    print("  PASS: no masked failures across", len(glob.glob(os.path.join(wfdir, '*.yml'))), "workflows")
sys.exit(1 if fails else 0)
PY
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

# Self-test: every masking shape must turn the guard red on a mutated copy of
# the real workflows (skipped when a directory argument is given).
[ -z "${1:-}" ] || exit 0
SELF="$(mktemp -d "${TMPDIR:-/tmp}/loki-nomask.XXXXXX")" || exit 1
trap 'rm -rf -- "$SELF"' EXIT
SELF_FAIL=0
mut() { # name file old new
    local d="$SELF/$1"
    mkdir -p "$d" && cp .github/workflows/*.yml "$d/"
    python3 -I - "$d/$2" "$3" "$4" <<'MP'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
assert a in s, "mutation anchor missing: " + a
open(p, "w").write(s.replace(a, b, 1))
MP
    bash "$0" "$d" >/dev/null 2>&1
    if [ $? -eq 1 ]; then echo "  PASS: $1 turns the guard red"; else echo "  FAIL: $1 not caught"; SELF_FAIL=1; fi
}
JOB='    continue-on-error: ${{ matrix.experimental == true }}'
STEP='        run: bun test
'
mut M04-job-expr-true nightly.yml "$JOB" '    continue-on-error: ${{ true }}'
mut M05-job-event-name nightly.yml "$JOB" "    continue-on-error: \${{ github.event_name == 'schedule' }}"
mut M06-step-expr-true nightly.yml "$STEP" '        continue-on-error: ${{ true }}
        run: bun test
'
mut M07-exit-0 nightly.yml "$STEP" '        run: bun test || exit 0
'
mut M08-echo nightly.yml "$STEP" '        run: bun test || echo ignored
'
mut M09-true-then nightly.yml "$STEP" '        run: bun test || true; echo next
'
mut M10-true-comment nightly.yml "$STEP" '        run: bun test || true  # tolerated
'
mut M11-success-or-failure release.yml '    needs: [gate, required-ci]
' '    needs: [gate, required-ci]
    if: success() || failure()
'
mut M12-always release.yml '    needs: [gate, required-ci]
' '    needs: [gate, required-ci]
    if: always()
'
exit "$SELF_FAIL"
