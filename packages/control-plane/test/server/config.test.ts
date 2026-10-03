// CPE-14: GET and PUT /v1/config. Comment-preserving atomic writes, If-Match, schema validation, secret refusal, symlink and peer guards.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { needsQuote, renderVerified } from "../../src/server/routes/config.ts";
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
  const ok = await put(app, { config: edit((c) => { c.concurrency = 3; }) }, { etag });
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

test("a shell-bearing workspace is read-only as a whole: re-pointing repo and path under an unchanged setup is 422", async () => {
  const yml = "workspaces:\n  w:\n    repos:\n      - repo: a/b\n        path: ../b\n        setup: npm ci\n";
  writeFileSync(join(dir, "loki.yaml"), yml);
  const { app } = mk();
  const { etag, config } = await (await get(app)).json() as { etag: string; config: any };
  for (const f of [(c: any) => { c.workspaces.w.repos[0].repo = "bad/pkg"; c.workspaces.w.repos[0].path = "../../../Downloads/bad"; }, (c: any) => { c.workspaces.w.repos[0].path = "/x"; }, (c: any) => { c.workspaces.w.integration = { path: "q" }; }]) {
    const c = structuredClone(config); f(c);
    const r = await put(app, { config: c }, { etag });
    expect(r.status).toBe(422);
  }
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(yml);
});

test("a workspace without shell strings cannot take a .. path", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  const r = await put(app, { config: { workspaces: { w: { repos: [{ repo: "a/b", path: "../../x" }] } } } }, { etag });
  expect(r.status).toBe(422);
  expect(((await r.json()) as { error: string }).error).toContain(".. segments");
  expect((await put(app, { config: { workspaces: { w: { repos: [{ repo: "a/b", path: "/x/y" }] } } } }, { etag })).status).toBe(200);
});

test("the YAML merge key << is refused at any depth", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  for (const c of [{ workspaces: { "<<": { repos: [{ repo: "a/b", path: "/x" }] } } }, { workspaces: { w: { repos: [{ repo: "a/b", path: "/x", "<<": 1 }] } } }]) {
    const r = await put(app, { config: c }, { etag });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toContain("merge key");
  }
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(SAMPLE);
});

test("strings YAML 1.1 reads as non-strings are written quoted and round-trip under 1.1", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  const vals = ["yes", "2026-01-01", "on", "No", "~", "null", "1_000", "0o17", "0x1F", "1:30", "1.5e3", "012"];
  const r = await put(app, { config: { knowledge_sources: vals } }, { etag });
  expect(r.status).toBe(200);
  const text = readFileSync(join(dir, "loki.yaml"), "utf8");
  expect(text).toContain('"yes"');
  expect(text).toContain('"2026-01-01"');
  expect(text).toContain('"on"');
  expect((parseDocument(text, { version: "1.1", schema: "yaml-1.1", merge: true }).toJS() as { knowledge_sources: string[] }).knowledge_sources).toEqual(vals);
  const py = spawnSync("python3", ["-c", "import yaml"]);
  if (py.status !== 0) return;
  const script = join(import.meta.dir, "..", "..", "..", "..", "autonomy", "lib", "loki_yaml.py");
  const v = spawnSync("python3", [script, "validate", join(dir, "loki.yaml")], { encoding: "utf8" });
  expect(v.status).toBe(0);
});

test("a payload nested past the cap returns the exact nested-too-deeply error", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  const r = await raw(app, `{"config":{"knowledge_sources":${"[".repeat(30)}${"]".repeat(30)}}}`, etag);
  expect(r.status).toBe(422);
  expect(((await r.json()) as { error: string }).error).toBe("config is nested too deeply");
});

const pyOk = spawnSync("python3", ["-c", "import yaml"]).status === 0;
const LOKI_YAML = join(import.meta.dir, "..", "..", "..", "..", "autonomy", "lib", "loki_yaml.py");
const CORPUS = ["=", "<<", "a\u2029b", "a\u2028b", "a\u0085b", "\u2029", "yes", "No", "~", "1_000", "0o17", "1e3", "-", "a: b", "a #b", "tab\there", "x ", "caf\u00e9", "{a}", "!tag", "*alias", "&anc", "?", "|", ">", "%x", "@x", "`x"];

test("every corpus string round-trips through PyYAML safe_load identically and loki_yaml.py validate exits 0", async () => {
  if (!pyOk) return;
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  const all = await put(app, { config: { knowledge_sources: CORPUS } }, { etag });
  expect(all.status).toBe(200);
  const file = join(dir, "loki.yaml");
  const py = (f: string) => spawnSync("python3", ["-c", "import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8').read()), ensure_ascii=True))", f], { encoding: "utf8" });
  const r = py(file);
  expect(r.status).toBe(0);
  expect((JSON.parse(r.stdout) as { knowledge_sources: string[] }).knowledge_sources).toEqual(CORPUS);
  expect(spawnSync("python3", [LOKI_YAML, "validate", file], { encoding: "utf8" }).status).toBe(0);
  // each value alone, under models.default as well
  for (const v of CORPUS) {
    const e = (await (await get(app)).json() as { etag: string }).etag;
    expect((await put(app, { config: { models: { default: v } } }, { etag: e })).status).toBe(200);
    const one = py(file);
    expect(one.status).toBe(0);
    expect((JSON.parse(one.stdout) as { models: { default: string } }).models.default).toBe(v);
    expect(spawnSync("python3", [LOKI_YAML, "validate", file], { encoding: "utf8" }).status).toBe(0);
  }
});

const BAD_CPS = [0x7f, ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i).filter((c) => c !== 0x85), 0xfffe, 0xffff];

test("code points PyYAML refuses raw (U+007F, U+0080-9F minus 85, U+FFFE/F) are escaped and load in PyYAML", async () => {
  if (!pyOk) return;
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const vals = BAD_CPS.map((c) => "a" + String.fromCodePoint(c) + "b");
  expect(vals.length).toBe(34);
  const file = join(dir, "loki.yaml");
  const py = (f: string) => spawnSync("python3", ["-c", "import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8').read()), ensure_ascii=True))", f], { encoding: "utf8" });
  const etag = (await (await get(app)).json() as { etag: string }).etag;
  expect((await put(app, { config: { knowledge_sources: vals } }, { etag })).status).toBe(200);
  const r = py(file);
  expect(r.status).toBe(0);
  expect((JSON.parse(r.stdout) as { knowledge_sources: string[] }).knowledge_sources).toEqual(vals);
  expect(spawnSync("python3", [LOKI_YAML, "validate", file], { encoding: "utf8" }).status).toBe(0);
  for (const v of ["\u007f", "\u009f", "\ufffe"]) {
    const e = (await (await get(app)).json() as { etag: string }).etag;
    expect((await put(app, { config: { models: { default: v } } }, { etag: e })).status).toBe(200);
    const one = py(file);
    expect(one.status).toBe(0);
    expect((JSON.parse(one.stdout) as { models: { default: string } }).models.default).toBe(v);
  }
});

test("an existing file with escaped bad code points stays loadable in PyYAML after an unrelated edit", async () => {
  if (!pyOk) return;
  const yml = 'models:\n  default: "\\x7f"\nknowledge_sources:\n  - "\\x9f"\n  - "\\uFFFE"\nconcurrency: 3\n';
  writeFileSync(join(dir, "loki.yaml"), yml);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  expect((await put(app, { config: { models: { default: "\u007f" }, knowledge_sources: ["\u009f", "\ufffe"], concurrency: 4 } }, { etag })).status).toBe(200);
  const file = join(dir, "loki.yaml");
  const r = spawnSync("python3", ["-c", "import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8').read()), ensure_ascii=True))", file], { encoding: "utf8" });
  expect(r.status).toBe(0);
  const j = JSON.parse(r.stdout) as { models: { default: string }; knowledge_sources: string[]; concurrency: number };
  expect(j.models.default).toBe("\u007f");
  expect(j.knowledge_sources).toEqual(["\u009f", "\ufffe"]);
  expect(j.concurrency).toBe(4);
});

test("renderVerified refuses output that still holds a character PyYAML rejects", () => {
  // a renderer that leaks a raw control character the escapes do not cover: only the final guard can refuse it
  const leaky = parseDocument("a: 1\n");
  leaky.toString = () => "a: 1 # p\u0001q\n";
  expect(renderVerified(leaky, { a: 1 })).toBeNull();
  const clean = parseDocument("a: 1\n");
  clean.toString = () => "a: 1 # pq\n";
  expect(renderVerified(clean, { a: 1 })).toBe("a: 1 # pq\n");
  const d2 = parseDocument("a: x\n");
  d2.set("a", "p\u007fq");
  expect(renderVerified(d2, { a: "p\u007fq" })).toBe('a: "p\\x7fq"\n');
});

test("needsQuote quotes the dangerous scalars and leaves plain names plain", () => {
  for (const v of ["=", "<<", "a\u2029b", "a\u2028b", "a\u0085b", "yes", "-", "1.5", "x "]) expect(needsQuote(v)).toBe(true);
  for (const v of ["sonnet", "a/b", "per_run_usd", "gpt-5.3-codex", "a b"]) expect(needsQuote(v)).toBe(false);
});

test("the YAML 1.1 re-parse refuses a write on its own when the quoter misses a value", () => {
  const never = () => false;
  const docWith = (v: string) => { const d = parseDocument("a: x\n"); d.set("a", v); return d; };
  // "yes" is a string under 1.2 (first re-parse passes) but a boolean under 1.1: only the second re-parse can refuse it
  expect(parseDocument("a: yes\n").toJS()).toEqual({ a: "yes" });
  expect(renderVerified(docWith("yes"), { a: "yes" }, never)).toBeNull();
  expect(renderVerified(docWith("yes"), { a: "yes" })).toBe('a: "yes"\n');
});

test("a NEW .. path is refused even when a different .. path already exists in the file", async () => {
  const yml = "workspaces:\n  w:\n    repos:\n      - repo: a/b\n        path: ../old\n";
  writeFileSync(join(dir, "loki.yaml"), yml);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  const keep = { repo: "a/b", path: "../old" };
  for (const w of [
    { w: { repos: [keep, { repo: "c/d", path: "../new" }] } },
    { w: { repos: [{ repo: "a/b", path: "../other" }] } },
    { w: { repos: [keep] }, v: { repos: [{ repo: "c/d", path: "../old" }] } },
  ]) {
    const r = await put(app, { config: { workspaces: w } }, { etag });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toContain(".. segments");
  }
  expect((await put(app, { config: { workspaces: { w: { repos: [keep] } } } }, { etag })).status).toBe(200);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toContain("../old");
});

test("workspace names are restricted to [A-Za-z0-9_.-]+ and may not be . or ..", async () => {
  writeFileSync(join(dir, "loki.yaml"), SAMPLE);
  const { app } = mk();
  const { etag } = await (await get(app)).json() as { etag: string };
  for (const n of ["../../escape", "..", ".", "a/b", "a b", ""]) {
    const r = await put(app, { config: { workspaces: { [n]: { repos: [{ repo: "a/b", path: "/x" }] } } } }, { etag });
    expect(r.status).toBe(422);
  }
  expect((await put(app, { config: { workspaces: { "my-ws_1.x": { repos: [{ repo: "a/b", path: "/x" }] } } } }, { etag })).status).toBe(200);
  expect(readFileSync(join(dir, "loki.yaml"), "utf8")).toBe(SAMPLE.length ? readFileSync(join(dir, "loki.yaml"), "utf8") : "");
});
