# Show HN Post Draft

## Title

Show HN: Loki Mode - PRD in, tested code out (41 agent roles, 8 quality gates, RARV self-verification)

## Body

I built Loki Mode because I got tired of the copy-paste loop between AI coding assistants and my terminal. I wanted to hand over a PRD and get back a working, tested codebase -- not perfect, but a solid starting point.

**What it does:** You give it a Product Requirements Document. It breaks the work into tasks across 41 specialized agent roles organized into 8 domains (engineering, operations, business, data, product, growth, review, orchestration) -- prompt-defined specifications the orchestrator adopts per phase, with parallel review (blind council) and optional worktree streams on Claude Code, sequential on other providers -- and runs every iteration through a self-verification loop called RARV: Reason, Act, Reflect, Verify. The idea is that the system catches its own mistakes before you have to.

**Quality gates:** 9 automated gates including 3-reviewer blind review (agents review each other's work without seeing prior reviews), anti-sycophancy checks (a devil's advocate pass on unanimous approvals), and mock/mutation detection. These are not foolproof, but they catch a surprising number of issues that single-pass generation misses.

**Multi-provider:** Runs on Claude Code (full parallel agent support), OpenAI Codex CLI, or Google Gemini CLI. Codex and Gemini run in degraded sequential mode -- no parallel agents, no Task tool. Claude Code is the primary target.

**Memory:** 3-tier system (episodic, semantic, procedural) so the system can learn from previous runs. Optional vector search with sentence-transformers if you want similarity-based retrieval.

**Enterprise features:** TLS, OIDC/SSO, RBAC, OTEL tracing, policy engine, audit trails. All behind env vars. Certs are self-signed only. Dashboard runs on a single machine at port 57374.

**Research foundation:** The architecture draws from Anthropic's Constitutional AI (principles-based self-critique), DeepMind's Scalable Oversight via Debate, and OpenAI's Agents SDK patterns (guardrails, tripwires, handoffs). References to specific papers are in the repo.

**What it does NOT do:** It does not deploy anything. It generates deployment configs (Helm, Docker Compose, Terraform), but a human deploys. Complex domain logic will need human review. The system can and does make mistakes, especially on novel problems. Token costs scale with project complexity. Our SWE-bench numbers (299/300 patches generated) measure output, not resolution -- the official evaluator has not been run, so the actual fix rate is unknown and likely significantly lower than the generation rate. The HumanEval score is self-reported with max 3 retries per problem.

**Test suite:** 683 npm tests, 631 pytest tests, 16 shell tests. Self-reported HumanEval score of 162/164 (98.78%).

Built solo. MIT licensed.

## Try it

```bash
npm install -g loki-mode
claude --dangerously-skip-permissions
# Then say: "Loki Mode with PRD at path/to/your-prd.md"
```

Python SDK: `pip install loki-mode-sdk`. TypeScript SDK: `npm install loki-mode-sdk` (available in the repo at `sdk/typescript/`).

Integrations: Jira, Slack, Teams, GitHub Actions.

## Feedback wanted

- Is the 8-gate quality system overkill, or does it actually help for your use cases?
- How do you handle the tension between autonomous agent speed and code review thoroughness?
- What PRD complexity level breaks this approach? I have hit walls with highly coupled distributed systems.

GitHub: https://github.com/asklokesh/loki-mode
