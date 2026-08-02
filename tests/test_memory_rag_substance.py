"""A retrieved "memory" with no content must not be rendered as a real one.

THE DEFECT. `build_rag_context` renders every pattern `query_patterns` returns
under the header "The following patterns were found in the organization
knowledge base". `query_patterns` scores on four fields, and `category` is one
of them -- so a row whose ONLY match is its category bucket comes back with no
name and no description. It was rendered anyway:

    The following patterns were found in the organization knowledge base:

    ### Unknown Pattern (retry)

That is a fabricated memory presented to the agent as a retrieved one, under a
header asserting it was found in the knowledge base. It burns prompt budget and
it lies about substantiation. Same class as the cost arc: not-measured must not
render as a value. Here, no-content must not render as a memory.

TWO FALSY TRAPS, both of which made the naive guard useless. Both were verified
against the real code before the fix:

    p = {"category": "retry", "description": ""}
    p.get('name', p.get('pattern', 'Unknown Pattern'))   -> 'Unknown Pattern'

A row missing BOTH name keys resolved to the literal default, which is TRUTHY,
so `if not name` could never fire on the very rows that have no name. And:

    q = {"description": "", "correct_approach": "Use a key."}
    q.get('description', q.get('correct_approach', ''))  -> ''

a present-but-empty 'description' shadowed a real 'correct_approach', so a
genuine memory would have been dropped by the new guard. `or` chaining fixes
both.

BOTH DIRECTIONS ARE ASSERTED. An over-strict guard that suppressed genuine
patterns would silently starve the RARV prompt of real institutional knowledge
-- the opposite failure, and harder to notice than the visible fake heading.
Name OR description is the substance rule: category alone is a bucket label,
not a memory; a named pattern with no description is still real signal.
"""

import pathlib
import sys
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

from memory.knowledge_graph import OrganizationKnowledgeGraph  # noqa: E402
from memory.rag_injector import build_rag_context  # noqa: E402

_HEADER = "The following patterns were found in the organization knowledge base"


class RagSubstanceTest(unittest.TestCase):
    """All fixtures are hermetic: knowledge_dir is a fresh temp dir, never
    the developer's real ~/.loki/knowledge store."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp()
        self.kg = OrganizationKnowledgeGraph(self.dir)
        self.kg.ensure_dir()

    def _context(self, rows, query="retry"):
        self.kg.save_patterns(rows)
        return build_rag_context(query, knowledge_dir=self.dir)

    # -- direction 1: hollow patterns must not be rendered -----------------

    def test_row_missing_both_name_keys_is_dropped(self):
        """The .get-default trap: no 'name' and no 'pattern' key at all.

        This row resolved to the literal string 'Unknown Pattern' via the
        nested-default chain. It is the case a `if not name` guard cannot see.
        """
        ctx = self._context([{"category": "retry", "description": ""}])
        self.assertNotIn("Unknown Pattern", ctx)
        self.assertEqual(ctx, "")

    def test_empty_string_name_and_description_is_dropped(self):
        ctx = self._context([{"name": "", "description": "", "category": "retry"}])
        self.assertEqual(ctx, "")

    def test_name_sanitizing_to_empty_with_no_desc_is_dropped(self):
        """Fields that are only markdown markers sanitize away to nothing."""
        ctx = self._context([{"name": "```", "description": "  ", "category": "retry"}])
        self.assertEqual(ctx, "")

    def test_all_hollow_yields_no_bare_header(self):
        """A header with no sections under it is a standalone lie: it asserts
        patterns were found when none had any content."""
        ctx = self._context([
            {"category": "retry"},
            {"name": "", "category": "retry", "description": ""},
            {"pattern": "###", "category": "retry"},
        ])
        self.assertEqual(ctx, "")
        self.assertNotIn(_HEADER, ctx)

    # -- direction 2: genuine patterns must survive ------------------------

    def test_named_pattern_without_description_is_kept(self):
        """A name is substance on its own. Dropping this would be the
        over-strict failure."""
        ctx = self._context([{"name": "idempotency-key", "category": "retry"}])
        self.assertIn("idempotency-key", ctx)
        self.assertIn(_HEADER, ctx)

    def test_correct_approach_survives_empty_description(self):
        """The second falsy trap, in the over-strict direction: a real
        correct_approach must not be shadowed by an empty description."""
        ctx = self._context([{
            "name": "", "pattern": "", "category": "retry",
            "description": "", "correct_approach": "Use an idempotency key.",
        }])
        self.assertIn("Use an idempotency key.", ctx)
        # No name survived sanitization, so the heading legitimately falls
        # back -- but the section carries real content underneath it.
        self.assertIn("Unknown Pattern", ctx)

    def test_unnamed_but_described_pattern_is_kept(self):
        ctx = self._context([{
            "pattern": "```", "category": "retry",
            "description": "Retry only idempotent writes.",
        }])
        self.assertIn("Retry only idempotent writes.", ctx)

    def test_schema_pattern_field_is_kept(self):
        """SemanticPattern schema uses 'pattern' rather than 'name'."""
        ctx = self._context([{"pattern": "retry-with-backoff", "category": "retry"}])
        self.assertIn("retry-with-backoff", ctx)

    def test_hollow_rows_do_not_displace_real_ones(self):
        """Mixed store: the real pattern survives, the hollow ones vanish."""
        ctx = self._context([
            {"category": "retry", "description": ""},
            {"name": "", "category": "retry"},
            {"name": "idempotency-key", "category": "retry",
             "description": "Use a key."},
        ])
        self.assertIn("idempotency-key", ctx)
        self.assertIn("Use a key.", ctx)
        self.assertNotIn("Unknown Pattern", ctx)
        self.assertEqual(ctx.count("### "), 1)


if __name__ == "__main__":
    unittest.main()
