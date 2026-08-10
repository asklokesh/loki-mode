"""A reaped child's marker is UNKNOWN, never ABSENT.

WHY THIS EXISTS. Tests run 31391896826 at b14cb5c4 failed ONLY on Python 3.10
(3.11, 3.12 and 3.13 passed in the same matrix) with:

    AssertionError: 127 != 0
    launch_error: provider attempt lineage marker is unavailable
    termination_reason: launch_failed

127 is reported for a LAUNCH failure. The runner had in fact launched and
completed -- it was reaped before the lineage check could read its marker.

THE LINUX READ HAS THREE "PROCESS IS GONE" OUTCOMES AND ONLY ONE WAS HANDLED.
_process_has_lineage_token reads /proc/<pid>/environ:

    ENOENT -> FileNotFoundError   -> _LineageUnknown   (was handled)
    ESRCH  -> ProcessLookupError  -> "except OSError: return False"   (was not)
    reaped mid-read -> b"" -> no exception at all      (was not)

The last is the quiet one: an empty read raises nothing, splits to [b""], does
not contain the needle, and returns "no marker" for a process that carried one.
Both now raise _LineageUnknown, so the caller applies the SAME poll()-based
decision it already applies to ENOENT.

FAIL-CLOSED IS PRESERVED, and test_a_live_process_without_a_marker_still_fails
is the assertion that proves it. A LIVE process whose marker is genuinely
missing must still raise: poll() returns None for it, has_marker stays False,
and the guard fires. Only "the process is gone" is reclassified.

macOS never hit this -- it has the pipe-handle fallback -- so the bug was
Linux-only and invisible on a developer machine, which is why the local repro
passed 5/5 while CI stayed red.
"""

import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / "autonomy" / "lib"
sys.path.insert(0, str(LIB))

_spec = importlib.util.spec_from_file_location("deadline", LIB / "deadline.py")
deadline = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(deadline)


class ReapedChildMarkerTests(unittest.TestCase):
    """Drives the Linux branch explicitly, on every host.

    sys.platform is patched so these run on a developer Mac too. Without that
    the whole class would silently skip on the only machine most of this repo's
    work happens on -- which is precisely how the defect survived.
    """

    def setUp(self):
        self._platform = mock.patch.object(deadline.sys, "platform", "linux")
        self._platform.start()
        self.addCleanup(self._platform.stop)

    def test_empty_environ_is_unknown_not_absent(self):
        """A zero-length read raises nothing and must NOT mean 'no marker'."""
        m = mock.mock_open(read_data=b"")
        with mock.patch("builtins.open", m):
            with self.assertRaises(deadline._LineageUnknown):
                deadline._process_has_lineage_token(4242, "tok")

    def test_process_lookup_error_is_unknown_not_absent(self):
        """ESRCH means the pid was reaped, same fact as ENOENT."""
        with mock.patch("builtins.open", side_effect=ProcessLookupError()):
            with self.assertRaises(deadline._LineageUnknown):
                deadline._process_has_lineage_token(4242, "tok")

    def test_file_not_found_is_still_unknown(self):
        """The originally-handled path must keep behaving the same."""
        with mock.patch("builtins.open", side_effect=FileNotFoundError()):
            with self.assertRaises(deadline._LineageUnknown):
                deadline._process_has_lineage_token(4242, "tok")

    def test_a_real_marker_is_still_found(self):
        """The happy path must be untouched by the reclassification."""
        # Built from the module's own constant, not a hand-typed name: my
        # first draft guessed "LOKI_ATTEMPT_LINEAGE" and failed against correct
        # code. Deriving it means a rename cannot silently make this vacuous.
        marker = f"{deadline._LINEAGE_ENV_NAME}=tok".encode("ascii")
        payload = b"PATH=/usr/bin\0" + marker + b"\0"
        with mock.patch("builtins.open", mock.mock_open(read_data=payload)):
            self.assertTrue(deadline._process_has_lineage_token(4242, "tok"))

    def test_a_populated_environ_without_the_marker_is_absent(self):
        """A LIVE process that genuinely lacks the marker still reads False.

        This is the fail-closed direction: a non-empty environ is evidence the
        process is readable, so a missing needle is a real absence, not a race.
        """
        payload = b"PATH=/usr/bin\0" + b"HOME=/root\0"
        with mock.patch("builtins.open", mock.mock_open(read_data=payload)):
            self.assertFalse(deadline._process_has_lineage_token(4242, "tok"))

    def test_other_oserror_stays_fail_closed(self):
        """EACCES/EIO are read failures, not evidence of a completed child."""
        with mock.patch("builtins.open", side_effect=PermissionError()):
            self.assertFalse(deadline._process_has_lineage_token(4242, "tok"))


if __name__ == "__main__":
    unittest.main()
