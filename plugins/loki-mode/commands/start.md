---
description: Hand the current task to Loki (loki start) in the background and report where the handoff will land.
argument-hint: "<task description or path to a PRD/spec file>"
allowed-tools: Bash(loki start:*), Bash(loki status:*), Bash(command -v:*), Bash(ls:*)
---

Delegate the task in $ARGUMENTS to Loki Mode so it runs autonomously while the
user does something else. Do not start building the task yourself.

1. Confirm the CLI exists: `command -v loki`. If missing, say
   `npm install -g loki-mode` is required and stop.
2. If $ARGUMENTS is an existing file path, run `loki start --bg <path>`.
   Otherwise write the text to `.loki/handoff-task.md` (create `.loki/` if
   needed) and run `loki start --bg .loki/handoff-task.md`. Do not pass any
   permission-bypass flags of your own; `loki start` owns its provider setup.
3. Report in at most five lines: that the run started in the background, the
   command to check progress (`loki status`), and where results land:
   `.loki/review/HANDOFF.md` (read it with `/loki-mode:handoff`) and the
   evidence verdict (`/loki-mode:loki-verify --fast`).
4. If `loki start` exits non-zero, show its first error line verbatim and stop.
