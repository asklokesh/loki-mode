# spd-seq-ledger provenance (not given to arms)

- tier: speed (D38 provenance; authored speed tier, D67); sequential by design: each module imports the previous one; a decomposer must choose one sequential run
- repo.ref (red): more-itertools at 5d946b3590bfe92f1465c1b9b9830dd434745c84; every new module is absent, so the hidden file fails by assertion
- hidden file (authored for this task, no upstream): tests/test_spd_seq_ledger.py
- requirements map: one row per module, each naming its hidden test class
- D61 slice 17 speed tier: expected_decomposable=false feeds the large-tier target (parallel at most 0.5x sequential wall on decomposable tasks)
