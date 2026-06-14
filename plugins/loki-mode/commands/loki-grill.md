---
description: Interrogate a spec with Loki's Devil's-Advocate grill before building, and summarize the hardest questions it surfaces.
argument-hint: "[spec-path] (default: prd.md / .loki/generated-prd.md)"
allowed-tools: Bash(loki grill:*), Read
---

Harden a spec before any code is written. Loki's grill invokes the provider
once with a Devil's-Advocate prompt to surface the 10-15 hardest questions that
expose ambiguities, missing acceptance criteria, unstated assumptions, and
security/scale blind spots. A grilled spec is a better Reason input to the
RARV-C loop.

Steps:

1. Run the interrogation on the spec ($ARGUMENTS, or the default resolution
   prd.md / .loki/generated-prd.md if empty):

   ```
   loki grill $ARGUMENTS
   ```

   It writes `.loki/grill/report.md`. It requires a provider CLI and fails
   cleanly (exit 3) when none is available: it never fabricates questions.

2. Read `.loki/grill/report.md` and present the findings to the user grouped by
   category:
   - Ambiguities and missing acceptance criteria
   - Unstated assumptions
   - Security blind spots
   - Scale and reliability blind spots

3. For each hard question, suggest a concrete way to resolve it in the spec
   (a precise acceptance criterion, an explicit assumption made explicit, a
   security control, a stated limit). Do not silently answer them yourself;
   the point is to harden the human's intent.

4. If the user wants the questions embedded in the spec for the record, offer:

   ```
   loki grill --apply $ARGUMENTS
   ```

   which appends a "Grill findings" section to the spec file. Ask before
   modifying the spec.

Report only what the grill produced. If the provider was unavailable, say so
plainly and do not invent questions.
