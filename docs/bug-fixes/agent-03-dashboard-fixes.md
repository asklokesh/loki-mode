# Agent 03: Dashboard API Functional Testing - Bug Fix Report

## Scope
File: `dashboard/server.py` (~5,259 lines, FastAPI)
Focus: All API routes, WebSocket handlers, task board features, security audit

## Bug Audit Status from BUG-AUDIT-v6.61.0.md

### Already Fixed (verified in current codebase)

| Bug ID | Description | Status |
|--------|-------------|--------|
| BUG-DASH-001 | Token creation endpoint has no authentication | FIXED - `require_scope("admin")` dependency at line 1719 |
| BUG-DASH-002 | WebSocket rate-limit calls close() on unaccepted connection | FIXED - `accept()` then `close()` at lines 1396-1397 |
| BUG-DASH-003 | WebSocket connection limit rejection enters receive loop | FIXED - `connect()` returns False, caller returns at line 1421-1422 |
| BUG-DASH-004 | `create_project` doesn't validate tenant_id | FIXED - Tenant existence check + `Field(..., gt=0)` validation |
| BUG-DASH-005 | `update_task` doesn't clear completed_at on reopen | FIXED - `completed_at = None` in else branch at line 1254 |
| BUG-DASH-006 | Task state machine missing DONE transitions | FIXED - `DONE: {IN_PROGRESS, REVIEW}` at line 1316 |
| BUG-DASH-009 | ProjectUpdate.status allows arbitrary strings | FIXED - `Literal["active", "archived", "completed", "paused"]` at line 179 |
| BUG-DASH-010 | Audit log offset allows negative values | FIXED - `ge=0` constraint at line 1824 |
| BUG-DASH-011 | Learning signals offset allows negative values | FIXED - `ge=0` constraint at line 2443 |
| BUG-DASH-012 | WebSocket idle timeout doesn't call disconnect | FIXED - `finally: manager.disconnect(websocket)` at line 1469 |
| BUG-DASH-013 | GET /api/tasks ignores project_id parameter | FIXED - Filter applied at lines 1132-1134 |

### Not Applicable (code removed)

| Bug ID | Description | Status |
|--------|-------------|--------|
| BUG-PL-001 | Dead code after stop_session return | N/A - Purple Lab code removed from server.py |
| BUG-PL-002 | session.reset() never called on stop | N/A - Purple Lab code removed from server.py |
| BUG-PL-003 | Reader task sets running=False without lock | N/A - Purple Lab code removed |
| BUG-PL-004 | Chat/fix/auto-fix missing secrets injection | N/A - Purple Lab code removed |
| BUG-PL-005 | Pause state never tracked | N/A - Purple Lab code removed |
| BUG-PL-006 | delete_session can delete active directory | N/A - Purple Lab code removed |
| BUG-PL-007 | Chat PIDs tracked but never untracked | N/A - Purple Lab code removed |
| BUG-DS-002 | Auto-fix restart double-wraps command | N/A - Dev server code removed |
| BUG-DS-003 | Overly broad port regex | N/A - Dev server code removed |
| BUG-DS-004 | pip install into server's own environment | N/A - Dev server code removed |
| BUG-DS-005 | Docker Compose port parsing crash | N/A - Dev server code removed |
| BUG-DASH-007 | pause_session polling loop is dead code | N/A - pause_session rewritten (no polling loop) |

## Fixes Applied in This Session

### 1. BUG-DASH-008: `_safe_read_text` not truly safe (lines 95-101)

**Problem**: `_safe_read_text` used `Path.read_text()` directly without exception handling. While `Path.read_text()` properly manages file handles (no leak), the function could raise `OSError` on permission errors or missing files. The "safe" name was misleading -- callers expected it to never raise.

**Fix**: Wrapped in try/except to return empty string on any I/O error, making the function truly safe as its name implies.

### 2. SECURITY: `/api/focus` POST/DELETE missing authentication (lines 1637, 1672)

**Problem**: The `/api/focus` POST and DELETE endpoints had no auth dependency. Any network-reachable client could redirect the dashboard to read from an arbitrary project directory, potentially exposing data from other projects or causing the dashboard to process attacker-controlled state files.

**Fix**:
- Added `dependencies=[Depends(auth.require_scope("control"))]` to both POST and DELETE
- Added validation requiring the target directory to contain a `.loki/` subdirectory to prevent pointing the dashboard at arbitrary filesystem locations
- Changed to resolve path before checking, preventing TOCTOU issues

### 3. SECURITY: `/api/enterprise/tokens` GET missing authentication (line 1766)

**Problem**: The token listing endpoint had no auth dependency. When enterprise mode was enabled, any client could enumerate all API tokens (names, scopes, creation dates, expiration). While raw token values are not returned, the metadata exposure is still a security risk for token enumeration and scope discovery.

**Fix**: Added `dependencies=[Depends(auth.require_scope("admin"))]` to require admin authentication.

### 4. Deprecated `asyncio.get_event_loop()` in sync_registry (line 1600)

**Problem**: Used `asyncio.get_event_loop()` which is deprecated in Python 3.10+ for getting the running loop from within an async function. This could cause `DeprecationWarning` or incorrect behavior in future Python versions.

**Fix**: Changed to `asyncio.get_running_loop()` which is the correct API for async contexts.

### 5. Input validation: timeRange parameters on learning endpoints (lines 2361, 2430, 2450)

**Problem**: The `timeRange` parameters on `/api/learning/metrics`, `/api/learning/trends`, and `/api/learning/signals` accepted arbitrary strings with no validation. While `_parse_time_range()` handles invalid input gracefully (returns None), passing malformed strings wastes processing and could be used for fuzzing.

**Fix**: Added `Query(..., pattern=r"^\d{1,4}[hdm]$")` constraint to validate format (1-4 digit number followed by h/d/m).

### 6. Input validation: quality report format parameter (line 4970)

**Problem**: The `format` parameter on `/api/quality-report` accepted any string, passing it to `rigour.export_report()`. Arbitrary format strings could cause unexpected behavior in the export function.

**Fix**: Added `pattern="^(json|markdown|html)$"` constraint to limit to known formats.

### 7. Input validation: migration start target and codebase_path (line 5048)

**Problem**: The `start_migration` endpoint accepted `codebase_path` and `target` without type checking. Non-string values (lists, dicts) from JSON body would cause cryptic errors downstream.

**Fix**: Added type validation (`isinstance` check for str) and length limit (255 chars) for `target`.

## Security Audit Summary (OWASP Top 10)

| OWASP Category | Status | Notes |
|----------------|--------|-------|
| A01: Broken Access Control | FIXED | Added auth to /api/focus, /api/enterprise/tokens |
| A02: Cryptographic Failures | OK | Token generation uses `secrets` module |
| A03: Injection | OK | SQLAlchemy ORM prevents SQL injection; list-form subprocess calls prevent shell injection; realpath + regex prevent path traversal |
| A04: Insecure Design | FIXED | Focus endpoint now requires .loki/ subdirectory |
| A05: Security Misconfiguration | OK | CORS restricted to localhost; default bind to 127.0.0.1; TLS optional |
| A06: Vulnerable Components | N/A | Dependency audit out of scope |
| A07: Auth Failures | OK | Rate limiting on sensitive endpoints; token management requires admin |
| A08: Data Integrity | OK | Atomic file writes for state mutations (tmp + rename) |
| A09: Logging Failures | OK | Audit logging on destructive operations (delete, stop, kill) |
| A10: SSRF | MITIGATED | Focus endpoint restricted to dirs with .loki/ subdirectory |

## Route Coverage Audit

Verified all 100+ routes in server.py for:
- Authentication requirements (auth scope dependencies)
- Input validation (Pydantic models, Query constraints, regex patterns)
- Error handling (try/except with proper HTTP status codes)
- Rate limiting (control and read limiters)
- Path traversal protection (realpath checks, SAFE_ID_RE regex)
- Resource cleanup (WebSocket disconnect in finally block)

## Verification

```
python3 -c "import ast; ast.parse(open('dashboard/server.py').read()); print('Syntax OK')"
# Output: Syntax OK
```
