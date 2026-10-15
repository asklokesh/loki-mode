// LM-001: the shared setup requirements table (autonomy/lib/setup-requirements.json).
// Asserts evaluation per path, the missing-optional-dependency case, wording shared
// with runtime errors, and that docs/contracts/setup.md embeds the generated table.
// Regenerate the doc block with: UPDATE_CONTRACT=1 bun test tests/util/requirements.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateRequirements, firstTaskReady, loadRequirements, renderContractTable, requirementError,
  requirementFix, requirementMin, sdkBinaryPresent, type EvalDeps,
} from "../../src/util/requirements.ts";
import { REPO_ROOT } from "../../src/util/paths.ts";

const ALL_CMDS = ["node", "python3", "jq", "git", "curl", "bash", "bun", "claude", "codex", "cline", "aider", "opencode"];
function deps(over: Partial<EvalDeps> & { cmds?: string[] } = {}): EvalDeps {
  const cmds = over.cmds ?? ALL_CMDS;
  return {
    env: over.env ?? {},
    commandPath: async (c) => (cmds.includes(c) ? `/usr/bin/${c}` : null),
    version: async () => "99.0.0",
    sdkBinary: over.sdkBinary ?? (() => false),
  };
}
const pathOf = (rep: Awaited<ReturnType<typeof evaluateRequirements>>, id: string) => rep.paths.find((p) => p.id === id)!;

describe("requirements table", () => {
  test("every requirement has a known path, a fix, and a label", () => {
    const t = loadRequirements();
    const ids = new Set(t.paths.map((p) => p.id));
    const seen = new Set<string>();
    for (const r of t.requirements) {
      expect(ids.has(r.path)).toBe(true);
      expect(r.fix.length).toBeGreaterThan(0);
      expect(r.label.length).toBeGreaterThan(0);
      expect(seen.has(r.id)).toBe(false);
      seen.add(r.id);
    }
  });

  test("node minimum matches package.json engines", () => {
    const eng = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).engines.node as string;
    expect(eng).toBe(`>=${requirementMin("node")!.split(".")[0]}.0.0`);
  });

  test("claude path needs the CLI; api-key path needs mode, credentials, SDK binary and bun", async () => {
    const none = await evaluateRequirements(deps({ cmds: ["node", "python3", "jq", "git", "curl"] }));
    expect(pathOf(none, "claude-cli").ready).toBe(false);
    expect(pathOf(none, "api-key-sdk").ready).toBe(false);
    expect(firstTaskReady(none)).toBe(false);

    const cli = await evaluateRequirements(deps());
    expect(pathOf(cli, "claude-cli").ready).toBe(true);
    expect(firstTaskReady(cli)).toBe(true);

    const noCliButSdk = await evaluateRequirements(
      deps({ cmds: ["node", "python3", "jq", "git", "curl", "bun"], env: { LOKI_SDK_LOOP: "1", ANTHROPIC_API_KEY: "k" }, sdkBinary: () => true }),
    );
    expect(pathOf(noCliButSdk, "claude-cli").ready).toBe(false);
    expect(pathOf(noCliButSdk, "api-key-sdk").ready).toBe(true);
    expect(firstTaskReady(noCliButSdk)).toBe(true);
  });

  test("missing optional SDK leaves the claude path ready and the api-key path not ready", async () => {
    const rep = await evaluateRequirements(deps({ env: { LOKI_SDK_LOOP: "1", ANTHROPIC_API_KEY: "k" }, sdkBinary: () => false }));
    expect(pathOf(rep, "claude-cli").ready).toBe(true);
    const sdk = pathOf(rep, "api-key-sdk");
    expect(sdk.ready).toBe(false);
    expect(sdk.items.find((i) => i.id === "sdk-binary")!.status).toBe("missing");
  });

  test("missing bun is optional for common but blocks the api-key path", async () => {
    const cmds = ALL_CMDS.filter((c) => c !== "bun");
    const rep = await evaluateRequirements(deps({ cmds, env: { LOKI_SDK_LOOP: "1", ANTHROPIC_API_KEY: "k" }, sdkBinary: () => true }));
    expect(pathOf(rep, "common").ready).toBe(true);
    expect(pathOf(rep, "api-key-sdk").ready).toBe(false);
  });

  test("an old node fails the common path", async () => {
    const rep = await evaluateRequirements({ ...deps(), version: async (c) => (c === "node" ? "18.19.0" : "99.0.0") });
    expect(pathOf(rep, "common").ready).toBe(false);
    expect(pathOf(rep, "common").items.find((i) => i.id === "node")!.detail).toContain("older than 20.0");
  });

  test("any one other provider makes that path ready", async () => {
    const rep = await evaluateRequirements(deps({ cmds: ["codex"] }));
    expect(pathOf(rep, "other-providers").ready).toBe(true);
    const none = await evaluateRequirements(deps({ cmds: [] }));
    expect(pathOf(none, "other-providers").ready).toBe(false);
  });

  test("runtime wording shares the table fix text", () => {
    expect(requirementFix("claude")).toBe("npm install -g @anthropic-ai/claude-code");
    expect(requirementError("claude")).toContain(`Fix: ${requirementFix("claude")}`);
    expect(requirementFix("nonesuch")).toBeNull();
  });

  test("sdkBinaryPresent finds an executable platform binary and ignores a non-executable one", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-run.req-"));
    try {
      const d = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-test-x64");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "claude"), "#!/bin/sh\n");
      chmodSync(join(d, "claude"), 0o644);
      expect(sdkBinaryPresent({ LOKI_SDK_NODE_MODULES: join(dir, "node_modules") })).toBe(false);
      chmodSync(join(d, "claude"), 0o755);
      expect(sdkBinaryPresent({ LOKI_SDK_NODE_MODULES: join(dir, "node_modules") })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docs/contracts/setup.md", () => {
  const file = join(REPO_ROOT, "docs", "contracts", "setup.md");
  const BEGIN = "<!-- BEGIN GENERATED REQUIREMENTS (loki-ts/tests/util/requirements.test.ts) -->";
  const END = "<!-- END GENERATED REQUIREMENTS -->";

  test("embeds the table generated from the shared source", () => {
    const want = renderContractTable();
    let doc = readFileSync(file, "utf8");
    if (process.env["UPDATE_CONTRACT"] === "1") {
      const a = doc.indexOf(BEGIN), b = doc.indexOf(END);
      doc = `${doc.slice(0, a + BEGIN.length)}\n\n${want}\n${doc.slice(b)}`;
      writeFileSync(file, doc);
    }
    const a = doc.indexOf(BEGIN), b = doc.indexOf(END);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(doc.slice(a + BEGIN.length, b).trim()).toBe(want.trim());
  });
});
