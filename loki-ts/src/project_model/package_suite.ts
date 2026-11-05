// loki-ts/src/project_model/package_suite.ts -- FC-01: the deep full suite for a multi-root Project Model.
// Each package that declares a test command runs it in its own directory. Returns false when the model is
// absent or single-root, so the caller keeps its legacy per-runner path unchanged.
// FC-BASELINE-PER-PACKAGE: fullSuiteSpecs is the one list of full-suite commands; verify runs it and the intake baseline records it.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { harnessLoadReason } from "../runner/load_owner.ts";
import { suiteEmptyOnBase } from "../runner/repo_profile.ts";
import { classifyCheck, corroboratePass, failureExcerpt, firstError, fullSuiteCmd, goRunner, exitCodedId, isExitCodedScript, NO_TESTS_REASON, plainTestEnv, stripAnsi } from "../util/check_result.ts";
import { run, shellWord } from "../util/shell.ts";
import type { ProfileCommand } from "../runner/repo_profile.ts"; // type-only: no import cycle
import { STACK_TOOLS, repoTestCommand, toolOk } from "../util/stack_tools.ts";
import { errorsById, failIds, unhandledBlock } from "../engine10/failures.ts";
import type { RunnerName } from "../engine10/types.ts";
import type { ProjectApi } from "./api.ts";
import { isMultiRoot, loadProjectApi } from "./resolve.ts";

interface SuiteCheck { name: string; cmd: string; result: "pass" | "fail" | "not_run"; duration_s: number; ids?: string[]; errors?: Record<string, string[]>; unhandled?: string[]; first_error?: string; excerpt?: string; count?: string }

/** One full-suite command: `name` and `cmd` are the check's own fields, `run` is what executes in the repo-relative `cwd`. */
export interface SuiteSpec { name: string; cmd: string; cwd: string; run: string }

/** One spec per multi-root package with a test command; null when the model is absent, single-root or defines none. With `repoDir`, a Go package whose test command is a plain `go test`, or a Makefile target that only runs one, runs as `go test -json` (goMakeSuite). */
export function packageSuiteSpecs(api: ProjectApi | null | undefined, repoDir?: string): SuiteSpec[] | null {
  if (!isMultiRoot(api)) return null;
  const specs = api.packages().filter((p) => p.commands.test).map((p) => { const tc = p.commands.test!, line = (repoDir !== undefined ? goMakeSuite(repoDir, tc.cwd, tc.cmd) : null) ?? tc.cmd; return { name: `full suite: ${p.name}`, cmd: `(cd ${tc.cwd} && ${line})`, cwd: tc.cwd, run: line }; });
  return specs.length ? specs : null;
}
// go test flags goMakeSuite may drop: none selects tests or changes how a result is read (-short and -tags do, so a command with them is kept); -race is dropped like every other, as the single-root Go full suite never runs it. Valued ones take a separate token.
const GO_TEST_SAFE = new Set(["race", "cpu", "count", "timeout", "parallel", "p", "v", "failfast", "shuffle", "json"]), GO_TEST_VALUED = new Set(["cpu", "count", "timeout", "parallel", "p", "shuffle"]);
/** A Go module's (go.mod in `cwd`) full-suite command as one Loki can count. Plain go test output is never counted (GO_EXIT0_REASON), so a model command that is a plain `go test ./...` (what
 *  the model infers from go.mod) or `make <target>` whose target has no prerequisites and one plain `go test` recipe line (lefthook: `go test -cpu 24 -race -count=1 -timeout=30s ./...`) read
 *  not_run on every run. Returns `go test -json <its packages>`, the command a single-root Go repo already gets (fullSuiteCmd). null (the command is kept) for any other shape: prerequisites,
 *  a shell operator or variable, a second recipe line, a non-go-test line, -tags, -run, -short or any flag outside GO_TEST_SAFE. */
export function goMakeSuite(repoDir: string, cwd: string, cmd: string): string | null {
  const dir = join(repoDir, cwd); if (!existsSync(join(dir, "go.mod"))) return null;
  const m = /^\s*make\s+([A-Za-z0-9_.-]+)\s*$/.exec(cmd);
  let line = cmd.trim();
  if (m) {
    let text: string; try { text = readFileSync(join(dir, "Makefile"), "utf8"); } catch { return null; }
    const lines = text.split("\n"), at = lines.findIndex((l) => new RegExp(`^${m[1]!.replace(/[.]/g, "\\.")}\\s*:(?!=)(.*)$`).test(l));
    if (at < 0 || (/:(.*)$/.exec(lines[at]!)?.[1] ?? "").replace(/#.*/, "").trim() !== "") return null;
    const recipe: string[] = [];
    for (const l of lines.slice(at + 1)) { if (!l.startsWith("\t")) { if (l.trim() === "" || /^\s*#/.test(l)) continue; break; } const r = l.trim().replace(/^[@-]+/, ""); if (r !== "" && !r.startsWith("#")) recipe.push(r); }
    if (recipe.length !== 1) return null;
    line = recipe[0]!;
  }
  if (/[;&|`$()<>\\"']/.test(line)) return null;
  const toks = line.split(/\s+/);
  if (toks[0] !== "go" || toks[1] !== "test") return null;
  const pkgs: string[] = [];
  for (let k = 2; k < toks.length; k++) {
    const t = toks[k]!;
    if (!t.startsWith("-")) { pkgs.push(t); continue; }
    const flag = t.replace(/^--?/, "").split("=")[0]!;
    if (!GO_TEST_SAFE.has(flag)) return null;
    if (GO_TEST_VALUED.has(flag) && !t.includes("=")) k++;
  }
  return ["go", "test", "-json", ...pkgs].join(" ");
}

/** The full-suite commands verify will run: per package from the model, else per detected runner. */
export function fullSuiteSpecs(repoDir: string, runners: RunnerName[]): SuiteSpec[] {
  return packageSuiteSpecs(loadProjectApi(repoDir), repoDir) ?? runners.map((r) => { const f = fullSuiteCmd(r, repoDir), c = [f.cmd, ...f.args].join(" "); return { name: `full suite: ${r}`, cmd: c, cwd: ".", run: [f.cmd, ...f.args].map(shellWord).join(" ") }; }); // run goes through bash -c: an absolute .venv interpreter under a spaced path must stay one word
}

/** FR05: the full-suite commands verify will run (fullSuiteSpecs, the one list) as repo-profile rows, for readiness and `loki doctor --repo` when the manifests name no test command. Never executed and never persisted, so the baseline, attribution and implementer brief are unchanged. A build tool that is not installed (no wrapper, no committed verify.test_command) is validated:false and names the tool. */
export function verifyCommandRows(repoDir: string, tm: { runners: RunnerName[]; evidence?: Partial<Record<RunnerName, string>> }, env: NodeJS.ProcessEnv = process.env): ProfileCommand[] {
  try {
    const multi = packageSuiteSpecs(loadProjectApi(repoDir), repoDir) !== null, own = repoTestCommand(repoDir) !== null;
    return fullSuiteSpecs(repoDir, tm.runners).map((s, i) => {
      const r = multi ? undefined : tm.runners[i], t = r && !own && !toolOk(r, env, repoDir) ? STACK_TOOLS[r] : undefined;
      return { kind: "test", cmd: s.cmd, source: multi ? ".loki/project.json" : (r && tm.evidence?.[r]) || "test map", validated: t ? false : null, exit_code: null, duration_s: null, failing_ids: [], note: t ? `${t.tool} is not installed` : "verify runs this as the full suite", ...(t ? { fix: t.install } : {}) } as ProfileCommand;
    });
  } catch { return []; }
}

/** L026: the full-suite command lines of this repo, handed to an implement or fix session so its stream parser can count in-session full-suite runs. */
export function suiteCmdsOpt(repoDir: string, testmap: unknown): { suiteCmds?: string[] } {
  try { const runners = (testmap as { runners?: RunnerName[] } | undefined)?.runners ?? [], cmds = fullSuiteSpecs(repoDir, runners).map((s) => s.run); return cmds.length ? { suiteCmds: cmds } : {}; } catch { return {}; }
}
/** FC-FULLSUITE-ANSI-IDS: the plain child env (FC-69) for a full-suite run, with the caller's PATH override when present. */
export function suiteEnv(path?: string): Record<string, string> { return path ? { ...plainTestEnv(), PATH: path } : plainTestEnv(); }

/** FC-SEAL-NA-AS-UNPROVEN: a note that is informational, not a gap, travels in the same Set with this prefix; consumers split it with naNote/naText. */
export const NA_PREFIX = "n/a: ";
export const naNote = (n: string): boolean => n.startsWith(NA_PREFIX) || n.startsWith("full suite (no test runner");
export const naText = (n: string): string => (n.startsWith(NA_PREFIX) ? n.slice(NA_PREFIX.length) : n);
/** FC-WALL-PROOF-PACKAGE-BLIND: the Wall was red on base (a real failure, never missing or all not_run). */
export const wallRedOnBaseOf = (baseRun: unknown): boolean => { const f = (baseRun as { fail?: unknown } | null | undefined)?.fail; return typeof f === "number" && f > 0; };
/** Execution evidence, not text: a Wall red on base and green on head (proofFiles non-empty) proves a diff confined to one package (own Wall files excluded; unknown, empty or quoted diff never counts). */
function execProves(repoDir: string, o: { changed?: string[] | undefined; proofFiles?: string[] | undefined; wallBaseRed?: boolean | undefined }, owned: (f: string) => boolean): boolean {
  const proofs = o.proofFiles ?? [], rel = (f: string): string => (isAbsolute(f) ? relative(repoDir, f) : f);
  if (!o.wallBaseRed || !proofs.length || !o.changed) return false;
  const wall = new Set(proofs.map(rel)), rest = o.changed.filter((f) => !wall.has(rel(f)));
  return rest.length > 0 && !o.changed.some((f) => f.startsWith('"')) && rest.every(owned);
}
/** Test files of the Wall and holdout checks, only when at least one ran and every one passed (fail-safe: none ran, or any not pass, is no proof). A package without tests is proven only by a file inside it. */
export const wallProofOf = (checks: { name: string; result: string }[], wall: { name: string; path: string }[]): string[] => { const n = new Set(wall.map((w) => w.name)), w = checks.filter((c) => n.has(c.name) || c.name.startsWith("holdout")); return w.length > 0 && w.every((c) => c.result === "pass") ? wall.map((x) => x.path) : []; };

export async function runPackageSuites(
  repoDir: string,
  signal: AbortSignal,
  opts: { path?: string | undefined; timeoutMs: number; baseSha?: string; skip?: (f: string) => boolean; changed?: string[] | undefined; proofFiles?: string[] | undefined; wallBaseRed?: boolean | undefined; targetPassed?: boolean | undefined },
  checks: SuiteCheck[],
  notProven: Set<string>,
): Promise<boolean> {
  const api = loadProjectApi(repoDir), specs = packageSuiteSpecs(api, repoDir);
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
    const cls = await corroboratePass(classifyCheck({ kind: "test", ok: r.exitCode === 0, out, ...goRunner(line), exitCoded: isExitCodedScript(line) }), out, line, undefined, { cwd: join(repoDir, cwd), env: suiteEnv(opts.path), signal }); // FC-FULL-SUITE-EXIT-CODED-SCRIPT
    if (cls.result === "not_run" && r.exitCode === 0 && opts.targetPassed === true && suiteEmptyOnBase(repoDir, opts.baseSha, line, cmd, cls, out, cwd)) { notProven.add(`${NA_PREFIX}${name} (ran 0 tests on base and head; the Wall or a task-named check passed with executed tests)`); continue; } // a full suite that discovers nothing is a disclosed note, not a gate, once a target check proved the change
    checks.push({ name, cmd, result: cls.result, duration_s, ...(cls.count ? { count: cls.count } : {}), ...(cls.result === "fail" ? { ids: cls.count ? [exitCodedId(line, out, repoDir) ?? []].flat() as string[] : failIds(out), errors: Object.fromEntries(errorsById(out)), ...(unhandledBlock(out).length ? { unhandled: unhandledBlock(out) } : {}), first_error: firstError(out), excerpt: failureExcerpt(out, repoDir) } : {}) });
    if (cls.result === "not_run") notProven.add(`not run: ${name} (${cls.reason ?? NO_TESTS_REASON})`);
  }
  // FC-SEAL-NA-AS-UNPROVEN: a package with no test command is N/A only beside a suite that really ran; changed files it owns with no Wall proof (or an unknown diff) stay NOT PROVEN.
  const ran = checks.some((c) => c.result === "pass" || c.result === "fail"), rel = (f: string): string => (isAbsolute(f) ? relative(repoDir, f) : f), wallOwn = new Set((opts.proofFiles ?? []).map(rel));
  const product = opts.changed?.filter((f) => !wallOwn.has(rel(f))); // FC-WALL-FILE-OWNS-EVERY-PACKAGE: this run's passing Wall files are proof, not product, so an unowned root Wall file never makes every test-less package own the diff; unknown or Wall-only diff stays owned (fail-safe)
  // FC-UNOWNED-FILE-OWNED-BY-TESTLESS-PACKAGE: a file with no owning package belongs to the repo-root package only; elsewhere the run's passing Wall exec must prove it or it is named NOT PROVEN.
  const testless = api.packages().filter((p) => !p.commands.test), isRoot = (p: { root: string }): boolean => p.root === "." || p.root === "";
  const unowned = (product ?? []).filter((f) => !f.startsWith('"') && !api.packageOf(f)), unprovenFiles = execProves(repoDir, opts, (f) => !api.packageOf(f)) ? [] : unowned; // exec proof only when the whole product diff is unowned
  if (testless.length) for (const f of unprovenFiles) notProven.add(`changed file ${f} belongs to no package and no passing check exercised it`);
  for (const pkg of testless) {
    const note = `full suite: package ${pkg.name} defines no test command`, owns = !product || product.length === 0 || product.some((f) => { const o = api.packageOf(f); return f.startsWith('"') || (o ? o.root === pkg.root : isRoot(pkg)); });
    const proven = (opts.proofFiles ?? []).some((f) => api.packageOf(f)?.root === pkg.root) || execProves(repoDir, opts, (c) => api.packageOf(c)?.root === pkg.root);
    notProven.add(ran && !(owns && !proven) ? NA_PREFIX + note : note);
  }
  return true;
}
