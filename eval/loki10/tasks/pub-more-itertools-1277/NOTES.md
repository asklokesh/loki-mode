# pub-more-itertools-1277

- Issue: more-itertools/more-itertools#1277
- Fix PR: more-itertools/more-itertools#1278
- Merge commit (green): 4ebeea3e569388911a0bec740092f3cf996d79f3
- repo.ref (red) = merge^1: 9ed3dbb0ae527230cd156d91d0af305478558fba
- Hidden file: tests/test_more.py at the merge commit
- Why chosen / tests selected: Issue states zip_broadcast must not reopen an iterable, including empty inputs and strict=True, and gives the expected output. Selected: the PR's single new test covering those cases.
