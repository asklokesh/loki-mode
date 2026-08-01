# Fastest First-Pass Completion: measured plan

Goal (founder, 2026-08-01): **fastest first-pass full completion** -- highest
quality output, no waiting through a second iteration, faster than Cursor /
Cognition / Replit on the axis a user actually feels.

This plan is built on measurement first, competitor research second, and it
DISCARDS the intuition I started with.

---

## 1. What the competition actually does (researched, not assumed)

| Vendor | Speed mechanism | Reachable for us? |
|---|---|---|
| **Cursor** | Composer: in-house MoE model, ~250 tok/s (~4x GPT-5/Sonnet). MXFP8 training, no post-train quant. Compaction-in-the-loop RL cuts context errors 50%. | **No.** Custom frontier model. |
| **Cognition** | SWE-1.6 at ~950 tok/s; SWE-bench 51.5%. | **No.** Custom model. |
| **Replit** | Agent 3: ~2 min to visual preview, ~10 min to first app version. Design Mode <2 min. 2-3x gains across 2025. | **Partly.** Their edge is product/lifecycle, not model. |

**The strategic conclusion.** Cursor and Cognition bought speed by TRAINING
THEIR OWN MODELS. We cannot copy that and should stop pretending the gap is
closable that way. Replit's edge is time-to-first-visible-thing, which IS
reachable, because it is a product and lifecycle property.

The industry-wide numbers that matter for us, from the latency research:

- **Tool execution is 35-61% of total agent request time.** Harness, not model.
- Parallel tool calling / speculative execution deliver **2-5x latency
  reduction while preserving correctness**.
- Prompt caching turns repeated-prefix attention from O(n^2) to O(n).

That 35-61% is our lane. It is won by architecture, and it does not require a
frontier lab.

## 2. What we actually cost, MEASURED (this is the surprise)

Real `stage_complete` events from builds on this machine (n=35):

| stage | n | median s | max s | total s |
|---|---:|---:|---:|---:|
| **code_review** | 3 | **281** | **504** | **1055** |
| static_analysis | 5 | 5 | 14 | 26 |
| security_scan | 5 | 1 | 2 | 4 |
| lsp_diagnostics | 4 | 1 | 1 | 2 |
| test_suite | 4 | 0 | 1 | 1 |
| mutation_integrity | 4 | 0 | 1 | 1 |
| mock_integrity | 4 | 0 | 0 | 0 |
| doc_coverage | 3 | 0 | 0 | 0 |
| magic_debate | 3 | 0 | 0 | 0 |
| **TOTAL** | | | | **1089** |

**`code_review` is 97% of all measured gate time.** Everything else combined is
34 seconds.

### Two intuitions this killed

**First:** I was about to propose parallelizing the seven sequential gates at
`run.sh:22616-22980`. They ARE sequential and mostly independent. The change
would have been clean, defensible, and worth **about 20 seconds**.

**Second, and worse:** I then proposed parallelizing the reviewer council --
which was **already parallel**. I had grepped the wrong line range, got no
match, and treated that silence as evidence. A plan whose headline item was a
no-op.

Both were caught by going back to data instead of trusting the story. The
standing rule for this document:

> **No optimization ships without a before-number from this table, and no
> claim about how the code behaves ships without reading the code that does
> it.**

An absent grep match is not evidence of absence -- it is evidence the grep did
not match.

### Where the real time goes

Code review dominates, and the driver is **council size**, not sequential
dispatch (see the correction in P0 -- my first reading of this was wrong).

Measured: 3 reviewers finish in 31s; 6-7 reviewers take 177-502s. The council
is already concurrent, so what grows is the max-of-N tail plus contention on a
single provider.

This explains the founder's "21 minutes for a simple GitHub issue" better than
any other measurement taken today: a scoped issue was drawing a 7-member
council containing two overlapping security reviewers.

---

## 3. The plan, ranked by measured seconds returned

### P0 -- CORRECTED: the council is ALREADY parallel. The cost is its SIZE.

**This section originally claimed reviewers ran sequentially and proposed
parallelizing them. That was wrong, and the correction is recorded here rather
than quietly edited out.**

`run_code_review` forks every reviewer with `) &` (run.sh:14803), collects PIDs,
and `wait`s on each (run.sh:14880). It has been parallel all along. My first
grep searched the wrong line range, returned nothing, and I read that silence as
proof of absence -- the same mistake class this codebase has been punishing all
session.

**What the data actually says.** Pairing `code_review_start` with
`code_review_complete` across every recorded review:

| reviewers | seconds | verdict |
|---:|---:|---|
| 7 | 502 | 0 pass / 7 fail |
| 7 | 280 | 1 pass / 6 fail |
| 6 | 177 | 0 pass / 5 fail |
| **3** | **31** | 2 pass / 1 fail |

**3 reviewers = 31s. 7 reviewers = 280-502s.** Roughly 2x the council for 9-16x
the wall clock. Since dispatch is already concurrent, that superlinearity is not
the count itself -- it is that a larger council pulls in slower reviewers and
contends for the same provider, so the max-of-N tail dominates.

**And the 7-member council is partly redundant:**

```
architecture-strategist, maintainer-mergeability,
security-sentinel, review-security,      <- TWO security reviewers
performance-oracle, eng-qa, dependency-analyst
```

`security-sentinel` and `review-security` overlap. `eng-qa` and
`dependency-analyst` are appended agents, not part of the sized battery.

**The real P0, in priority order:**

1. **Deduplicate overlapping reviewers.** Two security reviewers on one diff is
   paying the tail cost twice for one signal. Collapse by mandate, not by name.
2. **Cap the effective council for scoped changes.** The tier map is
   `{simple: 2, standard: 2, complex: 4}` specialists + 2 mandatory. Appended
   agents bypass that sizing entirely, which is how 4 becomes 7. Bound the
   TOTAL, not just the specialist slots.
3. **Bound the tail, not the mean.** One slow reviewer sets the whole council's
   latency. A per-reviewer deadline that records a non-vote (never a silent
   pass) converts a 502s worst case into a bounded one.

Expected: the 6-7 member case moves toward the measured 3-member behaviour
(31s) for scoped work, while `complex` keeps its deeper battery.

**Fail-safe direction is load-bearing:** a dropped or deadlined reviewer must
count as a NON-VOTE exactly as today, never as a pass. Shrinking a council must
never be able to manufacture approval. Guard with a test asserting the verdict
is identical for the same fixture at any council size, and that a deadlined
reviewer never contributes a PASS.

### P1 -- Do not run the full council on iteration 1 of a scoped change

The 8-gate council exists to catch regressions in a large build. On a scoped
GitHub-issue fix, running a 3-reviewer council before the change is even
verified is spending 281s to review something a test run would disprove in 1s.

- Order: cheap deterministic gates FIRST (test_suite, static_analysis,
  lsp_diagnostics -- 6s combined), council only if those pass.
- A failing test means the council would have rejected anyway; running it first
  is strictly wasted wall-clock.
- Expected: on a failing first pass, ~281s saved outright.

### P2 -- Time-to-first-signal (the Replit lesson)

Replit shows a visual preview in ~2 minutes. We show nothing until an iteration
completes. Even when our total time is competitive, the FELT time is worse.

- Emit a first-signal event as soon as the agent's first file write lands.
- `.loki/app-runner/first-preview.json` already exists (write-once, bash route)
  -- surface it, and extend to the non-preview case as "first artifact".
- This is perception, not throughput, and it is cheap.

### P3 -- First-pass correctness (the actual "no second iteration" ask)

Research finding: success now hinges on **specification quality and dynamic
context**, not static upfront planning. Notably, auto-generated context files
REDUCED success ~3% while human-written ones improved it ~4%, both raising cost
20%+. So "generate a big context file" is measurably the wrong move.

What the evidence supports:
- ACE (ICLR 2026): generate -> reflect -> curate as an evolving context loop:
  **+10.6% on coding benchmarks**.
- We already have the seam: `LOKI_INJECT_FINDINGS` feeds structured per-finding
  records into the next iteration.
- The lever is making iteration 1's prompt carry what iteration 2 would have
  learned -- which the existing first-pass-excellence work began and which
  measured 2.8x cheaper with correctness held.

**Do not** add a static generated context file. The data says it hurts.

### P4 -- Prompt-cache discipline (already partly built, verify it holds)

`[CACHE_BREAKPOINT]` splits a cache-stable prefix from a volatile tail. Cache
reads price at 0.1x input. Any always-on instruction added to the wrong side
busts the cache every iteration.

- Add a regression test asserting no volatile content crosses the breakpoint.
- This is a cost lever primarily, and a TTFT lever secondarily.

---

## 4. What we do NOT do

- **Do not train a model.** Cursor and Cognition's speed is bought with custom
  MoE models at 250-950 tok/s. That is not a gap we close with harness work,
  and claiming otherwise would be dishonest.
- **Do not parallelize the seven cheap gates as a headline.** Measured worth:
  ~20s. Do it opportunistically inside P1's reordering, never sold as the win.
- **Do not add static generated context files.** Measured -3% success, +20%
  cost.

## 4b. Shipped, and VERIFIED ON THE REAL CODE PATH

P0-P2 shipped in v8.33.0, v8.34.0 and v8.35.0. Each is default-OFF, so none
changes behaviour until switched on.

The claim "the knob works" was verified by extracting run.sh's ACTUAL selector
heredoc and running it -- not by re-implementing it, which is the mistake that
let three mutations survive across v8.28.0/v8.34.0/v8.35.0:

```
cap=0 -> 6 reviewers: architecture-strategist, maintainer-mergeability,
                      security-sentinel, test-coverage-auditor,
                      performance-oracle, dependency-analyst
cap=4 -> 4 reviewers: architecture-strategist, maintainer-mergeability,
                      security-sentinel, test-coverage-auditor
cap=3 -> 3 reviewers: architecture-strategist, maintainer-mergeability,
                      security-sentinel
```

Two things this proves that a unit test could not:

1. The cap reaches the real selector through the real env, at every level.
2. **The safety property holds in production code**: `architecture-strategist`
   and `maintainer-mergeability` -- the mandatory pair -- survive at cap=3,
   cap=4 and uncapped. Only the appended tail is trimmed. A cap can shrink the
   council but can never remove a mandate.

For the skip knob, `gate_failures` (declared run.sh:22697) and the skip decision
(run.sh:22962) were confirmed to sit in the SAME function scope
(`run_autonomous`, run.sh:20842), so the skip genuinely observes the accumulated
failures rather than an empty shadow.

**Mapping to measured wall clock.** From the table in section 2: 6 reviewers
took 177s and 3 took 31s. Capping a complex-tier council from 6 to 3 therefore
targets the 31s regime for scoped work while `complex` keeps its deeper battery
when uncapped.

**What is still NOT proven:** an end-to-end scoped-issue run with the knobs on.
That requires a real paid build, and until it is measured, the numbers above are
selector behaviour plus historical stage timings -- not a demonstrated
end-to-end improvement. Do not report it as one.

## 5. How we know it worked

Every item ships with a before/after from the same `stage_complete` telemetry
that produced the table above. The acceptance number for the founder's
complaint:

> a scoped GitHub issue completes in **under 5 minutes**, first pass,
> with the council verdict intact.

Current measured critical path for that case is dominated by 281s of
sequential code review. P0 + P1 target exactly that.

## 6. Honest competitive position after this plan

- **vs Cursor** on raw interactive latency: still behind. Different category.
- **vs Replit** on time-to-first-visible: reachable with P2.
- **vs Cognition** on trust: ahead, and that is the moat -- the Evidence
  Receipt, now that the gates behind it actually run (v8.24.0-v8.31.0).

The wedge is **verified-and-fast**, not fastest-in-absolute. We should say that
plainly rather than claim a speed crown we cannot hold.

---

Sources: Cursor Composer blog, VentureBeat Composer coverage, Cognition
SWE-1.6 reporting, Replit Agent 3 reviews, Zylos speculative-execution/parallel
tool-calling research, ACE (ICLR 2026), 2026 context-engineering surveys.
