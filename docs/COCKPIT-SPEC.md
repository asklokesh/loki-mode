# Loki Cockpit (rec #6) - build spec

> **Historical:** this describes the classic dashboard, removed in Loki Mode 10.8. The Control Plane is the only UI; see [control-plane-migration.md](control-plane-migration.md).

Status: IN BUILD (v7.126.0 target). Design approved via mockup
(scratchpad/loki-cockpit.html). Grounded in real engine state + Autonomi identity.

## Product model (locked with founder)

Three surfaces, each for a different moment; the cockpit ADDS a choice, removes nothing:
- `loki start` - launch. Now DETACHES to background by default on an interactive
  TTY, after a rich handoff (spec/path/tier/budget/logs/dashboard URL + actions:
  view/watch/dashboard/detach/stop). Auto-picks "Both" after an 8s timeout.
  CI / --bg / --yes / non-interactive skip the handoff -> exactly today's behavior.
- `loki cockpit` - NEW opt-in observability surface. Renders the approved cockpit
  UI live from `.loki/` state, multi-repo. Two render paths:
    1. In-terminal 4K image (Kitty / iTerm2 / WezTerm / Ghostty graphics protocol)
       - pixel-exact, the approved HTML/SVG rasterized in-pane.
    2. Browser-dashboard fallback (default everywhere else) - opens the existing
       web dashboard (redesigned to the same identity).
  (`loki watch` is UNCHANGED - it remains the PRD-file auto-rerun watcher.)
- `loki dashboard` - the web view (redesigned to the cockpit identity).
- `loki stop` - already exists; surfaced as an action in the handoff + cockpit.

## Identity (from ~/git/autonomi-website, verified)

- Logo: purple squircle #553DE9 + white "A" (two strokes + Q-bezier apex) + teal
  dot #1FC5A8. Always visible top-left.
- Accent #553de9 (light) / #8b7bf5 (dark). Teal #1FC5A8 secondary.
- Fonts: Fraunces (display), Inter (body), JetBrains Mono (mono). Ink #201515.
- Light-grey ground DEFAULT (#f1f2f6); dark mode optional.
- Semantic: verified #1f8a52, warning #9a6a12, failed #b23a3a.

## Data sources (real, no new state invented)

- Multi-repo run list: `dashboard/registry.py` -> `get_fleet_runs()` /
  `list_projects()` reading `~/.loki/dashboard/projects.json`.
- Per-run live state: `<target>/.loki/autonomy-state.json` (iteration, phase,
  status), `.loki/council/*.json` (votes, gate/evidence blocks),
  `.loki/verify/evidence.json` (verdict + gates + freshness), `.loki/events.json`.
- Budget: `.loki/metrics/` + state cost fields.

## Render pipeline (dependency-free - the "no one has done this" bar)

No chafa / no headless Chrome hard dependency. Pipeline:
1. Build an SVG of the cockpit from live state (exact fonts embedded, exact colors).
2. Rasterize SVG -> PNG via a bundled pure path (resvg-js if present, else a
   node canvas fallback; capability-detected).
3. Encode PNG -> terminal via a SELF-CONTAINED encoder (Kitty graphics protocol
   or iTerm2 inline-image escape, pure base64 - no external binary).
4. Capability detection: $TERM / $TERM_PROGRAM / KITTY_WINDOW_ID / terminal
   query; on unsupported terminals fall back to opening the browser dashboard.
   Honest: never claim an image render happened when it fell back.

## Stories

- S1 (start handoff + detach-default): cmd_start. Rich handoff card, 8s auto-Both,
  actions, remember-per-project. Non-interactive/CI/--bg/--yes bypass. Tests.
- S2 (loki cockpit command + multi-repo model): cmd_cockpit, reads registry +
  per-run state, run switcher, --once/--follow, browser fallback. Tests.
- S3 (render pipeline): SVG-from-state builder + SVG->PNG + terminal-image
  encoder + capability detection + fallback. Tests (encoder byte-shape, detection).
- S4 (dashboard identity redesign): apply logo/purple/fonts/multi-repo switcher to
  legacy-ui; rebuild dist. Lightweight gate.
- S5 (docs + wiki + release): help text, README, wiki, CHANGELOG, 14 version files.

## Constraints

- CLI-invariant: no existing command changes behavior (watch stays PRD-watcher;
  start's non-interactive path byte-identical).
- Never fake-green: image path honest about fallback; every claim tested.
- Both routes where relevant; bash-route for start/cockpit/stop.
