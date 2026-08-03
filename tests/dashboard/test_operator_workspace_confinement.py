"""GET /api/operator/receipts?workspace= must not be a filesystem-traversal primitive.

THE HOLE THIS CLOSES. The route forwards `workspace` to
api_evidence.receipts_report, which walks it with an UNBOUNDED rglob
(api_evidence.py:346) and stats every entry. Forwarded unvalidated, that is a
read primitive over the whole disk:

    ?workspace=/                 walks the entire filesystem
    ?workspace=../../../..       climbs out of the workspace
    ?workspace=<symlink to />    escapes while looking local

AND THE AUTH DEPENDENCY DOES NOT COVER IT. The routes carry
Depends(auth.require_scope("read")), but LOKI_ENTERPRISE_AUTH is OFF by
default, so on a default deployment this route is reachable with no
credentials at all. A guard that only holds in the configuration nobody runs
is not a guard.

WHY REALPATH ON BOTH SIDES. A raw string comparison is defeated two ways: by
`..` segments that textually sit inside an allowed root, and by a symlink whose
NAME is inside an allowed root while its TARGET is not. Resolving both sides
first is what makes the comparison meaningful, and the symlink case below is
the one that a prefix check on unresolved paths silently passes.

WHY A TRAILING SEPARATOR. `"/workspaces-evil".startswith("/workspaces")` is
True. Containment must be tested against the root plus a separator, or a
sibling directory whose name merely shares a prefix is treated as inside.
"""

import os
import pathlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _client(allowed_root):
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    # Auth pinned OFF: these tests assert the CONFINEMENT behaviour (403 for a
    # path outside the roots, 200 for one inside), and an ambient
    # LOKI_ENTERPRISE_AUTH left set by a sibling test file would turn every
    # request into a 401 and mask both. See test_api_operator.py for the same
    # note; test_tenant_create_admin_only sets that variable and never unsets it.
    os.environ["LOKI_ENTERPRISE_AUTH"] = "false"
    try:
        from dashboard import auth as _auth
        _auth.ENTERPRISE_AUTH_ENABLED = False
        _auth.OIDC_ENABLED = False
    except Exception:
        pass

    os.environ["LOKI_OPERATOR_ROOTS"] = allowed_root
    from dashboard.api_operator import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


class TheWalkerCannotBePointedOutsideTheAllowedRoots(unittest.TestCase):

    def setUp(self):
        try:
            import fastapi  # noqa: F401
            import starlette  # noqa: F401
        except Exception as exc:  # pragma: no cover
            self.skipTest("fastapi/starlette unavailable: %s" % exc)
        self.tmp = tempfile.mkdtemp()
        self.allowed = os.path.realpath(os.path.join(self.tmp, "allowed"))
        os.makedirs(self.allowed, exist_ok=True)
        self.client = _client(self.allowed)

    def tearDown(self):
        os.environ.pop("LOKI_OPERATOR_ROOTS", None)

    def test_filesystem_root_is_refused(self):
        r = self.client.get("/api/operator/receipts", params={"workspace": "/"})
        self.assertEqual(
            r.status_code, 403,
            "?workspace=/ returned %d; an unbounded rglob over the whole "
            "filesystem is reachable" % r.status_code)

    def test_dot_dot_escape_is_refused(self):
        escape = os.path.join(self.allowed, "..", "..", "..")
        r = self.client.get("/api/operator/receipts",
                            params={"workspace": escape})
        self.assertEqual(
            r.status_code, 403,
            "a .. path escaped the allowed root (%d); the check is comparing "
            "raw strings rather than resolved paths" % r.status_code)

    def test_symlink_escape_is_refused(self):
        """The case a prefix check on UNRESOLVED paths silently passes.

        The link's name sits inside the allowed root. Its target does not.
        """
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside, exist_ok=True)
        link = os.path.join(self.allowed, "sneaky")
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError) as exc:  # pragma: no cover
            self.skipTest("symlinks unavailable here: %s" % exc)
        r = self.client.get("/api/operator/receipts",
                            params={"workspace": link})
        self.assertEqual(
            r.status_code, 403,
            "a symlink pointing outside the allowed root was accepted (%d); "
            "the containment check is not resolving symlinks" % r.status_code)

    def test_sibling_sharing_a_name_prefix_is_refused(self):
        """"/allowed-evil" must not pass as inside "/allowed"."""
        sibling = self.allowed + "-evil"
        os.makedirs(sibling, exist_ok=True)
        r = self.client.get("/api/operator/receipts",
                            params={"workspace": sibling})
        self.assertEqual(
            r.status_code, 403,
            "a sibling directory sharing a name prefix was accepted (%d); "
            "containment is a bare startswith without a separator"
            % r.status_code)

    def test_the_allowed_root_itself_still_works(self):
        """Vacuity guard: a check that refuses EVERYTHING also passes the
        four assertions above while making the route useless."""
        r = self.client.get("/api/operator/receipts",
                            params={"workspace": self.allowed})
        self.assertEqual(
            r.status_code, 200,
            "the allowed root itself was refused (%d); the confinement check "
            "rejects everything, so the tests above prove nothing"
            % r.status_code)

    def test_a_refusal_does_not_leak_the_allowed_roots(self):
        """A rejection must not double as a filesystem-layout oracle."""
        r = self.client.get("/api/operator/receipts", params={"workspace": "/"})
        self.assertNotIn(self.allowed, r.text,
                         "the 403 echoed the configured root back to the "
                         "caller, disclosing server filesystem layout")

    def test_no_workspace_param_still_reads_the_default(self):
        r = self.client.get("/api/operator/receipts")
        self.assertEqual(r.status_code, 200,
                         "omitting workspace broke the default read")


if __name__ == "__main__":
    unittest.main()
