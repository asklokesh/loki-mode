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

Shell: dashboard-ui/scripts/build-standalone.js (generates dashboard/static/index.html). Nav groups at build-standalone.js:1266-1347 (Build, Quality and Trust, Insights, Ops, Wiki). Pages at :1358-1882. RARV, Council, gates, checkpoints and app runner are legacy engine concepts with no v10 producer (docs/v10/LEGACY-REMOVAL.md:36-37), so they DROP or remap to v10 stages (events stage.started/completed/failed/skipped, loki-ts/src/engine10/status.ts:9).

| Legacy page or control | Source | Decision | v10 home |
|---|---|---|---|
| Overview (spec, tasks, RARV timeline, diff) | components/loki-overview.js, loki-spec-panel.js, loki-rarv-timeline.js, loki-session-diff.js, loki-task-board.js; build-standalone.js:1358-1415 | REWORK | Home (KPI row, recent runs, BLOCKED inbox). RARV timeline becomes the v10 stage timeline in the run thread. Task board DROP (no v10 task queue). Diff KEEP inside the run thread. |
| First-run hero ("loki quickstart") | build-standalone.js:1365-1387 | REWORK | Empty state of the New run composer (one action: paste an issue). |
| App Runner | loki-app-preview.js, loki-app-status.js (/api/app-runner/*) | DROP | Screenshots and evidence in the run thread replace it. |
| Checkpoints | loki-checkpoint-viewer.js (/api/checkpoints, rollback) | DROP | No v10 checkpoints; rollback deleted (LEGACY-REMOVAL.md:37). |
| Context | loki-context-tracker.js (/api/context) | DROP | Token counts per run (input_tokens, output_tokens) shown in the run cost card. |
| Fleet | loki-fleet.js (/api/fleet/*) | REWORK | Runs table (all repos, filters, group_id rollup). Its table styling is the Table primitive. |
| Quality (score, gates, prompt optimizer) | loki-quality-score.js, loki-quality-gates.js, loki-prompt-optimizer.js | DROP | v10 verify stage plus NOT PROVEN list in the run thread. |
| Trust trajectory and receipts panel | dashboard/static/trust.html, proofs.html; build-standalone.js:1811-1828 | KEEP on v10 data | Receipts page (list, inline verify, verified-rate trend from runs). |
| Completion Council | loki-council-dashboard.js, loki-council-transcripts.js | DROP | Remapped: the v10 verify stage and receipt verdict. |
| Spec Checklist | loki-checklist-viewer.js (/api/checklist) | REWORK | Plans and traceability (plan.json, issue.json, receipt claims). |
| Insights: logs | loki-log-stream.js (/api/logs) | KEEP | Streaming log inside the run thread (events.jsonl). |
| Insights: memory, learnings, USAGE.md | loki-memory-browser.js, loki-learning-dashboard.js; build-standalone.js:1427-1590 | DROP now | Memory page deferred until a v10 memory read API exists (section 3.2). USAGE.md becomes a Help link. |
| Analytics | loki-analytics.js (/api/activity) | REWORK | Home trends (runs per day, verified rate) from the runs table. |
| Cost | loki-cost-dashboard.js, loki-cost-waterfall.js, dashboard/static/cost.html; spend-cap banner build-standalone.js:1800-1806 | KEEP on v10 data | Cost and usage page; the "no cap" banner is kept and fed by loki.yaml budgets. |
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
| Onboarding (start.html) | dashboard/static/start.html (/api/onboarding/*, /api/backlog/*) | REWORK | Integrations page (GitHub connect status) plus the composer empty state. |

## 2. Design system (extracted, binding)

Two legacy layers exist and disagree on ground colors. The SHELL layer in build-standalone.js:113-185 is documented as the founder-approved identity (light-grey ground, comment at :113) and is what users saw around every page; the COMPONENT layer in dashboard-ui/core/loki-unified-styles.js:20-146 (also loki-theme.js:44-124) supplies the scales, status colors and component specs. Decision: shell ground and accent per theme from the shell layer; scales, radii, shadows, model colors and component recipes from the component layer. (Open question 1.)

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

## 5. Legacy integration contract (gate for CPE-24)

The legacy dashboard (dashboard/server.py, port 57374, 13194 lines) serves 234 routes (method and path entries after dropping HEAD; routers api_v2 at /api/v2, api_operator at /api/operator, api_start, api_runs_v1 at /api/v1/runs, the /lab and /assets mounts, WS /ws and /ws/collab). Deleting it (CPE-24) must not break a real integration. This section is the contract: one row per route, what consumes it, what the Control Plane offers, and what the shim at packages/control-plane/src/server/legacy/ does with it.

Method. Route list: FastAPI introspection of `dashboard.server.app` (the 234 entries). Consumers: a repo-wide text scan of git-tracked files, then each used route's consumer lines were read by hand. Counted as a consumer: the TypeScript and Python SDKs, vscode-extension (src and the bundled media/loki-dashboard.js webview), autonomy/loki and autonomy/run.sh, web-app, .github/workflows, tests/moat, tests/e2e, tests/integration, scripts/run-dashboard-* (marked "(test)" when a test). Not counted: dashboard/ itself, dashboard-ui/ (the legacy UI is deleted with the server), docs, generated maps, packages/control-plane. The scan matches path text, so single-segment paths (/start, /cost, /trust, /) were checked by hand: every hit was `loki start`, `/api/cost` or `/lab/api/cost`, none a request to that HTML route. Limits: a path built at runtime from parts is invisible to a text scan, and an HTTP verb is inferred from the nearby call text, so a verb on a bundled-JS row is best effort. A route with a consumer is USED, otherwise UNUSED.

Status values: EXISTS (the CP serves it today), PARTIAL (the shim maps it and says what differs), MISSING (a USED route the CP has no data or mechanism for), UNUSED (no consumer). Shim actions: map (answer from CP data), 308 to CP UI (HTML page), 410 with notice (UNUSED, retired), 501 not yet supported (USED but no CP data or mechanism: the shim answers an explicit 501, never a faked success), none (the CP already serves the path).

Counts: map 6, 308 5, 501 77, 410 142, none 4; total 234.

Auth contract (never looser than legacy). Legacy `require_scope` is open when LOKI_ENTERPRISE_AUTH and OIDC are both off, and otherwise answers 401 without a token and 403 on a missing scope. Open in every mode: /health, /.well-known/agent.json, /api/enterprise/status, /api/auth/info, /api/providers/models, /metrics, the docs routes. The shim applies one rule to every route the legacy server guarded: if LOKI_CONTROL_TOKEN is set, require the CP bearer token (401 with www-authenticate otherwise); if no CP token is set but legacy enterprise auth or OIDC is enabled in the environment, fail closed with 401 (the CP has no way to check the legacy `loki_*` tokens); if neither is set, open, matching the legacy default. The CP token carries every scope, which is safe because the shim exposes only read routes and answers 501 or 410 for the rest. 501 and 410 answers are also behind the guard, so an unauthenticated caller learns nothing about a guarded route. The shim never binds a port; mounting it on the CP app keeps hostGuard and the loopback-only action routes exactly as they are.

First hit per process, each route logs one line: `legacy dashboard route <path> is served by the Control Plane; migrate to /v1/...` (mapped and 308 routes). A 501 or 410 route logs the same single line in the words "is not served by the Control Plane (501)" or "is retired (410)".

### 5.1 Parity checklist (gate for CPE-24)
1. Every row of section 1 marked KEEP or REWORK has its v10 home rendered on real data, proven by a UI test with a fixture run.
2. Every row of section 3.3 not marked DEFERRED works end to end in tests/e2e (start a fixture run, stream, BLOCKED answer, stop, retry, verify, config write).
3. Visual parity: screenshots of wordmark, nav, card, KPI, badge, table in light and dark compared against legacy captures (CPE-23).
4. No route under the old dashboard is reachable except the CP-LEGACY redirects (7b701d238).
5. Lighthouse accessibility at or above 95 on composer, thread, Home; axe zero serious violations.


### 5.2 Route contract

| Method and path | Consumers (verified file:line) | CP /v1 equivalent | Status | Shim action |
|---|---|---|---|---|
| GET `/openapi.json` | none | none | UNUSED | 410 with notice |
| GET `/docs` | none | none | UNUSED | 410 with notice |
| GET `/docs/oauth2-redirect` | none | none | UNUSED | 410 with notice |
| GET `/redoc` | none | none | UNUSED | 410 with notice |
| POST `/api/v2/tenants` | sdk/python/loki_mode_sdk/client.py:204, sdk/typescript/src/client.ts:237 | none | MISSING | 501 not yet supported |
| GET `/api/v2/tenants` | sdk/python/loki_mode_sdk/client.py:191, sdk/typescript/src/client.ts:225 | none | MISSING | 501 not yet supported |
| GET `/api/v2/tenants/{tenant_id}` | sdk/typescript/src/client.ts:229 | none | MISSING | 501 not yet supported |
| PUT `/api/v2/tenants/{tenant_id}` | none | none | UNUSED | 410 with notice |
| DELETE `/api/v2/tenants/{tenant_id}` | sdk/typescript/src/client.ts:241 | none | MISSING | 501 not yet supported |
| GET `/api/v2/tenants/{tenant_id}/projects` | none | none | UNUSED | 410 with notice |
| POST `/api/v2/runs` | vscode-extension/media/loki-dashboard.js:9617 | none | MISSING | 501 not yet supported |
| GET `/api/v2/runs` | sdk/python/loki_mode_sdk/client.py:220, sdk/typescript/src/client.ts:201 | /v1/runs | PARTIAL (ids are source:run strings, not ints; no project_id filter; status maps to running/completed; limit/offset map to limit/cursor) | map |
| GET `/api/v2/runs/{run_id}` | sdk/python/loki_mode_sdk/client.py:228, sdk/typescript/src/client.ts:205 | /v1/runs/:id | PARTIAL (run_id is source:run (URL-encoded) or a bare run id; legacy integer ids answer 404) | map |
| POST `/api/v2/runs/{run_id}/cancel` | sdk/python/loki_mode_sdk/client.py:233, sdk/typescript/src/client.ts:209, vscode-extension/media/loki-dashboard.js:9617 | none | MISSING | 501 not yet supported |
| POST `/api/v2/runs/{run_id}/replay` | sdk/python/loki_mode_sdk/client.py:238, sdk/typescript/src/client.ts:213, vscode-extension/media/loki-dashboard.js:9617 | none | MISSING | 501 not yet supported |
| GET `/api/v2/runs/{run_id}/timeline` | sdk/python/loki_mode_sdk/client.py:243, sdk/typescript/src/client.ts:217, vscode-extension/media/loki-dashboard.js:9255 | /v1/runs/:id (stages, events) | PARTIAL (phases are CP stages; events carry seq, ts, type, stage only) | map |
| POST `/api/v2/api-keys` | sdk/python/loki_mode_sdk/client.py:263, sdk/typescript/src/client.ts:178, vscode-extension/media/loki-dashboard.js:10097 | none | MISSING | 501 not yet supported |
| GET `/api/v2/api-keys` | sdk/python/loki_mode_sdk/client.py:253, sdk/typescript/src/client.ts:170 | none | MISSING | 501 not yet supported |
| GET `/api/v2/api-keys/{identifier}` | none | none | UNUSED | 410 with notice |
| PUT `/api/v2/api-keys/{identifier}` | none | none | UNUSED | 410 with notice |
| DELETE `/api/v2/api-keys/{identifier}` | sdk/typescript/src/client.ts:190, vscode-extension/media/loki-dashboard.js:10097 | none | MISSING | 501 not yet supported |
| POST `/api/v2/api-keys/{identifier}/rotate` | sdk/python/loki_mode_sdk/client.py:271, sdk/typescript/src/client.ts:186, vscode-extension/media/loki-dashboard.js:10097 | none | MISSING | 501 not yet supported |
| GET `/api/v2/policies` | none | none | UNUSED | 410 with notice |
| PUT `/api/v2/policies` | none | none | UNUSED | 410 with notice |
| POST `/api/v2/policies/evaluate` | none | none | UNUSED | 410 with notice |
| GET `/api/v2/audit` | sdk/python/loki_mode_sdk/client.py:293, sdk/typescript/src/client.ts:254, vscode-extension/media/loki-dashboard.js:9813 | /v1/audit (added by the shim) | PARTIAL (CP audit is an operator-action log (run removal, prune), not the legacy hash-chained log; resource_type filter answers 400) | map |
| GET `/api/v2/audit/verify` | tests/moat/p2-honest-verdict.sh:1162 (test), tests/moat/p2-honest-verdict.sh:1258 (test), vscode-extension/media/loki-dashboard.js:9813 | none | MISSING | 501 not yet supported |
| GET `/api/v2/audit/export` | none | /v1/audit | UNUSED | 410 with notice |
| GET `/api/operator/runs/{run_id}` | none | /v1/runs/:id | UNUSED | 410 with notice |
| GET `/api/operator/tests` | none | none | UNUSED | 410 with notice |
| GET `/api/operator/receipts` | none | none | UNUSED | 410 with notice |
| GET `/api/operator/releases` | none | none | UNUSED | 410 with notice |
| GET `/api/operator/phases` | none | none | UNUSED | 410 with notice |
| GET `/api/operator/workspaces/runs` | none | none | UNUSED | 410 with notice |
| GET `/api/operator/workspaces/runs/{ws}/{run_id}` | none | none | UNUSED | 410 with notice |
| GET `/api/onboarding/state` | none | none | UNUSED | 410 with notice |
| POST `/api/onboarding/provider` | none | none | UNUSED | 410 with notice |
| POST `/api/onboarding/github` | none | none | UNUSED | 410 with notice |
| GET `/api/onboarding/repos` | none | none | UNUSED | 410 with notice |
| POST `/api/onboarding/repo` | none | none | UNUSED | 410 with notice |
| GET `/api/backlog/issues` | none | none | UNUSED | 410 with notice |
| POST `/api/backlog/run` | none | none | UNUSED | 410 with notice |
| GET `/api/backlog/status` | none | none | UNUSED | 410 with notice |
| GET `/api/v1/runs` | none | /v1/runs | UNUSED | 410 with notice |
| GET `/api/v1/runs/{run_id}` | none | /v1/runs/:id | UNUSED | 410 with notice |
| POST `/api/v1/runs` | none | /v1/runs | UNUSED | 410 with notice |
| POST `/api/v1/runs/{run_id}/stop` | none | none | UNUSED | 410 with notice |
| GET `/start` | none | CP UI (/) | EXISTS | 308 to CP UI |
| MOUNT `/lab` | none | CP UI (/) | EXISTS | 308 to CP UI |
| GET `/health` | autonomy/loki:1929, autonomy/loki:7760, autonomy/run.sh:19293 (+10) | /health | EXISTS (CP /health answers {service, pid, install_path}, not the legacy body; CLI discovery relies on that identity, so the shim never overrides it) | none (CP /health serves) |
| GET `/api/providers/models` | none | none | UNUSED | 410 with notice |
| GET `/.well-known/agent.json` | .github/workflows/integrity-audit.yml:114, .github/workflows/integrity-audit.yml:115 | none (static card) | PARTIAL (static card from shim constants; capabilities the CP cannot back (streaming, enterprise rbac/multi-tenant) are false) | map |
| GET `/api/status` | autonomy/loki:15601, autonomy/run.sh:19357, autonomy/run.sh:19541 (+10) | /v1/runs (derived) | PARTIAL (status, version, uptime, active_sessions, phase, provider only; no running_agents, pending_tasks, iteration, complexity, mode, current_task (CP has no such data, fields omitted)) | map |
| GET `/api/projects` | sdk/python/loki_mode_sdk/client.py:166, sdk/typescript/src/client.ts:127, tests/moat/p7-no-fabricated-data.sh:446 (test) | none | MISSING | 501 not yet supported |
| POST `/api/projects` | sdk/python/loki_mode_sdk/client.py:184, sdk/typescript/src/client.ts:139, tests/moat/p7-no-fabricated-data.sh:437 (test) (+1) | none | MISSING | 501 not yet supported |
| GET `/api/projects/{project_id}` | sdk/python/loki_mode_sdk/client.py:174, sdk/typescript/src/client.ts:131 | none | MISSING | 501 not yet supported |
| PUT `/api/projects/{project_id}` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| DELETE `/api/projects/{project_id}` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/tasks` | sdk/python/loki_mode_sdk/tasks.py:30, sdk/typescript/src/client.ts:150 | none | MISSING | 501 not yet supported |
| POST `/api/tasks` | sdk/python/loki_mode_sdk/tasks.py:56, sdk/typescript/src/client.ts:162, vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/tasks/{task_id}` | sdk/python/loki_mode_sdk/tasks.py:38, sdk/typescript/src/client.ts:154, vscode-extension/src/views/dashboardWebview.ts:168 | none | MISSING | 501 not yet supported |
| PUT `/api/tasks/{task_id}` | sdk/python/loki_mode_sdk/tasks.py:71, vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| DELETE `/api/tasks/{task_id}` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| POST `/api/tasks/{task_id}/move` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| WS `/ws` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/registry/projects` | none | none | UNUSED | 410 with notice |
| POST `/api/registry/projects` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/registry/projects/{identifier}` | none | none | UNUSED | 410 with notice |
| DELETE `/api/registry/projects/{identifier}` | none | none | UNUSED | 410 with notice |
| GET `/api/registry/projects/{identifier}/health` | none | none | UNUSED | 410 with notice |
| POST `/api/registry/projects/{identifier}/access` | none | none | UNUSED | 410 with notice |
| GET `/api/registry/discover` | none | none | UNUSED | 410 with notice |
| POST `/api/registry/sync` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/registry/tasks` | none | none | UNUSED | 410 with notice |
| GET `/api/registry/learnings` | none | none | UNUSED | 410 with notice |
| GET `/api/fleet/runs` | tests/moat/p7-no-fabricated-data.sh:4637 (test), tests/moat/p7-no-fabricated-data.sh:4706 (test), tests/moat/p7-no-fabricated-data.sh:4710 (test) (+1) | none | MISSING | 501 not yet supported |
| GET `/api/fleet/summary` | tests/moat/p7-no-fabricated-data.sh:4637 (test), tests/moat/p7-no-fabricated-data.sh:4695 (test), tests/moat/p7-no-fabricated-data.sh:4696 (test) (+1) | none | MISSING | 501 not yet supported |
| GET `/api/fleet/runs/{identifier}` | none | none | UNUSED | 410 with notice |
| POST `/api/focus` | autonomy/run.sh:24831, web-app/server.py:2744 | none | MISSING | 501 not yet supported |
| GET `/api/focus` | none | none | UNUSED | 410 with notice |
| DELETE `/api/focus` | none | none | UNUSED | 410 with notice |
| GET `/api/session/model` | none | none | UNUSED | 410 with notice |
| POST `/api/session/model` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/running-projects` | none | none | UNUSED | 410 with notice |
| POST `/api/control/start` | vscode-extension/media/loki-dashboard.js:496, vscode-extension/src/api/client.ts:257, vscode-extension/src/extension.ts:580 | none | MISSING | 501 not yet supported |
| GET `/api/control/builds/{execution_id}` | none | none | UNUSED | 410 with notice |
| GET `/api/control/builds/{execution_id}/proof` | none | none | UNUSED | 410 with notice |
| POST `/api/control/builds/{execution_id}/stop` | none | none | UNUSED | 410 with notice |
| POST `/api/running-projects/stop` | none | none | UNUSED | 410 with notice |
| POST `/api/fleet/runs/{identifier}/retry` | none | none | UNUSED | 410 with notice |
| POST `/api/fleet/runs/{identifier}/cancel` | none | none | UNUSED | 410 with notice |
| GET `/api/enterprise/status` | none | none | UNUSED | 410 with notice |
| GET `/api/auth/info` | none | none | UNUSED | 410 with notice |
| POST `/api/enterprise/tokens` | none | none | UNUSED | 410 with notice |
| GET `/api/enterprise/tokens` | none | none | UNUSED | 410 with notice |
| DELETE `/api/enterprise/tokens/{identifier}` | none | none | UNUSED | 410 with notice |
| GET `/api/enterprise/audit` | none | none | UNUSED | 410 with notice |
| GET `/api/enterprise/audit/summary` | none | none | UNUSED | 410 with notice |
| GET `/api/compliance` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/summary` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/episodes` | vscode-extension/src/views/memoryViewProvider.ts:152 | none | MISSING | 501 not yet supported |
| GET `/api/memory/episodes/{episode_id}` | vscode-extension/src/views/dashboardWebview.ts:204, vscode-extension/src/views/memoryViewProvider.ts:215 | none | MISSING | 501 not yet supported |
| GET `/api/memory/patterns` | vscode-extension/src/views/memoryViewProvider.ts:151 | none | MISSING | 501 not yet supported |
| GET `/api/memory/patterns/{pattern_id}` | vscode-extension/src/views/dashboardWebview.ts:186, vscode-extension/src/views/memoryViewProvider.ts:197 | none | MISSING | 501 not yet supported |
| GET `/api/memory/skills` | vscode-extension/src/views/memoryViewProvider.ts:153 | none | MISSING | 501 not yet supported |
| GET `/api/memory/skills/{skill_id}` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/economics` | tests/moat/p7-no-fabricated-data.sh:4638 (test), tests/moat/p7-no-fabricated-data.sh:4749 (test), tests/moat/p7-no-fabricated-data.sh:4750 (test) (+2) | none | MISSING | 501 not yet supported |
| POST `/api/memory/consolidate` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| POST `/api/memory/retrieve` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/memory/index` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/timeline` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/files` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/file` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/search` | none | none | UNUSED | 410 with notice |
| GET `/api/memory/stats` | none | none | UNUSED | 410 with notice |
| GET `/api/learning/metrics` | tests/moat/p7-no-fabricated-data.sh:4638 (test), tests/moat/p7-no-fabricated-data.sh:4752 (test) | none | MISSING | 501 not yet supported |
| GET `/api/learning/trends` | none | none | UNUSED | 410 with notice |
| GET `/api/learning/signals` | none | none | UNUSED | 410 with notice |
| GET `/api/learning/aggregation` | none | none | UNUSED | 410 with notice |
| POST `/api/learning/aggregate` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/learning/preferences` | none | none | UNUSED | 410 with notice |
| GET `/api/learning/errors` | none | none | UNUSED | 410 with notice |
| GET `/api/learning/success` | none | none | UNUSED | 410 with notice |
| GET `/api/learning/tools` | none | none | UNUSED | 410 with notice |
| POST `/api/control/pause` | vscode-extension/media/loki-dashboard.js:496, vscode-extension/src/api/client.ts:277, vscode-extension/src/extension.ts:703 | none | MISSING | 501 not yet supported |
| POST `/api/control/resume` | vscode-extension/media/loki-dashboard.js:496, vscode-extension/src/api/client.ts:285, vscode-extension/src/extension.ts:743 | none | MISSING | 501 not yet supported |
| POST `/api/control/stop` | vscode-extension/media/loki-dashboard.js:496, vscode-extension/src/api/client.ts:269, vscode-extension/src/extension.ts:651 | none | MISSING | 501 not yet supported |
| GET `/api/cost` | tests/moat/p7-no-fabricated-data.sh:4637 (test), tests/moat/p7-no-fabricated-data.sh:4646 (test), tests/moat/p7-no-fabricated-data.sh:4647 (test) (+3) | none | MISSING | 501 not yet supported |
| GET `/api/budget` | tests/e2e/dashboard-evidence-panels.mjs:73 (test), tests/moat/p7-no-fabricated-data.sh:4637 (test), tests/moat/p7-no-fabricated-data.sh:4650 (test) (+3) | none | MISSING | 501 not yet supported |
| GET `/api/cost/timeline` | tests/moat/p7-no-fabricated-data.sh:4637 (test), tests/moat/p7-no-fabricated-data.sh:4652 (test), tests/moat/p7-no-fabricated-data.sh:4653 (test) (+15) | none | MISSING | 501 not yet supported |
| GET `/api/trust/trajectory` | none | none | UNUSED | 410 with notice |
| GET `/api/gate-policy` | none | none | UNUSED | 410 with notice |
| GET `/api/pricing` | none | none | UNUSED | 410 with notice |
| GET `/api/council/state` | none | none | UNUSED | 410 with notice |
| GET `/api/council/verdicts` | none | none | UNUSED | 410 with notice |
| GET `/api/council/convergence` | none | none | UNUSED | 410 with notice |
| GET `/api/council/report` | none | none | UNUSED | 410 with notice |
| POST `/api/council/force-review` | vscode-extension/media/loki-dashboard.js:496, vscode-extension/media/loki-dashboard.js:4312 | none | MISSING | 501 not yet supported |
| GET `/api/council/transcripts` | vscode-extension/media/loki-dashboard.js:12426 | none | MISSING | 501 not yet supported |
| GET `/api/council/transcripts/{iteration_id}` | none | none | UNUSED | 410 with notice |
| GET `/api/context` | tests/moat/p7-no-fabricated-data.sh:4638 (test), tests/moat/p7-no-fabricated-data.sh:4745 (test), tests/moat/p7-no-fabricated-data.sh:4746 (test) (+3) | none | MISSING | 501 not yet supported |
| GET `/api/notifications` | none | none | UNUSED | 410 with notice |
| GET `/api/notifications/triggers` | none | none | UNUSED | 410 with notice |
| PUT `/api/notifications/triggers` | vscode-extension/media/loki-dashboard.js:496, vscode-extension/media/loki-dashboard.js:6802 | none | MISSING | 501 not yet supported |
| POST `/api/notifications/{notification_id}/acknowledge` | none | none | UNUSED | 410 with notice |
| POST `/api/notifications/{notification_id}/unacknowledge` | none | none | UNUSED | 410 with notice |
| GET `/api/checkpoints` | vscode-extension/src/views/checkpointProvider.ts:108, vscode-extension/src/views/checkpointProvider.ts:134 | none | MISSING | 501 not yet supported |
| GET `/api/checkpoints/{checkpoint_id}` | none | none | UNUSED | 410 with notice |
| POST `/api/checkpoints` | vscode-extension/media/loki-dashboard.js:5960 | none | MISSING | 501 not yet supported |
| POST `/api/checkpoints/{checkpoint_id}/rollback` | vscode-extension/media/loki-dashboard.js:5960 | none | MISSING | 501 not yet supported |
| GET `/api/agents` | none | none | UNUSED | 410 with notice |
| POST `/api/agents/{agent_id}/kill` | vscode-extension/media/loki-dashboard.js:4312 | none | MISSING | 501 not yet supported |
| POST `/api/agents/{agent_id}/pause` | vscode-extension/media/loki-dashboard.js:4312 | none | MISSING | 501 not yet supported |
| POST `/api/agents/{agent_id}/resume` | vscode-extension/media/loki-dashboard.js:4312 | none | MISSING | 501 not yet supported |
| GET `/api/logs` | none | none | UNUSED | 410 with notice |
| POST `/api/collab/join` | none | none | UNUSED | 410 with notice |
| POST `/api/collab/leave` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/users` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/users/{user_id}` | none | none | UNUSED | 410 with notice |
| POST `/api/collab/users/{user_id}/heartbeat` | none | none | UNUSED | 410 with notice |
| POST `/api/collab/users/{user_id}/cursor` | none | none | UNUSED | 410 with notice |
| POST `/api/collab/users/{user_id}/status` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/presence` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/file/{file_path:path}` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/state` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/state/value` | none | none | UNUSED | 410 with notice |
| POST `/api/collab/operation` | none | none | UNUSED | 410 with notice |
| POST `/api/collab/sync` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/history` | none | none | UNUSED | 410 with notice |
| WS `/ws/collab` | none | none | UNUSED | 410 with notice |
| GET `/api/collab/status` | none | none | UNUSED | 410 with notice |
| GET `/api/secrets/status` | none | none | UNUSED | 410 with notice |
| GET `/api/github/status` | none | none | UNUSED | 410 with notice |
| GET `/api/github/tasks` | none | none | UNUSED | 410 with notice |
| GET `/api/github/sync-log` | none | none | UNUSED | 410 with notice |
| GET `/api/health/processes` | none | none | UNUSED | 410 with notice |
| GET `/metrics` | autonomy/loki:29162, tests/e2e/webapp-admin-honesty.mjs:271 (test), tests/e2e/webapp-receipt-panel.mjs:54 (test) (+2) | none | MISSING | 501 not yet supported |
| GET `/api/checklist` | none | none | UNUSED | 410 with notice |
| GET `/api/usage` | none | none | UNUSED | 410 with notice |
| GET `/api/checklist/summary` | none | none | UNUSED | 410 with notice |
| GET `/api/prd-observations` | none | none | UNUSED | 410 with notice |
| GET `/api/checklist/waivers` | none | none | UNUSED | 410 with notice |
| POST `/api/checklist/waivers` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| DELETE `/api/checklist/waivers/{item_id}` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/council/gate` | tests/moat/p7-no-fabricated-data.sh:4638 (test), tests/moat/p7-no-fabricated-data.sh:4760 (test), tests/moat/p7-no-fabricated-data.sh:4762 (test) (+1) | none | MISSING | 501 not yet supported |
| GET `/api/app-runner/status` | none | none | UNUSED | 410 with notice |
| GET `/api/app-runner/logs` | none | none | UNUSED | 410 with notice |
| GET `/api/app-runner/errors` | none | none | UNUSED | 410 with notice |
| POST `/api/control/app-restart` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| POST `/api/control/app-stop` | vscode-extension/media/loki-dashboard.js:496 | none | MISSING | 501 not yet supported |
| GET `/api/playwright/results` | none | none | UNUSED | 410 with notice |
| GET `/api/playwright/screenshot` | none | none | UNUSED | 410 with notice |
| GET `/api/failures` | none | none | UNUSED | 410 with notice |
| GET `/api/prompt-versions` | none | none | UNUSED | 410 with notice |
| POST `/api/prompt-optimize` | autonomy/loki:17793, vscode-extension/media/loki-dashboard.js:7581 | none | MISSING | 501 not yet supported |
| MOUNT `/assets` | none | UI static assets | EXISTS (vite output under ui/dist/assets) | none (CP UI serves it) |
| GET `/api/activity` | vscode-extension/media/loki-dashboard.js:8596 | none | MISSING | 501 not yet supported |
| GET `/api/session-diff` | none | none | UNUSED | 410 with notice |
| POST `/api/activity` | none | none | UNUSED | 410 with notice |
| GET `/favicon.svg` | none | UI static asset | EXISTS (the CP UI serves its own favicon from ui/dist) | none (CP UI serves it) |
| GET `/cost` | none | CP UI (/) | EXISTS | 308 to CP UI |
| GET `/trust` | none | CP UI (/) | EXISTS | 308 to CP UI |
| GET `/` | none | CP UI (/) | EXISTS | 308 to CP UI |
| GET `/api/quality-score` | none | none | UNUSED | 410 with notice |
| GET `/api/quality-score/history` | none | none | UNUSED | 410 with notice |
| POST `/api/quality-scan` | autonomy/loki:23927, vscode-extension/media/loki-dashboard.js:7832 | none | MISSING | 501 not yet supported |
| GET `/api/quality-report` | autonomy/loki:23994 | none | MISSING | 501 not yet supported |
| GET `/api/migration/list` | vscode-extension/media/loki-dashboard.js:8173 | none | MISSING | 501 not yet supported |
| POST `/api/migration/start` | none | none | UNUSED | 410 with notice |
| GET `/api/migration/{migration_id}/status` | vscode-extension/media/loki-dashboard.js:8173 | none | MISSING | 501 not yet supported |
| GET `/api/migration/{migration_id}/plan` | none | none | UNUSED | 410 with notice |
| GET `/api/migration/{migration_id}/features` | none | none | UNUSED | 410 with notice |
| GET `/api/migration/{migration_id}/seams` | none | none | UNUSED | 410 with notice |
| POST `/api/migration/{migration_id}/advance` | none | none | UNUSED | 410 with notice |
| POST `/api/migration/{migration_id}/start-phase` | none | none | UNUSED | 410 with notice |
| GET `/api/managed/events` | vscode-extension/media/loki-dashboard.js:11965 | none | MISSING | 501 not yet supported |
| GET `/api/managed/status` | tests/integration/test_dashboard_api_smoke.sh:105 (test), tests/integration/test_dashboard_api_smoke.sh:106 (test), vscode-extension/media/loki-dashboard.js:11965 | none | MISSING | 501 not yet supported |
| GET `/api/managed/memory_versions/{memory_id}` | none | none | UNUSED | 410 with notice |
| GET `/api/findings/{iteration}` | none | none | UNUSED | 410 with notice |
| GET `/api/quality/architecture` | none | none | UNUSED | 410 with notice |
| GET `/api/learnings` | tests/e2e/dashboard-evidence-panels.mjs:72 (test) | none | MISSING | 501 not yet supported |
| GET `/api/escalations` | vscode-extension/media/loki-dashboard.js:12356 | none | MISSING | 501 not yet supported |
| GET `/api/escalations/{filename}` | none | none | UNUSED | 410 with notice |
| GET `/api/phases` | none | none | UNUSED | 410 with notice |
| GET `/api/proofs` | tests/e2e/dashboard-evidence-panels.mjs:71 (test), tests/e2e/webapp-receipt-panel.mjs:75 (test), tests/e2e/webapp-receipt-panel.mjs:84 (test) | none | MISSING | 501 not yet supported |
| GET `/api/proofs/summary` | tests/e2e/webapp-receipt-panel.mjs:76 (test) | none | MISSING | 501 not yet supported |
| GET `/api/proofs/{run_id}` | tests/moat/p2-honest-verdict.sh:1251 (test) | none | MISSING | 501 not yet supported |
| GET `/api/proofs/{run_id}/html` | none | none | UNUSED | 410 with notice |
| GET `/api/spec` | none | none | UNUSED | 410 with notice |
| GET `/api/spec/history` | none | none | UNUSED | 410 with notice |
| GET `/api/wiki` | none | none | UNUSED | 410 with notice |
| GET `/api/wiki/{section}` | none | none | UNUSED | 410 with notice |
| POST `/api/wiki/ask` | vscode-extension/media/loki-dashboard.js:12595 | none | MISSING | 501 not yet supported |
| GET `/{full_path:path}` | none | SPA fallback | EXISTS (CP app.get("*") serves the SPA and 404s missing assets) | none (CP UI serves it) |

### 5.3 Notes for the deletion gate

- Test consumers that block deleting the legacy routes (they run the Python app in process, so they need the routes or a rewrite): tests/moat/p2-honest-verdict.sh (GET /api/proofs/{run_id}, GET /api/v2/audit/verify) and tests/moat/p7-no-fabricated-data.sh (/api/status, /api/projects, /api/cost, /api/budget, /api/cost/timeline, /api/fleet/runs, /api/fleet/summary, /api/context, /api/memory/economics, /api/learning/metrics, /api/council/gate, /metrics). tests/e2e/dashboard-evidence-panels.mjs and webapp-receipt-panel.mjs read /api/proofs, /api/proofs/summary, /api/learnings, /api/budget. None of these may be weakened or added to tests/moat/pending.txt; CPE-24 must port the property each one proves before the route goes.
- Corrections to the inventory hints: tests/moat/p5-sovereignty.sh does not call /api/enterprise/status or /api/enterprise/tokens (it runs `loki start`, matched by the text `/start`); autonomy/loki does not call /api/control/start or /api/control/stop on the dashboard; the VS Code extension requests `/status`, which the legacy server never served (its catch-all answered HTML), so it is not a row.
- /api/memory/* and /api/learning/* are consumed by the VS Code memory view (src/views/memoryViewProvider.ts, dashboardWebview.ts) and the bundled webview, and p7 reads /api/memory/economics and /api/learning/metrics, so those that appear USED above are not deletable on the UI alone.
- /health: the CP /health identity ({service: "loki-control"}) is relied on by CLI discovery. Callers that probe the legacy /health body at port 57374 (autonomy/loki, autonomy/run.sh, web-app) need either a migrated probe or a separate listener; the shim does not add one.

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
| CPE-09 | Run control: supervisor writes <run>/run.pid (pid, start time, argv); stop, retry, resume endpoints | loki-ts/src/engine10/run_pid.ts, loki-ts/src/engine10/supervisor.ts, src/server/routes/control.ts, test/server/control.test.ts, loki-ts/tests/engine10/run_pid.test.ts | `bun test test/server/control.test.ts` and `cd loki-ts && bun test tests/engine10/run_pid.test.ts` (stale pid, reused pid, other run's pid refused) | 03 | HIGH |
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
| CPE-24 | Delete legacy dashboard at parity: dashboard-ui/, dashboard/static/, legacy server routes, their tests and package entries | dashboard-ui/**, dashboard/static/**, dashboard/server.py (UI routes), package.json files list, tests naming them | section 5 checklist all green plus `bash scripts/local-ci.sh` | all, section 5 | MEDIUM |

Parallelism: CPE-01 and CPE-03 start at once; after them up to 12 builders run in parallel (04, 05, 07, 09, 11, 12, 13, 14, 15, 18, 21, 22). HIGH slices (04, 07, 09, 14) carry the security review the founder asked for.

## 7. Open questions
1. Ground color: the shell's light-grey #F1F2F6 (founder-approved per build-standalone.js:113) or the components' warm cream #FFFEFB with midnight-purple dark #1A0F2E (unified-styles.js:24, :88)? This spec picks the shell; one screenshot pair for Loki settles it.
2. Mascot: keep it beside the wordmark (it was part of the old look) or drop it for a cleaner Claude.ai-like header?
3. Modernize, merge queue, PR risk review, schedules and memory have no v10 run events or API today. They stay hidden in 10.8.0 and get UI slices when their backends land; confirm that is acceptable for "no feature is CLI-only".
