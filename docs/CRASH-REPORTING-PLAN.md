# Crash Reporting and Auto-Fix Pipeline -- Implementation Plan

Status: DESIGN ONLY. No code, no version bumps, no commits in this pass.
Author role: Architect. Date: 2026-06-06. Target repo: asklokesh/loki-mode.

This plan designs a disclosed, anonymous, frictionless crash-reporting plus
auto-fix pipeline. It is grounded in the existing codebase; every file path
and function name below was verified by reading the repo. Where a thing does
NOT yet exist, it is marked MUST ADD. Where the spec wording and the best
engineering choice diverge, the deviation is called out explicitly.

--------------------------------------------------------------------------------
## 1. What already exists (verified, not assumed)
--------------------------------------------------------------------------------

### 1a. Telemetry already ships today -- and is currently UNDISCLOSED on first run
This is the headline finding. Loki Mode already collects anonymous usage data
via PostHog. There is no first-run disclosure line in the code today.

- `autonomy/telemetry.sh` -- bash PostHog client. Hardcoded ingest key
  `phc_ya0vGBru41AJWtGNfZZ8H9W4yjoZy4KON0nnayS7s87`, host
  `https://us.i.posthog.com`, path `/capture/`. Fire-and-forget curl with
  `--max-time 3`. Distinct id persisted at `~/.loki-telemetry-id`.
  Gated only by `LOKI_TELEMETRY_DISABLED=true` and `DO_NOT_TRACK=1`
  (`_loki_telemetry_enabled`, line 9). Sourced by `autonomy/run.sh:648-651`.
  Events fired: `session_start` (run.sh:13310), `session_end` (run.sh:13410).
- `dashboard/telemetry.py` -- Python equivalent. Same key/host, same opt-out
  vars, `send_telemetry()` on a daemon thread. Called from
  `dashboard/server.py:755` (`dashboard_start`).
- `bin/postinstall.js:182-209` -- npm install-time event to the same PostHog
  host/key, same opt-out vars.
- `docs/WELCOME-OPENER-PLAN.md` -- an EXISTING (unimplemented in code) plan for
  a first-run welcome that reuses this same PostHog contract and an opt-in form.
  No sentinel/welcome is wired in code yet; only the plan doc exists.

Consequence for this feature: the honesty invariant must cover the PostHog path
too. PRIVACY.md and the first-run line cannot describe only the new crash
pipeline while `session_start` / `session_end` / install events fire silently.
The opt-out must be UNIFIED so one switch disables both PostHog usage telemetry
and crash reporting. See section 6.

### 1b. There is a production-grade redactor already -- the keystone of this plan
- `autonomy/lib/proof_redact.py` -- the single security chokepoint for the
  proof-of-run feature. Verified contents:
  - `RULES_VERSION = "1.0"` (frozen, bump-on-behavior-change).
  - `redact_value(s)` -- pure function, redacts one string.
  - `redact_tree(obj)` -- recurses dict keys+values, lists, nested structures;
    returns `(new_obj, total_redactions_count)`.
  - Ordered, ReDoS-hardened patterns: Anthropic `sk-ant-`, GitHub `gh[pousr]_`,
    Slack `xox[baprs]-`, AWS `AKIA...` + typed secret assign, JWT `eyJ...`,
    Google `AI...`, generic OpenAI `sk-`, Bearer (keeps scheme), PEM PRIVATE KEY
    blocks (dropped whole), `_ENV_ASSIGN` secret-keyed assignments (bare / JSON /
    YAML quoted), `_URI_CREDENTIAL` (scheme://user:PASS@host), and
    `_UNIX_HOME` `/(Users|home)/<name>` + `_WIN_HOME` `C:\Users\<name>` ->
    `~`, with optional `set_context(home, repo_root)` for repo-relative paths.
- Parity model is ALREADY a shared Python module, not a TS port. `loki-ts`
  reaches the redactor by shelling out: `loki-ts/src/runner/proof.ts:27` resolves
  `autonomy/lib/proof-generator.py` via `findPython3` (`loki-ts/src/util/python.ts`)
  and bash calls `"$SCRIPT_DIR/lib/proof-generator.py"`. Both routes call the
  SAME python, so redaction can never drift between routes.
- Fail-closed precedent: `loki-ts/src/commands/proof.ts:216-227` refuses to
  publish unless `redaction.applied` is confirmed -- "never publish an
  unredacted artifact." This plan adopts the identical posture.
- An older bash inline privacy guard exists around `autonomy/run.sh:9047`
  (referenced in `proof_redact.py` comments as the source the ENV-assign rule
  mirrors).

### 1c. Event bus surface
- `events/bus.py`, `events/bus.ts`, `events/emit.sh`. TS `EventType` enum
  (bus.ts:12): `state | memory | task | metric | error | session | command |
  user`. `EventSource`: `cli | api | vscode | mcp | skill | hook | dashboard |
  memory | runner`. Exports include `emitErrorEvent` (bus.ts:467).
- `emit.sh` exposes `safe_append_event_jsonl()` (flock or mkdir-mutex serialized
  append to `.loki/events.jsonl`), sourceable with `LOKI_EMIT_LIB_ONLY=1`.
- `autonomy/run.sh:1138` defines `emit_event_json()`; `emit_event_pending` is
  used at the iteration-complete site.

### 1d. Metrics / KPI collector
- `loki-ts/src/metrics/kpis.ts` and `loki-ts/src/metrics/trust.ts` exist, with
  command parity in `loki-ts/src/commands/kpis.ts`, `stats.ts`, `trust.ts`.
- `.loki/metrics/` holds efficiency + reward data. `autonomy/context-tracker.py`
  exists. No crash-specific collector exists. MUST ADD.

### 1e. The doctor command
- bash `cmd_doctor` / `cmd_doctor_json` (`autonomy/loki`, per header in
  `loki-ts/src/commands/doctor.ts:1` referencing bash line 6216 / 6534).
- TS port: `loki-ts/src/commands/doctor.ts`. Good surface to add a "telemetry:
  on/off, crash buffer: N pending" line later.

### 1f. Naming and dispatch collisions (already resolved below)
- `loki report` is TAKEN: `cmd_report` (`autonomy/loki:25091`) is a SESSION
  report generator (text/markdown/html). The manual crash submit command must
  NOT reuse `report`. Decision: use `loki crash` with subcommands
  (`loki crash` = show pending, `loki crash submit`, `loki crash show <id>`).
- `loki telemetry` is TAKEN: `cmd_telemetry` (`autonomy/loki:17946`) is the
  OTEL tracing config (`status` / `enable`), dispatched `telemetry|otel`
  (`autonomy/loki:13437`). Decision: ADD `off` / `on` / `status` (extended)
  subcommands to the EXISTING `cmd_telemetry`. The spec-mandated
  `loki telemetry off` thus lives inside the existing command and drives the
  unified opt-out. Do not create a second `telemetry` command.

### 1g. Capture hook points (verified; mostly MUST ADD)
- TS: `loki-ts/src/cli.ts` has `process.on("SIGINT", ...)` (line 224),
  `process.on("SIGTERM", ...)` (line 225), and a single terminal
  `process.exit(code)` (line 228). There is NO `uncaughtException` /
  `unhandledRejection` handler. MUST ADD both, plus a wrapper around the
  terminal exit to capture nonzero exits.
- bash: traps are EXIT/INT/TERM cleanups only (run.sh:186, 199, 2891-2892,
  12734, 12843, 12914, 13192; loki:6160). There is a natural capture point at
  the iteration-complete block (run.sh ~11968-11989) where `$exit_code` is
  known and `status=...error` is already emitted, and `auto_capture_episode`
  (run.sh:12206) already records per-iteration outcome. MUST ADD an ERR/EXIT
  crash hook in `main()` (run.sh:12913) and a friction hook at the existing
  retry/rate-limit/gate sites.

### 1h. Issue-mode (auto-fix trigger primitive) already exists
- `gh issue ...` plumbing in `autonomy/run.sh` (create at 2200, comment at
  2078/2087, close at 2092, list at 1828). The product statement that
  `loki start owner/repo#123` runs in issue-mode is consistent with this
  surface; the auto-fix loop reuses it rather than inventing a runner.

### 1i. Release mechanics (do not reconstruct from memory)
- `scripts/release.sh` is the canonical bump tool. It bumps `VERSION`,
  `package.json`, `vscode-extension/package.json` directly (release.sh:209-211),
  then runs `scripts/update-changelog.sh`. The "14 version files" figure is the
  full release process across docs/wiki/mcp/dashboard `__init__.py`/SKILL.md etc.
  Each phase below says "follow the standard release bump + CHANGELOG"; it does
  NOT enumerate the 14 files from memory. Use the canonical scripts.
- Gate: `bash scripts/local-ci.sh` must pass (the bun-parity matrix is at
  local-ci.sh:250). 3-reviewer council (2 Opus + 1 Sonnet) unanimous.

--------------------------------------------------------------------------------
## 2. Architecture (ASCII)
--------------------------------------------------------------------------------

CLIENT (bash route OR Bun route -- identical behavior via shared python)
  +--------------------------------------------------------------+
  | capture hook                                                  |
  |  - TS: uncaughtException / unhandledRejection / nonzero exit  |  MUST ADD
  |  - bash: ERR/EXIT trap in main(); iteration-complete error    |  MUST ADD
  |  - provider invocation failure; friction (retry/ratelimit/gate)|
  +----------------------------+---------------------------------+
                               | raw context (in-process only)
                               v
  +--------------------------------------------------------------+
  | SHARED SCRUBBER  autonomy/lib/crash_redact.py                 |  MUST ADD
  |  imports proof_redact.redact_tree (1b) + crash allow/deny     |
  |  -> emits WHITELIST-ONLY dict + stable fingerprint            |
  |  FAIL CLOSED: if python3 missing -> write local, NO egress    |
  +----------------------------+---------------------------------+
                               |
              +----------------+-----------------+
              v                                  v
  +-----------------------+        +-----------------------------+
  | LOCAL SELF-INSPECT    |        | OUTBOUND QUEUE (later phase) |
  | .loki/crash/<id>.json |        | .loki/crash/outbox/*.json    |
  | exactly what would be |        | drained by `loki crash       |
  | sent (Phase 0 proof)  |        | submit` / background flush   |
  +-----------------------+        +--------------+--------------+
                                                  | HTTPS POST (Phase 1+)
                                                  v
  +--------------------------------------------------------------+
  | INGESTION BACKEND  (FastAPI, reuse dashboard/ python stack)  |  MUST ADD
  |  POST /v1/crash  (anon, rate-limited, no client write token)  |
  |  1. SECOND server-side scrub: import crash_redact.redact_tree |
  |  2. validate against whitelist schema; reject unknown fields  |
  |  3. fingerprint -> dedup store (sqlite/KV)                     |
  |  4. holds GitHub App / PAT token (never on clients)           |
  +----------------------------+---------------------------------+
                               | novel fingerprint -> create
                               | known fingerprint -> bump counter
                               v
  +--------------------------------------------------------------+
  | PRIVATE TRIAGE REPO  asklokesh/loki-telemetry (raw intake)   |
  |  one issue per novel fingerprint + occurrence counter         |
  +----------------------------+---------------------------------+
                               | human or rule confirms "real bug"
                               v PROMOTION (sanitized title/body only)
  +--------------------------------------------------------------+
  | AUTO-FIX AGENT   loki start asklokesh/loki-telemetry#<n>     |
  |  reproduce -> fix -> bash scripts/local-ci.sh -> open PR      |
  +----------------------------+---------------------------------+
                               | PR targets PUBLIC repo, sanitized desc
                               v
  +--------------------------------------------------------------+
  | PUBLIC REPO  github.com/asklokesh/loki-mode                  |
  |  auto-created PR, NOT auto-merged. council + local-ci gate.   |
  |  human merge approval (CLAUDE.md). Public issue mirrors the   |
  |  promise shown in the first-run line.                         |
  +--------------------------------------------------------------+

--------------------------------------------------------------------------------
## 3. Phased ship plan (smallest-first; each phase = one PATCH, shippable in a day)
--------------------------------------------------------------------------------

### Phase 0 -- LOCAL ONLY: capture + scrub + .loki/crash/ + `loki crash` (NO egress)
Goal: prove the capture+scrub layer with ZERO backend and ZERO network egress.
Resolves the spec's apparent tension ("manual-submit" vs "no egress"): the
manual command writes the scrubbed artifact locally and shows the user exactly
what WOULD be sent; it can optionally open a prefilled GitHub issue URL the user
submits by hand. No backend POST exists yet.

Behavior:
- On a captured crash/friction event, write the scrubbed whitelist payload to
  `.loki/crash/<fingerprint>-<ts>.json`. Never write unscrubbed data anywhere.
- `loki crash` lists pending local reports; `loki crash show <id>` prints one;
  `loki crash submit` (Phase 0) prints the payload and a prefilled
  `github.com/asklokesh/loki-mode/issues/new?...` URL for manual submission.
- FAIL CLOSED: if python3 unavailable, capture still writes nothing to egress;
  local file is written only if scrub ran.

Files to ADD:
- `autonomy/lib/crash_redact.py` -- shared scrubber + fingerprint (section 5).
  Imports `proof_redact.redact_tree` / `redact_value`.
- `autonomy/lib/crash_capture.py` -- builds the raw context dict, calls
  crash_redact, writes `.loki/crash/...`. Pure-ish, no network in Phase 0.
- `autonomy/crash.sh` -- bash hook helpers: `loki_crash_capture` (sourced by
  run.sh), `loki_crash_friction`. Calls python3 crash_capture.
- `loki-ts/src/runner/crash.ts` -- TS hook: registers `uncaughtException` /
  `unhandledRejection` in cli.ts and on nonzero exit; shells to crash_capture.py
  via `findPython3` (mirrors proof.ts:19,27).
- `loki-ts/src/commands/crash.ts` -- `loki crash` command (Bun route).
- `docs/PRIVACY.md` -- honest disclosure doc (ships in Phase 0).

Files to MODIFY:
- `autonomy/run.sh` -- source `crash.sh` near telemetry source (648-651); add
  ERR/EXIT crash hook in `main()` (12913); call `loki_crash_capture` at the
  iteration-complete error branch (~11968-11989) and `loki_crash_friction` at
  existing retry/rate-limit sites.
- `autonomy/loki` -- add `crash)` to dispatch (near report at 13472); add
  `cmd_crash`.
- `loki-ts/src/cli.ts` -- register crash handlers; wrap terminal `process.exit`
  (228); route `crash` command.
- `autonomy/telemetry.sh` + `dashboard/telemetry.py` + `bin/postinstall.js` --
  NO behavior change yet, but add a code comment pointer to the unified opt-out
  (full unification lands in section 6, can be Phase 0 since it is local).

New tests:
- `tests/crash/test_crash_redact.py` -- golden vectors: every secret class from
  proof_redact PLUS new crash fields; assert WHITELIST-only output and stable
  fingerprint across two synthetic machines (different home paths -> same hash).
- `tests/crash/test_crash_redact_negative.py` -- ReDoS / huge-stack guard;
  assert no `/Users/`, no env values, no emails/IPs survive.
- `loki-ts/tests/commands/crash.test.ts` -- `loki crash` lists/show/submit.
- Add a bun-parity entry so `loki crash --help` and `loki crash show` match
  byte-for-byte across routes (local-ci.sh:250 matrix).

CHANGELOG honest "NOT tested" disclosure (Phase 0):
- Tested: client-side scrub on golden vectors; local artifact write;
  `loki crash` list/show/submit; fingerprint stability.
- NOT tested: network egress (none exists in Phase 0); backend dedup;
  cross-machine real-world fingerprint collisions beyond synthetic fixtures;
  auto-fix loop.

### Phase 1 -- BACKEND ingest with SECOND scrub (egress behind unified opt-out)
Goal: add the ingestion backend and turn on opt-in-by-disclosure egress.
- Stand up FastAPI backend (section 7) reusing the dashboard Python stack so it
  can `import crash_redact` for the mandated second scrub.
- Client gains a background flush of `.loki/crash/outbox/*.json` to `POST
  /v1/crash`, gated by the unified opt-out (section 6) and rate-limited.
- Still NO issue creation server-side beyond storing; or create issues in the
  PRIVATE triage repo only.

Files to ADD: `dashboard/crash_ingest.py` (or `web-app/` route -- see 7 for the
host decision), `dashboard/crash_store.py` (dedup store), backend tests.
Files to MODIFY: `autonomy/crash.sh`, `loki-ts/src/runner/crash.ts` (add flush),
`loki-ts/src/commands/crash.ts` + `cmd_crash` (add `submit` real POST).
CHANGELOG NOT tested: production GitHub token custody under load; abuse/spam at
scale; promotion path (not yet built).

### Phase 2 -- DEDUP + fingerprint store + PRIVATE issue creation + counter
- Backend creates one private issue per novel fingerprint; bumps an occurrence
  counter comment on repeats. GitHub token held server-side only.
Files: extend `dashboard/crash_store.py`, add `dashboard/crash_github.py`.
CHANGELOG NOT tested: promotion to public repo; auto-fix.

### Phase 3 -- PROMOTION path (private -> public, sanitized) + AUTO-FIX loop
- Confirmed bugs promoted to public `asklokesh/loki-mode` with sanitized
  title/body. Auto-fix agent runs `loki start asklokesh/loki-telemetry#<n>`,
  fixes, runs local-ci, opens a PR to PUBLIC repo. NOT auto-merged.
Files: `dashboard/crash_promote.py`, `scripts/crash-autofix.sh` (or a routine).
CHANGELOG NOT tested: human-merge gate behavior in the wild; regression rate of
auto-fixes (council + local-ci gate is the guard, see section 8).

--------------------------------------------------------------------------------
## 4. (folded into section 3 per-phase: files + tests + CHANGELOG disclosure)
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
## 5. The scrubber spec (allow/deny, regex, fingerprint)
--------------------------------------------------------------------------------

### 5a. Deliberate deviation from spec wording (state plainly)
The spec asks for "the scrubber as a testable pure function in BOTH routes,"
"designed identically for bash and TS." The chosen design is ONE shared Python
module, `autonomy/lib/crash_redact.py`, that BOTH routes call -- bash via
python3, Bun via `findPython3` (exactly the `proof_redact.py` /
`proof-generator.py` precedent, verified at proof.ts:27).
- Why this is better: it makes drift between routes impossible, and the SAME
  module is importable by the FastAPI backend for the mandated SECOND scrub.
  One module, three call sites: bash client, Bun client, backend.
- Spirit of the requirement is met: `redact_value` / `redact_tree` ARE pure
  functions, covered by shared golden-vector tests.
- Contingency if the council demands strict per-route code: port the rules to
  `loki-ts/src/util/crash_redact.ts` and test it against the IDENTICAL fixture
  set as the Python module (same golden vectors), so parity is proven by tests.

### 5b. FAIL CLOSED
If python3 is unavailable, the no-leak guarantee cannot be enforced, so NO
egress happens. The client may write a local note that capture was skipped, but
must never POST. This mirrors proof.ts:216-227 ("never publish an unredacted
artifact").

### 5c. WHITELIST-only emit (deny-by-default)
The payload that leaves the machine contains ONLY these fields. Anything not on
this list is dropped, not redacted:
- os (uname -s), arch (uname -m)
- loki_version (from VERSION)
- runtime: node_version and/or bun_version
- error_class (e.g. TypeError, ENOENT, NonZeroExit)
- stack_signature: list of top N (default 5) normalized frame signatures
  (function/symbol names only; file paths, line numbers, columns stripped)
- rarv_phase (REASON/ACT/REVIEW/VERIFY/CLOSE/iteration)
- exit_code
- friction_kind (retry_loop | rate_limit_loop | gate_failure) when applicable
- project_id_hash (section 5e)
- fingerprint (section 5d)
- rules_version (from crash_redact) and redactions_count
- captured_at (UTC, second precision)

### 5d. Deny rules (reuse proof_redact, plus crash additions)
crash_redact imports and applies `proof_redact.redact_tree` first (all rules in
1b: keys, Bearer, PEM, env-assign, URI creds, /Users//home/ -> ~, Windows
home). Then crash-specific additions BEFORE whitelisting:
- emails: `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` -> [REDACTED:EMAIL]
- IPv4: `\b(?:\d{1,3}\.){3}\d{1,3}\b` -> [REDACTED:IP]
- IPv6: standard colon-hex form -> [REDACTED:IP]
- repo names: any `owner/repo` derived from the local git remote and any value
  matching the configured public/private repo names -> [REDACTED:REPO]
- prompt/PRD/code/file-content fields: never whitelisted, so dropped by 5c.
Because emit is whitelist-only, free-text fields (briefs, prompts, diffs) can
never reach the payload even if a deny rule missed them.

### 5e. Hashed non-reversible project id
- Do NOT hash the local filesystem path (it contains `/Users/<name>/`, which is
  reversible-ish and stripped anyway).
- Hash the git remote origin URL (normalized: strip scheme, `.git` suffix,
  trailing slash, lowercase host).
- Use SHA-256, UNSALTED. Tradeoff stated explicitly: unsalted gives cross-user
  dedup (two users hitting the same bug in the same public repo collapse to one
  triage issue, which is the whole point of the occurrence counter); a per-user
  salt would kill that dedup. Unsalted is dictionary-attackable for known public
  repos, but the project id reveals only "which public repo," which is already
  public, so the privacy cost is acceptable. Private-repo origins still hash to
  an opaque value with no path/name leakage.

### 5f. Fingerprint (dedup key)
- Computed in crash_redact AFTER scrub, on the REDACTED data, so client and
  backend derive the identical value.
- `fingerprint = sha256(error_class + "\n" + "\n".join(top_N_stack_signatures))`
  where each stack signature is the symbol/function name only, with file paths,
  line numbers, columns, and addresses stripped (or it would differ per machine).
- N defaults to 5; configurable constant in the module. Same hash function and N
  on client and server -> stable cross-machine dedup.

--------------------------------------------------------------------------------
## 6. First-run disclosure UX + unified opt-out
--------------------------------------------------------------------------------

### 6a. Copy (no emojis, no em dashes -- both are banned)
Shown once, on the first run, before any egress:

  Loki Mode auto-creates the issues you hit at github.com/asklokesh/loki-mode
  and tries to auto-resolve them. If it cannot, we encourage you to open an
  issue for anything causing hesitation.
  We send anonymous diagnostics only (os, arch, version, error type, sanitized
  stack signatures). Never your code, prompts, paths, keys, or repo names.
  See docs/PRIVACY.md. Turn this off anytime with: loki telemetry off

### 6b. Where the one-time flag lives (separate from opt-out)
- Disclosure sentinel: a `DISCLOSURE_SHOWN=true` key in `~/.loki/config` (the
  same global config already read at `autonomy/run.sh:643`). Shown once
  regardless of enable/disable state. Never re-shown after opt-out.
- Reuse `~/.loki/config`; do NOT invent a new sentinel file.

### 6c. Unified opt-out (gates BOTH PostHog usage telemetry AND crash reporting)
Map all switches to the SAME persisted key, and keep honoring the community
standard:
- `LOKI_TELEMETRY=off` (new, spec-mandated) -> treated as disabled.
- `loki telemetry off` (new subcommand on existing `cmd_telemetry`,
  autonomy/loki:17946) -> writes `TELEMETRY_DISABLED=true` to `~/.loki/config`.
- `loki telemetry on` -> removes/sets it false; `loki telemetry status` shows
  BOTH OTEL state (existing) and collection state (new) + pending crash count.
- Existing `LOKI_TELEMETRY_DISABLED=true` and `DO_NOT_TRACK=1` -> still honored.
- The unified check (a single helper, e.g. `loki_collection_enabled` in
  crash.sh and a TS mirror) must be consulted by: `autonomy/telemetry.sh`
  (`_loki_telemetry_enabled`), `dashboard/telemetry.py` (`_is_enabled`),
  `bin/postinstall.js`, AND the new crash flush. Otherwise the disclosure is a
  lie about PostHog events that keep firing.
- Never re-prompt once disabled (the sentinel is independent and never re-shown).

--------------------------------------------------------------------------------
## 7. Backend design
--------------------------------------------------------------------------------

### 7a. Host recommendation: reuse the FastAPI Python stack (dashboard/)
Recommendation: a small FastAPI service, deployed separately from the local
dashboard (dashboard/server.py runs on port 57374 locally; the ingest service
is a hosted deployment, e.g. on the existing `web-app/` / `deploy/` infra).
Justification (strongest single argument): the scrubber is Python, so the
backend can `import crash_redact` and run the EXACT SAME second scrub the client
ran -- no reimplementation, no drift, identical RULES_VERSION. A serverless
function in another language would force a second, divergent scrubber, which is
the primary data-leak risk. Reusing Python keeps one source of truth.
- Alternative considered: serverless (e.g. a single function). Rejected as the
  default precisely because it tends toward a re-implemented scrubber; acceptable
  ONLY if it runs the same Python module.

### 7b. Endpoints
- `POST /v1/crash` -- accept one scrubbed report. Returns 202 always (privacy:
  no confirmation that reveals dedup state to the client).
- `GET /healthz` -- liveness.
- (internal/admin, authn-gated) `GET /v1/crash/stats`, `POST /v1/crash/promote`.

### 7c. Auth model (clients carry NO write secret)
- Clients POST UNAUTHENTICATED but heavily constrained:
  - Strict rate limiting per source IP and per project_id_hash.
  - Body size cap; whitelist-schema validation; reject unknown fields.
  - Server-side second scrub regardless of client claims.
- Optionally a PUBLIC anon ingest key (like the PostHog public key already in
  the repo) for coarse routing/quota -- it is not a secret and grants no write
  access to GitHub. The GitHub write token is NEVER on clients.
- Rationale: any secret shipped in the client is exfiltratable (the repo already
  treats `phc_...` as public for this reason). So the trust boundary is: clients
  can only enqueue scrubbed diagnostics; only the server can write to GitHub.

### 7d. Dedup store
- Start with SQLite (file-backed) keyed by `fingerprint`: columns fingerprint,
  first_seen, last_seen, occurrence_count, private_issue_number, status
  (new|confirmed|promoted|fixed). Trivially swappable for a hosted KV later.

### 7e. GitHub token custody
- A GitHub App installation token or a fine-grained PAT, scoped to the PRIVATE
  triage repo (issues:write) and the PUBLIC repo (pull-requests:write for the
  auto-fix PR). Stored in the backend secret store / env, never returned to
  clients, never logged. Token rotation documented in PRIVACY.md ops notes.

### 7f. Second server-side scrub (mandatory)
- On ingest, before any storage or issue creation: `crash_redact.redact_tree`
  the entire body, then validate against the whitelist schema and DROP unknown
  fields. Record server `redactions_count`; if it is > 0 on a payload the client
  claimed was clean, log a scrubber-miss metric (a client-rule gap to fix).

--------------------------------------------------------------------------------
## 8. The auto-fix loop
--------------------------------------------------------------------------------

Trigger and flow:
1. A novel fingerprint creates a PRIVATE triage issue
   (asklokesh/loki-telemetry). A repeat bumps an occurrence-counter comment.
2. Confirmation gate: a bug is PROMOTED only when confirmed (rule-based on
   occurrence threshold + reproducibility, or a maintainer label). Promotion
   creates/links a sanitized PUBLIC issue (title/body scrubbed; no triage-repo
   internals leak to the public repo).
3. Auto-fix run: the backend (or a scheduled routine) invokes
   `loki start asklokesh/loki-telemetry#<n>` in issue-mode, reusing the existing
   issue plumbing (gh create/comment/close in run.sh: 2200/2078/2092). The agent
   reproduces, fixes, and runs `bash scripts/local-ci.sh`.
4. PR: the resulting PR TARGETS the PUBLIC repo with a SANITIZED description
   (links the public issue, never the raw triage payload). The PR is
   auto-created but NOT auto-merged.

Guards that prevent a bad auto-fix from shipping:
- local-ci gate: PR cannot be opened unless `bash scripts/local-ci.sh` passes
  (the same 42/42 + bun-parity matrix at local-ci.sh:250) on the fix branch.
- council: the standard 3-reviewer council (2 Opus + 1 Sonnet) unanimous, per
  CLAUDE.md, applies to the auto-fix PR like any other.
- NO auto-merge: human merge approval still gates (CLAUDE.md). The pipeline ends
  at "PR open + green + council-approved."
- Idempotency: one open auto-fix PR per fingerprint; the dedup store records
  private_issue_number and PR linkage to avoid duplicate PR storms.
- Sanitization at the boundary: the promotion step re-runs crash_redact on any
  text copied from private -> public, so the public PR/issue can never carry
  raw triage content.

--------------------------------------------------------------------------------
## 9. Risks (named + mitigated)
--------------------------------------------------------------------------------

| Risk | Mitigation |
| --- | --- |
| Scrubber miss -> data leak | Whitelist-ONLY emit (deny by default, 5c) so unlisted fields never ship even if a regex misses; reuse hardened proof_redact (1b); SECOND server-side scrub via the same module (7f); fail closed if python3 missing (5b); golden-vector + negative tests. |
| Undisclosed existing PostHog telemetry | Unified opt-out (6c) gates PostHog AND crash; PRIVACY.md + first-run line describe BOTH; honesty invariant covers existing events. |
| Backend abuse / spam | Unauthenticated-but-rate-limited (per IP + project_id_hash), body-size cap, whitelist-schema validation, 202-always (no oracle), occurrence counter collapses floods into one issue. |
| Auto-fix ships a regression | local-ci gate (42/42 + bun-parity) BEFORE PR; unanimous council; NO auto-merge; one PR per fingerprint; human merge gate per CLAUDE.md. |
| GitHub token exfiltration | Token only on backend (7c/7e); clients carry no write secret; only a public anon ingest key at most. |
| GDPR / CCPA compliance | Anonymous-by-design (no PII in whitelist; emails/IPs denied); disclosed default-on with friction-free persistent opt-out (LOKI_TELEMETRY=off, loki telemetry off, DO_NOT_TRACK=1); project_id_hash is non-reversible; PRIVACY.md documents data categories, retention, opt-out, and deletion-by-fingerprint on request. Default-on is defensible only WITH the disclosure; covert would not be. |
| Dual-route parity burden | Single shared Python scrubber called by both routes (5a) eliminates redaction drift; bun-parity matrix entries for `loki crash` (local-ci.sh:250); commands ported in both `autonomy/loki` and `loki-ts/src/commands/`. |
| Over-reporting normal operation | Conservative capture: only uncaught/ nonzero-exit/provider-failure/explicit friction signals (retry loop, rate-limit loop, gate failure), not routine retries; thresholds before friction fires. |
| python3 absence breaks capture | Fail closed: local write only if scrub ran, never egress without scrub (5b). |
| Fingerprint instability across machines | Hash computed post-scrub on path/line-stripped frame signatures (5f); synthetic two-machine test in Phase 0. |

--------------------------------------------------------------------------------
## 10. Non-goals (explicit)
--------------------------------------------------------------------------------

- NOT auto-merging auto-fix PRs. Human merge approval always gates.
- NOT collecting any PII, code, prompts, PRDs, file contents, paths, or repo
  names. Whitelist-only.
- NOT replacing the existing OTEL `cmd_telemetry` tracing feature; this adds
  subcommands and a separate crash pipeline.
- NOT replacing the existing PostHog usage telemetry; this UNIFIES its opt-out
  and discloses it, but does not rip it out.
- NOT building a real-time crash dashboard UI in this plan (the local dashboard
  may surface a count later; out of scope here).
- NOT a public bug bounty or external contributor intake flow.
- NOT cross-product telemetry beyond loki-mode.
- NOT shipping egress in Phase 0 (local-only proof first).

--------------------------------------------------------------------------------
## Critical Files for Implementation
--------------------------------------------------------------------------------
- /Users/lokesh/git/loki-mode/autonomy/lib/proof_redact.py (reuse / import; the keystone redactor)
- /Users/lokesh/git/loki-mode/autonomy/run.sh (bash capture hooks + telemetry sourcing)
- /Users/lokesh/git/loki-mode/loki-ts/src/cli.ts (TS uncaughtException/unhandledRejection/exit hook + command routing)
- /Users/lokesh/git/loki-mode/autonomy/loki (cmd_crash + telemetry off/on subcommands + dispatch)
- /Users/lokesh/git/loki-mode/dashboard/server.py (FastAPI host to extend for the ingest backend + second scrub)
