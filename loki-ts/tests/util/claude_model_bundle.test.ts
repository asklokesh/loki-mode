import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const catalog = JSON.parse(readFileSync(join(ROOT, "providers/model_catalog.json"), "utf8"));

test("bundled at dist depth, haiku still resolves to the full catalog id", async () => {
  const out = join(ROOT, "loki-ts", `.bundle-probe-${process.pid}`);
  mkdirSync(out, { recursive: true });
  try {
    const r = await Bun.build({ entrypoints: [join(ROOT, "loki-ts/src/util/claude_model.ts")], outdir: out, target: "bun" });
    expect(r.success).toBe(true);
    const mod = await import(join(out, "claude_model.js"));
    expect(mod.resolveClaudeModel("haiku")).toBe(catalog.providers.claude.cli_aliases.haiku);
    expect(mod.resolveClaudeModel("haiku")).toMatch(/^claude-/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("LOKI_MODEL_CATALOG override is honoured", async () => {
  const { resolveClaudeModel } = await import("../../src/util/claude_model.ts");
  const dir = mkdtempSync(join(tmpdir(), "loki-run.cat-"));
  try {
    await Bun.write(join(dir, "c.json"), JSON.stringify({ providers: { claude: { cli_aliases: { haiku: "claude-test-x" } } } }));
    process.env["LOKI_MODEL_CATALOG"] = join(dir, "c.json");
    expect(resolveClaudeModel("haiku")).toBe("claude-test-x");
  } finally {
    delete process.env["LOKI_MODEL_CATALOG"];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sdk-judge and sdk-text exit non-zero on an unresolved alias without calling the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-run.cat-"));
  try {
    await Bun.write(join(dir, "empty.json"), "{}");
    await Bun.write(join(dir, "p.txt"), "hi");
    await Bun.write(join(dir, "s.json"), "{}");
    const run = (sub: string, extra: string[]) =>
      Bun.spawnSync(["bun", join(ROOT, "loki-ts/src/cli.ts"), "internal", sub, "--prompt-file", join(dir, "p.txt"), ...extra, "--model", "haiku"], {
        env: { ...process.env, LOKI_MODEL_CATALOG: join(dir, "empty.json"), ANTHROPIC_API_KEY: "", LOKI_NO_BROWSER: "1" },
      });
    expect(run("sdk-judge", ["--schema-file", join(dir, "s.json")]).exitCode).toBe(2);
    expect(run("sdk-text", []).exitCode).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
