# Answer Key

This file contains answers for all module quizzes and the final certification exam.

---

## Module 1: Core Concepts Quiz

| Question | Answer | Explanation |
|----------|--------|-------------|
| 1 | B | RARV = Reason, Act, Reflect, Verify |
| 2 | C | 41 agent types: 37 domain + 4 orchestration |
| 3 | B | After 5 failures, the task moves to `.loki/queue/dead-letter.json` |
| 4 | C | architecture-strategist is always one of the 3 selected reviewers |
| 5 | D | 8 quality gates (Static Analysis through Magic Modules Debate); backward-compatibility is a conditional healing-mode auditor, not one of the 8 |
| 6 | B | Episodic, semantic, and procedural memory |
| 7 | B | Simple tier uses 3 phases |
| 8 | C | Gate 7 (Documentation Coverage) checks README presence, docs freshness within 10 commits, and API docs for packages; coverage % is not measured this release |
| 9 | C | Claude Code supports full features; Codex and Gemini run in degraded mode |
| 10 | B | If all 3 reviewers unanimously approve, a Devil's Advocate reviewer runs |

---

## Module 2: Enterprise Features Quiz

| Question | Answer | Explanation |
|----------|--------|-------------|
| 1 | A | Audit logging is enabled by default since v5.38.0 |
| 2 | C | OTEL activates when `LOKI_OTEL_ENDPOINT` is set to an OTLP endpoint |
| 3 | C | Default dashboard port is 57374 |
| 4 | A | `LOKI_ENTERPRISE_AUTH=true` enables token authentication |
| 5 | D | Syslog supports UDP and TCP via `LOKI_AUDIT_SYSLOG_PROTO` |
| 6 | D | Without the endpoint set, OTEL uses no-op stubs with zero overhead |
| 7 | A | `loki enterprise token generate my-token` creates an API token |
| 8 | D | Set `LOKI_TLS_CERT` and `LOKI_TLS_KEY` to PEM file paths |
| 9 | A | Controls whether `HUMAN_INPUT.md` can inject directives (disabled by default for security) |
| 10 | A | `loki enterprise status` shows all enterprise feature states |

---

## Module 3: Advanced Patterns Quiz

| Question | Answer | Explanation |
|----------|--------|-------------|
| 1 | B | Goal, Constraints, Context, Output (documented in `skills/agents.md`) |
| 2 | D | Confidence below 0.40 triggers human decision flag |
| 3 | C | Each verification runs independently without seeing the original response |
| 4 | A | security-sentinel > test-coverage-auditor > performance-oracle > dependency-analyst |
| 5 | A | Prevents "technically correct but wrong feature" by separating spec and quality reviews |
| 6 | D | Extraction triggers on novel insights: bug fixes, non-obvious solutions, reusable patterns |
| 7 | C | 4 parallel research agents enhance the plan in the deepen-plan phase |
| 8 | D | on_file_write triggers lint, typecheck, and secrets scan immediately after writes |
| 9 | C | Stage 1 failure returns to implementation; Stage 2 does not start |
| 10 | B | Handoffs include completed work, files modified, decisions, open questions, and mistakes |

---

## Module 4: Production Deployment Quiz

| Question | Answer | Explanation |
|----------|--------|-------------|
| 1 | C | Dockerfile uses Ubuntu 24.04 as the base image |
| 2 | B | `.:/workspace:rw` mounts the current directory read-write |
| 3 | A | Staged autonomy requires human approval before execution |
| 4 | C | Default `LOKI_MAX_PARALLEL_AGENTS` is 10 |
| 5 | A | `loki start --budget 10.00 ./prd.md` or `LOKI_BUDGET_LIMIT=10.00` |
| 6 | D | The council votes on project completion to prevent premature termination |
| 7 | B | The session auto-pauses when budget is exceeded |
| 8 | B | `LOKI_TLS_CERT` and `LOKI_TLS_KEY` environment variables |
| 9 | A | Stagnation limit flags when N iterations pass with no git changes |
| 10 | A | `LOKI_ALLOWED_PATHS` restricts which directories agents can modify |

---

## Final Certification Exam

| Question | Answer | Question | Answer |
|----------|--------|----------|--------|
| 1 | B | 26 | D |
| 2 | C | 27 | C |
| 3 | B | 28 | D |
| 4 | C | 29 | C |
| 5 | D | 30 | B |
| 6 | B | 31 | C |
| 7 | B | 32 | B |
| 8 | C | 33 | A |
| 9 | C | 34 | C |
| 10 | B | 35 | A |
| 11 | A | 36 | D |
| 12 | C | 37 | B |
| 13 | C | 38 | B |
| 14 | A | 39 | A |
| 15 | D | 40 | A |
| 16 | D | 41 | D |
| 17 | A | 42 | D |
| 18 | D | 43 | D |
| 19 | A | 44 | A |
| 20 | A | 45 | B |
| 21 | B | 46 | B |
| 22 | D | 47 | C |
| 23 | C | 48 | A |
| 24 | A | 49 | C |
| 25 | A | 50 | D |

---

## Scoring

- **50 questions total**
- **Passing score: 40 correct (80%)**
- Count your correct answers and divide by 50 to get your percentage

| Score Range | Result |
|-------------|--------|
| 40-50 (80-100%) | PASS -- Autonomi Certified Developer |
| 35-39 (70-79%) | FAIL -- Review weak areas and retake |
| Below 35 (<70%) | FAIL -- Complete all modules before retaking |
