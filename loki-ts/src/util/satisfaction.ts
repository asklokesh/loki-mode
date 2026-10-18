// Optional local rating after a VERIFIED run. Nothing is sent. No receipt field changes.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CI_MARKERS = ["GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL", "BUILDKITE", "CIRCLECI", "TRAVIS", "TF_BUILD", "TEAMCITY_VERSION"] as const;
/** Seconds the prompt waits before it skips, so an attended-looking TTY with nobody there never holds the exit code. */
export const ASK_TIMEOUT_MS = 30_000;

export function satisfactionEnabled(env: NodeJS.ProcessEnv, tty: boolean): boolean {
  if (!tty) return false;
  const ci = (env.CI ?? "").trim().toLowerCase();
  if (ci !== "" && ci !== "0" && ci !== "false") return false;
  if (CI_MARKERS.some((k) => (env[k] ?? "") !== "")) return false; // a CI runner with a pseudo-TTY and no CI var

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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  const home = o.env.HOME || homedir();
  if (!home) return;
  let line = "";
  if (o.ask) line = await o.ask(PROMPT);
  else {
    process.stderr.write(`${PROMPT}\n`);
    line = await askLine("> ", ASK_TIMEOUT_MS);
  }
  const parsed = parseScore(line);
  if (!parsed) return;
  recordSatisfaction(home, { run_id: o.runId, score: parsed.score, again: parsed.again, at: new Date().toISOString() });
}

/** One readline answer. EOF (Ctrl-D), close or the timeout resolve "" (a skip); never leaves the process waiting. */
export function askLine(q: string, timeoutMs: number, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input, output });
    let done = false;
    const finish = (a: string): void => { if (done) return; done = true; clearTimeout(t); rl.close(); res(a); };
    const t = setTimeout(() => finish(""), timeoutMs);
    rl.on("close", () => finish(""));
    rl.question(q, (a) => finish(a));
  });
}
