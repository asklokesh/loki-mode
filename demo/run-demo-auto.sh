#!/usr/bin/env bash
# Loki Mode v5.42 Complete Demo - All features showcase
# Usage: ./demo/run-demo-auto.sh
# shellcheck disable=SC2034

set -euo pipefail

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Demo output helpers
banner() {
    echo ""
    echo -e "${CYAN}============================================================${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}============================================================${NC}"
    echo ""
    sleep 0.8
}

step() {
    echo -e "${GREEN}>>> $1${NC}"
    sleep 0.4
}

info() {
    echo -e "${BLUE}    $1${NC}"
    sleep 0.2
}

agent() {
    echo -e "${MAGENTA}    [$1]${NC} $2"
    sleep 0.2
}

pass() {
    echo -e "  $1  ${GREEN}$2${NC}"
    sleep 0.2
}

fail() {
    echo -e "  $1  ${RED}$2${NC}"
    sleep 0.2
}

dim() {
    echo -e "${DIM}$1${NC}"
    sleep 0.2
}

# Clear screen
clear

# ==============================================================
# PART 1: INTRO + CLI OVERVIEW
# ==============================================================
banner "LOKI MODE v5.42"
echo -e "${BOLD}Multi-Agent Autonomous System${NC}"
echo -e "${DIM}Claude Code | OpenAI Codex CLI | Cline | Aider${NC}"
echo ""
echo "PRD to Production -- Zero Human Intervention"
echo ""
sleep 1.5

# CLI Overview
banner "CLI COMMANDS"
echo -e "${BOLD}Installation:${NC}"
echo "  npm install -g loki-mode"
echo "  brew install asklokesh/tap/loki-mode"
echo "  docker pull asklokesh/loki-mode"
echo ""
sleep 1

echo -e "${BOLD}Core Commands:${NC}"
echo -e "  ${CYAN}loki start${NC} [prd.md]         Start autonomous session"
echo -e "  ${CYAN}loki quick${NC} \"task\"            Single-task mode (3 iter max)"
echo -e "  ${CYAN}loki stop${NC}                    Graceful shutdown"
echo -e "  ${CYAN}loki status${NC}                  Session status + progress"
echo -e "  ${CYAN}loki logs${NC}                    Live session logs"
echo ""
sleep 1

echo -e "${BOLD}Dashboard & Monitoring:${NC}"
echo -e "  ${CYAN}loki dashboard start${NC}         Web UI on port 57374"
echo -e "  ${CYAN}loki dashboard open${NC}          Open in browser"
echo -e "  ${CYAN}loki dashboard stop${NC}          Stop dashboard server"
echo ""
sleep 1

echo -e "${BOLD}Project Setup:${NC}"
echo -e "  ${CYAN}loki init${NC}                    Interactive PRD builder"
echo -e "  ${CYAN}loki init -t saas${NC}            From template (12 types)"
echo -e "  ${CYAN}loki demo${NC}                    60-second interactive demo"
echo -e "  ${CYAN}loki issue 42 --start${NC}        Build from GitHub issue"
echo ""
sleep 1

echo -e "${BOLD}Intelligence:${NC}"
echo -e "  ${CYAN}loki council${NC} status          Completion council verdicts"
echo -e "  ${CYAN}loki memory${NC} index            Memory system browser"
echo -e "  ${CYAN}loki audit${NC} log               Tamper-evident audit trail"
echo -e "  ${CYAN}loki checkpoint${NC} list         Git SHA-based checkpoints"
echo -e "  ${CYAN}loki github${NC} sync             Sync tasks to GitHub issues"
echo ""
sleep 1

echo -e "${BOLD}Operations:${NC}"
echo -e "  ${CYAN}loki config${NC} show             View/set configuration"
echo -e "  ${CYAN}loki doctor${NC}                  System health check"
echo -e "  ${CYAN}loki voice${NC}                   Voice input (Whisper/macOS)"
echo -e "  ${CYAN}loki version${NC}                 Version info"
echo ""
sleep 2

# ==============================================================
# PART 2: SESSION LIFECYCLE
# ==============================================================
banner "SESSION: loki start ./prd.md"
step "PRD: SaaS Invoice Manager"
echo ""
cat << 'EOF'
  Features:
    - Create/send invoices    - Multi-currency
    - Client management       - Recurring billing
    - Payment tracking        - PDF export
  Stack: Next.js 15, PostgreSQL, Prisma, Stripe, Tailwind
EOF
echo ""
sleep 1.5

step "Provider: Claude Code (full features)"
dim "  Alternatives: --provider codex | --provider cline | --provider aider"
echo ""
sleep 1

# Bootstrap
step "Phase: BOOTSTRAP"
echo "  .loki/ directory initialized"
echo "  Session PID: 48291 (locked)"
echo "  Dashboard: http://localhost:57374"
echo ""
sleep 1

# Branch Protection
step "Phase: BRANCH PROTECTION"
echo -e "  ${DIM}git checkout -b loki/invoice-manager${NC}"
info "Never commits directly to main"
echo ""
sleep 1

# Discovery
step "Phase: DISCOVERY"
echo "  Analyzing PRD..."
echo "  Tasks generated: 14"
echo "  Dependencies mapped: 8 edges"
echo "  Complexity: COMPLEX (8 phases)"
echo ""
sleep 1

# ==============================================================
# PART 3: AGENT ORCHESTRATION
# ==============================================================
banner "AGENT ORCHESTRATION (8 Parallel)"
echo ""
agent "SPAWN" "architect-001   (Opus)   System design"
agent "SPAWN" "backend-001     (Sonnet) API + database"
agent "SPAWN" "backend-002     (Sonnet) Stripe integration"
agent "SPAWN" "frontend-001    (Sonnet) UI components"
agent "SPAWN" "frontend-002    (Sonnet) Dashboard views"
agent "SPAWN" "qa-001          (Haiku)  Unit tests"
agent "SPAWN" "qa-002          (Haiku)  E2E / Playwright"
agent "SPAWN" "security-001    (Haiku)  Security scanning"
echo ""
info "Opus: architecture | Sonnet: implementation | Haiku: testing"
info "All agents run in parallel via Task tool"
echo ""
sleep 1.5

# Development RARV
step "RARV Cycle: Iteration 1/5"
dim "  Reason -> Act -> Reflect -> Verify"
echo ""
agent "architect-001" "Designing DB schema + API contracts..."
agent "architect-001" "DONE: Architecture doc written"
agent "backend-001" "Prisma models + migrations running..."
agent "backend-002" "Stripe SDK + webhooks wiring..."
agent "frontend-001" "Invoice form + table components..."
agent "backend-001" "DONE: 6 CRUD endpoints live"
agent "frontend-002" "Dashboard charts + analytics..."
agent "backend-002" "DONE: Stripe checkout + webhook handlers"
agent "qa-001" "47/47 unit tests passing"
agent "frontend-001" "DONE: Invoice UI with PDF preview"
agent "frontend-002" "DONE: Dashboard with revenue chart"
agent "security-001" "OWASP scan: 0 critical, 0 high"
echo ""
sleep 1.5

# ==============================================================
# PART 4: CODE REVIEW (Anti-Sycophancy)
# ==============================================================
banner "CODE REVIEW (Anti-Sycophancy)"
step "5 specialist reviewers (blind mode)..."
echo ""
echo -e "  ${MAGENTA}security-sentinel${NC}        Auth + Stripe webhooks"
echo -e "  ${MAGENTA}performance-oracle${NC}       DB queries + N+1 detection"
echo -e "  ${MAGENTA}architecture-strategist${NC}  Module boundaries"
echo -e "  ${MAGENTA}test-coverage-auditor${NC}    Coverage gaps"
echo -e "  ${MAGENTA}dependency-analyst${NC}       Supply chain + licenses"
echo ""
sleep 1

step "Blind Review Results:"
echo ""
echo -e "  security-sentinel:       ${GREEN}APPROVED${NC} (1 Med: add CSRF)"
echo -e "  performance-oracle:      ${GREEN}APPROVED${NC} (1 Low: add index)"
echo -e "  architecture-strategist: ${GREEN}APPROVED${NC}"
echo -e "  test-coverage-auditor:   ${GREEN}APPROVED${NC}"
echo -e "  dependency-analyst:      ${GREEN}APPROVED${NC}"
echo ""
sleep 1

step "Unanimous -- Devil's Advocate triggered..."
echo ""
echo -e "  ${YELLOW}CHALLENGE:${NC} Stripe webhook signature uses simple comparison."
echo "    Recommendation: use crypto.timingSafeEqual()"
echo ""
agent "backend-002" "Fix applied: constant-time comparison"
echo ""
info "Anti-sycophancy protocol caught a real timing attack vector"
echo ""
sleep 1.5

# ==============================================================
# PART 5: QUALITY GATES
# ==============================================================
banner "8-GATE QUALITY SYSTEM"
echo ""
pass "[1] Static Analysis" "ESLint 0 errors, TypeScript strict"
pass "[2] Test Suite" "68/68 passing"
pass "[3] Blind Code Review" "3/3 reviewers approved (Critical/High block)"
pass "[4] Anti-Sycophancy" "Devil's advocate re-review clean"
pass "[5] Mock Integrity" "No tautological assertions"
pass "[6] Test Mutation" "No assertion-churn detected"
pass "[7] Documentation Coverage" "README + API docs present"
pass "[8] Magic Modules Debate" "Spec-vs-impl debate clean"
echo ""
echo -e "  ${GREEN}ALL 8 GATES PASSED${NC}"
echo ""
sleep 1.5

# ==============================================================
# PART 6: CONTEXT + COST TRACKING
# ==============================================================
banner "CONTEXT WINDOW + COST TRACKING"
echo ""
echo "  Token Usage:"
echo -e "  ${DIM}[################----] 78% (156K / 200K)${NC}"
echo ""
echo "  Per-Iteration Breakdown:"
echo "  Iter 1:  Input 31,200  Output 12,400  Cost \$1.84"
echo "  Iter 2:  Input 28,600  Output 14,200  Cost \$2.12"
echo "  Iter 3:  Input 34,100  Output 11,800  Cost \$1.96"
echo "  Iter 4:  Input 29,800  Output 13,600  Cost \$2.08"
echo "  Iter 5:  Input 32,400  Output 10,200  Cost \$1.72"
echo -e "  ${DIM}──────────────────────────────────────${NC}"
echo "  Total:   Input 156,100 Output 62,200  Cost \$9.72"
echo ""
echo "  Compactions: 0 (context managed efficiently)"
echo ""
sleep 1.5

# ==============================================================
# PART 7: COMPLETION COUNCIL
# ==============================================================
banner "COMPLETION COUNCIL"
step "3 council members evaluating project..."
echo ""
echo -e "  ${MAGENTA}Member 1:${NC} VOTE: ${GREEN}COMPLETE${NC}"
echo "    All 14 tasks done. Stripe integrated. Tests green."
echo ""
echo -e "  ${MAGENTA}Member 2:${NC} VOTE: ${GREEN}COMPLETE${NC}"
echo "    PDF export verified. Multi-currency conversion works."
echo ""
echo -e "  ${MAGENTA}Member 3:${NC} VOTE: ${GREEN}COMPLETE${NC}"
echo "    E2E covers all user flows. No regressions."
echo ""
sleep 1

step "Convergence Detection:"
echo "  Git diff hash: a7f3c2e (stable across 2 iterations)"
echo "  No code changes between iter 4 and 5"
echo -e "  Verdict: ${GREEN}2/3 majority -- PROJECT COMPLETE${NC}"
echo ""
dim "  Circuit breaker: 5 no-progress iterations = auto-stop"
echo ""
sleep 1.5

# ==============================================================
# PART 8: MEMORY SYSTEM
# ==============================================================
banner "MEMORY SYSTEM (3 Layers)"
echo ""
echo -e "${BOLD}  Episodic Memory${NC} (this session):"
echo "    5 RARV iterations, 8 agent interactions"
echo "    Devil's advocate finding: timing attack on webhooks"
echo "    Checkpoint: git SHA a7f3c2e"
echo ""
echo -e "${BOLD}  Semantic Memory${NC} (cross-project patterns):"
echo "    - Stripe webhooks: always use timingSafeEqual()"
echo "    - Next.js API routes: validate body with Zod"
echo "    - Prisma: add indexes on all foreign keys"
echo "    - PDF gen: use @react-pdf/renderer for server-side"
echo ""
echo -e "${BOLD}  Procedural Memory${NC} (learned skills):"
echo "    stripe-integration    confidence: 0.92"
echo "    nextjs-api-patterns   confidence: 0.88"
echo "    prisma-migrations     confidence: 0.95"
echo "    playwright-e2e        confidence: 0.90"
echo ""
dim "  CLI: loki memory index | timeline | consolidate | retrieve"
echo ""
sleep 1.5

# ==============================================================
# PART 9: DASHBOARD
# ==============================================================
banner "REALTIME DASHBOARD (http://localhost:57374)"
echo ""
echo -e "${BOLD}  Sidebar Navigation:${NC}"
echo "    Overview | Task Queue | Logs | Agents"
echo "    Memory | Learning | Council | Cost"
echo ""
sleep 0.5

echo -e "${BOLD}  Overview Tab:${NC}"
echo "    Session: RUNNING | Phase: DEVELOPMENT"
echo "    Iteration: 5/5 | RARV: VERIFY"
echo "    +-----------+-----------+----------+-----------+"
echo "    | Tasks: 14 | Active: 3 | Done: 14 | Failed: 0 |"
echo "    +-----------+-----------+----------+-----------+"
echo ""
sleep 0.5

echo -e "${BOLD}  Task Queue (Kanban):${NC}"
echo "    PENDING [0]  |  IN PROGRESS [0]  |  REVIEW [0]  |  DONE [14]"
echo "    .............|...................|..............|............."
echo "                 |                   |              | Set up Next.js"
echo "                 |                   |              | Prisma schema"
echo "                 |                   |              | Invoice CRUD"
echo "                 |                   |              | Stripe payment"
echo "                 |                   |              | ... +10 more"
echo ""
sleep 0.5

echo -e "${BOLD}  Agent Cards:${NC}"
echo "    architect-001  [Opus]   IDLE    12 tasks   4m 12s"
echo "    backend-001    [Sonnet] IDLE     8 tasks   6m 44s"
echo "    backend-002    [Sonnet] IDLE     4 tasks   3m 28s"
echo "    frontend-001   [Sonnet] IDLE     6 tasks   5m 16s"
echo "    frontend-002   [Sonnet] IDLE     4 tasks   3m 52s"
echo "    qa-001         [Haiku]  IDLE    68 tests   2m 08s"
echo "    qa-002         [Haiku]  IDLE     8 tests   1m 44s"
echo "    security-001   [Haiku]  IDLE     1 scan    0m 48s"
echo ""
sleep 0.5

echo -e "${BOLD}  Cost Tab:${NC}"
echo "    Total Cost: \$9.72 | Budget: \$15.00 | Remaining: \$5.28"
echo "    +---------+---------+--------+"
echo "    | Iter 1  | Iter 2  | Iter 3 | ..."
echo "    | \$1.84   | \$2.12   | \$1.96  | ..."
echo "    +---------+---------+--------+"
echo ""
sleep 0.5

echo -e "${BOLD}  Council Tab:${NC}"
echo "    Decision Log | Convergence Graph | Agent Votes"
echo "    Verdict: COMPLETE (3/3 unanimous)"
echo "    Convergence: Stable at hash a7f3c2e"
echo ""
sleep 0.5

echo -e "${BOLD}  Learning Tab:${NC}"
echo "    Signals: 12 patterns learned this session"
echo "    Cross-project: 47 semantic patterns total"
echo "    Skills: 4 new procedural skills acquired"
echo ""
sleep 0.5

echo -e "${BOLD}  Logs Tab:${NC}"
echo "    Live streaming session output"
echo "    Filterable by: agent, phase, severity"
echo "    Searchable with regex"
echo ""
dim "  API: 19 REST endpoints | WebSocket live updates"
dim "  Prometheus: /metrics endpoint (9 metrics, Grafana-ready)"
dim "  TLS: --tls-cert/--tls-key | OIDC: SSO + RBAC"
echo ""
sleep 1.5

# ==============================================================
# PART 10: GITHUB SYNC + AUDIT
# ==============================================================
banner "GITHUB SYNC + AUDIT TRAIL"
echo ""
step "GitHub Sync-back:"
echo "  14 completed tasks -> 14 GitHub issues closed"
echo "  PR #42 created: loki/invoice-manager -> main"
echo "  Dedup log: .loki/github/synced.log"
echo ""
sleep 1

step "Audit Trail (tamper-evident):"
echo "  .loki/logs/agent-audit.jsonl"
echo "  SHA-256 chain hashing between entries"
echo "  12 audit events logged"
dim "  CLI: loki audit log | loki audit verify"
echo ""
sleep 1

step "Checkpoint System:"
echo "  Checkpoint at git SHA a7f3c2e"
echo "  CONTINUITY.md updated automatically"
dim "  CLI: loki checkpoint list | loki checkpoint restore <sha>"
echo ""
sleep 1.5

# ==============================================================
# PART 11: MULTI-PROVIDER
# ==============================================================
banner "MULTI-PROVIDER SUPPORT"
echo ""
echo "  +--------------------+----------+-----------+-----------+"
echo "  | Feature            | Claude   | Codex     | Cline     |"
echo "  +--------------------+----------+-----------+-----------+"
echo "  | Full features      | Yes      | Degraded  | Degraded  |"
echo "  | Parallel agents    | 10+      | No        | No        |"
echo "  | Task tool          | Yes      | No        | No        |"
echo "  | MCP integration    | Yes      | No        | No        |"
echo "  | Context window     | 200K     | 128K      | varies    |"
echo "  +--------------------+----------+-----------+-----------+"
echo ""
echo "  loki start ./prd.md --provider codex"
echo "  loki start ./prd.md --provider cline"
echo "  LOKI_PROVIDER=codex loki start ./prd.md"
echo ""
sleep 1.5

# ==============================================================
# PART 12: SESSION COMPLETE
# ==============================================================
banner "SESSION COMPLETE"
echo ""
echo -e "${GREEN}SaaS Invoice Manager -- Ready for Production${NC}"
echo ""
echo "  Files created:       67"
echo "  Tests passing:       88 (94% coverage)"
echo "  Agents used:         8 (parallel)"
echo "  RARV iterations:     5"
echo "  Quality gates:       7/7 passed"
echo "  Council verdict:     COMPLETE (3/3)"
echo "  Context used:        156K / 200K tokens"
echo "  Session cost:        \$9.72"
echo "  Time elapsed:        14m 28s"
echo "  Human intervention:  0"
echo ""
echo "  Dashboard:  http://localhost:57374"
echo "  GitHub PR:  https://github.com/user/invoice-app/pull/42"
echo "  Audit log:  .loki/logs/agent-audit.jsonl"
echo "  Memory:     .loki/memory/ (3 layers persisted)"
echo ""
sleep 1.5

echo -e "${BOLD}Loki Mode v5.42${NC} -- github.com/asklokesh/loki-mode"
echo ""
sleep 3
