# pub-more-itertools-1250

- Issue: more-itertools/more-itertools#1250
- Fix PR: more-itertools/more-itertools#1251
- Merge commit (green): d92f081a089714e0aa92434c797fdd1a06da1290
- repo.ref (red) = merge^1: a826a4e09e3f2782822c71da6670e9275735ad3e
- Hidden file: tests/test_more.py at the merge commit
- Why chosen / tests selected: Issue states the TypeError raised while iterating must propagate and that non-iterables (including __iter__ raising TypeError) are still emitted as-is. Selected: the PR's two new ValueChainTests (propagation, red at ref; non-iterable emitted as-is, regression guard).
