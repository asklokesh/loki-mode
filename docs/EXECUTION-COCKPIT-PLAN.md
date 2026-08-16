# Execution Cockpit - build plan

Lane: LOKI-EXECUTION-COCKPIT-70. Scope: `web-app/` only, plus the narrowest
`web-app/server.py` read adapter if strictly necessary (see "Backend changes").

## 0. What was read, and one correction

The directive says "read AGENTS.md fully". **There is no `AGENTS.md` at the repo
root** (`find . -maxdepth 3 -name AGENTS.md` returns nothing). Read instead:

- `CLAUDE.md` (root, project instructions) - style rules, release workflow.
- `BRANDING.md` - Loki (agent/OSS) vs Autonomi (commercial). Local web app is
  "Loki Mode dashboard", so cockpit copy uses Loki, never Autonomi.
- `COMPONENTS.md` - component map. **Stale claim corrected**: it labels
  `web-app/` "deprecated v7.44.0", but web-app is live and shipped -
  `package.json:99-109` publishes `web-app/dist/` + `server.py`,
  `prepublishOnly` builds it, `autonomy/loki:7496` serves it via `loki web`, and
  three feature commits landed in `web-app/src` after v7.44.0 (`9e0cfdb0`,
  `4d8299c9`, `4831933b`). Building here is correct.
- `docs/COCKPIT-SPEC.md`, `docs/COCKPIT-UX-MANDATE.md` - prior cockpit work.
  Both target the **terminal** surface (`loki cockpit`, in-terminal image
  render). This plan is the **web** cockpit; it inherits their principles
  (honest always, never fake progress, alive-not-static, identity-first) and
  does not touch the terminal path.
- `web-app/server.py` (8782 lines) - the API the web app actually calls.
  **Not** `dashboard/server.py`, which is a different surface on a different port.
- `web-app/src/**` - App.tsx routing, `api/client.ts`, `types/api.ts`,
  `components/ui/*`, `tailwind.config.js`, `ProjectWorkspace.tsx`,
  `EvidenceReceiptPanel.tsx`.

## 1. The product

Not chat. An **issue-to-PR execution cockpit**: one screen that answers, in
order, the four questions a reviewer actually has.

1. **What was it asked to do, and how will we know it worked?** - task header
   with the goal and acceptance criteria.
2. **Where is it now?** - calm phase timeline plus elapsed / time-to-first-signal.
3. **What did it change, and what proves it?** - changed-file review surface and
   evidence attached to the outcome.
4. **What do I do about it?** - final actions, each either real or honestly
   disabled, plus risk and rollback.

Agent chatter (logs, per-agent traces) is **secondary and collapsed by default**.

## 2. User journey

```
  Projects list  ->  /project/:sessionId/cockpit
                          |
      +-------------------+-------------------+
      |                                       |
  LIVE (this session is the running one)   HISTORICAL (any other session)
      |                                       |
  header: goal + acceptance                header: goal + acceptance
  timeline: current phase pulses           timeline: rendered from final status,
  metrics: elapsed ticking                   labelled "historical", no ticking clock
  evidence: gates as they land             evidence: gates as recorded
  actions: pause / stop (real)             actions: open PR / rollback (real)
  chatter: live log stream                 chatter: stored session log
```

Entry: a "Cockpit" affordance on the existing project route. Exit: back to the
workspace or to the projects list. Deep-linkable; survives reload.

## 3. State model - the load-bearing decision

Live run state on this backend is **global**, not per-session:
`/api/session/status`, `/api/session/checklist`, `/api/session/logs`,
`/api/session/agents` and `/ws` all read one module-level `session` singleton
(`web-app/server.py:140`). There is exactly one running build per server.

Review state is **per-session**: `/api/sessions/{id}/git/status`, `/git/log`,
`/git/pr`, `/checkpoints`, `/github/prs/*`.

The cockpit spans both, so it must decide which mode it is in. The predicate:

```ts
// LiveBinding: the global run telemetry belongs to THIS session only when the
// running process is working in this session's directory.
isLive = status.running && normalize(status.projectDir) === normalize(session.path)
```

Both sides are absolute paths: `SessionDetail.path` is `str(target)`
(`server.py:3831`) and `StatusResponse.projectDir` is `session.project_dir`,
assigned from the resolved project dir at `server.py:2704`. `normalize` strips a
trailing slash only; no other coercion, because a coincidental match would be
worse than a miss.

**When `isLive` is false the cockpit renders zero live facts** - no phase pulse,
no ticking elapsed, no "running" badge. It shows the historical view sourced from
`SessionDetail.status` and the per-session endpoints. This is the single rule
that keeps the screen from inventing a run.

### View states

| State | Predicate | Renders |
|---|---|---|
| `loading` | detail fetch in flight | skeletons in the real layout shape |
| `empty` | detail loaded, no PRD and no changed files | "nothing recorded for this session yet" + what would populate it |
| `running` | `isLive && !paused` | live timeline, ticking elapsed, live gates |
| `paused` | `isLive && status.paused` | timeline frozen with an explicit paused marker, Resume enabled |
| `recovering` | `isLive && status.exit_code == null && phase == 'starting'` | "starting up" - the backend's own synthetic phase, labelled as such, never as progress |
| `failed` | `!isLive && detail.status == 'failed'`, or `isLive && exit_code not in (null, 0)` | failure header, exit code, last output, rollback surfaced first |
| `completed` | `!isLive && detail.status == 'completed'` | historical timeline, evidence, final actions |
| `disconnected` | WS closed while `isLive` | last-known state, dimmed, with a "reconnecting" note and the age of the data |

`disconnected` is not decoration: the WS reconnects on a 3s timer
(`client.ts:786`) and a stale screen that looks live is an invented fact.

## 4. Phase map - the highest-risk table

The backend's phase vocabulary is **not** the directive's six display phases.
Real values, traced to source:

| Backend value | Written by | Display phase |
|---|---|---|
| `idle` | `server.py:2924` default | Not started |
| `starting` | `server.py:2996` synthetic (<15s, nothing on disk yet) | Understanding |
| `BOOTSTRAP` | `run.sh:6270` seed record | Understanding |
| `REASON` | `run.sh:3485` `get_rarv_phase_name` | Planning |
| `ACT` | `run.sh:3486` | Editing |
| `REFLECT` | `run.sh:3487` | Review |
| `VERIFY` | `run.sh:3488` | Testing |
| `BUILDING` | `run.sh:26167` `_advance_current_phase` | Editing |
| `COMPLETED` | `run.sh:26286` | PR-ready |
| `FAILED` | `run.sh:26289`, `:26294` | Failed |
| `UNKNOWN` | `run.sh:3489` | Unknown |
| anything else | - | **renders the raw string verbatim** |

Both routes persist the RARV name: bash at `run.sh:22295`, Bun via
`updateCurrentPhase` (`loki-ts/src/runner/autonomous.ts:670` ->
`state.ts:632`). The map lives in one exported constant so it is greppable and
testable. An unmapped phase is shown as itself - never silently bucketed.

Two honesty notes the UI must carry:

- RARV phases cycle (`iteration % 4`), so the timeline is **not** a monotonic
  progress bar. It renders as a repeating cycle with the current step marked,
  and iteration N of max shown alongside. Presenting REASON->VERIFY as a
  one-way march would misrepresent the engine.
- `starting` is the server's own placeholder for "process alive, nothing written
  yet". Labelled "starting up", not counted as work done.

## 5. Metrics

| Metric | Source | Honesty rule |
|---|---|---|
| Elapsed | `status.uptime` (seconds, server-computed) | Ticks locally between 2s pushes; resets to server truth on each push. Only when `isLive`. |
| Iteration | `status.iteration` / `status.max_iterations` | `max_iterations` falls back to env default 10 (`server.py:2977`); shown as "of ~10" when it came from the fallback is over-claiming, so we show the bare number and the max without an "estimated" claim only when a real value was read. If `max_iterations` came from the env fallback we render iteration alone. |
| Cost | `status.cost` | Zero renders as "not recorded", never "$0.00 spent". |
| Time to first result | **client-observed only** | The first transition out of `idle`/`starting` seen *by this mount*. `.loki/app-runner/first-preview.json` exists in the engine but **no web-app endpoint serves it** (`grep -n first-preview web-app/server.py` -> nothing). So TTFR is labelled "first signal seen this session" and is **hidden entirely on a reload that missed the transition**, rather than shown as an authoritative number. |

## 6. Evidence

| Tile | Source | Empty behaviour |
|---|---|---|
| Quality gates | `GET /api/session/checklist` -> `.loki/state/checklist.json` | The endpoint returns all-zeros with `items: []` when the file is absent (`server.py:3160`). **Zeros are not "all passing"** - renders "no gate results recorded". |
| Evidence receipt | `GET /api/proofs`, `/proofs/summary`, `/proofs/{run_id}` | Reuses the existing `EvidenceReceiptPanel`; no second receipt view. `unknown` stays its own bucket. |
| Changed files | `GET /api/sessions/{id}/git/status` | **Dedupe by path.** The endpoint emits two entries for one path when it is both staged and unstaged-modified (`server.py:5405-5411`), so a naive count is wrong. Staged/unstaged is folded into one row per path. |
| Tests / build / lint | `POST /sessions/{id}/test`, `/review` | These **run** things and return `{output, returncode}` - they are actions, not passive evidence. The tile shows "not run" until the user triggers it, and never implies a result that was not fetched. |

## 7. Actions - capability table

Every affordance is checked against a real endpoint. Anything without one
renders disabled **with a visible reason**, never a dead grey button.

| Action | Endpoint | State | Guard |
|---|---|---|---|
| Pause | `POST /api/session/pause` | Real | Enabled only when `isLive && !paused` |
| Resume | `POST /api/session/resume` | Real | Enabled only when `isLive && paused` |
| Stop | `POST /api/session/stop` | Real | Enabled only when `isLive`; confirm step |
| Open PR | `POST /api/sessions/{id}/git/pr` (title, body) | Real | Needs title; disabled when no changed files, reason shown |
| Commit | `POST /api/sessions/{id}/git/commit` | Real | Disabled when working tree clean |
| Push | `POST /api/sessions/{id}/git/push` | Real | Disabled when nothing ahead |
| Rollback | `POST /api/sessions/{id}/checkpoints/{cp_id}/restore` | Real, **destructive** | Two-step confirm naming the checkpoint. Disabled with "no checkpoints recorded" when the list is empty. |
| Request change | `POST /api/sessions/{id}/chat/preview` (dry-run diff) | Real, read-only | Shows what *would* change. Deliberately **not** wired to `chatStart` - that is the chat surface this product is not. |
| Approve | none | **Disabled / planned** | No endpoint approves a local run. `reviewGitHubPR` approves an *existing GitHub PR*; offered only when a PR number is known, otherwise the button reads "requires an open PR". |

## 8. Responsive behaviour

- **Mobile (<768px) - monitoring.** Single column, sticky task header, timeline
  as a vertical stepper, metrics as a two-up row, evidence and diff collapsed
  into disclosures. Actions in a bottom bar (the repo already has
  `MobileBottomNav.tsx` as precedent). Diff bodies are horizontally scrollable,
  never squeezed.
- **Tablet (768-1279px).** Two columns: timeline + metrics left, evidence and
  diff right.
- **Desktop (>=1280px) - review.** Three regions: task header full-width;
  timeline + metrics + risk in a left rail; diff review as the main surface;
  evidence docked right. Chatter is a collapsed drawer at the bottom.

Existing `react-resizable-panels` is available, but the cockpit uses plain CSS
grid - fixed regions, no resize handles to fiddle with. (Noted because
`resizable-panels` v4 reads a bare numeric `size` as pixels, a known trap here.)

## 9. Accessibility

- **Landmarks**: `header` / `nav` / `main` / `aside` / `footer`, each labelled.
- **Keyboard**: every action reachable by Tab in visual order; the diff file list
  is a roving-tabindex listbox (Up/Down to move, Enter to open); `g` then a digit
  jumps to a region; `?` opens a shortcut sheet; Esc closes any disclosure. No
  keyboard trap - the chatter drawer uses the existing `useFocusTrap` only while
  it is modal on mobile.
- **Live regions**: phase changes and gate results announce via a polite
  `aria-live` region, throttled so a 2s push does not spam a screen reader.
  Elapsed does **not** announce.
- **Reduced motion**: follow the existing `motion-reduce:animate-none` idiom
  (`ui/Badge.tsx:32`). The phase pulse, progress transitions, and any
  celebration become static under `prefers-reduced-motion`.
- **Contrast**: body text on `#FFFEFB` uses `muted-accessible` (`#6B6960`), not
  `muted` (`#939084`), which fails AA at small sizes.
- **Status is never colour-only**: every state carries an icon and a text label.
- **Dark mode**: `darkMode: 'class'` with a full `dark-*` token set - every
  surface carries a dark variant or half the app looks broken.

## 10. Files

New, all under `web-app/src`:

| File | Role |
|---|---|
| `cockpit/phases.ts` | The phase map (section 4), display metadata, `mapPhase()` with verbatim fallback |
| `cockpit/useCockpitState.ts` | Fetches session detail + status + checklist + git status + checkpoints; owns `isLive`, view state, WS subscription, TTFR observation |
| `cockpit/TaskHeader.tsx` | Goal + acceptance criteria + provider/branch identity |
| `cockpit/PhaseTimeline.tsx` | The calm timeline; cycle-aware, reduced-motion aware |
| `cockpit/RunMetrics.tsx` | Elapsed, iteration, cost, TTFR - each with its empty rule |
| `cockpit/ChangeReview.tsx` | Deduped changed-file list + diff pane |
| `cockpit/EvidencePanel.tsx` | Gates, receipt link, test/build/lint "not run" states |
| `cockpit/RiskPanel.tsx` | Uncertainty + rollback affordance |
| `cockpit/FinalActions.tsx` | Section 7 table, rendered |
| `cockpit/AgentChatter.tsx` | Collapsed-by-default log drawer |
| `cockpit/ExecutionCockpit.tsx` | Composition + layout + keyboard map |
| `pages/CockpitPage.tsx` | Route shell, error boundary |

Modified:

| File | Change |
|---|---|
| `src/App.tsx` | One route: `/project/:sessionId/cockpit` |
| `src/api/client.ts` | Only if a needed call is missing a wrapper (additive) |
| `src/types/api.ts` | Add `exit_code` / `last_output` to `StatusResponse` - the server already returns them (`server.py:3025-3026`); the type just never declared them |

### Backend changes

**None planned.** Everything the cockpit needs is already on `web-app/server.py`.
If a genuine gap appears, the adapter goes in `web-app/server.py` (the server the
web app talks to), not `dashboard/server.py`. Any such addition is read-only and
called out in the final report.

## 11. Verification

`web-app` has **no unit-test harness** - only Playwright e2e (`tests/e2e/`,
baseURL `127.0.0.1:57375`) and pytest for the server. No new dependencies. So:

1. `npm run build` (`tsc -b && vite build`) - typecheck + build.
2. `npm run lint` - eslint.
3. A deterministic Playwright spec, `tests/e2e/cockpit.spec.ts`, driving every
   view state via `page.route()` interception of the API - no live build needed.
   Fixtures cover: loading, empty, running, paused, recovering, failed,
   completed, disconnected, and the **non-live** case (a session that is not the
   running one must show zero live facts).
4. A pure-function check on `mapPhase()` over every row of the section-4 table
   plus an unmapped value - the one place a silent bug would be invisible.

Screenshots: captured with the installed Playwright only if a browser binary is
already present. If `npx playwright install` would be required, screenshots are
skipped and that is reported, not silently omitted.

## 12. Acceptance criteria

- [ ] No live phase, elapsed, or running badge renders when `isLive` is false.
- [ ] Every phase in the section-4 table maps to its stated display phase; an
      unmapped phase renders verbatim.
- [ ] An absent checklist renders "no gate results recorded", never a green 0/0.
- [ ] Changed-file count matches distinct paths when a file is both staged and
      unstaged-modified.
- [ ] Every disabled action states its reason in visible text.
- [ ] Rollback requires a confirm naming the checkpoint.
- [ ] Full keyboard traversal of header, timeline, diff list, and actions.
- [ ] Every animation is inert under `prefers-reduced-motion`.
- [ ] Mobile layout is single-column with no horizontal page scroll.
- [ ] Dark mode renders every cockpit surface.
- [ ] `npm run build` and `npm run lint` pass; the Playwright cockpit spec passes.

## 13. Out of scope

Version bump, release, commit, push. Any external or public mutation. Changes to
`dashboard/`, the terminal cockpit, or the chat surface.
