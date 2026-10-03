# Morning brief, 2026-10-03 (refreshed 16:29Z, next refresh 17:30Z)

## Shipped today
- 8 releases in 24h. The newest is v10.6.14 (tag 7fbbefc30, 14:01Z). npm latest is still 10.6.14.

## 10.7.0: one big train, minor bump (D82, D84, D85)
- train/102 (cf5be9026) went red: Tier A (shard-durations rows) and Tests (help and completion registration for acp and merge, `loki web --port` validation, a CP-INGEST type error, the gitleaks baseline count).
- All of them were fixed in place (D85) and rerun locally green. train/103 (d9704dfc4) was pushed at 16:28Z and CI is running. Release follows a green Tests run.
- In: the speed path on by default (with the fix for its 9 reds), quiet-mode live line, the cost cap, loopback-only default listeners, Playwright e2e with video, `loki merge`, `loki review --risk`, project memory, mobile emulator tests, the REST runs API, ACP, Sentry intake, and Control Plane zero-setup ingest, legacy entry points and live runs.
- Moved to 10.7.1: the empty-Wall seal (it failed the engine e2e done run), CP roles and OIDC, the liveline CP URL, the monorepo RealBaseTestRunner, and mobile-verify wiring.

## 10.8.0: enterprise Control Plane rebuild (D83)
- On cpe-base: shell, home, runs, run thread, compose, cost, work, receipts, models, plans, merge queue and PR risk pages, a11y and contrast fixes. The suite is 235/0 and UI tsc is 0.
- Settings (loki.yaml write-back, CPE-14) has been blocked by opus three times, on YAML 1.1 parser differences. The shell-command lock now holds. A fixer is on the remaining quoting gaps.
- Opus security review is running on the merge-run endpoint.
- Next: CPE-19 workspaces, CPE-20 integrations, and CPE-24 deleting the legacy dashboard last.

## Risks
- Host load makes the pulse git and ps probes time out, so many metrics read UNKNOWN.
- The weekly projection is over the pulse ceiling. Your D68 85% live /usage floor governs.

## Needs you
- FOUNDER-QUEUE 18: a screenshot veto on the 10.8.0 look.
- Items 15 and 16 (real-provider gate, Slack webhook) still park the real-model E2E legs.
- Items 7 and 8 gate the external loki-seal launch.
