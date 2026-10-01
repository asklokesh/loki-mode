# Competitive Scorecard

Generated 2026-08-03 against Loki Mode v9.8.1.

Every cell in this document is one of three things and nothing else:

- `[measured]` - reproduced on this machine with a command in the "How to reproduce"
  section, whose output is pasted here or in that section.
- `[sourced: URL]` - taken from a public page that was actually fetched on
  2026-08-03. Vendor marketing claims are labelled `vendor-claimed` and are not
  treated as fact.
- `UNKNOWN` - not measured and not sourced. This is a legitimate and common answer
  in this document.

There is deliberately no fourth category in the axis table. Unmarked guesses do
not appear.

One exception, quarantined: section 2b is a **planned** benchmark design. Nothing
in it has been run, none of it is evidence, and it is excluded from the cell
counts below. It is separated precisely so it can never be mistaken for a result.

**Cell census** (the 48 axis-table cells in section 2, being 6 axes x 8 products):
**10 measured, 5 sourced, 33 UNKNOWN**. Two thirds of this document is an
admission of ignorance, which is the honest state of the evidence.

This file is distinct from `docs/COMPETITIVE-ANALYSIS.md`, which is a narrative
positioning document. This one is an evidence ledger and makes no claim it cannot
back with a pasted command output or a fetched URL. Where the two disagree, this
file is the one with the receipts; no attempt is made here to reconcile them.

## How to read this document (scope limits)

Two limits on what these measurements mean. Both narrow the document; neither
softens a single cell.

**Verification is one sub-axis, not the thesis.** The evidence-document
capability measured below is adaptive scaffolding: useful at today's model
capability, expected to become progressively cheaper, more selective, and ideally
invisible as frontier models get better. The correct trajectory for it is toward
near-zero overhead, applied where calibrated confidence is low and bypassed where
it is high - not toward a permanent tollbooth on every build. Pillar 7 sharpens
this: an orchestration layer is supposed to benefit automatically from model
improvement rather than be displaced by it, so a verification tax that stays
fixed while models improve converts from an asset into precisely the drag that
displaces us. A scorecard row that looks like a win today is therefore a snapshot
of a gap we intend to make matter less. Do not read the observability row as the
product's reason to exist, and do not let a competitor closing that gap read as a
strategic loss. In the structure below, verification appears as one sub-axis of
observability and as one scored dimension of the proposed benchmark - nowhere as
the organising claim.

**These six axes do not measure the durable ambition.** The stated ambition is
frontier software-and-research execution at arbitrary complexity, framed as a
compound capability system of six pillars. The table below barely touches any of
them:

| Pillar | Covered by this table? |
|---|---|
| 1. Outcome intelligence - ambiguous intent to excellent products/research, not merely passing tests | No. Nothing here measures outcome quality. |
| 2. Architecture depth - massive repos, distributed systems, migrations, performance, security, UX, data, infra, long-horizon evolution | No. Deepest probe was a 5-file diff. |
| 3. Adaptive autonomy - dynamic planning/replanning, hierarchical agents, memory, simulation, tool/model routing, recovery, learning from outcomes | No. Not probed at all. |
| 4. Scientific research - literature/web/code/data synthesis, hypothesis generation, experiment design, reproducibility, statistical rigor | No. Not probed at all. |
| 5. Economics - best quality-adjusted completion per dollar and wall-clock, budget-aware routing, minimal coordination/verification tax | Barely. One prompt-size ablation, no quality-adjusted or wall-clock figure. |
| 6. Developer experience - fastest intent to trustworthy shipped value, excellent observability/control, easy onboarding, graceful human collaboration | Partially, and only as affordances. The onboarding and observability rows list which commands exist; no one was timed, and "graceful human collaboration" is untested. |
| 7. Extensibility/independence - model-agnostic orchestration that benefits automatically from exponential model improvement rather than being displaced by it | Partially, and the flag overstates it. `loki start --provider claude\|codex\|cline\|aider` exists `[measured]` from `loki --help`, but whether quality holds across providers is unmeasured. Concretely: this machine has `codex-cli 0.146.0` `[measured]`, while the repo still classifies Codex as Tier 3 on v0.98-era flag assumptions (CLAUDE.md). A provider flag that exists against stale assumptions is a capability claim, not an independence result - the same conflation this document polices elsewhere. |

The axes in this document are process-and-plumbing axes, and passing all of them
could coexist with mediocre outcomes. In particular the "quality of completion"
row measures whether a verdict was produced by an independent runner - it does
not measure whether the resulting software was any good. Note also that pillar 5
names the verification tax as a cost to minimise, which is the same direction as
the scaffolding point above: the observability row measures a capability whose
own overhead is a tax the roadmap intends to shrink. Treat any gap in this table
as necessary, not sufficient, evidence. The benchmarks that would test the real
ambition do not exist yet; the gaps are enumerated in section 4.

## 1. Honest summary

Thirty-three of the 48 cells in this table are UNKNOWN, and that is the headline.
Three of the six axes (reliability, time-to-first-success, quality of completion)
are UNKNOWN for every product including Loki Mode, because we have run no
head-to-head build benchmark and any number there would be invented. None of the
seven capability pillars that constitute the actual ambition - outcome
intelligence, architecture depth, adaptive autonomy, scientific research,
economics, developer experience, extensibility - is measured here at all; pillars
3 and 4 are entirely unprobed. Every difference this document did find is a
difference in **CLI affordances**, not in outcomes: what a tool's `--help`
advertises is not what it delivers. Within that narrow frame, the one capability
no competitor matched is a persisted, schema-versioned evidence document with a
freshness re-check (`loki verify --json` emitted a `schema_version: "1.0"` doc
with a per-gate `runner` field and exit code 2; `--check-fresh` then correctly
returned STALE once the tree moved). That is one sub-axis of observability, it is
adaptive scaffolding rather than an identity, and its value is expected to decline
as models improve - see "How to read this document" above. It is emphatically not
a claim to be the only tool with review or machine-readable output; the opposite
is true and competitors are close. Claude Code ships `ultrareview --json`, a
cloud-hosted multi-agent review printing a raw `bugs.json` payload; Codex ships a
first-class `codex review` subcommand plus `exec --json` and `--output-schema`;
cursor-agent has `--output-format json|stream-json`; OpenCode has `run --format
json`, `export`, and a working `stats`. Structured output is table stakes in 2026.
On cost we can cite exactly one in-repo measurement (the `LOKI_SIMPLE=1` prompt
ablation, -78% prompt size, ~1562 tokens/iteration) whose own README entry says
its effect on build speed and quality is not yet measured - a prompt-size number,
nothing about value delivered. Devin, Replit and Emergent were **not tested**:
Devin does publish a local CLI at cli.devin.ai which we deliberately did not
install, and Replit and Emergent appear to be web-only; all three of their rows
are sourced or UNKNOWN, never measured.

## 2. Axis table

Column key: the first five columns are CLIs installed and version-verified on this
machine. The last three ship no CLI we tested; their cells are sourced or UNKNOWN.

Verified versions `[measured]`, via `<cmd> --version`:
`claude 2.1.220 (Claude Code)` / `codex-cli 0.146.0` / `cursor-agent
2026.05.24-dda726e` / `opencode 1.18.9` / `Loki Mode v9.8.1`. (`aider 0.86.2` is
installed and probed; see footnote 1 rather than a column.)

### reliability

| Loki Mode | Claude Code | Codex CLI | cursor-agent | OpenCode | Devin | Replit | Emergent |
|---|---|---|---|---|---|---|---|
| UNKNOWN. No head-to-head reliability benchmark was run. What is `[measured]` is only that a deterministic gate run emits a per-gate pass/fail with a named runner (`tests: fail (jest)`, `static_analysis: pass (syntax)`, `dependency_audit: fail`) - the presence of gates is not a reliability measurement. | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN. Vendor references "SWE 1.7, our latest model" with no supporting benchmark data on the pricing page `[sourced: https://devin.ai/pricing]` | UNKNOWN. Vendor states the agent "is probabilistic - meaning it may occasionally make mistakes" `[sourced: https://replit.com/pricing]`; this is a disclaimer, not a metric | UNKNOWN `[sourced: https://app.emergent.sh/]` - no reliability or benchmark claim on the landing page |

### time-to-first-success

| Loki Mode | Claude Code | Codex CLI | cursor-agent | OpenCode | Devin | Replit | Emergent |
|---|---|---|---|---|---|---|---|
| UNKNOWN. Not measured. No build was run for this document. | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

This entire row is UNKNOWN by construction: measuring it requires running paid
model builds on a common task across eight products, which was out of scope and
would have cost money. Do not fill this row from vendor demos.

### quality of completion

| Loki Mode | Claude Code | Codex CLI | cursor-agent | OpenCode | Devin | Replit | Emergent |
|---|---|---|---|---|---|---|---|
| UNKNOWN as an outcome. `[measured]`: a verdict is computed only from executed gate rows, and `--explain` prints "pass = independent evidence (a real runner/scanner exit), never a self-assessment". Also `[measured]`: `llm_review.status = "skipped"` with reason "deterministic-only MVP ... blind council are deferred to Phase 2" - so the LLM review half of our own quality story is **not shipped** in `loki verify` today. | UNKNOWN as an outcome. `[measured]` from `claude ultrareview --help`: a cloud-hosted multi-agent code review exists with `--json` emitting a raw `bugs.json` payload. Not executed (paid). | UNKNOWN as an outcome. `[measured]` from `codex review --help`: a dedicated non-interactive review subcommand exists with `--uncommitted`, `--base <BRANCH>`, `--commit <SHA>`. Not executed (paid). | UNKNOWN | UNKNOWN | UNKNOWN. `[sourced: https://docs.devin.ai/]` - docs emphasise making "tasks easy to verify - e.g. checking that CI passes", described as manual verification, not a structured output format | UNKNOWN | UNKNOWN |

Note the discipline here: the existence of gates, councils or review subcommands
is a capability, not a quality measurement. Nobody in this row has a measured
quality-of-completion number, us included.

### cost

| Loki Mode | Claude Code | Codex CLI | cursor-agent | OpenCode | Devin | Replit | Emergent |
|---|---|---|---|---|---|---|---|
| Partially `[measured]`, in-repo: `LOKI_SIMPLE=1` strips the coaching half of the system prompt, measured at **-78% prompt size, ~1562 tokens per iteration**, on both the bash and Bun routes (`README.md:757`). The same README entry states plainly that "Whether it changes build speed or quality is NOT yet measured". So this is a prompt-size reduction, not a demonstrated cost-per-delivered-outcome win. Total cost per build: UNKNOWN. `loki report cost` exists `[measured]` from `loki help report`. | UNKNOWN (BYO model spend, not measured) | UNKNOWN (BYO model spend, not measured) | UNKNOWN | `[measured]` `opencode stats` runs locally and prints an OVERVIEW plus COST & TOKENS panel (this machine: 142 sessions, 3,441 messages, Avg Tokens/Session 1.4M, Total Cost $0.00 - the $0.00 reflects local config, not a claim about OpenCode's price) | `[sourced: https://devin.ai/pricing]` Free $0; Pro $20/mo; Max $200/mo; Team $80/mo base + $40/mo per seat; Enterprise custom. Cost per message varies by model and task complexity; overage at API rates | `[sourced: https://replit.com/pricing]` Starter free with daily agent credits; Core $20/mo annually with $25 monthly credits, up to 2 parallel agents; Pro $95/mo annually with $100 monthly credits, up to 10 parallel agents; Enterprise custom | UNKNOWN `[sourced: https://app.emergent.sh/]` - a Pricing link exists in nav but no figures on the landing page |

Cross-product cost comparison is deliberately **not** computed. The units are not
commensurable (subscription credits vs BYO token spend) and we have no
cost-per-completed-task figure for any product including our own.

### observability

| Loki Mode | Claude Code | Codex CLI | cursor-agent | OpenCode | Devin | Replit | Emergent |
|---|---|---|---|---|---|---|---|
| `[measured]` `loki verify --json` writes a persisted `evidence.json` with top-level keys `schema_version, verdict, exit_code, subject, produced_by, deterministic_gates, llm_review, findings, suppressed, scope`; verdict BLOCKED, exit_code 2. `--explain` prints a per-gate table with a RUNNER and REPRO column. `--check-fresh` re-reads a prior evidence doc and returned `VERDICT: STALE (worktree modified since 1c80c85ff059)`. `loki status --json`, `loki doctor --json`, `loki report cost/metrics/export`, and a dashboard server also exist `[measured]` from `loki --help`. | `[measured]` `--output-format text\|json\|stream-json` (with `--print`), `--json-schema` for structured output, `--include-partial-messages`; `ultrareview --json` emits raw `bugs.json`. No persisted on-disk evidence document or freshness re-check was found in `--help`. | `[measured]` `codex exec --json` prints events as JSONL; `--output-schema <FILE>` takes a JSON Schema for the final response shape; `-o/--output-last-message <FILE>` writes the last message to a file. `codex review --help` lists **no** `--json` and no evidence-file flag (grep for json/output flags on that subcommand returned 0 matches). `codex doctor` exists. | `[measured]` `--output-format text\|json\|stream-json` with `--print`, plus `--stream-partial-output`. No evidence artifact or freshness check found in `--help`. | `[measured]` `opencode run --format json` (raw JSON events), `opencode export [sessionID]` exports session data as JSON, `opencode stats` prints usage/cost, `opencode serve` headless server. Session export is not a verdict artifact. | UNKNOWN. `[sourced: https://docs.devin.ai/]` - a Devin API is referenced; docs list no machine-readable verdict or evidence artifact | UNKNOWN | UNKNOWN |

This is the row where the honest differentiator lives, and it is narrow. Four of
five installed competitors emit structured JSON. What was not found in any
competitor's help output is a **persisted verdict document plus a staleness
re-check** (`--check-fresh`). "Not found in help output" is weaker than "does not
exist" - see section 4.

### onboarding

| Loki Mode | Claude Code | Codex CLI | cursor-agent | OpenCode | Devin | Replit | Emergent |
|---|---|---|---|---|---|---|---|
| `[measured]` from `loki --help`: a dedicated first-run path is printed at the top of help - `loki welcome`, `loki doctor`, `loki quickstart`, `loki start ./prd.md`, plus `loki next` ("Run the right next step for you"). Whether this reduces real time-to-first-build: UNKNOWN, not user-tested. | `[measured]` `claude doctor` subcommand; interactive session is the default with no subcommand. | `[measured]` `codex doctor` ("Diagnose local Codex installation, config, auth, and runtime health"); interactive by default; `codex login`. | `[measured]` interactive by default; `install-shell-integration` subcommand. | `[measured]` TUI is the default command; `opencode providers/auth` for credentials; `opencode upgrade`. | `[sourced: https://docs.devin.ai/]` a local CLI ("Devin for Terminal") installs via `curl -fsSL https://cli.devin.ai/install.sh \| bash`, with `/handoff` to escalate to cloud Devin. **We did not install or run it.** | `[sourced: https://replit.com/pricing]` web platform; no local CLI mentioned on the pricing page | `[sourced: https://app.emergent.sh/]` web-based, "Build production-ready apps through conversation"; no CLI mentioned on the landing page |

Footnote 1 - aider 0.86.2 is installed and was probed but is not given a column.
`[measured]`: grepping `aider --help` for verify/json/report/audit/attest returned
only `--verify-ssl/--no-verify-ssl` and `--git-commit-verify`, both unrelated to
output verification. No verdict artifact, no JSON output surface found.

## 2b. Proposed benchmark: complexity tiers (PLANNED - nothing here has been run)

Everything in this section is a **planned experiment**, not a result. No tier has
been executed, no score exists, and no cell below should ever be cited as
evidence. It is here so the gaps in section 4 have a concrete shape.

The six axes in section 2 measure plumbing. To measure the seven pillars, tasks
have to span real complexity and be scored on outcome, not on gate output.

**Tiers** (each a real task, run identically across tools):

| Tier | Task shape | Which pillars it exercises |
|---|---|---|
| T0 | Single-file bug fix with a failing test | 6 |
| T1 | Multi-file feature in an unfamiliar mid-size repo | 1, 6 |
| T2 | Cross-cutting migration (framework or API version) over a large repo | 2, 3 |
| T3 | Performance or security investigation with no known answer | 2, 3 |
| T4 | Distributed-system change spanning services, with a rollback path | 2, 3 |
| T5 | Open research task: literature plus code plus data synthesis, hypothesis, experiment, reproducible result | 4 |

**Scored dimensions** (per tier, per tool). Note verification is one row here,
not the frame:

| Dimension | Definition | Why it is not a gate metric |
|---|---|---|
| Completion quality | Does the result actually solve the stated problem, judged against the intent | Passing tests is the floor, not the score |
| Intervention rate | Human corrections needed per task | Directly measures autonomy (pillar 3) |
| Wall-clock time | Intent to shipped value | Pillar 5, 6 |
| Cost | Total spend, quality-adjusted | Pillar 5; unadjusted cost is meaningless |
| Recovery | Behaviour after an induced failure | Pillar 3; needs deliberate fault injection |
| Maintainability | Quality of what is left behind | Long-horizon evolution, pillar 2 |
| Novelty/usefulness | For T5, is the finding actually new and useful | Pillar 4; needs a domain judge |
| User value | Would the requester ship it | The only dimension that ends in a human |
| Verification tax | Time and tokens spent verifying, and how often it changed an outcome | Pillar 5. A *cost* row. Should trend down over time |

The verification-tax row is the one that keeps scaffolding honest: it measures
overhead and the hit rate that justifies it. If overhead rises while the hit rate
falls, the scaffolding is being over-applied and should be selectively bypassed.

### 2b-FROZEN. Design seal for T1 and T2 (2026-08-03)

T1 and T2 are FROZEN as designs. Nothing has been run, no money has been
spent, and this seal exists so that stays true until a founder decision says
otherwise.

**Held-out discipline, and why it is written down BEFORE any run.** The value
of a benchmark is destroyed by the ordinary act of debugging against it. Once a
task has been attempted, the harness tuned, and the task attempted again, the
score measures fit to that task rather than capability. So:

1. **The T1 and T2 task instances are not selected yet, and must not be
   selected by whoever tunes the harness.** Selection and tuning by the same
   party is how a held-out set stops being held out.
2. **One scored attempt per tool per task.** A retry after seeing the result is
   a different experiment and must be reported as such, never averaged in.
3. **The scoring rubric is frozen before the first run.** A dimension added
   after seeing results is a dimension chosen because of them.
4. **Task text is never committed to this repo.** A task in the repo is a task
   in the training and context of the thing being measured.

**What would make a T1/T2 result quotable**, stated now so it cannot be
loosened later to fit an outcome:

- n >= 3 independent instances per tier, scored blind to which tool produced
  the artifact where the dimension allows it.
- Every competitor run under the same instance, same day, same rubric.
- Cost and wall clock read from each tool's own artifacts, never from a
  supervising process.
- Any dimension that could not be scored reads UNKNOWN. A partial rubric is
  reported as partial rather than averaged over the dimensions that happened to
  work.

**Explicitly NOT frozen and NOT designed:** T3, T4 and T5. T5 in particular
needs a domain judge for novelty, and no such judge is identified. Listing them
in the tier table is a sketch, not a design.

**Cost, stated because it is the reason this is frozen rather than run.** Each
tier instance is a real build across eight tools. At n>=3 that is dozens of paid
runs, and the T2 shape (cross-cutting migration over a large repo) is the
expensive end. No run happens without an explicit founder spend decision.

**Status separation.** Required reading before quoting anything from this file:

| Category | What is in it |
|---|---|
| **Measured capability** | Only section 2, and only cells tagged `[measured]` or `[sourced]`. These are CLI affordances and one prompt-size ablation. No outcome quality anywhere. |
| **Planned experiments** | All of section 2b. Tiers T0-T5 and every scored dimension. Zero runs to date. |
| **Aspirational** | The seven pillars as a whole. They are the stated ambition and are not claims of current capability. Pillars 3 and 4 are entirely unprobed. |

## 3. How to reproduce

Every command below was actually run on 2026-08-03 in the repo working tree at
`/Users/lokesh/git/lokimode-anthropic/.claude/worktrees/pre-push-scoped-pytest`.
None of them makes a paid model call.

Versions:

```bash
for c in claude codex cursor-agent opencode aider loki; do
  printf "=== %s ===\n" "$c"; command -v "$c"; "$c" --version 2>&1 | head -3
done
```

Capability probes (help text only - no model calls, no spend):

```bash
loki --help
loki help verify
loki help report
claude --help | grep -iE "output-format|json"
claude ultrareview --help
codex --help
codex review --help
codex exec --help | grep -iE "json|output-schema|output"
cursor-agent --help
opencode --help
opencode run --help
aider --help | grep -iE "verify|json|report|audit|attest"
```

The evidence-document claim, which is the only differentiator asserted here:

```bash
# Deterministic-only: loki verify's help states there is NO LLM code review in
# this slice, so this run is free.
loki verify HEAD~1 --out /tmp/loki-verify-sc2 --explain

# Persisted, schema-versioned artifact:
python3 -c "import json;d=json.load(open('/tmp/loki-verify-sc2/evidence.json'));print(list(d.keys()))"
# -> ['schema_version','verdict','exit_code','subject','produced_by',
#     'deterministic_gates','llm_review','findings','suppressed','scope']

# Freshness re-check against the current tree:
loki verify --check-fresh --out /tmp/loki-verify-sc2
# -> VERDICT: STALE (worktree modified since 1c80c85ff059) -- re-run loki verify
```

Observed `--explain` output from that run, verbatim:

```
  GATE               STATUS       RUNNER         REPRO  EVIDENCE
  ----               ------       ------         -----  --------
  build              skipped      -              true   no detectable build command
  tests              fail         jest           true   tests failed (rc=1)
  static_analysis    pass         syntax         true   4 file(s) checked, no syntax errors
  nomock             skipped      -              true   no scannable UI/data-render files in diff
  secret_scan        pass         regex-fallback true   no secrets matched
  dependency_audit   fail         npm-audit      true   0 critical, 4 high CVEs
```

SCOPE NOTE on that audit row, because both numbers are real and they mean
very different things to a release decision:

```
npm audit                -> 7 vulnerabilities (1 low, 2 moderate, 4 high)
npm audit --production   -> 2 moderate, 0 high

The four highs (brace-expansion, form-data, js-yaml, ws) do NOT appear in the
production dependency tree; they arrive through dev tooling. The shipped
package's own exposure is 2 moderate, both reached via
@modelcontextprotocol/sdk -> @hono/node-server, one of which is a
Windows-only path traversal in serve-static.

Both are stated rather than one being chosen. "4 high CVEs" unqualified
overstates what someone installing the package is exposed to; "2 moderate"
alone understates what our own gate sees and blocks on.
  spec_drift         skipped      loki-spec      true   no spec lock (.loki/spec/spec.lock)

VERDICT: BLOCKED
```

Note this is a BLOCKED verdict on our own tree, reported unchanged. A scorecard
whose own tool passes cleanly on the first try is a scorecard to distrust.

Cost citation (in-repo, cite - do not re-derive): `README.md:757`, the
`LOKI_SIMPLE` row. Re-run the ablation on your own workload with
`benchmarks/run-prompt-ablation.sh` before drawing any conclusion from it.

Cleanup after reproducing:

```bash
rm -rf /tmp/loki-verify-scorecard /tmp/loki-verify-sc2 /tmp/loki-verify-scorecard.err
```

## 3b. Deployment and self-hosting (added 2026-08-08)

Sourced from vendor documentation on 2026-08-08. Full quotes, URLs and the
per-vendor UNKNOWN list are in `docs/COMPETITOR-DEPLOYMENT-MODELS.md`. Same
rules as the rest of this file: `[sourced]` means a page was actually fetched,
UNKNOWN means we could not establish it.

| Product | Self-hosting | Inference routing | Output-verification artifact |
|---|---|---|---|
| Factory AI | Yes, incl. airgapped `[sourced]` | Customer-controlled, BYOK `[sourced]` | Not documented publicly |
| Claude Code (self-hosted envs) | Execution only; control plane stays Anthropic-hosted `[sourced]` | Pinned to Anthropic; not routable to Bedrock/Vertex/Foundry/gateway `[sourced]` | Not documented publicly |
| Devin | No; prior self-hosted offering in maintenance mode since 2025-05-12 `[sourced]` | UNKNOWN | Not documented publicly |
| Replit Agent | Not documented publicly | Vendor-pinned `[sourced]` | Not documented publicly |
| 8090 | UNKNOWN | UNKNOWN | Not documented publicly |
| Loki Mode | Yes, control plane included `[measured]` | Provider-agnostic `[measured]` | `loki proof verify` `[measured]` |

**This CORRECTS a claim we were making internally.** "Fully self-hosted and
provider-agnostic" was treated as the differentiator. It is not: Factory AI
documents airgapped installs with customer-controlled model routing, so that
column does not separate us from them. Recording the correction rather than
quietly dropping it, because a scorecard that only ever moves in our favour is
not evidence.

The column that does separate is the last one, and it is the weakest kind of
finding: **absence from documentation is not absence from a product.** The
honest statement is "not documented publicly as of 2026-08-08", never "does not
exist". A vendor may ship this behind a login, in an enterprise tier, or simply
undocumented.

Loki's two `[measured]` cells are reproducible:

```bash
grep -c "api.anthropic.com" autonomy/*.sh providers/*.sh   # 1, inside a per-provider case
ls providers/*.sh                                          # claude, codex, aider, cline, opencode
bash tests/test-competitor-verify-surface.sh               # the installed-CLI audit
loki proof verify <id>                                     # re-hash a receipt, exit 1 on tamper
```

### 3d. Our own numbers on the axes people ask about, measured 2026-08-08

These are ABSOLUTE measurements of this product with a CI guard behind each. They
are deliberately NOT presented as a comparison: no competitor number appears
here, because three of the four named competitors have no runnable binary on
this machine and the fourth exposes no equivalent command. A number next to a
blank is not a ratio.

| Axis | Measured | Budget | Guarded by |
|---|---|---|---|
| UI page weight | 787 KB | 1024 KB | `tests/test-dashboard-bundle-budget.sh` |
| Backend verify latency | 7 ms | under 1000 ms | `tests/test-fast-verify.sh` |
| Worker horizontal scale | 1..25 replicas render | n/a | `tests/test-helm-worker-scaling.sh` |

Two of those three guards already existed; only the page-weight budget was added
on 2026-08-08. Recording that because "we measured it" and "we added a
measurement" are different claims and the difference matters.

What these numbers do NOT establish: they say nothing about output quality,
which is the axis a user actually cares about, and nothing about how any
competitor performs on the same axes. A fast gate that verifies the wrong thing
is worse than a slow one that verifies the right thing.

Reproduce:

```bash
bash tests/test-dashboard-bundle-budget.sh   # prints the KB and the budget
bash tests/test-fast-verify.sh               # prints the ms and the budget
bash tests/test-helm-worker-scaling.sh       # renders 1, 2, 5 and 25 replicas
```

### 3c. Deploy surface, measured 2026-08-08

Ran on the four competitor CLIs installed on this machine. Method matters here:
a `--help` grep is NOT sufficient -- an earlier audit in this repo counted
aider's `--verify-ssl` as a verification capability, which it is not. So each
CLI was invoked as `<cli> deploy --help` and the result classified as a real
subcommand only when it exited 0 AND its output named the subcommand, rather
than falling through to generic help.

| CLI | `deploy` subcommand |
|---|---|
| claude | none `[measured]` |
| aider | none `[measured]` |
| opencode | none `[measured]` |
| codex | none `[measured]` |
| loki | present, and evidence-gated `[measured]` |

**4 of 4 installed competitor CLIs expose no deploy verb.** Loki's is gated on a
verified receipt: it refuses on UNSIGNED, TAMPERED, anchor mismatch, or a dirty
tree, and writes a receipt for the deploy itself naming the authorizing run_id.

Scope limits, same as everywhere else in this file. This covers CLIs INSTALLED
HERE. Factory, Devin, Replit and 8090 have no runnable binary on this machine
(`bash benchmarks/head-to-head-readiness.sh` reports 3 ready / 4 blocked), so no
claim is made about them. A hosted product may deploy without exposing a CLI
verb -- Replit Agent's documented headline capability is exactly that. This
measures a CLI surface, not a product capability, and it is not a quality
comparison.

Reproduce:

```bash
# Exit code ALONE is not the test: every CLI here exits 0 on `deploy --help`
# because an unknown subcommand falls through to generic help. The first
# version of this recipe did exactly that and reported all four as having a
# deploy command. The output must NAME the subcommand.
for c in claude aider opencode codex loki; do
  out="$($c deploy --help 2>&1 | head -3)"
  printf '%s' "$out" | grep -qiE "$c deploy|deploy -" \
    && echo "$c: real deploy subcommand" \
    || echo "$c: no deploy subcommand (fell through to generic help)"
done
bash autonomy/loki deploy --execute       # refuses, naming each failed check
```

## 4. What we do NOT know

This section is mandatory and is not empty.

1. **We did not execute any competitor's review or build command.** Every
   competitor capability above is read from `--help` output only. Running
   `claude ultrareview`, `codex review`, `cursor-agent -p`, or an OpenCode build
   would each make a paid model call, which was out of scope. "Not listed in
   `--help`" is not proof of absence - a capability may exist undocumented, in a
   config file, or behind a subcommand we did not enumerate.
2. **No head-to-head build benchmark exists.** Reliability, time-to-first-success
   and quality-of-completion are UNKNOWN for all eight products. We have never
   run the same task through even two of these tools and compared outcomes.
3. **We have no cost-per-completed-task figure for any product, including Loki.**
   The `LOKI_SIMPLE` number is a prompt-size measurement only, and its effect on
   speed and quality is explicitly unmeasured per its own README entry.
4. **Devin was not tested despite having a local CLI.** `docs.devin.ai` documents
   `curl -fsSL https://cli.devin.ai/install.sh | bash`. We chose not to install
   third-party software, so every Devin cell is sourced or UNKNOWN. An earlier
   read of the pricing page suggested "no local CLI"; the docs page corrected
   that. Treat any Devin claim here as provisional.
5. **Replit and Emergent were assessed from marketing pages only** (a pricing page
   and a landing page). Neither page discusses verification. Absence of a claim on
   a marketing page is not evidence the capability is absent from the product.
6. **Our own LLM review stage is not shipped in `loki verify`.** The evidence doc
   records `llm_review.status = "skipped"`, reason "deterministic-only MVP ...
   blind council are deferred to Phase 2". The 8-gate build loop is a separate
   path from `loki verify` and was not exercised for this document.
7. **The freshness/evidence differentiator is help-text-derived for competitors.**
   We verified our own `--check-fresh` by running it. We did not exhaustively
   search competitor filesystems, config schemas, or APIs for an equivalent.
8. **Onboarding is unmeasured.** No user was timed through first build on any
   product. The onboarding row records which affordances exist, not whether they
   work.
9. **`opencode stats` showed Total Cost $0.00 on this machine**, which reflects
   local provider configuration and tells us nothing about OpenCode's economics.
10. **Vendor benchmark claims were not independently verified.** Devin's "SWE 1.7"
    reference appears with no supporting data on the page fetched.
11. **We have no measurement of outcome intelligence for anyone, including us.**
    Nothing here tests whether ambiguous intent becomes an excellent product or
    a real research result, as opposed to a change that passes its gates. Gate
    pass rates and verdict artifacts are explicitly not a proxy for this. No
    benchmark for it currently exists in this repo.
12. **We have no measurement of architecture depth for anyone, including us.**
    Nothing here tests reasoning across a massive repository, a distributed
    system, a migration, or a performance investigation. Every probe in this
    document ran against a single repo's help text or a 5-file diff, which is
    the shallowest possible case.
13. **The overhead of verification itself is only partially measured.**
    PARTIALLY CLOSED 2026-08-03. `tools/verification-tax.py` now computes wall
    time and outcome-change rate from evidence documents. First real reading, on
    the `loki verify HEAD~1` run cited in section 3: **19.0s, outcome changed 1
    of 1 runs**. That is a single-run sample and a single axis - it is a
    baseline, not a trend. Still unmeasured: **token** cost of verification (only
    wall time is captured), and the hit rate over a meaningful history rather
    than one run. Reproduce with
    `python3 tools/verification-tax.py <log.jsonl>`.
14. **Confidence calibration is unmeasured.** Selectively bypassing verification
    where confidence is high presupposes that the confidence signal is
    calibrated. We have not measured whether ours is, so we cannot currently
    say where bypassing would be safe.
