# Plan: make the receipt real, then make it the product

Source of findings: `artifacts/COMPETITIVE-UX-FINDINGS.md` (65 findings across
Ona, 8090, Devin, Factory). This plan implements **9** of them and names every
other one it defers, with a reason. Scaling this up is the founder's call; a
silent drop is not.

---

## The finding that reorders everything

I ran the product instead of reading its config, and two of my own earlier
claims were wrong:

1. **I analysed the wrong frontend.** `dashboard/static/index.html` (787,917
   bytes) is what `loki web` serves. `web-app/dist/index.html` is 800 bytes and
   ships nothing. My "the trust surfaces have zero callers" claim was measured
   against `web-app/src`, which users never see.

2. **The trust surfaces already exist and already work.** The running dashboard
   has 16 nav items including Trust, Council, Quality, Spec Checklist. Trust
   Trajectory renders. Quality renders all 8 gates with real explanatory text.

The actual problem is worse than a missing UI:

| Surface | Renders | Live API |
|---|---|---|
| Header | `9 receipts · 0 verified` | `{"total_receipts":9,"verified":0,"not_verified":9}` |
| Trust | "no data", 0 improving, 0 regressing | `{"verdicts":[],"details":[]}` |
| Quality | 8 gates PENDING, "Last checked: Never" | no gate has ever written a result |

**The UI is honest. The engine is empty.** From a real receipt:

```
facts.git.base_sha = ""                  <- empty, nothing anchorable
verification = {"scope": "integrity"}    <- a self-hash, not verification
```

An empty `base_sha` is the same root cause the outcome ledger already reports as
ANCHORED 0 of 9. A receipt that cannot anchor cannot be verified.

**So no amount of UI work fixes this.** A redesign that renders `0 verified` in
a nicer font ships a prettier zero. Phase 1 is engine work, and the UI phases
depend on it.

Non-negotiable: **do not "fix" the honest zero into a green checkmark.** The
dashboard is currently doing the right thing.

---

## Phase 1 -- Make the receipt mean something (ENGINE, blocks everything else)

### 1.1 Populate `base_sha` at receipt-write time
The receipt writer records `head_sha` and leaves `base_sha` empty, so
`resolve_anchor()` returns `unanchored/base_sha_empty` for every run. Fix at the
source: capture the merge-base (or the run's start SHA) when the run begins, and
write it into `facts.git`.

Verify: re-run `loki outcomes` and get ANCHORED > 0 on a fresh run. Assert the
existing anchor gate still returns UNKNOWN with a named reason for genuinely
unanchorable runs (greenfield) -- the fix must not make the gate credulous.

### 1.2 Write gate results into the receipt
Quality shows "Last checked: Never" for all 8 gates because gate outcomes are
not persisted where the dashboard reads them. Wire the existing gate results
(they are computed -- `track_gate_failure` already counts them) into the receipt
and `/api/quality`.

### 1.3 Stable acceptance-criterion IDs -- **8090**
`REQ-[PREFIX]-NNN` / `AC-[PREFIX]-NNN.N`, each phrased "When [condition], the
system shall [behavior]". Our `_brief_acceptance_criteria` and `derived_ac` emit
prose bullets with no IDs, so nothing downstream can cite one.

This is the highest-leverage item in the whole plan, because it is what turns a
receipt from a blob into a claim a human can check: *AC-CHK-003.2 is satisfied by
this test at this line*. It also makes drift trackable per criterion.

Rules to enforce (from 8090's guide): atomic (one behaviour per criterion),
testable, user-centred; `shall`/`should`/`may` for mandatory/recommended/optional.

**User-visible result of Phase 1:** the header stops saying `0 verified`, and
says it because the number changed, not because the label did.

---

## Phase 2 -- One UI, and it is the dashboard

### 2.1 Settle the two-frontend problem
`web-app/` is 174 source files including a 2,510-line / 81-hook
`ProjectWorkspace.tsx` with no behavioural test coverage, and it does not ship.
Two competing UIs is itself a source of the "complex and complicated" feeling.

Decision: **the dashboard is the product.** `web-app/` is either deleted or
explicitly marked non-shipping in one commit, so nobody (including me) analyses
it again by mistake. I will not rewrite `ProjectWorkspace.tsx` -- rewriting
2,510 lines with 81 hooks and zero behavioural coverage is how you ship a
regression you cannot detect.

### 2.2 Design language: operational, not editorial
Current chrome is warm neutrals + `DM Serif Display` headings + eight accent
colours. Linear/Vercel/Sentry/Ona run cool neutrals, dense type, one accent.

Concretely:
- serif headings out of product chrome (keep for marketing)
- one accent with one meaning; status colours reserved for status only
- status legible without colour (icon or label carries it too)
- increase density -- an operator wants more rows per screen, not fewer
- **never a spinner without a claim**: every wait states the step, the bound,
  and what happens next (the rule we already applied to `docs generate`)

Before-shots captured for Overview, Trust, Quality. Any change is judged against
those, and I will capture after-shots of the same three.

---

## Phase 3 -- The four adopted mechanisms (ranked by fit to the measured gap)

### 3.1 Repo readiness score -- **Factory**
`agent_readiness.py` already exists and has **zero runtime callers**. Factory's
insight is the framing: score the REPO, not the agent, and make the score
executable (`/readiness-report` -> `/readiness-fix`).

Why this one: it reframes "the agent failed" into a fixable, measurable
environment problem, and it is the strongest before-first-value lever for
brownfield -- our stated wedge. Factory is explicit that Missions need
readiness Level 4+ or "the mission cannot reliably verify its own work."

### 3.2 Three-way confidence taxonomy -- **Devin**
Findings split by epistemic status: **Bug** (high confidence), **Investigate**
("you should review this yourself"), **Informational**. We already have
advisory-vs-blocking internally; this is its UI, and it is the honest way to
hand uncertainty back rather than flattening everything into "issues found."

### 3.3 Audit-first policy ladder -- **Ona**
`EFFECT_AUDIT` -> review matches -> promote to `EFFECT_BLOCK`. A policy you
cannot safely enable is a policy nobody enables. This gives our advisory gates
a promotion path instead of a permanent second-class status.

### 3.4 Mid-run steering: edit the command, don't just deny it -- **Devin**
Approval is not yes/no; the user can rewrite the proposed command (or describe
the change in plain language) and review before it runs. Cheapest
high-leverage steering hook in any corpus.

Supporting evidence for prioritising steering at all -- Factory's release
sequence: capability, then extensibility, then permission granularity, then the
context wall, and **the last ~40 releases are disproportionately about steering,
not capability.** At long horizons the binding constraint is the user's ability
to intervene without destroying the run.

---

## The cut list (the load-bearing section)

The request was "implement all of them." I am implementing 9 and deferring the
rest, because every finding ADDS surface to a dashboard that already has 16 nav
items, and the same message asked that it stop feeling complex. Deferred, by
name, each with a reason:

**Deferred -- needs infrastructure we do not have (cloud/multi-tenant):**
Ona service accounts, Ona Insights org rollup, Ona runners/VPC, Ona devcontainer
bootstrap, Devin enterprise/org scoping, Devin IdP groups + IP allowlists,
Factory org hooks governance, 8090 multiplayer collaboration + real-time
co-editing.

**Deferred -- duplicates something we already ship:**
8090 spec-vs-code drift (we have spec-lock + `loki intent`), Devin knowledge
store (we have the memory system), Factory AGENTS.md caps (we have prompt-cache
discipline), Factory context compaction suite (we have context-tracker),
8090 knowledge graph (we have graphify).

**Deferred -- good, but adds surface against the stated goal:**
Devin Session Insights (strong idea -- wants its own phase, not a bolt-on),
Devin misleading-knowledge detection (depends on Session Insights),
Devin playbooks (third memory type; we already have skills + memory),
Factory `/btw` side channel, Factory subagent tool-boundary config,
Factory Missions, 8090 configurable decomposition strategy,
8090 feedback themes + quote evidence, Ona automation templates gallery,
Devin automations + natural-language authoring.

**Deferred -- policy call, not an engineering one:**
Ona identity-attribution model, Devin soft budget block (we deliberately ship no
default spend cap; changing that is the founder's call), Devin adaptive model
routing.

**Adopted as doctrine, not code** (they cost nothing and sharpen our writing):
Factory's "GA is the absence of a tag"; Factory's published open questions;
8090's "confidence without measurement is the most dangerous form of
misalignment"; Devin's slice discipline (<90 min, independently verifiable).

---

## Verification

1. `loki outcomes` reports ANCHORED > 0 on a fresh run, and still UNKNOWN with a
   named reason on a genuinely unanchorable one (both directions, or the fix
   traded a false negative for a false positive).
2. The header badge changes from `9 receipts · 0 verified` because the
   verification count moved -- confirmed against `/api/proofs/summary`, not
   against the rendered text.
3. Quality shows a real "Last checked" timestamp for at least one gate.
4. An acceptance criterion is citable by ID from a receipt.
5. After-shots of Overview, Trust, Quality compared against the before-shots
   already captured.
6. `bash scripts/local-ci.sh` green before any push (fast tier is the gate).

## Sequencing

1.1 first -- it unblocks 1.2, 1.3, and every UI phase. Then 1.2, 1.3 together.
Phase 2 next (settling the frontend before touching chrome). Phase 3 last, in
the order 3.1 -> 3.2 -> 3.3 -> 3.4.

## Carried constraints

- Never report an unmeasured thing as measured; UNKNOWN with a named reason.
- No composite score. Individual signals are the actionable part.
- Do not weaken a gate to gain a nicer number.
- Byte-mirror anything that exists on both routes, and test the mirror.
- No emojis, no em dashes.
