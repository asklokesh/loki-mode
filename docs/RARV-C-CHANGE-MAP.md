# RARV-C Efficiency Change Map (apply-and-measure, from lever investigation)

> SUPERSEDED by `docs/RARV-C-100X-PLAN.md` (v8.0.0 arc, 2026-07-13). Kept as history.
> Anchors here are grounded to v7.121.5 and have DRIFTED; use the 100X plan for current
> file:line. Note: budget/effort (#7) and council --json-schema were adopted AFTER this doc.


Both checks resolve cleanly:

**Check 1 (env propagation): CONFIRMED SAFE.** `_base.py:113` does `full_env = dict(os.environ)` then passes it as `env=full_env` to subprocess. The loki adapter (`loki.py:120`) uses `run_env`. So env-prefixing the bench invocation propagates the knob into the loki subprocess, where completion-council.sh:84 reads it at source time. Every `KNOB=x bench run` command in the plan is a real measurement, not a no-op.

**Check 2 (iteration counts): CONFIRMED AVAILABLE.** `iterations` is a canonical per-trial field (`loki.py:35-77` counts `iteration_complete` events; `_base.py:34,92` records it in the result row). So the moment the baseline lands, per-spec iteration counts are readable directly from the result JSON, which is exactly the discriminator the advisor flagged.

The advisor's arithmetic is decisive: 150s / 14k tokens ≈ 1 iteration, so simple-1 almost certainly already stops at iter ~1 via the fast path. The council-knob interval sweep must be pointed at the highest-iteration spec, not the trivial baseline. Here is the final synthesis.

---

# RARV-C EFFICIENCY ARC: ORDERED APPLY-AND-MEASURE CHANGE MAP

## Gate rule (applies to every change below)
Ships iff it moves >=1 of {iterations, $/build, wall-clock} BEYOND the ~25% noise band AND does not regress verified-pass-rate. Baseline: 5 specs x 3 trials, running now.

**Measurement primitive (all changes):**
`KNOB=val bash benchmarks/bench/run.sh run <spec> --trials 3 --emit-proof` (env-prefix propagates via `_base.py:113` `dict(os.environ)` -> loki subprocess). Read `iterations`, `cost`, `duration_s` per trial from the result JSON; pass = grader `exit==0` (`runner.py:210-254`).

**Baseline arithmetic that reshapes the whole plan:** 2.5min ≈ 150s and ~14k tokens ≈ ONE iteration (~130s/~10k each per the other two investigations). So the trivial baseline is almost certainly **already stopping at iter ~1 via the explicit-claim fast path** (`completion-council.sh:3519-3521`) - the exact case the council investigation says needs NO change. The council-knob headroom lives in high-iteration specs (`multifail-1-two-modules`, `tokenheavy-1-crm`), not `simple-1`.

---

## DO THIS FIRST (the moment the baseline lands)

**READ per-spec iteration counts from the baseline result JSON** before touching anything. This single read decides whether change #1 (council interval) can ship at all.

Then, change #1 is the first thing to **measure** (zero code, pure env var, cannot regress pass-rate - it changes WHEN not WHETHER the council approves):

**One-line command:**
```
LOKI_COUNCIL_CHECK_INTERVAL=2 bash benchmarks/bench/run.sh run multifail-1-two-modules --trials 3
```
(Point at whichever spec the baseline shows grinding *past its min-iter floor with no claim*. If NO spec grinds past floor, change #1 is a no-op and does not ship - see #1 below.)

---

## CHANGE TABLE (buckets a -> c -> b)

### BUCKET (a) - constants/gates, no prompt text, no parity blast radius

#### #1. Council check-interval sweep (simple tier) [SHIP FIRST if warranted]
| Field | Value |
|---|---|
| Anchor | `completion-council.sh:84` (`COUNCIL_CHECK_INTERVAL=${LOKI_COUNCIL_CHECK_INTERVAL:-5}`); modulo gate `:3523` |
| Current | 5 |
| Proposed | 2 or 3 for simple tier only; keep 5 for standard/complex |
| Bucket | (a) |
| Metric | wall-clock + iterations, ONLY on no-claim/no-test-suite specs that grind to the interval boundary |
| Measure | `LOKI_COUNCIL_CHECK_INTERVAL=2 bash benchmarks/bench/run.sh run <highest-iter-spec> --trials 3`; pass = APPROVE verdict unchanged vs baseline, wall-clock down past noise |
| Effort | Trivial (1 env default) |
| Risk | Low. Do NOT go to 1 globally (council convenes every iter -> cost rises on genuine multi-iter builds). |
| **NO-OP GUARD** | If baseline shows every spec stops at iter ~1 (fast path), this moves nothing and FAILS the gate on trivial specs. **Ships only if a spec is empirically grinding past its floor without a claim.** |

#### #2. Verify explicit fast-path fires at iter 1 (validation run, not a change)
| Field | Value |
|---|---|
| Anchor | claim detection `completion-council.sh:3601-3605`; bypass `:3519-3521`; runner peek `run.sh:18309-18314` |
| Current | On (structural) |
| Proposed | No change - run matrix row C to prove it |
| Measure | `bash benchmarks/bench/run.sh run simple-1-contact-form --trials 3` with `COMPLETION_REQUESTED` touched at end of iter 1; expect stop at iter 1. If it does NOT, that is a **real claim-wiring bug**, not a knob. |
| Effort | Trivial | Risk | None (read-only validation) |

### BUCKET (c) - need off-worktree / bench validation (parity or regression guard)

#### #3. Complexity -> tier routing (`auto` sentinel)
| Field | Value |
|---|---|
| Anchors | `run.sh:742` (`LOKI_SESSION_MODEL:-sonnet` -> `:-auto`); `run.sh:16932-16943` (case block, add `auto` arm); `_loki_session_pin_opus=1` reuse `run.sh:16953`; parity: estimator `autonomy/loki:15860-15870`, dashboard `server.py:2841,3059` |
| Current | Session pinned to `sonnet` for whole run; tier NOT complexity-aware |
| Proposed | `auto` arm: simple->fast+**haiku-enable**, complex->planning+`_loki_session_pin_opus=1`, standard->development. Propagate resolved tier via `.loki/state/session-tier` file for the two parity readers (they lack `DETECTED_COMPLEXITY`). |
| Bucket | **(c)** - conflicts with task framing (task calls tier-routing a leading "(a)" candidate; its own investigation classified it **(c)** on evidence: 3 parity readers + hard-1 bench guard + gated opus/haiku dispatch). Go with the evidence. |
| Metric | $/build + tokens (simple drops via haiku); verified-pass-rate must hold (hard-1) |
| Measure | Bench before/after with auto on: `hard-1-order-api` stays `exit==0` at planning tier; `simple-1`/`simple-2` cost drops AND stays green. If cheap routing drops hard-1 below pass, classifier thresholds (`detect_complexity` 2574-2591) are wrong. |
| Effort | Medium (~15 lines run.sh + state-file read in 2 ports + parity allowlist for `auto`) |
| Risk | Med. Silent quality regression if a hard build routes cheap. Guarded by hard-1 held-out acceptance. |
| **LANDMINES** | L2: `simple->fast` alone == sonnet==sonnet, **zero savings** without `LOKI_ALLOW_HAIKU=true` - the haiku-enable is the load-bearing half. L3: `CURRENT_TIER=planning` dispatches sonnet post-v7.104; must reuse `_loki_session_pin_opus=1` for real opus. |

#### #4. Self-heal from run logs (route app.log error signature into prompt)
| Field | Value |
|---|---|
| Anchors | S1 new helper `app-runner.sh` (~15 lines); S2 call sites `app-runner.sh:1756,1823` + `_loki_write_last_error` `run.sh:1103`; S3 injection edit `run.sh:14941-14942` (the `APP_CRASHED` heredoc line - **verified exact**) |
| Current | Watchdog restarts blindly; prompt gets crash *count* + "check app.log yourself"; `LAST_ERROR.json` is write-only (never read by `build_prompt`) |
| Proposed | S1: deterministic `tail -60 app.log` + grep first stack frame (Traceback/Error:/panic:/EADDRINUSE/MODULE_NOT_FOUND). S2: persist as `error_class=app_runtime_error`. S3: append signature + targeted-fix instruction to the injection. No new subsystem; reuses 2 existing mechanisms. |
| Bucket | (c) - orchestration change, provider-agnostic, needs bench validation on crashing specs |
| Metric | **iterations-to-green / verified-pass-rate on CRASHING specs** (NOT trivial cost - does nothing on the non-crashing baseline; will look like a gate fail if measured on simple-1) |
| Measure | Unit-test S1 against fixture `app.log` with a Python traceback (asserts signature) and one without (asserts empty, no fabrication). Then bench on `multifail-1-two-modules` (crashes): expect faster convergence / higher pass-rate. |
| Effort | Small (1 helper + 2 call sites + 1 edit) |
| Risk | Low. No-fake-green by construction: only routes info into the prompt; fix still flows through health-check + council + 8 gates. Honest-degrade: no signature -> today's behavior. |

#### #5. MCP/tool-surface scoping for simple builds (prompt-size Lever A)
| Field | Value |
|---|---|
| Anchors | Provider invocation / MCP mount logic (NOT `build_prompt`); lsp-proxy mount + `mcp/server.py` ~34-tool surface |
| Current | Full MCP surface (loki-mode ~34 tools + lsp-proxy + Claude built-ins) mounted every build; multiple-k of fixed token floor |
| Proposed | Gate lsp-proxy mount off when no language server helps; reduced MCP toolset for simple-complexity builds |
| Bucket | (c) - NOT the low-effort/no-regression "(a)" the task framing implies. Same "dropped a tool the build needed -> regression" risk class as tier-routing; mount-time complexity detection is real work. The prompt-size investigation's "do first" is scoped *within prompt-size*, not the whole arc. |
| Metric | input tokens/build (biggest single token win, no byte-lock unlock) |
| Measure | Bench simple-1/simple-2 token delta with reduced surface; hard-1 must stay green (needs its tools). |
| Effort | Medium (mount gating + complexity signal at invocation) |
| Risk | Med - underscoping breaks a build that needed a dropped tool. |

#### #6. PreToolUse content validation on Write/Edit (Bucket-2 gap, Claude-only)
| Field | Value |
|---|---|
| Anchor | `.claude/settings.json` PreToolUse matcher (mirrors `validate-bash.sh`) |
| Current | PreToolUse hook exists for Bash command strings only; no content validation on file writes |
| Proposed | Add `Write|Edit` matcher validating written content (secret patterns, `node --check` syntax) |
| Bucket | (c) - native hook is right mechanism but **Claude-provider-only** defense-in-depth; real cross-provider containment stays the sandbox (`LOKI_SANDBOX_MODE`) |
| Metric | Not an efficiency lever - safety. **Does not move any gate metric.** Include only as opportunistic safety, not scored against the efficiency gate. |
| Effort | Small | Risk | Low (advisory) |

### BUCKET (b) - founder-gated (build_prompt byte-locked + 60-fixture SHA parity)

#### #7. Enable prompt caching / activate `[CACHE_BREAKPOINT]` (prompt-size Lever B)
| Field | Value |
|---|---|
| Anchor | `[CACHE_BREAKPOINT]` marker `run.sh:15119` (inert today); no `cache_control` set |
| Current | Static ~1.6k prefix + tool/system floor re-billed full price every iteration (each iter is a distinct `claude -p` process) |
| Proposed | Wire real caching for the static prefix |
| Bucket | (b)-adjacent, and **CONTINGENT** - benefit is 100% caching, hinges on whether Claude Code CLI folds the prefix into a cached breakpoint reusable across per-iteration processes within the 5-min TTL. **Verify against the CLI before committing.** |
| Metric | $/build on multi-iteration runs (zero token reduction; converts fixed prefix to ~0.1x on cache reads) |
| Measure | Compare cost on a multi-iteration spec (tokenheavy-1) before/after; caching shows on iter-2+. |
| Effort | Med (contingent on CLI mechanics) | Risk | Med - may be a no-op if CLI doesn't wire cache_control for the prefix. Flag "verify before committing," not a committed change. |

#### #8. Trim static boilerplate in `<loki_system>` prefix (prompt-size Lever C)
| Field | Value |
|---|---|
| Anchors | compose (~290t) + LSP (~286t) + USAGE (~209t) + DOC_SCOPE (~143t) strings in `run.sh` + `build_prompt.ts` |
| Current | All emitted every build |
| Proposed | Load-on-demand / shorten (~700-900 tokens recoverable) |
| Bucket | (b) - byte-locked; each string `MUST stay byte-identical` under 60-fixture SHA parity (`loki-ts/tests/parity/build_prompt.test.ts`). Needs founder unlock + fixture regen + dual-route parity re-verify. |
| Metric | input tokens (~7-9% of 10k) |
| Effort | Small code, EXPENSIVE unlock | Risk | Low behavior, high process cost. |

---

## NOT WORTH DOING (ponytail: no no-ops)

| Item | Why it's a no-op / not worth it |
|---|---|
| `_council_effective_min_iter` simple->1 | **ALREADY SHIPPED** (SaaS #122, verified `completion-council.sh:118-130`). Nothing to do. |
| `simple->fast` tier route WITHOUT haiku-enable | sonnet==sonnet (L2, `claude.sh:60-62`). Zero savings. The haiku-enable is the only load-bearing half. |
| Lowering `COUNCIL_STAGNATION_LIMIT` (5->3) for speed | Fires circuit breaker sooner -> force-stop, which is NOT verified-complete (`run.sh:18320-18326`). Pass-rate regression dressed as speedup. Leave at 5. |
| Council interval on the trivial baseline | If baseline stops at iter ~1 (very likely per arithmetic), lowering the interval moves nothing on simple-1 and fails the gate. Only ships against a spec grinding past floor. |
| Prompt-size Lever D (move RARV to `--append-system-prompt`) standalone | Saves ZERO without Lever B's caching, and DOUBLE-BILLS if the byte-locked removal half doesn't ship simultaneously. Bundle-with-#7 or drop. Not a standalone change. |
| Self-heal S5 (dedicated read-only investigate sub-agent) | YAGNI. S3 already gives the RARV agent the error text; RARV's own VERIFY is the remediate half. Add only if S1-S4 measurably under-fix. |

---

## ORDER SUMMARY
1. **Read baseline iteration counts per spec** (decides #1 viability).
2. **#1 council interval** - measure first, ship iff a spec grinds past floor (bucket a, zero code).
3. **#2 fast-path validation** - confirms claimed builds stop at iter 1 (bucket a, read-only).
4. **#3 tier routing** (bucket c) - biggest $/build lever; needs parity + hard-1 guard, off-worktree.
5. **#4 self-heal** (bucket c) - pass-rate lever on crashing specs; measure on multifail-1, not simple-1.
6. **#5 MCP scoping** (bucket c) - biggest token win, but real regression risk; not the "first" the framing suggests.
7. **#6 PreToolUse content validation** (bucket c, safety, unscored).
8. **#7 caching** (bucket b, contingent - verify CLI before committing).
9. **#8 prefix trim** (bucket b, founder-gated - small win, expensive unlock; do LAST, don't spend the unlock for ~300 tokens while ~5k sits in tool schemas).

**Two framing conflicts surfaced (evidence wins):** (a) the task calls tier-routing and MCP-scoping leading "(a)" candidates; their own investigations classify both **(c)** on parity/regression-guard evidence. (b) The council-knob is genuinely the first thing to *measure* (pure env var, no regression path) but is a no-op on the trivial baseline - its real target is high-iteration specs.

Read-only synthesis; no edits, no processes, no temp files. Clean.
