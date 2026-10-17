import { Database } from "bun:sqlite";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
}

export type Filter = "all" | "active" | "done";

export const MAX_TITLE = 200;

interface Row {
  id: number;
  title: string;
  done: number;
  created_at: string;
}

const toTodo = (r: Row): Todo => ({
  id: r.id,
  title: r.title,
  done: r.done === 1,
  createdAt: r.created_at,
});

export class ValidationError extends Error {}

export function normalizeTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("title must be a string");
  const title = raw.trim();
  if (title.length === 0) throw new ValidationError("title must not be empty");
  if (title.length > MAX_TITLE) {
    throw new ValidationError(`title must be at most ${MAX_TITLE} characters`);
  }
  return title;
}

export function createStore(path: string) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  const byId = db.query<Row, [number]>("SELECT * FROM todos WHERE id = ?");

  return {
    list(filter: Filter = "all"): Todo[] {
      const where = filter === "active" ? "WHERE done = 0" : filter === "done" ? "WHERE done = 1" : "";
      return db
        .query<Row, []>(`SELECT * FROM todos ${where} ORDER BY id DESC`)
        .all()
        .map(toTodo);
    },
    counts(): { total: number; active: number; done: number } {
      const r = db
        .query<{ total: number; done: number | null }, []>(
          "SELECT COUNT(*) AS total, SUM(done) AS done FROM todos",
        )
        .get()!;
      const done = r.done ?? 0;
      return { total: r.total, active: r.total - done, done };
    },
    create(rawTitle: unknown): Todo {
      const title = normalizeTitle(rawTitle);
      const row = db
        .query<Row, [string]>("INSERT INTO todos (title) VALUES (?) RETURNING *")
        .get(title)!;
      return toTodo(row);
    },
    update(id: number, patch: { title?: unknown; done?: unknown }): Todo | null {
      const current = byId.get(id);
      if (!current) return null;
      let title = current.title;
      let done = current.done;
      if (patch.title !== undefined) title = normalizeTitle(patch.title);
      if (patch.done !== undefined) {
        if (typeof patch.done !== "boolean") throw new ValidationError("done must be a boolean");
        done = patch.done ? 1 : 0;
      }
      db.query("UPDATE todos SET title = ?, done = ? WHERE id = ?").run(title, done, id);
      return toTodo(byId.get(id)!);
    },
    remove(id: number): boolean {
      return db.query("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
    },
    clearCompleted(): number {
      return db.query("DELETE FROM todos WHERE done = 1").run().changes;
    },
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof createStore>;
