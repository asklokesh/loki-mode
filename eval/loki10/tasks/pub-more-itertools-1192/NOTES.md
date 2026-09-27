# pub-more-itertools-1192

- Issue: more-itertools/more-itertools#1192
- Fix PR: more-itertools/more-itertools#1193
- Merge commit (green): b363d6b82c7082db647bd350560fca5e1d724a16
- repo.ref (red) = merge^1: 5d946b3590bfe92f1465c1b9b9830dd434745c84
- Hidden file: tests/test_more.py at the merge commit
- Why chosen / tests selected: Issue states interleave_evenly([]) and interleave_evenly([], lengths=[]) must return an empty list. Selected: the PR's single new test, which checks exactly those two calls.
