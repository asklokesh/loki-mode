// loki-ts/src/engine10/modernize/oracle/java.ts -- M-11: Java 8 to 21 oracle capture
// (docs/v10/MODERNIZE.md sections 3.2, 7; uses the merged M-04 graph via
// ../lang/java.ts to resolve each unit file's package -- the same regex
// M-04 already uses, not a second copy of its scan). Every verdict lives
// here, as pure functions over the raw files autonomy/lib/modernize/
// java_capture.sh writes (status.json, jacoco.xml, replay1.jsonl,
// replay2.jsonl): the shell script only runs tools, this module decides
// what is proven. Coverage and case output paths follow types.ts's
// oracleDir (unit -> cases.jsonl, coverage.json), matching M-09's shape.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { REPO_ROOT } from "../../../util/paths.ts";
import { buildJavaGraph } from "../lang/java.ts";

const SCRIPT = join(REPO_ROOT, "autonomy", "lib", "modernize", "java_capture.sh");
const PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/m;

/** Fully-qualified class names for a unit's files, reusing M-04's own .java filtering
 *  (buildJavaGraph's graph.nodes) rather than re-scanning the file list here -- a file M-04
 *  dropped (not .java, unreadable) is dropped here the same way. The package-line regex is
 *  the one line of lang/java.ts's private scanJavaFiles this module needs and that file does
 *  not export, so it is repeated rather than exported for a one-line reason. */
export function unitClassesFromGraph(repoDir: string, files: readonly string[]): string[] {
  const { graph } = buildJavaGraph(repoDir, files);
  return graph.nodes.map((n) => {
    const src = readFileSync(join(repoDir, n.id), "utf8");
    const pkg = PACKAGE_RE.exec(src)?.[1];
    const cls = basename(n.id, ".java");
    return pkg ? `${pkg}.${cls}` : cls;
  });
}

/** found:false means the script binary itself is missing -- separate from the script running
 *  and reporting no JDK 8, which is a normal, expected outcome, not a runner failure. Mirrors
 *  codemod.ts's CommandResult/CommandRunner so tests inject this the same way. */
export interface CommandResult {
  found: boolean;
  code: number | null;
}
export type CommandRunner = (cmd: string, args: string[], cwd: string) => CommandResult;

export const realCommandRunner: CommandRunner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return { found: false, code: null };
  return { found: true, code: r.status };
};

interface Status {
  jdk8: boolean;
  jdkVersionRaw: string | null;
  jacocoAgent: string | null;
  jacocoCli: string | null;
  randoopJar: string | null;
  reasons: string[];
}

interface RawCase {
  class: string;
  method: string | null;
  args?: unknown[];
  return?: unknown;
  exc?: { type: string } | null;
  stdout?: string;
  not_capturable?: string[];
}

export interface JavaCase {
  method: string;
  args: unknown[];
  return: unknown;
  exc: { type: string } | null;
  stdout: string;
  not_proven: string[];
}

export interface CoverageResult {
  unit: string;
  entries: string[];
  cases: number;
  branches_total: number;
  branches_taken: number;
  branch_pct: number | null; // null = not measured (section 3.2); never rounds up to 100
  missing: never[]; // ponytail: JaCoCo XML gives report-level counters only here, no per-line
  // missing detail -- upgrade path: parse <line> elements once a real JaCoCo run is available
  // to validate the schema against (section 7 gives the method/return/stdout fields the same
  // way; this field mirrors py_capture's coverage.json shape for the equivalence checker).
}

export interface JavaCaptureResult {
  proven: boolean; // false whenever notProven is non-empty (section 3.2 honest-verdict rule)
  notProven: string[];
  caseCount: number;
  nondeterministicCount: number;
  coverage: CoverageResult;
  casesPath: string;
  coveragePath: string;
}

export interface JavaCaptureOpts {
  repoDir: string;
  outDir: string; // oracleDir(repoDir, mid, unit) from types.ts, caller's job to build
  unitDir: string; // directory of the unit's .java sources, passed to java_capture.sh
  unitFiles: readonly string[]; // the unit's repo-relative .java paths (cluster.ts Unit.nodes);
  // fully-qualified class names are derived via unitClassesFromGraph (M-04), never re-typed
  testClasspath?: string;
  runner?: CommandRunner;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readJsonl(path: string): RawCase[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: RawCase[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RawCase);
    } catch {
      // a malformed line is dropped, never guessed at -- counted via caseCount vs raw line count
    }
  }
  return out;
}

/** JaCoCo's XML report nests a BRANCH <counter> inside every element (method, class, package)
 *  and rolls one up as a direct child of the root <report>. Regex-scraping the LAST BRANCH
 *  counter in the file lands on that report-level roll-up without a full XML parser.
 *  ponytail: never validated against a real JaCoCo run (none installed here) -- validated only
 *  against fixtures built from JaCoCo's documented XML schema. Upgrade path: swap for a real
 *  XML parser plus a live run once a JDK 8 + JaCoCo host exists. */
function parseJacocoBranches(xml: string): { total: number; taken: number } | null {
  const re = /<counter\s+type="BRANCH"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) last = m;
  if (!last) return null;
  const missed = Number(last[1]);
  const covered = Number(last[2]);
  return { total: missed + covered, taken: covered };
}

/** Deep-equal over already-parsed JSON values (cases are JSON-safe by construction: no NaN,
 *  no cycles, no functions), used for the double-replay determinism check (section 3.2:
 *  "Replay every case twice ... A field that differs between the replays is marked
 *  nondeterministic"). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Runs java_capture.sh, reads its raw artifacts, applies the double-replay determinism filter,
 *  the boundary check, the coverage floor, and writes cases.jsonl + coverage.json into opts.outDir.
 *  Every verdict here is a pure function of files on disk -- java_capture.sh only produced them. */
export function captureJavaUnit(opts: JavaCaptureOpts): JavaCaptureResult {
  const runner = opts.runner ?? realCommandRunner;
  mkdirSync(opts.outDir, { recursive: true });
  const classes = unitClassesFromGraph(opts.repoDir, opts.unitFiles);

  const args = [
    SCRIPT,
    "--unit-dir", opts.unitDir,
    "--classes", classes.join(","),
    "--files", opts.unitFiles.join(","),
    "--out", opts.outDir,
  ];
  if (opts.testClasspath) args.push("--test-classpath", opts.testClasspath);
  const result = runner("bash", args, opts.repoDir);

  const notProven: string[] = [];
  const casesPath = join(opts.outDir, "cases.jsonl");
  const coveragePath = join(opts.outDir, "coverage.json");

  if (!result.found) {
    notProven.push("skipped: no JDK 8", "java_capture.sh not found");
    const coverage: CoverageResult = {
      unit: opts.unitDir, entries: classes, cases: 0,
      branches_total: 0, branches_taken: 0, branch_pct: null, missing: [],
    };
    writeFileSync(casesPath, "");
    writeFileSync(coveragePath, JSON.stringify(coverage));
    return { proven: false, notProven, caseCount: 0, nondeterministicCount: 0, coverage, casesPath, coveragePath };
  }

  const status = readJson<Status>(join(opts.outDir, "status.json"));
  if (!status || !status.jdk8) {
    // The script itself already records "skipped: no JDK 8" plus a fuller reason when it can
    // exit early; a missing/unparseable status.json is the same honest outcome by another cause.
    notProven.push(...(status?.reasons ?? ["skipped: no JDK 8", "old runtime unavailable"]));
    if (!notProven.some((r) => r.startsWith("skipped: no JDK 8"))) notProven.unshift("skipped: no JDK 8");
    const coverage: CoverageResult = {
      unit: opts.unitDir, entries: classes, cases: 0,
      branches_total: 0, branches_taken: 0, branch_pct: null, missing: [],
    };
    writeFileSync(casesPath, "");
    writeFileSync(coveragePath, JSON.stringify(coverage));
    return { proven: false, notProven, caseCount: 0, nondeterministicCount: 0, coverage, casesPath, coveragePath };
  }
  notProven.push(...status.reasons);

  // --- double-replay determinism filter --------------------------------------------------
  const replay1 = readJsonl(join(opts.outDir, "replay1.jsonl"));
  const replay2 = readJsonl(join(opts.outDir, "replay2.jsonl"));
  const byMethod2 = new Map(replay2.map((c) => [`${c.class}\u0000${c.method}`, c]));
  const kept: JavaCase[] = [];
  let nondeterministicCount = 0;
  for (const c1 of replay1) {
    const key = `${c1.class}\u0000${c1.method}`;
    const c2 = byMethod2.get(key);
    if (!c2 || !deepEqual(c1, c2)) {
      nondeterministicCount++;
      notProven.push(`nondeterministic:${key.replace("\u0000", "#")}`);
      continue;
    }
    const caseNotProven = (c1.not_capturable ?? []).map((r) => `${r} (${c1.method})`);
    kept.push({
      method: c1.method ?? c1.class,
      args: c1.args ?? [],
      return: c1.return ?? null,
      exc: c1.exc ?? null,
      stdout: c1.stdout ?? "",
      not_proven: caseNotProven,
    });
    notProven.push(...caseNotProven);
  }

  // --- coverage ----------------------------------------------------------------------------
  const xmlPath = join(opts.outDir, "jacoco.xml");
  const xml = existsSync(xmlPath) ? readFileSync(xmlPath, "utf8") : "";
  const branches = xml.trim() ? parseJacocoBranches(xml) : null;
  let branchPct: number | null = null;
  if (branches && branches.total > 0) {
    branchPct = Math.round((10000 * branches.taken) / branches.total) / 100;
  } else {
    notProven.push("coverage not measured");
  }
  if (branchPct !== null && branchPct < 80) {
    notProven.push(`NOT PROVEN: coverage ${branchPct}% below 80%`);
  }

  const coverage: CoverageResult = {
    unit: opts.unitDir,
    entries: classes,
    cases: kept.length,
    branches_total: branches?.total ?? 0,
    branches_taken: branches?.taken ?? 0,
    branch_pct: branchPct,
    missing: [],
  };

  writeFileSync(casesPath, kept.map((c) => JSON.stringify(c)).join("\n") + (kept.length ? "\n" : ""));
  writeFileSync(coveragePath, JSON.stringify(coverage));

  return {
    proven: notProven.length === 0,
    notProven,
    caseCount: kept.length,
    nondeterministicCount,
    coverage,
    casesPath,
    coveragePath,
  };
}
