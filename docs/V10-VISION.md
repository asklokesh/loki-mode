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

**Why it is 10x, not 1x.** Loki's work arrives with proof: a Seal that anyone can re-check offline. None of the three offers this.
- Devin guarantees hours saved, not correctness.
- 8090's "receipts" live inside its platform.
- Factory proves nothing beyond tests and PR review.

Proof is what lets an enterprise grant more autonomy. More autonomy is what turns an assistant into a factory.

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

## How the line runs

1. **Take work.** Work arrives as an idea, a requirement, an issue, a backlog, or an existing system.
2. **Understand.** The factory maps the system and the intent. It asks at most the questions that change the outcome, and records its assumptions.
3. **Plan.** It writes a plan a person can read in a minute. Acceptance checks are frozen before building.
4. **Build.** Parallel workers do the building, routed to the cheapest model that keeps the Seal rate up.
5. **Seal.** Every change is verified and signed.
6. **Ship.** It opens a pull request. It deploys only sealed changes, and only through a canary.
7. **Operate.** It watches shipped changes. A regression becomes new work, fixed through the same line.
8. **Earn autonomy.** Each agent and repo earns more freedom from its Seal record, and loses it on a failure in a protected area.

## What we do not build

- No IDE and no hosted preview sites.
- No feature that works only as our SaaS.
- No benchmark chasing.
- No certification claims.
- No setting that exists because we could not choose a default.

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

Sources for competitor figures: research of 2026-09-25 and `docs/COMPETITIVE-INTEL-2026-09.md`. Treat vendor figures as vendor-claimed.
