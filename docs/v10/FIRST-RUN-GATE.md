# First-run gate: defect reproduction (A-02, step 1)

Base: main at VERSION 10.5.10. Local CLI `bin/loki` from this worktree, never a global install.
Every run used a run-owned temp dir (`loki_run_tmp_create`), `HOME=<tmp>/home` (empty: no
`~/.claude` skills, no `~/.loki`, no dashboard), `LOKI_NO_BROWSER=1`, and the bugrepo from
`firstrun-repro/bugrepo-original/` (git repo, no remote, one commit).

Provider: a stub `claude` first on PATH (answers `--help` with `--settings`, exits 0, fixes
`sum.js` on the implement stage, signals completion; in the Wall stage it writes nothing).
`STUB_SPEC_CONFLICT` makes it print a `LOKI_SPEC_CONFLICT:` line. The v10 engine needs
`LOKI_E10_INVOKER=cli` to use the stub (its default SDK loop does not go through PATH).

Real provider: 2 attempts (`LOKI_ENGINE=v10`), both died in 1-3 s at cost $0 with
`Not logged in`. A throwaway HOME does not carry the Claude login (copying
`~/.claude/.credentials.json` was not enough). Real-provider reproduction of (a) and the
real-claude timing in (d) therefore rests on the recorded logs (`run1.log`, `run2.log`,
`raw.log`) plus the source reading below. The gate's `--real` mode must pass a token via
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or run with the real HOME.

Entry point chosen for a new user (README.md "Use it"): `loki quickstart` is interactive and
asks for an idea, so it cannot fix a given repo; the README's one-shot task command is
`loki quick "<task>"`, which is what run1.log used and what the gate runs. The v10 engine
(`LOKI_ENGINE=v10 loki "<task>" --no-pr`) is tested as a second entry.

| # | Defect | Reproduced | Command and rc | Evidence line | Class | Source |
|---|--------|-----------|----------------|---------------|-------|--------|
| a | Wall commits Jest globals in a node:test repo | Not reproduced live (real provider unavailable in clean HOME); root cause confirmed in code | v10 stub run: intake event `"testmap":{"runners":["npm"],"tests":[]...}` | Wall brief is paths only ("framework named in repomap.txt"); the testmap reports `tests: []` and runner `npm` for a node:test repo, so nothing names node:test; `guessRunner` returns null for npm so the generated file is never run or checked | CODE BUG | `loki-ts/src/engine10/stages/wall.ts:76-86` (brief), `:110-117` (guessRunner), `loki-ts/src/engine10/testmap.ts:37` (npm coarse, no node:test detection) |
| b | npm test red (2 of 3) but the run exits 0 | Yes | v10 stub run, implement makes no diff, tests still red: rc=0, `seal ... SPEC_CONFLICT`; also `PARTIAL` rc=0 | `Verdict:    SPEC_CONFLICT` then `rc=0` with the failing test untouched | CODE BUG | `loki-ts/src/engine10/supervisor.ts:387` (`res.verdict === "FAILED" ? 1 : 0`, so PARTIAL and SPEC_CONFLICT exit 0) |
| c | `loki verify` calls an untouched sealed receipt TAMPERED | Yes | `LOKI_ENGINE=v10 loki verify` after a sealed run whose receipt holds a non-ASCII char: rc=1 | `verdict: TAMPERED / receipt_sha256 mismatch: recorded "40b8a0ef..." computed 4a572bdf...` (receipt untouched; ASCII-only receipts verify UNSIGNED rc=0) | CODE BUG | `loki-ts/src/engine10/verify_cmd.ts:21-28` private `canonicalJson` does not `\uXXXX`-escape chars U+0080 and above; the sealer does at `stages/seal.ts:39-50` |
| d | `loki quick` slow, noisy, commits extra files | Yes for noise and commits; time partly (stub) | `loki quick "fix ..."` stub provider: rc=0, 111 s wall with a zero-latency stub (real: 97 s vs 10 s raw per run1.log/raw.log), 269 output lines | commit `Loki Mode session changes` adds `HANDOFF.md` and `package-lock.json` (+77 -1 for a 1-line fix); USAGE.md is also committed when the provider returns Markdown (run1.log) | CODE BUG | `autonomy/run.sh:11065-11233` (`commit_session_changes` stages everything), HANDOFF writer `autonomy/run.sh:29334-29344`, docs gate `autonomy/run.sh:14835-14853`, banner/gate logging throughout |
| e | Printed receipt digest differs from what proof verify checks | Yes | `loki quick` stub, then `loki proof verify <run>` rc=0 | Printed block: `Files changed | 2`, `Diff sha256 af01b739...`; `proof verify` recorded/current diff `25b61f73...` over 3 files (the printed block predates the session commit that adds HANDOFF.md and the lockfile) | CODE BUG | receipt generated before `commit_session_changes` (`autonomy/run.sh:11233`, proof call near `:8815-8935`); printer at `:4948-4964` |
| f | v10 prints UNSIGNED; two engines use different signing env vars | Yes (UNSIGNED); partially (env vars) | any v10 run: rc per verdict | `receipts will be UNSIGNED (no signing key configured; set LOKI_RECEIPT_SIGNING_KEY or LOKI_RECEIPT_SIGNING_KEY_FILE)` | CODE BUG (first-run default) | both honor `LOKI_RECEIPT_SIGNING_KEY[_FILE]` (`seal.ts:69`, `autonomy/lib/proof-generator.py:2185-2186`), but the legacy engine also has `LOKI_PROOF_GPG_KEY` (`proof-generator.py:2158`); with no key neither signs, so a new user always gets an unsigned receipt |
| g | doctor FAILs for Cline and Aider | No | `loki doctor` in clean HOME: rc=1 | `WARN  Cline CLI - not found (optional)`, `PASS  Aider CLI (v0.86.2)`; the only FAIL is `Claude login has EXPIRED` (stub claude / empty HOME) | MACHINE ARTIFACT | founder machine broken symlinks; not a code path (Cline and Aider are WARN when absent) |

Notes
- (c) needs a non-ASCII character anywhere in the receipt (task-derived reasons, repo paths,
  check messages); real runs with a spec-conflict reason or unicode in a path hit it.
- (b) shows the exit code is wrong independent of (a): any non-FAILED verdict exits 0.
- Cost of all runs in this table: $0.00 (stub runs; both real attempts failed on login).
