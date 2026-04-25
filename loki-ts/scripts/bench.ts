/**
 * Microbenchmark: compare bash vs Bun for the simplest possible CLI
 * command (`version`) on this machine. Validates ADR-001's published
 * numbers are reproducible.
 *
 * Run: bun run bench
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const RUNS = 50;
const WARMUP = 5;

interface Result {
  label: string;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

function runOnce(cmd: string, args: readonly string[]): number {
  const t0 = performance.now();
  const r = spawnSync(cmd, args as string[], { stdio: "ignore" });
  const t1 = performance.now();
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`${cmd} ${args.join(" ")} -> exit ${r.status}`);
  }
  return t1 - t0;
}

function bench(label: string, cmd: string, args: readonly string[]): Result {
  for (let i = 0; i < WARMUP; i++) runOnce(cmd, args);
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) samples.push(runOnce(cmd, args));
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    label,
    meanMs: sum / samples.length,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

function main() {
  const lokiBash = resolve(REPO_ROOT, "autonomy", "loki");
  const lokiTs = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");

  console.log(`bench: ${RUNS} runs (${WARMUP} warmup) -- lower is better\n`);

  const results = [
    bench("bash autonomy/loki version", lokiBash, ["version"]),
    bench("bun loki-ts/src/cli.ts version", "bun", [lokiTs, "version"]),
  ];

  for (const r of results) {
    console.log(
      `${r.label.padEnd(42)} ${r.meanMs.toFixed(2).padStart(7)} ms  (min ${r.minMs.toFixed(2)}, max ${r.maxMs.toFixed(2)})`,
    );
  }

  const baseline = results[0]!.meanMs;
  console.log("\nrelative to bash:");
  for (const r of results) {
    const ratio = r.meanMs / baseline;
    const verdict =
      ratio < 1
        ? `${(1 / ratio).toFixed(2)}x FASTER than bash`
        : `${ratio.toFixed(2)}x slower than bash`;
    console.log(`  ${r.label.padEnd(42)} ${verdict}`);
  }
}

main();
