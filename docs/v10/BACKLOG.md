# Backlog

Ranked. Moat work and red-main fixes always rank first. Each item: milestone,
the metric it moves, status. Plans live in the item.

Status values: todo, in progress, shipped (version), parked (reason).

## Now

1. **Moat suite `tests/moat/` (M0).** Metric: moat properties proven (0 of 9 measured before this). Status: in progress (cycle 1).
   Plan: one script per property emitting `CASE <id> PASS|FAIL`; runner enforces a shrink-only `pending.txt` ratcheted against the last release tag (D2); registered in the local-ci fast tier and a dedicated "Moat suite" job in the Tests workflow (tags fetched). Enforced now: P1 portable proof (with two fixes: Bun `--jwks` passthrough, stripped signature fails), P6 in-place brownfield, the P2 subset that holds. Everything else lands as real failing cases, pending with a milestone.

## Next (moat gaps the audits found, 2026-09-25)

2. **P7 no fabricated data (M7, pulled forward: moat).** Admin page mounts three sample-data panels (`web-app/src/pages/AdminPage.tsx:393,401,405`); unmeasured cost rendered as `$0.00` in `loki-fleet.js:52`, `loki-analytics.js:428`, `ProjectWorkspace.tsx:804`. Fix, rebuild bundles, promote the P7 cases.
3. **P9 Rule of Two (M3, pulled forward: moat).** `loki-issue-to-pr.yml` holds issue text, secrets and push in one step; no `author_association` gate on `/loki`; checkout persists credentials; provider env keeps `GH_TOKEN`. Split read and push jobs; scrub tokens from the provider env.
4. **P2 remaining honest-verdict gaps.** Council approval on inconclusive evidence exits 0 (M2 Seal verdict); `loki verify` and `--fast` exit-code renumber (v10.0.0, breaking).
5. **P3 the Wall + P8 load-bearing proof (M2).** Separate check-author context; freeze and hash checks; no-op ablation in the Seal with N/A path.
6. **P4 model freedom (M0).** Add `claude-opus-5-5` to the catalog after confirming the id; seeded-defect corpus (100+ mostly deterministic defects); floor vs top wrong-pass measurement.
7. **P5 sovereignty (M9).** Egress-blocked start, seal, verify; `doctor --airgap` false "air-gap ready" for opencode with a remote default.

## M0 measurement (after the moat suite)

8. Factory eval: greenfield and brownfield items with known-good outcomes; Seal rate, cost per sealed change, lead time, human touches; top, floor, routed.
9. Seeded-defect corpus (shared with item 6).
10. Adoption eval: scripted fresh-machine run, time to first sealed PR, decisions asked.
11. Head-to-head arms: raw Claude Code (Opus 5.5), raw Codex (through opencode/OpenAI route, or recorded as a gap), hidden tests.
12. Baselines into `METRICS.md`.

## Carried over from v9

13. `docs/INSTALLATION.md:446` pins `asklokesh/loki-mode:8.0.0` in a live `docker run` block; add the line to the release bump list, not just the value.
14. Work selector `select_next_work()` in worktree branch `worktree-agent-a8fad9a6e301fe297` (19/0 tests, 8 mutations verified). Candidate for M5 backlog mode.

## Found in cycle 1 (2026-09-25)

15. **P6 untracked files swept into the session commit (high, data risk).** `commit_session_changes` (`autonomy/run.sh:9207`) runs `git add -A`, committing the user's pre-existing untracked files onto the Loki branch; a later checkout of the base removes them from the working tree. Snapshot untracked files at session start and exclude them. Case `P6.untracked-not-swept`.
16. **py_compile artifacts land in brownfield commits.** Static-analysis gate (`autonomy/run.sh:10782`) writes `__pycache__/*.pyc` into the user's repo, then 9207 commits it.
17. **Dashboard focus POST fires with `LOKI_DASHBOARD=false`** (`autonomy/run.sh:22467-22474`).
18. **Caveman bootstrap makes an outbound attempt and installs a global `~/.claude` SessionStart hook by default** (`autonomy/lib/claude-flags.sh:787`). Sovereignty and simplicity: an air-gapped run still tries egress; a tool silently editing the user's global Claude Code config needs a default-off decision.
19. **Remote stripped signature passes.** `loki_remote_verify_receipt` treats an unattested remote receipt as UNSIGNED exit 0 even when the server publishes a JWKS (pinned by `tests/test-remote-attestation-verdict.sh` test 4).
20. **`loki_proof_attestation_check` accepts plain `http://` JWKS URLs** (MITM controls the key set). Require https or warn.
21. **Seatbelt test fails on this host** (D5). Exit 32 unexplained; investigate on macOS 27.
22. **Orphaned `sleep 300` from the resource monitor** after `loki start` exits.
23. **`tests/lib-extract-client-paths.mjs` / `lib-match-client-routes.py` hardcode the main checkout path**, so `tests/test-verify-client-routes.sh` checks the wrong tree from a worktree or CI.
24. **Bun route: `doctor --airgap` rejected** (case `P5.airgap-audit-default-route`), **`--session-model opus` rejected and per-tier `LOKI_CLAUDE_MODEL_*` ignored** (case `P4.three-setups-resolve`).

25. **`loki ci --report` crashes on large diffs** with "Argument list too long" (`autonomy/loki:33811` passes the diff to python3 as argv; exit 126). Seen on PR #216 and a 2026-08-30 PR via the "Loki CI Quality Gate" workflow, which runs the published package. Pass the diff on stdin or a file.
26. **Bun Parity `doctor-json` flake:** `disk.available_gb` read 94 vs 95 between the two routes on macOS (PR #216). Normalize or drop the value in the parity comparison.
27. **Dashboard routes vanish on newer FastAPI:** a clean `requirements-test.txt` install resolves FastAPI 0.141.1 / Starlette 1.7.0, where `dashboard.server.app.routes` has 191 routes and zero `/api/v2` paths, against 218 and 24 on FastAPI 0.128.0 (slice Z measurement). Users installing today may get a dashboard missing its v2 API. Pin or fix.

28. **Moat: pending-failure fingerprints.** A pending case that starts failing for a different reason (for example its own positive control broke) stays green. Give each pending entry an expected failure reason and fail on a mismatch (council round 2).
29. **P7 route count depends on the host** (9 missing on macOS, 21 on Linux CI) because optional routers do not mount there; tied to item 27.
30. **P4 results need provenance.** Once the corpus exists, a hand-written per-defect outcomes file could still pass; require a verifiable receipt per outcome.
31. **`proof-verify.py` reads "drift unverifiable" (not a git tree, no base_sha) as 1 (tampered)**; it should be 2 (could not check). (The Bun timeout part is fixed: exits above 128 map to 2.)
32. **Docs tell npm users to run `doctor --airgap`** (`docs/air-gapped.md:48`, `deploy/helm/README.md:413`), which the default route rejects. Note `LOKI_LEGACY_BASH=1` until `P5.airgap-audit-default-route` is fixed.
33. **Council member vote: `runner=none` counts as a positive signal while a suite that ran zero tests does not.** Decide one rule.

34. **M2 builders: P3 and P8 must be wired, not just present.** `P8` drives `autonomy/lib/ablation.py` directly and `P3.check-author-context-excludes-implementation` drives `check_author.py` directly. Before promoting either, add an assertion that a stub-provider `run.sh` session (as P5/P6 drive one) records `facts.ablation` and invokes the check-author step (council round 4).
35. **Moat runner self-test: 0-byte baseline file.** Dropping the `git grep -L` empty-file listing leaves the self-test green; the code path was checked by hand. Add a case.
36. **P7 scanners: refuse a zero-file scan** (`SCANNED>0`), so a moved directory cannot read PASS.

37. **Bun route passes an inconclusive test result (high, honest verdict).** `loki-ts/src/runner/quality_gates.ts:451-458` `runTestCoverage` returns `passed: true` for `pass: "inconclusive"` on the default route (council round 5). Same class as the council `pass` readers fixed in v9.52.0.
38. **Council: a missing `pass` key is labelled `no_tests_executed`**; use a distinct reason such as `no_pass_recorded` (`autonomy/completion-council.sh` ~1985).
39. **Attestation edge labels:** `{"keys": []}` reads FAILED (exit 1) rather than NOT CHECKED; `attestation: false` reads UNSIGNED on the remote render but FAILED locally. Neither is a false pass.
40. **P3 prompt case is phrase-based.** `P3.implementer-prompt-has-no-check-authoring` passes on the absence of phrases; pair it with a behavioral assertion (the implementer session does not write the checklist) before promoting.
41. **P1.different-tree-fails lacks an in-script no-edit control** (checked by hand: unedited copy verifies 0).
42. **`doctor --airgap` "local" is a substring match** (`ollama|localhost|127.0.0.1|lmstudio`) and ignores a remote `OLLAMA_HOST`.

43. **Audit every `python3 -c` / `python3 -` on a verdict path for cwd module shadowing (high, honest verdict).** Apply D7 (`python3 -E` plus the `sys.path` filter, or a neutral cwd); the four `completion-council.sh` test-results readers are `python3 -c` calls run from the agent's repo. Council round 6 proved a committed `hashlib.py` could print "attestation: VERIFIED" through the attestation heredocs (fixed in v9.52.0). The same class likely exists wherever the runner or council runs inline Python with the cwd inside the agent's repo (the evidence gate reading test results, checklist verification), where the agent under test can write `json.py`. Guard with `sys.path[:] = [p for p in sys.path if p not in ("", ".")]` or run from a neutral cwd, and add a shadow-module moat case.
44. **P9 injection case: also grep the run HOME and provider-visible files for the canaries** (credential helpers, `~/.config/gh/hosts.yml`), not only env and argv, before promoting.
45. **P4.three-setups-resolve pass bar:** a documented spelling that silently dispatches another model (for example `--session-model high` sending sonnet) must fail the case, not appear as a note.

46. **P2 advisory-only case: match the control.** Its positive control differs from the probe in two variables (gate type and tests yes/no); use an exogenous gate with no tests expecting VERIFIED WITH GAPS.
47. **Refuse bootstrap on release commits once any moat release exists on origin** (a hotfix branch cut before the first moat release has no carrying tag and runs in bootstrap; labelled, but unratcheted).

48. **Same-class hardening beyond D7:** `loki outcomes canary verify` and inline `python3 -` heredocs for `proof share`/`show` still run with the cwd importable; a PATH with an empty component lets a committed `gpg`/`git`/`python3` in the checkout answer (absolute tool paths or scrub empty PATH components on verify paths).
49. **Verifier stdout vs exit code:** on ABSENT / NOT CHECKED the base verifier's JSON (`ok: true`) is still printed while the exit is 1/2; a stdout-only consumer reads a pass. Emit the final verdict in the JSON too.
50. **Remote NOT CHECKED returns 0; local returns 2.** Align or document.
51. **With `-E`, cryptography supplied via `PYTHONPATH`/`PYTHONUSERBASE` reads NOT CHECKED**; say so in the NOT CHECKED message.
52. **CI check name:** "Moat suite" shows green at 0 of 9; consider a name that says "no rule failed" so the check mark is not read as "moat proven" (the step summary already carries the count).

53. **Checklist verification still imports from the agent repo:** `autonomy/prd-checklist.sh` (a script call near 994 and about 9 inline `python3 -c` sites) is outside the cycle-2 fix; apply D7 there next (cycle-2 slice S).
54. **Council helpers still unguarded:** `autonomy/lib/voter-agents.sh` (3 sites parse voter output), `autonomy/council-v2.sh` (7), `autonomy/lib/done-recognition.sh` (16), `autonomy/lib/proof-check.sh` (3); about 217 non-verdict inline sites in `run.sh`; script-form calls (claim_grounding, requirements helper, deadline.py) inherit `PYTHONPATH`. Managed council inserts `PROJECT_DIR or os.getcwd()` on `sys.path` behind experimental flags.
55. **Zero-test honesty on bash:** `enforce_test_coverage`'s #82 zero-test branch downgrades only the JSON record; `test_passed` stays true, so `run.sh` (~12533) still touches `quality/unit-tests.pass` and logs "passed". `evidence-gate-details.json` records `tests.pass: true` for every inconclusive outcome.
56. **Bun npm-test fallback has no zero-test detection**, and the Bun reader uses `passed`/`failed` while the bash writer emits `passed_count`/`failed_count` (the detail shows an unmeasured failed=0).

57. **Resume must re-snapshot untracked files (data risk).** The snapshot is taken only when a session branch is minted; on the resume and already-on-loki paths (`run.sh` ~9100-9119) a file the user created between sessions is swept into the commit and removed from disk on checkout of the base. Add the current untracked list to the snapshot on both reuse paths (cycle-2 council).
58. **Gitignored user files are swept when the agent rewrites `.gitignore` (data risk).** Also snapshot `git ls-files -z --others --ignored --exclude-standard --directory` and prefix-match directory entries in `workspace_diff` (cycle-2 council).
59. **Agent edits to pre-existing untracked files are omitted from the receipt (new in v9.53.0).** Store a blob hash per snapshot entry; list a path whose hash changed (for example `preexisting_modified`) while still never committing the user's file (cycle-2 council). Not a false pass: no verdict reads the list.
60. **Bun `runTestCoverage` accepts a stale `test-results.json`** (no freshness check against `.loki/quality/.test-results.iter`), and an inconclusive coverage still lands in `GateOutcome.passed[]` with an "(gate did not run)" log line.

61. **`evidence-block.json` still writes the raw `$test_pass`** (`completion-council.sh` ~2792, block path), so `tests.pass` can read true for an inconclusive test axis when another axis blocks.
62. **`enforce_test_coverage` monorepo-custom-rejected path** records `pass: true` / `verified` and touches `unit-tests.pass` when `LOKI_MONOREPO_TEST_CMD` is rejected and the gate is skipped.
63. **`council_augment_from_managed_memory`** (`completion-council.sh` ~228) runs `cd "${PROJECT_DIR:-$(pwd)}"` then `python3 -m memory.managed_memory.retrieve`; with `PROJECT_DIR` unset it can run the agent repo's own `memory/` package into the council prompt.
64. **A test script like `exit 0` still reads as a pass on both routes** (the zero-test detector acts only on positive evidence of zero tests); `node --test` behind an npm script is not detected. The Bun freshness marker is agent-writable.
65. **(Fixed for interrupt and kill in cycle 3 via `.loki/state/session-created.z`; see 86 for limits.) Previous-session leftovers become "pre-existing" after a crash** (cycle-3 disclosure): files left uncommitted by a crashed or secret-scan-aborted session are recorded as pre-existing on the next run and stay on disk, uncommitted.

66. **Ignored `dir/` snapshot entries hide agent files under them.** If the agent un-ignores `build/` and creates `build/agent.js`, the literal `build/` reset unstages it and the receipt's coverage check hides it; an agent edit to a user file under that entry is not disclosed (no per-file hash for dir entries). At least report new or changed paths covered only by a dir entry (cycle-3 council).
67. **Deletions and ignored edits are not disclosed.** An agent `rm` of a pre-existing untracked user file, or an edit to a still-ignored pre-existing file (`.env.local`), leaves the receipt silent; iterate the recorded hash map (missing = deleted, changed = modified), with care for gate-regenerated noise (cycle-3 council).
68. **The resume union never prunes entries that became tracked**: a file the user committed between sessions is still unstaged by the session commit while the receipt lists it as modified. Drop union entries present in `git ls-files -z --cached`.
69. **Snapshot hashing cost on large untracked data trees**: every file entry is sha256'd at every session start (30k small files: 1.9s; tens of GB of untracked parquet or weights would stall for minutes). Add a size cap or a size+mtime+inode fingerprint.
70. **Snapshot and hash files live in agent-writable `.loki/state`**: an agent can add entries (hide or uncommit files) or delete the hash file (suppress `preexisting_modified`). Predates cycle 3; matters for adversarial agents.
71. **`evidence-gate-details` `tests.ok` stays true for an inconclusive test axis**; `surface_evidence_gate_details` prints `tests_ok=True` next to `tests_inconclusive`.

72. **Refused resume keeps the old `base-branch.txt` and says too little.** Now that `--no-overwrite-ignore` makes the mint fallback a normal path, session 2 keeps session 1's recorded base (wrong PR `--base` advice if it started elsewhere), and the warning does not name the ignored file or where session 1's commits live.

73. **Bash records a test run that exits 0 but reports failures as a pass** (a jest printing "Tests: 1 failed, 2 passed" with exit 0 wrote `pass: true`, `verified`). Parse the runner's own summary for failures (cycle-3 council round 2).
74. **Agent self-commits bypass the snapshot (data risk).** The snapshot guards only Loki's session commit: an agent that rewrites `.gitignore` and runs `git add -A && git commit` itself puts the user's untracked and ignored files on the session branch, and a base checkout removes them from disk. The RARV prompt tells every provider to checkpoint-commit; only `providers/claude.sh` (and the Bun override) forbids `git add -A`. Intersect `git diff --diff-filter=A <base>..HEAD` with the snapshot in `commit_session_changes`, `git rm --cached` hits, warn, and add the hygiene line to codex/cline/opencode/aider prompts. Also: an agent moving a user file to a new path gets the user's bytes committed under an agent-created name.
75. **Unregistered suites:** `tests/council/test_managed_completion_flag.sh`, `tests/council/test_managed_review*`, `tests/test-voter-agents-json.sh` and `tests/test-evidence-gate-no-tests.sh` are never run by `tests/run-all-tests.sh` (named only in comments).

76. **`done-recognition.sh` tests_axis (434-479): a zero-test record falls through** to an affirmative branch (predates cycle 3; council round 3).
77. **Every Bun test-results.json is stale by construction:** only bash `enforce_test_coverage` writes `.test-results.iter`, so the Bun gate always re-runs `npm test` or reports inconclusive, and an unknown zero-test detector result makes every exit-0 npm run inconclusive. Fails safe; decide whether Bun should write its own marker.
78. **Leading-directory pathspec mismatch:** a pre-existing untracked file `a` also matches `a/b` in the literal reset, but `workspace_diff._covered` only treats `a/` entries as covering children, so the commit omits `a/b` while the receipt lists it (the receipt is the honest side).
79. **A previous session's `static-analysis.pass` survives iteration 0** and reads as a pass of the exogenous static_analysis gate when the new session never runs static analysis (cannot produce VERIFIED alone). Add it to the iteration-0 drop.
80. **Refused resume on a paused or interrupted state keeps session 1's `start-sha`** while the new branch is minted from the current base, so base commits made between sessions can appear in the receipt diff (extends 72).

81. **Two more verdict-relevant inline Python sites without D7:** `run.sh` `_declared_test_script` (~11981) and `_ws_script` (~12101) run plain `python3 -c` with the cwd in the agent repo (extends 54).
82. **`proof-generator._collect_quality_gates` reads `test-results.json` status with no freshness check** against `.test-results.iter` (the iteration-0 drop covers the new-session case; a stale file mid-session is still read).
83. **An embedded git repo with no commits under an un-ignored directory makes `git add -A` fail as a whole**; `commit_session_changes` then silently commits nothing with no "Left uncommitted" warning (fails safe, predates cycle 3).
84. **`-E` also drops `PYTHONDONTWRITEBYTECODE`/`PYTHONIOENCODING`/`PYTHONUTF8`** for the guarded helpers; the council-v2 swarm imports may write `__pycache__` into the install dir (cosmetic).

85. **The test gate's pytest writes `__pycache__/*.pyc` into the user's repo**, and the session commit includes them when the repo does not ignore `__pycache__` (seen in a receipt: `__pycache__/helper.cpython-313.pyc`). `P6.no-gate-artifacts-committed` covers only the static-analysis gate; run tests with `PYTHONDONTWRITEBYTECODE=1` or a pycache prefix under `.loki` (cycle-3 interrupt fix).
86. **Session-created record limits:** the provider turn in flight when the process dies is not recorded (SIGHUP is not trapped, like SIGKILL), so those files are treated as the user's (kept, never committed); a refused resume starts an empty record (warns by name); a path created then deleted by the agent and later re-created by the user is committed as the session's; the snapshot now requires python3 (fails closed without it).

87. **Resume rehash hides earlier edits:** the union deletes and rehashes `.sha.z`, so after a SIGKILL or pod loss (no session-1 receipt) session 1's edit to a pre-existing untracked file never appears as `preexisting_modified`. Keep existing hashes for entries already in the base list; hash only new paths.
88. **Old git (< 2.18) receipt attribution:** a failed mint snapshot deletes the list, so the receipt names every user untracked file as the run's work (names and counts only; the commit path fails closed). Keep an `ls-files --others --exclude-standard` fallback list for the receipt.
89. **Bash and Bun read `failed_count` differently:** the bash evidence gate reads `pass: true` as PASS whatever `failed_count` says; Bun now fails it.

90. **Data risk, next in line: `LOKI_BRANCH_PROTECTION=false` on a leftover `loki/session-*` branch** returns before any snapshot (`run.sh` ~9073), and `commit_session_changes` then commits with the earlier session's stale snapshot, so a file the user made since is committed and lost from disk on checkout of the base (also in v9.53.0; breaks the LOCK A1 opt-out promise). One guard: commit nothing unless this run took a snapshot, or skip the session commit when branch protection is off (cycle-3 council round 6).
91. **Zero-test stage events:** a zero-test run still returns 0 from `enforce_test_coverage`, so the loop emits `stage_complete test_suite pass` (~24590) although the result is inconclusive.
92. **Receipt path bases mix under a subdirectory `TARGET_DIR`:** tracked entries are repo-top-relative, untracked and `preexisting_modified` entries are cwd-relative.

## Later milestones

M1 one command, M2 Seal and Wall, M3 assign like a teammate, M4 system map, M5 the line, M6 ship and operate, M7 one screen, M8 legacy lane, M9 enterprise readiness, M10 simplify and ship v10.0.0. Items get broken out here when their milestone comes up.
