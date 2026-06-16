# Autonomi Certified Developer -- Final Exam

**Total Questions:** 50
**Passing Score:** 80% (40 correct)
**Format:** Multiple choice (A/B/C/D)

---

## Section 1: Core Concepts (Questions 1-10)

**Question 1:** What does the RARV cycle stand for?

A) Read, Analyze, Review, Validate
B) Reason, Act, Reflect, Verify
C) Request, Assign, Run, Verify
D) Review, Approve, Release, Validate

---

**Question 2:** How many specialized agent types does Loki Mode define?

A) 8
B) 25
C) 41
D) 50

---

**Question 3:** What happens when a task fails 5 times in the RARV cycle?

A) The entire session terminates
B) The task is moved to the dead-letter queue
C) The task is automatically deleted
D) The agent escalates to a more powerful model

---

**Question 4:** Which specialist reviewer is ALWAYS included in the 3-reviewer blind review system?

A) security-sentinel
B) performance-oracle
C) architecture-strategist
D) test-coverage-auditor

---

**Question 5:** How many quality gates does Loki Mode enforce?

A) 3
B) 5
C) 7
D) 8

---

**Question 6:** What are the three types of memory in the Loki Mode memory system?

A) Short-term, long-term, working
B) Episodic, semantic, procedural
C) Cache, storage, archive
D) Input, processing, output

---

**Question 7:** Which complexity tier uses 3 phases?

A) basic
B) simple
C) standard
D) complex

---

**Question 8:** What does Gate 7 (Documentation Coverage) check?

A) That unit test coverage is at least 80%
B) That every function has an inline comment
C) That a README exists, docs are fresh within 10 commits, and packages have API docs
D) That cyclomatic complexity stays under 10

---

**Question 9:** Which AI provider supports full Loki Mode features including parallel agents and the Task tool?

A) OpenAI Codex CLI
B) Google Gemini CLI
C) Claude Code
D) All three providers equally

---

**Question 10:** What does Gate 4 (Anti-Sycophancy Check) do?

A) Blocks all code that has any warnings
B) Runs a Devil's Advocate reviewer when all 3 reviewers unanimously approve
C) Requires human approval for every change
D) Checks for duplicate code across the project

---

## Section 2: Enterprise Features (Questions 11-20)

**Question 11:** What is the default state of audit logging in Loki Mode (v5.38.0+)?

A) Enabled by default, can be disabled with `LOKI_AUDIT_DISABLED=true`
B) Disabled, must be explicitly enabled
C) Only enabled when running in Docker sandbox
D) Only enabled when `LOKI_ENTERPRISE_AUDIT=true` is set

---

**Question 12:** Which environment variable enables OpenTelemetry in Loki Mode?

A) `LOKI_OTEL_ENABLED=true`
B) `LOKI_TELEMETRY=true`
C) `LOKI_OTEL_ENDPOINT=http://localhost:4318`
D) `OTEL_EXPORTER_ENDPOINT=http://localhost:4318`

---

**Question 13:** What is the default port for the Loki Mode dashboard?

A) 3000
B) 8080
C) 57374
D) 9090

---

**Question 14:** Which environment variable enables token-based API authentication?

A) `LOKI_ENTERPRISE_AUTH=true`
B) `LOKI_AUTH_ENABLED=true`
C) `LOKI_TOKEN_AUTH=true`
D) `LOKI_API_AUTH=true`

---

**Question 15:** What protocol options does Loki Mode support for syslog forwarding?

A) HTTP and HTTPS only
B) MQTT and AMQP
C) gRPC and HTTP
D) UDP and TCP

---

**Question 16:** What happens when `LOKI_OTEL_ENDPOINT` is NOT set?

A) Loki Mode refuses to start
B) OTEL uses a default localhost endpoint
C) OTEL data is written to a local file
D) Loki Mode uses no-op stubs with zero overhead

---

**Question 17:** Which command generates an API token for the dashboard?

A) `loki enterprise token generate my-token`
B) `loki auth token create`
C) `loki dashboard auth --new-token`
D) `loki config auth token`

---

**Question 18:** How do you enable TLS for the Loki Mode dashboard?

A) Set `LOKI_DASHBOARD_TLS=true`
B) TLS is always enabled by default
C) Pass `--tls` flag to `loki dashboard start`
D) Set `LOKI_TLS_CERT` and `LOKI_TLS_KEY` to PEM file paths

---

**Question 19:** What does `LOKI_PROMPT_INJECTION` control?

A) Whether the `HUMAN_INPUT.md` file can inject directives into a running session
B) Whether agents can execute shell commands
C) Whether API tokens expire automatically
D) Whether OTEL traces include prompt content

---

**Question 20:** Which command checks the status of all enterprise features?

A) `loki enterprise status`
B) `loki config show`
C) `loki doctor --enterprise`
D) `loki status --enterprise`

---

## Section 3: Advanced Patterns (Questions 21-30)

**Question 21:** What are the four required sections in a structured agent prompt?

A) Task, Input, Process, Output
B) Goal, Constraints, Context, Output
C) Objective, Scope, Resources, Deliverables
D) Summary, Details, Requirements, Acceptance

---

**Question 22:** In confidence-based routing, what happens when a task's confidence score is below 0.40?

A) The task is executed with the cheapest model
B) The task is automatically retried 3 times
C) The task is split into smaller subtasks
D) The task is flagged for human decision

---

**Question 23:** What is the critical feature of Step 3 (Execute) in the Chain-of-Verification process?

A) All verifications run sequentially in the same context
B) The verifier has full access to the original response for comparison
C) Each verification runs independently with NO access to the original response
D) A human must approve each verification question

---

**Question 24:** In the specialist review pool, what is the tie-breaker priority order?

A) security-sentinel > test-coverage-auditor > performance-oracle > dependency-analyst
B) performance-oracle > dependency-analyst > security-sentinel > test-coverage-auditor
C) test-coverage-auditor > security-sentinel > dependency-analyst > performance-oracle
D) dependency-analyst > performance-oracle > test-coverage-auditor > security-sentinel

---

**Question 25:** Why is code review split into two stages?

A) To prevent approving well-written code that implements the wrong feature
B) To reduce the number of reviewers needed
C) To allow junior developers to handle Stage 1
D) To make the review process faster

---

**Question 26:** What triggers the compound learning knowledge extraction phase?

A) Every task completion regardless of outcome
B) Only when manually invoked with `loki compound run`
C) Only when the project reaches the DEPLOYMENT phase
D) Only when a task produces a novel insight (bug fix, non-obvious solution, reusable pattern)

---

**Question 27:** How many parallel research agents run during the deepen-plan phase?

A) 2
B) 3
C) 4
D) 5

---

**Question 28:** What is the purpose of the `on_file_write` hook trigger?

A) To back up files before they are modified
B) To prevent agents from writing to protected files
C) To log all file changes to the audit trail
D) To run lint, typecheck, and secrets scanning immediately after a file is written

---

**Question 29:** In the two-stage review protocol, what happens if Stage 1 (spec compliance) fails?

A) The code goes directly to Stage 2 for quality feedback
B) The review is cancelled and a new agent is assigned
C) The code returns to implementation; Stage 2 is NOT started
D) Both stages run in parallel anyway to save time

---

**Question 30:** What information is included in a structured agent handoff?

A) Only the list of files modified
B) Completed work, files modified, decisions made, open questions, and mistakes learned
C) Only the task ID and completion status
D) A full copy of the agent's conversation history

---

## Section 4: Production Deployment (Questions 31-40)

**Question 31:** What base image does the Loki Mode Dockerfile use?

A) Alpine Linux 3.19
B) Node.js 20 official image
C) Ubuntu 24.04
D) Debian Bookworm

---

**Question 32:** Which volume mount in docker-compose.yml gives the container read-write access?

A) `~/.gitconfig:/home/loki/.gitconfig`
B) `.:/workspace:rw`
C) `~/.ssh:/home/loki/.ssh`
D) `~/.config/gh:/home/loki/.config/gh`

---

**Question 33:** What does `LOKI_STAGED_AUTONOMY=true` do?

A) Requires human approval before execution
B) Enables parallel agent execution in stages
C) Stages deployment across multiple environments
D) Enables incremental feature rollout

---

**Question 34:** What is the default maximum number of parallel agents?

A) 3
B) 5
C) 10
D) 20

---

**Question 35:** How do you set a cost budget limit for a Loki Mode session?

A) `loki start --budget 10.00 ./prd.md`
B) `loki start --max-cost 10`
C) `LOKI_COST_LIMIT=10 loki start`
D) `loki config set budget 10.00`

---

**Question 36:** What does the completion council do?

A) Reviews all code changes before they are committed
B) Assigns tasks to available agents
C) Manages the deployment pipeline approval process
D) Votes on whether the project is truly complete to prevent premature termination

---

**Question 37:** What happens when the budget limit set by `LOKI_BUDGET_LIMIT` is exceeded?

A) The session continues but logs a warning
B) The session auto-pauses
C) The session terminates immediately with an error
D) The budget is automatically doubled

---

**Question 38:** Which environment variables enable TLS for the dashboard?

A) `LOKI_HTTPS=true` and `LOKI_HTTPS_PORT=443`
B) `LOKI_TLS_CERT` and `LOKI_TLS_KEY`
C) `LOKI_SSL_CERT` and `LOKI_SSL_KEY`
D) `LOKI_DASHBOARD_TLS=true`

---

**Question 39:** What does `LOKI_COUNCIL_STAGNATION_LIMIT=5` mean?

A) After 5 iterations with no git changes, stagnation is flagged
B) The council can only reject completion 5 times
C) The council checks every 5 minutes
D) Maximum 5 council members can vote

---

**Question 40:** How do you restrict which directories agents can modify?

A) `LOKI_ALLOWED_PATHS=/workspace/src,/workspace/tests`
B) `LOKI_READ_ONLY_PATHS=/etc,/usr`
C) `LOKI_SANDBOX_PATHS=/safe/dir`
D) `LOKI_WRITE_DIRS=src,tests`

---

## Section 5: Troubleshooting (Questions 41-50)

**Question 41:** What are the three states of the circuit breaker system?

A) Active, Inactive, Standby
B) Green, Yellow, Red
C) Running, Paused, Stopped
D) Closed, Open, Half-Open

---

**Question 42:** How many failures within 60 seconds trigger a circuit breaker to OPEN?

A) 1
B) 2
C) 5
D) 3

---

**Question 43:** What is the default cooldown period when a circuit breaker is in the OPEN state?

A) 30 seconds
B) 60 seconds
C) 600 seconds (10 minutes)
D) 300 seconds (5 minutes)

---

**Question 44:** After how many failures is a task moved to the dead-letter queue?

A) 5
B) 3
C) 7
D) 10

---

**Question 45:** What happens when 3 or more DRIFT_DETECTED signals accumulate?

A) The session terminates immediately
B) A context clear is triggered and state is reloaded from scratch
C) The task is moved to the dead-letter queue
D) All agents are stopped and restarted

---

**Question 46:** Which file should an agent read first when recovering from context loss?

A) `.loki/queue/pending.json`
B) `.loki/CONTINUITY.md`
C) `.loki/session.json`
D) `.loki/memory/index.json`

---

**Question 47:** What does the `loki reset retries` command do?

A) Deletes all tasks from the queue
B) Restarts the AI provider CLI
C) Resets retry counters only
D) Removes the entire `.loki/` directory

---

**Question 48:** Which environment variable disables Gate 5 (Mock Integrity Detector)?

A) `LOKI_GATE_MOCK=false`
B) `LOKI_SKIP_MOCK_CHECK=true`
C) `LOKI_DISABLE_GATE_5=true`
D) `LOKI_NO_MOCK_DETECTION=true`

---

**Question 49:** When should a dead-letter task be permanently abandoned?

A) After 3 failed attempts
B) After 5 failed attempts
C) After 10+ total attempts, or same error with 3 different approaches
D) Only when manually deleted by the user

---

**Question 50:** What is a red flag indication that an agent is rationalizing a failure?

A) The agent requests a model upgrade
B) The agent runs additional tests
C) The agent creates a new branch for the fix
D) The agent uses language like "probably", "should be fine", or "just a small change"

---

**End of Exam**

Check your answers against `answer-key.md`. You need 40 or more correct answers (80%) to pass.
