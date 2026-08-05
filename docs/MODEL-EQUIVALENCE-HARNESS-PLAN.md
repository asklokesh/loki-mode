# Model-Equivalence Harness Plan (provable "haiku + harness = opus" moat)

Thesis under test: outcome quality is a property of the ORCHESTRATION, not the raw model. A great harness makes Haiku reach the same end-outcome quality as Opus.

Formal claim (per axis, held-out corpus): outcome_quality(haiku + full-harness) >= outcome_quality(opus + baseline-harness) - epsilon, accepted only when the bootstrap CI of the gap overlaps zero (or sits above -epsilon). Else report the true residual. This is a measurement instrument, not a marketing generator.

Design stance: the bench harness, grader, schema, cost module, tier machinery all exist and are correct. Steering levers are env-var-controlled; _base.run_cli merges os.environ into the loki start subprocess (_base.py:113). So the model x config matrix needs ZERO adapter/grader changes - only an orchestration script that sets env vars and calls the existing runner, plus a new aggregation report.

## Ground truth (build on, don't rebuild)
- Model pin: LOKI_SESSION_MODEL in {haiku,sonnet,opus,fable}, honored at adapters/loki.py:135-138 and run.sh:17336-17357.
- Env passthrough: _base.run_cli merges dict(os.environ) (_base.py:113).
- Grader: held-out overlay + acceptance exit code; adapter forbidden from emitting success/quality/score/verdict (bench_schema.py:219-231).
- Corpus: 5 discriminator tasks with held-out overlays. HARD tasks (hard-1-order-api, multifail-1-two-modules, tokenheavy-1-crm) are where levers fire; simple tasks one-shot (iterations:1) so levers are noise there.
- Steering flags (all env-dialable): LOKI_MAX_ITERATIONS, LOKI_COUNCIL_ENABLED, LOKI_PHASE_CODE_REVIEW, LOKI_SELF_HEAL, LOKI_ALLOW_HAIKU, LOKI_COMPLETION_PROMISE, LOKI_COUNCIL_CHECK_INTERVAL/THRESHOLD/MIN_ITERATIONS.
- Cost: prices.json (opus 15/75, sonnet 3/15, haiku 1/5 per Mtok) + native cost_usd.

## 1. Experiment design
Matrix 6 cells: {haiku,sonnet,opus} x {baseline-steering, full-harness-steering}. Hero cell = H.F (haiku+full harness) vs O.B (opus+raw). baseline = MAX_ITERATIONS=1, council off, review off, self-heal off (the Replit/Cursor "throw the model at it" mode). full = all levers on.

Three axes, never blended: (1) CORRECTNESS = held-out acceptance exit 0 (deterministic, works today, primary). (2) DESIGN QUALITY = D-val screenshot+rubric 0-100 (web tasks only; NOT yet built; report not_captured until the judge is validated). (3) HONESTY = real proof.json/verify verdict present + true (guards against weak model "declaring done" falsely).

Statistical rigor: correctness is Bernoulli -> Wilson score interval (not normal approx). gap = success_rate(H.F) - success_rate(O.B); bootstrap CI (>=2000 resamples over (task,trial) pairs). Decision: accept equivalence iff gap CI lower-bound >= -epsilon (default 0.10). CI entirely below -epsilon -> real residual. CI straddles -> underpowered, need more N. HONEST small-N: N=3 x 5 tasks detects only >~20-pt gaps; credible equivalence within epsilon=0.10 needs N>=8-10/task (~40-50 obs/cell). Min credible claim = N=10 x 5 tasks x 6 cells = 300 runs.

## 2. Steering levers + ablation (the mechanism)
Each lever = an env var wired into run.sh. Ablate: hold model=haiku, toggle one lever, measure delta in success_rate (leave-one-out from full-on; cheaper + more decision-relevant). Do it only on the 3 HARD tasks.
- More RARV-C iterations (LOKI_MAX_ITERATIONS 1->8): weak models converge by trial-and-error against the acceptance harness.
- Council gate (LOKI_COUNCIL_ENABLED): 3 reviewers catch weak-model "looks done but isn't".
- Code review (LOKI_PHASE_CODE_REVIEW): catches weak-model correctness bugs.
- Self-heal (LOKI_SELF_HEAL=1): feeds prior error back as a hint; weak models fix faster.
- Verify/proof gate: forces real evidence (honesty axis).
- Structured decomposition (grill): breaks hard tasks into weak-model-sized pieces.
- Design gate (D-val): forces design quality regardless of model (web only).
- Prompt scaffolding: constrains weak-model output toward the spec.
Output: ablation table (lever -> haiku success_rate OFF vs ON, marginal lift + CI + DEV/LOCKED overfit flag).

## 3. Adaptive harness (the product)
Encode the ablation result as a tier-aware harness policy (model -> lever settings), so the same outcome ships on any tier. Home: loki_apply_tier_harness_policy() helper + policy table in autonomy/run.sh near the tier case block (17340-17347); exports lever env vars UNLESS the operator set them (override wins). ~15 lines. haiku/fast: MAX_ITERATIONS=8, council on, self-heal on, stricter gate. sonnet: MAX_ITERATIONS=5, council on, self-heal on. opus: MAX_ITERATIONS=3, council on, self-heal off. Ties to Task#6 tier routing (same variable) and SaaS pricing (model-policy.ts allowedModels: free=haiku/$15=sonnet/$99=opus) - they meet at the one env var. This is what makes free-tier haiku yield near-top outcomes = the business case.

## 4. Improvement loop (not one-shot)
Run 6-cell matrix on HARD held-out tasks (correctness first, it's free) -> measure per-axis gap + bootstrap CI -> if gap CI lower-bound >= -epsilon on all axes, DONE (claim proven with N+spread) -> else leave-one-out ablation on haiku, find the lever closing the largest residual, dial it, re-run only changed cells -> repeat UNTIL equivalence within noise OR marginal lift < CI width (diminishing returns -> report honest residual). Never chase a benchmark number.

Anti-overfit: DEV/LOCKED corpus split (levers tuned on DEV, LOCKED touched only for the final claim). Grow corpus to >=12-15 tasks before any equivalence claim, ~60/40 split. Rotate locked tasks. Any lever lifting DEV but not LOCKED = benchmark-overfit, excluded from shipped policy.

## 5. Rigor/honesty guards
Grader stays deterministic held-out exit code (no change to runner.grade / validate_adapter_output). The D-val LLM-judge MUST be validated before grading: inter-rater reproducibility (same screenshot >=3x, 2 judge models opus+sonnet, report variance), anchor with known-good/known-bad; if judge variance > the gap being measured, design axis is not_captured (don't fabricate). Correctness + honesty axes don't depend on any LLM judge. No fabricated numbers (report N + spread; null != 0). Never tune corpus/grader across a before/after pair (task_hash binds fixture+spec; refuse to compare mismatched task_hash). Disclose overfit levers (DEV vs LOCKED delta per lever).

## 6. Cost + cheap-first schedule
Per-build (hard task, full harness): haiku ~$0.30-1, sonnet ~$1-3, opus ~$5-15 (council+review+self-heal add reviewer calls; full-harness cells cost multiples of baseline).
- Stage 0 smoke: H.B + O.B on fizzbuzz, N=1 = 2 runs, ~$1. Prove the matrix machinery + haiku pin (needs LOKI_ALLOW_HAIKU=true).
- Stage 1 pilot: H.F vs O.B on 3 HARD tasks, N=2-3, ~15 runs, ~$30-80. First credible directional signal on the gap. (Underpowered: only detects >20-pt gaps.)
- Stage 2 ablation: leave-one-out on haiku, hard tasks, N=3, ~50 runs, ~$60-120. Which lever closes the gap.
- Stage 3 credible claim: full 6-cell, >=12-task corpus, DEV/LOCKED, N=10, ~700 runs, ~$500-2000. Publishable proof with CIs.
Min for first signal: Stage 0 + Stage 1 ~$30-80 = H.F vs O.B on 3 hard tasks at N=3.

## 7. Deliverables (thin extensions)
1. benchmarks/bench/matrix.sh (~80 lines): loops 6 cells, exports model+lever env per cell, calls existing run.sh run <task>, writes tagged result JSONs. No runner/adapter change.
2. benchmarks/bench/equivalence_report.py: reads tagged results, computes per-axis per-model gap + Wilson/bootstrap CI, renders grid + ablation table + explicit decision (equivalent within epsilon / real residual / underpowered). Reuses report.py helpers. Refuses mismatched task_hash.
3. Adaptive harness policy helper + table in autonomy/run.sh (populated from Stage-2 data; stub first).
4. Corpus growth: 7-10 new tasks + overlays following the existing 5, DEV/LOCKED split. Web tasks tagged for D-val.
5. Design-axis integration (deferred until D-val judge validated): non-gating grader signal like quality.lint_ok.

## Ranked (cheapest credible signal first)
1. Stage 0 smoke (~$1): confirm haiku pin + env passthrough.
2. Stage 1 pilot (~$30-80): first directional signal; ship equivalence_report.py here, honestly labelled underpowered.
3. Stage 2 ablation (~$60-120): attribute gap-closing to levers -> harness policy table.
4. Corpus growth + DEV/LOCKED (dev time): precondition for a published claim.
5. Stage 3 credible claim (~$500-2000): publishable proof.
Everything before Stage 3 is under ~$200 and answers "does steering close the haiku-vs-opus gap?" with real data.

CORRECTION: the design axis (D-val) is planned in autonomi-saas, NOT built; its LLM judge must pass reproducibility validation before grading. The first provable claim rests on CORRECTNESS (free, deterministic, works today) + HONESTY (verify verdict). Do not gate the moat claim on the unbuilt design axis.
