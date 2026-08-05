"""A vanished process is not a lineage violation.

The lineage guard proves a spawned runner is really the child we launched. On
Linux it reads /proc/<pid>/environ for a marker. That file disappears the
instant the process is reaped, so a runner that exits quickly is
indistinguishable -- to a naive read -- from one that never carried the marker.

Answering "no marker" for it makes the guard raise, which the supervisor
reports as a LAUNCH failure with rc 127, for a process that in fact launched
and ran to completion.

macOS never hit this: it has a pipe-handle fallback. So the bug is Linux-only
and does not reproduce on a developer Mac, which is the whole reason it is
worth a test rather than an inspection.

The property that must NOT regress while fixing it: a process that is alive
and genuinely lacks the marker must still fail the guard. That is what the
guard is for; "unknown" applies only to a process that is gone.
"""

import os
import subprocess
import sys
import time
import unittest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "autonomy", "lib"))

import deadline  # noqa: E402


@unittest.skipUnless(sys.platform.startswith("linux"),
                     "the /proc environ race is Linux-only")
class LineageMarkerLivenessTests(unittest.TestCase):
    def test_live_process_without_marker_still_fails_closed(self):
        """The security property. A live unmarked process is a violation."""
        proc = subprocess.Popen(["/bin/sh", "-c", "sleep 5"],
                                env={"PATH": "/usr/bin:/bin"})
        try:
            time.sleep(0.05)
            self.assertFalse(
                deadline._process_has_lineage_token(proc.pid, "absent-token"),
                "a live process with no marker must fail the guard")
        finally:
            proc.kill()
            proc.wait()

    def test_exited_process_reports_unknown_not_absent(self):
        """The bug. A reaped process must not be reported as unmarked."""
        proc = subprocess.Popen(["/bin/sh", "-c", "exit 0"],
                                env={"PATH": "/usr/bin:/bin"})
        proc.wait()
        with self.assertRaises(deadline._LineageUnknown):
            deadline._process_has_lineage_token(proc.pid, "any-token")

    def test_live_process_with_marker_is_recognized(self):
        """The happy path still works -- the fix did not blind the reader."""
        env = {"PATH": "/usr/bin:/bin", deadline._LINEAGE_ENV_NAME: "tok-xyz"}
        proc = subprocess.Popen(["/bin/sh", "-c", "sleep 5"], env=env)
        try:
            time.sleep(0.05)
            self.assertTrue(
                deadline._process_has_lineage_token(proc.pid, "tok-xyz"))
        finally:
            proc.kill()
            proc.wait()


if __name__ == "__main__":
    unittest.main()
