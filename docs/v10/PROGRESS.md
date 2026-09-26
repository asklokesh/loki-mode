# Progress

## Current

- Milestone: **M0 measure first**, item 1: the moat suite.
- Last release: v9.51.1 (published before v10 work began; npm serves 9.51.1, checked 2026-09-25).
- Next release target: v9.52.0 = moat suite + P1 fixes, reported as "moat: X of 9 properties proven".

## Cycle log

### Cycle 1 (2026-09-25)

- Oriented: `docs/v10/` did not exist; created it. main clean after stashing six pre-existing modified files (D1, founder queue 1). Main CI green at `a8858ed1`.
- Four read-only audits mapped every moat property to code. Result: nothing under `tests/moat/`; P1 mostly built with two holes (Bun drops `--jwks`, stripped signature passes); P2 partly built with false-green paths; P3, P8, P9 unbuilt; P4 has no `claude-opus-5-5` and no corpus; P5 has no egress-blocked run and a false "air-gap ready"; P6 works but is unasserted; P7 has three sample-data admin panels and three `$0.00`-when-unmeasured paths. Details in BACKLOG items 2-7.
- Decisions D2 (pending ratchet), D3 (exit contract scope), D4 (unsigned proof with key fails).
- Dev fleet (6 slices, worktree-isolated) built the suite and the P1/P2 fixes; integrated as 7 commits. Suite: 13.5s, "moat: 1 of 9 properties proven", 23 pending.
- Main was red since `87ec48dc` (tamper-claim scanner flagged the build prompt's own prohibition line). Fixed in `35c0daaa`; Tests green there (D5 covers the local pre-push skip).
- Council round 1: 3 of 3 CONCERN. Blocking: empty `--jwks` skipped the signature check; air-gap audit read other providers' model vars; P1 metadata fields unsigned while P1 read PROVEN; P5 passed on a failed start; P1 Linux egress detection could not tell "blocked" from "never launched". Fix round 1 landed (3 slices), plus a grow-only case registry, PyYAML in CI deps, and the three sibling council `pass` readers. Suite now reads "0 of 9 proven" (P1 lost its PROVEN when its unsigned metadata got a real case).
- Linux CI validation via PR #216: Moat suite job green on ubuntu with a real kernel block (`sudo unshare -n` + `setpriv`); identical results to macOS.
- Council round 2: APPROVE, CONCERN, APPROVE. Blocker: an attested remote receipt checked without python cryptography read UNSIGNED. Fixed in `50bbea5c` (plus bash `proof verify` exits 2 without python3, semver-only baselines, bootstrap marker, P2 route labels, P5 proxy scrub).
- Local fast tier green (106 passed, 0 failed) after fixing the quickstart fixture's Xcode-shim host issue (`682f6635`).
- Council round 3: CONCERN, CONCERN, APPROVE. Blockers: the ratchet baseline was the nearest tag by depth (a merged hotfix tag could reset or loosen it); a crafted malformed attestation token turned FAILED into NOT CHECKED. Fixed (ratchet over all reachable release tags; malformed tokens refused; unknown `proof verify` flags exit 64; P1 refusal cases pinned to exact codes).
- Council rounds 4-8 each found one more real verifier hole, all fixed with red-then-green tests: `--help` skipped the check (rounds 4-5: verify now never exits 0 without a verdict); the checkout could supply the verifier's Python modules through `python3 -` (round 6), through `PYTHONPATH`/`sitecustomize.py` (round 7: `python3 -E`, D7), and through chain stage subprocesses (round 8).
- Council round 9: **3 of 3 APPROVE** at `5119f897`. One unreproduced observation (P1.modified-field-fails failed once in 7 local runs; 60 further runs under load passed).
- Release v9.52.0 cut: version bump, CHANGELOG, dashboard rebuild (no diff), dist rebuild, tarball smoke-tested from a fresh PATH.
- **v9.52.0 verified on all channels (2026-09-26):** Release run green (required-ci: Tests, Bun Parity, Security Audit at `7c280ead`); npm `latest` 9.52.0 with `gitHead` `7c280ead`; tag `v9.52.0^{}` = `7c280ead`; GitHub release published; Docker Hub `9.52.0` amd64 + arm64; Homebrew formula sha256 equals the downloaded release tarball. Published package smoke-tested on both routes from a fresh PATH (reports 9.52.0; `verify -h` 64). Validation PR #216 auto-merged by GitHub; its branch is gone.

## Shipped in v10 program

- **v9.54.0** (2026-09-26): resume never sweeps, overwrites or loses user files (between-session files, gitignored files, interrupted sessions, old git); previous-session test evidence never read as this session's; D7 on checklist verification, council helpers and load_state.
- **v9.53.0** (2026-09-26): P6 in-place brownfield proven (moat 1 of 9); user untracked files never swept into session commits; no bytecode from the syntax gate; Bun gate never passes an inconclusive result; council and runner verdict paths cannot import from the agent repo.
- **v9.52.0** (2026-09-25): moat suite `tests/moat/` (45 cases, 0 of 9 properties proven, 24 pending with milestones, ratchet baseline set by this release); verifier fixes (Bun `--jwks`, stripped signature, malformed tokens, strict flags and help, `python3 -E` on every verify path, exit contract 64/66); council `pass` readers fail closed; honest `doctor --airgap`; main-red fix.

### Cycle 2 (2026-09-26)

- Dev fleet (3 worktree slices): untracked-file sweep and bytecode (BACKLOG 15, 16), Bun inconclusive pass and council reason naming (37, 38), cwd shadowing on council and runner verdict paths (43). Integrated plus the D7 guard on the new syntax check.
- Moat: **1 of 9 proven** (P6); ratchet live against v9.52.0 (23 pending, 48 registered).
- Council: 3 of 3 APPROVE on the first round. Non-blocking data-safety findings recorded as BACKLOG 57-60.
- Released as v9.53.0.

### Cycle 3 (2026-09-26)

- v9.53.0 verified on all channels (npm latest + gitHead `d7fb8674`, tag, GitHub release, Docker amd64/arm64, Homebrew sha256).
- Dev fleet (3 worktree slices): resume re-snapshot, gitignored files, receipt discloses edits to user files (BACKLOG 57-59); D7 on checklist verification and council helpers (53, 54 partly); zero-test and stale results never affirmative on either route (55, 56, 60).
- Moat: still 1 of 9 proven (P6); 54 cases registered (48 in the release-tag union), 23 pending; ratchet against v9.52.0 and v9.53.0. New cases: P6.resume-does-not-sweep, P6.ignored-files-not-swept, P6.preexisting-edit-disclosed, P6.resume-keeps-ignored-user-file, P2.checklist-verify-not-shadowed, P2.zero-test-never-affirmative.
- Council rounds: r1 CONCERN x2 (resume overwrote ignored user files; stale Bun pass) -> fixed 55ee9747; r2 CONCERN (previous test-results.json still reported) -> fixed d55b13f4; r3 CONCERN (snapshot on git < 2.18 fell back to sweeping everything) -> fixed f71ab6a1; r4 3 of 3 APPROVE but an interrupt regression found -> fixed 5faa666e; r5 CONCERN (session-created record held directory entries) -> fixed 32d3831a; r6 **3 of 3 APPROVE**.
- Moat at release: 1 of 9 proven; 55 registered, 32 pass, 23 pending.
- Released as v9.54.0.
- Open items the slices found: BACKLOG 61-65.

## Next (after cycle 3)

1. BACKLOG 90 (branch-protection-off stale snapshot: data risk), then 74 (agent self-commits bypass the snapshot), 85 (test-gate `__pycache__`), 73 (exit-0 runs with failures).
2. Honest verdict: 81, 82, 89, 91; council helper D7 remainder (54).
3. Then P7 (no fabricated data), P9 (Rule of Two), M0 measurement.

## Next (after cycle 2)

1. Brownfield data safety: BACKLOG 57, 58, 59 (resume re-snapshot, gitignored files, receipt omission).
2. Honest verdict: BACKLOG 53-56, 60 (checklist verification and council helpers under D7; zero-test record; stale results).
3. Then P7 (no fabricated data), P9 (Rule of Two), M0 measurement.

## Next (before cycle 2, kept for history)

1. Cycle 2: BACKLOG 15 (untracked files swept into the session commit: data risk), 37 (Bun passes an inconclusive test result) and 43 (inline Python on council verdict paths importable from the agent repo): honest-verdict and data-risk items first.
2. Then P7 (no fabricated data) and P9 (Rule of Two), the moat gaps with the smallest fix, and M0 measurement (catalog + seeded-defect corpus).
