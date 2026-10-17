import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server";
import { createStore, type Store } from "../src/store";

let store: Store;
let server: ReturnType<typeof createServer>;
let base: string;

const send = (path: string, init?: RequestInit) => fetch(base + path, init);
const post = (title: unknown) =>
  send("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
const patch = (id: number, body: unknown) =>
  send(`/api/todos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  server?.stop(true);
  store?.close();
  store = createStore(":memory:");
  server = createServer(store, 0);
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  store?.close();
});

describe("API", () => {
  test("create then list returns the new todo, newest first", async () => {
    const a = await (await post("  buy milk  ")).json();
    expect(a.title).toBe("buy milk");
    expect(a.done).toBe(false);
    await post("call dentist");
    const { todos, counts } = await (await send("/api/todos")).json();
    expect(todos.map((t: { title: string }) => t.title)).toEqual(["call dentist", "buy milk"]);
    expect(counts).toEqual({ total: 2, active: 2, done: 0 });
  });

  test("rejects empty, whitespace, non-string and over-long titles with 400", async () => {
    for (const bad of ["", "   ", 42, null, "x".repeat(201)]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(store.counts().total).toBe(0);
  });

  test("rejects malformed JSON with 400", async () => {
    const res = await send("/api/todos", { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("JSON");
  });

  test("PATCH toggles done and edits title; filters respect state", async () => {
    const a = await (await post("one")).json();
    await post("two");
    expect((await (await patch(a.id, { done: true })).json()).done).toBe(true);
    expect((await (await patch(a.id, { title: "uno" })).json()).title).toBe("uno");

    const done = await (await send("/api/todos?filter=done")).json();
    expect(done.todos.map((t: { title: string }) => t.title)).toEqual(["uno"]);
    const active = await (await send("/api/todos?filter=active")).json();
    expect(active.todos.map((t: { title: string }) => t.title)).toEqual(["two"]);
    expect(active.counts).toEqual({ total: 2, active: 1, done: 1 });
  });

  test("PATCH validates done type and title, 404s on unknown id", async () => {
    const a = await (await post("one")).json();
    expect((await patch(a.id, { done: "yes" })).status).toBe(400);
    expect((await patch(a.id, { title: "" })).status).toBe(400);
    expect((await patch(9999, { done: true })).status).toBe(404);
    expect(store.list()[0].title).toBe("one");
  });

  test("DELETE removes one todo; second delete is 404", async () => {
    const a = await (await post("one")).json();
    expect((await send(`/api/todos/${a.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await send(`/api/todos/${a.id}`, { method: "DELETE" })).status).toBe(404);
    expect(store.counts().total).toBe(0);
  });

  test("DELETE ?completed=true clears only finished todos", async () => {
    const a = await (await post("one")).json();
    await post("two");
    await patch(a.id, { done: true });
    const res = await send("/api/todos?completed=true", { method: "DELETE" });
    expect(await res.json()).toEqual({ removed: 1 });
    expect(store.list().map((t) => t.title)).toEqual(["two"]);
    expect((await send("/api/todos", { method: "DELETE" })).status).toBe(400);
  });

  test("invalid filter is 400", async () => {
    expect((await send("/api/todos?filter=bogus")).status).toBe(400);
  });
});

describe("static files", () => {
  test("serves index and assets, 404s unknown files", async () => {
    const index = await send("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("What needs doing");
    expect((await send("/app.js")).status).toBe(200);
    expect((await send("/style.css")).status).toBe(200);
    expect((await send("/missing.png")).status).toBe(404);
  });

  test("raw ../ request cannot read files outside public/", async () => {
    let out = "";
    const closed = Promise.withResolvers<void>();
    const sock = await Bun.connect({
      hostname: "localhost",
      port: server.port!,
      socket: {
        data(_s, d) {
          out += new TextDecoder().decode(d);
        },
        close() {
          closed.resolve();
        },
      },
    });
    sock.write("GET /../package.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    await closed.promise;
    expect(out).toContain("404");
    expect(out).not.toContain('"name": "todo-app"');
  });
});

describe("persistence", () => {
  test("todos survive closing and reopening the database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-app-test-"));
    try {
      const file = join(dir, "t.sqlite");
      const first = createStore(file);
      const t = first.create("persist me");
      first.update(t.id, { done: true });
      first.close();
      const second = createStore(file);
      expect(second.list()).toEqual([{ ...t, done: true }]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
