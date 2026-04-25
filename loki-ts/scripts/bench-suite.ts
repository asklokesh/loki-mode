// Phase 2 benchmark suite -- runs hyperfine over every ported command and
// records results to .loki/metrics/migration_bench.jsonl.
//
// Used by:
//   - Phase 2 acceptance gate (must show Bun >= bash on every command)
//   - Phase 6 30-day soak (regression detection)
//
// Usage: bun run scripts/bench-suite.ts [--runs N] [--warmup K]
import { run } from "../src/util/shell.ts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SHIM = resolve(REPO_ROOT, "bin", "loki");

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["version", "version"],
  ["provider show", "provider show"],
  ["provider list", "provider list"],
  ["memory list", "memory list"],
  ["status", "status"],
  ["stats", "stats"],
  ["doctor", "doctor"],
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]!;
  return fallback;
}

async function benchOne(label: string, cmd: string, runs: string, warmup: string) {
  const r = await run(
    [
      "hyperfine",
      "--warmup",
      warmup,
      "--runs",
      runs,
      "--ignore-failure", // doctor exits 1 when system has any FAIL check; that's by design
      "--export-json",
      `/tmp/bench-${label.replace(/\s+/g, "_")}.json`,
      `${SHIM} ${cmd}`,
      `LOKI_LEGACY_BASH=1 ${SHIM} ${cmd}`,
    ],
  );
  if (r.exitCode !== 0) {
    process.stderr.write(`bench failed for "${label}": ${r.stderr}\n`);
    return null;
  }
  const path = `/tmp/bench-${label.replace(/\s+/g, "_")}.json`;
  if (!existsSync(path)) return null;
  const data = JSON.parse(await Bun.file(path).text()) as {
    results: Array<{ command: string; mean: number; stddev: number }>;
  };
  const [bun, bash] = data.results;
  if (!bun || !bash) return null;
  const speedup = bash.mean / bun.mean;
  return {
    command: label,
    bun_mean_ms: +(bun.mean * 1000).toFixed(2),
    bash_mean_ms: +(bash.mean * 1000).toFixed(2),
    speedup: +speedup.toFixed(2),
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const runs = arg("--runs", "20");
  const warmup = arg("--warmup", "3");
  const results: Array<NonNullable<Awaited<ReturnType<typeof benchOne>>>> = [];

  process.stdout.write(`Phase 2 benchmark suite (runs=${runs}, warmup=${warmup})\n\n`);
  for (const [label, cmd] of COMMANDS) {
    process.stdout.write(`> ${label}... `);
    const r = await benchOne(label, cmd, runs, warmup);
    if (r) {
      results.push(r);
      process.stdout.write(`${r.speedup}x  (bun=${r.bun_mean_ms}ms, bash=${r.bash_mean_ms}ms)\n`);
    } else {
      process.stdout.write(`SKIPPED\n`);
    }
  }

  if (results.length === 0) {
    process.stderr.write("\nNo results produced.\n");
    process.exit(1);
  }

  const geomean = Math.pow(
    results.reduce((acc, r) => acc * r.speedup, 1),
    1 / results.length,
  );
  process.stdout.write(`\nGeomean speedup: ${geomean.toFixed(2)}x across ${results.length} commands\n`);

  const metricsDir = resolve(REPO_ROOT, ".loki", "metrics");
  await mkdir(metricsDir, { recursive: true });
  const out = resolve(metricsDir, "migration_bench.jsonl");
  for (const r of results) {
    await appendFile(out, JSON.stringify(r) + "\n");
  }
  process.stdout.write(`Recorded to ${out}\n`);
}

main();
