# Outcome Canary

`python3 tools/outcome-canary.py report.json --enable-canary --subject <key> --control-route <name>`
plans a reversible canary split between the route an [outcome router](./OUTCOME-ROUTER.md)
report selected and an operator-named control. It is a planner: it never invokes or
switches a provider, never weakens a gate, and writes nothing.

The canary is opt-in. Without `--enable-canary` it refuses, so a plan can never be
produced by accident.

## Evidence it demands

The tool refuses unless the evidence stands up on its own terms:

- the report parses, is a `loki-outcome-router/v1` object, and carries `source`,
  a 64-hex `source_sha256`, and a `candidates` list
- the recorded source file still exists and still hashes to `source_sha256`, so a
  plan cannot rest on trials that changed after they were measured
- the exact router-report bytes are hashed as `report_sha256`; that digest is
  emitted in the plan and participates in assignment, so a report edited after
  review cannot reuse the prior plan binding
- the report selected a primary route, the control route is present, both are
  `eligible`, and the two differ
- `trials` and `mean_risk` on both routes are strictly valid numbers: booleans,
  `NaN`, and `Infinity` are rejected, not coerced
- both routes have equal trial counts, so the two arms rest on matched evidence
- neither route's mean risk exceeds `--max-risk` (default `.25`)
- `--canary-percent` (default `10`) is a finite number from 0 to 100

Every failed check is reported in `refusal_reasons`; the plan is refused as a whole
rather than partially applied.

## Assignment

Assignment is deterministic and needs no stored state. The tool hashes a
NUL-joined, domain-separated string of `loki-outcome-canary/v1`, the subject, the
router-report digest, the source digest, the primary route, the control route, and the percentage, then takes
that sha256 modulo 10000 against the percentage. The same subject and the same
evidence always land in the same arm, in any process; different subjects spread
across arms. Because the digest includes the evidence, changing the trials
reshuffles the split rather than silently carrying an old assignment forward.

Percent 0 assigns every subject to control and percent 100 assigns every subject to
the canary, which is what makes the rollback a real command rather than a promise.

## Rollback

A plan always carries `reversible: true` and a `rollback` object naming the control
route, its effect, and the exact command that assigns control to everyone:

```
python3 tools/outcome-canary.py report.json --enable-canary \
  --subject <key> --control-route <name> --canary-percent 0
```

## Output and exit codes

`--json` emits the whole plan for automation; the default is human-readable. Exit 0
means a plan exists, 3 means the evidence or policy cannot support one (including a
missing `--enable-canary`, and a source that drifted), 64 is an invocation error,
and 66 is a missing report file or a report whose evidence source is gone.
