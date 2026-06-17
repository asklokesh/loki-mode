#!/usr/bin/env python3
"""Run the first N instances of the pinned subset sequentially through Loki.

Produces (in <work_root>, disposable /tmp by default):
  - <work_root>/loki_predictions.json   ({instance_id, patch, prefix} list)
  - <work_root>/batch_records.json      (per-instance run records: cost, wall, etc.)
  - <work_root>/<iid>.patch             (each patch on disk)

Durability (data-loss fix): every completed instance is ALSO persisted, the
moment it finishes, to a durable, repo-relative ledger that survives a reboot,
a /tmp wipe, and any cleanup glob:
  - <durable>/records/<iid>.json        (one atomic per-instance record)
  - <durable>/patches/<iid>.patch       (one atomic per-instance patch)
where <durable> defaults to benchmarks/results/swebench-pro-pilot/ (override
with SWEBENCH_PRO_DURABLE_DIR). Each write is temp-file + os.replace (atomic),
so a crash mid-write can never corrupt a prior completed instance: prior
instances live in their OWN files and are never rewritten. On re-run the batch
SKIPs every instance already recorded in the durable ledger (resume), unless
--force / --rerun is passed.

Run grading separately via the official evaluator (see METHODOLOGY.md Section 6).
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_instance  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SUBSET = os.path.join(HERE, "pilot-subset-119.json")

# Durable ledger root. Repo-relative (like SUBSET) so it NEVER lands in /tmp and
# a reboot / `rm -rf /tmp/loki-*` / git-branch prune structurally cannot reach
# it. A distinct subdir from run-benchmarks.sh's results/<timestamp>/ so the two
# harnesses never collide. Env-overridable so tests point it at a tempdir.
DURABLE_DIR = os.environ.get(
    "SWEBENCH_PRO_DURABLE_DIR",
    os.path.normpath(os.path.join(HERE, "..", "results", "swebench-pro-pilot")),
)


def _atomic_write(path, data):
    """Write `data` (str) to `path` atomically: temp file in the same dir +
    os.replace. os.replace is atomic on POSIX, so a reader/crash sees either the
    full old file or the full new file, never a truncated half-write."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def is_completed(rec):
    """A record represents a COMPLETED instance (loki actually ran to a verdict)
    iff it carries no harness/infra error. Infra failures (image_pull_failed,
    extract_app_failed) and budget-exhausted placeholders are NOT completions:
    they must stay re-runnable on a later resume, never frozen into the durable
    ledger. A no-patch or timeout-with-no-error run IS a completion (loki ran;
    "no fix produced" is a real, gradeable outcome)."""
    return rec.get("error") is None


def persist_durable(durable_dir, rec, patch):
    """Persist one COMPLETED instance to the durable ledger, atomically, the
    moment it finishes. record -> <durable>/records/<iid>.json ; patch (if any)
    -> <durable>/patches/<iid>.patch. Idempotent: re-persisting overwrites the
    same per-instance file, never touching any OTHER instance's file. Returns
    True if persisted; infra-failure / non-completion records are NOT persisted
    (so a transient pull/extract failure is retried on the next resume instead
    of being skipped forever)."""
    if not is_completed(rec):
        return False
    iid = rec["instance_id"]
    _atomic_write(os.path.join(durable_dir, "records", iid + ".json"),
                  json.dumps(rec, indent=2))
    if patch and patch.strip():
        _atomic_write(os.path.join(durable_dir, "patches", iid + ".patch"),
                      patch)
    return True


def load_durable(durable_dir):
    """Load the durable ledger as {instance_id: record}. Skips unreadable or
    half-written (.tmp) files so a crash mid-write can never block resume.
    A stray <iid>.json that fails json.load is ignored, not fatal."""
    done = {}
    rec_dir = os.path.join(durable_dir, "records")
    if not os.path.isdir(rec_dir):
        return done
    for fn in sorted(os.listdir(rec_dir)):
        if not fn.endswith(".json") or fn.endswith(".tmp"):
            continue
        try:
            r = json.load(open(os.path.join(rec_dir, fn)))
        except Exception:
            # truncated / corrupt single file -> treat as not-done, re-run it.
            continue
        if isinstance(r, dict) and r.get("instance_id"):
            done[r["instance_id"]] = r
    return done


def durable_patch(durable_dir, iid):
    pp = os.path.join(durable_dir, "patches", iid + ".patch")
    return open(pp).read() if os.path.exists(pp) else ""


# Pre-registration amendment 2026-06-10 (BEFORE batch instances 2-10 ran):
# Stage 2 measured ~$14.55/instance at LOKI_MAX_ITERATIONS=8 (vs $3-8 expected)
# and found the in-product USD breaker inert (cost pipeline defect). To stay
# inside the authorized $30-80 envelope: instances 2-10 run at
# LOKI_MAX_ITERATIONS=4 and the batch hard-aborts when cumulative measured
# spend reaches USD 78. Instances not run are reported explicitly as
# "not run (budget exhausted)" -- never silently dropped. Instance 1 ran
# pre-amendment at max_iter=8 and is documented as such.
#
# Full-119 run (2026-06-10): same host-side cumulative breaker mechanism as the
# Section 11 amendment, cap raised to the founder-authorized full-run envelope
# of USD 700 (smoke calibration projected ~$608-629 generation cost for 119 at
# max_iter=4; $700 hard cap, $952 worst case). max_iter stays 4. This is a
# pre-registered operational parameter consistent with Section 11's mechanism;
# only the numeric cap changed. The 10 smoke records in batch_records.json are
# retained and skipped by the resume loop; their $62.16 counts toward the cap.
BATCH_MAX_ITER = 4
CUMULATIVE_CAP_USD = 700.0


def main():
    # CLI: run_batch.py [N] [work_root] [--force|--rerun]
    # --force / --rerun re-runs every instance from scratch, ignoring the
    # durable ledger (does NOT delete the ledger; completed records remain).
    argv = sys.argv[1:]
    force = False
    for flag in ("--force", "--rerun"):
        if flag in argv:
            argv.remove(flag)
            force = True
    n = int(argv[0]) if len(argv) > 0 else 10
    work_root = argv[1] if len(argv) > 1 else "/tmp/swebench-pro-pilot/runs"
    durable_dir = DURABLE_DIR
    os.makedirs(work_root, exist_ok=True)
    ids = json.load(open(SUBSET))["instance_ids"][:n]

    records = []
    preds = []
    # resume: skip instances already recorded. PRIMARY source is the durable,
    # reboot-proof per-instance ledger; the legacy monolithic /tmp ledger is
    # merged only for back-compat with in-flight pre-fix runs.
    rec_path = os.path.join(work_root, "batch_records.json")
    done = {}
    if not force:
        if os.path.exists(rec_path):
            try:
                for r in json.load(open(rec_path)):
                    done[r["instance_id"]] = r
            except Exception:
                # legacy monolithic ledger truncated by a crash mid-write -- the
                # exact data-loss this fix removes. Ignore it; the durable
                # per-instance ledger below is the authoritative survivor.
                pass
        done.update(load_durable(durable_dir))  # durable wins over legacy

    def spent():
        return sum((r.get("cost") or {}).get("usd") or 0 for r in records)

    for i, iid in enumerate(ids):
        if iid in done:
            print(f"[{i+1}/{n}] SKIP (already done): {iid}", flush=True)
            rec = done[iid]
            records.append(rec)
            patch = durable_patch(durable_dir, iid)
            if not patch:
                pp = os.path.join(work_root, iid + ".patch")
                patch = open(pp).read() if os.path.exists(pp) else ""
            preds.append({"instance_id": iid, "patch": patch, "prefix": "loki-pilot"})
            continue
        if spent() >= CUMULATIVE_CAP_USD:
            print(f"[{i+1}/{n}] NOT RUN (budget exhausted at "
                  f"${spent():.2f} >= ${CUMULATIVE_CAP_USD}): {iid}", flush=True)
            records.append({"instance_id": iid, "patch_produced": False,
                            "error": "not_run_budget_exhausted",
                            "cost": None, "wall_s": None, "exit": None})
            preds.append({"instance_id": iid, "patch": "", "prefix": "loki-pilot"})
            continue
        print(f"[{i+1}/{n}] RUN: {iid} (spent so far: ${spent():.2f})", flush=True)
        rec, patch = run_instance.run(iid, work_root, max_iter=BATCH_MAX_ITER)
        records.append(rec)
        # DURABLE-FIRST: persist this instance to the reboot-proof per-instance
        # ledger BEFORE anything else, atomically. If the process is killed on
        # the very next line, a true completion is already saved and a re-run
        # will SKIP it. Prior instances live in their own files and are never
        # rewritten, so this write cannot corrupt them. Infra failures
        # (image-pull / extract) are NOT persisted, so they stay re-runnable.
        persist_durable(durable_dir, rec, patch)
        with open(os.path.join(work_root, iid + ".patch"), "w") as f:
            f.write(patch)
        preds.append({"instance_id": iid, "patch": patch, "prefix": "loki-pilot"})
        # legacy aggregate (disposable /tmp) for back-compat tooling
        json.dump(records, open(rec_path, "w"), indent=2)
        json.dump(preds, open(os.path.join(work_root, "loki_predictions.json"), "w"))
        print(f"    produced={rec['patch_produced']} cost={rec['cost']} "
              f"wall={rec['wall_s']}s exit={rec['exit']}", flush=True)

    json.dump(records, open(rec_path, "w"), indent=2)
    json.dump(preds, open(os.path.join(work_root, "loki_predictions.json"), "w"))
    print(f"DONE. {len(records)} records, total spend ${spent():.2f} -> {rec_path}",
          flush=True)


if __name__ == "__main__":
    main()
