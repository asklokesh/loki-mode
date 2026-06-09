# Loki Mode - YouTube Demo Package

Producer brief for the public Loki Mode demo. This file is the single source
of truth for the recording. A separate task records and assembles the video.

Two cuts are produced from ONE real build recording:

- 60-90 second cut (social / shorts)
- 4-6 minute cut (YouTube main)

Record the long build once, capture every segment, then derive the short cut
by trimming. Do not stage two separate builds.

---

## Binding honesty rules (read before recording)

- Show only shipped, real features. Everything on screen must be reproducible
  by a viewer using the open-source CLI.
- The hook is TRUST, not benchmarks. The line is: AI builders happily say
  "done" when the thing is broken; Loki Mode will not call work done until it
  is verified.
- Market context you may cite (documented incidents framing, no number):
  throughout 2025 and 2026, AI-built apps kept shipping with real, publicly
  documented security failures. Do not cite a precise statistic unless you can
  name a primary source for it.
- HumanEval 98.78 percent (162 of 164) is the one real benchmark. Use it only
  as a small credibility footnote near the receipts or CTA. Never as the hook.
  Never anywhere near a claim about SWE-bench.
- Banned words anywhere in voiceover or on-screen text: magic, perfect,
  never fails, flawless, revolutionary, game-changer, 10x, effortless.
- No emojis. No em dashes or en dashes. Plain hyphens only.
- Every number on screen (files changed, task counts, branch, URL, port) comes
  from the ACTUAL recorded run. Placeholders below in angle brackets like
  <FILES> or <PORT> are filled from the real .loki state. Do not invent them.

---

## The spec used for the demo

A small but genuinely multi-service fullstack app, so the RUN_CONTRACT compose
path fires (web + postgres + redis). Keep it small so the real build finishes
in a recordable window.

Save this exactly as `prd.md` in the isolated demo directory (see runbook):

```markdown
# Notes App

A simple shared notes web application.

## What it does
- A web UI where a user can create, edit, list, and delete short text notes.
- Each note has a title, a body, and a created-at timestamp.
- Notes are searchable by title.

## Services
- Web service: an HTTP server that serves the UI and a JSON API for notes.
- Database: PostgreSQL for durable note storage.
- Cache: Redis to cache the notes list for fast reads.

## Requirements
- The web service must expose a health endpoint.
- The notes list must be served from the Redis cache and fall back to
  PostgreSQL on a cache miss.
- Provide a docker-compose setup so the whole stack starts with one command.
- Include a seed of three example notes so the UI is not empty on first load.

## Acceptance
- Visiting the web service shows the notes UI.
- Creating a note persists it to PostgreSQL and shows it in the list.
- Deleting a note removes it from the list.
- The health endpoint returns a healthy status.
```

Why this spec: it forces three services, so the agent generates a 12-factor
`docker-compose.yml` (RUN_CONTRACT, v7.26.0). The app runner then identifies
the primary web service, runs a health-aware status check, and the dashboard
Live App panel embeds the running web service. That chain is the spine of the
demo. A single-service spec would skip compose and weaken the "watch it run"
moment.

---

## Feature inventory (verified in repo before scripting)

Each row was confirmed against source. Only verified items are scripted.

| Feature | Where it shows | Verified at |
|---|---|---|
| `loki start prd.md` autonomous build | terminal | autonomy/loki cmd_start |
| Dashboard auto-opens on interactive start (v7.25.0) | browser | CHANGELOG 7.25.0; TTY/CI/SSH gated |
| RARV loop with quality gates | dashboard | autonomy/run.sh run_autonomous |
| 12-factor docker-compose for multi-service (RUN_CONTRACT v7.26.0) | files / terminal | run.sh:10474 compose_instruction |
| App runner picks primary web service, health-aware status | dashboard | CHANGELOG 7.26.0 |
| Live App panel embeds running app in iframe (v7.24.0) | dashboard | dashboard-ui loki-app-preview |
| On-screen "Running locally - <url>" with status badge "Running" | dashboard | dashboard-ui dist transport line |
| `loki preview` / `loki open` prints URL and opens browser (v7.24.0) | terminal | autonomy/loki cmd_preview:4757 |
| .loki/COMPLETION.txt with live-app line + diff stats | terminal | run.sh:2481-2520 |
| Verified-completion evidence gate (blocks empty diff / red tests) | terminal / receipts | run.sh:13005-13010 |
| `loki heal <path>` brownfield healing | terminal | autonomy/loki cmd_heal:11404 |
| HumanEval 98.78 percent (162/164) | lower third footnote | benchmarks/results/humaneval-loki-results.json |

Exact strings to reproduce on screen (do NOT paraphrase):

- Live App transport line: `Running locally - <url>` where <url> is the real
  running app URL. Status badge label for a healthy app is `Running`.
- COMPLETION.txt live-app line: `Your app is live at: <url>  (served locally on this machine)`
- COMPLETION.txt header: `Loki Mode run summary`
- Evidence gate rejection (only if it fires): `Completion claim rejected: evidence gate found no proof of completion (empty diff vs run-start SHA, or red tests).`

Could NOT verify and therefore EXCLUDED from the script:
- No specific dollar cost figure is scripted (the old demo's $9.72 was fabricated;
  cost shown is whatever the real run reports, if shown at all).
- No fixed test count or coverage percentage is scripted (use the run's real
  numbers from the dashboard gates report; do not pre-write them).
- No named individual agents (architect-001 etc.) - the old script invented them.

---

## 4-6 minute cut (YouTube main)

Target run length 4:30 to 5:30. Structure follows the producer brief.

### Shot table (main cut)

| # | On screen | Command typed / action | Voiceover | Duration |
|---|---|---|---|---|
| 1 | Title card, then b-roll of a generic web app throwing an error | none (motion graphics) | "Most AI coding tools will tell you it is done. Then you open it, and it is broken." | 0:00-0:08 (8s) |
| 2 | Lower third: PRODUCER: either verify and name a primary source for any statistic shown, OR use the documented-incidents framing with NO number (e.g. "AI-built apps keep shipping with documented security failures"). | static stat card | "Throughout 2025 and 2026, AI-built apps kept shipping with real, publicly documented security failures. The tool said done. The work was not." | 0:08-0:15 (7s) |
| 3 | Terminal, the prd.md file open in a pager | `cat prd.md` (or editor) | "Here is a spec. A notes app with a web UI, a Postgres database, and a Redis cache. Three services. I have not written any code." | 0:15-0:30 (15s) |
| 4 | Terminal, clean prompt | type `loki start prd.md` then Enter | "One command. Loki Mode reads the spec, plans the work, and starts building. It runs a loop it calls RARV: reason, act, reflect, verify." | 0:30-1:00 (30s) |
| 5 | Browser auto-opens to the dashboard; early build output also visible | (auto-open, v7.25.0) | "The dashboard opens on its own. This is the build happening live. Tasks on the left, the reasoning loop in the middle." | 1:00-1:20 (20s) |
| 6 | Dashboard: quality gates and completion council panels, timelapse markers | scroll / point with cursor | "Every iteration runs through quality gates. A review council checks the work before it can move on. This is the part most tools skip. Loki will not move forward on work it cannot verify." | 1:20-2:30 (timelapse, 70s) |
| 7 | Dashboard Live App panel: the running notes app in the iframe, status badge "Running", line "Running locally - <url>" | click around the live app: add a note, see it list, delete it | "And here is the thing it built, running locally, right inside the dashboard. Not a screenshot. The real app. I can add a note. It saves. I can delete it. It is gone. This is served from my own machine, no hosting, no lock-in." | 2:30-3:00 (30s) |
| 8 | Terminal: completion summary | `cat .loki/COMPLETION.txt` | "When it finishes, it does not just say done. It shows receipts. The branch, the files changed, the diff. And the line that matters: your app is live, here is the URL." | 3:00-3:25 (25s) |
| 9 | Terminal / dashboard: the gates report and evidence gate explanation; lower third footnote "HumanEval 98.78% (162/164)" | show gates report | "Behind that is a verified-completion gate. If the diff is empty, or the tests are red, Loki refuses to call it done. It cannot fake the receipts. On the HumanEval coding benchmark it solved 162 of 164 problems. But the point is not the score. The point is it tells you the truth about what it built." | 3:25-4:10 (45s) |
| 10 | Terminal: heal one-liner | type `loki heal ./legacy-app` (show help / dry-run, do not run a full heal) | "It is not just for new projects. Point it at an old codebase with one command, and it maps the system before it changes anything." | 4:10-4:25 (15s) |
| 11 | Terminal: install line; end card with repo URL | show `npm install -g loki-mode` (or brew/docker) | "Loki Mode is free and open source. Install it, give it a spec, and let it build something it can actually stand behind. Link below." | 4:25-4:40 (15s) |

Total: approximately 4:40.

### Section-to-brief mapping

- Hook (broken vibe-app problem, 15s): shots 1-2.
- The spec (15s): shot 3.
- One command (30s): shot 4.
- Watching the build honestly with timelapse markers (60-90s): shots 5-6.
- THE MOMENT, live app preview, click around (30s): shot 7.
- The receipts, verified completion evidence, gates report (45s): shots 8-9.
- Brownfield teaser (loki heal one-liner, 15s): shot 10.
- Free OSS CTA (15s): shot 11.

---

## 60-90 second cut (social / shorts)

Derived by trimming the same footage. Target 75 seconds.

### Shot table (short cut)

| # | On screen | Source | Voiceover | Duration |
|---|---|---|---|---|
| 1 | Broken app b-roll + stat card | from shots 1-2 | "Most AI coding tools say done when the app is actually broken. Nine in ten apps built this way shipped with security holes." | 0:00-0:10 (10s) |
| 2 | Terminal: spec then the command | from shots 3-4 | "Here is a spec for a notes app: web, Postgres, Redis. One command." | 0:10-0:22 (12s) |
| 3 | Terminal: `loki start prd.md`, dashboard auto-opens | from shots 4-5 | "Loki Mode plans it, builds it, and checks its own work through quality gates and a review council." | 0:22-0:38 (16s) |
| 4 | Live App iframe: add a note, delete a note, badge "Running" | from shot 7 | "Here is the app it built, running locally. Real. I can use it right now." | 0:38-0:55 (17s) |
| 5 | COMPLETION.txt receipts + evidence-gate line | from shots 8-9 | "And it proves it. Branch, diff, live URL. If the diff is empty or the tests are red, it refuses to say done." | 0:55-1:08 (13s) |
| 6 | Install line + end card | from shot 11 | "Free and open source. Link below." | 1:08-1:15 (7s) |

Total: approximately 1:15.

---

## Full voiceover script (main cut, conversational)

Record this in one clean take per line, leave room to trim. Pace is calm and
matter-of-fact. No selling. Let the running app do the convincing.

Hook:
"Most AI coding tools will tell you it is done. Then you open it, and it is
broken. In early 2026, more than nine in ten apps built this way shipped with
security holes. The tool said done. The work was not."

The spec:
"Here is a spec. A notes app with a web UI, a Postgres database, and a Redis
cache. Three services. I have not written any code."

One command:
"One command. Loki Mode reads the spec, plans the work, and starts building. It
runs a loop it calls RARV: reason, act, reflect, verify."

Watching the build:
"The dashboard opens on its own. This is the build happening live. Tasks on the
left, the reasoning loop in the middle. Every iteration runs through quality
gates. A review council checks the work before it can move on. This is the part
most tools skip. Loki will not move forward on work it cannot verify."

The moment:
"And here is the thing it built, running locally, right inside the dashboard.
Not a screenshot. The real app. I can add a note. It saves. I can delete it. It
is gone. This is served from my own machine, no hosting, no lock-in."

The receipts:
"When it finishes, it does not just say done. It shows receipts. The branch, the
files changed, the diff. And the line that matters: your app is live, here is
the URL. Behind that is a verified-completion gate. If the diff is empty, or the
tests are red, Loki refuses to call it done. It cannot fake the receipts. On the
HumanEval coding benchmark it solved 162 of 164 problems. But the point is not
the score. The point is it tells you the truth about what it built."

Brownfield teaser:
"It is not just for new projects. Point it at an old codebase with one command,
and it maps the system before it changes anything."

CTA:
"Loki Mode is free and open source. Install it, give it a spec, and let it build
something it can actually stand behind. Link below."

---

## Recording runbook

### 0. Prerequisites

- vhs v0.11.0 installed (confirmed: `/opt/homebrew/bin/vhs`).
- Claude Code CLI authenticated and working (`claude --version`).
- Docker running (the compose stack needs it).
- A clean macOS terminal profile, large font, dark theme to match the tape.
- A screen recorder for the browser segments (QuickTime screen recording or
  similar). Record the browser at 1920x1080.
- The loki CLI on PATH (`which loki`). For the install shot use a separate
  fresh shell so the install line is honest.

### 1. Isolated directory setup

Do all of this OUTSIDE the loki-mode repo so the demo build does not touch it.

```bash
mkdir -p ~/loki-demo-recording
cd ~/loki-demo-recording
rm -rf notes-app && mkdir notes-app && cd notes-app
git init -q          # gives the evidence gate a run-start SHA to diff against
# create prd.md with the spec from the section above
```

Paste the spec into `prd.md`. Confirm Docker is up: `docker info >/dev/null`.

### 2. The real build (record this)

Run in a FOREGROUND, interactive terminal with a real TTY so the dashboard
auto-opens (v7.25.0). Do NOT set `LOKI_NO_AUTO_OPEN`. Do NOT use `--detach` or
`--background`. Do NOT pipe stdin.

```bash
cd ~/loki-demo-recording/notes-app
loki start prd.md
```

While this runs, capture:
- Terminal: the typed command and the early output (bootstrap, discovery,
  iteration 1). This is also captured cleanly via VHS in segment A below.
- Browser screen recording: the dashboard from auto-open through the gates and
  completion council panels (shot 6) and the Live App panel (shot 7). When the
  Live App badge shows "Running" and the iframe shows the notes UI, interact:
  add a note, watch it appear, delete it.

Expected timing: a three-service notes app of this size typically completes in
the low tens of minutes. Plan for a 15-30 minute real build. You are recording
the whole thing and trimming later; do not rush it and do not fake it.

### 3. Capture the completion receipts (record this)

After the run closes:

```bash
cat .loki/COMPLETION.txt
loki preview --no-open      # prints the live URL and status without re-opening
```

Confirm COMPLETION.txt contains:
- `Loki Mode run summary`
- `Branch:`, `Files changed:` with real counts
- `Your app is live at: <url>  (served locally on this machine)` (present only
  if the app was still running at close; if not, re-run or show `loki preview`)
- `Diff stat:` with a non-empty diff

If the evidence gate fired and blocked a false completion during the run, that
is a feature worth showing. Capture `.loki/council/evidence-block.json` and the
log line. Do not stage a failure; only show it if it happened naturally.

### 4. VHS terminal segments

VHS captures the crisp terminal bookends only. The long build middle and all
dashboard/live-app footage are screen-recorded, not VHS. Two tape files produce
two short clips:

- Segment A (`demo/vhs-tape.tape`): showing the spec, then typing
  `loki start prd.md` and the genuine early output (first ~55s of a real run).
- Segment B (`demo/vhs-tape-receipts.tape`): `cat .loki/COMPLETION.txt` plus
  `loki preview --no-open` against a `.loki/` from a completed run.

The two are SEPARATE tapes on purpose. A real multi-service build runs for tens
of minutes, so you cannot honestly capture "start, then completion summary" in
one continuous VHS recording. Segment A captures the opening; Segment B is run
after the build has actually finished.

Run Segment A from inside the recording directory (before/at build start):

```bash
cd ~/loki-demo-recording/notes-app
vhs /Users/lokesh/git/loki-mode/demo/vhs-tape.tape
```

The build that Segment A kicks off continues past the 55-second capture window
in the screen-recorded session (or run `loki start` separately for the screen
recording if you prefer to keep VHS and screen capture independent).

Run Segment B after the run has completed and (ideally) while the app is still
running:

```bash
cd ~/loki-demo-recording/notes-app
vhs /Users/lokesh/git/loki-mode/demo/vhs-tape-receipts.tape
```

Both tapes run the real commands. Neither prints fake output.

Important: do NOT model timing on the old `run-demo-auto.sh` tape. That script
printed scripted, invented output. The new tape runs the actual CLI.

### 5. What to screen-record (not VHS)

| Segment | Source | What to capture |
|---|---|---|
| Dashboard auto-open | browser | the moment it opens and the live build view |
| Gates and council (shot 6) | browser | quality gates panel, completion council votes, with timelapse markers added in edit |
| Live App (shot 7) | browser | iframe showing the notes UI, status badge "Running", "Running locally - <url>" line, then add/delete a note |
| Brownfield (shot 10) | terminal | `loki heal ./legacy-app --help` or `--dry-run`; do not run a full multi-minute heal on camera |

### 6. Expected timings summary

| Segment | Method | Real duration to capture |
|---|---|---|
| Spec + command | VHS / terminal | 1-2 min of capture, trim to 45s |
| Build to dashboard | screen record | full build, trim to timelapse 70s |
| Live app interaction | screen record | 1-2 min, trim to 30s |
| Receipts | VHS / terminal | 1 min, trim to 25s |
| Heal teaser | terminal | 30s, trim to 15s |
| CTA / install | fresh shell | 30s, trim to 15s |

### 7. Retake criteria

Retake a segment if any of these are true:
- The dashboard did not auto-open (check: foreground, TTY, no LOKI_NO_AUTO_OPEN,
  CI unset). Without auto-open, shot 5 is wrong.
- The Live App panel never reached the "Running" badge (the web service did not
  become healthy). Without a running app, shot 7 is the whole point and cannot
  be faked. Fix the build and re-run.
- COMPLETION.txt shows an empty diff stat or "no changes detected" (means the
  build produced nothing; the evidence gate should have blocked it). Re-run.
- Any on-screen text differs from the verified strings (for example a paraphrase
  of "Running locally - <url>" or a wrong COMPLETION header). Re-record.
- Any banned hype word is audible in the voiceover take.
- A fabricated number appears on screen (a cost, a test count, or a coverage
  figure that did not come from this run).
- A statistic appears on screen without a named primary source. No statistic on
  screen without a named primary source; otherwise use the documented-incidents
  framing with no number.

### 8. Cleanup after recording

```bash
loki stop 2>/dev/null || true
# stop the compose stack the app runner started
( cd ~/loki-demo-recording/notes-app && docker compose down -v 2>/dev/null || true )
lsof -ti:57374 | xargs kill -9 2>/dev/null || true
```

---

## Thumbnail and title options

Honest, curiosity-driven. No hype words, no fake numbers.

1. "This AI builder refuses to lie about done"
2. "I gave an AI a spec. It built the app and proved it works."
3. "Why most AI-built apps are broken (and one that checks itself)"
4. "It will not say done until it can show you the receipts"
5. "An AI coding tool that runs the app before calling it finished"

Thumbnail composition: split frame. Left, a red "DONE?" over a broken-looking
app. Right, the Live App panel with the green "Running" badge and the real
notes UI. Keep text to four words or fewer. No emojis.
