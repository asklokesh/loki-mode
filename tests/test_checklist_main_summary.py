"""End-to-end test for autonomy/checklist-verify.py main() tally.

main() reads a checklist.json (categories[].items[].verification[]), runs each
check, tallies item statuses via determine_item_status, and writes
verification-results.json with summary {total, verified, failing, pending}.
run.sh:5468 reads that summary as the N/total-verified completion signal, so a
silent counting regression fakes completion. No other test drives main()
end to end.

This test invokes the real main() the way the runner does: as a CLI via
subprocess (python3 autonomy/checklist-verify.py --checklist <path>), with cwd
set to a temp project dir (main() uses os.getcwd() as project_dir). It builds a
checklist mixing one all-verified item, one failing item, and one
inconclusive/pending item, then reads back verification-results.json and asserts
the summary counts match the determine_item_status contract:

  file_exists on a present file  -> passed True  -> item "verified"
  file_exists on an absent file  -> passed False -> item "failing"
  http_check with app not running-> passed None  -> item "pending"

Expected summary: total 3, verified 1, failing 1, pending 1.
"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRIPT = os.path.join(REPO, "autonomy", "checklist-verify.py")


def _build_checklist():
    # One category, three items exercising all three terminal statuses.
    return {
        "categories": [
            {
                "name": "core",
                "items": [
                    {
                        "id": "item-verified",
                        "title": "present file",
                        "priority": "major",
                        "verification": [
                            {"type": "file_exists", "path": "present.txt"}
                        ],
                    },
                    {
                        "id": "item-failing",
                        "title": "absent file",
                        "priority": "major",
                        "verification": [
                            {"type": "file_exists", "path": "definitely-absent.txt"}
                        ],
                    },
                    {
                        "id": "item-pending",
                        "title": "app not running",
                        "priority": "minor",
                        "verification": [
                            {"type": "http_check", "path": "/health"}
                        ],
                    },
                ],
            }
        ]
    }


def test_main_summary_counts():
    with tempfile.TemporaryDirectory(prefix="loki-checklist-test-") as project:
        # The verified item's file_exists check must find a real file. main()
        # resolves paths relative to os.getcwd(), so create it in project dir.
        with open(os.path.join(project, "present.txt"), "w") as f:
            f.write("x")

        checklist_dir = os.path.join(project, ".loki", "checklist")
        os.makedirs(checklist_dir)
        checklist_path = os.path.join(checklist_dir, "checklist.json")
        with open(checklist_path, "w") as f:
            json.dump(_build_checklist(), f)

        # Invoke the real main() as the runner does: CLI subprocess, cwd=project.
        proc = subprocess.run(
            [sys.executable, SCRIPT, "--checklist", checklist_path, "--timeout", "5"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert proc.returncode == 0, (
            f"checklist-verify.py exited {proc.returncode}\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )

        results_path = os.path.join(checklist_dir, "verification-results.json")
        assert os.path.isfile(results_path), "verification-results.json not written"
        with open(results_path) as f:
            results = json.load(f)

        summary = results["summary"]
        assert summary["total"] == 3, summary
        assert summary["verified"] == 1, summary
        assert summary["failing"] == 1, summary
        assert summary["pending"] == 1, summary

        # Guard the sum invariant too: a regression that miscounts one bucket
        # while keeping the total right must still trip the per-bucket asserts.
        assert (
            summary["verified"] + summary["failing"] + summary["pending"]
            == summary["total"]
        ), summary


if __name__ == "__main__":
    test_main_summary_counts()
    print("PASS")
