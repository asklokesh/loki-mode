// FC-DOCTOR-COUNT: the failure count must derive from the single list of check
// results, and a flaky `claude auth status` probe must not change it.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bump,
  evaluateClaudeLogin,
  makeTally,
  summarizeStatuses,
} from "../../src/commands/doctor.ts";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const root = mkdtempSync(join(tmpdir(), "doctor-count-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("single counting mechanism", () => {
  it("tally counts equal the recorded rows", () => {
    const t = makeTally();
    for (const s of ["pass", "fail", "warn", "fail", "pass", "pass"] as const) bump(t, s);
    expect([t.pass, t.fail, t.warn]).toEqual([3, 2, 1]);
    expect(summarizeStatuses(t.results)).toEqual({ passed: 3, failed: 2, warnings: 1, ok: false });
  });

  it("an inconclusive login probe is a warning, never a fail, regardless of clock", () => {
    expect(evaluateClaudeLogin("").status).toBe("warn");
    expect(evaluateClaudeLogin("").blocker).toBeNull();
    expect(evaluateClaudeLogin("yes").status).toBe("pass");
    expect(evaluateClaudeLogin("no").status).toBe("fail");
  });
});

// A claude shim whose `auth status` answer is driven by a mode, plus an
// EXPIRED credentials file: the exact combination that used to turn a flaky
// probe into a second FAIL line.
function runDoctor(mode: "yes" | "empty" | "flaky", json: boolean): string {
  const dir = mkdtempSync(join(root, "env-"));
  const cfg = join(dir, "cfg");
  const bin = join(dir, "bin");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: 1000 } }));
  const counter = join(dir, "n");
  const body =
    mode === "yes"
      ? `echo '{"loggedIn": true}'`
      : mode === "empty"
        ? `exit 0`
        : `if [ -f "${counter}" ]; then echo '{"loggedIn": true}'; else touch "${counter}"; fi`;
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/bash\nif [ "$1" = "auth" ]; then ${body}; exit 0; fi\necho "1.0.0"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const r = Bun.spawnSync(["bun", CLI, "doctor", ...(json ? ["--json"] : [])], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      CLAUDE_CONFIG_DIR: cfg,
      ANTHROPIC_API_KEY: "",
      LOKI_NO_BROWSER: "1",
    },
    timeout: 120000,
  });
  return strip(r.stdout.toString());
}

function textCounts(out: string) {
  const m = out.match(/Summary: (\d+) passed, (\d+) failed, (\d+) warnings/);
  expect(m).not.toBeNull();
  const failLines = out.split("\n").filter((l) => /^\s*FAIL\s/.test(l)).length;
  return { failed: Number(m![2]), failLines };
}

describe("doctor failure count is stable and consistent", () => {
  it("count equals FAIL lines and does not move when the login probe flakes", () => {
    const base = textCounts(runDoctor("yes", false));
    for (const mode of ["empty", "flaky"] as const) {
      const c = textCounts(runDoctor(mode, false));
      expect(c.failed).toBe(c.failLines);
      expect(c.failed).toBe(base.failed);
    }
  }, 300000);

  it("--json failed count agrees with the text summary", () => {
    const text = textCounts(runDoctor("empty", false));
    const j = JSON.parse(runDoctor("empty", true));
    expect(j.summary.failed).toBe(text.failed);
    expect(j.summary.ok).toBe(text.failed === 0);
  }, 300000);
});
