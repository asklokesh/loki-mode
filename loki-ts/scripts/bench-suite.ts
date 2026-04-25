// Phase 2 benchmark suite -- runs hyperfine over every ported command and
// records results to .loki/metrics/migration_bench.jsonl.
//
// Used by:
//   - Phase 2 acceptance gate (must show Bun >= bash on every command)
//   - Phase 3 cold-start regression check (--compare-dist)
//   - Phase 6 30-day soak (regression detection)
//
// Usage:
//   bun run scripts/bench-suite.ts [--runs N] [--warmup K]
//   bun run scripts/bench-suite.ts --compare-dist [--runs N] [--warmup K]
import { run } from "../src/util/shell.ts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SHIM = resolve(REPO_ROOT, "bin", "loki");
const DIST_ENTRY = resolve(REPO_ROOT, "loki-ts", "dist", "loki.js");

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["version", "version"],
  ["provider show", "provider show"],
  ["provider list", "provider list"],
  ["memory list", "memory list"],
  ["status", "status"],
  ["stats", "stats"],
  ["doctor", "doctor"],
];

type Route = "bash" | "bun-source" | "bun-dist";

interface BenchRecord {
  command: string;
  route: Route;
  mean_ms: number;
  stddev_ms: number;
  timestamp: string;
}

interface PairedResult {
  command: string;
  bun_mean_ms: number;
  bash_mean_ms: number;
  speedup: number;
  timestamp: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]!;
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function benchPair(
  label: string,
  cmd: string,
  runs: string,
  warmup: string,
): Promise<PairedResult | null> {
  const outPath = `/tmp/bench-${label.replace(/\s+/g, "_")}.json`;
  const r = await run([
    "hyperfine",
    "--warmup",
    warmup,
    "--runs",
    runs,
    "--ignore-failure",
    "--export-json",
    outPath,
    `${SHIM} ${cmd}`,
    `LOKI_LEGACY_BASH=1 ${SHIM} ${cmd}`,
  ]);
  if (r.exitCode !== 0) {
    process.stderr.write(`bench failed for "${label}": ${r.stderr}\n`);
    return null;
  }
  if (!existsSync(outPath)) return null;
  const data = JSON.parse(await Bun.file(outPath).text()) as {
    results: Array<{ command: string; mean: number; stddev: number }>;
  };
  const [bun, bash] = data.results;
  if (!bun || !bash) return null;
  return {
    command: label,
    bun_mean_ms: +(bun.mean * 1000).toFixed(2),
    bash_mean_ms: +(bash.mean * 1000).toFixed(2),
    speedup: +(bash.mean / bun.mean).toFixed(2),
    timestamp: new Date().toISOString(),
  };
}

async function benchRoute(
  label: string,
  cmd: string,
  route: Route,
  runs: string,
  warmup: string,
): Promise<BenchRecord | null> {
  const outPath = `/tmp/bench-${route}-${label.replace(/\s+/g, "_")}.json`;
  let invocation: string;
  switch (route) {
    case "bash":
      invocation = `LOKI_LEGACY_BASH=1 ${SHIM} ${cmd}`;
      break;
    case "bun-source":
      invocation = `BUN_FROM_SOURCE=1 ${SHIM} ${cmd}`;
      break;
    case "bun-dist":
      invocation = `${SHIM} ${cmd}`;
      break;
  }
  const r = await run([
    "hyperfine",
    "--warmup",
    warmup,
    "--runs",
    runs,
    "--ignore-failure",
    "--export-json",
    outPath,
    invocation,
  ]);
  if (r.exitCode !== 0) {
    process.stderr.write(`bench failed for "${label}" route=${route}: ${r.stderr}\n`);
    return null;
  }
  if (!existsSync(outPath)) return null;
  const data = JSON.parse(await Bun.file(outPath).text()) as {
    results: Array<{ command: string; mean: number; stddev: number }>;
  };
  const res = data.results[0];
  if (!res) return null;
  return {
    command: label,
    route,
    mean_ms: +(res.mean * 1000).toFixed(2),
    stddev_ms: +(res.stddev * 1000).toFixed(2),
    timestamp: new Date().toISOString(),
  };
}

async function writeJsonl(records: ReadonlyArray<object>): Promise<string> {
  const metricsDir = resolve(REPO_ROOT, ".loki", "metrics");
  await mkdir(metricsDir, { recursive: true });
  const out = resolve(metricsDir, "migration_bench.jsonl");
  for (const r of records) {
    await appendFile(out, JSON.stringify(r) + "\n");
  }
  return out;
}

async function runDefault(runs: string, warmup: string): Promise<void> {
  const results: PairedResult[] = [];
  process.stdout.write(`Phase 2 benchmark suite (runs=${runs}, warmup=${warmup})\n\n`);
  for (const [label, cmd] of COMMANDS) {
    process.stdout.write(`> ${label}... `);
    const r = await benchPair(label, cmd, runs, warmup);
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

  const out = await writeJsonl(results);
  process.stdout.write(`Recorded to ${out}\n`);
}

async function runCompareDist(runs: string, warmup: string): Promise<void> {
  const distAvailable = existsSync(DIST_ENTRY);
  const routes: Route[] = distAvailable
    ? ["bash", "bun-source", "bun-dist"]
    : ["bash", "bun-source"];

  process.stdout.write(
    `Phase 3 dist comparison (runs=${runs}, warmup=${warmup})\n` +
      `Routes: ${routes.join(", ")}\n`,
  );
  if (!distAvailable) {
    process.stdout.write(
      `WARN: ${DIST_ENTRY} not found -- skipping bun-dist route. ` +
        `Run \`cd loki-ts && bun run build\` to enable.\n`,
    );
  }
  process.stdout.write("\n");

  const records: BenchRecord[] = [];
  // command -> route -> mean_ms
  const matrix = new Map<string, Map<Route, number>>();

  for (const [label, cmd] of COMMANDS) {
    process.stdout.write(`> ${label}\n`);
    const perCmd = new Map<Route, number>();
    for (const route of routes) {
      process.stdout.write(`    ${route}... `);
      const r = await benchRoute(label, cmd, route, runs, warmup);
      if (r) {
        records.push(r);
        perCmd.set(route, r.mean_ms);
        process.stdout.write(`${r.mean_ms}ms (+/-${r.stddev_ms}ms)\n`);
      } else {
        process.stdout.write("SKIPPED\n");
      }
    }
    matrix.set(label, perCmd);
  }

  if (records.length === 0) {
    process.stderr.write("\nNo results produced.\n");
    process.exit(1);
  }

  // Summary table
  process.stdout.write("\n=== Summary (mean ms per route) ===\n");
  const header =
    "command".padEnd(20) +
    "bash".padStart(10) +
    "bun-source".padStart(14) +
    "bun-dist".padStart(12) +
    "src->dist".padStart(14);
  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");

  const regressions: Array<{ command: string; source: number; dist: number; deltaPct: number }> =
    [];
  for (const [label] of COMMANDS) {
    const perCmd = matrix.get(label);
    if (!perCmd) continue;
    const bash = perCmd.get("bash");
    const src = perCmd.get("bun-source");
    const dist = perCmd.get("bun-dist");
    const fmt = (v: number | undefined): string => (v === undefined ? "n/a" : v.toFixed(2));
    let delta = "n/a";
    if (src !== undefined && dist !== undefined) {
      const deltaPct = ((dist - src) / src) * 100;
      delta = (deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(1) + "%";
      // Allow small noise tolerance: regression is dist > 1.10x source.
      if (dist > src * 1.1) {
        regressions.push({ command: label, source: src, dist, deltaPct });
      }
    }
    process.stdout.write(
      label.padEnd(20) +
        fmt(bash).padStart(10) +
        fmt(src).padStart(14) +
        fmt(dist).padStart(12) +
        delta.padStart(14) +
        "\n",
    );
  }

  const out = await writeJsonl(records);
  process.stdout.write(`\nRecorded ${records.length} records to ${out}\n`);

  if (regressions.length > 0) {
    process.stderr.write(
      `\nREGRESSION: ${regressions.length} command(s) slower in dist than source ` +
        `(>10% threshold):\n`,
    );
    for (const r of regressions) {
      process.stderr.write(
        `  - ${r.command}: source=${r.source.toFixed(2)}ms dist=${r.dist.toFixed(2)}ms ` +
          `(+${r.deltaPct.toFixed(1)}%)\n`,
      );
    }
    process.exit(1);
  }

  if (!distAvailable) {
    process.stdout.write("\nNote: bun-dist route was skipped (dist artifact missing).\n");
  } else {
    process.stdout.write("\nNo dist regressions detected.\n");
  }
}

async function main(): Promise<void> {
  const runs = arg("--runs", "20");
  const warmup = arg("--warmup", "3");
  if (hasFlag("--compare-dist")) {
    await runCompareDist(runs, warmup);
  } else {
    await runDefault(runs, warmup);
  }
}

main();
