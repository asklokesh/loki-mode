# Control Plane enterprise UI (D83)

Status: STEP 1 design, architect output. STEP 2 is the slice plan in section 6. Ships as 10.8.0.
Package: packages/control-plane (server in src/server, UI in ui/src). Sources cited as path:line on main e6d6c362f.

## 0. Guiding principle (founder addendum, 15:24Z, binding)

"i want fully controllable loki mode of sessions, configurations and anything from UI, but keep it super clean and lean like claude.ai UI and chatgpt UI, but with loki mode's old dashboard look, should feel amazing for users".

1. FULL CONTROL. Everything the CLI does is doable in the UI: start, stop, answer, retry and resume a run; choose repo, issue, model, provider and budget; edit loki.yaml through forms that write back to the file; connect integrations; manage workspaces (and schedules and the merge queue once their backends exist); view and verify receipts. No feature is CLI-only. Section 3.3 is the CLI-to-UI parity table and is a release gate.
2. CLEAN AND LEAN. One primary surface, like Claude.ai and ChatGPT:
   - Left sidebar = wordmark, a "New run" button, and the session list (runs as conversations, grouped Today, Yesterday, Earlier). Nothing else at the top level.
   - Main pane = either the New run composer or one run as a single readable thread.
   - New run = one input, "Paste an issue link or describe a task", with inline chips for repo, model, provider and budget.
   - A run = live steps stream in like messages; diff, evidence and receipt expand inline; a BLOCKED question renders as a reply prompt.
   - Everything else (Home, Runs table, Work board, Workspaces, Plans, Receipts, Cost, Models, Integrations, Notifications, Audit log, Settings) sits behind ONE menu entry at the sidebar foot, not 15 sidebar items. Progressive disclosure everywhere.
3. OLD LOOK on that lean structure: Fraunces serif wordmark and page titles, Inter UI, JetBrains Mono numbers, the purple accent, cards, KPI tiles, badges, status dots, light and dark themes, exactly from section 2 tokens.
4. FEEL AMAZING: instant navigation (client router, cached list), optimistic updates with rollback, Cmd+K, Cmd+Enter to start, empty states that give the single next action, and no dead or placeholder panel. A page whose backend does not exist is not rendered at all.
5. HONESTY (D83 item 3): every number comes from ingested events or run artifacts. A missing value renders as "not measured", never 0. Partial cost shows measured_sessions/total_sessions.

## 1. Legacy inventory (KEEP / REWORK / DROP)

Shell: legacy-ui/scripts/build-standalone.js (generates legacy-ui-static/index.html). Nav groups at build-standalone.js:1266-1347 (Build, Quality and Trust, Insights, Ops, Wiki). Pages at :1358-1882. RARV, Council, gates, checkpoints and app runner are legacy engine concepts with no v10 producer (docs/v10/LEGACY-REMOVAL.md:36-37), so they DROP or remap to v10 stages (events stage.started/completed/failed/skipped, loki-ts/src/engine10/status.ts:9).

| Legacy page or control | Source | Decision | v10 home |
|---|---|---|---|
| Overview (spec, tasks, RARV timeline, diff) | components/loki-overview.js, loki-spec-panel.js, loki-rarv-timeline.js, loki-session-diff.js, loki-task-board.js; build-standalone.js:1358-1415 | REWORK | Home (KPI row, recent runs, BLOCKED inbox). RARV timeline becomes the v10 stage timeline in the run thread. Task board DROP (no v10 task queue). Diff KEEP inside the run thread. |
| First-run hero ("loki quickstart") | build-standalone.js:1365-1387 | REWORK | Empty state of the New run composer (one action: paste an issue). |
| App Runner | loki-app-preview.js, loki-app-status.js (/api/app-runner/*) | DROP | Screenshots and evidence in the run thread replace it. |
| Checkpoints | loki-checkpoint-viewer.js (/api/checkpoints, rollback) | DROP | No v10 checkpoints; rollback deleted (LEGACY-REMOVAL.md:37). |
| Context | loki-context-tracker.js (/api/context) | DROP | Token counts per run (input_tokens, output_tokens) shown in the run cost card. |
| Fleet | loki-fleet.js (/api/fleet/*) | REWORK | Runs table (all repos, filters, group_id rollup). Its table styling is the Table primitive. |
| Quality (score, gates, prompt optimizer) | loki-quality-score.js, loki-quality-gates.js, loki-prompt-optimizer.js | DROP | v10 verify stage plus NOT PROVEN list in the run thread. |
| Trust trajectory and receipts panel | legacy-ui-static/trust.html, proofs.html; build-standalone.js:1811-1828 | KEEP on v10 data | Receipts page (list, inline verify, verified-rate trend from runs). |
| Completion Council | loki-council-dashboard.js, loki-council-transcripts.js | DROP | Remapped: the v10 verify stage and receipt verdict. |
| Spec Checklist | loki-checklist-viewer.js (/api/checklist) | REWORK | Plans and traceability (plan.json, issue.json, receipt claims). |
| Insights: logs | loki-log-stream.js (/api/logs) | KEEP | Streaming log inside the run thread (events.jsonl). |
| Insights: memory, learnings, USAGE.md | loki-memory-browser.js, loki-learning-dashboard.js; build-standalone.js:1427-1590 | DROP now | Memory page deferred until a v10 memory read API exists (section 3.2). USAGE.md becomes a Help link. |
| Analytics | loki-analytics.js (/api/activity) | REWORK | Home trends (runs per day, verified rate) from the runs table. |
| Cost | loki-cost-dashboard.js, loki-cost-waterfall.js, legacy-ui-static/cost.html; spend-cap banner build-standalone.js:1800-1806 | KEEP on v10 data | Cost and usage page; the "no cap" banner is kept and fed by loki.yaml budgets. |
| Notifications | loki-notification-center.js | REWORK | Derived from events: BLOCKED, FAILED, budget.hit, tampered, conflict. |
| Escalations | loki-escalations.js | REWORK | BLOCKED inbox on Home plus the reply prompt in the thread. |
| Migration | loki-migration-dashboard.js | REWORK | Runs filtered to `loki modernize` runs once they ship events (engine10/modernize); hidden until then. |
| Wiki | loki-wiki-browser.js | DROP | Wiki deleted (LEGACY-REMOVAL.md:45). |
| Session panel: Start build, spec textarea | loki-session-control.js:443-500 (/api/control/start, loki-api-client.js:1109) | REWORK | New run composer. |
| Session panel: model picker (start-time) | loki-session-control.js:453-495 | KEEP | Model chip on the composer. |
| Session panel: mid-run model switch | loki-session-control.js:362-437 (/api/session/model) | DROP | v10 has no mid-run switch; Retry with another model instead. |
| Session panel: advisor picker | loki-session-control.js:464-490 | DROP | No v10 advisor. |
| Session panel: Pause, Resume, Stop | loki-session-control.js:19-22 (/api/control/pause, resume, stop) | REWORK | Stop, Retry, Resume on the run header (no pause in v10). |
| Right status sidebar (288 px, 48 px rail) | build-standalone.js:1885-1958, layout :116-140 | REWORK | Run details become an inline collapsible "Details" card in the thread; no permanent third column. |
| Settings disclosure (API URL, theme) | build-standalone.js:1905-1935 | REWORK | Settings page; theme toggle lives in the menu. |
| Project picker and per-app Stop list | build-standalone.js:1244-1258 (/api/running-projects) | REWORK | Repo chip on composer plus a repo filter on the session list. |
| Receipts badge | build-standalone.js:1227-1238, CSS :334-351 (/api/proofs/summary) | KEEP | Sidebar header badge, fed by /v1/stats receipts count. |
| Mascot presence | loki-mascot-presence.js | KEEP | Next to the wordmark, state from "any run running". |
| Budget banner | build-standalone.js:1200-1203 | KEEP | Top banner when a budget is hit (budget.hit event). |
| Run manager, audit viewer | loki-run-manager.js, loki-audit-viewer.js | REWORK | Runs table actions; Audit log page (control-plane actions). |
| API keys, tenant switcher, managed memory | loki-api-keys.js, loki-tenant-switcher.js, loki-managed-memory-panel.js | DROP | Local single user; the bearer token is set by env (src/server/auth.ts). |
| Onboarding (start.html) | legacy-ui-static/start.html (/api/onboarding/*, /api/backlog/*) | REWORK | Integrations page (GitHub connect status) plus the composer empty state. |

## 2. Design system (extracted, binding)

Two legacy layers exist and disagree on ground colors. The SHELL layer in build-standalone.js:113-185 is documented as the founder-approved identity (light-grey ground, comment at :113) and is what users saw around every page; the COMPONENT layer in legacy-ui/core/loki-unified-styles.js:20-146 (also loki-theme.js:44-124) supplies the scales, status colors and component specs. Decision: shell ground and accent per theme from the shell layer; scales, radii, shadows, model colors and component recipes from the component layer. (Open question 1.)

Package: packages/control-plane/ui/src/design/ with tokens.css (custom properties below), fonts.css (Google Fonts link, build-standalone parity: Fraunces opsz 9..144 wght 400/500/600, Inter 300-700, JetBrains Mono 400/500; static/index.html:11), tailwind.preset.ts (maps Tailwind colors, radius, spacing, fontFamily to the vars, so existing Tailwind classes keep working), and primitives/*.tsx.

### 2.1 Tokens (tokens.css)

```css
:root, [data-theme="light"] {
  /* ground: build-standalone.js:116-139 */
  --cp-bg: #F1F2F6; --cp-bg-2: #E6E8EE; --cp-bg-3: #DBDEE6;
  --cp-card: rgba(255,255,255,0.86); --cp-hover: #E6E8EE;
  --cp-glass: rgba(255,255,255,0.7); --cp-glass-border: rgba(255,255,255,0.4);
  --cp-glass-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --cp-text: #201515; --cp-text-2: #4A4640; --cp-text-muted: #8A857C; --cp-text-inverse: #ffffff;
  --cp-border: rgba(0,0,0,0.08); --cp-border-light: rgba(0,0,0,0.05);
  /* accent: shell :124-126, hover/active unified-styles.js:33-35 */
  --cp-accent: #553DE9; --cp-accent-hover: #4432c4; --cp-accent-active: #3828a0;
  --cp-accent-glow: rgba(85,61,233,0.15); --cp-accent-muted: rgba(85,61,233,0.10);
  /* status text: shell :131-134 (AA on light ground); fills: unified-styles.js:51-58 */
  --cp-success: #1f8a52; --cp-warning: #9a6a12; --cp-error: #b23a3a; --cp-info: #2F71E3;
  --cp-success-fill: #1FC5A8; --cp-success-muted: rgba(31,197,168,0.12);
  --cp-warning-fill: #D4A03C; --cp-warning-muted: rgba(212,160,60,0.12);
  --cp-error-fill: #C45B5B;   --cp-error-muted: rgba(196,91,91,0.12);
  --cp-info-muted: rgba(47,113,227,0.12);
  /* models: unified-styles.js:72-75 */
  --cp-opus: #d97706; --cp-sonnet: #553DE9; --cp-haiku: #1FC5A8;
  --cp-shadow-sm: 0 1px 2px rgba(32,21,21,0.04); --cp-shadow-md: 0 4px 6px rgba(32,21,21,0.06);
  --cp-shadow-lg: 0 10px 15px rgba(32,21,21,0.08); --cp-focus: 0 0 0 3px rgba(85,61,233,0.25);
}
[data-theme="dark"] {           /* build-standalone.js:164-185; unified-styles.js:86-146 */
  --cp-bg: #17161C; --cp-bg-2: #1E1D25; --cp-bg-3: #27262F;
  --cp-card: rgba(35,34,43,0.82); --cp-hover: #27262F;
  --cp-glass: rgba(23,22,28,0.7); --cp-glass-border: rgba(255,255,255,0.08);
  --cp-glass-shadow: 0 4px 24px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.12);
  --cp-text: #F0ECF8; --cp-text-2: #B8B0C8; --cp-text-muted: #8B85A0; --cp-text-inverse: #17161C;
  --cp-border: rgba(255,255,255,0.08); --cp-border-light: rgba(255,255,255,0.04);
  --cp-accent: #8b7bf5; --cp-accent-hover: #9c8ff7; --cp-accent-active: #6258D0;
  --cp-accent-glow: rgba(139,123,245,0.2); --cp-accent-muted: rgba(123,107,240,0.18);
  --cp-success: #2ED8B6; --cp-warning: #E8B84A; --cp-error: #E07070; --cp-info: #5A9CF5;
  --cp-success-fill: #2ED8B6; --cp-success-muted: rgba(46,216,182,0.18);
  --cp-warning-fill: #E8B84A; --cp-warning-muted: rgba(232,184,74,0.18);
  --cp-error-fill: #E07070;   --cp-error-muted: rgba(224,112,112,0.18);
  --cp-info-muted: rgba(90,156,245,0.18);
  --cp-opus: #f59e0b; --cp-sonnet: #8b7bf5; --cp-haiku: #2ED8B6;
  --cp-shadow-sm: 0 1px 2px rgba(0,0,0,0.4); --cp-shadow-md: 0 4px 12px rgba(0,0,0,0.5);
  --cp-shadow-lg: 0 10px 25px rgba(0,0,0,0.6); --cp-focus: 0 0 0 3px rgba(123,107,240,0.30);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* same as [data-theme="dark"] */ } }
:root {
  --cp-font-serif: 'Fraunces', Georgia, 'Times New Roman', serif;          /* unified-styles.js:358-362 */
  --cp-font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  --cp-font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace;
  --cp-text-xs: 10px; --cp-text-sm: 11px; --cp-text-base: 12px; --cp-text-md: 13px;
  --cp-text-lg: 14px; --cp-text-xl: 16px; --cp-text-2xl: 18px; --cp-text-3xl: 24px;
  --cp-space-xs: 4px; --cp-space-sm: 8px; --cp-space-md: 12px; --cp-space-lg: 16px;   /* :333-341 */
  --cp-space-xl: 24px; --cp-space-2xl: 32px; --cp-space-3xl: 48px;
  --cp-radius-sm: 2px; --cp-radius-md: 4px; --cp-radius-lg: 5px; --cp-radius-nav: 8px; --cp-radius-full: 9999px; /* :346-353, nav :400-406 */
  --cp-ease: cubic-bezier(0.4,0,0.2,1); --cp-dur-fast: 100ms; --cp-dur: 200ms; --cp-dur-slow: 300ms; /* :390-405 */
  --cp-sidebar-w: 240px;   /* build-standalone.js:126 grid track */
  --cp-detail-w: 288px; --cp-rail-w: 48px;   /* :120-121, used only by the optional Details drawer */
  --cp-main-pad: 28px 32px;   /* .main-content :917-923 */
  --cp-thread-max: 820px;     /* NEW: reading width of the run thread (Claude.ai-like) */
  --cp-z-dropdown: 100; --cp-z-sticky: 200; --cp-z-modal: 300; --cp-z-popover: 400; --cp-z-toast: 600; /* :419-427 */
}
```

Breakpoints (unified-styles.js:408-414): 640, 768, 1024, 1280, 1536. Below 768 px the sidebar becomes a drawer (legacy mobile-menu-btn, build-standalone.js:1210 and media :240-266).

### 2.2 Typography and wordmark
- Wordmark: "Loki Mode" in --cp-font-serif 22px weight 400, letter-spacing -0.02em, line-height 1.1; subtitle "powered by Autonomi" Inter 9px uppercase 0.08em weight 500 muted (build-standalone.js:312-328). Logo: the 34 px purple rounded-square SVG with the teal dot (:1218-1224), copied verbatim.
- Page and thread titles: serif 1.8rem weight 400, -0.02em (.section-page-title :949-955). Section headings: serif 1.15rem weight 400 (:1432).
- Body: Inter 13px, line-height 1.5, font-feature-settings 'cv02','cv03','cv04','cv11', antialiased (:283-296).
- Numbers (KPI values, cost, seq, SHA): mono. KPI value 28px (compact 20px) (loki-kpi-card.js:258-262).

### 2.3 Primitives (ui/src/design/primitives)
| Primitive | Recipe (source) |
|---|---|
| Card | --cp-card bg, 1px --cp-border, radius 5px, padding 16px, hover border --cp-border-light; interactive variant lifts 1px with --cp-shadow-md (unified-styles.js:746-767) |
| KpiTile | Card at 14px 16px (compact 10px 12px), gap 10px, icon chip radius 6px, trend pill 11px radius 3px, mono value, 11px label, optional sparkline SVG from real series only (loki-kpi-card.js:180-293) |
| Badge | inline-flex, 2px 8px, radius 2px, 10px uppercase 0.025em weight 500; variants success, warning, error, info, neutral use muted bg plus solid text (unified-styles.js:799-835). Verdict map: VERIFIED success, PARTIAL warning, FAILED error, SPEC_CONFLICT (BLOCKED) info, running neutral with pulse dot. |
| Pill | receipts badge recipe: radius 999px, 3px 8px, 10px, card bg, 1px border (build-standalone.js:334-351) |
| StatusDot | 12x6 px, radius 2px; active = success with 2s pulse; idle muted; paused warning; error error (unified-styles.js:723-742) |
| Button | 8px 12px, radius 4px, 13px weight 500; primary accent/hover/active; secondary, ghost, danger; sm and lg sizes; disabled opacity 0.5 (:646-722) |
| Input, Textarea, Select | --cp-bg-3 bg, 1px border, radius 4px, focus border accent plus --cp-focus ring (:768-797) |
| Chip | Pill shape with a leading icon and a popover menu (composer repo, model, provider, budget). NEW, built from Pill and Input tokens. |
| Table | wrapper Card radius 5px overflow auto; 12px rows; th 11px weight 600 uppercase 0.05em muted on --cp-bg-3, padding 10px 14px (loki-fleet.js:279-300) |
| NavItem | 8px 12px, radius 8px, 13px weight 500, text-2; hover --cp-hover; active accent text on --cp-accent-glow with a 3x16 px left accent bar (build-standalone.js:400-458) |
| GroupHead | 9.5px weight 600 uppercase 0.09em muted, padding 4px 12px 5px (:389-398); used for Today, Yesterday, Earlier |
| Timeline | vertical stage track (loki-session-timeline.js:328-400): a dot per stage colored by status, connector line --cp-border, label plus mono duration |
| Message | NEW thread item: 32 px gutter icon, serif-free body, mono meta line; expandable body (diff, evidence, receipt) using Card |
| Glass surface | sidebar: --cp-glass with backdrop-filter blur(16px) saturate(1.4), right border --cp-glass-border (:268-280) |
| EmptyState, Spinner, Toast, Dialog, Drawer, Kbd | unified-styles.js:836-880 for empty and spinner; others NEW on the same tokens |

Motion: page fade-in 0.2s translateY(6px) (build-standalone.js:925-940); respect prefers-reduced-motion.

## 3. Feature set and information architecture

### 3.1 Shell
- Sidebar (240 px, glass): wordmark plus mascot plus receipts Pill; "New run" primary button (Cmd+Enter submits, Cmd+N focuses); search field (opens Cmd+K); session list grouped Today, Yesterday, Earlier, each row = title (issue ref or first line of task), repo, StatusDot, verdict Badge; footer = Menu button (opens the menu sheet), theme toggle, connection dot.
- Menu sheet (progressive disclosure, like the Claude.ai account menu): Home, Runs, Work board, Workspaces, Plans, Receipts, Cost and usage, Models and providers, Integrations, Notifications, Audit log, Settings. Entries whose backend is missing are not listed.
- Main pane: composer (route /) or run thread (/r/:source/:run) or a menu page.

### 3.2 Pages (data backing; "BACKEND" names the slice that must land first)
| Page | Inspired by | Content | Data |
|---|---|---|---|
| New run composer | Claude.ai, Devin | One input "Paste an issue link or describe a task"; chips repo, model, provider, budget (max-cost), deep, no-pr; recent issues suggestions | BACKEND CPE-07 (start), CPE-15 (providers), CPE-03 (repos) |
| Run thread | Devin session | header (title, repo, verdict Badge, elapsed, cost, Stop, Retry, Resume); stage messages streaming; streaming log; diff; evidence and screenshots; receipt with sha256, signed flag, inline Verify; NOT PROVEN list; PR link; BLOCKED reply prompt; Details drawer | exists: /v1/runs/:s/:r, answer. BACKEND CPE-04 (artifacts), CPE-05 (stream), CPE-09 (control) |
| Home | Factory | KPI tiles: runs today, verified rate 7d, cost 7d (measured/partial), BLOCKED waiting; recent runs; BLOCKED inbox | BACKEND CPE-12 (/v1/stats) |
| Runs | Factory fleet | Table with filters verdict, repo, since, group; group_id rollup | exists: /v1/runs filters |
| Work board | Vorflux, Linear | Kanban: Issue (issue_ref) to Running to PR open to Verified or Not proven | exists: runs fields issue_ref, pr_url, verdict |
| Workspaces | Factory | loki.yaml workspaces, per-group status, run a workspace | BACKEND CPE-14 (config read), CPE-07 (start with workspace) |
| Plans and traceability | 8090 | requirement (issue.json, plan.json) to stage to changed file to test to receipt claim; NOT PROVEN highlighted | BACKEND CPE-04 |
| Receipts | trust.html | list, verify in place, verified-rate trend | BACKEND CPE-04, CPE-16 |
| Cost and usage | cost.html | per day, model, repo, provider; tokens; measured vs partial; budgets and "no cap" banner | BACKEND CPE-13 |
| Models and providers | session-control | detected CLIs with version, auth present (boolean only), model catalog, default model | BACKEND CPE-15 |
| Integrations | Vorflux | GitHub (gh auth or git.token_env present), GitLab, Slack (notifications.slack_webhook_env), Jira, Linear, Sentry, MCP: real probe status; connect = write the env var NAME into loki.yaml, never a secret | BACKEND CPE-20 |
| Notifications | legacy center | BLOCKED, FAILED, budget.hit, tampered, ingest conflict; unread state local | BACKEND CPE-21 (derived from events) |
| Audit log | enterprise | every UI action (start, stop, retry, resume, answer, config write) with time, actor, result | BACKEND CPE-03 (actions table) |
| Settings | Claude.ai settings | loki.yaml forms per schema section (provider, models, git, repos, concurrency, budgets, knowledge_sources, workspaces, notifications; schemas/loki-yaml.schema.json); appearance; server token | BACKEND CPE-14 |
| Merge queue, PR reviews with risk, Schedules and triggers | Vorflux | NOT BUILT: backends parked (BOARD.md D64-MERGE :725, D64-REVIEW :726, D64-SERVE :724). Hidden until those land; UI slices are cut then. | none today |
| Memory | Devin knowledge | NOT BUILT: no v10 memory read API (repomemory.ts is engine-internal). Hidden. | none today |
| Cmd+K, search | Linear | jump to run, page, action ("New run", "Toggle theme", "Stop current run") | client side over cached lists |
| Light/dark, mobile, accessibility | | data-theme toggle persisted (localStorage, try/catch), system default; drawer at < 768 px; WCAG AA contrast, focus rings, aria-live for streaming steps, full keyboard path | CPE-23 tests |

### 3.3 CLI-to-UI parity table (release gate for 10.8.0)
| CLI | UI control | API |
|---|---|---|
| `loki "<task>"` | composer input | POST /v1/runs (CPE-07) |
| `loki <issue-url or owner/repo#N>` | composer input (issue link detected) | POST /v1/runs |
| `--provider <name>` | provider chip | POST /v1/runs body.provider |
| model (loki.yaml models.default, LOKI_SESSION_MODEL) | model chip | POST /v1/runs body.model |
| `--max-cost <usd>` | budget chip | POST /v1/runs body.max_cost_usd |
| `--deep`, `--no-pr` | toggles in the composer "More" chip | POST /v1/runs body.deep, body.no_pr |
| `loki status [run-id]` | session list plus run thread | GET /v1/runs, GET /v1/runs/:s/:r |
| `loki answer <run>` | BLOCKED reply prompt, Resume | POST /v1/runs/:s/:r/answer (exists), POST .../resume (CPE-09) |
| Ctrl+C on a run | Stop | POST /v1/runs/:s/:r/stop (CPE-09) |
| re-run the same ref | Retry | POST /v1/runs/:s/:r/retry (CPE-09) |
| `loki verify [run-id or receipt.json]` | Verify button on receipt | POST /v1/runs/:s/:r/verify (CPE-16) |
| `loki keys export` | Receipts page "Public key" | GET /v1/keys (CPE-16) |
| `loki workspace list, show, run, status` | Workspaces page | GET /v1/config, POST /v1/runs body.workspace (CPE-19) |
| `loki config` (loki.yaml edit, validate) | Settings forms | GET, PUT /v1/config (CPE-14) |
| `loki provider` | Models and providers | GET /v1/providers (CPE-15) |
| `loki control` | (this UI) | n/a |
| `loki modernize <repo> --to <target>` | composer "Modernize" mode | DEFERRED: modernize does not emit v10 run events yet (open question 3) |
| `loki merge`, `loki review --risk`, `loki serve` schedules | none until built | DEFERRED with D64 backends |

## 4. API: what exists and what is new

Exists (packages/control-plane/src/server): GET /health, /ready; POST /v1/ingest; GET /v1/runs (verdict, repo, since, until, group_id, limit, cursor); GET /v1/runs/:source/:run and /v1/runs/:id (summary, stages, receipt sha256/signed/verdict/path, not_proven, blocked_question, current_stage, files_touched); POST /v1/runs/:source/:run/answer (app.ts:46-75, runs.ts, answer.ts). Guards: hostGuard (loopback), tokenGuard (bearer on /v1/*) (auth.ts). Store: SQLite via Drizzle, tables sources, events, runs (db/schema.ts). Shipper backfills and tails .loki/runs/*/events.jsonl (shipper/*). Run dir artifacts (engine10): events.jsonl, issue.json, plan.json, task.md, receipt.json, receipt.md, report.json, report.md, status.json, eta.json, estimate.json, failures.jsonl.

Gap: the server stores events only. Artifacts live in the local repo, and source_id is a hash (ship.ts:16-21), so the server cannot find the repo. CPE-03 adds a LOCAL-ONLY table local_repos (source_id, realpath) filled by local discovery, never by /v1/ingest, never returned over the API beyond a display name.

| New endpoint | Slice | Tier | Notes |
|---|---|---|---|
| GET /v1/runs/:s/:r/events?after=seq | CPE-04 | HIGH | paged events for the log |
| GET /v1/runs/:s/:r/artifact/:name | CPE-04 | HIGH | fixed allowlist of names (issue.json, plan.json, receipt.json, receipt.md, report.md, task.md, diff.patch, evidence/*.png); realpath must stay under <repo>/.loki/runs/<run>; size cap |
| GET /v1/runs/:s/:r/stream, GET /v1/stream | CPE-05 | MEDIUM | SSE of new events and run-row changes, heartbeat 15s |
| GET /v1/stats?since= | CPE-12 | MEDIUM | counts, verified rate, cost measured and partial, receipts count |
| GET /v1/stats/cost?group=day,model,repo,provider | CPE-13 | MEDIUM | from runs table |
| GET /v1/repos | CPE-03 | MEDIUM | display names of discovered local repos |
| POST /v1/runs | CPE-07 | HIGH | start: repo must be a local_repos entry; ref or task text validated; flags whitelisted; spawns `loki` with argv array (no shell), detached, env scrubbed to an allowlist; JSON content type plus Origin check; audit row |
| POST /v1/runs/:s/:r/stop, /retry, /resume | CPE-09 | HIGH | stop signals only the pid recorded in <run>/run.pid whose start time and run id match; retry re-uses the recorded argv; resume = existing answer file plus `loki answer <run>` spawn; audit row |
| GET /v1/config, PUT /v1/config | CPE-14 | HIGH | read and validate against schemas/loki-yaml.schema.json; write atomic (temp plus rename), comment-preserving (adopt the `yaml` package Document API), backup to loki.yaml.bak, optimistic concurrency via sha256 If-Match; secrets refused (env var names only) |
| GET /v1/providers | CPE-15 | MEDIUM | CLI detection with timeout, versions, auth present boolean, providers/model_catalog.json |
| POST /v1/runs/:s/:r/verify, GET /v1/keys | CPE-16 | MEDIUM | calls the existing verify_cmd and keys_cmd in process, read-only |
| GET /v1/integrations | CPE-20 | MEDIUM | status probes only |
| GET /v1/notifications | CPE-21 | LOW | derived query over events |
| GET /v1/audit | CPE-21 | LOW | actions table, newest first |

Every mutating endpoint: requires the bearer token when the server is not loopback-only, refuses non-JSON bodies, checks Origin against the served host, writes an audit row before acting, and returns the resulting state for optimistic reconciliation.

## 5. Parity checklist (gate for CPE-24)
1. Every row of section 1 marked KEEP or REWORK has its v10 home rendered on real data, proven by a UI test with a fixture run.
2. Every row of section 3.3 not marked DEFERRED works end to end in tests/e2e (start a fixture run, stream, BLOCKED answer, stop, retry, verify, config write).
3. Visual parity: screenshots of wordmark, nav, card, KPI, badge, table in light and dark compared against legacy captures (CPE-23).
4. No route under the old dashboard is reachable except the CP-LEGACY redirects (7b701d238).
5. Lighthouse accessibility at or above 95 on composer, thread, Home; axe zero serious violations.

## 6. STEP 2 slice plan

Rules: one writer per file; UI pages register through ui/src/pages/registry.ts and server routes through src/server/routes/index.ts, both CREATED with stubs for every planned page and route by CPE-02 and CPE-03, so later slices only fill their own stub files. Wall checks run from packages/control-plane. HIGH = opus D12 review.

| ID | Goal | File set | Wall check | Depends | Tier |
|---|---|---|---|---|---|
| CPE-01 | Design token package: tokens.css, fonts.css, tailwind.preset.ts, primitives (Card, KpiTile, Badge, Pill, StatusDot, Button, Input, Chip, Table, NavItem, GroupHead, Timeline, Message, EmptyState, Spinner, Toast, Dialog, Drawer, Kbd) | ui/src/design/**, ui/tailwind.config.js, test/ui/design.test.tsx | `bun test test/ui/design.test.tsx` (every token in 2.1 present in both themes; hex values match the cited sources; primitives render) | none | MEDIUM |
| CPE-02 | Lean shell: glass sidebar with wordmark, mascot, receipts Pill, New run, grouped session list, Menu sheet, theme toggle, mobile drawer; client router; page registry with stubs | ui/src/App.tsx, ui/src/shell/**, ui/src/pages/registry.ts, ui/src/pages/*/index.tsx (stubs), ui/src/main.tsx, ui/src/index.css, test/ui/shell.test.tsx | `bun test test/ui/shell.test.tsx` (Today, Yesterday, Earlier grouping from fixture; hidden entries for stub pages) | 01 | MEDIUM |
| CPE-03 | Server scaffold: routes/index.ts with stub modules, schema tables local_repos and actions plus migration, audit helper, local discovery fills local_repos, GET /v1/repos | src/server/routes/index.ts, src/server/routes/*.ts (stubs), src/server/audit.ts, src/server/repos.ts, src/db/schema.ts, drizzle/**, src/server/app.ts, src/shipper/discover.ts, test/server/scaffold.test.ts | `bun test test/server/scaffold.test.ts` (ingest never writes local_repos; /v1/repos returns names only) | none | MEDIUM |
| CPE-04 | Run artifacts read API: events page, artifact allowlist, path containment | src/server/routes/artifacts.ts, test/server/artifacts.test.ts | `bun test test/server/artifacts.test.ts` (traversal, symlink escape, oversize, unknown name all refused) | 03 | HIGH |
| CPE-05 | SSE stream for one run and for the runs list | src/server/routes/stream.ts, test/server/stream.test.ts | `bun test test/server/stream.test.ts` | 03 | MEDIUM |
| CPE-06 | Run thread view: stage messages, live log, diff, evidence, receipt, NOT PROVEN, cost, PR, BLOCKED reply prompt, Details drawer; replaces Live.tsx | ui/src/pages/run/**, ui/src/Live.tsx (delete), test/ui/run.test.tsx | `bun test test/ui/run.test.tsx` (fixture run renders every section; missing cost shows "not measured") | 02, 04, 05 | MEDIUM |
| CPE-07 | Start-run endpoint POST /v1/runs | src/server/routes/start.ts, src/server/spawn.ts, test/server/start.test.ts | `bun test test/server/start.test.ts` (unknown repo, shell metacharacters, unknown flag, missing token, bad Origin all refused; argv exact) | 03 | HIGH |
| CPE-08 | New run composer: one input, chips, Cmd+Enter, optimistic session row, empty state | ui/src/pages/compose/**, test/ui/compose.test.tsx | `bun test test/ui/compose.test.tsx` | 02, 07 | MEDIUM |
| CPE-09 | Run control: supervisor writes <run>/run.pid (pid, start time, argv); stop, retry, resume endpoints | loki-ts/src/util/run_pid.ts, loki-ts/src/engine10/supervisor.ts, src/server/routes/control.ts, test/server/control.test.ts, loki-ts/tests/engine10/run_pid.test.ts | `bun test test/server/control.test.ts` and `cd loki-ts && bun test tests/engine10/run_pid.test.ts` (stale pid, reused pid, other run's pid refused) | 03 | HIGH |
| CPE-10 | Run control UI: Stop (confirm), Retry, Resume with optimistic state and rollback | ui/src/pages/run-controls/** (mounted in the run header slot CPE-06 provides), test/ui/controls.test.tsx | `bun test test/ui/controls.test.tsx` | 06, 09 | LOW |
| CPE-11 | Runs table page with filters and group rollup | ui/src/pages/runs/**, test/ui/runs.test.tsx | `bun test test/ui/runs.test.tsx` | 02 | LOW |
| CPE-12 | Home: /v1/stats plus KPI tiles, recent runs, BLOCKED inbox | src/server/routes/stats.ts, ui/src/pages/home/**, test/server/stats.test.ts, test/ui/home.test.tsx | `bun test test/server/stats.test.ts test/ui/home.test.tsx` (numbers equal a hand-folded fixture) | 02, 03 | MEDIUM |
| CPE-13 | Cost and usage: /v1/stats/cost plus page with measured vs partial and budget banner | src/server/routes/cost.ts, ui/src/pages/cost/**, test/server/cost.test.ts, test/ui/cost.test.tsx | `bun test test/server/cost.test.ts test/ui/cost.test.tsx` | 02, 03 | MEDIUM |
| CPE-14 | Settings: GET, PUT /v1/config with schema validation, comment-preserving atomic write, If-Match; forms per schema section | src/server/routes/config.ts, ui/src/pages/settings/**, package.json (yaml dep), test/server/config.test.ts, test/ui/settings.test.tsx | `bun test test/server/config.test.ts` (comments survive round trip; invalid rejected; stale If-Match 409; secret-looking value refused) | 02, 03 | HIGH |
| CPE-15 | Models and providers: /v1/providers plus page | src/server/routes/providers.ts, ui/src/pages/models/**, test/server/providers.test.ts | `bun test test/server/providers.test.ts` (probe timeout honored; no secret value returned) | 02, 03 | MEDIUM |
| CPE-16 | Receipts: list, in-place verify, public key, verified-rate trend | src/server/routes/verify.ts, ui/src/pages/receipts/**, test/server/verify.test.ts | `bun test test/server/verify.test.ts` (tampered fixture fails verify) | 04 | MEDIUM |
| CPE-17 | Plans and traceability matrix from issue.json, plan.json, stages, files, receipt | ui/src/pages/plans/**, test/ui/plans.test.tsx | `bun test test/ui/plans.test.tsx` | 04 | MEDIUM |
| CPE-18 | Work board kanban from runs (issue to running to PR to verified or not proven) | ui/src/pages/board/**, test/ui/board.test.tsx | `bun test test/ui/board.test.tsx` | 02 | LOW |
| CPE-19 | Workspaces page: list from config, group status, run a workspace via POST /v1/runs body.workspace | ui/src/pages/workspaces/**, test/ui/workspaces.test.tsx | `bun test test/ui/workspaces.test.tsx` | 07, 14 | MEDIUM |
| CPE-20 | Integrations: /v1/integrations status probes plus page; connect writes env var names through /v1/config | src/server/routes/integrations.ts, ui/src/pages/integrations/**, test/server/integrations.test.ts | `bun test test/server/integrations.test.ts` | 14 | MEDIUM |
| CPE-21 | Notifications and Audit log: derived notifications, actions view | src/server/routes/notify.ts, src/server/routes/audit.ts, ui/src/pages/notifications/**, ui/src/pages/audit/**, test/server/notify.test.ts | `bun test test/server/notify.test.ts` | 03 | LOW |
| CPE-22 | Cmd+K palette, global search, shortcuts (Cmd+Enter, Cmd+N, Cmd+Shift+D, Esc) | ui/src/palette/**, test/ui/palette.test.tsx | `bun test test/ui/palette.test.tsx` | 02 | LOW |
| CPE-23 | Accessibility, mobile and visual parity: axe, keyboard path, 375 px layout, light and dark screenshot comparison to legacy captures | test/e2e/cp-ui.spec.ts, test/e2e/legacy-baseline/**, ui/playwright.config.ts | `bunx playwright test test/e2e/cp-ui.spec.ts` (headless, LOKI_NO_BROWSER=1) | 06, 08, 12 | MEDIUM |
| CPE-24 | Delete legacy dashboard at parity: legacy-ui/, legacy-ui-static/, legacy server routes, their tests and package entries | legacy-ui/**, legacy-ui-static/**, dashboard/server.py (UI routes), package.json files list, tests naming them | section 5 checklist all green plus `bash scripts/local-ci.sh` | all, section 5 | MEDIUM |

Parallelism: CPE-01 and CPE-03 start at once; after them up to 12 builders run in parallel (04, 05, 07, 09, 11, 12, 13, 14, 15, 18, 21, 22). HIGH slices (04, 07, 09, 14) carry the security review the founder asked for.

## 7. Open questions
1. Ground color: the shell's light-grey #F1F2F6 (founder-approved per build-standalone.js:113) or the components' warm cream #FFFEFB with midnight-purple dark #1A0F2E (unified-styles.js:24, :88)? This spec picks the shell; one screenshot pair for Loki settles it.
2. Mascot: keep it beside the wordmark (it was part of the old look) or drop it for a cleaner Claude.ai-like header?
3. Modernize, merge queue, PR risk review, schedules and memory have no v10 run events or API today. They stay hidden in 10.8.0 and get UI slices when their backends land; confirm that is acceptable for "no feature is CLI-only".
