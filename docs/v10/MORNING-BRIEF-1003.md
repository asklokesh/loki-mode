# Morning brief, 2026-10-03 (refreshed 15:35Z, next refresh 16:30Z)

## Shipped today
- 8 releases in 24h. The newest is v10.6.14 (tag 7fbbefc30, 14:01Z).
- train/101 (seal forged-lines, P9 default push, cloud-dispatch) is folded into the 10.7.0 train.

## 10.7.0: one big train, minor bump (D82)
- Freeze is at 15:45Z, the cut at 15:55Z, and npm at about 16:10Z.
- On local main, unpushed:
  - Cost cap (subscription: no dollar cap; API key: $100 default).
  - Default-on flags, with listeners on loopback only.
  - Playwright e2e with video, `loki merge` queue, `loki review --risk`, project memory, mobile emulator tests, REST runs API, ACP for VS Code and JetBrains, Sentry intake, and D50 fixes.
  - Docker and liveline.
  - Control Plane zero-setup ingest, legacy dashboard entry points routed to the Control Plane, live run view, and shell with a loopback-only start endpoint (opus APPROVE r2).
  - An empty Wall now seals NOT PROVEN (opus APPROVE r2).
- Open item: 9 loki-ts bun reds after the LOKI_SPEED default flip. A fixer agent is working on them. If any real speed regression is unfixed by the freeze, the speed flip is reverted for 10.7.0.

## 10.8.0: enterprise Control Plane rebuild (D83)
- Plan: docs/v10/CP-ENTERPRISE-UI.md, slices CPE-01..26. Integration happens on branch cpe-base, kept off main until 10.7.0 is cut.
- Status:
  - Done: CPE-01 (legacy tokens, fonts, 19 primitives), CPE-03 (server scaffold), CPE-05 (SSE) and CPE-21 (notifications, audit). cpe-base suite is 97/0.
  - Opus security review: CPE-04 (artifacts read API) and CPE-07 (POST /v1/runs).
  - Building: CPE-02 (lean claude.ai-style shell) and CPE-09 (run.pid plus stop, retry and resume).

## Decisions taken without you
- D83 point 6:
  - Ground #F1F2F6 and the mascot are kept.
  - The merge queue and PR risk get UI pages (CPE-25, CPE-26).
  - Schedules, memory and modernize stay hidden.
- CPE-01 added AA-safe ink tokens, because the legacy light-theme status hex fail WCAG AA on the ground (FOUNDER-QUEUE 18).

## Risks
- Host load makes the pulse git and ps probes time out, so many metrics read UNKNOWN.
- The weekly projection is over the pulse ceiling. Your D68 85% live /usage floor governs.

## Needs you
- FOUNDER-QUEUE 18: a screenshot veto on the 10.8.0 look.
- Items 15 and 16 (real-provider gate, Slack webhook) still park the real-model E2E legs.
- Items 7 and 8 gate the external loki-seal launch.
