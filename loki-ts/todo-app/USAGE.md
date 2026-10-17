# Daybook (todo app)

A single-user todo list: add, edit, tick off, delete, filter, clear finished. Data persists in SQLite.

## Prerequisites
- Bun 1.1 or newer (uses `bun:sqlite`, no other runtime needed)
- Port 3000 free, or set `PORT`
- Optional env: `PORT` (default 3000), `TODO_DB` (default `data/todos.sqlite`)

## Install
```
bun install
```

## Start
```
bun start
```
Then open http://localhost:3000

## Verify
```
curl -s -XPOST localhost:3000/api/todos -H 'content-type: application/json' -d '{"title":"ship it"}'
```
Expect: `{"id":1,"title":"ship it","done":false,"createdAt":"..."}`

```
curl -s localhost:3000/api/todos
```
Expect: `{"todos":[{"id":1,...}],"counts":{"total":1,"active":1,"done":0}}`

Restart the server and run the second command again: the todo is still there.

Run the test suite:
```
bun test
```

## API
- `GET /api/todos?filter=all|active|done`
- `POST /api/todos` with `{"title": "..."}` (1-200 chars)
- `PATCH /api/todos/:id` with `{"title"?: "...", "done"?: true|false}`
- `DELETE /api/todos/:id`
- `DELETE /api/todos?completed=true`

## Stop
Ctrl+C in the terminal, or for a backgrounded server:
```
lsof -ti:3000 | xargs kill -9
```
