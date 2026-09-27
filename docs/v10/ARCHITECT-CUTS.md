

## 20:12Z cut (S-194..S-213)

**Checked before cutting.** All reads are on main at 8ba7024d (v9.73.0).
- **Alternates re-read against the code.**
  - **A1 (BACKLOG 108) is real.** `create_session_pr`'s `LOKI_AUTO_PR=1` branch calls `_loki_trusted_push` and never reads `.loki/state/agent-committed-user-files.z`. The only references to that file are the writer comment and the writer itself, inside `_loki_untrack_agent_committed_user_files`.
  - **A2 (BACKLOG 17) is real.** The "Notify dashboard of active project directory" block, about 24477 today, posts to `/api/focus` behind `command -v curl` only. It has no `ENABLE_DASHBOARD` check.
  - **A3 is real and larger than the card says.** run.sh 211 and 239 always set PROJECT_DIR to the Loki install root. So the BACKLOG 127 "guard when unset" would do nothing. The actual defect is that `council_managed_should_stop` runs `git diff --stat` in Loki's own tree, not the target project. Its three readers are still bare `python3 -E`, and p2-honest-verdict.sh (about 858) says so.
  - **A4 (BACKLOG 51) is real.** `grep -c PYTHONUSERBASE autonomy/loki` prints 0. The NOT CHECKED text says "Install python3 cryptography" even to a user who installed it through PYTHONPATH or PYTHONUSERBASE, which `-E` ignores.
  - **A5 is split.**
    - BACKLOG 145 sits in the Array.from generator arm, about 1934-1994. That does not overlap S-180's helper-return arm (about 2081-2170).
    - BACKLOG 147 edits `HELPER_LOCAL_DECL_TMPL`, which is in S-180's region, so it is held.
- **New class found: every `-E`-only verdict reader outside completion-council.sh (BACKLOG 53 and 54).** These are:
  - autonomy/lib/done-recognition.sh: 16 sites.
  - autonomy/council-v2.sh: 7 sites.
  - autonomy/lib/voter-agents.sh: 3 sites.
  - autonomy/lib/proof-check.sh: 3 sites.
  - autonomy/prd-checklist.sh: about 11 sites.
  - loki-ts/src/commands/proof.ts:606, the Bun `loki proof verify` path.

  All of them run PATH `python3 -E`. BACKLOG 134 showed that a user-site `.pth` still loads under `-E`.

  On `-S` compatibility:
  - The imports I read are stdlib only: swarm/sycophancy.py, autonomy/checklist-verify.py, and autonomy/lib/proof-verify.py (which adds its own directory to sys.path at line 76). So `-I -S` should hold for those.
  - Each builder still audits the imports of the rest of its sites, including the prd-checklist oracle heredoc.

  Existing tests source each of these files on their own, so each file needs the guarded helper copy. For voter-agents.sh, `.` at completion-council.sh 4245 sources it into the parent shell.
- **council-v2 fails open on sycophancy.** A detector crash yields `0.000`, then `should_challenge=no`. A unanimous approve then skips the devil's advocate.
- **Cockpit remainder (BACKLOG 114).**
  - `FinalActions` receives `git=null` after a failed status fetch (the `settle` fallback) and still says "The working tree is clean" and "Nothing to push".
  - A failed `getStatus` (the swallow at useCockpitState.ts:202) makes Pause, Resume and Stop read "No run in progress".
  - A failed `getChecklist` (the swallow at 204) renders "No gate results recorded."
- **Already handled, so dropped:**
  - BACKLOG 31: proof-verify maps unverifiable drift to 2.
  - BACKLOG 38: `no_pass_recorded`.
  - BACKLOG 49: the `--jwks` output is patched.
  - BACKLOG 16 and 85: `PYTHONDONTWRITEBYTECODE` in `enforce_test_coverage`, plus the py_compile rewrite.
  - BACKLOG 133: `PULSE_MOAT_RESULT` carries a `.sha` sidecar.
  - BACKLOG 140: the environment-variables.md row names all four tokens and both routes.
  - BACKLOG 13: release.sh bumps INSTALLATION.md at 320.
  - BACKLOG 22: the resource monitor backgrounds its sleep.
  - BACKLOG 26: test-bun-parity-disk-tolerance.sh.
  - The unreadable-waivers banner in loki-checklist-viewer is already pinned in loki-unmeasured-panels-honesty.node.test.mjs:319.
  - The GitPanel badge on a null fetch renders nothing.
  - PhaseVisualizer: its only caller passes 'idle'.
- **Dropped on merit: BACKLOG 69 (snapshot hash size cap).**
  - A size-plus-mtime fingerprint is spoofable, which weakens `preexisting_modified`.
  - It changes the sealed `.sha.z` entries.
  - Nobody has measured the stall.

### S-194: LOKI_AUTO_PR pushes a branch whose history still holds user files (BACKLOG 108, A1)
- Files:
  - autonomy/run.sh: `create_session_pr` only, from its head to the `_loki_trusted_push` call. Anchor on the function name, because S-175 shifts line numbers when it merges.
  - tests/test-auto-pr-agent-committed-refuse.sh (new)
- Tier: HIGH (secret exposure)
- Region: this does not overlap S-175 (`enforce_test_coverage`) or S-195 (the focus notify block).
- Red:
  - With a non-empty agent-committed-user-files.z and `LOKI_AUTO_PR=1`, the stubbed `_loki_trusted_push` gets called.
  - The advisory path prints `git push -u` advice with no cleanup step.
- Green:
  - When the record is non-empty:
    - Recompute the fork the way `_loki_untrack_agent_committed_user_files` does: the merge base with base-branch.txt, else session-start-sha.
    - Print `git reset --soft <fork> && git commit` before any push advice.
    - Under `LOKI_AUTO_PR=1`, refuse the push: `log_warn` naming the files, and return 1.
  - An empty or absent record leaves both paths byte-identical to today.
- Gate: the builder first reproduces the stub push call on main. If it does not reproduce, the slice closes as handled.
- Test rule: `cd` to scratch before sourcing run.sh, and assert that no `.loki/state/provider` appears in the repo (BACKLOG 126).
- Wall: `bash tests/test-auto-pr-agent-committed-refuse.sh` exits 0. Its legs:
  - Auto path with a record: no push, rc 1, and the cleanup line printed.
  - Advisory path with a record: the cleanup line appears before `git push -u`.
  - Empty record: the push happens.
  - Removing the record read in a scratch copy fails the first leg.
  - `bash tests/test-trusted-push-agent-config.sh` exits 0.

### S-195: the /api/focus POST fires with the dashboard disabled (BACKLOG 17, A2)
- Files:
  - autonomy/run.sh: the "Notify dashboard of active project directory" block only.
  - tests/test-focus-post-dashboard-off.sh (new)
- Tier: MEDIUM
- Region: this does not overlap S-175 or S-194.
- Red: with `ENABLE_DASHBOARD=false`, a curl shim on PATH records one POST to `/api/focus`.
- Green:
  - Guard on the runtime `ENABLE_DASHBOARD`, which run.sh sets false at about 19288. Do not guard on `LOKI_DASHBOARD`.
- Test: extract the block by its comment anchor, as test-autocapture-shadow-write-guard.sh does. No full run.sh source.
- Wall: `bash tests/test-focus-post-dashboard-off.sh` exits 0.
  - false: the shim log is empty.
  - true: exactly one POST.
  - Removing the guard in a scratch copy fails the false leg.

### S-196: council_managed_should_stop reads Loki's install tree for its diff and runs -E readers (A3)
- Files:
  - autonomy/completion-council.sh: `council_managed_should_stop` only.
  - tests/moat/p2-honest-verdict.sh: `case_council_readers_no_user_site_pth`, plus the about-858 comment in `case_council_readers_not_shadowed`.
  - tests/test-council-managed-diff-target.sh (new)
- Tier: HIGH (moat)
- Red:
  - A stub `providers.managed` records `_CC_DIFF`. It shows install-tree paths, not the target project's change.
  - A planted user-site `.pth` forges the test_summary read.
- Green:
  - `diff_summary` comes from `${TARGET_DIR:-.}`, the same root as `loki_dir` and `LOKI_TARGET_DIR`.
  - The two inline readers and the heredoc run through `_loki_snapshot_py_tool -I -S`.
  - If no interpreter resolves, test_summary is empty, pending is `[]`, and the function returns 1 (the Bash voting fallback). It never returns 0.
  - The new leg lands in the same commit as the fix, because the case is already proven.
- Gate: reproduce the install-tree diff with the stub first. Reuse S-173's stub.
- Wall:
  - `bash tests/moat/p2-honest-verdict.sh` prints `CASE P2.council-readers-no-user-site-pth PASS` and `CASE P2.council-readers-not-shadowed PASS`.
  - `bash tests/test-council-managed-diff-target.sh` exits 0: a file changed only in the target appears in `_CC_DIFF`.
  - Reverting the readers to `python3 -E` in a scratch copy makes the pth case FAIL.
  - `bash tests/moat/run.sh` reports no rule failed.

### S-197: the NOT CHECKED text should name PYTHONPATH and PYTHONUSERBASE (BACKLOG 51, A4)
- Files:
  - autonomy/loki:
    - `loki_remote_verify_receipt`'s attestation NOT CHECKED branch only.
    - `cmd_proof verify`'s `--jwks` NOT CHECKED echo only.
  - tests/test-proof-verify-jwks.sh (case 4 only)
- Tier: LOW
- Region: this does not overlap S-179 (`cmd_cost`).
- Green:
  - Both messages add that the verifier runs `python3 -E`, so cryptography supplied through PYTHONPATH or PYTHONUSERBASE is not seen.
  - Exit codes are unchanged.
- Wall:
  - `bash tests/test-proof-verify-jwks.sh` exits 0, and case 4 asserts that the NOT CHECKED output names PYTHONUSERBASE.
  - `grep -c PYTHONUSERBASE autonomy/loki` prints 2 or more (0 today).
  - `bash tests/test-remote-attestation-verdict.sh` exits 0.

### S-198: the P7 Array.from arm loses an outer generator's index when generators nest (BACKLOG 145, A5)
- Files: tests/moat/p7-no-fabricated-data.sh. Only two regions:
  - the Array.from generator arm, about 1934-1994;
  - one fixture beside the B-8 fixture, about 3301.
- Tier: HIGH (moat)
- Region: this does not overlap S-180's helper-return arm. Do not append fixtures at the file tail.
- Red: `Array.from({length:2}, (_, r) => Array.from({length:2}, (_, c) => ({ id: r, user: 'Admin' })))` goes through.
- Green: substitute the enclosing generator's params as well as the inner ones.
- Branch: run the widened arm on main first.
  - On any live hit in dashboard-ui or web-app, the slice becomes report-only.
  - Never add an allowlist.
  - cases.txt stays unchanged.
- Wall:
  - `bash tests/moat/p7-no-fabricated-data.sh` prints PASS for every P7 case, and the nested fixture is flagged.
  - Removing the outer substitution lets the fixture through.

### S-199: the py-tool identity test covers every guarded copy
- Files: tests/test-council-py-tool-identity.sh
- Tier: LOW
- Green:
  - Compare every `^_loki_snapshot_py_tool() {` body found by `git grep -l` under autonomy/ against run.sh's.
  - Vacuity guard: at least one copy besides run.sh, and each body at least 10 lines.
  - This is the only row that edits this file. S-200 to S-204 add copies and rely on it.
- Wall:
  - `bash tests/test-council-py-tool-identity.sh` exits 0 and prints the number of copies compared.
  - A one-byte change to completion-council.sh's copy in a scratch tree exits 1.

### S-200: done-recognition readers load user-site .pth (BACKLOG 54)
- Files:
  - autonomy/lib/done-recognition.sh: every python3 site, plus a guarded helper copy.
  - tests/test-done-recognition-no-user-site-pth.sh (new)
- Tier: HIGH
- Red: a user-site `.pth` under a scratch HOME changes the verdict read (the about-703 site).
- Green:
  - All sites run through `_loki_snapshot_py_tool -I -S`.
  - The builder lists each site's result when no interpreter resolves. None of them may read as done or met.
  - Add a byte-identical guarded copy.
- Gate: reproduce the forged read on main first.
- Wall:
  - `bash tests/test-done-recognition-no-user-site-pth.sh` exits 0.
  - Reverting one site to `-E` in a scratch copy fails it.
  - `bash tests/test-done-recognition-tests-axis.sh` and `bash tests/test-reuse-done-recognition.sh` exit 0.

### S-201: council-v2 readers load .pth, and a crashed sycophancy check skips the devil's advocate (BACKLOG 54)
- Files:
  - autonomy/council-v2.sh: its 7 python3 sites and the Step 4 and 5 fallbacks, plus a guarded helper copy.
  - tests/test-council-v2-no-user-site-pth.sh (new)
- Tier: MEDIUM. The path is opt-in through `LOKI_COUNCIL_VERSION=2`.
- Red:
  - A `.pth` forges a vote read.
  - A detector failure yields `0.000`, so a unanimous approve never challenges.
- Green:
  - `-I -S` on every site.
  - An unmeasured sycophancy score on a unanimous approve runs the devil's advocate. A resolver failure never yields "no challenge".
- Gate: reproduce both on main first.
- Wall:
  - `bash tests/test-council-v2-no-user-site-pth.sh` exits 0, covering the `.pth` leg and the detector-failure leg.
  - Reverting either change fails its leg.
  - `bash tests/test-council-v2-quorum.sh` exits 0.

### S-202: voter-agents readers load user-site .pth (BACKLOG 54)
- Files:
  - autonomy/lib/voter-agents.sh: its 3 python3 sites, plus a guarded helper copy.
  - tests/test-voter-agents-no-user-site-pth.sh (new)
- Tier: HIGH
- Red: a `.pth` changes a parsed voter verdict.
- Green: `-I -S`. With no interpreter, the dispatch fails, so completion-council's existing fail-closed CONTINUE applies.
- Gate: reproduce the changed verdict on main first.
- Wall:
  - `bash tests/test-voter-agents-no-user-site-pth.sh` exits 0, and reverting fails it.
  - `bash tests/test-voter-agents-json.sh` and `bash tests/test-sdk-voter-agents.sh` exit 0.

### S-203: proof-check readers load user-site .pth (BACKLOG 54)
- Files:
  - autonomy/lib/proof-check.sh: its 3 heredoc readers, plus a guarded helper copy.
  - tests/test-proof-check-no-user-site-pth.sh (new)
- Tier: MEDIUM
- Red: a `.pth` forges the headline read.
- Green: `-I -S`. With no interpreter, the readers print empty, as they do today when python3 is absent.
- Gate: reproduce the forged headline on main first.
- Wall:
  - `bash tests/test-proof-check-no-user-site-pth.sh` exits 0, and reverting fails it.
  - `bash tests/test-proven-pr-check.sh` exits 0.

### S-204: checklist verification loads user-site .pth (BACKLOG 53)
- Files:
  - autonomy/prd-checklist.sh: every python3 site, including the checklist-verify.py call and the oracle heredoc, plus a guarded helper copy.
  - tests/test-prd-checklist-no-user-site-pth.sh (new)
- Tier: HIGH
- Red: a `.pth` changes the status_token or the waiver read.
- Green:
  - `-I -S`. The builder audits the oracle heredoc's imports first.
  - Any site that needs a non-stdlib module stays `-E` with a ponytail note.
  - Resolver failure: the builder lists each site's result. None reads as verified.
- Gate: reproduce the changed read on main first.
- Wall:
  - `bash tests/test-prd-checklist-no-user-site-pth.sh` exits 0, and reverting fails it.
  - `bash tests/moat/p2-honest-verdict.sh` prints `CASE P2.checklist-verify-not-shadowed PASS`.
  - `bash tests/test-prd-checklist-interval-w4.sh` exits 0.

### S-205: Bun loki proof verify runs a PATH python3 -E (BACKLOG 48 class, Bun half)
- Files:
  - loki-ts/src/commands/proof.ts: the verifier spawn only.
  - loki-ts/src/util/python.ts, only to extend the helper that already exists there.
  - loki-ts/tests/commands/proof_verify_interpreter.test.ts (new)
- Tier: HIGH
- Red: a user-site `.pth` under a scratch HOME changes verify output, or writes a marker.
- Green:
  - Resolve like `_loki_snapshot_py_tool`: /usr/bin/python3 and /bin/python3 first, then absolute PATH dirs, each probed with `-I -S -c ''`. Run with `-I -S`.
  - If none resolves, exit 2 as NOT CHECKED.
- Gate: reproduce the `.pth` effect on main first.
- Wall:
  - `cd loki-ts && bun test tests/commands/proof_verify_interpreter.test.ts tests/commands/proof_verify_parity.test.ts` exits 0.
  - Reverting to `["python3","-E"]` fails the new test.
- The Captain rebuilds loki-ts/dist.

### S-206: cockpit actions say "working tree is clean" and "no run in progress" after a failed fetch (BACKLOG 114)
- Files:
  - web-app/src/cockpit/FinalActions.tsx (disabled reasons only)
  - web-app/src/cockpit/FinalActions.reasons.test.mjs (new)
- Tier: LOW
- Green:
  - Export a pure reasons function.
  - `git === null`: commit, push and PR read "Working tree status not loaded".
  - `status === null`: pause, resume and stop read "Run status not loaded".
  - Real data keeps today's copy.
- Wall:
  - `node --test web-app/src/cockpit/FinalActions.reasons.test.mjs` passes:
    - git null lacks "The working tree is clean" and "Nothing to push";
    - status null lacks "No run in progress";
    - `{ahead:0}` with no files keeps both sentences.
  - `cd web-app && npx tsc -b` exits 0.
- The Captain rebuilds web-app/dist.

### S-207: cockpit evidence says "No gate results recorded" when the checklist request failed (BACKLOG 114)
- Files:
  - web-app/src/cockpit/useCockpitState.ts: `getChecklist` through `settle`, plus a `checklistError` field.
  - web-app/src/cockpit/EvidencePanel.tsx (empty branch only)
  - web-app/src/cockpit/ExecutionCockpit.tsx (EvidencePanel props only)
  - web-app/src/cockpit/EvidencePanel.state.test.mjs (new)
- Tier: LOW
- Wall:
  - `node --test web-app/src/cockpit/EvidencePanel.state.test.mjs` passes:
    - an error renders "Could not load gate results" and not "No gate results recorded";
    - `items:[]` with no error keeps that sentence.
  - `node web-app/src/cockpit/run-derive-view-test.mjs` exits 0.
  - `cd web-app && npx tsc -b` exits 0.
- The Captain rebuilds web-app/dist.

### S-208: trust trajectory reads any non-pass council verdict as a failure (BACKLOG 118)
- Files:
  - autonomy/lib/trust_trajectory.py (`_verdict_is_pass` only)
  - tests/test_trust_trajectory_unknown_verdict.py (new)
- Tier: MEDIUM
- Red: a verdict such as "UNKNOWN" or "INCONCLUSIVE" maps to 0.0.
- Green:
  - Only explicit fail tokens map to False. The builder enumerates them from completion-council.sh and proof-generator's writers.
  - Anything else maps to None, meaning the axis has no data point.
- Gate: find a writer string that is neither pass nor fail. If none exists, close the slice as handled.
- Wall:
  - `python3 -m pytest -q tests/test_trust_trajectory_unknown_verdict.py tests/test_trust_trajectory.py tests/dashboard/test_trust_trajectory_endpoint.py` passes.
  - An unknown verdict adds no data point, and REJECTED still reads 0.0.
  - Reverting fails the first case.

### S-209: Bun codex, cline and aider get the raw prompt without the commit-hygiene line (BACKLOG 99, Bun half)
- Files:
  - loki-ts/src/runner/providers.ts: the codex, cline and aider invokers only.
  - loki-ts/tests/runner/provider_commit_hygiene.test.ts (new)
  - loki-ts/tests/runner/providers.test.ts, only where exact-argv assertions move.
- Tier: MEDIUM
- Green:
  - Prefix the prompt with the hygiene line plus a blank line, matching the bash `"$PROVIDER_COMMIT_HYGIENE"$'\n\n'"$prompt"`.
  - The test reads the literal from providers/codex.sh; it does not copy it.
- Wall:
  - `cd loki-ts && bun test tests/runner/provider_commit_hygiene.test.ts tests/runner/providers.test.ts` exits 0.
  - All three argvs carry the bash literal.
  - Claude's prompt is not double-prefixed.
  - Removing the prefix fails the three legs.
- The Captain rebuilds loki-ts/dist.

### S-210: speed up the two command-probe suites (29s and 30s in shard-durations.tsv)
- Files: tests/test-help-discoverability.sh, tests/test-completion-coverage.sh (the probe loops only)
- Tier: LOW
- Change:
  - The builder captures `real_count` and the pass and fail lines first.
  - Then probe with `xargs -P 8`, each probe in its own scratch cwd, writing one result file per command.
  - Keep the captured-output (never piped) rule noted in the file.
- Wall:
  - `time bash tests/test-help-discoverability.sh` and `time bash tests/test-completion-coverage.sh` each exit 0 with real time under 10s.
  - `real_count` and the pass counts match the pre-change capture.
  - The builder reports both timings.

### S-211: register the four suites BACKLOG 75 still leaves unrun (after S-174 merges)
- Files: tests/run-all-tests.sh (four `run_test` lines only), tests/shard-durations.tsv (four lines)
- Tier: LOW. **Captain-built after S-174 merges.**
- Suites: tests/council/test_managed_completion_flag.sh, tests/council/test_managed_review_flag.sh, tests/test-evidence-gate-no-tests.sh, tests/test-voter-agents-json.sh.
  - All four appear only in comments in run-all-tests.sh, so no runner executes them.
  - The evidence-gate suite also appears in scripts/local-ci.sh, which is retired.
- Gate:
  - Each suite passes 3 of 3 from a scratch cwd and leaves no `.loki/state/provider` in the repo.
  - A suite that fails is reported, not registered, and becomes its own fix slice (the S-110 lesson).
- Wall:
  - `grep -c -e test_managed_completion_flag -e test_managed_review_flag -e test-evidence-gate-no-tests -e test-voter-agents-json tests/run-all-tests.sh` prints 8 (4 before registration).
  - `bash tests/test-shard-coverage.sh` exits 0.

### S-212: GUARDS 5, 12 and 13 still read PENDING after S-138, S-139 and S-154 landed (after S-181 merges)
- Files: docs/v10/GUARDS.md (sections 5, 12 and 13 only). This does not overlap S-181's section 11.
- Tier: LOW
- Green:
  - Section 12 names tests/test-no-ambient-gitconfig-writes.sh (S-138).
  - Section 13 names the RELEASED_AHEAD_OF_NPM case in tests/test-v10-pulse.sh (S-139). It states that this is a flag, not a refusal.
  - Section 5 names tests/test-prune-worktrees.sh only if that test asserts the no-mtime rule. Otherwise it stays PENDING and says what would close it.
- Wall:
  - `awk '/^## 12\./,0' docs/v10/GUARDS.md | grep -c 'PENDING, no slice cut'` prints 0.
  - `bash tests/test-no-ambient-gitconfig-writes.sh` and `bash tests/test-v10-pulse.sh` exit 0.

### S-213: no test of their own covers the council-vote labels on cost.html and proofs.html (BACKLOG 123, tests only)
- Files: dashboard-ui/tests/static-council-vote-label.node.test.mjs (new)
- Tier: LOW
- It pins:
  - proofs.html: the badge reads "council " plus the verdict, with the title "Recorded council vote, not a verification result".
  - cost.html: the runs header reads "Council vote".
- Wall:
  - `node --test dashboard-ui/tests/static-council-vote-label.node.test.mjs` passes.
  - Renaming the header, or dropping the title, in a scratch copy fails it.

**Registration and rebuilds (Captain).**
- New tests to register:
  - S-194 to S-198.
  - S-200 to S-209.
  - S-213.
- Bundle rebuilds:
  - S-205 and S-209: loki-ts/dist.
  - S-206 and S-207: web-app/dist.
- Sequencing:
  - S-211 builds after S-174 merges.
  - S-212 builds after S-181 merges.
  - S-194 and S-195 are the only run.sh rows. They name regions that do not overlap each other or S-175, and merge one at a time.

**Held, not in the 20:**
- BACKLOG 147 (P7 useMemo composed form): wait for S-180.
- BACKLOG 36 (P7 zero-file scan): wait for S-180 and S-198.
- BACKLOG 19 (a stripped remote attestation reads UNSIGNED exit 0): same function as S-197, so wait for S-197.
- The bash `loki proof verify` interpreter (autonomy/loki `cmd_proof`, `python3 -E`): wait for S-179 and S-197.
- BACKLOG 99, bash half (run.sh main loop): wait for S-175, S-194 and S-195.
- workspace_diff reports count 0 in a non-git directory: needs a design, because the value lands in the receipt.
- dashboard/server.py items from BACKLOG 118: wait for S-178. They are:
  - `/cost` pricing at Sonnet rates with no estimate label;
  - council-state `total_votes: 0`;
  - notifications zero summary;
  - `StatusResponse` defaults;
  - skill-session `running_agents: 0`.
- ProjectWorkspace phase labels and Replay Build: wait for S-187.
- Speeding up test-autocapture-shadow-write-guard.sh: its negative legs wait on a disowned process and need a design.
- Carried over: P1.verification-metadata-signed; the P2 verify renumber (CEO); BACKLOG 18, 28, 52, 121, and 123 (the audit.py half); S-112, S-114, S-115, S-117 to S-122.

| S-194 | BACKLOG 108: LOKI_AUTO_PR pushes a branch whose history still holds user files | autonomy/run.sh (create_session_pr only; does not overlap S-175 or S-195), tests/test-auto-pr-agent-committed-refuse.sh (new) | HIGH | bash tests/test-auto-pr-agent-committed-refuse.sh exits 0: auto path with a record makes no push, returns 1 and prints git reset --soft; advisory path prints the cleanup before git push -u; empty record pushes; removing the record read in a scratch copy fails leg 1; bash tests/test-trusted-push-agent-config.sh exits 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-195 | BACKLOG 17: /api/focus POST fires with the dashboard disabled | autonomy/run.sh (dashboard focus notify block only; does not overlap S-175 or S-194), tests/test-focus-post-dashboard-off.sh (new) | MEDIUM | bash tests/test-focus-post-dashboard-off.sh exits 0: ENABLE_DASHBOARD=false leaves the curl shim log empty, true records one POST; removing the guard in a scratch copy fails the false leg | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-196 | council_managed_should_stop diffs Loki's install tree and runs -E readers | autonomy/completion-council.sh (council_managed_should_stop only), tests/moat/p2-honest-verdict.sh (case_council_readers_no_user_site_pth plus the ~858 comment), tests/test-council-managed-diff-target.sh (new) | HIGH | bash tests/moat/p2-honest-verdict.sh prints CASE P2.council-readers-no-user-site-pth PASS and CASE P2.council-readers-not-shadowed PASS; bash tests/test-council-managed-diff-target.sh exits 0 with the target-only file in _CC_DIFF; reverting the readers to -E makes the pth case FAIL; bash tests/moat/run.sh reports no rule failed | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-197 | BACKLOG 51: NOT CHECKED text should name PYTHONPATH and PYTHONUSERBASE | autonomy/loki (loki_remote_verify_receipt attestation NOT CHECKED branch and cmd_proof --jwks NOT CHECKED echo only; does not overlap S-179), tests/test-proof-verify-jwks.sh (case 4 only) | LOW | bash tests/test-proof-verify-jwks.sh exits 0 with case 4 asserting PYTHONUSERBASE in the NOT CHECKED output; grep -c PYTHONUSERBASE autonomy/loki prints 2 or more; bash tests/test-remote-attestation-verdict.sh exits 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-198 | BACKLOG 145: P7 Array.from arm loses an outer generator's index when generators nest | tests/moat/p7-no-fabricated-data.sh (Array.from generator arm ~1934-1994 and one fixture beside the B-8 fixture ~3301 only; does not overlap S-180) | HIGH | bash tests/moat/p7-no-fabricated-data.sh prints PASS for every P7 case and flags the nested fixture; removing the outer substitution lets it through; tests/moat/cases.txt unchanged | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-199 | py-tool identity test covers every guarded _loki_snapshot_py_tool copy under autonomy/ | tests/test-council-py-tool-identity.sh | LOW | bash tests/test-council-py-tool-identity.sh exits 0 and prints the number of copies compared (at least 1 besides run.sh); a one-byte change to completion-council.sh's copy in a scratch tree exits 1 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-200 | BACKLOG 54: done-recognition readers load user-site .pth (-E only) | autonomy/lib/done-recognition.sh (python3 sites plus guarded helper copy), tests/test-done-recognition-no-user-site-pth.sh (new) | HIGH | bash tests/test-done-recognition-no-user-site-pth.sh exits 0 and reverting one site to -E in a scratch copy fails it; bash tests/test-done-recognition-tests-axis.sh and bash tests/test-reuse-done-recognition.sh exit 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-201 | BACKLOG 54: council-v2 readers load .pth; a crashed sycophancy check skips the devil's advocate | autonomy/council-v2.sh (python3 sites, Step 4 and 5 fallbacks, guarded helper copy), tests/test-council-v2-no-user-site-pth.sh (new) | MEDIUM | bash tests/test-council-v2-no-user-site-pth.sh exits 0 (pth leg and detector-failure leg run the devil's advocate on a unanimous approve); reverting either change fails its leg; bash tests/test-council-v2-quorum.sh exits 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-202 | BACKLOG 54: voter-agents readers load user-site .pth (-E only) | autonomy/lib/voter-agents.sh (3 python3 sites plus guarded helper copy), tests/test-voter-agents-no-user-site-pth.sh (new) | HIGH | bash tests/test-voter-agents-no-user-site-pth.sh exits 0 and reverting fails it; bash tests/test-voter-agents-json.sh and bash tests/test-sdk-voter-agents.sh exit 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-203 | BACKLOG 54: proof-check readers load user-site .pth (-E only) | autonomy/lib/proof-check.sh (3 heredoc readers plus guarded helper copy), tests/test-proof-check-no-user-site-pth.sh (new) | MEDIUM | bash tests/test-proof-check-no-user-site-pth.sh exits 0 and reverting fails it; bash tests/test-proven-pr-check.sh exits 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-204 | BACKLOG 53: checklist verification loads user-site .pth (-E only) | autonomy/prd-checklist.sh (python3 sites incl. checklist-verify.py call and oracle heredoc, plus guarded helper copy), tests/test-prd-checklist-no-user-site-pth.sh (new) | HIGH | bash tests/test-prd-checklist-no-user-site-pth.sh exits 0 and reverting fails it; bash tests/moat/p2-honest-verdict.sh prints CASE P2.checklist-verify-not-shadowed PASS; bash tests/test-prd-checklist-interval-w4.sh exits 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-205 | Bun loki proof verify runs a PATH python3 -E (user-site .pth reaches the verdict) | loki-ts/src/commands/proof.ts (verifier spawn only), loki-ts/src/util/python.ts (extend existing helper only if used), loki-ts/tests/commands/proof_verify_interpreter.test.ts (new) | HIGH | cd loki-ts && bun test tests/commands/proof_verify_interpreter.test.ts tests/commands/proof_verify_parity.test.ts exits 0; reverting to python3 -E fails the new test; no resolvable interpreter exits 2 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-206 | BACKLOG 114: cockpit actions say working tree is clean and no run in progress after a failed fetch | web-app/src/cockpit/FinalActions.tsx (disabled reasons only), web-app/src/cockpit/FinalActions.reasons.test.mjs (new) | LOW | node --test web-app/src/cockpit/FinalActions.reasons.test.mjs passes: git null lacks The working tree is clean and Nothing to push, status null lacks No run in progress, real data keeps both; cd web-app && npx tsc -b exits 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-207 | BACKLOG 114: cockpit evidence says No gate results recorded when the checklist request failed | web-app/src/cockpit/useCockpitState.ts (getChecklist via settle only), web-app/src/cockpit/EvidencePanel.tsx (empty branch only), web-app/src/cockpit/ExecutionCockpit.tsx (EvidencePanel props only), web-app/src/cockpit/EvidencePanel.state.test.mjs (new) | LOW | node --test web-app/src/cockpit/EvidencePanel.state.test.mjs passes: an error renders Could not load gate results, items [] keeps No gate results recorded; node web-app/src/cockpit/run-derive-view-test.mjs exits 0; cd web-app && npx tsc -b exits 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-208 | BACKLOG 118: trust trajectory reads any non-pass council verdict as a failure | autonomy/lib/trust_trajectory.py (_verdict_is_pass only), tests/test_trust_trajectory_unknown_verdict.py (new) | MEDIUM | python3 -m pytest -q tests/test_trust_trajectory_unknown_verdict.py tests/test_trust_trajectory.py tests/dashboard/test_trust_trajectory_endpoint.py passes: an unknown verdict adds no data point, REJECTED stays 0.0; reverting fails case 1 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-209 | BACKLOG 99 (Bun): codex, cline and aider get the prompt without the commit-hygiene line | loki-ts/src/runner/providers.ts (codex, cline, aider invokers only), loki-ts/tests/runner/provider_commit_hygiene.test.ts (new), loki-ts/tests/runner/providers.test.ts (argv asserts only if moved) | MEDIUM | cd loki-ts && bun test tests/runner/provider_commit_hygiene.test.ts tests/runner/providers.test.ts exits 0: all three argvs carry the providers/codex.sh literal, claude not double-prefixed; removing the prefix fails the three legs | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-210 | Velocity: help-discoverability (29s) and completion-coverage (30s) probe loops under 10s each | tests/test-help-discoverability.sh, tests/test-completion-coverage.sh (probe loops only) | LOW | time bash tests/test-help-discoverability.sh and time bash tests/test-completion-coverage.sh each exit 0 with real under 10s; real_count and pass counts match the pre-change capture; both timings reported | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-211 | BACKLOG 75: register the four suites no runner executes (Captain, after S-174 merges) | tests/run-all-tests.sh (four run_test lines only, after S-174 merges), tests/shard-durations.tsv (four lines) | LOW | grep -c -e test_managed_completion_flag -e test_managed_review_flag -e test-evidence-gate-no-tests -e test-voter-agents-json tests/run-all-tests.sh prints 8; bash tests/test-shard-coverage.sh exits 0; each suite ran 3 of 3 from a scratch cwd with no .loki/state/provider left | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-212 | GUARDS 5, 12 and 13 still read PENDING after S-138, S-139 and S-154 landed (after S-181 merges) | docs/v10/GUARDS.md (sections 5, 12, 13 only; does not overlap S-181 section 11) | LOW | awk '/^## 12\./,0' docs/v10/GUARDS.md piped to grep -c 'PENDING, no slice cut' prints 0; bash tests/test-no-ambient-gitconfig-writes.sh and bash tests/test-v10-pulse.sh exit 0 | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
| S-213 | BACKLOG 123: cost.html and proofs.html council-vote labels have no test of their own | dashboard-ui/tests/static-council-vote-label.node.test.mjs (new) | LOW | node --test dashboard-ui/tests/static-council-vote-label.node.test.mjs passes (proofs.html council prefix and title, cost.html Council vote header); renaming the header or dropping the title in a scratch copy fails it | ready@2026-09-27T20:12Z | Source: 20:12Z cut. |
