# SDLC Fleet Pattern (skill module)

**Established:** v7.7.4 (2026-05-24)
**Origin:** user mandate "agent teams with senior most developers, Loki architects, sdet team and council of reviewers exist and coordinate and work in parallel"
**Proven by:** v7.6.0 fleet ship (architect + 3 principal engineers + SDET + 3-reviewer council + real-user QA) demonstrated the pattern works end-to-end.

This skill describes the STANDING pattern for shipping any non-trivial change in Loki Mode. The integrator (Claude Code session) is responsible for orchestrating the roles below. Each role is a Loki Agent call.

## When to invoke this pattern

Apply this pattern when shipping ANY of:

- A new feature touching > 3 files
- A bug fix touching agent runtime, council, memory, or auto-spawn surfaces
- A MINOR or MAJOR release
- A change with cross-route parity implications (bash + Bun + TS)
- A change the user has marked "critical" or "production-blocking"

Skip this pattern (acceptable shortcuts) when:

- Single-line typo fix in user-facing strings
- Pure docs edit (no code change)
- A revert of a previously-shipped change with no new logic
- An emergency hotfix where waiting on parallel agents would exceed the production-impact window

## The 6 roles

### 1. Architect (1 agent, Plan subagent_type, model: opus)

**Job:** Design the change end-to-end before any code is written. Produces a written plan saved as `docs/<TOPIC>-PLAN.md`.

**Inputs:** the original user directive verbatim + relevant source files + any prior council findings.

**Outputs:** a markdown plan with: scope, acceptance criteria, implementation steps, file-level diffs sketch, testing plan, risks + mitigations, NOT-tested honest disclosure.

**Output is BINDING** for the dev fleet -- don't change scope without re-architecting.

### 2. Product Owner (the integrator, NOT a separate agent)

**Job:** Lock scope before implementation. Use `AskUserQuestion` to surface ambiguity to the user. NEVER guess at scope.

**Output:** explicit user answer that locks the acceptance criteria.

### 3. Dev Fleet (3-5 principal engineers in parallel, model: opus)

**Job:** Implement independent slices of the architect's plan IN PARALLEL. Each engineer gets a single self-contained task with explicit file references and binding constraints.

**Pattern:** spawn N agents via `Agent` tool with `run_in_background: true` in ONE message (parallel). Each agent gets:

- The architect's plan section relevant to their slice
- A SINGLE deliverable (one fix, one feature, one file)
- Binding constraints (no version bumps, no commits, no emojis, no em dashes, NO destructive operations)
- Explicit "report back in N words" cap

The integrator does NOT delegate synthesis -- they integrate the parallel outputs themselves.

### 4. SDET (1-2 agents, model: opus)

**Job:** Write tests + capture screenshots. For each shipped feature:

- One or more bash / Playwright tests asserting acceptance criteria
- For UI surfaces: screenshot capture with `chrome --headless --screenshot` or Playwright
- For backends: curl-based smoke tests

**Output:** test files + screenshot artifacts under `artifacts/<release>-screens/`.

### 5. Council Reviewers (3 agents, parallel, model: 2 opus + 1 sonnet)

**Job:** Independent code review. Binding gate: unanimous APPROVE required to ship.

**Pattern:** spawn 3 agents in parallel via `Agent` tool. Each gets:

- The full file diff at HEAD
- Their specialized focus (e.g. "frontend correctness", "backend / integration risk", "release readiness")
- Strict output format: `VOTE: APPROVE | CONCERN | REJECT` + findings list + reasoning

On any CONCERN or REJECT:

1. Integrator reads source + validates concern
2. If valid: dispatch fix agent + RE-RUN entire council on post-fix state
3. If invalid: refute with evidence + re-spawn ONLY the dissenting reviewer with the refutation
4. Loop until 3-of-3 APPROVE
5. "2-of-3 is good enough" is NEVER acceptable

### 6. Real-User QA (1 agent OR the integrator directly)

**Job:** Install the just-shipped release fresh from npm/bun, run a user-realistic scenario end-to-end, capture screenshots, report any breakage.

**Pattern:** after `gh release` confirms, run:

```bash
bun install -g loki-mode@<NEW_VERSION>
loki --version  # confirm new version on PATH
# Then exercise the new feature in a user-realistic way:
loki <new-command> ...  # the change we just shipped
```

Capture:
- Exit codes
- Output structure
- Any unexpected errors / warnings
- Browser screenshots if UI surface

## Parallel-execution rules

When spawning multiple agents in the SAME message:

- Use `Agent` tool with `run_in_background: true`
- Send all N tool calls in a SINGLE message (parallel scheduling)
- Each agent gets a SELF-CONTAINED prompt (no shared context)
- Each agent gets a SHORT response cap (under 250 words)
- The integrator INTEGRATES the parallel outputs -- never delegates synthesis

Anti-pattern: spawning agents sequentially when work is independent. Always parallel.

## Honest acknowledgements pattern

Every CHANGELOG entry that ships work via this pattern MUST include:

```markdown
### NOT tested in this release

- <each test that was skipped + reason>
- <any feature shipped without end-to-end real-user repro>
- <any divergence from architect plan + workaround>
```

Failing to disclose is fabrication. CLAUDE.md MEMORY.md "Be real, no fabrication, no lying" applies.

## Reference run: v7.6.0 LSP integration

Demonstrated this pattern works:

1. **Architect** (Plan agent): designed Merge-3 in `docs/MERGE3-PLAN.md`
2. **Product Owner** (integrator + AskUserQuestion): user chose merge scope
3. **Dev Fleet** (3 principal engineers in parallel): Engineer A fixed memory PYTHONPATH; Engineer B added USAGE.md auto-gen across bash + TS; Engineer C added Memory drill-down UI
4. **SDET** (Explore + Playwright): captured 20+ UI screenshots, ran 24-scenario CLI permutation test
5. **Council** (2 Opus + 1 Sonnet): 2 rounds; round 1 had 2 CONCERN-major; fixes applied; round 2 unanimous APPROVE
6. **Real-user QA**: fresh `bun install -g loki-mode@7.7.0` + ran on a different stack (Python Flask) than dev test + verified USAGE.md auto-generated + Memory drill-down rendered in a real browser

Result: 4 releases shipped that day with all 8 GitHub workflows SUCCESS on each.

## Per-release checklist (always)

See `artifacts/ROADMAP-v7.6.2-v7.7.0.md` "Per-release CLAUDE.md checklist" section for the binding 14-step checklist (architect plan, 14 version bumps, CHANGELOG, pre-publish validation, council, local-ci, individual staging, push, workflow validation, distribution validation, real-user smoke test, UI screenshot regression, cleanup).
