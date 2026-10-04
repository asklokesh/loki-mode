// CP-ASK slice 2 wall checks: read-only data tools and the stdio server that exposes them.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../../src/server/app.ts";
import { localRepos } from "../../src/db/schema.ts";
import { TOOL_NAMES } from "../../src/ask/tools.ts";
import * as T from "../../src/ask/tools.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-asktools-")));
const dbPath = join(root, "control.db");
const repo = join(root, "repo");
const load = (name: string) => readFileSync(join(FIX, name, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const c = createApp({ dbPath, loopbackOnly: true });
c.db.insert(localRepos).values({ sourceId: SRC, realpath: repo, name: "repo", discoveredAt: new Date().toISOString() }).run();
const ids: string[] = [];
for (const name of ["verified", "failed"]) {
  const evs = load(name);
  const run = evs[0].run as string;
  ids.push(run);
  const r = await c.app.fetch(new Request("http://127.0.0.1:1/v1/ingest", { method: "POST", headers: { host: "127.0.0.1:1" }, body: JSON.stringify({ source: SRC, run_id: run, events: evs }) }));
  expect(r.status).toBe(200);
}
const [A, B] = ids as [string, string];
const dir = join(repo, ".loki", "runs", A);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "receipt.md"), "# receipt\n");
writeFileSync(join(dir, "events.jsonl"), "not allowlisted\n");
afterAll(() => { c.close(); rmSync(root, { recursive: true, force: true }); });

test("runs_compare returns both ids, verdicts and costs", () => {
  const r = T.runsCompare(c.db, { source_a: SRC, run_a: A, source_b: SRC, run_b: B }) as any;
  expect(r.runs.map((x: any) => x.run_id)).toEqual([A, B]);
  for (const x of r.runs) {
    expect(x).toHaveProperty("verdict");
    expect(x).toHaveProperty("cost_usd");
  }
  expect(r.runs[0].verdict).toBe("VERIFIED");
  expect(r.runs[1].verdict).not.toBe("VERIFIED");
  expect(T.runsCompare(c.db, { source_a: SRC, run_a: A, source_b: SRC, run_b: "nope" })).toHaveProperty("error");
});

test("artifact outside the allowlist or containment is refused", () => {
  for (const name of ["events.jsonl", "../../etc/passwd", "/etc/passwd", "receipt.md/../x", "a\\b", "evidence/../x.png", ""]) {
    expect(T.runArtifact(c.db, { source_id: SRC, run_id: A, name })).toHaveProperty("error");
  }
  expect(T.runArtifact(c.db, { source_id: SRC, run_id: "../x", name: "receipt.md" })).toHaveProperty("error");
  expect(T.runArtifact(c.db, { source_id: SRC, run_id: A, name: "receipt.md" })).toEqual({ name: "receipt.md", content: "# receipt\n" });
  expect(T.runArtifact(c.db, { source_id: SRC, run_id: A, name: "evidence/x.png" })).toHaveProperty("error");
});

test("search, get, events, stats, cost, repos work and leak no path, url or token", async () => {
  const all = [
    T.runsSearch(c.db, {}), T.runGet(c.db, { source_id: SRC, run_id: A }), await T.runEvents(c.db, { source_id: SRC, run_id: A, limit: 3 }),
    T.stats(c.db, {}), await T.cost(c.db, { group: "day,model" }), T.reposList(c.db),
  ];
  expect((all[0] as any).runs.length).toBe(2);
  expect((all[2] as any).events.length).toBe(3);
  expect((all[5] as any).repos).toContain("repo");
  expect(await T.cost(c.db, { group: "bogus" })).toHaveProperty("error");
  expect(T.runsSearch(c.db, { limit: 9999 })).toHaveProperty("error");
  const blob = JSON.stringify(all);
  expect(blob).not.toContain(root);
  expect(blob).not.toMatch(/https?:\/\//);
});

test("stdio server lists exactly the read tools and they answer", async () => {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../../src/ask/tools_server.ts")],
    env: { PATH: process.env.PATH ?? "", LOKI_CONTROL_DB: dbPath, LOKI_CONTROL_TOKEN: "tok-SECRET" },
  });
  const cl = new Client({ name: "t", version: "1" });
  await cl.connect(t);
  try {
    const list = await cl.listTools();
    expect(list.tools.map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of list.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    const r = (await cl.callTool({ name: "runs_compare", arguments: { source_a: SRC, run_a: A, source_b: SRC, run_b: B } })) as any;
    const body = JSON.parse(r.content[0].text);
    expect(body.runs.map((x: any) => x.run_id)).toEqual([A, B]);
    expect(r.content[0].text).not.toContain("tok-SECRET");
    const bad = (await cl.callTool({ name: "run_artifact", arguments: { source_id: SRC, run_id: A, name: "events.jsonl" } })) as any;
    expect(bad.isError).toBe(true);
    const missing = await cl.callTool({ name: "store_pattern", arguments: {} }).catch((e) => e);
    expect((missing as any).isError === true || missing instanceof Error).toBe(true);
  } finally { await cl.close(); }
}, 30000);

test("no write path: db opened read-only and no spawn imports", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/ask/tools_server.ts"), "utf8") + readFileSync(join(import.meta.dir, "../../src/ask/tools.ts"), "utf8");
  expect(src).toContain("readonly: true");
  expect(src).not.toMatch(/spawn\.ts|planStart|spawnStart|child_process|Bun\.spawn/);
  expect(src).not.toMatch(/\.(insert|update|delete)\(/);
});
