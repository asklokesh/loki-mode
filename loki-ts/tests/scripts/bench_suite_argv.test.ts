import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { benchPairArgv, benchRouteArgv, skipExitCode } from "../../scripts/bench-suite.ts";

function fakeHyperfineDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-fakehf-"));
  const f = join(dir, "hyperfine");
  writeFileSync(
    f,
    `#!/bin/sh
for a in "$@"; do
  if printf '%s' "$a" | LC_ALL=C grep -Eq '^[A-Z_]+='; then
    echo "Error: Cannot run $a" >&2
    exit 1
  fi
done
exit 0
`,
  );
  chmodSync(f, 0o755);
  return dir;
}

function runFake(argv: string[], dir: string): number {
  const r = Bun.spawnSync([join(dir, argv[0]!), ...argv.slice(1)], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  return r.exitCode ?? -1;
}

describe("bench-suite argv", () => {
  const dir = fakeHyperfineDir();
  test("pair argv accepted by hyperfine 1.20", () => {
    expect(runFake(benchPairArgv("/x/loki", "version", "1", "0", "/o.json"), dir)).toBe(0);
  });
  test("every route argv accepted by hyperfine 1.20", () => {
    for (const route of ["bash", "bun-source", "bun-dist"] as const) {
      expect(runFake(benchRouteArgv("/x/loki", "version", route, "1", "0", "/o.json"), dir)).toBe(0);
    }
  });
  test("fake rejects VAR= form (control)", () => {
    expect(runFake(["hyperfine", "LOKI_LEGACY_BASH=1 /x/loki version"], dir)).toBe(1);
  });
  test("partial skip exits non-zero", () => {
    expect(skipExitCode(6, 1)).toBe(1);
    expect(skipExitCode(0, 0)).toBe(1);
    expect(skipExitCode(7, 0)).toBe(0);
  });
});
