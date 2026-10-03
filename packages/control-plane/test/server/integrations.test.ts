// CPE-20: GET /v1/integrations. Presence-only probes; no secret value ever reaches a response body.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const KEYS = ["GITHUB_TOKEN", "MY_GH", "SLACK_HOOK", "LINEAR_API_KEY", "SENTRY_AUTH_TOKEN", "GITLAB_TOKEN", "JIRA_API_TOKEN", "PATH"];
const saved: Record<string, string | undefined> = {};
let dir: string;
let bins: string;
let cleanups: Array<() => void> = [];

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; if (k !== "PATH") delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), "cpe20-repo-"));
  bins = mkdtempSync(join(tmpdir(), "cpe20-bin-"));
  // Hermetic PATH: a runner image shipping a system gh must not leak into the gh-absent cases.
  process.env.PATH = bins;
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const f of cleanups) f();
  cleanups = [];
  rmSync(dir, { recursive: true, force: true });
  rmSync(bins, { recursive: true, force: true });
});


const lo = (path: string, o: { ip?: string; host?: string; headers?: Record<string, string> } = {}) => (app: { fetch: (r: Request, e?: unknown) => Response | Promise<Response> }) =>
  app.fetch(new Request(`http://127.0.0.1:1234${path}`, { headers: { host: o.host ?? "127.0.0.1:1234", ...(o.headers ?? {}) } }), { requestIP: () => ({ address: o.ip ?? "127.0.0.1" }) });

const gh = (code: number) => { const p = join(bins, "gh"); writeFileSync(p, `#!/bin/sh\nexit ${code}\n`); chmodSync(p, 0o755); };
const list = async () => {
  const { app, close } = createApp({ dbPath: ":memory:", repoDir: dir });
  cleanups.push(close);
  const text = await (await lo("/v1/integrations")(app)).text();
  const rows = JSON.parse(text).integrations as Array<Record<string, any>>;
  return { text, by: (id: string) => rows.find((r) => r.id === id)!, rows };
};

test("lists all seven services; unprobeable ones read not_measured, never a fake zero", async () => {
  const { by, rows } = await list();
  expect(rows.map((r) => r.id)).toEqual(["github", "gitlab", "slack", "jira", "linear", "sentry", "mcp"]);
  expect(by("github").status).toBe("not_measured");
  expect(by("jira").status).toBe("not_measured");
  expect(by("slack").status).toBe("not_connected");
  expect(by("mcp").status).toBe("not_measured");
});

test("github: stubbed gh auth success, failure, and git.token_env", async () => {
  gh(0);
  expect((await list()).by("github")).toMatchObject({ status: "connected", method: "gh_cli" });
  gh(1);
  expect((await list()).by("github")).toMatchObject({ status: "not_connected", method: "gh_cli" });
  writeFileSync(join(dir, "loki.yaml"), "git:\n  token_env: MY_GH\n");
  expect((await list()).by("github")).toMatchObject({ status: "not_connected", env_name: "MY_GH", env_set: false });
  process.env.MY_GH = "ghp_ABCDEF1234567890SECRET";
  expect((await list()).by("github")).toMatchObject({ status: "connected", method: "env", env_name: "MY_GH", env_set: true });
});

test("slack reads notifications.slack_webhook_env; mcp counts servers; others use conventional names", async () => {
  writeFileSync(join(dir, "loki.yaml"), "notifications:\n  slack_webhook_env: SLACK_HOOK\n");
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { a: { env: { K: "mcp-secret-value" } }, b: {} } }));
  process.env.SLACK_HOOK = "https://hooks.slack.com/services/T0/B0/XXXX";
  process.env.LINEAR_API_KEY = "lin_api_SECRET";
  const { by, text } = await list();
  expect(by("slack")).toMatchObject({ status: "connected", env_name: "SLACK_HOOK", config_path: "notifications.slack_webhook_env" });
  expect(by("mcp")).toMatchObject({ status: "connected", detail: "2 servers declared in .mcp.json" });
  expect(by("linear")).toMatchObject({ status: "connected", env_name: "LINEAR_API_KEY", config_path: null });
  expect(text).not.toContain("mcp-secret-value");
});

test("a secret value in the environment never appears in any response body", async () => {
  const secrets = { MY_GH: "ghp_TOPSECRETVALUE111", SLACK_HOOK: "https://hooks.slack.com/services/TSECRET/BSECRET/ZSECRET", GITLAB_TOKEN: "glpat-SECRETGITLAB", JIRA_API_TOKEN: "jira-SECRETJIRA", LINEAR_API_KEY: "lin_SECRETLINEAR", SENTRY_AUTH_TOKEN: "sntrys_SECRETSENTRY" };
  Object.assign(process.env, secrets);
  writeFileSync(join(dir, "loki.yaml"), "git:\n  token_env: MY_GH\nnotifications:\n  slack_webhook_env: SLACK_HOOK\n");
  gh(0);
  const { text } = await list();
  for (const v of Object.values(secrets)) expect(text).not.toContain(v);
  for (const frag of ["SECRET", "hooks.slack.com"]) expect(text).not.toContain(frag);
  expect(text).toContain("MY_GH");
});

test("token guard: 401 without the bearer token", async () => {
  const { app, close } = createApp({ dbPath: ":memory:", repoDir: dir, token: "tok123" });
  cleanups.push(close);
  expect((await app.request("/v1/integrations")).status).toBe(401);
  expect((await app.request("/v1/integrations", { headers: { authorization: "Bearer tok123" } })).status).toBe(200);
});

test("no token: non-loopback peer or Host is refused; with a token the bearer is the gate", async () => {
  const { app, close } = createApp({ dbPath: ":memory:", repoDir: dir });
  cleanups.push(close);
  expect((await lo("/v1/integrations", { ip: "10.0.0.5" })(app)).status).toBe(403);
  expect((await lo("/v1/integrations", { host: "evil.example" })(app)).status).toBe(403);
  expect((await lo("/v1/integrations")(app)).status).toBe(200);
});

test("gh probe result is cached for 60s per app", async () => {
  const log = join(dir, "gh.log");
  rmSync(log, { force: true });
  writeFileSync(join(bins, "gh"), `#!/bin/sh\necho x >> ${log}\nexit 0\n`); chmodSync(join(bins, "gh"), 0o755);
  const { app, close } = createApp({ dbPath: ":memory:", repoDir: dir });
  cleanups.push(close);
  for (let i = 0; i < 3; i++) expect((await lo("/v1/integrations")(app)).status).toBe(200);
  expect(readFileSync(log, "utf8").split("\n").filter(Boolean).length).toBe(1);
});
