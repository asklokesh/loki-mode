// loki-ts/src/project_model/package_suite.ts -- FC-01: the deep full suite for a multi-root Project Model.
// Each package that declares a test command runs it in its own directory. Returns false when the model is
// absent or single-root, so the caller keeps its legacy per-runner path unchanged.
// FC-BASELINE-PER-PACKAGE: fullSuiteSpecs is the one list of full-suite commands; verify runs it and the intake baseline records it.
import { join } from "node:path";
import { harnessLoadReason } from "../runner/load_owner.ts";
import { classifyCheck, FULL_SUITE_CMD, goRunner, NO_TESTS_REASON } from "../util/check_result.ts";
import { run } from "../util/shell.ts";
import { failIds } from "../engine10/failures.ts";
import type { RunnerName } from "../engine10/types.ts";
import type { ProjectApi } from "./api.ts";
import { isMultiRoot, loadProjectApi } from "./resolve.ts";

interface SuiteCheck { name: string; cmd: string; result: "pass" | "fail" | "not_run"; duration_s: number; ids?: string[] }

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

export async function runPackageSuites(
  repoDir: string,
  signal: AbortSignal,
  opts: { path?: string | undefined; timeoutMs: number; baseSha?: string },
  checks: SuiteCheck[],
  notProven: Set<string>,
): Promise<boolean> {
  const api = loadProjectApi(repoDir), specs = packageSuiteSpecs(api);
  if (!api || !specs) return false;
  for (const { name, cmd, cwd, run: line } of specs) {
    const started = Date.now();
    const r = await run(["bash", "-c", line], { cwd: join(repoDir, cwd), timeoutMs: opts.timeoutMs, ...(opts.path ? { env: { PATH: opts.path } } : {}) });
    const duration_s = (Date.now() - started) / 1000;
    if (signal.aborted) { checks.push({ name, cmd, result: "not_run", duration_s }); notProven.add(`not run: ${name} (aborted)`); continue; }
    // FC-16 C1 / FC-02: the same parser and load-error ownership as the legacy per-runner path, per package.
    const out = `${r.stdout}\n${r.stderr}`;
    const lr = r.exitCode === 0 || !opts.baseSha ? undefined : await harnessLoadReason({ repoDir, baseSha: opts.baseSha, out, cmd: "bash", args: ["-c", line], signal, cwd: join(repoDir, cwd), ...(opts.path ? { env: { PATH: opts.path } } : {}) });
    if (lr) { checks.push({ name, cmd, result: "not_run", duration_s }); notProven.add(`${lr} (${name}; harness-owned)`); continue; }
    const cls = classifyCheck({ kind: "test", ok: r.exitCode === 0, out, ...goRunner(line) });
    checks.push({ name, cmd, result: cls.result, duration_s, ...(cls.result === "fail" ? { ids: failIds(out) } : {}) });
    if (cls.result === "not_run") notProven.add(`not run: ${name} (${cls.reason ?? NO_TESTS_REASON})`);
  }
  for (const pkg of api.packages().filter((p) => !p.commands.test)) notProven.add(`full suite: package ${pkg.name} defines no test command`);
  return true;
}
