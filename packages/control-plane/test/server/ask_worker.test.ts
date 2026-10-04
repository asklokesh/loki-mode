// CP-ASK slice 9: the Ask worker, driven by a fake provider script (no network, no real claude).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { buildPrompt, trimHistory } from "../../src/ask/prompt.ts";
import { addTurn, citations, createThread, getMessage, listEvents } from "../../src/ask/store.ts";
import { cancelJob, runAskJob } from "../../src/ask/worker.ts";
import { pidAlive } from "../../src/ask/store.ts";

const REPO = resolve(import.meta.dir, "../../../..");
let root: string, out: string, bin: string;

const RESULT = (cost: number, text = "Hello r1") => `{"type":"result","subtype":"success","is_error":false,"result":"${text}","total_cost_usd":${cost}}`;
const DELTA = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}';
const TOOL = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__loki-ask__run_get","input":{"run":"r1"}}]}}';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ask-worker-test-"));
  out = join(root, "out");
  bin = join(root, "fake-claude");
  writeFileSync(bin, `#!/bin/sh
mkdir -p "$FAKE_OUT"
cat > "$FAKE_OUT/stdin.txt"
pwd -P > "$FAKE_OUT/cwd.txt"
echo "$@" > "$FAKE_OUT/argv.txt"
env > "$FAKE_OUT/env.txt"
echo $$ > "$FAKE_OUT/pid.txt"
case "$FAKE_MODE" in
  ok) echo '${DELTA}'; echo '${TOOL}'; echo '${RESULT(0.05)}' ;;
  pricey) echo '${DELTA}'; echo '${RESULT(5)}' ;;
  truncated) echo '${DELTA}' ;;
  hang) echo '${DELTA}'; sleep 60 ;;
  boom) echo oops >&2; exit 3 ;;
esac
`);
  chmodSync(bin, 0o755);
  process.env.FAKE_OUT = out;
});
afterAll(() => { delete process.env.FAKE_OUT; delete process.env.FAKE_MODE; rmSync(root, { recursive: true, force: true }); });

function setup(question = "whats going on so far") {
  const db = openDb(":memory:").db;
  const thread = createThread(db, { provider: "claude" });
  const { assistantId } = addTurn(db, thread, question);
  return { db, thread, id: assistantId };
}
const opts = (extra: Record<string, unknown> = {}) => ({ dbPath: "/data/control.db", bin, timeoutMs: 10_000, maxUsd: 1, ...extra });
const mode = (m: string) => { process.env.FAKE_MODE = m; rmSync(out, { recursive: true, force: true }); };

test("a good run is done, stores events and tool calls as citations, and removes the scratch dir", async () => {
  mode("ok");
  const { db, id } = setup();
  const status = await runAskJob(db, id, opts());
  expect(status).toBe("done");
  const m = getMessage(db, id)!;
  expect(m.status).toBe("done");
  expect(m.text).toBe("Hello r1");
  expect(m.costUsd).toBe(0.05);
  expect(m.workerPid).toBeGreaterThan(1);
  expect(m.pgid).toBe(m.workerPid!);
  expect(citations(db, id)).toEqual([{ id: "t1", name: "mcp__loki-ask__run_get", input: { run: "r1" } }]);
  expect(listEvents(db, id).map((e) => e.kind)).toEqual(["delta", "tool_use", "result"]);
  const cwd = readFileSync(join(out, "cwd.txt"), "utf8").trim();
  expect(existsSync(cwd)).toBe(false);
  const argv = readFileSync(join(out, "argv.txt"), "utf8");
  expect(argv).toContain("--strict-mcp-config");
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(readFileSync(join(out, "stdin.txt"), "utf8")).toContain("whats going on so far");
});

test("the provider env never carries the control token or db path", async () => {
  mode("ok");
  process.env.LOKI_CONTROL_TOKEN = "sekret-token";
  process.env.LOKI_CONTROL_DB = "/should/not/leak.db";
  try {
    const { db, id } = setup();
    await runAskJob(db, id, opts());
  } finally { delete process.env.LOKI_CONTROL_TOKEN; delete process.env.LOKI_CONTROL_DB; }
  const env = readFileSync(join(out, "env.txt"), "utf8");
  expect(env).not.toContain("sekret-token");
  expect(env).not.toContain("LOKI_CONTROL_DB");
  expect(env).toContain("LOKI_NO_BROWSER=1");
});

test("a result over the budget is over_budget, not done", async () => {
  mode("pricey");
  const { db, id } = setup();
  expect(await runAskJob(db, id, opts({ maxUsd: 1 }))).toBe("over_budget");
  expect(getMessage(db, id)!.status).toBe("over_budget");
  expect(getMessage(db, id)!.costUsd).toBe(5);
});

test("a truncated stream is failed, never done", async () => {
  mode("truncated");
  const { db, id } = setup();
  expect(await runAskJob(db, id, opts())).toBe("failed");
  expect(getMessage(db, id)!.error).toContain("without a result");
});

test("a nonzero exit is failed and carries the stderr tail", async () => {
  mode("boom");
  const { db, id } = setup();
  expect(await runAskJob(db, id, opts())).toBe("failed");
  expect(getMessage(db, id)!.error).toContain("oops");
});

test("a timeout kills only the recorded pgid and the process is gone", async () => {
  mode("hang");
  const { db, id } = setup();
  const kills: [number, string][] = [];
  const status = await runAskJob(db, id, opts({
    timeoutMs: 400,
    kill: (pgid: number, sig: NodeJS.Signals) => { kills.push([pgid, sig]); process.kill(-pgid, sig); },
  }));
  expect(status).toBe("timeout");
  const m = getMessage(db, id)!;
  expect(m.status).toBe("timeout");
  expect(kills.length).toBeGreaterThan(0);
  for (const [pgid] of kills) expect(pgid).toBe(m.pgid!);
  const pid = Number(readFileSync(join(out, "pid.txt"), "utf8").trim());
  expect(pid).toBe(m.pgid!);
  await Bun.sleep(100);
  expect(pidAlive(pid)).toBe(false);
  expect(existsSync(readFileSync(join(out, "cwd.txt"), "utf8").trim())).toBe(false);
});

test("cancelJob kills the recorded group and the message ends interrupted", async () => {
  mode("hang");
  const { db, id } = setup();
  const p = runAskJob(db, id, opts());
  for (let i = 0; i < 100 && getMessage(db, id)!.status !== "running"; i++) await Bun.sleep(20);
  expect(getMessage(db, id)!.status).toBe("running");
  expect(cancelJob(db, id)).toBe(true);
  expect(await p).toBe("interrupted");
  expect(getMessage(db, id)!.status).toBe("interrupted");
  expect(cancelJob(db, id)).toBe(false);
});

test("an unsupported provider fails before spawning anything", async () => {
  mode("ok");
  const db = openDb(":memory:").db;
  const t = createThread(db, { provider: "aider" });
  const { assistantId } = addTurn(db, t, "hi");
  expect(await runAskJob(db, assistantId, opts())).toBe("failed");
  expect(getMessage(db, assistantId)!.error).toContain("Ask needs claude or codex for now");
  expect(existsSync(out)).toBe(false);
});

test("a follow-up replays prior turns, oldest first, and the repo chip", async () => {
  mode("ok");
  const db = openDb(":memory:").db;
  const t = createThread(db, { provider: "claude", repo: "acme/widgets" });
  const first = addTurn(db, t, "how many runs failed?");
  const { finishMessage } = await import("../../src/ask/store.ts");
  finishMessage(db, first.assistantId, { status: "done", text: "Two failed: a:r1 and a:r2." });
  const second = addTurn(db, t, "why did the first one fail?");
  await runAskJob(db, second.assistantId, opts());
  const stdin = readFileSync(join(out, "stdin.txt"), "utf8");
  expect(stdin.indexOf("how many runs failed?")).toBeGreaterThan(-1);
  expect(stdin.indexOf("Two failed: a:r1 and a:r2.")).toBeGreaterThan(stdin.indexOf("how many runs failed?"));
  expect(stdin.indexOf("why did the first one fail?")).toBeGreaterThan(stdin.indexOf("Two failed"));
  expect(stdin).toContain("acme/widgets");
  expect(stdin).not.toContain("User: \n");
});

test("buildPrompt tells the model tool text is untrusted and that Ask cannot start builds; history is trimmed oldest first", () => {
  const p = buildPrompt({ history: [], question: "q?" });
  expect(p).toContain("untrusted");
  expect(p).toContain("read-only");
  expect(p).toContain("source:run");
  const big = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn${i} ` + "x".repeat(3000) }));
  const kept = trimHistory(big, 10_000);
  expect(kept.length).toBeLessThan(10);
  expect(kept[kept.length - 1]!.text.startsWith("turn9")).toBe(true);
});

test("the ask module never imports planStart or spawnStart, and imports only childEnv from spawn.ts", () => {
  const dir = join(REPO, "packages/control-plane/src/ask");
  const files = ["store", "policy", "invoke", "worker", "prompt", "parse"].map((f) => readFileSync(join(dir, `${f}.ts`), "utf8"));
  const routes = readFileSync(join(REPO, "packages/control-plane/src/server/routes/ask.ts"), "utf8");
  for (const src of [...files, routes]) {
    expect(src).not.toMatch(/planStart|spawnStart|registryRepos/);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*spawn\.ts"/g)) expect(m[1]!.trim()).toBe("childEnv");
  }
});
