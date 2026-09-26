# Metrics

Latest measured value for each metric, with n, cost, date and the command that
produced it. "Not measured" is a real value here: nothing is estimated.

## Adoption

| Metric | Value | n / window | Date | Command |
|---|---|---|---|---|
| npm downloads, last 30 days | 12,194 | 2026-08-25..2026-09-23 | 2026-09-25 | `curl -s https://api.npmjs.org/downloads/point/last-month/loki-mode` |
| npm downloads, last 7 days | 838 (about 120/day) | 2026-09-17..2026-09-23 | 2026-09-25 | `curl -s https://api.npmjs.org/downloads/point/last-week/loki-mode` |
| Organic floor (days with no release) | about 94/day | from strategy doc | 2026-09-25 | `docs/STRATEGY-2026-2028.md:9` (re-measure with the adoption eval) |
| GitHub stars / forks | 1,073 / 206 | - | 2026-09-25 | `gh api repos/asklokesh/loki-mode --jq '{stars:.stargazers_count,forks:.forks_count}'` |
| Time to first sealed PR | not measured | - | - | adoption eval (M0, not built) |
| Decisions asked of the user | not measured | - | - | adoption eval (M0, not built) |

## Factory (M0 baselines, none measured yet)

| Metric | top | floor | routed | raw Claude Code | raw Codex |
|---|---|---|---|---|---|
| Seal rate | - | - | - | n/a | n/a |
| Verified-correct rate (hidden tests) | - | - | - | - | - |
| Cost per sealed change | - | - | - | - | - |
| Time to sealed PR, one item | - | - | - | - | - |
| Human touches per change | - | - | - | - | - |

## Seal accuracy

| Metric | Target | Required n | Current n | Value |
|---|---|---|---|---|
| False-SEALED (wrong pass) | at most 1%, 95% upper bound at most 3% | about 100 seeded defects with 0 wrong passes (rule of three) | 0 | not measured |
| False-NOT-SEALED (wrong fail) | at most 5% | - | 0 | not measured |

## Verification latency

| Metric | Target | Value |
|---|---|---|
| `loki verify --fast` p95, diff scope | under 1s | not measured in v10 terms |
| Full Seal overhead beyond project tests | at most 60s median | not measured |

## Moat suite

| Property | Status | Command |
|---|---|---|
| all 9 | 1 of 9 proven (P6); 55 cases, 32 pass, 23 pending with milestones (2026-09-26, v9.54.0) | `bash tests/moat/run.sh` |
| history | v9.53.0: 1 of 9, 48 cases, 25 pass, 23 pending | - |
| history | v9.52.0: 0 of 9, 45 cases, 21 pass, 24 pending | - |
| runtime | about 15s locally (9 scripts in parallel), about 1m15s CI job | `time bash tests/moat/run.sh` |
