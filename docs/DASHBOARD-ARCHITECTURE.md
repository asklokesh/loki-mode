# Dashboard Architecture: Real-Data, Near-Realtime

Design only. No implementation in this document.

Status: proposal. Measured against the worktree at
`/Users/lokesh/git/lokimode-anthropic/.claude/worktrees/pre-push-scoped-pytest`
on 2026-08-03.

## 0. Executive finding

The dashboard's problem is not styling and not the UI framework. It is that
several required domains have **no read path from the engine to the browser**.

But the brief's framing ("six domains have ZERO API surface") is wrong in a way
that makes the work cheaper and changes its ranking. The precise situation is
three different failure modes, and they need three different fixes:

| Failure mode | Domains | Fix shape | Cost |
|---|---|---|---|
| **A. Route exists, store is never written** | runs | Wire an engine-side writer | Small |
| **B. Writer exists in code, no route reads it** | receipts, tests, artifacts, prompts (partial), releases | Add a read route over the file that writer produces | Small each |
| **C. No source of truth at all** | prompts (main-loop) | Do not build. Mark NOT AVAILABLE | Zero |

**Precision on mode B.** What is verified is that a *writer exists in source* at
a cited `file:line`. It is **not** verified that an instance exists on disk: this
worktree has never completed a run, `.loki/proofs/` and `.loki/quality/` do not
exist here, and `ls -R .loki/proofs` returns empty. Claiming "the data is
already there" would be exactly the fabrication this document forbids (see R8).
The design conclusion is unchanged, because a read route is written against the
writer's contract, not against a sample file. But the two facts are tracked
separately throughout, and every mode-B row below says which one it is.

None of these is a UI rewrite. The ranked work is **writer-side and
route-side**. Section 4 concludes that the existing 46-component UI is kept
almost entirely, and that a rewrite is not supportable on the evidence.

### Measurement honesty

Every number below was produced by a command recorded next to it. Where the
brief's number and my measurement disagree, both are shown.

One correction against myself: my first pass reported `0` aria attributes in the
built artifact and I nearly wrote that up as a shipped accessibility regression.
It was a measurement error. `dashboard/static/index.html` has lines long enough
(577 chars plus minified runs) that `grep` treated the file as binary and
suppressed output. With `grep -a` the brief's numbers are confirmed. This is the
`grep-absence false-green` failure mode: an empty result was an absent
measurement, not evidence of absence. Any count in this document taken over a
built artifact uses `grep -a`.

## 1. DATA CONTRACT

### 1.1 How route counts were measured

```
grep -oE '^@app\.(get|post|put|delete|patch|websocket)\("([^"]+)"' \
  dashboard/server.py | sed 's/^@app\.\([a-z]*\)("/\1 /' | sort -u    # 156
grep -cE '^@app\.(get|post|put|delete|patch|websocket)' dashboard/server.py  # 165
```

- 165 route decorators in `dashboard/server.py`
- 156 unique (method, path) pairs
- 140 unique paths
- Plus 24 routes in `dashboard/api_v2.py` under prefix `/api/v2`
  (`dashboard/api_v2.py:39`), mounted at `dashboard/server.py:1010-1011`

The brief's "138 routes" is close to the 140 unique-path figure but is not
reproducible from any single command I ran. **The api_v2 router was not counted
in the brief at all**, which is how the runs domain got misclassified.

`dashboard/server.py` is 12,466 lines.

### 1.2 The 15 domains

Freshness classes used below:

- **PUSH** - broadcast by `_push_loki_state_loop` (`dashboard/server.py:596`),
  2s while a run is active, 30s idle, 5s with no clients connected
- **MTIME** - file modification time is available and should be returned
- **ON-READ** - computed per request, freshness equals request time
- **NONE** - no freshness signal exists

| # | Domain | API today | Source of truth on disk | Freshness | Verdict |
|---|---|---|---|---|---|
| 1 | memory | 17 routes | `.loki/memory/` | MTIME | Keep |
| 2 | tasks | 8 routes | `.loki/queue/{pending,in-progress,completed,failed}.json` | PUSH + MTIME | Keep |
| 3 | council | 8 routes | `.loki/quality/reviews/<id>/` (`autonomy/run.sh:12736`) | MTIME | Keep |
| 4 | agents | 5 routes | `.loki/state/agents.json` | PUSH | Keep |
| 5 | cost | 3 routes | `.loki/metrics/budget.json` | PUSH on transition (`server.py:626-633`) | Keep |
| 6 | logs | 2 routes | `.loki/logs/` | MTIME | Keep |
| 7 | health | 3 routes | live process probe | ON-READ | Keep |
| 8 | events | 1 route | `.loki/events.jsonl` (`server.py:7080`) | MTIME + byte offset | Keep, extend |
| 9 | models | 3 routes | `.loki/state/model-override` | MTIME | Keep |
| 10 | providers | 1 route | `.loki/state/{provider,cli-provider}` | MTIME | Keep |
| 11 | **runs** | **5 routes exist** (`/api/v2/runs*`) | **SQL `Run` table, never written by the engine** | NONE | **Fix writer** |
| 12 | **receipts** | 0 routes | `.loki/proofs/<runId>/proof.json` (`loki-ts/src/runner/proof.ts:117`) | MTIME | **Add route** |
| 13 | **tests** | 0 routes | `.loki/quality/test-results.json` (`autonomy/run.sh:4781`), `.loki/verification/playwright-results.json` | MTIME | **Add route** |
| 14 | **artifacts** | 0 routes | `.loki/app-runner/state.json` (`run.sh:4196`), `first-preview.json` (`run.sh:4220`) | MTIME | **Add route** |
| 15 | **releases** | 0 routes | git tags (780 present), `VERSION`, `CHANGELOG.md` | ON-READ | **Add route** |
| - | **prompts** | 0 routes | **Review prompts only**: `.loki/quality/reviews/<id>/<reviewer>-prompt.txt` (`run.sh:14700`). Main-loop prompt is constructed in memory and never persisted. | MTIME (review only) | **Partial. Main loop NOT AVAILABLE** |

### 1.3 The six domains, corrected

This is the table the brief asked for, with the brief's claim next to what the
code says.

| Domain | Brief says | Measured | Root cause | Work |
|---|---|---|---|---|
| runs | ZERO routes | **5 routes exist**, `api_v2.py` `/runs`, `/runs/{id}`, `/cancel`, `/replay`, `/timeline`; mounted `server.py:1010` | Only writer is `api_v2.py:461 create_run`. Nothing in `autonomy/` writes the `Run` table (grep over `autonomy/*.sh` finds only sqlalchemy dependency checks). Store is structurally empty for every real run. | **P0. Engine-side writer.** Not a new API. |
| receipts | ZERO routes | 0 routes. Confirmed. | Writer at `proof.ts:117` produces `.loki/proofs/<runId>/proof.json`. No instance in this worktree. | **P1. One read route.** |
| tests | ZERO routes | 0 routes. Confirmed. | Writer at `run.sh:4781` produces `.loki/quality/test-results.json`. No instance in this worktree. | **P1. One read route.** |
| artifacts | ZERO routes | 0 routes. Confirmed. | Writer at `run.sh:4196` produces `.loki/app-runner/state.json`. No instance in this worktree. | **P1. One read route.** |
| releases | ZERO routes | 0 routes. Confirmed. | Source is git itself (780 tags present, verified) plus `VERSION`. Only domain whose source is verified to exist. | **P2. One read route.** |
| prompts | ZERO routes | 0 routes. Confirmed. | Review prompts persisted at `run.sh:14700`. Main-loop prompt built in memory, never written. | **P2 for review prompts. Main loop = NOT AVAILABLE.** |

**The single most important line in this document:** runs is not a missing API.
It is a route reading an empty table. Building a second runs API would produce a
second empty surface.

### 1.4 Contract rules for every new endpoint

Existing precedent to follow, not replace: `/api/events` reads
`.loki/events.jsonl` directly (`dashboard/server.py:7070-7092`), with an
existence check at `:7081` and a size cap at `:7089`. New file-backed domains
copy this shape.

Every endpoint returns an envelope:

```
{
  "data":       <payload> | null,
  "source":     "<absolute-ish path or 'git' or 'computed'>",
  "observed_at": "<RFC3339, server clock at read>",
  "source_mtime": "<RFC3339>" | null,
  "state":      "ok" | "empty" | "stale" | "unavailable" | "error",
  "detail":     "<human-readable reason>" | null
}
```

Rules, all binding:

1. `source` is mandatory. A payload with no stated source is a defect.
2. An unmeasured value is `null` with `state: "unavailable"`. **Never `0`**, and
   never a plausible-looking sample. A zero cost and an unmeasured cost must not
   render identically.
3. `state` distinguishes four failure shapes that the current code collapses:
   - `empty` - source exists, has no records (a run with no receipts yet)
   - `unavailable` - source file absent (engine never ran)
   - `stale` - source older than the domain's freshness budget
   - `error` - source present but unparseable
4. `source_mtime` is `null` only for ON-READ domains.
5. HTTP status stays 200 for `empty` / `stale`, 503 for `unavailable`, 500 for
   `error`. The UI must be able to distinguish these without parsing prose.

The existing 33 honesty markers in `server.py`
(`grep -oaE '"(unknown|unavailable|not_measured|UNKNOWN|not available)"' | wc -l`)
are the seed of this convention. The brief's "54" is not reproducible by that
command; I report 33 and the command that produced it. Either way, the markers
are ad hoc string literals today. The envelope makes the convention
machine-checkable instead of a naming habit.

## 2. REALTIME MODEL

### 2.1 What exists

- `/ws` at `dashboard/server.py:2499`. Auth by query parameter (`:2523-2540`)
  because browsers cannot set headers on WS upgrade.
- `ConnectionManager` at `:478`. `MAX_CONNECTIONS` default 100 (`:482`).
- `broadcast` at `:512` fans out concurrently with a per-client
  `SEND_TIMEOUT_SECONDS = 5.0` (`:510`) and **drops** any client that times out
  (`:535-539`). Backpressure is already handled by disconnection, not buffering.
- Liveness: server pings after 30s of silence, closes after 2 missed pongs
  (`:2554-2588`).
- `_push_loki_state_loop` at `:596`. Reads `dashboard-state.json`; broadcasts
  only when mtime changed (`:670-672`). Budget (`:626`) and trust (`:646`)
  transitions bypass the mtime gate.
- Other realtime surfaces: `/ws/collab`, `/api/managed/events`,
  `/api/health/processes`.

Built artifact realtime constructs: 9
(`grep -oaE "new WebSocket|EventSource|setInterval" dashboard/static/index.html | wc -l`).
The brief's "34 realtime constructs" is not reproducible by any pattern I tried;
I mark that figure **not independently verified** rather than repeat it.

### 2.2 The three gaps

**Gap 1 - silence is ambiguous.** `if mtime != last_mtime` (`:670`) means an
unchanged file produces no broadcast at all. A client cannot distinguish
"nothing changed" from "the writer died" from "my socket is half-open." This is
the exact defect the staleness requirement exists to prevent.

*Design answer:* every broadcast payload carries `source_mtime` and
`observed_at`. The client renders **age**, not just value. Past a per-domain
budget the panel flips to STALE. A panel showing a number with no age is
non-compliant. Silence is never evidence of freshness.

**Gap 2 - reconnect is blind.** The `connected` message (`:2547`) carries no
state snapshot. A reconnecting client waits for the next mtime change, which on
an idle run may never come.

*Design answer:* reconnect is REST-first. On open, the client fetches the
snapshot for each mounted panel over HTTP, then applies WS deltas on top. The
socket is an invalidation channel, not the source of truth. This also means a
total WS failure degrades to polling rather than to a blank dashboard.

**Gap 3 - no ordering or gap detection.** `broadcast` sends bare dicts with no
sequence number. A client cannot detect a dropped message, and since slow
clients are dropped mid-fan-out (`:535-539`), drops are an expected condition,
not an edge case.

*Design answer:* a monotonic `seq` per connection on every broadcast. Client
tracks last seen; on a gap it re-fetches the REST snapshot rather than trusting
its accumulated state. Ordering is per-connection and total; there is no
cross-domain ordering guarantee and the design does not pretend to one.

### 2.3 Staleness budgets

| Domain class | Budget | Rationale |
|---|---|---|
| Active run state (tasks, agents) | 6s | Push loop runs at 2s; 3 missed cycles |
| Cost / budget | 60s | Transition-pushed, not periodic |
| Receipts, tests, artifacts | 120s | Written at phase boundaries, not continuously |
| Releases | 1h | Git tags change on release only |
| Health | 15s | ON-READ, staleness means the probe itself is failing |

On disconnect: panels do not clear and do not freeze silently. The header shows
a single global disconnected state, every panel dims and shows its last
`observed_at` age. Old numbers are never presented as current.

## 3. INFORMATION ARCHITECTURE

The bundle is 779,725 bytes raw, 150,341 gzipped
(`dashboard/server.py:982`, `GZipMiddleware(minimum_size=1024)` at `:1001`).
gzip stays; nothing in this design touches it.

**Progressive disclosure here cannot mean code-splitting.**
`dashboard-ui/scripts/build-standalone.js` produces a single self-contained
file with zero runtime dependencies, written to both `dashboard/static/` and
`dist/`. That property is why the dashboard works offline and inside Docker
without a CDN. Splitting the bundle would trade a real capability for a
transfer-size win that gzip has already mostly taken (5.2x). So disclosure is
implemented as **deferred render and deferred fetch**, not deferred download.
The bytes arrive once; the work does not.

Concretely: a panel below the fold does not fetch, does not subscribe, and does
not render until it is revealed. The cost being managed is request fan-out and
DOM work against a 12k-line server, not kilobytes.

**First paint (new user, zero config).** One question answered: is anything
running, and is it healthy? Run status, current phase, budget, and a single
verdict tile. If no run has ever happened, this is an empty state that says so
and links to `loki start`. It must not render zeros.

**One click deep.** Task board, council reviews, cost breakdown, test results,
receipts, logs. Each fetches on reveal.

**Expert only.** Memory browser and graph, prompt optimizer, migration
dashboard, audit viewer, tenant switcher, raw event stream. These are the
heaviest panels and the least often needed; they stay behind explicit
navigation.

## 4. MIGRATION

Measured on the shipped artifact with `grep -a`:

| Property | Count | Command |
|---|---|---|
| Custom elements registered | 39 | `grep -oa "customElements.define" dashboard/static/index.html \| wc -l` |
| `aria-*` attributes | 100 | `grep -oa "aria-[a-z]*=" ... \| wc -l` |
| `aria-` occurrences | 113 | `grep -oa "aria-" ... \| wc -l` |
| `role="` | 38 | `grep -oa 'role="' ... \| wc -l` |
| `@media` breakpoints | 13 | `grep -oa "@media" ... \| wc -l` |
| Component source files | 43 | `ls dashboard-ui/components \| grep -v vendor \| wc -l` |
| Registrations in source | 44 | `grep -roha "customElements.define" components core \| wc -l` |

The brief's 113 aria and 41 role are consistent with mine within pattern choice
(113 counts the bare `aria-` prefix, 100 counts full attributes). The component
figure is 43 files carrying 44 registrations, not 46.

**One gap worth noting:** source registers 44 custom elements, the shipped
artifact registers 39. Five components exist in `dashboard-ui/` and do not reach
the browser. This is out of scope for this document and I did not chase it, but
it is recorded here because it means the source tree is not a reliable proxy for
what ships. All acceptance criteria in section 5 therefore measure the **built
artifact**, not source.

### Decision: keep

**Nothing is deleted. Nothing is rewritten.** The justification the brief asked
for cuts the other way: the accessibility work is real and shipped (100 aria
attributes, 38 roles across 39 elements), the zero-dependency build is a genuine
operational asset, and the responsive work exists. A rewrite would spend its
entire budget re-earning properties the codebase already has, while the actual
defect (no data) stayed untouched. A dashboard that is beautifully rebuilt and
still shows nothing real is a worse outcome than the current one.

| Component set | Action | Reason |
|---|---|---|
| All 39 registered elements | **Keep** | Working, accessible, zero-dependency |
| 138-156 existing routes | **Keep** | Working. No breaking changes |
| `/api/v2/runs*` (5 routes) | **Keep, fix writer** | Route is correct; store is empty |
| Envelope fields on responses | **Add, additive** | New optional keys; existing clients unaffected |
| `seq` on WS broadcasts | **Add, additive** | Unknown keys are ignored by current clients |
| Panels for the 5 new domains | **Add** | New elements alongside existing ones |
| gzip middleware | **Keep untouched** | 5.2x on the wire |

Every change is additive. The migration has no step at which the current
dashboard is worse than it is today.

### Ranked work

| Rank | Work | Domain | Why first |
|---|---|---|---|
| P0 | Engine appends run lifecycle records at phase boundaries | runs | Unblocks 5 existing routes and the run-manager component. Highest value per unit of work in the entire plan |
| P1 | Read route over `.loki/proofs/<runId>/proof.json` | receipts | Trust core; writer already exists |
| P1 | Read route over `.loki/quality/test-results.json` | tests | Writer already exists |
| P1 | Read route over `.loki/app-runner/state.json` | artifacts | Writer already exists; drives preview |
| P2 | Read route over git tags + `VERSION` | releases | ON-READ, no writer needed, source verified present |
| P2 | Read route over `.loki/quality/reviews/<id>/*-prompt.txt` | prompts (review only) | Partial coverage, honestly labelled |
| P3 | Envelope + `seq` + staleness rendering | all | Correctness of everything above |

#### Why P0 needs a writer at all (alternative considered and rejected)

The cheaper option would be a read route over existing files, matching every P1
item and requiring no engine change. It was checked and does not work:

- `.loki/state/orchestrator.json` holds **current** phase and cumulative metrics
  only (`autonomy/run.sh:6225-6226`, read at `:6438-6439`). It is overwritten in
  place; there is no per-run history.
- `.loki/dashboard-state.json` is derived from that same file
  (`autonomy/run.sh:6543-6556`), so it inherits the same limitation.
- `.loki/sessions/<id>/` contains only `loki.pgid` and `loki.pid`. Process
  identity, not lifecycle.
- `.loki/checkout-runs/` contains a single numeric directory and is not a
  general run store.

So current-run state is well served by files, and **run history has no file
source**. A history view cannot be built by reading what exists. That is why
this one item is a writer and everything else is a route.

Two constraints on that writer, both to bound R1. It appends at **phase
boundaries only**, never inside the iteration inner loop, so the hot path is
untouched. And it is **append-only**, so a crashed run leaves a truncated record
rather than a corrupt one. If phase-boundary granularity later proves too
coarse, the upgrade path is a finer trigger, not a different store.

Main-loop prompt capture is **not** on this list. It has no source of truth, and
inventing one is a change to the engine's hot path for a dashboard feature. It
renders NOT AVAILABLE.

## 5. RISK REGISTER

| # | Risk | Evidence | Mitigation | Detection |
|---|---|---|---|---|
| R1 | Run writer double-writes or races the engine hot path | `run.sh` is 20k lines; state writes are scattered | Writer is append-only at phase boundaries; never in the iteration inner loop | Run duration before/after must not regress beyond noise |
| R2 | New file reads block the event loop on a large file | `/api/events` already caps reads (`server.py:7089`); learning aggregation reads up to 10MB (`:6904`) | Same size cap and existence check as the events precedent | Response time per new endpoint |
| R3 | `state: "empty"` renders as zero in a panel | Current code has 33 ad hoc markers, no shared convention | Envelope is mandatory; panels bind to `state` before `data` | A panel rendering a number while `state != "ok"` is a test failure |
| R4 | Slow-client drops read as data loss | `broadcast` drops on 5s timeout (`:535-539`) | `seq` gap triggers REST re-fetch | Client-side gap counter |
| R5 | 100-connection ceiling reached | `MAX_CONNECTIONS` (`:482`) | Already returns close code 1013; documented, not raised speculatively | Rejected-connection count |
| R6 | Bundle grows past the point gzip saves it | 779KB raw / 150KB gzipped today | Deferred render, not new dependencies. Zero-dependency property is a hard constraint | Raw and gzipped size per build |
| R7 | Additive envelope breaks a current consumer | Unknown | Fields are added, never renamed or removed | Existing route tests must pass unchanged |
| R8 | Measurement error is mistaken for a defect | Happened during this analysis: `grep` without `-a` reported 0 aria in a file with 113 | All artifact measurements use `grep -a`; empty results are treated as absent measurements | Any claim of "zero X" requires a positive control |

## ACCEPTANCE MATRIX

Every row is measurable by a command. No aspirational entries.

| # | Criterion | Measurement | Pass condition |
|---|---|---|---|
| A1 | No route regression | `grep -cE '^@app\.(get\|post\|put\|delete\|patch\|websocket)' dashboard/server.py` | >= 165 |
| A2 | api_v2 routes intact | `grep -cE '@router\.(get\|post\|put\|delete)' dashboard/api_v2.py` | >= 24 |
| A3 | Accessibility not regressed | `grep -oa "aria-" dashboard/static/index.html \| wc -l` | >= 113 |
| A4 | Roles not regressed | `grep -oa 'role="' dashboard/static/index.html \| wc -l` | >= 38 |
| A5 | Custom elements not regressed | `grep -oa "customElements.define" dashboard/static/index.html \| wc -l` | >= 39 |
| A6 | Breakpoints not regressed | `grep -oa "@media" dashboard/static/index.html \| wc -l` | >= 13 |
| A7 | gzip still active | `grep -c "GZipMiddleware" dashboard/server.py` | >= 1 |
| A8 | Zero runtime dependencies | Built artifact contains no external script/CDN src | 0 external hosts |
| A9 | Runs store is written by the engine | Drive the lifecycle writer directly (source `run.sh`, call the phase-boundary function), then `GET /api/v2/runs`. No provider call, no spend | Returns >= 1 record with a real run id |
| A10 | Every new endpoint states source | Each new route's response | `source` key present and non-empty |
| A11 | Every new endpoint states freshness | Each new route's response | `observed_at` present; `source_mtime` present or explicitly null |
| A12 | Every new endpoint has an error state | Delete or corrupt the source file, call the route | Returns `state` in {`unavailable`,`error`}, never a 200 with zeros |
| A13 | No fabricated zeros | Call each new route with no `.loki/` present | No numeric field is `0`; all are null with `state: "unavailable"` |
| A14 | Staleness is visible | Freeze the source file past its budget | Panel shows STALE and an age |
| A15 | Disconnect is visible | Kill the WS server with the UI open | Every panel dims and shows last-updated age within 10s |
| A16 | Reconnect recovers without a push | Reconnect while source files are unchanged | Panels repopulate from REST |
| A17 | Gap detection works | Drop a broadcast | Client detects `seq` gap and re-fetches |
| A18 | Existing tests pass unchanged | Existing dashboard test suite | 0 failures, 0 modified assertions |

### Not accepted as criteria

Deliberately excluded because they are not measurable as stated: "feels fast",
"enterprise-grade", "near-realtime" without a number, "clean UI", and any
coverage percentage (coverage is not measured in this release per
`skills/quality-gates.md`).

## Appendix: contradictions to the brief

1. **runs has 5 routes, not zero.** `dashboard/api_v2.py` `/runs`, `/runs/{id}`,
   `/runs/{id}/cancel`, `/runs/{id}/replay`, `/runs/{id}/timeline`, mounted at
   `dashboard/server.py:1010-1011`. The brief's route grep missed the `api_v2`
   router because it uses `@router.` not `@app.`. The real defect is that the
   only writer is `api_v2.py:461`; the engine never populates the table.
2. **prompts is partially available.** Review prompts are persisted at
   `autonomy/run.sh:14700` under `.loki/quality/reviews/<id>/<reviewer>-prompt.txt`.
   Only the main-loop prompt is unavailable.
3. **The other four domains have writers in code.** receipts
   (`loki-ts/src/runner/proof.ts:117`), tests (`autonomy/run.sh:4781`),
   artifacts (`autonomy/run.sh:4196`), releases (git, 780 tags verified
   present). "No API" is true; "nothing produces this data" is false. This is
   what changes the work from backend construction to route exposure. Note the
   limit of the claim: for the first three, the writer is verified in source and
   no output instance exists in this worktree.
4. **Route count is 165 decorators / 156 unique method+path / 140 unique paths**
   in `server.py`, plus 24 in `api_v2.py`. Not 138.
5. **Honesty markers measure 33**, not 54, by
   `grep -oaE '"(unknown|unavailable|not_measured|UNKNOWN|not available)"'`.
6. **"34 realtime constructs" is not reproducible.** I measure 9 in the built
   artifact. Marked not independently verified rather than repeated.
7. **Component count is 43 files / 44 source registrations / 39 shipped
   elements**, not 46/39. The source-to-shipped gap of 5 is unexplained and
   out of scope here.
8. The brief's aria (113) and breakpoint (13) figures **are confirmed**, but
   only with `grep -a`. Without it the file greps as binary and reports zero.
