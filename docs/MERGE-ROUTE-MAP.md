# Purple Lab Into Dashboard: Route Map (Phase Merge-1)

**Status:** Audit complete. Doc-only output for Phase Merge-1 of the v7.5.29+ true-integration arc.
**Date:** 2026-05-23
**Source:** `dashboard/server.py` (133 routes) and `web-app/server.py` (112 routes), audited from HEAD.

This document is the source-of-truth route-collision analysis for the Purple Lab merge into Dashboard. It enumerates every route in both servers, identifies collisions, and defines the namespace strategy for Phases Merge-2 through Merge-7.

## Top-Level Summary

| Metric | Value |
|---|---|
| Dashboard routes -- main `app` decorators | 133 |
| Dashboard routes -- `api_v2_router` (mounted at `/api/v2/*` via `include_router`) | 24 |
| Dashboard routes -- total | **157** |
| Dashboard `/api/*` routes | 135 |
| Purple Lab routes (total) | 112 |
| Purple Lab `/api/*` routes | 100 |
| Purple Lab routers (`APIRouter` / `include_router`) | 0 |
| Exact collisions (method + path) | **3** |
| Path-only collisions | **3** |
| `/api/*` collisions (any method) | **0** |
| `/api/v2/*` collisions vs Purple Lab | **0** (Purple Lab has no `/api/v2/*` routes) |
| Surviving uncollided Purple Lab routes | **109** |

**Result:** The merge is structurally clean. Only 3 infrastructure paths collide; all 100 of Purple Lab's `/api/*` routes have distinct paths from Dashboard's 135 `/api/*` routes. The `api_v2_router` (24 routes at `/api/v2/tenants`, `/api/v2/runs`, `/api/v2/api-keys`, `/api/v2/policies`, `/api/v2/audit`) is enterprise multi-tenant surface that Purple Lab does not currently expose.

## The 3 Collisions

| Method | Path | Dashboard purpose | Purple Lab purpose | Resolution |
|---|---|---|---|---|
| `GET` | `/health` | Dashboard health check | Purple Lab health check | Single `/health` on Dashboard wins. Lab's becomes `/lab/health`. |
| `GET` | `/{full_path:path}` | Dashboard SPA catch-all (serves `legacy-ui-static/index.html`) | Purple Lab SPA catch-all (serves `web-app/dist/index.html`) | Dashboard catch-all wins at root. Lab's becomes `/lab/{full_path:path}` -- triggered only inside the mount. |
| `WS` | `/ws` | Dashboard WebSocket bus | Purple Lab WebSocket bus | Dashboard `/ws` wins. Lab's becomes `/lab/ws`. Long term: unify into a single bus (Phase Merge-5). |

All three collisions resolve automatically when Lab's FastAPI app is mounted at `/lab` via Starlette `app.mount("/lab", purple_lab_app)`. No code dedup needed in Merge-1 -- the mount provides path isolation.

## Namespace Strategy

Single rule: **Purple Lab's entire FastAPI app mounts under `/lab/`**. No route renames inside the Lab app itself -- the mount handles prefixing.

- Lab route `/api/sessions/{id}/chat` becomes externally visible as `/lab/api/sessions/{id}/chat`.
- Lab static asset `/assets/index-BN52-GQT.js` becomes `/lab/assets/index-BN52-GQT.js`.
- Lab WebSocket `/ws` becomes `/lab/ws`.

The Vite build (Phase Merge-3) is rebuilt with `base: '/lab/'` so the bundled JS naturally calls `/lab/api/*` and the HTML loads `/lab/assets/*`. No runtime base-href shimming needed.

## Web-App Route Inventory (by category)

| Category | Count | Sample paths |
|---|---|---|
| `/api/sessions/*` | 61 | `/api/sessions/{session_id}/chat/{task_id}/stream`, `/api/sessions/{session_id}/checkpoints` |
| `/api/session/*` | 18 | `/api/session/start`, `/api/session/quick-start`, `/api/session/status` |
| `/api/deploy/*` | 6 | `/api/deploy/{provider}` |
| `/api/magic/*` | 5 | `/api/magic/components`, `/api/magic/generate` |
| `/api/auth/*` | 5 | (auth endpoints) |
| `/api/teams/*` | 4 | (team management) |
| `/api/secrets/*` | 3 | (secrets management) |
| `/api/templates/*` | 2 | `/api/templates`, `/api/templates/{filename}` |
| `/api/provider/*` | 2 | `/api/provider/current`, `/api/provider/set` |
| `/api/audit-log` | 1 | (audit log endpoint) |
| `/proxy/{session_id}` | 1 | (legacy proxy) |
| `/ws/*` | 2 | `/ws`, `/ws/terminal` |
| `/health` | 1 | (health check) |
| `/{full_path:path}` | 1 | (SPA catch-all) |
| **Total** | **112** | |

## Dashboard Route Inventory (by category, top 20)

| Category | Count |
|---|---|
| `/api/memory/*` | 14 |
| `/api/registry/*` | 10 |
| `/api/learning/*` | 9 |
| `/api/migration/*` | 8 |
| `/api/council/*` | 8 |
| `/api/tasks/*` | 6 |
| `/api/enterprise/*` | 6 |
| `/api/projects/*` | 5 |
| `/api/control/*` | 5 |
| `/api/checklist/*` | 5 |
| `/api/notifications/*` | 4 |
| `/api/agents/*` | 4 |
| `/api/managed/*` | 3 |
| `/api/github/*` | 3 |
| `/api/focus/*` | 3 |
| `/api/checkpoints/*` | 3 |
| (etc., 89 more under /api/) | -- |
| **Total** | **133** |

## Semantic Overlap (Candidates for Dedup in Phase Merge-5)

After path-suffix analysis, only one path-suffix is genuinely shared between the two servers:

- `github/status` -- appears as `/api/github/status` (Dashboard) and inside Lab's session endpoints. Not a collision (different paths), but functional overlap worth investigation in Phase Merge-5.

The bigger semantic overlap is at the conceptual level:

| Concept | Dashboard endpoint | Purple Lab endpoint | Merge-5 decision needed |
|---|---|---|---|
| Session lifecycle (start/stop/status) | `/api/control/*` (5 routes) | `/api/session/*` (18 routes) + `/api/sessions/{id}/*` (61 routes) | Likely: Lab keeps richer session CRUD; Dashboard's `/api/control/*` becomes thin wrappers calling Lab's. Or: unify on Lab's surface and retire Dashboard's. Decide in Merge-5. |
| Memory access | `/api/memory/*` (14 routes) | `/api/session/{id}/memory` (1 route) | Dashboard owns the rich surface; Lab's becomes a thin wrapper. |
| Checkpoints | `/api/checkpoints/*` (3 routes) | `/api/sessions/{id}/checkpoints` (2 routes) | Dashboard owns the global view; Lab's per-session view consumes Dashboard's. |
| Council / quality | `/api/council/*` (8) + `/api/quality-score/*` (2) | -- | Dashboard-only. Lab needs to surface this via UI, not duplicate endpoints. |
| Provider routing | `/api/provider/*` (?) | `/api/provider/current`, `/api/provider/set` | Likely same routes already; verify in Merge-2. |

None of these block the mount in Merge-4. They become refactor targets in Merge-5.

## Phase Dependencies (Confirmed by This Audit)

- **Merge-2** (state/business-logic dedup audit): Doable in parallel with Merge-3. Operates on `.loki/state/` and Python modules, not routes.
- **Merge-3** (Vite rebuild with `base: '/lab/'`): Single-file config change in `web-app/vite.config.ts` + `npm run build`. No route changes needed because the mount handles prefixing.
- **Merge-4** (FastAPI mount): The 3 infrastructure collisions resolve naturally via mount path isolation. No route renames inside `web-app/server.py`.
- **Merge-5** (deep dedup): Only required for the 4 conceptual overlaps above. Each becomes a separate sub-task.
- **Merge-6** (sidebar entry): Pure dashboard-UI work, no backend route changes.
- **Merge-7** (deprecate `loki web` standalone): Keep `loki web` working for 2 minor versions per user-safety Rule 0. Standalone uvicorn entrypoint is preserved; only `loki dashboard` gains the mount.

## NOT Decided In This Phase

1. **Cookie / session-token namespace.** If Lab and Dashboard both set cookies at root path, mount may cause conflicts. Audit needed in Merge-2.
2. **CORS middleware.** Lab has CORS middleware at line 119 of `web-app/server.py`. After mount, this becomes redundant (same origin). Remove in Merge-4.
3. **Lifespan / startup events.** Lab's startup hooks (if any) must compose with Dashboard's. Audit in Merge-4.
4. **Auth headers.** If Lab requires its own auth token and Dashboard requires another, the mount may double-auth or break. Audit in Merge-2.

These are not blockers for Merge-1 sign-off; they are explicit followups.

## Cleanup

Audit artifacts in `/tmp/loki-merge-audit/` may be removed:
```bash
rm -rf /tmp/loki-merge-audit
```

## Honest Acknowledgements

- The "0 /api/* collisions" finding holds for the route-table inspection only. Two routes with distinct paths can still share a backing function or `.loki/` file, and that semantic overlap is what Phase Merge-2 must catalog.
- Initial audit used `grep -nE '^@app\.(get|post|put|delete|patch|websocket)\(' ...` which missed `include_router` mounts. Followup audit found Dashboard's `api_v2_router` at `dashboard/api_v2.py` (24 routes, prefix `/api/v2`) and confirmed Purple Lab has zero `APIRouter` / `include_router` registrations. The summary table reflects the corrected total of 157 Dashboard routes.
- `app.add_api_route(...)` is also a dynamic registration pattern. `grep -n "add_api_route" web-app/server.py dashboard/server.py` returns nothing -- both servers use decorator-style registration exclusively.
- No fixture-based runtime collision test was performed. Phase Merge-4 must add a route-table dump test that runs the mounted app and asserts the surviving route set against this doc's expected output.
