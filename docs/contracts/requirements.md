# Requirements map contract (REQTRACE)

File: `.loki/state/requirements-map.json`. Written after verification, before the run summary. Read-only view: `loki plan --requirements` (add `--json` for the raw file).

## Shape

```json
{"version":1,"revision":"<git sha at write time, or \"unknown\">","requirements":[
  {"id":"R1","text":"...","checks":["<check id>"],"status":"covered","method":"explicit"}
]}
```

- `status` is `covered` only when at least one check that actually ran and passed maps to the requirement. `checks` lists only those passing checks. A failed, flaky, not_run or pending check never covers.
- `method` is `explicit` when the requirement carries its own link to checks, `heuristic` otherwise. An uncovered requirement with no link is `heuristic` with `checks: []`.
- Ids `R1..Rn` are assigned in source order. At most 40 requirements are taken from PRD text.
- The file is never written when there is no requirement source, and a write failure never fails a run.

## Where requirements and checks come from (no second parser)

| Run | Requirements | Checks that ran | Link |
|---|---|---|---|
| Bun runner (`loki start`, default) | `.loki/checklist/checklist.json` items (existing PRD checklist) | that item's `verification[]` entries, id `<item id>:<type>:<n>`; `passed === true` counts | explicit, by construction |
| engine10 with `--spec` | acceptance criteria of the spec snapshot (`spec_file.ts` parseSpec) | `test.result` events of the run, id = check name (`runner:path`) | explicit if the criterion ends with `[check: id1, id2]`, else heuristic |
| engine10 text or PRD task | units from `autonomy/lib/requirements_contract.py` `extract_bound_requirement_units`; needs 2 or more units, so a one-line brief is not a PRD | same `test.result` events | heuristic |

Heuristic rule: a passing check matches when it shares at least 2 significant words (4 or more letters, minus a small stop list; all of them when the requirement has only one) with the check id plus command. It is a hint, not proof, which is why `method` is recorded.

## Surfaces

- Run summary next-step line: `N requirement(s) uncovered, see: loki plan --requirements` when `N > 0`, inside the 8-line cap (engine10 `withNextLine` / `formatRunSummary`, and `autonomy/lib/run-summary.sh` for the bash summary). The JSON summary adds `requirements_uncovered` only when `N > 0`.
- Code: `loki-ts/src/util/requirements_map.ts`. Tests: `loki-ts/tests/util/requirements_map.test.ts`.

## Known gaps

- The legacy bash engine (`autonomy/run.sh` without Bun) does not write the map; its summary only reads one if present.
- Heuristic matching is word overlap only; it can both miss and over-claim. Use explicit `[check: id]` links for requirements that matter.
