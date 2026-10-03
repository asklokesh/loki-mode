// loki-ts/src/project_model/package_suite.ts -- FC-01: the deep full suite for a multi-root Project Model.
// Each package that declares a test command runs it in its own directory. Returns false when the model is
// absent or single-root, so the caller keeps its legacy per-runner path unchanged.
import { join } from "node:path";
import { run } from "../util/shell.ts";
import { isMultiRoot, loadProjectApi } from "./resolve.ts";

interface SuiteCheck { name: string; cmd: string; result: "pass" | "fail" | "not_run"; duration_s: number }

export async function runPackageSuites(
  repoDir: string,
  signal: AbortSignal,
  opts: { path?: string | undefined; timeoutMs: number },
  checks: SuiteCheck[],
  notProven: Set<string>,
): Promise<boolean> {
  const api = loadProjectApi(repoDir);
  if (!isMultiRoot(api)) return false;
  const withTests = api.packages().filter((p) => p.commands.test);
  if (withTests.length === 0) return false;
  for (const pkg of withTests) {
    const tc = pkg.commands.test!, name = `full suite: ${pkg.name}`, cmd = `(cd ${tc.cwd} && ${tc.cmd})`;
    const started = Date.now();
    const r = await run(["bash", "-c", tc.cmd], { cwd: join(repoDir, tc.cwd), timeoutMs: opts.timeoutMs, ...(opts.path ? { env: { PATH: opts.path } } : {}) });
    const duration_s = (Date.now() - started) / 1000;
    if (signal.aborted) { checks.push({ name, cmd, result: "not_run", duration_s }); notProven.add(`not run: ${name} (aborted)`); continue; }
    checks.push({ name, cmd, result: r.exitCode === 0 ? "pass" : "fail", duration_s });
  }
  for (const pkg of api.packages().filter((p) => !p.commands.test)) notProven.add(`full suite: package ${pkg.name} defines no test command`);
  return true;
}
