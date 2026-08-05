# Cost controls

You set the ceiling. We stop at it, and the receipt tells you where the money
went.

## Why this page exists

"I paid for the AI's own mistakes" is one of the sharpest complaints in this
category, and it is worth being precise about how our model differs.

Most competitors sell credits. Lovable has already addressed the objection
directly -- their "Try to fix" button does not consume credits, and their
troubleshooting docs push you toward reverting or replanning instead of
retrying the same prompt. That is a good policy and we are not claiming to have
invented a better one.

**Our model is different in kind: you bring your own provider credentials.** We
never bill you, because we are never in the payment path. What we owe you
instead is a hard ceiling and an honest account of what was spent -- which is
what this page describes.

## The three caps

They bound different things, and a run that stalls needs all three.

| Cap | Bounds | Default |
|---|---|---|
| `LOKI_BUDGET_LIMIT` | Total spend, in USD | unset (no cap) |
| `LOKI_MAX_ITERATIONS` | Number of iterations | 1000 |
| `LOKI_MAX_DURATION` | Wall-clock time | unset (no cap) |

```sh
LOKI_BUDGET_LIMIT=25 loki start ./prd.md
loki start ./prd.md --max-duration 90m
loki config set budget 25
```

**Why three and not one.** Spend and iterations both assume forward progress. A
run that *stalls* -- a hung provider call, a wedged subprocess -- burns hours
while spending almost nothing and completing no iteration, so neither of those
breakers ever trips. The wall-clock cap is the one that catches it. We added it
after a run burned $34 reaching an external timeout.

## Hitting a cap is a FAILURE, not a success

This is the part that matters for anyone automating against us.

All three caps produce a **terminal failure**: exit 20 under
`LOKI_DURABLE_STATE=1`, with a distinct status (`budget_exceeded`,
`max_iterations_reached`, `max_duration_reached`) so the receipt and `loki why`
can tell you *which* ceiling you hit and therefore which one to raise.

`budget_exceeded` used to exit **0**, on the reasoning that a human would raise
the cap and resume. That is true at a terminal and false inside a Kubernetes
Job, where there is no human: the Job went Complete, the pipeline went green,
and an incomplete build looked finished. Exit 0 now means the work is finished
or a person deliberately stopped it -- never that we ran out of money mid-task.

See [exit codes](./exit-codes.md) for the full contract.

## Preview the cost before spending anything

```sh
loki plan ./prd.md --json
```

Reports complexity, estimated iterations, token usage and cost **without
executing**. No provider call, no spend. `LOKI_CONFIG_DUMP=1 loki start ./prd.md`
prints the resolved configuration and exits, so you can confirm your caps are
actually set before a real run.

## What you are charged for, stated plainly

Every iteration calls your provider, including iterations spent re-running
after a quality gate fails. **We do not exempt our own gate failures from your
budget**, and pretending otherwise would be dishonest -- those calls really do
consume your tokens.

What we do instead:

- the caps above bound the total, so a doom loop has a hard ceiling
- the Evidence Receipt records iteration count and cost, so a re-run is visible
  rather than buried
- reaching a cap reports as a failure with the reason named, so you know whether
  to raise the ceiling or narrow the spec

If a run cost more than you expected, `loki proof show <id>` tells you where it
went.
