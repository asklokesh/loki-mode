// MARK-2: per-change AI-BOM (CycloneDX 1.7 ML-BOM block). Pure over receipt plus config.
import { afterEach, describe, expect, test } from "bun:test";
import { buildAiBom, mcpServerNames, AI_BOM_SPEC_VERSION, writeAiBom, AI_BOM_FILE } from "../../src/contrib/ai_bom.ts";
import { hooks } from "../../src/engine10/hooks.ts";
import { sealStage } from "../../src/engine10/stages/seal.ts";
import type { EventType, RunContext, StageName } from "../../src/engine10/types.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "a".repeat(64);
const NOW = "2026-10-08T12:00:00.000Z";
const claudeReceipt = { run_id: "r-claude-1", provider: "claude", model: "claude-sonnet-5-5", receipt_sha256: SHA };
const codexReceipt = { run_id: "r-codex-1", provider: "codex", model: "gpt-5.3-codex", receipt_sha256: "b".repeat(64) };
const claudeBundle = { mcpServers: { "loki-mode": { command: "python3" }, "lsp-proxy": { command: "python3" } } };

describe("ai_bom", () => {
  test("claude fixture golden", () => {
    const bom = buildAiBom({ receipt: claudeReceipt, harnessVersion: "11.3.1", mcpServers: mcpServerNames(claudeBundle), tools: ["claude"], now: NOW });
    expect(bom).toEqual({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      serialNumber: "urn:uuid:ffe054fe-7ae0-4b6d-865c-3af9b61d5209",
      version: 1,
      metadata: {
        timestamp: NOW,
        tools: { components: [{ type: "application", name: "loki-mode", version: "11.3.1" }] },
        component: { type: "application", name: "run:r-claude-1", "bom-ref": "run:r-claude-1" },
        properties: [{ name: "loki:receipt_sha256", value: SHA }],
      },
      components: [
        { type: "machine-learning-model", "bom-ref": "model:claude:claude-sonnet-5-5", publisher: "claude", name: "claude-sonnet-5-5", version: "unknown" },
        { type: "application", "bom-ref": "tool:claude", name: "claude" },
        { type: "application", "bom-ref": "mcp:loki-mode", name: "loki-mode", properties: [{ name: "loki:kind", value: "mcp-server" }] },
        { type: "application", "bom-ref": "mcp:lsp-proxy", name: "lsp-proxy", properties: [{ name: "loki:kind", value: "mcp-server" }] },
      ],
    });
  });

  test("codex fixture golden has no mcp or tool components when none given", () => {
    const bom = buildAiBom({ receipt: codexReceipt, harnessVersion: "11.3.1", now: NOW });
    expect(bom.components).toEqual([
      { type: "machine-learning-model", "bom-ref": "model:codex:gpt-5.3-codex", publisher: "codex", name: "gpt-5.3-codex", version: "unknown" },
    ]);
    expect(bom.metadata.properties).toEqual([{ name: "loki:receipt_sha256", value: "b".repeat(64) }]);
  });

  test("model version is never invented; explicit version is used", () => {
    expect(buildAiBom({ receipt: claudeReceipt, harnessVersion: "1", now: NOW }).components[0]!.version).toBe("unknown");
    const v = buildAiBom({ receipt: claudeReceipt, harnessVersion: "1", modelVersion: "2026-09-01", now: NOW });
    expect(v.components[0]!.version).toBe("2026-09-01");
    const blank = buildAiBom({ receipt: { ...claudeReceipt, model: "" }, harnessVersion: "", now: NOW });
    expect(blank.components[0]!.name).toBe("unknown");
    expect(blank.metadata.tools.components[0]!.version).toBe("unknown");
  });

  test("required CycloneDX fields present", () => {
    const bom = buildAiBom({ receipt: claudeReceipt, harnessVersion: "1", now: NOW });
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe(AI_BOM_SPEC_VERSION);
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(typeof bom.metadata).toBe("object");
    expect(Array.isArray(bom.components)).toBe(true);
  });

  test("deterministic, and component refs are unique", () => {
    const i = { receipt: claudeReceipt, harnessVersion: "1", mcpServers: ["a", "a", "b"], tools: ["t", "t"], now: NOW };
    expect(JSON.stringify(buildAiBom(i))).toBe(JSON.stringify(buildAiBom(i)));
    const refs = buildAiBom(i).components.map((c) => c["bom-ref"]);
    expect(new Set(refs).size).toBe(refs.length);
  });

  test("mcpServerNames reads the bundle shape and tolerates junk", () => {
    expect(mcpServerNames(claudeBundle)).toEqual(["loki-mode", "lsp-proxy"]);
    expect(mcpServerNames(null)).toEqual([]);
    expect(mcpServerNames({ mcpServers: 5 })).toEqual([]);
    expect(mcpServerNames({})).toEqual([]);
  });

  test("no secrets: server config bodies never reach the BOM", () => {
    const bom = buildAiBom({ receipt: claudeReceipt, harnessVersion: "1", mcpServers: mcpServerNames({ mcpServers: { s: { env: { TOKEN: "SECRET_CANARY" } } } }), now: NOW });
    expect(JSON.stringify(bom)).not.toContain("SECRET_CANARY");
  });
});

const sh = (a: string[], cwd: string): string => spawnSync(a[0]!, a.slice(1), { cwd, encoding: "utf8" }).stdout;
const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });
function sealRun(model: string, perModel?: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
  const repo = mkdtempSync(join(tmpdir(), "loki-aibom."));
  tmp.push(repo);
  sh(["git", "init", "-q", "-b", "main"], repo);
  sh(["git", "config", "user.email", "t@t"], repo); sh(["git", "config", "user.name", "t"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n"); sh(["git", "add", "a.txt"], repo); sh(["git", "commit", "-q", "-m", "base"], repo);
  const base = sh(["git", "rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, "a.txt"), "two\n");
  mkdirSync(join(repo, ".loki/runs/r1"), { recursive: true });
  writeFileSync(join(repo, ".loki/runs/r1/events.jsonl"), "");
  const outputs: Partial<Record<StageName, Record<string, unknown>>> = {
    intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", resumed: false },
    wall: { files: [] }, implement: { exit: "done", tests_reverted: [], duration_s: 3, iteration_id: "e10-r1-impl" },
    verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 2 },
  };
  const ctx = {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: base, branch: "loki/r1", provider: "claude", model, deep: false, capS: 900,
    emit: (_t: EventType) => {}, sessions: { run: async () => { throw new Error("no"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, ...(perModel ? { records: { per_model: perModel } } : {}) }) },
    clock: { now: () => 0 }, outputs: () => outputs,
  } as unknown as RunContext;
  return sealStage.run(ctx, new AbortController().signal) as Promise<{ data: Record<string, unknown> }>;
}
const bomOf = (s: { data: Record<string, unknown> }) => JSON.parse(readFileSync(join(s.data.receipt_path as string, "..", AI_BOM_FILE), "utf8"));

describe("ai_bom hook after seal", () => {
  test("registered in contrib", () => { expect(typeof hooks.sealed).toBe("function"); });

  test("writes next to the receipt, listing only the recorded models and provider tool", async () => {
    const s = await sealRun("claude-sonnet-5-5", { "claude-opus-4-8": {}, "claude-haiku-4-5": {} });
    const bom = bomOf(s);
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.components.map((c: { name: string }) => c.name).sort()).toEqual(["claude", "claude-haiku-4-5", "claude-opus-4-8"]);
    expect(bom.metadata.properties[0].value).toBe(s.data.receipt_sha256);
  });

  test("no per-model record falls back to the receipt model only", async () => {
    const bom = bomOf(await sealRun("mx-1"));
    expect(bom.components.filter((c: { type: string }) => c.type === "machine-learning-model").map((c: { name: string }) => c.name)).toEqual(["mx-1"]);
  });

  test("nothing known to have run yields an empty components list", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-aibom.")); tmp.push(d);
    writeAiBom(d, { run_id: "r", provider: "", model: "", receipt_sha256: "c".repeat(64), cost: {} });
    expect(JSON.parse(readFileSync(join(d, AI_BOM_FILE), "utf8")).components).toEqual([]);
  });

  test("no home paths, env values or secret-looking names reach the BOM", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-aibom.")); tmp.push(d);
    writeAiBom(d, { run_id: "r", provider: "claude", model: "/Users/x/models/m", receipt_sha256: "c".repeat(64), cost: { per_model: { "sk-ant-abc123": {}, "TOKEN=CANARY_VALUE": {}, ok: {} } } });
    const txt = readFileSync(join(d, AI_BOM_FILE), "utf8");
    for (const bad of ["/Users", "sk-ant", "CANARY_VALUE"]) expect(txt).not.toContain(bad);
    expect(txt).toContain('"ok"');
  });

  test("a throwing writer leaves the seal and verdict unchanged", async () => {
    const saved = hooks.sealed;
    const a = await sealRun("m1");
    hooks.sealed = () => { throw new Error("boom"); };
    try {
      const b = await sealRun("m1");
      expect(b.data.verdict).toBe(a.data.verdict);
      expect(existsSync(join(b.data.receipt_path as string, "..", AI_BOM_FILE))).toBe(false);
    } finally { hooks.sealed = saved; }
  });

  test("Q18-05b: more credential prefixes and any case are dropped", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-aibom.")); tmp.push(d);
    const bad = ["github_pat_AAA", "glpat-AAA", "AIzaAAA", "npm_AAA", "hf_AAA", "ASIAAAA", "sk_live_AAA", "SK-ANT-AAA", "GHP_AAA", "openai/sk-AAA"];
    const per_model: Record<string, object> = { ok: {} }; for (const b of bad) per_model[b] = {};
    writeAiBom(d, { run_id: "r", provider: "claude", model: "m", receipt_sha256: "c".repeat(64), cost: { per_model } });
    const names = JSON.parse(readFileSync(join(d, AI_BOM_FILE), "utf8")).components.map((c: { name: string }) => c.name);
    expect(names).toEqual(["ok", "claude"]);
  });

  test("Q18-05b: one interior slash kept (provider/model), paths and double slashes dropped", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-aibom.")); tmp.push(d);
    writeAiBom(d, { run_id: "r", provider: "claude", model: "m", receipt_sha256: "c".repeat(64), cost: { per_model: { "openrouter/gpt-5": {}, "/abs/path": {}, "a/b/c": {}, "a/": {}, "../x": {} } } });
    const names = JSON.parse(readFileSync(join(d, AI_BOM_FILE), "utf8")).components.map((c: { name: string }) => c.name);
    expect(names).toEqual(["openrouter/gpt-5", "claude"]);
  });

  test("Q18-05b: sealed hook gets a frozen clone, not the live receipt", async () => {
    const saved = hooks.sealed; let seen: Record<string, unknown> | undefined; let threw = false;
    hooks.sealed = (_d, r) => { seen = r as unknown as Record<string, unknown>; try { "use strict"; (r as { verdict?: string }).verdict = "x"; (r as { run_id: string }).run_id = "tampered"; } catch { threw = true; } };
    try {
      const s = await sealRun("m1");
      expect(Object.isFrozen(seen)).toBe(true);
      expect(threw).toBe(true);
      expect(JSON.parse(readFileSync(s.data.receipt_path as string, "utf8")).run_id).not.toBe("tampered");
    } finally { hooks.sealed = saved; }
  });
});
