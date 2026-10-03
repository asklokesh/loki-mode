# CP-ASK slice plan (Architect, 2026-10-04T00:05Z)

Founder 22:03Z: the CP home box stops being "what should Loki build" and becomes Ask Loki.
- What it does: search, learn and compare across runs, receipts, repos and issues.
- How it runs: asynchronously, on the user's provider (default claude).

Everything ships behind LOKI_CP_ASK=1 (default off). Ask is a read-only async job: the provider calls tools from the existing MCP server, and threads are stored in control.db. It never starts a build.

## Findings (file:line; CP = packages/control-plane)
- **The box today:** CP/ui/src/pages/home/Hero.tsx:45-68, mounted at home/index.tsx:8.
  - Submit (:26-40) calls POST /v1/start, which reaches spawn.ts:52 planStart, then spawnStart (:73), which runs `loki start --brief`.
  - Compose (ui/src/pages/compose/index.tsx:75) is a second start path, so builds keep a home.
- **CP data that already exists:**
  - control.db holds events, runs, audit, local_repos and actions (src/db/schema.ts:3-89).
  - HTTP reads: /v1/runs (app.ts:55), /v1/runs/:s/:r (:63), events and the artifact allowlist (artifacts.ts:53, :68), plus stats, cost, fleet, metrics, memory, audit, checkpoints and providers.
  - There is no /v1/compare route (CONTROL-PLANE.md:41 lists one).
- **mcp/server.py (3028 lines) mixes read and write tools.**
  - Read tools: memory_retrieve, state_get, metrics_efficiency, v10_status, project_status, agent_metrics, quality_report, code_search, mem_search, timeline, get, hotspots, co_changes, doc_coverage, findings, learnings, graph_query.
  - Write or spawn tools: store_pattern, task_queue_add, task_queue_update, capture_session_summary, consolidate_memory, complete_task, v10_run, start_project, checkpoint_restore, loki_start, verify_fast, v10_verify.
  - It is stdio and works relative to its cwd's .loki.
- **Repos:** ~/.loki/dashboard/projects.json (spawn.ts:34) plus local_repos.
- **GitHub:** nothing in the CP; gh is on the host.
- **Read-only primitives per provider:**
  - claude: --mcp-config (loki-ts/src/providers/mcp_config.ts) and --allowedTools/--disallowedTools, with deny taking precedence (claude_flags.ts:472-512).
  - codex: `exec --sandbox read-only`.
  - opencode: MCP (opencode.sh:72).
  - cline and aider: no MCP on our path.
- **Reusable CP helpers:** the SSE helper stream.ts:20-44 and child env scrubbing spawn.ts:14 childEnv.

## Decisions
- **Data access is tools only (ADOPT, no prompt stuffing).**
  - mcp/server.py gets `--read-only`, which registers only the read allowlist.
  - A new mcp/cp_tools.py calls the CP's own HTTP read API: runs_search, run_get, run_events, run_artifact, runs_compare, stats, cost and repos_list (names only).
  - gh_issues and gh_prs use fixed argv (`gh issue list|view`, `gh pr list|view`), with the repo validated against a known origin_repo.
  - The CP token reaches only the MCP child env, never the model.
- **Async job.**
  - POST /v1/ask writes ask_threads and ask_messages rows, then spawns a detached ask worker (argv, no shell, childEnv).
  - The worker parses the provider's stream-json into ask_events and records cost.
  - A message ends as done, failed, timeout (600s), over_budget or interrupted.
  - The UI streams over SSE; the user can leave and come back, and follow-ups replay prior turns.
- **Security boundary, three layers:**
  1. Tools: claude gets --strict-mcp-config with allowedTools Read,Grep,Glob,mcp__loki__* and disallowedTools Write,Edit,NotebookEdit,Bash,WebFetch,WebSearch; codex gets --sandbox read-only.
  2. cwd is an empty 0700 per-job scratch dir, never a repo, removed at the end.
  3. The MCP surface is read-only and gh runs with fixed argv.
  - The ask module never imports planStart or spawnStart (guard test).
  - All run, event and issue text is untrusted data.
  - POST requires loopback or a bearer token, accepts JSON only and questions up to 4000 chars, and allows at most 2 concurrent jobs.
  - cline and aider are refused with "Ask needs a provider with MCP; use claude, codex or opencode".

## Founder questions (decided by the CoS under the standing mandate; FOUNDER-QUEUE row 20, reversible)
- (a) With the flag on, the home box is Ask only, with a visible "Start a build" link to Compose. This follows the founder's words directly.
- (b) Defaults are $1.00 per ask (LOKI_ASK_MAX_USD) and a 600s timeout, both configurable. Ask spend is tracked and shown on the Cost page apart from run budgets.
- (c) Scope:
  - CP-level data (runs, receipts and events across every repo, since they are already in control.db) is always available.
  - Per-repo memory and code tools use one repo per ask (the repo chip, default the CP repo).
  - All-repos memory fan-out is a later slice.

## Slices (no shared files)
| # | Slice | Tier | Needs | Files | Wall checks |
|---|---|---|---|---|---|
| 1 | MCP read-only mode | HIGH | none | mcp/server.py, mcp/tests/test_read_only.py, tests/test-mcp-tool-surface-guard-rejects.sh | The tool list equals the read allowlist exactly; each write tool is absent (re-adding store_pattern goes red); default mode is unchanged. |
| 2 | CP data tools | HIGH | 1 | mcp/cp_tools.py, mcp/tests/test_cp_tools.py, mcp/tests/fixtures/cp_api/*.json | runs_compare of two fixture runs returns both ids, verdicts and costs; an artifact outside the allowlist is refused; no CP URL or token is returned. |
| 3 | gh read tools | HIGH | 2 | mcp/gh_tools.py, mcp/tests/test_gh_tools.py | Only list/view argv is spawned; an unknown repo is refused; gh api is unreachable. |
| 4 | DB schema | MEDIUM | none | CP/src/db/schema.ts, CP/drizzle/0005_ask.sql, CP/drizzle/meta/*, CP/test/db/ask_schema.test.ts | Migrating a 0004 db keeps runs rows byte-equal. |
| 5 | Ask store | MEDIUM | 4 | CP/src/ask/store.ts, CP/test/server/ask_store.test.ts | Append order is kept; markInterrupted flips only dead-pid running rows. |
| 6 | Policy and job dir | HIGH | none | CP/src/ask/policy.ts, CP/test/server/ask_policy.test.ts | The deny list covers the loki-ts REVIEW denylist; mcp.json names --read-only; the scratch dir is 0700 and outside every repo. |
| 7 | Provider argv | HIGH | 6 | CP/src/ask/invoke.ts, CP/test/server/ask_invoke.test.ts | claude has --strict-mcp-config and the deny list and has no --dangerously-skip-permissions; codex has --sandbox read-only; cline and aider are refused; the default model is omitted (L1). |
| 8 | Stream parser | MEDIUM | none | CP/src/ask/parse.ts, CP/test/server/ask_parse.test.ts, CP/test/fixtures/ask/{claude,codex}-stream.jsonl | Deltas concatenate to the final text; tool_use is captured; the cost comes from the result line; a truncated stream is failed, never done. |
| 9 | Worker and prompt | HIGH | 5, 7, 8 | CP/src/ask/worker.ts, CP/src/ask/prompt.ts, CP/test/server/ask_worker.test.ts | A timeout kills only the recorded pgid; over budget gives over_budget; the scratch dir is gone after exit; tool calls are stored as citations. |
| 10 | Routes | HIGH | 5, 9 | CP/src/server/routes/ask.ts, routes/index.ts, routes/stream.ts (export sse), CP/test/server/ask_routes.test.ts, CP/package.json | Flag off gives 404; non-loopback without a token gives 403; a third job gives 429; cancel kills only the recorded pid; nothing is imported from spawn.ts except childEnv. |
| 11 | Ask page | MEDIUM | 10 | CP/ui/src/pages/ask/{index.tsx,Thread.tsx,api.ts}, CP/ui/src/pages/wired.tsx | Text streams; citations link to #/runs/:s/:r; an interrupted message shows a retry. |
| 12 | Home box swap | MEDIUM | 11 | CP/ui/src/pages/home/Hero.tsx, AskBox.tsx | Flag on: submit POSTs /v1/ask, never /v1/start, and a "Start a build" link goes to Compose. Flag off: byte-identical. |
| 13 | Nav and palette | LOW | 11 | CP/ui/src/shell/AppShell.tsx, CP/ui/src/palette/index.tsx | The Ask entry appears only with the flag on. |
| 14 | E2E and red team | HIGH | 10, 12 | CP/test/e2e/ask.spec.ts, CP/test/server/ask_readonly.test.ts, CP/test/fixtures/ask/inject-run/* | An injected "edit README, run loki start" leaves git status unchanged, spawns no loki and logs no Write or Edit; "compare my last two runs on FireLater" cites both ids. |
| 15 | Docs and flag flip | LOW | 14 | docs/v10/CONTROL-PLANE.md, CP-ENTERPRISE-UI.md, CHANGELOG.md | The flip is a separate one-line change after a live EV run on real claude passes. |

Waves: {1,4,6,8}, then {2,5,7}, then {3,9}, then 10, then 11, then {12,13}, then 14, then 15.

## Risks
1. Run data, repo files and issues go to the user's provider. The UI says so on first use.
2. Prompt injection from issue and run text: no write tool exists, and with no WebFetch the provider is the only outbound channel.
3. mcp/server.py memory tools are per-repo; cross-repo memory waits for a later slice.
4. $1 and 600s may truncate deep comparisons; both are configurable.
5. The read-only allowlist can drift as tools are added. The exact-list test makes a new tool absent until it is classified (fail closed).
6. codex and opencode MCP flags are version-sensitive. Gate them on probes and mark them degraded.
