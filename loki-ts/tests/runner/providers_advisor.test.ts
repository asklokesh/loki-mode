// R1-07 (docs/v11/ROUTER-1.md 4.4, 4.5): advisorModel and autoCompactWindow wiring under LOKI_ROUTER=1.
// In SDK 0.3.293 both are fields of `interface Settings` (sdk.d.ts), reached through Options.settings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSdkLoopOptions, claudeProvider, SDK_BUNDLED_CLAUDE_CODE } from "../../src/runner/providers.ts";

const KEYS = [
  "LOKI_ROUTER", "LOKI_ROUTER_ADVISOR", "LOKI_E10_STAGE", "LOKI_ALLOW_HAIKU", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "LOKI_CLAUDE_CLI",
  "LOKI_SESSION_STAMP", "LOKI_DIR",
];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "loki-r1-07-"));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const base = () => ({ tier: "development", model: "haiku", cwd: dir, runDir: dir, claudeCodeVersion: "2.1.293" });

describe("bundled version constant", () => {
  test("SDK_BUNDLED_CLAUDE_CODE equals the installed SDK's claudeCodeVersion", () => {
    const manifest = join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    const v = (JSON.parse(readFileSync(manifest, "utf8")) as { claudeCodeVersion: string }).claudeCodeVersion;
    expect(SDK_BUNDLED_CLAUDE_CODE).toBe(v);
  });
});

describe("buildSdkLoopOptions under the router", () => {
  test("LOKI_ROUTER=1 carries settings.advisorModel=opus and autoCompactWindow=100000", () => {
    process.env["LOKI_ROUTER"] = "1";
    const o = buildSdkLoopOptions(base());
    expect(o.settings).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
    expect(o.model).toBe("haiku");
  });

  test("compact ceiling is keyed on the executor: haiku and unknown get it, sonnet and opus do not", () => {
    process.env["LOKI_ROUTER"] = "1";
    const w = (model: string) => buildSdkLoopOptions({ ...base(), model }).settings;
    expect(w("haiku")).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
    expect(w("claude-haiku-5-5")).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
    expect(w("sonnet")).toEqual({ advisorModel: "opus" });
    expect(w("claude-sonnet-5-5")).toEqual({ advisorModel: "opus" });
    expect(w("opus")).toEqual({ advisorModel: "opus" });
    expect(w("claude-opus-5-5")).toEqual({ advisorModel: "opus" });
    expect(w("some-unknown-model")).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
  });

  test("advisor unavailable: both absent and the routed model is sonnet, never haiku", () => {
    process.env["LOKI_ROUTER"] = "1";
    process.env["LOKI_ROUTER_ADVISOR"] = "off";
    const o = buildSdkLoopOptions(base());
    expect(o.settings).toBeUndefined();
    expect(o.model).toBe("sonnet");
  });

  test("advisor unavailable on an old Claude Code, a cloud flag or a foreign base url", () => {
    process.env["LOKI_ROUTER"] = "1";
    expect(buildSdkLoopOptions({ ...base(), claudeCodeVersion: "2.1.292" }).settings).toBeUndefined();
    process.env["CLAUDE_CODE_USE_BEDROCK"] = "1";
    expect(buildSdkLoopOptions(base()).model).toBe("sonnet");
    delete process.env["CLAUDE_CODE_USE_BEDROCK"];
    process.env["ANTHROPIC_BASE_URL"] = "https://proxy.example.com";
    expect(buildSdkLoopOptions(base()).settings).toBeUndefined();
  });

  test("a sticky advisor error marker in the run dir makes it unavailable", () => {
    process.env["LOKI_ROUTER"] = "1";
    writeFileSync(join(dir, "advisor-error.txt"), "advisor tool error\n");
    const o = buildSdkLoopOptions(base());
    expect(o.settings).toBeUndefined();
    expect(o.model).toBe("sonnet");
  });

  test("a haiku primary gets a sonnet fallbackModel under the router", () => {
    process.env["LOKI_ROUTER"] = "1";
    expect(buildSdkLoopOptions(base()).fallbackModel).toBe("sonnet");
  });

  test("any haiku model id (claude-haiku-5-5) is raised to sonnet when the advisor is unavailable", () => {
    process.env["LOKI_ROUTER"] = "1";
    process.env["LOKI_ROUTER_ADVISOR"] = "off";
    const o = buildSdkLoopOptions({ ...base(), model: "claude-haiku-5-5" });
    expect(o.model).toBe("sonnet");
    expect(o.settings).toBeUndefined();
    delete process.env["LOKI_ROUTER_ADVISOR"];
    const on = buildSdkLoopOptions({ ...base(), model: "claude-haiku-5-5" });
    expect(on.model).toBe("claude-haiku-5-5");
    expect(on.fallbackModel).toBe("sonnet");
  });

  test("a sonnet or opus model is never rewritten", () => {
    process.env["LOKI_ROUTER"] = "1";
    process.env["LOKI_ROUTER_ADVISOR"] = "off";
    expect(buildSdkLoopOptions({ ...base(), model: "sonnet" }).model).toBe("sonnet");
    expect(buildSdkLoopOptions({ ...base(), model: "opus" }).model).toBe("opus");
  });

  test("flag off or unset: byte-identical to the pre-router options", () => {
    const off = JSON.stringify(buildSdkLoopOptions(base()));
    process.env["LOKI_ROUTER"] = "0";
    expect(JSON.stringify(buildSdkLoopOptions(base()))).toBe(off);
    const o = buildSdkLoopOptions(base());
    expect("settings" in o).toBe(false);
    expect("model" in o).toBe(false);
    expect(o.fallbackModel).toBeUndefined();
  });

  test("the engine10 six-tool whitelist is untouched by the router", () => {
    process.env["LOKI_E10_STAGE"] = "implement";
    const off = buildSdkLoopOptions(base()).tools;
    process.env["LOKI_ROUTER"] = "1";
    expect(buildSdkLoopOptions(base()).tools).toEqual(off);
  });
});

describe("CLI argv", () => {
  function stubCli(): { cli: string; log: string } {
    const log = join(dir, "argv.log");
    const cli = join(dir, "claude-stub.sh");
    writeFileSync(
      cli,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.293 (Claude Code)"; exit 0; fi\nif [ "$1" = "--help" ]; then echo "--settings --model"; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n`,
    );
    chmodSync(cli, 0o755);
    return { cli, log };
  }
  const call = () => ({
    tier: "development" as const,
    prompt: "hi",
    cwd: dir,
    iterationOutputPath: join(dir, "out.txt"),
    mainLoop: false,
  });

  test("LOKI_ROUTER=1 puts advisorModel (no compact ceiling, sonnet executor) in a --settings JSON", async () => {
    const { cli, log } = stubCli();
    process.env["LOKI_CLAUDE_CLI"] = cli;
    process.env["LOKI_ROUTER"] = "1";
    process.env["LOKI_DIR"] = dir;
    await claudeProvider().invoke(call() as never);
    const argv = readFileSync(log, "utf8").split("\n");
    const i = argv.indexOf("--settings");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(argv[i + 1] as string)).toEqual({ advisorModel: "opus" });
  });

  test("advisor unavailable or flag off: no advisor in argv", async () => {
    const { cli, log } = stubCli();
    process.env["LOKI_CLAUDE_CLI"] = cli;
    process.env["LOKI_DIR"] = dir;
    await claudeProvider().invoke(call() as never);
    expect(readFileSync(log, "utf8")).not.toContain("advisorModel");
    rmSync(log);
    process.env["LOKI_ROUTER"] = "1";
    process.env["LOKI_ROUTER_ADVISOR"] = "off";
    await claudeProvider().invoke(call() as never);
    expect(readFileSync(log, "utf8")).not.toContain("advisorModel");
  });
});
