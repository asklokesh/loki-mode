---
description: Print Loki's review handoff (.loki/review/HANDOFF.md) for the last run.
allowed-tools: Read, Bash(ls:*), Bash(loki own:*)
---

Show the user what Loki handed off, verbatim.

1. If `.loki/review/HANDOFF.md` exists, Read it and print it unchanged.
2. Else if `HANDOFF.md` exists at the project root, Read and print that.
3. Else run `loki own` and print its output.
4. If none yields content, say no handoff exists yet and suggest
   `/loki-mode:start <task>`. Do not invent a summary.
