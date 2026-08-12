# Outcome Canary Evaluation

`outcome-canary-evaluate.py` converts consented, locally recorded canary
observations into one deterministic aggregate verdict. It never invokes a provider,
changes an assignment, or promotes a route.

Installed Loki distributions expose the complete workflow through one command:

```bash
loki outcomes canary plan --help
loki outcomes canary record --help
loki outcomes canary evaluate --help
loki outcomes canary receipt --help
loki outcomes canary verify --help
```

`loki outcomes canary` resolves the bundled tools from the installation, so these commands
work outside the Loki source checkout. It passes arguments and exit codes through
unchanged; the explicit opt-in gates documented below still apply.

```bash
loki outcomes canary evaluate report.json observations.json \
  --enable-evaluation --control-route safe --canary-percent 10 --json
```

Evaluation is opt-in. Without `--enable-evaluation`, the command refuses.

## Retain a decision receipt

After a complete evaluation, create one immutable portable proof by independently
rerunning the same decision:

```bash
loki outcomes canary receipt report.json observations.json receipt.json \
  --enable-receipt --control-route safe --canary-percent 10 --min-samples 5
```

The command creates a new canonical `loki-outcome-canary-decision-receipt/v1`
file. It binds the exact report, source, and observation digests; the full
evaluation policy; privacy-safe aggregate arm results; the acceptance delta; and
the `PROMOTE`, `HOLD`, or `ROLLBACK` verdict. It never includes subject keys or
local input/output pathnames, invokes a provider, or changes a route.

Receipt creation is explicit and create-only. An existing file or symlink is
never replaced, and a target created by another process wins without being
changed. Refused or sparse evaluation, malformed or oversized inputs, unsafe
path indirection, source drift, evidence drift, and publication failure leave no
receipt claim. The output is written with mode `0600`, fsynced, and published
atomically in its destination directory.

Verify a handed-off receipt against the exact current evidence before acting on
its verdict:

```bash
loki outcomes canary verify report.json observations.json receipt.json \
  --enable-verification --json
```

The read-only verifier takes the policy from the canonical receipt, independently
reruns the deterministic evaluation, rechecks the report, source, and observation
bytes, and requires the complete rederived receipt to match exactly. It returns
`VERIFIED` only for the same bound evidence, aggregates, policy, and verdict.
Missing, symlinked, oversized, malformed, non-canonical, sparse, refused,
substituted, or drifted inputs fail closed without writes, telemetry, provider
calls, or route changes.

## Record an observation

Use the installed recorder instead of hand-editing the observation contract:

```bash
loki outcomes canary record report.json observations.json \
  --enable-recording --subject '<locally chosen opaque key>' \
  --accepted --risk 0.10 --control-route safe --canary-percent 10
```

Choose exactly one of `--accepted` or `--rejected`. The risk value is a finite
number from zero through one. The recorder independently reproduces the subject's
deterministic assignment and route, then creates or appends one canonical item
through an atomic local replacement. Existing report and source bindings must
match, and every prior item is rebound before the append is accepted.

Recording is explicit and local: the command never invokes a provider, changes a
route, or emits the subject or input pathname. Duplicate subjects, symlinks,
malformed or oversized evidence, binding drift, assignment drift, and unsafe
values are refused without changing the observation file. A sidecar `.lock` file
serializes cooperating writers.

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
