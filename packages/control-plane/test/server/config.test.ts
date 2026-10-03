// CPE-14: GET and PUT /v1/config. Comment-preserving atomic writes, If-Match, schema validation, secret refusal, symlink and peer guards.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { renderVerified } from "../../src/server/routes/config.ts";
import { createApp } from "../../src/server/app.ts";

const peer = (address: string) => ({ requestIP: () => ({ address }) });
let dir: string;
let outside: string;
let cleanups: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cpe14-repo-"));
  outside = mkdtempSync(join(tmpdir(), "cpe14-out-"));
});
afterEach(() => {
  for (const f of cleanups) f();
  cleanups = [];
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const mk = () => {
  const { app, db, close } = createApp({ dbPath: ":memory:", loopbackOnly: true, repoDir: dir });
  cleanups.push(close);
  return { app, db };
};
const get = (app: ReturnType<typeof mk>["app"], ip = "127.0.0.1") =>
  app.fetch(new Request("http://127.0.0.1:1234/v1/config", { headers: { host: "127.0.0.1:1234" } }), peer(ip));
const put = (app: ReturnType<typeof mk>["app"], body: unknown, o: { etag?: string | null; ip?: string; origin?: string } = {}) => {
  const headers: Record<string, string> = { host: "127.0.0.1:1234", "content-type": "application/json" };
  if (o.etag !== null && o.etag !== undefined) headers["if-match"] = o.etag;
  if (o.origin) headers.origin = o.origin;
  return app.fetch(new Request("http://127.0.0.1:1234/v1/config", { method: "PUT", headers, body: JSON.stringify(body) }), peer(o.ip ?? "127.0.0.1"));
};
const auditRows = (db: ReturnType<typeof mk>["db"]) => (db as unknown as { $client: { query: (q: string) => { all: () => Array<Record<string, string>> } } }).$client.query("select kind, result, detail from actions order by id").all();

const SAMPLE = `# team config
provider: claude # default provider
models:
  # the dev model
  default: sonnet
concurrency: 2
`;

test("comments survive a round trip and the file stays atomic (no temp files left)", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const g = await get(app);
  expect(g.status).toBe(200);
  const gb = await g.json() as { etag: string; config: Record<string, unknown>; errors: string[] };
  expect(gb.errors).toEqual([]);
  expect(gb.config.provider).toBe("claude");
  const r = await put(app, { config: { ...gb.config, concurrency: 4, budgets: { per_run_usd: 5 } } }, { etag: gb.etag });
  expect(r.status).toBe(200);
  const out = readFileSync(join(dir, "loki.yaml"), "utf8");
  expect(out).toContain("# team config");
  expect(out).toContain("# default provider");
  expect(out).toContain("# the dev model");
  expect(out).toContain("concurrency: 4");
  expect(out).toContain("per_run_usd: 5");
  expect(readFileSync(join(dir, "loki.yaml.bak"), "utf8")).toBe(SAMPLE);
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  const again = await (await get(app)).json() as { config: Record<string, unknown> };
  expect(again.config.concurrency).toBe(4);
});

test("a missing loki.yaml reads as empty and can be created", async () => {
  const { app } = mk();
  const gb = await (await get(app)).json() as { exists: boolean; etag: string };
  expect(gb.exists).toBe(false);
  expect((await put(app, { config: { provider: "codex" } }, { etag: gb.etag })).status).toBe(200);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toContain("provider: codex");
});

test("invalid input is rejected with paths and the file is untouched", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  for (const config of [{ provider: "gemini" }, { concurrency: 0 }, { concurrency: 2.5 }, { nope: 1 }, { budgets: { per_run_usd: -1 } }, { git: { token_env: "lower" } }, { repos: ["bad repo"] }]) {
    const r = await put(app, { config }, { etag });
    expect(r.status).toBe(422);
  }
  expect((await put(app, { config: "x" }, { etag })).status).toBe(400);
  expect((await put(app, { nothing: 1 }, { etag })).status).toBe(400);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(SAMPLE);
});

test("If-Match is required and a stale value gets 409 with the current etag", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app, db } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  expect((await put(app, { config: { provider: "codex" } }, { etag: null })).status).toBe(428);
  expect((await put(app, { config: { provider: "codex" } }, { etag: "\"deadbeef\"" })).status).toBe(409);
  expect((await put(app, { config: { provider: "codex" } }, { etag })).status).toBe(200);
  const stale = await put(app, { config: { provider: "aider" } }, { etag });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { etag: string }).etag).not.toBe(etag);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toContain("provider: codex");
  expect(auditRows(db).some((a) => a.kind === "config.update" && a.result === "conflict")).toBe(true);
});

test("a secret-looking value is refused, never echoed, never audited, never written", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app, db } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  const secrets = ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "xoxb-123456789012-abcdef", "https://hooks.slack.com/services/T000/B000/XXXX", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5", "https://user:pw123@example.com/x"];
  for (const s of secrets) {
    const r = await put(app, { config: { git: { token_env: s } } }, { etag });
    expect(r.status).toBe(422);
    const text = await r.text();
    expect(text).not.toContain(s);
    const r2 = await put(app, { config: { knowledge_sources: [s] } }, { etag });
    expect(r2.status).toBe(422);
  }
  expect(JSON.stringify(auditRows(db))).not.toContain("abcdefghijklmnop");
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(SAMPLE);
  const ok = await put(app, { config: { git: { token_env: "GITHUB_TOKEN" }, notifications: { slack_webhook_env: "SLACK_WEBHOOK_URL" }, knowledge_sources: ["/Users/dev/projects/very-long-directory-name/docs"] } }, { etag });
  expect(ok.status).toBe(200);
});

test("a symlinked loki.yaml that resolves outside the repo is refused for read and write", async () => {
  writeFileSync(join(outside, "loki.yaml"), "provider: claude\n");
  symlinkSync(join(outside, "loki.yaml"), join(dir, "loki.yaml"));
  const { app } = mk();
  expect((await get(app)).status).toBe(400);
  const r = await put(app, { config: { provider: "codex" } }, { etag: "\"x\"" });
  expect(r.status).toBe(400);
  expect(readFileSync(join(outside, "loki.yaml"), "utf8")).toBe("provider: claude\n");
});

test("a symlink that stays inside the repo is followed and the link is kept", async () => {
  mkdirSync(join(dir, "conf"));
  writeFileSync(join(dir, "conf", "real.yaml"), SAMPLE);
  symlinkSync(join(dir, "conf", "real.yaml"), join(dir, "loki.yaml"));
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  expect((await put(app, { config: { provider: "codex" } }, { etag })).status).toBe(200);
  expect(readFileSync(join(dir, "conf", "real.yaml"), "utf8")).toContain("provider: codex");
  expect(existsSync(join(dir, "loki.yaml"))).toBe(true);
});

test("a non-loopback peer, a bad origin, a non-JSON body and a non-loopback bind are refused", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  expect((await get(app, "192.168.1.50")).status).toBe(403);
  expect((await put(app, { config: { provider: "codex" } }, { etag, ip: "192.168.1.50" })).status).toBe(403);
  expect((await put(app, { config: { provider: "codex" } }, { etag, origin: "https://evil.example.com" })).status).toBe(403);
  const form = await app.fetch(new Request("http://127.0.0.1:1234/v1/config", { method: "PUT", headers: { host: "127.0.0.1:1234", "content-type": "text/plain", "if-match": etag }, body: "{}" }), peer("127.0.0.1"));
  expect(form.status).toBe(403);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(SAMPLE);
  const open = createApp({ dbPath: ":memory:", loopbackOnly: false, repoDir: dir });
  cleanups.push(open.close);
  expect((await put(open.app, { config: { provider: "codex" } }, { etag })).status).toBe(404);
});

test("a successful write is audited with section names only", async () => {
  const { app, db } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  await put(app, { config: { provider: "codex", concurrency: 3 } }, { etag });
  const row = auditRows(db).find((a) => a.kind === "config.update" && a.result === "updated");
  expect(row?.detail).toBe("sections: provider, concurrency");
});

const raw = (app: ReturnType<typeof mk>["app"], body: string, etag = "*") =>
  app.fetch(new Request("http://127.0.0.1:1234/v1/config", { method: "PUT", headers: { host: "127.0.0.1:1234", "content-type": "application/json", "if-match": etag }, body }), peer("127.0.0.1"));

test("prototype member names are unknown keys: both payloads get 422 and a file holding them reports errors", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  for (const body of ['{"config":{"constructor":{"hook":"HOOKCMD"}}}', '{"config":{"models":{"toString":["x"]}}}', '{"config":{"hasOwnProperty":1}}', '{"config":{"__proto__":{"a":1}}}']) {
    expect((await raw(app, body, etag)).status).toBe(422);
  }
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(SAMPLE);
  writeFileSync(join(dir, "loki.yaml"), "constructor:\n  hook: HOOKCMD\nmodels:\n  toString: [x]\n");
  const g = await (await get(app)).json() as { errors: string[] };
  expect(g.errors.length).toBeGreaterThanOrEqual(2);
});

test("deep nesting and an alias bomb return 422 (not a crash) and are audited", async () => {
  const { app, db } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  const deep = `{"config":{"knowledge_sources":${"[".repeat(40000)}${"]".repeat(40000)}}}`;
  expect((await raw(app, deep, etag)).status).toBe(422);
  const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 30 }, (_, i) => `b${i}: *a`)].join("\n") + "\n";
  writeFileSync(join(dir, "loki.yaml"), bomb);
  const g = await get(app);
  expect([200, 422]).toContain(g.status);
  const e2 = g.status === 200 ? ((await g.json()) as { etag: string }).etag : "*";
  const p = await put(app, { config: { provider: "claude" } }, { etag: e2 });
  expect([409, 422]).toContain(p.status);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(bomb);
  expect(auditRows(db).filter((a) => a.result === "refused").length).toBeGreaterThanOrEqual(1);
});

test("every refusal is audited, including the 403 guards and 413", async () => {
  const { app, db } = mk();
  await get(app, "10.0.0.9");
  await put(app, { config: {} }, { etag: "*", ip: "10.0.0.9" });
  await put(app, { config: {} }, { etag: "*", origin: "https://evil.example.com" });
  expect((await raw(app, "x".repeat(100_001))).status).toBe(413);
  const rows = auditRows(db);
  expect(rows.filter((a) => a.result === "refused").map((a) => a.detail)).toEqual(["loopback requests only", "loopback JSON requests only", "origin not allowed", "body too large"]);
});

test("workspace shell strings are read-only through the API", async () => {
  const yml = "workspaces:\n  w:\n    repos:\n      - repo: a/b\n        setup: npm ci\n    integration:\n      command: npm test\n";
  writeFileSync(join(dir, "loki.yaml"), yml);
  const { app } = mk();
  const { etag, config } = await (await get(app)).json() as { etag: string; config: any };
  const edit = (f: (c: any) => void) => { const c = structuredClone(config); f(c); return c; };
  const bad = [
    edit((c) => { c.workspaces.w.integration.command = "echo pwned"; }),
    edit((c) => { c.workspaces.w.repos[0].setup = "echo pwned"; }),
    edit((c) => { delete c.workspaces.w.integration.command; }),
    edit((c) => { c.workspaces.w.repos.push({ repo: "c/d", setup: "x" }); }),
    edit((c) => { c.workspaces.v = { integration: { command: "id" } }; }),
  ];
  for (const c of bad) {
    const r = await put(app, { config: c }, { etag });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toContain("edit shell commands in loki.yaml directly");
  }
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(yml);
  const ok = await put(app, { config: edit((c) => { c.concurrency = 3; c.workspaces.w.repos[0].path = "/x"; }) }, { etag });
  expect(ok.status).toBe(200);
});

test("If-Match * matches an existing file only; a directory named loki.yaml is 422", async () => {
  const { app } = mk();
  expect((await put(app, { config: { provider: "codex" } }, { etag: "*" })).status).toBe(409);
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  expect((await put(app, { config: { provider: "codex" } }, { etag: "*" })).status).toBe(200);
  rmSync(join(dir, "loki.yaml"));
  mkdirSync(join(dir, "loki.yaml"));
  expect((await get(app)).status).toBe(422);
  expect((await put(app, { config: { provider: "codex" } }, { etag: "*" })).status).toBe(422);
});

test("the render round-trip guard refuses a write that would break an anchor", async () => {
  const yml = "repos: &r [a/b]\nknowledge_sources: *r\n";
  writeFileSync(join(dir, "loki.yaml"), yml);
  const { app } = mk();
  const { etag, config } = await (await get(app)).json() as { etag: string; config: Record<string, unknown> };
  const r = await put(app, { config: { ...config, repos: ["c/d"] } }, { etag });
  expect(r.status).toBe(400);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(yml);
});

test("renderVerified returns null unless the re-parsed render equals the requested config", () => {
  expect(renderVerified(parseDocument("a: 1\n"), { a: 1 })).toBe("a: 1\n");
  expect(renderVerified(parseDocument("a: 1\n"), { a: 2 })).toBeNull();
  expect(renderVerified(parseDocument("a: 1\n"), { b: 1 })).toBeNull();
});
