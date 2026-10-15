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

## Requirement-to-check map (REQTRACE)

File: `.loki/state/requirements-map.json`. Written after verification, before the run summary. Read-only view: `loki plan --requirements` (add `--json` for the raw file). Code: `loki-ts/src/features/contract.ts`; tests: `loki-ts/tests/features/contract.test.ts`.

```json
{"version":1,"revision":"<git sha at write time, or \"unknown\">","requirements":[
  {"id":"R1","text":"...","checks":["<check id>"],"status":"covered","method":"explicit"}
]}
```

- `status` is `covered` only when at least one check that actually ran and passed maps to the requirement. `checks` lists only those passing checks. A failed, flaky, not_run or pending check never covers.
- `method` is `explicit` when the requirement carries its own link to checks, `heuristic` otherwise. An uncovered requirement with no link is `heuristic` with `checks: []`.
- Ids `R1..Rn` are assigned in source order. At most 40 requirements are taken from PRD text.
- The file is never written when there is no requirement source, and a write failure never fails a run.

Requirements and checks come from existing extractors, with no second parser:

| Run | Requirements | Checks that ran | Link |
|---|---|---|---|
| Bun runner (`loki start`, default) | `.loki/checklist/checklist.json` items | that item's `verification[]` entries, id `<item id>:<type>:<n>`; `passed === true` counts | explicit, by construction |
| engine10 with `--spec` | acceptance criteria of the spec snapshot (`spec_file.ts` parseSpec) | `test.result` events of the run, id = check name (`runner:path`) | explicit if the criterion ends with `[check: id1, id2]`, else heuristic |
| engine10 text or PRD task | units from `autonomy/lib/requirements_contract.py` `extract_bound_requirement_units`; needs 2 or more units | same `test.result` events | heuristic |

Heuristic rule: a passing check matches when it shares at least 2 significant words (4 or more letters, minus a small stop list; all of them when the requirement has only one) with the check id plus command. It is a hint, not proof, which is why `method` is recorded.

Surfaces: the run summary next-step line reads `N requirement(s) uncovered, see: loki plan --requirements` when `N > 0`, inside the 8-line cap (engine10 `withNextLine` / `formatRunSummary`, and `autonomy/lib/run-summary.sh` for the bash summary). The JSON summary adds `requirements_uncovered` only when `N > 0`.

Known gaps: the legacy bash engine (`autonomy/run.sh` without Bun) does not write the map; its summary only reads one if present. Heuristic matching is word overlap only and can both miss and over-claim, so use explicit `[check: id]` links for requirements that matter.
