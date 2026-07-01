# Sonnet 5 Default - Implementation Plan

Status: PLAN (no code written). Worktree: `../loki-sonnet5-wt` (branch `feat/sonnet5-default`).
Board decision: `strategy/roadmap/13-BOARD-2026-06-30.md`. Verified facts: `reference-sonnet5-model-ids` memory.
Release class: MINOR (new default execution model for every user). Full local-ci + council 3/3 + release ladder.

## 1. Goal (founder directive, 2026-06-30)

Make Sonnet 5 the DEFAULT execution model for Loki runs. Advisor stays Opus (opt-in / when needed).
User can set all tiers to haiku|sonnet|opus from the dashboard at start, and hot-switch mid-run without
interrupting executions. Protect the "never lies about done" trust moat: the switch must NOT weaken the
verdict.

## 2. Ground truth (verified against source 2026-06-30)

- Live model resolver: `resolve_model_for_tier()` (providers/claude.sh:390) reads
  `PROVIDER_MODEL_{PLANNING,DEVELOPMENT,FAST}` (claude.sh:65-67) which chain from `CLAUDE_DEFAULT_*`
  (claude.sh:55-57). Today: PLANNING=opus, DEVELOPMENT=opus (comment "was sonnet"), FAST=sonnet.
- `get_provider_tier_param` case block (run.sh:~2447) with hardcoded `development) echo opus` is the
  INERT legacy fallback, reachable only when claude.sh is unsourced (guard run.sh:2414). Flip anyway
  for consistency.
- Trust-gate code-review reviewers: `_dispatch_reviewer()` (run.sh:~10148) sets
  `_rv_argv=("--dangerously-skip-permissions")` and deliberately passes NO `--model` -> reviewers run
  on the ACCOUNT DEFAULT model = non-deterministic, config-dependent. The in-code comment (run.sh:~10164)
  explicitly says a future `--model` here "must be pinned to opus, never fable" (Fable refuses cyber
  content, ends -p turn with stop_reason refusal). Bun route mirrors this: quality_gates.ts:28 + :1223.
- Hot-switch mid-run EXISTS: `.loki/state/model-override` read each iteration (run.sh:16007-16070),
  written by dashboard `POST /api/session/model` (server.py:2852), allowlist haiku|sonnet|opus|fable,
  clamped by `loki_apply_max_tier_clamp` (claude.sh:347). Fresh `claude -p` per iteration = clean switch.
- Sonnet 5 = alias `claude-sonnet-5` (CLI resolves aliases to latest; loki passes alias verbatim at
  claude.sh:334). Opus 4.8 = `claude-opus-4-8`. Pricing (server.py:6174, run.sh:4847/12153): sonnet
  $3/$15, opus $5/$25, haiku $1/$5, fable $10/$50 - all correct. model_catalog.json has stale IDs
  opus-4-7, sonnet-4-6.
- Parity-locked: `tests/test-model-override.sh` + dashboard estimator (`_clamp_to_max_tier`, `_max_tier`)
  are byte-locked to the resolver. Flipping defaults MOVES the quote -> expected values must update.
- Dashboard-ui: no start-time model picker (grep empty). mid-run switcher UI also appears absent
  (POST endpoint exists, no UI consumer found).

## 3. Tier -> model mapping AFTER the change

| Tier (RARV phase)        | Today                    | After                                  |
|--------------------------|--------------------------|----------------------------------------|
| planning (REASON)        | opus                     | sonnet (Opus opt-in via advisor path)  |
| development (ACT/REFLECT)| opus                     | sonnet                                 |
| fast (VERIFY)            | sonnet                   | sonnet (haiku via LOKI_ALLOW_HAIKU)    |
| trust gate (council/review)| account default (float)| account default (UNCHANGED); opus via OPT-IN `LOKI_ADVISOR_MODEL` |
| advisor / reviewer pin    | (does not exist)         | `LOKI_ADVISOR_MODEL` (default unset = today's behavior; set=opus) |
| Opus-for-execution       | default                  | opt-in (dashboard "all opus" / env)    |

### CORRECTION (advisor review 2026-06-30) - D2 is OPT-IN, not always-on

The original board D2 ("always pin reviewers to --model opus") is REJECTED as written, for four reasons:
1. NOT causally forced by the Sonnet flip: `_dispatch_reviewer` reads neither `tier_param` nor
   `CLAUDE_DEFAULT_*`, so flipping the builder default does NOT change the reviewer model. The judge
   floating with the account default is a PRE-EXISTING condition, not something this PR exposes.
2. UNCOSTED: pinning 3 reviewers + devil's-advocate + security-sentinel to Opus ADDS Opus-priced tokens
   on top of the builder savings. Opus ~1.7x sonnet. This could eat or exceed the "~40% cheaper" story.
   Net cost is UNKNOWN until we measure reviewer-token vs builder-token volume for a typical `loki start`.
3. CONTRADICTS the founder's words: "advisor will be opus IF NEEDED OR USER OPTED" = conditional/opt-in.
   Always-on removes the implicit cost control users have today (account default) - opposite of the
   adoption/cost intent.
4. "Deterministic verdict" is the wrong framing: LLM reviewers are never deterministic; this is a
   consistency/quality argument, not determinism.

Moat guarantee (corrected): default behavior of the trust gate is UNCHANGED by this release (no
cost regression, no surprise). Users who want a strong, consistent Opus judge set `LOKI_ADVISOR_MODEL=opus`
(or the dashboard "advisor: Opus" toggle), which pins the reviewer/override-judge to Opus. This is the
founder's "opus if needed or user opted", made real and opt-in. Lane B and Lane C COLLAPSE into this one
opt-in advisor path.

## 4. Per-file change list (disjoint lanes for parallel principal engineers)

### Lane A - Execution default flip (providers/claude.sh) [engineer 1]
- claude.sh:56 `CLAUDE_DEFAULT_DEVELOPMENT="opus"` -> `"sonnet"`.
- claude.sh:55 `CLAUDE_DEFAULT_PLANNING="opus"` -> `"sonnet"` (see open question Q1 - founder may want
  planning to stay opus; design so this one line is a trivial revert).
- claude.sh:57 FAST stays sonnet.
- Trace + document the clamp ripple: `loki_apply_max_tier_clamp` (claude.sh:347) resolves planning/fable
  DOWN to `PROVIDER_MODEL_DEVELOPMENT`. With dev=sonnet, `LOKI_MAX_TIER=sonnet` now genuinely pins
  sonnet (previously it clamped to opus). Update the comment block at claude.sh:383-386 which currently
  documents the opposite. This is a BEHAVIOR clarification, verify against the parity ports (Lane E).
- run.sh:~2447 legacy fallback `development) echo opus` -> `sonnet` (inert but consistent).

### Lane B+C (COLLAPSED) - OPT-IN advisor/reviewer Opus pin [engineer 2]
- Introduce `LOKI_ADVISOR_MODEL` (unset default = TODAY'S behavior, no change; set to `opus` = pin).
- Bash: `_dispatch_reviewer()` (run.sh:~10148): IF `LOKI_ADVISOR_MODEL` is a valid allowlisted alias,
  add `("--model" "$LOKI_ADVISOR_MODEL")` to `_rv_argv`; else leave unset (current behavior). Honor the
  existing comment (opus ok, never fable - validate the alias is not fable). The override/architect paths
  (which rewrite tier_param, NOT this dispatch) still cannot touch it.
- Bun: `quality_gates.ts` reviewer dispatch (near :1223): mirror the same opt-in read. BOTH routes match.
- Update the "reviewers deliberately do NOT pass --model" comments to: default no --model; opt-in pin
  via LOKI_ADVISOR_MODEL; rationale = consistent/strong judge when the user wants it (NOT determinism).
- Devil's-advocate + security-sentinel inherit the opt-in pin (same dispatch).
- Dashboard: an "Advisor model" toggle (default: account default; option: Opus) writes LOKI_ADVISOR_MODEL
  into the run env / a state file the dispatch reads. This IS the founder's "opus if needed or user opted".
- DO NOT make this always-on. Default behavior of the trust gate is unchanged (no cost regression).

### Lane D - Dashboard model selection [engineer 4] (follows frontend-ui-engineering skill)
- Backend: confirm `POST /api/session/model` (server.py:2852) writes `.loki/state/model-override`
  with allowlist haiku|sonnet|opus|fable (already does). Add start-time selection: `start_build`
  (server.py:3234) accepts an optional `model` that writes the override file BEFORE launch (so iteration
  1 picks it up). Validate against the same allowlist + clamp.
- Frontend (dashboard-ui/src): add an accessible model selector (haiku/sonnet/opus) on the start/new-run
  surface AND a mid-run switcher that calls POST /api/session/model. Real design-system tokens, keyboard
  accessible, no AI-aesthetic. Show current effective model + that switch applies at next iteration.
  Rebuild dashboard/static per CLAUDE.md release step 2.

### Lane E - Catalog IDs, pricing note, parity tests [engineer 5]
- model_catalog.json: opus-4-7 -> claude-opus-4-8 (3 occurrences), sonnet-4-6 -> claude-sonnet-5
  (5 occurrences). Keep the alias->tier structure.
- Pricing: LEAVE the cost NUMBERS at standing $3/$15 for sonnet (over-estimate is the safe direction;
  avoids date-expiry logic that silently breaks after Aug 31 2026). ADD a one-line intro-price NOTE in
  the dashboard pricing display / label ("Sonnet 5 intro $2/$10 through Aug 31 2026") - display only,
  not a computed rate. Update labels "Sonnet (latest)" -> "Sonnet 5".
- codex gpt-5.3-codex $1.50/$12: UNVERIFIED external number. WebFetch OpenAI pricing to confirm or leave
  with a "verify" note; do not propagate a guess as fact.
- Confirm gemini fully absent from pricing (deprecated v7.5.18).
- Parity tests: update `tests/test-model-override.sh` expected values (dev tier now sonnet). Update
  dashboard estimator expected quotes. Any Bun parity test for the resolver. Run the parity matrix.

## 5. Test / parity changes enumerated
- tests/test-model-override.sh: dev-tier resolution + LOKI_MAX_TIER=sonnet clamp expectations flip.
- Dashboard estimator parity test: per-iteration quote changes (opus->sonnet dev cost).
- New: a test asserting the trust-gate reviewer dispatch includes `--model opus` on BOTH routes
  (grep/behavioral) - locks the moat guarantee so a future edit can't silently un-pin.
- New: start_build with model param writes a valid override; invalid model rejected.
- CLI-invariance: existing `loki verify` / `loki start` still run (no crash); default model differs
  (that IS the intended change - do NOT assert byte-identical default output here).

## 6. Calibration protocol (CEO gate - before ship)
- Pick 5-10 representative specs from benchmarks/ or internal fixtures spanning easy->hard.
- Run each on Sonnet-default vs current Opus-default (real model calls; NOT in CI - documented manual
  step). Record: iterations-to-council-APPROVE, BLOCK count, wall-clock, and NET cost (builder tokens +
  reviewer tokens, so the "~40% cheaper" claim is verified NET, not just on the builder tier). Append to
  a calibration log under artifacts/sonnet5-calibration/.
- SHIP criterion: Sonnet-default does not materially increase iterations-to-APPROVE or BLOCK-rate on
  hard specs AND the net cost genuinely drops. If iterations/BLOCK regress: keep the pre-built escape
  hatch (planning->opus one-line revert; dev stays sonnet) and re-measure. Never silently keep Opus -
  make the escalation legible. If net cost does NOT drop as claimed, correct the marketing claim to the
  measured number - never ship an unverified "~40% cheaper".

## 7. Release (per CLAUDE.md)
- Version bump all files (MINOR). Loud CHANGELOG entry: "Default execution model changed Opus -> Sonnet 5.
  ~40% cheaper builds. Trust-gate reviewers pinned to Opus (deterministic verdict). Override any model
  from the dashboard." Never claim "same accuracy" (no controlled study).
- bash scripts/local-ci.sh (must be green). Council 3/3 (2 Opus + 1 Sonnet reviewers that RUN tests).
- Rebuild dashboard frontend (Lane D). Merge worktree to main, tag via CI, verify 4 channels.
- NEVER run a loki build from the worktree (self-delete trap). Verify engine changes by function
  extraction to scratch repos.

## 8. Open questions for the founder (do NOT block starting)
- Q1: Should PLANNING tier also default to Sonnet (full flatten), or stay Opus (architecture quality)?
  Plan flattens both per plain reading; Lane A makes planning a one-line revert either way.
- Q2: "advisor" scope - is it the completion-council override judge (recommended, minimal) or a
  distinct advisory role you envision elsewhere?
- Q3: Sonnet 5 intro pricing - display-only note (planned) vs actually bill the $2/$10 in estimates
  (rejected: date-expiry bug risk). Confirm display-only is acceptable.
