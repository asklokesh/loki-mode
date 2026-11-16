// The harness's own re-run of the implement session's proof script. The session's reply is written by the author of the code, so a command and result
// in it are a claim. This module turns the claim into a fact Loki holds: the session leaves one script that builds everything from empty and exercises
// each requested item; after the session and every fix round, Loki runs that script itself in a new run-owned scratch directory and records the real
// exit code and output. The acceptance line check reads that output, not the reply. (New file: no module owned a harness-run proof; stages/prove.ts is
// the separate prover session, off by default.)
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupSessionScratch, createSessionScratch, scratchSessionEnv } from "../runner/worker_proc.ts";
import { run } from "../util/shell.ts";
import { CONNECTION_ENV } from "./session.ts";

export const PROOF_SCRIPT = "loki-proof.sh";
const MAX_SCRIPT_BYTES = 200_000, TAIL_CHARS = 8000;
/** Seconds Loki gives its own re-run (LOKI_E10_PROOF_RERUN_S overrides). */
export const proofRerunS = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env["LOKI_E10_PROOF_RERUN_S"]); return n > 0 ? n : 600; };
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
