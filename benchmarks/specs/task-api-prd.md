# PRD: Task API service

A small but REAL multi-file service, not a toy. This is the benchmark spec for
the "does a realistic PRD converge in few iterations" question -- the hello-world
CLI spec cannot answer that, because a one-file build exercises none of the
cross-file reasoning, persistence, or error-path work a real PRD demands.

Node.js, built-in modules only (`node:http`, `node:fs`, `node:test`). No express,
no database driver, no npm dependencies -- so the run measures the ENGINE, not
package-install latency or network flakiness.

## Requirements

1. **HTTP server** (`server.js`) exposing a JSON task API on a configurable port
   (`PORT` env var, default 3000):
   - `POST /tasks` -- body `{"title": "...", "done": false}`. Returns `201` with
     the created task including a generated string `id`.
   - `GET /tasks` -- returns `200` with a JSON array of all tasks.
   - `GET /tasks/:id` -- returns `200` with the task, or `404` if unknown.
   - `PATCH /tasks/:id` -- partial update of `title` and/or `done`. Returns `200`
     with the updated task, or `404` if unknown.
   - `DELETE /tasks/:id` -- returns `204`, or `404` if unknown.

2. **Validation and error handling**:
   - `POST` with a missing or non-string `title` returns `400` with
     `{"error": "..."}`. It must NOT create a task.
   - `PATCH` with a non-boolean `done` returns `400`.
   - A malformed JSON body returns `400`, never a crash or a 500.
   - An unknown route returns `404` with a JSON body.

3. **Persistence** (`store.js`, a separate module):
   - Tasks persist to a JSON file at `TASKS_FILE` (default `./tasks.json`).
   - The store survives a process restart: data written by one process is
     readable by the next.
   - A missing or empty store file is treated as an empty task list, not an error.

4. **Tests** (`node --test`) covering, at minimum:
   - The full create / read / update / delete happy path.
   - Every `400` validation case in requirement 2.
   - `404` for a non-existent id on GET, PATCH, and DELETE.
   - Persistence across a fresh store instance.
   Tests must exercise the REAL server and the REAL store. Do not re-implement
   the handler logic inside the test file.

5. **`README.md`** documenting how to run the server and the tests.

## Acceptance

- `node --test` passes with every case above covered.
- `server.js`, `store.js`, `README.md`, and at least one `*.test.js` all exist.
- The server starts on the port given by `PORT` and answers `GET /tasks` with
  `200` and a JSON array.
- No dependencies outside Node built-ins (no `node_modules` required to run).
