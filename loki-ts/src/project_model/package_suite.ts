// loki-ts/src/project_model/package_suite.ts -- FC-01: the deep full suite for a multi-root Project Model.
// Each package that declares a test command runs it in its own directory. Returns false when the model is
// absent or single-root, so the caller keeps its legacy per-runner path unchanged.
// FC-BASELINE-PER-PACKAGE: fullSuiteSpecs is the one list of full-suite commands; verify runs it and the intake baseline records it.
import { closeSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { harnessLoadReason } from "../runner/load_owner.ts";
import { classifyCheck, failureExcerpt, FULL_SUITE_CMD, goRunner, NO_TESTS_REASON, plainTestEnv, stripAnsi } from "../util/check_result.ts";
import { run } from "../util/shell.ts";
import { failIds } from "../engine10/failures.ts";
import type { RunnerName } from "../engine10/types.ts";
import type { ProjectApi } from "./api.ts";
import { isMultiRoot, loadProjectApi } from "./resolve.ts";

interface SuiteCheck { name: string; cmd: string; result: "pass" | "fail" | "not_run"; duration_s: number; ids?: string[]; excerpt?: string }

/** One full-suite command: `name` and `cmd` are the check's own fields, `run` is what executes in the repo-relative `cwd`. */
export interface SuiteSpec { name: string; cmd: string; cwd: string; run: string }

/** One spec per multi-root package with a test command; null when the model is absent, single-root or defines none. */
export function packageSuiteSpecs(api: ProjectApi | null | undefined): SuiteSpec[] | null {
  if (!isMultiRoot(api)) return null;
  const specs = api.packages().filter((p) => p.commands.test).map((p) => { const tc = p.commands.test!; return { name: `full suite: ${p.name}`, cmd: `(cd ${tc.cwd} && ${tc.cmd})`, cwd: tc.cwd, run: tc.cmd }; });
  return specs.length ? specs : null;
}

/** The full-suite commands verify will run: per package from the model, else per detected runner. */
export function fullSuiteSpecs(repoDir: string, runners: RunnerName[]): SuiteSpec[] {
  return packageSuiteSpecs(loadProjectApi(repoDir)) ?? runners.map((r) => { const c = [FULL_SUITE_CMD[r].cmd, ...FULL_SUITE_CMD[r].args].join(" "); return { name: `full suite: ${r}`, cmd: c, cwd: ".", run: c }; });
}

/** FC-FULLSUITE-ANSI-IDS: the plain child env (FC-69) for a full-suite run, with the caller's PATH override when present. */
export function suiteEnv(path?: string): Record<string, string> { return path ? { ...plainTestEnv(), PATH: path } : plainTestEnv(); }

/** FC-SEAL-NA-AS-UNPROVEN: a note that is informational, not a gap, travels in the same Set with this prefix; consumers split it with naNote/naText. */
export const NA_PREFIX = "n/a: ";
export const naNote = (n: string): boolean => n.startsWith(NA_PREFIX) || n.startsWith("full suite (no test runner");
export const naText = (n: string): string => (n.startsWith(NA_PREFIX) ? n.slice(NA_PREFIX.length) : n);
/** Test files of the Wall and holdout checks, only when at least one ran and every one passed (fail-safe: none ran, or any not pass, is no proof). A package without tests is proven only by a file inside it. */
export const wallProofOf = (checks: { name: string; result: string }[], wall: { name: string; path: string }[]): string[] => { const n = new Set(wall.map((w) => w.name)), w = checks.filter((c) => n.has(c.name) || c.name.startsWith("holdout")); return w.length > 0 && w.every((c) => c.result === "pass") ? wall.map((x) => x.path) : []; };

export async function runPackageSuites(
  repoDir: string,
  signal: AbortSignal,
  opts: { path?: string | undefined; timeoutMs: number; baseSha?: string; skip?: (f: string) => boolean; changed?: string[] | undefined; proofFiles?: string[] | undefined },
  checks: SuiteCheck[],
  notProven: Set<string>,
): Promise<boolean> {
  const api = loadProjectApi(repoDir), specs = packageSuiteSpecs(api);
  if (!api || !specs) return false;
  for (const { name, cmd, cwd, run: line } of specs) {
    const started = Date.now();
    const r = await run(["bash", "-c", line], { cwd: join(repoDir, cwd), timeoutMs: opts.timeoutMs, env: suiteEnv(opts.path) });
    const duration_s = (Date.now() - started) / 1000;
    if (signal.aborted) { checks.push({ name, cmd, result: "not_run", duration_s }); notProven.add(`not run: ${name} (aborted)`); continue; }
    // FC-16 C1 / FC-02: the same parser and load-error ownership as the legacy per-runner path, per package.
    const out = stripAnsi(`${r.stdout}\n${r.stderr}`); // FC-FULLSUITE-ANSI-IDS
    const lr = r.exitCode === 0 || !opts.baseSha ? undefined : await harnessLoadReason({ repoDir, baseSha: opts.baseSha, ...(opts.skip ? { skip: opts.skip } : {}), out, cmd: "bash", args: ["-c", line], signal, cwd: join(repoDir, cwd), env: suiteEnv(opts.path) });
    if (lr) { checks.push({ name, cmd, result: "not_run", duration_s }); notProven.add(`${lr} (${name}; harness-owned)`); continue; }
    const cls = classifyCheck({ kind: "test", ok: r.exitCode === 0, out, ...goRunner(line) });
    checks.push({ name, cmd, result: cls.result, duration_s, ...(cls.result === "fail" ? { ids: failIds(out), excerpt: failureExcerpt(out, repoDir) } : {}) });
    if (cls.result === "not_run") notProven.add(`not run: ${name} (${cls.reason ?? NO_TESTS_REASON})`);
  }
  // FC-SEAL-NA-AS-UNPROVEN: a package with no test command is N/A only beside a suite that really ran; changed files it owns with no Wall proof (or an unknown diff) stay NOT PROVEN.
  const ran = checks.some((c) => c.result === "pass" || c.result === "fail");
  for (const pkg of api.packages().filter((p) => !p.commands.test)) {
    const note = `full suite: package ${pkg.name} defines no test command`, owns = !opts.changed || opts.changed.some((f) => { const o = api.packageOf(f); return !o || f.startsWith('"') || o.root === pkg.root; });
    const proven = (opts.proofFiles ?? []).some((f) => api.packageOf(f)?.root === pkg.root) || namesPackageFile(repoDir, opts.proofFiles ?? [], opts.changed, (c) => { const o = api.packageOf(c); return !!o && !c.startsWith('"') && o.root === pkg.root; }, pkg.root);
    notProven.add(ran && !(owns && !proven) ? NA_PREFIX + note : note);
  }
  return true;
}

const PROOF_READ_CAP = 1 << 20;
const readCapped = (abs: string): string | null => { let fd = -1; try { fd = openSync(abs, "r"); const b = Buffer.alloc(PROOF_READ_CAP), n = readSync(fd, b, 0, PROOF_READ_CAP, 0); return b.toString("utf8", 0, n); } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ } } };

/** FC-WALL-PROOF-PACKAGE-BLIND: a passing proof file anywhere in the repo credits a package when its text names a changed file that package owns (repo-relative, package-relative or proof-directory-relative). Unknown diff or unreadable proof: no credit. */
function namesPackageFile(repoDir: string, proofs: string[], changed: string[] | undefined, owned: (f: string) => boolean, pkgRoot: string): boolean {
  const mine = (changed ?? []).filter(owned);
  if (!mine.length) return false;
  for (const pf of proofs) {
    const abs = isAbsolute(pf) ? pf : join(repoDir, pf), text = readCapped(abs);
    if (text === null) continue;
    const pdir = dirname(abs);
    for (const c of mine) {
      const cands = [c, pkgRoot === "." ? "" : relative(pkgRoot, c), relative(pdir, join(repoDir, c))].filter((x) => x.length > 0);
      if (cands.some((x) => text.includes(x))) return true;
    }
  }
  return false;
}
