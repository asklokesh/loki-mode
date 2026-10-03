# spd-par-text provenance (not given to arms)

- tier: speed (D38 provenance; authored speed tier, D67); decomposable: 4 units with disjoint files and no shared symbols; a correct decomposer runs them in parallel
- repo.ref (red): more-itertools at 5d946b3590bfe92f1465c1b9b9830dd434745c84; every new module is absent, so the hidden file fails by assertion
- hidden file (authored for this task, no upstream): tests/test_spd_par_text.py
- requirements map: one row per module, each naming its hidden test class
- D61 slice 17 speed tier: expected_decomposable=true feeds the large-tier target (parallel at most 0.5x sequential wall on decomposable tasks)
