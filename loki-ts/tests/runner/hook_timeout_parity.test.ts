import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// P12-38: the host-guard hook timeout is the same on the TS runner and the bash runner.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hookTimeoutSeconds, hostGuardSettingsJson, HOOK_TIMEOUT_DEFAULT_S } from "../../src/runner/providers.ts";

const RUN_SH = resolve(import.meta.dir, "..", "..", "..", "autonomy", "run.sh");
const src = readFileSync(RUN_SH, "utf8");
const fn = src.match(/^_loki_hook_timeout\(\) \{[\s\S]*?^\}/m)?.[0] ?? "";

function bashTimeout(value: string | undefined): number {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  if (value !== undefined) env["LOKI_HOOK_TIMEOUT"] = value;
  const r = Bun.spawnSync({ cmd: ["bash", "-c", `${fn}\n_loki_hook_timeout`], env });
  return Number(new TextDecoder().decode(r.stdout).trim());
}

describe("hook timeout parity (TS vs bash)", () => {
  it("bash function was found", () => {
    expect(fn.length).toBeGreaterThan(20);
  });

  it("defaults agree", () => {
    expect(bashTimeout(undefined)).toBe(HOOK_TIMEOUT_DEFAULT_S);
    expect(hookTimeoutSeconds({})).toBe(HOOK_TIMEOUT_DEFAULT_S);
  });

  for (const v of ["5", "30", "120", "99999", "0", "-1", "abc", "", "1.5", "100000", "007"]) {
    it(`LOKI_HOOK_TIMEOUT=${JSON.stringify(v)} resolves identically`, () => {
      expect(hookTimeoutSeconds({ LOKI_HOOK_TIMEOUT: v })).toBe(bashTimeout(v));
    });
  }

  it("TS CLI settings carry the shared timeout", () => {
    process.env["LOKI_HOOK_TIMEOUT"] = "17";
    try {
      const s = JSON.parse(hostGuardSettingsJson()) as { hooks: { PreToolUse: Array<{ hooks: Array<{ timeout?: number }> }> } };
      expect(s.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(bashTimeout("17"));
    } finally {
      delete process.env["LOKI_HOOK_TIMEOUT"];
    }
  });

  it("bash settings generator emits the timeout field", () => {
    expect(src).toContain('"timeout": int(os.environ["_LOKI_HOOK_TIMEOUT"])');
  });
});
