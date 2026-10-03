# Runs REST API (/api/v1/runs)

Served by the local dashboard (loopback by default). Auth reuses the dashboard
scopes: "read" for GET, "control" for POST. With auth off (default local mode)
no token is needed; with it on, send `Authorization: Bearer <token>`.

- `GET /api/v1/runs` - envelope `{runs, source, freshness_s, reason}`, newest first.
- `GET /api/v1/runs/{id}` - one run plus per-iteration detail (current run only); 404 if unknown.
- `POST /api/v1/runs` - start a run. Body: `{"prd_text": "..."}` or `{"prd_path": "..."}`, optional `provider`, `parallel`. Same behavior as `POST /api/control/start` (single-flight, 409 if busy).
- `POST /api/v1/runs/{id}/stop` - stop the run. Only the current run can be stopped (409 otherwise, 404 if unknown).

Cost and status fields come from measured records only; unmeasured values are null, never 0.
