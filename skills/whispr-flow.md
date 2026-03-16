# Whispr Flow - Voice-Driven Development Flow

**Load when:** Using voice commands during autonomous execution, enabling narration, or running continuous voice-driven development sessions.

---

## Overview

Whispr Flow bridges the gap between voice-driven "vibe coding" and Loki Mode's autonomous execution engine. While BMAD handles **pre-development** artifact pipelines (PRD/architecture/epics), Whispr Flow enables **continuous voice interaction during execution**.

**Complementary to BMAD:**
| Concern | BMAD | Whispr Flow |
|---------|------|-------------|
| When | Pre-development (requirements) | During development (execution) |
| Input | Structured artifacts (PRD, epics) | Natural language voice commands |
| Output | Normalized .loki/ files | Directives, queue tasks, signals |
| Integration | `--bmad-project` flag | `--whispr-flow` flag or `loki whispr` |

---

## Architecture

```
Voice Input (microphone)
    |
    v
Transcription (voice.sh backends: Whisper API / local / macOS / Vosk)
    |
    v
Command Parser (NLP pattern matching in whispr-flow.sh)
    |
    +--[control]-------> .loki/PAUSE, .loki/STOP, .loki/RESUME
    +--[focus]---------> .loki/whispr/current-directive.md -> run.sh prompt
    +--[task]----------> .loki/queue/pending.json (high priority insert)
    +--[phase]---------> .loki/whispr/current-directive.md (phase skip/advance)
    +--[status]--------> Read .loki/state/orchestrator.json + TTS output
    +--[review]--------> Directive injection for code review trigger
    +--[general]-------> .loki/whispr/current-directive.md (raw directive)
    |
    v
Narration Engine (TTS feedback via voice.sh speak)
```

### State Files

| File | Purpose | Read by |
|------|---------|---------|
| `.loki/whispr/session.json` | Active session metadata | whispr-flow.sh, run.sh |
| `.loki/whispr/current-directive.md` | Current voice directive | run.sh (prompt injection) |
| `.loki/whispr/directives.log` | Directive history (append-only) | Debugging |
| `.loki/whispr/command-history.json` | Parsed command log (last 100) | Status display |
| `.loki/whispr/events.log` | Narration events | Debugging |

---

## Voice Command Reference

### Execution Control
| Say this | Action |
|----------|--------|
| "pause" / "wait" / "hold" | Creates `.loki/PAUSE` |
| "resume" / "continue" / "go" | Removes `.loki/PAUSE` |
| "stop" / "abort" / "cancel" | Creates `.loki/STOP` |
| "restart" / "reset" | Clears PAUSE and STOP signals |

### Focus & Priority
| Say this | Action |
|----------|--------|
| "focus on authentication" | Reprioritizes queue for auth-related tasks |
| "prioritize the API" | Same as focus |
| "deprioritize styling" | Moves styling tasks to bottom of queue |

### Phase Navigation
| Say this | Action |
|----------|--------|
| "skip deployment" | Injects phase-skip directive |
| "advance to QA" | Injects phase-advance directive |
| "move to development" | Same as advance |

### Task Injection
| Say this | Action |
|----------|--------|
| "add task: fix login bug" | Inserts task at front of queue |
| "fix the API timeout" | Injects fix directive |
| "implement dark mode" | Injects implementation directive |

### Status & Information
| Say this | Action |
|----------|--------|
| "status" / "progress" | Reads orchestrator state aloud |
| "show tasks" / "list pending" | Lists pending tasks |
| "show errors" | Shows dead-letter queue entries |
| "show phase" | Shows current SDLC phase |

### Code Review
| Say this | Action |
|----------|--------|
| "review the code" | Triggers code review |
| "approve" / "looks good" | Approves current review |
| "reject" / "nope" | Rejects and triggers rollback |

---

## CLI Usage

```bash
# Start continuous voice flow (with TTS narration)
loki whispr start --narrate --listen-interval 15

# Quick text-based command injection (no microphone needed)
loki whispr inject "focus on the database layer"
loki whispr inject "add task: implement user authentication"
loki whispr inject "pause"

# Parse without executing (debugging)
loki whispr parse "skip deployment phase"

# Check status
loki whispr status

# View command history
loki whispr history

# Stop session
loki whispr stop
```

### With `loki start` Integration

```bash
# Start Loki Mode with Whispr Flow enabled
loki start --whispr-flow prd.md

# With narration
loki start --whispr-flow --whispr-narrate prd.md

# Combined with BMAD
loki start --bmad-project ./my-project --whispr-flow
```

---

## run.sh Integration

Whispr Flow context is injected into `build_prompt()` alongside BMAD and OpenSpec contexts. The injection reads `.loki/whispr/current-directive.md` and recent command history to inform the autonomous agent.

**Context budget:** Max 4KB for Whispr Flow context (directive + 5 recent commands + session info). This is small compared to BMAD (8-15KB) because Whispr Flow directives are action-oriented, not document-oriented.

**Directive lifecycle:**
1. Voice input -> parsed -> written to `current-directive.md`
2. Next run.sh iteration reads directive into prompt
3. After injection, directive is consumed (cleared)
4. Agent acts on directive during its RARV cycle
5. New directives can arrive mid-execution

---

## Narration Events

When narration is enabled (`--narrate` or `WHISPR_NARRATE=true`), run.sh can emit TTS events at key moments:

```bash
# In run.sh, after phase transition:
"$SCRIPT_DIR/whispr-flow.sh" narrate phase_transition "DEVELOPMENT -> QA"

# After task completion:
"$SCRIPT_DIR/whispr-flow.sh" narrate task_complete "Implemented user auth"

# On failure:
"$SCRIPT_DIR/whispr-flow.sh" narrate task_failed "Database migration error"

# On build/test results:
"$SCRIPT_DIR/whispr-flow.sh" narrate tests_pass
"$SCRIPT_DIR/whispr-flow.sh" narrate build_failure "TypeScript compilation error"
```

Supported events: `phase_transition`, `task_complete`, `task_failed`, `review_start`, `review_complete`, `build_success`, `build_failure`, `tests_pass`, `tests_fail`, `completion`, `budget_warning`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPR_NARRATE` | `false` | Force-enable TTS narration |
| `LOKI_PROMPT_INJECTION` | `false` | Also write directives to HUMAN_INPUT.md |
| `WHISPR_LISTEN_INTERVAL` | `30` | Seconds between listen attempts |

---

## Relationship to Existing Modules

- **voice.sh**: Low-level transcription and TTS. Whispr Flow builds on top of it.
- **BMAD adapter**: Pre-development artifacts. Whispr Flow is runtime interaction.
- **OpenSpec adapter**: Brownfield delta context. Whispr Flow is voice-driven, not spec-driven.
- **run.sh HUMAN_INPUT.md**: Manual text injection. Whispr Flow automates this with voice parsing.
- **Event bus (events/)**: Whispr Flow narration events complement the event bus but use TTS output.
- **Completion council**: Whispr Flow's "approve"/"reject" commands can influence review outcomes.
