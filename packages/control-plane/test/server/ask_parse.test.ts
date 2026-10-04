// CP-ASK slice 8: stream parser wall checks.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, newState, parseLine, type AskEvent } from "../../src/ask/parse.ts";

const fx = (n: string) => readFileSync(join(import.meta.dir, "../fixtures/ask", n), "utf8").split("\n").filter(Boolean);
function run(p: "claude" | "codex", lines: string[]) {
  const st = newState();
  const events: AskEvent[] = [];
  for (const l of lines) events.push(...parseLine(p, l, st));
  return { events, out: finish(st) };
}

test("claude: deltas concatenate to the final result text", () => {
  const { events, out } = run("claude", fx("claude-stream.jsonl"));
  const joined = events.filter((e) => e.kind === "delta").map((e) => e.payload.text).join("");
  expect(joined).toBe("Let me look at the runs. There are 2 runs.");
  expect(out.text).toBe(joined);
  expect(out.status).toBe("done");
});

test("claude: tool_use keeps name and input, tool_result is emitted", () => {
  const { events } = run("claude", fx("claude-stream.jsonl"));
  const tu = events.find((e) => e.kind === "tool_use")!;
  expect(tu.payload.name).toBe("Read");
  expect(tu.payload.input).toEqual({ file_path: ".loki/state/runs.json" });
  expect(events.some((e) => e.kind === "tool_result" && e.payload.tool_use_id === "toolu_1")).toBe(true);
});

test("claude: costUsd comes from total_cost_usd on the result line", () => {
  expect(run("claude", fx("claude-stream.jsonl")).out.costUsd).toBe(0.0421);
});

test("a truncated stream finishes failed, never done", () => {
  const { out } = run("claude", fx("claude-stream.jsonl").slice(0, -1));
  expect(out.status).toBe("failed");
  expect(out.text).toContain("Let me look");
  expect(run("codex", fx("codex-stream.jsonl").slice(0, -1)).out.status).toBe("failed");
});

test("a malformed line becomes an error event, does not throw, and parsing continues", () => {
  const lines = fx("claude-stream.jsonl");
  lines.splice(2, 0, "{not json");
  const { events, out } = run("claude", lines);
  expect(events.filter((e) => e.kind === "error").length).toBe(1);
  expect(out.status).toBe("done");
  expect(out.text).toBe("Let me look at the runs. There are 2 runs.");
});

test("an is_error result finishes failed", () => {
  const lines = [...fx("claude-stream.jsonl").slice(0, -1), JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "boom", total_cost_usd: 0.01 })];
  const { out } = run("claude", lines);
  expect(out.status).toBe("failed");
  expect(out.error).toBe("boom");
  expect(out.costUsd).toBe(0.01);
});

test("claude partial stream_event deltas are not double counted with the assistant text", () => {
  const ev = (t: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
  const lines = [ev("Hel"), ev("lo"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" } }), JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hello" })];
  const { events, out } = run("claude", lines);
  expect(events.filter((e) => e.kind === "delta").map((e) => e.payload.text).join("")).toBe("Hello");
  expect(out.status).toBe("done");
});

test("codex (degraded): agent_message and command_execution parse; no cost", () => {
  const { events, out } = run("codex", fx("codex-stream.jsonl"));
  expect(out.status).toBe("done");
  expect(out.text).toBe("There is one file.");
  expect(out.costUsd).toBeUndefined();
  expect(events.some((e) => e.kind === "tool_use" && e.payload.name === "command_execution")).toBe(true);
});
