# Working on a codebase you already have

Most of this category is built for starting from nothing. If you already have a
repository -- especially a large, private, awkward one -- your options narrow
fast.

## Where the tools actually stand

Verified from vendor documentation, 2026-07-31:

| Tool | Existing repository |
|---|---|
| Lovable | **Cannot import one.** "You can only export from Lovable to GitHub"; two-way sync begins only after Lovable creates the repo. |
| Replit Agent | Imports GitHub (public and private), Figma, ZIP -- into Replit's environment. |
| Cursor | Indexes your repo; embeddings are uploaded, obfuscated and encrypted. |
| Devin | Indexes the repo, plus YAML blueprints producing snapshots each session boots from. |
| Loki | Runs in place, where the code already is. |

That last row is the whole difference, and it is not a preference. For a private
monorepo with internal dependencies and submodules, "upload it to our
environment" is often not a thing anyone is permitted to do.

**Credit where it is due:** Devin has the strongest documented modernization
story of the four -- named playbooks for COBOL, Java upgrades, and
SAS-to-PySpark. If you want a vendor-run modernization program, look at them
seriously. What follows is what we do differently, not a claim that they are
bad at this.

## Start here: read-only analysis before modernizing

```sh
loki modernize ./your-repo --to <target> --dry-run --json
```

Use `--to python3` or `--to java21` (or another target). No provider call needed for `--dry-run`, no API key, no spend, no writes. It reports:

- an **assessment** of what would be required for modernization
- **dependency analysis** with complexity estimates
- **blast-radius reasoning** per file
- **the runtime it detects**: Node engine constraint, dependency count, frameworks present
- **cost and time estimates**

The `--dry-run` flag provides the honest opening move: you learn what would be involved before committing to anything.

## Modernization (planned feature)

Legacy system modernization via `loki modernize <path> --to <target>` is being redesigned in v10. The `--dry-run` path (analysis only) is available now. Full execution (actual modernization with phases) will follow in a future release.

## Behavioral equivalence is the part worth arguing about

Every tool in this category will tell you it preserved your business logic.
Devin's COBOL page says it preserves "critical functionality." What none of them
document is a *procedure* for proving it.

That is the axis we build on:

- **characterization tests** capture what the system does today, quirks
  included, before anything is modernized
- **friction classification** distinguishes accidental mess from load-bearing
  weirdness -- the 30-second sleep that looks stupid and is actually a race-
  condition fix nobody documented
- **a backward-compatibility auditor** blocks removal of unclassified friction
- **the validate phase** checks behavior against the recorded baseline

Then the [Evidence Receipt](../README.md#the-evidence-receipt-dont-trust-the-agent-check-it)
records what was proven and what was not, bound to the specific diff.

"We prove behavior is unchanged" is a stronger claim than "we preserve business
logic," and it is the one you can check.

The full procedure -- what each phase does, what the friction taxonomy
distinguishes, and where the safety gates sit -- is in
[skills/healing.md](../skills/healing.md), with the research it draws on in
[references/legacy-healing-patterns.md](../references/legacy-healing-patterns.md).

### The friction question, concretely

The hardest part of a legacy migration is not translating syntax. It is telling
the difference between:

- a `sleep 30` that is genuinely dead weight, and
- a `sleep 30` that is the only thing preventing a race condition nobody wrote
  down, whose author left in 2019

Delete the second and the system breaks in production, weeks later, in a way
nobody connects to the migration. This is why the auditor blocks removal of
*unclassified* friction: not because the friction is sacred, but because
"we do not know what this does yet" is a real state that deserves a name
instead of a guess.

## Honest scope

- **Measured and working:** `--assess` on real repositories, verified by
  execution.
- **Implemented, not measured here:** the five mutating phases need a provider
  and real spend; this page does not claim an end-to-end benchmark we have not
  published.
- **We do not do COBOL.** If your problem is a mainframe, we are not your
  answer today.
- **Your code stays put.** Nothing is uploaded to us -- there is no "us" in the
  data path. See [cost controls](./cost-controls.md) for how spend is bounded.
