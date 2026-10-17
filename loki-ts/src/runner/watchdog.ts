// Progress classes + stall watchdog (P12-12, B04). Pure and clock-injected: the session heartbeat
// feeds it one observation per tick; no runner module owned liveness before this.
export type ProgressClass = "progressing" | "idle" | "looping" | "stalled";
export const DEFAULT_STALL_S = 900; // below the 1800s run_outputs STALE_S
export const IDLE_S = 120;
export const LOOP_TICKS = 3;

export function stallThresholdS(env: string | undefined = process.env["LOKI_E10_STALL_S"]): number {
  const n = Number(env);
  return env !== undefined && env.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_S;
}

/** LOKI_E10_STALL_KILL_S: idle seconds after which the session's own child is terminated. Unset, blank, non-numeric or <= 0 means 0 (off). */
export function stallKillS(env: string | undefined = process.env["LOKI_E10_STALL_KILL_S"]): number {
  const n = Number(env);
  return env !== undefined && env.trim() !== "" && Number.isFinite(n) && n > 0 ? n : 0;
}

export interface Watchdog {
  /** One observation: cumulative output bytes and a diff signature. */
  tick(bytes: number, diff: string): { cls: ProgressClass; idleS: number; stalledNow: boolean };
}

export function createWatchdog(now: () => number, stallS: number = stallThresholdS()): Watchdog {
  let lastBytes = 0, lastDiff = "", lastChange = now(), loopTicks = 0, stalled = false;
  return {
    tick(bytes, diff) {
      const t = now();
      const moreOutput = bytes > lastBytes, diffMoved = diff !== lastDiff;
      lastBytes = bytes;
      if (diffMoved) { lastDiff = diff; loopTicks = 0; lastChange = t; stalled = false; }
      else if (moreOutput) { loopTicks++; lastChange = t; stalled = false; } // streamed output is progress; "looping" only labels it, a silent static session still stalls
      else loopTicks = 0;
      const idleS = (t - lastChange) / 1000;
      if (idleS >= stallS) { const stalledNow = !stalled; stalled = true; return { cls: "stalled", idleS, stalledNow }; }
      if (loopTicks >= LOOP_TICKS) return { cls: "looping", idleS, stalledNow: false };
      if (!moreOutput && !diffMoved && idleS >= IDLE_S) return { cls: "idle", idleS, stalledNow: false };
      return { cls: "progressing", idleS, stalledNow: false };
    },
  };
}
