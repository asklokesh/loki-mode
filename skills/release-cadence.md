# Release Cadence (skill module)

**Purpose:** the shortest VERIFIED path from idea to published. Shortest and
verified are both load-bearing; this repo has shipped fast and shipped nothing
at the same time, four times in a row, and the cost was invisible for days.

**Authority:** the binding procedure is the CLAUDE.md "Release Workflow"
section (version-bump file list, dashboard build, pre-publish validation,
distribution verification). This module does not duplicate that list. It
encodes the CADENCE decisions around it: which gate blocks, what the pipeline
actually enforces for you, and the failure modes that make a release silently
publish nothing.

**Companion:** `skills/factory-operations.md` for role and coordination rules.
Section 5 there (release windows) and section 4 here are the same rule seen
from two sides.

**REGISTRATION REQUIRED (blocking).** `tests/test-skill-doc-accuracy.sh:126-133`
loops every `skills/*.md` and FAILS any file that `skills/00-index.md` cannot
route to. Measured on creation: the suite went from 57 passed / 0 failed to 57
passed / 2 failed, both failures being this file and `factory-operations.md`.
Until a routing row is added to `00-index.md`, the gate is red. A module the
index cannot name is also a module the agent never loads, however binding it
claims to be.

All measured numbers below carry their measurement date. Line numbers drift;
each citation also names a string or label to grep.

---

## 1. The gate decision, and why two files appear to disagree

**The FAST tier is the release gate. The FULL tier is not a blocker.**

That is the founder decision of 2026-07-31, recorded in CLAUDE.md under a
header that says so explicitly: "Local CI Before Every Push (2026-07-31 mandate
-- SUPERSEDES 2026-04-26)".

The measured basis, all from that date:

| Thing | Measured |
|---|---|
| GitHub CI Tests | 31 seconds |
| GitHub CI Release | 2 minutes |
| Local FULL tier | 26m50s |
| 323-suite shell run, serial | ~1440s |
| Same run, sharded 4 ways | 352s (4.1x, 0 failures, identical coverage) |

CI is fast because it shards the 323-suite shell run 4 ways; the local full
tier had no sharding at all. A 26-minute gate cannot sit in front of an hourly
release cadence.

### 1.1 The apparent contradiction, resolved

`scripts/local-ci.sh` prints, on a FAST pass:

```
All FAST-tier local-ci checks passed.
This is NOT push authorization.
```

and on a FULL pass, `Safe to commit + push.` Read alone, that says the opposite
of the mandate above.

Both are correct, because they answer different questions, and the wording is
deliberately pinned. `tests/test-local-ci-tiers.sh:60-70` ASSERTS both strings:
that the fast verdict contains `NOT push authorization`, and that `Safe to
commit + push` appears ONLY in the full branch. This is an invariant under
test, not drift to be tidied away.

The reconciliation:

- **Fast tier is the gate.** A red fast tier BLOCKS the push. It is not
  skippable and it costs about a minute.
- **Fast green is not a verification certificate.** The verdict line exists to
  stop a fast pass being mistaken for a full one. It names what was deferred:
  282 shell suites (~10+ min), blanket pytest 1793 tests (128s), shellcheck
  (118s), plus SBOM, npm audit, license-audit, bun-parity and MCP handshakes
  (`scripts/local-ci.sh:1911-1918`).
- **Full tier is not a release precondition** because its BULK moved to CI,
  which runs it faster. The 323-suite shell run and the pytest blanket are
  covered by Tests, and `required-ci` enforces Tests, Bun Parity and Security
  Audit at the exact release SHA (section 3). Blocking locally on those buys
  latency without buying coverage.

Be precise about what that does NOT cover, because "CI has it" is false for
part of the deferred list. Measured by grepping `.github/workflows/`:
`sbom` appears in three workflows (`sbom.yml`, `release.yml`,
`security-audit.yml`), but **shellcheck, license-audit and the MCP handshakes
match no workflow at all.** Those items are checked NOWHERE until somebody runs
a full tier deliberately. This is the same point CLAUDE.md makes from the other
direction: "Of seven real defects found on 2026-07-31, four were caught by the
local gate ALONE -- GitHub CI has no equivalent check."

So the trade is explicit: skip the full tier for cadence, and accept that a
shellcheck or license regression can reach main. Run the FULL tier when
diagnosing something specific, on a quiet cycle, or after changes concentrated
in shell scripts or dependencies. Never as a release precondition.

Caveat worth carrying: `scripts/local-ci.sh:1903-1905` justifies its verdict
text by citing "CLAUDE.md mandates the full gate before every push", which is
the SUPERSEDED 2026-04-26 rule. The string is right and pinned; its stated
reason is stale. Do not let the comment talk you into blocking a release on the
full tier.

---

## 2. What the fast tier must contain: the artifact rule

**A check that guards the SHIPPED ARTIFACT must run in the FAST tier.** It is
the only tier that runs before every push, and GitHub CI has no equivalent
check, because everything works fine from a git checkout.

This is the most expensive lesson in this repo's release history. Four releases
(v8.38.0 to v8.41.0) were spent discovering that the checks guarding the
shipped package were themselves unguarded:

- Four quality-gate detectors under `tests/` were never in `package.json`
  `files[]`, so mutation-integrity fail-closed on EVERY iteration for EVERY npm
  user. First-pass completion was impossible regardless of model output. Found
  only because telemetry showed a gate failing in 0-1 seconds across 3 of 3
  iterations; real analysis cannot run in zero seconds.
- The committed `loki-ts/dist/loki.js` hardcoded version 8.11.0 for 27
  releases, because the dist-freshness check was DEFERRED by the very fast tier
  that CLAUDE.md justifies with dist freshness.
- `npm pack tarball contents` was also deferred, and when promoted turned out
  to pass on "6 or more" matches of 6 patterns that healthily produce 8. It
  tolerated losing two required artifacts and could not say which.

Those checks are now on the fast-tier keep list by name, each with its measured
cost (`scripts/local-ci.sh:210-245`, grep `_FAST_KEEP`):

| Kept check | Measured cost |
|---|---|
| `dist/loki.js is a fresh build of src` | one `bun run build`, ~40ms |
| `npm pack tarball contents` | 1.6s |
| `Agent SDK is a resolvable root dependency` | 21ms |
| `parent checkout is not falsely marked bare` | sub-second |

against a roughly 60s tier. The keep list is an ALLOWLIST, not a denylist:
the fast tier states positively what it runs, so a newly added slow check
cannot quietly drift into it (`scripts/local-ci.sh:108-127`).

### 2.1 The two rules that generalise past packaging

**Assert each required thing individually, never a count.** A threshold cannot
say WHICH artifact vanished, and it absorbs slack it was never meant to have.
The "6 or more of 6 patterns that produce 8" check is the worked example.

**Guard against vacuity.** An empty result is not evidence; it is an absent
measurement. A substring search over an empty listing reports nothing missing.
`npm pack` writes its listing to STDERR, so `2>&1 >file` captures build chatter
instead and makes every assertion pass. Assert the haystack is plausibly sized
first.

The pipeline already implements this rule in two places, and both are worth
copying rather than reinventing:

- `release.yml:120-130` VACUITY GUARD: an empty workflow-runs API result never
  satisfies the wait loop, because "no failing runs" over zero runs is not
  "everything passed."
- `release.yml:520-535` takes the LAST line of `npm pack --silent`, because
  prepack's bun build writes to stdout too and a naive capture would be three
  lines rather than a filename.

---

## 3. What the pipeline enforces for you

Know this before adding a local check: duplicating it wastes cadence, and
assuming it wastes releases.

`on: push, paths: [VERSION], branches: [main]` (`release.yml:3-8`). Then:

**`gate`** runs bash syntax validation, then Bun typecheck plus `bun test`,
then Python tests. The order is not cosmetic. v9.49.0 died on a one-line TS2322
in `doctor.ts`; because the typecheck ran LAST, the job spent ~3m46s on pip
installs and the full pytest suite before tsc failed in 7 seconds (measured on
run 34724377951: gate 4m03s total). Cheapest failing check first is now the
rule, and nothing about what is verified changed, only the order.

**`required-ci`** (`needs: gate`) polls the check-runs API for Tests, Bun Parity
and Security Audit AT THE EXACT RELEASE SHA, waiting up to 2400s and failing
closed. Its direction is load-bearing: "cancelled, timed_out, failure, skipped:
none is a pass." It deliberately polls rather than re-running the matrix inline,
because re-running would verify a DIFFERENT execution than the one the branch
was judged on, at double the cost for a weaker guarantee.

**`release`** (`needs: [gate, required-ci]`) creates the tag, the GitHub
release and its artifacts. Publish jobs hang off `needs: release`:
`publish-npm`, `publish-docker`, and the others are PARALLEL SIBLINGS. That has
a consequence the npm job documents: "the channel with the assertion cannot
stop the one without it, and npm has already shipped by the time Docker goes
red" (`release.yml:523-525`). A per-channel assertion protects only its own
channel.

`publish-npm` asserts the PACKED tarball embeds the current VERSION, not the
worktree, because `prepack` rebuilds dist during publish and SWALLOWS a failed
build (`|| echo 'WARN: ... using existing dist if present'`), yielding exit 0
and a tarball carrying a stale dist. The committed dist legitimately lags
VERSION: 9dfb18d2 shipped VERSION 9.50.1 with a committed dist embedding
9.50.0, and npm published 9.50.1 correctly because prepack rebuilt it.
Asserting on the worktree would have failed that good release.

---

## 4. The two ways a release silently publishes nothing

Both have happened more than once. Both look like success from the terminal.

### 4.1 The VERSION bump must be the push HEAD

`on: push, paths: [VERSION]` fires only if the VERSION-changing commit is the
HEAD of the push. GitHub creates a workflow run for the push head only. Bump
VERSION, keep working, push the batch, and the release silently no-ops.

Verified through the Actions API (`repos/.../actions/runs?head_sha=<sha>`):

| Commit | Tests runs |
|---|---|
| `c86115d5` (v9.14.0 bump) | 0 |
| `5d081dbc` (v9.15.0 bump) | 0 |
| `151b7401` (v9.16.0 bump) | 0 |
| push heads (`4158b6c1`, `1b7069ba`, `946cf472`) | 1 each |

loki-mode shipped 9.13.0 through 9.16.0 to git with full CHANGELOG entries
while npm latest stayed 9.12.6, and 15 commits landed after the 9.16.0 bump.
It survived four rounds because the releases were reported as shipped without
checking npm.

`scripts/release.sh` has always been correct: it commits (`:227`) and pushes
(`:235`) back to back, so the bump IS the head. The failure came from bumping
by hand and bypassing it. Use `scripts/release.sh`, or make the VERSION bump
the last commit before the push.

Recovery for an already-stranded bump needs BOTH dispatches, because
`security-audit.yml` shares the `paths: [VERSION]` trigger and `required-ci`
fails closed on "Security Audit: not reported yet":

```bash
gh workflow run security-audit.yml --ref main
# wait for Tests + Bun Parity + Security Audit green at the SAME sha
gh workflow run release.yml --ref main
```

Note: a fast-tier check named "VERSION is not stranded ahead of the last
release" was recorded as the going-forward detection for this. It is NOT
present in `scripts/local-ci.sh` today (grepped on two independent term sets,
zero matches). Until it exists, this failure mode is caught only by the
post-release npm verification in section 5. Treat that verification as
mandatory, not as belt and braces.

### 4.2 Pushing during the window cancels the release's Tests

After a VERSION push, push NOTHING to that branch until npm shows the new
version. Any later push moves HEAD, GitHub's concurrency rules CANCEL the older
Tests run at the release SHA, and `required-ci` correctly refuses to treat
`cancelled` as a pass.

On 2026-08-08 v9.18.0 failed with `FAIL: a required workflow did not succeed at
8892f477`. Nothing was broken:

```
Tests: completed/cancelled
Bun Parity: completed/success
Security Audit: completed/success
```

Re-broken on 2026-09-10 by a docs-only commit pushed during v9.27.3's release.
"It is only docs" is not an exemption: concurrency cancellation keys on the
BRANCH, not the diff.

Diagnose by reading the per-workflow status lines before assuming a test
failure; `cancelled` and `failure` look identical in the job summary and have
completely different fixes. Recovery without a version bump: rerun the
cancelled **Tests** at the release SHA first, then rerun **Release**. A later
commit that does not touch VERSION fires no Release of its own, so there is
nothing else to wait for.

Rewriting the same VERSION value is "nothing to commit" and the trigger never
fires. Re-releasing needs a REAL change to VERSION.

---

## 5. After the push: verify provenance, not the version string

A matching version on npm is NOT evidence that your tree shipped.

On 2026-08-08 npm `latest` read 9.17.0 within minutes of a release push and the
version matched the bump. It was a different build: the published tarball's
`gitHead` was `00b9f4e2`, a commit that is not even an ancestor of main,
published by a parallel agent's release run that won the race. The package was
functional and contained none of the fixes its own CHANGELOG described.

Several agents run against this checkout at once. Two release workflows for the
same version both start; the first to reach `npm publish` takes the version and
the second fails on version-conflict.

So verify:

```bash
npm view loki-mode@<V> gitHead
git merge-base --is-ancestor <gitHead> HEAD
```

and confirm a specific fix is present in the published tarball WITH A POSITIVE
CONTROL, so an empty grep cannot read as clean:

```bash
npm pack loki-mode@<V> && tar xzf loki-mode-<V>.tgz
grep -c "<fix-string>" package/<file>          # the fix: expect > 0
grep -c "<string-that-must-exist>" package/<file>   # control: proves the grep works
```

A zero without a control is an absent measurement, not a clean result.

### 5.1 Confirm a release-critical fix THREE ways, never one

One green reading proves nothing. Require all three, and record all three:

1. **LIVE** -- the real check against the real source reads the expected value.
2. **NEGATIVE control** -- feed it a canned input representing the BAD state and
   confirm it still reports bad. This proves the check can still fail, so a
   green is informative.
3. **POSITIVE control** -- perturb something that must not matter and confirm
   the answer is unchanged. This proves the green came from the logic, not from
   a coincidence of the input.

Worked example, the MCP registry staleness guard (2026-09-14). The guard read
7.34.1 as live for hours after 9.50.1 was published, because it iterated
`servers[]` and took the first name match, and the registry keeps every
published version as a separate still-`active` row. The fix selects on
`isLatest`. It was confirmed:

- LIVE: reads 9.50.1 against the real registry.
- NEGATIVE: a canned response with `isLatest` on the OLD version still selects
  the old version, proving real drift is still detected.
- POSITIVE: reversing the live array still selects 9.50.1, proving
  order-independence rather than a lucky ordering.

Had only the LIVE reading been taken, a guard that happened to be right for one
ordering would have been declared fixed. See
`skills/factory-operations.md` section 7 for why this shape recurs, and for the
three other instances measured in the same session.

Applies to the artifact greps in this section too: a built artifact can contain
NUL bytes, which makes plain `grep` report no matches and exit 1 on a file that
demonstrably contains the string. Measured on `legacy-ui-static/index.html`:
`grep -c 'Loki'` finds nothing, `grep -ac 'Loki'` finds 27, Python finds 91.
Always pair a dist grep with a control string known to be present.

Then run the post-release distribution validation from CLAUDE.md across npm,
Docker, Brew and GitHub Release, on BOTH routes (Bun and `LOKI_LEGACY_BASH=1`).
Cleanup uses `loki_run_tmp_create` / `loki_run_tmp_cleanup` from CLAUDE.md's
"Test and Resource Cleanup"; never sweep shared ports, process names, `/tmp` or
`$TMPDIR`.

Timing note before calling a job hung: macOS Bun jobs legitimately take ~22
minutes. Compare against a prior successful run's `startedAt -> completedAt`
first. And npm's registry lags a green publish job by roughly 4 minutes, so a
green job is not yet proof the version is fetchable.

---

## 6. The cadence, end to end

1. **Scope locked** by the PM. No guessing (`skills/sdlc-fleet.md:40`).
2. **Build** inside owned file sets, at most 3 streams
   (`skills/factory-operations.md` section 3).
3. **Council**: unanimous 3-of-3 APPROVE. Any CONCERN or REJECT means fix and
   re-run the WHOLE council.
4. **Gate**: `bash scripts/local-ci.sh` (fast tier). Red blocks. One gate run
   at a time, repo-wide.
5. **Bump VERSION as the push HEAD**, via `scripts/release.sh`.
6. **Window opens**: nobody pushes to main until npm shows the version.
7. **Verify provenance**: `gitHead` ancestry plus a fix grep with a positive
   control.
8. **Window closes.** Queued commits land now.

Steps 4 through 7 are the verified part of "shortest verified path". Dropping
any one of them has already produced a release that reported success and
shipped nothing.
