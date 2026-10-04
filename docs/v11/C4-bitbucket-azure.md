# C4: Bitbucket and Azure DevOps

## Problem
Loki Mode integrates with GitHub only: issue parsing, webhook dispatch, status updates. Enterprise customers use:
- Bitbucket Cloud/Server
- Azure DevOps (ADO)
- GitLab (via webhook, but no parsing)

## Current state
- `mcp/server.py` has `/webhooks/github` only (line ~340)
- Issue parsing in `autonomy/parse-issue.sh` calls GitHub API only
- Status updates via `gh api repos/...` (GitHub CLI)
- No abstraction over VCS platform

## Proposed v1 scope
- VCS abstraction layer: detect provider from webhook origin
- Bitbucket Cloud: parse PR/issue webhook, query API, post status
- Azure DevOps: parse webhook, query ADO API, post build status
- CLI flag `--vcs=bitbucket` to override GitHub default
- Detect provider from repo URL (bitbucket.org, dev.azure.com, github.com)

## Open questions
- Bitbucket Cloud vs Server vs Data Center: which to ship first?
- ADO: personal access token vs service principal auth?
- Status API parity: are all GitHub status fields available in Bitbucket/ADO?
- How to test without paid Bitbucket/ADO accounts?

## Why deferred from 11.0.0
No tier-A demand. Requires test accounts and API key management. Scheduled 11.4 when VCS abstraction strategy documented.
