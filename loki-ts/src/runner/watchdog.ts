// Progress classes + stall watchdog (P12-12, B04). Pure and clock-injected: the session heartbeat
// feeds it one observation per tick; no runner module owned liveness before this.
import { loopKillS, SILENCE_KILL_S } from "../engine10/types.ts";
export type ProgressClass = "progressing" | "idle" | "looping" | "stalled";
export const DEFAULT_STALL_S = 900; // below the 1800s run_outputs STALE_S
export const IDLE_S = 120;
export const LOOP_TICKS = 3;

const warned = new Set<string>();
function warnInvalid(name: string, raw: string, used: number): void {
  const key = `${name}=${raw}`;
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`loki: ignoring invalid ${name}="${raw}" (need a number > 0); using ${used}${used === 0 ? " (off)" : "s"}\n`);
}

function positiveEnv(name: string, env: string | undefined, dflt: number): number {
  if (env === undefined || env.trim() === "") return dflt;
  const n = Number(env);
  if (Number.isFinite(n) && n > 0) return n;
  warnInvalid(name, env, dflt);
  return dflt;
}

export function stallThresholdS(env: string | undefined = process.env["LOKI_E10_STALL_S"]): number {
  return positiveEnv("LOKI_E10_STALL_S", env, DEFAULT_STALL_S);
}

/** LOKI_E10_STALL_KILL_S: idle seconds after which the session's own child is terminated. Unset or blank means `dflt`: 0 (off) under a time budget, and
 *  SILENCE_KILL_S (1800) for a session with no time limit (NO-DEFAULT-BUDGET, session.ts); non-numeric or <= 0 also means `dflt` and warns once on stderr. */
export function stallKillS(env: string | undefined = process.env["LOKI_E10_STALL_KILL_S"], dflt = 0): number {
  return positiveEnv("LOKI_E10_STALL_KILL_S", env, dflt);
}

/** NO-DEFAULT-BUDGET: the kills one session runs under. A session with no time limit (limitS Infinity) ends on silence (SILENCE_KILL_S, 1800 s) or on output with
 *  no tree change (LOOP_KILL_S, 3600 s); one with a limit keeps the old default (no kill) and its limit ends it. LOKI_E10_STALL_KILL_S / LOKI_E10_LOOP_KILL_S win. */
export function sessionKillsS(limitS: number, env: NodeJS.ProcessEnv = process.env): { stallS: number; loopS: number } {
  const noLimit = !Number.isFinite(limitS);
  return { stallS: stallKillS(env["LOKI_E10_STALL_KILL_S"], noLimit ? SILENCE_KILL_S : 0), loopS: noLimit ? loopKillS(env) : 0 };
}
export interface Watchdog {
  /** One observation: cumulative output bytes and a diff signature. */
  tick(bytes: number, diff: string): { cls: ProgressClass; idleS: number; stalledNow: boolean; diffIdleS: number };
}

export function createWatchdog(now: () => number, stallS: number = stallThresholdS()): Watchdog {
  let lastBytes = 0, lastDiff = "", lastChange = now(), lastDiffChange = now(), loopTicks = 0, stalled = false; // lastDiffChange: NO-DEFAULT-BUDGET loop guard (output alone is not progress)
  return {
    tick(bytes, diff) {
      const t = now();
      const moreOutput = bytes > lastBytes, diffMoved = diff !== lastDiff;
      lastBytes = bytes;
      if (diffMoved) { lastDiff = diff; loopTicks = 0; lastChange = t; lastDiffChange = t; stalled = false; }
      else if (moreOutput) { loopTicks++; lastChange = t; stalled = false; } // streamed output is progress; "looping" only labels it, a silent static session still stalls
      else loopTicks = 0;
      const idleS = (t - lastChange) / 1000, diffIdleS = (t - lastDiffChange) / 1000;
      if (idleS >= stallS) { const stalledNow = !stalled; stalled = true; return { cls: "stalled", idleS, stalledNow, diffIdleS }; }
      if (loopTicks >= LOOP_TICKS) return { cls: "looping", idleS, stalledNow: false, diffIdleS };
      if (!moreOutput && !diffMoved && idleS >= IDLE_S) return { cls: "idle", idleS, stalledNow: false, diffIdleS };
      return { cls: "progressing", idleS, stalledNow: false, diffIdleS };
    },
  };
}
