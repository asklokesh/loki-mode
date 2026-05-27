# Changelog

For the complete release history and detailed changes, see the main [CHANGELOG.md](../CHANGELOG.md) in the repository root.

## Recent Releases (current track: v7.7.x)

### [7.7.14] - 2026-05-27

Fixed:
- **Critical LSP regression** silently broken since v7.7.0. `lsp_get_diagnostics` returned empty array unconditionally because `LSPClient` had no notification reader thread; `request()` busy-read loop dropped every `publishDiagnostics`. Now a dedicated daemon reader thread owns `proc.stdout`, routes responses to per-request Queues, routes `publishDiagnostics` into `pending_diagnostics`. Re-spawn after crash cleanly stops old reader; reader-death drains pending waiters with error sentinel (no hangs).

### [7.7.13] - 2026-05-27

Fixed:
- `loki start` no-PRD crash on bash 3.2 (macOS default) — `args[@]: unbound variable`. Safe expansion `${args[@]+"${args[@]}"}` applied at exec/nohup sites.
- `docker run --rm asklokesh/loki-mode start` exited without input. Now detects non-TTY stdin and auto-confirms with clear warning.

### [7.7.12] - 2026-05-27

Fixed:
- Bash/bun status parity for UT2-13 `provider_source: "cli"`. Bun route did not read `.loki/state/cli-provider`, so 99% of npm users saw `default` after `--provider <name>`.

### [7.7.11] - 2026-05-24

Added:
- USAGE.md markdown rendering with XSS guard (link href scheme allowlist)
- `provider_source: "cli"` cascade with provider name validation + PID liveness
- bun-parity flake root-cause fix (`BUN_FROM_SOURCE=1` in matrix)
- Forge plan docs (FORGE-AUTONOMOUS-QUEUE.md, ULTRAPLAN-FORGE-BAAS.md) extracted from PR #161

### [7.7.10] - 2026-05-24

Fixed:
- F-3 USAGE.md port hallucination via entrypoint file capture + secret scrubber + `LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0` opt-out

### [7.7.9] - 2026-05-24

Added:
- jdtls (Java) in LSP detection list (mcp/lsp_proxy.py + autonomy/lib/mcp-config.sh)

### [7.7.8] - 2026-05-24

Added:
- LSP grounding instruction in agent system prompt (use lsp_check_exists before writing API calls)

### [7.7.0 - 7.7.7] - 2026-05-22 to 2026-05-24

Added:
- LSP grounding as first-class agent tool: `lsp_check_exists`, `lsp_get_diagnostics`, `lsp_workspace_symbols`, `lsp_find_definition_by_name`, `lsp_find_references` via `mcp/lsp_proxy.py`. Supports pyright, typescript-language-server, gopls, rust-analyzer, jdtls. (Note: `lsp_get_diagnostics` was silently broken until v7.7.14 fix.)

---

## Historical Releases

### [5.42.2] - 2026-02-15

Changed:
- Autonomi parent brand added across all surfaces (README, SKILL.md, Dockerfiles, package.json, wiki, docs, VSCode extension)
- GitHub Pages redirects to autonomi.dev
- Homepage URL updated to autonomi.dev
- Re-recorded demo with full v5.42 feature showcase (CLI, dashboard, agents, council, memory)
- GitHub Pages color palette updated to indigo/blurple design system

### [5.42.1] - 2026-02-14

Fixed:
- Orphan dashboard process: added async watchdog that checks session PID every 30s and self-terminates if session is gone (prevents dashboard surviving after SIGKILL)

### [5.42.0] - 2026-02-14

Fixed:
- Cost tab always showing zeros: efficiency files now include token counts from context tracker
- Learning tab empty: success patterns and tool efficiency now read from `.loki/learning/signals/`
- Cost API fallback reads `.loki/context/tracking.json` instead of nonexistent `state.tokens`
- Token totals added to `dashboard-state.json` for overview display
- `track_context_usage()` now runs BEFORE efficiency file write so token data is available
- Learning metrics, trends, signals, aggregation all merge data from both event bus and signals directory

### [5.41.0] - 2026-02-13

Added:
- GitHub sync-back: `sync_github_status()` wired into iteration loop and session lifecycle
- GitHub PR creation: `create_github_pr()` called on successful session end (`LOKI_GITHUB_PR=true`)
- GitHub task export: `export_tasks_to_github()` available via CLI
- Deduplication log at `.loki/github/synced.log` prevents duplicate issue comments
- `sync_github_completed_tasks()` batch syncs all completed GitHub tasks after each iteration
- `sync_github_in_progress_tasks()` notifies GitHub when imported issues are being worked on
- `loki github` CLI command with 4 subcommands: sync, export, pr, status
- Dashboard API: `/api/github/status`, `/api/github/tasks`, `/api/github/sync-log`
- Comprehensive CLI reference wiki with copy-paste examples for all commands

Fixed:
- Misleading "API credits" wording in no-PRD confirmation prompt
- GitHub integration status changed from "Planned" to "Implemented" in SKILL.md

### [5.40.1] - 2026-02-13

Fixed:
- OIDC JWT signature validation - fail-closed by default, explicit opt-in for skip
- Provider allowlist and PRD path traversal validation in control API
- Rate limiter memory leak - key eviction with max_keys=10000 limit
- WebSocket connection limit - configurable MAX_CONNECTIONS (default 100)
- Dashboard log stream memory leak - proper event listener cleanup in disconnectedCallback
- Cross-platform millisecond timestamps in event emitter (GNU date, python3, fallback)
- Events.jsonl streaming with 10MB/10000 event size limits to prevent OOM
- Registry discovery max_depth bounded to 1-10 range
- Flock-based session locking to prevent TOCTOU race conditions (with PID fallback)
- Atomic JSON writes with fcntl.flock for control API state files
- Bash validation hook: additional bypass pattern detection
- Telemetry file permissions set to 0600 for sensitive data
- API client global listener cleanup to prevent memory leaks on destroy
- Rate limiting on token/sync/aggregate/ws read endpoints
- Registry symlink traversal prevention
- SHA-256 instead of MD5 for project ID hashing
- Events.jsonl 50MB log rotation with single backup

---

For complete version history, detailed changes, and older releases, see [CHANGELOG.md](../CHANGELOG.md).
