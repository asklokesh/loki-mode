# Plan v1.2: validated item list and slice cards (P12 series)

This file is the full Plan v1.2 todo list and slice plan, kept in the repo so it survives session resets. Source document: /Users/lokesh/Downloads/LOKI_MODE_INTEGRATED_ENGINEERING_PLAN_v1.2.md. Section 0 is the live status list, sections A to D are the validation table, slice cards, decisions and dispatch order. docs/v10/BOARD.md stays the dispatch authority for slice rows; this file mirrors it and never overrides it. To update: when a slice moves (for example building to merged to released), move its row to the matching status table in section 0 and edit the Evidence and Remaining cells, then refresh the summary count table and the date in the section 0 heading. Add newly found work under "New todos found in audit".

Source: /Users/lokesh/Downloads/LOKI_MODE_INTEGRATED_ENGINEERING_PLAN_v1.2.md, cross-checked against
/Users/lokesh/Downloads/FACTORY_VS_LOKI_MODE_INTEGRATED_v1.1.md (already planned as FV-*, COST-*, M-*, INTEL-* rows).
Validated against main at dad1b2872, VERSION 11.14.0, 2026-10-15. Author: Architect (opus), read-only pass.
Prefix P12-NN verified unused on docs/v10/BOARD.md.

Ground rules every card inherits (not repeated per card):
- Extend, never duplicate. A new file carries a one-line justification in its card.
- Line caps (budget.test.ts, D94 point 2, never raised): engine10 core 4981/5000 (19 lines left),
  modernize 4107/4000 (over, trim slice in flight), e10ext 1475/1500, features 2901/3000, contrib 869/1200.
  util/, runner/, commands/, integrations/, metrics/, autonomy/*.sh, python and eval/ are uncapped.
  New logic lands in util/ or runner/ (pattern: util/run_outputs.ts, util/engine_origin.ts) with a one-line call
  from core. Any card touching engine10 core is line-neutral and its Wall includes
  `cd loki-ts && bun test tests/engine10/budget.test.ts`.
- Hot files no builder owns: tests/moat/cases.txt, tests/moat/pending.txt, CHANGELOG.md,
  docs/v10/{BACKLOG,BOARD,PROGRESS,METRICS,CONTROL}.md, scripts/local-ci.sh, tests/run-all-tests.sh, VERSION,
  package.json, SKILL.md, Dockerfile*, plugin.json, server.json, dashboard/__init__.py, mcp/__init__.py, CLAUDE.md.
  A slice needing a new tests/*.sh asks the Captain for runner registration and the shard row.
  loki-ts/dist is rebuilt by the Captain only.
- A bug fix needs its docs/v10/FAILURE-CLASSES.md row first (D86). Cards marked FC-REQ need the PO to add the row
  before dispatch.
- Budgets: LOW 15 min, MEDIUM 30 min. HIGH cards are 30 min build plus a 2-round HIGH review (D98).
- Every slice is a release (D96).

## 0. Live todo list (status as of 2026-10-16)

Audited against main, VERSION 11.17.1, local main a9f8b0b99 is pushed to origin, 57 commits ahead of b136ed44e (the v11.17.1 release commit), and will be cut as v11.17.2. Rows are the source epic ids from source section 9 (P0-01 to P2-01), the plan item ids from section A (S, A, B, C, D, E, Q, T, M, N, R; A-prefixed and A9-prefixed ids are plan items or plan A.9 epics that are not source epics), the P12 slice ids from section B, the P12 slice ids from section B, and the founder and CTO decisions from section C. One work item can appear under several ids, so counts below are rows, not unique slices. The per-slice P12-NN rows are the authoritative status; the other ids point at them.

### Summary count by status

| Status | Rows |
|---|---|
| Released | 69 |
| Merged, ships in v11.17.2 | 30 |
| In review or building | 6 |
| Ready | 0 |
| Blocked on founder | 24 |
| Blocked on dependency | 4 |
| Not started | 69 |
| Validation only, no work needed (n/a) | 8 |
| Total | 210 |

### Released
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| S03 | 10x metric (active human minutes) | P12-31 9e2604b95, BOARD released, CHANGELOG v11.16.0 (shipped v11.17.1) | - |
| S04 | Steer from issue and chat | P12-14 64a1113a7, P12-15 2fefb15ad, CHANGELOG v11.16.0 line 75 | - |
| S06 | Multi-repo work | D51-B13r/B14r/B16r + PO-WS-METRICS-1 merged 2026-10-03; D51-B13..B16 parked as superseded | - |
| S09 | Claude Code qualification and min version | P12-24 e6754c961, BOARD released, CHANGELOG v11.16.0 line 68 | Bundled-version bump to 2.1.300 not tracked here |
| S10 | Configured-Claude-Code baseline arm | P12-29 7c368bebd, BOARD released v11.17.1 | - |
| S11 | Chat steering/TUI drift | P12-20 bb9394cdd, CHANGELOG v11.16.0 line 79 | - |
| B03 | Single work-item id across runs | P12-08 5c03f2dab, 08b, 08c; BOARD released v11.17.1 | deploy record keying left to P12-33..36 |
| B05 | Quota wait and resume in engine10 | P12-09/09b/09c; BOARD released, CHANGELOG v11.17.1 line 16 | - |
| C05 | Reviewer findings file:line rule | P12-06 40ee4c1a9, CL v11.16.0 line 78 | - |
| C06 | Merge pinned to proven head | P12-03/03b/03c/03d, P12-04 6b5774c46; BOARD released v11.17.1 | - |
| BP5 | Plain verify compares head_sha with HEAD | P12-01 (01b) BOARD released v11.17.1 | - |
| D01 | GitHub steer provenance | P12-14 merge 64a1113a7; CHANGELOG v11.17.0 (P12-14, P12-15) | Follow-up open: bot applied rev N status-comment edit (see P12-14) |
| D02 | Chat and Slack steer | P12-15 7f8e7b51b (source=chat, actor); P12-17 a7ea408c0; BOARD P12-17 released; CHANGELOG v11.17.0 | - |
| D05 | Intervention classes drive behavior | P12-31 9e2604b95 (active human minutes); BOARD P12-31 released; v11.17.0 | Metrics side only per plan; classes driving behavior stays out of scope |
| D07 | Handoff says resume from stage X | P12-07 / 07b / 07c, BOARD P12-07 released; v11.17.0 handoff names resume commands | - |
| BP6 | Context vs control split, durable dedup, chat.update, steer ack | P12-17 a7ea408c0 (chat.update, durable dedup); P12-14 64a1113a7; P12-17b d2c39e801 | Unverified: GitHub issue steer ack comment updated in place |
| A-P1-02 | Revoked-actor tests, live allowlist (section A.5 item, not a source epic) | P12-17 a7ea408c0 live allowlist + revoked actors; Opus approve 2d333d158; v11.17.0 | - |
| E01 | Model capability catalog | P12-24 e6754c961 (min CLI version from model catalog, compat manifest); v11.17.0 | Capability fields beyond context_window and min version; replace claude_flags.ts help probing (not shown done) |
| E03 | Per-stage, retry and compute cost in receipt | P12-21 b3c21ecde, bb0a5b275; merge 44c0810f2; v11.17.0 | - |
| E05 | Policy-compiled permission mode | P12-26 c613ce4d7, 26b 054fcc8a3, 26c f3440f888, 26d 61c0ebf0f released v11.17.1; 26e 550ddd617 and 26f e02847f76 merged, ship v11.17.2; P12-26g built 2db619fc0, HIGH review; C-C2 pending | Release 26e/26f in v11.17.2; land 26g (//tmp + tmp-star deny); export PATH=x across segments needs session-state tracking; default flip blocked on C-C2 |
| E06 | Per-provider isolation matrix | P12-25 c4856f189, merge 8c256963b, guard fixes cf3dc6e7f ea4b26dec; v11.17.0/.1 | - |
| E07 | Min CLI version, compat matrix, canary | P12-24 e6754c961 doctor enforces minimum; v11.17.0 | Per-release compat suite/canary run (Q2) not evidenced |
| BP2 | Run identity: CLI version, endpoint, config digest, policy | P12-23 74e17c2ec, eb1f00ee2 (null endpoint under Bedrock/Vertex), 23b 22cc9af80; v11.17.0 | Verify config digest and policy fields present in session.started |
| E-Q | Requested vs actual model tuple in receipt | P12-23 74e17c2ec requested-vs-actual flag; 23b 22cc9af80 router-rewritten model; v11.17.0 | - |
| Q1 | Execution tuple and qualification levels | P12-24 e6754c961 + P12-23 tuple; v11.17.0 | Qualification levels beyond minimum-version check not evidenced |
| Q2 | Compat suite per CLI release | P12-24 compat manifest e6754c961; 6e1237e15 fake claude meets minimum | Automated per-CLI-release suite/canary not evidenced; may need follow-up slice |
| Q3 | No silent downgrade, requested vs actual | P12-23 74e17c2ec, 23b 22cc9af80; v11.17.0 | - |
| A9-P0-02 | A.9 plan epic (non-source id): Head-pinned merge | P12-03 b3ff4bb1d, 03b/03c/03d, P12-04 6da9172e6; v11.17.0 | - |
| A9-P1-02 | A.9 plan epic (non-source id): Revoked actors | P12-17 2d333d158, 17b; v11.17.0 | - |
| A9-P1-03 | A.9 plan epic (non-source id): Adapter qualification | P12-23 74e17c2ec, P12-24 e6754c961, P12-25 8c256963b; v11.17.0 | Compat canary per CLI release if desired |
| M1 | Active human minutes | P12-31 9e2604b95; BOARD released; v11.17.0 | - |
| M3 | Configured-CC arm | P12-29 7c368bebd, 44844d631; v11.17.0 | - |
| M10 | Guard against unmeasured Nx claims | P12-40 fe49c59b4, 40b 0445b8453; v11.17.0 | - |
| N3 | Qualify CC | P12-24 e6754c961; v11.17.0 | Full qualification levels/canary per Q1/Q2 |
| P12-03 | Merge pinned to proven head | b3ff4bb1d / 3754b7636 (v11.17.0 BOARD row, CHANGELOG 11.16.0 gh pr merge pinned); 03b/03c/03d dirty-proof fail-closed in 11.17.0/11.17.1 | Known limit only: subject-writable .git can drop paths from info/sparse-checkout (comment, no slice). |
| P12-04 | verify-pr respond compares headRefOid | 6b5774c46 / 6da9172e6; CHANGELOG v11.16.0 line 84; BOARD row released | - |
| P12-06 | Council findings cite file:line | 40ee4c1a9 / 374f2dc22 / a6f9f2f5e; CHANGELOG v11.16.0 line 78 (unanchored blocking downgraded, not rejected) | - |
| P12-08 | Work-item id and extended lifecycle states | 5c03f2dab / b3ca200e4; 08b ebd0004fe and 08c 364cbcec2 in 11.17.0; CHANGELOG 11.17.0 line 34 | B03 cross-run work_item_id keyed by issue/PR and separate blockers field delivered per 08/08c; deploy record keying not covered (see P12-36). |
| P12-09 | engine10 quota wait and resume | 753453944 / 4f7edfc13; 09b merged (37031def6, 11.17.0), 09c in 11.17.1 (c83921054) | - |
| P12-14 | GitHub steer provenance and ack comment | 64a1113a7 merge (ancestor of d2c39e801 v11.17.0); CHANGELOG 'Issue-comment and chat steers record source and actor (P12-14, P12-15)'; no BOARD row | Provenance part only. The bot 'applied rev N' status-comment edit is not done: no such text in autonomy/trigger-server.py. Revision-log-per-run key not confirmed. Needs follow-up slice. |
| P12-15 | Chat steer provenance | 7f8e7b51b feat + 2fefb15ad merge; before v11.17.0 release d2c39e801; CHANGELOG P12-14/15 line | - |
| P12-17 | Slack thread steer, chat.update, allowlist, revoked actors | BOARD P12-17 released@2026-10-16T17:19Z (2d333d158, a7ea408c0); P12-17b echo redaction 000442841 v11.17.0 | - |
| P12-20 | Remove stale steer text and legacy marks | 7dcf9e300, 9f7117d69, bb9394cdd merge; CHANGELOG 'loki steer help no longer claims LOKI_PROMPT_INJECTION' (v11.16/17) | - |
| P12-21 | Per-stage, retry and cache cost attribution | BOARD P12-21 released@2026-10-16T17:19Z (44c0810f2) | - |
| P12-23 | Run identity tuple in receipt (23, 23b) | 74e17c2ec feat, 797bfbdc4 merge, 22cc9af80 (23b) before d2c39e801; BOARD P12-23 (23b) released v11.17.1; CHANGELOG P12-23, P12-23b | - |
| P12-24 | Minimum CLI version, compat manifest, canary | BOARD P12-24 released@2026-10-16T17:19Z (e6754c961, f7b4e4fd8) | Canary probe script against new CLI release not confirmed in commits; verify whether delivered or needs a slice. |
| P12-25 | Per-provider isolation matrix | BOARD P12-25 released (8c256963b); follow-up fixes cf3dc6e7f, ea4b26dec in v11.17.1 per CHANGELOG | - |
| P12-29 | Configured-Claude-Code arm | BOARD row 68 released v11.17.1; commits 44844d631, 90dee82e8, merge 7c368bebd; CHANGELOG v11.17.0. | - |
| P12-31 | Active human minutes metric | BOARD row 52; merge 9e2604b95; CHANGELOG v11.17.0 section (v11.16.0 and v11.17.0 were never published; shipped in v11.17.1). | Confirm docs/EVALUATING.md:228 was updated (not checked). |
| P12-40 | Unmeasured Nx claim guard | BOARD row 70 released v11.17.1; commits 32c3147cb, 391530687, 0445b8453; CHANGELOG v11.17.0 line 38. | Plan card asks to fix the CHANGELOG.md:272 unmeasured claim via Release Manager; not confirmed (older CHANGELOG lines such as 'about 5x faster' still exist). |
| D2-P12-03 | Dispatch 2: Merge pinned to proven head (HIGH) | b3ff4bb1d, 03b a4ea00c9f, 03c 5fa6f4c7b, 03d 13204dd11; BOARD rows released; CHANGELOG 11.17.0 | - |
| D3-P12-04 | Dispatch 3: verify-pr respond pins headRefOid (HIGH) | 6b5774c46; BOARD P12-04 released; shipped v11.17.1 | - |
| D4-P12-06 | Dispatch 4: Council file:line rule (MEDIUM) | 40ee4c1a9; BOARD P12-06 released; shipped v11.17.1 | - |
| D6-P12-14 | Dispatch 6: GitHub steer provenance (HIGH) | 64a1113a7 (ancestor of b136ed44e); CHANGELOG 11.16.0 section line 75 'source and actor' | Ack comment part of card not evidenced in log; check card |
| D7-P12-15 | Dispatch 7: Chat steer provenance (LOW) | 2fefb15ad (ancestor of b136ed44e); CHANGELOG line 75 | - |
| D8-P12-17 | Dispatch 8: Slack thread steer, revoked actors (HIGH) | 2d333d158; 17b 000442841; BOARD P12-17 and P12-17b released | - |
| D9-P12-20 | Dispatch 9: Stale steer text (LOW) | bb9394cdd merge (ancestor of b136ed44e); no BOARD row for P12-20; CHANGELOG line 79 (loki steer help) shipped in v11.17.1 | - |
| D10-P12-23 | Dispatch 10: Run identity tuple (MEDIUM) | 797bfbdc4, 23b 22cc9af80; BOARD P12-23 released | - |
| D11-P12-24 | Dispatch 11: Min CLI version and compat manifest (MEDIUM) | f7b4e4fd8; BOARD P12-24 released | - |
| D12-P12-21 | Dispatch 12: Cost attribution (MEDIUM) | 44c0810f2; BOARD P12-21 released | - |
| D13-P12-29 | Dispatch 13: Configured-CC arm (MEDIUM) | 7c368bebd (ancestor of b136ed44e); BOARD P12-29 released | - |
| D14-P12-31 | Dispatch 14: Active human minutes (MEDIUM) | 9e2604b95; BOARD P12-31 released | - |
| DN-P12-08 | Next: Work-item id and lifecycle states (MEDIUM) | 5c03f2dab, 08b ebd0004fe, 08c 364cbcec2; BOARD P12-08 released | - |
| DN-P12-09 | Next: engine10 quota wait and resume (HIGH) | 09b 37031def6, 09c c83921054 (ancestor of b136ed44e, CHANGELOG 11.17.1) | - |
| DN-P12-25 | Next: Per-provider isolation matrix (LOW) | 8c256963b; BOARD P12-25 released | - |
| DN-P12-40 | Next: Unmeasured Nx claim guard (LOW) | fe49c59b4, 40b 0445b8453 (in 11.17.1) | - |
| DN-P12-05 | Next: Wall holdout in engine10 (HIGH) | 87637d1ee; BOARD P12-05 released; default off pending C-C4 | Default flip depends on C-C4 |
| R5 | Risk: steer provenance source=cli for GitHub/chat; merge not pinned to proven head | P12-14 64a1113a7, P12-15 2fefb15ad, P12-17 2d333d158, P12-03 b3ff4bb1d, P12-04 6b5774c46 | Verify other steer sources (Jira/Linear, P12-18) record provenance; ack-comment follow-up open (P12-14) |
| P0-01 | Source epic (section 9): Pinned Claude adapter + compatibility manifest | P12-24 e6754c961 (min CLI version, compat manifest), P12-23 tuple, P12-25 isolation matrix; released v11.17.1 | Per-release upgrade smoke suite and canary not evidenced (Q2) |

### Merged, ships in v11.17.2
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| A04 | Intent revisions invalidate Seal/Wall/verify, in receipt | P12-02 released v11.17.1 (02b, 02c); 02c-02g merged 1bc2a9165 + dist 0b121dd33 after b136ed44e; P12-07h revision dedupe released | Cut v11.17.2; nits: sweepOrphans pid-reuse age gate, orphan archive dedupe; 02h prune Set merged 9086f40ee; 02g no-hardlink limit documented |
| B04 | Progress classes and watchdog | P12-12/12c/12d released (CL 11.17.0/11.17.1); P12-12e e3ec5a357 after b136ed44e; 12f closed no-op | Release 12e in v11.17.2; nit: in-place growth of single file edge |
| C02 | Seal binds intent; verify detects drift | P12-01/01b released; 01c/01d CL 11.17.1; 01e 41193f437 merged after b136ed44e | release 01e; nit mcp/v10_tools.py:195 2000-char tail |
| A-P0-05 | Seal negative tests (section A.4 item, not a source epic) | P12-01b-d released; 01e merged, ships in v11.17.2 | confirm changed-intent and fabricated-success negatives all covered; release |
| CH | Chat gaps: /answer /pause /resume /start, help, system prompt, rev-N ack | P12-16 d7d8b104d, 16b, 16c, 16d, 16e released (v11.17.0/.1); P12-16f 5521284dc on local main after b136ed44e | Release 16f; confirm system prompt chat.sh:6 mentions steer; tighten test-doctor-ux.sh:250 grep nit |
| A9-P0-01 | A.9 plan epic (non-source id): Seal intent binding | P12-01/01b/01c/01d released v11.17.1; P12-02/02b released; 02c-02h and 01e merged locally (1bc2a9165, 9086f40ee, 41193f437), ship in v11.17.2 | Release v11.17.2; 02g no-hardlink limit |
| A9-P0-03 | A.9 plan epic (non-source id): Durable lifecycle and resume | P12-07..07n, 08, 09/09b/09c; 07n merged eb9e260d3 (ships v11.17.2); P12-10 and P12-11 have no commits or BOARD rows | Release v11.17.2; P12-10 pause/cancel states; P12-11 failure fingerprints and recovery classes |
| A9-P0-05 | A.9 plan epic (non-source id): Seal negatives | P12-01 family released; 01e merged on local main (41193f437, HIGH re-review approved) | Release 01e; schema-variant receipt reads UNSIGNED nit |
| A9-P1-01 | A.9 plan epic (non-source id): Steer provenance | P12-14 64a1113a7, 15 2fefb15ad, 16..16e released; 16f 5521284dc local | Release 16f |
| A9-P1-06 | A.9 plan epic (non-source id): Measurement program | P12-29, 30, 30b, 31 released; 30c/30d/30e merged local (82a56d307, baf30647a); P12-28 no commits | Release 30c-30e; P12-28 parity gate, per-task table with CI; paid live run needs C-F1 |
| M5 | Predeclared task families | P12-30 34baaadf7 (7 families) released v11.17.1; 30b released; 30c/30d/30e local main | Release 30c-30e; nits: measure-size.py:321 dead harness=None, test-harness.sh:1718 grep check |
| P12-01 | Seal intent and head drift in verify | Base 26d86d22c/fa13ab989 in v11.16.0/11.17.0; 01b/01c in 11.17.0; 01d in 11.17.1 (2dfdd5111); 01e merged after b136ed44e (41193f437, review approve, HIGH) | Release 01e (dist rebuilt bddd33859). Nit: mcp/v10_tools.py:195 keeps last 2000 chars, may cut no-bun message (false red only). |
| P12-02 | Steer revision invalidates Wall/Seal, lists in receipt | Base c7d945cf0 + 02b in v11.17.1; 02c..02g merged 1bc2a9165, dist 0b121dd33; 02h Set prune merged 9086f40ee, dist 7298fea79 (all after b136ed44e); 02g review BLOCK then approve | Release v11.17.2. Nits: concurrent sweeper ENOENT stranded (fail-closed); claim time in claim name; kill between link and record on no-hardlink fs is a documented known limit. |
| P12-12 | Progress classes and watchdog | 4c0ee6dbf / 39cbc9ccf (11.17.0); 12c, 12d, 12/25 in 11.17.1 (2fc044eec, 7fb04dfdc, f2092b207); 12e merged after b136ed44e (e3ec5a357); 12f closed no-op | Release 12e. Nit: watchdog stalls at 900s when output streams but diff static. |
| P12-16 | Chat command completeness (16, 16b-16f) | BOARD P12-16/16b released v11.17.1 (d7d8b104d, c0cfcb0c7); 16c/16d/16e merged (eee8bb72e, 6bf93b9dc, 2bb1d875c) in 11.17.1; 16f merged 5521284dc after b136ed44e (dist bddd33859) | 16f ships in v11.17.2. Open nits: tighten test-doctor-ux.sh:250 grep to 'clock read failed while waiting'; chat.sh _chat_now_ms lost its SECONDS fallback (use now_ms=$(_chat_now_ms) // break). Plan-card items 'help lists /status /steer /stop' and 'system prompt explains steering' not verified. |
| P12-26 | Policy-compiled permission mode (26b-26g) | 26b/26c/26d released (f3440f888, 61c0ebf0f); 26e merge 550ddd617 and 26f merge e02847f76 are after b136ed44e and ship in v11.17.2; 26g (safe-path //tmp and tmp-star deny) built 2db619fc0, in HIGH review | 26g review and merge. C-C2 default flip pending (blocked-founder). Known gaps: export PATH=x; rm across segments needs session-state tracking; 26d nit CHANGELOG notes (recursive delete of /tmp/a/../b denied, /tmp/.cache* denied); managed-settings precedence case unconfirmed. |
| P12-30 | Predeclared task families | BOARD row 69 released v11.17.1 (34baaadf7, cbb2185dc, 12b29b4a6 for 30b, all ancestors of b136ed44e). Sub-slices 30c/30d/30e merged at 82a56d307 and baf30647a, after b136ed44e. | Release 30c/30d/30e (harness deps required in CI, skip scoping, python -I). Follow-up nits: raw repo.source readers in scripts/real-repo-gate.sh:106, eval/loki10/test-harness.sh:1260, eval/loki10/measure-size.py:314 (30c/30e mostly cover); baseline the 44 other test-harness.sh FAILs seen in a worktree. |
| D1-P12-01 | Dispatch 1: Seal intent and head drift in verify (HIGH) | 01b/01c/01d released (d2c39e801, 11.17.0/11.17.1); 01e merged 41193f437 after b136ed44e; BOARD P12-01 released row | Release 01e (v11.17.2); no further slices |
| DN-P12-12 | Next: Progress classes and watchdog (MEDIUM) | 12/12c/12d released (11.17.1); 12e merged e3ec5a357 after b136ed44e; 12f closed no-op in followups | Release 12e |
| DN-P12-16 | Next: Chat command completeness (MEDIUM) | 16/16b/16c-16e released; 16f merged 5521284dc after b136ed44e | Release 16f |
| DN-P12-30 | Next: Predeclared task families (LOW) | 30/30b released; 30c/30d/30e merged 82a56d307 after b136ed44e | Release; followup nit: measure-size.py dead harness=None, test-harness.sh -I check is grep |
| B08 | Snapshot and reconcile | P12-07 parent: 07b-07m merged and P12-07n merged eb9e260d3 (dist a9f8b0b99); 07i-07n ship in v11.17.2 | Release v11.17.2; kill-replay test of re-entry; nits listed under P12-07 |
| BP1 | Durable lifecycle states and kill-replay test | P12-08 released; P12-07 resume 07i-07n merged (resumeMachineOpts calls seedResumeCtx, run_outputs.ts:228), ships in v11.17.2 | Release v11.17.2; kill-replay test through re-entry |
| P12-07 | Per-stage persistence and resume-from-stage | 07..07g released (014679a86, c3d7bb80f, f5c54cbb7), 07h in v11.17.1 (30b632766); 07i/07j/07l/07m merged 0804a5da1, 07k merged 5e386f4a4; 07n merged eb9e260d3 (fix 6753f5174 bounds the alive heartbeat read, dist a9f8b0b99). 07i-07n ship in v11.17.2 | Release v11.17.2. Nits: implDone<0 wasteful implement rerun (run_outputs.ts:234); already_done.test.ts:443 emit test passes on old code; worker stage.started can reopen already_satisfied window; run_cap.ts hardening untested; supervisor.ts:323-324 duplicate assignment. |
| D5-P12-07 | Dispatch 5: Per-stage persistence and resume (HIGH) | 07b-07j released (BOARD P12-07 released, CHANGELOG 11.17.1 07h); 07i/07j/07l/07m merged 0804a5da1, 07k merged 5e386f4a4, 07n merged eb9e260d3 (all after b136ed44e) | Release v11.17.2 (07i-07n); seedResumeCtx is called from resumeMachineOpts (07i) |
| DN-P12-02 | Next: Steer revision invalidates Wall/Seal (HIGH) | 02/02b released; 02c-02g steer hardening merged 1bc2a9165 + dist 0b121dd33; 02h steer prune Set merged 9086f40ee (fix af48a84cf, dist 7298fea79); all after b136ed44e | Release v11.17.2 (02c-02h) |
| R3 | Risk: engine10 cannot resume mid-run; P12-13 depends on P12-07 | P12-07 resume merged: 07i re-enter machine 17073e66f through 07n eb9e260d3 (ships v11.17.2); P12-13 no commits, no BOARD row | Cut v11.17.2, then dispatch P12-13 (deps P12-02, 07, 09, 14 all merged or released) |
| P0-02 | Source epic (section 9): Durable work/intent/action ledger | P12-08 work-item id and lifecycle released v11.17.1; P12-07..07n resume merged (07n eb9e260d3); P12-02/02h intent revisions merged; P12-36 outbox no commits | Release v11.17.2; kill-at-each-transition replay test (BP1); P12-36 idempotency keys |
| P0-05 | Source epic (section 9): Evidence-backed completion service | P12-01/01b/01c/01d released; 01e 41193f437 merged (ships v11.17.2); P12-03/04 head-pinned merge released | Release 01e; confirm changed-intent and fabricated-success negatives; schema-variant receipt nit |
| P0-06 | Source epic (section 9): Recovery & loop supervisor | P12-09/09b/09c quota wait and resume released; P12-12/12c/12d released, 12e e3ec5a357 merged; 07n eb9e260d3 merged (ships v11.17.2); P12-10 and P12-11 no commits, no BOARD rows | Release v11.17.2; P12-10 cancellation; P12-11 flaky and protocol-error classes; no-progress watchdog nits |

### In review or building
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| B02 | Decomposition wired / modernize units | BOARD M-26..M-29 still ready; M-26 ea6d2eef8 approved on branch m-26 not on main; M-26b approved 9f0c613de on branch m-26b, nit commit pending; architect cutting M-27 prerequisite cards (oracle capture, unit merge ops, ablation stub runner, wave verify commands) | Merge M-26b after v11.17.2 is cut, then M-27, M-28, M-29; wire features/decompose.ts |
| DN-P12-26 | Next: Policy-compiled permission mode (HIGH) | 26b-26d released (v11.17.1); 26e merged 550ddd617, 26f merged e02847f76 after b136ed44e (ship v11.17.2); P12-26g (safe-path //tmp, tmp-star deny, A-Z class) built 2db619fc0, HIGH review in flight | Land 26g after review; session-state tracking for export PATH=x across segments; default flip waits on C-C2 |
| R1 | Risk: line caps (core 4981/5000, modernize over, etc.) | BOARD P12-CAP released; budget.test.ts caps 5000/4000/1500/3000/1200; P12-08b/09b reported core delta 0; M-MOD merged a3964e29f | Re-run budget.test.ts to confirm current counts; modernize trim merge status not evidenced |
| P12-26g | Safe-path //tmp and tmp-star deny, A-Z class in validate-bash.sh | Built 2db619fc0 on e02847f76 base, HIGH review in flight | Review (D98 two rounds), merge, dist rebuild, release |
| M-26b | Modernize nested unit ids and oracle-declared text boundaries | Approved 9f0c613de on branch m-26b; nit commit pending | Apply nit, merge after v11.17.2 is cut |
| P0-03 | Source epic (section 9): Effective policy & authority compiler | P12-26 26b-26d released v11.17.1; 26e/26f merged (ship v11.17.2); P12-26g built 2db619fc0, HIGH review | Land 26g; C-C2 default flip; denial consistency across connectors and resumed workers not evidenced |

### Ready

None at this audit. No P12-NN slice is in ready state on docs/v10/BOARD.md (P12 rows exist only as released); the ready BOARD rows (M-26 to M-29 and older EV rows) are not P12 slices.

### Blocked on founder
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| S07 | North star hosted Company OS | C-F5 founder scope call | Founder decision C-F5 |
| S08 | Stale version references (v11.4.2) | C-F8; plan says VERSION 11.14.0, now 11.17.1 | Founder-owned doc refresh; update plan version refs |
| S14 | Cost at or under half of raw CC | P12-28 not started; COST-6 parked@2026-10-16 paid eval; C-F1 spend go | C-F1 spend approval, COST-6 run, P12-28 valid B9 row and parity gate |
| C01 | Wall authored in isolation with holdout | P12-05 87637d1ee released v11.17.1, default off pending C-C4 | Founder decision C-C4 holdout ratio / default on |
| M4 | n>=3 per cell | COST-6 parked@2026-10-16T00:12Z; C-F1 paid spend | Founder approves spend; run COST-6 attribution --execute n=3 |
| M8 | Ablation producer | BOARD S-112 parked@2026-09-27T20:00Z; autonomy/lib/ablation.py absent; C-F1 | Unpark after C-F1; implement ablation.py |
| M11 | Measured cost figures | COST-2/COST-3 parked@2026-10-16T00:12Z; C-C3 CTO pending; COST-6 parked | C-C3 decision then COST-2/3 measurement runs |
| M12 | Version in docs | C-F8 pending (doc v11.4.2 stale) | Founder updates source doc version and deploy claim |
| N7 | Comparative pilot | C-F7 paid external pilot, no work | Founder decision on C-F7 |
| P12-05 | Wall holdout in engine10 | 87637d1ee, 76e0ba56e, 72a5a124c in v11.17.0 (BOARD: Wall holdout, off by default); default off pending C-C4 | Founder decision C-C4 (holdout ratio, block vs warn); then flip default on. No C-C4 row in FOUNDER-QUEUE.md. |
| P12-32 | Router objective: expected accepted-outcome cost | No BOARD row or commits. Plan card dep C-C3 (COST-2/3 moat overlap), listed in PLAN-V12 section C as a pending CTO decision. | Needs C-C3 decision, then scoring module in loki-ts/src/runner/router with history fixture test, keeping never_below_raw green. |
| C-F1 | Paid evaluation spend (COST-6, B9 n>=3 live run, unpark S-112) | PLAN-V12 sec C; no entry in FOUNDER-QUEUE.md; BOARD COST-6 row present; P12-28 has no commits | Founder approves spend; then P12-28 live B9 run and COST-6 n=3 run |
| C-F5 | Hosted Company OS in/out of scope | PLAN-V12 sec C; not in FOUNDER-QUEUE.md | Founder scope decision |
| C-F6 | Enterprise commitments (SCIM, HA, support owner) | PLAN-V12 sec C; P12-48 has no commits or BOARD row; not in FOUNDER-QUEUE.md | Founder decision; P12-48 (retention/backup only) independent |
| C-F7 | Comparative pilot with human-minutes capture vs Factory/Devin/Cursor | PLAN-V12 sec C; not in FOUNDER-QUEUE.md; P12-31 (metric) released via 9e2604b95 | Founder approves paid external pilot |
| C-F8 | Fix source doc stale version refs (v11.4.2 to 11.14.0) and deploy print-only claim | PLAN-V12 sec C; source doc is /Users/lokesh/Downloads/LOKI_MODE_INTEGRATED_ENGINEERING_PLAN_v1.2.md; no commit evidence | Founder edits or authorizes edit of the source doc |
| C-C1 | Gateway lane policy: non-Anthropic routes behind claude CLI and label wording | PLAN-V12 sec C; P12-27 depends on it; P12-27 no commits, no BOARD row; FOUNDER-QUEUE.md has no entry | CTO/founder decides wording; then P12-27 (also needs P12-26 merged, now true) |
| C-C2 | Flip default from skip-permissions flag to compiled permission mode | PLAN-V12 sec C and risk 4; CHANGELOG 11.17.0 compiled policy behind LOKI_PERMISSION_POLICY, default unchanged | Founder/CTO approval, then flag-flip slice (default compiled, update E05, providers/claude.sh and runner/providers.ts) |
| C-C3 | COST-2/COST-3 moat changes and overlap with router objective | PLAN-V12 sec C; P12-32 has no commits and no BOARD row | CTO decision; then P12-32 |
| C-C4 | Wall holdout ratio and block-vs-warn on holdout failures | loki-ts/src/util/holdout.ts:10 default ratio 0 'founder decision C-C4 pending'; P12-05 merged 87637d1ee, released 11.17.0 | Decide default ratio (e.g. 0.2) and block/warn; then flip default in holdout.ts |
| R2 | Risk: COST-HALF unproven, no valid B9 row | BOARD COST-4/COST-6 notes best 0.68x; P12-28 not started; needs C-F1 | Founder spend then P12-28 and COST-6 run |
| R4 | Risk: main calls use the skip-permissions flag, no policy compiler | Compiled policy exists behind LOKI_PERMISSION_POLICY (CHANGELOG 11.17.0); default unchanged; needs C-C2 | C-C2 decision then flip slice |
| P1-04 | Source epic (section 9): Enterprise pilot hardening | P12-48 retention/backup no commits; SCIM/HA/support wait on C-F6; P12-42 tenant scope no commits | C-F6 founder decision; P12-48 buildable independently |
| P2-01 | Source epic (section 9): Production operations & optimization | P12-28 no commits; paid runs wait on C-F1; P12-32 waits on C-C3; P12-30 families released | C-F1 spend approval, C-C3 decision; routing ablations (M8) parked |

### Blocked on dependency
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| P12-27 | OTel passthrough and gateway lane labels | No BOARD row, no commits; no OTEL/unqualified text in providers/loader.sh or model_routes.sh; plan deps P12-26 (26e/26f merged, 26g in HIGH review) and C-C1 wording (founder, pending) | OTel env passthrough in providers/loader.sh, 'unqualified alternative' labels in model_routes.sh printed by doctor, tests; serialize after P12-26. Passthrough part buildable now; label wording needs C-C1. |
| P12-34 | Observation window | No BOARD row or commits. Serialized after P12-33, which is not started. | Replace single probe with N probes over a window with error-rate threshold, recorded in receipt; builder confirms owner module; flapping fixture test. |
| P12-35 | Release manifest | No BOARD row or commits. Card dep P12-36 for digest. Only prior composite_seal commit is 54ba78a23 (FV-evidence-sha-2). | Manifest in util/composite_seal.ts binding repo heads, artifact digests and deploy destination; digest mismatch refused test. |
| P1-03 | Source epic (section 9): Model qualification & route catalog | P12-23/24/25 released v11.17.1; P12-27 no commits, waits on C-C1; P12-32 waits on C-C3 | Published per-tuple suite; P12-27 labels after C-C1 |

### Not started
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| S02 | Inherit native CC strengths (no PreCompact) | P12-38: no BOARD row, no commits, no CHANGELOG hit | P12-38 PreCompact hook in .claude/settings.json + milestone flush |
| S12 | Two lanes (Claude, non-Claude) labelled | P12-27 no BOARD row or commits; C-C1 founder queue | P12-27 gateway lane labels + OTel passthrough; C-C1 decision |
| S13 | Reproduce U1-U8 journeys | P12-13 no BOARD row, no commits | P12-13 fixture set (depends on P12-07 re-entry wiring) |
| A01 | Repo readiness doctor with provider round-trip | P12-41 no row/commits | harmless provider round-trip task in doctor --repo |
| A02 | Readiness history persisted | P12-41 no row/commits | history in repo profile |
| A03 | Typed constraints and trace in contract | P12-43 no row/commits | typed constraints in features/contract.ts |
| A05 | Design decision records | P12-37 no row/commits | decision records beyond LLM dispatch log |
| A06 | Lessons with provenance | Validation DONE; minor P12-42 no row/commits | relevant_files.ts reason field (minor) |
| A07 | Skill-derived checks | P12-44 no row/commits | producer in runner/quality_gates.ts |
| A08 | Resume on spec revision reruns affected units | P12-45 no row/commits | spec-revision-aware unit resume in run_group.ts |
| B01 | Sizing tiers beyond small/normal | P12-46 no row/commits | large tier in engine10/sizing.ts |
| B06 | Failure fingerprints across runs | P12-11 no row/commits | persist fingerprints across runs |
| B07 | Pause and cancel states | P12-10 no row/commits (states exist in lifecycle via P12-08) | pause/cancel commands and engine10 handling |
| BP4 | Recovery classes incl. flaky/protocol error | P12-11 no row/commits | supervisor.ts flaky class, protocol error class |
| C03 | Visual evidence as gate | P12-47 no row; features/visual_evidence.ts opt-in only (f861602b5 older) | optional gate mode |
| C07 | Release manifest binding heads and deploy | P12-35 no row; deps on P12-36 | manifest + digest, after P12-36 |
| C08 | Deploy staging, canary, observation | P12-33, P12-34 no rows/commits | staging profile/destination enum, observation window |
| BP7 | Destination enum, artifact digest, DB rollback | P12-33, P12-36 no rows/commits | destination enum, digest, DB rollback |
| D03 | Jira/Linear inbound comment steer and transitions | No P12-18 commits, no BOARD row | P12-18: inbound Jira/Linear comment steer plus lifecycle transitions beyond done |
| D04 | Status freshness (last event N ago) | No P12-19 commits, no BOARD row | P12-19: 'last event N ago' in run_status.ts and status comments |
| D06 | Control Plane deep link per run | No P12-19 commits | P12-19: deep link in liveline.ts and run_outputs issueStatusBody |
| D08 | Memory tenant scope, TTL, outcome feedback | No P12-42 commits, no BOARD row | P12-42: tenant scope, TTL, outcome feedback in memory/schemas.py and storage.py |
| E02 | Router objective = expected accepted-outcome cost | No P12-32 commits or BOARD row; COST-2/COST-3 parked@2026-10-16T00:12Z | P12-32 after C-C3 CTO decision on COST-2/3 |
| E04 | Pre-call budget reservation, shared ledger | No P12-22 commits or BOARD row | P12-22: reservation before call, shared ledger in budget_cap.ts |
| E08 | Enterprise SCIM, retention, HA, backup, support | No P12-48 commits; C-F6 founder commitments pending | P12-48 retention and backup; SCIM/HA/support blocked on C-F6 |
| BP3 | PreCompact hook, milestone flush | No P12-38 commits or BOARD row | P12-38: PreCompact hook in .claude/settings.json and milestone flush |
| BP8 | Outbox and idempotency keys | No P12-36 commits or BOARD row | P12-36: outbox and idempotency keys beyond stages/pr.ts existing-PR tolerance |
| E-L | Gateway lane labelled, feature-loss list | No P12-27 commits; C-C1 gateway lane policy pending | P12-27 labels and feature-loss list after C-C1 |
| E-O | OTel passthrough | No P12-27 commits; no CLAUDE_CODE_ENABLE_TELEMETRY passthrough found | P12-27: passthrough of CLAUDE_CODE_ENABLE_TELEMETRY and OTel env |
| Q4 | Routing objective | No P12-32 commits or BOARD row | P12-32 (see E02) |
| T1 | Deploy is print-only claim (WRONG partly) | No P12-33 commits or BOARD row | P12-33 staging deploy; C-F8 source doc correction |
| T2 | Knowledge graph, decision records | No P12-37 commits or BOARD row | P12-37 decision records |
| T3 | Progressive profiles | No P12-41 commits or BOARD row | P12-41 progressive profiles |
| A9-P0-04 | A.9 plan epic (non-source id): Vertical slice | No P12-13 commits or BOARD row | P12-13 issue to PR with kill, resume, comment fixture |
| A9-P1-04 | A.9 plan epic (non-source id): Cost attribution and reservation | P12-21 released (b3c21ecde) but P12-22 has no commits or BOARD row | P12-22 pre-call budget reservation and shared ledger |
| A9-P1-05 | A.9 plan epic (non-source id): Delivery destinations | No P12-33..P12-36 commits or BOARD rows | P12-33, 34, 35, 36 |
| A9-P2-01 | A.9 plan epic (non-source id): Knowledge and enterprise | No commits for P12-37..P12-48 | P12-37..P12-48 (12 slices) |
| M7 | Published per-task table with CI | No P12-28 commits or BOARD row | P12-28 per-task table with CI; B9 row superseded |
| M9 | Small-edit parity gate | No P12-28 commits | P12-28 parity gate |
| M13 | Fixtures: compaction resume, truncated transcript, stale remote status | No P12-39 commits or BOARD row | P12-39 three fixtures |
| R11 | Overhead risk of added gates | Covered by P12-28 parity gate, no commits | P12-28 |
| N4 | Reproduce U1-U8 | No P12-13 commits | P12-13 |
| N5 | Non-Claude routes | No P12-27 commits; C-C1 pending | P12-27 after C-C1 |
| N6 | Vertical slice | No P12-13 commits | P12-13 |
| P12-10 | Pause and cancel | No BOARD row, no git log hits for P12-10, loki-ts/src/util/run_control.ts does not exist; dep P12-08 released | Create util/run_control.ts, wire loki pause/resume/cancel in commands/run_status.ts, engine reads requests at stage boundaries, record cancel_requested then cancel_effective, run_control.test.ts. Unblocked, but has no BOARD row so it is not Ready until a card is cut. |
| P12-11 | Recovery classes: flaky, protocol error, conflicting requirements | No BOARD row, no git log hits for P12-11; dep P12-09 released so unblocked | Add three classes to runner/recovery_policy.ts, supervisor.ts:207 flaky from rerun evidence, persist .loki/state/fingerprints.jsonl across runs, classifier table test, FC-REQ row. |
| P12-18 | Jira and Linear inbound comment steer and transitions | No BOARD row, no commits; loki-ts/src/integrations has only before_after.ts and writeback.ts (no inbound.ts) | Build integrations/inbound.ts, transition hooks on start/blocked/done in writeback.ts, inbound.test.ts fixtures. Dep P12-14 is merged so unblocked. Related old backlog FV-tracker-writeback-1..3 exists in BOARD but is not P12-tagged. |
| P12-19 | Status freshness label and Control Plane deep link | No BOARD row, no commits; run_status.ts has no 'last event' label | Add 'last event Ns ago (seq N)' to loki status, deep link in issueStatusBody/liveline. Dep P12-08 is released (5c03f2dab), so unblocked. |
| P12-22 | Pre-call budget reservation and shared ledger | No BOARD row, no commits; loki-ts/src/runner/budget_ledger.ts does not exist | Full slice: budget_ledger.ts with lock, one-line delegation from e10ext/budget_cap.ts, parallel-unit test. Dep P12-21 now met. |
| P12-28 | Valid B9 scoreboard row and small-edit parity gate | No BOARD row, no P12-28 commits. Only old b9-scoreboard commits (d14b18a63 B9-RAW-ARM, 2970dc584 R1-17). | Build scripts/b9-scoreboard.sh n>=3 row with CI column and per-task table, plus small-edit parity gate (M7, M9, S14), on recorded fixtures. Paid live run waits for C-F1. |
| P12-33 | Destination enum and staging profile | No BOARD row or commits. Dep P12-03 is released (b3ff4bb1d), so unblocked. | Add destination preview/staging/production in the autonomy/loki deploy block (~:10335); staging-before-production refusal test in tests/test-deploy-receipt-gate.sh. |
| P12-36 | Outbox and idempotency keys for PR, comments, deploy | No BOARD row, no commits, no loki-ts/src/util/outbox.ts. Dep P12-07 is released, so unblocked. | New util/outbox.ts, swap the pr.ts:123 call line-neutral, outbox.test.ts kill-between-post-and-record replay; budget.test.ts green. |
| P12-37 | Design decision records | No BOARD row or P12-37 commits; decision_record.py has no design record type in git history. | Add design record type (rationale, alternatives, source, scope) to autonomy/lib/decision_record.py, written by plan stage; schema round-trip test. |
| P12-38 | PreCompact hook and milestone flush | No BOARD row or commits; grep PreCompact in autonomy/hooks and .claude/settings.json finds nothing. | Register PreCompact in the shipped hook config template, add flush script, extend hook test. |
| P12-39 | Fixtures: compaction resume, truncated transcript, stale remote status | No BOARD row or commits. | Three fixtures under loki-ts/tests/engine10/fixtures and extend loki-ts/tests/runner/sdk_stream_parser.test.ts; parser must degrade on truncated transcript. |
| P12-41 | Readiness history and harmless round-trip | No BOARD row or commits; no readiness.jsonl in git log. Dep P12-24 released (e6754c961). | doctor --repo harmless provider round-trip appending to .loki/state/readiness.jsonl (doctor.ts :1768-1777, repo_profile.ts); two-run append test. |
| P12-42 | Memory TTL, tenant scope, outcome feedback | No BOARD row or commits; tenant commits in log are unrelated (dashboard/Teams). | Add tenant, ttl, outcome fields to memory/schemas.py and storage.py; expired item not retrieved; outcome rank; relevant_files.ts pick reason. |
| P12-43 | Typed constraints in contract | No BOARD row or commits. | Typed constraints (perf, api, security) in loki-ts/src/features/contract.ts traced to Wall case ids; diff under 60 lines for features cap; budget.test.ts. |
| P12-44 | Skill-derived checks | No BOARD row or commits. | Repo-skill-declared checks run as quality gates in runner/quality_gates.ts; fixture skill failing a run. |
| P12-45 | Spec-revision-aware unit resume | No BOARD row or commits. Dep P12-02 released. | Rerun only units whose contract slice changed in features/speed/run_group.ts; unaffected-unit-skipped test; budget.test.ts. |
| P12-46 | Sizing tier large | No BOARD row or commits. sizing.ts only mentions large in a comment (line 47). EV-12* BOARD rows are parked eval-task rows, not sizing routing, so the card is not subsumed. | Add large tier routing to decompose in engine10/sizing.ts (line-neutral) with test; confirm no EV-12 overlap, else drop. |
| P12-47 | Visual evidence as optional gate | No BOARD row or commits; no LOKI_VISUAL_GATE in git log. | LOKI_VISUAL_GATE=1 turns visual evidence failures into verify failure in features/visual_evidence.ts; diff fixture test. |
| P12-48 | Enterprise retention and backup | No BOARD row or commits. SCIM/HA wait on C-F6 (pending). | Audit log retention policy in dashboard/audit.py and a backup/restore command for dashboard state; prune and round-trip tests. SCIM/HA stay out of scope until C-F6. |
| VS | Vertical slice issue to PR with kill/resume/comment | P12-13 no BOARD row; deps met (P12-07 through 07n merged, P12-14 released) | P12-13 e2e once v11.17.2 is cut |
| P12-13 | Vertical slice e2e plus U1-U8 journeys | No BOARD row, no git log hits for P12-13. Deps all met: P12-02, 07 (07n merged), 09 and 14 (released v11.17.1); seedResumeCtx is wired via resumeMachineOpts (run_outputs.ts:228). | Extend tests/engine10/issue_ref_e2e.test.ts and fixtures/issue-ref/bin/gh: kill -9 mid-implement, resume, comment steer, PR updated, receipt revision; then U1-U8 fixtures. Needs a BOARD row and card. |
| P0-04 | Source epic (section 9): Budget reservations + cost attribution | P12-21 cost attribution released (b3c21ecde, 44c0810f2); P12-22 no commits, no BOARD row | P12-22 reservation before call and shared ledger |
| P0-07 | Source epic (section 9): GitHub issue-to-PR work-item UI | P12-14 steer provenance released v11.17.1; P12-08 work-item id released; status-comment projection not built (no applied rev N text in autonomy/trigger-server.py); P12-19 and P12-13 no commits | Ack-comment follow-up (P12-14), P12-19 status freshness and deep link, P12-13 e2e; no BOARD rows |
| P1-01 | Source epic (section 9): CI/review/staging delivery loop | P12-03/04 exact-head merge released v11.17.1; P12-33..36 no commits or BOARD rows | P12-33 staging, P12-34 observation, P12-35 manifest, P12-36 outbox |
| P1-02 | Source epic (section 9): Unified Slack/Jira/Linear adapters | P12-15 and P12-17 chat and Slack released v11.17.1 (revoked actors covered); P12-18 Jira/Linear inbound no commits or BOARD row | P12-18; outage recovery not evidenced |

### Validation only, no work needed (n/a)
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| ID | Item | Evidence | Remaining |
|---|---|---|---|
| S01 | Claude Code stays primary engine | Validation DONE in plan A.1 (runner/providers.ts:331) | - |
| S05 | Receipts as proof of done | Validation DONE (seal.ts, composite_seal.ts); hardening tracked under C02/P0-05 | - |
| C04 | Base subtraction | Validation DONE (verify.ts:155,276) | - |
| T4 | Proof of done | Validation-only, DONE (seal + receipt) | - |
| M2 | Arms in harness | DONE, eval/loki10/harness.py:51 | - |
| M6 | Losses reported | DONE scorecard | - |
| N1 | Pin snapshot | Validation-only DONE | - |
| N2 | Audit | Validation-only DONE (PLAN-V12.md) | - |

### New todos found in audit

- P12-07: kill-replay test of re-entry (BP1); seedResumeCtx is called by resumeMachineOpts (run_outputs.ts:228), so P12-13 is unblocked.
- P12-07n: merged eb9e260d3, dist a9f8b0b99, ships in v11.17.2 (RangeError fixed by 6753f5174).
- P12-07 nits: run_outputs.ts:234 implDone<0 reruns implement wastefully; already_done.test.ts:443 emit test passes on old code; worker stage.started can reopen the already_satisfied window; run_cap.ts Infinity hardening untested; duplicate assignment at supervisor.ts:323-324; D61-04 already_satisfied lost on intake restore needs a FAILURE-CLASSES row.
- P12-07k: CHANGELOG must list the flags that now exit 64 on the bash route; completions comment rule nit.
- P12-02: sweepOrphans pid-reuse age gate; dedupe orphan archive by bytes; put claim time in the claim name (closes the claim-rename to lutimes window); avoid spurious "stranded" on concurrent sweepers.
- P12-02g: no-hardlink filesystem known limit (kill between link and record) needs a follow-up decision. P12-02h (prune Set) is merged 9086f40ee, ships in v11.17.2.
- P12-01c/01e: mcp/v10_tools.py:195 keeps only the last 2000 chars and can cut the no-bun message (widen, or match on a structured field); unknown or missing receipt schema reads UNSIGNED, and test-mcp-tasks-verify-readonly.sh turns non-VERIFIED into SKIP exit 0 (possible false-green).
- P12-12: in-place growth of a single file is invisible to the watchdog after loopTicks>=3; watchdog stalls at 900s when output streams but the diff is static.
- P12-03d: known limit, a subject-writable .git can drop sparse-checkout paths; no mitigation slice.
- P12-14 follow-up: trigger-server bot must edit its GitHub status comment with "applied rev N" and key the revision log per run (only source and actor provenance shipped); BP6 steer ack updated in place is unverified.
- P12-16: tighten test-doctor-ux.sh:250 grep to "clock read failed while waiting"; restore the SECONDS fallback in chat.sh _chat_now_ms; verify /help lists /status /steer /stop and the chat.sh system prompt explains steering.
- P12-24: confirm or build the compat canary probe script that runs a harmless task against a new Claude CLI release (Q2/E07 have no slice beyond the manifest).
- E01: model capability catalog beyond context_window and min version, and removal of claude_flags.ts help probing, has no slice.
- BP2: verify config digest and policy fields appear in session.started; add a slice if missing.
- P12-26g (built 2db619fc0, HIGH review): safe-path //tmp double-slash and tmp-star deny, plus the A-Z class in validate-bash.sh:366 and _ASSIGN_ONLY.
- P12-26: "export PATH=x; rm" across segments needs session-state tracking (no slice); CHANGELOG should note that recursive delete of /tmp/a/../b and /tmp/.cache* are now denied (26d nits).
- P12-30c/d/e: nits at measure-size.py:321 (dead harness=None, except label covers resolve_source error) and test-harness.sh:1718 (-I check is a grep); raw repo.source readers at scripts/real-repo-gate.sh:106, eval/loki10/test-harness.sh:1260, eval/loki10/measure-size.py:314 need resolve_source confirmation; make-bundle.sh:7 comment is stale; baseline the 44 other eval/loki10/test-harness.sh FAILs seen in a worktree (env vs real).
- P12-40: verify the CHANGELOG.md:272 unmeasured claim was fixed (plan card asks the Release Manager) and that the scripts/global-guards.tsv row exists.
- P12-31: confirm the docs/EVALUATING.md:228 active-minutes update landed.
- M-26: BOARD row still ready though M-26 is approved on branch m-26; update after M-26b merges.
- S08: refresh version references in this file and the source plan (VERSION 11.17.1) once C-F8 is decided.
- BOARD: add rows for P12-10, 11, 13, 14, 15, 20, 27, 28, 32-39, 41-48 (none exist). Product Owner writes slice cards. Unblocked now: P12-10, 11, 18, 19, 22, 33, 36, 37, 38, 39, 41-48 (P12-33 and P12-36 are unblocked, P12-34 follows 33, P12-35 follows 36).
- FOUNDER-QUEUE.md: add C-C1..C-C4 and C-F1, C-F5, C-F6, C-F7, C-F8 as rows (none are recorded there), in particular C-C2 (permission default flip) and C-C4 (Wall holdout ratio).
- P12-13: vertical slice e2e has no BOARD row; deps P12-02, 07, 09, 14 are all merged or released and seedResumeCtx is wired; U1-U8 fixtures as separate sub-slices.
- P12-28: needs recorded B9 fixtures for the CI-column scorecard before the paid run (C-F1).
- P12-34/35 order: 33 then 34; 36 then 35; the deploy block in autonomy/loki is shared with released P12-03, so serialize merges.
- P12-27: OTel passthrough is buildable now; label wording waits on C-C1. P12-32 waits on C-C3.
- Release step: cut v11.17.2 from local main a9f8b0b99 (pushed to origin, 57 commits after b136ed44e) for merged P12-01e, 02c-02h, 07i-07n, 12e, 16f, 26e, 26f, 30c-30e, M-MOD. M-26b merges after v11.17.2.
- Confirm current budget.test.ts line counts after post-release merges (core cap risk R1).

Known open items carried from earlier sessions:

- M-27 Legacy-Bench pilot needs oracle capture, unit merge ops, an ablation stub runner, and wave verify commands; an architect is cutting those prerequisite cards.
- Cost vs Claude Code is not yet proven (best 0.68x lean, default 1.67x); paid eval runs are needed.
- MCP registry is stale at 10.9.1; needs a credentialed publish.
- v11.16.0 and v11.17.0 were never published (content shipped in 11.17.1).
- Founder decisions C-C2 and C-C4 are pending.
- Clean up merged-slice worktrees.

## A. Validation table

Status key: DONE, PARTIAL, MISSING, WRONG (doc claim wrong or stale), N/A (not applicable or founder-owned).
Evidence is file:line on main. "Slice" names the P12 card or the existing BOARD row that owns the work.

### A.1 Sections 1-4 (positioning claims)

| # | Item | Status | Evidence | Slice |
|---|---|---|---|---|
| S01 | Claude Code stays the primary engine | DONE | runner/providers.ts:331 SDK_BUNDLED_CLAUDE_CODE, providers/claude.sh:31 | none |
| S02 | Inherit native CC strengths (hooks, skills, CLAUDE.md) | PARTIAL | .claude/settings.json has SessionStart/PreToolUse/PostToolUse/Stop, no PreCompact | P12-38 |
| S03 | 10x metric (human active minutes) | MISSING | docs/EVALUATING.md:228 says not measured; metrics/trust.ts:494 has waited_s only | P12-31 |
| S04 | Steer from issue and chat | PARTIAL | trigger-server.py:711 and chat set no LOKI_STEER_SOURCE | P12-14, P12-15 |
| S05 | Receipts as proof of done | DONE | engine10/stages/seal.ts, util/composite_seal.ts | none |
| S06 | Multi-repo work | PARTIAL | covered by D51-B13..B16 (ready) | existing rows |
| S07 | North star: hosted Company OS | N/A | founder scope call | C-F5 |
| S08 | Version references in the doc (v11.4.2) | WRONG | VERSION is 11.14.0; doc is stale | C-F8 |
| S09 | Claude Code 2.1.300 qualification | PARTIAL | bundled 2.1.293 (runner/providers.ts:331), no min version, no compat manifest | P12-24 |
| S10 | Configured-Claude-Code baseline arm | MISSING | eval/loki10/harness.py:595-597 strips CLAUDE.md and hooks | P12-29 |
| S11 | Chat steering and TUI | DONE with drift | chat.sh --tui runs `exec claude`; autonomy/loki:1800 stale LOKI_PROMPT_INJECTION text; cli/registry.ts:280 marks steer legacy | P12-20 |
| S12 | Two lanes (Claude, non-Claude) | PARTIAL | providers/model_routes.sh:4-24,130-138 routes claude CLI via ANTHROPIC_BASE_URL, unlabelled | P12-27, C-C1 |
| S13 | Reproduce U1-U8 user journeys | MISSING | no fixture set | P12-13 |
| S14 | Cost at or under half of raw CC with proof | PARTIAL | best 0.68x lean, default small 1.67x, no valid B9 row (scripts/b9-scoreboard.sh, METRICS:609 SUPERSEDED) | P12-28, COST-6, C-F1 |

### A.2 Category A (intent, profile, knowledge)

| # | Item | Status | Evidence | Slice |
|---|---|---|---|---|
| A01 | Repo readiness doctor with harmless provider round-trip | PARTIAL | commands/doctor.ts:1768-1777 `--repo`, repo_profile.ts; no round-trip task | P12-41 |
| A02 | Readiness history persisted | PARTIAL | profile has schema_version, no history | P12-41 |
| A03 | Typed constraints and trace in contract | PARTIAL | features/contract.ts acceptance criteria only, keyword trace | P12-43 |
| A04 | Intent revisions invalidate Seal/Wall/verify and appear in receipt | PARTIAL | autonomy/loki:5080-5124, util/steer.ts writes .loki/intent-revisions.jsonl; no consumer in seal/wall/verify | P12-02 |
| A05 | Design decision records | PARTIAL | autonomy/lib/decision_record.py logs LLM dispatch only | P12-37 |
| A06 | Lessons with provenance | DONE | util/pr_lessons.ts retrieveLessons; minor: relevant_files.ts lacks reason | P12-42 (minor) |
| A07 | Skill-derived checks | MISSING | no producer; owner runner/quality_gates.ts | P12-44 |
| A08 | Resume on spec revision reruns only affected units | PARTIAL | features/speed/run_group.ts resumes VERIFIED units on same spec sha only | P12-45 |

### A.3 Category B (work item lifecycle and continuity)

| # | Item | Status | Evidence | Slice |
|---|---|---|---|---|
| B01 | Sizing tiers beyond small/normal | PARTIAL | engine10/sizing.ts two tiers | P12-46 |
| B02 | Decomposition wired | PARTIAL | features/decompose.ts unwired; modernize per-unit worktrees | M-26..29 (existing) |
| B03 | Single work-item id across runs | PARTIAL | only parent_run links runs; deploy record not keyed | P12-08 |
| B04 | Progress classes and watchdog | PARTIAL | session.ts:196 heartbeat print; run_outputs.ts 1800s stall; machine.ts:262 3-sig stop | P12-12 |
| B05 | Quota wait and resume in engine10 | PARTIAL | machine.ts:83 quota fatal; runner/autonomous.ts:1097 legacy only; run_outputs.ts:192 publish-only resume | P12-09 |
| B06 | Failure fingerprints | DONE in parts | not kept across runs | P12-11 |
| B07 | Pause and cancel states | MISSING | none in engine10 | P12-10 |
| B08 | Snapshot and reconcile | PARTIAL | only the PR reconciled | P12-07 |
| BP1 | Durable lifecycle states and kill-replay test | PARTIAL | util/run_outputs.ts:61-93 workItemState lacks delivering/observing/waiting_for_policy/paused | P12-07, P12-08 |
| BP4 | Recovery classes incl. flaky and protocol error | PARTIAL | runner/retry_class.ts, recovery_policy.ts; supervisor.ts:207 flaky: [] | P12-11 |
| VS | Vertical slice: issue to PR with kill, resume, comment | MISSING | pieces exist: tests/engine10/issue_ref_e2e.test.ts, fixtures/issue-ref/bin/gh | P12-13 |

### A.4 Category C (verification and delivery)

| # | Item | Status | Evidence | Slice |
|---|---|---|---|---|
| C01 | Wall authored in isolation with holdout | PARTIAL | stages/wall.ts isolated author; implementer can read Wall tests; holdout only in modernize/equiv.ts | P12-05 |
| C02 | Seal binds intent; verify detects drift | PARTIAL | seal binds head_sha and task sha256; verify_cmd.ts never compares with current spec | P12-01 |
| C03 | Visual evidence as gate | PARTIAL | features/visual_evidence.ts optional, evidence only | P12-47 |
| C04 | Base subtraction | DONE | stages/verify.ts:155,276 subtractBase | none |
| C05 | Per-dimension reviewers, file:line findings | N/A as worded | xreview only lowers; council/finding_schema.ts no file:line rule | P12-06 (file:line rule only) |
| C06 | Merge pinned to proven head | PARTIAL | autonomy/loki:26076 no --match-head-commit; :26057 reads last-proof-id; verify-pr respond no headRefOid compare | P12-03, P12-04 |
| C07 | Release manifest binding heads and deploy | PARTIAL | util/composite_seal.ts binds heads; no manifest or deploy binding | P12-35 |
| C08 | Deploy with staging, canary, observation | PARTIAL | autonomy/loki:10335 print-only unless --execute; canary Vercel/Fly only; one probe | P12-33, P12-34 |
| BP5 | Plain verify compares head_sha with HEAD | PARTIAL | tests/test-deploy-receipt-gate.sh:236-250 covers deploy only | P12-01 |
| BP7 | Destination enum, artifact digest, DB rollback | PARTIAL | none | P12-33, P12-36 |
| P0-05 | Seal negative tests (wrong SHA, missing log, changed intent, fabricated success) | PARTIAL | first two tested only | P12-01 |

### A.5 Category D (steer, chat, integrations, memory)

| # | Item | Status | Evidence | Slice |
|---|---|---|---|---|
| D01 | GitHub steer provenance | PARTIAL | trigger-server.py:711 no LOKI_STEER_SOURCE/ACTOR; log per repo | P12-14 |
| D02 | Chat and Slack steer | PARTIAL | chat records source=cli; contrib/slack_inbound.ts:95 reply starts new run | P12-15, P12-17 |
| D03 | Jira/Linear inbound comment steer and transitions | PARTIAL | integrations/writeback.ts outbound only; transitions on done only (trigger-server.py:937,2119) | P12-18 |
| D04 | Status freshness | PARTIAL | events.ts seq; mcp/cp_tools.py:277 cursor; commands/run_status.ts no "last event N ago" | P12-19 |
| D05 | Intervention classes drive behavior | PARTIAL | runner/intervention.ts metrics only | P12-31 (metrics side) |
| D06 | Control Plane deep link per run | PARTIAL | e10ext/liveline.ts, run_outputs issueStatusBody lack link | P12-19 |
| D07 | Handoff says resume from stage X | DONE minor | util/run_summary.ts | P12-07 (one line) |
| D08 | Memory tenant scope, TTL, outcome feedback | PARTIAL | memory/schemas.py, storage.py | P12-42 |
| BP6 | Context vs control split, durable dedup, chat.update, steer ack | PARTIAL | Slack dedup in memory, no chat.update, issue comment not updated | P12-17, P12-14 |
| P1-02 | Revoked-actor tests, live allowlist | MISSING | slack_inbound.ts:206 reads allowlist once | P12-17 |
| CH | Chat gaps: /answer, /pause, /resume, /start, help, system prompt, rev-N ack | PARTIAL | chat.sh:6 prompt omits steer | P12-16 |

### A.6 Category E (adapter, cost, policy, enterprise)

| # | Item | Status | Evidence | Slice |
|---|---|---|---|---|
| E01 | Model capability catalog | PARTIAL | model_catalog.json context_window only; claude_flags.ts:503 help probing | P12-24 |
| E02 | Router objective = expected accepted-outcome cost | PARTIAL | runner/router/* history and floors | P12-32 |
| E03 | Per-stage, retry and compute cost in receipt | PARTIAL | supervisor.ts:207, cost.ts run-level usd | P12-21 |
| E04 | Pre-call budget reservation, shared ledger | MISSING | e10ext/budget_cap.ts:4-5 post-spend check | P12-22 |
| E05 | Policy-compiled permission mode | PARTIAL | --dangerously-skip-permissions at providers/claude.sh:31,394,673; runner/providers.ts:482 | P12-26, C-C2 |
| E06 | Per-provider isolation matrix | PARTIAL | loki-ts/tests/providers/ partial | P12-25 |
| E07 | Min CLI version, compat matrix, canary | PARTIAL | runner/providers.ts:331; doctor.ts:101,295 display only | P12-24 |
| E08 | Enterprise SCIM, retention, HA, backup, support | PARTIAL | dashboard/audit.py chain, dashboard/auth.py OIDC | P12-48, C-F6 |
| BP2 | Run identity: CLI version, endpoint, config digest, policy | PARTIAL | session.started has provider and model only | P12-23 |
| BP3 | PreCompact hook, milestone flush | PARTIAL | .claude/settings.json no PreCompact | P12-38 |
| BP8 | Outbox and idempotency keys | PARTIAL | stages/pr.ts:123 tolerates existing PR only | P12-36 |
| E-Q | Requested vs actual model tuple in receipt | MISSING | sdk_stream_parser.ts:69 records actual; model_downgrades.ts prints | P12-23 |
| E-L | Gateway lane labelled, feature-loss list | PARTIAL | providers/model_routes.sh:4-24 | P12-27, C-C1 |
| E-O | OTel passthrough | MISSING | no CLAUDE_CODE_ENABLE_TELEMETRY passthrough | P12-27 |

### A.7 Section 7 (Claude adapter)

| # | Item | Status | Slice |
|---|---|---|---|
| Q1 | Execution tuple and qualification levels | PARTIAL | P12-24 |
| Q2 | Compat suite per CLI release | MISSING | P12-24 |
| Q3 | No silent downgrade, requested vs actual | MISSING | P12-23 |
| Q4 | Routing objective | PARTIAL | P12-32 |

### A.8 Section 8 (comparison table claims)

| # | Claim | Status | Note |
|---|---|---|---|
| T1 | Deploy is print-only | WRONG (partly) | --execute exists (autonomy/loki:10335); staging missing (P12-33) |
| T2 | Knowledge graph | PARTIAL | graphify and project_model exist; no decision records (P12-37) |
| T3 | Progressive profiles | MISSING | P12-41 |
| T4 | Proof of done | DONE | seal + receipt |

### A.9 Epics P0-01..P2-01

| Epic | Status | Owning slices |
|---|---|---|
| P0-01 Seal intent binding | PARTIAL | P12-01, P12-02 |
| P0-02 Head-pinned merge | PARTIAL | P12-03, P12-04 |
| P0-03 Durable lifecycle and resume | PARTIAL | P12-07..P12-10 |
| P0-04 Vertical slice | MISSING | P12-13 |
| P0-05 Seal negatives | PARTIAL | P12-01 |
| P1-01 Steer provenance | PARTIAL | P12-14..P12-16 |
| P1-02 Revoked actors | MISSING | P12-17 |
| P1-03 Adapter qualification | PARTIAL | P12-23..P12-25 |
| P1-04 Cost attribution and reservation | PARTIAL | P12-21, P12-22 |
| P1-05 Delivery destinations | PARTIAL | P12-33..P12-36 |
| P1-06 Measurement program | PARTIAL | P12-28..P12-31 |
| P2-01 Knowledge and enterprise | PARTIAL | P12-37..P12-48 |

### A.10 Section 10 (measurement) and 11 to 13

| # | Item | Status | Evidence | Slice |
|---|---|---|---|---|
| M1 | Active human minutes | MISSING | docs/EVALUATING.md:228 | P12-31 |
| M2 | Arms in harness | DONE | eval/loki10/harness.py:51 | none |
| M3 | Configured-CC arm | MISSING | harness.py:595-597 | P12-29 |
| M4 | n>=3 per cell | PARTIAL | D50 n=1 | COST-6 (founder spend) |
| M5 | Predeclared task families | PARTIAL | no UI, API migration, flaky, review-response, CI-failure, staging, incident | P12-30 |
| M6 | Losses reported | DONE | scorecard | none |
| M7 | Published per-task table with CI | PARTIAL | eval/loki10/scorecard; B9 row SUPERSEDED | P12-28 |
| M8 | Ablation producer | PARTIAL | autonomy/lib/ablation.py absent; S-112 parked | S-112 (unpark, C-F1) |
| M9 | Small-edit parity gate | PARTIAL | never_below_raw.test.ts is routing only | P12-28 |
| M10 | Guard against unmeasured Nx claims | MISSING | CHANGELOG.md:272 v11.5.0 | P12-40 |
| M11 | Measured cost figures | PARTIAL | small 1.67x, lean 0.68x, medium >=1.55x, D50 haiku 0.86x, sonnet 1.36x | COST-2/3 (C-C3) |
| M12 | Version in docs | DONE | doc's v11.4.2 is stale | C-F8 |
| M13 | Fixtures: compaction resume, truncated transcript, stale remote status | PARTIAL | none | P12-39 |
| R11 | Overhead risk of added gates | PARTIAL | every new gate in this plan is opt-out measured | P12-28 (parity gate covers) |
| N1 | Pin snapshot | DONE | this validation | none |
| N2 | Audit | DONE | this plan | none |
| N3 | Qualify CC | MISSING | P12-24 |
| N4 | Reproduce U1-U8 | MISSING | P12-13 |
| N5 | Non-Claude routes | PARTIAL | P12-27, C-C1 |
| N6 | Vertical slice | MISSING | P12-13 |
| N7 | Comparative pilot | MISSING | C-F7 (paid) |

### A.11 Counts

Items extracted: 108 (S 14, A 8, B 11, C 11, D 11, E 14, Q 4, T 4, epics 12, measurement/next 19).
By status: DONE 12, PARTIAL 66, MISSING 21, WRONG 3, N/A 6. (Epic rows are rollups; counted once each.)
Non-DONE items are all covered by 48 P12 slices, existing BOARD rows (D51-B13..16, M-26..29, COST-2/3/6, S-112),
or a decision in section C.

## B. Wave-ordered slice cards

Order: moat > Seal accuracy > delivered accuracy > cost > speed. Waves overlap; a wave starts as seats free.
File sets inside a wave never overlap. Cross-wave overlaps are noted as dependencies.

### Wave 1: moat and Seal accuracy (6 slices)

P12-01 Seal intent and head drift in verify (HIGH)
- Goal: `loki verify` fails when the seal's task/contract sha differs from the current spec, or head_sha differs
  from HEAD. Adds changed-intent and fabricated-success negatives (P0-05, BP5, C02).
- Files: loki-ts/src/engine10/verify_cmd.ts (line-neutral: one call), new logic in loki-ts/src/util/seal_drift.ts
  (new file: no util owns seal-vs-workspace comparison; composite_seal.ts is group binding),
  loki-ts/tests/engine10/verify_cmd.test.ts.
- Wall red then green: verify_cmd.test.ts cases "intent changed after seal" and "receipt claims pass with no test
  log" fail on main, pass after. budget.test.ts green.
- Deps: none. Budget 30 min. Line-cap risk: core 19 left; must be net zero in verify_cmd.ts.

P12-02 Steer revision invalidates Wall/Seal and lists in receipt (HIGH)
- Goal: an intent revision after Wall authoring marks the Wall stale; Seal refuses until re-authored; receipt
  carries `intent_revisions: [{rev, source, actor, sha}]` (A04).
- Files: loki-ts/src/util/steer.ts (reader), loki-ts/src/util/run_outputs.ts (receipt field),
  loki-ts/tests/engine10/steer.test.ts. Core: one call in stages/seal.ts, line-neutral.
- Wall: steer.test.ts "revision after wall blocks seal" and "receipt lists revisions" red then green; budget.test.ts.
- Deps: P12-01 (shares seal path, merge after). Budget 30 min. Line-cap: core.

P12-03 Merge pinned to proven head (HIGH, credentials/push)
- Goal: `gh pr merge` passes `--match-head-commit <proof.head_sha>`; the gate resolves the proof for the PR head,
  not last-proof-id (C06). FC-REQ.
- Files: autonomy/loki (merge block near :26057-26076 only), tests/test-loki-merge-queue.sh.
- Wall: merge-queue test with fake gh asserting the flag and a stale-proof refusal red then green;
  `bash -n autonomy/loki`; shellcheck on changed lines.
- Deps: none. Budget 30 min. Line-cap: none (uncapped).

P12-04 verify-pr respond compares headRefOid (HIGH)
- Goal: `verify-pr respond` refuses when the PR headRefOid differs from the proof head (C06).
- Files: loki-ts/src/commands/verify_pr.ts, loki-ts/src/util/pr_lessons.ts (head fetch helper only),
  loki-ts/tests/commands/verify_pr.test.ts (extend if present, else the nearest verify_pr test).
- Wall: "head moved after proof" case red then green. Deps: none. Budget 30 min. Line-cap: none.

P12-05 Wall holdout in engine10 (HIGH, moat)
- Goal: reserve a holdout subset of Wall tests hidden from the implementer, run only at verify; reuse the
  modernize/equiv.ts holdout selection by moving the selector to util/holdout.ts (new: shared by modernize and
  engine10; equiv.ts then imports it, net negative lines in modernize) (C01).
- Files: loki-ts/src/util/holdout.ts, loki-ts/src/modernize/equiv.ts (import swap only),
  loki-ts/src/engine10/stages/wall.ts (one call, line-neutral), loki-ts/tests/engine10/wall_holdout.test.ts
  (new test: no existing wall test file covers holdout).
- Wall: holdout test red then green; modernize equiv tests stay green; budget.test.ts.
- Deps: wait for the in-flight modernize trim to merge. Budget 30 min. CTO approval (moat). Line-cap: core, modernize.

P12-06 Council findings must cite file:line (MEDIUM)
- Goal: council/finding_schema.ts rejects a blocking finding without a file:line anchor (C05 reworded).
- Files: loki-ts/src/council/finding_schema.ts, its existing test.
- Wall: schema test "blocking finding without anchor rejected" red then green. Deps: none. Budget 30 min.

### Wave 2: vertical slice and continuity (7 slices)

P12-07 Per-stage persistence and resume-from-stage (HIGH, engine)
- Goal: each stage writes a durable checkpoint (stage, inputs sha, outputs) in util/run_outputs.ts; `loki start
  --resume <run>` re-enters at the first incomplete stage; HANDOFF prints "resume from stage X" (B08, BP1, D07).
- Files: loki-ts/src/util/run_outputs.ts, loki-ts/src/util/run_summary.ts, loki-ts/src/engine10/supervisor.ts
  (one call, line-neutral), loki-ts/tests/engine10/fix_resume.test.ts (extend).
- Wall: "kill after implement, resume skips intake/plan/wall" red then green; budget.test.ts.
- Deps: none. Budget 30 min. Line-cap: core. Largest risk in the plan; reviewer must check idempotence.

P12-08 Work-item id and extended lifecycle states (MEDIUM)
- Goal: one work_item_id spans runs (issue or PR keyed); workItemState gains delivering, observing,
  waiting_for_policy, paused; blockers get a separate field (B03, BP1).
- Files: loki-ts/src/util/run_outputs.ts (state enum block :61-93 only), loki-ts/tests/engine10/run_outputs.test.ts
  (extend the existing run_outputs test).
- Wall: state-transition table test red then green. Deps: P12-07 (same file, serialize). Budget 30 min.

P12-09 engine10 quota wait and resume (HIGH, engine)
- Goal: quota/rate-limit becomes wait-then-resume using runner/retry_class.ts, not fatal (B05).
- Files: loki-ts/src/runner/retry_class.ts, loki-ts/src/engine10/machine.ts (:83 one-line swap, line-neutral),
  loki-ts/tests/engine10/machine.test.ts (extend).
- Wall: fake provider returns 429 twice then succeeds; run completes; red then green. budget.test.ts.
- Deps: P12-07. Budget 30 min. Line-cap: core.

P12-10 Pause and cancel (MEDIUM)
- Goal: `loki pause|resume|cancel <run>` writes control requests; engine reads them at stage boundaries and records
  cancel_requested then cancel_effective (B07).
- Files: loki-ts/src/util/run_control.ts (new: no module owns run control requests; steer.ts owns intent only),
  loki-ts/src/commands/run_status.ts (subcommand wiring), loki-ts/tests/engine10/run_control.test.ts.
- Wall: pause at boundary, cancel recorded twice-stamped; red then green. Deps: P12-08. Budget 30 min.

P12-11 Recovery classes: flaky, protocol error, conflicting requirements (MEDIUM)
- Goal: runner/recovery_policy.ts adds three classes; supervisor fills flaky from rerun evidence instead of [];
  fingerprints persist across runs in .loki/state/fingerprints.jsonl (BP4, B06). FC-REQ.
- Files: loki-ts/src/runner/recovery_policy.ts, loki-ts/src/runner/retry_class.ts is NOT touched (P12-09 owns),
  loki-ts/tests/runner/recovery_policy.test.ts. supervisor.ts:207 one-line swap, line-neutral.
- Wall: classifier table test red then green; budget.test.ts. Deps: P12-09 merged. Budget 30 min.

P12-12 Progress classes and watchdog (MEDIUM)
- Goal: classify events into progressing, idle, looping, stalled; watchdog emits a stall event at a configurable
  threshold below 1800s (B04).
- Files: loki-ts/src/util/run_outputs.ts is avoided; new logic in loki-ts/src/runner/watchdog.ts (new: no runner
  module owns liveness), loki-ts/tests/runner/watchdog.test.ts. session.ts:196 one-line swap.
- Wall: fake clock test red then green; budget.test.ts. Deps: none. Budget 30 min.

P12-13 Vertical slice e2e plus U1-U8 journeys (HIGH)
- Goal: issue to PR via fake gh, kill -9 mid-implement, resume, issue comment steer, PR updated, receipt has
  revision. Then U1-U8 journey fixtures as further cases in the same file (VS, S13, N4, N6).
- Files: loki-ts/tests/engine10/issue_ref_e2e.test.ts, loki-ts/tests/engine10/fixtures/issue-ref/bin/gh.
- Wall: the new case is red on main (resume impossible), green after P12-07..09 and P12-02.
- Deps: P12-02, P12-07, P12-09, P12-14. Budget 30 min (test only). Line-cap: none.

### Wave 3: chat and steer seamlessness (7 slices)

P12-14 GitHub steer provenance and ack comment (HIGH, trigger server)
- Goal: trigger-server.py sets LOKI_STEER_SOURCE=github and LOKI_STEER_ACTOR; revision log keyed per run; the bot
  edits its status comment with "applied rev N" (D01, BP6). FC-REQ.
- Files: autonomy/trigger-server.py (steer dispatch near :711 only), tests/test_trigger.py.
- Wall: test_trigger.py asserts source=github and actor recorded; red then green. Deps: none. Budget 30 min.

P12-15 Chat steer provenance (LOW)
- Goal: chat /steer exports LOKI_STEER_SOURCE=chat and the user as actor (D02).
- Files: autonomy/chat.sh (steer handler only), tests/test-chat-steer.sh if present, else extend the existing chat
  test the Captain names.
- Wall: recorded source=chat red then green. Deps: none. Budget 15 min.

P12-16 Chat command completeness (MEDIUM)
- Goal: add /answer, /pause, /resume, /start alias of /run; /run backgrounds and returns the prompt; help lists
  /status /steer /stop; system prompt (chat.sh:6) explains steering; rev-N ack after steer (CH, X2).
- Files: autonomy/chat.sh (command table and prompt), same chat test as P12-15.
- Wall: each command smoke case red then green. Deps: P12-15 (same file, serialize), P12-10 (pause). Budget 30 min.

P12-17 Slack thread steer, chat.update, live allowlist, revoked actors (HIGH, auth)
- Goal: a thread reply to an active run steers it instead of starting a new run; status message updated in place
  via chat.update; durable dedup file; allowlist re-read per event; revoked actor refused (D02, BP6, P1-02).
- Files: loki-ts/src/contrib/slack_inbound.ts, its existing test. contrib 331 lines left: keep the diff under 150.
- Wall: revoked-actor and thread-steer cases red then green; budget.test.ts (contrib cap). Deps: none. Budget 30 min.

P12-18 Jira and Linear inbound comment steer and transitions (MEDIUM)
- Goal: inbound comment webhook maps to a steer for the run keyed by work item; transitions on start, blocked, done
  (D03).
- Files: loki-ts/src/integrations/writeback.ts (transition hooks), autonomy/trigger-server.py is NOT touched (P12-14
  owns); inbound handler in loki-ts/src/integrations/inbound.ts (new: writeback.ts is outbound-only by design),
  loki-ts/tests/integrations/inbound.test.ts.
- Wall: fixture payloads produce steer records; red then green. Deps: P12-14 merged (trigger route wiring follow-up
  one line). Budget 30 min.

P12-19 Status freshness label and Control Plane deep link (LOW)
- Goal: `loki status` prints "last event Ns ago (seq N)"; issue status body and liveline carry the run deep link
  (D04, D06).
- Files: loki-ts/src/commands/run_status.ts, loki-ts/src/util/run_outputs.ts issueStatusBody only (coordinate with
  P12-07/08: merge after them), loki-ts/tests/commands/run_status.test.ts.
- Wall: label and link asserted; red then green. Deps: P12-08. Budget 15 min. e10ext/liveline.ts untouched (cap).

P12-20 Remove stale steer text and legacy marks (LOW)
- Goal: delete the LOKI_PROMPT_INJECTION requirement text (autonomy/loki:1800) and the legacy mark on steer
  (cli/registry.ts:280) (S11).
- Files: autonomy/loki (help text line only), loki-ts/src/cli/registry.ts.
- Wall: help-text grep test red then green. Deps: none. Budget 15 min.

### Wave 4: Claude adapter and qualification (7 slices)

P12-23 Run identity tuple in receipt (MEDIUM)
- Goal: receipt records claude CLI version, endpoint (base URL host only), config digest (CLAUDE.md, settings,
  hooks sha), policy id, requested and actual model with a downgrade flag (BP2, E-Q, Q3).
- Files: loki-ts/src/util/run_identity.ts (new: no util owns execution identity; engine_origin.ts is origin URL
  only), loki-ts/src/runner/sdk_stream_parser.ts (expose actual model), loki-ts/tests/util/run_identity.test.ts.
  supervisor.ts one call, line-neutral.
- Wall: receipt fields asserted; downgrade case red then green; budget.test.ts. Deps: none. Budget 30 min.

P12-24 Minimum CLI version, compat manifest, canary (MEDIUM)
- Goal: providers/model_catalog.json gains capability fields and a qualified CLI range; doctor fails below minimum;
  a compat probe script runs the harmless task against a new CLI release (S09, E01, E07, Q1, Q2, N3).
- Files: providers/model_catalog.json, loki-ts/src/commands/doctor.ts (version check block near :101,:295),
  loki-ts/tests/commands/doctor.test.ts.
- Wall: doctor below-minimum case red then green. Deps: none. Budget 30 min.

P12-25 Per-provider isolation matrix (LOW)
- Goal: one table-driven test runs the isolation assertions for every provider (E06).
- Files: loki-ts/tests/providers/ (extend the existing isolation test file).
- Wall: new rows red for a provider lacking isolation, else green with a mutation proving bite. Budget 15 min.

P12-26 Policy-compiled permission mode (HIGH, credentials)
- Goal: compile task policy to `--permission-mode` plus allow/deny tool lists; keep skip-permissions as the
  default until C-C2 approves the flip; flag LOKI_PERMISSION_POLICY=compiled (E05).
- Files: providers/claude.sh (flag assembly near :31,:394,:673), loki-ts/src/runner/providers.ts (:482 block),
  loki-ts/tests/providers/ (extend), tests/test-provider-loader.sh.
- Wall: compiled flag set asserted under the flag; default unchanged; managed-settings precedence case.
- Deps: C-C2 for default flip only (build proceeds). Budget 30 min.

P12-27 OTel passthrough and gateway lane labels (MEDIUM)
- Goal: pass CLAUDE_CODE_ENABLE_TELEMETRY and OTEL_* through when set; model_routes.sh labels each non-Anthropic
  route "unqualified alternative" with its known feature losses, printed by doctor (E-O, E-L, S12).
- Files: providers/model_routes.sh, providers/claude.sh env block is NOT touched (P12-26 owns): passthrough goes in
  providers/loader.sh, tests/test-provider-loader.sh (shared with P12-26: serialize after it).
- Wall: env passthrough and label assertions red then green. Deps: P12-26, C-C1 for wording. Budget 30 min.

P12-21 Per-stage, retry and cache cost attribution (MEDIUM)
- Goal: receipt cost gains per-stage usd, retry usd, cache read/write tokens (E03).
- Files: loki-ts/src/engine10/cost.ts is core: new aggregation in loki-ts/src/util/cost_breakdown.ts (new: cost.ts
  is at the core cap), loki-ts/tests/engine10/cost.test.ts (extend). cost.ts one-line call.
- Wall: breakdown sums equal run usd; red then green; budget.test.ts. Deps: none. Budget 30 min.

P12-22 Pre-call budget reservation and shared ledger (HIGH)
- Goal: reserve estimated spend before each call; refuse when reservation would exceed cap; ledger file shared by
  parallel units with lock (E04).
- Files: loki-ts/src/runner/budget_ledger.ts (new: e10ext/budget_cap.ts is near its cap and post-spend by design),
  e10ext/budget_cap.ts (one-line delegation), loki-ts/tests/runner/budget_ledger.test.ts.
- Wall: two parallel units cannot jointly exceed cap; red then green; budget.test.ts (e10ext 25 left).
- Deps: P12-21. Budget 30 min.

### Wave 5: cost and measurement (6 slices)

P12-28 Valid B9 scoreboard row and small-edit parity gate (MEDIUM)
- Goal: b9-scoreboard.sh produces a row with n>=3, CI, per-task table; a parity check fails when Loki costs more
  than raw on the small-edit family (M7, M9, S14). Runs are paid: build and dry-run on recorded fixtures only;
  the paid run waits for C-F1.
- Files: scripts/b9-scoreboard.sh, eval/loki10/scorecard (extend), tests/test-b9-scoreboard.sh if present.
- Wall: recorded-fixture scorecard red (no CI column) then green. Deps: none. Budget 30 min.

P12-29 Configured-Claude-Code arm (MEDIUM)
- Goal: harness arm that keeps the repo's CLAUDE.md, hooks and skills, alongside the stripped raw arm (M3, S10).
- Files: eval/loki10/harness.py (:51 arms, :595-597 strip), eval/loki10/test_harness.py (extend existing).
- Wall: arm config test red then green. Deps: none. Budget 30 min.

P12-30 Predeclared task families (LOW)
- Goal: add UI, API migration, flaky, review-response, CI-failure, staging, incident family manifests (M5).
- Files: eval/loki10/tasks/ (manifests only).
- Wall: harness manifest validator passes on the new families; red before they exist. Deps: P12-29. Budget 15 min.

P12-31 Active human minutes metric (MEDIUM)
- Goal: compute active minutes from steer, answer, approval and intervention events; report next to waited_s;
  runner/intervention.ts classes feed it (M1, S03, D05).
- Files: loki-ts/src/metrics/trust.ts (near :494), loki-ts/src/runner/intervention.ts, loki-ts/tests/metrics/
  trust.test.ts (extend). docs/EVALUATING.md:228 updated.
- Wall: fixture event log yields expected minutes; red then green. Deps: none. Budget 30 min.

P12-32 Router objective: expected accepted-outcome cost (HIGH, engine routing)
- Goal: router scores routes by cost divided by historical acceptance probability, with floors kept (E02, Q4).
- Files: loki-ts/src/runner/router/ (scoring module only), its tests, never_below_raw.test.ts stays green.
- Wall: history fixture flips choice to the cheaper accepted route; red then green. Deps: C-C3 (COST-2/3 overlap).
  Budget 30 min.

P12-40 Unmeasured Nx claim guard (LOW)
- Goal: a guard row fails when docs or release notes state "Nx" or "% faster/cheaper" without a METRICS reference
  (M10). Fixes the CHANGELOG.md:272 claim via the Release Manager (hot file).
- Files: scripts/global-guards.tsv (one row), scripts/guard-changed.sh if the row needs a matcher.
- Wall: guard red on a seeded fixture, green on clean; avoid self-match (comment quoting pattern). Budget 15 min.

### Wave 6: delivery (4 slices)

P12-33 Destination enum and staging profile (HIGH)
- Goal: deploy takes destination preview|staging|production; staging promotion requires a green observation
  window; production stays --execute gated (C08, BP7, T1).
- Files: autonomy/loki (deploy block near :10335 only), tests/test-deploy-receipt-gate.sh (extend).
- Wall: staging-before-production refusal red then green. Deps: P12-03 (same file, different block; serialize merge).
  Budget 30 min.

P12-34 Observation window (MEDIUM)
- Goal: replace the single probe with N probes over a window with error-rate threshold; recorded in receipt (C08).
- Files: autonomy/lib/deploy_observe.sh if it exists, else the FV deploy-observe module (the builder confirms the
  owner from FV-deploy-observe rows), tests/test-deploy-receipt-gate.sh (serialize after P12-33).
- Wall: flapping fixture fails the window; red then green. Deps: P12-33. Budget 30 min.

P12-35 Release manifest (MEDIUM)
- Goal: util/composite_seal.ts emits a manifest binding repo heads, artifact digests and deploy destination (C07).
- Files: loki-ts/src/util/composite_seal.ts, its test.
- Wall: manifest digest mismatch refused; red then green. Deps: P12-36 for digest. Budget 30 min.

P12-36 Outbox and idempotency keys for PR, comments, deploy (HIGH, push)
- Goal: external side effects go through an outbox with idempotency key; replay after kill does not double-post;
  artifact digest computed once (BP8, BP7).
- Files: loki-ts/src/util/outbox.ts (new: no module owns side-effect replay), loki-ts/src/engine10/stages/pr.ts
  (:123 call swap, line-neutral), loki-ts/tests/engine10/outbox.test.ts.
- Wall: kill between post and record, replay posts once; red then green; budget.test.ts. Deps: P12-07. Budget 30 min.

### Wave 7: knowledge and enterprise (9 slices)

P12-37 Design decision records (MEDIUM)
- Goal: decision_record.py gains a design record type (rationale, alternatives, source, scope), written by plan
  stage via the existing writer (A05, T2).
- Files: autonomy/lib/decision_record.py, its test under tests/.
- Wall: schema round-trip red then green. Budget 30 min.

P12-38 PreCompact hook and milestone flush (LOW)
- Goal: register PreCompact in the shipped hook config to flush state and summary (BP3, S02).
- Files: .claude/settings.json template the installer ships (the builder confirms the source under
  autonomy/hooks/), the existing hook test.
- Wall: hook config contains PreCompact and the flush script runs on a fixture. Budget 15 min.

P12-39 Fixtures: compaction resume, truncated transcript, stale remote status (LOW)
- Goal: three fixtures and tests (M13).
- Files: loki-ts/tests/engine10/fixtures/ (new fixtures), loki-ts/tests/runner/sdk_stream_parser.test.ts (extend).
- Wall: truncated transcript case red if parser throws, green when it degrades. Budget 15 min.

P12-41 Readiness history and harmless round-trip (MEDIUM)
- Goal: `doctor --repo` runs a harmless provider round-trip (echo task, no writes) and appends to
  .loki/state/readiness.jsonl (A01, A02, T3).
- Files: loki-ts/src/commands/doctor.ts (:1768-1777 block), repo_profile.ts. Serialize after P12-24 (same file).
- Wall: history appended twice across runs; red then green. Budget 30 min.

P12-42 Memory TTL, tenant scope, outcome feedback (MEDIUM)
- Goal: memory/schemas.py adds tenant, ttl, outcome fields; retrieval drops expired; outcome raises or lowers rank;
  relevant_files.ts records pick reason (D08, A06 minor).
- Files: memory/schemas.py, memory/storage.py, existing memory tests.
- Wall: expired item not retrieved; red then green. Budget 30 min.

P12-43 Typed constraints in contract (MEDIUM)
- Goal: features/contract.ts gains typed constraints (perf, api, security) traced to Wall cases by id (A03).
- Files: loki-ts/src/features/contract.ts, its test. features cap 99 left: keep diff under 60.
- Wall: constraint without trace flagged; budget.test.ts. Budget 30 min.

P12-44 Skill-derived checks (MEDIUM)
- Goal: checks declared in a repo skill run as quality gates (A07).
- Files: loki-ts/src/runner/quality_gates.ts, its test.
- Wall: fixture skill check fails a run; red then green. Budget 30 min.

P12-45 Spec-revision-aware unit resume (MEDIUM)
- Goal: on spec revision rerun only units whose contract slice changed (A08).
- Files: loki-ts/src/features/speed/run_group.ts, its test. features cap.
- Wall: unaffected unit skipped; red then green; budget.test.ts. Deps: P12-02. Budget 30 min.

P12-46 Sizing tier large (LOW)
- Goal: sizing.ts gains large tier routing to decompose (B01). Coordinate with EV-12* large tier rows; if EV-12
  already owns it, drop this card.
- Files: engine10/sizing.ts (line-neutral), its test. Budget 15 min.

P12-47 Visual evidence as optional gate (LOW)
- Goal: LOKI_VISUAL_GATE=1 turns visual evidence failures into a verify failure (C03).
- Files: loki-ts/src/features/visual_evidence.ts, its test. features cap.
- Wall: flag on, diff fixture fails. Budget 15 min.

P12-48 Enterprise retention and backup (MEDIUM)
- Goal: audit log retention policy and a backup/restore command for dashboard state; SCIM and HA wait for C-F6 (E08).
- Files: dashboard/audit.py, dashboard/ backup helper in an existing module, existing dashboard tests.
- Wall: retention prunes beyond policy, restore round-trips. Budget 30 min.

Slice IDs P12-01 to P12-48 are all used above (48 slices across 7 waves).

## C. Founder and CTO decisions (do not block other waves)

Founder:
- C-F1 Paid evaluation spend: COST-6, the B9 n>=3 run (P12-28 live run), and unparking S-112 ablation.
- C-F5 Hosted Company OS (north star): in or out of scope for this program.
- C-F6 Enterprise commitments: SCIM, HA, support owner (P12-48 does retention and backup only).
- C-F7 Comparative pilot with human-minutes capture against Factory, Devin and Cursor (paid, external users).
- C-F8 Update the source doc's stale version references (v11.4.2 to 11.14.0) and the "deploy print-only" claim.

CTO:
- C-C1 Gateway lane policy: may non-Anthropic routes behind the claude CLI be shipped, and with what label
  (P12-27 wording).
- C-C2 Flip the default from --dangerously-skip-permissions to the compiled permission mode (P12-26 flag flip).
- C-C3 COST-2 and COST-3 moat changes and their overlap with the router objective (P12-32).
- C-C4 Wall holdout ratio and whether holdout failures block or warn (P12-05).

## D. First-wave dispatch order (14 seats)

Chosen for non-overlapping file sets and no unmet dependencies. Highest moat value first.

1. P12-01 Seal intent and head drift in verify (HIGH) - verify_cmd.ts, util/seal_drift.ts
2. P12-03 Merge pinned to proven head (HIGH) - autonomy/loki merge block
3. P12-04 verify-pr respond headRefOid (HIGH) - commands/verify_pr.ts, util/pr_lessons.ts
4. P12-06 Council file:line rule (MEDIUM) - council/finding_schema.ts
5. P12-07 Per-stage persistence and resume (HIGH) - util/run_outputs.ts, run_summary.ts, supervisor.ts
6. P12-14 GitHub steer provenance (HIGH) - autonomy/trigger-server.py, tests/test_trigger.py
7. P12-15 Chat steer provenance (LOW) - autonomy/chat.sh
8. P12-17 Slack thread steer and revoked actors (HIGH) - contrib/slack_inbound.ts
9. P12-20 Stale steer text (LOW) - cli/registry.ts, autonomy/loki help line (coordinate with #2: different hunk,
   merge after #2)
10. P12-23 Run identity tuple (MEDIUM) - util/run_identity.ts, sdk_stream_parser.ts
11. P12-24 Min CLI version and compat manifest (MEDIUM) - model_catalog.json, commands/doctor.ts
12. P12-21 Cost attribution (MEDIUM) - util/cost_breakdown.ts, engine10/cost.ts
13. P12-29 Configured-CC arm (MEDIUM) - eval/loki10/harness.py
14. P12-31 Active human minutes (MEDIUM) - metrics/trust.ts, runner/intervention.ts

Core-touching slices in this wave: #1 (verify_cmd.ts), #5 (supervisor.ts), #12 (cost.ts). Core has 19 lines left;
all three must be line-neutral and merge one at a time with budget.test.ts in each Wall.
Next to dispatch as seats free: P12-02 (after #1), P12-08 (after #5), P12-09 (after #5), P12-12, P12-16 (after #7),
P12-25, P12-26, P12-30, P12-40, P12-05 (after the modernize trim merges).

## Top risks

1. Line caps: engine10 core 4981/5000 (19 left), modernize 4107/4000 (over on main, trim in flight), e10ext
   1475/1500, features 2901/3000, contrib 869/1200. Three wave-1 slices touch core.
2. COST-HALF unproven: best 0.68x (lean), default small 1.67x raw, no valid B9 row; proof needs founder spend.
3. engine10 cannot resume mid-run; the vertical slice (P12-13) depends on P12-07, the hardest slice.
4. Main calls run with --dangerously-skip-permissions and no policy compiler; flipping needs C-C2.
5. Steer provenance records source=cli for GitHub and chat, and merge is not pinned to the proven head SHA.
