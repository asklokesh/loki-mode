#!/usr/bin/env python3
"""Hash-bound oracle probes whose artifacts live OUTSIDE this repository.

WHY THIS EXISTS, and what it fixes about the previous attempt.

The medium and high tiers cannot ship a positive probe in-repo: a correct
`order_api.py`, or a correct `temperature.py` + `roman.py`, IS the answer key,
and committing one contaminates the held-out design the whole benchmark rests
on. So they were probed by hand in a temp directory, the artifacts were
deleted, and the result was written down as VERIFIED.

That was wrong, and it is worth naming precisely: nothing survived, no hash
bound anything to that run, and no process could replay it. An observation
that cannot be replayed is not a receipt, which is the standard this codebase
applies to every other claim.

THE FIX, which is the smallest thing that makes the claim real:

  - artifacts live in a PRIVATE directory outside the repo
    (default ~/loki-bench-private, override with LOKI_BENCH_PRIVATE)
  - each artifact set is content-hashed (sha256 over the sorted file list,
    each file's name and bytes)
  - the receipt records the HASH and the exit codes, never the content
  - a later run recomputes the hash and compares

So the repo carries a verifiable claim -- "these exact bytes produced exit 0
and this near-miss produced exit 1" -- while the bytes themselves stay out of
the training and context of the thing being measured. A reader who does not
have the private directory sees UNVERIFIED, honestly, rather than a claim they
cannot check.

WHAT THIS DELIBERATELY DOES NOT DO. It does not create the artifacts. Writing
them here would put the answer key back in the repo through a side door. It
verifies whatever a human has placed in the private directory, and reports
NOT AVAILABLE when there is nothing there.

THIS RECEIPT DOES NOT PROMOTE A TIER IN tier_receipt.py, deliberately.

The obvious next step is to have tier_receipt read this result and upgrade
medium/high from `not_attempted` to `discriminates`. That is refused, because
the two receipts answer different questions for different readers:

  tier_receipt   what can ANYONE with this repository verify?
  private_probe  what can THIS MACHINE verify, given artifacts it holds?

A reader on a fresh clone has no private directory. If tier_receipt promoted a
tier on evidence they cannot reproduce, its output would depend on who ran it
-- and a receipt whose verdict changes with the operator is exactly the thing
this line of work exists to prevent. It would also re-create, one level up, the
defect already retracted once here: a claim resting on artifacts the reader
cannot see.

So the two stay separate and a human combines them. Promotion would only be
correct if the artifacts became shareable (a second repository, an attested
bundle), which is a distribution decision rather than a code change.

Exit codes: 0 reported, 1 a probe contradicted its recorded result,
            3 nothing to check (no private dir), 64 usage, 66 path missing.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))

# Where a human puts the artifacts. Never inside the repository.
_PRIVATE = os.environ.get(
    "LOKI_BENCH_PRIVATE", os.path.join(os.path.expanduser("~"), "loki-bench-private"))

# Each entry: task -> {probe name -> expected exit code}. The probe names are
# subdirectories the operator creates under <private>/<task>/.
_EXPECTED = {
    "multifail-1-two-modules": {"positive": 0, "adversarial": 1},
    "hard-1-order-api": {"positive": 0, "adversarial": 1},
}


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64; argparse's default 2 means 'could not check'."""

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def artifact_hash(directory):
    """sha256 over the sorted (name, bytes) pairs in a directory.

    Names are included, not just contents: two artifact sets with identical
    bytes under different filenames are different inputs to a grader that
    imports by module name, and hashing contents alone would call them equal.
    """
    h = hashlib.sha256()
    names = sorted(n for n in os.listdir(directory)
                   if os.path.isfile(os.path.join(directory, n)))
    if not names:
        return None
    for n in names:
        h.update(n.encode("utf-8"))
        h.update(b"\0")
        with open(os.path.join(directory, n), "rb") as fh:
            h.update(fh.read())
        h.update(b"\0")
    return h.hexdigest()


def _grader(task):
    return os.path.join(_ROOT, "benchmarks", "bench", "fixtures",
                        task + "-overlay", "check_acceptance.py")


def run_probe(task, probe, src_dir):
    """Copy the artifacts into a scratch dir, run the grader, return a record.

    The grader runs against a COPY so a grader that writes files cannot mutate
    the private artifacts and silently change their hash between runs.
    """
    digest = artifact_hash(src_dir)
    if digest is None:
        return {"probe": probe, "status": "empty",
                "why": "no files in %s" % src_dir}
    grader = _grader(task)
    if not os.path.isfile(grader):
        return {"probe": probe, "status": "no_grader", "artifact_sha256": digest}
    with tempfile.TemporaryDirectory() as scratch:
        for n in sorted(os.listdir(src_dir)):
            s = os.path.join(src_dir, n)
            if os.path.isfile(s):
                with open(s, "rb") as a, open(os.path.join(scratch, n), "wb") as b:
                    b.write(a.read())
        proc = subprocess.run([sys.executable, grader], cwd=scratch,
                              capture_output=True, text=True, timeout=180)
    out = (proc.stdout or proc.stderr or "").strip().splitlines()
    return {
        "probe": probe,
        "status": "measured",
        "artifact_sha256": digest,
        "exit_code": proc.returncode,
        "expected_exit": _EXPECTED.get(task, {}).get(probe),
        "message": (out[0][:100] if out else ""),
    }


def build():
    if not os.path.isdir(_PRIVATE):
        return None
    tasks = []
    for task, probes in sorted(_EXPECTED.items()):
        tdir = os.path.join(_PRIVATE, task)
        if not os.path.isdir(tdir):
            tasks.append({"task": task, "status": "not_available",
                          "why": "no %s in the private directory" % task})
            continue
        recs = []
        for probe in sorted(probes):
            pdir = os.path.join(tdir, probe)
            if not os.path.isdir(pdir):
                recs.append({"probe": probe, "status": "not_available"})
                continue
            recs.append(run_probe(task, probe, pdir))
        measured = [r for r in recs if r.get("status") == "measured"]
        agree = [r for r in measured if r.get("exit_code") == r.get("expected_exit")]
        disagree = [r for r in measured if r.get("exit_code") != r.get("expected_exit")]
        if disagree:
            status = "contradicted"
        elif len(agree) == len(probes):
            status = "verified"
        else:
            status = "incomplete"
        tasks.append({"task": task, "status": status, "probes": recs})
    return {
        "schema_version": "1.0",
        "receipt_type": "private_hash_bound_oracle_probe",
        "private_dir": _PRIVATE,
        "artifacts_in_repo": False,
        "tasks": tasks,
    }


def render(r):
    lines = ["PRIVATE ORACLE PROBE (hash-bound, artifacts outside the repo)",
             "  dir: %s" % r["private_dir"], ""]
    for t in r["tasks"]:
        lines.append("  %-26s %s" % (t["task"], t["status"]))
        for p in t.get("probes", []):
            if p.get("status") != "measured":
                lines.append("      %-12s %s" % (p["probe"], p.get("status")))
                continue
            mark = "ok" if p["exit_code"] == p["expected_exit"] else "CONTRADICTED"
            lines.append("      %-12s exit=%s expected=%s  %s"
                         % (p["probe"], p["exit_code"], p["expected_exit"], mark))
            lines.append("                   sha256=%s" % p["artifact_sha256"][:32])
            if p.get("message"):
                lines.append("                   %s" % p["message"][:64])
    lines += [
        "",
        "  A tier reads `verified` only when every probe ran AND matched its",
        "  expected exit code. Absent artifacts read not_available, never a",
        "  pass: this receipt cannot verify what it was not given.",
    ]
    return "\n".join(lines)


def main(argv=None):
    p = _Parser(description="Verify oracle probes against hash-bound artifacts "
                            "held outside this repository. Runs no agent.")
    p.add_argument("--json", action="store_true", help="emit the receipt as JSON")
    args = p.parse_args(argv)

    r = build()
    if r is None:
        sys.stderr.write(
            "NOTHING TO CHECK: no private artifact directory at %s\n" % _PRIVATE)
        sys.stderr.write(
            "  Create <dir>/<task>/{positive,adversarial}/ and place the\n"
            "  artifacts there. They must NOT be added to this repository:\n"
            "  a correct solution is the answer key.\n")
        return 3

    if args.json:
        sys.stdout.write(json.dumps(r, indent=2, sort_keys=True) + "\n")
    else:
        sys.stdout.write(render(r) + "\n")

    # A contradiction is a real defect in the evidence chain: either the grader
    # changed behaviour or the artifacts are not what the record says.
    if any(t["status"] == "contradicted" for t in r["tasks"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
