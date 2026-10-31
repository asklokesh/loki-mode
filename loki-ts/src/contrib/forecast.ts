// QF-2: advisory quota forecast printed before a run. Never blocks, never throws, and is never written
// into a receipt as a measured value. A percent is printed only when there are past runs whose window
// deltas were measured on this machine; otherwise the line says "unmeasured" and carries no forecast number.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { terminalWidth } from "../util/term_width.ts";

export const MIN_FORECAST_RUNS = 3;
const KEEP_RUNS = 20;

export interface UsageReading {
  session_pct: number | null;
  week_pct: number | null;
}

export interface WindowDelta {
  session: number;
  week: number;
}

export const forecastOn = (env: Record<string, string | undefined> = process.env): boolean => env["LOKI_FORECAST"] !== "0";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Reading from the usage-governor `--json` report (`measured` block). Anything not status ok is unmeasured. */
export function readingFromGovernorJson(rep: unknown): UsageReading | null {
  const m = (rep as { measured?: { status?: unknown; session_pct?: unknown; week_pct?: unknown } | null } | null)?.measured;
  if (!m || m.status !== "ok") return null;
  const session_pct = finite(m.session_pct) ? m.session_pct : null;
  const week_pct = finite(m.week_pct) ? m.week_pct : null;
  return session_pct === null && week_pct === null ? null : { session_pct, week_pct };
}

const historyPath = (lokiDir: string): string => join(lokiDir, "quota-runs.jsonl");

export function readWindowDeltas(lokiDir: string): WindowDelta[] {
  const p = historyPath(lokiDir);
  if (!existsSync(p)) return [];
  const out: WindowDelta[] = [];
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line) as { session?: unknown; week?: unknown };
        if (finite(d.session) && finite(d.week) && d.session >= 0 && d.week >= 0) out.push({ session: d.session, week: d.week });
      } catch {
        /* skip a torn line */
      }
    }
  } catch {
    return [];
  }
  return out.slice(-KEEP_RUNS);
}

/** Record what one finished run consumed. Only two measured readings with a non-negative delta count (a reset between them does not). */
export function recordWindowDelta(lokiDir: string, before: UsageReading | null, after: UsageReading | null): boolean {
  if (!before || !after || before.session_pct === null || after.session_pct === null || before.week_pct === null || after.week_pct === null) return false;
  const session = after.session_pct - before.session_pct;
  const week = after.week_pct - before.week_pct;
  // Identical readings are a cache hit (the governor caches 15 min), not evidence of zero use.
  if (session < 0 || week < 0 || (session === 0 && week === 0)) return false;
  try {
    mkdirSync(lokiDir, { recursive: true });
    appendFileSync(historyPath(lokiDir), JSON.stringify({ session, week }) + "\n");
    return true;
  } catch {
    return false;
  }
}

const range = (xs: number[]): string => {
  const lo = Math.floor(Math.min(...xs)), hi = Math.ceil(Math.max(...xs));
  return lo === hi ? `${hi}` : `${lo}-${hi}`;
};

function fit(s: string, width: number): string {
  return s.length <= width ? s : s.slice(0, Math.max(0, width - 3)) + "...";
}

/** The forecast line, or null when the forecast is switched off. */
export function forecastLine(
  reading: UsageReading | null,
  history: WindowDelta[],
  opts: { env?: Record<string, string | undefined>; width?: number } = {},
): string | null {
  if (!forecastOn(opts.env)) return null;
  const width = opts.width ?? terminalWidth();
  if (!reading) return fit("forecast: unmeasured (no usage reading on this machine)", width);
  const used = [
    reading.session_pct !== null ? `session ${reading.session_pct}% used` : null,
    reading.week_pct !== null ? `week ${reading.week_pct}% used` : null,
  ].filter((x): x is string => x !== null).join(", ");
  if (history.length < MIN_FORECAST_RUNS) {
    return fit(`forecast: unmeasured (${used}; ${history.length} past run${history.length === 1 ? "" : "s"}, need ${MIN_FORECAST_RUNS})`, width);
  }
  const s = range(history.map((h) => h.session));
  const w = range(history.map((h) => h.week));
  return fit(`forecast: ~${s}% of session window, ~${w}% of week (basis: ${history.length} past runs; ${used})`, width);
}

/** Print the advisory line. Swallows every failure: the forecast must never affect a run. */
export async function printForecast(
  lokiDir: string,
  read: () => Promise<UsageReading | null>,
  write: (s: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!forecastOn(env)) return;
  try {
    const line = forecastLine(await read(), readWindowDeltas(lokiDir), { env });
    if (line) write(line + "\n");
  } catch {
    /* advisory only */
  }
}
