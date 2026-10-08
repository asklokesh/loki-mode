#!/usr/bin/env bash
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

for path in sorted(glob.glob(os.path.join(wfdir, "*.yml"))):
    fn = os.path.basename(path)
    doc = yaml.safe_load(open(path))
    jobs = (doc or {}).get("jobs") or {}
    for jname, job in jobs.items():
        coe = job.get("continue-on-error")
        if truthy_literal(coe):
            if (fn, jname, None) not in COE_ALLOW:
                fail(f"{fn}:{jname}: unconditional job-level continue-on-error: true hides a failed job from the run conclusion (R1)")
        elif isinstance(coe, str) and "matrix." in coe:
            for leg in legs((job.get("strategy") or {}).get("matrix")):
                expr = coe.strip()
                m = re.fullmatch(r"\$\{\{\s*matrix\.(\w+)\s*==\s*true\s*\}\}", expr)
                if not m:
                    fail(f"{fn}:{jname}: unsupported continue-on-error expression {coe!r} (use matrix.<key> == true)")
                    break
                if leg.get(m.group(1)) is True and str(leg.get("bun-version")) != "latest":
                    fail(f"{fn}:{jname}: pinned leg {leg} is experimental, so its failure would not fail the run (R2)")
        cond = str(job.get("if", ""))
        if re.search(r"\balways\(\)", cond) and (fn, jname) not in ALWAYS_ALLOW:
            fail(f"{fn}:{jname}: if: always() aggregator not on the reviewed allowlist (R5)")
        for st in job.get("steps") or []:
            sname = st.get("name") or st.get("id") or "?"
            if truthy_literal(st.get("continue-on-error")) and (fn, jname, sname) not in COE_ALLOW:
                fail(f"{fn}:{jname}: step {sname!r} has unconditional continue-on-error: true (R1)")
            run = st.get("run")
            if not isinstance(run, str) or not TEST_CMD.search(run):
                continue
            pipefail = "pipefail" in run or st.get("shell") == "bash"
            for line in run.splitlines():
                s = line.strip()
                if s.startswith("#") or not TEST_CMD.search(s):
                    continue
                if re.search(r"\|\|\s*true\s*$", s) or re.search(r"\|\|\s*:\s*$", s):
                    fail(f"{fn}:{jname}: step {sname!r}: test command masked by '|| true': {s[:90]} (R3)")
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
exit $?
