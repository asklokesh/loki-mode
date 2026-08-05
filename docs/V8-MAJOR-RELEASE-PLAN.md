# v8 Major Release - Costed Decision Plan

Status: PROPOSAL (founder review before any implementation spend). 2026-07-24.
Author: this session, grounded in the actual repo state (not aspirational).

## TL;DR (the honest headline)

**v8 is ~80% built and tested, but uncommitted.** The hard engineering - a 12,300-line
parity-locked TypeScript runner, the Anthropic SDK route (`sdk_invoker.ts`, `sdk_mode.ts`,
stream parser), and ~18,000 lines of *working, test-passing* feature work (supervised builds,
deadline confinement, honesty/no-mock hardening, code-review calibration) - already exists in
the working tree. The V8-AGENT-SDK-PLAN and RARV-C-100X-PLAN both say so explicitly:
"much of this is already shipped."

So "the v8 major release" is NOT a build-from-scratch effort. It is, in order of cost:
1. **CONSOLIDATE + VERIFY + SHIP** what already works (cheap, high-value, the bulk of the win).
2. **A bounded net-new layer** the founder asked for: jcode-informed harness-intelligence,
   PostHog analytics, the otel 2.x upgrade.

This plan costs each phase so the founder funds them selectively, not as one open-ended blob.

---

## Where v8 actually stands (verified this session)

| Component | State | Evidence |
|---|---|---|
| TS runner (autonomous loop, council, gates, prompt) | Built, parity-locked | `loki-ts/src/runner/` 12.3k lines, 22 modules |
| Anthropic SDK route (judges = raw SDK, loop = Agent SDK) | Built + tested | `sdk_invoker.ts`, `sdk_mode.ts`, `sdk_stream_parser.ts`; tests: sdk_invoker, sdk_stream_parser, sdk_query_provider, sdk_loop_e2e |
| One-switch `LOKI_SDK_MODE` (off/judges/full) + rollback | Built | CHANGELOG v8.1; byte-mirrored bash+TS, shared parity fixture |
| Supervised builds / deadline confinement | Built + tests PASS | `deadline.py`, `build_supervisor.py`, `dependency-setup.sh` + `test-hard-deadline-confinement`, `test-supervised-*` (verified passing) |
| Honesty / no-mock hardening | Built + tests PASS | `no_mock_scan.py`, `test-harness-false-green`, `test-honest-gate-status`, `test-nomock-data-render` (verified passing) |
| Code-review calibration | Built | `test-review-severity-calibration`, `-assurance-tail`, `-lockfile-context` + council/quality_gates mods |
| ~18k LOC uncommitted total | Working, not committed | `git diff`: 46 files +7173/-1296; 25 new files +11057 LOC |
| Published to npm as 8.x | NO | npm latest = 7.129.4; v8 never published, never merged to main |
| PostHog analytics | **BUILT** (`5dcc88c6`) | opt-in `build_verified` event behind a strict second gate (`LOKI_ANALYTICS=on`, default OFF even when telemetry is on), fixed allowlist reader emits proof scalars only |
| otel 2.x (the deferred CVE fix) | **DONE** (`159dc7f4`) | clears GHSA-45rx-2jwx-cxfr at source |
| Phase 3 harness intelligence | **BUILT** (`9e596e9a`, `889bd52a`, `500e74f6`) | 3a prompt-cache discipline already existed (verified, not rebuilt); 3b confidence-spike, 3c goal scoring, 3d smart retry landed 2026-07-25 |
| Release identity (VERSION vs CHANGELOG) | **RESOLVED** (`a749ee54`) | folded the drafted `v8.1.0` block into one `v8.0.0` entry; no 8.x was ever published, so a first-ever 8.x as 8.1.0 would have described a release history that does not exist |

**Releasability gate:** full `local-ci.sh` on the WIP tree - RESULT PENDING (running at write time;
this plan's Phase 1 cost depends on how clean it is).

---

## The CHANGELOG-vs-WIP question (must resolve first)

The `## v8.1.0 (unreleased)` CHANGELOG entry documents ONLY the SDK one-switch/rollback/packaging
gate. But the ~18k uncommitted lines are mostly OTHER efforts (supervised builds, deadline,
honesty, review calibration). **The documented release scope and the actual WIP do not match.**

Resolution needed from founder: is the v8 MAJOR release =
- (A) the SDK route ONLY (commit just the SDK-related files, ship a focused v8.0.0), OR
- (B) EVERYTHING in the tree (SDK + supervised + honesty + review work) as one big v8.0.0?

Recommendation: **(B)**, because the extra work is on-thesis (all deepens the trust moat), already
tested, and shipping it piecemeal means more release cycles. But it requires per-theme commit
curation (never one `git add -A`), so it costs more review time than (A). This is the single
biggest scope decision and it changes Phase 1's cost.

---

## Phased plan (each phase independently fundable)

### Phase 1 - CONSOLIDATE + SHIP what's built  [CHEAPEST, HIGHEST VALUE]
The bulk of v8's value is already written. This phase makes it real.
- Resolve the scope question (A vs B above).
- Curate the WIP into coherent, themed commits (per-theme, individually staged - the same
  isolation discipline used for the v7.129.4 doc-gen commit; NEVER `git add -A`).
- Get full local-ci green on the committed tree (prime deps + rebuild dist - the lesson from
  v7.129.4: most "failures" are environmental).
- Reconcile the release identity: VERSION 8.0.0 vs CHANGELOG's 8.1.0; first-ever 8.x publish; a
  genuine MAJOR. Decide the number, write the CHANGELOG major entry.
- **Do NOT publish yet** - land it green + reviewed on the branch, PR-ready. Publishing 8.0.0 is a
  separate, explicit, irreversible founder go (like the v7.129.4 push).
- Cost: MODERATE (review/curation of 18k LOC + CI greening). Mostly verification, little new code.
- Deliverable: v8 branch green, committed, coherent, PR-ready. The trust moat + SDK route SHIPPED.

### Phase 2 - PostHog analytics  [NET-NEW, founder-requested]
"log/monitor/get analytics as much as possible in PostHog."
- Wire a PostHog sink alongside the existing OTLP/crash telemetry (opt-in, privacy-preserving -
  loki's zero-egress posture is a documented moat; PostHog must be explicit-opt-in, never covert).
- The SDK route already surfaces rich typed telemetry (total_cost_usd, usage, cache read/creation,
  modelUsage, num_turns, duration_ms) - these become PostHog events cheaply.
- Instrument: build lifecycle, gate outcomes, RARV iterations, provider/model, cost/tokens, council
  verdicts, receipt facts, per-stage latency, failure modes.
- Cost: MODERATE (one new sink + event mapping; reuses existing telemetry seams).
- Deliverable: opt-in PostHog analytics across the v8 build lifecycle.

### Phase 3 - jcode-informed harness intelligence  [NET-NEW, "better than jcode"]
Adopt jcode's measured-harness discipline onto loki's trust moat (see the jcode analysis in
[[project-v8-major-release-mandate]]). Ranked by impact/effort:
- 3a. **Prompt-cache discipline** (HIGH impact on latency+cost, MED effort): append-only context,
  stable prefix, MCP tools advertised up-front. The SDK route makes cache metrics visible already.
- 3b. **Confidence-stepping / spike re-check** (HIGH, MED): force re-verify when agent confidence
  jumps to 100 (jcode's finding: confident-after is not signal). Layers onto the completion council.
- 3c. **Hill-climbable goal scoring** (MED, MED): score each goal's quantifiability, push back on
  un-measurable goals. Complements the evidence gate.
- 3d. **Auto-poke persistence** (MED, LOW): poke the loop back on incomplete todos; smart retry
  (transient retry, non-retryable stop-to-save-tokens). Partially exists (never-stop directive).
- Cost: LARGE (each is a real feature). Fund individually; 3a is the best first (direct latency/cost win).
- Deliverable: measurably faster/cheaper/more-persistent loop, trust moat intact.

### Phase 4 - otel 2.x + dependency modernization  [DEFERRED FROM v7.129.4]
- The breaking @opentelemetry 2.x major bump that clears GHSA-45rx-2jwx-cxfr for real (the v7.129.4
  patch waived it as not-reachable; here it gets genuinely fixed since major bumps belong in a major).
- Re-verify tracing still works after the bump.
- Founder standing directive: "always latest code, api, libraries" - audit + modernize other deps here.
- Cost: SMALL-MODERATE (mechanical but needs tracing re-verification).

### Phase 5 - MAJOR RELEASE  [IRREVERSIBLE, explicit founder go]
- Full CLAUDE.md release workflow: 14-file version bump, CHANGELOG major entry, dashboard rebuild,
  pre-publish validation, merge to main -> publish npm/Docker/Homebrew.
- Post-release validation across all channels + both routes (as done for v7.129.4).
- Cost: SMALL (mechanical, proven process from v7.129.4). The GO is the founder's.

---

## Recommended sequence + why

1. **Phase 1 first, always.** It converts existing work into a shipped, reviewed, green branch -
   the highest value for the least new spend, and it de-risks everything else.
2. Then the founder picks Phase 2 (PostHog) and/or Phase 3 items (harness intelligence) to fund -
   these are the "better in every direction" asks and each is independently costed.
3. Phase 4 (otel/deps) bundles into whichever phase touches CI next.
4. Phase 5 (publish) only when the founder says the accumulated phases are worth a major release.

## Cost discipline (per the standing directives)
- Ultrathink each phase's plan + advisor review before its implementation.
- Ultracode (surgical workflow) for the implementation where parallelism pays - NOT for planning.
- Every phase ends in a SHIPPED/committed/verified artifact, never another doc.
- No `git add -A`; per-theme individual staging; repo-local asklokesh identity; explicit go before
  any irreversible publish.

## The one thing to decide now
The founder's call that unblocks everything: **the CHANGELOG-vs-WIP scope question (A vs B) + confirm
Phase 1 as the start.** Everything downstream flows from that.
