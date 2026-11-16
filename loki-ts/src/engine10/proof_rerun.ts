// The harness's own re-run of the implement session's proof script. The session's reply is written by the author of the code, so a command and result
// in it are a claim. This module turns the claim into a fact Loki holds: the session leaves one script that builds everything from empty and exercises
// each requested item; after the session and every fix round, Loki runs that script itself in a new run-owned scratch directory and records the real
// exit code and output. The acceptance line check reads that output, not the reply. (New file: no module owned a harness-run proof; stages/prove.ts is
// the separate prover session, off by default.)
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupSessionScratch, createSessionScratch, scratchSessionEnv } from "../runner/worker_proc.ts";
import { run } from "../util/shell.ts";
import { CONNECTION_ENV } from "./session.ts";
import { acceptanceLines, FRESH_INSTALL_ASK, issueAcceptanceCapOn, issueAcceptanceOf, optionalAsk } from "../util/intent_card.ts";
import { neededServices } from "../util/stack_tools.ts";
import { issueRunBrief } from "./types.ts";

/** The lines the label is checked against: the issue's own checklist, else (an issue in prose) the plan's acceptance lines; plus the fresh-install line when
 *  the repository needs a database or another service. Empty when the check is off or nothing gives a line. */
export function labelAsks(provider: string, intake: Record<string, unknown> | undefined, plan: unknown, repoDir: string, env: NodeJS.ProcessEnv = process.env): { asks: string[]; source: "issue" | "plan"; needs: string[] } {
  if (!issueAcceptanceCapOn(env)) return { asks: [], source: "issue", needs: [] };
  const listed = issueAcceptanceOf(intake), own = listed.length ? listed : issueRunBrief(provider, intake?.["source"], env) ? acceptanceLines(plan as never) : [];
  let needs: string[] = []; if (own.length) { try { needs = neededServices(repoDir); } catch { needs = []; } }
  return { asks: own.length && needs.length ? [...own, FRESH_INSTALL_ASK] : own, source: listed.length ? "issue" : "plan", needs };
}
/** A tree object of the working tree as it stands (tracked changes and new files, ignores respected), built in a throwaway index so the real index is
 *  never touched. Lets the acceptance check read the uncommitted change with `git diff <base> <tree>`. Null when git cannot build it. */
export async function worktreeTree(repoDir: string): Promise<string | null> {
  const idx = join(repoDir, ".git", `loki-label-index-${process.pid}`);
  try {
    const real = join(repoDir, ".git", "index"); if (existsSync(real)) copyFileSync(real, idx);
    const env = { GIT_INDEX_FILE: idx };
    const a = await run(["git", "-C", repoDir, "add", "-A", "--", ".", ":(exclude).loki"], { env, timeoutMs: 60000 }); if (a.exitCode !== 0) return null;
    const w = await run(["git", "-C", repoDir, "write-tree"], { env, timeoutMs: 60000 }), sha = w.stdout.trim();
    return w.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch { return null; } finally { try { rmSync(idx, { force: true }); } catch { /* a stale throwaway index is harmless */ } }
}
/** The brief that hands unmet lines back to the session: each line with the check's reason, and what closing it takes. */
export function unmetBrief(unmet: { line: string; reason: string }[]): string {
  return [`Loki checked your change against the acceptance lines, using its own run of your proof script. ${unmet.length} line${unmet.length === 1 ? " is" : "s are"} not met yet:`, "",
    ...unmet.map((u, i) => `${i + 1}. ${u.line}\n   Why not: ${u.reason || "no evidence that it was exercised"}`), "",
    "Close each one. If the product does not do it, make it do it. If it does but nothing proves it, add the proof to $LOKI_SCRATCH/loki-proof.sh: send the exact request the real caller sends (for a page, every path its client code calls, with the same method and parameters) and print a PROVED or FAILED line with the real response. Run the script yourself with a new empty directory until it exits 0, leave it in place, and end with the same finish line. Do not weaken a check to make it pass.",
  ].join("\n");
}
export { optionalAsk };

export const PROOF_SCRIPT = "loki-proof.sh";
const MAX_SCRIPT_BYTES = 200_000, TAIL_CHARS = 8000;
/** Seconds Loki gives its own re-run (LOKI_E10_PROOF_RERUN_S overrides). */
export const proofRerunS = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env["LOKI_E10_PROOF_RERUN_S"]); return n > 0 ? n : 600; };
/** How many times Loki hands a failing re-run back to the session before sealing (LOKI_E10_PROOF_LOOP_MAX, default 3; 0 only reports). */
export const proofLoopMax = (env: NodeJS.ProcessEnv = process.env): number => { const v = (env["LOKI_E10_PROOF_LOOP_MAX"] ?? "").trim(), n = Number(v); return v !== "" && Number.isInteger(n) && n >= 0 ? n : 3; };
/** On by default; LOKI_E10_PROOF_RERUN=0 opts out (the label then rests on the session's own description again). */
export const proofRerunOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_PROOF_RERUN"] ?? "").trim());

/** Copies the session's proof script out of its scratch directory before the scratch is removed. True when a script was kept. */
export function keepProofScript(scratchDir: string, runDir: string): boolean {
  try {
    const src = join(scratchDir, PROOF_SCRIPT);
    if (!existsSync(src)) return false;
    const st = statSync(src);
    if (!st.isFile() || st.size === 0 || st.size > MAX_SCRIPT_BYTES) return false;
    copyFileSync(src, join(runDir, PROOF_SCRIPT));
    return true;
  } catch { return false; }
}

export interface ProofRerun { exit: number | null; seconds: number; proved: number; failed: number; tail: string; script_chars: number; stopped: number; left: number }
/** Runs the kept script once, from the repository root, in a new scratch directory that the same ownership cleanup stops and removes afterwards.
 *  Null when no script was kept or the re-run is off. Never throws. */
export async function rerunProof(repoDir: string, runDir: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<ProofRerun | null> {
  const script = join(runDir, PROOF_SCRIPT);
  if (!proofRerunOn(env) || !existsSync(script)) return null;
  let scriptChars = 0; try { scriptChars = readFileSync(script, "utf8").length; } catch { return null; }
  let scratch: ReturnType<typeof createSessionScratch>;
  try { scratch = createSessionScratch(); } catch { return { exit: null, seconds: 0, proved: 0, failed: 0, tail: "Loki could not create a scratch directory for its own re-run", script_chars: scriptChars, stopped: 0, left: 0 }; }
  const blank: Record<string, string> = {}; for (const k of Object.keys(env)) if (CONNECTION_ENV.test(k)) blank[k] = ""; // the re-run never sees the user's own database settings either
  const t0 = Date.now();
  let exit: number | null = null, out = "";
  try {
    const r = await run(["bash", script, scratch.dir], { cwd: repoDir, timeoutMs: proofRerunS(env) * 1000, group: true, signal, env: { ...blank, ...scratchSessionEnv(scratch) } });
    exit = r.exitCode; out = `${r.stdout}\n${r.stderr}`;
  } catch (e) { out = `Loki's re-run did not complete: ${(e as Error).message}`; }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const clean = cleanupSessionScratch(scratch);
  const text = out.replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, " ");
  return { exit, seconds, proved: (text.match(/^PROVED:/gm) ?? []).length, failed: (text.match(/^FAILED:/gm) ?? []).length, tail: text.slice(-TAIL_CHARS), script_chars: scriptChars, stopped: clean.stopped.length, left: clean.left.length };
}
/** The facts for the acceptance line check: what Loki's own run of the script returned, and the script itself (so a script that checks nothing is visible). */
export function proofFacts(runDir: string, r: ProofRerun | null, expected: boolean): string[] {
  if (!r) return expected ? ["The session left no proof script ($LOKI_SCRATCH/loki-proof.sh), so Loki could not re-run anything itself. Nothing in the reply counts as proof from running."] : [];
  let script = ""; try { script = readFileSync(join(runDir, PROOF_SCRIPT), "utf8").slice(0, 12000); } catch { /* the facts still say what ran */ }
  return [
    `Loki re-ran the session's proof script by itself, after the session and every fix round, in a new empty directory: exit ${r.exit === null ? "none (it did not complete)" : r.exit} after ${r.seconds}s; ${r.proved} PROVED line(s), ${r.failed} FAILED line(s). Only this run counts as proof from running; what the reply says about earlier runs does not.`,
    `Output of Loki's own run (real, last ${TAIL_CHARS} characters):\n${r.tail || "(no output)"}`,
    `The script Loki ran (check that each PROVED line comes from a real request or command and its response, not from an unconditional echo):\n${script || "(unreadable)"}`,
  ];
}
