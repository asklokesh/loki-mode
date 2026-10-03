# Factory Operations (skill module)

**Purpose:** the operating system for running multiple agent teams against this
repo at once without losing work, without false greens, and without the teams
blocking each other.

**Scope:** this module governs COORDINATION (who decides what, who owns which
file, how many things run at once, what a blocked team does). It does not
restate the release procedure, which lives in `skills/release-cadence.md` and,
authoritatively, in the CLAUDE.md "Release Workflow" section.

**Relationship to `skills/sdlc-fleet.md`:** that module defines the six roles
for ONE change. This module defines what happens when several such fleets run
concurrently. Read sdlc-fleet.md for the roles; read this one for the traffic
rules between them.

**REGISTRATION REQUIRED (blocking).** `tests/test-skill-doc-accuracy.sh:126-133`
loops every `skills/*.md` and FAILS any file that `skills/00-index.md` cannot
route to. Measured on creation: the suite went from 57 passed / 0 failed to 57
passed / 2 failed, both failures being this file and `release-cadence.md`.
Until a routing row is added to `00-index.md`, the gate is red. This is the
cross-cutting-registration failure class this repo already records: a new
artifact needs ALL its registrations, not just its own file.

**The spine of this module, read section 7 first.** Every rule below exists to
stop ONE failure shape: **a measurement that cannot see the thing it claims to
measure.** It is worse than no measurement, because it emits a log line that
looks exactly like evidence. SIX instances were observed in a single session on
2026-09-14, in six different tools: a staleness guard that read the wrong
registry row, a verification loop whose comparison errored on every file while
printing OK, a `grep` over a built artifact that silently found nothing because
the file contains NUL bytes, a 0/3 benchmark that never reached the tool, a
`git push` that reported exit 0 while origin never moved, and a shell glob
failure that returned rc=0 without ever running the search.
Section 7 carries the evidence table and the three rules that fall out. The
coordination rules in sections 1 through 6 are what keep a factory of parallel
agents from manufacturing these at scale.

A note on the evidence in this file: every mechanism claim carries a
`file:line` or a measured number with its date. Line numbers drift, so each
citation also names the label, function, or string to grep for. Where a number
is quoted it is the number already measured and recorded in this repo; nothing
here is estimated.

---

## 1. Roles: what each one DECIDES vs what it ADVISES

The distinction matters because a role that only advises must never be able to
stop work, and a role that decides must never be overridden by consensus. Most
coordination failure in this repo has been a role acting outside its column.

| Role | DECIDES (binding) | ADVISES (non-binding) |
|---|---|---|
| **Chief of Staff** (the integrator session) | Work partition and file ownership; WIP admission; when to escalate to the founder; integration of parallel outputs | Implementation approach inside a team's slice |
| **PM** (per workstream) | Scope and acceptance criteria for its workstream; accepts or rejects the delivered slice against those criteria | Sequencing relative to other workstreams (the CoS decides that) |
| **Dev Fleet** (3-5 engineers, parallel) | Implementation detail within an owned file set | Scope changes; anything touching a file it does not own |
| **SDET** | Whether a test actually exercises the acceptance criterion | Whether the feature ships (that is the council's call) |
| **Council Reviewers** (3, parallel) | SHIP / NO-SHIP. Unanimous APPROVE required | Style preferences, which are findings, not vetoes |
| **Release Captain** | When the VERSION bump is pushed, and sole ownership of main during a release window | Content of the release (the PM and council settled that already) |

Three rules that follow, each of which this repo has broken and paid for:

**The Chief of Staff does not write code in a file an agent owns.** Not a
one-line fix, not while the agent looks idle. An agent holds the file's prior
content and writes whole regions from its own buffer; an edit made underneath
it vanishes with no conflict and no error. Measured on 2026-08-08: a
`--allow-unanchored` flag added by hand to `autonomy/loki` while an agent was
running was silently discarded, and `grep -c` returned 0 for code that had
just been verified with `bash -n`. `Edit` warns in the reverse direction only;
nothing protects the lead. If a requirement has not landed after two asks, the
fix is a third message carrying a measured number and the exact distinction
wanted, not an edit.

**The council decides ship, and 2-of-3 is never acceptable.** This is
inherited verbatim from `skills/sdlc-fleet.md:83` and CLAUDE.md's standing
fleet pattern. A CONCERN or REJECT sends the integrator to the source to
validate it; a valid concern means fix and RE-RUN the entire council, not
patch and count votes again.

**The Release Captain owns main during a release window.** See section 5.

---

## 2. Partition: how two teams never edit the same file

### 2.1 Per-file ownership is the primary mechanism

Every spawn brief states two things explicitly:

1. the exact file set this agent OWNS and may write, and
2. the file sets the OTHER concurrent agents own.

Point 2 is not courtesy. In the 2026-08-08 session the briefs carried per-file
ownership and the only collision that occurred was the one the lead created by
editing an owned file directly.

An agent that needs a change in a file it does not own does not make the
change. It reports the required change to the Chief of Staff, who routes it to
the owner. A cross-cutting change with no single owner is a signal the
partition is wrong; re-partition rather than letting two agents negotiate.

### 2.2 Worktree isolation is the EXCEPTION, not the default

The generic advice is "give each team a worktree." In this repo that is wrong
most of the time, and confirmed wrong twice on 2026-07-15.

Worktree agents cut their tree from the repo's DEFAULT branch (main),
regardless of your committed feature HEAD. With v8 work committed to
`feature/v8-agent-sdk` at HEAD `d3cd833c` (VERSION 8.0.0), every worktree agent
still got a tree at `08a09b19` (main, VERSION 7.129.3). Files that existed only
on the feature branch "did not exist" to those agents, and their diffs were
against main's version of shared files.

The rule:

- Feature-branch work that is ahead of main: do NOT use worktree isolation.
  Run agents without isolation against the live tree, partitioned by file
  ownership.
- Agents writing DISJOINT NEW files: no isolation needed; there is nothing to
  collide.
- Same-file parallel mutation, AND your base == main: worktree isolation is
  correct and is what it is for.

After any worktree reconcile, re-run parse checks (`bash -n`, `ast.parse`,
typecheck) on every reconciled file and confirm your own earlier edits to those
files survived the patch. A patch to a nearby hunk can silently coexist with or
clobber them.

### 2.3 A red test during a review window may be someone else's mutation

Council and mutation-testing agents work by copy -> mutate -> assert red ->
restore. While they run, the tree transiently contains deliberate breakage.
A suite that goes red mid-cycle on a file an agent is reviewing is that agent's
proof-of-catch, not a regression. Do not act on it, and do not run those tests,
until the agents complete. A `<system-reminder>` reporting such a file as
"modified ... intentional" has been observed reporting an agent's transient
mutation that was reverted seconds later.

---

## 3. WIP limit

**The limit: one verification gate at a time, and at most 3 concurrent
implementation streams.**

### 3.1 Why one gate, not more

This is the non-obvious half, and it is not about agent capacity. The gate
refuses to run concurrently by design. `scripts/local-ci.sh:69-80` (grep
`SINGLE INSTANCE`) records four suites measured on 2026-07-30 that FAILED under
concurrent load and passed cleanly in isolation:

| Suite | Under load | Alone |
|---|---|---|
| `tests/cli/test-alias-forwarding.sh` | FAIL | 213 passed, 0 failed |
| `tests/test-plan-command.sh` | FAIL | 27 passed, 0 failed |
| `tests/test-proven-pr-receipt.sh` | FAIL | 14 passed, 0 failed |
| `tests/test-heal-assess-readiness.sh` | FAIL | 8 passed, 0 failed |

The script's own reasoning is the load-bearing part: "Hours were spent treating
those as defects. Worse, a phantom failure trains the reader to distrust the
gate, which is exactly how a REAL failure gets waved through. Refusing to start
is cheaper than a verdict nobody believes."

So WIP is bounded by VERIFICATION SERIALIZATION, not by how many agents can be
spawned. Throughput above that bound is not throughput; it is a queue of
unverifiable work plus a gate nobody believes.

The same effect has been seen at the suite level: a provider-backed review
suite once sat 28 minutes at 0.06s CPU under overlap, then passed 8/8 in
isolation (`scripts/local-ci.sh:1138-1140`, the `LOCAL_CI_SERIAL` fallback
comment).

### 3.2 Why 3 implementation streams

`LOKI_MAX_PARALLEL_SESSIONS` defaults to 3 (`skills/parallel-workflows.md:180-181`,
grep `caps parallel Claude sessions`).
The honest ceiling documented there is "dozens, not thousands", for a reason
that is a coordination fact rather than a hardware one: "The 3-reviewer council
is a serialization point: every non-trivial change funnels through blind review
before merge, so review throughput, not spawn count, sets the end-to-end pace"
(`skills/parallel-workflows.md:216-218`).

Spawning a fourth stream does not produce a fourth shipped change. It produces
a third change that waits longer, because the council and the gate are both
serial. Raise the stream count only after measuring that review throughput has
risen, never in the hope that it will.

Opt-in dynamic concurrency (`LOKI_DYNAMIC_CONCURRENCY=1`) only ever reduces the
cap under CPU or memory pressure; it never raises it above the configured
ceiling.

### 3.3 The admission rule

A new stream is admitted only when all of these hold:

- fewer than 3 implementation streams are active,
- no gate run is in flight,
- the new stream's file set is disjoint from every active stream's file set,
- main is not inside a release window (section 5).

If any fails, the work is QUEUED, not started. A queued item with a written
owner and file set is cheap. A started item that collides is expensive twice:
once to discover, once to reconstruct.

---

## 4. Escalation: what a blocked team does instead of waiting

Waiting is the failure mode. A blocked agent that idles burns the WIP slot that
bounds the whole factory. The rule is: **every block converts into either a
reroute or a written escalation within one turn.**

Route by the KIND of block:

| Block | Action | Never |
|---|---|---|
| Needs an edit in a file another agent owns | Report the required change to the Chief of Staff with the exact diff intent; continue on the rest of the owned slice | Edit it yourself |
| Ambiguous scope | Escalate to the PM, who uses `AskUserQuestion` to lock it. Per `skills/sdlc-fleet.md:40`, NEVER guess at scope | Pick an interpretation and build |
| Gate is red | Read the actual assertion and the whole guard above it before bisecting; the assertion type names the failing line | Call it environmental |
| Gate red and unreproducible | Re-run on the IDENTICAL SHA first. A rerun proves flake AND diff-innocence for free | Edit the test to make it pass |
| Blocked on a gate run held by another stream | Queue behind it and do useful non-gate work (plan the next item, write the test, draft the brief) | Start a second concurrent gate run |
| Dependency on an unfinished stream | Stub the seam, write the test against the seam, hand back | Block until the other stream lands |
| Red that nobody in the repo can clear (external state, credentials) | Escalate to make the guard ADVISORY: report and exit 0 on the push path, hard exit behind a scheduled-job env var. See section 7.1 | Leave a permanent red on every push |
| A check that passed but you cannot show how it could fail | Treat as UNVERIFIED and add a positive control before reporting. See section 7 | Report the green |
| An operation that stalls (push, build, gate, agent) | MEASURE whether it is alive first: process table, output mtime, downstream state. See section 4.1 | Retry it, or abandon it |

### 4.1 A stall is a measurement problem, not a patience problem

**When an operation stalls, the first action is to measure whether it is ALIVE,
before retrying or abandoning.** A retry on a wedged operation produces a second
wedged operation and destroys the evidence of the first. Abandoning it discards
the same evidence more quietly.

Three cheap measurements, in order:

1. **Process table.** `ps -eo pid,etime,command | grep <thing>`. This answers
   alive-or-dead, and `etime` answers how long, which is the number that decides
   whether it is slow or wedged. Check ELAPSED before killing anything: a
   name-based match has already killed a 33-hour-old MCP server in this repo
   when the intended target was a 3-minute test.
2. **Output mtime.** A process that is working usually writes. A log whose mtime
   is advancing is alive; one frozen for minutes while the process lives is
   blocked, which is a different fault with a different fix.
3. **Downstream state.** Ask the destination, not your local view. This is the
   only one of the three that can confirm an outward-facing action; see
   section 4.2. For a push,
   `git ls-remote origin main` asks the server; `git rev-parse origin/main` only
   reads a local remote-tracking ref that updates on fetch, so it reports the
   old commit indefinitely and looks exactly like a failed push.

Worked example, measured live on 2026-09-14. A release push to origin/main
appeared to hang for several minutes with origin still at the old commit. Two
documented causes were suspected: the shared `.git/config` identity placeholder,
and `core.bare` spontaneously flipping true. Measurement ruled out BOTH in three
commands:

```
git config --get core.bare        -> false          (not flipped)
git config --get user.email       -> lokeshmure@live.com  (what the hook demands)
ps -eo pid,etime,command | grep -E "git push|pytest"  -> no match
```

No process was alive. The push was not stalled; it was not running. The stale
`origin/main` was a local tracking ref, not the server's state. Had the first
action been a retry, it would have produced a second push against an undiagnosed
repo and erased the evidence that the first one had already exited.

Know the real timings before calling something hung, because the documented
stall has a specific shape and this was not it. `.githooks/pre-push:37-42`
checks identity and fails FAST with a `FAIL:` line. The expensive part is the
pytest run, and `.githooks/pre-push:90-93` scopes it to files changed since
`merge-base HEAD origin/main` and skips it entirely when nothing relevant
changed. The historical 220s "hang" happened because the hook ran the full
3160-test suite BEFORE printing its identity verdict. `git ls-remote` returning
instantly while a push hangs is the tell that it is the hook, not the network.

Elsewhere: macOS Bun CI jobs legitimately take about 22 minutes, so compare
against a prior successful run's `startedAt -> completedAt` before calling one
hung.

### 4.2 An exit code reports a PROCESS, never the WORLD

**Never report an outward-facing action as done based on an exit code.** Verify
that the remote state actually changed:

| Action | Do NOT trust | Assert instead |
|---|---|---|
| `git push` | the command's exit code | `git ls-remote origin <branch>`, compare to local HEAD |
| npm publish | a green publish job | `npm view <pkg> version`, then `gitHead` ancestry (section 5 of `release-cadence.md`) |
| a release | the workflow's conclusion | the artifact exists and is downloadable |
| any registry write | the publisher's exit code | query the registry for the value you wrote |

An exit code answers "did this process end cleanly". Whether the world changed
is a different question, and only the destination can answer it. Every
outward-facing step must assert the second one.

Measured 2026-09-14, and this is instance 5 of the section 7 table. A release
push reported `[exited with code 0]` and the release was nearly announced on
that basis. Origin had not moved. The push was wrapped in `timeout 180`, the
repo's pre-push hook runs pytest, and the timeout killed the hook mid-run while
the WRAPPER reported success. The only thing that caught it was fetching origin
and comparing SHAs.

Confirmed on this checkout minutes later: `git ls-remote origin main` returned
`bb73addb` while local HEAD was `d1e4e6b7`. The server is the authority; a
`git rev-parse origin/main` would have agreed with the stale value indefinitely,
because a remote-tracking ref only moves on fetch.

The same shape has been recorded here before on the publish side: a publisher
that exits 0 on an authentication failure, so a green step meant nothing. Two
different tools, same hour, same lesson.

**Corollary, the timeout rule: never wrap an operation in a timeout shorter than
its own internal gate.** The 180s wrapper sat in front of a hook whose pytest
run alone is ~128s, plus transfer. That converted a working safety gate into a
silent failure, which is strictly worse than having no wrapper: the gate no
longer protects, and its failure is now invisible. Either allow the gate its
full budget, or do not wrap it at all. Before choosing a timeout, measure what
the operation's own gates cost.

Three hard constraints on escalation content:

**Never escalate a zero as a finding.** A 0/N result is the one outcome fully
explained by an environment mistake; every other outcome at least proves the
harness reached the tool. On 2026-08-08 a competitor CLI measured 0/3, and a
known-good CLI with 5 prior successful trials ALSO measured 0/3 in the same
harness. Both zeros were harness bugs (a missing
`--skip-git-repo-check` and a missing `</dev/null`). A zero is reportable only
alongside a positive control that scored non-zero in the SAME harness on the
SAME task, and the control travels with the report.

**Never escalate an absence as evidence.** An empty result is an absent
measurement, not a clean one. A substring search over an empty haystack reports
nothing missing. Assert the haystack is plausibly sized before believing
anything about its contents. `release.yml:120-130` implements exactly this as a
VACUITY GUARD: an empty workflow-runs API result never satisfies the wait loop,
because "no failing runs" over zero runs is not "everything passed."

**Never escalate a red you cannot clear as a blocker.** Drift in external state
that only a credential holder can fix is a REPORT, not a gate. Escalate it as a
request to make the guard advisory, per section 7.1. The measured cost of the
other choice: the MCP registry guard's first version exited 1 from
`run-all-tests.sh`, which every push runs in every shard, so a publishing gap
nobody in the repo could close turned Tests red on every push (run 93989130,
shard 1). A red nobody can clear is how the team learns to ignore reds.

---

## 5. Release windows: main is WIP=1

When a VERSION bump is pushed, main enters a release window that closes only
when npm shows the new version. Inside that window the Release Captain owns
main and NOBODY else pushes to it, including docs.

This is not caution. `release.yml`'s `required-ci` job waits for Tests, Bun
Parity and Security Audit to be green AT THE EXACT RELEASE SHA and fails
closed, treating cancelled, timed_out, failure and skipped as non-passes
(`release.yml:95-171`, grep `cancelled, timed_out, failure, skipped: none is a
pass`). Any later push to the branch moves HEAD and GitHub's concurrency rules
CANCEL the older run at the release SHA. `required-ci` then correctly reports
failure although nothing was broken.

Measured twice. On 2026-08-08, v9.18.0 failed with `FAIL: a required workflow
did not succeed at 8892f477` while Bun Parity and Security Audit were both
green and Tests read `completed/cancelled`. Re-broken on 2026-09-10 by a
docs-only commit pushed during v9.27.3's release, which cancelled its Tests and
stopped the publish. "It is only docs" is not an exemption: concurrency
cancellation keys on the BRANCH, not the diff.

Queue follow-up commits locally. See `skills/release-cadence.md` for the window
procedure and its recovery paths.

---

## 6. Contended main: verify ancestry, never force

Several agent processes run against this checkout at once. On 2026-08-07 a
parallel process force-reset main to a different lineage and five commits
vanished from the remote, including one already reported to the founder as
landed with CI running against it.

- Before claiming a push landed, check ANCESTRY, not equality:
  `git fetch origin main && git merge-base --is-ancestor <sha> FETCH_HEAD`.
  A point-in-time `git ls-remote` match is true at that instant and can be
  false minutes later.
- Never `git push --force*` to main here. `--force-with-lease` compares against
  the lease you name; on a contended branch the lease can match while the
  remote's real lineage has already moved, so the force SUCCEEDS and overwrites
  another agent's work.
- `git push ... | tail -N` MASKS git's exit code; a rejected push reports rc=0.
  Redirect to a file and read `$?` directly.

---

## 7. The void measurement: the failure shape that costs the most

**A measurement that cannot see the thing it claims to measure is worse than no
measurement, because it produces a log line that looks exactly like evidence.**

This is the organizing rule of this module. SIX instances were observed in a
SINGLE session on 2026-09-14, in six different tools, by different people, none
of whom was being careless. One of them is instance 6 below, committed by the
author of this document while writing this section. That rate is why it is
section 7 and not a footnote: it is not a mistake anyone stops making by trying
harder.

| # | The check | What it reported | What was true | Why it was blind |
|---|---|---|---|---|
| 1 | MCP registry staleness guard | drift, 7.34.1 vs 9.50.1 | registry was already current | iterated `servers[]`, took the FIRST name match; the registry keeps every published version as an `active` row |
| 2 | "any stale version string left after the bump" | OK on every file | measured nothing at all | shell arithmetic comparison errored on every file; the error text printed alongside the OK lines |
| 3 | `grep -c '9.50.1' legacy-ui-static/index.html` | no match, rc=1 | the string class IS present | file contains NUL bytes, so grep treats it as binary and silently reports nothing |
| 4 | competitor benchmark | 0/3 | harness never reached the tool | missing `--skip-git-repo-check` and `</dev/null` (2026-08-08) |
| 5 | `git push` wrapped in `timeout 180` | `[exited with code 0]` | origin never moved | the timeout killed the pre-push hook mid-pytest; the WRAPPER's exit code replaced the operation's |
| 6 | `grep -rn ... --include=*.sh` for a precedent | no output, `rc=0` | the search never ran | zsh expanded `--include=*.sh` as a glob, found no match, and aborted the command before grep started |

Instance 5 is the most dangerous of the set: it nearly shipped a false release
announcement to the founder. It was caught only because the operator fetched
origin and compared SHAs instead of trusting the exit code. See section 4.2.

Instance 6 is instructive because it is the cheapest possible version of the
mistake and it still produced a confident wrong answer. A shell glob failure
printed `no matches found` and returned `rc=0`, so a "no results" reading looked
like a verified absence. The fix is the same as everywhere else in this table:
run a positive control. `grep -rl "mcp-publisher"` returned 0 files while the
control `grep -rl "loki-mode"` returned 448 in the same command, which is what
made the zero trustworthy.

Instances 1 and 3 are reproducible right now. For 1, the fix is at
`tests/test-mcp-registry-not-stale.sh:135-143`, which selects on
`official.get("isLatest") is True` and comments the reason: "Taking the first
name match reports whichever row the API happens to order first, which is how
this guard read 7.34.1 as live for hours AFTER 9.50.1 was published and flagged
latest. Select on isLatest, never order."

For 3, measured on this checkout, three tools give three answers for the same
question on the same file:

```
grep -c  'Loki' legacy-ui-static/index.html   ->  (nothing), rc=1
grep -ac 'Loki' legacy-ui-static/index.html   ->  27,       rc=0
python3  ... .read().count('Loki')            ->  91
```

The default tool was silently wrong. A dist check built on a plain `grep` would
have reported clean every single time, which matters here more than anywhere
else: this repo's worst recorded release defect is a stale `loki-ts/dist/loki.js`
shipping the wrong version for 27 releases.

### 7.1 The three rules that follow

**A CHECK THAT CANNOT FAIL IS NOT A CHECK.** Every verification needs a positive
control proving it can produce a non-passing result. This repo already applies
that rule to zeros; extend it to GREENS, because a green from a broken
comparison is indistinguishable from a real green in the log. Instance 2 is the
proof: every line printed OK while the comparison errored on every file.

**NEVER GREP A BUILT ARTIFACT WITHOUT A POSITIVE CONTROL.** Bundles, minified
JS and dist HTML routinely contain bytes that make text tools bail silently. A
grep over dist that finds nothing has not proven absence; it has usually proven
the tool could not read the file. Use a control string known to be present, or
a reader that cannot silently bail (`grep -a`, or Python with an explicit
encoding).

**A GUARD THAT CANNOT SEE SUCCESS IS WORSE THAN NO GUARD.** Instance 1 reported
red against a correct state. A red nobody can clear trains the team to ignore
reds, which is how a REAL red gets waved through. This is the same reasoning
`scripts/local-ci.sh:69-80` gives for refusing concurrent gate runs: "a phantom
failure trains the reader to distrust the gate."

Pair that last one with the repo's existing ADVISORY-GUARD rule, because they
are the two halves of one design. When drift is closable only by a credential
holder, the guard must REPORT and exit 0 on the push path, with the hard exit
behind an env var only a scheduled job sets
(`LOKI_MCP_REGISTRY_STRICT=1`). Precedent:
`tests/test-model-catalog-staleness.sh:97-102` asserts staleness must not change
the exit code, calling it "THE INVARIANT: advisory only." The cost of getting
this wrong is measured: the registry guard's first version exited 1, was
registered in `run-all-tests.sh`, and turned a publishing gap nobody in the repo
could fix into a failing Tests run on every push (run 93989130, shard 1).

Verify that the advisory green did NOT come from silencing the guard: the log
must still print the FAIL line.

### 7.2 Why this is a COORDINATION rule, not a testing tip

Void measurements are what make every other rule in this module load-bearing:

- They are why **WIP is bounded by verification** (section 3). More streams
  produce more checks, and an unverified check is a confident false green.
- They are why **file ownership is exclusive** (section 2). A silently
  discarded edit is a void measurement of your own work: `bash -n` passed, and
  the code was gone.
- They are why **escalations carry controls** (section 4). A finding without a
  control is a claim, and claims do not survive a council.

### 7.3 If this module is ever trimmed

1. **A file belongs to exactly one writer at a time, and the lead is not
   exempt.** Concurrent writes here do not conflict; they silently discard.
2. **WIP is bounded by what can be VERIFIED serially, not by what can be
   spawned.** The gate refuses concurrency on purpose, and the council is a
   serialization point.
3. **Every measurement needs a control that proves it can fail.** Zeros need
   positive controls; greens need them too; empty haystacks need size
   assertions; built artifacts need a reader that cannot silently bail; and
   cancelled is not passed.
