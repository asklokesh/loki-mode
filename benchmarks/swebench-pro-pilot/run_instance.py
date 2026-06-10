#!/usr/bin/env python3
"""SWE-bench Pro instance -> Loki -> graded patch adapter (agent-on-host).

Per the pilot runbook Section 3, path (b) agent-on-host (chosen because Loki's
multi-agent fleet under QEMU amd64 emulation is too slow for a calibration
batch; the container is only needed for grading, which resets to base_commit).

Fidelity guarantee: the host workdir is the repo's /app tree extracted from the
SAME instance image the grader uses, checked out at base_commit. So the host
diff base == the grader's `git reset --hard base_commit` base, exactly.

Flow per instance:
  1. Compute image URI (helper_code/image_uri.py), pull --platform linux/amd64.
  2. Extract /app from the image into a host workdir; checkout base_commit;
     remove the held-out test_patch files so the agent never sees them (they are
     not part of the source fix and must not collide with the baked tests).
  3. Write problem_statement to ISSUE.md (the spec).
  4. Run `loki start ISSUE.md` bounded (LOKI_MAX_ITERATIONS, LOKI_BUDGET_LIMIT).
  5. Extract `git diff base_commit` EXCLUDING test files (selected_test_files_to_run
     and any path matching the known test dirs). Strip the .loki/ artifacts.
  6. Collect cost from .loki/metrics/efficiency/*.json. Record wall time.

Emits a per-instance record and appends the {instance_id, patch, prefix} to the
predictions JSON. NEVER reports resolved/success; the official evaluator grades.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time

HELPER = "/tmp/swebench-pro-pilot/SWE-bench_Pro-os/helper_code"
DATASET = os.path.join(HELPER, "sweap_eval_full_v2.jsonl")
sys.path.insert(0, HELPER)
from image_uri import get_dockerhub_image_uri  # noqa: E402

PLATFORM = "linux/amd64"
LOKI_BIN = "/Users/lokesh/.bun/bin/loki"


def load_row(instance_id):
    with open(DATASET) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r["instance_id"] == instance_id:
                return r
    raise KeyError(instance_id)


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def pull_image(uri):
    r = sh(["docker", "pull", "--platform", PLATFORM, uri], timeout=3600)
    return r.returncode == 0, r.stderr[-2000:] if r.returncode else ""


def extract_app(uri, dest, base_commit):
    """Create a container from the image, copy /app to dest, checkout base."""
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    cid = sh(["docker", "create", "--platform", PLATFORM, uri]).stdout.strip()
    if not cid:
        raise RuntimeError("docker create failed for " + uri)
    try:
        cp = sh(["docker", "cp", f"{cid}:/app", dest])
        if cp.returncode != 0:
            raise RuntimeError("docker cp /app failed: " + cp.stderr[-500:])
    finally:
        sh(["docker", "rm", "-f", cid])
    # checkout base_commit so host diff base == grader reset base
    sh(["git", "stash"], cwd=dest)
    co = sh(["git", "checkout", "-f", base_commit], cwd=dest)
    if co.returncode != 0:
        raise RuntimeError("git checkout base_commit failed: " + co.stderr[-500:])
    # clean any untracked from the image build so diff is clean
    sh(["git", "clean", "-fd"], cwd=dest)
    return dest


def test_paths_for(row):
    """Paths the agent's diff must NEVER include (held-out tests)."""
    paths = set()
    raw = row.get("selected_test_files_to_run")
    try:
        lst = raw if isinstance(raw, list) else json.loads(raw)
        for p in lst:
            paths.add(p.strip())
    except Exception:
        pass
    # test_patch enumerates the held-out test files too
    for line in (row.get("test_patch") or "").splitlines():
        m = re.match(r"\+\+\+ b/(.+)$", line)
        if m:
            paths.add(m.group(1).strip())
    return paths


TEST_DIR_RE = re.compile(r"(^|/)(test|tests|__tests__|spec)(/|$)")


def extract_patch(workdir, base_commit, test_paths):
    """git diff base_commit, dropping .loki and held-out test files."""
    r = sh(["git", "add", "-A"], cwd=workdir)
    # Get list of changed files (staged) vs base
    diff_names = sh(["git", "diff", "--name-only", base_commit], cwd=workdir).stdout
    keep = []
    dropped = []
    for f in diff_names.splitlines():
        f = f.strip()
        if not f:
            continue
        if f.startswith(".loki/") or f == "ISSUE.md":
            dropped.append(f)
            continue
        if f in test_paths:
            dropped.append(f)
            continue
        keep.append(f)
    if not keep:
        return "", dropped
    diff = sh(["git", "diff", base_commit, "--"] + keep, cwd=workdir).stdout
    return diff, dropped


def collect_cost(loki_dir):
    eff = os.path.join(loki_dir, "metrics", "efficiency")
    pricing = {"opus": (5.0, 25.0), "sonnet": (3.0, 15.0), "haiku": (1.0, 5.0)}
    total = 0.0
    tin = tout = 0
    found = False
    if os.path.isdir(eff):
        import glob
        for fp in glob.glob(os.path.join(eff, "*.json")):
            try:
                d = json.load(open(fp))
            except Exception:
                continue
            found = True
            c = d.get("cost_usd")
            i = d.get("input_tokens", 0) or 0
            o = d.get("output_tokens", 0) or 0
            tin += i
            tout += o
            if c is not None:
                total += float(c)
            else:
                p = pricing.get((d.get("model") or "sonnet").lower(), pricing["sonnet"])
                total += i / 1e6 * p[0] + o / 1e6 * p[1]
    return {"usd": round(total, 4) if found else None,
            "input_tokens": tin or None, "output_tokens": tout or None,
            "found": found}


def run(instance_id, work_root, max_iter=8, budget=8, timeout=5400):
    row = load_row(instance_id)
    repo = row["repo"]
    base = row["base_commit"]
    uri = get_dockerhub_image_uri(instance_id, "jefzda", repo)
    rec = {"instance_id": instance_id, "repo": repo, "base_commit": base,
           "image": uri, "patch_produced": False, "patch_len": 0,
           "cost": None, "wall_s": None, "exit": None, "error": None,
           "dropped_files": []}
    t0 = time.time()

    ok, err = pull_image(uri)
    if not ok:
        rec["error"] = "image_pull_failed: " + err
        rec["wall_s"] = round(time.time() - t0, 1)
        return rec, ""

    workdir = os.path.join(work_root, instance_id)
    try:
        extract_app(uri, workdir, base)
    except Exception as e:
        rec["error"] = "extract_app_failed: " + str(e)
        rec["wall_s"] = round(time.time() - t0, 1)
        return rec, ""

    with open(os.path.join(workdir, "ISSUE.md"), "w") as f:
        f.write(row["problem_statement"])

    env = dict(os.environ)
    env.update({
        "LOKI_MAX_ITERATIONS": str(max_iter),
        "LOKI_BUDGET_LIMIT": str(budget),
        "LOKI_AUTO_CONFIRM": "true",
        "LOKI_AUTONOMY_OVERRIDE": "1",
    })
    cmd = [LOKI_BIN, "start", "ISSUE.md", "--provider", "claude",
           "--no-dashboard", "--yes"]
    try:
        proc = subprocess.run(cmd, cwd=workdir, env=env, timeout=timeout,
                              capture_output=True, text=True)
        rec["exit"] = proc.returncode
    except subprocess.TimeoutExpired:
        rec["exit"] = "timeout"

    test_paths = test_paths_for(row)
    patch, dropped = extract_patch(workdir, base, test_paths)
    rec["dropped_files"] = dropped
    rec["patch_produced"] = bool(patch.strip())
    rec["patch_len"] = len(patch)
    rec["cost"] = collect_cost(os.path.join(workdir, ".loki"))
    rec["wall_s"] = round(time.time() - t0, 1)
    return rec, patch


if __name__ == "__main__":
    iid = sys.argv[1]
    work_root = sys.argv[2] if len(sys.argv) > 2 else "/tmp/swebench-pro-pilot/runs"
    rec, patch = run(iid, work_root)
    print(json.dumps(rec, indent=2))
    out = os.path.join(work_root, iid + ".patch")
    with open(out, "w") as f:
        f.write(patch)
    print("patch written:", out)
