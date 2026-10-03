// CPE-15: GET /v1/providers. The probe timeout is honored and no secret value ever reaches the response.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const dir = mkdtempSync(join(tmpdir(), "cp-prov-"));
const savedPath = process.env.PATH;
const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, t: process.env.LOKI_PROVIDER_PROBE_TIMEOUT_MS };
afterAll(() => {
  process.env.PATH = savedPath;
  for (const [k, v] of [["ANTHROPIC_API_KEY", saved.a], ["OPENAI_API_KEY", saved.o], ["LOKI_PROVIDER_PROBE_TIMEOUT_MS", saved.t]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const bin = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
const mk = (token?: string) => createApp({ dbPath: ":memory:", answerDir: mkdtempSync(join(tmpdir(), "cp-prov-a-")), token });

test("slow binary: probe stops at the timeout and the request returns promptly", async () => {
  bin("codex", "sleep 20");
  bin("claude", "echo 'claude 2.1.7 (Claude Code)'");
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  process.env.LOKI_PROVIDER_PROBE_TIMEOUT_MS = "300";
  const { app } = mk();
  const t0 = Date.now();
  const j = (await (await app.request("/v1/providers")).json()) as any;
  expect(Date.now() - t0).toBeLessThan(5000);
  const by = (id: string) => j.providers.find((p: any) => p.id === id);
  expect(by("codex")).toMatchObject({ installed: true, version: null, probe: "timeout" });
  expect(by("claude")).toMatchObject({ installed: true, version: "2.1.7", probe: "ok" });
  expect(by("aider")).toMatchObject({ installed: false, probe: "not_found" });
  expect(by("gemini").deprecated).toBe(true);
  expect(j.providers.map((p: any) => p.id)).toEqual(["claude", "codex", "cline", "aider", "opencode", "gemini"]);
  expect(by("claude").tiers.planning).toBeTruthy();
});

test("no secret value appears in the response, only env var names", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-SECRETVALUE-12345";
  process.env.OPENAI_API_KEY = "sk-openai-TOPSECRET-67890";
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  process.env.LOKI_PROVIDER_PROBE_TIMEOUT_MS = "300";
  const { app } = mk();
  const text = await (await app.request("/v1/providers")).text();
  expect(text).not.toContain("SECRETVALUE");
  expect(text).not.toContain("TOPSECRET");
  const j = JSON.parse(text);
  const claude = j.providers.find((p: any) => p.id === "claude");
  expect(claude.auth_present).toBe(true);
  expect(claude.auth_env_set).toContain("ANTHROPIC_API_KEY");
});

test("token guard: 401 without the bearer token", async () => {
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  process.env.LOKI_PROVIDER_PROBE_TIMEOUT_MS = "300";
  const { app } = mk("tok123");
  expect((await app.request("/v1/providers")).status).toBe(401);
  expect((await app.request("/v1/providers", { headers: { authorization: "Bearer tok123" } })).status).toBe(200);
});
