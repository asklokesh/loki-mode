# RARV-C 100x Native-Primitives Upgrade - Plan (v8.0.0 arc)

## Context

Founder mandate (memory `project-rarvc-cookbook-upgrade`): we can't out-build
Replit/Emergent/Cognition on capability. Loki's moat is loop RIGOR (never-fake-green
RARV-C, 3-reviewer council, evidence gate), which is ON-THESIS with Anthropic's own
long-running-agent guidance. The gap isn't rigor; it's efficiency: the loop does its
mechanics via home-grown bash (parsing model output as TEXT, polling for budget,
inferring cost from token math) where the installed `claude` CLI now ships NATIVE
primitives that do the same job cheaper, faster, and without fragile parsing.

This plan adopts those primitives where they MEASURABLY beat the bash equivalents, one
per commit, bench-proven, quality never regresses. MAJOR arc (v8.0.0) on branch
`feature/rarv-c-100x-primitives` (not yet created).

**The honest headline: much of this is already shipped.** Two prior plan docs exist
(`docs/RARV-C-LOOP-EFFICIENCY-PLAN.md`, `docs/RARV-C-CHANGE-MAP.md`, grounded to v7.121.5),
AND the engine has since adopted several native flags. So this plan does NOT regenerate
them. It: (1) reconciles drift to v7.128.2, (2) records what's ALREADY adopted so we don't
rebuild it, (3) scopes the genuinely net-new work (extend structured-outputs to 4 remaining
text-parse sites), (4) adds the missing PARITY and RELEASE sections, and consolidates into
`docs/RARV-C-100X-PLAN.md`.

---

## Primary-source verification (done live this session, CLI v2.1.207)

Per `reference-claude-session-flags` ("live-probe, don't trust stale training or --help
alone"), every flag was verified by RUNNING it:

| Primitive | Flag | Verified behavior (2026-07-13) |
|---|---|---|
| Structured output | `--json-schema <schema>` | Forces valid JSON. Envelope carries top-level `structured_output` key + `result` valid-JSON + `stop_reason:"tool_use"`. Model CANNOT emit malformed output. |
| Cost breaker | `--max-budget-usd <amt>` | On exceed: `subtype:"error_max_budget_usd"`, `is_error:true`, exit 0 (graceful, parseable). |
| Effort dial | `--effort low\|medium\|high\|xhigh\|max` | 5 levels; maps onto `get_rarv_tier()`. |
| Rate-limit resilience | `--fallback-model <model>` | Present. |
| Caching visibility | JSON envelope | `usage.cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m` per call -> caching measurable. |
| Cost/iter readout | JSON envelope | `total_cost_usd`, per-model `costUSD`, `cache_read_input_tokens`, `iterations[]`. |
| Continuity | `--resume`/`--session-id`/`--fork-session` | iter0 `--session-id U0`, iterN `--resume U0`; `--session-id` reuse ERRORS. |

---

## What is ALREADY adopted (do NOT rebuild - ponytail rung 2)

Verified in current source. The prior CHANGE-MAP predates these:

- **`--effort` + `--max-budget-usd` are ALREADY plumbed** in `_loki_build_claude_auto_flags`
  (`providers/claude.sh:143-158`), gated on `loki_claude_flag_supported` (degrades on old CLI),
  mirrored in `loki-ts/src/providers/claude_flags.ts` (`effortForTier()`:23, `buildAutoFlags()`:150).
  So "adopt native budget/effort breakers" is LARGELY DONE. `check_budget_limit()` (`run.sh:13035`)
  and `is_rate_limited()` (`run.sh:12835`) still exist as the belt to the native suspenders.
- **`--json-schema` is ALREADY adopted for the council-vote path**: `voter-agents.sh:277`
  (`claude --agents <json> --json-schema <schema>`), wired as PREFERRED council dispatch at
  `completion-council.sh:3137-3144` with graceful text-parse fallback (3146-3154). Schema:
  `loki-ts/data/finding-schema.json`. TS mirror: `loki-ts/src/council/voter_agents.ts:299-327`.
  This pair is the TEMPLATE to extend, not a greenfield build.
- **Completion detection is already structured** via `.loki/signals/*` + `loki_complete_task`
  MCP tool (`run.sh:13351-13369`); text-match is legacy behind `LOKI_LEGACY_COMPLETION_MATCH=true`.

**Net-new structured-output work = extend the voter-agents+schema template to the 4 remaining
text-parse sites. Everything else is tuning + bench + pointing side-calls at flags that exist.**

---

## Reconciled anchors (v7.128.2; lines drift, re-grep before editing)

**completion-council.sh:** `_council_effective_min_iter()`:118 | `COUNCIL_CHECK_INTERVAL`:84 |
`COUNCIL_STAGNATION_LIMIT`:132 | `council_evidence_gate()`:1704 | explicit-claim fast path:3640
(block 3625-3648) | modulo gate now in helper `_council_should_check_now()`:3521-3560 (gate:3548),
called from `council_should_stop`:3644 | `council_should_stop()`:3562

**run.sh:** `detect_complexity()`:2491 | `get_rarv_tier()`:2616 | `run_code_review()`:11095 |
`is_rate_limited()`:12835 | `check_budget_limit()`:13035 | `store_episode_trace()`:13729 |
`save_state()`:14395 | `build_prompt()`:14633 | `run_autonomous()`:16299 | `LOKI_SESSION_MODEL`
default:742, session-pin read:16959, case block:16963-16967 | `[CACHE_BREAKPOINT]` INERT (doc anchor
only, no cache wiring):15143/15231/15278 | APP_CRASHED injection:14969 (python3 -c inline)

**Main-loop invocation:** `run.sh:17316-17320` -> `claude "${_loki_claude_argv[@]}" -p "$prompt"
--output-format stream-json --verbose` (argv ~17226+). Uses stream-json, not --json-schema.
Model catalog: opus->claude-opus-4-8, sonnet->claude-sonnet-5, haiku->claude-haiku-4-5; defaults
planning/development/fast ALL=sonnet (v7.104.0).

### The 4 remaining text-parse sites (the genuine structured-output targets)
1. **Code-review verdict** `run.sh:11044-11063` `_classify_verdict` (regex `grep -iE "VERDICT:"`
   -> case FAIL/PASS/AMBIGUOUS, no retry) + severity greps :11075/:11090; reviewer call :10998
   uses `--output-format text`. Parity-locked to `loki-ts/src/runner/quality_gates.ts`.
2. **Council VOTE fallback** `completion-council.sh:645-659` (`grep -oE VOTE:`) + `:1005` (Python
   `re.search`) - the fallback under the already-structured path; mangled VOTE silently->REJECT.
3. **Council-v2 JSON** `council-v2.sh:337-346` (`sed -n '/^{/,/^}/p'` carves JSON from prose, else
   hardcodes REJECT); invocation :299 (no schema).
4. **Done-recognition** `done-recognition.sh:282-303` (`json.loads` + brace-substring fallback,
   else `inconclusive`); call :57/:171 (no schema).

---

## Deliverable 1: Bench harness (BUILD/LOCK THIS FIRST - nothing ships before it)

Reuse `benchmarks/bench/` (~95% built per existing plan S2a). The work is lock + reconcile +
baseline, not a build:
- **Lock a discriminator-derived corpus** (existing plan 2e-HARDENING #3): simple + HARD (tier-guard)
  + MULTI-FAILURE (parallel-fix) + TOKEN-HEAVY (distillation), each with machine-checkable held-out
  acceptance. Frozen once baselined.
- **Reconcile iterations source** to `events.jsonl` `iteration_complete` count (canonical) with
  session.json fallback, so `adapters/loki.py` and `speed-benchmark.sh` agree. PREREQUISITE, blocking.
- **NEW (from live probe):** read cost/cache/iterations straight from the `--json-schema`/`--output-format
  json` envelope (`total_cost_usd`, `cache_read_input_tokens`, `iterations[]`) instead of token-math x
  price-table where available - more accurate, self-consistent with the CLI.
- **Noise floor** (blocking): baseline reports SPREAD (std/min-max across trials); a change ships only
  if its metric moves BEYOND the noise band. Effect < trial variance -> "no measurable effect", don't ship.
- **2-spec smoke check** (the one runnable guard): one MUST-pass, one underspecified MUST-fail; assert
  `verified_pass == [True, False]`. If the grader can't tell them apart it measures nothing.
- **Commit the v7.128.2 baseline** (`benchmarks/results/<baseline>.json`, N real OFF-WORKTREE builds,
  isolated source copy, cwd + LOKI_TARGET_DIR pinned to scratch) BEFORE any change.
- **Grader stays deterministic** `success = exit==0` on held-out acceptance. NEVER council/completion-claim.
  `validate_adapter_output()` already rejects self-judged keys - keep that invariant.

**Gate rule (binding, every change):** ships iff it improves >=1 of {iterations, $/build, wall-clock}
beyond the noise band AND does not regress verified-pass-rate on the frozen corpus vs baseline.

---

## Deliverable 2: Primitive-by-primitive adoption table (ranked, one per commit)

Bucket key: **(a)** orchestration/flags, changeable now | **(b)** founder-gated (build_prompt
byte-lock) | **(c)** needs off-worktree real-build validation.

| # | Primitive / change | Current impl (file:line) | Native replacement | Expected win | Bucket | Parity | Rollback |
|---|---|---|---|---|---|---|---|
| 1 | **Structured code-review verdict** | `run.sh:11044` regex `_classify_verdict` + severity greps :11075/:11090; reviewer :10998 `--output-format text` | reviewer emits `--json-schema` (extend `voter-agents.sh`+`finding-schema.json` template); read `structured_output.verdict/severity` | Kills fragile parse + AMBIGUOUS-token bugs; zero retry. Quality-safety, not speed | (a) | safe (invocation flag, NOT build_prompt); MUST mirror in `quality_gates.ts` | keep text fallback path (like council does 3146-3154) |
| 2 | **Structured council VOTE** (retire text fallback) | `completion-council.sh:645/1005` regex/re.search fallback | make the already-wired `--json-schema` path (3137) the only path; delete text fallback once proven | Removes silent VOTE->REJECT corruption (:2337) | (a) | safe; TS mirror `voter_agents.ts` | revert to fallback |
| 3 | **Structured council-v2** | `council-v2.sh:337-346` sed-carved JSON | add `--json-schema` + `--output-format json` to :299 | Removes "prose around JSON"->hardcoded REJECT | (a) | safe | hardcoded-REJECT fallback stays |
| 4 | **Structured done-recognition** | `done-recognition.sh:282-303` json.loads+brace-slice | add `--json-schema` to :57/:171 | Removes unparsable->inconclusive | (a) | safe | inconclusive fallback stays |
| 5 | **Council interval sweep** (existing CHANGE-MAP #1) | `completion-council.sh:84` interval=5 | tune 2-3 for simple tier | fewer idle iters -> $/wall-clock | (a) | n/a | env default |
| 6 | **Complexity->tier routing** (existing #3) | `run.sh:742` flat sonnet; case :16963 | `auto` arm: simple->haiku-enable, complex->opus-pin | $/build on simple majority | (c) | 3 readers + hard-guard | revert to `sonnet` |
| 7 | **Native budget/effort tighten** | ALREADY plumbed `claude.sh:143-158`; side-calls (:10998, council-v2:299, done-rec:57) still bare | point side-calls at `--max-budget-usd`/`--effort` too | consistent native breaker everywhere | (a) | mirror bash<->TS flags | drop flag |
| 8 | **Prompt caching** (existing #7, CONTINGENT) | `[CACHE_BREAKPOINT]` INERT `run.sh:15143` | wire real `cache_control` on static prefix IF CLI folds it across per-iter processes | $/build on multi-iter (cache reads visible in envelope) | (b)-adjacent | verify CLI first; may be no-op | remove marker wiring |
| 9 | **Self-heal from logs** (existing #4) | APP_CRASHED count only `run.sh:14969`; LAST_ERROR write-only | route `tail+grep` error signature into prompt | pass-rate on crashing specs | (c) | build_prompt-adjacent -> check byte-lock | honest-degrade to today |

Ranked order to execute: **1 -> 2 -> 3 -> 4** (structured-outputs cluster, all bucket-(a),
parity-safe, mostly quality/robustness - do first, low risk) **-> 5** (interval, zero code)
**-> 7** (side-call flag tighten) **-> 6** (tier routing, (c)) **-> 9** (self-heal, (c)) **-> 8**
(caching, contingent, verify CLI first). Each: change, re-run corpus, apply gate rule. No bench
move the right way = don't ship (ponytail: no no-ops).

**Do NOT** touch `build_prompt()` output text (items that would: 8, 9 partially) without founder
auth + 60-fixture regen. Structured-outputs items 1-4 do NOT touch build_prompt - confirmed
parity-safe below.

---

## Deliverable 3: Parity plan

**The load-bearing fact:** the 60-fixture SHA-256 lock (`loki-ts/tests/parity/build_prompt.test.ts`,
KNOWN_FAILING empty = hard 60/60) hashes ONLY `buildPrompt()` return TEXT. CLI flags come from a
separate surface (`claude_flags.ts` / `voter_agents.ts` / `providers.ts:244`). **So adding
`--json-schema`/`--effort`/`--max-budget-usd` to a claude call is parity-SAFE w.r.t. the lock**, and
also doesn't touch the 10-command CLI matrix (which never invokes a model).

**The parity TRAP this arc must own** (agent-verified): a native flag added to ONE route only
(bash `autonomy/lib/claude-flags.sh` vs TS `loki-ts/src/providers/claude_flags.ts`) would **pass all
four parity gates** (bun-parity.yml, parity-drift.yml, local-ci matrix, build_prompt lock) while
diverging at RUNTIME - because the matrix doesn't spawn the model. Therefore:
- **Every native-flag change lands in BOTH `claude-flags.sh` AND `claude_flags.ts`, byte-mirrored**,
  gated on `claudeFlagSupported()`/`loki_claude_flag_supported` for old-CLI degrade.
- **Proven by the flag-parity unit tests** (`loki-ts/tests/runner/providers.test.ts`,
  `tests/test-bash-bun-parity.sh` run at `local-ci.sh:390`), NOT the CLI matrix. Add a case per new flag.
- Structured-output items 1-4: mirror the bash change (voter-agents/council-v2/done-rec/quality-gates)
  in the corresponding TS (`council/voter_agents.ts`, `runner/quality_gates.ts`).
- **build_prompt-touching items (8, 9)**: founder-gated. Regenerate all 60 fixtures via `run-bash.sh`
  (`for i in $(seq 1 60); do bash run-bash.sh fixture-$i; done`), regenerate `index.json`, keep bash<->TS
  60/60 in the SAME PR. Watch the fixtures 27/45 alphabetical-readdir determinism guard.
- **Doctor normalizers are TRIPLICATED** (`bun-parity.yml:127-184`, `parity-drift.yml:83-135`,
  `local-ci.sh:812-860`) with subtle diffs (JSON floor-vs-delete, counts kept-vs-blanked). If any
  primitive changes doctor output, edit ALL THREE in sync.

Every commit proven on BOTH routes (`bin/loki` + `LOKI_LEGACY_BASH=1 bin/loki`).

---

## Deliverable 4: Gate plan

- **Trust-core = 3-reviewer council** (2 Opus + 1 Sonnet, unanimous APPROVE, reviewers RUN tests).
  Any CONCERN/REJECT -> read source, fix, RE-RUN whole council. Loop to 3/3. Never "2-of-3".
- **`bash scripts/local-ci.sh` green before EVERY push** (Step 0). It mirrors every workflow:
  bash -n + shellcheck, pytest, `bun typecheck` + `bun test` (the 60-fixture lock runs here),
  CLI dual-route (`test-cli-commands.sh` Bun + LEGACY_BASH), `test-bash-bun-parity.sh`, the local
  bun-parity matrix, npm-pack contents (>=6 load-bearing files), SBOM, no-emoji, no-`git add -A`.
- **Extraction-test harness for bash fn changes** (`feedback-function-extraction-test-harness`):
  extract the changed fn AND every helper it calls (grep `sed -n '/^<fn>() {/'` tests); `set +u`
  inside the eval subshell; prove runtime-vs-test before "fixing" a red test (fix the TEST if runtime
  is right, never patch correct code).
- **RARV-C changes proven with hermetic Bun integration tests** (stub judge, `LOKI_OVERRIDE_REAL_JUDGE=0`,
  mkdtemp scratch, no token cost) - pattern in `loki-ts/tests/integration/override_on_block.test.ts`.
- **Never run an engine build from the worktree** (`feedback-never-run-engine-build`): all real builds
  from isolated source copy, cwd + LOKI_TARGET_DIR pinned to scratch.

---

## Deliverable 5: Release plan (v8.0.0, MAJOR)

- **14 version locations** (all verified at 7.128.2, zero drift): VERSION:1, package.json:4,
  SKILL.md:6+411, Dockerfile:9/14, Dockerfile.sandbox:102/103, plugins/.../plugin.json:5, CLAUDE.md:306,
  dashboard/__init__.py:10, mcp/__init__.py:60, CHANGELOG.md:8, docs/INSTALLATION.md:5(+399 docker tag),
  wiki/Home.md:106, wiki/_Sidebar.md:46, wiki/API-Reference.md:69.
- **MAJOR bump also touches docker-tag group** (README.md ~81/~380, docs/INSTALLATION.md 7+ tags,
  docker-compose.yml:1).
- **Do NOT touch** (independently versioned, would break if "fixed"): `sdk/python/pyproject.toml`
  (auto-synced by release.yml:352 at publish), `sdk/typescript/package.json` (5.55.0),
  `loki-ts/package.json` (0.1.0-alpha.1), `vscode-extension/package.json` (deprecated).
- **FIX in v8 - release-notes bug** (`release.yml:179/231`): awk expects bracketed `## [VERSION]` but
  CHANGELOG uses unbracketed `## vVERSION`, so release notes have silently been generic. Fix the awk or
  the header format (one PR, verify the extracted body is non-empty).
- **Dashboard frontend rebuilt** (`cd dashboard-ui && npm ci && npm run build:all`) - writes both
  `dashboard-ui/dist/` and `dashboard/static/`.
- **Pre-publish validation** (CLAUDE.md 3a): `npm pack --dry-run` contains web-app/dist + dashboard/static;
  fresh global install serves web app + API.
- **Per-job release verification**: `gh run view <id> --json jobs` per channel (npm/Docker/Homebrew/Release),
  not just "workflow green".
- **Post-release smoke from SHIPPED artifacts on BOTH routes**: `npm pack loki-mode@8.0.0` + `bun run bin/loki
  version` and `LOKI_LEGACY_BASH=1 ... version`; `docker run --rm asklokesh/loki-mode:8.0.0 doctor --json`;
  WebFetch brew formula version+sha.
- **Cleanup after every local-ci/validation**: `lsof -ti:57374 | xargs kill -9; rm -rf /tmp/loki-* /tmp/test-* /tmp/package /tmp/*.tgz`.

---

## Do-NOT list (binding)

1. Do NOT replace the 3-reviewer council with a single-LLM outcome-grader. Structured-outputs changes
   the OUTPUT FORMAT (text->JSON), NOT the 3-judge architecture. That's the moat.
2. Do NOT add an LLM judge to the bench grader (deterministic exit==0 only; `validate_adapter_output`
   rejects self-judged keys).
3. Do NOT trust council APPROVE / completion-claim as the bench pass signal (fake-green failure mode).
4. Do NOT touch `build_prompt()` output text without founder auth + 60-fixture regen + 60/60 bash<->TS.
5. Do NOT change corpus/grader/price-table across a before/after pair.
6. Do NOT run a real engine build from the worktree.
7. Do NOT add a native flag to one route only (silent runtime divergence past all parity gates).
8. Do NOT ship a change that doesn't move the bench the right way.
9. Do NOT rebuild what's already adopted (--effort/--max-budget-usd plumbing, council --json-schema path).

---

## FOUNDER SCOPE DECISIONS (2026-07-13, locked)

- **SCOPE = FULL ARC** including founder-gated items 8 (caching) and 9 (self-heal-from-logs).
  This constitutes explicit authorization to unlock `build_prompt()`'s 60-fixture byte-lock WHEN
  those items come up - executed per Deliverable 3 (regenerate all 60 fixtures via `run-bash.sh`,
  keep bash<->TS 60/60 in the same PR, full council + local-ci). Founder-gated items still run LAST,
  after all bucket-(a) structured-output wins are banked and bench-measured. Caching (8) still
  requires the CLI-mechanics verification (does the CLI fold cache_control across per-iteration
  processes?) BEFORE committing - if it's a no-op, report that and drop it, don't ship a no-op.
- **BASELINE = 3-SPEC SMOKE FIRST.** Prove the full pipeline (baseline -> one change -> measure ->
  gate rule) on a tiny 3-spec corpus to validate the harness machinery cheaply, THEN build the real
  discriminator-derived corpus (simple+hard+multi-failure+token-heavy) and run the full v7.128.2
  baseline. Catches harness bugs before the big real-dollar run.
- **Honesty pre-commit stands:** most iteration wins are already shipped; expect single-digit-% to
  maybe-2x from tuning, NOT 100x (the real 100x is the already-scoped k8s INFRA work, not this arc).
  Report the true number even if unimpressive.

## Consolidation + sequencing

1. Create branch `feature/rarv-c-100x-primitives`. Build harness, run 3-SPEC SMOKE to validate the
   pipeline, then commit the full v7.128.2 baseline (Deliverable 1) before any change.
2. Write `docs/RARV-C-100X-PLAN.md` = this plan (supersedes/links the two prior v7.121.5 docs; keep
   them as history, note they're superseded).
3. Execute the adoption table in ranked order, one primitive per commit, bench + full gate after each.
4. Founder-gated items (8 caching, 9 self-heal build_prompt half) LAST, only after (a)-items banked and
   explicit unlock.
5. Release v8.0.0 per Deliverable 5 once the bench shows the aggregate win (or honestly report the real
   delta if single-digit - the plan pre-commits to reporting the true number, not dressing it up).

## Verification (how to test end-to-end)
- Bench: `bash benchmarks/bench/run.sh run <spec> --trials 3` from isolated scratch; read
  iterations/cost/duration from result JSON; grader `exit==0`. 2-spec smoke asserts [pass, fail].
- Structured-outputs: hermetic Bun integration test with stub judge asserts JSON verdict parsed,
  no text-regex path hit; + extraction test for the bash side.
- Parity: `bash scripts/local-ci.sh` green (runs 60-fixture lock + dual-route CLI + flag-parity tests).
- Per commit: full 3-reviewer council + local-ci, both routes.
