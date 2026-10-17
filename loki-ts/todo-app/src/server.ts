import { mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { createStore, ValidationError, type Filter, type Store } from "./store";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + "/")) return json({ error: "not found" }, 404);
  const file = Bun.file(full);
  if (!(await file.exists())) return json({ error: "not found" }, 404);
  return new Response(file);
}

async function handleApi(store: Store, req: Request, url: URL): Promise<Response> {
  const { pathname } = url;

  if (pathname === "/api/todos") {
    if (req.method === "GET") {
      const raw = url.searchParams.get("filter") ?? "all";
      if (raw !== "all" && raw !== "active" && raw !== "done") {
        return json({ error: "filter must be all, active or done" }, 400);
      }
      return json({ todos: store.list(raw as Filter), counts: store.counts() });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      return json(store.create(body.title), 201);
    }
    if (req.method === "DELETE") {
      if (url.searchParams.get("completed") !== "true") {
        return json({ error: "only DELETE /api/todos?completed=true is supported" }, 400);
      }
      return json({ removed: store.clearCompleted() });
    }
    return json({ error: "method not allowed" }, 405);
  }

  const match = pathname.match(/^\/api\/todos\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const todo = store.update(id, { title: body.title, done: body.done });
      return todo ? json(todo) : json({ error: "todo not found" }, 404);
    }
    if (req.method === "DELETE") {
      return store.remove(id) ? new Response(null, { status: 204 }) : json({ error: "todo not found" }, 404);
    }
    return json({ error: "method not allowed" }, 405);
  }

  return json({ error: "not found" }, 404);
}

export function createServer(store: Store, port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname.startsWith("/api/")) return await handleApi(store, req, url);
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        return await serveStatic(url.pathname);
      } catch (err) {
        if (err instanceof ValidationError) return json({ error: err.message }, 400);
        console.error(err);
        return json({ error: "internal error" }, 500);
      }
    },
  });
}

if (import.meta.main) {
  const dbPath = process.env.TODO_DB ?? join(import.meta.dir, "..", "data", "todos.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const server = createServer(createStore(dbPath), Number(process.env.PORT ?? 3000));
  console.log(`todo-app listening on ${server.url}`);
}
