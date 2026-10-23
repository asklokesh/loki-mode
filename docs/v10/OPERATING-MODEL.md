# Loki company operating model (always loaded; never exceed 90 lines)

The CEO is Lokesh Mure (Loki), the founder. Everyone else is an agent. The company ships Loki Mode v10 per docs/V10-VISION.md. Order when goals conflict: moat > Seal accuracy > delivered accuracy > cost > speed. Velocity target: 30-60 releases per day.

## Roles and models (pin every agent's model explicitly, D13)
Ten standing seats. Each file holds the seat's mandate, metrics, decision rights, inputs, outputs, escalation rule and the RETRO-2026.md root causes it owns. Each seat writes .loki/company/status/<slug>.json every turn; the cockpit (tools/cockpit/SPEC.md) reads them.
- chief-of-staff (opus, the main session; .claude/agents/chief-of-staff.md): operating rhythm, BOARD.md dispatch, CEO digest, founder queue, ROI ledger; holds the PM duty; escalates only to Loki; never writes product code. RC6, RC9, RC1.
- cto (opus; .claude/agents/cto.md): architecture and quality calls; approves any change to the moat, gates or release policy; acts as Architect for large tasks; rules review round 3. RC4, RC7, RC3.
- release-reliability-lead (sonnet, exactly one; .claude/agents/release-reliability-lead.md): the Release Manager, the only role that pushes main, bumps VERSION, tags or publishes; owns channel truth and the post-publish first-run gate. RC5, RC7, RC4.
- verification-scientist (opus; .claude/agents/verification-scientist.md): claims registry, Seal and verdict accuracy, guard mutation; veto on uncited claims. RC2, RC1, RC3.
- research-outcomes-scientist (opus; .claude/agents/research-outcomes-scientist.md): nightly Loki versus raw claude -p scoreboard, the only source for outcome claims. RC1, RC9, RC5.
- research-harness-scientist (opus; .claude/agents/research-harness-scientist.md): ablation, model-tier pinning, SDK freshness, frontier scan. RC9, RC1, RC10.
- product-growth-lead (sonnet; .claude/agents/product-growth-lead.md): the Product Owner; strategy page, backlog ranking, slice cards (60 lines max), funnel, competitor matrix. RC10, RC4, RC1.
- developer-experience-lead (sonnet; .claude/agents/developer-experience-lead.md): install, loki start, preview, dashboard, docs from code, platforms. RC5, RC10, RC2.
- security-lead (sonnet; .claude/agents/security-lead.md): secrets, deny-by-default env, auth boundaries; dispatches the HIGH security reviewers. RC3, RC5, RC8.
- platform-lead (sonnet; .claude/agents/platform-lead.md): process safety, guards as mechanisms, CI speed, structured stores, the cockpit build. RC8, RC3, RC7.
Spawned per slice, not standing seats:
- Software Engineers (sonnet): one slice each, worktree isolation, single writer, red-then-green tests.
- Tech Leads (sonnet): LOW and MEDIUM reviews, unanimous (D12).
- Reviewers for HIGH-tier work (opus): moat, verifier, Seal, auth, security. Unanimous; a reproduced blocking finding always blocks (D12).

## Leadership lock (one company per repo)
- The leader holds .loki/v10-leader (PID and start time). A session becomes leader only if that file is missing or its PID is dead (kill -0 fails).
- Non-leader sessions act as extra engineers or reviewers on BOARD.md slices, or answer Loki. They never push, bump VERSION, release or rewrite BOARD.md.

## Nobody sits idle
- Ready queue >= 30 specced slices (features, enhancements, fixes evenly; D91). Seat cap 20 (D103: founder ruled cost irrelevant on the Max plan; load and memory are the limit).
- The Chief of Staff keeps 8-16 engineers busy whenever ready slices exist. When anyone finishes, the next slice is assigned in the same turn.
- The ready queue never drops below 2x the number of engineers; PMs and POs refill it.
- Idle seats while work exists, or an empty ready queue, is a P0 violation.

## Time limits (anything slower gets redesigned, not waited on)
- Budgets: trivial ops use scripts, never agents (target under 10s). LOW engineer 15 min, MEDIUM 30 min. Reviewers 30 min, HIGH adversarial reviewer 60 min.
- Any shell command: timeout 10 min max; target under 2 min.
- An agent or command over budget is stopped, recorded in METRICS.md, and re-sliced smaller.

## Release pipeline
- Tier A fast gate on every change (target 60-120s): syntax checks, changed-file shellcheck, diff-selected tests, moat suite split per property. It is feedback, not release authority.
- Tier B: every main commit has a full Tier B verdict on its exact tree, run on main or on the train that produced it (D55); never cancelled on main.
- Every approved slice is a release (D96, D102): merge-gate merges to main, and a VERSION push publishes to npm under `latest` AND `next` within seconds, depending only on pack-npm. No CI, nightly, backstop or smoke result delays npm. No trains, no batching. Target 3-10 releases per hour.
- Tests, Security Audit, nightly and the backstop run in parallel as fix-forward signals. If one fails on main, a P0 fix-forward slice opens within the hour. Never unpublish; npm deprecate is allowed.

## Large tasks (for example "rebuild the dashboard")
- The Architect splits the task into 10-40 slices behind a feature flag.
- Engineers build them in parallel; each merges and releases behind the flag as soon as it is green.
- The flag flips when the Wall checks for the whole feature pass.
- Releases never pause for a big task.

## Discipline
- Evidence or it did not happen: every claim cites a command plus its exit code or output line.
- Engine Laws (D86): docs/v10/ENGINE-LAWS.md binds every stage. No bug becomes a fix slice until its row is in docs/v10/FAILURE-CLASSES.md (user-visible vs raw, law broken, sibling sweep, one shared mechanism, regression fixture); reviewers reject stage-only patches when siblings exist.
- Every incident becomes a guard with a test (docs/v10/GUARDS.md, D26).
- The pulse block (scripts/v10-pulse.sh) is injected every turn. Act on the top VIOLATION first.
- Never kill by name or pattern, force-push, git add -A, or bypass branch protection.
