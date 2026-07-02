#!/usr/bin/env python3
"""tests/test-proof-pat-redaction.py -- regression for GitHub fine-grained
PAT leak in proof-of-run redaction (v7.111.0 MED, wave-3).

Bug: the redactor's GitHub token pattern only matched classic tokens
(gh[pousr]_...). GitHub fine-grained PATs use a "github_pat_" prefix, which
does NOT match gh[pousr]_ (the char after "gh" is "i"), so a github_pat_ token
in a captured diff leaked verbatim into proof.json diffs[] and the rendered
proof HTML.

Fix: add a dedicated github_pat_[A-Za-z0-9_]{20,} pattern (before the classic
rule) in autonomy/lib/proof_redact.py.

This test is runnable standalone (python3 tests/test-proof-pat-redaction.py)
and under unittest discovery. It self-skips if the redactor module cannot be
imported. It asserts:
  - a diff containing a github_pat_ token is masked (the fix),
  - a diff containing a classic ghp_ token is still masked (no regression),
  - all classic prefixes gho_/ghu_/ghs_/ghr_ are still masked.

Tokens below are synthetic, structurally-valid-looking, not real credentials.
"""

from __future__ import annotations

import os
import sys
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LIB = os.path.join(_REPO, "autonomy", "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

try:
    import proof_redact  # noqa: E402
    _IMPORT_ERR = None
except Exception as exc:  # pragma: no cover - dependency-absent guard
    proof_redact = None
    _IMPORT_ERR = exc

# Synthetic tokens (not real). Fine-grained PAT bodies mix [A-Za-z0-9_].
_FINE_GRAINED = "github_pat_11ABCDEF0_" + "A" * 70
_GHP = "ghp_" + "d" * 36
_GHO = "gho_" + "e" * 36
_GHU = "ghu_" + "f" * 36
_GHS = "ghs_" + "g" * 36
_GHR = "ghr_" + "h" * 36


def _diff_with(token: str) -> str:
    """A minimal unified-diff hunk carrying a leaked token, as it would appear
    in a proof.json diffs[] entry.

    The token is placed on a plain command line with NO secret-keyword and NO
    HTTP-header context, so the github token pattern itself is what must mask
    it. (A "Token:"/"key=" context would be masked by the header/env-assign
    rules with a generic [REDACTED] label, which would not exercise the pattern
    this regression targets.)
    """
    return (
        "diff --git a/deploy.sh b/deploy.sh\n"
        "--- a/deploy.sh\n"
        "+++ b/deploy.sh\n"
        "@@ -1,1 +1,2 @@\n"
        " #!/usr/bin/env bash\n"
        "+gh auth login --with " + token + " https://api.example.com\n"
    )


@unittest.skipIf(proof_redact is None, "proof_redact import failed: %s" % _IMPORT_ERR)
class GitHubPatRedactionTest(unittest.TestCase):
    def test_fine_grained_pat_is_masked(self):
        """The fix: github_pat_ tokens must be redacted (this is what leaked)."""
        out = proof_redact.redact_value(_diff_with(_FINE_GRAINED))
        self.assertNotIn(
            _FINE_GRAINED, out,
            "fine-grained github_pat_ token leaked into redacted output",
        )
        self.assertNotIn("github_pat_", out, "github_pat_ prefix survived")
        self.assertIn("[REDACTED:GITHUB_TOKEN]", out)

    def test_classic_tokens_still_masked(self):
        """No regression: classic gh[pousr]_ tokens remain redacted."""
        for label, tok in (
            ("ghp_", _GHP), ("gho_", _GHO), ("ghu_", _GHU),
            ("ghs_", _GHS), ("ghr_", _GHR),
        ):
            out = proof_redact.redact_value(_diff_with(tok))
            self.assertNotIn(tok, out, "classic %s token leaked" % label)
            self.assertIn("[REDACTED:GITHUB_TOKEN]", out)

    def test_redact_tree_masks_pat_in_diffs_list(self):
        """End-to-end shape: a proof-like dict with diffs[] carrying a PAT is
        fully redacted by redact_tree (the actual generator call path)."""
        proof = {
            "diffs": [
                {"path": "deploy.sh", "patch": _diff_with(_FINE_GRAINED)},
            ]
        }
        redacted, count = proof_redact.redact_tree(proof)
        blob = str(redacted)
        self.assertNotIn(_FINE_GRAINED, blob)
        self.assertNotIn("github_pat_", blob)
        self.assertGreaterEqual(count, 1)


if __name__ == "__main__":
    if proof_redact is None:
        print("SKIP: could not import proof_redact (%s)" % _IMPORT_ERR)
        sys.exit(0)
    unittest.main(verbosity=2)
