# Phase 6 Readiness Checklist (v8.0.0 Sunset of Bash)

Authoritative checklist for graduating Loki Mode from the dual-runtime
(bash + Bun) era to a Bun-only v8.0.0 release. Derived from
`/Users/lokesh/.claude/plans/polished-waddling-stardust.md` Phase 6
section. This file is the single source of truth executed by
`loki-ts/scripts/check-phase6-ready.ts`.

Every item below is a hard gate. Any single failure blocks v8.0.0.

Current state at file authorship: branch `feat/bun-migration`, HEAD
`672354ea`, version v7.4.3, Phase 5 in scaffolding. Phase 6 cannot
ship from this session. See "Why Phase 6 cannot complete in this
session" at the bottom.

---

## 1. Phase 5 Prerequisites (must be DONE and SHIPPED)

Each module must exist, have parity tests, ship in a tagged release,
and pass council. Status snapshots are based on the v7.4.3 codebase.

| Module | Path | Acceptance Criteria | Current Status (v7.4.3) |
|---|---|---|---|
| Completion council | `loki-ts/src/runner/completion.ts` | 100-run synthetic parity vs `autonomy/completion-council.sh`; verdict divergence < 1%; severity budget + unanimous+DA logic mirrors `completion-council.sh:1337-1345` | Scaffolded only; no parity harness yet |
| Code review | `loki-ts/src/runner/council.ts` | Single-writer invariant on `.loki/quality/reviews/<id>/*.txt` preserved; dashboard reads still work | Scaffolded only; needs 3-reviewer parallel logic |
| Provider invocation (TS path) | `loki-ts/src/runner/providers.ts` | Real `claude -p`, `codex exec`, `gemini`, `cline`, `aider` subprocess calls succeed end-to-end on a real PRD | Scaffolded; no real-provider integration test recorded |
| Quality gates pipeline | `loki-ts/src/runner/quality_gates.ts` | All 9 gates from `skills/quality-gates.md` invoked from TS runner; gate 6 (backward-compat / healing) preserved | Scaffolded |
| Task queues | `loki-ts/src/runner/queues.ts` | `.loki/queue/pending.json` schema preserved byte-for-byte; dashboard `/api/queue/*` keeps working | Scaffolded |
| Phase 5 release tag | `git tag` | `v7.5.0` (or last 7.x minor) shipped containing all of the above | NOT SHIPPED (current tag v7.4.3) |

A Phase 5 release ships when every row above flips to "DONE +
council-unanimous + parity-passing".

---

## 2. 30-Day Soak Metrics (must be CLEAN)

The soak window starts the day Phase 5 is tagged. Phase 6 cannot ship
until 30 consecutive calendar days of clean telemetry have elapsed
since the Phase 5 release.

### 2.1 Files inspected

- `.loki/metrics/migration_bench.jsonl` -- per-invocation parity and
  speedup records. Every line is a hyperfine result with
  `bun_mean_ms`, `bash_mean_ms`, `speedup`, and `timestamp`.
- `.loki/metrics/migration_bench_soak.jsonl` -- nightly extended
  benchmark with stddev + p50/p95.
- `.loki/managed/events.ndjson` -- per-invocation provenance log
  (created by Phase 5; the file may not yet exist at Phase 5 ship,
  in which case `loki telemetry events` is the canonical source).
  Each event includes `legacy_bash` boolean, `route` string,
  `parity_failure` boolean.
- `.loki/quality/reviews/` -- council verdicts; used to verify zero
  unresolved blocker reviews remain.

### 2.2 Queries to run

```bash
# 30-day soak window (epoch seconds; adjust for actual cutover date)
SOAK_START=$(date -u -v-30d +%s 2>/dev/null || date -u -d '30 days ago' +%s)

# 1. Zero LOKI_LEGACY_BASH=true invocations in window
jq -r --argjson cut "$SOAK_START" '
  select(.timestamp >= $cut and (.legacy_bash // false) == true)
' .loki/managed/events.ndjson | wc -l
# Expected: 0

# 2. Zero parity failures in window
jq -r --argjson cut "$SOAK_START" '
  select(.timestamp >= $cut and (.parity_failure // false) == true)
' .loki/managed/events.ndjson | wc -l
# Expected: 0

# 3. Bun never regresses below bash (speedup >= 1.0 on every record)
jq -r 'select(.speedup < 1.0)' .loki/metrics/migration_bench.jsonl | wc -l
# Expected: 0

# 4. At least one bench record per day for 30 days (continuity check)
jq -r '.timestamp' .loki/metrics/migration_bench_soak.jsonl \
  | awk '{print strftime("%Y-%m-%d", $1)}' | sort -u | wc -l
# Expected: >= 30
```

### 2.3 Thresholds

| Metric | Threshold | Why |
|---|---|---|
| `legacy_bash=true` count over 30d | == 0 | Zero users still on the rollback path |
| `parity_failure=true` count over 30d | == 0 | No behavioral divergence detected |
| Min `speedup` across all bench records | >= 1.0 | Bun never slower than bash |
| Distinct soak days with bench data | >= 30 | Telemetry continuity |
| Open blocker reviews in `.loki/quality/reviews/` | == 0 | No unresolved council issues |

---

## 3. File-Deletion Checklist for v8.0.0

These must all be `git rm`'d in the v8.0.0 commit. The script verifies
each path exists today (so deletion is meaningful) and is referenced
from the deletion list.

### 3.1 Bash entry points (3 files)

- `autonomy/loki` (~10,820 LOC)
- `autonomy/run.sh` (~12,028 LOC)
- `autonomy/completion-council.sh` (~1,771 LOC)

### 3.2 Provider shells (7 files)

- `providers/claude.sh`
- `providers/codex.sh`
- `providers/gemini.sh`
- `providers/cline.sh`
- `providers/aider.sh`
- `providers/loader.sh`
- `providers/models.sh`

### 3.3 Bash helpers in `autonomy/` (15 currently present;
plan called for 22 -- delta tracked in deletion PR description)

Examples (run `ls autonomy/*.sh` for full list at sunset time):
- `autonomy/app-runner.sh`
- `autonomy/council-v2.sh`
- `autonomy/issue-parser.sh`
- `autonomy/issue-providers.sh`
- `autonomy/migration-agents.sh`
- `autonomy/notify.sh`
- `autonomy/playwright-verify.sh`
- `autonomy/prd-checklist.sh`
- (remaining inventory captured in `loki-ts/scripts/check-phase6-ready.ts`)

### 3.4 Bash test scripts in `tests/` (65 currently;
plan called for 83)

Wildcard delete: `git rm tests/test-*.sh`

Each bash test must have a Bun replacement under `loki-ts/tests/`
with equal or greater coverage. The script counts both populations
and refuses to graduate if Bun test count < deleted bash test count.

### 3.5 Shim and flag changes

- `bin/loki` -- rewrite to a 3-line shim: `exec bun
  loki-ts/dist/loki.js "$@"`. Drop `LOKI_LEGACY_BASH` handling, drop
  `BASH_CLI` resolution, drop bash fall-through for missing Bun
  (Bun becomes a hard dependency).
- Remove every reference to `LOKI_LEGACY_BASH` from the codebase
  (`grep -rn LOKI_LEGACY_BASH` must return zero hits except the
  CHANGELOG entry that announces the removal).

---

## 4. Documentation Updates Needed

| File | Change |
|---|---|
| `CHANGELOG.md` | Add `## [8.0.0]` entry: "Bash runtime removed. Install v7.4.3 (or last 7.x) if you need bash back." Pin the exact version. |
| `SKILL.md` | Header + footer version bump to 8.0.0; remove any "bash" references in the architecture section. |
| `README.md` | Drop `LOKI_LEGACY_BASH` mention; update install/runtime requirements (Bun >=1.3.0 hard requirement). |
| `docs/INSTALLATION.md` | Bun installation made mandatory; remove "bash fallback" verbiage. |
| `wiki/Home.md` | Current Version line -> 8.0.0. |
| `wiki/_Sidebar.md` | Version line -> 8.0.0. |
| `wiki/API-Reference.md` | Bump example version strings. |
| `CLAUDE.md` | "Current: v8.0.0"; release-workflow section may drop bash-syntax checks. |
| `docs/architecture/ADR-001-runtime-migration.md` | Append "Phase 6 closed YYYY-MM-DD" footnote. |
| `docs/architecture/STATE-MACHINES.md` | Strip bash file/line references in favor of TS file references. |
| `VERSION` | 8.0.0 |
| `package.json` (root) | 8.0.0; `engines.bun` becomes required, drop any node-only fallback declarations. |
| `loki-ts/package.json` | Bump to match. |
| `dashboard/__init__.py`, `mcp/__init__.py`, `vscode-extension/package.json`, `Dockerfile`, `Dockerfile.sandbox`, `docker-compose.yml` | Version bumps per CLAUDE.md release-workflow 14-locations rule. |

---

## 5. GitHub Actions Changes

### 5.1 `.github/workflows/test.yml`

- Drop the bash-route matrix leg (any job that sets
  `LOKI_LEGACY_BASH=true`).
- Drop bash-only test invocations (`bash tests/test-*.sh`).
- Keep `bun test` and `tsc --noEmit` jobs.
- Verify with: `grep -n LOKI_LEGACY_BASH .github/workflows/*.yml` -> 0 hits.

### 5.2 `.github/workflows/bun-parity.yml`

- Either delete the file outright (parity is no longer meaningful
  when bash is gone) OR retain as a regression smoke test against
  the last shipped 7.x tarball (preferred: delete to reduce CI
  surface).

### 5.3 `.github/workflows/release.yml`

- Drop "build bash artifact" steps if any.
- Ensure `npm pack --dry-run` no longer expects `autonomy/loki`,
  `autonomy/run.sh`, etc. in tarball.
- Confirm Docker, Homebrew, VSCode publish steps still pass.

---

## 6. Homebrew Formula Update

The asklokesh/homebrew-tap formula is updated by `release.yml`. For
v8.0.0 the formula must:

- Add `depends_on "oven-sh/bun/bun"` (was optional via shim
  fallback before).
- Drop any `depends_on "bash"` (`>=4`) declaration if present.
- Verify the bottle still installs and `loki version` returns
  `8.0.0` after `brew upgrade loki-mode`.

The formula is not in this repo, so the check script verifies the
release.yml job that updates the tap has not been removed.

---

## 7. Auto-Graduation Script

`loki-ts/scripts/check-phase6-ready.ts` -- runnable with
`bun run scripts/check-phase6-ready.ts`. Exits 0 if every gate
passes, non-zero otherwise with a `NOT READY: ...` reason per failed
gate. Gate list:

1. Phase 5 release tag exists (`v7.5.0` or later 7.x)
2. Phase 5 modules exist on disk
   (`runner/completion.ts`, `runner/council.ts`,
   `runner/providers.ts`, `runner/quality_gates.ts`,
   `runner/queues.ts`)
3. Bash files still present (so deletion is meaningful)
4. 30 days elapsed since Phase 5 tag (`git log --format=%ct
   <tag> -1`)
5. Soak telemetry: zero `legacy_bash=true` events in window
6. Soak telemetry: zero `parity_failure=true` events in window
7. Soak telemetry: min `speedup >= 1.0` across all records
8. Soak telemetry: >= 30 distinct days with bench data
9. Bun test population >= bash test population (no coverage loss)
10. Open blocker reviews count == 0
11. Final reviewer council verdict file present
    (`.loki/quality/phase6-final-council.json`) with unanimous pass

Any gate that cannot be evaluated (file missing, command fails)
counts as failure.

---

## Why Phase 6 cannot complete in THIS session

Hard blockers, all immutable from inside a single session:

1. Phase 5 has not shipped. Current tag is `v7.4.3`; no `v7.5.0`
   exists. Phase 5 modules (`completion.ts`, `council.ts`,
   `quality_gates.ts`, `queues.ts`) are scaffolded but have no
   parity harness, no 100-run synthetic council fixture, and no
   council unanimous verdict.
2. The 30-day soak clock has not started. By definition you cannot
   compress 30 calendar days into one session. The earliest Phase 6
   can ship is `Phase5_tag_date + 30 days`.
3. `.loki/managed/events.ndjson` does not exist yet -- the soak
   telemetry pipeline (Phase 5 deliverable) is not in production.
4. Real-provider invocation through the new TS path has zero
   recorded production runs. The migration_bench data is
   micro-benchmark only (CLI `version`/`status`/`provider show`),
   not real `loki start <prd>` runs.
5. Final reviewer council file
   (`.loki/quality/phase6-final-council.json`) does not exist.
6. Mass deletion of 90+ bash files (3 entry points + 7 providers +
   15 helpers + 65 test scripts) without the soak data would be a
   direct CLAUDE.md and plan-document violation.

Therefore this session ships only the readiness apparatus
(checklist + auto-graduation script), not the v8.0.0 release.
