# Founder Observability Tool - Spec

## Goal
ONE local, Docker-hosted dashboard for the founder to navigate the whole program's history at a
glance: releases, before/after metrics, what worked, what did NOT work, mistakes made + fixes,
and current status - across loki-mode + autonomi-verify + autonomi-saas. Simplest possible form,
in Autonomi's design language. Runs in Docker locally; opens in the browser when done.

## Absolute rules (never violate)
- **HONEST DATA ONLY.** Every number/claim must come from a REAL source file (below). NEVER
  fabricate a metric, a release, or an outcome. Accuracy is the moat; a fabricated founder
  dashboard destroys it. If a datum is unknown, show "not measured" - never invent it.
- Include the UGLY: "what didn't work" and "mistakes" are REQUIRED sections and must show real
  ones (e.g. the reverted PRD-reuse denylist fix; the convergence double-consume bug two Opus
  reviewers caught before ship; the benchmark harness dying at turn boundaries). Honesty about
  misses is the point of the tool.
- No emojis, no em-dashes/en-dashes anywhere (project rule).

## Data sources (read these; do not invent)
- Releases: `CHANGELOG.md` (parse `## [x.y.z] - date` + the entry body).
- Before/after metrics: `benchmarks/results/*.json` (speed-before/after-*.json = wall_clock_min,
  act_iterations, completion_claims, engine_completed, acceptance, per_iteration_work_s).
- Diagnoses / decisions / plans: `docs/SPEED-DIAGNOSIS-2026-07-01.md`,
  `docs/FOUNDER-STATUS-AND-DECISIONS-2026-07-01.md`, `docs/TOP-100-BACKLOG.md`,
  `docs/research-2026-07/GAP-ANALYSIS-BACKLOG.md`.
- What worked / didn't / mistakes: parse the above docs' honest sections + git log on origin/main
  (`git log --oneline` for shipped commits; look for "revert" and "fix(...council-review finding)"
  as mistake->fix signals).
- Founder-gated decisions (open): section 4/6 of FOUNDER-STATUS-AND-DECISIONS.

## REAL adoption + efficiency metrics (founder wants graphs, real numbers, NO fakes)
Fetch these live at build/refresh time. If any endpoint fails, show "unavailable" - NEVER fake.
Verified working 2026-07-01 (sample values shown so you know the shape; re-fetch for current):
- **GitHub stars/forks/issues**: `gh api repos/asklokesh/loki-mode` (.stargazers_count=998,
  .forks_count=193, .open_issues_count, .created_at=2025-12-26). 
- **Per-release download counts + dates**: `gh api repos/asklokesh/loki-mode/releases`
  (per tag: .tag_name, .published_at, sum of .assets[].download_count). Real per-release adoption.
- **npm downloads (last-month total + 30-day DAILY series for a line graph)**:
  `curl -s https://api.npmjs.org/downloads/range/last-month/loki-mode` -> .downloads[] is
  [{day, downloads}] (30 points; last month total ~23,798; peak 2,598 on 2026-06-17). GRAPH THIS.
  Also per-version: `https://api.npmjs.org/versions/loki-mode/last-week` (downloads by version).
- **Docker Hub pulls**: `curl -s https://hub.docker.com/v2/repositories/asklokesh/loki-mode/`
  -> .pull_count (=56,232), .last_updated. (Cumulative total only; no time-series from Hub.)
- **Homebrew custom-tap installs**: NOT publicly available for a custom tap (only homebrew/core
  taps have analytics). Show "not available (custom tap has no public install API)" - do NOT fake.
- **Efficiency per release**: from `benchmarks/results/speed-*.json` (wall_clock_min,
  act_iterations) + git-diff churn per release from CHANGELOG. Where a release has no benchmark,
  show "not benchmarked" honestly. As more before/after runs accumulate, chart wall-clock and
  iteration-count per version to show the efficiency trend.

GRAPHS REQUIRED (real data only): npm daily-downloads line (30d), per-release GH-download bars,
cumulative Docker pulls (single stat + timestamp), stars (single stat), and a
speed/efficiency-per-release chart (wall-clock + iterations) that grows as benchmarks accumulate.
Use a tiny dependency-light chart approach (inline SVG or a single vendored lib) so it stays
Dockerizable and offline-safe. A daily/refresh fetch keeps the numbers current.

## Design language (Autonomi)
Match the shipped Autonomi look. Reference files: `artifacts/whitepaper/Autonomi-Whitepaper.html`
and `dashboard/static/trust.html`. Palette: dark bg (#0F0B1A / #0d1117), Autonomi purple accent
(#553DE9 / #7B6BF0), verified teal (#2ED8B6 / #1AAF95), dim ink (#B8B0C8 / #8A857C), warning amber
(#C4922E), reject red (#C04848). Semantic status colors: verified=teal, reported/pending=amber,
mistake/reverted=red, roadmap=purple. Clean, calm, founder-readable; big numbers, short labels,
before->after arrows. Reuse the whitepaper's CSS-variable pattern (--bg, --accent, --verified,
--ink, --panel, --line) so it feels native.

## Sections (the dashboard)
1. **At a glance**: current live version (VERSION), # releases this cycle, latest before/after
   speed number (with an honest "n=1, pending repeat" caveat if only one after-run exists).
2. **Release timeline**: each version, date, one-line what+why, and its outcome (live/verified).
3. **Before/After metrics**: the speed benchmark(s) as before->after cards (wall-clock, iterations,
   completion-claims); mark clearly what engine version each ran on and that attribution is
   "vX vs vY" not single-cause. If only a before exists, show before + "after pending".
4. **What worked**: shipped, council-approved, verified fixes (with the evidence: tests, live check).
5. **What did NOT work / reverted**: honest list (PRD-reuse denylist reverted as unsound; any
   dropped approach) with the reason.
6. **Mistakes -> Fixes**: bugs I introduced that review/CI caught and I fixed (convergence
   double-consume; server.py payload edge; benchmark cross-spec contamination avoided). Each:
   what went wrong -> how caught -> how fixed. This is the founder's audit trail.
7. **Open founder decisions**: the 6 one-line asks from FOUNDER-STATUS-AND-DECISIONS.
8. **Backlog / roadmap**: top ranked items from the gap-analysis + top-100 (accuracy-first).

## Delivery
- Static-first is fine (a single index.html + a small data.json generated from the sources by a
  build script), OR a tiny server. Whatever is simplest and robust.
- Dockerized: a `Dockerfile` + a one-command run (e.g. `docker build -t loki-observability . &&
  docker run -p <port>:<port> loki-observability`) serving the dashboard. Pick a free port
  (NOT 57374/57375 which loki uses); e.g. 58080.
- A build/refresh script that regenerates data.json from the real sources so it stays current.
- Place under `artifacts/observability/` (or `tools/observability/`).
- OPEN it in the browser when up (macOS `open http://127.0.0.1:<port>`).

## Validation (before calling done)
- Every displayed number traces to a source file (spot-check 3).
- The "mistakes" and "didn't work" sections are NON-EMPTY and real.
- `docker run` serves the page; the page renders in the Autonomi look; no console errors.
- No emojis / dashes. Screenshot the running page as proof.
