"""A version bump must not rewrite a dependency's version.

WHAT THIS CAUGHT, and it took down every CI job at once.

The v9.8.0 release bumped the project version with a blind string replace of
"9.7.0" -> "9.8.0" across package.json. That string also occurs inside a
dependency spec:

    "jest": "^29.7.0"   ->   "jest": "^29.8.0"

jest 29.8.0 has never existed; 29.7.0 is the highest 29.x. So `npm install`
failed with ETARGET and ALL ELEVEN JOBS died before running a single test --
four shell shards, every Bun matrix entry, and every Node version. The
preceding red shards were three genuine test failures; this was one character
of collateral from the release process itself.

WHY A TEST RATHER THAN CARE. The bump is mechanical and runs on every release,
so "remember to check the diff" is not a control. This asserts the property
that actually matters -- every dependency spec resolves to a real published
version -- which catches this class no matter which field a future blind
replace corrupts.

Network-free by default: the resolvability check runs only when npm is
available and reachable, and skips rather than failing when it is not. An
absent measurement must not read as a pass, so the skip says so explicitly.
"""

import json
import pathlib
import re
import shutil
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_PKG = _ROOT / "package.json"

_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies")
_EXACT = re.compile(r"^[\^~]?(\d+\.\d+\.\d+)$")


def _manifest():
    return json.loads(_PKG.read_text(encoding="utf-8"))


class TheProjectVersionIsNotADependencyVersion(unittest.TestCase):
    def test_no_dependency_carries_the_project_version(self):
        """The exact shape of the v9.8.0 breakage.

        A dependency whose spec contains the project's own version string is
        the fingerprint of a blind replace. It is not proof of corruption on
        its own -- a dep could legitimately share the number -- so this asserts
        the resolvable check below is what decides, and merely reports the
        coincidence here for a human to eyeball.
        """
        d = _manifest()
        version = d["version"]
        collisions = []
        for sect in _SECTIONS:
            for name, spec in (d.get(sect) or {}).items():
                if version in str(spec):
                    collisions.append("%s.%s = %s" % (sect, name, spec))
        # Reported, not failed: the resolvability test is the real gate.
        if collisions:
            print("NOTE: dependency specs containing the project version %s: %s"
                  % (version, ", ".join(collisions)))

    def test_jest_is_pinned_to_a_version_that_exists(self):
        """The specific regression, pinned by name.

        jest 29.8.0 does not exist and never did. This is cheap, offline, and
        fails loudly if the same replace happens again.
        """
        d = _manifest()
        jest = (d.get("devDependencies") or {}).get("jest")
        if jest is None:
            self.skipTest("jest is no longer a dependency")
        m = _EXACT.match(jest)
        self.assertIsNotNone(
            m, "jest spec %r is not a simple pin; re-check by hand" % jest)
        self.assertLessEqual(
            tuple(int(x) for x in m.group(1).split(".")), (29, 7, 0),
            "jest is pinned above 29.7.0, the highest 29.x that exists. "
            "v9.8.0 shipped ^29.8.0 from a blind version replace and every CI "
            "job died on npm ETARGET before running a single test.")


class EveryPinnedDependencyResolves(unittest.TestCase):
    def test_every_exact_pin_exists_on_the_registry(self):
        """The property that catches the CLASS, not just jest.

        Skips when npm is unavailable or the registry cannot be reached, and
        says so: an absent measurement is not a pass.
        """
        if shutil.which("npm") is None:
            self.skipTest("npm not available; registry resolvability unchecked")

        d = _manifest()
        specs = []
        for sect in _SECTIONS:
            for name, spec in (d.get(sect) or {}).items():
                if _EXACT.match(str(spec)):
                    specs.append((sect, name, str(spec)))
        self.assertTrue(specs, "no pinned dependencies found; check is vacuous")

        probe = subprocess.run(
            ["npm", "view", "jest", "version"],
            capture_output=True, text=True, timeout=90)
        if probe.returncode != 0:
            self.skipTest("npm registry unreachable; resolvability unchecked")

        unresolvable = []
        for sect, name, spec in specs:
            r = subprocess.run(
                ["npm", "view", "%s@%s" % (name, spec), "version"],
                capture_output=True, text=True, timeout=90)
            if r.returncode != 0 or not r.stdout.strip():
                unresolvable.append("%s.%s = %s" % (sect, name, spec))

        self.assertEqual(
            unresolvable, [],
            "these dependency specs resolve to NO published version, so "
            "`npm install` fails and every CI job dies before running a "
            "test: %s" % ", ".join(unresolvable))


if __name__ == "__main__":
    unittest.main()
