# CEO cockpit: specification

Status: spec only (owner: platform-lead to build; chief-of-staff to accept).
Source of the ask: docs/v10/RETRO-2026.md section 6 item 6 (CEO console) and
item 7 (ROI ledger).

New-file justification (CLAUDE.md "extend, never duplicate"): no existing file
owns company operations for the founder. `dashboard/server.py` is the
user-facing per-run product dashboard and must stay free of company state;
`scripts/v10-pulse.sh`, `tools/cost-history.py` and `scripts/usage-governor.py`
already own pulse, run cost and usage, so the cockpit only invokes them and
renders their output. It re-implements none of their logic.

## 1. Goals and non-goals
Goals:
- One page where the CEO sees, within 5 seconds of opening, what the company
  is doing, what shipped, what is blocked and what it costs against value.
- One write path: a founder command box that appends a row to
  docs/v10/FOUNDER-QUEUE.md for the chief-of-staff to act on.
Non-goals:
- No direct control. Stop-all, dispatch and release actions are queue rows
  ("STOP ALL", "pause release") that the chief-of-staff executes by recorded
  PID or through release-reliability-lead. The cockpit never signals a
  process, edits BOARD.md, runs git writes or calls npm publish.
- No hosted mode, no auth provider, no telemetry.

## 2. Hard constraints
1. Server: Python 3 standard library only (`http.server`,
   `ThreadingHTTPServer`, `json`, `subprocess`, `fcntl`, `secrets`). No pip
   dependency.
2. Client: one static file `tools/cockpit/index.html` with inline CSS and JS.
   No build step, no framework, no CDN, no third-party origin in the CSP.
   One vendored asset: `tools/cockpit/vendor/three.module.js` is
   `three@0.160.0` `build/three.module.js` (MIT), taken from the npm registry
   tarball after its sha512 matched the registry `dist.integrity`, and pinned
   by sha256 `76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495`
   (`THREE_SHA256` in server.py, asserted by tests/test-cockpit.sh). The
   server reads it once at startup from that fixed path, serves it at
   `/vendor/three.module.js` from 'self', and answers 500 if the hash does not
   match. `vendor/` exists because no existing file owns third-party assets.
   When WebGL or the import fails, every avatar falls back to an inline 2D
   SVG portrait; every number still renders. One cached scene per seat; a
   mood change disposes the old scene's geometries and materials; one shared
   renderer. All DOM writes go through one `add()` helper (the only
   `appendChild` call) that turns non-Node values into text nodes, and each
   panel and the member drawer render inside their own try/catch, so one bad
   field shows "render error in <panel>" in that panel only.
3. Bind 127.0.0.1 only. The `--host` flag accepts only `127.0.0.1` or `::1`;
   any other value exits 64 with a message. Never `0.0.0.0`.
4. Read-only except `POST /api/queue`, which only appends to FOUNDER-QUEUE.md.
5. Testable headless: `--once --json` prints the full snapshot and exits; no
   browser is ever opened (honour LOKI_NO_BROWSER; no `webbrowser` import).
6. Every shell-out has a timeout (default 20 s; pulse 60 s) and a cache, so a
   hung `gh` or `npm` never blocks the page. A failed source renders
   UNKNOWN with the error line, never a blank or a 0.
7. No emojis, no em or en dashes in code, UI text or output.

## 3. Files
- `tools/cockpit/server.py`: server, collectors, snapshot builder, CLI.
- `tools/cockpit/index.html`: the page.
- `tools/cockpit/roi-basis.json`: the salary basis and ROI assumptions (section
  5.6). Tracked, edited by hand or by the chief-of-staff, versioned in git.
- `tests/test-cockpit.sh`: headless test, registered in
  `tests/run-all-tests.sh` and the shard map (retro 3.3.21).
- Runtime only (untracked, under `.loki/`): `.loki/company/status/<slug>.json`
  (written by each seat), `.loki/cockpit/cache/*.json`, `.loki/cockpit/token`.

## 4. CLI
```
python3 tools/cockpit/server.py [--port 8787] [--host 127.0.0.1]
                                [--repo-root PATH] [--once] [--json]
                                [--panel NAME]
```
- `--once --json`: build one snapshot, print it, exit 0 (exit 2 if any panel
  is UNKNOWN, mirroring the pulse contract 0 clean, 1 violation, 2 unknown;
  exit 1 if the pulse reports a VIOLATION).
- `--panel NAME`: restrict `--once` to one panel (pulse, releases, board,
  agents, okrs, roi, queue, work, compare, health).
- Env overrides (for tests and fixtures): `COCKPIT_NPM_CMD`, `COCKPIT_GH_CMD`,
  `COCKPIT_PULSE_CMD`, `BOARD_MD`, `FOUNDER_QUEUE_MD`, `RETRO_MD`,
  `USAGE_READINGS_TSV`, `COST_HISTORY_FILE`, `COCKPIT_STATUS_DIR`,
  `COCKPIT_NOW` (ISO8601 UTC, for deterministic ages). Executive panels add
  `COCKPIT_GIT_ROOT`, `COCKPIT_GIT_DAYS` (default 15), `COCKPIT_GH_RUNS_CMD`,
  `COCKPIT_GH_ISSUES_CMD`, `COCKPIT_GH_PRS_CMD`, `COCKPIT_TRANSCRIPT_ROOT`,
  `COCKPIT_TOKEN_CACHE`, `COCKPIT_PRICING_JSON`, `COCKPIT_USAGE_CAP_CMD`,
  `COCKPIT_LEADER_FILE`, `COCKPIT_SCOREBOARD_DIR`. HQ adds
  `COCKPIT_GH_OPEN_ISSUES_CMD` (default `gh issue list --state open --limit
  1000 --json number,title,state,labels`, the source of open_now and open P0 counts),
  `COCKPIT_BOARD_STALE_HOURS` (default 24), `COCKPIT_GOVERNOR_TTL_S` (cache
  TTL of the usage governor, floored at 300 s because one run takes about
  36 s) and `COCKPIT_WATCH_INTERVAL_S` (stream watcher poll, default 2 s).
- A second launch on a port already in use prints "already in use" and exits
  0, so the KeepAlive LaunchAgent (`SuccessfulExit` false) does not crash
  loop while another cockpit holds the port.
- On start the server prints `cockpit: http://127.0.0.1:<port>/` and its PID,
  and writes the PID to `.loki/cockpit/server.pid` so it is stopped by
  recorded PID only.

## 5. Panels and data sources
Each panel in the snapshot has the shape
`{status: OK|VIOLATION|UNKNOWN|UNMEASURED|PARTIAL|STALE, as_of, source_cmd, data, error}`.
`source_cmd` is the exact command or file read, shown on the page under each
panel (evidence rule, retro 3.1.1).

### 5.1 Pulse
- Source: `bash scripts/v10-pulse.sh` (override `COCKPIT_PULSE_CMD`), run with
  `PULSE_REPO_ROOT` set to the repo root. Cached 90 s; refreshed in a
  background thread so a request never waits on it.
- Parse: every `Key: value` line into `metrics`; every line under
  `=== VIOLATIONS ===` starting `VIOLATION:` into `violations`; the
  `UNKNOWN metrics:` and `STALE metrics` lines into lists. Exit code 0, 1 or 2
  maps to OK, VIOLATION, UNKNOWN.
- Render: violations first in a red band, top one largest; then the metric
  table; STALE values shown with their age.

### 5.2 Releases
- npm: `npm view loki-mode time dist-tags --json` (override
  `COCKPIT_NPM_CMD`). Show `dist-tags.latest`, `dist-tags.next`, the last 20
  versions with publish time, releases in the last hour and 24 h, and minutes
  since the last publish.
- Release runs: `gh run list --workflow release.yml --limit 20 --json
  databaseId,status,conclusion,headSha,createdAt,displayTitle,url` (override
  `COCKPIT_GH_CMD`). Show each run with conclusion and link.
- Local: `VERSION` file and `git -C <root> describe --tags --abbrev=0`.
- Derived flags: VERSION vs next vs latest divergence (retro 3.2.27); a
  release run with conclusion failure on the newest VERSION SHA is a
  VIOLATION. A cached packument is not proof: the panel labels npm data
  "registry view" and never claims a tarball is fetchable (retro 3.2.7).

### 5.3 BOARD flow
- Source: `docs/v10/BOARD.md` (override `BOARD_MD`). Parse table rows with
  columns `ID | Owner | Branch @ SHA | File set | Tier | Status | Notes`.
  Status cell is `<token>@YYYY-MM-DDTHH:MMZ`; tokens: ready, building, review,
  review-blocked, approved, merged, released, blocked, rejected, parked.
- Render: count per token (flow strip ready, building, review, approved,
  merged, released), the active rows (building, review, review-blocked,
  approved, blocked) with age in minutes against their tier budget (LOW 15,
  MEDIUM 30, HIGH 60 per OPERATING-MODEL.md), and an "unparsed rows" list.
  Ready count below 30 is flagged (D91).
- Status cell forms parsed: `released@<time>`, `released v1.2.3@<time>`,
  `released@<time> v1.2.3`, `released v1.2.3`, bare `released`, each with an
  optional `: note` or `(note)`. A row without a time counts in
  `released_unknown_time`, never in the 24 h or 7 d windows.
- Freshness: the board `as_of` is the file time (last commit time when the
  file is tracked and clean, else its mtime; `freshness.basis` says which).
  Older than `COCKPIT_BOARD_STALE_HOURS` the board panel and every section
  that reads BOARD.md are STALE with the age; their numbers are still shown.
  This covers every BOARD-derived number: board, work, agents slice owners,
  health blocked, roi value, by_seat and company (and the roi panel when its
  multiple uses BOARD rows), compare week_over_week, day_over_day and
  seat_vs_seat.

### 5.4 Agents
- Source: `.loki/company/status/<slug>.json` for the 10 slugs in
  `.claude/agents/` (list derived from that directory, never hard-coded).
  Schema: `{seat, model, doing, slice, since, next, blocked_on, updated}`.
- Render one card per seat: model, what it is doing, slice ID linking to the
  BOARD row, minutes since `updated`. A seat with no file is UNKNOWN; a file
  older than 60 min is STALE; `blocked_on` non-empty is highlighted.
- Also show the seat's owned root causes, parsed from the "Root causes
  owned" section of its agent file.

### 5.5 OKRs
- Source: `docs/v10/RETRO-2026.md` section 6 (override `RETRO_MD`): the 20
  numbered items, each parsed into title (first sentence), owner (text after
  `Owner:` up to the next period) and metric (text after `Metric:`).
- Current values: `.loki/company/okrs.json`, written by the owning seats,
  shape `{"<item number>": {value, target, status, source_cmd, as_of}}`.
- Render the 20 rows ranked as in the retro. An item with no current value
  shows UNMEASURED, never 0 and never green. A value without `source_cmd` is
  shown as UNCITED and counts against verification-scientist.

### 5.6 ROI
Two sides, always labelled with their measurement state.

Agent cost (left side):
- Plan cost: `roi-basis.json` field `plan_usd_per_month` (default 200, the
  founder's stated spend, retro RC9 evidence), prorated per day.
- Usage share: `docs/v10/usage-readings.tsv` (columns `utc_time
  window_percent weekly_percent`) and `python3 scripts/usage-governor.py
  --json`. These are plan-usage percentages, not tokens or dollars; the panel
  says so and shows weekly percent used.
- Metered run cost: `python3 tools/cost-history.py report --json` (file
  override `COST_HISTORY_FILE`). Shows measured runs, unmeasured runs (usd
  null) as a separate count, and total measured USD. A missing history file
  is UNMEASURED.
- Budget line: the $50 per day budget from FOUNDER-QUEUE row 3, as a
  configurable `daily_budget_usd`.
- Cost is labelled ESTIMATE when derived from plan proration, MEASURED only
  when it comes from cost-history measured rows.

Human-equivalent value (right side):
- Salary basis in `roi-basis.json`, versioned, every figure with source URL
  and snapshot date:
  ```json
  {
    "source_url": "https://www.levels.fyi/companies/anthropic/salaries/software-engineer",
    "snapshot_date": "2026-09-24",
    "annual_total_comp_usd": {
      "entry": 483000, "senior": 621000, "lead": 865000,
      "staff": 1410000, "median": 883000
    },
    "research_scientist_median_usd": {"value": null, "status": "UNVERIFIED"},
    "research_engineer_usd": {"value": null, "status": "NOT FOUND"},
    "overhead_multiplier": {"value": 1.25, "status": "ASSUMPTION"},
    "work_hours_per_year": {"value": 2000, "status": "ASSUMPTION"},
    "seat_tier": {"chief-of-staff": "lead", "cto": "staff", "...": "..."},
    "hours_per_outcome": {"verified_slice": {"value": null, "status": "ASSUMPTION, unset"}},
    "plan_usd_per_month": 200,
    "daily_budget_usd": 50
  }
  ```
  The figures match RETRO-2026.md 3.8.10 and were re-fetched from the URL on
  2026-10-23. The basis is flagged STALE when `snapshot_date` is older than
  90 days.
- Value formula, shown on the page: hourly rate = annual total comp x
  overhead multiplier / work hours per year; human-equivalent value = sum over
  released slices (BOARD released tokens in the window) of hours per outcome
  x hourly rate for the owning seat's tier.
- Value is UNMEASURED while `hours_per_outcome` is unset. The page then shows
  only "standing 10-seat payroll equivalent" (sum of tier comp x overhead for
  10 seats, labelled ASSUMPTION) next to agent cost, and never prints an ROI
  multiple.
- ROI multiple is shown only when both sides are non-null, with the label of
  the weaker side (ESTIMATE or ASSUMPTION). Per verified outcome cost comes
  from the outcome scoreboard (`.loki/company/scoreboard/*.json`) when it
  exists, else UNMEASURED.
- Every assumption is editable only in `roi-basis.json`; the page shows its
  path and git SHA, never an inline editor.

### 5.8 Executive panels (work, compare, health) and extended team, releases, ROI
Data rule for every executive number: it comes from a real source, the
panel lists that source and its as-of time per section, a missing source is
UNKNOWN with the error (never 0 or a guess), and every assumption is labelled
ASSUMPTION. Each panel carries `data.sources[section] = {status, source,
as_of, error, keys}`; `keys` names the data keys that section produced. A
panel is OK when all sections are OK, PARTIAL when some are UNKNOWN, UNKNOWN
when all are.
- agents (team): the 10 seats with model, last tick, outcome, skip reason,
  ticks/day, cost/day, STALE at 2x cadence, plus spawned engineers and
  reviewers seen in 24h and 7d. Cost is tokens from Claude transcripts
  (`scripts/usage-governor.py iter_records`) times
  `loki-ts/data/model-pricing.json` by tier. It is an ESTIMATE at list price,
  not billed spend. A model without a price is listed under `unpriced_models`,
  never priced at 0. The 24 h window is hour-floored (it spans 24 to 25 h);
  `transcripts.window_note` says so and the page shows it. `data.total` is the
  seat count.
- releases: timeline with lead time (npm publish minus release commit time;
  None when the commit is not found), rates, failures, dist-tags, and CI state
  per release SHA from the last 100 runs of `gh run list`. Each row carries
  `local_tag_exists`; the page labels that column "local tag" (a tag in this
  clone, not proof of a GitHub release).
- work: commits by conventional type (24h, 7d, previous 7d, lines changed),
  slices released from BOARD stamps, merged PRs by type, issues opened and
  closed (commit log, `gh pr list`, `gh issue list`, BOARD.md).
- compare: week over week and day over day (pct is None when the previous
  value is 0), seat versus seat, model mix by tier, and the Loki versus raw
  `claude -p` scoreboard from `.loki/company/scoreboard/*.json` (fields shown
  verbatim, UNKNOWN with the path looked for if absent).
- health: CI green rate overall and per workflow, open P0 issues (label p0),
  blocked, review-blocked and parked rows, usage percents and the governor
  cap, PAUSED state, load, and the leader lock holder. The usage cap comes from
  `COCKPIT_USAGE_CAP_CMD` (default `python3 scripts/usage-cap.py check --json
  --no-refresh`), mapped to `usage_cap` {paused, state, reason, week_pct,
  ceiling, override, reading_at}. A missing script, non-zero exit, bad JSON or
  a state other than OK or PAUSED gives UNKNOWN with the error, never OK. The
  KPI strip shows PAUSED in red with the reason and week_pct against ceiling.
- roi: company cost 7d, cost per release, per released slice and per fix
  commit, per-seat cost, plan proration labelled ASSUMPTION. The ROI multiple
  stays withheld while `hours_per_outcome.verified_slice` is unset.
- Always running: `loki trigger install` also installs the LaunchAgent
  `dev.autonomi.loki-cockpit` (`server.py --port 8787 --repo-root <root>`,
  KeepAlive, RunAtLoad, plist mode 0600, logs under `~/.loki/logs/`);
  `loki trigger uninstall` removes it. The plist resolves `server.py` from
  the location of `autonomy/trigger-schedule.py`, install skips the cockpit
  with a message when that file is missing, and before bootstrap it probes
  the port: a listener answering `/healthz` with a pid is an existing
  cockpit; any other listener is reported as foreign and never signalled.
- Member detail (`GET /api/member/<slug>`): one seat's agent-file persona
  (mandate, decision rights, metrics, escalation, root causes), status file,
  last tick, tick history from `.loki/company/<slug>/log.jsonl` (bad lines
  skipped; counts 24 h and 7 d by outcome), last run from `last.out`
  (as reported by claude -p: duration, turns, models; cost is the claude -p
  `total_cost_usd`, a list-price equivalent, not billed spend), transcript cost (ESTIMATE),
  BOARD slices owned by the slug, and the seat ROI row with its formula.
  Per-tick cost and per-seat commits have no source yet and are "no data:
  <reason>" strings, never numbers. Each part has its own source entry.

### 5.7 Founder command box
- UI: one textarea (max 2000 characters), one "Why only you" optional field,
  one submit button. After submit, the page shows the appended row number
  and the line written.
- `POST /api/queue`, body JSON `{item, why}`; returns `{row, line}`.
- Append rules:
  1. Take an exclusive `fcntl.flock` on `FOUNDER-QUEUE.md.lock` (sidecar,
     under `.loki/cockpit/`), with a 5 s timeout returning 503.
  2. Read the file; allocate the next number as max existing `#` + 1.
  3. Sanitize: strip control characters, replace newlines with spaces and
     `|` with `/`, trim, reject empty (400) or over the cap (413).
  4. Write one row in the existing header shape
     `| # | Date | Item | Why only you | Loop does meanwhile |` with Date as
     today UTC `YYYY-MM-DD`, Item prefixed `[cockpit]`, Why from the field or
     `founder command`, Loop cell `chief-of-staff to triage`, plus trailing
     status cell `open`.
  5. Append only (`open(path, "a")`), then fsync, then re-read and verify the
     file did not shrink and the new row is the last line (shrink guard,
     retro 3.3.17). On failure return 500 and leave the file unchanged.
- The cockpit never commits the change; the chief-of-staff triages and
  commits.

## 6. HTTP API
| Method | Path | Returns |
|---|---|---|
| GET | `/` | index.html |
| GET | `/api/snapshot` | all panels |
| GET | `/api/panel/<name>` | one panel (pulse, releases, board, agents, okrs, roi, queue, work, compare, health) |
| GET | `/api/member/<slug>` | one seat's detail; slug must match `^[a-z0-9][a-z0-9-]{0,63}$` and a `.claude/agents/<slug>.md` file (checked before any panel is read), else 404 |
| GET | `/api/stream` | server-sent events: `retry: 3000`, `event: hello` (with `degraded`), then `event: change` with `{changed: [panel names], at, seq}` when a watched source signature changes, and `event: degraded` with `{degraded: {at, error} or null}` when a watcher step fails or recovers (the failure is also logged to stderr). Each write has a 10 s socket timeout |
| GET | `/vendor/three.module.js` | the vendored three.js module, only when its sha256 matches `THREE_SHA256`, else 500 |
| GET | `/healthz` | `{"ok": true, "pid": N}` |
| POST | `/api/queue` | append result |
Every other method or path returns 405 or 404.

Security:
- Reject any request whose `Host` header is not `127.0.0.1:<port>`,
  `localhost:<port>` or `[::1]:<port>` (DNS rebinding).
- `POST /api/queue` requires header `X-Cockpit-Token` equal to a per-process
  random token (`secrets.token_urlsafe(32)`), written to
  `.loki/cockpit/token` with mode 600 and injected into the served page; and
  an `Origin` equal to the served origin. Missing or wrong: 403.
- `GET /api/stream` and `GET /api/member/<slug>` answer 403 when an `Origin`
  header is present and is not the served origin; no `Origin` is allowed.
- Request body capped at 8 KB. Responses set `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff` and a CSP of `default-src 'self';
  script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'`. It names no third-party origin.
- Subprocesses run with an argument list (never `shell=True`) and an env built
  deny-by-default (PATH, HOME, USER, LOGNAME, LANG, gh and npm config paths
  only), per security-lead rule 3.9.2.
- No file path from a request is ever opened; all paths come from flags or
  env.

## 7. Page behaviour
- Subscribes to `/api/stream`; on a change event it refetches the named
  panels. The header shows Live, Polling every 15 s (stream lost; polls
  `/api/snapshot`), Live stream degraded (watcher failing; polls) or
  Offline. While Live it also refetches every 60 s as a safety refresh. A
  malformed `#member/` hash is ignored. Panels update in place without layout shift;
  a "last refreshed" time and the age of each source are always visible.
- Dark first with a light toggle; a KPI strip; SVG charts; the 10 seats as
  cards with persona, mandate, color and avatar. Clicking a seat opens the
  member drawer (`#member/<slug>`, deep-linkable).
- A missing value renders "no data: <reason>", never a blank or 0.
- Order: pulse violations band, agents, BOARD flow, releases, OKRs, ROI,
  command box.
- Light and dark from `prefers-color-scheme`, overridable by the toggle;
  readable at 1280 px and 390 px.
- Every number has a hover or caption with its `source_cmd` and `as_of`.

## 8. Headless test (`tests/test-cockpit.sh`)
Uses `loki_run_tmp_create` and `loki_run_tmp_cleanup`, stops the server by its
recorded PID only, sets `LOKI_NO_BROWSER=1`. Fixtures under the run tmp dir:
- A BOARD.md with one row per token plus one unparsed row; assert counts.
- A FOUNDER-QUEUE.md copy; POST an item containing `|`, a newline and 2001
  characters; assert 413, then a valid item, assert row number = max + 1, the
  pipe replaced, the file only grew, and two concurrent POSTs get distinct
  numbers.
- Stub `COCKPIT_NPM_CMD` and `COCKPIT_GH_CMD` scripts emitting fixed JSON,
  and one that sleeps past the timeout; assert UNKNOWN, not a hang.
- Missing cost-history and empty status dir: assert ROI cost UNMEASURED and
  agents UNKNOWN, and that no panel prints `0` for an unmeasured value.
- `--host 0.0.0.0` exits 64. POST without token: 403. Bad Host: 403.
- `--once --json` output parses and its exit code matches the pulse stub's
  exit code mapping.
- Executive fixtures: a real repo with dated commits, stubbed gh runs,
  issues and PRs, transcripts, a price table, a scoreboard dir, a leader file.
  Assert exact values (commit counts by window and type, lead time, CI per
  release SHA, cost, ROI ratios), the UNKNOWN path for each source (commits,
  gh, BOARD, transcripts, price table, usage, leader, scoreboard), the
  usage-cap command cases (OK, PAUSED cap, PAUSED stale, override, missing script, bad rc, bad JSON), and a walker that fails when any panel number
  lacks a source claim or an UNKNOWN source still carries numbers (with two
  mutation controls). `tests/test_trigger.py` covers the cockpit plist.
- HQ: member endpoint (values, missing files, 404 cases), the stream (hello,
  change after a status write, retry), the in-use exit 0, BOARD forms and
  STALE, open issues from the separate call, governor TTL floor, and a node
  fake-DOM run of the page script (appendChild throws on non-Nodes) over
  null, empty, garbage and fixture inputs. Each has a mutation the suite
  kills.
- Hardening: the vendored three.js sha256 pin (file, constant, served body;
  a tampered copy answers 500), a CSP with no third-party origin (header and
  constant), every BOARD-derived source STALE under a stale BOARD (with the
  required reader set), watcher step failure degrading the stream, foreign
  Origin 403 on stream and member, governor loaded from the server checkout,
  a malformed `#member/` hash, and scene reuse with disposal on mood change.
  Each has a mutation the suite kills.
- Positive control for every absence assertion (retro 3.1.6): the same probe
  run on a fixture that does contain the value must find it.

## 9. Acceptance (Wall checks)
1. `python3 tools/cockpit/server.py --once --json | python3 -m json.tool`
   exits 0 or 2 on a clean checkout, with all 10 panels present.
2. `bash tests/test-cockpit.sh` passes, and fails when the append sanitizer
   or the Host check is removed (mutation).
3. `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows 127.0.0.1 only.
4. No file under the repo changes after an hour of page polling except
   FOUNDER-QUEUE.md on submit (`git status --porcelain` diff).
5. Screenshot at 1280 px and 390 px reviewed by developer-experience-lead.
