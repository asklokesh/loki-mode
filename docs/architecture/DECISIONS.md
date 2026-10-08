# Architectural Decision Records

This document records the significant architectural decisions for **loki-mode**,
an autonomous spec-to-product system. Each record captures the context in which
a decision was made, the decision itself, and the consequences that follow.

Decisions are listed newest-first by ADR number. A decision marked **Superseded**
remains for historical reference; the record that replaces it is named inline.

For the detailed runtime-migration record, see
`docs/architecture/ADR-001-runtime-migration.md`. The summary below mirrors its
high-level conclusions.

---

## ADR-001: Migrate the orchestrator runtime from bash to Bun/TypeScript

**Status:** Accepted (phased; bash sunset gated on a clean soak)

### Context

The original orchestrator was implemented as two very large bash programs:
`autonomy/run.sh` (the RARV-C iteration loop) and `autonomy/loki` (the CLI, with
100+ command handlers). At over 10,000 lines each they were untyped, fragile,
and hard to refactor or test. As the product grew, the cost of changing core
control flow in bash kept rising, and the lack of static typing meant defects
surfaced only at runtime in users' terminals.

### Decision

Port the orchestrator and CLI to TypeScript running on Bun (`loki-ts/`). Ship the
migration in phases (scaffold, read-only commands, build tooling, outer loop,
council and code review, then bash sunset) rather than as a single rewrite. A
`bin/loki` shim routes ported commands to the Bun CLI and falls through to the
bash implementation for the rest. `LOKI_LEGACY_BASH=1` forces the bash route as a
rollback escape hatch.

### Consequences

- Both runtimes coexist during the migration, so every behavior must be verified
  for cross-route parity. A dedicated parity matrix in CI guards against drift.
- New work lands in typed TypeScript with `bun test` coverage; the bash code is
  frozen and only patched for parity.
- The final phase (deleting `run.sh` and `autonomy/loki`, removing the legacy
  flag) is deliberately gated behind a multi-week clean soak with zero parity
  regressions, rather than shipped on a date.
- Carrying two implementations is real maintenance overhead until sunset, traded
  for a safe, reversible rollout.

---

## ADR-002: Provider-agnostic execution with automatic failover

**Status:** Accepted

### Context

Tying the system to a single AI vendor would be a hard dependency and a single
point of failure. Users run different coding agents (Claude Code, OpenAI Codex
CLI, Cline, Aider) with different capabilities, and the product positioning
("no vendor lock-in") requires running on more than one.

### Decision

Abstract provider invocation behind shell-sourceable provider configs
(`providers/*.sh`) and a TypeScript provider layer
(`loki-ts/src/runner/providers.ts`), classified by capability tier:

- **Claude Code (Tier 1):** full features (subagents, parallelism, Task tool, MCP).
- **Cline (Tier 2):** reduced parallelism.
- **OpenAI Codex CLI and Aider (Tier 3):** degraded mode (sequential, no Task tool).

The orchestrator adapts its strategy to the active provider's tier and fails over
automatically. Google Gemini CLI was deprecated (v7.5.18) after upstream
deprecation; selecting it exits with a migration message.

### Consequences

- Features must degrade gracefully: anything Tier 1 specific cannot be assumed
  available, so the loop checks capability before using it.
- Adding a provider means adding a config plus tier mapping, not rewriting the loop.
- The capability matrix is a permanent part of the design and must be kept honest;
  a provider listed at a tier it cannot meet would break runs silently.

---

## ADR-003: Verified completion via the RARV-C closure loop and an Evidence Receipt

**Status:** Accepted

### Context

Most coding agents declare a task "done" by narrating it in a transcript, which
is unverifiable. The product's core differentiator is trust: "done" must mean
proven, not promised. An agent that lies about completion (empty diffs, failing
tests reported green) destroys user confidence and word-of-mouth.

### Decision

Every iteration runs the RARV-C cycle (Reason, Act, Reflect, Verify, Close).
Completion is decided by deterministic, re-derivable facts rather than the
agent's own claim:

- An empty git diff against the run-start commit cannot be reported as done.
- Red tests block completion.
- Each build produces an **Evidence Receipt** separating **Facts** (diff SHAs,
  file counts, test command and exit code, build command and exit code, gate
  verdicts) from **Assessments** (AI judgments such as the review council).
- The receipt headline (VERIFIED / VERIFIED WITH GAPS / NOT VERIFIED) is computed
  only from the facts; gaps are always listed by name so silence never reads as a
  pass.

### Consequences

- Completion logic must stay deterministic and independently re-checkable; LLM
  judgment can inform but never make the headline green on its own.
- `loki verify` exposes the same gates as a standalone, CI-ready check with
  machine-readable evidence and meaningful exit codes.
- The system will sometimes refuse to call work "done" that a user feels is done;
  this friction is intentional and is the product's main promise.

---

## ADR-004: Quality enforced by 8 gates and a blind multi-reviewer council

**Status:** Accepted

### Context

Autonomous code generation without enforcement produces plausible-looking but
incorrect output. A single reviewer (human or model) is prone to sycophancy and
blind spots. Quality has to be enforced mechanically and from independent angles,
not trusted.

### Decision

Run 8 quality gates (static analysis, test pass/fail, blind 3-reviewer code
review with severity blocking, anti-sycophancy / devil's advocate, mock-integrity
detection, test-mutation detection, documentation coverage, magic-modules debate)
plus a conditional legacy-healing auditor. Code review uses three independent
reviewers whose verdicts must reconcile; Critical/High findings block, Medium/Low
are advisory. An override council can revisit a BLOCK only when backed by a
non-empty evidence artifact.

### Consequences

- A red gate stops the release; "2-of-3 is good enough" is explicitly not
  acceptable for the council, which loops until unanimous.
- Gates add latency and token cost to every iteration, accepted as the price of
  trustworthy output.
- Each gate's blocking semantics must be precise; an over-eager gate that fires on
  unrelated changes (as the legacy-healing auditor once did) erodes signal and was
  scoped to fire only on healing-mode work.

---

## ADR-005: File-based memory in `.loki/` as the system's source of truth

**Status:** Accepted

### Context

The orchestrator, dashboard, MCP server, and quality gates are separate processes
(and separate runtimes: bash, TypeScript, Python). They need shared, durable state
that survives crashes and resumes, without forcing an external database as a
prerequisite for a local-first tool.

### Decision

All components communicate through filesystem state under `.loki/` (memory,
session, queue, checkpoints, findings, healing artifacts). Memory is a layered
Python package (`memory/`) with episodic, semantic, and procedural stores,
progressive-disclosure loading, optional vector search, and cross-project recall.
A unified event bus (`events/`) provides Python, TypeScript, and bash emitters
over the same conventions.

### Consequences

- Any process can read or resume from disk; runs survive restarts and pod loss.
- Concurrent writers must coordinate via file locking; lost-update and inode races
  here have been recurring, high-severity bug classes that demand careful locking
  and tests.
- No database is required to run locally, preserving the self-hosted, private,
  zero-egress posture; external stores (e.g. ChromaDB, object storage) are optional
  add-ons, not dependencies.

---

## ADR-006: Polyglot stack (Bun/TypeScript, Python, bash) over a single language

**Status:** Accepted

### Context

The system spans distinct concerns: orchestration control flow, a web dashboard
API, a memory engine with embeddings, an MCP server, and provider shims. No single
language is the best fit for all of them, and parts predate the Bun migration.

### Decision

Use the right tool per concern: Bun/TypeScript for the orchestrator, CLI, and HTTP
API (`loki-ts/`, `api/`); Python for the memory engine, MCP server, and FastAPI
dashboard (`memory/`, `mcp/`, `dashboard/`); bash for provider configs, hooks, and
the legacy runtime during migration. Node.js 20+ is the minimum engine; the npm
package ships zero runtime dependencies in `package.json`.

### Consequences

- Contributors need familiarity with more than one ecosystem, and CI must run a
  matrix across runtimes (bun typecheck/test, Python syntax, shellcheck, parity).
- Cross-language contracts (the `.loki/` state files, the event bus) must be kept
  in sync across three emitter implementations.
- Boundaries stay clean because each component owns its language; the cost is more
  build and test tooling, mitigated by the local CI gate.

---

## ADR-007: Distribute across npm, Docker, and Homebrew from a single release pipeline

**Status:** Accepted

### Context

Users install via different channels (npm global, Docker, Homebrew), and the
dashboard frontend and Python modules must be present and working in each. Past
releases shipped broken because local testing did not verify the published
tarball or a fresh global install.

### Decision

A single GitHub Actions release workflow creates the tag and GitHub Release, then
publishes to npm, builds and pushes a multi-arch (amd64 + arm64) Docker image, and
updates the Homebrew tap. Every release is preceded by a mandatory local CI gate
(`scripts/local-ci.sh`) that mirrors every CI workflow, plus pre-publish
validation that inspects the npm tarball contents and performs a fresh global
install smoke test. Versions are kept in sync across all manifests and Dockerfiles.

### Consequences

- The local Mac is the canonical pre-push gate; GitHub Actions is the verifier, not
  the place defects are discovered.
- The dashboard frontend must be rebuilt and committed before release, and the
  built artifacts must be tracked in git so every channel includes them.
- A single broken artifact can affect all channels at once, so the validation
  checklist is non-negotiable per release.

---

## ADR-008: Source-available under BUSL-1.1 with a separate commercial brand

**Status:** Accepted

### Context

The project needs broad adoption and community trust (which favors open source)
while leaving room for a sustainable commercial business and protection against
hosted-competitor free-riding.

### Decision

License the source under the Business Source License 1.1: free for personal,
internal, and academic use, source-available, with commercial hosted/team
editions sold under the separate **Autonomi** brand (Autonomi Cloud, Autonomi
Enterprise). The same Loki CLI, SDK, and MCP are available to everyone.

### Consequences

- BUSL-1.1 is not OSI-approved "open source"; the project consistently uses the
  term "source-available" to avoid misleading users.
- Contributions require a CLA (`CLA.md`), adding friction for contributors in
  exchange for a clear commercial path.
- The open core and commercial editions must stay aligned on the core surface so
  the free tier remains genuinely useful, not a crippled demo.

---

## ADR-009: Model selection tiered by task, with deterministic auto-selection

**Status:** Accepted

### Context

Using the most capable (and expensive) model for every task wastes budget; using
a weak model for architecture produces poor results. Forcing the user to choose a
model per task is friction and contradicts the autonomy goal.

### Decision

Map task type to model tier: Opus for planning and architecture, Sonnet for
development and functional testing, Haiku for unit tests, monitoring, and simple
parallelizable work. The tier is auto-selected from task signals
(`run.sh:get_rarv_tier()`, `detect_complexity()`) rather than asked of the user;
model levers (session pin, mid-flight override, ceiling) exist as opt-out escape
hatches, and the cost quote, dashboard, and dispatched model always agree.

### Consequences

- Cost scales with task difficulty automatically, and parallel cheap-model work is
  encouraged for throughput.
- Selection must be deterministic and honest: the quoted plan cost and the actual
  dispatch must never diverge, including ceiling-enforcement and tier-collapse
  paths (e.g. an unavailable Fable tier collapsing to Opus).
- Adding or retiring a model means updating the registry and the auto-select
  heuristic together, or quotes drift from reality.

---

## ADR-010: Progressive-disclosure skill architecture for the agent context

**Status:** Accepted

### Context

Loading the full body of operational guidance (quality gates, healing, testing,
agent types, provider docs, advanced patterns) into every agent invocation would
waste context budget and dilute the signal. But the guidance still needs to be
available on demand.

### Decision

Keep `SKILL.md` slim (a few hundred lines) and split detailed guidance into
on-demand modules under `skills/`, with an index (`skills/00-index.md`) that routes
to the right module, and deeper reference material under `references/`. Modules are
pulled in only when relevant to the current task.

### Consequences

- Context stays focused and cheaper per iteration; agents read only what the task
  needs.
- The routing index and module boundaries must be maintained, or guidance becomes
  hard to find and modules drift out of sync with the code they describe.
- `SKILL.md` has a hard size budget; detailed content belongs in modules, not
  inlined, which is enforced as a contribution rule.
