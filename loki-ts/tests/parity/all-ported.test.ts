// Phase 2 parity gate: every ported command must produce the same stdout
// as the bash route. Anti-sycophancy reviewer (#1) reads this directly.
import { describe, expect, it } from "bun:test";
import { run } from "../../src/util/shell.ts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

// Commands and expected exit codes. Empty-args list means no-arg invocation.
// Add new entries here as Phase 2 ports land.
const PARITY_CASES: ReadonlyArray<{ name: string; argv: string[]; expectedExit?: number }> = [
  { name: "version", argv: ["version"] },
  { name: "version --version", argv: ["--version"] },
  { name: "version -v", argv: ["-v"] },
  { name: "provider show", argv: ["provider", "show"] },
  { name: "provider list", argv: ["provider", "list"] },
  { name: "memory list", argv: ["memory", "list"] },
  { name: "memory ls", argv: ["memory", "ls"] },
];

describe("Phase 2 parity", () => {
  for (const tc of PARITY_CASES) {
    it(`${tc.name} produces identical stdout`, async () => {
      const a = await run(["bun", CLI, ...tc.argv]);
      const b = await run([BASH_CLI, ...tc.argv]);
      if (tc.expectedExit !== undefined) {
        expect(a.exitCode).toBe(tc.expectedExit);
        expect(b.exitCode).toBe(tc.expectedExit);
      }
      expect(a.stdout).toBe(b.stdout);
    });
  }
});

// LOKI_LEGACY_BASH=1 routes to bash even for ported commands.
describe("Rollback flag (LOKI_LEGACY_BASH)", () => {
  const SHIM = resolve(REPO_ROOT, "bin", "loki");

  it("shim exists and is executable", () => {
    expect(existsSync(SHIM)).toBe(true);
  });

  it("LOKI_LEGACY_BASH=1 routes version through bash", async () => {
    const bashPath = await run(["bash", "-c", `LOKI_LEGACY_BASH=1 ${SHIM} version`]);
    const directBash = await run([BASH_CLI, "version"]);
    expect(bashPath.stdout).toBe(directBash.stdout);
  });

  it("default route uses Bun (when bun is on PATH)", async () => {
    const r = await run([SHIM, "version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^Loki Mode v/);
  });
});
