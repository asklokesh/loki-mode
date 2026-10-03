# Morning brief, 2026-10-03 (written 14:31Z, refresh due 15:30Z)

## Shipped today
- 8 releases in 24h, the newest v10.6.14 (tag 7fbbefc30, 14:01Z). It is on npm `next`; `latest` is still 10.6.13 until D49 auto-promote.
- What users can do on v10.6.14:
  - The Wall caps its time by task size: 90s small, 180s normal, and LOKI env override clamped to 300s (W1-S3).
  - The Wall manifest runs on the base tree, and the seal records manifest_sha256 (W1-S2, D77).
  - Unit mode fails closed, freezes its spec at intake, and applies the unit cost cap (D61-11, D61-11b).
  - Criteria import keeps list items on GNU sed (P0-T99-ROUTING).

## On the next train (train/101, e14834e53, pushed 14:29Z)
- loki-seal: forged runner pass lines that contradict the runner summary give NOT VERIFIED, and coverage is granted only from a node --test run that loki-seal launches itself with a scrubbed env (SEAL-FORGED-LINES, 13 rounds, D80 amendment 2, final opus APPROVE).
- Loki's post-session push and PR no longer get skipped under CPU load (P0-P9-DEFAULT-PUSH):
  - Root cause: `printf | grep -q` under pipefail took SIGPIPE.
  - Under docker load it failed 5 of 18 runs before the fix and 0 of 10 after.
  - The fix passed opus review.
- scripts/cloud-dispatch.sh: dry-run-first cloud fan-out for BOARD rows (G-04, opus r3 APPROVE).

## Decisions taken without you (logged in DECISIONS.md)
- D80 amendment 2 (13:26Z) sets loki-seal coverage policy:
  - Coverage comes only from a runner loki-seal launches itself.
  - Only built-in reporters count.
  - jest and vitest give NOT VERIFIED.
  - The 13:14Z amendment was not ratified.
- The train/100 P9 red was handled per D68: a full rerun went green and released, and a P0 was opened in parallel. Nothing was added to tests/moat/pending.txt.

## Risks and open items
- The weekly usage projection is over the pulse ceiling. Your D68 override (85% live /usage floor) governs, and the peer reported 64% of the week.
- Opus share is about 37 to 45% against its 30% budget. Opus is used only for HIGH reviews; builders and TL reviews run on sonnet.
- The pulse git and ps probes time out under host load, so many metrics read UNKNOWN. These are probe failures, not regressions.
- The local fast gate hit its 590s timeout once under load (rc=124). Its one real failure, the emoji scan on loki-seal check marks, was fixed in 98e144f21.
- 14 of 18 ready BOARD rows are blocked by dependencies: the M-15 chain, S41-06 and S41-13. The dispatchable ones are W1-S4, EV-9, A-112b and S41-06.

## Carded advisories (non-blocking)
- loki-seal:
  - jest and vitest "red still counts" has no E2E test.
  - NODE_PATH is covered only by a unit test.
- engine10-push: add a case where run.sh keeps its anchors but drops one function, asserting rc 3.
- P0-T99: change the root sed `\s` to `[[:space:]]`.
- G-04: --live checks the session, not the agent; also the paren-prose tokens and the dependency wording.
- W1-S3: add a note on STAGE_BUDGETS.wall.limitS.

## Needs you (see FOUNDER-QUEUE.md, nothing new today)
- Items 15 and 16 (real-provider first-run gate, Slack webhook) still park the real-model E2E legs.
- Item 7 (loki-seal license) and item 8 (public repo) gate the external seal launch.
