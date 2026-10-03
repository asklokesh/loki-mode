# lg-seq-kv provenance (not given to arms)

- tier: large (D38); sequential by design: each module imports the previous one; a decomposer must choose one sequential run
- repo.ref (red): more-itertools at 5d946b3590bfe92f1465c1b9b9830dd434745c84; every new module is absent, so the hidden file fails by assertion
- hidden file (authored for this task, no upstream): tests/test_lg_seq_kv.py
- requirements map: one row per module, each naming its hidden test class
- D61 slice 17: expected_decomposable=false feeds the large-tier target (parallel at most 0.5x sequential wall on decomposable tasks)
