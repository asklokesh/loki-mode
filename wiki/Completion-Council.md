# Completion Council

Multi-agent definition-of-done system for autonomous session completion (v5.25.0).

---

## Overview

The Completion Council is a 3-member voting system that determines when a Loki Mode session has achieved its objectives. Instead of relying on a single agent's judgment, the council uses majority voting with anti-sycophancy protections to make robust completion decisions.

### Key Features

- **3-member council** with 2/3 majority required for completion
- **Anti-sycophancy** devil's advocate triggered on unanimous votes
- **Convergence detection** via git diff hash tracking between iterations
- **Circuit breaker** after 5 consecutive no-progress iterations
- **Dashboard integration** with real-time vote visualization

---

## How It Works

### Voting Process

1. Every N iterations (configurable via `LOKI_COUNCIL_CHECK_INTERVAL`), the council convenes
2. Each of the 3 council members independently evaluates whether the session objectives are met
3. Votes are tallied -- 2 out of 3 votes are required for a "complete" decision
4. If all 3 members vote unanimously for completion, a devil's advocate review is triggered to prevent premature completion

### Convergence Detection

The council tracks git diff hashes between iterations to detect stagnation:

- If the codebase stops changing across iterations, the convergence tracker flags it
- After `LOKI_COUNCIL_STAGNATION_LIMIT` consecutive iterations with no git changes, a circuit breaker triggers and forces session completion
- This prevents infinite loops where the AI is not making meaningful progress

> **Route parity (v8.0.0):** both force-stop valves now run on the default
> (bash) route AND the opt-in Agent SDK loop (`LOKI_SDK_MODE=full`). The TS
> route persists its convergence counters to `.loki/council/state.json`, so they
> survive a runner restart. Two counters with different reset rules drive the
> valves: `done_signals` is consecutive (it resets the moment the agent stops
> claiming done) while `total_done_signals` is monotonic and is what arms the
> done-signal valve. Stagnation force-stops at 2x
> `LOKI_COUNCIL_STAGNATION_LIMIT`, matching bash. See
> `loki-ts/src/runner/council.ts` and
> `loki-ts/tests/council/track_iteration_valves.test.ts`.
>
> A force-stop is **not** a council approval: it means the run was halted to
> stop it burning budget, and the work is NOT verified-complete.

### Confidence-Spike Re-Check (v8.0.0)

An agent asserting maximal confidence is not evidence the work is done: a jump
to near-certainty correlates with the agent having stopped looking, not with
correctness. Loki already refuses to treat a self-report as a gate, and this
adds the cheap complement.

When the agent's self-reported confidence spikes, the **done-signal** force-stop
is delayed by exactly one iteration, so the claim gets verified instead of
terminated on. A spike is either a jump of at least
`LOKI_CONFIDENCE_SPIKE_DELTA` points (default `40`), or arrival at
`LOKI_CONFIDENCE_SPIKE_MIN` (default `90`) having not been there before -- the
second arm matters because an agent that opens at 100 never "jumps".

Three properties make this safe rather than a liability:

- **Strictly additive.** A spike can only ever ADD a verification pass. There is
  deliberately no path by which high confidence skips, shortens, or satisfies a
  gate -- that would be a false-green vector. High confidence makes the engine
  look harder, never less hard.
- **Never delays stagnation.** Only the done-signal valve is delayed. A stagnant
  build still fails cheap no matter how confident the agent sounds.
- **One-shot.** The delay is consumed on use, so a run that keeps re-spiking
  cannot postpone the valve forever and turn a safety valve into a budget leak.

Inert unless the agent actually emits a confidence figure. Opt out with
`LOKI_CONFIDENCE_SPIKE=0`. See `loki-ts/src/runner/council.ts`.

### Anti-Sycophancy

When all council members agree unanimously, Loki Mode triggers a devil's advocate review:

- A separate review pass challenges the completion decision
- This guards against all members being overly optimistic
- The devil's advocate can override the unanimous vote if issues are found

### Checklist hard gate

Separate from the vote, the council enforces a `critical_checklist_failures`
hard gate: if a critical checklist item reads `failing`, completion is blocked
regardless of how the members voted. Those items are verified by the checklist
verifier (a deterministic grep, not the voting logic). As of v7.121.0 that grep
runs in extended-regex mode and only ever reports a real match as green; an
unparseable or unestablished check becomes `pending`, never a fake `failing`
that would block a correct build. See [[Quality Gates]] for the full pass /
fail / pending semantics.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_COUNCIL_ENABLED` | `true` | Enable completion council |
| `LOKI_COUNCIL_SIZE` | `3` | Number of council members |
| `LOKI_COUNCIL_THRESHOLD` | `2` | Votes needed for completion |
| `LOKI_COUNCIL_CHECK_INTERVAL` | `5` | Check every N iterations |
| `LOKI_COUNCIL_MIN_ITERATIONS` | `3` | Minimum iterations before council runs |
| `LOKI_COUNCIL_CONVERGENCE_WINDOW` | `3` | Iterations to track for convergence |
| `LOKI_COUNCIL_STAGNATION_LIMIT` | `5` | Max iterations with no git changes |

### Config File

```yaml
# .loki/config.yaml
completion:
  council:
    enabled: true
    size: 3
    threshold: 2
    check_interval: 5
    min_iterations: 3
    stagnation_limit: 5
```

### Examples

```bash
# Disable council (use simple completion detection)
export LOKI_COUNCIL_ENABLED=false

# More aggressive completion detection
export LOKI_COUNCIL_CHECK_INTERVAL=3
export LOKI_COUNCIL_STAGNATION_LIMIT=3

# Require unanimous vote (all 3 members)
export LOKI_COUNCIL_THRESHOLD=3
```

---

## CLI Commands

```bash
# Check council status
loki council status

# View vote history (decision log)
loki council verdicts

# View convergence data
loki council convergence

# Force an immediate council review
loki council force-review

# View the final completion report
loki council report

# Show council configuration
loki council config

# Show help
loki council help
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/council/state` | Current council state |
| GET | `/api/council/verdicts` | Vote history |
| GET | `/api/council/convergence` | Convergence tracking data |
| GET | `/api/council/report` | Final completion report |
| POST | `/api/council/force-review` | Trigger immediate review |

See [[API Reference]] for detailed endpoint documentation.

---

## Dashboard Tab

The Completion Council has a dedicated tab in the dashboard with four views:

| View | Description |
|------|-------------|
| **Overview** | Current council state -- enabled status, total votes, latest verdict |
| **Decision Log** | Chronological history of council verdicts with vote breakdowns |
| **Convergence** | Chart showing git diff hash changes over iterations |
| **Agents** | Active agent list with pause, resume, and kill controls |

---

## State Files

Council state is stored in `.loki/council/`:

| File | Description |
|------|-------------|
| `state.json` | Current council state and configuration |
| `convergence.log` | Git diff hash history for convergence detection |
| `votes/` | Individual vote records per iteration |
| `report.md` | Final completion report (written when session ends) |

---

## See Also

- [[Architecture]] - Council architecture diagram
- [[API Reference]] - Council API endpoints
- [[CLI Reference]] - Council CLI commands
- [[Dashboard]] - Council dashboard tab
- [[Configuration]] - Council configuration options
