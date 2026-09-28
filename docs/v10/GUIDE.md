# Loki 10 engine guide

Opt-in: set LOKI_ENGINE=v10 <!-- loki10-default -->

Loki 10 is the rewritten engine (docs/v10/ENGINE.md). It is not the default
yet. Every command below only runs when LOKI_ENGINE=v10 is set; leave it
unset and `loki` keeps using the current (legacy) engine exactly as before.

Some pieces named in this guide are still being built. Each one below says
so plainly instead of describing a finished feature.

## Quickstart

Put the task first, as a quoted multi-word string, so bin/loki's router
sends it to the v10 engine instead of the legacy one. A one-word argument
that is not an issue ref, or any first argument starting with `-`, stays
on the legacy engine.

```
LOKI_ENGINE=v10 loki "fix the login redirect loop" --no-pr
```

Issue refs work the same way:

```
LOKI_ENGINE=v10 loki owner/repo#123
LOKI_ENGINE=v10 loki https://github.com/owner/repo/issues/123
```

bin/loki routes GitHub, GitLab (`.../-/issues/N`) and Jira
(`.../browse/KEY`) issue URLs to the v10 engine, and the issue-fetch step
(autonomy/issue-providers.sh) fetches title/body/labels from all three.
Only the extra already-done check (an issue's `state` and whether it was
closed by a merged PR) is GitHub-only; a GitLab or Jira issue still runs,
just without that extra signal.

Flags, from the engine's own `--help`:

- `--no-pr`: build and verify, but skip opening a pull request.
- `--deep`: request the deep verify pass; the implement time budget goes
  from 480s to 1800s (`loki-ts/src/engine10/types.ts`).
- `--provider <name>`: pick the coding provider for this run. See the
  provider table below.
- `--resume <run-id>`: continue a run that was interrupted.

`--no-pr`, `--deep` and `--provider` are parsed by the supervisor
(`loki-ts/src/engine10/supervisor.ts`) and take effect on a real run.
`--resume` is not wired yet: passing it prints `engine10: --resume is not
wired yet` and exits 2. Its shape is documented here because it is already
fixed in `--help`.

`loki status`, `loki verify` and `loki dashboard` are all built on main
(status.ts, verify_cmd.ts, dashboard/server.ts) and route through cli.ts's
table like any other subcommand.

The free-text and issue-ref run itself (the supervisor that plans, builds
and verifies) is wired into the CLI on main: `loki "<task>"` and `loki
<issue-ref>` run the full worker flow (intake, plan, wall, implement,
verify, seal) and then, in the supervisor, the pr stage, ending in the
5-line summary below.

Slack is not part of the v10 engine surface (no command, no notification
hook) and is in progress, tracked with the other wave 3 items.

## The 5-line summary

A finished run prints five lines, one label each:

```
PR:         https://github.com/owner/repo/pull/1
Verdict:    VERIFIED
NOT PROVEN: full suite, app boot, council, security scan
Cost:       $0.42 (claude, 212k tokens)
Time:       4m12s (intake 11s, plan 20s, implement 3m10s, verify 31s)
```

- **PR**: the opened pull request URL, or `none` when the run used
  `--no-pr` or never got that far. A draft PR adds the draft reason in
  parentheses.
- **Verdict**: one of VERIFIED, PARTIAL, ALREADY_SATISFIED, SPEC_CONFLICT or
  FAILED.
- **NOT PROVEN**: everything the run did not check, comma-joined. Never
  empty by omission: a check that was skipped or deferred is always listed
  here, not silently dropped. A flaky test found during verify appears as a
  separate `; flaky ...` clause on the same line.
- **Cost**: the provider-reported dollar figure and token count. When the
  provider does not report cost, this line reads `not measured` instead of
  `$0.00`; a missing cost is never rendered as free.
- **Time**: total wall time, then each stage's own duration in parentheses.

This formatter (`loki-ts/src/engine10/output.ts`, `formatSummary`) is
called by the supervisor at the end of every run, so a real `loki "<task>"`
or `loki <issue-ref>` run prints this block on completion. The block above
is that function's real output, not a mockup.

## NOT PROVEN

NOT PROVEN lists what a run did not verify, so a passing run is never read
as more thorough than it was. One entry is unconditional, written by Seal
every time:

- **The deep checks**: `full suite, app boot, council, security scan`.
  They are deferred to a separate deep-verify pass, so Seal always lists
  all four at seal time.

Seal also adds an entry whenever it applies, for example: `cost not
measured (no iteration ids recorded)`, `kill blocking not enforced` for
any provider other than claude, `worker killed by the supervisor backstop
(cap plus grace)`, `event log modified outside the engine`, a flaky test,
a reverted test edit, a model override a non-claude provider could not
honor, a task source the intake step did not record, an uncomputable
diff, an individual check that did not run, or a failed receipt signature.
The Cost line above separately reads `not measured` (never `$0.00`)
whenever the provider reported no dollar figure.

## Receipts

A run writes `.loki/runs/<run-id>/receipt.json` and a matching
`receipt.md`. The JSON receipt's `receipt_sha256` hashes the canonical JSON
without the `verification` block, so verifying a receipt never has to trust
its own signature field to compute the hash it is checking.

`loki verify [run-id]` re-hashes the receipt and checks its signature. A
receipt with no signing key configured (or a key that failed to load) reads
`UNSIGNED` and is never presented as attested; a signed receipt reads
`SIGNED (kid ...)`.

## Provider table

| Provider | Cost measured | Kill blocking enforced |
|----------|----------------|--------------------------|
| claude   | yes            | yes                      |
| codex    | no             | no                       |
| cline    | no             | no                       |
| aider    | no             | no                       |
| opencode | not supported  | n/a                      |

For codex, cline and aider, a run's Cost line reads `not measured` and the
NOT PROVEN line adds the literal entry `kill blocking not enforced`
(`loki-ts/src/engine10/stages/seal.ts`). opencode is not one of engine10's
provider names (`claude`, `codex`, `cline`, `aider`); it is not supported.

## After the flip

Once v10 becomes the default (docs/v10/DECISIONS.md, D29), `loki`, `loki
status`, `loki verify` and `loki dashboard` with no `LOKI_ENGINE` set will
mean the v10 commands described above. The previous engine stays fully
reachable: `loki legacy <args>` and `LOKI_ENGINE=legacy` both route to it,
unchanged. Nothing is removed at the flip.

That flip has not happened on main as of this guide. The opt-in line near
the top of this file and of README.md's section is the one place that
records which state we are in; it changes in the same commit as the flip
itself.
