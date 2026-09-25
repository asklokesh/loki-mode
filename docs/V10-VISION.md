# Loki Mode 10: the software factory enterprises just use

## One sentence

**Give Loki the work. Get back shipped software, every change sealed.**

## What it is

Loki Mode 10 combines the three things enterprises are buying separately today into one simple product:

| They buy | For | Loki gives them |
|---|---|---|
| Cognition Devin | A teammate you assign work to | Assign work where you already are: an issue label, a comment, a Slack mention, or one command. |
| 8090 Software Factory | Business intent traced to code, legacy understood | Every change is traced from requirement to acceptance check to code to Seal. Legacy systems get mapped and modernized against their own behavior. |
| Factory.ai Droids | A fleet of agents across the SDLC, on any model, in your environment | A continuous line that works through a backlog in parallel, on any model, inside your perimeter, air-gapped if needed. |
| Claude Code, Codex (raw agents) | A powerful agent in one developer's terminal | The same engines, but running as a team-level factory: backlog in, sealed changes out, with model choice and cost control across vendors. |

**Why it can be 10x, not 1x.** Loki's work arrives with proof: a Seal that anyone can re-check offline. None of them offers this.
- Devin guarantees hours saved, not correctness.
- 8090's "receipts" live inside its platform.
- Factory's proof stops at tests and PR review.
- Claude Code and Codex leave verification to the developer who runs them.

Proof is what lets an enterprise grant more autonomy. More autonomy is what turns an assistant into a factory.

**What 10x means, measurably.** The north-star metric is **verified changes shipped per hour of human attention**, compared with a raw agent whose output a person must review by hand. Three multipliers stack:
- parallel throughput (the line);
- less human review per change (the Seal, and autonomy earned from it);
- lower cost per verified change (routing to the cheapest capable model).

The performance bar below sets a target for each of them. The 10x is the product of the three, measured and never asserted.

## Our relationship with Claude, Claude Code and other model vendors

Claude Code and Codex are engines, and Loki runs on top of them. We do not compete on the model or on one developer's interactive agent loop. Every model upgrade makes Loki better for free.

We compete on what a raw agent does not give an enterprise:
- a continuous line across a whole backlog and many repos;
- proof on every change;
- autonomy that is earned, not granted blindly;
- one cost view across every vendor;
- freedom to switch models without switching tools.

The rule is to ride the platform. When Claude Code or another engine ships a capability natively, Loki uses theirs and deletes its own copy. That keeps Loki lean and always current.

Being "better than Claude Code" has to be measured, not claimed. On the same tasks with the same model, Loki must deliver more verified-correct changes per hour and per dollar than raw Claude Code does. See the performance bar below.

## The Apple principle: simplicity is the product

Adoption comes from how little a user has to learn, not from how much the product can do.

- **One install, one command.** `loki` in any repo just works. It finds the repo, the tracker and the model key. No config file is required.
- **Three things a user ever does:**
  - give work;
  - glance at progress;
  - approve.
  Everything else is automatic or hidden.
- **One artifact to trust:** a pull request with a Seal on it.
- **One screen for leaders:** work in, work shipped, cost per sealed change, and what is waiting on a human.
- **Defaults over knobs.** Every setting must earn its existence. When in doubt, delete it.
- **It works where people already work.** That means GitHub, GitLab, Jira, Slack and the terminal. We do not ask anyone to adopt a new place to work.

**The adoption bar, measured before every major release:**
- A new user on a real repo gets to a first sealed pull request in under 10 minutes.
- The user makes at most one decision along the way: providing a model key if none is found.
- Zero required reading.

## The moat (never trade it for a feature)

1. **Portable proof.** A signed, diff-bound Seal that a third party verifies offline with only a public key. It records what was not proven as clearly as what was.
2. **An honest verdict.** Pass comes only from checks that actually ran. Models write checks and review; a model's opinion never produces a pass. Unknown is never a pass.
3. **The Wall.** Acceptance checks are written from the requirement by a step that never sees the implementation.
4. **Model freedom.** It works from the strongest model (Claude Opus 5.5) down to the cheapest capable one. A cheaper model can make the line slower. It must never make the Seal wrong.
5. **Sovereignty.** The whole factory runs inside the customer's perimeter with their own keys and models. The only thing that leaves is model calls, and only to the endpoints they choose.
6. **Runs where the code lives.** It works on existing and legacy codebases in place, not only greenfield apps.
7. **Honesty.** It publishes its own error rates and makes no claim it cannot reproduce. Every competitor that overclaims makes this more valuable.
8. **Load-bearing proof.** Every Seal proves the delivered code is what makes the checks pass: the changed code is disabled, and the checks must then fail.
9. **Safe by construction.** Untrusted text from issues and PRs never shares a step with secrets or the power to push.

## How the line runs

1. **Take work.** Work arrives as an idea, a requirement, an issue, a backlog, or an existing system.
2. **Understand.** The factory maps the system and the intent. It asks at most the questions that change the outcome, and records its assumptions.
3. **Plan.** It writes a plan a person can read in a minute. Acceptance checks are frozen before building.
4. **Build.** Parallel workers do the building, routed to the cheapest model that keeps the Seal rate up.
5. **Seal.** Every change is verified and signed.
6. **Ship.** It opens a pull request. It deploys only sealed changes, and only through a canary.
7. **Operate.** It watches shipped changes. A regression becomes new work, fixed through the same line.
8. **Earn autonomy.** Each agent and repo earns more freedom from its Seal record, and loses it on a failure in a protected area.

## Built on evidence

Every design rule traces to research: the Wall, the deterministic verdict, per-step routing, the single writer, risk-tiered autonomy, and injection-safe intake. The sources are 2025-2026 papers from ICSE, ACL, ICLR and NeurIPS, preprints, and industry data from Meta, Google, METR and DORA, collected in `docs/V10-RESEARCH.md`.

The two findings that matter most:
- Agents that can see the checks build to the checks.
- Models are better at writing tests than at judging code.

That is why the Seal's verdict comes only from checks that run, written by a step that never saw the code.

## What we do not build

- No IDE and no hosted preview sites.
- No feature that works only as our SaaS.
- No benchmark chasing.
- No certification claims.
- No setting that exists because we could not choose a default.

## The performance bar

Accuracy, speed, efficiency and verification latency are all measured on an in-repo eval. Correctness is graded by hidden tests that neither Loki nor the comparison agent ever sees. The comparison arms are:
- raw Claude Code on Opus 5.5;
- raw Codex;
- Loki at top-only, cheapest-only and routed.

Factory, 8090 and Devin are closed products we cannot run. We compare against them only where they publish numbers, such as Factory's Legacy-Bench results, and we label those numbers vendor-claimed.

| Axis | Target for v10 |
|---|---|
| Delivered accuracy | Higher verified-correct rate than raw Claude Code with the same model, on hidden tests |
| Seal accuracy | Wrong passes at or below 1% (95% upper bound at or below 3%). Wrong fails at or below 5%. Holds at the cheapest model too. |
| Verification latency | Fast check under 1 second on the changed code. A full Seal adds at most 60 seconds (median) on top of the project's own test time, using only the checks the change affects, run in parallel and cached. |
| Speed, one item | Time to a sealed PR within 1.2x of raw Claude Code's time to an unverified PR |
| Speed, a backlog | At least 3x the sealed-PR throughput of one raw Claude Code session |
| Efficiency | Routed cost per verified-correct change at most half that of raw Claude Code on Opus 5.5 |
| Adoption | First sealed PR in under 10 minutes, at most one decision |

These are targets, not claims. We publish whatever the eval measures, including misses. A miss is fixed in the product, never in the wording.

## Metrics that matter

| Metric | Definition |
|---|---|
| Time to first sealed PR | Fresh machine to first sealed pull request |
| Seal rate | Share of changes that come back sealed |
| Cost per sealed change | At top-only, cheapest-only and routed model setups |
| Human touches per shipped change | How often a person had to step in |
| Post-merge change-failure rate | Share of merged changes that later fail |
| Seal error rates | Wrong passes and wrong fails, published |
| Organic adoption floor | Daily installs on days we ship nothing (baseline about 94 per day, per `docs/STRATEGY-2026-2028.md`) |

## Honest risks

- **The competitors are rich.**
  - Factory: $5B valuation.
  - Cognition: $26B valuation, $492M run-rate.
  - 8090: EY distribution.

  They also have sales teams and certifications. We win on simplicity, proof, model economics and sovereignty, not on headcount.
- **GitHub or Factory could ship a portable signed receipt.** Our answers:
  - Interoperate on open standards (in-toto, Sigstore).
  - Stay neutral across GitHub, GitLab and Bitbucket.
  - Make the Seal part of a whole factory, not a standalone feature.
- **No SOC 2 report and no sales motion yet.** Engineering can deliver readiness documents, not the audit or the team. These are founder decisions.
- **The cheapest model may lower throughput.** Routing and escalation handle that, and the numbers get published.
- **Anthropic or OpenAI build a factory into their own agents.** Our answers:
  - Stay model-neutral, which no model vendor can.
  - Ride their improvements instead of duplicating them.
  - Own the proof and the cross-vendor cost view.

Sources for competitor figures: research of 2026-09-25 and `docs/COMPETITIVE-INTEL-2026-09.md`. Treat vendor figures as vendor-claimed.
