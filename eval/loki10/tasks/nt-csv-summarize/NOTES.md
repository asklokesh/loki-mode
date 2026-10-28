# nt-csv-summarize provenance (not given to arms)

- stratum: repo with no test suite (the seed has no tests directory, no test runner config); the acceptance check is an executable script that drives the real entry point. Authored for the held-out harder set; not drawn from any task used to tune the harness.
- seed files are written by setup (never overwriting an existing file).
- red on base: seeds only, hidden test exits 1 (see hidden/RED.txt).
