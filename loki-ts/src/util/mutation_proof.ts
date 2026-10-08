// T2 mutation proof v1: after a VERIFIED verdict, re-run the recorded Wall tests on a temporary worktree of the base
// (pre-fix) tree. The Wall test files are applied, the fix's source changes are not. Data-only helper (D42, lives in util/ to stay out of the e10ext and features line caps): the test
// runner is injected by seal.ts, so this file imports nothing from stages/. A "no" downgrades only under LOKI_MUTATION_STRICT=1 with a declared behavior change (seal.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { safeGit } from "./safe_git.ts";

export type MutationOutcome = "yes" | "no" | "inconclusive";
export interface MutationProof { outcome: MutationOutcome; line: string; }
export interface MutationTest { runner: string; path: string; }
export interface MutationRunner { run(dir: string, files: MutationTest[]): { pass: number; fail: number; not_run?: number }; }
export interface MutationInput {
  repoDir: string; baseSha: string; runDir: string;
  wallFiles: { path: string }[]; // sealed Wall files as recorded by wall.ts (absolute or repo-relative)
  checks: { name: string }[]; // verify's recorded checks, named `<runner>:<repo-relative path>`
  runner: MutationRunner | ((remainingMs: number) => MutationRunner); env?: NodeJS.ProcessEnv; timeoutS?: number;
}
/** CTO ruling: the downgrade to PARTIAL is off unless LOKI_MUTATION_STRICT=1 (and then only for a model-declared behavior change). */
export const mutationStrict = (env: NodeJS.ProcessEnv = process.env): boolean => (env["LOKI_MUTATION_STRICT"] ?? "").trim() === "1";
export const mutationEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => (env["LOKI_MUTATION_PROOF"] ?? "").trim() !== "0";
const LABEL = "test fails without the fix: ";
const np = (reason: string): MutationProof => ({ outcome: "inconclusive", line: `${LABEL}inconclusive (${reason})` });
const MAX_TOTAL_S = 40; // B2: seal stage limit is 60s; the whole proof (worktree add, every test, removal) must fit well inside it
const DEP_DIRS = ["node_modules", ".venv", "venv"];
const git = (cwd: string, args: string[], timeout = 30_000): { status: number } => { try { safeGit(cwd, args, { timeout }); return { status: 0 }; } catch { return { status: 1 }; } };

/** Runs the proof. Never throws; the temp worktree is removed on every path with `git worktree remove --force <exact path>`. */
export function mutationProof(i: MutationInput): MutationProof {
  const rels = i.wallFiles.map((f) => (isAbsolute(f.path) ? relative(i.repoDir, f.path) : f.path));
  if (rels.length === 0) return np("no Wall tests");
  const tests = rels.flatMap((rel) => { const c = i.checks.find((k) => k.name.endsWith(`:${rel}`)); const idx = c ? c.name.indexOf(":") : -1; return c && idx > 0 ? [{ runner: c.name.slice(0, idx), path: rel }] : []; });
  if (tests.length === 0) return np("no recorded Wall test command");
  if (tests.length !== rels.length) return np("a Wall file has no recorded test command"); // N1
  const budgetS = Math.min(i.timeoutS ?? (Number((i.env ?? process.env)["LOKI_MUTATION_PROOF_TIMEOUT_S"] ?? 30) || 30), MAX_TOTAL_S);
  const deadline = Date.now() + budgetS * 1000, remaining = (): number => deadline - Date.now();
  let parent: string | null = null, wt: string | null = null, added = false;
  try {
    parent = mkdtempSync(join(tmpdir(), "loki-mutproof-")); wt = join(parent, "wt");
    const add = git(i.repoDir, ["worktree", "add", "--detach", wt, i.baseSha], Math.max(1000, Math.min(30_000, remaining())));
    added = existsSync(wt) || add.status === 0;
    if (add.status !== 0) return np("could not create the base worktree");
    for (const rel of rels) { // sealed copy first (byte-exact what the run sealed), else the file in the working tree
      const sealed = join(i.runDir, "wall", basename(rel)), src = existsSync(sealed) ? sealed : join(i.repoDir, rel);
      if (!existsSync(src)) return np(`Wall file missing: ${rel}`);
      mkdirSync(dirname(join(wt, rel)), { recursive: true }); writeFileSync(join(wt, rel), readFileSync(src));
    }
    // B1: the bare worktree has no installed dependencies; link each one that exists in the repo (root and every Wall file ancestor) so a missing package is never read as a failing test.
    for (const rel of rels) { const parts = rel.split("/").slice(0, -1); for (let n = 0; n <= parts.length; n++) { const anc = parts.slice(0, n).join("/"); for (const d of DEP_DIRS) { const src = join(i.repoDir, anc, d), dst = join(wt, anc, d); if (existsSync(src) && !existsSync(dst)) { try { symlinkSync(src, dst); } catch { /* the run decides */ } } } } }
    let pass = 0, fail = 0, notRun = 0;
    for (const t of tests) {
      if (remaining() <= 0) return np("timeout");
      const r = (typeof i.runner === "function" ? i.runner(remaining()) : i.runner).run(wt, [t]); pass += r.pass; fail += r.fail; notRun += r.not_run ?? 0;
    }
    if (remaining() <= 0 && fail === 0) return np("timeout");
    if (fail > 0) return { outcome: "yes", line: `${LABEL}yes` };
    if (pass > 0 && notRun === 0) return { outcome: "no", line: `${LABEL}no (warning: the Wall tests also pass on the old code)` };
    return np("the Wall command did not execute to a result");
  } catch (e) {
    return np(`error: ${String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`);
  } finally {
    if (wt && added) git(i.repoDir, ["worktree", "remove", "--force", wt]);
    if (parent) rmSync(parent, { recursive: true, force: true });
  }
}
