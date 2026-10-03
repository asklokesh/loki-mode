// Control Plane auth: bearer token on /v1, loopback Host check, refuse non-loopback bind without a token.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { bindRefusal, isLoopbackHost, tokenMatches } from "../../src/server/auth.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const TOKEN = "s3cret-token-value";
const secured = () => createApp({ dbPath: ":memory:", answerDir: mkdtempSync(join(tmpdir(), "cp-auth-")), token: TOKEN }).app;
const evs = () => readFileSync(join(FIX, "blocked", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test("with a token: no header 401, wrong token 401, right token 200 on GET /v1/runs", async () => {
  const app = secured();
  expect((await app.request("/v1/runs")).status).toBe(401);
  expect((await app.request("/v1/runs", { headers: bearer("wrong") })).status).toBe(401);
  expect((await app.request("/v1/runs", { headers: bearer(TOKEN + "x") })).status).toBe(401);
  expect((await app.request("/v1/runs", { headers: { authorization: TOKEN } })).status).toBe(401);
  expect((await app.request("/v1/runs", { headers: bearer(TOKEN) })).status).toBe(200);
});

test("with a token: POST /v1/ingest and POST .../answer are gated too", async () => {
  const app = secured();
  const e = evs();
  const body = JSON.stringify({ source: SRC, run_id: e[0].run, events: e });
  expect((await app.request("/v1/ingest", { method: "POST", body })).status).toBe(401);
  expect((await app.request("/v1/ingest", { method: "POST", body, headers: bearer("nope") })).status).toBe(401);
  expect((await app.request("/v1/ingest", { method: "POST", body, headers: bearer(TOKEN) })).status).toBe(200);
  const ans = (h: Record<string, string>) => app.request(`/v1/runs/${SRC}/${e[0].run}/answer`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ answer: "go" }) });
  expect((await ans({})).status).toBe(401);
  expect((await ans(bearer("nope"))).status).toBe(401);
  expect((await ans(bearer(TOKEN))).status).toBe(200);
  expect((await app.request("/v1/nope")).status).toBe(401);
});

test("/health and /ready stay open with a token", async () => {
  const app = secured();
  expect((await app.request("/health")).status).toBe(200);
  expect((await app.request("/ready")).status).toBe(200);
});

test("no token: behaviour unchanged, /v1 is open", async () => {
  const { app } = createApp({ dbPath: ":memory:" });
  expect((await app.request("/v1/runs")).status).toBe(200);
});

test("loopback: a Host that is not a loopback name gets 403, loopback names pass", async () => {
  const { app } = createApp({ dbPath: ":memory:", loopbackOnly: true });
  expect((await app.request("/v1/runs", { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await app.request("/health", { headers: { host: "evil.example:80" } })).status).toBe(403);
  for (const h of ["127.0.0.1", "127.0.0.1:57400", "localhost", "localhost:3000", "[::1]", "[::1]:8080"]) {
    expect((await app.request("/v1/runs", { headers: { host: h } })).status).toBe(200);
  }
});

test("without loopbackOnly the Host header is not checked", async () => {
  const { app } = createApp({ dbPath: ":memory:" });
  expect((await app.request("/v1/runs", { headers: { host: "control.corp.example" } })).status).toBe(200);
});

test("helpers: loopback names, length-safe token compare, bind refusal", () => {
  expect(isLoopbackHost("localhost:1")).toBe(true);
  expect(isLoopbackHost("evil.localhost.example")).toBe(false);
  expect(isLoopbackHost(undefined)).toBe(false);
  expect(tokenMatches("Bearer abc", "abc")).toBe(true);
  expect(tokenMatches("Bearer abcd", "abc")).toBe(false);
  expect(tokenMatches("Bearer ", "abc")).toBe(false);
  expect(tokenMatches(undefined, "abc")).toBe(false);
  expect(bindRefusal({})).toBeNull();
  expect(bindRefusal({ LOKI_CONTROL_HOST: "127.0.0.1" })).toBeNull();
  expect(bindRefusal({ LOKI_CONTROL_HOST: "localhost" })).toBeNull();
  expect(bindRefusal({ LOKI_CONTROL_HOST: "::1" })).toBeNull();
  expect(bindRefusal({ LOKI_CONTROL_HOST: "0.0.0.0" })).toContain("LOKI_CONTROL_TOKEN");
  expect(bindRefusal({ LOKI_CONTROL_HOST: "0.0.0.0", LOKI_CONTROL_TOKEN: "t" })).toBeNull();
  expect(bindRefusal({ LOKI_CONTROL_HOST: "0.0.0.0", LOKI_CONTROL_ALLOW_INSECURE_BIND: "1" })).toBeNull();
});

test("serve.ts: non-loopback host without a token exits 2 without binding", () => {
  const home = mkdtempSync(join(tmpdir(), "cp-auth-home-"));
  const env = { PATH: process.env.PATH ?? "", HOME: home, PORT: "0", LOKI_CONTROL_HOST: "0.0.0.0", LOKI_CONTROL_DB: ":memory:", LOKI_NO_BROWSER: "1" };
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/server/serve.ts")], { env, stdout: "pipe", stderr: "pipe" });
  rmSync(home, { recursive: true, force: true });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("LOKI_CONTROL_TOKEN");
  expect(r.stdout.toString()).not.toContain("listening");
});

test("percent-encoded /v1 paths cannot skip the token (route is matched on the decoded path)", async () => {
  const app = secured();
  const e = evs();
  const body = JSON.stringify({ source: SRC, run_id: e[0].run, events: e });
  for (const p of ["/%761/runs", "/v%31/runs", "/%76%31/runs", "/v1%2Fruns"]) {
    const r = await app.request(p);
    expect(r.status === 401 || r.status === 404).toBe(true);
  }
  const post = await app.request("/%761/ingest", { method: "POST", body });
  expect(post.status).toBe(401);
  expect((await app.request("/%761/runs", { headers: bearer(TOKEN) })).status).toBe(200);
  expect((await app.request("/v1/runs", { method: "HEAD" })).status).toBe(401);
  expect((await app.request("/v1/runs", { method: "OPTIONS" })).status).toBe(401);
});

test("bearer scheme is case-insensitive", () => {
  expect(tokenMatches("bearer abc", "abc")).toBe(true);
  expect(tokenMatches("BEARER abc", "abc")).toBe(true);
});

test("isLoopbackHost is strict: trailing junk and userinfo tricks are rejected", () => {
  for (const h of ["[::1]evil", "localhost:80@evil", "localhost@evil", "127.0.0.1.evil.com", "localhost:", "localhost:80x"]) expect(isLoopbackHost(h)).toBe(false);
  for (const h of ["LOCALHOST", "127.0.0.1:1", "[::1]:9"]) expect(isLoopbackHost(h)).toBe(true);
});

test("insecureBindWarning: only when the override is what permits a non-loopback bind with no token", async () => {
  const { insecureBindWarning } = await import("../../src/server/auth.ts");
  expect(insecureBindWarning({ LOKI_CONTROL_HOST: "0.0.0.0", LOKI_CONTROL_ALLOW_INSECURE_BIND: "1" })).toContain("0.0.0.0");
  expect(insecureBindWarning({ LOKI_CONTROL_HOST: "0.0.0.0", LOKI_CONTROL_ALLOW_INSECURE_BIND: "1", LOKI_CONTROL_TOKEN: "tok-secret" })).toBeNull();
  expect(insecureBindWarning({ LOKI_CONTROL_HOST: "127.0.0.1", LOKI_CONTROL_ALLOW_INSECURE_BIND: "1" })).toBeNull();
  expect(insecureBindWarning({ LOKI_CONTROL_HOST: "0.0.0.0" })).toBeNull();
});
