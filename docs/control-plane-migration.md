# Migrating from the classic dashboard to the Control Plane

Loki Mode 10.8 removes the classic dashboard UI (`dashboard-ui/`, `dashboard/static/`, and the UI served on port 57374). The Control Plane (`packages/control-plane`, UI in `packages/control-plane/ui`) is the only UI. Deploy files (Helm, compose, ECS) and the clients (SDKs, VS Code, `run.sh`) already point at it.

## What changed

| Before | Now |
| --- | --- |
| UI and API on port 57374 (FastAPI, `dashboard/server.py`) | Control Plane on port 47821 by default (`loki control serve`) |
| `loki dashboard start` serves the classic UI | `loki dashboard`, `loki dashboard start` and `loki dashboard open` open the Control Plane |
| `dashboard-ui` build (`npm run build:all`) | `cd packages/control-plane && bun run build:all` (UI plus bundled server) |
| REST under `/api/*` | REST under `/v1/*`, plus `/health` and `/ready` |
| Token management through the dashboard | One bearer token, `LOKI_CONTROL_TOKEN`, on `/v1/*` |

## Start the Control Plane

```bash
loki control serve                 # 127.0.0.1:47821, database ~/.loki/control/control.db
loki control serve --port 0        # any free port; the printed URL is the real one
loki control status                # reachable? how many runs held?
loki dashboard                     # reuse a running Control Plane, or start one, and open it
```

Notes:

- Bun is required (https://bun.sh). Without it `loki dashboard` says so and does not start a server.
- The default port falls back to any free port when 47821 is taken. An explicit `--port` or `LOKI_CONTROL_PORT` never falls back.
- While `loki control serve` runs, runs on this machine ship to it automatically through `~/.loki/control/instance.json`. A run never starts the server.
- Import runs that finished before the server existed: `loki control backfill [DIR]`.
- Remove runs: `loki control prune --repo OWNER/NAME` or `--before ISO_DATE`, with `--dry-run` to preview.
- `LOKI_HEADLESS=1`, `LOKI_NO_BROWSER=1` or `--no-open` print the URL instead of opening a browser.
- `LOKI_CONTROL=0` turns the Control Plane off. `LOKI_CONTROL_DEFAULT=0` makes the bare `loki dashboard` skip it.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `LOKI_CONTROL_PORT` | listen port for `loki control serve`, and the port clients assume (default 47821) |
| `LOKI_CONTROL_URL` | where clients and the shipper send runs (overrides discovery) |
| `LOKI_CONTROL_DB` | SQLite path (default `~/.loki/control/control.db`) |
| `LOKI_CONTROL_HOST` | bind address (default 127.0.0.1) |
| `LOKI_CONTROL_TOKEN` | bearer token for `/v1/*`; required for any non-loopback bind, otherwise the server exits 2 |
| `LOKI_CONTROL_ALLOW_INSECURE_BIND` | `1` accepts a tokenless non-loopback bind (not recommended) |
| `LOKI_CONTROL_ANSWER_DIR` | where BLOCKED-run answers are written |

With a token set, send `Authorization: Bearer <token>` on every `/v1/*` call. Actions that touch the machine (start, stop, import, delete, config) exist only on a loopback-bound server and need a JSON content type.

## Route mapping

Legacy routes come from `dashboard/server.py`. Rows marked "no direct legacy route" are Control Plane routes that did not exist in the classic server.

| Legacy | Control Plane |
| --- | --- |
| `GET /api/status` | `GET /v1/runs` (list, filters `verdict`, `repo`, `since`, `until`, `group_id`, `limit`, `cursor`), `GET /v1/runs/<source>/<run>` (detail), `GET /v1/stats` |
| `GET /api/cost` | `GET /v1/stats/cost` |
| `POST /api/control/start` | `POST /v1/start` (alias `POST /v1/runs`) |
| `POST /api/control/stop` | `POST /v1/runs/<source>/<run>/stop` |
| `POST /api/control/resume` | `POST /v1/runs/<source>/<run>/resume` |
| (none) | `POST /v1/runs/<source>/<run>/retry`, `POST /v1/runs/<source>/<run>/verify`, `POST /v1/runs/<source>/<run>/answer` |
| log streaming | `GET /v1/runs/<source>/<run>/events`, `GET /v1/runs/<source>/<run>/stream`, `GET /v1/stream`, `GET /v1/runs/<source>/<run>/artifact/<path>` |
| `GET /api/audit` | `GET /v1/audit` |
| `GET /api/health` family | `GET /health` (liveness), `GET /ready` (database check) |
| (no direct legacy route) | `GET /v1/config`, `PUT /v1/config` |
| (no direct legacy route) | `GET /v1/providers`, `GET /v1/integrations` |
| (no direct legacy route) | `GET /v1/notifications` |
| (no direct legacy route) | `GET /v1/merge/queue`, `POST /v1/merge/queue`, `POST /v1/merge/run`, `GET /v1/review/risk` |
| (no direct legacy route) | `GET /v1/keys` (public key only, loopback only) |
| (no direct legacy route) | `GET /v1/repos` (names only, loopback only) |
| (no direct legacy route) | `POST /v1/ingest`, `POST /v1/import`, `DELETE /v1/runs/<source>/<run>` |

## Not yet available in the Control Plane

These legacy features have no Control Plane route today:

- `POST /api/control/pause`, `/api/control/app-restart` and `/api/control/app-stop`.
- `GET /api/audit/summary` and `GET /api/audit/verify` (the Control Plane has `GET /v1/audit` only).
- `GET /api/cost/timeline` and `GET /api/health/processes`.
- API key creation, rotation and revocation (`/api/keys` POST routes, `loki dashboard token`), RBAC and OIDC login. The Control Plane uses the single `LOKI_CONTROL_TOKEN`.
- The `/lab/` web app and the memory browser.
- Classic-server options: `loki dashboard --host`, `--tls-cert`, `--tls-key`, `LOKI_DASHBOARD_CORS`, `LOKI_DASHBOARD_PORT` for the UI.

## Deploy

- Container, Helm and ECS overview: [control-plane-container.md](control-plane-container.md).
- Docker Compose: `deploy/docker-compose/README.md`. The UI is on host port 57374 by default (`LOKI_DASHBOARD_PORT`), mapped to the Control Plane on container port 47821. `LOKI_CONTROL_TOKEN` is required in `.env`; open the UI with `#token=<token>` appended.
- Helm: `deploy/helm/README.md` (chart at `deploy/helm/autonomi`, Control Plane deployment in `templates/deployment-controlplane.yaml`).
- ECS: `deploy/ecs/README.md` and `deploy/ecs/control-plane-task.json` (run exactly one task, the database is single-writer).

## Clients

SDKs, the VS Code extension and `run.sh` talk to the Control Plane. Set `LOKI_CONTROL_URL` (and `LOKI_CONTROL_TOKEN` when the server has one) to point them at a remote instance.

## Building from source

```bash
cd packages/control-plane && bun run build:all   # UI plus dist/server.js
```
