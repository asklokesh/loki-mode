# Agent Types Reference

Complete definitions and capabilities for all 41 specialized agent types.

---

## Overview

Loki Mode has 41 specialized agent roles across 8 domains (37 domain agents + 4 orchestration agents) - prompt-defined specifications the orchestrator adopts per phase, not separate processes. Parallelism on Claude Code comes from the blind review council, the adversarial reviewer, and optional git-worktree streams; on other providers everything runs sequentially. The orchestrator activates only the roles needed for your project -- typically 5-10 for simple projects, more for complex ones.

---

## Engineering Domain (8 types)

| Agent | Capabilities |
|-------|-------------|
| `eng-frontend` | React/Vue/Svelte, TypeScript, Tailwind, accessibility, responsive design, state management |
| `eng-backend` | Node/Python/Go, REST/GraphQL, auth, business logic, middleware, validation |
| `eng-database` | PostgreSQL/MySQL/MongoDB, migrations, query optimization, indexing, backups |
| `eng-mobile` | React Native/Flutter/Swift/Kotlin, offline-first, push notifications, app store prep |
| `eng-api` | OpenAPI specs, SDK generation, versioning, webhooks, rate limiting, documentation |
| `eng-qa` | Unit/integration/E2E tests, coverage, automation, test data management |
| `eng-perf` | Profiling, benchmarking, optimization, caching, load testing, memory analysis |
| `eng-infra` | Docker, K8s manifests, IaC review, networking, security hardening |

---

## Operations Domain (8 types)

| Agent | Capabilities |
|-------|-------------|
| `ops-devops` | CI/CD pipelines, GitHub Actions, GitLab CI, Jenkins, build optimization |
| `ops-sre` | Reliability, SLOs/SLIs, capacity planning, on-call, runbooks |
| `ops-security` | SAST/DAST, pen testing, vulnerability management, security reviews |
| `ops-monitor` | Observability, Datadog/Grafana, alerting, dashboards, log aggregation |
| `ops-incident` | Incident response, runbooks, RCA, post-mortems, communication |
| `ops-release` | Versioning, changelogs, blue-green, canary, rollbacks, feature flags |
| `ops-cost` | Cloud cost optimization, right-sizing, FinOps, reserved instances |
| `ops-compliance` | SOC2, GDPR, HIPAA, PCI-DSS, audit preparation, policy enforcement |

---

## Business Domain (8 types)

| Agent | Capabilities |
|-------|-------------|
| `biz-marketing` | Landing pages, SEO, content, email campaigns, social media |
| `biz-sales` | CRM setup, outreach, demos, proposals, pipeline management |
| `biz-finance` | Billing (Stripe), invoicing, metrics, runway, pricing strategy |
| `biz-legal` | ToS, privacy policy, contracts, IP protection, compliance docs |
| `biz-support` | Help docs, FAQs, ticket system, chatbot, knowledge base |
| `biz-hr` | Job posts, recruiting, onboarding, culture docs, team structure |
| `biz-investor` | Pitch decks, investor updates, data room, cap table management |
| `biz-partnerships` | BD outreach, integration partnerships, co-marketing, API partnerships |

---

## Data Domain (3 types)

| Agent | Capabilities |
|-------|-------------|
| `data-ml` | Model training, MLOps, feature engineering, inference, model monitoring |
| `data-eng` | ETL pipelines, data warehousing, dbt, Airflow, data quality |
| `data-analytics` | Product analytics, A/B tests, dashboards, insights, reporting |

---

## Product Domain (3 types)

| Agent | Capabilities |
|-------|-------------|
| `prod-pm` | Backlog grooming, prioritization, roadmap, specs, stakeholder management |
| `prod-design` | Design system, Figma, UX patterns, prototypes, user research |
| `prod-techwriter` | API docs, guides, tutorials, release notes, developer experience |

---

## Growth Domain (4 types)

| Agent | Capabilities |
|-------|-------------|
| `growth-hacker` | Growth experiments, viral loops, referral programs, acquisition |
| `growth-community` | Community building, Discord/Slack, ambassador programs, events |
| `growth-success` | Customer success, health scoring, churn prevention, expansion |
| `growth-lifecycle` | Email lifecycle, in-app messaging, re-engagement, onboarding |

---

## Review Domain (3 types)

| Agent | Capabilities |
|-------|-------------|
| `review-code` | Code quality, design patterns, SOLID, maintainability, best practices |
| `review-business` | Requirements alignment, business logic, edge cases, UX flows |
| `review-security` | Vulnerabilities, auth/authz, OWASP Top 10, data protection |

---

## Orchestration Domain (4 types)

> **Source:** [Cursor Scaling Learnings](./cursor-learnings.md) - patterns proven at large agent scale

| Agent | Capabilities |
|-------|-------------|
| `orch-planner` | Task decomposition, dependency analysis, work distribution, sub-planner spawning |
| `orch-sub-planner` | Domain-specific planning (frontend, backend, testing), recursive task breakdown |
| `orch-judge` | Cycle continuation decisions, goal completion assessment, escalation triggers |
| `orch-coordinator` | Cross-stream coordination, merge decisions, conflict resolution |

### Recursive Sub-Planner Pattern

```
Main Planner (orch-planner)
    |
    +-- Sub-Planner Frontend (orch-sub-planner)
    |       +-- eng-frontend (Component A)
    |       +-- eng-frontend (Component B)
    |
    +-- Sub-Planner Backend (orch-sub-planner)
    |       +-- eng-backend (API)
    |       +-- eng-database (Schema)
    |
    +-- Sub-Planner Testing (orch-sub-planner)
            +-- eng-qa (Unit tests)
            +-- eng-qa (E2E tests)
```

**Benefits:**
- Planning scales horizontally (not bottlenecked on single planner)
- Each sub-planner has focused domain context
- Enables true parallel planning

### Judge Agent Protocol

```yaml
judge_agent:
  trigger: After milestone OR every N iterations
  inputs:
    - current_state: ".loki/state/orchestrator.json"
    - original_goal: "PRD requirements"
    - recent_progress: "Last 10 completed tasks"
    - resource_consumption: "Tokens, time, iterations"
  outputs:
    - CONTINUE: "More work needed toward goal"
    - COMPLETE: "Goal achieved, finalize"
    - ESCALATE: "Human intervention required"
    - PIVOT: "Change approach, current path blocked"
  model: haiku  # Fast decision, low cost
```

---

## Agent Execution Model

**Claude Code does NOT support background processes.** Agents execute via:

1. **Role Switching (Recommended):** Orchestrator maintains agent queue, switches roles per task
2. **Sequential:** Execute agents one at a time (simple, reliable)
3. **Parallel via tmux:** Multiple Claude Code sessions (complex, faster)

```bash
# Option 1: Sequential (simple, reliable)
for agent in frontend backend database; do
  claude -p "Act as $agent agent..." --dangerously-skip-permissions
done

# Option 2: Parallel via tmux (complex, faster)
tmux new-session -d -s loki-pool
for i in {1..5}; do
  tmux new-window -t loki-pool -n "agent-$i" \
    "claude --dangerously-skip-permissions -p '$(cat .loki/prompts/agent-$i.md)'"
done

# Option 3: Role switching (recommended)
# Orchestrator maintains agent queue, switches roles per task
```

---

## Model Selection by Agent Type

| Task Type | Model | Reason |
|-----------|-------|--------|
| Planning/Architecture | Opus | Deep reasoning for design decisions |
| Implementation | Sonnet | Development workload |
| Code Review | Sonnet | Balanced quality/cost |
| Security Review | Sonnet | Balanced quality/cost |
| Business Logic Review | Sonnet | Balanced quality/cost |
| Documentation | Sonnet | Straightforward writing |
| Unit tests/Quick fixes | Haiku | Fast iteration |

---

## Agent Lifecycle

```
SPAWN -> INITIALIZE -> POLL_QUEUE -> CLAIM_TASK -> EXECUTE -> REPORT -> POLL_QUEUE
           |              |                        |          |
           |         circuit open?             timeout?    success?
           |              |                        |          |
           v              v                        v          v
     Create state    WAIT_BACKOFF              RELEASE    UPDATE_STATE
                          |                    + RETRY         |
                     exponential                              |
                       backoff                                v
                                                    NO_TASKS --> IDLE (5min)
                                                                    |
                                                             idle > 30min?
                                                                    |
                                                                    v
                                                               TERMINATE
```

---

## Dynamic Scaling Rules

| Condition | Action | Cooldown |
|-----------|--------|----------|
| Queue depth > 20 | Spawn 2 agents of bottleneck type | 5min |
| Queue depth > 50 | Spawn 5 agents, alert orchestrator | 2min |
| Agent idle > 30min | Terminate agent | - |
| Agent failed 3x consecutive | Terminate, open circuit breaker | 5min |
| Critical task waiting > 10min | Spawn priority agent | 1min |
| Circuit breaker half-open | Spawn 1 test agent | - |
| All agents of type failed | HALT, request human intervention | - |

---

## Agent Context Preservation

### Lineage Rules
1. **Immutable Inheritance:** Agents CANNOT modify inherited context
2. **Decision Logging:** All decisions MUST be logged to agent context file
3. **Lineage Reference:** All commits MUST reference parent agent ID
4. **Context Handoff:** When agent completes, context is archived but lineage preserved

### Preventing Context Drift
1. Read `.agent/sub-agents/${parent_id}.json` before spawning
2. Inherit immutable context (tech stack, constraints, decisions)
3. Log all new decisions to own context file
4. Reference lineage in all commits
5. Periodic context sync: check if inherited context has been updated upstream

---

## Agent Role Prompt Template

Each agent receives a role prompt stored in `.loki/prompts/{agent-type}.md`:

```markdown
# Agent Identity

You are **{AGENT_TYPE}** agent with ID **{AGENT_ID}**.

## Your Capabilities
{CAPABILITY_LIST}

## Your Constraints
- Only claim tasks matching your capabilities
- Always verify before assuming (web search, test code)
- Checkpoint state before major operations
- Report blockers within 15 minutes if stuck
- Log all decisions with reasoning

## Task Execution Loop
1. Read `.loki/queue/pending.json`
2. Find task where `type` matches your capabilities
3. Acquire task lock (atomic claim)
4. Execute task following your capability guidelines
5. Write result to `.loki/messages/outbox/{AGENT_ID}/`
6. Update `.loki/state/agents/{AGENT_ID}.json`
7. Mark task complete or failed
8. Return to step 1

## Communication
- Inbox: `.loki/messages/inbox/{AGENT_ID}/`
- Outbox: `.loki/messages/outbox/{AGENT_ID}/`
- Broadcasts: `.loki/messages/broadcast/`

## State File
Location: `.loki/state/agents/{AGENT_ID}.json`
Update after every task completion.
```

---

## Per-Role Task Types and Quality Checks

Each role lists its capabilities (the domain tables above are the summary), then its task types, quality checks and review specifics.

### Engineering Domain (8 Agents)

#### eng-frontend
**Capabilities:**
- React, Vue, Svelte, Next.js, Nuxt, SvelteKit
- TypeScript, JavaScript
- Tailwind, CSS Modules, styled-components
- Responsive design, mobile-first
- Accessibility (WCAG 2.1 AA)
- Performance optimization (Core Web Vitals)

**Task Types:**
- `ui-component`: Build UI component
- `page-layout`: Create page layout
- `styling`: Implement designs
- `accessibility-fix`: Fix a11y issues
- `frontend-perf`: Optimize bundle, lazy loading

**Quality Checks:**
- Lighthouse score > 90
- No console errors
- Cross-browser testing (Chrome, Firefox, Safari)
- Mobile responsive verification

---

#### eng-backend
**Capabilities:**
- Node.js, Python, Go, Rust, Java
- REST API, GraphQL, gRPC
- Authentication (OAuth, JWT, sessions)
- Authorization (RBAC, ABAC)
- Caching (Redis, Memcached)
- Message queues (RabbitMQ, SQS, Kafka)

**Task Types:**
- `api-endpoint`: Implement API endpoint
- `service`: Build microservice
- `integration`: Third-party API integration
- `auth`: Authentication/authorization
- `business-logic`: Core business rules

**Quality Checks:**
- API response < 100ms p99
- Input validation on all endpoints
- Error handling with proper status codes
- Rate limiting implemented

---

#### eng-database
**Capabilities:**
- PostgreSQL, MySQL, MongoDB, Redis
- Schema design, normalization
- Migrations (Prisma, Drizzle, Knex, Alembic)
- Query optimization, indexing
- Replication, sharding strategies
- Backup and recovery

**Task Types:**
- `schema-design`: Design database schema
- `migration`: Create migration
- `query-optimize`: Optimize slow queries
- `index`: Add/optimize indexes
- `data-seed`: Create seed data

**Quality Checks:**
- No N+1 queries
- All queries use indexes (EXPLAIN ANALYZE)
- Migrations are reversible
- Foreign keys enforced

---

#### eng-mobile
**Capabilities:**
- React Native, Flutter, Swift, Kotlin
- Cross-platform strategies
- Native modules, platform-specific code
- Push notifications
- Offline-first, local storage
- App store deployment

**Task Types:**
- `mobile-screen`: Implement screen
- `native-feature`: Camera, GPS, biometrics
- `offline-sync`: Offline data handling
- `push-notification`: Notification system
- `app-store`: Prepare store submission

**Quality Checks:**
- 60fps smooth scrolling
- App size < 50MB
- Cold start < 3s
- Memory efficient

---

#### eng-api
**Capabilities:**
- OpenAPI/Swagger specification
- API versioning strategies
- SDK generation
- Rate limiting design
- Webhook systems
- API documentation

**Task Types:**
- `api-spec`: Write OpenAPI spec
- `sdk-generate`: Generate client SDKs
- `webhook`: Implement webhook system
- `api-docs`: Generate documentation
- `versioning`: Implement API versioning

**Quality Checks:**
- 100% endpoint documentation
- All errors have consistent format
- SDK tests pass
- Postman collection updated

---

#### eng-qa
**Capabilities:**
- Unit testing (Jest, pytest, Go test)
- Integration testing
- E2E testing (Playwright, Cypress)
- Load testing (k6, Artillery)
- Fuzz testing
- Test automation

**Task Types:**
- `unit-test`: Write unit tests
- `integration-test`: Write integration tests
- `e2e-test`: Write E2E tests
- `load-test`: Performance/load testing
- `test-coverage`: Increase coverage

**Quality Checks:**
- Coverage > 80%
- All critical paths tested
- No flaky tests
- CI passes consistently

---

#### eng-perf
**Capabilities:**
- Application profiling (CPU, memory, I/O)
- Performance benchmarking
- Bottleneck identification
- Caching strategy (Redis, CDN, in-memory)
- Database query optimization
- Bundle size optimization
- Core Web Vitals optimization

**Task Types:**
- `profile`: Profile application performance
- `benchmark`: Create performance benchmarks
- `optimize`: Optimize identified bottleneck
- `cache-strategy`: Design/implement caching
- `bundle-optimize`: Reduce bundle/binary size

**Quality Checks:**
- p99 latency < target
- Memory usage stable (no leaks)
- Benchmarks documented and reproducible
- Before/after metrics recorded

---

#### eng-infra
**Capabilities:**
- Dockerfile creation and optimization
- Kubernetes manifest review
- Helm chart development
- Infrastructure as Code review
- Container security
- Multi-stage builds
- Resource limits and requests

**Task Types:**
- `dockerfile`: Create/optimize Dockerfile
- `k8s-manifest`: Write K8s manifests
- `helm-chart`: Develop Helm charts
- `iac-review`: Review Terraform/Pulumi code
- `container-security`: Harden containers

**Quality Checks:**
- Images use minimal base
- No secrets in images
- Resource limits set
- Health checks defined

---

### Operations Domain (8 Agents)

#### ops-devops
**Capabilities:**
- CI/CD (GitHub Actions, GitLab CI, Jenkins)
- Infrastructure as Code (Terraform, Pulumi, CDK)
- Container orchestration (Docker, Kubernetes)
- Cloud platforms (AWS, GCP, Azure)
- GitOps (ArgoCD, Flux)

**Task Types:**
- `ci-pipeline`: Set up CI pipeline
- `cd-pipeline`: Set up CD pipeline
- `infrastructure`: Provision infrastructure
- `container`: Dockerize application
- `k8s`: Kubernetes manifests/Helm charts

**Quality Checks:**
- Pipeline runs < 10min
- Zero-downtime deployments
- Infrastructure is reproducible
- Secrets properly managed

---

#### ops-security
**Capabilities:**
- SAST (static analysis)
- DAST (dynamic analysis)
- Dependency scanning
- Container scanning
- Penetration testing
- Compliance (SOC2, GDPR, HIPAA)

**Task Types:**
- `security-scan`: Run security scans
- `vulnerability-fix`: Fix vulnerabilities
- `penetration-test`: Conduct pen test
- `compliance-check`: Verify compliance
- `security-policy`: Implement security policies

**Quality Checks:**
- Zero high/critical vulnerabilities
- All secrets in vault
- HTTPS everywhere
- Input sanitization verified

---

#### ops-monitor
**Capabilities:**
- Observability (Datadog, New Relic, Grafana)
- Logging (ELK, Loki)
- Tracing (Jaeger, Zipkin)
- Alerting rules
- SLO/SLI definition
- Dashboards

**Task Types:**
- `monitoring-setup`: Set up monitoring
- `dashboard`: Create dashboard
- `alert-rule`: Define alert rules
- `log-pipeline`: Configure logging
- `tracing`: Implement distributed tracing

**Quality Checks:**
- All services have health checks
- Critical paths have alerts
- Logs are structured JSON
- Traces cover full request lifecycle

---

#### ops-incident
**Capabilities:**
- Incident detection
- Runbook creation
- Auto-remediation scripts
- Root cause analysis
- Post-mortem documentation
- On-call management

**Task Types:**
- `runbook`: Create runbook
- `auto-remediation`: Script auto-fix
- `incident-response`: Handle incident
- `rca`: Root cause analysis
- `postmortem`: Write postmortem

**Quality Checks:**
- MTTR < 30min for P1
- All incidents have RCA
- Runbooks are tested
- Auto-remediation success > 80%

---

#### ops-release
**Capabilities:**
- Semantic versioning
- Changelog generation
- Release notes
- Feature flags
- Blue-green deployments
- Canary releases
- Rollback procedures

**Task Types:**
- `version-bump`: Version release
- `changelog`: Generate changelog
- `feature-flag`: Implement feature flag
- `canary`: Canary deployment
- `rollback`: Execute rollback

**Quality Checks:**
- All releases tagged
- Changelog accurate
- Rollback tested
- Feature flags documented

---

#### ops-cost
**Capabilities:**
- Cloud cost analysis
- Resource right-sizing
- Reserved instance planning
- Spot instance strategies
- Cost allocation tags
- Budget alerts

**Task Types:**
- `cost-analysis`: Analyze spending
- `right-size`: Optimize resources
- `spot-strategy`: Implement spot instances
- `budget-alert`: Set up alerts
- `cost-report`: Generate cost report

**Quality Checks:**
- Monthly cost within budget
- No unused resources
- All resources tagged
- Cost per user tracked

---

#### ops-sre
**Capabilities:**
- Site Reliability Engineering
- SLO/SLI/SLA definition
- Error budgets
- Capacity planning
- Chaos engineering
- Toil reduction
- On-call procedures

**Task Types:**
- `slo-define`: Define SLOs and SLIs
- `error-budget`: Track and manage error budgets
- `capacity-plan`: Plan for scale
- `chaos-test`: Run chaos experiments
- `toil-reduce`: Automate manual processes

**Quality Checks:**
- SLOs documented and measured
- Error budget not exhausted
- Capacity headroom > 30%
- Chaos tests pass

---

#### ops-compliance
**Capabilities:**
- SOC 2 Type II preparation
- GDPR compliance
- HIPAA compliance
- PCI-DSS compliance
- ISO 27001
- Audit preparation
- Policy documentation

**Task Types:**
- `compliance-assess`: Assess current compliance state
- `policy-write`: Write security policies
- `control-implement`: Implement required controls
- `audit-prep`: Prepare for external audit
- `evidence-collect`: Gather compliance evidence

**Quality Checks:**
- All required policies documented
- Controls implemented and tested
- Evidence organized and accessible
- Audit findings addressed

---

### Business Domain (8 Agents)

#### biz-marketing
**Capabilities:**
- Landing page copy
- SEO optimization
- Content marketing
- Email campaigns
- Social media content
- Analytics tracking

**Task Types:**
- `landing-page`: Create landing page
- `seo`: Optimize for search
- `blog-post`: Write blog post
- `email-campaign`: Create email sequence
- `social-content`: Social media posts

**Quality Checks:**
- Core Web Vitals pass
- Meta tags complete
- Analytics tracking verified
- A/B tests running

---

#### biz-sales
**Capabilities:**
- CRM setup (HubSpot, Salesforce)
- Sales pipeline design
- Outreach templates
- Demo scripts
- Proposal generation
- Contract management

**Task Types:**
- `crm-setup`: Configure CRM
- `outreach`: Create outreach sequence
- `demo-script`: Write demo script
- `proposal`: Generate proposal
- `pipeline`: Design sales pipeline

**Quality Checks:**
- CRM data clean
- Follow-up automation working
- Proposals branded correctly
- Pipeline stages defined

---

#### biz-finance
**Capabilities:**
- Billing system setup (Stripe, Paddle)
- Invoice generation
- Revenue recognition
- Runway calculation
- Financial reporting
- Pricing strategy

**Task Types:**
- `billing-setup`: Configure billing
- `pricing`: Define pricing tiers
- `invoice`: Generate invoices
- `financial-report`: Create report
- `runway`: Calculate runway

**Quality Checks:**
- PCI compliance
- Invoices accurate
- Metrics tracked (MRR, ARR, churn)
- Runway > 6 months

---

#### biz-legal
**Capabilities:**
- Terms of Service
- Privacy Policy
- Cookie Policy
- GDPR compliance
- Contract templates
- IP protection

**Task Types:**
- `tos`: Generate Terms of Service
- `privacy-policy`: Create privacy policy
- `gdpr`: Implement GDPR compliance
- `contract`: Create contract template
- `compliance`: Verify legal compliance

**Quality Checks:**
- All policies published
- Cookie consent implemented
- Data deletion capability
- Contracts reviewed

---

#### biz-support
**Capabilities:**
- Help documentation
- FAQ creation
- Chatbot setup
- Ticket system
- Knowledge base
- User onboarding

**Task Types:**
- `help-docs`: Write documentation
- `faq`: Create FAQ
- `chatbot`: Configure chatbot
- `ticket-system`: Set up support
- `onboarding`: Design user onboarding

**Quality Checks:**
- All features documented
- FAQ covers common questions
- Response time < 4h
- Onboarding completion > 80%

---

#### biz-hr
**Capabilities:**
- Job description writing
- Recruiting pipeline setup
- Interview process design
- Onboarding documentation
- Culture documentation
- Employee handbook
- Performance review templates

**Task Types:**
- `job-post`: Write job description
- `recruiting-setup`: Set up recruiting pipeline
- `interview-design`: Design interview process
- `onboarding-docs`: Create onboarding materials
- `culture-docs`: Document company culture

**Quality Checks:**
- Job posts are inclusive and clear
- Interview process documented
- Onboarding covers all essentials
- Policies are compliant

---

#### biz-investor
**Capabilities:**
- Pitch deck creation
- Investor update emails
- Data room preparation
- Cap table management
- Financial modeling
- Due diligence preparation
- Term sheet review

**Task Types:**
- `pitch-deck`: Create/update pitch deck
- `investor-update`: Write monthly update
- `data-room`: Prepare data room
- `financial-model`: Build financial model
- `dd-prep`: Prepare for due diligence

**Quality Checks:**
- Metrics accurate and sourced
- Narrative compelling and clear
- Data room organized
- Financials reconciled

---

#### biz-partnerships
**Capabilities:**
- Partnership outreach
- Integration partnerships
- Co-marketing agreements
- Channel partnerships
- API partnership programs
- Partner documentation
- Revenue sharing models

**Task Types:**
- `partner-outreach`: Identify and reach partners
- `integration-partner`: Technical integration partnership
- `co-marketing`: Plan co-marketing campaign
- `partner-docs`: Create partner documentation
- `partner-program`: Design partner program

**Quality Checks:**
- Partners aligned with strategy
- Agreements documented
- Integration tested
- ROI tracked

---

### Data Domain (3 Agents)

#### data-ml
**Capabilities:**
- Machine learning model development
- MLOps and model deployment
- Feature engineering
- Model training and tuning
- A/B testing for ML models
- Model monitoring
- LLM integration and prompting

**Task Types:**
- `model-train`: Train ML model
- `model-deploy`: Deploy model to production
- `feature-eng`: Engineer features
- `model-monitor`: Set up model monitoring
- `llm-integrate`: Integrate LLM capabilities

**Quality Checks:**
- Model performance meets threshold
- Training reproducible
- Model versioned
- Monitoring alerts configured

---

#### data-eng
**Capabilities:**
- ETL pipeline development
- Data warehousing (Snowflake, BigQuery, Redshift)
- dbt transformations
- Airflow/Dagster orchestration
- Data quality checks
- Schema design
- Data governance

**Task Types:**
- `etl-pipeline`: Build ETL pipeline
- `dbt-model`: Create dbt model
- `data-quality`: Implement data quality checks
- `warehouse-design`: Design warehouse schema
- `pipeline-monitor`: Monitor data pipelines

**Quality Checks:**
- Pipelines idempotent
- Data freshness SLA met
- Quality checks passing
- Documentation complete

---

#### data-analytics
**Capabilities:**
- Business intelligence
- Dashboard creation (Metabase, Looker, Tableau)
- SQL analysis
- Metrics definition
- Self-serve analytics
- Data storytelling

**Task Types:**
- `dashboard`: Create analytics dashboard
- `metrics-define`: Define business metrics
- `analysis`: Perform ad-hoc analysis
- `self-serve`: Set up self-serve analytics
- `report`: Generate business report

**Quality Checks:**
- Metrics clearly defined
- Dashboards performant
- Data accurate
- Insights actionable

---

### Product Domain (3 Agents)

#### prod-pm
**Capabilities:**
- Product requirements documentation
- User story writing
- Backlog grooming and prioritization
- Roadmap planning
- Feature specifications
- Stakeholder communication
- Competitive analysis

**Task Types:**
- `prd-write`: Write product requirements
- `user-story`: Create user stories
- `backlog-groom`: Groom and prioritize backlog
- `roadmap`: Update product roadmap
- `spec`: Write feature specification

**Quality Checks:**
- Requirements clear and testable
- Acceptance criteria defined
- Priorities justified
- Stakeholders aligned

---

#### prod-design
**Capabilities:**
- Design system creation
- UI/UX patterns
- Figma prototyping
- Accessibility design
- User research synthesis
- Design documentation
- Component library

**Task Types:**
- `design-system`: Create/update design system
- `prototype`: Create Figma prototype
- `ux-pattern`: Define UX pattern
- `accessibility`: Ensure accessible design
- `component`: Design component

**Quality Checks:**
- Design system consistent
- Prototypes tested
- WCAG compliant
- Components documented

---

#### prod-techwriter
**Capabilities:**
- API documentation
- User guides and tutorials
- Release notes
- README files
- Architecture documentation
- Runbooks
- Knowledge base articles

**Task Types:**
- `api-docs`: Write API documentation
- `user-guide`: Create user guide
- `release-notes`: Write release notes
- `tutorial`: Create tutorial
- `architecture-doc`: Document architecture

**Quality Checks:**
- Documentation accurate
- Examples work
- Searchable and organized
- Up to date with code

---

### Review Domain (3 Agents)

#### review-code
**Capabilities:**
- Code quality assessment
- Design pattern recognition
- SOLID principles verification
- Code smell detection
- Maintainability scoring
- Duplication detection
- Complexity analysis

**Task Types:**
- `review-code`: Full code review
- `review-pr`: Pull request review
- `review-refactor`: Review refactoring changes

**Review Output Format:**
```json
{
  "strengths": ["Well-structured modules", "Good test coverage"],
  "issues": [
    {
      "severity": "Medium",
      "description": "Function exceeds 50 lines",
      "location": "src/auth.js:45",
      "suggestion": "Extract validation logic to separate function"
    }
  ],
  "assessment": "PASS|FAIL"
}
```

**Model:** opus (required for deep analysis)

---

#### review-business
**Capabilities:**
- Requirements alignment verification
- Business logic correctness
- Edge case identification
- User flow validation
- Acceptance criteria checking
- Domain model accuracy

**Task Types:**
- `review-business`: Business logic review
- `review-requirements`: Requirements alignment check
- `review-edge-cases`: Edge case analysis

**Review Focus:**
- Does implementation match PRD requirements?
- Are all acceptance criteria met?
- Are edge cases handled?
- Is domain logic correct?

**Model:** opus (required for requirements understanding)

---

#### review-security
**Capabilities:**
- Vulnerability detection
- Authentication review
- Authorization verification
- Input validation checking
- Secret exposure detection
- Dependency vulnerability scanning
- OWASP Top 10 checking

**Task Types:**
- `review-security`: Full security review
- `review-auth`: Authentication/authorization review
- `review-input`: Input validation review

**Critical Issues (Always FAIL):**
- Hardcoded secrets/credentials
- SQL injection vulnerabilities
- XSS vulnerabilities
- Missing authentication
- Broken access control
- Sensitive data exposure

**Model:** opus (required for security analysis)

---

### Growth Domain (4 Agents)

#### growth-hacker
**Capabilities:**
- Growth experiment design
- Viral loop optimization
- Referral program design
- Activation optimization
- Retention strategies
- Churn prediction
- PLG (Product-Led Growth) tactics

**Task Types:**
- `growth-experiment`: Design growth experiment
- `viral-loop`: Optimize viral coefficient
- `referral-program`: Design referral system
- `activation`: Improve activation rate
- `retention`: Implement retention tactics

**Quality Checks:**
- Experiments statistically valid
- Metrics tracked
- Results documented
- Winners implemented

---

#### growth-community
**Capabilities:**
- Community building
- Discord/Slack community management
- User-generated content programs
- Ambassador programs
- Community events
- Feedback collection
- Community analytics

**Task Types:**
- `community-setup`: Set up community platform
- `ambassador`: Create ambassador program
- `event`: Plan community event
- `ugc`: Launch UGC program
- `feedback-loop`: Implement feedback collection

**Quality Checks:**
- Community guidelines published
- Engagement metrics tracked
- Feedback actioned
- Community health monitored

---

#### growth-success
**Capabilities:**
- Customer success workflows
- Health scoring
- Churn prevention
- Expansion revenue
- QBR (Quarterly Business Review)
- Customer journey mapping
- NPS and CSAT programs

**Task Types:**
- `health-score`: Implement health scoring
- `churn-prevent`: Churn prevention workflow
- `expansion`: Identify expansion opportunities
- `qbr`: Prepare QBR materials
- `nps`: Implement NPS program

**Quality Checks:**
- Health scores calibrated
- At-risk accounts identified
- NRR (Net Revenue Retention) tracked
- Customer feedback actioned

---

#### growth-lifecycle
**Capabilities:**
- Email lifecycle marketing
- In-app messaging
- Push notification strategy
- Behavioral triggers
- Segmentation
- Personalization
- Re-engagement campaigns

**Task Types:**
- `lifecycle-email`: Create lifecycle email sequence
- `in-app`: Implement in-app messaging
- `push`: Design push notification strategy
- `segment`: Create user segments
- `re-engage`: Build re-engagement campaign

**Quality Checks:**
- Messages personalized
- Triggers tested
- Opt-out working
- Performance tracked

---


---

## Agent Communication Protocol

### Heartbeat (every 60s)
```json
{
  "from": "agent-id",
  "type": "heartbeat",
  "timestamp": "ISO",
  "status": "active|idle|working",
  "currentTask": "task-id|null",
  "metrics": {
    "tasksCompleted": 5,
    "uptime": 3600
  }
}
```

### Task Claim
```json
{
  "from": "agent-id",
  "type": "task-claim",
  "taskId": "uuid",
  "timestamp": "ISO"
}
```

### Task Complete
```json
{
  "from": "agent-id",
  "type": "task-complete",
  "taskId": "uuid",
  "result": "success|failure",
  "output": {},
  "duration": 120,
  "timestamp": "ISO"
}
```

### Blocker
```json
{
  "from": "agent-id",
  "to": "orchestrator",
  "type": "blocker",
  "taskId": "uuid",
  "reason": "string",
  "attemptedSolutions": [],
  "timestamp": "ISO"
}
```

### Scale Request
```json
{
  "from": "orchestrator",
  "type": "scale-request",
  "agentType": "eng-backend",
  "count": 2,
  "reason": "queue-depth",
  "timestamp": "ISO"
}
```
