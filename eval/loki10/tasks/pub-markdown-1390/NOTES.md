# pub-markdown-1390 provenance (not given to arms)

- issue: Python-Markdown/markdown#1390
- fix_pr: Python-Markdown/markdown#1414 (squash merge)
- merge_sha: 3d8afc6f89e169522f44c1bbec15f66dc359eccb
- repo.ref (red) = merge^1: 9edba85fc14f034b7109534220702bf60178ff15
- git diff --stat ref merge:
  .spell-dict | 1 +; docs/changelog.md | 4 +-;
  markdown/extensions/attr_list.py | 86 +++++---; markdown/extensions/fenced_code.py | 15 +++--;
  tests/test_syntax/extensions/test_attr_list.py | 45 ++++--;
  tests/test_syntax/extensions/test_fenced_code.py | 42 +++;
  6 files changed, 153 insertions(+), 40 deletions(-).
  Source-only diff (2 .py files under markdown/) is eval/loki10/refdiff/pub-markdown-1390.diff.
- hidden files: upstream tests at merge_sha, both taken whole (no -k), plus ONE AUTHORED test (not upstream) appended to test_fenced_code.py::TestFencedCode: testFencedCodeCurlyInQuotedAttrValueWithoutAttrList. It renders the issue's own example ('``` { .c data-copy="int main() { return 0; }" }') with extensions=['fenced_code'] only and expects the fence to be recognized (class language-c). It encodes only what the issue states.
  Issue-stated behavior: braces inside a quoted attr value parse in a fenced-code
  attr list and in a heading attr list (test_curly_in_double_quote,
  test_curly_in_single_quote, testFencedCodeCurlyInAttrs). The other upstream
  tests in these files (stray closing brace, historic ignore rules, mismatched
  braces) already pass at ref; they pin existing behavior as regression guards
  against over-broad fixes and assert no new API.
- RED at ref (exact hidden.run, fresh venv): 4 failed, 26 passed, 19 skipped, rc=1
  (real assertion failures, no collection/import errors):
  test_attr_list::test_curly_in_double_quote, ::test_curly_in_single_quote,
  test_fenced_code::testFencedCodeCurlyInAttrs and the authored test. The 19 skips are pygments-gated
  tests, skipped identically at ref and at merge.
- GREEN at merge_sha: 30 passed, 19 skipped, rc=0.
- Selected tests use no clock, randomness or network (network only at setup).

## One-file fix attempts (round 1 counts, taken before the authored test was added, so one fewer test)
Behavior lives in two independent files: attr_list.py (heading/inline attr
parsing) and fenced_code.py (fence-opener regex). The tests exercise each separately.
1. Upstream attr_list.py diff only, fenced_code.py untouched: 1 failed, 28 passed, rc=1
   (testFencedCodeCurlyInAttrs: fence with braces in a value renders as a paragraph).
2. fenced_code.py only (upstream diff, with the get_attrs_and_remainder dependency
   inlined back to the existing get_attrs so it runs standalone, regex widened to
   [^\n]*): 3 failed, 26 passed, rc=1 (both attr_list curly-in-quote tests, plus
   testFencedCodeMismatchedCurlyInAttrs).
3. Inlining helper into caller: fenced_code.py already gets everything from
   attr_list; there is no helper module to fold. Attempt 2 is that inlining.
All three need edits to both files, so no single-file fix passes.

## Wrong fix (plausible, rejected)
Widen only the two regexes ([^\}\n] to [^\n] in attr_list BASE_RE and in the fence
attrs group) with no remainder handling: 3 failed, 26 passed, rc=1
(test_curly_after_block, test_curly_after_inline, testFencedCodeMismatchedCurlyInAttrs).

## No-op baseline
STUB_MODE=noop through eval/loki10/run.sh (raw-claude arm, stub-arm.sh):
hidden_pass=false, completed=False.

## Review round 2 (reviewer's monkeypatch fix)
Reviewer fix: upstream attr_list.py diff plus a `_patch_fenced()` that rewrites
FencedBlockPreprocessor.FENCED_BLOCK_RE at import time. hidden.run now lists
test_fenced_code.py BEFORE test_attr_list.py. Results (same command, file order
in parentheses, all at ref with the hidden tests):
- monkeypatch, order attr_list then fenced: 30 passed, rc=0 (still passes; the
  authored test does not stop it, because fenced_code.py itself imports attr_list.py,
  so attr_list is always loaded whichever extensions the test names).
- monkeypatch, order fenced then attr_list (the committed order): 22 failed,
  8 passed, rc=1. The import-time patch does `from .fenced_code import ...` while
  fenced_code is still mid-import (circular), so extension loading fails.
- fenced_code.py-only fix (committed order): 3 failed, 27 passed, rc=1
  (test_curly_in_double_quote, test_curly_in_single_quote, testFencedCodeMismatchedCurlyInAttrs).
- upstream diff, committed order: RED rc=1 (4 failed), GREEN rc=0 (30 passed).
Caveat: the monkeypatch is rejected only by import order, not by behavior; a
lazily applied patch could still pass. No behavior test can tell them apart, as
the patch and upstream produce identical output.
