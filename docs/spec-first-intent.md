# Spec-first intent

The intent card (`LOKI_INTENT_CARD`, `LOKI_CONFIRM`) shows what the plan model thinks you want and the acceptance checks it will hold itself to. Spec-first intent turns those checks into a file you can edit before any code is written.

## Flow

```bash
loki plan "add search ranking" --spec     # or: loki start --spec-first "add search ranking"
# edit .loki/specs/add-search-ranking.md
loki start --spec .loki/specs/add-search-ranking.md
```

1. `loki plan <task> --spec` runs one model session. The model writes the intent sentence and 2 to 6 criteria as JSON; the engine checks that JSON against a schema and renders `.loki/specs/<slug>.md`. The model never writes the markdown itself. An existing spec is never overwritten unless you pass `--force`.
2. You edit the file. Keep the marker comment on line 1 and the three headings (`## Task`, `## Intent`, `## Acceptance criteria`). Task lines start with `> `; criteria are `- ` bullets.
3. `loki start --spec FILE` parses the file and treats it as the authoritative intent: the implement brief carries the intent and every criterion, and wins over the task text where they differ. A positional task, if given, replaces the task text but not the spec.

## Refusals

A spec that does not parse exits 2 before any run state is created, naming the file and line, for example `engine10: .loki/specs/a.md: line 14: criteria must be bullet lines starting with "- "`. `--spec` and `--spec-first` cannot be combined.

## Evidence

- The receipt gains an additive `spec` block: `{ "path": ".loki/specs/<slug>.md", "sha256": "<hex>" }`. The hash covers the exact bytes the run started from (the engine snapshots them into the run directory), so later edits to the file do not change what the receipt vouches for. Runs without `--spec` have no `spec` key and their receipt hashes are unchanged.
- The PR body gains a `Spec:` line linking the file with the first 12 hex characters of its hash, next to the `## Intent` section.

## Unchanged without the flags

Without `--spec` or `--spec-first`, `loki plan` stays on its existing route, `loki start` behaves as before, and the plan and implement briefs are byte-identical (pinned by golden fixtures in `loki-ts/tests/engine10/fixtures`).
