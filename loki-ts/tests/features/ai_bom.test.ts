// MARK-2: per-change AI-BOM (CycloneDX 1.7 ML-BOM block). Pure over receipt plus config.
import { describe, expect, test } from "bun:test";
import { buildAiBom, mcpServerNames, AI_BOM_SPEC_VERSION } from "../../src/contrib/ai_bom.ts";

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
