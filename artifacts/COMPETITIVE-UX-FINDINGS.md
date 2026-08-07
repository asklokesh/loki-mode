# Competitive UX findings (Ona, 8090, Devin, Factory)

Read 2026-08-07. Everything below is quoted or paraphrased from the scraped
corpora in `~/git/{ona,8090_ai,devin_cognition_ai,factory_ai}`, with file paths
so any claim can be re-checked. Nothing here is inferred from marketing pages.

Status: Ona and 8090 read directly and in full. Devin and Factory reader agents
were still running when this file was first written; their sections are appended
when they land.

---

## The measured gap in our own product (verified by RUNNING it, not by grep)

### CORRECTION: there are two frontends, and I first analysed the wrong one

My initial pass grepped `web-app/src` and concluded the trust surfaces had zero
callers. That was measuring a frontend that does not ship. Settled by byte
comparison against the live server:

```
served by loki web:      787,917 bytes
dashboard/static/index.html: 787,917 bytes   <-- THIS is the product
web-app/dist/index.html:         800 bytes   <-- a Vite shell, not the product
```

`dashboard/static/` is what `loki web` mounts (`dashboard/server.py:11270`).
The trust surfaces ARE wired there: the running dashboard has Overview, App
Runner, Checkpoints, Context, Fleet, Quality, Trust, Council, Spec Checklist,
Insights, Analytics, Cost, Notifications, Escalations, Migration -- 16 nav items.

So "the differentiator is invisible" was WRONG. The real finding is worse.

### The real finding: the UI is honest and the engine is empty

Live, from the running app:

| Surface | What it shows | API confirms |
|---|---|---|
| Header badge | `9 receipts · 0 verified` | `/api/proofs/summary` -> `{"total_receipts":9,"verified":0,"not_verified":9}` |
| Trust Trajectory | "no data", 0 improving, 0 regressing axes | `/api/council/verdicts` -> `{"verdicts":[],"details":[]}` |
| Quality | 8 gates, all PENDING, "Last checked: Never" | no gate run has ever written results |

The dashboard is doing the right thing -- reporting the true number instead of a
fabricated green. **Do not "fix" this by rendering a checkmark.**

Root cause, from a real receipt (`.loki/proofs/20260727T015320Z-3lgor0/proof.json`):

```
facts.git.base_sha = ""        <-- empty, so nothing is anchorable
verification = {"scope": "integrity"}   <-- a self-hash, not verification
```

An empty `base_sha` is the same root cause the outcome ledger already reports as
ANCHORED 0 of 9. **A receipt that cannot anchor cannot be verified, so 9 of 9
read unverified.** This is an ENGINE defect, not a UI defect. Any UI work that
does not fix it ships a prettier zero.

### Secondary: `web-app/` is a second, non-shipping UI

`ProjectWorkspace.tsx` is 2,510 lines with 81 `useState`/`useEffect` hooks and
~19 surfaces, and its E2E "coverage" (76 tests in `purple-lab.spec.ts`) is
almost entirely API-level plus shallow page-load assertions -- there is no
behavioural test of the workspace. It is not what users see. Two competing UIs
is itself a source of the "complex and complicated" feeling.

### Design language

`web-app/tailwind.config.js` sets primary `#553DE9`, warm neutrals (`#FFFEFB`
background, `#201515` ink) and `DM Serif Display` headings. The shipping
dashboard shares the serif-heading, warm-neutral look (visible in the
screenshots). Linear, Vercel, Sentry and Ona all run cool neutrals, dense type,
and no serif in product chrome.

---

## Ona (ona.com) -- read in full, 10 files

### 1. Audit-first policy ladder (the single best idea in the Ona corpus)
`ona.com_docs_ona_organizations_policies_executable-deny-list.md`

Veto Exec blocks or audits executables, and the docs push you to start in audit
mode: "Start with audit rules, review matches, then promote confirmed rules to
block." Rules take `EFFECT_AUDIT` or `EFFECT_BLOCK`; `EFFECT_ALLOW` is illegal
on a rule.

Why it is good: a policy you cannot safely turn on is a policy nobody turns on.
Audit-first lets an org see what WOULD have been blocked before anything breaks.
This is the same shape as our advisory-vs-blocking gate distinction, but applied
to security policy, and with an explicit promotion path.

Also sharp: block rules extend to "direct reads and copies, writes, opens that
could modify the file, and writable shared-memory mappings" and identity is
SHA-256 content, not path -- so renaming, hard-linking, copying, or symlinking a
blocked binary does not evade the rule.

### 2. Guardrails are numeric and set BEFORE the first run
`ona.com_docs_ona_create-first-automation.md`

"Max concurrent: 5 (for testing)" and "Max total: 20", with the instruction
"Increase these once you are confident the Automation works."

Why it is good: a hard runaway ceiling the user picks, in units they understand,
at the moment they create the automation. Compare our `LOKI_MAX_ITERATIONS`
(25 default) and `LOKI_BUDGET_LIMIT` (unset -- no spend cap at all).

### 3. The trust ladder: Manual -> verify -> Scheduled
`ona.com_docs_ona_create-first-automation.md`

"Start manual. Run the Automation a few times, review the results, and adjust
steps as needed. Build confidence before scheduling." Step 6 is run-and-verify;
step 7 is schedule-it.

Why it is good: the product encodes *earning* autonomy rather than assuming it.
The user is never asked to trust an unattended agent on day one.

### 4. Insights measures OUTCOMES, not agent activity
`ona.com_docs_ona_organizations_insights.md`

Velocity metrics are Lead time (median first commit to PR merge), PRs merged,
Time to first approval, Deploys/week. AI Adoption attributes lines to Ona,
Codex, Claude, Copilot, Cursor via `Co-authored-by` trailers.

Why it is good: these are metrics an engineering leader already reports upward.
It answers "did this help us ship" instead of "how busy was the agent". Our
metrics are agent-internal (iterations, gate pass rates, tokens).

Honest touch worth copying: "For lead time and time to first approval, a
downward trend is positive." The chart states which direction is good.

### 5. @-mention in a PR is the whole invocation
`ona.com_docs_ona_integrations_github-pr-mentions.md`

`@ona-agent` alone starts a review; anything after the handle becomes the
prompt. Works in PR comments, inline review comments, and review submissions.
`@ona-agent retry` replays the last failed start.

Why it is good: **zero required steps before first value** from where the user
already is. Also: "The agent reacts to your comment with an emoji to confirm the
trigger", then "posts one reply ... The same reply updates in place" -- one
comment that mutates, not a thread of spam.

Cancellation is equally cheap: "Delete your trigger comment. Cancels the session
and posts a confirmation."

Security detail worth stealing: "Pull requests from forks are ignored. Fork PRs
can carry untrusted code, and anyone with a GitHub account can comment on them."
And mentions inside code fences, inline code, blockquotes, HTML comments and
image syntax are ignored, so you can write *about* the handle without firing it.

### 6. Identity: run as user, or as a service account
`ona.com_docs_ona_create-first-automation.md`, `..._integrations_github-pr-mentions.md`

"Your user: Automations run under your identity. Commits and PRs appear as you."
vs a shared service account for team-wide automations.

Why it is good: attribution is explicit and chosen. Ours is implicit.

### 7. Bootstrap the environment config WITH the agent
`ona.com_docs_ona_create-first-automation.md`

Rather than making you hand-write `devcontainer.json` + `automations.yaml`, they
ship a ready-made prompt that generates both, and it is unusually well built:
it has a Required Process, explicit Success Criteria, **Acceptance Tests**
("The command `ona env devcontainer validate` succeeds", "Ona automation
services successfully reach the state ready"), and an Allowed Sources allowlist.

Why it is good: the hardest setup step is done BY the product, and the generated
work is checked against runnable acceptance tests, not vibes. This is the
first-run lever we most obviously lack.

---

## 8090 (8090.ai) -- read in full, 60 files

Their four-part "alignment engineering" blog series is the most rigorous
thinking in any of the four corpora.

### 1. Stable requirement + acceptance-criterion IDs (most directly actionable)
`www.8090.ai_docs_opinions_requirements-writing-guide.md`

Every requirement gets `REQ-[PREFIX]-NNN` and every criterion `AC-[PREFIX]-NNN.N`,
each phrased "When [condition], the system shall [behavior]". "Use shall for
mandatory behavior, should for recommended, and may for optional." Criteria must
be user-centered, testable, and **atomic**: "Each acceptance criterion covers one
behavior. Split compound behaviors into separate criteria."

Why it matters to us: a stable ID makes a criterion *citable*. A receipt could
say AC-CHK-003.2 is satisfied by this test at this line. Drift could be tracked
per criterion instead of per document. Our `_brief_acceptance_criteria` and
`derived_ac` emit prose bullets with no IDs, so nothing downstream can reference
one.

### 2. Bidirectional traceability as the load-bearing property
`www.8090.ai_blog_part-3-seven-properties-of-an-aligned-system.md`

"This is the salient property. The one that makes the other six possible."
Every line of code traces up to a work order, blueprint, requirement, and a
barrier on the customer state map; and at each layer artifacts must be mutually
consistent. "It is not a chain problem. It is a graph problem."

Verbatim, and worth pinning: "If the trace breaks anywhere, that element is
orphaned. It exists, but nobody can explain why in terms of the customer's
reality."

### 3. Every translation must declare what it LOST
Same file, property 2.

Each artifact answers three questions: what did I preserve, what did I compress,
**what did I assume that was not explicitly stated**. "The third question is the
most important. Implicit assumptions are the primary vehicle of misalignment."

Why it is good: this is a concrete, cheap artifact we could emit at every
translation (brief -> PRD, PRD -> tasks, task -> diff) and it directly attacks
the failure mode where an agent silently invents scope.

### 4. Confidence without measurement is the dangerous state
Same file, property 5.

"If the system feels aligned but has no measurement proving it, the system is
almost certainly drifting. Confidence without measurement is the most dangerous
form of misalignment, because it feels fine right up until it is not."

This is our own doctrine stated better than we state it.

### 5. Feedback speed sets the ceiling on achievable alignment
Same file, property 4.

"If you only validate against the customer's reality once a quarter, three
months of drift is the minimum misalignment your system can produce. No amount
of upfront specification changes this."

### 6. Quote evidence keeps planning grounded in the user's words
`www.8090.ai_docs_modules_feedback.md`

Themes group feedback, and "Quotes are exact passages from feedback items. Use
them to connect a theme back to the user's words and keep planning grounded in
evidence."

Why it is good: same discipline as our Evidence Receipt, applied to intake.
A theme cannot drift into a PM's paraphrase because the exact passage travels
with it.

### 7. A configurable decomposition strategy
`www.8090.ai_docs_modules_work-orders.md`

Before extracting tasks you pick an extraction strategy -- "feature-slice vs
specialist-oriented" -- or write "a custom extraction strategy by giving the
agent explicit instructions on how to break blueprints into tasks."

Why it is good: how work is sliced is a real engineering opinion, and they let
the user hold it. We decompose one way, always.

### 8. Reverse-engineer requirements from existing code
`www.8090.ai_docs_modules_requirements.md`

First-run choice: "Reverse-engineer requirements from artifacts and code, or
create new requirements from scratch." The agent can read "notes, transcripts,
designs, images, and codebases" to draft requirements.

Why it is good: brownfield users have no PRD and are not going to write one.
This removes the single biggest blocker to first value on an existing repo --
and brownfield is our stated wedge.

### 9. Distribution: ship a skill INTO the user's existing agent
`www.8090.ai_docs_opinions_agent-skill.md`

`npx skills add 8090-inc/software-factory-plugin`, invoked as `/software-factory`
in Cursor. Execution state lands in a `.sw-factory/` directory holding "an
implementation plan, implementation checklist, context notes, and a review log".

Why it is good: they do not require switching agents. Same wedge shape as our
Verify play. Note the on-disk execution directory is very close to our `.loki/`.

### 10. Structural changes require confirmation
`www.8090.ai_docs_modules_requirements.md`

"The agent can suggest creating, splitting, merging, or reorganizing features.
All structural changes require user confirmation."

### The 8090 credibility gap (our wedge, re-verified verbatim)
`www.8090.ai_terms-of-service.md`

They market alignment rigor to regulated enterprises, and their own ToS contains
"AS-IS", disclaims "ACCURACY", caps liability at "FIFTY US DOLLARS", and
requires "HUMAN REVIEW AND VERIFICATION OF ALL OUTPUT".

Grep-verified counts in that file: `FIFTY US DOLLARS` x1,
`HUMAN REVIEW AND VERIFICATION OF ALL OUTPUT` x1, `AS-IS` x1, accuracy x5.

---

## Design-language reference (top enterprise developer tools)

Not from the corpora -- this is the target for the UI work, stated so the plan
can be checked against it.

- **Cool neutrals, not warm.** Linear/Vercel/Sentry chrome is near-neutral grey
  with a single saturated accent. Our `#FFFEFB` / `#201515` warm palette and
  `DM Serif Display` headings read editorial, not operational.
- **Density is a feature.** Enterprise dev tools show more rows per screen, not
  fewer. Generous marketing spacing wastes an operator's screen.
- **One accent, used for one meaning.** We currently have primary purple, teal,
  pink, blue, plus success/warning/danger/info -- eight accents.
- **Status must be legible without color** (colorblind + dense tables): shape,
  label, or icon carries it too.
- **Keyboard-first.** Cmd-K is table stakes; Linear's speed reputation is mostly
  keyboard coverage.
- **Never a spinner without a claim.** Show what step, what bound, what happens
  next -- the same rule we applied to `docs generate` and `magic debate`.

---

## Devin (Cognition) -- read by a dedicated reader, ~410 English pages

Top items, ranked by fit to our measured gap.

1. **Session Insights.** Every completed session is auto-classified; L/XL runs
   get a full analysis at teardown producing an Issue Timeline, an **Improved
   Prompt** with hover diffs, and Action Items linking to the config that fixes
   them. It distinguishes two failure signatures: high ACU + few messages = the
   agent floundered alone; many messages + low ACU = the prompt was
   underspecified. `docs.devin.ai_product-guides_session-insights.md`
   > "Sessions classified as L or XL are flagged as unhealthy, meaning Devin
   > likely encountered significant issues or the task scope was too broad."

2. **Misleading Knowledge detection.** Insights splits retrieved knowledge into
   Useful vs **Misleading**, and explains why a misleading item led the agent
   astray. Makes memory falsifiable -- the store gets a feedback signal, not
   just an append path.
   > "a single outdated knowledge item can degrade session quality across your
   > entire team."

3. **Three-way review confidence taxonomy.** Findings split by epistemic status:
   **Bugs** (high confidence, fix it), **Flags/Investigate** ("you should review
   this yourself and verify whether there is an actual bug"), **Flags/
   Informational**. Admins choose which classes post to GitHub.
   `docs.devin.ai_work-with-devin_devin-review.md`

4. **Knowledge = trigger-description retrieval, not a context dump.** Every item
   carries a trigger phrase describing WHEN to recall it; retrieved mid-task.
   > "Devin retrieves Knowledge when relevant, not all at once or all at the
   > beginning."

5. **Permission prompts offer "Edit command" and "Describe change to command".**
   Approval is not yes/no -- you can rewrite the proposed command in plain
   language and review before running. Cheapest high-leverage steering hook in
   any of the four corpora. `docs.devin.ai_cli_reference_permissions.md`

6. **Smart mode: model judges the fuzzy middle, deterministic deny-list holds
   the tail.** Never auto-approved regardless of model judgment: package
   installs, mutating git, `rm`/`sudo`, cloud destructive ops, dotenv/key
   material, and **the agent's own configuration**. Fails closed when the model
   is unavailable.

7. **Soft budget block.** Per-PR review spend cap pauses auto-review but leaves
   manual review working, with a one-click re-enable surfaced in the PR
   description. A hard block makes a support ticket; a soft block makes an
   informed decision.

8. **Testing mode ends in an annotated video**, and asks for all missing secrets
   up front, persisting them. The test plan is sent for approval before
   execution.
   > "The goal is a short recording that a code reviewer watches and immediately
   > thinks 'yep, it works' -- then merges the PR."

9. **Attribution invariant.** > "Devin will never create commits or comments on
   behalf of a user without the user explicitly initiating the action."

10. **Reads competitors' instruction files** -- `CLAUDE.md`, `.cursorrules`,
    `AGENTS.md`, `.windsurfrules`, `.coderabbit.yaml`. Zero-migration adoption.

11. **Slices**: smallest atomic unit, under 90 minutes, independently
    verifiable, backwards-compatible. "Wide & Shallow beats Tall & Deep."
    > "Even a small error rate can compound when executing at scale."

**Conceded limitations (verbatim):**
> "it can still experience hallucinations, introduce bugs into code, or suggest
> insecure code or procedures" -- `docs.devin.ai_admin_security.md:65`
> "it can't make aesthetic judgment calls on its own"
> "Playbooks ... today require skill to write."
> "After each slice is completed, it should undergo human review before merging"

---

## Factory AI (Droids) -- read by a dedicated reader, all of harness/ + 187 release notes

1. **Agent Readiness Model.** A 5-level, 9-pillar rubric scoring whether a
   CODEBASE is capable of being worked on autonomously; 80% of level N gates
   level N+1. `/readiness-report` evaluates, **`/readiness-fix` remediates** --
   the agent bootstraps its own preconditions.
   `docs.factory.ai_agent-readiness_overview.md`
   > "Good observability turns 'it failed' into 'it failed because X was null
   > when calling Y after receiving Z.'"

2. **Missions publishes its own open questions.** A literal `## Open questions`
   section: `docs.factory.ai_missions_overview.md:113-121`
   > "Is parallelization necessary? ... does it actually produce better results
   > than sequential execution? We are testing this."
   > "How do you maximize correctness? Long-running plans accumulate errors."
   And: > "Without it, the mission cannot reliably verify its own work."
   (Missions require repo readiness Level 4+ -- self-verification is a property
   of the ENVIRONMENT, not the agent.)

3. **Code-review bug rubric: eight conjunctive gates.** An issue is a bug only
   if all hold, including **appropriate rigor** ("Does not demand more rigor
   than the rest of the codebase") and **provably affected** ("Identifies
   specific affected code, not a theoretical risk"). Optimizes precision over
   recall to protect attention. `docs.factory.ai_software-factory_code-review.md.md:143-156`

4. **`/btw` -- a side channel that does not pollute the transcript.** Ask a
   question mid-run without injecting it into the main conversation history.
   Separates the steering channel from the task channel.

5. **Slash commands remain usable WHILE the agent runs**, tiered: read-only
   commands open instantly; conversation-mutating ones confirm before stopping.

6. **Interaction Mode is decoupled from Autonomy Level.** Mode = what shape of
   work; autonomy = how much runs without approval. Two orthogonal axes.

7. **Blocklist: a floor no approval can bypass**, and it resolves the actual
   program first, so > "a blocked command cannot be slipped through with a
   wrapper shell ... an absolute path, quoting tricks, or command substitution."

8. **Subagents declare their information loss.** > "A single return value: it
   hands back one final message, which is not shown to you unless the parent
   summarizes it."

9. **AGENTS.md doc discourages more content.** Hard caps (80k initial, 40k
   dynamic). > "These are caps, not targets. Smaller files are usually better."

10. **`feature-maturity.md` refuses marketing vocabulary** -- only Private
    Preview and Deprecated exist; GA is the absence of a tag.

11. **Droid Shield publishes its own ceiling.** > "Droid Shield is a detection
    tool, not a guarantee."

**The release-sequence read (the most useful signal in the changelog):** they
built capability, then extensibility, then permission granularity, then hit the
context wall (four consecutive releases on compaction), and then turned hard
toward mid-run steering. **The last ~40 releases are disproportionately about
steering, not capability.** At long horizons the binding constraint is the
user's ability to intervene without destroying the run.
