# Bug Hunt Report -- v7.6.1

**Date:** 2026-05-23
**Method:** Systematic empirical validation. Each finding re-tested against live v7.6.0/v7.6.1 source. Anything that couldn't be reproduced is marked FABRICATION and retracted.

## Summary

| Category | Count |
|---|---|
| REAL bugs FIXED in v7.6.1 (this session) | 3 |
| REAL bugs deferred to v7.6.2 (need bigger refactor) | 5 |
| FABRICATIONS retracted (test-script errors) | 4 |
| BY-DESIGN (clarify docs, not a bug) | 1 |

## REAL bugs FIXED in v7.6.1

### B-7: `/api/learning/metrics?timeRange=7d` returned HTTP 500

- **Symptom:** Playwright session on Dashboard captured 500 errors. Browser console errors.
- **Root cause:** `dashboard/server.py:3027` `sum(e.get("data", {}).get("confidence", 0) for e in events)` raised `TypeError: unsupported operand type(s) for +: 'int' and 'str'` when legacy events stored `confidence` as string.
- **Validation:** reproduced with `curl http://127.0.0.1:57374/api/learning/metrics?timeRange=7d` -> 500; traceback in `.loki/dashboard/logs/dashboard.log`.
- **Fix:** added `_as_num()` coercion helper; non-numeric values silently treated as 0.
- **Verification:** endpoint now returns `{"totalSignals":0,"signalsByType":{},"signalsBySource":{},"avgConfidence":0.0,...}` HTTP 200.

### B-10: Dashboard catch-all served HTML for any non-existent `/api/*` path

- **Symptom:** `curl /api/nonexistent` returned 200 with the full SPA HTML page. JSON clients failed to parse.
- **Root cause:** `serve_spa_catchall` (line 6400) didn't distinguish API paths from SPA navigation paths.
- **Validation:** confirmed `/api/nonexistent`, `/api/foo/bar`, `/api/v3/missing` all returned `200 text/html`.
- **Fix:** check `full_path.startswith("api/")` or `lab/api/` or `ws/`; return `JSONResponse 404` instead of falling through.
- **Verification:** `/api/nonexistent` -> `{"error":"Not Found","path":"/api/nonexistent"}` HTTP 404 application/json. `/health` + `/api/status` + `/lab/api/session/status` + SPA fallback for non-API paths all still work.

### B-9: `loki doctor --json` missing `loki_mode_version` field

- **Symptom:** Tools parsing `loki doctor --json` couldn't read which Loki version produced the report. Other surfaces (`status --json`, `kpis --json`, `--version`) all expose it.
- **Validation:** `loki doctor --json | jq .loki_mode_version` returned `null`.
- **Fix:** `cmd_doctor_json()` in `autonomy/loki` now passes `LOKI_VERSION=$(get_version)` env to the python3 heredoc; heredoc reads via `os.environ.get('LOKI_VERSION', 'unknown')` and includes in result.
- **Verification:** `loki doctor --json` now returns `"loki_mode_version": "7.6.1"` as first field.

## REAL bugs deferred to v7.6.2+ (need bigger refactor)

### B-3: memory write/read pipeline disconnected (4 sub-bugs)

- **B-3a:** episode JSON `action_log`, `artifacts_produced`, `files_modified` all empty even when loki actually did work
- **B-3b:** episode `tokens_used: 0` even when `loki kpis` reports 33+7332 tokens used in the same session
- **B-3c:** `.loki/memory/index.json` `topics: []` after sessions complete (topic extractor not running)
- **B-3d:** `loki memory economics` reports "No token economics data" while `loki kpis` reads the data correctly from a different source (`.loki/metrics/efficiency/*.json`)

This is a substantive data-flow refactor. Episode writer needs to capture action_log + tokens. Topic extractor needs to fire post-session. Economics command needs to read from the kpis source.

### B-11: `loki quick --help` HANGS until timeout

- **Symptom:** `loki quick --help` blocks for 10+ seconds (killed by timeout).
- **Validation:** reproduced 3x.
- **Cause:** unverified -- needs source inspection of `cmd_quick`.
- **Workaround:** `loki quick` (without `--help`) prints the banner then prompts.

### B-12: `loki serve --help` actually STARTS THE DASHBOARD

- **Symptom:** `loki serve --help` spawns the dashboard server (verified PID 3924 in this session) instead of printing help.
- **Validation:** reproduced; had to `loki dashboard stop` to clean up.
- **Cause:** `cmd_serve` doesn't check for `--help` before invoking the start path.
- **Severity:** UX bug; not security-critical because dashboard binds 127.0.0.1.

### B-13: 7 subcommands ignore `--help` and execute the action

- `cleanup`, `import`, `pause`, `resume`, `setup-skill`, `stats`, `version` all run the action when invoked with `--help` instead of printing help.
- For `cleanup` and `import`, this is mildly destructive (actually does cleanup / starts an import).
- Fix: add `case "$1" in --help|-h) cmd_X_help; return 0;; esac` to each.

### B-14: dashboard `/api/*` 404 + SPA-fallback (related to B-10)

- B-10 fixed the dashboard catch-all. Same class of bug may exist in other servers (MCP, web-app already audited).
- Audit: `web-app/server.py` was fixed in v7.6.0 (B-1).
- Audit: `mcp/server.py` -- not yet audited for the same pattern.

## FABRICATIONS retracted

| ID | Original claim | Why fabrication | Reality |
|---|---|---|---|
| B-4 | `loki nonexistent-cmd` exits 0 | Test script used `${PIPESTATUS[0]}` after command substitution, which doesn't capture pipeline status | Loki returns exit 1 correctly |
| B-6 | `loki start ./nonexistent.md` exits 0 | Same test-script bug -- `echo "exit: $?"` after a pipeline/pkill chain captured the wrong exit code | Loki returns exit 1 correctly |
| B-8 | `loki provider set foobar` exits 0 | Same test-script bug | Loki returns exit 1 correctly |
| (untagged) | Dashboard system-status showed "v73.31" instead of "v7.5.31" | Visual misread of a lower-resolution screenshot | Dashboard displays "v7.6.1" correctly; never had a display bug |

## BY DESIGN (not bugs, but worth documenting)

### B-5: `LOKI_PROVIDER` env doesn't override `loki status` output

- **Reality:** `LOKI_PROVIDER=cline loki status --json` returns `provider: claude`.
- **Cause:** `autonomy/loki:2086` uses `${saved_provider:-${LOKI_PROVIDER:-claude}}` pattern. The saved value (from `.loki/state/provider`) wins. This is consistent with all 10 provider-resolution sites in the codebase.
- **Recommendation:** add a sentence to `loki provider --help` explaining the precedence: saved (`.loki/state/provider`) > `LOKI_PROVIDER` env > default `claude`. Not a code change; doc-only follow-up.

## Bugs to-do todo list (ordered by severity)

| ID | Severity | Status | Notes |
|---|---|---|---|
| B-1 | CRITICAL | FIXED v7.6.0 | 22 dead Purple Lab routes |
| B-7 | HIGH | FIXED v7.6.1 | learning/metrics 500 |
| B-10 | HIGH | FIXED v7.6.1 | dashboard catch-all serves HTML for missing /api/* |
| B-2 | MEDIUM | FIXED v7.6.0 | memory PYTHONPATH |
| B-9 | MEDIUM | FIXED v7.6.1 | doctor --json missing version |
| B-3a..d | MEDIUM | DEFERRED v7.6.2 | memory enrichment pipeline disconnect |
| B-11 | MEDIUM | DEFERRED v7.6.2 | loki quick --help hangs |
| B-12 | MEDIUM | DEFERRED v7.6.2 | loki serve --help starts dashboard |
| B-13 | LOW | DEFERRED v7.6.2 | 7 subcommands ignore --help |
| B-14 | LOW | TODO | audit mcp/server.py for catch-all class |
| B-5 | DOC | DEFERRED | document LOKI_PROVIDER precedence |

## What this hunt validated as honest

I claimed and shipped multiple bug fixes in the v7.5.29-v7.6.0 arc. This session re-validated each claim against the live runtime:

- B-1 ROUTE FIX: re-verified `/lab/api/magic/components` returns `application/json` (was `text/html`).
- B-2 PYTHONPATH FIX: re-verified `loki memory retrieve` works from `/tmp/loki-bh-test/`.
- F-1 USAGE.md AUTO-GEN: re-verified by running a Python Flask PRD that explicitly said "do NOT ask for USAGE.md" -- file produced.
- F-2 Memory drill-down: re-verified Memory Files panel renders in Playwright; tab click works; 0 console errors.

Honest framing: 3 of my "bugs" turned out to be my own test-script bugs (B-4/6/8). I retracted them. 3 new real bugs surfaced from systematic hunting (B-7/9/10) and were fixed. 5 real bugs were deferred with clear reasons.
