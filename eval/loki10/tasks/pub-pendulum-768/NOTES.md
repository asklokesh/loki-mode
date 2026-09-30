# pub-pendulum-768 provenance (not given to arms)

- issue: python-pendulum/pendulum#768
- fix_pr: python-pendulum/pendulum#775 (https://github.com/python-pendulum/pendulum/pull/775)
- merge_sha: 78fdc33f1dba7380ed853f5a2e1584e96c52d214
- repo.ref (red) = merge^1: 0a884dd36f1920a632681528a0251a9d6281aff1
- source files touched (medium: >=2): src/pendulum/datetime.py, src/pendulum/duration.py
- `git diff --stat ref merge`: src/pendulum/datetime.py (+1 -3), src/pendulum/duration.py (+15 -1), tests/datetime/test_add.py (+13 -1); the test file is the hidden file
- hidden files (verbatim upstream at merge_sha): tests/datetime/test_add.py
- prompt: issue title and reproducer; the GitHub template checklist dropped.
- setup installs only the pure-Python dependencies and hidden.run passes `-o pythonpath=src`: the repo builds with maturin (Rust), which is not needed because pendulum falls back to its Python implementation. No network at test time.
- hidden.run runs the whole test_add.py, no -k: RED at ref = 1 failed (test_add_duration_across_transition_days), 32 passed (rc=1); GREEN at merge = 33 passed (rc=0).
- issue reproducer at ref: `pendulum.datetime(2023,11,5,0,0,tz='America/Chicago') + pendulum.duration(days=1)` prints `2023-11-05 23:00:00-06:00` (expected 2023-11-06 00:00). Fails at ref.
- (a) single-file check: datetime.py only = 3 failed (AttributeError on the missing duration signature, rc=1); duration.py only = 1 failed (behavior unchanged, rc=1). Neither alone passes.
- (c) plausible wrong fix rejected: the upstream test also keeps the hours=24 case (renamed test_add_duration_across_transition) expecting elapsed-time 11:45, so a fix that turns every Duration into calendar days fails it. The datetime.py-only partial fix is rejected too (above).
- (e) deletion mutant at merge (restore the old `self.add(years=..., months=..., seconds=delta._total)` in datetime.py): 1 failed, rc=1. No-op baseline through run.sh (STUB_MODE=noop, absolute LOKI_EVAL_CLAUDE_BIN): status=ok, completed=False.
- Verified on Python 3.14.6.
