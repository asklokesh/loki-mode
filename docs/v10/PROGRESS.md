# Progress

## Current

- Milestone: **M0 measure first**, item 1: the moat suite.
- Last release: v9.51.1 (published before v10 work began; npm serves 9.51.1, checked 2026-09-25).
- Next release target: v9.52.0 = moat suite + P1 fixes, reported as "moat: X of 9 properties proven".

## Cycle log

### Cycle 1 (2026-09-25, in progress)

- Oriented: `docs/v10/` did not exist; created it. main clean after stashing six pre-existing modified files (D1, founder queue 1). Main CI green at `a8858ed1`.
- Four read-only audits mapped every moat property to code. Result: nothing under `tests/moat/`; P1 mostly built with two holes (Bun drops `--jwks`, stripped signature passes); P2 partly built with false-green paths; P3, P8, P9 unbuilt; P4 has no `claude-opus-5-5` and no corpus; P5 has no egress-blocked run and a false "air-gap ready"; P6 works but is unasserted; P7 has three sample-data admin panels and three `$0.00`-when-unmeasured paths. Details in BACKLOG items 2-7.
- Decisions D2 (pending ratchet), D3 (exit contract scope), D4 (unsigned proof with key fails).
- Dev fleet (6 slices, worktree-isolated) building the suite and the P1/P2 fixes.

## Shipped in v10 program

(nothing yet)

## Next

1. Integrate the six slices, run the suite and the fast tier, council review (3 of 3), release v9.52.0.
2. BACKLOG items 2-3 (P7, P9): the two moat gaps with the smallest fix.
