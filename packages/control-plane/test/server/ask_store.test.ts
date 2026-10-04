// CP-ASK slice 5: the Ask store keeps append order and only interrupts dead-pid running rows.
import { expect, test } from "bun:test";
import { openDb } from "../../src/db/migrate.ts";
import { activeCount, addTurn, appendEvent, citations, createThread, finishMessage, listEvents, listMessages, markInterrupted, setRunning } from "../../src/ask/store.ts";

const mk = () => openDb(":memory:").db;

test("messages and events keep append order with dense seq", () => {
  const db = mk();
  const t = createThread(db, { provider: "claude" });
  const a = addTurn(db, t, "first?");
  const b = addTurn(db, t, "second?");
  const msgs = listMessages(db, t);
  expect(msgs.map((m) => [m.seq, m.role, m.text])).toEqual([[0, "user", "first?"], [1, "assistant", ""], [2, "user", "second?"], [3, "assistant", ""]]);
  expect(msgs[1]!.id).toBe(a.assistantId);
  expect(msgs[3]!.id).toBe(b.assistantId);
  for (const k of ["delta", "tool_use", "delta"] as const) appendEvent(db, a.assistantId, k, { k });
  expect(listEvents(db, a.assistantId).map((e) => [e.seq, e.kind])).toEqual([[0, "delta"], [1, "tool_use"], [2, "delta"]]);
  expect(listEvents(db, a.assistantId, 0).map((e) => e.seq)).toEqual([1, 2]);
});

test("citations are the stored tool_use events", () => {
  const db = mk();
  const t = createThread(db, { provider: "claude" });
  const a = addTurn(db, t, "q");
  appendEvent(db, a.assistantId, "delta", { text: "x" });
  appendEvent(db, a.assistantId, "tool_use", { id: "1", name: "mcp__loki-cp__run_get", input: { run: "r1" } });
  expect(citations(db, a.assistantId)).toEqual([{ id: "1", name: "mcp__loki-cp__run_get", input: { run: "r1" } }]);
});

test("markInterrupted flips only running rows whose pid is dead", () => {
  const db = mk();
  const t = createThread(db, { provider: "claude" });
  const live = addTurn(db, t, "a").assistantId, dead = addTurn(db, t, "b").assistantId, queued = addTurn(db, t, "c").assistantId, done = addTurn(db, t, "d").assistantId;
  setRunning(db, live, 111, 111);
  setRunning(db, dead, 222, 222);
  setRunning(db, done, 333, 333);
  finishMessage(db, done, { status: "done", text: "ok", costUsd: 0.1 });
  expect(activeCount(db)).toBe(3);
  const n = markInterrupted(db, (pid) => pid === 111);
  expect(n).toBe(1);
  const st = Object.fromEntries(listMessages(db, t).filter((m) => m.role === "assistant").map((m) => [m.id, m.status]));
  expect(st[live]).toBe("running");
  expect(st[dead]).toBe("interrupted");
  expect(st[queued]).toBe("queued");
  expect(st[done]).toBe("done");
});
