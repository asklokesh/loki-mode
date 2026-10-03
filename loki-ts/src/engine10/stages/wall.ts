// E-15: Wall author (ENGINE.md 4). One provider session, cwd a fresh temp dir holding only task.md and repomap.txt
// (never sees the code), writes loki_wall_* tests, copied into the repo (never on abort/kill/timeout, E-54) and
// sealed under <runDir>/wall/ (sha256 each); wall.sealed before Implement; clean base-tree pass short-circuits to
// already_satisfied. E-64: skipped outright on the small-task lean path (plan.ts logs the same decision).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { RunContext, RunnerName, Stage, StageResult, TestMap, TestRef } from "../types.ts";
import { taskBlock } from "../types.ts";
import type { ReadOnlyFile } from "./implement.ts";
import { withStagePrefix } from "../../e10ext/lean_prefix.ts";
import { RUNNER_HINT } from "../../e10ext/wall_hints.ts";
import { hasRelevantTests, loadRepoMap, planMode, repoMapText, sizeTask, smallTaskPath, wallEnabled, wallModel } from "../sizing.ts";
import { sha256 } from "./seal.ts";
import { runnerCmd } from "./verify.ts";

const WALL_PREFIX = "loki_wall_";

export interface WallSealedFile { path: string; sha256: string; } // path: absolute, in the repo working tree

// Runs the sealed Wall tests on the base tree; local since types.ts has no "execute tests" contract yet.
// not_run (D42 (3)): no real result; counts toward neither pass nor fail. Optional for pre-D42(3) fakes.
export interface BaseTestRunner { run(repoDir: string, files: TestRef[]): { pass: number; fail: number; not_run?: number }; }
const BASE_RUN_TIMEOUT_MS = 60_000; // same per-check budget as verify.ts's CHECK_TIMEOUT_MS
// B1/B2/B3/B4 (r3, opus review of E-125): only the short-summary line names the FINAL exception -- immune to a captured stdout/stderr block forging an earlier frame (B3), or an earlier link in a chain (B4).
function pytestCollectionIsRed(output: string, repoDir: string): boolean {
  if (/ModuleNotFoundError/.test(output)) return false;
  const real = (p: string): string | null => { try { return realpathSync(isAbsolute(p) ? p : join(repoDir, p)); } catch { return null; } };
  const repoReal = real(repoDir); const under = (p: string): boolean => { const r = real(p); return !!repoReal && !!r && (r === repoReal || r.startsWith(`${repoReal}/`)); };
  // pytest reports an ImportError from `from x import y` via its own (short-summary-less) path; the message always carries the module's own (absolute) file, so a direct scan is unambiguous.
  const imp = /ImportError: cannot import name .* from ['"][\w.]+['"] \(([^)]+)\)/.exec(output); if (imp) return under(imp[1]!);
  // B3 (r4): captured stdout prints ABOVE the short summary, so trust only the LAST ERROR line after the final summary header, and E lines only from the first collecting block, cut at its first Captured separator. No header: fail closed.
  const hdr = [...output.matchAll(/^=+ short test summary info =+$/gm)].pop(); if (!hdr) return false;
  const cls = [...output.slice(hdr.index).matchAll(/^ERROR \S+ - (\w+Error): /gm)].pop()?.[1]; if (cls !== "AttributeError" && cls !== "NameError") return false;
  const start = output.search(/^_+ ERROR collecting /m); if (start < 0 || start > hdr.index) return false; const block = output.slice(start, hdr.index).split(/^-+ Captured .*$/m)[0]!;
  const eLines = [...block.matchAll(new RegExp(`^E {3}${cls}: (.*)$`, "gm"))]; const eLine = eLines[eLines.length - 1]; if (!eLine) return false;
  // B1 (r3): an AttributeError's frame is only where the dotted access sits, not who owns the missing attribute -- go by the message instead.
  if (cls === "AttributeError") { const m = /^module ['"]([\w.]+)['"] has no attribute/.exec(eLine[1]!); return !!m && moduleUnderRepo(repoDir, m[1]!); }
  // NameError: the raise site must be repo code, not merely an import line naming an outside module. B2 (r3): a frame path may contain a space.
  const frames = [...block.slice(0, eLine.index).matchAll(/^(.+?):\d+: in \S+\n\s*(.*)$/gm)]; const last = frames[frames.length - 1];
  return !!last && under(last[1]!) && !/^\s*(import\s|from\s\S+\s+import\b)/.test(last[2] ?? "");
}
function moduleUnderRepo(repoDir: string, name: string): boolean { const rel = name.replace(/\./g, "/"); return existsSync(join(repoDir, `${rel}.py`)) || existsSync(join(repoDir, rel, "__init__.py")); }
// E-125 r5: exit-1 output is red only from the real final summary, never captured text. The runner appends -rfE, so a repo's `-q` addopts (stacked to -qq, no footer) still lists FAILED lines.
function pytestExit1IsRed(output: string): boolean {
  if (/^!+ _pytest\.outcomes\.Exit\b/m.test(output)) return false; // pytest.exit(...) can print any text, incl. "1 failed"
  if (/^=*\s*(\d+ \w+(, )?)*\d+ failed\b.* in [\d.]+s/.test(output.trimEnd().split("\n").pop() ?? "")) return true;
  const hdr = [...output.matchAll(/^=+ short test summary info =+$/gm)].pop();
  return !!hdr && /^FAILED \S+/m.test(output.slice(hdr.index));
}
// B2 (r2): jest/vitest/bun red requires a parsed failed-test count above 0; unparseable output stays 0 (not_run).
function parsedFailCount(runner: RunnerName, output: string): number {
  const m = runner === "bun" ? /^\s*(\d+)\s+fail\s*$/m.exec(output)
    : runner === "jest" ? /Tests:\s*(\d+)\s+failed/i.exec(output)
    : runner === "vitest" ? /Tests\s+(\d+)\s+failed/i.exec(output) : null;
  return m ? Number(m[1]) : 0;
}
// A-103 node:test red, mirroring pytest: a missing module inside the repo or an error thrown by code under test is red; a missing bare package, or an error thrown from the Wall file itself (Jest globals), is not. A missing-module crash is not_run only when the file itself failed (no named subtest failed, spec or TAP), and any failing subtest whose error is not a Wall-file Reference/SyntaxError makes the file red, so a child process crash or printed footer cannot hide a real red. Only node's own lines count (col-0 crash text, or a failing-tests block's error line and first frame), never an assertion diff.
function nodeIsRed(f: TestRef, raw: string): boolean {
  // node 20/22 off a TTY print TAP: crash text is "# "-prefixed and a failure is a yaml block (name: 'X', stack: |-). Strip the prefix from non-counter lines so the spec-shape regexes apply.
  const o = raw.replace(/^# (?!(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|Subtest)\b)/gm, "");
  const mod = /^Error(?: \[\w+\])?: Cannot find (?:module|package) '([^']+)'(?:(?!\u2716)[\s\S])*?\nNode\.js v/m.exec(o), top = /^(\S+):\d+\n.*\n.*\n\n?(?:ReferenceError|SyntaxError)\b/m.exec(o);
  const named = [...o.matchAll(/^(?:\u2716|\s*not ok \d+ -) (?!failing tests:)(.+?)(?: \(|$)/gm)].some((m) => !f.path.endsWith(m[1]!) && !m[1]!.endsWith(f.path)), blk = o.split("failing tests:")[1] ?? "", esm = /^SyntaxError: The requested module '([^']+)' does not provide an export named/m.exec(o), errs = [...blk.matchAll(/^ {2}(\w+Error): .*\n\s+at (?:.*\()?([^\s()]+?):\d+:\d+/gm), ...o.matchAll(/^ +name: '(\w+Error)'\n(?:.*\n)*? +stack: \|-\n\s+(?:.*\()?([^\s()]+?):\d+:\d+/gm)];
  return /^(?:#|\u2139) fail [1-9]/m.test(raw) && (/^ {2}AssertionError\b/m.test(blk) || /^ +name: 'AssertionError'/m.test(o) || (mod && !named ? /^[./]/.test(mod[1]!) : esm ? /^[./]/.test(esm[1]!) : top ? !top[1]!.endsWith(f.path) : !errs.length || errs.some((e) => !/^(?:Reference|Syntax)Error$/.test(e[1]!) || !(e[2]!.startsWith("node:") || e[2]!.endsWith(f.path))))); // ESM "cannot import name": red for a repo path, not_run for a bare package
}
// D42 (3) exit classification. B4 (r2): any "system"-interpreter result is not_run, same as verify (E-98a).
// Red: pytest exit 1/resolved 2; jest/vitest/bun a parsed failed count>0. npm/go/cargo (B2, coarse): never fail.
export function classify(f: TestRef, status: number | null, output: string, repoDir: string, interpreter?: "project" | "system"): "pass" | "fail" | "not_run" {
  if (interpreter === "system") return "not_run";
  if (status === null || status === 126 || status === 127) return "not_run"; if (status === 0) return "pass";
  if (f.runner === "pytest") return status === 1 ? (pytestExit1IsRed(output) ? "fail" : "not_run") : status === 2 ? (pytestCollectionIsRed(output, repoDir) ? "fail" : "not_run") : "not_run";
  if (f.runner === "jest" || f.runner === "vitest" || f.runner === "bun") return parsedFailCount(f.runner, output) > 0 ? "fail" : "not_run";
  return f.runner === "node" && nodeIsRed(f, output) ? "fail" : "not_run"; // npm/go/cargo: coarse (B2), never a per-file red
}
// One process per file, through verify's own interpreter resolution (E-98a) so a missing `python` is never
// misread as a failing test. env is explicit, matching verify.ts's runOnce (its default PATH lookup can
// otherwise resolve a snapshot from process start, not the live env).
export class RealBaseTestRunner implements BaseTestRunner {
  run(repoDir: string, files: TestRef[]): { pass: number; fail: number; not_run: number } {
    let pass = 0, fail = 0, not_run = 0; for (const f of files) {
      const [cmd, args, interpreter] = runnerCmd(f, repoDir);
      const r = spawnSync(cmd, f.runner === "pytest" ? [...args, "-rfE"] : args, { cwd: repoDir, encoding: "utf8", timeout: BASE_RUN_TIMEOUT_MS, env: process.env });
      const status = r.error ? null : r.status;
      const result = classify(f, status, `${r.stdout ?? ""}\n${r.stderr ?? ""}`, repoDir, interpreter);
      if (result === "pass") pass++; else if (result === "fail") fail++; else not_run++;
    }
    return { pass, fail, not_run };
  }
}

export interface WallOptions { baseRunner?: BaseTestRunner; }
/** E-45: the Wall repo map is paths only, capped, so the (sonnet) brief stays short. */
export const WALL_MAP_MAX_LINES = 200;

export function buildWallBrief(task: string, repomapText = "", runners: RunnerName[] = []): string {
  return withStagePrefix([
    "You are the Loki 10 Wall author.",
    "You cannot see the repository. This directory holds only task.md and repomap.txt.",
    ...(repomapText ? [`Repository paths (repomap.txt):\n${repomapText}`] : []),
    ...taskBlock(task),
    "Write behavioral acceptance tests that prove the task is done. A test that errors on import, uses another framework's globals, or fails for a reason unrelated to the task is discarded.",
    `Test runner: ${runners.map((r) => RUNNER_HINT[r]).find(Boolean) ?? "the framework named in repomap.txt"}`,
    `Name every file you write starting with "${WALL_PREFIX}". Write nothing else.`,
  ].join("\n\n"));
}

/** RunContext carries no task text; read it as intake.ts does: prior.intake.task, else issue.json title+body, else LOKI_E10_TASK_TEXT. */
export function loadTaskText(ctx: RunContext, fromPrior: string | undefined): string {
  if (fromPrior) return fromPrior;
  const issueJsonPath = process.env.LOKI_E10_ISSUE_JSON ?? join(ctx.runDir, "issue.json");
  if (existsSync(issueJsonPath)) {
    try {
      const issue = JSON.parse(readFileSync(issueJsonPath, "utf8")) as { title?: string; body?: string };
      const text = [issue.title, issue.body].filter((s) => typeof s === "string" && s.length > 0).join("\n\n");
      if (text) return text;
    } catch { /* malformed issue.json: fall through to the text-mode env var */ }
  }
  return process.env.LOKI_E10_TASK_TEXT ?? "";
}

// Alongside an existing detected test file, or a top-level tests/ directory when the repo has none.
function wallTargetDir(repoDir: string, existingTests: TestRef[]): string {
  const first = existingTests[0];
  return first ? join(repoDir, dirname(first.path)) : join(repoDir, "tests");
}
/** Runner for a generated file: extension decides for Python/Go, else the repo's detected JS runner; unknown never guesses (unselectable). */
function guessRunner(fileName: string, runners: RunnerName[]): RunnerName | null {
  if (fileName.endsWith(".py")) return "pytest";
  if (fileName.endsWith(".go")) return "go";
  return (["vitest", "jest", "bun", "node"] as const).find((r) => runners.includes(r)) ?? null;
}

export async function runWall(ctx: RunContext, signal: AbortSignal, opts: WallOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before wall started" };
  if (!wallEnabled()) return { status: "skipped", data: {}, reason: "LOKI_E10_WALL=0" };

  const prior = ctx.outputs();
  const task = loadTaskText(ctx, prior.intake?.task as string | undefined);
  const repomapRef = prior.intake?.repomap_ref as string | undefined;
  const testMap = (prior.intake?.testmap as TestMap | undefined) ?? null;
  const existingTests: TestRef[] = testMap?.tests ?? [];
  const runners: RunnerName[] = testMap?.runners ?? [];

  // E-64: skip Wall too on the lean path (plan.ts, which always runs, logs this same decision on "variant").
  // LOKI_E10_PLAN=always forces a plan even for a small task, so the lean path never applies: a forced plan
  // still gets the Wall's independent acceptance tests.
  const repoMap = loadRepoMap(repomapRef);
  const sz = sizeTask(task, repoMap, testMap);
  if (planMode() !== "always" && smallTaskPath(sz.size, hasRelevantTests(task, repoMap, testMap, ctx.tests.impacted)) === "lean") {
    return { status: "skipped", data: { size: sz.size }, reason: "small task with a relevant test: cascade skips Wall" };
  }

  const tree = prior.intake?.tree as string | undefined;
  const repomapText = repoMapText(ctx.repoDir, tree, repomapRef, WALL_MAP_MAX_LINES);

  const cwd = mkdtempSync(join(tmpdir(), "loki-e15-wall-"));
  writeFileSync(join(cwd, "task.md"), task, "utf8");
  writeFileSync(join(cwd, "repomap.txt"), repomapText, "utf8");

  const session = await ctx.sessions.run({
    stage: "wall",
    brief: buildWallBrief(task, repomapText, runners),
    // E-45: pinned cheaper model; development tier because the planning tier yields to the LOKI_SESSION_MODEL=opus pin.
    tier: "development",
    model: wallModel(),
    iterationId: `${ctx.runId}-wall`,
    limitS: wallStage.limitS,
    signal,
    cwd,
  });
  if (session.killed || session.exit === null) { rmSync(cwd, { recursive: true, force: true }); return { status: "failed", data: {}, reason: "wall session aborted, killed, or timed out", killed: true }; } // E-54: also covers killed-from-outside (exit:null, "killed before exiting" per types.ts)

  const generated = readdirSync(cwd).filter((f) => f.startsWith(WALL_PREFIX));
  const targetDir = wallTargetDir(ctx.repoDir, existingTests);
  const sealedDir = join(ctx.runDir, "wall");
  if (generated.length > 0) { mkdirSync(targetDir, { recursive: true }); mkdirSync(sealedDir, { recursive: true }); }

  const sealedFiles: WallSealedFile[] = [];
  const readOnlyFiles: ReadOnlyFile[] = [];
  const wallTests: TestRef[] = [];

  for (const name of generated) {
    const content = readFileSync(join(cwd, name), "utf8"), dest = join(targetDir, name), runner = guessRunner(name, runners);
    writeFileSync(dest, content, "utf8"); writeFileSync(join(sealedDir, name), content, "utf8");
    sealedFiles.push({ path: dest, sha256: sha256(content) }); readOnlyFiles.push({ path: dest, content });
    if (runner) wallTests.push({ runner, path: relative(ctx.repoDir, dest) });
  }
  rmSync(cwd, { recursive: true, force: true });
  ctx.emit("wall.sealed", "wall", { files: sealedFiles });
  const baseRunner = opts.baseRunner ?? new RealBaseTestRunner(), baseRun = { pass: 0, fail: 0, not_run: 0 }; // A-103: one file at a time; a file with no real result (not_run) proves nothing, so it leaves the tree and Implement's read-only set. Its sealed copy stays under runDir/wall; base_run.not_run lets Seal list it.
  for (const t of wallTests) {
    const r = baseRunner.run(ctx.repoDir, [t]), abs = join(ctx.repoDir, t.path); baseRun.pass += r.pass; baseRun.fail += r.fail; baseRun.not_run += r.not_run ?? 0; if (r.pass + r.fail === 0) { rmSync(abs, { force: true }); for (const l of [sealedFiles, readOnlyFiles] as { path: string }[][]) l.splice(0, l.length, ...l.filter((f) => f.path !== abs)); }
  }
  // Gate on generated.length, not wallTests.length: an unselectable (guessRunner() null) file is sealed but never run, and must never be silently missing from the already_satisfied count.
  const unselectable = generated.length - wallTests.length;
  // D42 (3): not_run refuses the seal too -- never short-circuit on a base run that never proved anything.
  const alreadySatisfied = generated.length > 0 && unselectable === 0 && baseRun.fail === 0 && (baseRun.not_run ?? 0) === 0 && baseRun.pass === generated.length;

  return {
    status: "completed",
    data: {
      files: sealedFiles,
      readOnlyFiles,
      base_run: baseRun,
      iteration_ids: [`${ctx.runId}-wall`],
      already_satisfied: alreadySatisfied,
    },
  };
}

export const wallStage: Stage = {
  name: "wall",
  targetS: 45,
  limitS: 90,
  run: (ctx, signal) => runWall(ctx, signal),
};
export const stage = wallStage;
