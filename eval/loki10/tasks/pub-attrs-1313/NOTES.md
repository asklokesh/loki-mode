# pub-attrs-1313 provenance (not given to arms)

- issue: python-attrs/attrs#1313
- fix_pr: python-attrs/attrs#1383 (https://github.com/python-attrs/attrs/pull/1383)
- merge_sha: 62bdbf234f45195e75bfc2bb0648dab6fd2f0d33
- repo.ref (red) = merge^1: 103d51f6efa36efcc7be4adecfd571da3f63291c
- source files touched (medium: >=2): src/attr/__init__.py, src/attr/_funcs.py, src/attr/_make.py, src/attr/_next_gen.py
- hidden files (verbatim upstream at merge_sha): tests/test_functional.py
- requires Python >=3.13 on the eval host: the fix is copy.replace() support and the selected test class is `skipif(not PY_3_13_PLUS)`; on 3.12 hidden.run gives "1 skipped, 409 deselected" (rc=0, zero passed) at both ref and fix, so this task cannot show a real red-to-green signal below 3.13 (EV-11 review finding 3). Verified on this host's Python 3.14.6.
