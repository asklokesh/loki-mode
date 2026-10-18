// Optional local rating after a VERIFIED run. Nothing is sent. No receipt field changes.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function satisfactionEnabled(env: NodeJS.ProcessEnv, tty: boolean): boolean {
  if (!tty) return false;
  if (env.CI === "true" || env.CI === "1") return false;
  const v = (env.LOKI_SATISFACTION ?? "").trim().toLowerCase();
  return v !== "0" && v !== "off" && v !== "false";
}

/** "5 y" or "4 n" or a bare 1-5. Anything else is a skip (null). */
export function parseScore(line: string): { score: number; again: boolean | null } | null {
  const m = line.trim().match(/^([1-5])(?:\s+([yn]))?$/i);
  if (!m) return null;
  return { score: Number(m[1]), again: m[2] ? m[2].toLowerCase() === "y" : null };
}

export function recordSatisfaction(home: string, row: { run_id: string; score: number; again: boolean | null; at: string }): void {
  const dir = join(home, ".loki");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "satisfaction.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

const PROMPT = "Optional, stored only on this machine, never sent. Rate this verified run 1-5 and y or n for would use again (example: 5 y). Enter skips.";

/** Asks on a TTY after VERIFIED. A blank or invalid line stores nothing. */
export async function maybeAsk(o: {
  runId: string;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  ask?: (q: string) => Promise<string>;
}): Promise<void> {
  if (!satisfactionEnabled(o.env, o.isTTY)) return;
  const home = o.env.HOME;
  if (!home) return;
  let line = "";
  if (o.ask) line = await o.ask(PROMPT);
  else {
    process.stderr.write(`${PROMPT}\n`);
    line = await new Promise((res) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question("> ", (a) => { rl.close(); res(a); });
    });
  }
  const parsed = parseScore(line);
  if (!parsed) return;
  recordSatisfaction(home, { run_id: o.runId, score: parsed.score, again: parsed.again, at: new Date().toISOString() });
}
