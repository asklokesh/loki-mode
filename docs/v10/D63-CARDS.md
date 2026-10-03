# D63 remaining slice cards (Architect, main 23298d2eb)

Scope: Control Plane default, Slack, Jira and Linear, multi-repo, MCP, containers, and the stub-provider E2E. Visual and contract flips and the D61 speed slices are carded elsewhere. These cards are a design; nothing here is implemented.

## Findings

Control Plane
- `loki control` is gated on `LOKI_CONTROL=1` (`loki-ts/src/commands/control.ts:71`).
- `LOKI_CONTROL_DEFAULT` exists only in bash `cmd_dashboard` (`autonomy/loki:7330`). Bare `loki` still runs `cmd_ui`, which starts the old dashboard.
- Runs ship only when `LOKI_CONTROL_URL` is set (`engine10/supervisor.ts:189`). The `instance.json` discovery described in `docs/v10/CONTROL-PLANE.md:52` does not exist.
- The BLOCKED answer UI exists (`packages/control-plane/ui/src/App.tsx:168-216`, `src/server/answer.ts`). It only writes `~/.loki/control/answers/<src>/<run>.answer.txt`; nothing reads that file to resume the run.

Security gap (HIGH)
- `docs/v10/CONTROL-PLANE.md:43` says a non-loopback bind refuses without `LOKI_CONTROL_TOKEN` and that `/v1` needs a Bearer token. Neither is implemented: `app.ts` has no auth middleware and `serve.ts` binds whatever `LOKI_CONTROL_HOST` says.
- `Dockerfile.control-plane`, the Helm chart and the ECS task all set `0.0.0.0`, so the shipped container exposes unauthenticated ingest and answer-write on every interface.
- On loopback there is no Host check (DNS rebinding).

Routing (`bin/loki`)
- `slack` is missing from the Bun allowlist at `bin/loki:570`, so the documented `loki slack serve` is unreachable from an installed CLI.
- `jira:PROJ-1` and `linear:ENG-42` are one word and fall to the legacy engine.
- Linear URLs (`/issue/`, singular) match neither `*/issues/*` nor `*/browse/*` and also go legacy. Only Jira `https://...atlassian.net/browse/` URLs reach v10.

Slack
- The default launcher spawns `process.execPath process.argv[1] <task>`, which is `cli.ts`, not `bin/loki`; `cli.ts` has no task route, so the launch fails.
- The launcher passes `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` into the child run's env.
- Outbound with no webhook is already a clean no-op (`engine10/adapters/slack.ts:19`).

Jira and Linear
- Already on with no flag. A missing credential throws an error naming the variable, before any LLM call. Self-hosted Jira URLs are not parsed.

Multi-repo
- `autonomy/lib/workspace.py` is a 290-line compact version: repos run sequentially; no `show`, `status` or `clean`; no exit code 3; SIGINT not handled. The gate exists twice (`workspace.py:50`, `autonomy/loki:12926`).

MCP
- The three v10 tools are always registered. `mcp/tests/test_v10_tools.py` is not run by any runner, workflow or local-ci.

Containers
- Files exist; the only check is `packages/control-plane/test/deploy/container.test.ts`. The Dockerfile comment says "no authentication of its own". The token is optional in Helm.

Stub provider (BUG-2 in E2E-D65.md)
- A usage gap, not missing code: `LOKI_E10_INVOKER=cli` plus `LOKI_CLAUDE_CLI=<stub>` already drives v10 with a stub (`scripts/first-run-gate.sh:98`, `docs/v10/FIRST-RUN-GATE.md:11`).

## File-set rules for every card
- CHANGELOG: each card supplies its sentence; the Release Manager writes `CHANGELOG.md` at the train. No card edits it.
- README: each card edits only the README section it names.
- Headless tests: `LOKI_NO_BROWSER=1`, a throwaway `HOME`, `--port 0` or a stub server, never a port in 57374-57399. Stop only recorded PIDs; never kill by name or pattern.
- Every spawn under `loki-ts/src` passes an explicit env. No stored credentials are read.
- No new `tests/*.sh` except in C5, which owns `tests/run-all-tests.sh` and `tests/shard-durations.tsv`. Other cards extend existing suites.
- Caps: core engine10 has 64 lines left (D71), e10ext 33 lines left. New code goes in `loki-ts/src/features` or `packages/`.

---

## C1 CP-AUTH: Control Plane auth enforced as documented
- Tier: HIGH (auth, security). Budget: 30 min.
- Goal:
  - With `LOKI_CONTROL_TOKEN` set, every `/v1/*` call needs `Authorization: Bearer <token>`, compared with `timingSafeEqual`. `/health` and `/ready` stay open.
  - A non-loopback `LOKI_CONTROL_HOST` without a token refuses to start: exit 2 with a line naming `LOKI_CONTROL_TOKEN`. Override: `LOKI_CONTROL_ALLOW_INSECURE_BIND=1`.
  - On loopback, a request whose Host is not `127.0.0.1`, `localhost` or `[::1]` (any port) gets 403.
  - The UI accepts `#token=` once, keeps it in sessionStorage and sends it on each call.
- Files:
  - `packages/control-plane/src/server/auth.ts` (new), `packages/control-plane/src/server/app.ts`, `packages/control-plane/src/server/serve.ts`
  - `packages/control-plane/ui/src/api.ts`, `packages/control-plane/ui/dist/**` (rebuild)
  - `packages/control-plane/test/server/auth.test.ts` (new)
  - `docs/v10/CONTROL-PLANE.md` (Auth section only)
- Wall checks:
  - With a token: no header 401, wrong token 401, right token 200 on GET `/v1/runs`, POST `/v1/ingest`, POST `.../answer`.
  - No token on loopback: behaviour unchanged, existing tests green.
  - `serve.ts` with `LOKI_CONTROL_HOST=0.0.0.0` and no token exits 2 without binding (explicit env, port 0).
  - `Host: evil.example` on loopback gives 403.
  - Mutation: removing the middleware turns the 401 tests red.
- Commands: `cd packages/control-plane && bun test ./test/ && bun run typecheck && bun run build:all`
- CHANGELOG: "The Control Plane now enforces `LOKI_CONTROL_TOKEN` on every API call and refuses to listen on a non-loopback address without one."
- Docs: `docs/v10/CONTROL-PLANE.md` Auth section.
- Dependencies: none. Blocks C10.

## C2 CP-DEFAULT: Control Plane on by default; local runs ship to it
- Tier: MEDIUM. Budget: 30 min.
- Goal:
  - `LOKI_CONTROL` defaults on; `LOKI_CONTROL=0` prints one "off" line and exits 0.
  - `serve` reads the child's "listening on" line and writes `~/.loki/control/instance.json` `{pid, port, url, version, install_path, db}` (mode 0600), removed when the CLI exits.
  - The ship hook ships when `LOKI_CONTROL_URL` is set, or when `instance.json` names a live pid (`kill -0`) whose `/health` answers `service=loki-control` within 300 ms. It never starts a server. `LOKI_CONTROL=0` disables discovery.
- Files:
  - `loki-ts/src/commands/control.ts`
  - `packages/control-plane/src/shipper/discover.ts` (new)
  - `loki-ts/src/e10ext/ship_hook.ts` (at most 8 lines)
  - `loki-ts/src/engine10/supervisor.ts` (line 189 only, 1-line condition change)
  - `loki-ts/tests/commands/control_default.test.ts` (new)
  - `tests/test-control-plane.sh` (update the "ungated" assertion)
  - `docs/v10/CONTROL-PLANE.md` (sections 5 and 6)
  - README "Control Plane" section
- Wall checks:
  - No `instance.json` gives zero fetch calls (injected fetch).
  - A stale pid is ignored; a live stub `/health` with the wrong service is ignored; a valid instance gives one ship.
  - `LOKI_CONTROL=0` gives no discovery.
  - `instance.json` is mode 0600 and gone after serve exits.
  - `budget.test.ts` passes (core under 5000, e10ext under 1500).
- Commands: `cd loki-ts && bun test tests/commands/control_default.test.ts tests/engine10/budget.test.ts && bunx tsc --noEmit`; `bash tests/test-control-plane.sh`
- CHANGELOG: "The Control Plane is on by default: `loki control serve` needs no flag, and runs on this machine appear in it automatically while it is running."
- Docs: `docs/v10/CONTROL-PLANE.md` sections 5 and 6, README Control Plane section.
- Dependencies: none. C3 builds against its `instance.json` contract.

## C3 BASH-FLIPS: bare `loki` opens the Control Plane; workspace gate flips
- Tier: MEDIUM. Budget: 30 min.
- Goal:
  - `cmd_ui` (bare `loki`) and `cmd_dashboard ""|start|open` use the Control Plane by default; `LOKI_CONTROL_DEFAULT=0` restores the old dashboard.
  - Reuse a live `instance.json` URL; otherwise start `loki control serve` detached, record its PID and print the URL.
  - Headless (`LOKI_HEADLESS=1`, `LOKI_NO_BROWSER=1` or `--no-open`): print only, never open.
  - No bun: the old dashboard plus one line naming bun.
  - `cmd_workspace`: the gate becomes "`LOKI_WORKSPACES=0` disables".
  - Help lines 1633 and 1786 drop "preview" and "needs".
- Files:
  - `autonomy/loki` (`cmd_ui`, `cmd_dashboard` head, `cmd_workspace`, the two help lines only)
  - `tests/test-ui-bare-loki.sh` (pin the legacy leg to `LOKI_CONTROL_DEFAULT=0`; add a Control Plane leg with a python stub answering `/health` with `service=loki-control`)
  - `docs/dashboard.md` or the nearest dashboard doc (one paragraph)
- Wall checks:
  - Control Plane leg: bare `loki` with `LOKI_NO_BROWSER=1` and a stub `instance.json` prints the stub URL; the logging `open` stub has zero calls.
  - Legacy leg output unchanged.
  - No port in 57374-57399 bound (lsof on recorded PIDs).
  - shellcheck on the changed test; `bash -n autonomy/loki`.
- Commands: `bash tests/test-ui-bare-loki.sh; bash -n autonomy/loki; shellcheck tests/test-ui-bare-loki.sh`
- CHANGELOG: "`loki` with no arguments now opens the Control Plane (set `LOKI_CONTROL_DEFAULT=0` for the previous dashboard)."
- Docs: dashboard doc paragraph.
- Dependencies: merges on the same train as C2 or one later.

## C4 BLOCKED-RESUME: `loki answer` closes the BLOCKED loop
- Tier: MEDIUM. Budget: 30 min.
- Goal:
  - New `loki answer [<run-id>] [--text "..."]`; default run is the newest BLOCKED run.
  - Reads the run's task and question from events, and the answer from `--text` or the Control Plane answer file.
  - Launches `bin/loki "<task>\n\nClarification answering \"<q>\": <a>"` with an explicit env (`LOKI_NO_BROWSER=1`; no `SLACK_*` and no `LOKI_CONTROL_TOKEN`) and prints the new run id.
  - Refuses a run that is not BLOCKED (exit 2, says why).
  - The Control Plane `writeAnswer` resume string becomes `loki answer <run>`.
- Files:
  - `loki-ts/src/features/blocked_answer.ts` (new, at most 120 lines)
  - `loki-ts/src/cli.ts` (`answer` case plus the `control` help line)
  - `packages/control-plane/src/server/answer.ts` (resume string only)
  - `loki-ts/tests/features/blocked_answer.test.ts` (new)
  - `packages/control-plane/test/server/answer.test.ts` (resume assertion)
  - `docs/v10/CONTROL-PLANE.md` ("Answering a BLOCKED run" section)
  - README "Answering a BLOCKED run" paragraph
- Wall checks:
  - A fixture BLOCKED run plus an answer file gives a spawn argv containing the task, question and answer (spawn injected).
  - The env lacks `SLACK_BOT_TOKEN` and has `LOKI_NO_BROWSER=1`.
  - A non-BLOCKED run gives exit 2.
  - The features budget test passes.
- Commands: `cd loki-ts && bun test tests/features/blocked_answer.test.ts tests/engine10/budget.test.ts && bunx tsc --noEmit`; `cd packages/control-plane && bun test test/server/answer.test.ts`
- CHANGELOG: "`loki answer` resumes a BLOCKED run with the answer typed in the Control Plane (or `--text`)."
- Docs: CONTROL-PLANE.md section and README paragraph above.
- Dependencies: CLI reachability via C5 (unit tests independent).

## C5 ROUTING: shim entry points for D65 features
- Tier: MEDIUM. Budget: 20 min.
- Goal:
  - The `bin/loki:570` Bun allowlist gains `slack|answer`.
  - v10 routing (top level and the `start` case) gains `jira:*|linear:*|https://linear.app/*/issue/*`.
- Files:
  - `bin/loki`
  - `tests/test-d65-routing.sh` (new, `timeout -k`)
  - `tests/run-all-tests.sh` (one `run_test` row)
  - `tests/shard-durations.tsv` (one row)
- Wall checks:
  - With a probe bun that echoes argv: `loki slack serve` and `loki answer x` reach `cli.ts`; `loki jira:ABC-1`, `loki linear:ENG-2` and a Linear URL reach `engine10`; one-word `loki foo` stays legacy.
  - Real-CLI leg: `loki jira:ABC-1` with no `JIRA_*` env exits non-zero in under 5 s, names `JIRA_BASE_URL`, and the stub claude logs zero calls.
  - `tests/test-shard-coverage.sh` and shellcheck pass.
- Commands: `bash tests/test-d65-routing.sh; bash tests/test-shard-coverage.sh; shellcheck bin/loki tests/test-d65-routing.sh`
- CHANGELOG: "`loki jira:KEY`, `loki linear:KEY`, Linear issue URLs and `loki slack serve` now reach the Loki 10 engine directly."
- Docs: none beyond C6 and C7 docs.
- Dependencies: none. Merge early; C4, C6, C7, C11a, C11b CLI-level checks rely on it.

## C6 SLACK: two-way Slack polished and on by default
- Tier: MEDIUM. Budget: 25 min.
- Goal:
  - Inbound defaults on; `LOKI_SLACK_INBOUND=0` disables.
  - With no `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET`: one line naming both, exit 2, nothing bound.
  - The launcher spawns `REPO_ROOT/bin/loki` (not `argv[1]`) with an explicit env that strips both Slack secrets and sets `LOKI_NO_BROWSER=1`.
  - The poster logs an HTTP failure as one redacted line.
  - Outbound unchanged: no webhook, no call.
- Files:
  - `loki-ts/src/features/slack_inbound.ts`
  - `loki-ts/tests/features/slack_inbound.test.ts`
  - `docs/slack.md`
  - README Slack paragraph (around line 173)
- Wall checks:
  - No credentials: exit 2 and `Bun.serve` never called (injected).
  - Spawn argv[0] ends in `bin/loki`; env lacks both Slack secrets.
  - Signed `url_verification` returns the challenge; a bad signature returns 401.
  - BLOCKED (exit 4) posts the question; a thread reply relaunches with the clarification.
  - `LOKI_SLACK_INBOUND=0` gives exit 2 with the disabled line.
- Commands: `cd loki-ts && bun test tests/features/slack_inbound.test.ts && bunx tsc --noEmit`
- CHANGELOG: "Two-way Slack is on by default: with a bot token and signing secret, `@loki <task>` in a thread starts a run and a BLOCKED question is answered in the same thread."
- Docs: `docs/slack.md`, README Slack paragraph.
- Dependencies: CLI reachability via C5.

## C7 TRACKERS: Jira and Linear intake polish
- Tier: MEDIUM. Budget: 20 min.
- Goal:
  - `LOKI_TRACKER_INTAKE=0` kill switch (`parseTrackerRef` returns null).
  - Self-hosted Jira: `<JIRA_BASE_URL>/browse/KEY` parses when its origin equals `JIRA_BASE_URL`.
  - Error text names the exact variables per tracker (the one fix).
  - Linear: `errors[]` with no data, or HTTP 401, names `LINEAR_API_KEY`.
  - Intake only; no sync claims.
- Files:
  - `loki-ts/src/features/tracker_intake.ts`
  - `loki-ts/tests/engine10/tracker_intake.test.ts`
  - `docs/trackers.md` (new)
  - README "Issue intake" paragraph
- Wall checks:
  - Injected fetch only; zero network.
  - Self-hosted URL parses only when `JIRA_BASE_URL` matches, else null.
  - Kill switch gives null.
  - Missing credentials: message names the variable.
  - ADF fixture output unchanged.
- Commands: `cd loki-ts && bun test tests/engine10/tracker_intake.test.ts && bunx tsc --noEmit`
- CHANGELOG: "Jira (cloud and self-hosted) and Linear issues start a Loki 10 run with `loki jira:KEY` or `loki linear:KEY`, using credentials from the environment only."
- Docs: `docs/trackers.md`, README Issue intake paragraph.
- Dependencies: CLI reachability via C5.

## C8 WORKSPACES: multi-repo parity and the flag flipped
- Tier: MEDIUM. Budget: 30 min.
- Goal:
  - `enabled()` defaults on; `LOKI_WORKSPACES=0` disables.
  - Repos with no pending `after` run in parallel, bounded by `concurrency` (default 2).
  - Add `show <ws>` and `status [<run>]`, reading `integration.json`.
  - Exit 3 when the only non-ok outcomes are budget stops (child exit 3); 1 otherwise.
  - SIGINT handled like SIGTERM (killpg on recorded PIDs).
- Files:
  - `autonomy/lib/workspace.py`
  - `tests/test_workspace.py`
  - `tests/workspace/50-run.sh` (new part, auto-sourced by the registered `tests/test-workspace.sh`)
  - `docs/WORKSPACES.md`
  - `docs/v10/D51-PHASE-B.md` (status block)
  - `tests/docs-drift-allowlist.tsv` (remove rows 44-46; the commands now exist)
- Wall checks (stub launcher):
  - Two independent repos overlap in time (start timestamps).
  - The `after` dependent starts after its predecessor; a failed predecessor makes it SKIPPED.
  - All children exiting 3 gives group exit 3.
  - `status` prints per-repo rows.
  - `LOKI_WORKSPACES=0` gives exit 2.
  - The docs drift guard passes.
- Commands: `python3 -m pytest tests/test_workspace.py -q && bash tests/test-workspace.sh` plus the suite that reads `docs-drift-allowlist.tsv`
- CHANGELOG: "Multi-repo workspaces are on by default: `loki workspace run <ws> <ref>` runs each repo in parallel, respects `after` ordering and records integration evidence."
- Docs: `docs/WORKSPACES.md`, `docs/v10/D51-PHASE-B.md`.
- Dependencies: the bash gate flip is in C3; `workspace.py` is gated independently, so either order works.

## C9 MCP: v10 tools wired into CI and documented
- Tier: MEDIUM. Budget: 20 min.
- Goal:
  - `mcp/tests/test_v10_tools.py` runs in CI through the existing `tests/test-mcp-server.sh` (no new runner row).
  - `_env()` forces `LOKI_NO_BROWSER=1` and drops `LOKI_CONTROL_TOKEN` and the Slack secrets.
  - `v10_status` returns `blocked_question` when the verdict is BLOCKED.
  - `v10_run` passes `jira:` and `linear:` refs through; the leading-dash guard stays.
- Files:
  - `mcp/v10_tools.py`
  - `mcp/tests/test_v10_tools.py`
  - `tests/test-mcp-server.sh`
  - `docs/mcp.md` (or the existing MCP doc)
  - README MCP section (with the `claude mcp add` line)
- Wall checks:
  - pytest green.
  - The suite counts the v10 tests (positive control: one deliberately failing assert, run locally, turns the suite red).
  - Child env has no secrets.
  - A BLOCKED fixture returns the question.
  - `tests/test-mcp-tool-surface-packaged.sh` still lists all three tools.
- Commands: `python3 -m pytest mcp/tests/test_v10_tools.py -q && bash tests/test-mcp-server.sh && bash tests/test-mcp-tool-surface-packaged.sh`
- CHANGELOG: "The MCP server's `loki_v10_run`, `loki_v10_status` and `loki_v10_verify` tools are tested in CI and report a BLOCKED run's question."
- Docs: MCP doc, README MCP section.
- Dependencies: none.

## C10 CONTAINERS: image, Helm and ECS aligned with token auth
- Tier: MEDIUM (the reviewer reads C1). Budget: 20 min.
- Goal:
  - Dockerfile: drop the "no authentication" comment; document that `LOKI_CONTROL_TOKEN` is required on `0.0.0.0`.
  - Helm: `controlToken.existingSecret` required, failing at template time when unset (`required`), unless `allowInsecureBind: true` sets `LOKI_CONTROL_ALLOW_INSECURE_BIND=1`.
  - ECS: already maps the token; README states it.
- Files:
  - `Dockerfile.control-plane`
  - `deploy/helm/control-plane/**`
  - `deploy/ecs/**`
  - `docs/control-plane-container.md`
  - `packages/control-plane/test/deploy/container.test.ts`
- Wall checks (static, no helm or docker needed):
  - The deployment template references the `LOKI_CONTROL_TOKEN` `secretKeyRef` and a `required` guard.
  - The ECS task carries `LOKI_CONTROL_TOKEN` via `valueFrom`.
  - Dockerfile has `USER loki`, a HEALTHCHECK on `/ready`, and no "no authentication" text.
  - If `helm` is on PATH: `helm template` without the secret fails and with it succeeds. Otherwise the test prints SKIP (helm absent) and never passes silently.
- Commands: `cd packages/control-plane && bun test test/deploy/`
- CHANGELOG: "The Control Plane container, Helm chart and ECS task now require an access token whenever the service is exposed beyond localhost."
- Docs: `docs/control-plane-container.md`, `deploy/helm/README.md`, `deploy/ecs/README.md`.
- Dependencies: ships on the same train as C1 or later, never before.

## C11a E2E-HARNESS: hermetic `npm pack` E2E, legs 1-4
- Tier: MEDIUM. Budget: 30 min.
- Goal: `scripts/e2e-d65.sh`
  - `npm pack`, install into a temp prefix under a run-owned dir (`loki_run_tmp_create` pattern) with a throwaway `HOME` and `npm_config_cache`.
  - Stub `claude` on PATH (reuse the `first-run-gate.sh` stub shape; writes only on a real `-p` call).
  - `LOKI_E10_INVOKER=cli`, `LOKI_CLAUDE_CLI=<stub>`, `LOKI_NO_BROWSER=1`, `GIT_CONFIG_GLOBAL=/dev/null`; no `*_API_KEY` or `*_TOKEN` (`env -i` plus an allowlist).
  - Sources `scripts/e2e-d65/legs/*.sh`; prints one `PASS|FAIL|SKIP(<reason>)` per leg; exit 0 if and only if there is no FAIL.
  - `E2E_FORCE_FAIL=<leg>` is a positive control.
- Legs:
  - 1 D61 speed: `LOKI_SPEED=1` on a 2-file fixture task; receipt exists.
  - 2 Visual evidence: no Playwright gives a NOT PROVEN line, not a failure.
  - 3 Control Plane: `serve --port 0` (recorded PID); a run ships via `instance.json`; GET `/v1/runs` has at least one row; POST `answer` on the BLOCKED fixture returns 200.
  - 4 Slack: `serve --port 0` with fake secrets; signed `url_verification` returns the challenge; bad signature returns 401; nothing outbound.
- Files:
  - `scripts/e2e-d65.sh` (new)
  - `scripts/e2e-d65/legs/01-speed.sh`, `02-visual.sh`, `03-control.sh`, `04-slack.sh` (new)
  - `scripts/e2e-d65/stub-claude.sh` (new)
- Wall checks:
  - shellcheck clean.
  - A run on the current tree exits 0, or each FAIL names a bug.
  - `E2E_FORCE_FAIL=3` gives exit 1.
  - Afterwards no recorded PID is alive and the run dir is removed.
- Commands: `bash scripts/e2e-d65.sh` (timeout 10 min); `shellcheck scripts/e2e-d65.sh scripts/e2e-d65/*.sh scripts/e2e-d65/legs/*.sh`
- CHANGELOG: none (tooling); C11b documents it in `docs/v10/E2E-D65.md`.
- Dependencies: final run after C1-C10 merge; leg 3 needs C2, leg 4 needs C5 and C6.

## C11b E2E-LEGS: legs 5-9 and the results doc
- Tier: MEDIUM. Budget: 30 min.
- Legs:
  - 5 Jira: `jira:ABC-1` against a local fake `JIRA_BASE_URL=http://127.0.0.1:<port0>` gives a run whose `issue.json` has `source=jira`; with no credentials it exits fast naming the variable.
  - 6 Spec to contract: a `.loki/contract.json` fixture gives a receipt containing the contract section.
  - 7 Multi-repo: two local git repos in `loki.yaml` give two runs plus `integration.json`.
  - 8 MCP: `python3` imports `mcp.v10_tools` from the installed package; `v10_status` then `v10_verify` on leg 6's repo.
  - 9 Containers: deploy files exist in the repo; if `docker` is on PATH and the daemon answers, build `Dockerfile.control-plane` and probe `/ready` on a random host port; otherwise SKIP(docker unavailable), never PASS.
- Results doc: append section 6 "Stub E2E (`scripts/e2e-d65.sh`)" to `docs/v10/E2E-D65.md` with version, date, per-leg table (exit codes, seconds), the note that BUG-2 is resolved by `LOKI_E10_INVOKER=cli`, and which legs SKIP and why.
- Files:
  - `scripts/e2e-d65/legs/05-jira.sh`, `06-contract.sh`, `07-workspaces.sh`, `08-mcp.sh`, `09-containers.sh` (new)
  - `docs/v10/E2E-D65.md`
- Wall checks: as C11a, plus every leg is cited with its rc line in the doc.
- Commands: `bash scripts/e2e-d65.sh` (with the C11a harness)
- CHANGELOG: none (tooling).
- Docs: `docs/v10/E2E-D65.md`.
- Dependencies: C11a harness; leg 5 needs C5 and C7, leg 7 needs C8, leg 8 needs C9, leg 9 needs C10.

## C12 STUB-INVOKER (optional; drop if fix-e2e-bugs already owns BUG-2)
- Tier: MEDIUM. Budget: 15 min.
- Goal: setting `LOKI_CLAUDE_CLI` implies `LOKI_E10_INVOKER=cli`, so a stub path alone drives v10. Core edit at most 3 lines.
- Files:
  - `loki-ts/src/engine10/session.ts` (around line 39 only)
  - `loki-ts/tests/engine10/session_invoker.test.ts` (new)
  - `docs/v10/FIRST-RUN-GATE.md` (one line)
- Wall checks:
  - `LOKI_CLAUDE_CLI` set: env has no `LOKI_SDK_LOOP`.
  - Unset: unchanged (`LOKI_SDK_LOOP=1`).
  - Budget test passes.
- Commands: `cd loki-ts && bun test tests/engine10/session_invoker.test.ts tests/engine10/budget.test.ts`
- CHANGELOG: "Setting `LOKI_CLAUDE_CLI` now selects the Claude CLI invoker, so a stub or custom `claude` binary drives Loki 10 directly."
- Docs: `docs/v10/FIRST-RUN-GATE.md`.
- Dependencies: none; C11a works without it.

---

## Ordering and parallelism
All 12 cards can start now; file sets do not overlap. C1 (HIGH, opus reviewer) is the critical path and goes on the first train; C10 ships on the same train or later. C5 merges early because the CLI-level checks of C4, C6, C7 and both E2E cards reach their commands through it. C2 and C3 together make the Control Plane the default; they build in parallel against C2's `instance.json` contract, and C3 merges on the same train as C2 or one later. C11a and C11b start in parallel, but the final E2E runs only on a tree containing C1-C10. C12 goes only if fix-e2e-bugs has not fixed BUG-2. With 8 engineers: C1, C5, C2, C6, C7, C8, C9, C4 first; then C3, C10, C11a, C11b, C12 as seats free. Only C1 needs the HIGH review.
