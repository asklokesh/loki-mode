# pub-more-itertools-1252

- Issue: more-itertools/more-itertools#1252
- Fix PR: more-itertools/more-itertools#1253
- Merge commit (green): 3e87c08ac878f4bb79349d38ac69ba75c45dc5bf
- repo.ref (red) = merge^1: d92f081a089714e0aa92434c797fdd1a06da1290
- Hidden file: tests/test_more.py at the merge commit
- Why chosen / tests selected: Issue gives the exact expected value ([] for split_before/split_after/split_when on empty input at every maxsplit) and says split_at stays [[]]. Selected: the PR's new/changed empty-input tests for the three functions plus its split_at test_maxsplit (regression guard for the issue's 'leave split_at alone', already green at ref).
