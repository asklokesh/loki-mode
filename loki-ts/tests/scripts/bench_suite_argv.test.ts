import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { benchPairArgv, benchRouteArgv, p95Ms, skipExitCode } from "../../scripts/bench-suite.ts";

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
  test("verify-fast route argv runs loki verify --fast", () => {
    const argv = benchRouteArgv("/x/loki", "ignored", "verify-fast", "1", "0", "/o.json");
    expect(argv[argv.length - 1]).toBe("/x/loki verify --fast");
    expect(runFake(argv, dir)).toBe(0);
  });
  test("p95 is nearest-rank numeric, not string-sorted", () => {
    expect(p95Ms([])).toBe(0);
    expect(p95Ms([0.01, 0.002, 0.1, 0.0005])).toBe(100);
    expect(p95Ms([0.5, 0.0000001])).toBe(500);
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) / 1000);
    expect(p95Ms(twenty)).toBe(19);
  });
  test("--verify-fast entry records p95_ms", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-fakehf2-"));
    const f = join(d, "hyperfine");
    writeFileSync(
      f,
      `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--export-json" ]; then out="$2"; fi
  shift
done
printf '{"results":[{"command":"x","mean":0.01,"stddev":0.001,"times":[0.002,0.01,0.1,0.003,0.004,0.005,0.006,0.007,0.008,0.009]}]}' > "$out"
`,
    );
    chmodSync(f, 0o755);
    const metrics = join(d, "m");
    const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "../../scripts/bench-suite.ts"), "--verify-fast", "--runs", "10", "--warmup", "0"], {
      env: { ...process.env, PATH: `${d}:${process.env.PATH}`, LOKI_BENCH_METRICS_DIR: metrics },
    });
    expect(r.exitCode).toBe(0);
    const jl = join(metrics, "migration_bench.jsonl");
    expect(existsSync(jl)).toBe(true);
    const rec = JSON.parse(readFileSync(jl, "utf8").trim().split("\n").pop()!);
    expect(rec.route).toBe("verify-fast");
    expect(rec.p95_ms).toBe(100);
  });
  test("partial skip exits non-zero", () => {
    expect(skipExitCode(6, 1)).toBe(1);
    expect(skipExitCode(0, 0)).toBe(1);
    expect(skipExitCode(7, 0)).toBe(0);
  });
});
