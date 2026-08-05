# Evaluating Loki Mode

For someone deciding whether to trust an autonomous coding agent with a real
codebase. Every claim below has a command next to it. Run them; do not take our
word for it.

We have deliberately not written a feature grid scoring ourselves against ten
competitors. Those grids are written by the vendor being scored, the criteria
are chosen by the vendor, and no reader can check a single cell. This page only
makes claims you can falsify in a terminal.

---

## 1. The agent hands you a receipt, and it admits what it did not verify

```bash
npx loki-mode tour     # no install, no API key, no spend, no network
```

Output includes:

```
Headline: VERIFIED WITH GAPS

| Files changed | 8                                        |
| Diff sha256   | c2be6fff3e774c387f276277b25fc424f07b667… |
| Tests         | verified (node-test)                     |
| Build         | not_run                                  |
| Security      | findings                                 |
| Cost          | $10.3218                                 |
```

**What to notice:** the headline is not "SUCCESS". Build was not run. Security
has findings. The receipt says so on its own front page.

**Why that is the product.** Every coding agent reports its own completion, and
self-reporting is the thing they are structurally worst at. The receipt
separates deterministic FACTS (diff hash, test result, cost) from AI
ASSESSMENTS, because only four of our eight quality gates are agent-independent
and a receipt implying otherwise would be marketing.

**Check it yourself:** recompute the diff sha256 over the same range and confirm
it matches. If it does not, the receipt is worthless and you should not use us.

---

## 2. Verification runs air-gapped

Deterministic verification makes zero network calls, so it runs inside a
perimeter on code that may never leave the building.

```bash
bash tests/test-airgap-verify.sh
```

That test blackholes every proxy variable, strips the environment, and asserts a
real verdict still comes back. Measured: **8.43 ms**.

**Scope, stated honestly:** verification is air-gapped. **Generation is not.**
Every provider we ship calls a hosted API, and local-weight generation needs
models you would supply. We are not claiming the generation half, and any vendor
who claims a fully air-gapped LLM agent without shipping weights is worth a
second question.

---

## 3. On an existing codebase, the read-only path is genuinely read-only

Brownfield is the harder problem, and the reason to distrust an agent near it is
obvious. So the entry point writes nothing:

```bash
loki modernize heal ./your-repo --assess
git status        # clean. no scratch files, no .loki/, no commits.
```

**Enforced, not promised:**

```bash
bash tests/test-brownfield-assess-readonly.sh
```

That test hashes every file before and after, compares HEAD, and requires a
clean working tree. It is content-addressed, so it does not care *how* a write
might happen.

---

## 4. The harness is model-invariant (and we do not overclaim it)

```bash
cat benchmarks/results/cross-model-eval.json
```

- **Claimed:** the same gates run, the same acceptance is checked, and the same
  receipt semantics apply regardless of which model is behind it.
- **Explicitly NOT claimed:** identical quality or identical speed across
  models. That is not deliverable and we do not assert it.

Measured runs are in that file with wall-clock and iteration counts. Two runs is
two runs; it is not a benchmark suite, and the file says so.

---

## 5. Verification is fast enough to embed

```bash
python3 autonomy/lib/fast_verify.py --path . --diff-base HEAD~1
```

Measured on this repository, 1,932 tracked source files: **11,040 ms before,
19 ms diff-scoped** (298 ms cold, 87 ms warm). That is the difference between a
check you run at the end and a check something else can call as a dependency.

---

## 6. Head to head, on this machine, in ten seconds

The one competitive comparison we will publish, because you can rerun it:

```bash
bash tests/test-competitor-verify-surface.sh
```

It runs `--help` on whatever agent CLIs are installed and checks whether any of
them exposes a command that verifies the agent's OWN output.

Measured 2026-07-30 against every one of the six named competitors that ships
a local CLI:

| CLI | Verifies its own output |
| --- | --- |
| opencode 1.18.9 | no |
| aider 0.86.2 | no |
| codex-cli 0.146.0 | no |
| Claude Code 2.1.220 | no |
| cursor-agent 2026.05.24 | no |
| loki-mode 8.3.3 | yes (`loki proof verify`) |

Devin and Replit Agent ship no local CLI, so they are not covered and no claim
is made about them.

**The detail that makes this honest.** aider matches eight times on
verify/proof/attest terms. All eight are `--verify-ssl` (TLS certificate
validation) and `--git-commit-verify` (git pre-commit hooks). Neither verifies
the agent's output. A count-based comparison would have scored aider 8 against
our 2 and concluded the opposite of the truth, so the test reads every hit
instead of counting them.

**Scope.** This inspects the CLI surface of locally installed tools. Devin and
Replit Agent ship no local CLI and are not covered. Absence from a `--help`
listing is also not proof of absence from a product: a web UI or an API could
expose something the CLI does not. If a competitor does ship output
verification, this test is how we would find out, and the claim above would be
corrected rather than defended.

## 7. Headless latency, five trials per tool

Same task, same machine, artifact verified by content, five trials each:

| CLI | Success | Median | Range |
| --- | --- | --- | --- |
| opencode 1.18.9 | 5/5 | 11s | 4s to 265s |
| codex-cli 0.146.0 | 4/5 | 69s | 48s to 80s (one 300s timeout) |

**Read the range, not just the median.** opencode's first trial took 265
seconds and the next four took 4 to 12. A new user experiences the 265, not the
11. Reporting only the median would hide the thing they will actually feel.

**The timeout is kept in.** Dropping codex's one failure would turn 4-of-5 into
an implied 5-of-5 and overstate reliability.

**Five trials, not one, and that is the point.** An earlier single-shot run of
this same codex command timed out, and publishing it would have recorded
"codex: timeout" as a fact about a competitor when the identical command
completed in 51 seconds minutes later. The spread is the finding.

**What this does not measure.** One trivial file-creation task is not a proxy
for build quality, multi-iteration work, or brownfield capability. It measures
headless invocation latency and nothing else. aider, Claude Code and
cursor-agent have not been run on this task; Devin and Replit Agent ship no
local CLI. Cost is not compared: codex ran on a free tier and opencode's
per-call cost was not recorded.

---

## What we do not have

Stating this plainly, because you will find it out anyway and it is cheaper for
both of us if you find it here.

- **No published enterprise case studies.** We have adoption signal (fork ratio
  well above the norm for a tool this size) but no named enterprise references.
- **No independent third-party benchmark placement.** The SWE-bench Verified
  leaderboard is months stale and every entry on it is self-reported, ours would
  be too.
- **Only the CLI surface is audited, not whole products.** Section 6 measures
  every named competitor that ships a local CLI (opencode, aider, codex, Claude
  Code, cursor-agent) and none exposes output verification. That is a real
  measurement you can rerun, but it is a measurement of `--help`, not of a
  product: a web UI or an API could expose something the CLI does not. Devin and
  Replit Agent ship no local CLI and are not covered at all. Treat this as
  "unclaimed on every surface we can reach", which is stronger than the earlier
  "unclaimed as far as we can verify" and still short of a proven first.
- **Generation is not air-gapped.** See section 2.

---

## The one question worth asking any agent vendor

> When your agent says it finished, what artifact can I check that does not come
> from the agent's own narrative?

Ours is the Evidence Receipt, and section 1 is a two-minute test of whether the
answer holds up. Ask the same question everywhere else.
