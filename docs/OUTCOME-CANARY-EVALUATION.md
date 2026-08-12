# Outcome Canary Evaluation

`outcome-canary-evaluate.py` converts consented, locally recorded canary
observations into one deterministic aggregate verdict. It never invokes a provider,
changes an assignment, or promotes a route.

```bash
python3 tools/outcome-canary-evaluate.py report.json observations.json \
  --enable-evaluation --control-route safe --canary-percent 10 --json
```

Evaluation is opt-in. Without `--enable-evaluation`, the command refuses.

## Observation contract

The input is one `loki-outcome-canary-observations/v1` JSON object:

```json
{
  "observations": "loki-outcome-canary-observations/v1",
  "report_sha256": "<sha256 of the exact router report>",
  "source_sha256": "<source_sha256 from that report>",
  "items": [
    {
      "subject": "locally chosen opaque key",
      "assignment": "control",
      "route": "safe",
      "accepted": true,
      "risk": 0.1
    }
  ]
}
```

Each item has exactly those five fields. Subjects must be unique and non-empty;
`accepted` is a JSON Boolean; and `risk` is a finite number from zero through one.
The file is capped at 5 MiB and 100,000 observations. Duplicate JSON keys are
rejected.

The evaluator accepts only named regular report and observation files. Symlinks,
directories, devices, and other path indirection are refused. It hashes the exact
report and observation bytes, rechecks the report's underlying source digest, and
reruns the released deterministic canary assignment for every subject. A recorded
arm or route that does not match that assignment refuses the entire evaluation.
Output contains no subject keys or input pathnames.

## Verdict policy

Both arms must reach `--min-samples` (default 5). The tool computes integer accepted
basis points and mean observed risk for each arm.

- `ROLLBACK`: canary acceptance is below control, or canary mean risk exceeds
  `--max-risk` (default 0.25).
- `PROMOTE`: canary acceptance lift reaches `--min-lift-bps` (default 1) and canary
  mean risk is no higher than control.
- `HOLD`: the evidence is valid and sufficiently sampled but meets neither rule.

These are offline recommendations, not routing actions. A consented operator still
controls whether to apply any change. Malformed, drifted, mismatched, sparse, or
unbound evidence returns `REFUSED` rather than a partial verdict.

## Output and exit codes

`--json` emits the aggregate arms, policy, exact evidence digests, verdict, and
refusal reasons. It is portable across machines because it omits local input paths.
The default output is a short human-readable summary. Exit 0 means
a verdict was produced (including `ROLLBACK`), 3 means evaluation was refused, 64
is an invocation error, and 66 is a missing input file.
