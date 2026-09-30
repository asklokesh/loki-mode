# pub-dotenv-661 provenance (not given to arms)

- issue: theskumar/python-dotenv#661
- fix_pr: theskumar/python-dotenv#680 (squash merge, 1 commit)
- merge_sha: f7b18d9c72d1abcc2ad4023424b84f5bee30d266
- repo.ref (red) = merge^1: 751f8c148222e58aa173c83c4e5e6cfccb2cc124
- Source-only diff (src/dotenv/main.py + src/dotenv/parser.py) is eval/loki10/refdiff/pub-dotenv-661.diff
  (git diff ref merge for those two files, 35 lines).
- Shape: serializer (main.py set_key) plus parser (parser.py single and double quoted value regexes).
  The hidden file drives both through the public API: set_key writes, get_key reads back.
- hidden file: tests/test_main.py verbatim from merge_sha, run whole (no -k). Nothing authored, nothing edited.
  tests/test_parser.py from the PR is NOT used: its double-quoted-value rows are not stated by the issue.
- Issue-stated behavior: values containing a backslash (C:\Users, \d+) must survive set_key then get_key;
  backslashes are escaped before single quotes (the issue's Fix section).
  Caveat for reviewers: the trailing-backslash rows (`C:\Users\`, `back\`) and the exact-output
  rows in test_set_key follow from the issue's general claim ("any value containing a backslash",
  "escape backslashes before escaping single quotes") but the issue's own examples are only C:\Users and \d+.
  Those rows are what make parser.py necessary: the escaped trailing backslash `'b\\'` is read at ref as an
  escaped quote and swallows the rest of the file.
- RED at ref (exact hidden.run, fresh venv, system python 3.14): 5 failed, 123 passed, rc=1
  (test_set_key rows 13-15 exact output, test_set_key_round_trips[C:\\Users\\] and [back\\]).
- GREEN at merge_sha: 128 passed, rc=0.
- Selected tests use no clock, randomness or network (network only at setup). RED.txt paths are scrubbed to <tmp>.

## One-file fix attempts (all with the full hidden.run, at ref)
1. Upstream main.py diff only (backslashes escaped before quotes), parser.py at ref: 2 failed, 126 passed, rc=1
   (test_set_key_round_trips[C:\\Users\\] and [back\\]: the written `'C:\\Users\\'` is misread).
2. Upstream parser.py diff only, main.py at ref: 6 failed, 122 passed, rc=1 (the serializer still writes
   `'C:\Users'`, so the three exact rows and three round trips fail).
3. Own main.py-only variant (.replace("\\", "\\\\") before the quote replace, same as attempt 1): 2 failed, 126 passed, rc=1.
4. Own parser.py-only variant: not separately run; attempt 2 is the parser half and the serializer output rows
   are untestable by a parser change.
5. Serializer-only workaround for the trailing backslash (write the value so the old parser copes, e.g. unquoted):
   contradicts the exact-output rows in test_set_key, so it fails that test; not a valid fix.
No single-file fix passes; main.py-only misses exactly the trailing-backslash round trips.

## No-op baseline
STUB_MODE=noop through eval/loki10/run.sh (raw-claude arm, stub-arm.sh), rc=0:
hidden_pass=false, completed=False, tier=medium.
