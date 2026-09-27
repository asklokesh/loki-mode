

## 20:59Z cut (S-214..S-233)

**Checked before cutting.** All reads are on main at 04af133a.

**Held dependencies, checked against main.**
- **Merged:**
  - S-180 (22ff5a44)
  - S-179 (94035ac4)
  - S-175 (6fab92ce)
  - S-178 (c8b4c8c0)
  - S-187 (03070f62)
- **Still in flight:** S-194, S-195, S-197, S-198.
- **What that unblocks:**
  - BACKLOG 147: S-180 has merged, and S-198's region (about 1934-1994, fixture about 3301) does not overlap `HELPER_LOCAL_DECL_TMPL` (1182, used about 2186). Cut as S-214.
  - dashboard/server.py items from BACKLOG 118: S-178 has merged. The council-state fallback (8638) and the notifications zero summary (8909) are already handled on main. The skill-session `running_agents: 0` is cut as S-222. The other two are held or dropped (see below).
  - ProjectWorkspace phase labels and Replay Build: S-187 has merged. Cut as S-230.
- **Still held:**
  - BACKLOG 36: waits for S-198.
  - BACKLOG 19 and the bash `loki proof verify` interpreter: wait for S-197.
  - BACKLOG 99, bash half: waits for S-194 and S-195.

**Found shipped on main, but the backlog text still reads open.** Future cuts can skip these:
- 35: tests/test-moat-runner.sh:653
- 37 and 60: loki-ts/src/runner/quality_gates.ts about 565-615
- 72 and 80, the base and start-sha part: run.sh 9888-9895. The warning wording is still open and is cut as S-233.
- 91: run.sh 26343-26345
- 102: run.sh 10951-10955
- 104 and 120: tests/run-all-tests.sh 965-966
- 116, the overview council gate card: loki-overview.js about 395-414
- 118:
  - standalone receipt order and the VERIFIED WITH GAPS colour: build-standalone.js 2517-2531
  - council-state and notifications: server.py 8638, 8909
- 150: S-79
- The memory browser's null lists (loki-memory-browser.js 448-506) and the cockpit's ChangeReview and RiskPanel errors are also handled.

**Dropped on merit.**
- **`/cost` priced at Sonnet rates with no estimate label (BACKLOG 118).**
  - The Sonnet price only applies to a record that is missing `cost_usd`. No Loki writer produces one: run.sh 9121 always writes `model` and `cost_usd` (0 when unmeasured), and no Bun efficiency writer exists.
  - It would close the way S-208 did.
- **Removing T6 from test-sentrux-init-rules.sh as a speed-up.**
  - autonomy/loki has no `.sh` extension, so run-shellcheck.sh's `find` never lints it. T6 is its only lint.
  - S-232 moves that lint rather than deleting it.

**New class found: inline Python that imports from the repo under review.**
- The pattern is `python3 -` or bare `python3 -c` run with the target repo as cwd, which puts `''` first on sys.path.
- The receipt renderer in autonomy/lib/proof-pr.sh has it (it writes the PR description). So do autonomy/verify.sh's readers (`loki verify`).
- A committed `json.py` in the repo would be imported before the stdlib module. This is worse than the `.pth` class that S-200..S-205 close.

**Stale timings.** shard-durations.tsv still lists trust-core at 130s, reachability at 95s and the selector at 45s. Those predate S-135, S-155 and S-136. S-211 owns the tsv, so the Captain refreshes it after S-211 merges.

### S-214: the P7 useMemo arm misses a factory that calls a registered fabricator (BACKLOG 147)
- Files:
  - tests/moat/p7-no-fabricated-data.sh, three regions only:
    - `HELPER_LOCAL_DECL_TMPL` (about 1182) and its use (about 2186);
    - the ceiling comment (about 978-986);
    - one fixture beside the DECL_USEMEMO fixture (about 3138-3160).
- Tier: HIGH (moat)
- Region: this does not overlap S-198's Array.from arm or its fixture at about 3301. Do not append at the file tail.
- Red: `function getRows(d){ return [{ id: 1, user: 'Admin' }]; } const rows = useMemo(() => getRows(d), [d]); setRows(rows);` goes through.
- Green:
  - Add an optional `(?:React\.)?useMemo\(\s*\(\)\s*=>\s*` prefix ahead of the fabricator-call pattern.
  - The comment stops listing this shape as a ceiling.
- Branch: run the widened arm on main first.
  - On any live hit in dashboard-ui or web-app, the slice becomes report-only.
  - Never add an allowlist. cases.txt stays unchanged.
- Wall:
  - `bash tests/moat/p7-no-fabricated-data.sh` prints PASS for every P7 case and flags the composed fixture.
  - Removing the prefix in a scratch copy lets the fixture through.
  - `git diff --stat tests/moat/cases.txt` is empty.

### S-215: the PR receipt renderer imports json from the target repo (cwd shadow)
- Files:
  - autonomy/lib/proof-pr.sh: the `render_evidence_receipt_md` heredoc reader, plus a guarded `_loki_snapshot_py_tool` copy.
  - tests/test-proof-pr-no-cwd-shadow.sh (new)
- Tier: HIGH (the receipt headline in the PR body)
- Red: from a scratch repo that holds a `json.py` whose `load` returns `{"honesty":{"headline":"VERIFIED"}}`, a proof.json whose headline is NOT VERIFIED renders with VERIFIED.
- Green:
  - Run through `_loki_snapshot_py_tool -I -S`.
  - If no interpreter resolves, print "Evidence Receipt: unavailable for this run."
- Gate: reproduce the forged headline on main first. If it does not reproduce, close the slice as handled.
- Wall:
  - `bash tests/test-proof-pr-no-cwd-shadow.sh` exits 0, and reverting to bare `python3 -` in a scratch copy fails it.
  - `bash tests/test-proven-pr-receipt.sh` exits 0.
  - `bash tests/test-council-py-tool-identity.sh` exits 0 and counts one more copy.

### S-216: loki verify's inline readers import from the tree under review (cwd shadow)
- Files:
  - autonomy/verify.sh: the reader sites only (about 190, 591, 1269, 1271, 1295, 1337, 1339, 1441), plus a guarded helper copy.
  - tests/test-verify-no-cwd-shadow.sh (new)
- Tier: HIGH (P2 verdict path)
- Out of scope: the `unittest` and `py_compile` runs (about 730, 921). They run the user's own code on purpose.
- Red: a planted `json.py` in the tree changes a recorded gate. Examples are the npm audit severity count read at about 1295, or the package.json test script read at about 591. The builder names the gate and its before and after status.
- Green:
  - `-I -S` through the helper.
  - With no interpreter, each reader returns what it returns today when python3 is absent. None of them reads as pass.
- Gate: reproduce the changed gate on main first.
- Rule: no moat case, because p2-honest-verdict.sh belongs to S-196 and S-204.
- Wall:
  - `bash tests/test-verify-no-cwd-shadow.sh` exits 0, and reverting one site in a scratch copy fails it.
  - `bash tests/test-verify.sh` exits 0.
  - `bash tests/moat/run.sh` reports no rule failed. `P2.verify-exit-contract` stays pending.
  - `bash tests/test-council-py-tool-identity.sh` exits 0.

### S-217: enforce_test_coverage's package.json readers load user-site .pth (BACKLOG 81)
- Files:
  - autonomy/run.sh: `enforce_test_coverage`, only the `_declared_test_script` and `_ws_script` readers. Anchor on those names.
  - tests/test-enforce-test-coverage-pkg-readers-pth.sh (new)
- Tier: HIGH
- Red: a user-site `.pth` under a scratch HOME empties or changes the read, and that changes the recorded test gate outcome in test-results.json. The builder names both the runner and the pass value.
- Green:
  - Both readers go through `_loki_snapshot_py_tool -I -S`.
  - With no interpreter, the record reads inconclusive, never pass.
- Gate:
  - Reproduce the recorded-outcome change on main first.
  - If the forged read changes nothing that gets recorded, close as handled.
- Test rule: `cd` to scratch before sourcing, and assert that no `.loki/state/provider` is left in the repo.
- Wall:
  - `bash tests/test-enforce-test-coverage-pkg-readers-pth.sh` exits 0, and reverting one reader to `-E` in a scratch copy fails it.
  - `bash tests/test-honest-gate-status.sh` exits 0.

### S-218: the snapshot's git status runs an agent-chosen core.fsmonitor command (BACKLOG 131c)
- Files:
  - autonomy/run.sh: `_loki_untracked_status` only.
  - tests/test-untracked-status-fsmonitor.sh (new)
- Tier: HIGH
- Red: a repo whose `.git/config` sets `core.fsmonitor` to a script that writes a marker gets the marker during `_loki_untracked_status`.
- Green:
  - Add `-c core.fsmonitor=false -c core.untrackedCache=false` to that status call.
  - No marker is written, and a real untracked file is still listed.
- Gate: reproduce the marker on main first.
- Test rules:
  - Use S-138's isolation prelude.
  - Extract the function by name. No full run.sh source.
- Wall:
  - `bash tests/test-untracked-status-fsmonitor.sh` exits 0, and removing the two `-c` flags in a scratch copy fails it.
  - `bash tests/test-no-ambient-gitconfig-writes.sh` and `bash tests/test-branch-lifecycle.sh` exit 0.

### S-219: a failed git add -A makes the session commit silently commit nothing (BACKLOG 83)
- Files:
  - autonomy/run.sh: `commit_session_changes`, the `git add -A` block only.
  - tests/test-session-commit-add-failure.sh (new)
- Tier: MEDIUM
- Red: an embedded git repo with no commits under an un-ignored directory makes `git add -A` fail. The session ends with no commit and no "Left uncommitted" line.
- Green:
  - Keep git's first stderr line.
  - On a non-zero exit, reset the index, `log_warn "Left uncommitted: git add failed (<line>). Review and commit manually."`, and return 0.
  - A successful add is unchanged.
- Gate: reproduce the silent no-commit on main first.
- Test rules: S-138 prelude; scratch cwd; no `.loki/state/provider` left in the repo.
- Wall:
  - `bash tests/test-session-commit-add-failure.sh` exits 0: the warning names the failure, and a normal repo still commits.
  - Removing the rc check in a scratch copy fails leg 1.
  - `bash tests/test-branch-lifecycle.sh` exits 0.

### S-220: the untrack step's global reset drops force-staged agent files from the session commit (BACKLOG 109)
- Files:
  - autonomy/run.sh: `_loki_untrack_agent_committed_user_files` only.
  - tests/test-untrack-keeps-force-staged.sh (new)
- Tier: MEDIUM
- Red: the agent runs `git add -f dist/bundle.js` (an ignored path) and also commits one pre-existing user file. After the untrack step and the session commit, `dist/bundle.js` is in neither commit, and no warning is printed.
- Green:
  - Commit the removal without resetting the whole index. The builder picks the shorter correct form: `git commit --only` on the removed paths, or a temporary `GIT_INDEX_FILE`.
  - Other staged paths stay staged.
- Gate: reproduce the dropped file on main first.
- Size: this may run past 30 minutes.
- Test rules: S-138 prelude; scratch cwd.
- Wall:
  - `bash tests/test-untrack-keeps-force-staged.sh` exits 0: `dist/bundle.js` is in the session commit, and the user file is untracked and still on disk.
  - Restoring `git reset -q` in a scratch copy fails it.
  - `bash tests/test-branch-lifecycle.sh` exits 0.

### S-221: audit.py verify exits 0 when it checked nothing (BACKLOG 123, audit.py half)
- Files:
  - dashboard/audit.py: the `_unified_cli` verify branch and its docstring only.
  - tests/dashboard/test_audit_verify_cli_nothing_checked.py (new)
- Tier: MEDIUM
- Red: `python3 dashboard/audit.py verify <empty dir>` exits 0.
- Green:
  - `files_checked == 0` exits 2 (could not check), and the JSON is unchanged.
  - `tip` and `prefix` are untouched, because src/audit/crosslink.js reads `tip`.
- Wall:
  - `python3 -m pytest -q tests/dashboard/test_audit_verify_cli_nothing_checked.py` covers:
    - empty dir: 2;
    - valid chain: 0;
    - tampered chain: 1;
    - `tip` on an empty dir: still 0.
  - `bash tests/test-audit-chain-honesty.sh` and `bash tests/test-audit-js-suites.sh` exit 0.

### S-222: the skill-session WebSocket status push hardcodes running_agents 0 (BACKLOG 118)
- Files:
  - dashboard/server.py: the skill-session broadcast payload only (about 1030-1047).
  - tests/dashboard/test_skill_session_ws_running_agents.py (new)
- Tier: LOW
- Red: with no dashboard-state.json and a fresh session.json, the pushed payload carries `running_agents: 0`.
- Green:
  - Send `running_agents: None` (unmeasured).
  - The clients already read null: loki-overview.js 212, loki-session-control.js 152, and web-app StatusOverview.
- Gate: drive the branch on main first.
  - If the loop cannot be driven in-process, lift the payload into one function and test that.
  - If the branch is unreachable, close as handled.
- Wall:
  - `python3 -m pytest -q tests/dashboard/test_skill_session_ws_running_agents.py` shows running_agents None.
  - Restoring 0 fails it.

### S-223: notification triggers read "No triggers configured" after a failed read (BACKLOG 114 and 118)
- Files:
  - dashboard/server.py: `get_notification_triggers` only.
  - dashboard-ui/components/loki-notification-center.js: `_loadTriggers` and the triggers empty branch only.
  - tests/dashboard/test_notification_triggers_unreadable.py (new)
  - dashboard-ui/tests/loki-notification-triggers-error.node.test.mjs (new)
- Tier: LOW
- Red:
  - A corrupt triggers.json answers `{"triggers": []}`.
  - A failed fetch keeps `[]`, so the panel says "No triggers configured".
- Green:
  - The server answers `{"triggers": null, "error": "unreadable_triggers"}`, the same shape as `read_active_notifications`.
  - The panel renders "Could not load triggers" and offers no toggles.
  - A missing file still answers `[]`.
- Wall:
  - `python3 -m pytest -q tests/dashboard/test_notification_triggers_unreadable.py` passes.
  - `node --test dashboard-ui/tests/loki-notification-triggers-error.node.test.mjs` passes: an error lacks "No triggers configured", and an empty list keeps it.

### S-224: the web-app receipt and cost trend show a partly priced run as a complete cost (BACKLOG 118)
- Files:
  - web-app/src/components/EvidenceReceiptPanel.tsx (the Cost field only)
  - web-app/src/api/client.ts (the ProofDetail `cost` type and the cost/timeline `runs` type only)
  - web-app/src/pages/MetricsPage.tsx (`costTrend` only)
  - web-app/src/components/EvidenceReceiptPanel.cost.test.mjs (new)
- Tier: MEDIUM
- Red: a detail with `cost: {usd: 1.2, cost_partial: true}` renders "$1.20".
- Green:
  - The receipt renders "at least $1.20", matching cost.html and proofs.html after S-158.
  - A partial run's trend label carries "(partial)".
  - `cost_partial` absent or false keeps today's text.
- Wall:
  - `node --test web-app/src/components/EvidenceReceiptPanel.cost.test.mjs` passes.
  - `cd web-app && npx tsc -b` exits 0.

### S-225: the standalone receipts list shows a partly priced run as a complete cost (BACKLOG 118)
- Files:
  - dashboard-ui/scripts/build-standalone.js (the `loadReceipts` cost cell only)
  - tests/test-receipts-panel.sh (one new leg)
- Tier: LOW
- Green:
  - `cost_partial === true` renders "at least $X.XX".
  - Anything else keeps today's text.
- Wall:
  - `bash tests/test-receipts-panel.sh` exits 0, and the new leg asserts the "at least" prefix only when `cost_partial` is true.
  - `bash tests/test-budget-banner-dedup.sh` exits 0.

### S-226: loki stats reads unmeasured cost as $0.00 on both routes (BACKLOG 106 class)
- Files:
  - autonomy/loki (`cmd_stats` only)
  - loki-ts/src/commands/stats.ts
  - loki-ts/tests/commands/stats_unmeasured.test.ts (new)
  - tests/test-stats-unmeasured-cost.sh (new)
- Tier: MEDIUM
- Red: efficiency records where every cost and token field is 0 print "Estimated cost: $0.00", and the JSON has `tokens.cost_usd: 0.0`.
- Green:
  - A record counts when `efficiency_cost.record_is_measured` (bash) or kpis.ts `recordsMeasured` (Bun) holds.
  - If none counts, the JSON sends `cost_usd: null` and the text says "not recorded".
  - Budget used follows `cmd_cost`'s rule: a positive recorded `budget_used`, else the measured current cost, else null.
  - Both routes produce identical output.
- Size: this may run past 30 minutes.
- Wall:
  - `bash tests/test-stats-unmeasured-cost.sh` exits 0.
  - `cd loki-ts && bun test tests/commands/stats.test.ts tests/commands/stats_unmeasured.test.ts` exits 0.
  - `bash tests/test-bash-bun-parity.sh` exits 0.

### S-227: loki status prints Budget $0 for a run it never measured, on both routes (BACKLOG 106 class)
- Files:
  - autonomy/loki (the `cmd_status` budget block only)
  - loki-ts/src/commands/status.ts (`readBudgetField` and its budget caller only)
  - loki-ts/tests/commands/status.test.ts (budget legs only)
  - tests/test-status-budget-unmeasured.sh (new)
- Tier: MEDIUM
- Red: `"budget_used": 0` (what `check_budget_limit` writes when unmeasured), null, or a missing key prints "Budget: $0 / $10" on bash and "0" on Bun.
- Green:
  - Only a positive recorded `budget_used` is a reading, the same rule as `cmd_cost`.
  - Otherwise print "Budget: not recorded / $10" (or "Cost: not recorded (no limit)") and skip the gauge.
  - Both routes produce identical output.
- Wall:
  - `bash tests/test-status-budget-unmeasured.sh` exits 0.
  - `cd loki-ts && bun test tests/commands/status.test.ts` exits 0.
  - `bash tests/test-status-cli-provider-parity.sh` exits 0.

### S-228: DeployConnections pushes default "not connected" states upward after its own fetch failed (BACKLOG 121)
- Files:
  - web-app/src/components/DeployConnections.tsx (the connect and disconnect handlers only)
  - web-app/src/components/DeployConnections.propagate.test.mjs (new)
- Tier: LOW
- Red: the first fetch fails, then connecting Vercel calls `onStatusChange` with netlify and github `{connected:false}` built from the default state.
- Green: when the last fetch failed, the handlers re-fetch instead of pushing synthesized defaults.
- Wall:
  - `node --test web-app/src/components/DeployConnections.propagate.test.mjs` passes.
  - `node --test web-app/src/components/DeployConnections.state.test.mjs` passes.
  - `cd web-app && npx tsc -b` exits 0.

### S-229: the preview header says "Detecting project type..." forever after a failed preview-info fetch (BACKLOG 114)
- Files:
  - web-app/src/components/ProjectWorkspace.tsx, preview regions only: the `getPreviewInfo` call (about 839) and the "Detecting project type..." branch (about 1877).
  - web-app/src/components/ProjectWorkspace.preview.test.mjs (new)
- Tier: LOW
- Green:
  - Keep the error.
  - Render "Could not detect project type" with the message.
  - A pending request keeps "Detecting project type...".
- Wall:
  - `node --test web-app/src/components/ProjectWorkspace.preview.test.mjs` passes: a rejected fetch lacks "Detecting project type...".
  - `node --test web-app/src/components/ProjectWorkspace.panels.test.mjs` passes.
  - `cd web-app && npx tsc -b` exits 0.

### S-230: ProjectWorkspace labels unknown phases "building", and Replay Build can never appear (BACKLOG 115 and 118)
- Files:
  - web-app/src/components/ProjectWorkspace.tsx, only the `buildPhase` memo (about 1401-1410) and the Replay Build condition (about 1488).
  - web-app/src/components/ProjectWorkspace.phase.test.mjs (new)
- Tier: LOW
- Region: this does not overlap S-229's preview regions.
- Green:
  - The builder lists the phase strings run.sh and the Bun runner actually write.
  - Map REASON, ACT, REFLECT and VERIFY explicitly. Any other phase returns 'unknown'.
  - Replay Build shows when `!isBuilding` and `sessionData.status` is completed or completion_promise_fulfilled, the same test as about 1431.
- Wall:
  - `node --test web-app/src/components/ProjectWorkspace.phase.test.mjs` passes:
    - an unrecognized phase is not 'building';
    - a completed idle session shows Replay Build.
  - `cd web-app && npx tsc -b` exits 0.

### S-231: the "Moat suite" CI check reads as moat proven at 0 of 9 (BACKLOG 52)
- Files: .github/workflows/test.yml (the moat-suite job `name:` only)
- Tier: LOW
- Green:
  - Rename the job to "Moat ratchet (no rule failed)".
  - The step summary keeps its N of 9 count.
- Gate:
  - First run `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks --jq .contexts`.
  - If "Moat suite" is a required context, the slice becomes report-only, because renaming it would block every merge.
- Wall:
  - `git grep -n "name: Moat suite" -- .github` prints nothing.
  - `git grep -n "Moat suite" -- tests scripts .github` lists only the step-summary heading.
  - The first push after merge shows the renamed check green.

### S-232: autonomy/loki is linted only inside the sentrux test; the lint suite never schedules its big files first
- Files:
  - tests/run-shellcheck.sh
  - tests/test-sentrux-init-rules.sh (T6 only)
- Tier: LOW (velocity plus lint placement)
- Change:
  - (a) Add ./autonomy/loki to run-shellcheck.sh at `-S error`, today's bar. Delete T6.
  - (b) Order the file list largest first, so run.sh and loki do not start last.
- Gate: capture the counts and real time before changing anything. Run back to back with a fixed `LOKI_SHELLCHECK_JOBS=4`.
  - If (b) gains under 15%, keep only (a).
- Wall:
  - `LOKI_SHELLCHECK_JOBS=4 bash tests/run-shellcheck.sh` exits 0. Its output includes "Checked ./autonomy/loki". The pass, fail and info counts equal the pre-change capture, with loki added.
  - `time bash tests/test-sentrux-init-rules.sh` exits 0 with "8 passed" and real time under 10s.
  - `grep -c shellcheck tests/test-sentrux-init-rules.sh` prints 0.
  - The builder reports both timings.

### S-233: a refused resume says nothing about which file blocked it or where the earlier commits are (BACKLOG 72 remainder)
- Files:
  - autonomy/run.sh: the `setup_agent_branch` resume block only, around the `--no-overwrite-ignore` checkout.
  - tests/test-refused-resume-warning.sh (new)
- Tier: LOW
- Red: a gitignored user file at a path the recorded branch tracks gets "could not be checked out - creating a new one", and nothing else.
- Green:
  - The warning names the conflicting path or paths from git's stderr.
  - It states that the earlier session's commits are still on `${recorded}`.
- Test rules: S-138 prelude; scratch cwd; no `.loki/state/provider` left in the repo.
- Wall:
  - `bash tests/test-refused-resume-warning.sh` exits 0, and the warning contains the file name and the branch name.
  - `bash tests/test-branch-lifecycle.sh` exits 0.

**Registration and rebuilds (Captain).** S-211 owns tests/run-all-tests.sh and tests/shard-durations.tsv, so no slice edits them.
- **New tests to register, after S-211 merges:**
  - S-215: tests/test-proof-pr-no-cwd-shadow.sh
  - S-216: tests/test-verify-no-cwd-shadow.sh
  - S-217: tests/test-enforce-test-coverage-pkg-readers-pth.sh
  - S-218: tests/test-untracked-status-fsmonitor.sh
  - S-219: tests/test-session-commit-add-failure.sh
  - S-220: tests/test-untrack-keeps-force-staged.sh
  - S-221: tests/dashboard/test_audit_verify_cli_nothing_checked.py
  - S-222: tests/dashboard/test_skill_session_ws_running_agents.py
  - S-223: tests/dashboard/test_notification_triggers_unreadable.py and dashboard-ui/tests/loki-notification-triggers-error.node.test.mjs
  - S-224: web-app/src/components/EvidenceReceiptPanel.cost.test.mjs
  - S-226: tests/test-stats-unmeasured-cost.sh and loki-ts/tests/commands/stats_unmeasured.test.ts
  - S-227: tests/test-status-budget-unmeasured.sh
  - S-228: DeployConnections.propagate.test.mjs
  - S-229: ProjectWorkspace.preview.test.mjs
  - S-230: ProjectWorkspace.phase.test.mjs
  - S-233: tests/test-refused-resume-warning.sh
- **Bundle rebuilds:**
  - loki-ts/dist: S-226, S-227.
  - web-app/dist: S-224, S-228, S-229, S-230.
  - dashboard static: S-225.
  - dashboard-ui dist and dashboard static: S-223.
- **Merge order:**
  - run.sh: S-217, S-218, S-219, S-220 and S-233, plus S-194 and S-195 in flight. They name regions that do not overlap, anchor on function names, and merge one at a time.
  - autonomy/loki: S-226 and S-227, plus S-197 in flight, one at a time.
  - dashboard/server.py: S-222 and S-223.
  - ProjectWorkspace.tsx: S-229 and S-230.
  - S-215 and S-216 add guarded helper copies. S-199's identity test picks them up with no edit.
- **Test rules for the git-touching slices** (S-218, S-219, S-220, S-233): each uses S-138's isolation prelude, and `bash tests/test-no-ambient-gitconfig-writes.sh` must stay green.

**Held, not in the 20:**
- BACKLOG 36: waits for S-198.
- BACKLOG 19 and the bash `loki proof verify` interpreter: wait for S-197 (S-179 is merged, 94035ac4).
- BACKLOG 99, bash half: waits for S-194 and S-195 (S-175 is merged, 6fab92ce).
- `StatusResponse` defaults (iteration 0, provider "claude"): changing the types touches every /api/status consumer, so this needs a design.
- BACKLOG 100 (the untrack step in the interrupt path): git commits from a signal handler need a design.
- workspace_diff count 0 in a non-git directory: needs a design.
- Speeding up test-autocapture-shadow-write-guard.sh: needs a design.
- `P4.three-setups-resolve`: waits on the D10 default decision.
- BACKLOG 18: default-off decision for the founder.
- BACKLOG 28: needs per-case expected failure reasons; design.
- BACKLOG 121, the settings half: product decision.
- `P1.verification-metadata-signed`: M2 seal.v1.
- The P2 verify renumber (CEO); S-112, S-114, S-115, S-117 to S-122.

| S-214 | BACKLOG 147: P7 useMemo arm misses a factory that calls a registered fabricator | tests/moat/p7-no-fabricated-data.sh (HELPER_LOCAL_DECL_TMPL ~1182 and its use ~2186, ceiling comment ~978-986, one fixture beside the DECL_USEMEMO fixture ~3138-3160 only; does not overlap S-198) | HIGH | bash tests/moat/p7-no-fabricated-data.sh prints PASS for every P7 case and flags the composed useMemo fixture; removing the useMemo prefix in a scratch copy lets it through; git diff --stat tests/moat/cases.txt is empty | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-215 | PR receipt renderer in proof-pr.sh imports json from the target repo (cwd shadow) | autonomy/lib/proof-pr.sh (render_evidence_receipt_md heredoc reader plus guarded _loki_snapshot_py_tool copy), tests/test-proof-pr-no-cwd-shadow.sh (new) | HIGH | bash tests/test-proof-pr-no-cwd-shadow.sh exits 0 (a planted json.py cannot forge the headline) and reverting to bare python3 - in a scratch copy fails it; bash tests/test-proven-pr-receipt.sh exits 0; bash tests/test-council-py-tool-identity.sh exits 0 and counts one more copy | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-216 | loki verify inline readers import from the tree under review (cwd shadow) | autonomy/verify.sh (reader sites ~190, 591, 1269, 1271, 1295, 1337, 1339, 1441 plus guarded helper copy; not the unittest or py_compile runs), tests/test-verify-no-cwd-shadow.sh (new) | HIGH | bash tests/test-verify-no-cwd-shadow.sh exits 0 and reverting one site in a scratch copy fails it; bash tests/test-verify.sh exits 0; bash tests/moat/run.sh reports no rule failed; bash tests/test-council-py-tool-identity.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-217 | BACKLOG 81: enforce_test_coverage package.json readers load user-site .pth | autonomy/run.sh (enforce_test_coverage _declared_test_script and _ws_script readers only; anchor on names), tests/test-enforce-test-coverage-pkg-readers-pth.sh (new) | HIGH | bash tests/test-enforce-test-coverage-pkg-readers-pth.sh exits 0 (a .pth no longer changes the recorded test gate outcome) and reverting one reader to -E in a scratch copy fails it; no .loki/state/provider left in the repo; bash tests/test-honest-gate-status.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-218 | BACKLOG 131c: snapshot git status runs an agent-chosen core.fsmonitor command | autonomy/run.sh (_loki_untracked_status only), tests/test-untracked-status-fsmonitor.sh (new) | HIGH | bash tests/test-untracked-status-fsmonitor.sh exits 0 (no fsmonitor marker, real untracked file still listed) and removing the two -c flags in a scratch copy fails it; bash tests/test-no-ambient-gitconfig-writes.sh and bash tests/test-branch-lifecycle.sh exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-219 | BACKLOG 83: a failed git add -A makes the session commit silently commit nothing | autonomy/run.sh (commit_session_changes git add -A block only), tests/test-session-commit-add-failure.sh (new) | MEDIUM | bash tests/test-session-commit-add-failure.sh exits 0: an empty embedded repo prints Left uncommitted naming the add failure, a normal repo still commits; removing the rc check in a scratch copy fails leg 1; bash tests/test-branch-lifecycle.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-220 | BACKLOG 109: untrack step's global reset drops force-staged agent files from the session commit | autonomy/run.sh (_loki_untrack_agent_committed_user_files only), tests/test-untrack-keeps-force-staged.sh (new) | MEDIUM | bash tests/test-untrack-keeps-force-staged.sh exits 0: git add -f dist/bundle.js lands in the session commit while the pre-existing user file stays untracked on disk; restoring git reset -q in a scratch copy fails it; bash tests/test-branch-lifecycle.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-221 | BACKLOG 123: audit.py verify exits 0 when it checked nothing | dashboard/audit.py (_unified_cli verify branch and docstring only; tip and prefix untouched), tests/dashboard/test_audit_verify_cli_nothing_checked.py (new) | MEDIUM | python3 -m pytest -q tests/dashboard/test_audit_verify_cli_nothing_checked.py: empty dir exits 2, valid chain 0, tampered 1, tip on an empty dir still 0; bash tests/test-audit-chain-honesty.sh and bash tests/test-audit-js-suites.sh exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-222 | BACKLOG 118: skill-session WebSocket status push hardcodes running_agents 0 | dashboard/server.py (skill-session broadcast payload ~1030-1047 only), tests/dashboard/test_skill_session_ws_running_agents.py (new) | LOW | python3 -m pytest -q tests/dashboard/test_skill_session_ws_running_agents.py shows running_agents None on the skill-session push; restoring 0 fails it | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-223 | BACKLOG 114/118: notification triggers read No triggers configured after a failed read | dashboard/server.py (get_notification_triggers only), dashboard-ui/components/loki-notification-center.js (_loadTriggers and triggers empty branch only), tests/dashboard/test_notification_triggers_unreadable.py (new), dashboard-ui/tests/loki-notification-triggers-error.node.test.mjs (new) | LOW | python3 -m pytest -q tests/dashboard/test_notification_triggers_unreadable.py shows triggers null with error on a corrupt file and [] on a missing one; node --test dashboard-ui/tests/loki-notification-triggers-error.node.test.mjs shows an error lacks No triggers configured and an empty list keeps it | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-224 | BACKLOG 118: web-app receipt and cost trend show a partly priced run as a complete cost | web-app/src/components/EvidenceReceiptPanel.tsx (Cost field only), web-app/src/api/client.ts (ProofDetail cost type and cost/timeline runs type only), web-app/src/pages/MetricsPage.tsx (costTrend only), web-app/src/components/EvidenceReceiptPanel.cost.test.mjs (new) | MEDIUM | node --test web-app/src/components/EvidenceReceiptPanel.cost.test.mjs: cost_partial true renders at least $1.20, absent keeps $1.20, a partial run's trend label carries (partial); cd web-app && npx tsc -b exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-225 | BACKLOG 118: standalone receipts list shows a partly priced run as a complete cost | dashboard-ui/scripts/build-standalone.js (loadReceipts cost cell only), tests/test-receipts-panel.sh (one new leg) | LOW | bash tests/test-receipts-panel.sh exits 0 with the new leg asserting at least $X.XX only when cost_partial is true; bash tests/test-budget-banner-dedup.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-226 | BACKLOG 106 class: loki stats reads unmeasured cost as $0.00 on both routes | autonomy/loki (cmd_stats only), loki-ts/src/commands/stats.ts, loki-ts/tests/commands/stats_unmeasured.test.ts (new), tests/test-stats-unmeasured-cost.sh (new) | MEDIUM | bash tests/test-stats-unmeasured-cost.sh exits 0 (all-zero records give cost_usd null and not recorded, same on both routes); cd loki-ts && bun test tests/commands/stats.test.ts tests/commands/stats_unmeasured.test.ts exits 0; bash tests/test-bash-bun-parity.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-227 | BACKLOG 106 class: loki status prints Budget $0 for a run it never measured, on both routes | autonomy/loki (cmd_status budget block only), loki-ts/src/commands/status.ts (readBudgetField and its budget caller only), loki-ts/tests/commands/status.test.ts (budget legs only), tests/test-status-budget-unmeasured.sh (new) | MEDIUM | bash tests/test-status-budget-unmeasured.sh exits 0 (budget_used 0, null or absent prints not recorded on both routes, a positive value prints as today); cd loki-ts && bun test tests/commands/status.test.ts exits 0; bash tests/test-status-cli-provider-parity.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-228 | BACKLOG 121: DeployConnections pushes default not-connected states upward after its own fetch failed | web-app/src/components/DeployConnections.tsx (connect and disconnect handlers only), web-app/src/components/DeployConnections.propagate.test.mjs (new) | LOW | node --test web-app/src/components/DeployConnections.propagate.test.mjs shows no synthesized statuses reach onStatusChange after a failed fetch; node --test web-app/src/components/DeployConnections.state.test.mjs and cd web-app && npx tsc -b exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-229 | BACKLOG 114: preview header says Detecting project type forever after a failed preview-info fetch | web-app/src/components/ProjectWorkspace.tsx (getPreviewInfo call ~839 and Detecting project type branch ~1877 only), web-app/src/components/ProjectWorkspace.preview.test.mjs (new) | LOW | node --test web-app/src/components/ProjectWorkspace.preview.test.mjs shows a rejected fetch renders Could not detect project type and lacks Detecting project type; node --test web-app/src/components/ProjectWorkspace.panels.test.mjs and cd web-app && npx tsc -b exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-230 | BACKLOG 115/118: ProjectWorkspace labels unknown phases building and Replay Build can never appear | web-app/src/components/ProjectWorkspace.tsx (buildPhase memo ~1401-1410 and Replay Build condition ~1488 only; does not overlap S-229), web-app/src/components/ProjectWorkspace.phase.test.mjs (new) | LOW | node --test web-app/src/components/ProjectWorkspace.phase.test.mjs shows an unrecognized phase is not building and a completed idle session shows Replay Build; cd web-app && npx tsc -b exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-231 | BACKLOG 52: the Moat suite CI check reads as moat proven at 0 of 9 | .github/workflows/test.yml (moat-suite job name only) | LOW | gh api required_status_checks for main does not list Moat suite (else report-only); git grep -n "name: Moat suite" -- .github prints nothing; git grep -n "Moat suite" -- tests scripts .github lists only the step-summary heading; the next push shows the renamed check | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-232 | autonomy/loki is linted only inside the sentrux test; the lint suite schedules big files last | tests/run-shellcheck.sh, tests/test-sentrux-init-rules.sh (T6 only) | LOW | LOKI_SHELLCHECK_JOBS=4 bash tests/run-shellcheck.sh exits 0, prints Checked ./autonomy/loki, counts match the pre-change capture plus loki; time bash tests/test-sentrux-init-rules.sh exits 0 with 8 passed under 10s; grep -c shellcheck tests/test-sentrux-init-rules.sh prints 0; both timings reported | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-233 | BACKLOG 72 remainder: refused resume does not name the blocking file or where the earlier commits are | autonomy/run.sh (setup_agent_branch resume block around the no-overwrite-ignore checkout only), tests/test-refused-resume-warning.sh (new) | LOW | bash tests/test-refused-resume-warning.sh exits 0 with the warning naming the conflicting ignored file and the recorded branch; bash tests/test-branch-lifecycle.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
