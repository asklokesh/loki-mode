# pub-faker-1817 provenance (not given to arms)

- issue: joke2k/faker#1817
- fix_pr: joke2k/faker#2203 (https://github.com/joke2k/faker/pull/2203)
- merge_sha: a126753d1419d8f1f0088944a4cfdb4d1b301b39
- repo.ref (red) = merge^1: c1f95c5b208adbcdba3a6e3c7350c5e98a7f01fa
- source files touched (medium: >=2): faker/providers/profile/__init__.py, faker/proxy.py
- hidden files (verbatim upstream at merge_sha): tests/test_unique.py
- EV-11a fix (2026-09-28, review docs/dev, e19-rejects.json key "EV-11"): the
  prior hidden.run narrowed to `-k "TestUniquenessClass and
  test_complex_return_types_is_supported"`. A deletion mutant (wrapper
  returns the raw function result before touching `_seen`, deleting
  uniqueness tracking entirely) still graded completed: the narrowed run
  only exercises the dict-hashing crash, not the actual uniqueness
  contract. Widened to `-k "TestUniquenessClass"` (whole class, 6 tests).
  Re-verified by hand: RED at ref (c1f95c5b) = 5 passed, 1 failed, rc=1
  (only test_complex_return_types_is_supported fails, same TypeError as
  before). GREEN at merge_sha (a126753d) = 6 passed, rc=0. The same
  deletion mutant applied at merge_sha now fails: 2 failed ("test_uniqueness",
  "test_sanity_escape"), 4 passed, rc=1; mutant reverted after
  (`git checkout -- faker/proxy.py`, `git diff --stat` empty).
