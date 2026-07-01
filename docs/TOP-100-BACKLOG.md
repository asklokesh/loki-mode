# Loki + Autonomi: Top-100 Backlog (Master Plan)

Generated 2026-07-01 by the top100-backlog-enumeration ultracode workflow (7 agents, 116 raw items -> 100 ranked). North star: easiest to integrate with anyone; ranked by leverage toward zero-friction adoption, modularization, enterprise-grade, and scale.

## Themes
- Trust and correctness bugs (data-loss, cross-tenant, fake-green safety)
- Autonomi Verify productization (stub -> shipped: gate/council/cost/sign wiring)
- Zero-friction adoption (reduce user setup and error surface)
- Modularization (extract libraries, break monoliths, fix import boundaries)
- Enterprise-scale and multi-tenant (RBAC/SSO/persistence/sandbox, mostly founder-gated)
- autonomi-saas evidence and proof pipeline (receipt phases, correlation, worker cutover)
- CI, test, and distribution hardening (coverage, unreachable tests, publish gates)
- Runtime-agnostic and Bun migration (bash sunset, write-path port)

## Legend
- **gate**: autonomous (I execute) | founder-gated (prep to one-approval-away) | community
- **effort**: S/M/L/XL | **value**: critical/high/medium/low

## Full ranked list

| # | value | eff | gate | area | item |
|---|---|---|---|---|---|
| 1 | critical | S | autonomous | engine | run.sh self-delete EXIT trap nukes canonical source on LOKI_RUNNING_FROM_TEMP |
| 2 | critical | M | autonomous | saas | autonomi-saas proof correlation: cross-tenant leak + stuck-Building fix (per-build run_id) |
| 3 | critical | XL | founder-gated | verify | Verify: verifyCompletion() stub throws not-implemented (wire gate->integrity->council->cost->sign pipeline) |
| 4 | critical | M | founder-gated | verify | Verify: npm @autonomi/verify unpublishable (private:true, no exports/types/build, .ts bin, undeclared zod) |
| 5 | critical | S | founder-gated | saas | Verify: BUSL-1.1 vs open licensing undecided (blocks hosted/commercial launch) |
| 6 | critical | M | founder-gated | saas | Verify: hosted /verify REST API not deployed (Node entry + Dockerfile + serve script + persistent signing key) |
| 7 | critical | M | autonomous | modularization | Verify: extract verification-core library (port council_evidence_gate to TS) |
| 8 | critical | S | autonomous | verify | Verify: 5 deterministic gates parity with completion-council.sh (staged, verify + ship) |
| 9 | critical | S | autonomous | saas | autonomi-saas anti-fake-green safety: verdict strictly from engine honesty.headline (verify + guard) |
| 10 | critical | M | autonomous | saas | autonomi-saas VS-7 worker cutover: BFF enqueues, worker sole executor (verify live e2e) |
| 11 | high | M | founder-gated | verify | Signed neutral records on SDK/MCP path (verifyCompletion returns UNSIGNED_SENTINEL; only REST signs) |
| 12 | medium | S | autonomous | verify | Verify: fix embed import boundary (review/* drags LLM council into offline core; refresh regresses) |
| 13 | high | S | founder-gated | verify | Verify: resolve naming collision (loki-vaas vs loki-verify bin vs loki verify subcommand) |
| 14 | critical | L | founder-gated | engine | Sandbox backend implementation (createSandbox throws; choose gVisor/Firecracker/Kata) |
| 15 | critical | XL | founder-gated | enterprise | Enterprise RBAC / SSO / API-key auth / metering (hosted + on-prem control plane) |
| 16 | high | L | founder-gated | enterprise | On-prem persistence backend interface + first prod store (Postgres/SQLite) |
| 17 | high | S | autonomous | engine | base_unreachable signal in ObservedDiff (suppress empty_diff false-block once sandbox lands) |
| 18 | high | M | founder-gated | engine | Real Anthropic LLM provider wiring for production verify (council against live model) |
| 19 | high | M | founder-gated | verify | Verify: LLM council wired into default verdict path (module exists, verifyCompletion stub does not invoke) |
| 20 | high | S | autonomous | engine | Signed verification records + ed25519 audit trail (staged, verify + ship) |
| 21 | high | M | autonomous | verify | Golden-output conformance corpus for byte-identical CLI-invariance across implementations |
| 22 | high | M | autonomous | engine | Code review gate: run 3 parallel reviewers (currently single-reviewer path) |
| 23 | high | S | founder-gated | saas | HTTP /verify endpoint production wiring (handler complete, README lists as planned) |
| 24 | high | S | autonomous | saas | MCP verify tools (verify_completion, run_evidence_gate) wiring + distribution (staged) |
| 25 | high | M | community | test | Memory failure-loop (FAILURE_MEMORY) persistence bug (strict-xfail; recency read incomplete) |
| 26 | high | XL | autonomous | engine | Bun runtime Phase 2: migrate write-path commands (feat/bun-migration) |
| 27 | high | M | autonomous | cli | Bash runtime sunset (loki run-shell removal, Phase 6, after clean soak) |
| 28 | high | M | community | saas | autonomi-saas Evidence Receipt Phase 2: screenshot capture + BFF stream route (in progress) |
| 29 | high | M | community | saas | autonomi-saas Evidence Receipt Phase 3: test results from engine workspace |
| 30 | high | L | autonomous | saas | autonomi-saas Cost tab + budget-breaker UX (web + enforcement audit) |
| 31 | high | S | community | saas | autonomi-saas BFF overlays stored saas_evidence onto engine proof (verify) |
| 32 | medium | M | founder-gated | saas | E4 no-server run output capture for CLI/library builds (bounded inline + artifact) |
| 33 | high | M | autonomous | dashboard | Prompt Optimizer: wire real LLM-as-judge (currently heuristic-only) |
| 34 | high | M | community | engine | Cost-honesty check implementation (normalizeModel + quote==dispatched) |
| 35 | high | S | community | saas | POST /cost-honesty API handler (blocked on cost core) |
| 36 | critical | L | founder-gated | saas | Hosted metered runner with per-verification container sandbox |
| 37 | high | M | community | ci | CI parity-matrix flake root-cause (state cooldown after test-cli-commands.sh) |
| 38 | high | M | community | ci | Post-release smoke sign-off gate before npm/Docker go public |
| 39 | high | M | community | test | Document the 3 pre-existing failing shell tests (no public known-failures list) |
| 40 | medium | S | autonomous | dashboard | PR #178: dashboard memory summary reports 0 on JSON-backed projects |
| 41 | high | M | community | test | ARM64 runtime verification (emulation-only in CI; needs real Apple Silicon run) |
| 42 | high | XL | founder-gated | saas | Multi-tenant sandbox backend (gVisor/Firecracker/Kata) selection spike |
| 43 | critical | L | community | test | Real provider end-to-end tests (cost + secrets + duration make CI-unreachable) |
| 44 | high | XL | founder-gated | enterprise | Enterprise deploy: object-store sync + queue fleet modes + #691 --config loader |
| 45 | high | M | founder-gated | enterprise | Compliance scanner (loki-verify) converged as module in trust-layer SKU |
| 46 | high | L | founder-gated | saas | GitHub App verification integration (webhook wrapper, greenfield) |
| 47 | high | L | community | test | Long-duration stress tests (leak/queue-churn) unreachable in CI |
| 48 | medium | L | community | saas | autonomi-saas Evidence Receipt Phase 4: clip + full test-log streaming + build_artifacts table |
| 49 | high | XL | community | test | SWE-bench Pro 119 resume (paused 35/119) |
| 50 | medium | M | autonomous | engine | Multi-reviewer completion council option in hosted verify (council:true dropped today) |
| 51 | medium | M | autonomous | engine | Integrity detectors (mock-only, tautological, test-weakening) wired into evidence block |
| 52 | medium | S | community | test | Bun test coverage threshold enforcement on branches (70% baseline exists) |
| 53 | medium | L | autonomous | dashboard | Dashboard mid-run steering / builder control (mid-flight model switch exists, broader control deferred) |
| 54 | medium | S | community | test | Dashboard static-asset freshness gate in local-ci (like loki-ts/dist) |
| 55 | medium | L | community | test | Windows/WSL runtime verification (no Windows CI runner) |
| 56 | low | M | autonomous | cli | KPI reporting (loki report kpis) on bash legacy route (Bun-only today) |
| 57 | medium | M | autonomous | cli | Voice mode (Issue #85) |
| 58 | medium | M | community | test | Mutation testing (stryker) workflow re-enable + fix stale 5-provider assertions |
| 59 | medium | XL | founder-gated | engine | Managed Agents multiagent path (LOKI_EXPERIMENTAL_MANAGED_*, research preview) |
| 60 | low | M | autonomous | engine | Sentrux iteration-loop auto-gating (manual-only today) |
| 61 | medium | S | founder-gated | adoption | npm registry publish prep for @autonomi/verify SDK (distribution wiring) |
| 62 | low | M | founder-gated | adoption | Disclosed default-on PostHog telemetry (Phase L, blocked + deferred) |
| 63 | medium | S | community | saas | MCP check_cost_honesty tool registration (deferred until cost core lands) |
| 64 | medium | L | founder-gated | dashboard | Hosted dashboard with shareable verification badges |
| 65 | medium | M | founder-gated | adoption | MCP registry submission + Glama claim + awesome-list PRs |
| 66 | medium | M | autonomous | saas | autonomi-saas UI/UX pass: build-watching pane + finished cues from trust verdict |
| 67 | medium | XL | autonomous | dashboard | Server.py route modularization (~10K-line monolith, no domain separation) |
| 68 | medium | L | autonomous | dashboard | Large dashboard-ui components modularization (5 files 1K-1.9K lines) |
| 69 | medium | L | founder-gated | engine | Wave-13 deferred trust fixes + PRD-reuse spurious-update design fix |
| 70 | medium | M | community | dashboard | Dashboard dark-toggle iframe theme not following SPA (harness/product parity) |
| 71 | medium | M | community | ci | Sonnet-5 calibration follow-ups: test-verify --hosted + gate missing-tool handling |
| 72 | medium | S | community | ci | Integrity audit (SBOM/provenance) blocking on publish (currently informational) |
| 73 | medium | S | community | distribution | Python SDK version pre-check before publish (mismatch risk if publish fails post-tag) |
| 74 | medium | S | community | ci | Docker buildx early-detection for uncommitted loki-ts/dist (silent COPY failure risk) |
| 75 | medium | S | community | ci | loki-enterprise workflow enabled in main CI (dispatch-only today) |
| 76 | medium | S | community | distribution | Brew tap real-install verification on clean macOS host post-release |
| 77 | low | L | founder-gated | perf | Horizontal scaling / distributed rate-limit + persistence (in-memory today) |
| 78 | low | S | community | saas | Optional build_artifacts table for enumeration/lifecycle/reaping (deferred) |
| 79 | medium | S | community | saas | Headless browser (playwright-core) dep + Docker image size cap for screenshot capture |
| 80 | low | M | community | engine | Wave-8/9 deferred tail: spawn_timeout removal, heredoc guards, MED/LOW findings |
| 81 | medium | L | community | adoption | v7.19.1 traction: uncertainty-gated escalation + shareable proof + integrate 8 tutorials |
| 82 | medium | M | autonomous | verify | Benchmarks HumanEval/SWE-bench: publish results (runners + datasets exist) |
| 83 | low | S | autonomous | cli | loki run removal (deprecated alias for loki start, next major) |
| 84 | low | S | autonomous | cli | Fable model tier wiring (collapses to Opus until API-available) |
| 85 | low | S | community | distribution | Homepage/blog release update automation (Slack-notify-only today) |
| 86 | low | S | community | distribution | Wiki-sync scheduled trigger (manual/dispatch only, skips without API key) |
| 87 | low | L | autonomous | dashboard | Dashboard React app: implement four stub views (experimental app) |
| 88 | low | S | community | test | Embeddings edge-case tests run without numpy (skip today) |
| 89 | low | S | community | test | Hybrid-search test runs without chromadb skip |
| 90 | low | S | community | test | PID-recycling test platform-portability (ps lstart skip for pid 1) |
| 91 | low | S | community | test | Cloud integration tests (aider-cloud) run in a credentialed gated job |
| 92 | low | S | community | test | Sentrux real-binary nightly promoted from best-effort to tracked |
| 93 | low | S | community | test | Model-catalog probe: surface staleness in tests (issue-create skipped without admin scope) |
| 94 | low | S | community | test | Phase 6 readiness check re-enable (cron disabled; issues disabled on repo) |
| 95 | low | S | community | distribution | TS/Bun SDK (@loki-mode/sdk) discoverability from main package/docs |
| 96 | low | S | community | distribution | Docker Hub description update resilience (PAT scope failures non-blocking) |
| 97 | low | S | community | distribution | VS Code extension: keep source marked deprecated, not silently removed |
| 98 | low | S | autonomous | dashboard | Web-app docs: fill video placeholder (coming-soon text) |
| 99 | low | M | autonomous | cli | C# provider support (roslyn analyzers + dotnet build, deferred) |
| 100 | low | XL | founder-gated | engine | BMAD-METHOD v6 integration (net-new, needs founder planning) |
