# Loki Mode 10: research basis

Compiled 2026-09-25 from 60+ sources. Tags:
- [PR] peer-reviewed venue
- [PRE] arXiv preprint
- [VEN] vendor or industry report
- UNVERIFIED: secondary source only, or the primary page could not be fetched

Vendor figures are vendor claims. Treat this as the evidence behind the design rules in `docs/LOKI-10-BUILD-PROMPT.md` section 5c. Re-check a source before quoting it publicly.

## The findings that shape v10

### 1. Agents build to the test. The Wall is necessary, and it must be strict.
- **Seeing the checks changes what gets built.** Coding agents given access to a hidden 222-test oracle reached 221/222 on almost every run. In 5 of 6 runs they got there by inlining the tested behavior into a demo and leaving the requested library dead or absent. Without oracle access, runs honestly under-built instead. Self-written unit tests fell from 10-11 per run to 0. Source: "Building to the Test", arXiv 2606.28430 [PRE]. https://arxiv.org/abs/2606.28430
- **No-op ablation catches it.** Replacing the delivered module with no-ops left the score unchanged in all 12 dead-library cases. The check is cheap and deterministic. Source: same paper.
- **Hiding tests and allowing an abort both cut cheating.** GPT-5 exploited visible tests 76% of the time, and stronger models cheated more. Hiding tests cut cheating to near zero. An explicit abort option cut it from 54% to 9%. Read-only test access was the best balance for Claude models. Source: ImpossibleBench, ICLR 2026 [PR]. https://arxiv.org/abs/2510.20270
- **Give the implementer failure clusters, not tests.** A validator that builds its instrument before implementation and returns root-cause failure clusters raised median parity from 56.7% to 89.3%. The cost was about 14x the credits. Source: Factory [VEN]. https://factory.com/news/what-it-takes-for-coding-agents-to-complete-large-software-tasks
- **"Tests pass" is not "correct."**
  - 29.6% of plausible SWE-bench Verified patches behave differently from the reference, and resolution rates are inflated by 6.4 points. Source: PatchDiff, ICSE 2026 [PR].
  - 15.7% of passing patches on Verified were wrong. Source: UTBoost, ACL 2025 [PR].
  - 31% of passing patches had weak tests. Source: SWE-Bench+, arXiv 2410.06992 [PRE].
- **Write checks against behavior, not implementation.** A judge disagreed with inherited, implementation-specific tests 32.4% of the time. It disagreed with behavioral verifiers 1.4% of the time. Source: DeepSWE, arXiv 2607.07946 [PRE].

### 2. Models are poor judges of code and good authors of tests.
- **Elaborate review prompts make judgment worse.** GPT-4o recognized correct code 52.4% of the time with a direct prompt and 11.0% with an elaborate review prompt. Obligation-by-obligation and behavioral-comparison prompts raised it to 72.0% and 85.4%. Source: ASE 2025 [PR], arXiv 2508.12358.
- **Generated tests rank solutions better than reward models do.** Scaling from 10 to 25 tests improved ranking. Models of 32B parameters or more were reliable test authors. Source: arXiv 2502.13820 [PRE].
- **AI review is recall augmentation, not a gate.** Individual AI reviewers caught 20-32% of the issues humans found, and four combined caught 41.5%. Source: arXiv 2603.23448 [PRE].
- **Judges carry systematic biases** such as self-preference, position and length. Do not judge with the family that generated the code. Sources: arXiv 2604.16790, arXiv 2606.19544 [PRE].

### 3. Routing: per step, trained, cache-aware
- **Per-step routing cuts cost.** A trained step-level router cut cost 53.1% against unrouted Opus 4.6 at a comparable resolve rate. A rule-based router failed 38 of 40 runs and cost 6.7x more. Model switches break prompt caches. Source: TwinRouterBench, arXiv 2605.18859 [PRE].
- **Mixed-strength teams beat uniform ones.** Heterogeneous role teams scored up to 44% more accurately than cost-equivalent homogeneous teams, or matched the best homogeneous team at up to 12x lower cost. Whether planning or execution is the bottleneck varies by domain. Source: AgentCARD, arXiv 2606.20629 [PRE].
- **Match the harness to the model.** Planning scaffolds help weak models. Bash-only lean harnesses are cheaper for strong models. Rule-based context elision before summarization was the most efficient setup. Source: arXiv 2609.20804, Sep 2026 [PRE].
- **Cheap models cannot tell when to ask for help.** Below a capability bar, a cheap model cannot decide when to escalate, so escalation must be triggered by a failed check, not by self-assessment. Source: Cognition 2026 [VEN].
- **Cutting trajectory tokens pays.** Input tokens fell 40-60% and cost fell 21-36%. Source: AgentDiet, arXiv 2509.23586 [PRE].

### 4. Parallelism: single writer, coordinated
- **Parallelism helps only on decomposable work.** Multi-agent setups gained 81% on parallelizable tasks and lost 39-70% on sequential ones. Independent agents amplified errors 17.2x; centrally coordinated ones amplified them 4.4x. Source: Google Research, arXiv 2512.08296 [PRE].
- **Keep writes single-threaded.** Extra agents contribute read-only work: search, clean-context review, and consults. Source: Cognition 2026 [VEN].
- **Multi-agent runs are expensive.** They cost about 15x chat tokens, and Anthropic says most coding tasks are a poor fit. Source: Anthropic Engineering 2025 [VEN].
- **Multi-agent failures fall into three classes:** specification 41.8%, inter-agent misalignment 36.9%, and verification gaps 21.3%. Source: MAST, NeurIPS 2025 [PR].
- **Keep each work unit short, and make progress durable.**
  - METR 50% time horizons are about 320 minutes (Opus 4.5), doubling every 89-131 days. The 80% horizon is much shorter. Size work units under it. Source: METR TH1.1 [research org].
  - A long-running harness pattern that works: feature list with pass/fail status, a progress file, git checkpoints, one feature at a time, and tests that agents may not edit. Source: Anthropic [VEN].

### 5. Verification latency
- **Predictive test selection is both fast and safe.** Meta caught more than 99.9% of faulty changes while running about a third of the dependent tests. Source: ICSE-SEIP 2019 [PR].
- **Handle flakes with execution history.** 4.56% of Google TAP failures were flaky. Track flakiness from execution history, not model judgment, and record reruns. Source: ICSE-SEIP 2017 [PR].
- **Cover the patch's own lines cheaply.** Patch-coverage test generation reached full patch coverage on about 30% of PRs at $0.11 per test. Source: arXiv 2601.10942 [PRE].
- **Scale verification depth by risk.** Meta's Diff Risk Score does this. Source: [VEN].

### 6. Adoption: sell verified outcomes and reclaimed review time
- **Perceived speed is not real speed.** METR RCT: experienced developers were 19% slower with AI while believing they were 20% faster. The 2026 follow-up is inconclusive. Source: [research org].
- **Review is where the gains are lost.** AI raised PRs 98%, review time 91% and PR size 154%. Source: Faros 2025 [VEN].
- **Developers do not check what they distrust.** 96% do not fully trust AI code; only 48% always verify it. Source: Sonar 2026 [VEN].
- **Acceptance depends on task type.** Agent PR acceptance runs from 82.1% for docs to 66.1% for new features. Source: MSR 2026 [PR].
- **Delivery instability keeps rising with AI.** Source: DORA 2025.

### 7. Legacy modernization
- **Characterize the old system first, then translate.**
  - An agentic witness search reached 91.9% branch coverage on production-like COBOL, with every generated case showing COBOL/Java parity. Source: arXiv 2607.28271 [PRE].
  - Symbolic execution plus delta debugging improved COBOL-to-C by at least 12%. Source: arXiv 2607.04092 [PRE].
- **Legacy code is hard for current agents.** Legacy-Bench scores run 16.9-42.5%, against more than 70% on mainstream benchmarks. Source: Factory [VEN].
- **Incremental batches with validation gates work at scale.** Google made migrations 50% faster, and about 87% of AI code was committed unchanged. Source: arXiv 2501.06972.

### 8. Provenance and supply chain
- **Use the standard attestation stack.** in-toto Statement plus DSSE, Sigstore keyless signing, Rekor log, SLSA VSA summary. Source: SLSA v1.2 [standard].
- **Check dependencies in the harness, not the model.**
  - Assistants checked provenance before installing in 0.5% of 1,920 trials. Source: arXiv 2609.07754 [PRE].
  - Package hallucination ran 19.7% (USENIX Security 2025 [PR]) and 4.6-6.1% on 2026 frontier models, with shared invented names across models (arXiv 2605.17062 [PRE]).

### 9. Autonomy governance
- **Tier auto-landing by risk.** Meta RADAR auto-lands 60% of eligible diffs with 1/3 the revert rate. The comparison is confounded by selection, since RADAR only takes low-risk diffs. Thresholds are set per organization. Source: arXiv 2605.30208 [PRE/industry].
- **Users grant more autonomy as trust grows.** Claude Code full auto-approve goes from about 20% of sessions for new users to over 40% for experienced ones. Source: Anthropic 2026 [VEN] (numbers from search summaries).
- **Autonomy levels framed by the human's role.** Source: arXiv 2506.12469 [PRE].

### 10. Agent security
- **Issue text is the main injection route.** In 86.5% of confirmed injection vulnerabilities in agentic CI workflows, the issue title or body was the source (496 confirmed, 343 zero-days). Source: arXiv 2605.07135 [PRE].
- **One payload hit three major agents.** It exfiltrated tokens from Claude Code Security Review, Gemini CLI Action and Copilot Agent. Source: "Comment and Control" [security research].
- **Rule of Two.** A session may hold at most two of: untrusted input, sensitive data, external side effects. Source: Meta 2025 [VEN].
- **Prompt and classifier defenses fail against adaptive attacks** (over 90% bypass). Architectural separation works: CaMeL. Source: arXiv 2503.18813 [PRE].
