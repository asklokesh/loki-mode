// T2 mutation proof v1: after a VERIFIED verdict, re-run the recorded Wall tests on a temporary worktree of the base
// (pre-fix) tree. The Wall test files are applied, the fix's source changes are not. Data-only helper (D42, lives in util/ to stay out of the e10ext and features line caps): the test
// runner is injected by seal.ts, so this file imports nothing from stages/. A "no" downgrades only under LOKI_MUTATION_STRICT=1 with a declared behavior change (seal.ts).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { safeGit } from "./safe_git.ts";
import { readScopeText } from "./run_cap.ts";
import { sealedWallCopy, sealedWallDir } from "./check_result.ts";

export type MutationOutcome = "yes" | "no" | "inconclusive";
export interface MutationProof { outcome: MutationOutcome; line: string; failed?: string[]; before?: ProofBefore[]; } // before (AWE-2): each failed file's own base-run output lines, for the proof card; display only, never a verdict input
export interface ProofBefore { file: string; lines: string[]; } // failed: the files whose run failed on the base (serially confirmed), for a caller that must know WHICH test discriminates
export interface MutationTest { runner: string; path: string; }
export interface MutationRunner { lastFailLines?: Record<string, string[]>; run(dir: string, files: MutationTest[]): { pass: number; fail: number; not_run?: number; assertFail?: number }; withEnv?(env: Record<string, string>): MutationRunner; /* BASE-SEES-HEAD: the same runner with extra env (editableBaseEnv) */ runEach?(dir: string, files: MutationTest[], jobs: number, corroborate: boolean, remaining?: () => number): Promise<({ pass: number; fail: number; not_run?: number } | undefined)[]>; } // runEach: same per-file result, a few files at once
const envJobs = (raw: string | undefined): number => { const n = Number.parseInt(raw ?? "", 10); return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1; }; // LOKI_MUTATION_PROOF_JOBS: default 1 = serial (as LOKI_E10_BASE_JOBS / LOKI_E10_VERIFY_JOBS). Opt-in >1 is faster but can give a false "yes" on a Wall test with side effects outside the worktree.
export interface MutationInput {
  repoDir: string; baseSha: string; runDir: string;
  wallFiles: { path: string }[]; // sealed Wall files as recorded by wall.ts (absolute or repo-relative)
  checks: { name: string }[]; // verify's recorded checks, named `<runner>:<repo-relative path>`
  runner: MutationRunner | ((remainingMs: number) => MutationRunner); env?: NodeJS.ProcessEnv; timeoutS?: number;
  /** No Wall ran: the "wall files" are the run's own agent-authored test files, read byte-exact from this commit (never the sealed Wall copy or the working tree). */
  headSha?: string;
  /** Files that exist at the base: their BASE version must itself pass on the base tree first, else a red file (pre-existing, unrelated) would read as "fails without the fix". Such a file is dropped from the proof. */
  baseMustPass?: string[];
  /** A file counts in `failed` only when its base failure was an assertion (runner reports assertFail), never an import, collection or attribute error. */
  requireAssertion?: boolean;
  /** PROOF-TEST-SIDE (headSha mode only): test-side paths the change added, modified or deleted that are not themselves run (data files, fixtures), and, when there is any, the
   *  change's other non-code files, and its code files in which the diff declares or modifies no symbol (seal.ts proofSupport). Each is written byte-exact from headSha, or removed when `deleted`, after the test overlay, so the base run differs from
   *  the head run only in the change's code (testSideSupport builds the list). */
  supportFiles?: SupportFile[];
}
/** PROOF-TEST-SIDE: one test-side path of the change. `mode` is its git mode at the head (100644, 100755, 120000 for a symlink): the overlay keeps the exec bit and the link. */
export interface SupportFile {
  path: string;
  deleted: boolean;
  mode?: string;
}
/** PROOF-TEST-SIDE (LOKI_E10_PROOF_TEST_SIDE, default on, =0/off/false/no opts out): the fail-then-pass base worktree gets the change's whole test side, not only the test files that ran. */
export const proofTestSideOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_E10_PROOF_TEST_SIDE"] ?? "").trim()) /* off by default: its last cold review was NOT GO (2026-11-21); opt in to measure */;
/** PROOF-TEST-SIDE: the support files of a fail-then-pass proof from a `git diff-tree -r -z --raw --no-renames` listing (status line, path, status line, path, ...): every path with
 *  status A, M, T or D that `isSide` calls test side and that is not one of the `run` test files, with its head mode (the second field of the status line). [] with the knob off
 *  (only the run test files are copied, as before). */
export function testSideSupport(rawDiff: readonly string[], run: readonly string[], isSide: (rel: string) => boolean, env: NodeJS.ProcessEnv = process.env): SupportFile[] {
  if (!proofTestSideOn(env)) return [];
  const out: SupportFile[] = [], ran = new Set(run);
  for (let k = 0; k + 1 < rawDiff.length; k += 2) {
    const f = rawDiff[k]!.trim().split(" "), st = f.pop() ?? "", path = rawDiff[k + 1]!;
    if ((st === "A" || st === "M" || st === "T" || st === "D") && !ran.has(path) && isSide(path) && !out.some((s) => s.path === path)) out.push({ path, deleted: st === "D", ...(f[1] ? { mode: f[1] } : {}) });
  }
  return out;
}
/** A repo-relative path that stays inside the worktree: no absolute path, no `..` segment, and no existing ancestor that is a symlink (a linked node_modules or .venv points into the real repo). */
function insideWorktree(wt: string, rel: string): boolean {
  if (isAbsolute(rel) || rel.split("/").some((p) => p === ".." || p === "")) return false;
  const parts = rel.split("/");
  for (let n = 1; n < parts.length; n++) { const p = join(wt, ...parts.slice(0, n)); try { if (lstatSync(p).isSymbolicLink()) return false; } catch { return true; } }
  return true;
}
/** CTO ruling: the downgrade to PARTIAL is off unless LOKI_MUTATION_STRICT=1 (and then only for a model-declared behavior change). */
export const mutationStrict = (env: NodeJS.ProcessEnv = process.env): boolean => (env["LOKI_MUTATION_STRICT"] ?? "").trim() === "1";
export const mutationEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => (env["LOKI_MUTATION_PROOF"] ?? "").trim() !== "0";
const LABEL = "test fails without the fix: ";
const np = (reason: string): MutationProof => ({ outcome: "inconclusive", line: `${LABEL}inconclusive (${reason})` });
const MAX_TOTAL_S = 40; // B2: seal stage limit is 60s; the whole proof (worktree add, every test, removal) must fit well inside it
/** Only a positive finite number of seconds is accepted from the env; anything else (negative, zero, NaN, Infinity, junk) falls back to 30. */
const envTimeoutS = (raw: string | undefined): number => { const n = Number(raw ?? 30); return Number.isFinite(n) && n > 0 ? n : 30; };
export const DEP_DIRS = ["node_modules", ".venv", "venv"];
/** BASE-SEES-HEAD: a linked .venv whose editable install (a .pth path line, or a path in a setuptools __editable__ finder) points into the live repo
 *  makes the base worktree import the HEAD sources, so a test that fails on the real base passes there and reads "no". The worktree's own copy of each
 *  such source dir goes first on PYTHONPATH, so the base run imports base code. {} when no linked venv names the repo. */
export function editableBaseEnv(repoDir: string, wt: string, venvs: string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const roots = new Set<string>([repoDir]); try { roots.add(realpathSync(repoDir)); } catch { /* as given */ }
  for (const r of [...roots]) roots.add(r.startsWith("/private/") ? r.slice("/private".length) : `/private${r}`);
  const mapped: string[] = [], add = (p: string): void => { for (const r of roots) if (p === r || p.startsWith(`${r}/`)) { const m = join(wt, relative(r, p)); if (existsSync(m) && !mapped.includes(m)) mapped.push(m); return; } };
  for (const v of venvs) {
    let libs: string[] = []; try { libs = readdirSync(join(v, "lib")).filter((n) => n.startsWith("python")).map((n) => join(v, "lib", n, "site-packages")); } catch { /* Windows layout or none */ }
    for (const sp of [...libs, join(v, "Lib", "site-packages")]) {
      let names: string[] = []; try { names = readdirSync(sp); } catch { continue; }
      for (const n of names) {
        const pth = n.endsWith(".pth"), finder = /^__editable__.*\.py$/.test(n); if (!pth && !finder) continue;
        let text = ""; try { text = readFileSync(join(sp, n), "utf8"); } catch { continue; }
        if (pth) for (const l of text.split("\n")) { const t = l.trim(); if (isAbsolute(t)) add(t); }
        else for (const m of text.matchAll(/["']((?:\/|[A-Za-z]:\\)[^"'\n]+)["']/g)) add(dirname(m[1]!)); // MAPPING = {"pkg": "<repo>/src/pkg"}: the dir that holds the package
      }
    }
  }
  if (!mapped.length) return {};
  const prev = (env["PYTHONPATH"] ?? "").trim();
  return { PYTHONPATH: [...mapped, ...(prev ? [prev] : [])].join(delimiter) };
}
const git = (cwd: string, args: string[], timeout = 30_000): { status: number } => { try { safeGit(cwd, args, { timeout }); return { status: 0 }; } catch { return { status: 1 }; } };

/** PROOF-COMPILED-BUDGET (LOKI_E10_PROOF_COMPILED_BUDGET, default on, =0 opts out): a proof whose tests run on a compiled stack (go, cargo, maven, gradle, javac,
 *  dotnet) gets MAX_TOTAL_S (40 s) by default instead of 30 s, still inside seal's 60 s limit; for go, the base worktree's test packages are compiled once
 *  (`go test -run ^$ -count=1 ./<pkg>`, no test runs) inside that same deadline before the timed runs. It only grants time: what counts as proof is unchanged. */
export const compiledBudgetOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PROOF_COMPILED_BUDGET"] ?? "").trim());
const COMPILED_RUNNERS = new Set(["go", "cargo", "maven", "gradle", "javac", "dotnet"]);
/** The proof's whole budget in seconds: the caller's timeoutS, else LOKI_MUTATION_PROOF_TIMEOUT_S, else 40 s for a compiled stack (knob on) or 30 s; never above MAX_TOTAL_S. */
export function proofBudgetS(tests: readonly { runner: string }[], env: NodeJS.ProcessEnv = process.env, timeoutS?: number): number {
  const explicit = timeoutS ?? (env["LOKI_MUTATION_PROOF_TIMEOUT_S"] !== undefined ? envTimeoutS(env["LOKI_MUTATION_PROOF_TIMEOUT_S"]) : undefined);
  return Math.min(explicit ?? (compiledBudgetOn(env) && tests.some((t) => COMPILED_RUNNERS.has(t.runner)) ? MAX_TOTAL_S : envTimeoutS(undefined)), MAX_TOTAL_S);
}
export function warmGoBuild(wt: string, tests: readonly { runner: string; path: string }[], remaining: () => number): number {
  const dirs = [...new Set(tests.filter((t) => t.runner === "go").map((t) => { const d = dirname(t.path); return d === "." ? "./" : `./${d}`; }))];
  let n = 0;
  for (const d of dirs) { const ms = remaining() - 10_000; if (ms < 2_000) break; try { spawnSync("go", ["test", "-run", "^$", "-count=1", d], { cwd: wt, timeout: ms, stdio: "ignore" }); n++; } catch { /* warming is best effort; the timed run decides */ } }
  return n;
}
/** Runs the proof. Never throws; the temp worktree is removed on every path with `git worktree remove --force <exact path>`. */
export async function mutationProof(i: MutationInput): Promise<MutationProof> {
  const rels = i.wallFiles.map((f) => (isAbsolute(f.path) ? relative(i.repoDir, f.path) : f.path));
  if (rels.length === 0) return np("no Wall tests");
  const tests = rels.flatMap((rel) => { const c = i.checks.find((k) => k.name.endsWith(`:${rel}`)); const idx = c ? c.name.indexOf(":") : -1; return c && idx > 0 ? [{ runner: c.name.slice(0, idx), path: rel }] : []; });
  if (tests.length === 0) return np("no recorded Wall test command");
  if (tests.length !== rels.length) return np("a Wall file has no recorded test command"); // N1
  const env0 = i.env ?? process.env, compiled = compiledBudgetOn(env0) && tests.some((t) => COMPILED_RUNNERS.has(t.runner));
  const budgetS = proofBudgetS(tests, env0, i.timeoutS); // PROOF-COMPILED-BUDGET: a compiled stack gets the whole cap by default (a cold go build of the base worktree took 32 s of a 30 s budget on go-chi/chi); an explicit budget still wins
  const deadline = Date.now() + budgetS * 1000, remaining = (): number => deadline - Date.now();
  let parent: string | null = null, wt: string | null = null, added = false;
  try {
    parent = mkdtempSync(join(tmpdir(), "loki-mutproof-")); wt = join(parent, "wt");
    const add = git(i.repoDir, ["worktree", "add", "--detach", wt, i.baseSha], Math.max(1000, Math.min(30_000, remaining())));
    added = existsSync(wt) || add.status === 0;
    if (add.status !== 0) return np("could not create the base worktree");
    const srcs: [string, string | Buffer][] = [], reset = (): boolean => { // clean base tree for a confirming re-run: the concurrent run may have left files in the shared worktree; linked dependency dirs stay
      if (git(wt as string, ["reset", "-q", "--hard", i.baseSha]).status !== 0 || git(wt as string, ["clean", "-fdxq", ...DEP_DIRS.flatMap((d) => ["-e", d])]).status !== 0) return false;
      for (const [rel, src] of srcs) { mkdirSync(dirname(join(wt as string, rel)), { recursive: true }); writeFileSync(join(wt as string, rel), typeof src === "string" ? readFileSync(src) : src); }
      applySide(); return true; }; // PROOF-TEST-SIDE: the hard reset put the base data back (and restored deleted files), so the confirming re-run gets the test side again
    const side: { rel: string; buf: Buffer | null; mode: string }[] = [], applySide = (): void => { // buf null: the change deletes the path. Deletions first, then writes, each as a fresh entry (never through a leaf symlink)
      for (const e of side) if (e.buf === null) rmSync(join(wt as string, e.rel), { force: true });
      for (const e of side) if (e.buf !== null) {
        const dst = join(wt as string, e.rel); mkdirSync(dirname(dst), { recursive: true }); rmSync(dst, { force: true });
        if (e.mode === "120000") symlinkSync(e.buf.toString("utf8"), dst); else { writeFileSync(dst, e.buf); if (e.mode === "100755") chmodSync(dst, 0o755); } // a symlink's blob is its target; the exec bit as at the head
      } };
    // B1: the bare worktree has no installed dependencies; link each one that exists in the repo (root and every test file ancestor) so a missing package is never read as a failing test.
    const venvs: string[] = [];
    for (const rel of rels) { const parts = rel.split("/").slice(0, -1); for (let n = 0; n <= parts.length; n++) { const anc = parts.slice(0, n).join("/"); for (const d of DEP_DIRS) { const src = join(i.repoDir, anc, d), dst = join(wt, anc, d); if (existsSync(src) && !existsSync(dst)) { try { symlinkSync(src, dst); if (d !== "node_modules") venvs.push(src); } catch { /* the run decides */ } } } } }
    const baseEnv = editableBaseEnv(i.repoDir, wt, venvs, i.env ?? process.env), envd = (r: MutationRunner): MutationRunner => (r.withEnv && Object.keys(baseEnv).length ? r.withEnv(baseEnv) : r); // BASE-SEES-HEAD
    if (compiled) warmGoBuild(wt, tests, remaining); // PROOF-COMPILED-BUDGET: compile the base worktree's go packages once, inside the same deadline, so the timed per-file runs reuse the build cache
    let active = tests; // the base version of an edited file runs on the pristine base before any overlay
    const bmp = new Set(i.baseMustPass ?? []);
    if (bmp.size > 0) {
      const pre = active.filter((t) => bmp.has(t.path)); if (pre.length > 0) { if (remaining() <= 0) return np("timeout"); const pr = pre.map((t) => (remaining() <= 0 ? null : envd(typeof i.runner === "function" ? i.runner(remaining()) : i.runner).run(wt as string, [t]))); if (pr.some((r) => !r)) return np("timeout"); const red = new Set(pre.filter((_, k) => !(pr[k]!.pass > 0 && pr[k]!.fail === 0 && (pr[k]!.not_run ?? 0) === 0)).map((t) => t.path)); active = active.filter((t) => !red.has(t.path)); if (active.length === 0) return np("the base version of each edited test file is not green on the base"); }
    }
    for (const rel of rels) { // sealed copy first (byte-exact what the run sealed), else the file in the working tree; headSha: the committed bytes
      if (i.headSha) { try { const buf = execFileSync("git", ["-C", i.repoDir, "show", `${i.headSha}:${rel}`], { maxBuffer: 16 << 20, timeout: 20_000 }); mkdirSync(dirname(join(wt, rel)), { recursive: true }); writeFileSync(join(wt, rel), buf); srcs.push([rel, buf]); continue; } catch { return np(`could not read ${rel} at the head commit`); } }
      const sealed = sealedWallCopy(i.runDir, rel);
      if (!existsSync(sealed) && existsSync(sealedWallDir(i.runDir))) return np(`sealed Wall copy missing: ${rel}`); // never substitute the working-tree file for a deleted sealed copy
      const src = existsSync(sealed) ? sealed : join(i.repoDir, rel);
      if (!existsSync(src)) return np(`Wall file missing: ${rel}`);
      mkdirSync(dirname(join(wt, rel)), { recursive: true }); writeFileSync(join(wt, rel), readFileSync(src)); srcs.push([rel, src]);
    }
    if (i.headSha) { // PROOF-TEST-SIDE: the rest of the change's test side (data files, fixtures, deletions), byte-exact from the head, so base and head differ only in non-test code
      for (const s of i.supportFiles ?? []) {
        if (remaining() <= 0) return np("timeout"); // one git show per path, and the widened list (seal.ts) can be long
        if (!insideWorktree(wt, s.path)) return np(`support path outside the base worktree: ${s.path}`);
        if (s.mode === "160000") return np(`support path is a submodule: ${s.path}`); // a gitlink has no bytes to copy; never half-apply the test side
        if (s.deleted) { side.push({ rel: s.path, buf: null, mode: "" }); continue; }
        try { side.push({ rel: s.path, mode: s.mode ?? "100644", buf: execFileSync("git", ["-C", i.repoDir, "show", `${i.headSha}:${s.path}`], { maxBuffer: 16 << 20, timeout: 20_000 }) }); } catch { return np(`could not read ${s.path} at the head commit`); }
      }
      applySide();
    }
    let pass = 0, fail = 0, notRun = 0;
    if (remaining() <= 0) return np("timeout");
    const mk = (): MutationRunner => envd(typeof i.runner === "function" ? i.runner(remaining()) : i.runner), jobs = envJobs((i.env ?? process.env)["LOKI_MUTATION_PROOF_JOBS"]), first = mk();
    const par = jobs > 1 && active.length > 1 && first.runEach !== undefined;
    const lines: Record<string, string[]> = {}, runOne = (t: MutationTest): ReturnType<MutationRunner["run"]> => { const r = mk(), x = r.run(wt as string, [t]); const l = r.lastFailLines?.[t.path]; if (x.fail > 0 && l?.length) lines[t.path] = l; return x; }; // AWE-2: a serial run's failing output lines
    const rs = par ? await first.runEach!(wt, active, jobs, false, remaining) : active.map((t) => (remaining() <= 0 ? null : runOne(t)));
    if (rs.some((r) => !r)) return np("timeout");
    if (par && remaining() <= 0) return np("timeout"); // concurrent path: a passed deadline is a timeout before any verdict
    // A concurrent fail is not authoritative (children share the temp worktree): it counts only if it reproduces serially.
    let sure = rs.length; // results at index >= sure are concurrent and not confirmed
    if (par) for (let k = 0; k < rs.length; k++) if (rs[k]!.fail > 0) { if (remaining() <= 0) return np("timeout"); if (!reset()) return np("could not reset the base worktree"); rs[k] = runOne(active[k]!); if (rs[k]!.fail > 0) { sure = k + 1; break; } }
    for (const r of rs) { pass += r!.pass; fail += r!.fail; notRun += r!.not_run ?? 0; }
    if (remaining() <= 0 && fail === 0) return np("timeout");
    const failed = active.filter((_, k) => k < sure && rs[k]!.fail > 0 && (!i.requireAssertion || ((rs[k] as { assertFail?: number }).assertFail ?? 0) > 0)).map((t) => t.path);
    const before = failed.map((file) => ({ file, lines: lines[file] ?? [] })); // [] lines: the card says "not recorded", never a paraphrase
    if (fail > 0) return { outcome: "yes", line: `${LABEL}yes`, failed, ...(before.length ? { before } : {}) };
    if (pass > 0 && notRun === 0) return { outcome: "no", line: `${LABEL}no (warning: the Wall tests also pass on the old code)` };
    return np("the Wall command did not execute to a result");
  } catch (e) {
    return np(`error: ${String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`);
  } finally {
    if (wt && added) git(i.repoDir, ["worktree", "remove", "--force", wt]);
    if (parent) rmSync(parent, { recursive: true, force: true });
  }
}

/** T3 intent: the plan brief line asking the model to declare whether the task changes observable behavior (asked for only under strict). */
export const behaviorChangeInstruction = (scopePath: string): string => `In the same JSON object (${scopePath}) also add "behavior_change": true if this task changes observable behavior (a fix or a feature a new test can distinguish from the old code), false for a refactor, rename, docs or config-only change.`;
/** The model-declared flag from plan-scope.json as plan output data; {} unless strict and a real boolean (undeclared never downgrades). */
export function readBehaviorChange(runDir: string, env: NodeJS.ProcessEnv = process.env): { behavior_change?: boolean } {
  if (!mutationStrict(env)) return {};
  const rd = readScopeText(runDir); if (rd.status !== "ok") return {};
  try { const bc = (JSON.parse(rd.text) as { behavior_change?: unknown }).behavior_change; return typeof bc === "boolean" ? { behavior_change: bc } : {}; } catch { return {}; }
}
