// loki-ts/src/engine10/modernize/cli.ts -- M-07: `loki modernize` CLI and flag parsing
// (docs/v10/MODERNIZE.md section 2). Wires the already-built pieces (Inventory M-02, the
// Python graph M-03, clustering M-05, the estimate M-06) into --dry-run's zero-spend print.
// Java's graph builder (M-04) is not built yet: it is loaded the same not-built-yet-tolerant
// way ../cli.ts routes every subcommand (a specifier string, never a static import -- D33:
// core never imports modernize/, and this file mirrors that discipline one level down for
// its own not-yet-built sibling), so a java21 run reports the gap honestly instead of
// clustering on a fabricated empty graph.
import { existsSync, statSync } from "node:fs";
import { buildInventory } from "./inventory.ts";
import { buildPythonGraph } from "./lang/python.ts";
import { clusterInventory } from "./cluster.ts";
import type { DepGraph } from "./cluster.ts";
import { estimate, formatDryRun } from "./estimate.ts";
import type { CostPrior } from "./estimate.ts";
import { ModernizeLog } from "./log.ts";
import { isModernizeId, makeModernizeId } from "./types.ts";
import type { ModernizeTarget } from "./types.ts";

const TARGETS: readonly ModernizeTarget[] = ["python3", "java21"];
const DEFAULT_WORKERS = 4;
const MAX_LOCAL_WORKERS = 32; // section 2: "max 32 locally"; --remote's cap comes from the cluster instead

export const USAGE = `Usage:
  loki modernize <repo> --to "<target>" [--budget USD] [--workers N] [--remote URL]
                 [--resume <mid>] [--dry-run] [--provider P] [--no-pr]
Targets: ${TARGETS.join(", ")}
`;

export interface ModernizeOptions {
  repoDir: string;
  target: ModernizeTarget;
  budgetUsd: number | null;
  workers: number;
  remote: string | null;
  resume: string | null;
  dryRun: boolean;
  provider: string | null;
  noPr: boolean;
}

export type ParseResult = { ok: true; opts: ModernizeOptions } | { ok: false; error: string };

/** Pure: no I/O, so every flag case is a plain assertion in cli.test.ts. */
export function parseArgs(args: readonly string[]): ParseResult {
  let repoDir: string | null = null;
  let target: string | null = null;
  let budgetUsd: number | null = null;
  let workers = DEFAULT_WORKERS;
  let remote: string | null = null;
  let resume: string | null = null;
  let dryRun = false;
  let provider: string | null = null;
  let noPr = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const needValue = (): string | null => {
        const v = args[++i];
        return v === undefined ? null : v;
      };
      switch (a) {
        case "--to": {
          const v = needValue();
          if (v === null) return { ok: false, error: "--to needs a value" };
          target = v;
          break;
        }
        case "--budget": {
          const v = needValue();
          const n = v === null ? NaN : Number(v);
          if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "--budget must be a positive number" };
          budgetUsd = n;
          break;
        }
        case "--workers": {
          const v = needValue();
          const n = v === null ? NaN : Number(v);
          if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "--workers must be a positive integer" };
          workers = n;
          break;
        }
        case "--remote": {
          const v = needValue();
          if (v === null) return { ok: false, error: "--remote needs a value" };
          remote = v;
          break;
        }
        case "--resume": {
          const v = needValue();
          if (v === null) return { ok: false, error: "--resume needs a value" };
          if (!isModernizeId(v)) return { ok: false, error: `--resume: not a modernization id: ${v}` };
          resume = v;
          break;
        }
        case "--dry-run":
          dryRun = true;
          break;
        case "--provider": {
          const v = needValue();
          if (v === null) return { ok: false, error: "--provider needs a value" };
          provider = v;
          break;
        }
        case "--no-pr":
          noPr = true;
          break;
        default:
          return { ok: false, error: `unknown flag: ${a}` };
      }
      continue;
    }
    if (repoDir === null) repoDir = a;
    else return { ok: false, error: `unexpected argument: ${a}` };
  }

  if (!repoDir) return { ok: false, error: "missing <repo>" };
  if (!target) return { ok: false, error: "missing --to" };
  if (!(TARGETS as readonly string[]).includes(target)) {
    return { ok: false, error: `unknown target ${JSON.stringify(target)}; supported: ${TARGETS.join(", ")}` };
  }
  if (!remote && workers > MAX_LOCAL_WORKERS) {
    return { ok: false, error: `--workers ${workers} exceeds the local max of ${MAX_LOCAL_WORKERS} (use --remote for more)` };
  }

  return {
    ok: true,
    opts: { repoDir, target: target as ModernizeTarget, budgetUsd, workers, remote, resume, dryRun, provider, noPr },
  };
}

type Loader = (specifier: string) => Promise<Record<string, unknown>>;
const defaultLoader: Loader = (spec) => import(spec);

function isMissing(err: unknown, spec: string): boolean {
  const e = err as { code?: string; message?: string } | null;
  const msg = String(e?.message ?? "");
  const notFound =
    e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND" || /Cannot find module|Module not found/i.test(msg);
  return notFound && msg.includes(spec);
}

/** Python's graph builder is already built, so it is wired directly (M-03).
 *  Java's (M-04) is loaded the same not-built-yet-tolerant way ../cli.ts's
 *  router loads every subcommand module, so this file works today and a
 *  java21 run reports the gap instead of clustering on a fabricated graph. */
async function buildGraph(
  target: ModernizeTarget,
  repoDir: string,
  files: readonly string[],
  load: Loader,
): Promise<{ graph: DepGraph } | { notBuilt: string }> {
  if (target === "python3") return { graph: (await buildPythonGraph(repoDir, files)).graph };
  const spec = "./lang/java.ts";
  try {
    const mod = await load(spec);
    const fn = mod["buildJavaGraph"];
    if (typeof fn !== "function") return { notBuilt: "modernize: lang/java.ts does not export buildJavaGraph" };
    const result = await (fn as (r: string, f: readonly string[]) => Promise<{ graph: DepGraph }>)(repoDir, files);
    return { graph: result.graph };
  } catch (err) {
    if (!isMissing(err, spec)) throw err;
    return { notBuilt: "modernize: lang/java.ts (M-04) not built yet" };
  }
}

export interface ModernizeCliDeps {
  load?: Loader;
  now?: () => string;
  makeId?: () => string;
  /** Cost/time priors (eta.ts/cost.ts history, or the Legacy-Bench pilot median, M-27).
   *  Unmeasured (null/null) until that wiring lands; estimate.ts prints "not measured", never $0. */
  prior?: CostPrior;
}
const NO_PRIOR: CostPrior = { usdPerUnit: null, p50UnitTimeS: null };

/** `loki modernize` entry point (TABLE route in ../cli.ts). Section 2/3.1: parses and
 *  validates flags, opens the modernize log, runs Inventory and the up-front estimate, and
 *  for --dry-run prints it and stops at zero model spend. Oracle capture, planning and
 *  execution (sections 3.2-3.6) are later slices (M-09 onward); a non-dry-run invocation
 *  stops after the estimate rather than claiming work those slices have not built yet. */
export async function main(args: readonly string[], deps: ModernizeCliDeps = {}): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`modernize: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const opts = parsed.opts;
  // A typo'd or missing <repo> must not silently read as "nothing to convert": Inventory's
  // git ls-files returns [] outside a repo, which would otherwise print a false "units: 0"
  // dry-run and create .loki/ under a path that was never real (section 3.1's "undetectable
  // build system stops the run" is the same honesty rule).
  if (!existsSync(opts.repoDir) || !statSync(opts.repoDir).isDirectory()) {
    process.stderr.write(`modernize: not a directory: ${opts.repoDir}\n`);
    return 2;
  }
  const mid = opts.resume ?? (deps.makeId ?? makeModernizeId)();
  const log = new ModernizeLog(opts.repoDir, mid, deps.now);
  log.append("modernize.started", {
    repo: opts.repoDir, to: opts.target, budget_usd: opts.budgetUsd, workers: opts.workers,
    remote: opts.remote, resume: opts.resume, provider: opts.provider, no_pr: opts.noPr, dry_run: opts.dryRun,
  });

  const inv = buildInventory(opts.repoDir);
  log.append("inventory.completed", {
    files: inv.files.length, truncated: inv.truncated, languages: inv.languages, build_system: inv.buildSystem.system,
  });

  const graphResult = await buildGraph(opts.target, opts.repoDir, inv.files, deps.load ?? defaultLoader);
  if ("notBuilt" in graphResult) {
    process.stderr.write(`${graphResult.notBuilt}\n`);
    return 2;
  }

  const clustered = clusterInventory(graphResult.graph);
  const est = estimate(clustered, deps.prior ?? NO_PRIOR, opts.workers);
  log.append("estimate.printed", {
    units: est.units, waves: est.waves, cost_usd: est.costUsd, wall_time_s: est.wallTimeS,
    risk_high: est.riskHigh, risk_normal: est.riskNormal,
  });
  process.stdout.write(formatDryRun(est) + "\n");
  if (opts.dryRun) return 0;

  process.stderr.write("modernize: oracle capture and execution are not built yet; use --dry-run\n");
  return 2;
}
